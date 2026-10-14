/**
 * Adversarial review of src/data/repo.ts (money-ledger correctness). These tests were written as `bug(...)`
 * (it.fails) while each defect was open; all of them are fixed now and run as plain regression tests.
 */
import { describe, it, expect } from 'vitest';
import { makeRepo, page, serverCustomer, serverEntry, pair } from './helpers/repo';
import { validateBackup } from '../src/data/repo';
import { SqlRepo } from '../src/data/repo';
import type { Db } from '../src/db/db';
import { openSqlJs } from '../src/db/sqljs';
import { migrate } from '../src/db/schema';
import { addDays } from '../src/core/ledger';

const ST = '2026-10-12T05:00:05.000Z';
const TODAY = '2026-10-12'; // T0 = 10:30 IST on 12 Oct 2026

describe('review: a reversal whose original was rejected', () => {
  it('is not counted once its original is permanently rejected (balance, home, totals)', async () => {
    const { repo } = await makeRepo();
    const c = await repo.createCustomer({ name: 'Kamala' });
    const g = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 50_000 });
    const r = await repo.reverseEntry(g.entry.id); // shopkeeper corrects it before the first sync
    expect(await repo.balance(c.id)).toBe(0);
    await repo.outboxBatch(20);
    // The server refuses the original permanently; the reversal (same chunk) can never find its target.
    await repo.applyPushResults([
      { tbl: 'customers', id: c.id, status: 'stored', seq: 1 },
      { tbl: 'entries', id: g.entry.id, status: 'rejected', reason: 'FUTURE_DATE' },
      { tbl: 'entries', id: r.reversal.id, status: 'rejected', reason: 'UNKNOWN_ORIGINAL' },
    ], ST);
    // Server and every other phone: 0. This phone: the orphan +(-50,000) reversal still counts.
    expect(await repo.balance(c.id)).toBe(0);
    expect((await repo.listHome()).find((h) => h.id === c.id)?.balance_paise).toBe(0);
    expect((await repo.totals()).advance_paise).toBe(0);
  });

  it('does not make exportBackup() write a file that validateBackup()/importBackup() refuses', async () => {
    const { repo } = await makeRepo();
    const c = await repo.createCustomer({ name: 'Kamala' });
    const g = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 50_000 });
    const r = await repo.reverseEntry(g.entry.id);
    await repo.outboxBatch(20);
    await repo.applyPushResults([
      { tbl: 'customers', id: c.id, status: 'stored', seq: 1 },
      { tbl: 'entries', id: g.entry.id, status: 'rejected', reason: 'BAD_AMOUNT' },
      { tbl: 'entries', id: r.reversal.id, status: 'rejected', reason: 'UNKNOWN_ORIGINAL' },
    ], ST);
    const file = await repo.exportBackup(); // rejected original left out, its pending reversal kept
    expect(() => validateBackup(file)).not.toThrow(); // today: BAD_BACKUP "reversal ...: target missing"
    const snap = await repo.snapshotIfDue();
    expect(() => validateBackup(snap)).not.toThrow();
  });
});

describe('review: never-accepted rejected customer', () => {
  it('day book / month totals agree with home + totals (they hide this customer, the day book counts it)', async () => {
    const { repo } = await makeRepo();
    const bad = await repo.createCustomer({ name: 'Bad' });
    const ok = await repo.createCustomer({ name: 'Ok' });
    await repo.addEntry({ customer_id: bad.id, kind: 'GIVE', amount_paise: 100 });
    await repo.addEntry({ customer_id: ok.id, kind: 'GIVE', amount_paise: 200 });
    await repo.applyPushResults([
      { tbl: 'customers', id: bad.id, status: 'rejected', reason: 'BAD_ROW' },
      { tbl: 'customers', id: ok.id, status: 'stored', seq: 1 },
    ], ST);
    expect((await repo.totals()).receivable_paise).toBe(200);
    const day = await repo.dayBook(TODAY);
    expect(day.totals.given_paise).toBe(200); // today: 300
    expect(day.totals.net_paise).toBe(200);
    expect(day.rows.map((x) => x.customer_id)).toEqual([ok.id]);
    expect((await repo.monthTotals('2026-10')).given_paise).toBe(200);
  });

  it('importBackup() does not resurrect a rejected (and dismissed) customer into home + totals', async () => {
    const { repo } = await makeRepo();
    const bad = await repo.createCustomer({ name: 'Duplicate typo' });
    await repo.addEntry({ customer_id: bad.id, kind: 'GIVE', amount_paise: 70_000 });
    await repo.applyPushResults([{ tbl: 'customers', id: bad.id, status: 'rejected', reason: 'BAD_ROW' }], ST);
    await repo.resolveRejected('customers', bad.id, 'discard'); // user dismissed it under Needs attention
    expect(await repo.listHome()).toEqual([]);
    expect((await repo.totals()).receivable_paise).toBe(0);
    await repo.importBackup(await repo.exportBackup()); // backup + restore of the same phone
    expect((await repo.listHome()).map((h) => h.id)).toEqual([]); // today: the customer is back, owing 700
    expect((await repo.totals()).receivable_paise).toBe(0);
  });
});

describe('review: re-queue / epoch change', () => {
  it('a permanently rejected entry does not start counting again after "Re-upload everything"', async () => {
    const { repo } = await makeRepo();
    const c = await repo.createCustomer({ name: 'Anbu' });
    const ok = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 10_000 });
    const badE = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 90_000 });
    await repo.outboxBatch(20);
    await repo.applyPushResults([
      { tbl: 'customers', id: c.id, status: 'stored', seq: 1 },
      { tbl: 'entries', id: ok.entry.id, status: 'stored', seq: 2 },
      { tbl: 'entries', id: badE.entry.id, status: 'rejected', reason: 'FUTURE_DATE' },
    ], ST);
    expect(await repo.balance(c.id)).toBe(10_000);
    await repo.requeueEverything(); // the user taps it offline; nothing re-validates it until a push
    expect(await repo.balance(c.id)).toBe(10_000); // today: 100,000
  });

  it('handleEpochChange() keeps a rejected entry out of balances until the server accepts it', async () => {
    const { repo } = await makeRepo();
    await pair(repo);
    const c = await repo.createCustomer({ name: 'Anbu' });
    const badE = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 90_000 });
    await repo.outboxBatch(20);
    await repo.applyPushResults([
      { tbl: 'customers', id: c.id, status: 'stored', seq: 1 },
      { tbl: 'entries', id: badE.entry.id, status: 'rejected', reason: 'MISMATCH' },
    ], ST);
    await repo.handleEpochChange('epoch-2');
    expect(await repo.balance(c.id)).toBe(0);
    expect((await repo.totals()).receivable_paise).toBe(0);
  });
});

describe('review: IST day edge', () => {
  it('default statement closes at the balance the shopkeeper sees (entry dated tomorrow by a fast phone)', async () => {
    const { repo } = await makeRepo();
    await pair(repo);
    const x = serverCustomer({ code: 900 });
    // Another phone, clock a few minutes fast just before midnight IST, wrote "tomorrow"; the server allows +1 day.
    const e1 = serverEntry(x.id, { amount_paise: 10_000, delta_paise: 10_000, biz_date: TODAY });
    const e2 = serverEntry(x.id, { amount_paise: 5_000, delta_paise: 5_000, biz_date: addDays(TODAY, 1) });
    await repo.applyPullPage(page([
      { seq: 1, tbl: 'customers', row: x },
      { seq: 2, tbl: 'entries', row: e1 },
      { seq: 3, tbl: 'entries', row: e2 },
    ]));
    const bal = await repo.balance(x.id);
    expect(bal).toBe(15_000);
    const p = await repo.defaultStatementPeriod(x.id);
    const st = await repo.statement(x.id, p.from, p.to);
    expect(st.closing_paise).toBe(bal); // today: 10,000 (the WhatsApp statement disagrees with the screen)
  });
});

describe('review: pull page atomicity', () => {
  it('a pulled entry the local schema refuses fails the page (no silent skip with the cursor moved past it)', async () => {
    const { repo } = await makeRepo();
    await pair(repo);
    const x = serverCustomer({ code: 900 });
    // e.g. a newer server/app version adds a kind (plan v1.2 "merge"), or a mode in another case.
    const e = serverEntry(x.id, { kind: 'TRANSFER' as never, amount_paise: 5_000, delta_paise: 5_000 });
    await expect(repo.applyPullPage(page([
      { seq: 1, tbl: 'customers', row: x },
      { seq: 2, tbl: 'entries', row: e },
    ]))).rejects.toThrow(); // today: resolves; INSERT OR IGNORE swallowed the CHECK failure
    expect(await repo.getMeta('cursor')).toBe('0');
  });
});

// ------------------------------------------------------------------ regression guards (pass today)

/** A Db whose outer methods throw while one of its transactions is running (the real adapters would hang). */
function deadlockGuard(db: Db): { db: Db; violations: string[] } {
  let depth = 0;
  const violations: string[] = [];
  const check = (what: string): void => {
    if (depth > 0) {
      violations.push(what);
      throw new Error(`DEADLOCK: outer Db used inside a transaction: ${what.slice(0, 60)}`);
    }
  };
  return {
    violations,
    db: {
      run: (sql, p) => { check(sql); return db.run(sql, p); },
      query: (sql, p) => { check(sql); return db.query(sql, p); },
      exec: (sql) => { check(sql); return db.exec(sql); },
      transaction: (fn) => {
        check('transaction()');
        return db.transaction(async (tx) => {
          depth++;
          try {
            return await fn(tx);
          } finally {
            depth--;
          }
        });
      },
      close: () => db.close(),
      engine: () => db.engine(),
    },
  };
}

describe('review guard: no Repo method touches the outer Db inside its own transaction', () => {
  it('every Repo method, including sync and backup paths', async () => {
    const raw = await openSqlJs();
    await migrate(raw);
    const g = deadlockGuard(raw);
    const repo = new SqlRepo(g.db, { now: () => new Date('2026-10-12T05:00:00.000Z') });
    await repo.init();
    await repo.saveSettings({ shop_name: 'S', lang: 'en', lock_timeout_min: 2, confirm_above_paise: 500, upi_id: 'a@b', device_name: 'P' });
    await repo.setMeta('onboarded', '1');
    await repo.getMeta('onboarded');
    await repo.setPin('1234');
    expect(await repo.verifyPin('1234')).toBe(true);
    const a = await repo.createCustomer({ name: 'Anbu', phone: '9876543210' });
    const b = await repo.createCustomer({ name: 'கமலா' });
    await repo.updateCustomer(a.id, { note: 'n' });
    await repo.findByPhone('9876543210');
    await repo.findBySameName('anbu');
    const e = await repo.addEntry({ customer_id: a.id, kind: 'GIVE', amount_paise: 1_000 });
    await repo.addEntry({ customer_id: a.id, kind: 'RECEIVE', amount_paise: 400, mode: 'UPI' });
    await repo.reverseEntry(e.entry.id);
    await repo.addEntry({ customer_id: b.id, kind: 'WRITEOFF', amount_paise: 10 });
    await repo.listHome();
    await repo.totals();
    await repo.balance(a.id);
    await repo.getCustomer(a.id);
    await repo.getEntry(e.entry.id);
    await repo.listEntries(a.id);
    await repo.recentDuplicate(a.id, 'GIVE', 1_000);
    const per = await repo.defaultStatementPeriod(a.id);
    await repo.statement(a.id, per.from, per.to);
    await repo.dayBook(TODAY);
    await repo.enteredOn(TODAY);
    await repo.monthTotals('2026-10');
    await repo.pendingCount();
    await repo.maxLocalCode();
    await repo.codesRemaining();
    await pair(repo);
    const batch = await repo.outboxBatch(20);
    await repo.applyPushResults([
      ...batch.customers.map((c, i) => ({ tbl: 'customers' as const, id: c.id, status: i ? 'rejected' as const : 'stored' as const, reason: i ? 'CODE_TAKEN' as const : undefined, seq: 1 })),
      ...batch.entries.map((x) => ({ tbl: 'entries' as const, id: x.id, status: 'rejected' as const, reason: 'BAD_AMOUNT' as const })),
    ], ST);
    await repo.needsAttention();
    await repo.resolveRejected('entries', batch.entries[0].id, 'resend');
    await repo.resolveRejected('entries', batch.entries[1].id, 'discard');
    const x = serverCustomer({ code: 901 });
    await repo.applyPullPage(page([{ seq: 5, tbl: 'customers', row: x }, { seq: 6, tbl: 'entries', row: serverEntry(x.id) }]));
    await repo.addCodeBlock(151, 200);
    await repo.setDevices([]);
    await repo.archiveCustomer(b.id).catch(() => undefined);
    await repo.unarchiveCustomer(b.id);
    await repo.applyErasure(x.id, { ...x, name: 'Erased', erased_at: ST });
    await repo.applyErasure(b.id);
    await repo.handleEpochChange('epoch-9');
    await repo.requeueEverything();
    const file = await repo.exportBackup();
    await repo.snapshotIfDue();
    await repo.importBackup(file);
    await repo.unpair(false);
    await repo.unpair(true);
    await repo.getSettings();
    expect(g.violations).toEqual([]);
  });
});
