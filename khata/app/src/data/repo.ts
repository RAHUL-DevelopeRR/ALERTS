/**
 * SqlRepo: the Repo contract (src/data/types.ts) over a Db (src/db/db.ts). The only module that writes SQL
 * against the ledger tables. All money/date/phone/name rules come from src/core/ledger.ts.
 *
 * Invariants kept here:
 *  - Every multi-row write is ONE db.transaction (row + outbox, reversal + outbox, push/pull application, ...).
 *  - "Counted" entries are those with sync_state <> 'rejected'; only counted entries enter any balance,
 *    statement, day book, home row or total.
 *  - A customer the server never accepted (server_seq IS NULL) and then rejected is hidden from the home list
 *    and totals (it is listed in needsAttention). A previously accepted customer whose later UPDATE was rejected
 *    still exists on the server, so it stays visible with the has_rejected badge.
 *  - Every local write enqueues an outbox row, paired or not (unpaired phones push it all after /pair).
 *  - Rejected rows the user dismissed keep sync_state='rejected' with reject_reason 'DISCARDED:<reason>'.
 *  - A pending REVERSAL whose original is permanently rejected is void: it is marked rejected with reason
 *    'ORIGINAL_REJECTED' (hidden like ALREADY_REVERSED) and comes back if the original is resent or accepted.
 *  - customers.server_row holds the last content the current server accepted; a refused customer UPDATE
 *    restores it so this phone keeps showing what the server and the other phones hold.
 *  - Requeue (epoch change, "Re-upload everything", restore, re-pairing with another server) never puts an
 *    actively rejected row back into the balances.
 */
import {
  RETRIABLE_REASONS,
  type CustomerRow,
  type EntryRow,
  type PushResult,
  type PullResponse,
  type DeviceInfo,
  type RejectReason,
} from '../../../shared/protocol';
import type { Db, DbExec, Row, SqlValue } from '../db/db';
import {
  MAX_AMOUNT_PAISE,
  UUID_RE,
  bizDateIST,
  cleanName,
  daysBetween,
  defaultPeriod,
  formatCode,
  formatDay,
  formatINR,
  hasTamil,
  isValidDate,
  istDayBoundsUTC,
  makeEntry,
  makeReversal,
  normName,
  normalizePhone,
  transliterateTamil,
  uuid,
} from '../core/ledger';
import {
  RepoError,
  type BackupFile,
  type Customer,
  type DayBook,
  type DayBookRow,
  type DayBookTotals,
  type Entry,
  type EntryKind,
  type EntryView,
  type HomeRow,
  type Lang,
  type MetaKey,
  type NeedsAttentionItem,
  type NewCustomerInput,
  type NewEntryInput,
  type OutboxBatch,
  type PayMode,
  type Repo,
  type Role,
  type Settings,
  type Statement,
  type StatementPeriod,
} from './types';

// ------------------------------------------------------------------ constants

export const PROVISIONAL_CODE_END = 1_000_000;
export const DEFAULT_LOCK_TIMEOUT_MIN = 10;
export const DEFAULT_CONFIRM_ABOVE_PAISE = 1_000_000; // ₹10,000
export const PIN_ITERATIONS = 150_000;
export const SNAPSHOT_EVERY_MS = 20 * 3600_000;
export const NOTE_MAX = 200;

const CUST_COLS =
  'id, code, name, search_name, phone, note, archived_at, erased_at, created_at, updated_at, updated_by, received_at, server_seq, sync_state, reject_reason';
const ENTRY_COLS =
  'id, customer_id, kind, amount_paise, delta_paise, biz_date, note, mode, reverses_entry_id, device_id, created_at, received_at, server_seq, sync_state, reject_reason';

/** SQL condition on alias `c`: customer is visible in home/totals (not a never-accepted rejected row). */
const CUST_VISIBLE = `NOT (c.sync_state = 'rejected' AND c.server_seq IS NULL)`;
/** reject_reason of a pending reversal voided because its original was permanently rejected. */
export const ORIGINAL_REJECTED = 'ORIGINAL_REJECTED';
/** SQL condition on alias `x`: a rejected row the user still has to look at (not hidden, not dismissed). */
const activeReject = (x: string): string =>
  `${x}.sync_state = 'rejected' AND COALESCE(${x}.reject_reason, '') NOT IN ('ALREADY_REVERSED', '${ORIGINAL_REJECTED}')
   AND COALESCE(${x}.reject_reason, '') NOT LIKE 'DISCARDED%'`;
/** Customers that requeue puts back to pending: every row except a never-accepted rejected one (it stays under
 *  Needs attention; resend it there). A refused update of an accepted customer already shows server content. */
const REQUEUE_CUST = `NOT (sync_state = 'rejected' AND server_seq IS NULL)`;
/** Entries that requeue puts back to pending: never a rejected one, so a refused amount does not count again. */
const REQUEUE_ENTRY = `sync_state <> 'rejected'`;
/** SQL condition on entries alias `e`: the entry counts in shop-wide figures (home, totals, day book, month).
 *  Per-customer views (balance, statement) use only `sync_state <> 'rejected'`. */
const SHOP_COUNTED = `e.sync_state <> 'rejected'
  AND EXISTS (SELECT 1 FROM customers c WHERE c.id = e.customer_id AND ${CUST_VISIBLE})`;

const CUSTOMER_ROW_KEYS = [
  'id', 'code', 'name', 'search_name', 'phone', 'note', 'archived_at', 'erased_at', 'created_at', 'updated_at',
  'updated_by', 'received_at',
] as const;

/** Parse customers.server_row; null when absent or unusable. */
function parseServerRow(v: unknown, id: string): CustomerRow | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    const o = JSON.parse(v) as Partial<CustomerRow>;
    if (!o || o.id !== id || !Number.isSafeInteger(o.code) || typeof o.name !== 'string' || !o.name) return null;
    return o as CustomerRow;
  } catch {
    return null;
  }
}

function serverRowJson(r: CustomerRow): string {
  const o: Record<string, unknown> = {};
  for (const k of CUSTOMER_ROW_KEYS) o[k] = r[k] ?? null;
  return JSON.stringify(o);
}

const KINDS: readonly EntryKind[] = ['GIVE', 'RECEIVE', 'WRITEOFF', 'REVERSAL'];
const MODES: readonly PayMode[] = ['CASH', 'UPI', 'OTHER'];
const KIND_LABEL: Record<EntryKind, string> = { GIVE: 'Debit', RECEIVE: 'Credit', WRITEOFF: 'Write-off', REVERSAL: 'Correction' };
const LEDGER_CODES = new Set(['BAD_AMOUNT', 'BAD_DATE', 'FUTURE_DATE', 'BAD_NAME', 'BAD_PHONE', 'CANNOT_REVERSE_REVERSAL']);

// ------------------------------------------------------------------ row mapping

const s = (v: unknown): string => (v == null ? '' : String(v));
const sn = (v: unknown): string | null => (v == null ? null : String(v));
const n = (v: unknown): number => (v == null ? 0 : Number(v));
const nn = (v: unknown): number | null => (v == null ? null : Number(v));

function toCustomer(r: Row): Customer {
  return {
    id: s(r.id),
    code: n(r.code),
    name: s(r.name),
    search_name: sn(r.search_name),
    phone: sn(r.phone),
    note: sn(r.note),
    archived_at: sn(r.archived_at),
    erased_at: sn(r.erased_at),
    created_at: s(r.created_at),
    updated_at: s(r.updated_at),
    updated_by: s(r.updated_by),
    received_at: sn(r.received_at),
    server_seq: nn(r.server_seq),
    sync_state: s(r.sync_state) as Customer['sync_state'],
    reject_reason: sn(r.reject_reason),
  };
}

function toEntry(r: Row): Entry {
  return {
    id: s(r.id),
    customer_id: s(r.customer_id),
    kind: s(r.kind) as EntryKind,
    amount_paise: n(r.amount_paise),
    delta_paise: n(r.delta_paise),
    biz_date: s(r.biz_date),
    note: sn(r.note),
    mode: sn(r.mode) as PayMode | null,
    reverses_entry_id: sn(r.reverses_entry_id),
    device_id: s(r.device_id),
    created_at: s(r.created_at),
    received_at: sn(r.received_at),
    server_seq: nn(r.server_seq),
    sync_state: s(r.sync_state) as Entry['sync_state'],
    reject_reason: sn(r.reject_reason),
  };
}

function customerWire(c: Customer): CustomerRow {
  return {
    id: c.id, code: c.code, name: c.name, search_name: c.search_name, phone: c.phone, note: c.note,
    archived_at: c.archived_at, erased_at: c.erased_at, created_at: c.created_at, updated_at: c.updated_at,
    updated_by: c.updated_by, received_at: c.received_at ?? null,
  };
}

function entryWire(e: Entry): EntryRow {
  return {
    id: e.id, customer_id: e.customer_id, kind: e.kind, amount_paise: e.amount_paise, delta_paise: e.delta_paise,
    biz_date: e.biz_date, note: e.note, mode: e.mode, reverses_entry_id: e.reverses_entry_id,
    device_id: e.device_id, created_at: e.created_at, received_at: e.received_at ?? null,
  };
}

/** Run a ledger.ts function, turning its Error('CODE') into RepoError('CODE'). */
function ledger<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Error && LEDGER_CODES.has(e.message)) throw new RepoError(e.message);
    throw e;
  }
}

function cleanNote(note: string | null | undefined): string | null {
  const t = note?.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, NOTE_MAX) : null;
}

function cleanOptional(v: string | null | undefined, max: number): string | null {
  const t = v?.trim();
  return t ? t.slice(0, max) : null;
}

function intOrNull(v: string | null): number | null {
  if (v == null || v === '') return null;
  const x = Number(v);
  return Number.isSafeInteger(x) ? x : null;
}

// ------------------------------------------------------------------ meta helpers (usable with tx or db)

async function metaGet(x: DbExec, key: MetaKey): Promise<string | null> {
  const r = await x.query<{ value: string | null }>('SELECT value FROM meta WHERE key = ?', [key]);
  return r.length ? r[0].value : null;
}

async function metaSet(x: DbExec, key: MetaKey, value: string | null): Promise<void> {
  if (value === null) await x.run('DELETE FROM meta WHERE key = ?', [key]);
  else await x.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}

async function metaAll(x: DbExec): Promise<Map<string, string | null>> {
  const rows = await x.query<{ key: string; value: string | null }>('SELECT key, value FROM meta');
  return new Map(rows.map((r) => [r.key, r.value]));
}

// ------------------------------------------------------------------ PIN hashing

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function fromHex(h: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(h.length >> 1));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

async function pbkdf2Hex(pin: string, salt: Uint8Array<ArrayBuffer>): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto (crypto.subtle) is not available');
  const key = await subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PIN_ITERATIONS }, key, 256);
  return toHex(new Uint8Array(bits));
}

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// ------------------------------------------------------------------ repo

export interface SqlRepoOptions {
  /** Clock for tests. Defaults to the real clock. */
  now?: () => Date;
}

export class SqlRepo implements Repo {
  private readonly now: () => Date;
  /** Highest outbox `n` per row (`tbl:id`) handed out by the last outboxBatch(), so an edit queued while a push
   *  is in flight is not deleted by applyPushResults(). */
  private readonly batchMaxN = new Map<string, number>();
  /** Customer content handed out by the last outboxBatch() (what the server stores if it accepts the row). */
  private readonly batchCust = new Map<string, CustomerRow>();
  /** Bumped whenever the local ledger is rebuilt or re-queued (restore, requeue, epoch change, unpair). A push
   *  batch read before that is stale: its results are ignored and the rows are simply pushed again. */
  private generation = 0;
  private batchGeneration = 0;

  constructor(private readonly db: Db, opts: SqlRepoOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private async today(x: DbExec): Promise<string> {
    const off = Number(await metaGet(x, 'clock_offset_ms')) || 0;
    return bizDateIST(new Date(this.now().getTime() + off));
  }

  private async deviceId(x: DbExec): Promise<string> {
    const id = await metaGet(x, 'device_id');
    if (id) return id;
    const fresh = `local-${uuid()}`;
    await metaSet(x, 'device_id', fresh);
    return fresh;
  }

  private async role(x: DbExec): Promise<Role> {
    const paired = !!(await metaGet(x, 'server_url'));
    if (!paired) return 'owner';
    return (await metaGet(x, 'role')) === 'staff' ? 'staff' : 'owner';
  }

  private async enqueue(x: DbExec, tbl: 'customers' | 'entries', id: string): Promise<void> {
    await x.run('INSERT INTO outbox (tbl, row_id, queued_at) VALUES (?, ?, ?)', [tbl, id, this.nowIso()]);
  }

  private async customerTx(x: DbExec, id: string): Promise<Customer | null> {
    const r = await x.query(`SELECT ${CUST_COLS} FROM customers WHERE id = ?`, [id]);
    return r.length ? toCustomer(r[0]) : null;
  }

  private async entryTx(x: DbExec, id: string): Promise<Entry | null> {
    const r = await x.query(`SELECT ${ENTRY_COLS} FROM entries WHERE id = ?`, [id]);
    return r.length ? toEntry(r[0]) : null;
  }

  private async balanceTx(x: DbExec, customerId: string): Promise<number> {
    const r = await x.query<{ b: number }>(
      `SELECT COALESCE(SUM(delta_paise), 0) AS b FROM entries WHERE customer_id = ? AND sync_state <> 'rejected'`,
      [customerId],
    );
    return n(r[0]?.b);
  }

  private async maxCodeTx(x: DbExec): Promise<number> {
    const r = await x.query<{ m: number | null }>('SELECT MAX(code) AS m FROM customers');
    return n(r[0]?.m);
  }

  // ---------------------------------------------------------------- lifecycle

  async init(): Promise<void> {
    await this.db.transaction(async (tx) => {
      const m = await metaAll(tx);
      const setIfMissing = async (k: MetaKey, v: string): Promise<void> => {
        if (m.get(k) == null) await metaSet(tx, k, v);
      };
      if (!m.get('device_id')) await metaSet(tx, 'device_id', `local-${uuid()}`);
      await setIfMissing('role', 'owner');
      await setIfMissing('lang', 'ta');
      await setIfMissing('lock_timeout_min', String(DEFAULT_LOCK_TIMEOUT_MIN));
      await setIfMissing('confirm_above_paise', String(DEFAULT_CONFIRM_ABOVE_PAISE));
      await setIfMissing('shop_name', '');
      await setIfMissing('cursor', '0');
      if (!m.get('server_url') && (m.get('code_next') == null || m.get('code_end') == null)) {
        await metaSet(tx, 'code_next', String((await this.maxCodeTx(tx)) + 1));
        await metaSet(tx, 'code_end', String(PROVISIONAL_CODE_END));
      }
    });
  }

  // ---------------------------------------------------------------- settings / meta

  async getSettings(): Promise<Settings> {
    const m = await metaAll(this.db);
    const g = (k: MetaKey): string | null => m.get(k) ?? null;
    const lang: Lang = g('lang') === 'en' ? 'en' : 'ta';
    const paired = !!g('server_url');
    return {
      shop_name: g('shop_name') ?? '',
      upi_id: g('upi_id'),
      lang,
      pin_set: !!g('pin_hash'),
      lock_timeout_min: intOrNull(g('lock_timeout_min')) ?? DEFAULT_LOCK_TIMEOUT_MIN,
      confirm_above_paise: intOrNull(g('confirm_above_paise')) ?? DEFAULT_CONFIRM_ABOVE_PAISE,
      paired,
      server_url: g('server_url'),
      device_id: g('device_id') ?? '',
      device_name: g('device_name'),
      role: paired && g('role') === 'staff' ? 'staff' : 'owner',
      last_sync_at: g('last_sync_at'),
      last_sync_error: g('last_sync_error'),
      last_backup_at: g('last_backup_at'),
      clock_offset_ms: Number(g('clock_offset_ms')) || 0,
    };
  }

  async saveSettings(
    patch: Partial<Pick<Settings, 'shop_name' | 'upi_id' | 'lang' | 'lock_timeout_min' | 'confirm_above_paise' | 'device_name'>>,
  ): Promise<Settings> {
    const writes: [MetaKey, string | null][] = [];
    if (patch.shop_name !== undefined) writes.push(['shop_name', (patch.shop_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)]);
    if (patch.upi_id !== undefined) writes.push(['upi_id', cleanOptional(patch.upi_id, 100)]);
    if (patch.device_name !== undefined) writes.push(['device_name', cleanOptional(patch.device_name, 60)]);
    if (patch.lang !== undefined) {
      if (patch.lang !== 'ta' && patch.lang !== 'en') throw new RepoError('BAD_SETTINGS', 'lang');
      writes.push(['lang', patch.lang]);
    }
    if (patch.lock_timeout_min !== undefined) {
      const v = patch.lock_timeout_min;
      if (!Number.isSafeInteger(v) || v <= 0) throw new RepoError('BAD_SETTINGS', 'lock_timeout_min');
      writes.push(['lock_timeout_min', String(v)]);
    }
    if (patch.confirm_above_paise !== undefined) {
      const v = patch.confirm_above_paise;
      if (!Number.isSafeInteger(v) || v <= 0 || v > MAX_AMOUNT_PAISE) throw new RepoError('BAD_SETTINGS', 'confirm_above_paise');
      writes.push(['confirm_above_paise', String(v)]);
    }
    if (writes.length) {
      await this.db.transaction(async (tx) => {
        for (const [k, v] of writes) await metaSet(tx, k, v);
      });
    }
    return this.getSettings();
  }

  getMeta(key: MetaKey): Promise<string | null> {
    return metaGet(this.db, key);
  }

  async setMeta(key: MetaKey, value: string | null): Promise<void> {
    await metaSet(this.db, key, value);
  }

  async setPin(pin: string | null): Promise<void> {
    if (pin == null || pin === '') {
      await this.db.transaction(async (tx) => {
        await metaSet(tx, 'pin_hash', null);
        await metaSet(tx, 'pin_salt', null);
      });
      return;
    }
    const salt = new Uint8Array(new ArrayBuffer(16));
    globalThis.crypto.getRandomValues(salt);
    const hash = await pbkdf2Hex(pin, salt);
    await this.db.transaction(async (tx) => {
      await metaSet(tx, 'pin_salt', toHex(salt));
      await metaSet(tx, 'pin_hash', hash);
    });
  }

  async verifyPin(pin: string): Promise<boolean> {
    const m = await metaAll(this.db);
    const hash = m.get('pin_hash');
    const salt = m.get('pin_salt');
    if (!hash || !salt) return false;
    const got = await pbkdf2Hex(pin, fromHex(salt));
    return constantTimeEqual(got, hash);
  }

  // ---------------------------------------------------------------- customers

  async listHome(): Promise<HomeRow[]> {
    const today = await this.today(this.db);
    const rows = await this.db.query(
      `WITH live AS (SELECT * FROM entries WHERE sync_state <> 'rejected'),
            rev AS (SELECT reverses_entry_id AS id FROM live WHERE reverses_entry_id IS NOT NULL),
            agg AS (
              SELECT e.customer_id AS customer_id,
                     SUM(e.delta_paise) AS balance_paise,
                     MAX(e.biz_date) AS last_activity,
                     MAX(CASE WHEN e.kind = 'RECEIVE' AND e.id NOT IN (SELECT id FROM rev) THEN e.biz_date END) AS last_payment,
                     MIN(CASE WHEN e.kind = 'GIVE' AND e.id NOT IN (SELECT id FROM rev) THEN e.biz_date END) AS first_give,
                     MAX(CASE WHEN e.sync_state = 'pending' THEN 1 ELSE 0 END) AS e_pending
              FROM live e GROUP BY e.customer_id),
            rej AS (SELECT x.customer_id AS customer_id, 1 AS r FROM entries x WHERE ${activeReject('x')} GROUP BY x.customer_id)
       SELECT c.id AS id, c.code AS code, c.name AS name, c.search_name AS search_name, c.phone AS phone,
              c.note AS note, c.archived_at AS archived_at, c.erased_at AS erased_at,
              COALESCE(a.balance_paise, 0) AS balance_paise, a.last_activity AS last_activity,
              a.last_payment AS last_payment, a.first_give AS first_give,
              CASE WHEN c.sync_state = 'pending' OR COALESCE(a.e_pending, 0) = 1 THEN 1 ELSE 0 END AS has_pending,
              CASE WHEN (${activeReject('c')}) OR r.r = 1 THEN 1 ELSE 0 END AS has_rejected
       FROM customers c
       LEFT JOIN agg a ON a.customer_id = c.id
       LEFT JOIN rej r ON r.customer_id = c.id
       WHERE ${CUST_VISIBLE}
         AND ((c.archived_at IS NULL AND c.erased_at IS NULL) OR COALESCE(a.balance_paise, 0) <> 0)
       ORDER BY (a.last_activity IS NULL), a.last_activity DESC, c.name, c.id`,
    );
    return rows.map((r) => {
      const lastPayment = sn(r.last_payment);
      const firstGive = sn(r.first_give);
      const since = lastPayment ?? firstGive;
      return {
        id: s(r.id),
        code: n(r.code),
        name: s(r.name),
        search_name: sn(r.search_name),
        phone: sn(r.phone),
        note: sn(r.note),
        archived_at: sn(r.archived_at),
        erased_at: sn(r.erased_at),
        balance_paise: n(r.balance_paise),
        last_activity: sn(r.last_activity),
        last_payment: lastPayment,
        first_give: firstGive,
        days_since: since ? Math.max(0, daysBetween(since, today)) : null,
        has_pending: n(r.has_pending) === 1,
        has_rejected: n(r.has_rejected) === 1,
      };
    });
  }

  async totals(): Promise<{ receivable_paise: number; advance_paise: number; customers_owing: number }> {
    const [r] = await this.db.query(
      `WITH bal AS (SELECT customer_id, SUM(delta_paise) AS b FROM entries
                    WHERE sync_state <> 'rejected' GROUP BY customer_id)
       SELECT COALESCE(SUM(CASE WHEN bal.b > 0 THEN bal.b ELSE 0 END), 0) AS receivable_paise,
              COALESCE(SUM(CASE WHEN bal.b < 0 THEN -bal.b ELSE 0 END), 0) AS advance_paise,
              COALESCE(SUM(CASE WHEN bal.b > 0 THEN 1 ELSE 0 END), 0) AS customers_owing
       FROM bal JOIN customers c ON c.id = bal.customer_id
       WHERE ${CUST_VISIBLE}`,
    );
    return { receivable_paise: n(r?.receivable_paise), advance_paise: n(r?.advance_paise), customers_owing: n(r?.customers_owing) };
  }

  getCustomer(id: string): Promise<Customer | null> {
    return this.customerTx(this.db, id);
  }

  async findByPhone(phone: string, exceptId?: string): Promise<Customer[]> {
    let p: string | null;
    try {
      p = normalizePhone(phone);
    } catch {
      return [];
    }
    if (!p) return [];
    const rows = await this.db.query(
      `SELECT ${CUST_COLS} FROM customers
       WHERE phone = ? AND archived_at IS NULL AND erased_at IS NULL AND id <> ? ORDER BY code, id`,
      [p, exceptId ?? ''],
    );
    return rows.map(toCustomer);
  }

  async findBySameName(name: string, exceptId?: string): Promise<Customer[]> {
    const key = normName(name);
    if (!key) return [];
    const rows = await this.db.query(
      `SELECT ${CUST_COLS} FROM customers WHERE archived_at IS NULL AND erased_at IS NULL AND id <> ? ORDER BY code, id`,
      [exceptId ?? ''],
    );
    return rows.map(toCustomer).filter((c) => normName(c.name) === key);
  }

  /** Next customer code from the current block, then the spare block; provisional range while unpaired. */
  private async allocCode(tx: DbExec): Promise<number> {
    const m = await metaAll(tx);
    const paired = !!m.get('server_url');
    let next = intOrNull(m.get('code_next') ?? null);
    let end = intOrNull(m.get('code_end') ?? null);
    if (!paired) {
      const floor = (await this.maxCodeTx(tx)) + 1;
      if (next == null || end == null) {
        next = floor;
        end = PROVISIONAL_CODE_END;
      }
      next = Math.max(next, floor);
      if (next > end) end = next + PROVISIONAL_CODE_END; // never exhausts while unpaired
    }
    for (let guard = 0; guard < 10_000; guard++) {
      if (next != null && end != null && next <= end) {
        const used = await tx.query('SELECT 1 AS x FROM customers WHERE code = ? LIMIT 1', [next]);
        if (used.length) {
          next++;
          continue;
        }
        await metaSet(tx, 'code_next', String(next + 1));
        await metaSet(tx, 'code_end', String(end));
        return next;
      }
      const ss = intOrNull(m.get('spare_start') ?? null);
      const se = intOrNull(m.get('spare_end') ?? null);
      if (ss != null && se != null && ss <= se) {
        next = ss;
        end = se;
        m.delete('spare_start');
        m.delete('spare_end');
        await metaSet(tx, 'spare_start', null);
        await metaSet(tx, 'spare_end', null);
        continue;
      }
      break;
    }
    await metaSet(tx, 'code_next', next == null ? null : String(next));
    throw new RepoError('CODES_EXHAUSTED');
  }

  async createCustomer(input: NewCustomerInput): Promise<Customer> {
    const name = ledger(() => cleanName(input.name ?? ''));
    const phone = ledger(() => normalizePhone(input.phone ?? null));
    const note = cleanNote(input.note);
    let search = cleanOptional(input.search_name, 100);
    if (!search && hasTamil(name)) search = transliterateTamil(name) || null;
    return this.db.transaction(async (tx) => {
      const code = await this.allocCode(tx);
      const device = await this.deviceId(tx);
      const now = this.nowIso();
      const c: Customer = {
        id: uuid(), code, name, search_name: search, phone, note, archived_at: null, erased_at: null,
        created_at: now, updated_at: now, updated_by: device, received_at: null,
        server_seq: null, sync_state: 'pending', reject_reason: null,
      };
      await tx.run(
        `INSERT INTO customers (${CUST_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.id, c.code, c.name, c.search_name, c.phone, c.note, c.archived_at, c.erased_at, c.created_at,
          c.updated_at, c.updated_by, c.received_at ?? null, c.server_seq, c.sync_state, c.reject_reason],
      );
      await this.enqueue(tx, 'customers', c.id);
      return c;
    });
  }

  /** Write changed customer fields + outbox; marks the row pending (it has unpushed content). */
  private async writeCustomer(tx: DbExec, c: Customer): Promise<Customer> {
    const device = await this.deviceId(tx);
    const next: Customer = { ...c, updated_at: this.nowIso(), updated_by: device, sync_state: 'pending', reject_reason: null };
    await tx.run(
      `UPDATE customers SET name = ?, search_name = ?, phone = ?, note = ?, archived_at = ?, erased_at = ?,
              updated_at = ?, updated_by = ?, sync_state = 'pending', reject_reason = NULL WHERE id = ?`,
      [next.name, next.search_name, next.phone, next.note, next.archived_at, next.erased_at, next.updated_at, next.updated_by, next.id],
    );
    await this.enqueue(tx, 'customers', next.id);
    return next;
  }

  async updateCustomer(id: string, patch: Partial<NewCustomerInput>): Promise<Customer> {
    const name = patch.name !== undefined ? ledger(() => cleanName(patch.name ?? '')) : undefined;
    const phone = patch.phone !== undefined ? ledger(() => normalizePhone(patch.phone ?? null)) : undefined;
    return this.db.transaction(async (tx) => {
      const c = await this.customerTx(tx, id);
      if (!c) throw new RepoError('NOT_FOUND');
      if (c.erased_at) throw new RepoError('ERASED');
      const updated: Customer = { ...c };
      if (name !== undefined) updated.name = name;
      if (phone !== undefined) updated.phone = phone;
      if (patch.note !== undefined) updated.note = cleanNote(patch.note);
      if (patch.search_name !== undefined) {
        updated.search_name = cleanOptional(patch.search_name, 100);
        if (!updated.search_name && hasTamil(updated.name)) updated.search_name = transliterateTamil(updated.name) || null;
      } else if (name !== undefined && name !== c.name) {
        // Keep an auto-filled transliteration in step with the new name; never touch a hand-typed one.
        const wasAuto = !c.search_name || (hasTamil(c.name) && c.search_name === transliterateTamil(c.name));
        if (wasAuto) updated.search_name = hasTamil(name) ? transliterateTamil(name) || null : null;
      }
      return this.writeCustomer(tx, updated);
    });
  }

  async archiveCustomer(id: string): Promise<Customer> {
    return this.db.transaction(async (tx) => {
      if ((await this.role(tx)) !== 'owner') throw new RepoError('OWNER_ONLY');
      const c = await this.customerTx(tx, id);
      if (!c) throw new RepoError('NOT_FOUND');
      if ((await this.balanceTx(tx, id)) !== 0) throw new RepoError('ARCHIVE_NONZERO');
      if (c.archived_at) return c;
      return this.writeCustomer(tx, { ...c, archived_at: this.nowIso() });
    });
  }

  async unarchiveCustomer(id: string): Promise<Customer> {
    return this.db.transaction(async (tx) => {
      // The server refuses an archive change from staff (FORBIDDEN_ROLE), same as archiveCustomer.
      if ((await this.role(tx)) !== 'owner') throw new RepoError('OWNER_ONLY');
      const c = await this.customerTx(tx, id);
      if (!c) throw new RepoError('NOT_FOUND');
      if (!c.archived_at) return c;
      return this.writeCustomer(tx, { ...c, archived_at: null });
    });
  }

  async applyErasure(id: string, serverRow?: CustomerRow): Promise<Customer> {
    return this.db.transaction(async (tx) => {
      const c = await this.customerTx(tx, id);
      if (!c) throw new RepoError('NOT_FOUND');
      if (serverRow) {
        await tx.run(
          `UPDATE customers SET code = ?, name = ?, search_name = ?, phone = ?, note = ?, archived_at = ?, erased_at = ?,
                  updated_at = ?, updated_by = ?, received_at = ?, sync_state = 'accepted', reject_reason = NULL,
                  server_row = ? WHERE id = ?`,
          [serverRow.code, serverRow.name, serverRow.search_name, serverRow.phone, serverRow.note, serverRow.archived_at,
            serverRow.erased_at ?? this.nowIso(), serverRow.updated_at, serverRow.updated_by, serverRow.received_at ?? null,
            serverRowJson({ ...serverRow, id, erased_at: serverRow.erased_at ?? this.nowIso() }), id],
        );
        await tx.run(`DELETE FROM outbox WHERE tbl = 'customers' AND row_id = ?`, [id]);
      } else {
        const today = await this.today(tx);
        await this.writeCustomer(tx, {
          ...c, name: `Erased ${today}`, search_name: null, phone: null, note: null, erased_at: this.nowIso(),
        });
      }
      // Force a fresh snapshot so the rolling local copies stop carrying the erased details sooner.
      await metaSet(tx, 'last_snapshot_at', null);
      return (await this.customerTx(tx, id))!;
    });
  }

  balance(customerId: string): Promise<number> {
    return this.balanceTx(this.db, customerId);
  }

  // ---------------------------------------------------------------- entries

  private async insertEntry(tx: DbExec, e: Entry): Promise<void> {
    await tx.run(
      `INSERT INTO entries (${ENTRY_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.id, e.customer_id, e.kind, e.amount_paise, e.delta_paise, e.biz_date, e.note, e.mode, e.reverses_entry_id,
        e.device_id, e.created_at, e.received_at ?? null, e.server_seq, e.sync_state, e.reject_reason],
    );
  }

  async addEntry(input: NewEntryInput): Promise<{ entry: Entry; balance_paise: number }> {
    if (!['GIVE', 'RECEIVE', 'WRITEOFF'].includes(input.kind)) throw new RepoError('BAD_ROW', 'kind');
    return this.db.transaction((tx) => this.addEntryTx(tx, input));
  }

  /** Body of addEntry inside the caller's transaction. */
  private async addEntryTx(tx: DbExec, input: NewEntryInput): Promise<{ entry: Entry; balance_paise: number }> {
    const c = await this.customerTx(tx, input.customer_id);
    if (!c) throw new RepoError('NOT_FOUND');
    if (input.kind === 'WRITEOFF' && (await this.role(tx)) !== 'owner') throw new RepoError('OWNER_ONLY');
    const device = await this.deviceId(tx);
    const today = await this.today(tx);
    const mode = input.mode && MODES.includes(input.mode) ? input.mode : null;
    const draft = ledger(() =>
      makeEntry({
        customer_id: c.id, kind: input.kind, amount_paise: input.amount_paise, biz_date: input.biz_date,
        note: input.note, mode, device_id: device, today, now: this.now(),
      }),
    );
    const entry: Entry = { ...draft, received_at: null, server_seq: null, sync_state: 'pending', reject_reason: null };
    await this.insertEntry(tx, entry);
    await this.enqueue(tx, 'entries', entry.id);
    if (c.archived_at) {
      // Money for an archived customer brings them back (the server does the same when it accepts the entry).
      await tx.run('UPDATE customers SET archived_at = NULL WHERE id = ?', [c.id]);
    }
    return { entry, balance_paise: await this.balanceTx(tx, c.id) };
  }

  async reverseEntry(entryId: string, note?: string | null): Promise<{ reversal: Entry; balance_paise: number }> {
    return this.db.transaction((tx) => this.reverseEntryTx(tx, entryId, note));
  }

  /** Body of reverseEntry inside the caller's transaction. */
  private async reverseEntryTx(tx: DbExec, entryId: string, note?: string | null): Promise<{ reversal: Entry; balance_paise: number }> {
    const orig = await this.entryTx(tx, entryId);
    if (!orig) throw new RepoError('NOT_FOUND');
    if (orig.kind === 'REVERSAL') throw new RepoError('CANNOT_REVERSE_REVERSAL');
    if (orig.sync_state === 'rejected') throw new RepoError('REJECTED');
    const existing = await tx.query(
      `SELECT id FROM entries WHERE reverses_entry_id = ? AND sync_state <> 'rejected' LIMIT 1`,
      [entryId],
    );
    if (existing.length) throw new RepoError('ALREADY_REVERSED');
    const device = await this.deviceId(tx);
    const draft = ledger(() => makeReversal(orig, device, note, this.now()));
    const reversal: Entry = { ...draft, received_at: null, server_seq: null, sync_state: 'pending', reject_reason: null };
    await this.insertEntry(tx, reversal);
    await this.enqueue(tx, 'entries', reversal.id);
    return { reversal, balance_paise: await this.balanceTx(tx, orig.customer_id) };
  }

  async correctEntry(
    origId: string,
    input: NewEntryInput,
  ): Promise<{ reversal: Entry; entry: Entry; balance_paise: number }> {
    if (!['GIVE', 'RECEIVE', 'WRITEOFF'].includes(input.kind)) throw new RepoError('BAD_ROW', 'kind');
    return this.db.transaction(async (tx) => {
      const orig = await this.entryTx(tx, origId);
      if (!orig) throw new RepoError('NOT_FOUND');
      if (orig.customer_id !== input.customer_id) throw new RepoError('BAD_ROW', 'customer_id');
      const { reversal } = await this.reverseEntryTx(tx, origId);
      const { entry, balance_paise } = await this.addEntryTx(tx, input);
      return { reversal, entry, balance_paise };
    });
  }

  getEntry(id: string): Promise<Entry | null> {
    return this.entryTx(this.db, id);
  }

  /** Counted entries of a customer with running balance (seeded with `opening`), optionally limited to dates. */
  private async entryViews(x: DbExec, customerId: string, opening: number, from?: string, to?: string): Promise<EntryView[]> {
    const myDevice = await metaGet(x, 'device_id');
    const params: SqlValue[] = [opening, customerId];
    let range = '';
    if (from !== undefined && to !== undefined) {
      range = 'AND e.biz_date BETWEEN ? AND ?';
      params.push(from, to);
    }
    const rows = await x.query(
      `SELECT ${ENTRY_COLS.split(', ').map((c) => `e.${c} AS ${c}`).join(', ')},
              ? + SUM(e.delta_paise) OVER (ORDER BY e.biz_date, e.created_at, e.id ROWS UNBOUNDED PRECEDING) AS running_paise,
              (SELECT r.id FROM entries r WHERE r.reverses_entry_id = e.id AND r.sync_state <> 'rejected'
                ORDER BY r.created_at, r.id LIMIT 1) AS reversed_by,
              d.name AS device_name
       FROM entries e LEFT JOIN devices d ON d.id = e.device_id
       WHERE e.customer_id = ? AND e.sync_state <> 'rejected' ${range}
       ORDER BY e.biz_date, e.created_at, e.id`,
      params,
    );
    return rows.map((r) => {
      const e = toEntry(r);
      const reversedBy = sn(r.reversed_by);
      return {
        ...e,
        running_paise: n(r.running_paise),
        is_reversed: reversedBy !== null,
        reversed_by: reversedBy,
        device_name: e.device_id === myDevice ? null : sn(r.device_name),
      };
    });
  }

  listEntries(customerId: string): Promise<EntryView[]> {
    return this.entryViews(this.db, customerId, 0);
  }

  async recentDuplicate(customerId: string, kind: EntryKind, amountPaise: number, seconds = 60): Promise<boolean> {
    const since = new Date(this.now().getTime() - seconds * 1000).toISOString();
    const device = await metaGet(this.db, 'device_id');
    const r = await this.db.query(
      `SELECT 1 AS x FROM entries WHERE customer_id = ? AND kind = ? AND amount_paise = ? AND device_id = ?
         AND created_at >= ? AND sync_state <> 'rejected' LIMIT 1`,
      [customerId, kind, amountPaise, device ?? '', since],
    );
    return r.length > 0;
  }

  // ---------------------------------------------------------------- statements & reports

  async defaultStatementPeriod(customerId: string): Promise<StatementPeriod> {
    return this.db.transaction(async (tx) => {
      const today = await this.today(tx);
      const rows = await tx.query<{ biz_date: string; delta_paise: number }>(
        `SELECT biz_date, delta_paise FROM entries WHERE customer_id = ? AND sync_state <> 'rejected'
         ORDER BY biz_date, created_at, id`,
        [customerId],
      );
      const p = defaultPeriod(rows.map((r) => ({ biz_date: s(r.biz_date), delta_paise: n(r.delta_paise) })), today);
      // The server accepts biz_date up to IST today + 1 (a phone whose clock runs a little fast just before
      // midnight). An open period must still close at the balance on screen, so it runs to the latest entry.
      const last = rows.length ? s(rows[rows.length - 1].biz_date) : today;
      const to = p.kind === 'since_zero' && last > p.to ? last : p.to;
      return { from: p.from, to, kind: p.kind };
    });
  }

  async statement(customerId: string, from: string, to: string): Promise<Statement> {
    if (!isValidDate(from) || !isValidDate(to) || from > to) throw new RepoError('BAD_DATE');
    return this.db.transaction(async (tx) => {
      const customer = await this.customerTx(tx, customerId);
      if (!customer) throw new RepoError('NOT_FOUND');
      const [o] = await tx.query<{ b: number }>(
        `SELECT COALESCE(SUM(delta_paise), 0) AS b FROM entries
         WHERE customer_id = ? AND biz_date < ? AND sync_state <> 'rejected'`,
        [customerId, from],
      );
      const opening = n(o?.b);
      const rows = await this.entryViews(tx, customerId, opening, from, to);
      let given = 0;
      let received = 0;
      let window = 0;
      for (const r of rows) {
        window += r.delta_paise;
        if (r.is_reversed) continue;
        if (r.kind === 'GIVE') given += r.amount_paise;
        else if (r.kind === 'RECEIVE') received += r.amount_paise;
      }
      return {
        customer, from, to, opening_paise: opening, closing_paise: opening + window, rows,
        given_paise: given, received_paise: received,
      };
    });
  }

  /** Day-book style totals over counted entries matching `cond` (unqualified entries columns). */
  private async totalsWhere(x: DbExec, label: string, cond: string, params: SqlValue[]): Promise<DayBookTotals> {
    const [r] = await x.query(
      `WITH live AS (SELECT e.* FROM entries e WHERE ${cond} AND ${SHOP_COUNTED}),
            rev AS (SELECT reverses_entry_id AS id FROM entries
                    WHERE reverses_entry_id IS NOT NULL AND sync_state <> 'rejected'),
            t AS (SELECT live.*, CASE WHEN live.id IN (SELECT id FROM rev) THEN 1 ELSE 0 END AS reversed FROM live)
       SELECT COALESCE(SUM(CASE WHEN kind = 'GIVE' AND reversed = 0 THEN amount_paise ELSE 0 END), 0) AS given_paise,
              COALESCE(SUM(CASE WHEN kind = 'RECEIVE' AND reversed = 0 THEN amount_paise ELSE 0 END), 0) AS received_paise,
              COALESCE(SUM(CASE WHEN kind = 'RECEIVE' AND reversed = 0 AND mode = 'CASH' THEN amount_paise ELSE 0 END), 0) AS received_cash_paise,
              COALESCE(SUM(CASE WHEN kind = 'RECEIVE' AND reversed = 0 AND mode = 'UPI' THEN amount_paise ELSE 0 END), 0) AS received_upi_paise,
              COALESCE(SUM(CASE WHEN kind = 'RECEIVE' AND reversed = 0 AND (mode IS NULL OR mode = 'OTHER') THEN amount_paise ELSE 0 END), 0) AS received_other_paise,
              COALESCE(SUM(CASE WHEN kind = 'WRITEOFF' AND reversed = 0 THEN amount_paise ELSE 0 END), 0) AS writeoff_paise,
              COALESCE(SUM(delta_paise), 0) AS net_paise,
              COALESCE(SUM(CASE WHEN kind = 'REVERSAL' THEN 1 ELSE 0 END), 0) AS corrections_count,
              COUNT(*) AS entry_count
       FROM t`,
      params,
    );
    return {
      biz_date: label,
      given_paise: n(r?.given_paise),
      received_paise: n(r?.received_paise),
      received_cash_paise: n(r?.received_cash_paise),
      received_upi_paise: n(r?.received_upi_paise),
      received_other_paise: n(r?.received_other_paise),
      writeoff_paise: n(r?.writeoff_paise),
      net_paise: n(r?.net_paise),
      corrections_count: n(r?.corrections_count),
      entry_count: n(r?.entry_count),
    };
  }

  private async dayRows(x: DbExec, cond: string, params: SqlValue[]): Promise<DayBookRow[]> {
    const myDevice = await metaGet(x, 'device_id');
    const rows = await x.query(
      `SELECT ${ENTRY_COLS.split(', ').map((c) => `e.${c} AS ${c}`).join(', ')},
              c.code AS customer_code, c.name AS customer_name, d.name AS device_name,
              CASE WHEN EXISTS (SELECT 1 FROM entries r WHERE r.reverses_entry_id = e.id AND r.sync_state <> 'rejected')
                   THEN 1 ELSE 0 END AS is_reversed
       FROM entries e JOIN customers c ON c.id = e.customer_id LEFT JOIN devices d ON d.id = e.device_id
       WHERE ${cond} AND e.sync_state <> 'rejected' AND ${CUST_VISIBLE}
       ORDER BY e.created_at, e.id`,
      params,
    );
    return rows.map((r) => {
      const e = toEntry(r);
      return {
        ...e,
        customer_code: n(r.customer_code),
        customer_name: s(r.customer_name),
        device_name: e.device_id === myDevice ? null : sn(r.device_name),
        is_reversed: n(r.is_reversed) === 1,
      };
    });
  }

  async dayBook(bizDate: string): Promise<DayBook> {
    if (!isValidDate(bizDate)) throw new RepoError('BAD_DATE');
    return this.db.transaction(async (tx) => ({
      totals: await this.totalsWhere(tx, bizDate, 'biz_date = ?', [bizDate]),
      rows: await this.dayRows(tx, 'e.biz_date = ?', [bizDate]),
    }));
  }

  async enteredOn(dayIST: string): Promise<DayBookRow[]> {
    if (!isValidDate(dayIST)) throw new RepoError('BAD_DATE');
    const { start, end } = istDayBoundsUTC(dayIST);
    return this.dayRows(this.db, 'e.created_at >= ? AND e.created_at < ?', [start, end]);
  }

  async monthTotals(month: string): Promise<DayBookTotals> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new RepoError('BAD_DATE');
    return this.totalsWhere(this.db, month, 'biz_date LIKE ?', [`${month}-%`]);
  }

  // ---------------------------------------------------------------- sync support

  /** Outboxed rows that can be pushed now: entries under a never-accepted rejected customer, and reversals of a
   *  rejected original, are skipped (the server would answer UNKNOWN_* forever) but do not block others. */
  private static readonly PUSHABLE_ENTRY = `
    EXISTS (SELECT 1 FROM customers c WHERE c.id = e.customer_id AND ${CUST_VISIBLE})
    AND (e.reverses_entry_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM entries o WHERE o.id = e.reverses_entry_id AND o.sync_state = 'rejected'))`;

  async pendingCount(): Promise<number> {
    const [r] = await this.db.query<{ k: number }>(
      `SELECT (SELECT COUNT(DISTINCT row_id) FROM outbox WHERE tbl = 'customers')
            + (SELECT COUNT(DISTINCT o.row_id) FROM outbox o JOIN entries e ON e.id = o.row_id
               WHERE o.tbl = 'entries' AND ${SqlRepo.PUSHABLE_ENTRY}) AS k`,
    );
    return n(r?.k);
  }

  async outboxBatch(limit: number): Promise<OutboxBatch> {
    const max = Math.max(0, Math.floor(limit));
    if (max === 0) return { customers: [], entries: [] };
    return this.db.transaction(async (tx) => {
      const cRows = await tx.query(
        `SELECT ${CUST_COLS.split(', ').map((c) => `c.${c} AS ${c}`).join(', ')}, o.first_n AS first_n, o.max_n AS max_n
         FROM (SELECT row_id, MIN(n) AS first_n, MAX(n) AS max_n FROM outbox WHERE tbl = 'customers' GROUP BY row_id) o
         JOIN customers c ON c.id = o.row_id
         ORDER BY o.first_n LIMIT ?`,
        [max],
      );
      const left = max - cRows.length;
      const eRows = left > 0
        ? await tx.query(
          `SELECT ${ENTRY_COLS.split(', ').map((c) => `e.${c} AS ${c}`).join(', ')}, o.first_n AS first_n, o.max_n AS max_n
           FROM (SELECT row_id, MIN(n) AS first_n, MAX(n) AS max_n FROM outbox WHERE tbl = 'entries' GROUP BY row_id) o
           JOIN entries e ON e.id = o.row_id
           WHERE ${SqlRepo.PUSHABLE_ENTRY}
           ORDER BY o.first_n LIMIT ?`,
          [left],
        )
        : [];
      this.batchGeneration = this.generation;
      const customers = cRows.map((r) => customerWire(toCustomer(r)));
      for (const r of cRows) this.batchMaxN.set(`customers:${s(r.id)}`, n(r.max_n));
      for (const r of eRows) this.batchMaxN.set(`entries:${s(r.id)}`, n(r.max_n));
      for (const c of customers) this.batchCust.set(c.id, c);
      return {
        customers,
        entries: eRows.map((r) => entryWire(toEntry(r))),
      };
    });
  }

  async unsyncedRows(): Promise<OutboxBatch> {
    // Pending/outboxed rows, and rejected rows that are neither hidden duplicates nor dismissed by the user.
    const kept = (x: string, tbl: 'customers' | 'entries'): string =>
      `(${x}.sync_state = 'pending'
        OR EXISTS (SELECT 1 FROM outbox ob WHERE ob.tbl = '${tbl}' AND ob.row_id = ${x}.id)
        OR (${x}.sync_state = 'rejected' AND COALESCE(${x}.reject_reason, '') <> 'ALREADY_REVERSED'
            AND COALESCE(${x}.reject_reason, '') NOT LIKE 'DISCARDED%'))`;
    // A never-accepted customer the user dismissed is gone from every list, with its entries (as in exportTx).
    const dismissed = (c: string): string =>
      `(${c}.sync_state = 'rejected' AND ${c}.server_seq IS NULL AND COALESCE(${c}.reject_reason, '') LIKE 'DISCARDED%')`;
    // A voided reversal of a dismissed original stays void.
    const entryWhere = (e: string, c: string): string =>
      `${kept(e, 'entries')} AND NOT ${dismissed(c)}
       AND NOT (COALESCE(${e}.reject_reason, '') = '${ORIGINAL_REJECTED}' AND EXISTS (
         SELECT 1 FROM entries o WHERE o.id = ${e}.reverses_entry_id AND COALESCE(o.reject_reason, '') LIKE 'DISCARDED%'))`;
    return this.db.transaction(async (tx) => {
      const eRows = await tx.query(
        `SELECT ${ENTRY_COLS.split(', ').map((c) => `e.${c} AS ${c}`).join(', ')}
         FROM entries e JOIN customers c ON c.id = e.customer_id
         WHERE ${entryWhere('e', 'c')}
         ORDER BY e.created_at, e.id`,
      );
      const cRows = await tx.query(
        `SELECT ${CUST_COLS.split(', ').map((c) => `c.${c} AS ${c}`).join(', ')} FROM customers c
         WHERE NOT ${dismissed('c')} AND (${kept('c', 'customers')} OR c.id IN (
           SELECT e2.customer_id FROM entries e2 JOIN customers c2 ON c2.id = e2.customer_id WHERE ${entryWhere('e2', 'c2')}))
         ORDER BY c.code, c.created_at, c.id`,
      );
      return { customers: cRows.map((r) => customerWire(toCustomer(r))), entries: eRows.map((r) => entryWire(toEntry(r))) };
    });
  }

  /** A pending reversal of `origId` can never be stored once the original is permanently rejected: void it. */
  private async voidReversalsTx(tx: DbExec, origId: string): Promise<void> {
    const revs = await tx.query<{ id: string }>(
      `SELECT id FROM entries WHERE reverses_entry_id = ? AND kind = 'REVERSAL' AND sync_state = 'pending'`,
      [origId],
    );
    for (const r of revs) {
      await tx.run(`UPDATE entries SET sync_state = 'rejected', reject_reason = ? WHERE id = ?`, [ORIGINAL_REJECTED, r.id]);
      await tx.run(`DELETE FROM outbox WHERE tbl = 'entries' AND row_id = ?`, [r.id]);
      this.batchMaxN.delete(`entries:${r.id}`);
    }
  }

  /** The original is pending or accepted again: its voided reversal counts again and is queued after it
   *  (or is hidden as a duplicate when another reversal of it already counts). */
  private async reviveReversalsTx(tx: DbExec, origId: string): Promise<void> {
    const revs = await tx.query<{ id: string }>(
      `SELECT id FROM entries WHERE reverses_entry_id = ? AND sync_state = 'rejected' AND reject_reason = ?
       ORDER BY created_at, id`,
      [origId, ORIGINAL_REJECTED],
    );
    for (const r of revs) {
      const counted = await tx.query(
        `SELECT 1 AS x FROM entries WHERE reverses_entry_id = ? AND sync_state <> 'rejected' LIMIT 1`,
        [origId],
      );
      if (counted.length) {
        await tx.run(`UPDATE entries SET reject_reason = 'ALREADY_REVERSED' WHERE id = ?`, [r.id]);
        continue;
      }
      await tx.run(`UPDATE entries SET sync_state = 'pending', reject_reason = NULL WHERE id = ?`, [r.id]);
      await this.enqueue(tx, 'entries', r.id);
    }
  }

  /** A permanently refused customer UPDATE: put back the content the server holds (kept in server_row), so this
   *  phone agrees with the server and the other phones. The row stays 'rejected' for Needs attention. */
  private async restoreServerCustomerTx(tx: DbExec, id: string, reason: string): Promise<boolean> {
    const [r] = await tx.query(`SELECT server_seq, server_row FROM customers WHERE id = ?`, [id]);
    if (!r || r.server_seq == null) return false;
    const row = parseServerRow(r.server_row, id);
    if (row) {
      await tx.run(
        `UPDATE customers SET code = ?, name = ?, search_name = ?, phone = ?, note = ?, archived_at = ?, erased_at = ?,
                updated_at = ?, updated_by = ?, received_at = ?, sync_state = 'rejected', reject_reason = ? WHERE id = ?`,
        [row.code, row.name, row.search_name ?? null, row.phone ?? null, row.note ?? null, row.archived_at ?? null,
          row.erased_at ?? null, row.updated_at, row.updated_by, row.received_at ?? null, reason, id],
      );
      return true;
    }
    if (reason === 'ARCHIVE_NONZERO') {
      // No copy of the server content (older data): at least undo the refused archive.
      await tx.run(`UPDATE customers SET archived_at = NULL WHERE id = ?`, [id]);
    }
    return false;
  }

  async applyPushResults(results: PushResult[], serverTime: string): Promise<{ accepted: number; rejected: number; retry: number }> {
    const counts = { accepted: 0, rejected: 0, retry: 0 };
    if (this.batchGeneration !== this.generation) {
      // The ledger was rebuilt or re-queued after this batch was read: the rows are queued again anyway, and
      // results for the old content must not mark the new content accepted or rejected.
      this.batchGeneration = this.generation;
      return counts;
    }
    await this.db.transaction(async (tx) => {
      for (const res of results) {
        const tbl = res.tbl === 'customers' ? 'customers' : res.tbl === 'entries' ? 'entries' : null;
        if (!tbl) continue;
        const exists = await tx.query<{ sync_state: string; reject_reason: string | null }>(
          `SELECT sync_state, reject_reason FROM ${tbl} WHERE id = ?`,
          [res.id],
        );
        if (!exists.length) continue;
        const key = `${tbl}:${res.id}`;
        const maxN = this.batchMaxN.get(key);
        this.batchMaxN.delete(key);
        const pushed = tbl === 'customers' ? this.batchCust.get(res.id) : undefined;
        if (tbl === 'customers') this.batchCust.delete(res.id);
        if (res.status !== 'stored' && res.status !== 'already'
          && exists[0].sync_state === 'rejected' && exists[0].reject_reason === ORIGINAL_REJECTED) {
          continue; // voided earlier in this same result list (its original was refused)
        }
        /** Remove the outbox rows this push covered; returns how many newer rows remain. */
        const dropCovered = async (): Promise<number> => {
          if (maxN === undefined) {
            await tx.run('DELETE FROM outbox WHERE tbl = ? AND row_id = ?', [tbl, res.id]);
            return 0;
          }
          await tx.run('DELETE FROM outbox WHERE tbl = ? AND row_id = ? AND n <= ?', [tbl, res.id, maxN]);
          const [left] = await tx.query<{ k: number }>('SELECT COUNT(*) AS k FROM outbox WHERE tbl = ? AND row_id = ?', [tbl, res.id]);
          return n(left?.k);
        };

        if (res.status === 'stored' || res.status === 'already') {
          const remaining = await dropCovered();
          await tx.run(
            `UPDATE ${tbl} SET sync_state = ?, server_seq = COALESCE(?, server_seq), received_at = ?, reject_reason = NULL WHERE id = ?`,
            [remaining > 0 ? 'pending' : 'accepted', res.seq ?? null, serverTime, res.id],
          );
          if (tbl === 'customers') {
            const stored = pushed ?? customerWire((await this.customerTx(tx, res.id))!);
            await tx.run(`UPDATE customers SET server_row = ? WHERE id = ?`, [
              serverRowJson({ ...stored, received_at: serverTime }), res.id,
            ]);
          }
          counts.accepted++;
          continue;
        }
        if (res.status !== 'rejected') continue;
        const reason: RejectReason = res.reason ?? 'BAD_ROW';
        if (RETRIABLE_REASONS.has(reason)) {
          if (reason === 'CODE_TAKEN' && tbl === 'customers') {
            try {
              const code = await this.allocCode(tx);
              await tx.run('UPDATE customers SET code = ?, updated_at = ? WHERE id = ?', [code, this.nowIso(), res.id]);
            } catch (e) {
              if (!(e instanceof RepoError && e.code === 'CODES_EXHAUSTED')) throw e;
              // No codes left: keep it queued; the engine asks for a new block and the next push retries.
            }
          }
          await tx.run(
            'UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE tbl = ? AND row_id = ?',
            [reason, tbl, res.id],
          );
          counts.retry++;
          continue;
        }
        let remaining = 0;
        if (reason === 'ALREADY_REVERSED') {
          await tx.run('DELETE FROM outbox WHERE tbl = ? AND row_id = ?', [tbl, res.id]);
        } else {
          remaining = await dropCovered();
        }
        await tx.run(`UPDATE ${tbl} SET sync_state = 'rejected', reject_reason = ? WHERE id = ?`, [reason, res.id]);
        if (tbl === 'entries') await this.voidReversalsTx(tx, res.id);
        else if (remaining === 0) await this.restoreServerCustomerTx(tx, res.id, reason); // else a newer edit is pushed next
        counts.rejected++;
      }
    });
    return counts;
  }

  async applyPullPage(page: PullResponse, since?: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (since !== undefined) {
        // The page was requested from `since`. If the cursor moved meanwhile (a restore, "Re-upload everything",
        // an epoch change or unpair reset it to 0), this page is stale: applying it would move the cursor past
        // rows that were just wiped, and they would never be pulled again.
        const cur = Number(await metaGet(tx, 'cursor')) || 0;
        if (cur !== since) return;
      }
      for (const ch of page.changes) {
        if (ch.tbl === 'customers') {
          const row = ch.row;
          const receivedAt = row.received_at ?? page.server_time;
          const shadow = serverRowJson({ ...row, received_at: receivedAt });
          const pending = await tx.query(`SELECT 1 AS x FROM outbox WHERE tbl = 'customers' AND row_id = ? LIMIT 1`, [row.id]);
          if (pending.length && !row.erased_at) {
            // The local edit wins; it is pushed next. Remember the server content in case that push is refused.
            await tx.run(`UPDATE customers SET server_row = ?, server_seq = COALESCE(server_seq, ?) WHERE id = ?`, [shadow, ch.seq, row.id]);
            continue;
          }
          if (row.erased_at) await tx.run(`DELETE FROM outbox WHERE tbl = 'customers' AND row_id = ?`, [row.id]);
          await tx.run(
            `INSERT INTO customers (${CUST_COLS}, server_row) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', NULL, ?)
             ON CONFLICT(id) DO UPDATE SET code = excluded.code, name = excluded.name, search_name = excluded.search_name,
               phone = excluded.phone, note = excluded.note, archived_at = excluded.archived_at,
               erased_at = excluded.erased_at, created_at = excluded.created_at, updated_at = excluded.updated_at,
               updated_by = excluded.updated_by, received_at = excluded.received_at, server_seq = excluded.server_seq,
               sync_state = 'accepted', reject_reason = NULL, server_row = excluded.server_row`,
            [row.id, row.code, row.name, row.search_name, row.phone, row.note, row.archived_at, row.erased_at,
              row.created_at, row.updated_at, row.updated_by, receivedAt, ch.seq, shadow],
          );
        } else if (ch.tbl === 'entries') {
          const e = ch.row;
          const receivedAt = e.received_at ?? page.server_time;
          // ON CONFLICT(id) ignores only the duplicate id: a row the local schema refuses (CHECK, NOT NULL, FK)
          // fails the whole page, so the cursor does not move past an entry this phone never stored.
          await tx.run(
            `INSERT INTO entries (${ENTRY_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', NULL)
             ON CONFLICT(id) DO NOTHING`,
            [e.id, e.customer_id, e.kind, e.amount_paise, e.delta_paise, e.biz_date, e.note, e.mode,
              e.reverses_entry_id, e.device_id, e.created_at, receivedAt, ch.seq],
          );
          await tx.run(
            `UPDATE entries SET sync_state = 'accepted', server_seq = ?, received_at = ?, reject_reason = NULL WHERE id = ?`,
            [ch.seq, receivedAt, e.id],
          );
          await tx.run(`DELETE FROM outbox WHERE tbl = 'entries' AND row_id = ?`, [e.id]);
          if (e.kind === 'REVERSAL' && e.reverses_entry_id) {
            // Another phone reversed the same entry first: our unaccepted duplicate can never be stored
            // (the server answers ALREADY_REVERSED), so hide it now instead of double-counting until the push.
            const dups = await tx.query<{ id: string }>(
              `SELECT id FROM entries WHERE reverses_entry_id = ? AND id <> ?
                 AND (sync_state = 'pending' OR (sync_state = 'rejected' AND reject_reason = ?))`,
              [e.reverses_entry_id, e.id, ORIGINAL_REJECTED],
            );
            for (const d of dups) {
              await tx.run(`UPDATE entries SET sync_state = 'rejected', reject_reason = 'ALREADY_REVERSED' WHERE id = ?`, [d.id]);
              await tx.run(`DELETE FROM outbox WHERE tbl = 'entries' AND row_id = ?`, [d.id]);
            }
          } else {
            // The server holds this entry after all (e.g. our copy was refused as MISMATCH): a reversal of it
            // voided by that refusal counts again and is pushed.
            await this.reviveReversalsTx(tx, e.id);
          }
        }
      }
      await this.setDevicesTx(tx, page.devices);
      if (page.shop) {
        await metaSet(tx, 'shop_id', page.shop.id);
        await metaSet(tx, 'shop_name', page.shop.name);
        await metaSet(tx, 'upi_id', page.shop.upi_id);
        // Not 'lang': the language is each phone's own choice (staff may read Tamil on one phone and English on
        // another), and with a pull every 20 s a shop-wide language would keep switching a phone back.
      }
      await metaSet(tx, 'cursor', String(page.next_since));
    });
  }

  /** Every row back to pending, one outbox row each, in push order: customers by creation, then non-reversal
   *  entries by creation, then reversals by creation. Rejected rows stay rejected (they count nowhere and are
   *  resent one by one from Needs attention), except a customer the server had accepted before, whose content
   *  is the server's own. Invalidates any push batch or pull page in flight. */
  private async requeueTx(tx: DbExec): Promise<number> {
    const now = this.nowIso();
    await tx.run(
      `UPDATE customers SET sync_state = 'pending', server_seq = NULL, server_row = NULL, reject_reason = NULL WHERE ${REQUEUE_CUST}`,
    );
    await tx.run(`UPDATE entries SET sync_state = 'pending', server_seq = NULL, reject_reason = NULL WHERE ${REQUEUE_ENTRY}`);
    await tx.run('DELETE FROM outbox');
    const a = await tx.run(
      `INSERT INTO outbox (tbl, row_id, queued_at)
       SELECT 'customers', id, ? FROM customers WHERE sync_state = 'pending' ORDER BY created_at, id`,
      [now],
    );
    const b = await tx.run(
      `INSERT INTO outbox (tbl, row_id, queued_at)
       SELECT 'entries', id, ? FROM entries WHERE sync_state = 'pending'
       ORDER BY CASE WHEN kind = 'REVERSAL' THEN 1 ELSE 0 END, created_at, id`,
      [now],
    );
    this.invalidateBatches();
    return a.changes + b.changes;
  }

  private invalidateBatches(): void {
    this.batchMaxN.clear();
    this.batchCust.clear();
    this.generation++;
  }

  async handleEpochChange(newEpoch: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.requeueTx(tx);
      await metaSet(tx, 'sync_epoch', newEpoch);
      await metaSet(tx, 'cursor', '0');
    });
  }

  async requeueEverything(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const k = await this.requeueTx(tx);
      await metaSet(tx, 'cursor', '0');
      return k;
    });
  }

  async needsAttention(): Promise<NeedsAttentionItem[]> {
    const custRows = await this.db.query(
      `SELECT ${CUST_COLS} FROM customers c WHERE ${activeReject('c')} ORDER BY updated_at, id`,
    );
    const entRows = await this.db.query(
      `SELECT ${ENTRY_COLS.split(', ').map((c) => `e.${c} AS ${c}`).join(', ')}, c.name AS customer_name, c.code AS customer_code
       FROM entries e JOIN customers c ON c.id = e.customer_id
       WHERE ${activeReject('e')}
       ORDER BY e.created_at, e.id`,
    );
    const items: NeedsAttentionItem[] = custRows.map((r) => {
      const c = toCustomer(r);
      return { tbl: 'customers', id: c.id, reason: c.reject_reason ?? '', summary: `${c.name} (${formatCode(c.code)})`, customer_id: c.id };
    });
    for (const r of entRows) {
      const e = toEntry(r);
      items.push({
        tbl: 'entries',
        id: e.id,
        reason: e.reject_reason ?? '',
        summary: `${formatINR(e.amount_paise)} ${KIND_LABEL[e.kind]} · ${s(r.customer_name)} (${formatCode(n(r.customer_code))}) · ${formatDay(e.biz_date, 'en', true)}`,
        customer_id: e.customer_id,
      });
    }
    return items;
  }

  async resolveRejected(tbl: 'customers' | 'entries', id: string, action: 'discard' | 'resend'): Promise<void> {
    if (tbl !== 'customers' && tbl !== 'entries') throw new RepoError('NOT_FOUND');
    await this.db.transaction(async (tx) => {
      const r = await tx.query<{ sync_state: string; reject_reason: string | null }>(
        `SELECT sync_state, reject_reason FROM ${tbl} WHERE id = ?`,
        [id],
      );
      if (!r.length) throw new RepoError('NOT_FOUND');
      if (r[0].sync_state !== 'rejected') return;
      const reason = r[0].reject_reason ?? '';
      if (action === 'discard') {
        if (!reason.startsWith('DISCARDED')) {
          await tx.run(`UPDATE ${tbl} SET reject_reason = ? WHERE id = ?`, [`DISCARDED:${reason}`, id]);
        }
        // A pending reversal of a discarded entry stays void (it was voided when the entry was refused).
        if (tbl === 'entries') await this.voidReversalsTx(tx, id);
        return;
      }
      await tx.run(`UPDATE ${tbl} SET sync_state = 'pending', reject_reason = NULL WHERE id = ?`, [id]);
      await this.enqueue(tx, tbl, id);
      if (tbl === 'entries') await this.reviveReversalsTx(tx, id); // queued after the original
    });
  }

  async completePairing(p: {
    server_url: string; device_id: string; device_name: string; role: Role; shop: { id: string; name: string; upi_id: string | null; lang: Lang };
    sync_epoch: string; code_block: { start: number; end: number };
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Which server held this phone's accepted rows: the current pairing, else the one before the last unpair.
      const curShop = await metaGet(tx, 'shop_id');
      const curEpoch = await metaGet(tx, 'sync_epoch');
      const before = curShop && curEpoch ? pairingKey(curShop, curEpoch) : await metaGet(tx, 'last_pairing');
      const [acc] = await tx.query<{ k: number }>(
        `SELECT (SELECT COUNT(*) FROM customers WHERE sync_state = 'accepted' OR server_seq IS NOT NULL)
              + (SELECT COUNT(*) FROM entries WHERE sync_state = 'accepted' OR server_seq IS NOT NULL) AS k`,
      );
      const reupload = n(acc?.k) > 0 && before !== pairingKey(p.shop.id, p.sync_epoch);

      const old = await metaGet(tx, 'device_id');
      if (old && old.startsWith('local-') && old !== p.device_id) {
        await tx.run('UPDATE entries SET device_id = ? WHERE device_id = ?', [p.device_id, old]);
        await tx.run('UPDATE customers SET updated_by = ? WHERE updated_by = ?', [p.device_id, old]);
      }
      await metaSet(tx, 'server_url', p.server_url);
      await metaSet(tx, 'device_id', p.device_id);
      await metaSet(tx, 'device_name', p.device_name);
      await metaSet(tx, 'role', p.role === 'staff' ? 'staff' : 'owner');
      await metaSet(tx, 'shop_id', p.shop.id);
      await metaSet(tx, 'shop_name', p.shop.name);
      await metaSet(tx, 'upi_id', p.shop.upi_id);
      // The language chosen on this phone (first run, Settings) stays: it is per phone, not per shop.
      await metaSet(tx, 'sync_epoch', p.sync_epoch);
      await metaSet(tx, 'cursor', '0');
      await metaSet(tx, 'last_pairing', null);
      await metaSet(tx, 'code_next', String(p.code_block.start));
      await metaSet(tx, 'code_end', String(p.code_block.end));
      await metaSet(tx, 'spare_start', null);
      await metaSet(tx, 'spare_end', null);
      await metaSet(tx, 'last_sync_error', null);
      if (reupload) {
        // Rows accepted by ANOTHER server (a redeployed Worker, a test server swapped for production, a restored
        // database with a new epoch): this server may hold none of them. Push everything; rows it already has
        // come back 'already'.
        await this.requeueTx(tx);
        return;
      }
      // Safety net: every pending row must have an outbox row so the first push uploads the offline history.
      const now = this.nowIso();
      await tx.run(
        `INSERT INTO outbox (tbl, row_id, queued_at)
         SELECT 'customers', id, ? FROM customers
         WHERE sync_state = 'pending' AND id NOT IN (SELECT row_id FROM outbox WHERE tbl = 'customers')
         ORDER BY created_at, id`,
        [now],
      );
      await tx.run(
        `INSERT INTO outbox (tbl, row_id, queued_at)
         SELECT 'entries', id, ? FROM entries
         WHERE sync_state = 'pending' AND id NOT IN (SELECT row_id FROM outbox WHERE tbl = 'entries')
         ORDER BY CASE WHEN kind = 'REVERSAL' THEN 1 ELSE 0 END, created_at, id`,
        [now],
      );
    });
  }

  maxLocalCode(): Promise<number> {
    return this.maxCodeTx(this.db);
  }

  async codesRemaining(): Promise<number> {
    const m = await metaAll(this.db);
    const g = (k: MetaKey): number | null => intOrNull(m.get(k) ?? null);
    const next = g('code_next');
    const end = g('code_end');
    const ss = g('spare_start');
    const se = g('spare_end');
    let k = 0;
    if (next != null && end != null && next <= end) k += end - next + 1;
    if (ss != null && se != null && ss <= se) k += se - ss + 1;
    return k;
  }

  async addCodeBlock(start: number, end: number): Promise<void> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start) {
      throw new RepoError('BAD_ROW', 'code block');
    }
    await this.db.transaction(async (tx) => {
      const m = await metaAll(tx);
      const next = intOrNull(m.get('code_next') ?? null);
      const curEnd = intOrNull(m.get('code_end') ?? null);
      const spareS = intOrNull(m.get('spare_start') ?? null);
      const spareE = intOrNull(m.get('spare_end') ?? null);
      const currentLeft = next != null && curEnd != null && next <= curEnd;
      const spareLeft = spareS != null && spareE != null && spareS <= spareE;
      if (!currentLeft) {
        if (spareLeft) {
          // Promote the spare, keep the new block as the spare.
          await metaSet(tx, 'code_next', String(spareS));
          await metaSet(tx, 'code_end', String(spareE));
        } else {
          await metaSet(tx, 'code_next', String(start));
          await metaSet(tx, 'code_end', String(end));
          await metaSet(tx, 'spare_start', null);
          await metaSet(tx, 'spare_end', null);
          return;
        }
      }
      await metaSet(tx, 'spare_start', String(start));
      await metaSet(tx, 'spare_end', String(end));
    });
  }

  private async setDevicesTx(tx: DbExec, devices: DeviceInfo[] | undefined): Promise<void> {
    if (!devices) return;
    await tx.run('DELETE FROM devices');
    for (const d of devices) {
      await tx.run(
        'INSERT OR REPLACE INTO devices (id, name, role, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)',
        [d.id, d.name, d.role, d.created_at ?? null, d.last_seen_at ?? null, d.revoked_at ?? null],
      );
    }
  }

  async setDevices(devices: DeviceInfo[]): Promise<void> {
    await this.db.transaction((tx) => this.setDevicesTx(tx, devices));
  }

  async unpair(wipe: boolean): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Remember which server holds the accepted rows, so re-pairing elsewhere re-uploads them (completePairing).
      const shopId = await metaGet(tx, 'shop_id');
      const epoch = await metaGet(tx, 'sync_epoch');
      if (shopId && epoch) await metaSet(tx, 'last_pairing', pairingKey(shopId, epoch));
      if (wipe) {
        await metaSet(tx, 'last_pairing', null);
        await tx.run('DELETE FROM outbox');
        await tx.run('DELETE FROM entries');
        await tx.run('DELETE FROM customers');
        await tx.run('DELETE FROM devices');
      }
      for (const k of ['server_url', 'sync_epoch', 'shop_id', 'last_sync_at', 'last_sync_error', 'spare_start', 'spare_end'] as MetaKey[]) {
        await metaSet(tx, k, null);
      }
      await metaSet(tx, 'cursor', '0');
      await metaSet(tx, 'role', 'owner');
      await metaSet(tx, 'device_id', `local-${uuid()}`);
      await metaSet(tx, 'clock_offset_ms', '0');
      await metaSet(tx, 'code_next', String((await this.maxCodeTx(tx)) + 1));
      await metaSet(tx, 'code_end', String(PROVISIONAL_CODE_END));
    });
    this.invalidateBatches();
  }

  async eraseLedger(): Promise<{ customers: number; entries: number }> {
    const r = await this.db.transaction(async (tx) => {
      if (await metaGet(tx, 'server_url')) throw new RepoError('ERASE_CONNECTED');
      const [c] = await tx.query<{ n: number }>('SELECT COUNT(*) AS n FROM customers');
      const [e] = await tx.query<{ n: number }>('SELECT COUNT(*) AS n FROM entries');
      await tx.run('DELETE FROM outbox');
      await tx.run('DELETE FROM entries');
      await tx.run('DELETE FROM customers');
      await tx.run('DELETE FROM devices');
      for (const k of ['voice_aliases', 'voice_stats', 'last_pairing', 'spare_start', 'spare_end'] as MetaKey[]) {
        await metaSet(tx, k, null);
      }
      await metaSet(tx, 'code_next', '1');
      await metaSet(tx, 'code_end', String(PROVISIONAL_CODE_END));
      return { customers: Number(c?.n ?? 0), entries: Number(e?.n ?? 0) };
    });
    this.invalidateBatches();
    return r;
  }

  // ---------------------------------------------------------------- backup

  private async exportTx(tx: DbExec): Promise<BackupFile> {
    const shop = (await metaGet(tx, 'shop_name')) ?? '';
    // A customer the server never accepted and the user dismissed is gone from every list; an import (which
    // marks everything pending) would bring it back with its entries, so it is left out.
    const custs = await tx.query(
      `SELECT ${CUST_COLS} FROM customers
       WHERE NOT (sync_state = 'rejected' AND server_seq IS NULL AND COALESCE(reject_reason, '') LIKE 'DISCARDED%')
       ORDER BY code, created_at, id`,
    );
    // Rejected entries (refused by the server, hidden duplicates, void reversals, dismissed rows) never count,
    // so they are not carried into a backup where an import would make them count again.
    const ents = await tx.query(`SELECT ${ENTRY_COLS} FROM entries WHERE sync_state <> 'rejected' ORDER BY created_at, id`);
    const customers = custs.map((r) => customerWire(toCustomer(r)));
    const custIds = new Set(customers.map((c) => c.id));
    let entries = ents.map((r) => entryWire(toEntry(r))).filter((e) => custIds.has(e.customer_id));
    // Every exported reversal must find its target in the file, or validateBackup() refuses the whole file.
    const ids = new Set(entries.map((e) => e.id));
    entries = entries.filter((e) => e.kind !== 'REVERSAL' || (e.reverses_entry_id != null && ids.has(e.reverses_entry_id)));
    return {
      format: 'kadan-kanakku-backup',
      version: 1,
      exported_at: this.nowIso(),
      shop_name: shop,
      customers,
      entries,
    };
  }

  exportBackup(): Promise<BackupFile> {
    return this.db.transaction((tx) => this.exportTx(tx));
  }

  async importBackup(file: BackupFile): Promise<{ customers: number; entries: number }> {
    const { customers, entries } = validateBackup(file);
    await this.db.transaction(async (tx) => {
      await tx.run('DELETE FROM outbox');
      await tx.run('DELETE FROM entries');
      await tx.run('DELETE FROM customers');
      for (const c of customers) {
        await tx.run(
          `INSERT INTO customers (${CUST_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', NULL)`,
          [c.id, c.code, c.name, c.search_name, c.phone, c.note, c.archived_at, c.erased_at, c.created_at, c.updated_at, c.updated_by],
        );
      }
      for (const e of entries) {
        await tx.run(
          `INSERT INTO entries (${ENTRY_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', NULL)`,
          [e.id, e.customer_id, e.kind, e.amount_paise, e.delta_paise, e.biz_date, e.note, e.mode,
            e.reverses_entry_id, e.device_id, e.created_at],
        );
      }
      await this.requeueTx(tx);
      await metaSet(tx, 'cursor', '0');
      if (!(await metaGet(tx, 'server_url'))) {
        const next = intOrNull(await metaGet(tx, 'code_next')) ?? 1;
        const floor = (await this.maxCodeTx(tx)) + 1;
        await metaSet(tx, 'code_next', String(Math.max(next, floor)));
        await metaSet(tx, 'code_end', String(PROVISIONAL_CODE_END));
      }
    });
    return { customers: customers.length, entries: entries.length };
  }

  async snapshotIfDue(): Promise<BackupFile | null> {
    return this.db.transaction(async (tx) => {
      const last = await metaGet(tx, 'last_snapshot_at');
      const nowMs = this.now().getTime();
      const lastMs = last ? Date.parse(last) : NaN;
      if (!Number.isNaN(lastMs) && nowMs - lastMs < SNAPSHOT_EVERY_MS && lastMs <= nowMs) return null;
      await metaSet(tx, 'last_snapshot_at', this.nowIso());
      return this.exportTx(tx);
    });
  }
}

/** Identity of the server a phone's accepted rows live on (meta last_pairing). */
function pairingKey(shopId: string, epoch: string): string {
  return `${shopId} ${epoch}`;
}

// ------------------------------------------------------------------ backup validation

function bad(detail: string): never {
  throw new RepoError('BAD_BACKUP', detail);
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isOptStr = (v: unknown): v is string | null | undefined => v == null || typeof v === 'string';
const isIso = (v: unknown): v is string => isStr(v) && v.length >= 10 && !Number.isNaN(Date.parse(v));
const isOptIso = (v: unknown): boolean => v == null || isIso(v);

/** Validate a BackupFile completely before anything is written. Throws RepoError('BAD_BACKUP', detail). */
export function validateBackup(file: unknown): { customers: CustomerRow[]; entries: EntryRow[] } {
  if (!file || typeof file !== 'object') bad('not an object');
  const f = file as Partial<BackupFile>;
  if (f.format !== 'kadan-kanakku-backup') bad('format');
  if (f.version !== 1) bad('version');
  if (!Array.isArray(f.customers) || !Array.isArray(f.entries)) bad('arrays');
  const customers: CustomerRow[] = [];
  const custIds = new Set<string>();
  for (const [i, raw] of f.customers.entries()) {
    const c = raw as Partial<CustomerRow> | null;
    const at = `customers[${i}]`;
    if (!c || typeof c !== 'object') bad(at);
    if (!isStr(c.id) || !UUID_RE.test(c.id)) bad(`${at}.id`);
    if (custIds.has(c.id)) bad(`${at}.id duplicate`);
    if (!Number.isSafeInteger(c.code) || (c.code as number) <= 0) bad(`${at}.code`);
    if (!isStr(c.name) || !c.name.trim()) bad(`${at}.name`);
    if (!isOptStr(c.search_name) || !isOptStr(c.phone) || !isOptStr(c.note)) bad(`${at} text fields`);
    if (!isOptIso(c.archived_at) || !isOptIso(c.erased_at)) bad(`${at} archived/erased`);
    if (!isIso(c.created_at) || !isIso(c.updated_at)) bad(`${at} timestamps`);
    if (!isStr(c.updated_by) || !c.updated_by) bad(`${at}.updated_by`);
    custIds.add(c.id);
    customers.push({
      id: c.id, code: c.code as number, name: c.name,
      search_name: c.search_name ?? null, phone: c.phone ?? null, note: c.note ?? null,
      archived_at: c.archived_at ?? null, erased_at: c.erased_at ?? null, created_at: c.created_at,
      updated_at: c.updated_at, updated_by: c.updated_by, received_at: null,
    });
  }
  const entries: EntryRow[] = [];
  const byId = new Map<string, EntryRow>();
  for (const [i, raw] of f.entries.entries()) {
    const e = raw as Partial<EntryRow> | null;
    const at = `entries[${i}]`;
    if (!e || typeof e !== 'object') bad(at);
    if (!isStr(e.id) || !UUID_RE.test(e.id)) bad(`${at}.id`);
    if (byId.has(e.id)) bad(`${at}.id duplicate`);
    if (!isStr(e.customer_id) || !custIds.has(e.customer_id)) bad(`${at}.customer_id`);
    if (!isStr(e.kind) || !KINDS.includes(e.kind as EntryKind)) bad(`${at}.kind`);
    const amt = e.amount_paise;
    if (!Number.isSafeInteger(amt) || (amt as number) <= 0 || (amt as number) > MAX_AMOUNT_PAISE) bad(`${at}.amount_paise`);
    if (!Number.isSafeInteger(e.delta_paise)) bad(`${at}.delta_paise`);
    if (e.kind === 'GIVE' && e.delta_paise !== amt) bad(`${at}.delta_paise`);
    if ((e.kind === 'RECEIVE' || e.kind === 'WRITEOFF') && e.delta_paise !== -(amt as number)) bad(`${at}.delta_paise`);
    if (e.kind !== 'REVERSAL' && e.reverses_entry_id != null) bad(`${at}.reverses_entry_id`);
    if (e.kind === 'REVERSAL' && (!isStr(e.reverses_entry_id) || !UUID_RE.test(e.reverses_entry_id))) bad(`${at}.reverses_entry_id`);
    if (!isStr(e.biz_date) || !isValidDate(e.biz_date)) bad(`${at}.biz_date`);
    if (!isOptStr(e.note)) bad(`${at}.note`);
    if (e.mode != null && !MODES.includes(e.mode)) bad(`${at}.mode`);
    if (!isStr(e.device_id) || !e.device_id) bad(`${at}.device_id`);
    if (!isIso(e.created_at)) bad(`${at}.created_at`);
    const row: EntryRow = {
      id: e.id, customer_id: e.customer_id, kind: e.kind as EntryKind, amount_paise: amt as number,
      delta_paise: e.delta_paise as number, biz_date: e.biz_date, note: e.note ?? null, mode: e.mode ?? null,
      reverses_entry_id: e.reverses_entry_id ?? null, device_id: e.device_id, created_at: e.created_at, received_at: null,
    };
    byId.set(row.id, row);
    entries.push(row);
  }
  const reversed = new Set<string>();
  for (const e of entries) {
    if (e.kind !== 'REVERSAL') continue;
    const t = byId.get(e.reverses_entry_id!);
    if (!t) bad(`reversal ${e.id}: target missing`);
    if (t.kind === 'REVERSAL') bad(`reversal ${e.id}: target is a reversal`);
    if (t.customer_id !== e.customer_id || t.amount_paise !== e.amount_paise || e.delta_paise !== -t.delta_paise) {
      bad(`reversal ${e.id}: mismatch`);
    }
    if (reversed.has(t.id)) bad(`reversal ${e.id}: target reversed twice`);
    reversed.add(t.id);
  }
  return { customers, entries };
}
