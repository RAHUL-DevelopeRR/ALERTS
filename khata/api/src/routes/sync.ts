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
import type { AppEnv } from '../env';
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
import { chunk, placeholders, uniq } from '../lib/util';
import { customerShape, entryShape } from '../lib/validate';

export const syncRoutes = new Hono<AppEnv>();

/** Change-log rows per INSERT statement (D1: at most 100 bound parameters; we bind 3 + 2 per row). */
const LOG_ROWS_PER_STMT = 20;

const str = (v: unknown): v is string => typeof v === 'string';
const nn = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

interface Accepted {
  tbl: Tbl;
  id: string;
  /** Index into results; null for server-side changes (un-archive) that answer no pushed row. */
  resultIndex: number | null;
}

/**
 * POST /v1/sync/push. Pre-checks in one batch of SELECTs, classification in memory (customers first),
 * then one write batch (one transaction) whose change-log statements yield the seqs via meta.last_row_id.
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
  const custIn = customers as (Json & { id: string })[];
  const entIn = entries as (Json & { id: string })[];

  const db = c.env.DB;
  const dev = c.get('device');
  const shopId = dev.shop_id;
  const now = new Date();
  const nowIso = iso(now);
  const todayIST = istDate(now);
  const results: PushResult[] = [];
  if (custIn.length + entIn.length === 0) return c.json<PushResponse>({ results, ...envelope(c, now) });

  // ---- 1. Pre-checks: one batch of indexed SELECTs (every IN-list stays far below 100 parameters).
  const targets = uniq(entIn.map((e) => e.reverses_entry_id).filter(str));
  const entryIds = uniq([...entIn.map((e) => e.id), ...targets]);
  const custIds = uniq([...custIn.map((x) => x.id), ...entIn.map((e) => e.customer_id).filter(str)]);
  const codes = uniq(custIn.map((x) => x.code).filter((v): v is number => typeof v === 'number' && Number.isSafeInteger(v)));
  const archiving = uniq(custIn.filter((x) => x.archived_at !== undefined && x.archived_at !== null).map((x) => x.id));

  const pre: { key: 'entries' | 'reversals' | 'customers' | 'codes' | 'balances'; stmt: D1PreparedStatement }[] = [];
  if (entryIds.length)
    pre.push({
      key: 'entries',
      stmt: db.prepare(`SELECT * FROM entries WHERE shop_id = ? AND id IN (${placeholders(entryIds.length)})`).bind(shopId, ...entryIds),
    });
  if (targets.length)
    pre.push({
      key: 'reversals',
      stmt: db
        .prepare(`SELECT id, reverses_entry_id FROM entries WHERE shop_id = ? AND reverses_entry_id IN (${placeholders(targets.length)})`)
        .bind(shopId, ...targets),
    });
  if (custIds.length)
    pre.push({
      key: 'customers',
      stmt: db.prepare(`SELECT * FROM customers WHERE shop_id = ? AND id IN (${placeholders(custIds.length)})`).bind(shopId, ...custIds),
    });
  if (codes.length)
    pre.push({
      key: 'codes',
      stmt: db.prepare(`SELECT id, code FROM customers WHERE shop_id = ? AND code IN (${placeholders(codes.length)})`).bind(shopId, ...codes),
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

  const serverEntries = new Map(rowsOf<EntryDb>('entries').map((e) => [e.id, e]));
  /** Entry state as of "now in this push": server rows plus rows accepted earlier in this chunk. */
  const entState = new Map<string, EntryDb>(serverEntries);
  const reversedIds = new Set(rowsOf<{ reverses_entry_id: string }>('reversals').map((r) => r.reverses_entry_id));
  const custState = new Map(rowsOf<CustomerDb>('customers').map((x) => [x.id, x]));
  const codesTaken = new Map(rowsOf<{ id: string; code: number }>('codes').map((x) => [x.code, x.id]));
  const balances = new Map(rowsOf<{ customer_id: string; bal: number }>('balances').map((b) => [b.customer_id, b.bal]));
  const knownCust = new Set(custState.keys());
  const pushedCustIds = new Set(custIn.map((x) => x.id));

  // This chunk's not-yet-stored entries per customer, for ARCHIVE_NONZERO.
  const chunkDelta = new Map<string, number>();
  for (const e of entIn) {
    if (serverEntries.has(e.id) || !str(e.customer_id)) continue;
    if (typeof e.delta_paise !== 'number' || !Number.isSafeInteger(e.delta_paise)) continue;
    chunkDelta.set(e.customer_id, (chunkDelta.get(e.customer_id) ?? 0) + e.delta_paise);
  }

  const stmts: D1PreparedStatement[] = [db.prepare('PRAGMA defer_foreign_keys = on')];
  const accepted: Accepted[] = [];
  const reject = (tbl: Tbl, id: string, reason: RejectReason) => results.push({ tbl, id, status: 'rejected', reason });

  // ---- 2a. Customers (their statements precede the entries').
  for (const x of custIn) {
    const prev = custState.get(x.id);
    if (prev && sameCustomer(prev, x)) {
      results.push({ tbl: 'customers', id: x.id, status: 'already' });
      continue;
    }
    const reason = validateCustomer(x, prev);
    if (reason) {
      reject('customers', x.id, reason);
      //MUT knownCust.delete(x.id); // its entries in this chunk answer UNKNOWN_CUSTOMER (retriable), never a FK failure
      continue;
    }
    const row: CustomerDb = {
      id: x.id,
      shop_id: shopId,
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
    // Server-order last-write-wins. erased_at and created_at are never written on update; erased rows are frozen.
    stmts.push(
      db
        .prepare(
          `INSERT INTO customers (id, shop_id, code, name, search_name, phone, note, archived_at, erased_at,
             created_at, updated_at, updated_by, received_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, ?11, ?12)
           ON CONFLICT(id) DO UPDATE SET code = excluded.code, name = excluded.name, search_name = excluded.search_name,
             phone = excluded.phone, note = excluded.note, archived_at = excluded.archived_at,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by, received_at = excluded.received_at
           WHERE customers.erased_at IS NULL AND customers.shop_id = excluded.shop_id`,
        )
        .bind(row.id, shopId, row.code, row.name, row.search_name, row.phone, row.note, row.archived_at,
          x.created_at as string, row.updated_at, dev.id, nowIso),
    );
    accepted.push({ tbl: 'customers', id: x.id, resultIndex: results.length });
    results.push({ tbl: 'customers', id: x.id, status: 'stored' });
    custState.set(x.id, row);
    knownCust.add(x.id);
    if (prev && prev.code !== row.code && codesTaken.get(prev.code) === x.id) codesTaken.delete(prev.code);
    codesTaken.set(row.code, x.id);
  }

  function validateCustomer(x: Json & { id: string }, prev: CustomerDb | undefined): RejectReason | null {
    const shape = customerShape(x);
    if (shape) return shape;
    if (prev?.erased_at) return 'ERASED';
    const wasArchived = !!prev?.archived_at;
    const isArchived = x.archived_at !== undefined && x.archived_at !== null;
    if (dev.role !== 'owner' && wasArchived !== isArchived) return 'FORBIDDEN_ROLE';
    const holder = codesTaken.get(x.code as number);
    if (holder !== undefined && holder !== x.id) return 'CODE_TAKEN';
    if (isArchived && !wasArchived && (balances.get(x.id) ?? 0) + (chunkDelta.get(x.id) ?? 0) !== 0) return 'ARCHIVE_NONZERO';
    return null;
  }

  // ---- 2b. Entries.
  const unarchive = new Set<string>();
  for (const e of entIn) {
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
      shop_id: shopId,
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
    stmts.push(
      db
        .prepare(
          `INSERT INTO entries (id, shop_id, customer_id, kind, amount_paise, delta_paise, biz_date, note, mode,
             reverses_entry_id, device_id, created_at, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        )
        .bind(row.id, shopId, row.customer_id, row.kind, row.amount_paise, row.delta_paise, row.biz_date, row.note,
          row.mode, row.reverses_entry_id, dev.id, row.created_at, nowIso),
    );
    accepted.push({ tbl: 'entries', id: e.id, resultIndex: results.length });
    results.push({ tbl: 'entries', id: e.id, status: 'stored' });
    entState.set(e.id, row);
    if (row.reverses_entry_id) reversedIds.add(row.reverses_entry_id);
    // Money on an archived customer brings it back (unless this chunk itself re-pushes that customer).
    if (custState.get(row.customer_id)?.archived_at && !pushedCustIds.has(row.customer_id)) unarchive.add(row.customer_id);
  }

  function validateEntry(e: Json & { id: string }): RejectReason | null {
    const shape = entryShape(e, todayIST);
    if (shape) return shape;
    if (e.kind === 'WRITEOFF' && dev.role !== 'owner') return 'FORBIDDEN_ROLE';
    if (!knownCust.has(e.customer_id as string)) return 'UNKNOWN_CUSTOMER';
    if (e.kind === 'REVERSAL') {
      const target = e.reverses_entry_id as string;
      const orig = entState.get(target);
      if (!orig) return 'UNKNOWN_ORIGINAL';
      if (orig.kind === 'REVERSAL') return 'REVERSAL_OF_REVERSAL';
      if (reversedIds.has(target)) return 'ALREADY_REVERSED';
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

  if (unarchive.size) {
    const ids = [...unarchive];
    stmts.push(
      db
        .prepare(
          `UPDATE customers SET archived_at = NULL, updated_at = ?1, updated_by = ?2, received_at = ?1
           WHERE shop_id = ?3 AND archived_at IS NOT NULL AND id IN (${ids.map((_, i) => `?${i + 4}`).join(',')})`,
        )
        .bind(nowIso, dev.id, shopId, ...ids),
    );
    for (const id of ids) accepted.push({ tbl: 'customers', id, resultIndex: null });
  }

  // ---- 3. Change log, in VALUES order; then one transaction for everything.
  const logPages = chunk(accepted, LOG_ROWS_PER_STMT);
  for (const page of logPages) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO changelog (shop_id, tbl, row_id, device_id, received_at) VALUES ` +
            page.map((_, i) => `(?1, ?${4 + 2 * i}, ?${5 + 2 * i}, ?2, ?3)`).join(', '),
        )
        .bind(shopId, dev.id, nowIso, ...page.flatMap((a) => [a.tbl, a.id])),
    );
  }

  if (accepted.length) {
    let out: D1Result[];
    try {
      out = await db.batch(stmts);
    } catch (err) {
      console.error('push: write batch failed', err instanceof Error ? err.message : 'unknown');
      if (custIn.length + entIn.length === 1) {
        const only = accepted.find((a) => a.resultIndex !== null);
        const r = only ? results[only.resultIndex as number] : undefined;
        if (r) {
          r.status = 'rejected';
          r.reason = 'BATCH_FAILED';
        }
        return c.json<PushResponse>({ results, ...envelope(c, now) });
      }
      return fail(c, 500, 'batch_failed');
    }
    const logOut = out.slice(out.length - logPages.length);
    logPages.forEach((page, p) => {
      const last = Number(logOut[p]?.meta.last_row_id);
      page.forEach((a, j) => {
        if (a.resultIndex !== null) {
          const r = results[a.resultIndex];
          if (r) r.seq = last - page.length + 1 + j;
        }
      });
    });
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

  const [pageRes, maxRes, devRes] = await db.batch([
    db
      .prepare(`SELECT seq, tbl, row_id FROM changelog WHERE shop_id = ? AND seq > ? AND device_id <> ? ORDER BY seq LIMIT ?`)
      .bind(shopId, since, dev.id, limit + 1),
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
          `SELECT l.seq AS _seq, c.* FROM changelog l JOIN customers c ON c.id = l.row_id
           WHERE l.shop_id = ?1 AND l.seq > ?2 AND l.seq <= ?3 AND l.device_id <> ?4 AND l.tbl = 'customers'`,
        )
        .bind(shopId, since, lastSeq, dev.id),
      db
        .prepare(
          `SELECT l.seq AS _seq, e.* FROM changelog l JOIN entries e ON e.id = l.row_id
           WHERE l.shop_id = ?1 AND l.seq > ?2 AND l.seq <= ?3 AND l.device_id <> ?4 AND l.tbl = 'entries'`,
        )
        .bind(shopId, since, lastSeq, dev.id),
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
