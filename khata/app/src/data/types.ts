/**
 * App-side domain types and the Repo contract. src/data/repo.ts implements Repo on top of src/db/db.ts.
 * The UI (src/ui/**) and the sync engine (src/sync/**) depend ONLY on this interface and src/core/ledger.ts.
 */
import type {
  CustomerRow, EntryRow, EntryKind, PayMode, Lang, Role, PushResult, PullResponse, DeviceInfo, ShopInfo,
} from '../../../shared/protocol';

export type { CustomerRow, EntryRow, EntryKind, PayMode, Lang, Role };
export type SyncState = 'pending' | 'accepted' | 'rejected';

export interface Customer extends CustomerRow {
  server_seq: number | null;
  sync_state: SyncState;
  reject_reason: string | null;
}

export interface Entry extends EntryRow {
  server_seq: number | null;
  sync_state: SyncState;
  reject_reason: string | null;
}

/** One row of the home list (single query). Balances exclude rejected entries. */
export interface HomeRow {
  id: string;
  code: number;
  name: string;
  search_name: string | null;
  phone: string | null;
  note: string | null;
  archived_at: string | null;
  erased_at: string | null;
  balance_paise: number;
  /** Latest biz_date of any counted entry, or null. */
  last_activity: string | null;
  /** Latest biz_date of an un-reversed RECEIVE, or null. */
  last_payment: string | null;
  /** Earliest biz_date of a GIVE, or null. */
  first_give: string | null;
  /** Days from (last_payment ?? first_give) to today (IST); null when neither exists. */
  days_since: number | null;
  /** Customer row or any of its entries is pending upload. */
  has_pending: boolean;
  /** Customer row or any of its entries was rejected by the server (badge). */
  has_rejected: boolean;
}

/** An entry as shown on the customer screen / statement, oldest first, with running balance. */
export interface EntryView extends Entry {
  /** Running balance after this row (excludes rejected rows; reversed pairs still both count, they cancel). */
  running_paise: number;
  /** This entry has been reversed by `reversed_by` (a counted REVERSAL row). */
  is_reversed: boolean;
  reversed_by: string | null;
  /** Name of the device that wrote it (from the devices mirror), or null for this/unknown device. */
  device_name: string | null;
}

export interface Statement {
  customer: Customer;
  from: string;              // inclusive biz_date
  to: string;                // inclusive biz_date
  opening_paise: number;     // balance before `from`
  closing_paise: number;     // balance at end of `to`
  rows: EntryView[];         // entries with biz_date in [from, to], running balance seeded with opening
  /** Given/received totals in the period, excluding reversed originals and their reversals. */
  given_paise: number;
  received_paise: number;
}

export interface StatementPeriod { from: string; to: string; kind: 'since_zero' | 'settled' | 'last30' | 'all' | 'custom' }

export interface DayBookTotals {
  biz_date: string;
  given_paise: number;           // GIVE not reversed
  received_paise: number;        // RECEIVE not reversed
  received_cash_paise: number;
  received_upi_paise: number;
  received_other_paise: number;  // mode OTHER or NULL
  writeoff_paise: number;        // WRITEOFF not reversed (positive number)
  net_paise: number;             // SUM(delta) over all counted rows (reversed pairs cancel)
  corrections_count: number;     // REVERSAL rows that day
  entry_count: number;
}

export interface DayBookRow extends Entry {
  customer_code: number;
  customer_name: string;
  device_name: string | null;
  is_reversed: boolean;
}

export interface DayBook { totals: DayBookTotals; rows: DayBookRow[] }

export interface NeedsAttentionItem {
  tbl: 'customers' | 'entries';
  id: string;
  reason: string;
  /** Short human description, e.g. "₹250 Gave · Kamala (C-0042) · 12 Oct". */
  summary: string;
  customer_id: string;
}

export interface Settings {
  shop_name: string;
  upi_id: string | null;
  lang: Lang;
  /** PIN lock enabled (a PIN has been set). */
  pin_set: boolean;
  lock_timeout_min: number;          // 2 | 10 | 30, default 10
  confirm_above_paise: number;       // default 10_000_00 (₹10,000)
  /** Paired with a server? */
  paired: boolean;
  server_url: string | null;
  device_id: string;                 // provisional 'local-<uuid>' until paired
  device_name: string | null;
  role: Role;                        // 'owner' when unpaired
  last_sync_at: string | null;
  last_sync_error: string | null;
  last_backup_at: string | null;     // last user-initiated export
  clock_offset_ms: number;           // server_time - device time from the last sync (0 if unknown)
}

/** Meta keys persisted in the `meta` table. */
export const META_KEYS = [
  'device_id', 'device_name', 'role', 'server_url', 'cursor', 'sync_epoch',
  'code_next', 'code_end', 'spare_start', 'spare_end',
  'shop_id', 'shop_name', 'upi_id', 'lang',
  'pin_hash', 'pin_salt', 'lock_timeout_min', 'confirm_above_paise',
  'last_sync_at', 'last_sync_error', 'last_backup_at', 'last_snapshot_at', 'clock_offset_ms',
  'onboarded',
  /** "<shop_id> <sync_epoch>" of the server this phone was paired with before the last unpair (see completePairing). */
  'last_pairing',
  /** Voice entry (v2, local only): JSON prefs {on, lang, bare, notice_ok} and the accuracy counters {heard, saved, ...}. */
  'voice_prefs', 'voice_stats',
  /** Spoken name -> customer id pairs learned on this phone (src/ui/voice/aliases.ts). */
  'voice_aliases',
] as const;
export type MetaKey = (typeof META_KEYS)[number];

/** Local backup file written by exportBackup() and read by importBackup(). */
export interface BackupFile {
  format: 'kadan-kanakku-backup';
  version: 1;
  exported_at: string;
  shop_name: string;
  customers: CustomerRow[];
  entries: EntryRow[];
}

export interface NewCustomerInput {
  name: string;
  phone?: string | null;      // any user format; repo normalises to E.164 (+91 default) or throws BAD_PHONE
  note?: string | null;
  search_name?: string | null;
}

export interface NewEntryInput {
  customer_id: string;
  kind: 'GIVE' | 'RECEIVE' | 'WRITEOFF';
  amount_paise: number;
  biz_date?: string;          // default: today IST (clock-offset corrected)
  note?: string | null;
  mode?: PayMode | null;      // RECEIVE only
}

/** What the sync engine pushes: current content of outboxed rows, customers first, at most `limit` rows. */
export interface OutboxBatch {
  customers: CustomerRow[];
  entries: EntryRow[];
}

/**
 * Errors thrown by Repo methods use `new RepoError(code)`; the UI maps codes to localized messages.
 * Codes: BAD_AMOUNT, FUTURE_DATE, BAD_DATE, BAD_NAME, BAD_PHONE, NOT_FOUND, ALREADY_REVERSED,
 * CANNOT_REVERSE_REVERSAL, ARCHIVE_NONZERO, CODES_EXHAUSTED, ERASED, BAD_BACKUP, OWNER_ONLY.
 */
export class RepoError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
    this.name = 'RepoError';
  }
}

export interface Repo {
  // ---- lifecycle
  /** Ensure device_id (provisional), default settings and a provisional code range exist. Idempotent. */
  init(): Promise<void>;

  // ---- settings / meta
  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Pick<Settings, 'shop_name' | 'upi_id' | 'lang' | 'lock_timeout_min' | 'confirm_above_paise' | 'device_name'>>): Promise<Settings>;
  getMeta(key: MetaKey): Promise<string | null>;
  setMeta(key: MetaKey, value: string | null): Promise<void>;
  /** PBKDF2-SHA256 (WebCrypto, 150k iterations, random 16-byte salt). Empty/null pin clears the lock. */
  setPin(pin: string | null): Promise<void>;
  verifyPin(pin: string): Promise<boolean>;

  // ---- customers
  listHome(): Promise<HomeRow[]>;
  /** Total the shop is owed (sum of positive balances) and total advances (sum of negative balances, as positive). */
  totals(): Promise<{ receivable_paise: number; advance_paise: number; customers_owing: number }>;
  getCustomer(id: string): Promise<Customer | null>;
  /** Active (not archived, not erased) customers with this normalised phone, excluding `exceptId`. */
  findByPhone(phone: string, exceptId?: string): Promise<Customer[]>;
  /** Active customers whose name equals `name` case/space-insensitively, excluding `exceptId`. */
  findBySameName(name: string, exceptId?: string): Promise<Customer[]>;
  /** Allocates the next customer code; writes the row + outbox in one transaction. */
  createCustomer(input: NewCustomerInput): Promise<Customer>;
  updateCustomer(id: string, patch: Partial<NewCustomerInput>): Promise<Customer>;
  /** Owner only; refused (ARCHIVE_NONZERO) unless balance is 0. */
  archiveCustomer(id: string): Promise<Customer>;
  unarchiveCustomer(id: string): Promise<Customer>;
  /** Apply an erasure: if `serverRow` is given (paired shop, server already erased) store it as accepted;
   *  if unpaired, erase locally. Also purges local snapshots' copies on the next snapshot rotation. */
  applyErasure(id: string, serverRow?: CustomerRow): Promise<Customer>;
  balance(customerId: string): Promise<number>;

  // ---- entries
  /** Validates (BAD_AMOUNT, FUTURE_DATE...), inserts entry + outbox in one transaction, returns new balance. */
  addEntry(input: NewEntryInput): Promise<{ entry: Entry; balance_paise: number }>;
  /** Appends a REVERSAL (same customer, amount, biz_date, mode as the original). Refuses a reversal of a
   *  reversal, an already-reversed entry, and a rejected entry. Returns the new balance. */
  reverseEntry(entryId: string, note?: string | null): Promise<{ reversal: Entry; balance_paise: number }>;
  /** Correction in ONE transaction: appends the REVERSAL of `origId` and the corrected entry `input` (same
   *  customer), both outboxed, so a crash can never leave the original reversed without its replacement.
   *  Same refusals as reverseEntry + addEntry; nothing is written if either part fails. */
  correctEntry(origId: string, input: NewEntryInput): Promise<{ reversal: Entry; entry: Entry; balance_paise: number }>;
  getEntry(id: string): Promise<Entry | null>;
  /** All counted entries of a customer, oldest first (biz_date, created_at, id), with running balance. */
  listEntries(customerId: string): Promise<EntryView[]>;
  /** True if this device saved the same customer+kind+amount within `seconds`. */
  recentDuplicate(customerId: string, kind: EntryKind, amountPaise: number, seconds?: number): Promise<boolean>;

  // ---- statements & reports
  defaultStatementPeriod(customerId: string): Promise<StatementPeriod>;
  statement(customerId: string, from: string, to: string): Promise<Statement>;
  dayBook(bizDate: string): Promise<DayBook>;
  /** Entries typed on this IST calendar day (by created_at), whatever biz_date they carry. */
  enteredOn(dayIST: string): Promise<DayBookRow[]>;
  /** Sum per month for the given 'YYYY-MM' (same columns as DayBookTotals, biz_date = month). */
  monthTotals(month: string): Promise<DayBookTotals>;

  // ---- sync support (used only by src/sync)
  pendingCount(): Promise<number>;
  outboxBatch(limit: number): Promise<OutboxBatch>;
  /** Every row that exists on no server, for the file kept before a remote wipe: pending/outboxed customers and
   *  entries (including ones the push skips, e.g. under a never-accepted rejected customer) and rejected rows the
   *  user has not dismissed (the refused rows themselves, void reversals of a refused original), plus the
   *  customers those entries belong to. Hidden duplicates (ALREADY_REVERSED) and dismissed rows are left out.
   *  Read-only: does not touch the outbox bookkeeping of outboxBatch(). */
  unsyncedRows(): Promise<OutboxBatch>;
  /** Apply push results in ONE transaction: stored/already -> accepted (+server_seq, received_at), outbox rows
   *  removed; retriable -> attempts++ (CODE_TAKEN reallocates the customer's code); permanent -> rejected;
   *  ALREADY_REVERSED -> rejected + hidden (no DELETE). `serverTime` is the response's server_time. */
  applyPushResults(results: PushResult[], serverTime: string): Promise<{ accepted: number; rejected: number; retry: number }>;
  /** Apply one pull page in ONE transaction and advance meta.cursor to page.next_since. Customers: server row
   *  wins unless the local row has a pending outbox edit (erased_at from server always wins). Entries:
   *  insert unless the id exists (a row the schema refuses fails the page), then mark accepted. Replaces the
   *  devices mirror and shop name/upi/lang. `since` (optional) is the cursor the page was requested with: when
   *  meta.cursor no longer equals it (restore / requeue / epoch change meanwhile) the page is ignored. */
  applyPullPage(page: PullResponse, since?: number): Promise<void>;
  /** Sync epoch changed (server restored): cursor=0, every local row back to pending + outboxed. */
  handleEpochChange(newEpoch: string): Promise<void>;
  /** "Re-upload everything" (same as epoch change without touching the epoch). */
  requeueEverything(): Promise<number>;
  needsAttention(): Promise<NeedsAttentionItem[]>;
  /** Discard a rejected row from view (keeps it, marks note); `resend` re-queues it as pending. */
  resolveRejected(tbl: 'customers' | 'entries', id: string, action: 'discard' | 'resend'): Promise<void>;
  /** After /pair: store identity, rewrite provisional device_id on this phone's rows, store code block. Rows
   *  accepted by a different server (other shop id or sync epoch) are all re-queued for upload. */
  completePairing(p: { server_url: string; device_id: string; device_name: string; role: Role; shop: ShopInfo; sync_epoch: string; code_block: { start: number; end: number } }): Promise<void>;
  /** Highest customer code allocated on this phone (for max_local_code). */
  maxLocalCode(): Promise<number>;
  /** Codes left in current + spare block; the engine requests a new block when this drops below 10. */
  codesRemaining(): Promise<number>;
  addCodeBlock(start: number, end: number): Promise<void>;
  setDevices(devices: DeviceInfo[]): Promise<void>;
  /** Forget pairing (after 401 revoked). If `wipe`, delete all customers/entries/outbox too. */
  unpair(wipe: boolean): Promise<void>;

  // ---- backup
  exportBackup(): Promise<BackupFile>;
  /** Validates the file (BAD_BACKUP), wipes customers/entries/outbox, imports, keeps this phone's identity,
   *  pairing and settings, resets cursor, marks all rows pending (re-upload). Returns counts. */
  importBackup(file: BackupFile): Promise<{ customers: number; entries: number }>;
  /** Keep a rolling local snapshot (last 7) once per day; returns the JSON when one is due, else null.
   *  The platform layer writes it to app storage. */
  snapshotIfDue(): Promise<BackupFile | null>;
}
