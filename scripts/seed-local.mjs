// Explicit local-only fixture. This file never reads credentials or contacts a hosted D1.
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createService } from '../lib/server/domain.ts';

const args = process.argv.slice(2);
if (!args.includes('--confirm-local') || args.some((arg, index) => !['--confirm-local', '--state-dir'].includes(arg) && args[index - 1] !== '--state-dir')) {
  console.error('Usage: node scripts/seed-local.mjs --confirm-local [--state-dir <local-state-directory>]');
  process.exit(1);
}
const root = resolve(import.meta.dirname, '..');
const stateIndex = args.indexOf('--state-dir');
const stateDirectory = resolve(stateIndex >= 0 ? args[stateIndex + 1] : resolve(root, '.wrangler/state'));
// Matches vite.config.ts localBindingConfig; never replace this with a hosted database ID.
const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("local seed");}}', compatibilityDate: '2026-05-22', d1Databases: { DB: '00000000-0000-4000-8000-000000000000' }, d1Persist: resolve(stateDirectory, 'v3/d1') });
try {
  const db = await mf.getD1Database('DB');
  if (!await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").first()) {
    const migration = await readFile(resolve(root, 'drizzle/0000_identity.sql'), 'utf8');
    await db.batch(migration.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  }
  const principal = { subject: 'local_seedy' };
  const service = createService({ db, bootstrapSiteUserId: principal.subject });
  const status = await service.getBootstrap(principal);
  if (status.initialized && status.me.membership?.role !== 'admin') throw new Error('Local dataset already belongs to another subject; no changes made.');
  if (status.initialized) console.log('Local synthetic dataset already initialized. Sign in as official local_seedy; create further synthetic invites in /admin/invites.');
  else {
    const result = await service.bootstrap(principal, { discName: '合成领队', jerseyNumber: '01' }, 'local-bootstrap-v1');
    console.log('Local synthetic dataset initialized for official loopback local_seedy. No hosted data changed.');
    console.log(`Local synthetic invitation (one use, do not send to real members): /join/${result.inviteToken}`);
  }
} finally { await mf.dispose(); }
