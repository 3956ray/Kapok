import { safeReturnTo } from './return-to';

export const makersPreview = process.env.KAPOK_MAKERS_PREVIEW === '1';

export function productionLoginPath(returnTo: unknown) {
  const url = new URL('https://kapok.party/login');
  url.searchParams.set('returnTo', safeReturnTo(returnTo));
  return url.href;
}
