import { LEGACY_SITES_ISSUER } from '../../lib/contracts/index.ts';
import { actorKey } from '../../lib/server/identity.ts';

export const sitesPrincipal = subject => ({ provider: 'site', issuer: LEGACY_SITES_ISSUER, subject });
export { actorKey };
