import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createService } from '../../lib/server/domain.ts';
import { dispatchApi } from '../../lib/server/http.ts';
const admin = {
    subject: 'admin'
};
const author = {
    subject: 'author'
};
const member = {
    subject: 'member'
};
const coach = {
    subject: 'coach'
};
const outsider = {
    subject: 'outsider'
};
const content = {
    title: '',
    text: '私人的训练思考',
    date: '2026-10-16',
    trainingId: null,
    videoId: null
};
const denied = (promise, code = 'NOT_FOUND') => assert.rejects(promise, e => e.code === code);
async function fixture(t, beforeReflections = null, legacy = false) {
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
        assert.equal(response.headers.get('X-Kapok-Actor'), member.subject);
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
                    'X-Kapok-Actor': author.subject,
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
