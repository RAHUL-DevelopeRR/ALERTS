import {
  CUSTOMER_CANONICAL_FIELDS,
  ENTRY_CANONICAL_FIELDS,
  type CustomerRow,
  type DeviceInfo,
  type EntryRow,
  type ShopInfo,
} from '../../../shared/protocol';
import type { ShopRecord } from '../env';

/** customers / entries as stored in D1 (wire row + shop_id). */
export type CustomerDb = CustomerRow & { shop_id: string; received_at: string };
export type EntryDb = EntryRow & { shop_id: string; received_at: string };

export const toShopInfo = (s: ShopRecord): ShopInfo => ({ id: s.id, name: s.name, upi_id: s.upi_id, lang: s.lang });

export const toDeviceInfo = (d: DeviceInfo): DeviceInfo => ({
  id: d.id,
  name: d.name,
  role: d.role,
  created_at: d.created_at,
  last_seen_at: d.last_seen_at ?? null,
  revoked_at: d.revoked_at ?? null,
});

export const toCustomerRow = (r: CustomerRow): CustomerRow => ({
  id: r.id,
  code: r.code,
  name: r.name,
  search_name: r.search_name,
  phone: r.phone,
  note: r.note,
  archived_at: r.archived_at,
  erased_at: r.erased_at,
  created_at: r.created_at,
  updated_at: r.updated_at,
  updated_by: r.updated_by,
  received_at: r.received_at ?? null,
});

export const toEntryRow = (r: EntryRow): EntryRow => ({
  id: r.id,
  customer_id: r.customer_id,
  kind: r.kind,
  amount_paise: r.amount_paise,
  delta_paise: r.delta_paise,
  biz_date: r.biz_date,
  note: r.note,
  mode: r.mode,
  reverses_entry_id: r.reverses_entry_id,
  device_id: r.device_id,
  created_at: r.created_at,
  received_at: r.received_at ?? null,
});

function sameFields(a: Record<string, unknown>, b: Record<string, unknown>, fields: readonly string[]): boolean {
  for (const f of fields) if ((a[f] ?? null) !== (b[f] ?? null)) return false;
  return true;
}

/**
 * Same client-owned content (server-filled fields excluded), for idempotent replays. created_at is left out: the
 * server keeps the first stored value on every update, so comparing it would turn each resend of an edit that
 * carries a different created_at into a fresh 'stored' with a new seq.
 */
const CUSTOMER_REPLAY_FIELDS = CUSTOMER_CANONICAL_FIELDS.filter((f) => f !== 'created_at');
export const sameCustomer = (stored: CustomerRow, pushed: Record<string, unknown>) =>
  sameFields(stored as unknown as Record<string, unknown>, pushed, CUSTOMER_REPLAY_FIELDS);

export const sameEntry = (stored: EntryRow, pushed: Record<string, unknown>) =>
  sameFields(stored as unknown as Record<string, unknown>, pushed, ENTRY_CANONICAL_FIELDS);

export const DEVICE_COLUMNS = 'id, name, role, created_at, last_seen_at, revoked_at';

export async function listDevices(db: D1Database, shopId: string): Promise<DeviceInfo[]> {
  const { results } = await db
    .prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE shop_id = ? ORDER BY created_at, id`)
    .bind(shopId)
    .all<DeviceInfo>();
  return results.map(toDeviceInfo);
}
