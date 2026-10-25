import type { ClientKind, Lang, Role } from '../../shared/protocol';

/** Server build version reported by GET /v1/config. */
export const SERVER_VERSION = '2.0.0';

/** Worker bindings: D1, plain vars from wrangler.jsonc and secrets (PEPPER, SETUP_KEY). */
export interface Bindings {
  DB: D1Database;
  /** Required secret mixed into every token / code hash. */
  PEPPER?: string;
  /** Optional secret enabling POST /v1/setup. */
  SETUP_KEY?: string;
  /** Requests per device per UTC day (default 10000: a busy counter phone left open day and night makes about 4,000 at most). */
  DAILY_REQUEST_CAP?: string;
  PAIR_THROTTLE_AFTER?: string;
  /** Workers Rate Limiting binding: per-client-IP first layer in front of /pair. Optional. */
  PAIR_LIMITER?: RateLimit;
  /** Per-client-IP first layer in front of /auth/prelogin, /auth/login and /auth/google. Optional. */
  AUTH_LIMITER?: RateLimit;
  /** Wrong password logins per UTC day before the shop-wide throttle (default 100). */
  AUTH_THROTTLE_AFTER?: string;
  /** Comma-separated WEB Google OAuth client ids accepted as `aud` for client 'web'; the FIRST is shown to the browser. Empty = Google off on the web. */
  GOOGLE_CLIENT_IDS?: string;
  /** Comma-separated ANDROID (Credential Manager) client ids accepted as `aud` for client 'android'. Empty = Google off on Android (404). */
  GOOGLE_ANDROID_CLIENT_IDS?: string;
  /** Optional Google Workspace domain whose addresses may be pre-registered as google_email besides gmail.com. */
  GOOGLE_HD?: string;
  /** Workers static assets (the web app in ../app/dist-web). Only /v1/* reaches the Worker. */
  ASSETS?: Fetcher;
}

/** The authenticated device, as returned by the auth UPDATE ... RETURNING. */
export interface DeviceRecord {
  id: string;
  shop_id: string;
  name: string;
  role: Role;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  requests_today: number;
  user_id: string | null;
  client: ClientKind | null;
  stepup_until: string | null;
  expires_at: string | null;
}

export interface ShopRecord {
  id: string;
  name: string;
  upi_id: string | null;
  lang: Lang;
  sync_epoch: string;
  created_at: string;
}

export interface Vars {
  device: DeviceRecord;
  shop: ShopRecord;
}

export type AppEnv = { Bindings: Bindings; Variables: Vars };

export function intVar(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
