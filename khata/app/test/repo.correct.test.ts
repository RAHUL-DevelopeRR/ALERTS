/** Repo.correctEntry: the reversal and the corrected entry are written in ONE transaction. */
import { describe, expect, it } from 'vitest';
import { SqlRepo } from '../src/data/repo';
import { failingDb, makeRepo } from './helpers/repo';

describe('correctEntry', () => {
  it('reverses the original and adds the corrected entry, both outboxed, and returns the new balance', async () => {
    const { repo } = await makeRepo();
    const c = await repo.createCustomer({ name: 'Murugan' });
    const big = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 150_000 });
    const r = await repo.correctEntry(big.entry.id, { customer_id: c.id, kind: 'GIVE', amount_paise: 15_000 });
    expect(r.balance_paise).toBe(15_000);
    expect(r.reversal.reverses_entry_id).toBe(big.entry.id);
    expect(r.entry.amount_paise).toBe(15_000);
    expect(await repo.balance(c.id)).toBe(15_000);
    const rows = await repo.listEntries(c.id);
    expect(rows.map((x) => x.kind).sort()).toEqual(['GIVE', 'GIVE', 'REVERSAL']);
    const batch = await repo.outboxBatch(100);
    const ids = batch.entries.map((e) => e.id);
    expect(ids).toContain(r.reversal.id);
    expect(ids).toContain(r.entry.id);
  });

  it('writes nothing when the corrected entry is refused (no lone reversal)', async () => {
    const { repo } = await makeRepo();
    const c = await repo.createCustomer({ name: 'Murugan' });
    const big = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 150_000 });
    await expect(repo.correctEntry(big.entry.id, { customer_id: c.id, kind: 'GIVE', amount_paise: 0 })).rejects.toMatchObject({ code: 'BAD_AMOUNT' });
    await expect(
      repo.correctEntry(big.entry.id, { customer_id: c.id, kind: 'GIVE', amount_paise: 100, biz_date: '2099-01-01' }),
    ).rejects.toMatchObject({ code: 'FUTURE_DATE' });
    expect(await repo.balance(c.id)).toBe(150_000);
    expect((await repo.listEntries(c.id)).length).toBe(1);
  });

  it('rolls back the reversal when the second insert fails at the database', async () => {
    const { db, repo, clock } = await makeRepo();
    const c = await repo.createCustomer({ name: 'Murugan' });
    const big = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 150_000 });
    // Fail the 2nd INSERT INTO entries inside the transaction.
    let inserts = 0;
    const flaky = failingDb(db, { test: (sql: string) => /INSERT INTO entries/.test(sql) && ++inserts === 2 } as unknown as RegExp);
    const repo2 = new SqlRepo(flaky, { now: clock.now });
    await repo2.init();
    await expect(repo2.correctEntry(big.entry.id, { customer_id: c.id, kind: 'GIVE', amount_paise: 15_000 })).rejects.toThrow(/injected/);
    expect(await repo.balance(c.id)).toBe(150_000);
    expect((await repo.listEntries(c.id)).length).toBe(1);
  });

  it('refuses an already-reversed original and a different customer', async () => {
    const { repo } = await makeRepo();
    const a = await repo.createCustomer({ name: 'A' });
    const b = await repo.createCustomer({ name: 'B' });
    const e = await repo.addEntry({ customer_id: a.id, kind: 'GIVE', amount_paise: 1_000 });
    await expect(repo.correctEntry(e.entry.id, { customer_id: b.id, kind: 'GIVE', amount_paise: 500 })).rejects.toMatchObject({ code: 'BAD_ROW' });
    await repo.reverseEntry(e.entry.id);
    await expect(repo.correctEntry(e.entry.id, { customer_id: a.id, kind: 'GIVE', amount_paise: 500 })).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
    expect(await repo.balance(a.id)).toBe(0);
  });
});
