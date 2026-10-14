/**
 * Regression tests for the second review round of the data area (src/data/repo.ts, src/db/schema.ts and the
 * shared src/core/ledger.ts helpers). The reviewers' own reproductions live in test/review-ledger.test.ts and
 * test/review-sync.test.ts; these cover the edges of each fix.
 */
import { describe, it, expect } from 'vitest';
import { makeRepo, pair, page, serverCustomer, serverEntry } from './helpers/repo';
import { ORIGINAL_REJECTED, validateBackup } from '../src/data/repo';
import { openSqlJs } from '../src/db/sqljs';
import { MIGRATIONS, SCHEMA_VERSION, migrate, splitSql } from '../src/db/schema';
import { formatDay, matchesQuery, searchKey } from '../src/core/ledger';

const ST = '2026-10-12T05:00:05.000Z';

describe('ledger helpers', () => {
  it('a doubled-letter or garbage query does not fold down to one common letter', () => {
    const keys = [
      searchKey({ name: 'Sundari', search_name: null, code: 1, phone: null, note: null }),
      searchKey({ name: 'Kasi', search_name: null, code: 2, phone: null, note: null }),
      searchKey({ name: 'முருகன்', search_name: null, code: 3, phone: null, note: null }),
    ];
    for (const q of ['zzz', 'qqq', 'ssss']) expect(keys.filter((k) => matchesQuery(k, q))).toEqual([]);
    expect(keys.filter((k) => matchesQuery(k, 'su'))).toHaveLength(1); // a short raw prefix still matches
    expect(matchesQuery(keys[2], 'murugan')).toBe(true); // the fold still works for real words
    expect(matchesQuery(keys[0], 'zundari')).toBe(true);
  });

  it('Tamil short months carry a full stop where they are cut short', () => {
    expect(formatDay('2026-08-12', 'ta')).toBe('12 ஆக. 2026');
    expect(formatDay('2026-01-02', 'ta', true)).toBe('2 ஜன.');
    expect(formatDay('2026-05-02', 'ta', true)).toBe('2 மே');
    expect(formatDay('2026-08-12', 'en')).toBe('12 Aug 2026');
  });
});

describe('schema v2', () => {
  it('adds customers.server_row and voids pending reversals of already-rejected originals', async () => {
    const db = await openSqlJs();
    await db.exec('PRAGMA foreign_keys = ON;');
    await db.transaction(async (tx) => {
      for (const st of splitSql(MIGRATIONS[0].sql)) await tx.run(st);
      await tx.run('PRAGMA user_version = 1');
    });
    await db.run(`INSERT INTO customers (id, code, name, created_at, updated_at, updated_by) VALUES ('c', 1, 'K', 'x', 'x', 'd')`);
    await db.run(`INSERT INTO entries (id, customer_id, kind, amount_paise, delta_paise, biz_date, device_id, created_at, sync_state, reject_reason)
                  VALUES ('o', 'c', 'GIVE', 500, 500, '2026-10-12', 'd', 'x', 'rejected', 'FUTURE_DATE')`);
    await db.run(`INSERT INTO entries (id, customer_id, kind, amount_paise, delta_paise, biz_date, reverses_entry_id, device_id, created_at)
                  VALUES ('r', 'c', 'REVERSAL', 500, -500, '2026-10-12', 'o', 'd', 'y')`);
    await db.run(`INSERT INTO outbox (tbl, row_id, queued_at) VALUES ('entries', 'r', 'y')`);
    expect(await migrate(db)).toBe(SCHEMA_VERSION);
    const [r] = await db.query<{ sync_state: string; reject_reason: string }>(`SELECT sync_state, reject_reason FROM entries WHERE id = 'r'`);
    expect(r).toEqual({ sync_state: 'rejected', reject_reason: ORIGINAL_REJECTED });
    expect(await db.query('SELECT * FROM outbox')).toEqual([]);
    expect(await db.query(`SELECT server_row FROM customers`)).toEqual([{ server_row: null }]);
  });
});

describe('reversal of a refused original', () => {
  it('is hidden from Needs attention, and resending the original brings it back, queued after it', async () => {
    const { repo } = await makeRepo();
    const c = await repo.createCustomer({ name: 'Kamala' });
    const g = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 50_000 });
    const r = await repo.reverseEntry(g.entry.id);
    await repo.outboxBatch(20);
    await repo.applyPushResults([
      { tbl: 'customers', id: c.id, status: 'stored', seq: 1 },
      { tbl: 'entries', id: r.reversal.id, status: 'rejected', reason: 'UNKNOWN_ORIGINAL' }, // listed first
      { tbl: 'entries', id: g.entry.id, status: 'rejected', reason: 'FUTURE_DATE' },
    ], ST);
    expect((await repo.getEntry(r.reversal.id))?.reject_reason).toBe(ORIGINAL_REJECTED);
    expect(await repo.balance(c.id)).toBe(0);
    expect(await repo.pendingCount()).toBe(0);
    expect((await repo.needsAttention()).map((x) => x.id)).toEqual([g.entry.id]);

    await repo.resolveRejected('entries', g.entry.id, 'resend');
    expect((await repo.getEntry(r.reversal.id))?.sync_state).toBe('pending');
    expect(await repo.balance(c.id)).toBe(0);
    const batch = await repo.outboxBatch(20);
    expect(batch.entries.map((e) => e.id)).toEqual([g.entry.id, r.reversal.id]);
  });

  it('a discarded original keeps its reversal void; an accepted copy pulled later revives it', async () => {
    const { repo } = await makeRepo();
    await pair(repo);
    const c = await repo.createCustomer({ name: 'Kamala' });
    const g = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 50_000 });
    const r = await repo.reverseEntry(g.entry.id);
    await repo.outboxBatch(20);
    await repo.applyPushResults([
      { tbl: 'customers', id: c.id, status: 'stored', seq: 1 },
      { tbl: 'entries', id: g.entry.id, status: 'rejected', reason: 'MISMATCH' },
    ], ST);
    await repo.resolveRejected('entries', g.entry.id, 'discard');
    expect((await repo.getEntry(r.reversal.id))?.sync_state).toBe('rejected');
    expect(await repo.balance(c.id)).toBe(0);
    // The server did hold this id (MISMATCH): its copy arrives through pull and counts; so does our reversal.
    const orig = await repo.getEntry(g.entry.id);
    await repo.applyPullPage(page([{ seq: 5, tbl: 'entries', row: { ...orig!, received_at: ST } }]));
    expect((await repo.getEntry(r.reversal.id))?.sync_state).toBe('pending');
    expect(await repo.balance(c.id)).toBe(0);
    expect(await repo.pendingCount()).toBe(1);
  });
});

describe('stale sync work after a rebuild', () => {
  it('applyPullPage ignores a page requested from a cursor that has since been reset', async () => {
    const { repo } = await makeRepo();
    await pair(repo);
    const x = serverCustomer({ code: 900 });
    await repo.applyPullPage(page([{ seq: 7, tbl: 'customers', row: x }]), 0);
    expect(await repo.getMeta('cursor')).toBe('7');
    await repo.requeueEverything(); // cursor back to 0
    const y = serverCustomer({ code: 901 });
    await repo.applyPullPage(page([{ seq: 9, tbl: 'customers', row: y }]), 7); // requested before the reset
    expect(await repo.getMeta('cursor')).toBe('0');
    expect(await repo.getCustomer(y.id)).toBeNull();
    await repo.applyPullPage(page([{ seq: 9, tbl: 'customers', row: y }])); // no `since`: applied as before
    expect(await repo.getMeta('cursor')).toBe('9');
  });

  it('push results for a batch read before a restore are ignored (the rows are pushed again)', async () => {
    const { repo } = await makeRepo();
    const c = await repo.createCustomer({ name: 'Anbu' });
    const file = await repo.exportBackup();
    await repo.outboxBatch(20);
    await repo.importBackup(file);
    const k = await repo.applyPushResults([{ tbl: 'customers', id: c.id, status: 'rejected', reason: 'BAD_ROW' }], ST);
    expect(k).toEqual({ accepted: 0, rejected: 0, retry: 0 });
    expect((await repo.getCustomer(c.id))?.sync_state).toBe('pending');
    expect(await repo.pendingCount()).toBe(1);
    await repo.outboxBatch(20);
    expect((await repo.applyPushResults([{ tbl: 'customers', id: c.id, status: 'stored', seq: 1 }], ST)).accepted).toBe(1);
  });
});

describe('re-pairing', () => {
  it('re-pairing with the same server and epoch does not re-upload accepted rows', async () => {
    const { repo } = await makeRepo();
    await pair(repo);
    const c = await repo.createCustomer({ name: 'Anbu' });
    await repo.outboxBatch(20);
    await repo.applyPushResults([{ tbl: 'customers', id: c.id, status: 'stored', seq: 1 }], ST);
    await repo.unpair(false);
    await pair(repo); // same shop, same epoch
    expect(await repo.pendingCount()).toBe(0);
    await repo.unpair(false);
    await pair(repo, { sync_epoch: 'epoch-other' }); // a different (or restored) server
    expect(await repo.pendingCount()).toBe(1);
    expect((await repo.getCustomer(c.id))?.sync_state).toBe('pending');
  });

  it('keeps a rejected entry rejected (and out of the balance) when it re-queues', async () => {
    const { repo } = await makeRepo();
    await pair(repo);
    const c = await repo.createCustomer({ name: 'Anbu' });
    const e = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 9_000 });
    await repo.outboxBatch(20);
    await repo.applyPushResults([
      { tbl: 'customers', id: c.id, status: 'stored', seq: 1 },
      { tbl: 'entries', id: e.entry.id, status: 'rejected', reason: 'BAD_AMOUNT' },
    ], ST);
    await repo.unpair(false);
    await pair(repo, { sync_epoch: 'epoch-other' });
    expect((await repo.getEntry(e.entry.id))?.sync_state).toBe('rejected');
    expect(await repo.balance(c.id)).toBe(0);
    expect((await repo.needsAttention()).map((x) => x.id)).toEqual([e.entry.id]);
  });
});

describe('refused customer update', () => {
  it('restores the latest server content (also when it arrived while the local edit was pending)', async () => {
    const { repo } = await makeRepo();
    await pair(repo, { role: 'staff' });
    const x = serverCustomer({ code: 900, name: 'Kamala', note: 'v1' });
    await repo.applyPullPage(page([{ seq: 1, tbl: 'customers', row: x }]));
    await repo.updateCustomer(x.id, { name: 'Kamala Teacher' });
    // Another phone changes the note; the local rename is still pending, so the pull keeps the local row.
    await repo.applyPullPage(page([{ seq: 2, tbl: 'customers', row: { ...x, note: 'v2', updated_at: ST } }]));
    expect((await repo.getCustomer(x.id))?.name).toBe('Kamala Teacher');
    await repo.outboxBatch(20);
    await repo.applyPushResults([{ tbl: 'customers', id: x.id, status: 'rejected', reason: 'ERASED' }], ST);
    const c = await repo.getCustomer(x.id);
    expect([c?.name, c?.note, c?.sync_state, c?.reject_reason]).toEqual(['Kamala', 'v2', 'rejected', 'ERASED']);
    expect((await repo.listHome()).map((h) => h.id)).toEqual([x.id]); // accepted before: still listed
  });

  it('staff cannot unarchive (the server would refuse it)', async () => {
    const { repo } = await makeRepo();
    const c = await repo.createCustomer({ name: 'Anbu' });
    await repo.archiveCustomer(c.id);
    await pair(repo, { role: 'staff' });
    await expect(repo.unarchiveCustomer(c.id)).rejects.toMatchObject({ code: 'OWNER_ONLY' });
  });
});

describe('backup', () => {
  it('an exported file always validates: no entry without its customer or its reversal target', async () => {
    const { repo } = await makeRepo();
    const bad = await repo.createCustomer({ name: 'Typo' });
    await repo.addEntry({ customer_id: bad.id, kind: 'GIVE', amount_paise: 100 });
    const ok = await repo.createCustomer({ name: 'Ok' });
    await repo.addEntry({ customer_id: ok.id, kind: 'GIVE', amount_paise: 200 });
    await repo.applyPushResults([{ tbl: 'customers', id: bad.id, status: 'rejected', reason: 'BAD_ROW' }], ST);
    // Still undecided: kept in the backup (its entries are real credit).
    expect((await repo.exportBackup()).customers.map((c) => c.id)).toContain(bad.id);
    await repo.resolveRejected('customers', bad.id, 'discard');
    const file = await repo.exportBackup();
    expect(file.customers.map((c) => c.id)).toEqual([ok.id]);
    expect(file.entries.every((e) => e.customer_id === ok.id)).toBe(true);
    expect(() => validateBackup(file)).not.toThrow();
  });
});

describe('statement period', () => {
  it('a settled period is unchanged; an open period without future rows still ends today', async () => {
    const { repo } = await makeRepo();
    const c = await repo.createCustomer({ name: 'Anbu' });
    await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 100, biz_date: '2026-10-10' });
    expect(await repo.defaultStatementPeriod(c.id)).toEqual({ from: '2026-10-10', to: '2026-10-12', kind: 'since_zero' });
    await repo.addEntry({ customer_id: c.id, kind: 'RECEIVE', amount_paise: 100, biz_date: '2026-10-11' });
    expect(await repo.defaultStatementPeriod(c.id)).toEqual({ from: '2026-10-10', to: '2026-10-11', kind: 'settled' });
    const x = serverCustomer({ code: 900 });
    await pair(repo);
    await repo.applyPullPage(page([
      { seq: 1, tbl: 'customers', row: x },
      { seq: 2, tbl: 'entries', row: serverEntry(x.id, { biz_date: '2026-10-13' }) },
    ]));
    expect(await repo.defaultStatementPeriod(x.id)).toEqual({ from: '2026-10-13', to: '2026-10-13', kind: 'since_zero' });
  });
});
