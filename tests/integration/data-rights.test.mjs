import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createService } from '../../lib/server/domain.ts';
import { dispatchApi } from '../../lib/server/http.ts';

const admin = { subject: 'admin' };
const author = { subject: 'author' };
const member = { subject: 'member' };
const coach = { subject: 'coach' };
const content = { title: '本人标题', text: '本人复盘正文', date: '2026-10-16' };
const state = r => ({
    expectedVersion: r.version,
    expectedSharingVersion: r.sharingVersion,
    expectedGeneration: r.generation,
});
const expected = m => ({ expectedVersion: m.version, expectedEpoch: m.epoch });
const denied = (promise, code) => assert.rejects(promise, e => e.code === code);

async function fixture(t, legacy = false) {
    const mf = new Miniflare({
        modules: true,
        script: 'export default {fetch(){return new Response("test")}}',
        compatibilityDate: '2026-05-22',
        d1Databases: ['DB'],
    });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database('DB');
    for (const file of (await readdir(new URL('../../drizzle/', import.meta.url))).filter(x => x.endsWith('.sql')).sort()) {
        if (legacy && file === '0005_two_scope_reflections.sql') continue;
        const sql = await readFile(new URL('../../drizzle/' + file, import.meta.url), 'utf8');
        for (const statement of sql.split('--> statement-breakpoint').flatMap(x => x.includes('CREATE TRIGGER') ? [x] : x.split(';')).map(x => x.trim()).filter(Boolean)) {
            await db.prepare(statement).run();
        }
    }
    let time = new Date('2026-10-16T12:00:00.000Z');
    const options = { db, clock: () => time, bootstrapSiteUserId: admin.subject };
    const s = createService(options);
    await s.bootstrap(admin, { discName: '管理员', jerseyNumber: '01' }, 'bootstrap');
    for (const p of [author, member, coach]) {
        const invite = await s.createInvite(admin, {}, 'invite-' + p.subject);
        await s.join(p, { token: invite.inviteToken, discName: p.subject, jerseyNumber: '07' }, 'join');
    }
    const ids = {};
    for (const p of [admin, author, member, coach]) ids[p.subject] = (await s.me(p)).user.id;
    const membership = async p => (await s.me(p)).membership;
    const change = async (p, values, key) => s.updateMembership(admin, ids[p.subject], { ...expected(await membership(p)), ...values }, key);
    const pausedBatch = () => {
        let release;
        let entered;
        const ready = new Promise(resolve => { entered = resolve; });
        const wait = new Promise(resolve => { release = resolve; });
        const delayed = createService({ ...options, db: {
            prepare: (...args) => db.prepare(...args),
            batch: async statements => { entered(); await wait; return db.batch(statements); },
        } });
        return { delayed, ready, release: () => release() };
    };
    return { s, db, ids, membership, change, pausedBatch, setTime: value => { time = new Date(value); } };
}

test('fresh own export omits other bodies, email and grant internals; unavailable references stay generic', async t => {
    const { s, ids, change } = await fixture(t);
    const training = await s.saveTraining(admin, null, { title: '训练秘密标题', description: '训练源正文', date: '2026-10-16', status: 'published' }, 'training');
    const video = await s.addVideo(admin, training.id, { title: '视频源标题', source: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD', position: 0 }, 'video');
    const comment = await s.saveComment(author, video.id, null, { text: '本人评论', timestampSec: 12, rootId: null }, 'comment');
    await s.saveComment(member, video.id, null, { text: '他人评论禁止导出', timestampSec: null, rootId: null }, 'other-comment');
    let other = await s.saveReflection(member, null, { ...content, text: '他人复盘禁止导出' }, 'other');
    other = await s.shareReflection(member, other.id, { ...state(other), scope: 'team', coachId: null }, 'other-share');
    await s.saveReflection(author, null, content, 'own');
    await s.saveCollection(author, null, { sourceKind: 'reflection', sourceId: other.id, privateNote: '本人备注', timestampSec: null }, 'collect');
    await s.saveCollection(author, null, { sourceKind: 'comment', sourceId: comment.id, privateNote: '本人秒数', timestampSec: 12 }, 'collect-comment');
    let data = await s.exportOwnData(author);
    assert.equal(data.profile.discName, 'author');
    assert.equal(data.reflections[0].text, content.text);
    assert.equal(data.comments[0].text, '本人评论');
    assert.equal(data.collections[0].sourceAvailable, true);
    for (const forbidden of ['他人评论禁止导出', '他人复盘禁止导出', '训练源正文', '训练秘密标题', '视频源标题', 'coachId', 'coach_epoch', 'author_epoch', 'email']) {
        assert.equal(JSON.stringify(data).includes(forbidden), false, forbidden);
    }
    await s.shareReflection(member, other.id, { ...state(other), scope: 'private', coachId: null }, 'revoke');
    data = await s.exportOwnData(author);
    assert.equal(data.collections.find(c => c.sourceId === other.id).sourceAvailable, false);
    await change(author, { role: 'member', status: 'paused' }, 'pause');
    data = await s.exportOwnData(author);
    assert.ok(data.collections.every(c => !c.sourceAvailable));
    assert.equal(data.collections.find(c => c.sourceId === other.id).privateNote, '本人备注');
    assert.equal(data.comments[0].text, '本人评论');
    assert.equal(JSON.stringify(await s.exportOwnData(admin)).includes(content.text), false);
    await denied(s.exportOwnData({ subject: 'outsider' }), 'FORBIDDEN');
    const own = await dispatchApi(new Request('https://kapok.test/api/v1/me/export'), ['me', 'export'], author, s);
    assert.equal(own.status, 200);
    assert.match(own.headers.get('Cache-Control'), /no-store/);
    assert.equal(own.headers.get('X-Kapok-Actor'), author.subject);
    const guessed = await dispatchApi(new Request('https://kapok.test/api/v1/me/' + ids.author + '/export'), ['me', ids.author, 'export'], member, s);
    assert.equal(guessed.status, 404);
    const anonymous = await dispatchApi(new Request('https://kapok.test/api/v1/me/export'), ['me', 'export'], null, s);
    assert.equal(anonymous.status, 401);
});

test('delete hides immediately; owner recycle restores only private and replay returns current state', async t => {
    const { s } = await fixture(t);
    let r = await s.saveReflection(author, null, content, 'save');
    r = await s.shareReflection(author, r.id, { ...state(r), scope: 'team', coachId: null }, 'share');
    r = await s.publishReflection(author, r.id, { ...state(r), published: true }, 'publish');
    const before = r;
    await s.deleteReflection(author, r.id, state(r), 'delete');
    await denied(s.getReflection(member, r.id), 'NOT_FOUND');
    assert.deepEqual((await s.listActivity(member)).items, []);
    assert.deepEqual(await s.listMyReflections(author), []);
    const [deleted] = await s.listDeletedReflections(author);
    assert.equal(deleted.text, content.text);
    assert.equal(deleted.recoverUntil, '2026-10-23T12:00:00.000Z');
    assert.deepEqual(await s.listDeletedReflections(member), []);
    await denied(s.restoreReflection(member, r.id, state(deleted), 'stolen'), 'NOT_FOUND');
    r = await s.restoreReflection(author, r.id, state(deleted), 'restore');
    assert.equal(r.scope, 'private');
    assert.equal(r.published, false);
    assert.equal('coachId' in r, false);
    assert.equal(r.generation, deleted.generation + 1);
    assert.equal(r.version, deleted.version + 1);
    assert.equal(r.sharingVersion, deleted.sharingVersion + 1);
    await denied(s.getReflection(member, r.id), 'NOT_FOUND');
    await denied(s.publishReflection(author, r.id, { ...state(before), published: true }, 'old-publish'), 'INVALID_INPUT');
    r = await s.saveReflection(author, r.id, { ...content, text: '恢复后新正文', ...state(r) }, 'new-edit');
    assert.equal((await s.restoreReflection(author, r.id, state(deleted), 'restore')).text, r.text);
    await denied(s.restoreReflection(author, r.id, { ...state(deleted), expectedVersion: deleted.version + 1 }, 'restore'), 'IDEMPOTENCY_CONFLICT');
    await s.deleteReflection(author, r.id, state(r), 'delete-again');
    await denied(s.restoreReflection(author, r.id, state(deleted), 'restore'), 'NOT_FOUND');
});

test('restore exact seven-day deadline, old prepared jobs and zero-effect final update are guarded in D1', async t => {
    const { s, db, pausedBatch, setTime } = await fixture(t);
    let r = await s.saveReflection(author, null, content, 'save');
    await s.deleteReflection(author, r.id, state(r), 'delete');
    const [deleted] = await s.listDeletedReflections(author);
    const pause = pausedBatch();
    const old = pause.delayed.restoreReflection(author, r.id, state(deleted), 'delayed-restore');
    await pause.ready;
    r = await s.restoreReflection(author, r.id, state(deleted), 'winner');
    await s.deleteReflection(author, r.id, state(r), 'new-delete');
    pause.release();
    await denied(old, 'VERSION_CONFLICT');
    const [latest] = await s.listDeletedReflections(author);
    await db.prepare("CREATE TRIGGER suppress_restore BEFORE UPDATE ON reflections WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL BEGIN SELECT RAISE(IGNORE); END").run();
    await denied(s.restoreReflection(author, r.id, state(latest), 'zero-effect'), 'VERSION_CONFLICT');
    assert.equal((await db.prepare("SELECT count(*) AS n FROM operations WHERE key IN ('zero-effect','delayed-restore')").first()).n, 0);
    assert.equal((await s.listDeletedReflections(author))[0].generation, latest.generation);
    await db.prepare('DROP TRIGGER suppress_restore').run();
    setTime('2026-10-23T12:00:00.000Z');
    assert.deepEqual(await s.listDeletedReflections(author), []);
    await denied(s.restoreReflection(author, r.id, state(latest), 'expired'), 'NOT_FOUND');
});

test('minimum lifecycle is server authorized, rotates rejoin epoch and never resurrects sharing', async t => {
    const { s, db, ids, change, membership } = await fixture(t, true);
    await change(coach, { role: 'coach', status: 'active' }, 'appoint');
    let r = await s.saveReflection(author, null, content, 'save');
    // Legacy fixture before 0005; new API must never create directed grants.
    await db.prepare("UPDATE reflections SET scope='coach',coach_id=?,coach_epoch=(SELECT epoch FROM memberships WHERE user_id=?),author_epoch=(SELECT epoch FROM memberships WHERE user_id=owner_id),gate='open' WHERE id=?").bind(ids.coach, ids.coach, r.id).run();
    await denied(s.listManagedMembers(author), 'FORBIDDEN');
    await denied(s.updateMembership(member, ids.coach, { ...expected(await membership(coach)), role: 'member', status: 'active' }, 'unauthorized'), 'FORBIDDEN');
    assert.equal((await s.listManagedMembers(admin)).length, 4);
    const input = { ...expected(await membership(coach)), role: 'member', status: 'active' };
    await s.updateMembership(admin, ids.coach, input, 'demote');
    await denied(s.getReflection(coach, r.id), 'NOT_FOUND');
    const migration = await readFile(new URL('../../drizzle/0005_two_scope_reflections.sql', import.meta.url), 'utf8');
    await db.batch(migration.split('--> statement-breakpoint').map(x => db.prepare(x.trim())));
    await change(coach, { role: 'coach', status: 'active' }, 'reappoint');
    const replay = await s.updateMembership(admin, ids.coach, input, 'demote');
    assert.equal(replay.role, 'coach');
    await denied(s.updateMembership(admin, ids.coach, { ...input, role: 'admin' }, 'demote'), 'IDEMPOTENCY_CONFLICT');
    await denied(s.getReflection(coach, r.id), 'NOT_FOUND');
    r = await s.getOwnReflection(author, r.id);
    r = await s.shareReflection(author, r.id, { ...state(r), scope: 'team', coachId: null }, 'team');
    const old = await membership(author);
    await s.leaveTeam(author, expected(old), 'leave');
    assert.equal((await s.me(author)).membership.status, 'left');
    assert.equal((await s.exportOwnData(author)).reflections[0].text, content.text);
    await denied(s.listMembers(author), 'FORBIDDEN');
    await denied(s.getReflection(member, r.id), 'NOT_FOUND');
    const invite = await s.createInvite(admin, {}, 'rejoin-invite');
    await s.join(author, { token: invite.inviteToken, discName: 'author', jerseyNumber: '07' }, 'rejoin');
    assert.ok((await membership(author)).epoch > old.epoch);
    assert.equal((await s.leaveTeam(author, expected(old), 'leave')).membership.status, 'active');
    await denied(s.getReflection(member, r.id), 'NOT_FOUND');
    const previous = await membership(author);
    await change(author, { role: 'member', status: 'paused' }, 'pause');
    await change(author, { role: 'member', status: 'active' }, 'resume');
    assert.ok((await membership(author)).epoch > previous.epoch);
});

test('last active admin survives self-demotion, self-leave and concurrent distinct admin changes', async t => {
    const { s, db, ids, change, membership } = await fixture(t);
    const initial = await membership(admin);
    await denied(s.leaveTeam(admin, expected(initial), 'last-leave'), 'MEMBERSHIP_CONFLICT');
    await denied(s.updateMembership(admin, ids.admin, { ...expected(initial), role: 'member', status: 'active' }, 'last-demote'), 'MEMBERSHIP_CONFLICT');
    assert.equal((await membership(admin)).version, initial.version);
    await change(member, { role: 'admin', status: 'active' }, 'new-admin');
    const results = await Promise.allSettled([
        s.leaveTeam(admin, expected(await membership(admin)), 'race-admin'),
        s.leaveTeam(member, expected(await membership(member)), 'race-member'),
    ]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.status='active' AND m.role='admin' AND u.status='active'").first()).n, 1);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM operations WHERE key IN ('race-admin','race-member')").first()).n, 1);
});

test('membership stale prepared mutation and zero-effect update roll back operation and audit', async t => {
    const { s, db, ids, change, membership, pausedBatch } = await fixture(t);
    const old = await membership(coach);
    const pause = pausedBatch();
    const mutation = pause.delayed.updateMembership(admin, ids.coach, { ...expected(old), role: 'coach', status: 'active' }, 'delayed-member');
    await pause.ready;
    await change(coach, { role: 'member', status: 'paused' }, 'newer-pause');
    pause.release();
    await denied(mutation, 'MEMBERSHIP_CONFLICT');
    const current = await membership(coach);
    await db.prepare('CREATE TRIGGER suppress_member BEFORE UPDATE ON memberships BEGIN SELECT RAISE(IGNORE); END').run();
    await denied(s.updateMembership(admin, ids.coach, { ...expected(current), role: 'member', status: 'active' }, 'zero-member'), 'MEMBERSHIP_CONFLICT');
    assert.equal((await membership(coach)).version, current.version);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM operations WHERE key IN ('delayed-member','zero-member')").first()).n, 0);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM moderation_audit').first()).n, 1);
});

test('a held export snapshot rechecks source revocation, owner leave and account disable inside D1', async t => {
    const { s, db, ids, membership, pausedBatch } = await fixture(t);
    let r = await s.saveReflection(member, null, { ...content, text: '他人正文永不导出' }, 'other');
    r = await s.shareReflection(member, r.id, { ...state(r), scope: 'team', coachId: null }, 'share');
    await s.saveCollection(author, null, { sourceKind: 'reflection', sourceId: r.id, privateNote: '保留本人备注' }, 'collect');
    const revokePause = pausedBatch();
    const beforeRevoke = revokePause.delayed.exportOwnData(author);
    await revokePause.ready;
    r = await s.shareReflection(member, r.id, { ...state(r), scope: 'private', coachId: null }, 'revoke');
    revokePause.release();
    const afterRevoke = await beforeRevoke;
    assert.equal(afterRevoke.collections[0].sourceAvailable, false);
    assert.equal(JSON.stringify(afterRevoke).includes('他人正文永不导出'), false);
    r = await s.shareReflection(member, r.id, { ...state(r), scope: 'team', coachId: null }, 'reshare');
    const leavePause = pausedBatch();
    const beforeLeave = leavePause.delayed.exportOwnData(author);
    await leavePause.ready;
    await s.leaveTeam(author, expected(await membership(author)), 'leave');
    leavePause.release();
    assert.equal((await beforeLeave).collections[0].sourceAvailable, false);
    const disablePause = pausedBatch();
    const beforeDisable = disablePause.delayed.exportOwnData(author);
    await disablePause.ready;
    await db.prepare("UPDATE users SET status='deleted',version=version+1 WHERE id=?").bind(ids.author).run();
    disablePause.release();
    await denied(beforeDisable, 'FORBIDDEN');
});

test('an old prepared publication cannot reopen sharing after delete and restore; last millisecond recovery works', async t => {
    const { s, pausedBatch, setTime } = await fixture(t);
    let r = await s.saveReflection(author, null, content, 'save');
    r = await s.shareReflection(author, r.id, { ...state(r), scope: 'team', coachId: null }, 'team');
    const pause = pausedBatch();
    const publication = pause.delayed.publishReflection(author, r.id, { ...state(r), published: true }, 'old-publication');
    await pause.ready;
    await s.deleteReflection(author, r.id, state(r), 'delete');
    const [deleted] = await s.listDeletedReflections(author);
    setTime('2026-10-23T11:59:59.999Z');
    r = await s.restoreReflection(author, r.id, state(deleted), 'restore');
    pause.release();
    await denied(publication, 'VERSION_CONFLICT');
    assert.equal((await s.getOwnReflection(author, r.id)).scope, 'private');
    await denied(s.getReflection(member, r.id), 'NOT_FOUND');
    assert.deepEqual((await s.listActivity(member)).items, []);
});

test('concurrent admin demotions and last-admin pause preserve one active administrator', async t => {
    const { s, db, ids, change, membership } = await fixture(t);
    await denied(s.updateMembership(admin, ids.admin, { ...expected(await membership(admin)), role: 'admin', status: 'paused' }, 'last-pause'), 'MEMBERSHIP_CONFLICT');
    await change(member, { role: 'admin', status: 'active' }, 'appoint');
    const results = await Promise.allSettled([
        s.updateMembership(admin, ids.admin, { ...expected(await membership(admin)), role: 'member', status: 'active' }, 'demote-self'),
        s.updateMembership(admin, ids.member, { ...expected(await membership(member)), role: 'member', status: 'active' }, 'demote-other'),
    ]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.status='active' AND m.role='admin' AND u.status='active'").first()).n, 1);
});

test('paused member can explicitly leave; suppressed lifecycle audit rolls back membership and grant revocation', async t => {
    const { s, db, ids, change, membership } = await fixture(t);
    let r = await s.saveReflection(author, null, content, 'save');
    r = await s.shareReflection(author, r.id, { ...state(r), scope: 'team', coachId: null }, 'share');
    await db.prepare('CREATE TRIGGER suppress_lifecycle_audit BEFORE INSERT ON moderation_audit BEGIN SELECT RAISE(IGNORE); END').run();
    await denied(s.leaveTeam(author, expected(await membership(author)), 'no-audit'), 'MEMBERSHIP_CONFLICT');
    assert.equal((await membership(author)).status, 'active');
    assert.equal((await s.getReflection(member, r.id)).text, content.text);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM operations WHERE key='no-audit'").first()).n, 0);
    await db.prepare('DROP TRIGGER suppress_lifecycle_audit').run();
    await change(author, { role: 'member', status: 'paused' }, 'pause');
    await s.leaveTeam(author, expected(await membership(author)), 'paused-leave');
    assert.equal((await membership(author)).status, 'left');
    const audit = await db.prepare("SELECT reason FROM moderation_audit WHERE actor_id=? AND action='member-leave'").bind(ids.author).first();
    assert.equal(JSON.parse(audit.reason).from.status, 'paused');
    assert.equal(JSON.parse(audit.reason).to.status, 'left');
});
