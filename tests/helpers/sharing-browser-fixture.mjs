// Test-only synthetic business data. Never imported by the application.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { createService } from '../../lib/server/domain.ts';
import { sitesPrincipal } from './identity-fixture.mjs';
export const principals = Object.fromEntries(['admin', 'author', 'member', 'outsider'].map(role => [role, sitesPrincipal(`sharing_${role}`)]));
export const versions = r => ({ expectedVersion: r.version, expectedSharingVersion: r.sharingVersion, expectedGeneration: r.generation });
export const syntheticContent = { title: '合成复盘·分享核验', text: '仅用于本机合成身份的分享核验正文。', date: '2026-10-19', trainingId: null, videoId: null };
export async function createSharingFixture({ persist } = {}) {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("synthetic fixture")}}', compatibilityDate: '2026-05-22',
        d1Databases: { DB: '00000000-0000-4000-8000-000000000000' }, r2Buckets: ['BUCKET'], ...(persist ? { d1Persist: resolve(persist, 'v3/d1') } : {}) });
    try {
        const db = await mf.getD1Database('DB');
        const files = (await readdir(new URL('../../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
        for (const file of files) {
            const sql = await readFile(new URL('../../drizzle/' + file, import.meta.url), 'utf8');
            for (const statement of sql.split('--> statement-breakpoint').flatMap(part => part.includes('CREATE TRIGGER') ? [part] : part.split(';')).map(part => part.trim()).filter(Boolean)) await db.prepare(statement).run();
        }
        const service = createService({ db, bucket: await mf.getR2Bucket('BUCKET'), bootstrapSiteUserId: principals.admin.subject });
        await service.bootstrap(principals.admin, { discName: '合成管理员', jerseyNumber: '01' }, 'sharing-bootstrap');
        for (const role of ['author', 'member']) {
            const invite = await service.createInvite(principals.admin, {}, `sharing-invite-${role}`);
            await service.join(principals[role], { token: invite.inviteToken, discName: role === 'author' ? '合成作者' : '合成队员', jerseyNumber: role === 'author' ? '07' : '08' }, `sharing-join-${role}`);
        }
        const ids = {};
        for (const role of ['admin', 'author', 'member']) ids[role] = (await service.me(principals[role])).user.id;
        return { mf, db, service, ids, dispose: () => mf.dispose() };
    } catch (e) { await mf.dispose(); throw e; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (!process.argv.includes('--confirm-local')) throw new Error('Pass --confirm-local for isolated synthetic setup.');
    const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const folder = resolve(project, '.sites-runtime/reflection-sharing');
    const state = resolve(folder, 'state');
    await mkdir(folder, { recursive: true });
    // Refuse reuse instead of resetting any existing preview or fixture data.
    await mkdir(state);
    const fixture = await createSharingFixture({ persist: state });
    try {
        const target = await fixture.service.saveReflection(principals.author, null, syntheticContent, 'sharing-target');
        for (let index = 0; index < 31; index++) {
            let filler = await fixture.service.saveReflection(principals.admin, null, { ...syntheticContent, title: `合成分页背景 ${index + 1}` }, `sharing-filler-${index}`);
            filler = await fixture.service.shareReflection(principals.admin, filler.id, { ...versions(filler), scope: 'team' }, `sharing-filler-team-${index}`);
            await fixture.service.publishReflection(principals.admin, filler.id, { ...versions(filler), published: true }, `sharing-filler-publish-${index}`);
        }
        const manifest = { evidence: 'LOCAL_SYNTHETIC_BUILT_BROWSER_ONLY', targetId: target.id, authorId: fixture.ids.author, subjects: principals, state, backgroundPublishedRows: 31 };
        await writeFile(resolve(folder, 'fixture.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
        console.log(JSON.stringify(manifest, null, 2));
    } finally { await fixture.dispose(); }
}
