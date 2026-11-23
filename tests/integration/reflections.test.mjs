import { sitesPrincipal, actorKey } from '../helpers/identity-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createService } from '../../lib/server/domain.ts';
import { dispatchApi } from '../../lib/server/http.ts';
const admin = sitesPrincipal('admin');
const author = sitesPrincipal('author');
const member = sitesPrincipal('member');
const coach = sitesPrincipal('coach');
const outsider = sitesPrincipal('outsider');
const content = {
    title: '',
    text: '私人的训练思考',
    date: '2026-10-16',
    trainingId: null,
    videoId: null
};
const denied = (promise, code = 'NOT_FOUND') => assert.rejects(promise, e => e.code === code);
async function fixture(t, beforeReflections = null, legacy = false, beforePhotoMigration = false) {
    const mf = new Miniflare({
        modules: true,
        script: 'export default {fetch(){return new Response("test")}}',
        compatibilityDate: '2026-05-22',
        d1Databases: ['DB'],
        r2Buckets: ['BUCKET']
    });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database('DB');
    const files = (await readdir(new URL('../../drizzle/', import.meta.url))).filter(x => x.endsWith('.sql')).sort();
    for (const file of files) {
        if (legacy && file === '0005_two_scope_reflections.sql') continue;
        if (beforePhotoMigration && file === '0026_reflection_photos.sql') continue;
        if (file === '0003_reflections.sql' && beforeReflections) await beforeReflections(db);
        const sql = await readFile(new URL('../../drizzle/' + file, import.meta.url), 'utf8');
        // Trigger bodies contain semicolons; migration breakpoints delimit whole statements.
        for (const statement of sql.split('--> statement-breakpoint').flatMap(x => x.includes('CREATE TRIGGER') ? [x] : x.split(';')).map(x => x.trim()).filter(Boolean)) {
            await db.prepare(statement).run();
        }
    }
    const s = createService({
        db,
        bucket: await mf.getR2Bucket('BUCKET'),
        bootstrapSiteUserId: admin.subject
    });
    await s.bootstrap(admin, {
        discName: '管理员',
        jerseyNumber: '01'
    }, 'bootstrap');
    for (const p of [author, member, coach]) {
        const invite = await s.createInvite(admin, {}, 'invite-' + p.subject);
        await s.join(
            p,
            {
                token: invite.inviteToken,
                discName: p.subject,
                jerseyNumber: '07'
            },
            'join'
        );
    }
    const ids = {};
    for (const p of [admin, author, member, coach]) ids[p.subject] = (await s.me(p)).user.id;
    await db.prepare("UPDATE memberships SET role='coach' WHERE user_id=?").bind(ids.coach).run();
    return {
        s,
        db,
        ids,
        bucket: await mf.getR2Bucket('BUCKET'),
        seedLegacyCoach: async r => {
            // Legacy grants are fixtures against the pre-0005 schema, never created through the new API.
            await db.prepare("UPDATE reflections SET scope='coach',coach_id=?,coach_epoch=(SELECT epoch FROM memberships WHERE user_id=?),author_epoch=(SELECT epoch FROM memberships WHERE user_id=owner_id),published_at=NULL,gate='open' WHERE id=?").bind(ids.coach, ids.coach, r.id).run();
        },
        migrateTwoScope: async () => {
            const sql = await readFile(new URL('../../drizzle/0005_two_scope_reflections.sql', import.meta.url), 'utf8');
            await db.batch(sql.split('--> statement-breakpoint').map(x => db.prepare(x.trim())));
        }
    };
}
const state = r => ({
    expectedVersion: r.version,
    expectedSharingVersion: r.sharingVersion,
    expectedGeneration: r.generation
});
async function team(s, r, key = 'team') {
    return s.shareReflection(author, r.id, {
        ...state(r),
        scope: 'team',
        coachId: null
    }, key);
}
test(
    'private reflection author only, no counts or reader metadata, and own growth automatic',
    async t => {
        const {
            s,
            ids
        } = await fixture(t);
        const r = await s.saveReflection(author, null, content, 'save');
        assert.equal(r.scope, 'private');
        assert.equal((await s.listMyReflections(author))[0].id, r.id);
        for (const p of [admin, member, coach, outsider, null]) await denied(s.getReflection(p, r.id));
        assert.deepEqual((await s.getMemberProfile(member, ids.author)).reflections, []);
        assert.deepEqual((await s.listActivity(member)).items, []);
        await denied(s.saveReflection(member, r.id, {
            ...content,
            ...state(r)
        }, 'edit'));
        await denied(s.shareReflection(admin, r.id, {
            ...state(r),
            scope: 'team',
            coachId: null
        }, 'share'));
        await denied(s.listMyReflections(outsider), 'FORBIDDEN');
    }
);
test(
    'exclusive share, explicit publication, current state replay, edit revokes and bookmarks recheck',
    async t => {
        const {
            s,
            ids
        } = await fixture(t);
        let r = await s.saveReflection(author, null, content, 'save');
        r = await team(s, r);
        const readable = await s.getReflection(member, r.id);
        assert.deepEqual(Object.keys(readable).sort(), ['author', 'date', 'id', 'isAuthor', 'link', 'text', 'title', 'updatedAt'].sort());
        assert.equal((await s.listActivity(member)).items.length, 0);
        assert.equal((await s.getMemberProfile(member, ids.author)).reflections.length, 1);
        await s.saveCollection(
            member,
            null,
            {
                sourceKind: 'reflection',
                sourceId: r.id,
                privateNote: '只属于我'
            },
            'bookmark'
        );
        await denied(s.saveCollection(author, null, {
            sourceKind: 'reflection',
            sourceId: r.id
        }, 'own'), 'INVALID_INPUT');
        r = await s.publishReflection(author, r.id, {
            ...state(r),
            published: true
        }, 'pub');
        assert.equal((await s.listActivity(member)).items.length, 1);
        r = await s.publishReflection(author, r.id, {
            ...state(r),
            published: false
        }, 'unpub');
        assert.equal((await s.listActivity(member)).items.length, 0);
        assert.equal((await s.getReflection(member, r.id)).text, content.text);
        const retried = await s.publishReflection(
            author,
            r.id,
            {
                expectedVersion: 1,
                expectedSharingVersion: 2,
                expectedGeneration: 1,
                published: true
            },
            'pub'
        );
        assert.equal(retried.published, false);
        r = await s.saveReflection(author, r.id, {
            ...content,
            title: '修改',
            ...state(r)
        }, 'edit');
        assert.equal(r.scope, 'private');
        await denied(s.getReflection(member, r.id));
        const saved = (await s.listCollections(member))[0];
        assert.equal(saved.source, null);
        assert.equal(saved.privateNote, '只属于我');
        assert.equal((await s.getMemberProfile(member, ids.author)).reflections.length, 0);
        await denied(s.saveReflection(author, null, {
            ...content,
            text: '换输入'
        }, 'save'), 'IDEMPOTENCY_CONFLICT');
    }
);
test(
    'new members read historical team, leave/rejoin and coach demotion never revive grants',
    async t => {
        const {
            s,
            db,
            ids,
            seedLegacyCoach,
            migrateTwoScope
        } = await fixture(t, null, true);
        let r = await team(s, await s.saveReflection(author, null, content, 'save'));
        const invite = await s.createInvite(admin, {}, 'new-invite');
        await s.join(outsider, {
            token: invite.inviteToken,
            discName: '后来',
            jerseyNumber: '09'
        }, 'join');
        assert.equal((await s.getReflection(outsider, r.id)).text, content.text);
        await seedLegacyCoach(r);
        await denied(s.getReflection(member, r.id));
        await denied(s.getReflection(coach, r.id));
        assert.deepEqual((await s.getMemberProfile(member, ids.author)).reflections, []);
        await db.prepare("UPDATE memberships SET role='member' WHERE user_id=?").bind(ids.coach).run();
        await migrateTwoScope();
        await db.prepare("UPDATE memberships SET role='coach' WHERE user_id=?").bind(ids.coach).run();
        await denied(s.getReflection(coach, r.id));
        r = await s.getReflection(author, r.id);
        r = await team(s, r, 'team-again');
        await db.prepare("UPDATE memberships SET status='left',epoch=epoch+1 WHERE user_id=?").bind(ids.author).run();
        assert.equal((await s.getReflection(author, r.id)).text, content.text);
        assert.equal((await s.listMyReflections(author)).length, 1);
        const leftPrivate = await s.saveReflection(author, null, {
            ...content,
            text: '离队后仍属本人'
        }, 'left-private');
        assert.equal(leftPrivate.scope, 'private');
        await denied(s.getReflection(member, r.id));
        await db.prepare("UPDATE memberships SET status='active',epoch=epoch+1 WHERE user_id=?").bind(ids.author).run();
        await denied(s.getReflection(member, r.id));
    }
);
test(
    'single-batch CAS rejects stale job after newer revoke and generation change; zero effect rolls back',
    async t => {
        const {
            s,
            db
        } = await fixture(t);
        let r = await team(s, await s.saveReflection(author, null, content, 'save'));
        let release;
        let entered;
        const ready = new Promise(resolve => {
            entered = resolve;
        });
        const wait = new Promise(resolve => {
            release = resolve;
        });
        const delayed = createService({
            db: {
                prepare: (...args) => db.prepare(...args),
                batch: async statements => {
                    entered();
                    await wait;
                    return db.batch(statements);
                }
            }
        });
        const old = delayed.publishReflection(author, r.id, {
            ...state(r),
            published: true
        }, 'old-job');
        await ready;
        r = await s.shareReflection(author, r.id, {
            ...state(r),
            scope: 'private',
            coachId: null
        }, 'revoke');
        release();
        await denied(old, 'VERSION_CONFLICT');
        await denied(s.getReflection(member, r.id));
        await db.prepare('UPDATE reflections SET generation=generation+1 WHERE id=?').bind(r.id).run();
        await denied(
            s.shareReflection(author, r.id, {
                ...state(r),
                scope: 'team',
                coachId: null
            }, 'old-generation'),
            'VERSION_CONFLICT'
        );
        r = await s.getReflection(author, r.id);
        await db.prepare("CREATE TRIGGER suppress_finish BEFORE UPDATE ON reflections WHEN NEW.active_op_id IS NULL AND OLD.active_op_id IS NOT NULL BEGIN SELECT RAISE(IGNORE); END").run();
        await denied(team(s, r, 'zero-effect'), 'VERSION_CONFLICT');
        assert.equal((await s.getReflection(author, r.id)).sharingVersion, r.sharingVersion);
        assert.equal((await db.prepare("SELECT count(*) AS n FROM operations WHERE key='zero-effect'").first()).n, 0);
    }
);
test(
    'concurrent publication/edit/revoke yields one guarded winner and old cursor rechecks sources',
    async t => {
        const {
            s
        } = await fixture(t);
        let r = await team(s, await s.saveReflection(author, null, content, 'save'));
        r = await s.publishReflection(author, r.id, {
            ...state(r),
            published: true
        }, 'pub');
        const before = await s.listActivity(member, null, 1);
        const attempts = await Promise.allSettled([
            s.publishReflection(author, r.id, {
                ...state(r),
                published: false
            }, 'unpub'),
            s.saveReflection(author, r.id, {
                ...content,
                text: '改了正文',
                ...state(r)
            }, 'edit'),
            s.shareReflection(author, r.id, {
                ...state(r),
                scope: 'private',
                coachId: null
            }, 'revoke')
        ]);
        assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
        r = await s.getReflection(author, r.id);
        if (r.scope !== 'private') r = await s.shareReflection(author, r.id, {
            ...state(r),
            scope: 'private',
            coachId: null
        }, 'final-revoke');
        assert.deepEqual((await s.listActivity(member, before.nextCursor, 1)).items, []);
        assert.equal((await s.listActivity(member)).items.length, 0);
    }
);
test(
    'announcements and video activity preserve publication time and source states, HTTP no-store',
    async t => {
        const {
            s
        } = await fixture(t);
        let a = await s.saveAnnouncement(admin, null, {
            title: '公告',
            text: '训练通知',
            status: 'draft'
        }, 'a');
        await denied(s.getAnnouncement(member, a.id));
        a = await s.saveAnnouncement(
            admin,
            a.id,
            {
                title: a.title,
                text: a.text,
                status: 'published',
                expectedVersion: a.version
            },
            'ap'
        );
        const publishedAt = a.publishedAt;
        a = await s.saveAnnouncement(
            admin,
            a.id,
            {
                title: '改标题',
                text: a.text,
                status: 'published',
                expectedVersion: a.version
            },
            'ae'
        );
        assert.equal(a.publishedAt, publishedAt);
        const tr = await s.saveTraining(
            admin,
            null,
            {
                title: '训练',
                date: '2026-10-16',
                description: '',
                status: 'draft'
            },
            'tr'
        );
        const v = await s.addVideo(
            admin,
            tr.id,
            {
                title: '视频',
                source: 'bilibili',
                url: 'BV1xx411c7mD',
                position: 1
            },
            'v'
        );
        assert.equal((await s.listActivity(member)).items.length, 1);
        const published = await s.saveTraining(
            admin,
            tr.id,
            {
                title: tr.title,
                date: tr.date,
                description: tr.description,
                status: 'published',
                expectedVersion: tr.version
            },
            'trp'
        );
        const events = await s.listActivity(member);
        assert.equal(events.items.length, 2);
        const event = events.items.find(x => x.kind === 'video');
        await s.updateVideo(
            admin,
            v.id,
            {
                title: '改名',
                position: 2,
                status: 'active',
                expectedVersion: v.version
            },
            've'
        );
        assert.equal((await s.listActivity(member)).items.find(x => x.kind === 'video').publishedAt, event.publishedAt);
        await s.saveTraining(
            admin,
            tr.id,
            {
                title: tr.title,
                date: tr.date,
                description: '',
                status: 'archived',
                expectedVersion: published.version
            },
            'archive'
        );
        assert.equal((await s.listActivity(member)).items.length, 1);
        await s.saveAnnouncement(
            admin,
            a.id,
            {
                title: a.title,
                text: a.text,
                status: 'draft',
                expectedVersion: a.version
            },
            'withdraw'
        );
        assert.deepEqual((await s.listActivity(member)).items, []);
        const response = await dispatchApi(new Request('https://kapok.test/api/v1/activity'), ['activity'], member, s);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('X-Kapok-Actor'), await actorKey(member));
        assert.match(response.headers.get('cache-control'), /no-store/);
    }
);
test(
    'association validation, unavailable source retains own body, soft delete revokes and increments generation',
    async t => {
        const {
            s,
            db
        } = await fixture(t);
        const tr = await s.saveTraining(
            admin,
            null,
            {
                title: '训练',
                date: '2026-10-16',
                description: '',
                status: 'published'
            },
            'tr'
        );
        const v = await s.addVideo(
            admin,
            tr.id,
            {
                title: '训练视频',
                source: 'bilibili',
                url: 'BV1xx411c7mD',
                position: 1
            },
            'v'
        );
        let r = await s.saveReflection(author, null, {
            ...content,
            trainingId: tr.id,
            videoId: v.id
        }, 'save');
        assert.equal(r.link.href, '/videos/' + v.id);
        await denied(s.saveReflection(author, null, {
            ...content,
            trainingId: tr.id,
            videoId: 'foreign'
        }, 'invalid'));
        await denied(s.saveReflection(author, null, {
            ...content,
            text: '字'.repeat(5001)
        }, 'long'), 'INVALID_INPUT');
        await denied(s.saveReflection(author, null, {
            ...content,
            title: '字'.repeat(61)
        }, 'title'), 'INVALID_INPUT');
        r = await team(s, r);
        await s.saveTraining(
            admin,
            tr.id,
            {
                title: tr.title,
                date: tr.date,
                description: '',
                status: 'hidden',
                expectedVersion: tr.version
            },
            'hide'
        );
        const unavailable = await s.getReflection(author, r.id);
        assert.equal(unavailable.text, content.text);
        assert.equal(unavailable.link, null);
        await s.deleteReflection(author, r.id, state(r), 'delete');
        for (const p of [author, member, admin]) await denied(s.getReflection(p, r.id));
        assert.deepEqual(await s.listMyReflections(author), []);
        const stored = await db.prepare('SELECT scope,published_at,generation,deleted_at FROM reflections WHERE id=?').bind(r.id).first();
        assert.equal(stored.scope, 'private');
        assert.equal(stored.published_at, null);
        assert.equal(stored.generation, r.generation + 1);
        assert.ok(stored.deleted_at);
        assert.deepEqual(await s.deleteReflection(author, r.id, state(r), 'delete'), {
            id: r.id,
            deleted: true
        });
    }
);
test(
    'author role downgrade preserves team, pause/account disable revoke irreversibly, recipient leaves',
    async t => {
        const {
            s,
            db,
            ids,
            seedLegacyCoach,
            migrateTwoScope
        } = await fixture(t, null, true);
        await db.prepare("UPDATE memberships SET role='coach' WHERE user_id=?").bind(ids.author).run();
        let r = await team(s, await s.saveReflection(author, null, content, 'save'));
        await db.prepare("UPDATE memberships SET role='member' WHERE user_id=?").bind(ids.author).run();
        assert.equal((await s.getReflection(member, r.id)).text, content.text);
        await db.prepare("UPDATE memberships SET status='paused' WHERE user_id=?").bind(ids.author).run();
        await denied(s.getReflection(member, r.id));
        assert.equal((await s.getReflection(author, r.id)).text, content.text);
        await db.prepare("UPDATE memberships SET status='active' WHERE user_id=?").bind(ids.author).run();
        await denied(s.getReflection(member, r.id));
        r = await s.getReflection(author, r.id);
        await seedLegacyCoach(r);
        await db.prepare("UPDATE memberships SET status='left',epoch=epoch+1 WHERE user_id=?").bind(ids.coach).run();
        await migrateTwoScope();
        await db.prepare("UPDATE memberships SET status='active',role='coach',epoch=epoch+1 WHERE user_id=?").bind(ids.coach).run();
        await denied(s.getReflection(coach, r.id));
        r = await team(s, await s.getReflection(author, r.id), 'team-again');
        await db.prepare("UPDATE users SET status='deleted' WHERE id=?").bind(ids.author).run();
        await denied(s.getReflection(author, r.id));
        await denied(s.getReflection(member, r.id));
        await db.prepare("UPDATE users SET status='active' WHERE id=?").bind(ids.author).run();
        await denied(s.getReflection(member, r.id));
    }
);
test(
    'real pagination cursor has no inaccessible summary after source revoke, collection IDs and notes survive migration',
    async t => {
        const {
            s,
            db
        } = await fixture(t);
        let a = await team(s, await s.saveReflection(author, null, {
            ...content,
            title: 'A'
        }, 'a'), 'ta');
        a = await s.publishReflection(author, a.id, {
            ...state(a),
            published: true
        }, 'pa');
        let b = await team(s, await s.saveReflection(author, null, {
            ...content,
            title: 'B'
        }, 'b'), 'tb');
        b = await s.publishReflection(author, b.id, {
            ...state(b),
            published: true
        }, 'pb');
        const page = await s.listActivity(member, null, 1);
        assert.ok(page.nextCursor);
        const unlisted = page.items[0].href.endsWith(a.id) ? b : a;
        await s.shareReflection(
            author,
            unlisted.id,
            {
                ...state(unlisted),
                scope: 'private',
                coachId: null
            },
            'revoke'
        );
        assert.deepEqual((await s.listActivity(member, page.nextCursor, 1)).items, []);
        const directory = await s.getMemberProfile(member, (await s.me(author)).user.id);
        assert.equal(JSON.stringify(directory).includes(unlisted.title + '"'), false);
        const old = await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='collections_before_reflections'").first();
        assert.equal(old.n, 0);
    }
);
test(
    'same team scope retains publication time, source edit resets shared reader, HTTP actor and edit boundary',
    async t => {
        const {
            s
        } = await fixture(t);
        let r = await team(s, await s.saveReflection(author, null, content, 'save'));
        r = await s.publishReflection(author, r.id, {
            ...state(r),
            published: true
        }, 'pub');
        const at = (await s.listActivity(member)).items[0].publishedAt;
        r = await team(s, r, 'same-scope');
        assert.equal(r.published, true);
        assert.equal((await s.listActivity(member)).items[0].publishedAt, at);
        const edit = await dispatchApi(new Request(`https://kapok.test/api/v1/reflections/${r.id}/edit`), ['reflections', r.id, 'edit'], member, s);
        assert.equal(edit.status, 404);
        const attempt = await dispatchApi(
            new Request(`https://kapok.test/api/v1/reflections/${r.id}/grants`, {
                method: 'PUT',
                headers: {
                    Origin: 'https://kapok.test',
                    'Content-Type': 'application/json',
                    'X-Kapok-Actor': await actorKey(author),
                    'Idempotency-Key': 'actor-stale'
                },
                body: JSON.stringify({
                    ...state(r),
                    scope: 'private',
                    coachId: null
                })
            }),
            ['reflections', r.id, 'grants'],
            member,
            s
        );
        assert.equal(attempt.status, 409);
        assert.equal((await attempt.json()).error.code, 'ACCOUNT_CHANGED');
    }
);
test(
    '0003 upgrade preserves preexisting collection ID, owner, note, seconds and version',
    async t => {
        const {
            db
        } = await fixture(
            t,
            async database => {
                await database.prepare("INSERT INTO users(id,created_at) VALUES('legacy','2026-10-15')").run();
                await database.prepare(`INSERT INTO collections(id,owner_id,source_kind,source_id,timestamp_sec,private_note,version,created_at,updated_at)
                        VALUES('existing-id','legacy','video','stable-source',17,'私人的旧备注',4,'2026-10-15','2026-10-16')`).run();
            }
        );
        const old = await db.prepare("SELECT * FROM collections WHERE id='existing-id'").first();
        assert.deepEqual(
            old,
            {
                id: 'existing-id',
                owner_id: 'legacy',
                source_kind: 'video',
                source_id: 'stable-source',
                timestamp_sec: 17,
                private_note: '私人的旧备注',
                version: 4,
                created_at: '2026-10-15',
                updated_at: '2026-10-16'
            }
        );
    }
);
test(
    'persisted pending draft retries real D1 committed-but-lost create after cold start without duplication',
    async t => {
        const {
            s,
            db
        } = await fixture(t);
        const {
            prepareDraftRequest,
            reconcileDraft
        } = await import('../../lib/client/reflection-draft.ts');
        const draft = {
            schema: 1,
            ...content,
            trainingId: '',
            videoId: '',
            updatedAt: '2026-10-16',
            cloud: null,
            pending: null
        };
        const sent = prepareDraftRequest(draft, 'durable-create');
        let dropped = false;
        const disconnect = createService({
            db: {
                prepare: (...args) => db.prepare(...args),
                batch: async statements => {
                    const result = await db.batch(statements);
                    if (!dropped) {
                        dropped = true;
                        throw new Error('response lost after actual commit');
                    }
                    return result;
                }
            }
        });
        const first = await disconnect.saveReflection(author, null, sent.pending.body, sent.pending.key);
        // The browser received no usable response: restore only its serialized local draft.
        const cold = prepareDraftRequest(JSON.parse(JSON.stringify(sent)), 'new-key-ignored');
        const retry = await s.saveReflection(author, cold.pending.targetId, cold.pending.body, cold.pending.key);
        assert.equal(retry.id, first.id);
        assert.equal((await s.listMyReflections(author)).length, 1);
        assert.equal(reconcileDraft(cold, retry).saved, true);
        assert.equal(reconcileDraft({
            ...cold,
            text: '更晚输入B'
        }, retry).saved, false);
    }
);

function heldCreate(db, bucket) {
    let entered;
    let resume;
    const ready = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { resume = resolve; });
    const service = createService({
        bucket,
        db: {
            prepare: (...args) => db.prepare(...args),
            batch: async statements => {
                entered();
                await wait;
                return db.batch(statements);
            }
        }
    });
    return { service, ready, release: () => resume() };
}

test('T3 fix1 concurrent same-key reflection creates return the committed winner without losing pending context', async t => {
    const { s, db } = await fixture(t);
    const firstHeld = heldCreate(db);
    const secondHeld = heldCreate(db);
    const first = firstHeld.service.saveReflection(author, null, content, 'held-create');
    const second = secondHeld.service.saveReflection(author, null, content, 'held-create');
    await Promise.all([firstHeld.ready, secondHeld.ready]);

    firstHeld.release();
    const winner = await first;
    secondHeld.release();
    const results = await Promise.allSettled([first, second]);

    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
    assert.deepEqual(results[1].value, winner);
    const rows = await s.listMyReflections(author);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, winner.id);
    await denied(s.saveReflection(author, null, { ...content, text: '同键改输入' }, 'held-create'), 'IDEMPOTENCY_CONFLICT');
});

test('T3 fix1 concurrent same-key announcement creates return the committed winner and one row', async t => {
    const { s, db } = await fixture(t);
    const firstHeld = heldCreate(db);
    const secondHeld = heldCreate(db);
    const input = { title: '合成公告', text: '一条有效通知', status: 'draft' };
    const first = firstHeld.service.saveAnnouncement(admin, null, input, 'held-announcement');
    const second = secondHeld.service.saveAnnouncement(admin, null, input, 'held-announcement');
    await Promise.all([firstHeld.ready, secondHeld.ready]);

    firstHeld.release();
    const winner = await first;
    secondHeld.release();
    const results = await Promise.allSettled([first, second]);

    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
    assert.deepEqual(results[1].value, winner);
    const rows = await s.listAnnouncements(admin);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, winner.id);
    await denied(s.saveAnnouncement(admin, null, { ...input, text: '同键改输入' }, 'held-announcement'), 'IDEMPOTENCY_CONFLICT');
});

for (const kind of ['training', 'video', 'comment', 'collection', 'upload']) {
    test(`final I1 concurrent ${kind} creates return the winning existing ID`, async t => {
        const { s, db, bucket } = await fixture(t);
        const training = await s.saveTraining(admin, null, { title: 'race training', date: '2026-10-16', description: '', status: 'published' }, 'setup-training');
        const video = await s.addVideo(admin, training.id, { title: 'race video', source: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD/', position: 0 }, 'setup-video');
        const inputs = {
            training: { title: 'winning training', date: '2026-10-16', description: '', status: 'draft' },
            video: { title: 'winning video', source: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD/', position: 1 },
            comment: { text: 'winning comment', timestampSec: null, rootId: null },
            collection: { sourceKind: 'video', sourceId: video.id, privateNote: 'winning note' },
            upload: { bytes: 1024 }
        };
        const create = (service, body) => {
            if (kind === 'training') return service.saveTraining(admin, null, body, 'race');
            if (kind === 'video') return service.addVideo(admin, training.id, body, 'race');
            if (kind === 'comment') return service.saveComment(admin, video.id, null, body, 'race');
            if (kind === 'collection') return service.saveCollection(admin, null, body, 'race');
            return service.createUpload(admin, body, 'race');
        };
        const one = heldCreate(db, bucket);
        const two = heldCreate(db, bucket);
        const first = create(one.service, inputs[kind]);
        const second = create(two.service, inputs[kind]);
        await Promise.all([one.ready, two.ready]);
        one.release();
        const winner = await first;
        two.release();
        const loser = await second;
        assert.ok(winner?.id);
        assert.equal(loser?.id, winner.id);
        const table = { training: 'trainings', video: 'videos', comment: 'video_comments', collection: 'collections', upload: 'uploads' }[kind];
        assert.equal((await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE id=?`).bind(winner.id).first()).n, 1);
        const total = await db.prepare(`SELECT count(*) AS n FROM ${table}`).first();
        assert.equal(total.n, ['training', 'video'].includes(kind) ? 2 : 1);
        const different = { ...inputs[kind], ...(kind === 'upload' ? { bytes: 2048 } : kind === 'comment' ? { text: 'different' } : kind === 'collection' ? { privateNote: 'different' } : { title: 'different' }) };
        await denied(create(s, different), 'IDEMPOTENCY_CONFLICT');
    });
}
test('final I5 inactive me/bootstrap omit all business fields while active-left retains profile', async t => {
    const { s, db, ids } = await fixture(t);
    await db.prepare("UPDATE memberships SET status='left' WHERE user_id=?").bind(ids.author).run();
    assert.equal((await s.me(author)).profile.discName, 'author');
    assert.equal((await s.me(author)).team, null);
    await db.prepare("UPDATE users SET status='deleted' WHERE id=?").bind(ids.author).run();
    const minimal = { user: { id: ids.author, status: 'deleted' }, profile: null, membership: null, team: null };
    assert.deepEqual(await s.me(author), minimal);
    assert.deepEqual((await s.getBootstrap(author)).me, minimal);
});

test('new workspace reads existing reflections and bookmarks and safely retries an interrupted team publication', async t => {
    const { loadGrowth, loadNote, saveNote, prepareSave, bookmark, editRemark, removeBookmark } = await import('../../app/workspace-ui/growth.js');
    const { s, db } = await fixture(t);
    async function context(principal) {
        const actor = await actorKey(principal);
        const request = async (path, method = 'GET', input, key = crypto.randomUUID()) => {
            const url = new URL('/api/v1/' + path, 'https://kapok.test');
            const r = await dispatchApi(new Request(url, {method,
                headers: {'X-Kapok-Actor':actor, Origin:url.origin, 'Idempotency-Key':key, 'Content-Type':'application/json'},
                ...(input ? {body:JSON.stringify(input)} : {})}), path.split('/'), principal, s);
            const payload = await r.json();
            if (!r.ok) throw Object.assign(new Error(payload.error.message), payload.error);
            return payload.data;
        };
        return {read: path => request(path), write: request};
    }
    const mine = await context(author), other = await context(member);
    assert.deepEqual((await s.workspaceDispatch(member,null)).items, []);
    assert.deepEqual(await other.read('workspace/export-assets'), []);
    const existing = await s.saveReflection(author, null, content, 'legacy');
    const old = await loadNote(mine, existing.id);
    assert.equal(old.ownerId, 'me');
    assert.equal(old.body, content.text);
    assert.equal(old.category, undefined);
    await assert.rejects(loadNote(other, existing.id));
    const input = {title:'新版手记', body:'边线观察', category:'战术判断', scope:'team'};
    assert.equal(prepareSave(input,null,{},'2026-11-23').publish,false);
    const operation = prepareSave({...input,publish:true}, null, {trainingId:null,videoId:null}, '2026-11-23');
    let lost = false;
    const interrupted = {...mine, write: async (...args) => {
        const receipt = await mine.write(...args);
        if (!lost && args[0].endsWith('/grants')) { lost=true; throw Error('response lost'); }
        return receipt;
    }};
    await assert.rejects(saveNote(interrupted, operation), /response lost/);
    const result = await saveNote(mine, operation);
    assert.equal((await loadNote(other,result.id)).category, '战术判断');
    assert.equal((await s.listActivity(member)).items.some(row=>row.href==='/reflections/'+result.id), true);
    assert.equal((await loadGrowth(mine)).notes.length,2);
    assert.equal((await loadGrowth(other)).notes.length,0);
    const training = await s.saveTraining(admin,null,{title:'整场训练',description:'',date:content.date,status:'published'}, 'new-training');
    await bookmark(mine,{kind:'training',id:training.id});
    let saved = (await loadGrowth(mine)).saved[training.id];
    assert.equal(saved.title,'整场训练');
    await editRemark(mine,saved,'私人观察');
    await assert.rejects(editRemark(mine,saved,'旧版本覆盖'));
    assert.equal((await loadGrowth(other)).saved[training.id],undefined);
    await db.prepare("UPDATE trainings SET status='draft' WHERE id=?").bind(training.id).run();
    saved = (await loadGrowth(mine)).saved[training.id];
    assert.equal(saved.missing,true);
    assert.equal(saved.note,'私人观察');
    await removeBookmark(mine,saved);
    assert.equal((await loadGrowth(mine)).saved[training.id],undefined);
});

test('workspace resumes earlier local drafts under the same actor and retains the original source and receipt', async () => {
    const { listDeviceDrafts } = await import('../../lib/client/reflection-draft.ts');
    const { draftKey } = await import('../../lib/client/session-guard.ts');
    const { reflectionSeedPath } = await import('../../app/workspace-ui/growth.js');
    const body = { title:'旧草稿',text:'仅本人',date:'2026-11-15',trainingId:null,videoId:null };
    const draft = { ...body, trainingId:'',videoId:'',schema:1,updatedAt:'2026-11-15', cloud:null,
        pending:{ key:'original-save-key', targetId:null,body } };
    const entries = new Map([
        [draftKey('a','bad'),'{'],
        [draftKey('a','collection:old-id'),JSON.stringify(draft)],
        [draftKey('b','new'),JSON.stringify(draft)],
        [draftKey('a','bloom-notes'),JSON.stringify({})],
    ]);
    const storage = { length:entries.size, key:i=>[...entries.keys()][i], getItem:k=>entries.get(k) };
    assert.deepEqual(listDeviceDrafts(storage,'a'),[
        {href:'/reflections/new?collection=old-id',title:draft.title,updatedAt:draft.updatedAt,pending:true},
    ]);
    assert.deepEqual(JSON.parse(entries.get(draftKey('a','collection:old-id'))).pending,draft.pending);
    for (const [query, endpoint] of [
        ['collection=saved-id','collections/saved-id/reflection-seed'],
        ['video=clip&training=field','videos/clip'],
        ['training=field',null],
        ['sourceKind=topic_collection&sourceId=volume','learning/collections/volume/reflection-seed'],
        ['sourceKind=learning_post&sourceId=post','learning/posts/post/reflection-seed'],
    ]) assert.equal(reflectionSeedPath(new URLSearchParams(query)),endpoint);
});

test('an announcement revision remains private until republished and detects conflicting edits', async t => {
    const {s} = await fixture(t);
    const draft = await s.saveAnnouncement(admin,null,{title:'A',text:'',status:'editorDraft'},'notice-start');
    const live = await s.saveAnnouncement(admin,draft.id,{title:'A',text:'First',status:'published',expectedVersion:draft.version},'notice-live');
    const revision = {title:'B',text:'Second',status:'revision',expectedVersion:live.version};
    await s.saveAnnouncement(admin,live.id,revision,'notice-edit');
    assert.equal((await s.getAnnouncement(member,live.id)).text,'First');
    assert.equal((await s.getAnnouncement(member,live.id)).revisionText,undefined);
    await assert.rejects(s.listAnnouncements(member,true));
    const edit = (await s.listAnnouncements(admin,true)).find(row=>row.id===live.id);
    assert.equal(edit.revisionText,'Second');
    await assert.rejects(s.saveAnnouncement(admin,live.id,revision,'notice-stale'));
    await s.saveAnnouncement(admin,live.id,{title:'B',text:'Second',status:'published',expectedVersion:edit.version},'notice-next');
    assert.equal((await s.getAnnouncement(member,live.id)).text,'Second');
    assert.equal((await s.listAnnouncements(admin,true)).find(row=>row.id===live.id).revisionText,null);
});

test('inline reflection images stay local until upload, attach atomically and follow the current reading grant', async t => {
    const {s,db,ids,bucket} = await fixture(t);
    const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNY6W680t2YAUIBACG6BI0c0mdzAAAAAElFTkSuQmCC','base64');
    const alternate = Buffer.from('UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoCAAIAAUAmJaACdLoAA5gA/u7T3/wF090Yt/+hJ/8En/wSfuAAAA==','base64');
    const origin = 'https://kapok.test';
    async function req(p,method,path,body,type='application/json') {
        return dispatchApi(new Request(origin+path,{method,headers:{Origin:origin,'X-Kapok-Actor':await actorKey(p),
            'Content-Type':type,'Idempotency-Key':'stable-image'},body}),path.slice('/api/v1/'.length).split('?')[0].split('/'),p,s);
    }
    const upload = (id,bytes=data,mime='image/png',actor=author) => req(actor,'PUT','/api/v1/workspace/note-images/'+id+'/content',bytes,mime);
    const get = (p,url) => req(p,'GET',url);
    const first = crypto.randomUUID(), second = crypto.randomUUID(), staged = crypto.randomUUID();
    const note = await s.saveReflection(author,null,{...content,text:'',hasLocalPhotos:true},'image-only-draft');
    assert.equal(note.hasLocalPhotos,true);
    assert.equal(note.text,'');
    await denied(team(s,note),'INVALID_INPUT');
    const withText = await s.saveReflection(author,note.id,{...content,...state(note)},'retain-pending');
    assert.equal(withText.hasLocalPhotos,true);
    await denied(team(s,withText,'no-partial-share'),'INVALID_INPUT');
    assert.equal((await upload(first,Buffer.from('bogus'))).status,415);
    assert.equal((await upload(first,Buffer.alloc(8*1024*1024+1))).status,413);
    assert.equal((await upload(first)).status,200);
    assert.equal((await upload(first)).status,200);
    assert.equal((await upload(first,alternate,'image/webp')).status,409);
    assert.equal((await upload(second,alternate,'image/webp')).status,200);
    const thumbUrl='/api/v1/workspace/note-images/'+second+'/thumbnail';
    assert.equal((await req(author,'PUT',thumbUrl,data,'image/png')).status,200);
    assert.equal((await req(author,'PUT',thumbUrl,data,'image/png')).status,200);
    const photos = [{id:second,at:0,caption:'动作二'},{id:first,at:0,caption:'动作一'}];
    const savePayload={...content,text:'',photos,...state(withText)};
    const saved=await s.saveReflection(author,note.id,savePayload,'attach-both');
    assert.deepEqual((await s.saveReflection(author,note.id,savePayload,'attach-both')).photos,saved.photos);
    assert.deepEqual(saved.photos.map(({id,at,caption})=>({id,at,caption})),photos);
    assert.equal(saved.hasLocalPhotos,undefined);
    assert.equal((await get(member,saved.photos[0].url)).status,404);
    let image=await get(author,saved.photos[0].url);
    assert.equal(image.status,200);
    assert.equal(image.headers.get('content-type'),'image/webp');
    assert.match(image.headers.get('cache-control'),/no-store/);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()),alternate);
    const other = await s.saveReflection(member,null,content,'own-text');
    await assert.rejects(s.saveReflection(member,other.id,{...content,...state(other),photos},'steal'));
    assert.equal((await s.getOwnReflection(member,other.id)).version,other.version);
    await denied(s.saveReflection(author,note.id,{...savePayload,...state(saved),photos:[...photos,photos[0]]},'dupe'),'INVALID_INPUT');
    await denied(s.saveReflection(author,note.id,{...savePayload,...state(saved),photos:[{...photos[0],at:1}]},'beyond'),'INVALID_INPUT');
    const shared = await team(s,saved,'share-both');
    assert.equal((await get(member,saved.photos[0].url)).status,404);
    const published=await s.publishReflection(author,note.id,{...state(shared),published:true},'publish-both');
    const detail = await s.getReflection(member,note.id);
    assert.equal(detail.photos[0].url,published.photos[0].url);
    assert.equal((await get(member,detail.photos[0].url)).status,200);
    const activity=(await s.workspaceDispatch(member,null)).items.find(item=>item.source===note.id);
    assert.equal(activity.photoCount,2);
    assert.deepEqual(activity.firstPhoto,{url:detail.photos[0].url+'?size=thumb',caption:'动作二'});
    const thumbnail=await get(member,activity.firstPhoto.url);
    assert.equal(thumbnail.headers.get('content-type'),'image/png');
    assert.deepEqual(Buffer.from(await thumbnail.arrayBuffer()),data);
    const own=(await s.exportOwnData(author)).reflections.find(row=>row.id===note.id);
    assert.deepEqual(own.photos,detail.photos);
    assert.equal(own.version,published.version);
    assert.equal((await s.exportOwnData(member)).reflections.some(row=>row.id===note.id),false);
    await db.prepare("UPDATE memberships SET status='paused' WHERE user_id=?").bind(ids.member).run();
    assert.equal((await get(member,detail.photos[0].url)).status,403);
    await db.prepare("UPDATE memberships SET status='active' WHERE user_id=?").bind(ids.member).run();
    await db.prepare("UPDATE users SET status='deleted' WHERE id=?").bind(ids.author).run();
    assert.equal((await get(member,detail.photos[0].url)).status,404);
    await db.prepare("UPDATE users SET status='active' WHERE id=?").bind(ids.author).run();
    const current=await s.getOwnReflection(author,note.id);
    const updated=await s.saveReflection(author,note.id,{...content,...state(current)},'old-client');
    assert.equal(updated.photos.length,2);
    assert.equal((await get(member,detail.photos[0].url)).status,404);
    const tomb=await s.deleteReflection(author,note.id,state(updated),'delete');
    assert.equal(tomb.deleted,true);
    assert.equal((await get(author,updated.photos[0].url)).status,404);
    const recycle=(await s.listDeletedReflections(author)).find(row=>row.id===note.id);
    assert.equal(recycle.photos.length,2);
    const restored=await s.restoreReflection(author,note.id,state(recycle),'restore');
    assert.equal(restored.scope,'private');
    assert.equal((await get(member,restored.photos[0].url)).status,404);
    assert.equal((await get(author,restored.photos[0].url)).status,200);
    assert.equal((await upload(staged)).status,200);
    const count = async () => (await bucket.list({prefix:'reflection-images/'})).objects.length;
    assert.equal(await count(),4);
    await req(member,'DELETE','/api/v1/workspace/note-images/'+staged);
    assert.equal(await count(),4);
    await req(author,'DELETE','/api/v1/workspace/note-images/'+first);
    assert.equal(await count(),4);
    await req(author,'DELETE','/api/v1/workspace/note-images/'+staged);
    await req(author,'DELETE','/api/v1/workspace/note-images/'+staged);
    assert.equal(await count(),3);
});

test('0026 preserves populated private and shared notes, grants and versions with empty photo defaults', async t => {
    const {s,db}=await fixture(t,null,false,true);
    const privateNote=await s.saveReflection(author,null,content,'legacy-private');
    const draft=await s.saveReflection(author,null,{...content,text:'旧的公开复盘'},'legacy-shared');
    const shared=await team(s,draft);
    const published=await s.publishReflection(author,draft.id,{...state(shared),published:true},'to-feed');
    const before=await s.getReflection(member,draft.id);
    const sql=await readFile(new URL('../../drizzle/0026_reflection_photos.sql',import.meta.url),'utf8');
    await db.batch(sql.split('--> statement-breakpoint').map(statement=>db.prepare(statement.trim())));
    assert.deepEqual(await s.getReflection(member,draft.id),before);
    assert.deepEqual(await s.getOwnReflection(author,privateNote.id),privateNote);
    assert.deepEqual(await s.getOwnReflection(author,draft.id),published);
    assert.deepEqual((await db.prepare("SELECT DISTINCT photos,local_photos_pending FROM reflections").all()).results,[{photos:'[]',local_photos_pending:0}]);
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
    assert.equal((await s.workspaceDispatch(member,null)).items.find(row=>row.source===draft.id).photoCount,0);
});

test('lost image upload acknowledgment recovers without duplicate R2 bytes; a revoke during R2 read wins', async t=>{
    const {s,db,bucket}=await fixture(t);
    const id=crypto.randomUUID();
    const bytes=Buffer.from('UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoCAAIAAUAmJaACdLoAA5gA/u7T3/wF090Yt/+hJ/8En/wSfuAAAA==','base64');
    const body=()=>new Request('https://kapok.test',{method:'PUT',headers:{'Content-Type':'image/webp'},body:bytes});
    const lossy=createService({db,bucket:{put:async(...args)=>{await bucket.put(...args);throw new Error('lost response');}}});
    await assert.rejects(lossy.putReflectionImage(author,id,body(),'upload'),/lost response/);
    assert.deepEqual(await s.putReflectionImage(author,id,body(),'upload'),{id});
    assert.equal((await bucket.list({prefix:'reflection-images/'})).objects.length,1);
    const r=await s.saveReflection(author,null,{...content,photos:[{id,at:2,caption:'原来的图注'}]},'attach');
    const shared=await team(s,r);
    const rev=[shared.version,shared.sharingVersion,shared.generation].join('-');
    const beforeRevocation=createService({db,bucket:{get:async key=>{
        const file=await bucket.get(key);
        await s.shareReflection(author,r.id,{...state(shared),scope:'private'},'revoke');
        return file;
    }}});
    await denied(beforeRevocation.readReflectionImage(member,r.id,rev,id,false),'NOT_FOUND');
    const current=await s.getOwnReflection(author,r.id);
    const shortened=await s.saveReflection(author,r.id,{...content,text:'甲',...state(current)},'old-client-short-edit');
    assert.equal(shortened.photos[0].at,1);
    const removed=await s.saveReflection(author,r.id,{...content,...state(shortened),photos:[]},'remove-photo');
    assert.equal(removed.photos,undefined);
    await db.prepare("UPDATE reflection_images SET touched_at='2000-01-01' WHERE id=?").bind(id).run();
    await s.putReflectionImage(author,crypto.randomUUID(),body(),'later');
    assert.equal((await bucket.list({prefix:'reflection-images/'})).objects.length,1);
    assert.equal(await db.prepare('SELECT id FROM reflection_images WHERE id=?').bind(id).first(),null);
});
