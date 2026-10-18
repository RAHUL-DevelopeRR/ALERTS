declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    PEPPER: string;
    SETUP_KEY: string;
    DAILY_REQUEST_CAP: string;
    PAIR_THROTTLE_AFTER: string;
    PAIR_LIMITER: RateLimit;
    AUTH_LIMITER: RateLimit;
    AUTH_THROTTLE_AFTER: string;
    GOOGLE_CLIENT_IDS: string;
    GOOGLE_ANDROID_CLIENT_IDS: string;
    GOOGLE_HD: string;
    ASSETS: Fetcher;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
