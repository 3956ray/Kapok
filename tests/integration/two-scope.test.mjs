import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createService } from '../../lib/server/domain.ts';
import { dispatchApi } from '../../lib/server/http.ts';
import { sha256 } from '../../lib/server/identity.ts';

const author = { subject: 'author' }, coach = { subject: 'coach' }, admin = { subject: 'admin' };
const body = { title: '保留标题', text: '逐字保留正文\n第二行 🥏', date: '2026-10-18', trainingId: null, videoId: null };
const state = r => ({ expectedVersion: r.version, expectedSharingVersion: r.sharingVersion, expectedGeneration: r.generation });
const denied = (promise, code) => assert.rejects(promise, e => e.code === code);
const split = sql => sql.split('--> statement-breakpoint').flatMap(x => x.includes('CREATE TRIGGER') ? [x] : x.split(';')).map(x => x.trim()).filter(Boolean);
async function fixture(t) {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("test")}}', compatibilityDate: '2026-05-22', d1Databases: ['DB'] });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database('DB');
    for (const file of (await readdir(new URL('../../drizzle/', import.meta.url))).filter(x => x.endsWith('.sql') && x < '0005').sort()) {
        for (const statement of split(await readFile(new URL('../../drizzle/' + file, import.meta.url), 'utf8'))) await db.prepare(statement).run();
    }
    const options = { db, bootstrapSiteUserId: admin.subject, clock: () => new Date('2026-10-18T01:00:00.000Z') };
    const s = createService(options);
    await s.bootstrap(admin, { discName: '管理员', jerseyNumber: '01' }, 'bootstrap');
    for (const p of [author, coach]) {
        const invite = await s.createInvite(admin, {}, 'invite-' + p.subject);
        await s.join(p, { token: invite.inviteToken, discName: p.subject, jerseyNumber: '07' }, 'join');
    }
    const a = await s.me(author), c = await s.me(coach);
    await db.prepare("UPDATE memberships SET role='coach' WHERE user_id=?").bind(c.user.id).run();
    const rows = async () => (await db.prepare('SELECT * FROM reflections ORDER BY id').all()).results;
    const migration = async (extra = []) => {
        const sql = await readFile(new URL('../../drizzle/0005_two_scope_reflections.sql', import.meta.url), 'utf8');
        return db.batch([...split(sql).map(x => db.prepare(x)), ...extra]);
    };
    const legacy = async (id, deleted = false) => {
        await db.prepare(`INSERT INTO reflections(id,owner_id,team_id,title,text,date,version,sharing_version,generation,
            scope,coach_id,coach_epoch,author_epoch,gate,active_op_id,deleted_at,created_at,updated_at)
            VALUES(?,?,?,?,?,?,7,11,3,'coach',?,?,?,?,'old-held-op',?,?,?)`).bind(id, a.user.id, a.membership.teamId, body.title, body.text, body.date,
            c.user.id, c.membership.epoch, a.membership.epoch, deleted ? 'closed' : 'open', deleted ? '2026-10-18T00:00:00.000Z' : null,
            '2026-10-18T00:00:00.000Z', '2026-10-18T00:00:00.000Z').run();
        return s.getOwnReflection(author, id).catch(() => null);
    };
    const paused = () => {
        let release, entered;
        const ready = new Promise(resolve => { entered = resolve; });
        const wait = new Promise(resolve => { release = resolve; });
        const delayed = createService({ ...options, db: { prepare: (...args) => db.prepare(...args), batch: async statements => { entered(); await wait; return db.batch(statements); } } });
        return { delayed, ready, release: () => release() };
    };
    return { s, db, a, c, legacy, rows, migration, paused };
}

test('two-scope migration preserves active/deleted body, author, association and versions; leaves private/team/publication untouched', async t => {
    const { s, db, a, c, legacy, rows, migration } = await fixture(t);
    const training = await s.saveTraining(admin, null, { title: '关联训练', description: '', date: body.date, status: 'published' }, 'training');
    const video = await s.addVideo(admin, training.id, { title: '关联视频', source: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD', position: 0 }, 'video');
    await legacy('active'); await legacy('deleted', true);
    await db.prepare('UPDATE reflections SET training_id=?,video_id=?').bind(training.id, video.id).run();
    // A legacy recipient's personal collection survives revocation, but its source is no longer readable.
    await db.prepare("INSERT INTO collections(id,owner_id,source_kind,source_id,private_note,created_at,updated_at) VALUES('old-note',?,'reflection','active','私人备注','2026-10-18','2026-10-18')").bind(c.user.id).run();
    await s.saveReflection(author, null, body, 'private');
    const unpublished = await s.saveReflection(author, null, body, 'team-unpublished');
    await s.shareReflection(author, unpublished.id, { ...state(unpublished), scope: 'team' }, 'unpublished-share');
    let team = await s.saveReflection(author, null, body, 'team');
    team = await s.shareReflection(author, team.id, { ...state(team), scope: 'team', coachId: null }, 'team-share');
    await s.publishReflection(author, team.id, { ...state(team), published: true }, 'publish');
    const before = await rows();
    await migration();
    for (const row of await rows()) {
        const original = before.find(x => x.id === row.id);
        if (original.scope !== 'coach') { assert.deepEqual(row, original); continue; }
        assert.deepEqual(row, { ...original, scope: 'private', coach_id: null, coach_epoch: null, author_epoch: null, published_at: null, gate: 'closed', active_op_id: null, sharing_version: 12 });
    }
    const own = await s.getOwnReflection(author, 'active');
    assert.equal(own.text, body.text); assert.equal(own.scope, 'private'); assert.equal('coachId' in own, false);
    await denied(s.getReflection(coach, 'active'), 'NOT_FOUND');
    assert.equal((await s.getMemberProfile(coach, a.user.id)).reflections.some(x => x.id === 'active'), false);
    assert.equal((await s.listActivity(coach)).items.some(x => x.id === 'active'), false);
    const note = (await s.listCollections(coach)).find(x => x.id === 'old-note');
    assert.equal(note.privateNote, '私人备注'); assert.equal(note.source, null);
    assert.equal((await s.listManagedMembers(admin)).find(x => x.userId === c.user.id).role, 'coach');
    const deleted = (await s.listDeletedReflections(author)).find(x => x.id === 'deleted');
    assert.equal(deleted.scope, 'private'); assert.equal(deleted.text, body.text);
    const restored = await s.restoreReflection(author, deleted.id, state(deleted), 'restore-legacy');
    assert.equal(restored.scope, 'private'); assert.equal(restored.published, false);
    await denied(s.getReflection(coach, deleted.id), 'NOT_FOUND');
});

test('two-scope zero-row migration installs DB INSERT/UPDATE rejection for old Workers, without blocking private/team', async t => {
    const { s, db, a, c, migration } = await fixture(t);
    await migration();
    const r = await s.saveReflection(author, null, body, 'new-private');
    await assert.rejects(db.prepare("UPDATE reflections SET scope='coach',coach_id=?,coach_epoch=1 WHERE id=?").bind(c.user.id, r.id).run(), /two_scope/);
    await assert.rejects(db.prepare(`INSERT INTO reflections(id,owner_id,team_id,text,date,scope,coach_id,coach_epoch,created_at,updated_at)
        VALUES('old-insert',?,?,'body','2026-10-18','coach',?,1,'now','now')`).bind(a.user.id, a.membership.teamId, c.user.id).run(), /two_scope/);
    await assert.rejects(db.prepare('UPDATE reflections SET coach_id=? WHERE id=?').bind(c.user.id, r.id).run(), /two_scope/);
    await assert.rejects(db.prepare('UPDATE reflections SET coach_epoch=1 WHERE id=?').bind(r.id).run(), /two_scope/);
    const team = await s.shareReflection(author, r.id, { ...state(r), scope: 'team' }, 'new-team');
    assert.equal(team.scope, 'team'); assert.equal(team.published, false);
    // An old Worker may have a fresh expected version and still try its obsolete grant SQL.
    // The DB fence must roll back its operation insertion and intermediate lock too.
    const before = await db.prepare('SELECT * FROM reflections WHERE id=?').bind(r.id).first();
    await assert.rejects(db.batch([
        db.prepare("INSERT INTO operations(id,actor_id,kind,target_id,key,input_hash,status,created_at) VALUES('old-worker',?,'reflection-share',?,'old-worker','old-hash','pending','now')").bind(a.user.id, r.id),
        db.prepare("UPDATE reflections SET gate='closed',active_op_id='old-worker',sharing_version=sharing_version+1 WHERE id=? AND sharing_version=?").bind(r.id, team.sharingVersion),
        db.prepare("UPDATE reflections SET scope='coach',coach_id=?,coach_epoch=1,gate='open',active_op_id=NULL WHERE id=? AND active_op_id='old-worker'").bind(c.user.id, r.id)
    ]), /two_scope/);
    assert.deepEqual(await db.prepare('SELECT * FROM reflections WHERE id=?').bind(r.id).first(), before);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM operations WHERE id='old-worker'").first()).n, 0);
});

test('two-scope API validates before done/pending replay, rejects fresh coach fields, removes coaches capability', async t => {
    const { s, db, a, c, legacy, migration } = await fixture(t);
    await legacy('old');
    const input = { scope: 'coach', coachId: c.user.id, expected: { version: 7, sharing: 11, generation: 3 } };
    for (const status of ['done', 'pending']) await db.prepare(`INSERT INTO operations(id,actor_id,kind,target_id,key,input_hash,status,result_json,created_at)
        VALUES(?,?,'reflection-share','old',?,?,?,?, 'now')`).bind(status, a.user.id, status, await sha256(JSON.stringify(input)), status, status === 'done' ? '{"id":"old"}' : null).run();
    await migration();
    for (const key of ['done', 'pending', 'fresh']) await denied(s.shareReflection(author, 'old', { scope: 'coach', coachId: c.user.id, expectedVersion: 7, expectedSharingVersion: 11, expectedGeneration: 3 }, key), 'INVALID_INPUT');
    const r = await s.getOwnReflection(author, 'old');
    await denied(s.shareReflection(author, r.id, { ...state(r), scope: 'team' }, 'done'), 'IDEMPOTENCY_CONFLICT');
    for (const scope of ['private', 'team']) await denied(s.shareReflection(author, r.id, { ...state(r), scope, coachId: c.user.id }, 'nonnull-' + scope), 'INVALID_INPUT');
    assert.equal(typeof s.listCoaches, 'undefined');
    const response = await dispatchApi(new Request('https://kapok.test/api/v1/coaches'), ['coaches'], author, s);
    assert.equal(response.status, 404);
    assert.equal((await s.shareReflection(author, r.id, { ...state(r), scope: 'private', coachId: null }, 'null-compat')).scope, 'private');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM operations WHERE key IN (\'done\',\'pending\')').first()).n, 2);
});

test('two-scope migration fences held share and publication batches; no stale operation commits', async t => {
    const { s, db, c, legacy, migration, paused } = await fixture(t);
    await legacy('held');
    // The old coach row is closed while a new two-scope request is being prepared.
    await db.prepare("UPDATE reflections SET gate='open',active_op_id=NULL WHERE id='held'").run();
    const old = await s.getOwnReflection(author, 'held');
    const share = paused();
    const held = share.delayed.shareReflection(author, old.id, { ...state(old), scope: 'team', coachId: null }, 'held-share');
    await share.ready;
    let team = await s.saveReflection(author, null, body, 'publication-body');
    team = await s.shareReflection(author, team.id, { ...state(team), scope: 'team' }, 'publication-team');
    const publication = paused();
    const heldPublication = publication.delayed.publishReflection(author, team.id, { ...state(team), published: true }, 'held-publication');
    await publication.ready;
    // A still-running old Worker changes the row before the new migration arrives.
    await db.prepare("UPDATE reflections SET scope='coach',coach_id=?,coach_epoch=1,published_at=NULL WHERE id=?").bind(c.user.id, team.id).run();
    await migration();
    share.release(); publication.release();
    await denied(held, 'VERSION_CONFLICT'); await denied(heldPublication, 'VERSION_CONFLICT');
    assert.equal((await db.prepare("SELECT count(*) AS n FROM operations WHERE key IN ('held-share','held-publication')").first()).n, 0);
    for (const id of [old.id, team.id]) { assert.equal((await s.getOwnReflection(author, id)).scope, 'private'); await denied(s.getReflection(coach, id), 'NOT_FOUND'); }
});

test('two-scope migration batch failure rolls back revocation AND triggers, then retries once', async t => {
    const { db, legacy, rows, migration } = await fixture(t);
    await legacy('rollback');
    const before = await rows();
    await assert.rejects(migration([db.prepare("INSERT INTO write_guards(op_id,phase,pass) VALUES('migration-fault','fault',0)")]), /CHECK constraint/);
    assert.deepEqual(await rows(), before);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'reflection_two_scope_%'").first()).n, 0);
    // Fail in the revocation UPDATE itself, after both trigger statements were attempted.
    await db.prepare("CREATE TRIGGER synthetic_migration_fault BEFORE UPDATE ON reflections BEGIN SELECT RAISE(ABORT,'synthetic revocation failure'); END").run();
    await assert.rejects(migration(), /synthetic revocation failure/);
    assert.deepEqual(await rows(), before);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'reflection_two_scope_%'").first()).n, 0);
    await db.prepare('DROP TRIGGER synthetic_migration_fault').run();
    await migration();
    assert.equal((await rows())[0].sharing_version, 12);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'reflection_two_scope_%'").first()).n, 2);
});
