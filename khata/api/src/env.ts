import type { Lang, Role } from '../../shared/protocol';

/** Worker bindings: D1, plain vars from wrangler.jsonc and secrets (PEPPER, SETUP_KEY). */
export interface Bindings {
  DB: D1Database;
  /** Required secret mixed into every token / code hash. */
  PEPPER?: string;
  /** Optional secret enabling POST /v1/setup. */
  SETUP_KEY?: string;
  DAILY_REQUEST_CAP?: string;
  PAIR_THROTTLE_AFTER?: string;
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
