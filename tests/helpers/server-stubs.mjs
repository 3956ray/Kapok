// Only the official request-header and D1 service boundaries are controlled for server-page SSR.
export let serverMe;
let serverBootstrap = { initialized: false, canBootstrap: false };
export function setServerBootstrap(value) { serverBootstrap = value; }
export function setServerMe(value) { serverMe = value; }
export async function headers() { return new Headers({ host: 'kapok.local', 'oai-authenticated-user-id': 'A', 'oai-authenticated-user-email': 'synthetic@example.invalid' }); }
export function getService() { return { getAccount: async () => serverMe, getBootstrap: async () => serverBootstrap, getOwnReflection: async () => null }; }
