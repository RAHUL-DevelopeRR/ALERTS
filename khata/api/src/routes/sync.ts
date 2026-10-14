import { Hono } from 'hono';
import {
  MAX_PUSH_ROWS,
  PULL_PAGE_SIZE,
  type Change,
  type DeviceInfo,
  type PullResponse,
  type PushResponse,
  type PushResult,
  type RejectReason,
  type Tbl,
} from '../../../shared/protocol';
import type { AppEnv, DeviceRecord } from '../env';
import { auth } from '../lib/auth';
import { badRequest, envelope, fail, isObj, readJson, type Json } from '../lib/http';
import {
  DEVICE_COLUMNS,
  sameCustomer,
  sameEntry,
  toCustomerRow,
  toDeviceInfo,
  toEntryRow,
  toShopInfo,
  type CustomerDb,
  type EntryDb,
} from '../lib/rows';
import { iso, istDate } from '../lib/time';
import { placeholders, uniq } from '../lib/util';
import { customerShape, entryShape } from '../lib/validate';

export const syncRoutes = new Hono<AppEnv>();

/**
 * Author of change-log rows the server makes on its own (un-archiving a customer that received money). No device id
 * ever equals it, so the pull's own-row filter never hides these rows, not even from the device whose push caused them.
 */
export const SERVER_AUTHOR = 'server';

const str = (v: unknown): v is string => typeof v === 'string';
const nn = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
/** `?from,?from+1,...` (numbered placeholders, so they can be mixed with other numbered ones). */
const nums = (from: number, n: number): string => Array.from({ length: n }, (_, i) => `?${from + i}`).join(',');

type Raw = Json & { id: string };

/** Server state read by the pre-check batch. Rows of another shop are only remembered as foreign ids. */
interface PreState {
  entries: Map<string, EntryDb>;
  foreignEntries: Set<string>;
  reversed: Set<string>;
  customers: Map<string, CustomerDb>;
  foreignCustomers: Set<string>;
  codes: Map<number, string>;
  balances: Map<string, number>;
}

/** In-memory classification of one chunk: the results (in request order) and the rows to write. */
interface Plan {
  results: PushResult[];
  custWrites: { i: number; row: CustomerDb }[];
  entWrites: { i: number; row: EntryDb }[];
  /** Customers this chunk archives (final chunk state archived, server state not archived). */
  archives: Set<string>;
}

/**
 * Classifies a chunk against the pre-check snapshot. `noArchive` lists customers whose archive must be refused
 * ARCHIVE_NONZERO: the caller finds them by re-running this until the accepted entries leave every archived
 * customer at zero (so a rejected or duplicate entry can never make a debtor look settled).
 */
function classify(
  custIn: Raw[],
  entIn: Raw[],
  pre: PreState,
  dev: DeviceRecord,
  todayIST: string,
  nowIso: string,
  noArchive: ReadonlySet<string>,
): Plan {
  const results: PushResult[] = [];
  const reject = (tbl: Tbl, id: string, reason: RejectReason) => results.push({ tbl, id, status: 'rejected', reason });
  const custState = new Map(pre.customers);
  const codes = new Map(pre.codes);
  const entState = new Map(pre.entries);
  const reversed = new Set(pre.reversed);
  const custWrites: Plan['custWrites'] = [];
  const entWrites: Plan['entWrites'] = [];

  // ---- customers (their statements precede the entries')
  for (const x of custIn) {
    if (pre.foreignCustomers.has(x.id)) {
      reject('customers', x.id, 'MISMATCH');
      continue;
    }
    const prev = custState.get(x.id);
    if (prev && sameCustomer(prev, x)) {
      results.push({ tbl: 'customers', id: x.id, status: 'already' });
      continue;
    }
    const reason = validateCustomer(x, prev);
    if (reason) {
      // Its entries in this chunk stay acceptable when the customer is on the server (no FK risk); for a new
      // customer they answer UNKNOWN_CUSTOMER (retriable), because it is not in custState.
      reject('customers', x.id, reason);
      continue;
    }
    const row: CustomerDb = {
      id: x.id,
      shop_id: dev.shop_id,
      code: x.code as number,
      name: x.name as string,
      search_name: nn(x.search_name as string | null | undefined),
      phone: nn(x.phone as string | null | undefined),
      note: nn(x.note as string | null | undefined),
      archived_at: nn(x.archived_at as string | null | undefined),
      erased_at: null,
      created_at: prev?.created_at ?? (x.created_at as string),
      updated_at: x.updated_at as string,
      updated_by: dev.id,
      received_at: nowIso,
    };
    custWrites.push({ i: results.length, row });
    results.push({ tbl: 'customers', id: x.id, status: 'stored' });
    custState.set(x.id, row);
    if (prev && prev.code !== row.code && codes.get(prev.code) === x.id) codes.delete(prev.code);
    codes.set(row.code, x.id);
  }

  function validateCustomer(x: Raw, prev: CustomerDb | undefined): RejectReason | null {
    const shape = customerShape(x);
    if (shape) return shape;
    if (prev?.erased_at) return 'ERASED';
    const wasArchived = !!prev?.archived_at;
    const isArchived = x.archived_at !== undefined && x.archived_at !== null;
    if (dev.role !== 'owner' && wasArchived !== isArchived) return 'FORBIDDEN_ROLE';
    const holder = codes.get(x.code as number);
    if (holder !== undefined && holder !== x.id) return 'CODE_TAKEN';
    if (isArchived && !wasArchived && noArchive.has(x.id)) return 'ARCHIVE_NONZERO';
    return null;
  }

  // ---- entries
  for (const e of entIn) {
    if (pre.foreignEntries.has(e.id)) {
      reject('entries', e.id, 'MISMATCH');
      continue;
    }
    const prev = entState.get(e.id);
    if (prev) {
      if (sameEntry(prev, e)) results.push({ tbl: 'entries', id: e.id, status: 'already' });
      else reject('entries', e.id, 'MISMATCH');
      continue;
    }
    const reason = validateEntry(e);
    if (reason) {
      reject('entries', e.id, reason);
      continue;
    }
    const row: EntryDb = {
      id: e.id,
      shop_id: dev.shop_id,
      customer_id: e.customer_id as string,
      kind: e.kind as EntryDb['kind'],
      amount_paise: e.amount_paise as number,
      delta_paise: e.delta_paise as number,
      biz_date: e.biz_date as string,
      note: nn(e.note as string | null | undefined),
      mode: nn(e.mode as EntryDb['mode'] | undefined),
      reverses_entry_id: nn(e.reverses_entry_id as string | null | undefined),
      device_id: dev.id,
      created_at: e.created_at as string,
      received_at: nowIso,
    };
    entWrites.push({ i: results.length, row });
    results.push({ tbl: 'entries', id: e.id, status: 'stored' });
    entState.set(e.id, row);
    if (row.reverses_entry_id) reversed.add(row.reverses_entry_id);
  }

  function validateEntry(e: Raw): RejectReason | null {
    const shape = entryShape(e, todayIST);
    if (shape) return shape;
    if (e.kind === 'WRITEOFF' && dev.role !== 'owner') return 'FORBIDDEN_ROLE';
    if (pre.foreignCustomers.has(e.customer_id as string)) return 'BAD_ROW';
    if (!custState.has(e.customer_id as string)) return 'UNKNOWN_CUSTOMER';
    if (e.kind === 'REVERSAL') {
      const target = e.reverses_entry_id as string;
      const orig = entState.get(target);
      if (!orig) return 'UNKNOWN_ORIGINAL';
      if (orig.kind === 'REVERSAL') return 'REVERSAL_OF_REVERSAL';
      if (reversed.has(target)) return 'ALREADY_REVERSED';
      if (
        orig.customer_id !== e.customer_id ||
        orig.amount_paise !== e.amount_paise ||
        orig.biz_date !== e.biz_date ||
        (orig.mode ?? null) !== (e.mode ?? null) ||
        e.delta_paise !== -orig.delta_paise
      )
        return 'REVERSAL_MISMATCH';
    }
    return null;
  }

  const archives = new Set<string>();
  for (const { row } of custWrites) {
    if (custState.get(row.id)?.archived_at && !pre.customers.get(row.id)?.archived_at) archives.add(row.id);
  }
  return { results, custWrites, entWrites, archives };
}

const isConstraintError = (msg: string) => /constraint|SQLITE_CONSTRAINT/i.test(msg);

/**
 * POST /v1/sync/push. Pre-checks in one batch of SELECTs, classification in memory (customers first), then one
 * write batch (one transaction). Every write in that batch re-checks, in SQL, what the pre-check decided (code still
 * free, customer not erased, reversal target not reversed, id not stored, archived customers with money), so a push
 * racing another phone's push is classified instead of failing; the change log is appended only for rows actually
 * written, and the seqs come back through RETURNING.
 */
syncRoutes.post('/sync/push', auth, async (c) => {
  const body = await readJson(c);
  if (!isObj(body)) return badRequest(c);
  const customers = body.customers ?? [];
  const entries = body.entries ?? [];
  if (!Array.isArray(customers) || !Array.isArray(entries)) return badRequest(c);
  if (customers.length + entries.length > MAX_PUSH_ROWS) return fail(c, 413, 'too_many_rows');
  for (const r of [...customers, ...entries] as unknown[]) {
    if (!isObj(r) || !str(r.id) || r.id.length < 1 || r.id.length > 64) return badRequest(c, 'row id');
  }
  const custIn = customers as Raw[];
  const entIn = entries as Raw[];

  const db = c.env.DB;
  const dev = c.get('device');
  const shopId = dev.shop_id;
  const now = new Date();
  const nowIso = iso(now);
  const todayIST = istDate(now);
  if (custIn.length + entIn.length === 0) return c.json<PushResponse>({ results: [], ...envelope(c, now) });

  // ---- 1. Pre-checks: one batch of indexed SELECTs (every IN-list stays far below 100 parameters). Rows are looked
  // up by primary key in every shop, so an id that belongs to another shop is refused instead of "stored".
  const targets = uniq(entIn.map((e) => e.reverses_entry_id).filter(str));
  const entryIds = uniq([...entIn.map((e) => e.id), ...targets]);
  const custIds = uniq([...custIn.map((x) => x.id), ...entIn.map((e) => e.customer_id).filter(str)]);
  const codeList = uniq(custIn.map((x) => x.code).filter((v): v is number => typeof v === 'number' && Number.isSafeInteger(v)));
  const archiving = uniq(custIn.filter((x) => x.archived_at !== undefined && x.archived_at !== null).map((x) => x.id));

  const pre: { key: 'entries' | 'reversals' | 'customers' | 'codes' | 'balances'; stmt: D1PreparedStatement }[] = [];
  if (entryIds.length)
    pre.push({ key: 'entries', stmt: db.prepare(`SELECT * FROM entries WHERE id IN (${placeholders(entryIds.length)})`).bind(...entryIds) });
  if (targets.length)
    pre.push({
      key: 'reversals',
      stmt: db
        .prepare(`SELECT id, reverses_entry_id FROM entries WHERE shop_id = ? AND reverses_entry_id IN (${placeholders(targets.length)})`)
        .bind(shopId, ...targets),
    });
  if (custIds.length)
    pre.push({ key: 'customers', stmt: db.prepare(`SELECT * FROM customers WHERE id IN (${placeholders(custIds.length)})`).bind(...custIds) });
  if (codeList.length)
    pre.push({
      key: 'codes',
      stmt: db.prepare(`SELECT id, code FROM customers WHERE shop_id = ? AND code IN (${placeholders(codeList.length)})`).bind(shopId, ...codeList),
    });
  if (archiving.length)
    pre.push({
      key: 'balances',
      stmt: db
        .prepare(
          `SELECT customer_id, SUM(delta_paise) AS bal FROM entries
           WHERE shop_id = ? AND customer_id IN (${placeholders(archiving.length)}) GROUP BY customer_id`,
        )
        .bind(shopId, ...archiving),
    });
  const preOut = pre.length ? await db.batch(pre.map((p) => p.stmt)) : [];
  const rowsOf = <T>(key: (typeof pre)[number]['key']): T[] => {
    const i = pre.findIndex((p) => p.key === key);
    return i < 0 ? [] : ((preOut[i]?.results ?? []) as T[]);
  };
  const allEntries = rowsOf<EntryDb>('entries');
  const allCustomers = rowsOf<CustomerDb>('customers');
  const state: PreState = {
    entries: new Map(allEntries.filter((e) => e.shop_id === shopId).map((e) => [e.id, e])),
    foreignEntries: new Set(allEntries.filter((e) => e.shop_id !== shopId).map((e) => e.id)),
    reversed: new Set(rowsOf<{ reverses_entry_id: string }>('reversals').map((r) => r.reverses_entry_id)),
    customers: new Map(allCustomers.filter((x) => x.shop_id === shopId).map((x) => [x.id, x])),
    foreignCustomers: new Set(allCustomers.filter((x) => x.shop_id !== shopId).map((x) => x.id)),
    codes: new Map(rowsOf<{ id: string; code: number }>('codes').map((x) => [x.code, x.id])),
    balances: new Map(rowsOf<{ customer_id: string; bal: number }>('balances').map((b) => [b.customer_id, b.bal])),
  };

  // ---- 2. Classify. ARCHIVE_NONZERO counts only the entries this chunk actually accepts (each id once): re-run
  // with the offending archives refused until stable (at most one extra pass per pushed customer; in-memory only).
  const noArchive = new Set<string>();
  let plan: Plan;
  for (;;) {
    plan = classify(custIn, entIn, state, dev, todayIST, nowIso, noArchive);
    const delta = new Map<string, number>();
    for (const { row } of plan.entWrites) delta.set(row.customer_id, (delta.get(row.customer_id) ?? 0) + row.delta_paise);
    const nonzero = [...plan.archives].filter((id) => (state.balances.get(id) ?? 0) + (delta.get(id) ?? 0) !== 0);
    if (!nonzero.length) break;
    for (const id of nonzero) noArchive.add(id);
  }
  const { results, custWrites, entWrites, archives } = plan;

  // ---- 3. One write batch (one transaction).
  const stmts: D1PreparedStatement[] = [db.prepare('PRAGMA defer_foreign_keys = on')];
  const custStmt: number[] = [];
  const entStmt: number[] = [];
  let custLog = -1;
  let entLog = -1;

  for (const { row } of custWrites) {
    // Server-order last-write-wins. The SELECT ... WHERE NOT EXISTS skips the write when another customer took the
    // code since the pre-check; the DO UPDATE ... WHERE skips it when the row was erased meanwhile. erased_at and
    // created_at are never written on update. A staff push never changes archived_at, even if the owner just did.
    custStmt.push(stmts.length);
    stmts.push(
      db
        .prepare(
          `INSERT INTO customers (id, shop_id, code, name, search_name, phone, note, archived_at, erased_at,
             created_at, updated_at, updated_by, received_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, ?11, ?12
           WHERE NOT EXISTS (SELECT 1 FROM customers WHERE shop_id = ?2 AND code = ?3 AND id <> ?1)
           ON CONFLICT(id) DO UPDATE SET code = excluded.code, name = excluded.name, search_name = excluded.search_name,
             phone = excluded.phone, note = excluded.note,
             archived_at = CASE WHEN ?13 = 1 THEN customers.archived_at ELSE excluded.archived_at END,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by, received_at = excluded.received_at
           WHERE customers.erased_at IS NULL AND customers.shop_id = excluded.shop_id
           RETURNING id`,
        )
        .bind(row.id, shopId, row.code, row.name, row.search_name, row.phone, row.note, row.archived_at,
          row.created_at, row.updated_at, dev.id, nowIso, dev.role === 'owner' ? 0 : 1),
    );
  }
  if (custWrites.length) {
    // One change-log row per customer this transaction wrote (the rows it stamped with this device and instant).
    const ids = uniq(custWrites.map((w) => w.row.id));
    custLog = stmts.length;
    stmts.push(
      db
        .prepare(
          `INSERT INTO changelog (shop_id, tbl, row_id, device_id, received_at)
           SELECT shop_id, 'customers', id, ?1, ?2 FROM customers
           WHERE shop_id = ?3 AND updated_by = ?1 AND received_at = ?2 AND id IN (${nums(4, ids.length)})
           ORDER BY CASE id ${ids.map((_, k) => `WHEN ?${k + 4} THEN ${k}`).join(' ')} END
           RETURNING seq, row_id`,
        )
        .bind(dev.id, nowIso, shopId, ...ids),
    );
  }
  for (const { row } of entWrites) {
    // ON CONFLICT DO NOTHING (no target) covers both the id and entries_once (one reversal per original); the WHERE
    // keeps a skipped customer or reversal target from turning into a foreign-key failure.
    entStmt.push(stmts.length);
    stmts.push(
      db
        .prepare(
          `INSERT INTO entries (id, shop_id, customer_id, kind, amount_paise, delta_paise, biz_date, note, mode,
             reverses_entry_id, device_id, created_at, received_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
           WHERE EXISTS (SELECT 1 FROM customers WHERE id = ?3 AND shop_id = ?2)
             AND (?10 IS NULL OR EXISTS (SELECT 1 FROM entries WHERE id = ?10 AND shop_id = ?2))
           ON CONFLICT DO NOTHING
           RETURNING id`,
        )
        .bind(row.id, shopId, row.customer_id, row.kind, row.amount_paise, row.delta_paise, row.biz_date, row.note,
          row.mode, row.reverses_entry_id, dev.id, row.created_at, nowIso),
    );
  }
  if (entWrites.length) {
    // Entries are immutable: exactly one change-log row each, ever. Seqs follow the chunk order (classification only
    // accepts a reversal after its original, so originals always get the smaller seq).
    const ids = entWrites.map((w) => w.row.id);
    const order = ids.map((_, k) => `WHEN ?${k + 2} THEN ${k}`).join(' ');
    entLog = stmts.length;
    stmts.push(
      db
        .prepare(
          `INSERT INTO changelog (shop_id, tbl, row_id, device_id, received_at)
           SELECT shop_id, 'entries', id, device_id, received_at FROM entries
           WHERE shop_id = ?1 AND id IN (${nums(2, ids.length)})
             AND NOT EXISTS (SELECT 1 FROM changelog l WHERE l.shop_id = entries.shop_id AND l.row_id = entries.id)
           ORDER BY CASE id ${order} END
           RETURNING seq, row_id`,
        )
        .bind(shopId, ...ids),
    );
  }
  // Money on an archived customer brings it back, decided from the state at write time (so an archive that
  // committed after our pre-check is still caught): every customer that received an entry here, unless this chunk
  // itself archives it; and a customer this chunk archives whose balance is not zero once everything committed
  // (another phone's entry landed between our pre-check and this write).
  const touched = uniq(entWrites.map((w) => w.row.customer_id)).filter((id) => !archives.has(id));
  const archived = [...archives];
  if (touched.length || archived.length) {
    const conds: string[] = [];
    if (touched.length) conds.push(`id IN (${nums(3, touched.length)})`);
    if (archived.length)
      conds.push(
        `(id IN (${nums(3 + touched.length, archived.length)})
          AND (SELECT COALESCE(SUM(delta_paise), 0) FROM entries WHERE customer_id = customers.id) <> 0)`,
      );
    stmts.push(
      db
        .prepare(
          `UPDATE customers SET archived_at = NULL, updated_at = ?1, updated_by = '${SERVER_AUTHOR}', received_at = ?1
           WHERE shop_id = ?2 AND archived_at IS NOT NULL AND (${conds.join(' OR ')})`,
        )
        .bind(nowIso, shopId, ...touched, ...archived),
    );
    // Logged as SERVER_AUTHOR so every phone pulls it, including this one (its own rows are skipped).
    const all = [...touched, ...archived];
    stmts.push(
      db
        .prepare(
          `INSERT INTO changelog (shop_id, tbl, row_id, device_id, received_at)
           SELECT shop_id, 'customers', id, '${SERVER_AUTHOR}', ?1 FROM customers
           WHERE shop_id = ?2 AND updated_by = '${SERVER_AUTHOR}' AND received_at = ?1 AND id IN (${nums(3, all.length)})`,
        )
        .bind(nowIso, shopId, ...all),
    );
  }

  if (custWrites.length || entWrites.length) {
    let out: D1Result[];
    try {
      out = await db.batch(stmts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('push: write batch failed', msg);
      // Transient D1 trouble (network, overload, reset) is retriable: never let the client mark rows rejected for it.
      if (!isConstraintError(msg)) return fail(c, 503, 'unavailable');
      if (custIn.length + entIn.length === 1) {
        const r = results[0];
        if (r && r.status === 'stored') {
          r.status = 'rejected';
          r.reason = 'BATCH_FAILED';
        }
        return c.json<PushResponse>({ results, ...envelope(c, now) });
      }
      return fail(c, 500, 'batch_failed');
    }
    const seqs = (idx: number) =>
      new Map(idx < 0 ? [] : ((out[idx]?.results ?? []) as { seq: number; row_id: string }[]).map((r) => [r.row_id, r.seq]));
    const custSeq = seqs(custLog);
    const entSeq = seqs(entLog);
    const wrote = (idx: number | undefined) => idx !== undefined && (out[idx]?.results?.length ?? 0) > 0;
    const skippedCust = custWrites.filter((_, k) => !wrote(custStmt[k]));
    const skippedEnt = entWrites.filter((_, k) => !wrote(entStmt[k]));
    custWrites.forEach((w, k) => {
      if (wrote(custStmt[k])) (results[w.i] as PushResult).seq = custSeq.get(w.row.id);
    });
    entWrites.forEach((w, k) => {
      if (wrote(entStmt[k])) (results[w.i] as PushResult).seq = entSeq.get(w.row.id);
    });

    // Rows skipped by a write-time guard (a concurrent push or erase got there first): classify them now.
    if (skippedCust.length || skippedEnt.length) {
      const sTargets = uniq(skippedEnt.map((w) => w.row.reverses_entry_id).filter(str));
      const sCust = uniq([...skippedCust.map((w) => w.row.id), ...skippedEnt.map((w) => w.row.customer_id)]);
      const sEnt = uniq([...skippedEnt.map((w) => w.row.id), ...sTargets]);
      const q: D1PreparedStatement[] = [
        db.prepare(`SELECT id, shop_id, erased_at FROM customers WHERE id IN (${placeholders(sCust.length)})`).bind(...sCust),
      ];
      if (sEnt.length) q.push(db.prepare(`SELECT * FROM entries WHERE id IN (${placeholders(sEnt.length)})`).bind(...sEnt));
      if (sTargets.length)
        q.push(
          db
            .prepare(`SELECT reverses_entry_id FROM entries WHERE shop_id = ? AND reverses_entry_id IN (${placeholders(sTargets.length)})`)
            .bind(shopId, ...sTargets),
        );
      const fu = await db.batch(q);
      const custNow = new Map(((fu[0]?.results ?? []) as { id: string; shop_id: string; erased_at: string | null }[]).map((x) => [x.id, x]));
      const entNow = new Map(((sEnt.length ? fu[1]?.results : []) ?? []).map((e) => [(e as EntryDb).id, e as EntryDb]));
      const revNow = new Set(
        ((sTargets.length ? fu[q.length - 1]?.results : []) ?? []).map((r) => (r as { reverses_entry_id: string }).reverses_entry_id),
      );
      const set = (i: number, r: Partial<PushResult>) => {
        const res = results[i] as PushResult;
        delete res.seq;
        delete res.reason;
        Object.assign(res, r);
      };
      for (const w of skippedCust) {
        const cur = custNow.get(w.row.id);
        const reason: RejectReason = cur?.shop_id && cur.shop_id !== shopId ? 'MISMATCH' : cur?.erased_at ? 'ERASED' : 'CODE_TAKEN';
        set(w.i, { status: 'rejected', reason });
      }
      for (const w of skippedEnt) {
        const cur = entNow.get(w.row.id);
        const cust = custNow.get(w.row.customer_id);
        const target = w.row.reverses_entry_id ? entNow.get(w.row.reverses_entry_id) : undefined;
        if (cur) set(w.i, cur.shop_id === shopId && sameEntry(cur, w.row as unknown as Json) ? { status: 'already' } : { status: 'rejected', reason: 'MISMATCH' });
        else if (!cust || cust.shop_id !== shopId) set(w.i, { status: 'rejected', reason: 'UNKNOWN_CUSTOMER' });
        else if (w.row.reverses_entry_id && (!target || target.shop_id !== shopId)) set(w.i, { status: 'rejected', reason: 'UNKNOWN_ORIGINAL' });
        else if (w.row.reverses_entry_id && revNow.has(w.row.reverses_entry_id)) set(w.i, { status: 'rejected', reason: 'ALREADY_REVERSED' });
        else {
          // Not expected. Everything else in the chunk is committed, so a resend answers 'already' for it.
          console.error('push: entry skipped for an unknown reason');
          return fail(c, 503, 'unavailable');
        }
      }
    }
  }

  // 'already' rows carry their latest seq: one query on the changelog_row index, only when needed.
  const alreadyIds = uniq(results.filter((r) => r.status === 'already').map((r) => r.id));
  if (alreadyIds.length) {
    const { results: seqs } = await db
      .prepare(
        `SELECT row_id, MAX(seq) AS seq FROM changelog WHERE shop_id = ? AND row_id IN (${placeholders(alreadyIds.length)})
         GROUP BY row_id`,
      )
      .bind(shopId, ...alreadyIds)
      .all<{ row_id: string; seq: number }>();
    const bySeq = new Map(seqs.map((s) => [s.row_id, s.seq]));
    for (const r of results) if (r.status === 'already') r.seq = bySeq.get(r.id);
  }
  return c.json<PushResponse>({ results, ...envelope(c, now) });
});

/**
 * GET /v1/sync/pull?since&limit. The page and MAX(seq) come from one batch (same snapshot); the current row
 * content is fetched with seq-range joins over the page, never with big IN-lists.
 *
 * Rows authored by the calling device are skipped, EXCEPT on a full re-pull (since=0): a phone that rebuilt its local
 * database keeps its token, and without its own rows it would receive other phones' entries on customers it never got.
 */
syncRoutes.get('/sync/pull', auth, async (c) => {
  const sinceRaw = c.req.query('since') ?? '0';
  const limitRaw = c.req.query('limit') ?? String(PULL_PAGE_SIZE);
  if (!/^\d{1,15}$/.test(sinceRaw) || !/^\d{1,6}$/.test(limitRaw)) return badRequest(c, 'since/limit');
  const since = Number(sinceRaw);
  const limit = Math.min(Math.max(Number(limitRaw), 1), PULL_PAGE_SIZE);
  const db = c.env.DB;
  const dev = c.get('device');
  const shopId = dev.shop_id;
  const now = new Date();
  /** Author filtered out of this pull; '' (no row has it) on a full re-pull. */
  const skipAuthor = since === 0 ? '' : dev.id;

  const [pageRes, maxRes, devRes] = await db.batch([
    db
      .prepare(`SELECT seq, tbl, row_id FROM changelog WHERE shop_id = ? AND seq > ? AND device_id <> ? ORDER BY seq LIMIT ?`)
      .bind(shopId, since, skipAuthor, limit + 1),
    db.prepare('SELECT MAX(seq) AS max_seq FROM changelog WHERE shop_id = ?').bind(shopId),
    db.prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE shop_id = ? ORDER BY created_at, id`).bind(shopId),
  ]);
  const devices = ((devRes?.results ?? []) as DeviceInfo[]).map(toDeviceInfo);

  const page = (pageRes?.results ?? []) as { seq: number; tbl: Tbl; row_id: string }[];
  const maxSeq = Number((maxRes?.results?.[0] as { max_seq: number | null } | undefined)?.max_seq ?? 0);
  const hasMore = page.length > limit;
  const rows = hasMore ? page.slice(0, limit) : page;
  const lastSeq = rows.length ? (rows[rows.length - 1] as { seq: number }).seq : since;
  const nextSince = hasMore ? lastSeq : Math.max(lastSeq, maxSeq, since);

  let changes: Change[] = [];
  if (rows.length) {
    const [cRes, eRes] = await db.batch([
      db
        .prepare(
          `SELECT l.seq AS _seq, c.* FROM changelog l JOIN customers c ON c.id = l.row_id AND c.shop_id = l.shop_id
           WHERE l.shop_id = ?1 AND l.seq > ?2 AND l.seq <= ?3 AND l.device_id <> ?4 AND l.tbl = 'customers'`,
        )
        .bind(shopId, since, lastSeq, skipAuthor),
      db
        .prepare(
          `SELECT l.seq AS _seq, e.* FROM changelog l JOIN entries e ON e.id = l.row_id AND e.shop_id = l.shop_id
           WHERE l.shop_id = ?1 AND l.seq > ?2 AND l.seq <= ?3 AND l.device_id <> ?4 AND l.tbl = 'entries'`,
        )
        .bind(shopId, since, lastSeq, skipAuthor),
    ]);
    for (const r of (cRes?.results ?? []) as (CustomerDb & { _seq: number })[]) {
      changes.push({ seq: r._seq, tbl: 'customers', row: toCustomerRow(r) });
    }
    for (const r of (eRes?.results ?? []) as (EntryDb & { _seq: number })[]) {
      changes.push({ seq: r._seq, tbl: 'entries', row: toEntryRow(r) });
    }
    changes = changes.sort((a, b) => a.seq - b.seq);
  }

  return c.json<PullResponse>({
    changes,
    next_since: nextSince,
    has_more: hasMore,
    devices,
    shop: toShopInfo(c.get('shop')),
    ...envelope(c, now),
  });
});
