/**
 * Adversarial review of the money ledger (push / pull / erase / code blocks) and of the D1 limits.
 *
 * Convention: tests named `FIXED-n` reproduce defect BUG-n of the review and assert the corrected behaviour (they
 * asserted the faulty behaviour until it was fixed). Tests named `OK` are attacks the Worker already resisted; they
 * guard the invariant.
 *
 * Races are made deterministic by running one request through app.fetch() with a D1 wrapper that parks a chosen
 * db.batch() call (auth = 1st batch, push pre-check = 2nd, push write = 3rd) until another request has finished.
 */
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { PushRequest, PushResponse } from '../../shared/protocol';
import type { Bindings } from '../src/env';
import app from '../src/index';
import { addDevice, call, customer, entry, istToday, ORIGIN, owner, pull, push, reversal } from './helpers';

const one = async <T>(sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<T>()) as T;
const balance = async (id: string) =>
  (await one<{ b: number | null }>('SELECT SUM(delta_paise) AS b FROM entries WHERE customer_id = ?', id)).b ?? 0;
const archivedAt = async (id: string) =>
  (await one<{ a: string | null }>('SELECT archived_at AS a FROM customers WHERE id = ?', id)).a;

/** A D1 binding whose `gateAt`-th batch() waits for release(); `reached` resolves when it is parked. */
function gatedDb(db: D1Database, gateAt: number, opts: { throwInstead?: string } = {}) {
  let n = 0;
  let release!: () => void;
  let reachedFn!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (reachedFn = r));
  const wrapped = new Proxy(db, {
    get(t, k) {
      if (k === 'batch')
        return async (stmts: D1PreparedStatement[]) => {
          n++;
          if (n === gateAt) {
            if (opts.throwInstead) throw new Error(opts.throwInstead);
            reachedFn();
            await gate;
          }
          return t.batch(stmts);
        };
      const v = Reflect.get(t, k) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return { db: wrapped as D1Database, release, reached };
}

async function viaApp<T = any>(db: D1Database, method: string, path: string, token: string, body?: unknown) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${ORIGIN}/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { ...env, DB: db } as unknown as Bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: (await res.json()) as T & { error?: string } };
}
const pushVia = (db: D1Database, token: string, req: Partial<PushRequest>) =>
  viaApp<PushResponse>(db, 'POST', '/sync/push', token, { customers: req.customers ?? [], entries: req.entries ?? [] });

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------- archive
describe('archive with a non-zero balance', () => {
  it('FIXED-1: a same-chunk entry that is itself REJECTED does not count toward ARCHIVE_NONZERO', async () => {
    const o = await owner();
    const k = customer();
    await push(o.token, { customers: [k], entries: [entry(k.id, 'GIVE', 100000)] });
    // RECEIVE that will be rejected FUTURE_DATE, but its delta is summed into chunkDelta before validation
    const fakeSettle = entry(k.id, 'RECEIVE', 100000, { biz_date: istToday(5) });
    const r = await push(o.token, { customers: [{ ...k, archived_at: nowIso(), updated_at: nowIso() }], entries: [fakeSettle] });
    expect(r.body.results.map((x) => [x.status, x.reason])).toEqual([
      ['rejected', 'ARCHIVE_NONZERO'],
      ['rejected', 'FUTURE_DATE'],
    ]);
    expect(await archivedAt(k.id)).toBeNull();
    expect(await balance(k.id)).toBe(100000);
  });

  it('FIXED-2: the same entry id twice in one chunk is counted once toward ARCHIVE_NONZERO', async () => {
    const o = await owner();
    const k = customer();
    await push(o.token, { customers: [k], entries: [entry(k.id, 'GIVE', 1000)] });
    const half = entry(k.id, 'RECEIVE', 500);
    const r = await push(o.token, { customers: [{ ...k, archived_at: nowIso(), updated_at: nowIso() }], entries: [half, half] });
    expect(r.body.results.map((x) => x.reason ?? x.status)).toEqual(['ARCHIVE_NONZERO', 'stored', 'already']);
    expect(await archivedAt(k.id)).toBeNull();
    expect(await balance(k.id)).toBe(500);
  });

  it('FIXED-3: an entry accepted for an archived customer re-pushed (still archived) in the same chunk un-archives it', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const k = customer();
    await push(o.token, { customers: [k] });
    const archived = { ...k, archived_at: nowIso(), updated_at: nowIso() };
    expect((await push(o.token, { customers: [archived] })).body.results[0]!.status).toBe('stored');
    // the staff phone knows K is archived, edits the note and gives credit offline; both reach the server in one chunk
    const r = await push(s.token, {
      customers: [{ ...archived, note: 'moved to 4th street', updated_at: nowIso() }],
      entries: [entry(k.id, 'GIVE', 25000)],
    });
    expect(r.body.results.map((x) => x.status)).toEqual(['stored', 'stored']);
    // plan: "un-archives a customer in the same batch whenever it accepts an entry for them"
    expect(await archivedAt(k.id)).toBeNull();
    expect(await balance(k.id)).toBe(25000);
  });

  it('FIXED-4: archive racing a GIVE from another phone (pre-check and write are separate) -> ends un-archived', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const k = customer();
    await push(o.token, { customers: [k] });
    // owner archives K (balance 0 at pre-check time); its write batch is parked
    const g = gatedDb(env.DB, 3);
    const archiving = pushVia(g.db, o.token, { customers: [{ ...k, archived_at: nowIso(), updated_at: nowIso() }] });
    await g.reached;
    // staff GIVE commits in between (K not archived yet -> no un-archive statement)
    expect((await push(s.token, { entries: [entry(k.id, 'GIVE', 80000)] })).body.results[0]!.status).toBe('stored');
    g.release();
    // The archive write commits, then the in-batch guard sees the non-zero balance and un-archives (logged as 'server',
    // so the archiving phone pulls the correction too).
    const ar = (await archiving).body.results[0]!;
    expect(ar.status).toBe('stored');
    expect(await archivedAt(k.id)).toBeNull();
    expect(await balance(k.id)).toBe(80000);
    const p = await pull(o.token, ar.seq);
    expect(p.body.changes.filter((ch) => ch.tbl === 'customers').map((ch) => [ch.row.id, (ch.row as any).archived_at])).toEqual([
      [k.id, null],
    ]);
  });

  it('FIXED-5: the server-side un-archive is logged as authored by the server, so the pushing phone pulls it too', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const k = customer();
    await push(o.token, { customers: [k] });
    const archived = { ...k, archived_at: nowIso(), updated_at: nowIso() };
    await push(o.token, { customers: [archived] });
    // staff pulls the archive, then (offline-tolerant UI) posts a GIVE: the server un-archives K
    const p0 = await pull(s.token, 0);
    const since = p0.body.next_since;
    expect((await push(s.token, { entries: [entry(k.id, 'GIVE', 5000)] })).body.results[0]!.status).toBe('stored');
    expect(await archivedAt(k.id)).toBeNull();
    const log = await one<{ device_id: string }>(
      `SELECT device_id FROM changelog WHERE tbl = 'customers' AND row_id = ? ORDER BY seq DESC LIMIT 1`,
      k.id,
    );
    expect(log.device_id).toBe('server');
    const p1 = await pull(s.token, since);
    const seen = p1.body.changes.filter((ch) => ch.tbl === 'customers');
    expect(seen.map((ch) => [ch.row.id, (ch.row as any).archived_at])).toEqual([[k.id, null]]);
    // ...so its next harmless edit of K (from the pulled row) is accepted
    const edit = await push(s.token, { customers: [{ ...(seen[0]!.row as typeof archived), phone: '+919000000009', updated_at: nowIso() }] });
    expect(edit.body.results[0]!.status).toBe('stored');
  });
});

// ---------------------------------------------------------------------------------------------- reversals
describe('reversals', () => {
  it('OK: two reversals of one original in one chunk or sequentially -> one stored, the other ALREADY_REVERSED', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const k = customer();
    const g = entry(k.id, 'GIVE', 1500);
    await push(o.token, { customers: [k], entries: [g] });
    const r1 = reversal(g);
    const r2 = reversal(g);
    const same = await push(o.token, { entries: [r1, r2] });
    expect(same.body.results.map((x) => x.reason ?? x.status)).toEqual(['stored', 'ALREADY_REVERSED']);
    const r3 = await push(s.token, { entries: [reversal(g)] });
    expect(r3.body.results[0]!.reason).toBe('ALREADY_REVERSED');
    expect(await balance(k.id)).toBe(0);
  });

  it('OK: a reversal changing amount / customer / mode / date / sign is refused', async () => {
    const o = await owner();
    const k = customer();
    const m = customer();
    const rc = entry(k.id, 'RECEIVE', 700, { mode: 'UPI', biz_date: istToday(-3) });
    await push(o.token, { customers: [k, m], entries: [rc] });
    const bad = [
      reversal(rc, { amount_paise: 70, delta_paise: 70 }),
      reversal(rc, { customer_id: m.id }),
      reversal(rc, { mode: 'CASH' }),
      reversal(rc, { mode: null }),
      reversal(rc, { biz_date: istToday() }),
      reversal(rc, { delta_paise: -700 }),
    ];
    const r = await push(o.token, { entries: bad });
    expect(r.body.results.map((x) => x.reason)).toEqual(Array(6).fill('REVERSAL_MISMATCH'));
    expect(await balance(k.id)).toBe(-700);
    expect(await balance(m.id)).toBe(0);
  });

  it('FIXED-6: two phones reversing the same original concurrently -> ALREADY_REVERSED, never BATCH_FAILED / 500', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const k = customer();
    const g = entry(k.id, 'GIVE', 150000);
    await push(o.token, { customers: [k], entries: [g] });
    // single-row chunk: the client's terminal state -> permanently "Needs attention" instead of auto-resolving
    const gate = gatedDb(env.DB, 3);
    const late = pushVia(gate.db, o.token, { entries: [reversal(g)] });
    await gate.reached;
    expect((await push(s.token, { entries: [reversal(g)] })).body.results[0]!.status).toBe('stored');
    gate.release();
    expect((await late).body.results[0]).toMatchObject({ status: 'rejected', reason: 'ALREADY_REVERSED' });
    // multi-row chunk: the innocent rows in the chunk are stored, the losing reversal is ALREADY_REVERSED
    const g2 = entry(k.id, 'GIVE', 200);
    await push(o.token, { entries: [g2] });
    const gate2 = gatedDb(env.DB, 3);
    const innocent = entry(k.id, 'GIVE', 999);
    const late2 = pushVia(gate2.db, o.token, { entries: [innocent, reversal(g2)] });
    await gate2.reached;
    await push(s.token, { entries: [reversal(g2)] });
    gate2.release();
    const l2 = await late2;
    expect(l2.status).toBe(200);
    expect(l2.body.results.map((x) => x.reason ?? x.status)).toEqual(['stored', 'ALREADY_REVERSED']);
    expect(await one<{ n: number }>('SELECT COUNT(*) AS n FROM entries WHERE id = ?', innocent.id)).toEqual({ n: 1 });
    expect(await one<{ n: number }>('SELECT COUNT(*) AS n FROM entries WHERE reverses_entry_id = ?', g2.id)).toEqual({ n: 1 });
    // the ledger invariant itself holds (UNIQUE entries_once): one reversal per original
    expect(await one<{ n: number }>('SELECT COUNT(*) AS n FROM entries WHERE reverses_entry_id = ?', g.id)).toEqual({ n: 1 });
  });
});

// ---------------------------------------------------------------------------------------------- double-post / loss
describe('double-post and lost writes', () => {
  it('OK: the same entry twice in one chunk and a resend -> stored once, one change-log row', async () => {
    const o = await owner();
    const k = customer();
    const g = entry(k.id, 'GIVE', 1234);
    const r = await push(o.token, { customers: [k], entries: [g, g] });
    expect(r.body.results.map((x) => x.status)).toEqual(['stored', 'stored', 'already']);
    expect(r.body.results[2]!.seq).toBe(r.body.results[1]!.seq);
    await push(o.token, { entries: [g] });
    expect(await balance(k.id)).toBe(1234);
    expect(await one<{ n: number }>(`SELECT COUNT(*) AS n FROM changelog WHERE row_id = ?`, g.id)).toEqual({ n: 1 });
  });

  it('FIXED-7: a retry racing the in-flight original push -> one stored, the other already with the same seq, 1 log row', async () => {
    const o = await owner();
    const k = customer();
    await push(o.token, { customers: [k] });
    const g = entry(k.id, 'GIVE', 4200);
    const gate = gatedDb(env.DB, 3);
    const first = pushVia(gate.db, o.token, { entries: [g] });
    await gate.reached;
    const retry = await push(o.token, { entries: [g] }); // timeout-retry of the same chunk
    gate.release();
    const a = (await first).body.results[0]!;
    const b = retry.body.results[0]!;
    expect([a.status, b.status]).toEqual(['already', 'stored']);
    expect(a.seq).toBe(b.seq);
    expect(await balance(k.id)).toBe(4200);
    expect(await one<{ n: number }>(`SELECT COUNT(*) AS n FROM changelog WHERE row_id = ?`, g.id)).toEqual({ n: 1 });
  });

  it('FIXED-8: a transient D1 error on a single-row push is a retriable 503, not a permanent BATCH_FAILED', async () => {
    const o = await owner();
    const k = customer();
    await push(o.token, { customers: [k] });
    const g = entry(k.id, 'GIVE', 50000);
    const flaky = gatedDb(env.DB, 3, { throwInstead: 'D1_ERROR: Network connection lost.' });
    const r = await pushVia(flaky.db, o.token, { entries: [g] });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('unavailable');
    expect(await balance(k.id)).toBe(0);
    // a genuine constraint failure on a single row is still BATCH_FAILED
    const broken = gatedDb(env.DB, 3, { throwInstead: 'D1_ERROR: CHECK constraint failed: entries: SQLITE_CONSTRAINT' });
    const r2 = await pushVia(broken.db, o.token, { entries: [g] });
    expect(r2.body.results[0]).toMatchObject({ status: 'rejected', reason: 'BATCH_FAILED' });
  });

  it('FIXED-9 (low): upper-case ids are BAD_ROW, so an upper-case copy can never post the same money twice', async () => {
    const o = await owner();
    const k = customer();
    const g = entry(k.id, 'GIVE', 10000);
    await push(o.token, { customers: [k], entries: [g] });
    const r = await push(o.token, { entries: [{ ...g, id: g.id.toUpperCase() }] });
    expect(r.body.results[0]).toMatchObject({ status: 'rejected', reason: 'BAD_ROW' });
    expect(await balance(k.id)).toBe(10000);
    // and an upper-case customer_id is BAD_ROW (permanent), not UNKNOWN_CUSTOMER (retried forever)
    const r2 = await push(o.token, { entries: [entry(k.id.toUpperCase(), 'GIVE', 1)] });
    expect(r2.body.results[0]!.reason).toBe('BAD_ROW');
  });

  it('FIXED-10: a rejected update of an EXISTING customer leaves its same-chunk entries acceptable', async () => {
    const o = await owner();
    const k = customer();
    await push(o.token, { customers: [k] });
    const er = await call('POST', `/customers/${k.id}/erase`, { token: o.token });
    expect(er.status).toBe(200);
    // entries of an erased customer are kept and accepted alone...
    expect((await push(o.token, { entries: [entry(k.id, 'RECEIVE', 300)] })).body.results[0]!.status).toBe('stored');
    // ...but next to a (stale) customer row they answer UNKNOWN_CUSTOMER although K exists on the server
    const r = await push(o.token, { customers: [{ ...k, note: 'x', updated_at: nowIso() }], entries: [entry(k.id, 'RECEIVE', 200)] });
    expect(r.body.results.map((x) => x.reason ?? x.status)).toEqual(['ERASED', 'stored']);
  });
});

// ---------------------------------------------------------------------------------------------- erase
describe('erase', () => {
  it('OK: erased data cannot be resurrected by a later push, a new id with the same code, or an un-archive', async () => {
    const o = await owner();
    const k = customer({ name: 'Secret Name', phone: '+919811111111', note: 'private' });
    await push(o.token, { customers: [{ ...k, archived_at: nowIso() }] });
    await call('POST', `/customers/${k.id}/erase`, { token: o.token });
    const again = await push(o.token, { customers: [{ ...k, updated_at: nowIso() }] });
    expect(again.body.results[0]!.reason).toBe('ERASED');
    const clone = await push(o.token, { customers: [customer({ code: k.code, name: 'Secret Name' })] });
    expect(clone.body.results[0]!.reason).toBe('CODE_TAKEN');
    await push(o.token, { entries: [entry(k.id, 'GIVE', 100)] }); // triggers the server un-archive path
    const row = await one<any>('SELECT name, phone, note, search_name, erased_at FROM customers WHERE id = ?', k.id);
    expect(row.name).toMatch(/^Erased \d{4}-\d{2}-\d{2}$/);
    expect([row.phone, row.note, row.search_name]).toEqual([null, null, null]);
    expect(row.erased_at).not.toBeNull();
  });

  it('FIXED-11 (low): a customer edit racing an erase answers ERASED (the write is skipped and not logged)', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const k = customer();
    await push(o.token, { customers: [k] });
    const gate = gatedDb(env.DB, 3);
    const edit = pushVia(gate.db, s.token, { customers: [{ ...k, phone: '+919822222222', updated_at: nowIso() }] });
    await gate.reached;
    expect((await call('POST', `/customers/${k.id}/erase`, { token: o.token })).status).toBe(200);
    gate.release();
    const res = (await edit).body.results[0]!;
    expect(res).toMatchObject({ status: 'rejected', reason: 'ERASED' });
    expect(res.seq).toBeUndefined();
    expect(await one<{ n: number }>(`SELECT COUNT(*) AS n FROM changelog WHERE row_id = ? AND device_id = ?`, k.id, s.device_id)).toEqual({ n: 0 });
    expect((await one<any>('SELECT phone FROM customers WHERE id = ?', k.id)).phone).toBeNull(); // personal data stays erased
  });
});

// ---------------------------------------------------------------------------------------------- codes
describe('customer codes', () => {
  it('OK: code swaps and duplicate codes inside one chunk never turn into a 500', async () => {
    const o = await owner();
    const a = customer();
    const b = customer();
    await push(o.token, { customers: [a, b] });
    const r = await push(o.token, {
      customers: [
        { ...a, code: b.code, updated_at: nowIso() }, // swap: CODE_TAKEN, retriable
        { ...b, code: a.code, updated_at: nowIso() },
        customer({ code: 900001 }),
        customer({ code: 900001 }),
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.results.map((x) => x.reason ?? x.status)).toEqual(['CODE_TAKEN', 'CODE_TAKEN', 'stored', 'CODE_TAKEN']);
    // move away then reuse within one chunk is fine
    const r2 = await push(o.token, { customers: [{ ...a, code: 900002, updated_at: nowIso() }, customer({ code: a.code })] });
    expect(r2.status).toBe(200);
    expect(r2.body.results.map((x) => x.status)).toEqual(['stored', 'stored']);
  });

  it('FIXED-12: max_local_code is capped far below the customer-code ceiling, so blocks always stay usable', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    for (const path of ['/devices/code-block']) {
      const blk = await call('POST', path, { token: s.token, body: { max_local_code: 1_000_000_000 } });
      expect(blk.status).toBe(400);
    }
    const pc = await call('POST', '/devices/pair-code', { token: o.token, body: { role: 'staff' } });
    expect((await call('POST', '/pair', { body: { code: pc.body.code, device_name: 'x', max_local_code: 1_000_001 } })).status).toBe(400);
    // the highest accepted value still leaves usable codes
    const top = await call('POST', '/devices/code-block', { token: s.token, body: { max_local_code: 1_000_000 } });
    expect(top.status).toBe(200);
    const next = await call('POST', '/devices/code-block', { token: o.token, body: {} });
    const k = customer({ code: next.body.start });
    const r = await push(o.token, { customers: [k], entries: [entry(k.id, 'GIVE', 100)] });
    expect(r.body.results.map((x) => x.status)).toEqual(['stored', 'stored']);
  });
  it('FIXED-13: /pair with a STAFF code and previous_device_id = the owner\'s id does not revoke the owner phone', async () => {
    const o = await owner();
    const pc = await call('POST', '/devices/pair-code', { token: o.token, body: { role: 'staff' } });
    // device ids are visible to every phone (pull returns the device list)
    const r = await call('POST', '/pair', { body: { code: pc.body.code, device_name: 'Helper', previous_device_id: o.device_id } });
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('staff');
    expect((await call('GET', '/me', { token: o.token })).status).toBe(200);
    // a staff code still replaces a staff phone's old row, and an owner code an owner phone's
    const pc2 = await call('POST', '/devices/pair-code', { token: o.token, body: { role: 'staff' } });
    const r2 = await call('POST', '/pair', { body: { code: pc2.body.code, device_name: 'Helper again', previous_device_id: r.body.device_id } });
    expect(r2.status).toBe(200);
    expect((await call('GET', '/me', { token: r.body.token })).status).toBe(401);
    const pc3 = await call('POST', '/devices/pair-code', { token: o.token, body: { role: 'owner' } });
    const r3 = await call('POST', '/pair', { body: { code: pc3.body.code, device_name: 'Owner, re-paired', previous_device_id: o.device_id } });
    expect(r3.status).toBe(200);
    expect((await call('GET', '/me', { token: o.token })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------- amounts & roles
describe('amounts and roles', () => {
  it('OK: floats, strings, overflow and unsafe integers are BAD_AMOUNT', async () => {
    const o = await owner();
    const k = customer();
    await push(o.token, { customers: [k] });
    const bad = [
      entry(k.id, 'GIVE', 100, { amount_paise: 100.5, delta_paise: 100.5 }),
      entry(k.id, 'GIVE', 100, { amount_paise: '100' as any, delta_paise: 100 }),
      entry(k.id, 'GIVE', 100, { amount_paise: 2 ** 53, delta_paise: 2 ** 53 }),
      entry(k.id, 'GIVE', 100, { amount_paise: 1e12 + 1, delta_paise: 1e12 + 1 }),
      entry(k.id, 'RECEIVE', 100, { delta_paise: 100 }),
      entry(k.id, 'GIVE', 100, { delta_paise: -0 }),
    ];
    const r = await push(o.token, { entries: bad });
    expect(r.body.results.map((x) => x.reason)).toEqual(Array(6).fill('BAD_AMOUNT'));
    // the biggest allowed amount round-trips exactly
    const big = entry(k.id, 'GIVE', 1e12);
    expect((await push(o.token, { entries: [big] })).body.results[0]!.status).toBe('stored');
    expect(await balance(k.id)).toBe(1e12);
  });

  it('OK: a staff phone cannot write off or archive (new or existing customer)', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const k = customer();
    await push(o.token, { customers: [k], entries: [entry(k.id, 'GIVE', 300)] });
    const r = await push(s.token, {
      customers: [customer({ archived_at: nowIso() }), { ...k, archived_at: nowIso(), updated_at: nowIso() }],
      entries: [entry(k.id, 'WRITEOFF', 300)],
    });
    expect(r.body.results.map((x) => x.reason)).toEqual(['FORBIDDEN_ROLE', 'FORBIDDEN_ROLE', 'FORBIDDEN_ROLE']);
    const r2 = await push(s.token, { entries: [entry(k.id, 'WRITEOFF', 300)] });
    expect(r2.body.results[0]!.reason).toBe('FORBIDDEN_ROLE');
    expect((await call('POST', `/customers/${k.id}/erase`, { token: s.token })).status).toBe(403);
    expect(await balance(k.id)).toBe(300);
  });
});

// ---------------------------------------------------------------------------------------------- D1 limits
describe('D1 limits', () => {
  it('OK: worst-case 20-row push (customers + archives + reversals + un-archives) stays under 50 queries / 100 params', async () => {
    const o = await owner();
    const zeroes = Array.from({ length: 5 }, () => customer());
    const archived = Array.from({ length: 5 }, () => customer({ archived_at: nowIso() }));
    const withMoney = customer();
    const gives = Array.from({ length: 5 }, () => entry(withMoney.id, 'GIVE', 100));
    await push(o.token, { customers: [...zeroes, ...archived, withMoney], entries: gives });
    const stats = { queries: 0, maxParams: 0 };
    const counting = new Proxy(env.DB, {
      get(t, k) {
        if (k === 'prepare')
          return (q: string) => {
            const st = t.prepare(q);
            const bind = st.bind.bind(st);
            (st as any).bind = (...a: unknown[]) => {
              stats.maxParams = Math.max(stats.maxParams, a.length);
              const b = bind(...a);
              for (const m of ['first', 'all', 'run', 'raw'] as const) {
                const f = (b as any)[m].bind(b);
                (b as any)[m] = (...x: unknown[]) => (stats.queries++, f(...x));
              }
              return b;
            };
            for (const m of ['first', 'all', 'run', 'raw'] as const) {
              const f = (st as any)[m].bind(st);
              (st as any)[m] = (...x: unknown[]) => (stats.queries++, f(...x));
            }
            return st;
          };
        if (k === 'batch') return (s: D1PreparedStatement[]) => ((stats.queries += s.length), t.batch(s));
        const v = Reflect.get(t, k) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const now = nowIso();
    const chunk: Partial<PushRequest> = {
      customers: [
        ...zeroes.map((x) => ({ ...x, archived_at: now, updated_at: now })), // 5 archives -> balance pre-check
        customer(),
        customer(),
      ],
      entries: [
        ...gives.map((g) => reversal(g)), // 5 reversals -> reversal pre-check
        ...archived.map((x) => entry(x.id, 'GIVE', 100)), // 5 un-archives
        entry(withMoney.id, 'GIVE', 1),
        gives[0]!, // 'already' -> seq lookup
        entry(zeroes[0]!.id, 'GIVE', 5),
      ],
    };
    expect((chunk.customers!.length + chunk.entries!.length)).toBe(20);
    const r = await pushVia(counting as D1Database, o.token, chunk);
    expect(r.status).toBe(200);
    expect(r.body.results).toHaveLength(20);
    expect(stats.queries).toBeLessThan(50);
    expect(stats.maxParams).toBeLessThan(100);
  });

  it('OK: every hot query is served by an index (no full table SCAN)', async () => {
    const ids = ['a', 'b'];
    const queries = [
      [`SELECT * FROM entries WHERE shop_id = ? AND id IN (?,?)`, 's', ...ids],
      [`SELECT id, reverses_entry_id FROM entries WHERE shop_id = ? AND reverses_entry_id IN (?,?)`, 's', ...ids],
      [`SELECT * FROM customers WHERE shop_id = ? AND id IN (?,?)`, 's', ...ids],
      [`SELECT id, code FROM customers WHERE shop_id = ? AND code IN (?,?)`, 's', 1, 2],
      [`SELECT customer_id, SUM(delta_paise) AS bal FROM entries WHERE shop_id = ? AND customer_id IN (?,?) GROUP BY customer_id`, 's', ...ids],
      [`SELECT row_id, MAX(seq) AS seq FROM changelog WHERE shop_id = ? AND row_id IN (?,?) GROUP BY row_id`, 's', ...ids],
      [`SELECT seq, tbl, row_id FROM changelog WHERE shop_id = ? AND seq > ? AND device_id <> ? ORDER BY seq LIMIT ?`, 's', 0, 'd', 501],
      [`SELECT MAX(seq) AS max_seq FROM changelog WHERE shop_id = ?`, 's'],
      [`SELECT l.seq AS _seq, c.* FROM changelog l JOIN customers c ON c.id = l.row_id
        WHERE l.shop_id = ?1 AND l.seq > ?2 AND l.seq <= ?3 AND l.device_id <> ?4 AND l.tbl = 'customers'`, 's', 0, 9, 'd'],
      [`SELECT l.seq AS _seq, e.* FROM changelog l JOIN entries e ON e.id = l.row_id
        WHERE l.shop_id = ?1 AND l.seq > ?2 AND l.seq <= ?3 AND l.device_id <> ?4 AND l.tbl = 'entries'`, 's', 0, 9, 'd'],
      // push after the review fixes: unscoped primary-key pre-checks, write-time guards, change-log inserts
      [`SELECT * FROM entries WHERE id IN (?,?)`, ...ids],
      [`SELECT * FROM customers WHERE id IN (?,?)`, ...ids],
      [`SELECT 1 FROM customers WHERE shop_id = ?1 AND code = ?2 AND id <> ?3`, 's', 1, 'a'],
      [`SELECT 1 FROM changelog l WHERE l.shop_id = ?1 AND l.row_id = ?2`, 's', 'a'],
      [`SELECT shop_id, id FROM customers WHERE shop_id = ?1 AND updated_by = ?2 AND received_at = ?3 AND id IN (?4,?5)`, 's', 'd', 't', ...ids],
      [`SELECT id FROM customers c WHERE shop_id = ?1 AND archived_at IS NOT NULL AND (id IN (?2)
        OR (id IN (?3) AND (SELECT COALESCE(SUM(delta_paise), 0) FROM entries WHERE customer_id = c.id) <> 0))`, 's', 'a', 'b'],
    ] as const;
    for (const [sql, ...b] of queries) {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...b).all<{ detail: string }>();
      const details = plan.results.map((p) => p.detail);
      expect(details.filter((d) => /^SCAN /.test(d)), `${sql}\n${details.join('\n')}`).toEqual([]);
    }
  });
});
