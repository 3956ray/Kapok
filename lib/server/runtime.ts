import { createService } from './domain';

export async function getService() {
  const { env } = await import('cloudflare:workers');
  if (!env.DB) throw new Error('D1 binding DB is unavailable.');
  return createService({ db: env.DB, bucket: env.BUCKET, accessInitialAdminEmail: env.ACCESS_INITIAL_ADMIN_EMAIL });
}
