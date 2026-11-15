// Explicit local-only fixture. This file never reads credentials or contacts a hosted D1.
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LEGACY_SITES_ISSUER } from '../lib/contracts/index.ts';
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
  async function migrate(file) {
    const migration = await readFile(resolve(root, 'drizzle', file), 'utf8');
    await db.batch(migration.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  }
  if (!await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").first()) {
    await migrate('0000_identity.sql');
  }
  if (!(await db.prepare("PRAGMA table_info(auth_identities)").all()).results.some(column => column.name === 'issuer')) {
    await migrate('0006_identity_namespace.sql');
  }
  if (!(await db.prepare("PRAGMA table_info(invites)").all()).results.some(column => column.name === 'recipient_email')) {
    await migrate('0007_email_bound_invites.sql');
  }
  if (!(await db.prepare("PRAGMA table_info(profiles)").all()).results.some(column => column.name === 'bio')) {
    await migrate('0011_profile_bio.sql');
  }
  const principal = { provider: 'site', issuer: LEGACY_SITES_ISSUER, subject: 'local_seedy' };
  const service = createService({ db, bootstrapSiteUserId: principal.subject });
  const status = await service.getBootstrap(principal);
  if (status.initialized && status.me.membership?.role !== 'admin') throw new Error('Local dataset already belongs to another subject; no changes made.');
  if (status.initialized) console.log('Local synthetic dataset already initialized. Sign in as official local_seedy.');
  else {
    await service.bootstrap(principal, { discName: '合成领队', jerseyNumber: '01' }, 'local-bootstrap-v1');
    console.log('Local synthetic dataset initialized for official loopback local_seedy. No hosted data changed.');
  }
} finally { await mf.dispose(); }
