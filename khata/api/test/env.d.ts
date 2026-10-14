declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    PEPPER: string;
    SETUP_KEY: string;
    DAILY_REQUEST_CAP: string;
    PAIR_THROTTLE_AFTER: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
