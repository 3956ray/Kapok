import { env } from 'cloudflare:workers';
import { createService } from './domain';

export function getService() {
  if (!env.DB) throw new Error('D1 binding DB is unavailable.');
  const config = env as Cloudflare.Env & { BOOTSTRAP_SITE_USER_ID?: string };
  return createService({ db: env.DB, bucket: env.BUCKET, bootstrapSiteUserId: config.BOOTSTRAP_SITE_USER_ID });
}
