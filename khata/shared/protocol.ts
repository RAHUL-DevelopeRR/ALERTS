/**
 * Kadan Kanakku sync protocol: the single contract shared by the Android app (khata/app)
 * and the Cloudflare Worker (khata/api). Both import this file by relative path.
 *
 * Ledger rules (see docs/GROCERY_DEBT_APP_PLAN.md):
 *  - Money is integer paise. Never floats.
 *  - Entries are append-only. A mistake is fixed by a REVERSAL entry (+ optionally a new corrected entry).
 *  - A customer's balance is SUM(delta_paise) over their entries (positive = customer owes the shop).
 *  - Every row id is a client-generated UUID v4 and doubles as the idempotency key.
 *  - Customer rows are last-write-wins in SERVER order (the row the server accepted last is current).
 *  - Ordering for sync is the server's append-only change log (`seq`), never row timestamps.
 */

export const API_VERSION = 'v1';
/** Max rows (customers + entries) in one POST /sync/push. The server answers 413 above this. */
export const MAX_PUSH_ROWS = 20;
/** Default and max page size for GET /sync/pull. */
export const PULL_PAGE_SIZE = 500;
/** Customer codes are handed to devices in blocks of this size. */
export const CODE_BLOCK_SIZE = 50;
/** Pairing codes are 8 decimal digits and live this many minutes. */
export const PAIR_CODE_TTL_MIN = 10;
/** Setup (first owner) pairing codes live longer, because the developer relays them by phone/WhatsApp. */
export const SETUP_CODE_TTL_MIN = 24 * 60;

export type Role = 'owner' | 'staff';
export type EntryKind = 'GIVE' | 'RECEIVE' | 'WRITEOFF' | 'REVERSAL';
export type PayMode = 'CASH' | 'UPI' | 'OTHER';
export type Lang = 'ta' | 'en';
export type Tbl = 'customers' | 'entries';

/**
 * Customer as it travels on the wire (push body and pull stream).
 * `code` is the human handle shown as C-0042 (the number 42).
 * `phone` is optional, E.164 (+91XXXXXXXXXX) when present, and NOT unique.
 * `updated_at`/`updated_by` are informational (phone clock + device id); `received_at` is the server clock.
 */
export interface CustomerRow {
  id: string;
  code: number;
  name: string;
  search_name: string | null;
  phone: string | null;
  note: string | null;
  archived_at: string | null;
  /** Set only by POST /customers/:id/erase. Terminal: later name/phone/note writes are refused (ERASED). */
  erased_at: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string;
  /** Server-filled. Ignored in push bodies. */
  received_at?: string | null;
}

/**
 * Ledger entry on the wire.
 * delta_paise: +amount for GIVE, -amount for RECEIVE and WRITEOFF, exactly -(original.delta_paise) for REVERSAL.
 * biz_date: 'YYYY-MM-DD' business day in Asia/Kolkata (may be back-dated, never in the future).
 * A REVERSAL copies the original's customer_id, amount_paise, biz_date and mode.
 */
export interface EntryRow {
  id: string;
  customer_id: string;
  kind: EntryKind;
  amount_paise: number;
  delta_paise: number;
  biz_date: string;
  note: string | null;
  mode: PayMode | null;
  reverses_entry_id: string | null;
  /** Author device. In push bodies the server ignores this and uses the authenticated device. */
  device_id: string;
  created_at: string;
  /** Server-filled. Ignored in push bodies. */
  received_at?: string | null;
}

export interface ShopInfo {
  id: string;
  name: string;
  upi_id: string | null;
  lang: Lang;
}

export interface DeviceInfo {
  id: string;
  name: string;
  role: Role;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

/** Every successful JSON response from an authenticated route includes these. */
export interface Envelope {
  server_time: string;
  sync_epoch: string;
}

/** Error body for every non-2xx response. */
export interface ApiError {
  error: string;
  message?: string;
  /** Present on 401 for a revoked device whose owner asked to wipe the local copy. */
  wipe?: boolean;
}

// ---------------------------------------------------------------- routes (all under /v1)

/** GET /v1/health  (no auth) -> { ok: true } after SELECT 1 */
export interface HealthResponse { ok: true }

/**
 * POST /v1/setup  (no bearer token; header `X-Setup-Key: <SETUP_KEY secret>`)
 * Creates the shop if none exists (using shop_name), otherwise reuses the existing one, and mints a
 * single-use OWNER pairing code valid SETUP_CODE_TTL_MIN minutes. If the SETUP_KEY secret is not set,
 * the route answers 404. Wrong key -> 403. This is the developer's bootstrap and last-resort recovery path.
 */
export interface SetupRequest { shop_name?: string }
export interface SetupResponse { shop: ShopInfo; code: string; expires_at: string }

/**
 * POST /v1/pair  (no bearer token; throttled, see API README)
 * `code` = an 8-digit pairing code or an owner recovery code (XXXX-XXXX-XXXX-XXXX; dashes/spaces/case ignored).
 * `max_local_code` = highest customer code this phone allocated before pairing; the server raises its
 *   customer-code sequence to at least this before issuing the first block, so codes never collide.
 * `previous_device_id` = this phone's old device id (if it was paired before); revoked in the same batch
 *   when it belongs to the same shop.
 * Errors: 400 bad_request, 403 invalid_code (unknown/used/expired), 429 throttled.
 */
export interface PairRequest {
  code: string;
  device_name: string;
  max_local_code?: number;
  previous_device_id?: string;
}
export interface PairResponse extends Envelope {
  token: string;
  device_id: string;
  role: Role;
  shop: ShopInfo;
  code_block: { start: number; end: number };
}

/** GET /v1/me -> who am I (cheap token check used by Settings). */
export interface MeResponse extends Envelope { device: DeviceInfo; shop: ShopInfo }

/** POST /v1/devices/pair-code  (owner) -> new 8-digit code for another phone. */
export interface PairCodeRequest { role: Role }
export interface PairCodeResponse extends Envelope { code: string; expires_at: string; role: Role }

/** POST /v1/devices/recovery-codes  (owner). Replaces all unused recovery codes; plaintext shown once. */
export interface RecoveryCodesRequest { count?: number /* 3..5, default 5 */ }
export interface RecoveryCodesResponse extends Envelope { codes: string[] }

/** POST /v1/devices/code-block  (any) -> next CODE_BLOCK_SIZE customer codes for this device. */
export interface CodeBlockRequest { max_local_code?: number }
export interface CodeBlockResponse extends Envelope { start: number; end: number }

/** GET /v1/devices  (owner) */
export interface DevicesResponse extends Envelope { devices: DeviceInfo[] }

/** POST /v1/devices/:id/revoke  (owner). A device cannot revoke itself (400). */
export interface RevokeRequest { wipe?: boolean }
export interface OkResponse extends Envelope { ok: true }

/** PUT /v1/shop  (owner) */
export interface ShopUpdateRequest { name?: string; upi_id?: string | null; lang?: Lang }
export interface ShopUpdateResponse extends Envelope { shop: ShopInfo }

/**
 * POST /v1/customers/:id/erase  (owner). DPDP erasure: name/search_name/phone/note are overwritten with
 * "Erased <YYYY-MM-DD>" (search_name/phone/note -> null), erased_at and received_at = server clock,
 * one change-log row appended. Entries are kept. Returns the updated row.
 */
export interface EraseResponse extends Envelope { customer: CustomerRow }

/**
 * POST /v1/sync/push  (any). At most MAX_PUSH_ROWS rows (413 otherwise).
 * Customers are processed before entries. Each row gets exactly one result.
 */
export interface PushRequest { customers: CustomerRow[]; entries: EntryRow[] }
export type PushStatus = 'stored' | 'already' | 'rejected';
export interface PushResult {
  tbl: Tbl;
  id: string;
  status: PushStatus;
  /** Change-log seq of the row (stored: newly assigned; already: its latest seq). */
  seq?: number;
  reason?: RejectReason;
}
export interface PushResponse extends Envelope { results: PushResult[] }

/**
 * Rejection reasons. RETRIABLE ones stay in the client's outbox; the rest mark the row
 * sync_state='rejected' (excluded from every balance) and list it under "Needs attention".
 */
export type RejectReason =
  | 'BAD_ROW'              // malformed: missing/invalid fields, bad uuid, bad date format, name empty
  | 'BAD_AMOUNT'           // amount not a positive safe integer, or delta sign/size wrong for kind
  | 'FUTURE_DATE'          // biz_date later than server IST date + 1 day
  | 'UNKNOWN_CUSTOMER'     // RETRIABLE: customer not on server and not accepted in this push
  | 'UNKNOWN_ORIGINAL'     // RETRIABLE: reversal target not on server and not accepted in this push
  | 'ALREADY_REVERSED'     // target already has a reversal (client auto-resolves: hides its duplicate)
  | 'REVERSAL_OF_REVERSAL' // target is itself a REVERSAL
  | 'REVERSAL_MISMATCH'    // customer/amount/mode/biz_date differ from the original, or delta != -original.delta
  | 'ARCHIVE_NONZERO'      // archive requested while balance (server + this chunk) != 0
  | 'CODE_TAKEN'           // RETRIABLE: (shop, code) belongs to a different customer id; client reallocates code
  | 'ERASED'               // change to an erased customer
  | 'FORBIDDEN_ROLE'       // staff pushing WRITEOFF or an archive
  | 'MISMATCH'             // same id already stored with different canonical content
  | 'BATCH_FAILED';        // a single-row chunk still failed inside the DB batch

export const RETRIABLE_REASONS: ReadonlySet<RejectReason> = new Set<RejectReason>([
  'UNKNOWN_CUSTOMER',
  'UNKNOWN_ORIGINAL',
  'CODE_TAKEN',
]);

/**
 * GET /v1/sync/pull?since=<seq>&limit=<n>  (any)
 * Returns change-log rows with seq > since, EXCLUDING rows authored by the calling device, in seq order,
 * each joined to the row's CURRENT content. `next_since` = last seq examined in this page (advance the
 * cursor to it even if every row in the page was filtered out). Also returns the device list and shop.
 */
export type Change =
  | { seq: number; tbl: 'customers'; row: CustomerRow }
  | { seq: number; tbl: 'entries'; row: EntryRow };
export interface PullResponse extends Envelope {
  changes: Change[];
  next_since: number;
  has_more: boolean;
  devices: DeviceInfo[];
  shop: ShopInfo;
}

/** GET /v1/export  (owner) -> full JSON copy of the shop (streamed). */
export interface ExportFile {
  format: 'kadan-kanakku-export';
  version: 1;
  exported_at: string;
  shop: ShopInfo;
  devices: DeviceInfo[];
  customers: CustomerRow[];
  entries: EntryRow[];
}

/** Canonical (client-owned) fields compared for idempotent replays. Server-filled fields are excluded. */
export const ENTRY_CANONICAL_FIELDS = [
  'id', 'customer_id', 'kind', 'amount_paise', 'delta_paise', 'biz_date', 'note', 'mode',
  'reverses_entry_id', 'created_at',
] as const;
export const CUSTOMER_CANONICAL_FIELDS = [
  'id', 'code', 'name', 'search_name', 'phone', 'note', 'archived_at', 'updated_at', 'created_at',
] as const;
