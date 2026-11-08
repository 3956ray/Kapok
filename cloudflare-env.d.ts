declare namespace Cloudflare {
  interface Env {
    ACCESS_ALLOWED_HOST?: string;
    ACCESS_ISSUER?: string;
    ACCESS_INITIAL_ADMIN_EMAIL?: string;
    ACCESS_AUDIENCE?: string;
    ASSETS?: Fetcher;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
