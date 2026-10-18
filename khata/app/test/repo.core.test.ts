import { describe, it, expect } from 'vitest';
import { makeRepo, failingDb, pair } from './helpers/repo';
import { SqlRepo } from '../src/data/repo';
import { RepoError } from '../src/data/types';

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RepoError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
}

describe('settings, meta, init', () => {
  it('defaults after init, idempotent init, provisional identity', async () => {
    const { repo } = await makeRepo();
    const s = await repo.getSettings();
    expect(s).toMatchObject({
      shop_name: '', upi_id: null, lang: 'ta', pin_set: false, lock_timeout_min: 10, confirm_above_paise: 1_000_000,
      paired: false, server_url: null, role: 'owner', clock_offset_ms: 0,
    });
    expect(s.device_id).toMatch(/^local-[0-9a-f-]{36}$/);
    await repo.init();
    expect((await repo.getSettings()).device_id).toBe(s.device_id);
    expect(await repo.getMeta('code_next')).toBe('1');
    expect(await repo.getMeta('code_end')).toBe('1000000');
    expect(await repo.getMeta('cursor')).toBe('0');
  });

  it('saveSettings validates and persists; setMeta/getMeta', async () => {
    const { repo } = await makeRepo();
    const s = await repo.saveSettings({ shop_name: '  Murugan   Stores ', lang: 'en', lock_timeout_min: 2, upi_id: ' m@upi ', confirm_above_paise: 500_000 });
    expect(s).toMatchObject({ shop_name: 'Murugan Stores', lang: 'en', lock_timeout_min: 2, upi_id: 'm@upi', confirm_above_paise: 500_000 });
    expect(await code(repo.saveSettings({ lang: 'fr' as 'en' }))).toBe('BAD_SETTINGS');
    expect(await code(repo.saveSettings({ lock_timeout_min: 0 }))).toBe('BAD_SETTINGS');
    await repo.setMeta('last_backup_at', '2026-10-12T00:00:00.000Z');
    expect(await repo.getMeta('last_backup_at')).toBe('2026-10-12T00:00:00.000Z');
    await repo.setMeta('last_backup_at', null);
    expect(await repo.getMeta('last_backup_at')).toBeNull();
    await repo.setMeta('clock_offset_ms', '-60000');
    expect((await repo.getSettings()).clock_offset_ms).toBe(-60000);
  });

  it('PIN set / verify / clear (PBKDF2, salted)', async () => {
    const { repo } = await makeRepo();
    expect(await repo.verifyPin('1234')).toBe(false);
    await repo.setPin('1234');
    expect((await repo.getSettings()).pin_set).toBe(true);
    const hash1 = await repo.getMeta('pin_hash');
    const salt1 = await repo.getMeta('pin_salt');
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    expect(salt1).toMatch(/^[0-9a-f]{32}$/);
    expect(await repo.verifyPin('1234')).toBe(true);
    expect(await repo.verifyPin('1235')).toBe(false);
    expect(await repo.verifyPin('')).toBe(false);
    await repo.setPin('1234');
    expect(await repo.getMeta('pin_salt')).not.toBe(salt1); // fresh salt every time
    expect(await repo.verifyPin('1234')).toBe(true);
    await repo.setPin(null);
    expect((await repo.getSettings()).pin_set).toBe(false);
    expect(await repo.verifyPin('1234')).toBe(false);
  });
});

describe('customers', () => {
  it('new customer + Gave ₹250 + Got ₹100 = ₹150', async () => {
    const { repo, clock } = await makeRepo();
    const c = await repo.createCustomer({ name: 'Kamala', phone: '98765 43210', note: '3rd street' });
    expect(c).toMatchObject({ code: 1, name: 'Kamala', phone: '+919876543210', note: '3rd street', sync_state: 'pending' });
    const g = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 25_000 });
    expect(g.balance_paise).toBe(25_000);
    expect(g.entry).toMatchObject({ kind: 'GIVE', delta_paise: 25_000, biz_date: '2026-10-12', mode: null, sync_state: 'pending' });
    clock.advance(1000);
    const r = await repo.addEntry({ customer_id: c.id, kind: 'RECEIVE', amount_paise: 10_000, mode: 'UPI' });
    expect(r.balance_paise).toBe(15_000);
    expect(r.entry.delta_paise).toBe(-10_000);
    expect(await repo.balance(c.id)).toBe(15_000);
    const [home] = await repo.listHome();
    expect(home).toMatchObject({ id: c.id, balance_paise: 15_000, last_payment: '2026-10-12', first_give: '2026-10-12', days_since: 0, has_pending: true, has_rejected: false });
    expect(await repo.totals()).toEqual({ receivable_paise: 15_000, advance_paise: 0, customers_owing: 1 });
    const list = await repo.listEntries(c.id);
    expect(list.map((e) => e.running_paise)).toEqual([25_000, 15_000]);
    expect(list[0].device_name).toBeNull(); // this device
  });

  it('Tamil name gets an automatic search_name; explicit one is kept; rename keeps auto in step', async () => {
    const { repo } = await makeRepo();
    const a = await repo.createCustomer({ name: 'முருகன்' });
    expect(a.search_name).toBe('murukan');
    const b = await repo.createCustomer({ name: 'லட்சுமி', search_name: 'Lakshmi' });
    expect(b.search_name).toBe('Lakshmi');
    const c = await repo.createCustomer({ name: 'Ravi' });
    expect(c.search_name).toBeNull();
    const a2 = await repo.updateCustomer(a.id, { name: 'செந்தில்' });
    expect(a2.search_name).toBe('senthil');
    const b2 = await repo.updateCustomer(b.id, { name: 'லட்சுமி அம்மா' });
    expect(b2.search_name).toBe('Lakshmi'); // hand-typed: untouched
  });

  it('duplicate phone and same-name finders', async () => {
    const { repo } = await makeRepo();
    const k = await repo.createCustomer({ name: 'Kamala', phone: '+91 98765 43210' });
    const m = await repo.createCustomer({ name: '  murugan ', phone: '098765-43210' });
    const m2 = await repo.createCustomer({ name: 'MURUGAN' });
    expect((await repo.findByPhone('9876543210')).map((c) => c.id)).toEqual([k.id, m.id]);
    expect((await repo.findByPhone('98765 43210', k.id)).map((c) => c.id)).toEqual([m.id]);
    expect(await repo.findByPhone('12')).toEqual([]);
    expect((await repo.findBySameName('Murugan')).map((c) => c.id)).toEqual([m.id, m2.id]);
    expect((await repo.findBySameName('murugan', m.id)).map((c) => c.id)).toEqual([m2.id]);
    await repo.archiveCustomer(m2.id);
    expect((await repo.findBySameName('murugan')).map((c) => c.id)).toEqual([m.id]);
  });

  it('BAD_NAME / BAD_PHONE / NOT_FOUND / ERASED', async () => {
    const { repo } = await makeRepo();
    expect(await code(repo.createCustomer({ name: '   ' }))).toBe('BAD_NAME');
    expect(await code(repo.createCustomer({ name: 'X', phone: '12345' }))).toBe('BAD_PHONE');
    const c = await repo.createCustomer({ name: 'X', phone: '' });
    expect(c.phone).toBeNull();
    expect(await code(repo.updateCustomer(c.id, { phone: '555' }))).toBe('BAD_PHONE');
    expect(await code(repo.updateCustomer(c.id, { name: '' }))).toBe('BAD_NAME');
    expect(await code(repo.updateCustomer('nope', { name: 'Y' }))).toBe('NOT_FOUND');
    const long = await repo.updateCustomer(c.id, { note: `  ${'n'.repeat(250)} ` });
    expect(long.note!.length).toBe(200);
    await repo.applyErasure(c.id);
    expect(await code(repo.updateCustomer(c.id, { name: 'Y' }))).toBe('ERASED');
  });

  it('codes are sequential; maxLocalCode; outbox per write', async () => {
    const { repo, db } = await makeRepo();
    const a = await repo.createCustomer({ name: 'A' });
    const b = await repo.createCustomer({ name: 'B' });
    expect([a.code, b.code]).toEqual([1, 2]);
    expect(await repo.maxLocalCode()).toBe(2);
    await repo.updateCustomer(a.id, { note: 'x' });
    const ob = await db.query<{ tbl: string; row_id: string }>('SELECT tbl, row_id FROM outbox ORDER BY n');
    expect(ob.map((o) => o.row_id)).toEqual([a.id, b.id, a.id]);
    expect((await repo.getCustomer(a.id))!.updated_by).toBe((await repo.getSettings()).device_id);
  });

  it('archive: refused at non-zero, owner only, unarchive, entry un-archives', async () => {
    const { repo } = await makeRepo();
    const c = await repo.createCustomer({ name: 'Kamala' });
    await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 5_000 });
    expect(await code(repo.archiveCustomer(c.id))).toBe('ARCHIVE_NONZERO');
    await repo.addEntry({ customer_id: c.id, kind: 'RECEIVE', amount_paise: 5_000, mode: 'CASH' });
    const arch = await repo.archiveCustomer(c.id);
    expect(arch.archived_at).not.toBeNull();
    expect((await repo.listHome()).length).toBe(0);
    const back = await repo.unarchiveCustomer(c.id);
    expect(back.archived_at).toBeNull();
    await repo.archiveCustomer(c.id);
    await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 800 });
    expect((await repo.getCustomer(c.id))!.archived_at).toBeNull();
    const home = await repo.listHome();
    expect(home.map((h) => [h.id, h.balance_paise])).toEqual([[c.id, 800]]);
  });

  it('archived customer with a non-zero balance (from sync) stays on the home list', async () => {
    const { repo, db } = await makeRepo();
    const c = await repo.createCustomer({ name: 'Kamala' });
    await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 800 });
    await db.run('UPDATE customers SET archived_at = ? WHERE id = ?', ['2026-10-11T00:00:00.000Z', c.id]);
    const [h] = await repo.listHome();
    expect(h).toMatchObject({ id: c.id, balance_paise: 800 });
    expect(h.archived_at).not.toBeNull();
  });

  it('staff cannot archive or write off; owner can', async () => {
    const { repo } = await makeRepo();
    const c = await repo.createCustomer({ name: 'Kamala' });
    await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 1_000 });
    await pair(repo, { role: 'staff' });
    expect(await code(repo.addEntry({ customer_id: c.id, kind: 'WRITEOFF', amount_paise: 1_000 }))).toBe('OWNER_ONLY');
    const z = await repo.createCustomer({ name: 'Zero' });
    expect(await code(repo.archiveCustomer(z.id))).toBe('OWNER_ONLY');
    await repo.setMeta('role', 'owner');
    const w = await repo.addEntry({ customer_id: c.id, kind: 'WRITEOFF', amount_paise: 1_000, note: 'bad debt' });
    expect(w.balance_paise).toBe(0);
    expect(w.entry.delta_paise).toBe(-1_000);
    const day = await repo.dayBook('2026-10-12');
    expect(day.totals).toMatchObject({ given_paise: 1_000, writeoff_paise: 1_000, net_paise: 0, received_paise: 0 });
  });

  it('applyErasure (unpaired) blanks personal data, keeps entries; erased zero-balance hidden', async () => {
    const { repo } = await makeRepo();
    const c = await repo.createCustomer({ name: 'Kamala', phone: '9876543210', note: 'blue house' });
    await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 1_000 });
    const e = await repo.applyErasure(c.id);
    expect(e).toMatchObject({ name: 'Erased 2026-10-12', phone: null, note: null, search_name: null });
    expect(e.erased_at).not.toBeNull();
    expect((await repo.listHome()).map((h) => h.balance_paise)).toEqual([1_000]); // owes money: still listed
    await repo.addEntry({ customer_id: c.id, kind: 'RECEIVE', amount_paise: 1_000 });
    expect(await repo.listHome()).toEqual([]);
    expect((await repo.listEntries(c.id)).length).toBe(2);
  });

  it('codes: paired block, spare, exhaustion, codesRemaining', async () => {
    const { repo } = await makeRepo();
    await repo.createCustomer({ name: 'Pre' }); // provisional code 1
    await pair(repo, { code_block: { start: 100, end: 101 } });
    expect(await repo.codesRemaining()).toBe(2);
    expect((await repo.createCustomer({ name: 'A' })).code).toBe(100);
    expect((await repo.createCustomer({ name: 'B' })).code).toBe(101);
    expect(await code(repo.createCustomer({ name: 'C' }))).toBe('CODES_EXHAUSTED');
    expect(await repo.codesRemaining()).toBe(0);
    await repo.addCodeBlock(150, 151);
    await repo.addCodeBlock(200, 249);
    expect(await repo.codesRemaining()).toBe(52);
    expect((await repo.createCustomer({ name: 'C' })).code).toBe(150);
    expect((await repo.createCustomer({ name: 'D' })).code).toBe(151);
    expect((await repo.createCustomer({ name: 'E' })).code).toBe(200); // spare promoted
    expect(await repo.getMeta('spare_start')).toBeNull();
    expect(await repo.codesRemaining()).toBe(49);
    expect(await repo.maxLocalCode()).toBe(200);
  });
});

describe('entries', () => {
  it('validation: BAD_AMOUNT, FUTURE_DATE, BAD_DATE, NOT_FOUND; note trimmed; mode only on RECEIVE', async () => {
    const { repo } = await makeRepo();
    const c = await repo.createCustomer({ name: 'K' });
    expect(await code(repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 0 }))).toBe('BAD_AMOUNT');
    expect(await code(repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 12.5 }))).toBe('BAD_AMOUNT');
    expect(await code(repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 100, biz_date: '2026-10-13' }))).toBe('FUTURE_DATE');
    expect(await code(repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 100, biz_date: '2026-02-30' }))).toBe('BAD_DATE');
    expect(await code(repo.addEntry({ customer_id: 'x', kind: 'GIVE', amount_paise: 100 }))).toBe('NOT_FOUND');
    const { entry } = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 100, note: '  rice  ', mode: 'UPI' });
    expect(entry).toMatchObject({ note: 'rice', mode: null });
    expect(await repo.getEntry(entry.id)).toEqual(entry);
    expect(await repo.getEntry('nope')).toBeNull();
  });

  it('clock offset moves "today"', async () => {
    const { repo, clock } = await makeRepo('2026-10-12T18:00:00.000Z'); // 23:30 IST 12 Oct
    const c = await repo.createCustomer({ name: 'K' });
    expect((await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 100 })).entry.biz_date).toBe('2026-10-12');
    await repo.setMeta('clock_offset_ms', String(60 * 60_000)); // server is an hour ahead
    expect((await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 100 })).entry.biz_date).toBe('2026-10-13');
    clock.advance(0);
  });

  it('reversal + corrected entry: day book excludes the reversed ₹1,500, shows ₹150; statement too', async () => {
    const { repo, clock } = await makeRepo();
    const c = await repo.createCustomer({ name: 'Kamala' });
    const wrong = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 150_000, biz_date: '2026-10-11' });
    clock.advance(60_000);
    const rev = await repo.reverseEntry(wrong.entry.id, 'typo');
    expect(rev.reversal).toMatchObject({ kind: 'REVERSAL', delta_paise: -150_000, amount_paise: 150_000, biz_date: '2026-10-11', reverses_entry_id: wrong.entry.id, note: 'typo' });
    expect(rev.balance_paise).toBe(0);
    clock.advance(1000);
    const fixed = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 15_000, biz_date: '2026-10-11' });
    expect(fixed.balance_paise).toBe(15_000);
    const day = await repo.dayBook('2026-10-11');
    expect(day.totals).toEqual({
      biz_date: '2026-10-11', given_paise: 15_000, received_paise: 0, received_cash_paise: 0, received_upi_paise: 0,
      received_other_paise: 0, writeoff_paise: 0, net_paise: 15_000, corrections_count: 1, entry_count: 3,
    });
    expect(day.rows.map((r) => [r.kind, r.is_reversed, r.customer_code, r.customer_name])).toEqual([
      ['GIVE', true, 1, 'Kamala'], ['REVERSAL', false, 1, 'Kamala'], ['GIVE', false, 1, 'Kamala'],
    ]);
    const list = await repo.listEntries(c.id);
    expect(list.find((e) => e.id === wrong.entry.id)).toMatchObject({ is_reversed: true, reversed_by: rev.reversal.id });
    const st = await repo.statement(c.id, '2026-10-01', '2026-10-12');
    expect(st).toMatchObject({ opening_paise: 0, closing_paise: 15_000, given_paise: 15_000, received_paise: 0 });
    expect(st.rows.map((r) => r.running_paise)).toEqual([150_000, 0, 15_000]);
    // A reversed cash receipt never inflates the drawer
    const got = await repo.addEntry({ customer_id: c.id, kind: 'RECEIVE', amount_paise: 5_000, mode: 'CASH' });
    await repo.reverseEntry(got.entry.id);
    const today = await repo.dayBook('2026-10-12');
    expect(today.totals).toMatchObject({ received_paise: 0, received_cash_paise: 0, net_paise: 0, corrections_count: 1, entry_count: 2 });
  });

  it('reversing twice, reversing a reversal, reversing a missing or rejected entry', async () => {
    const { repo } = await makeRepo();
    const c = await repo.createCustomer({ name: 'K' });
    const g = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 500 });
    const r = await repo.reverseEntry(g.entry.id);
    expect(await code(repo.reverseEntry(g.entry.id))).toBe('ALREADY_REVERSED');
    expect(await code(repo.reverseEntry(r.reversal.id))).toBe('CANNOT_REVERSE_REVERSAL');
    expect(await code(repo.reverseEntry('missing'))).toBe('NOT_FOUND');
    const g2 = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 700 });
    await repo.applyPushResults([{ tbl: 'entries', id: g2.entry.id, status: 'rejected', reason: 'FUTURE_DATE' }], '2026-10-12T05:00:00Z');
    expect(await code(repo.reverseEntry(g2.entry.id))).toBe('REJECTED');
  });

  it('recentDuplicate: same device/customer/kind/amount within N seconds', async () => {
    const { repo, clock } = await makeRepo();
    const c = await repo.createCustomer({ name: 'K' });
    const d = await repo.createCustomer({ name: 'D' });
    await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 25_000 });
    clock.advance(30_000);
    expect(await repo.recentDuplicate(c.id, 'GIVE', 25_000)).toBe(true);
    expect(await repo.recentDuplicate(c.id, 'RECEIVE', 25_000)).toBe(false);
    expect(await repo.recentDuplicate(c.id, 'GIVE', 25_001)).toBe(false);
    expect(await repo.recentDuplicate(d.id, 'GIVE', 25_000)).toBe(false);
    expect(await repo.recentDuplicate(c.id, 'GIVE', 25_000, 10)).toBe(false);
    clock.advance(31_000);
    expect(await repo.recentDuplicate(c.id, 'GIVE', 25_000)).toBe(false);
  });

  it('rejected entries are excluded everywhere but listed in needsAttention', async () => {
    const { repo } = await makeRepo();
    const c = await repo.createCustomer({ name: 'Kamala' });
    await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 50_000 });
    const bad = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 20_000 });
    const res = await repo.applyPushResults([{ tbl: 'entries', id: bad.entry.id, status: 'rejected', reason: 'FUTURE_DATE' }], '2026-10-12T05:00:01.000Z');
    expect(res).toEqual({ accepted: 0, rejected: 1, retry: 0 });
    expect(await repo.balance(c.id)).toBe(50_000);
    const [h] = await repo.listHome();
    expect(h).toMatchObject({ balance_paise: 50_000, has_rejected: true });
    expect((await repo.totals()).receivable_paise).toBe(50_000);
    expect((await repo.listEntries(c.id)).map((e) => e.amount_paise)).toEqual([50_000]);
    const st = await repo.statement(c.id, '2026-10-01', '2026-10-12');
    expect([st.closing_paise, st.given_paise, st.rows.length]).toEqual([50_000, 50_000, 1]);
    expect((await repo.dayBook('2026-10-12')).totals).toMatchObject({ given_paise: 50_000, entry_count: 1, net_paise: 50_000 });
    expect((await repo.dayBook('2026-10-12')).rows.length).toBe(1);
    expect((await repo.enteredOn('2026-10-12')).length).toBe(1);
    expect((await repo.monthTotals('2026-10')).given_paise).toBe(50_000);
    expect(await repo.recentDuplicate(c.id, 'GIVE', 20_000)).toBe(false);
    const na = await repo.needsAttention();
    expect(na).toEqual([{ tbl: 'entries', id: bad.entry.id, reason: 'FUTURE_DATE', summary: '₹200 Debit · Kamala (C-0001) · 12 Oct', customer_id: c.id }]);
    expect((await repo.exportBackup()).entries.length).toBe(1);
    // discard: stays out of balances, leaves the list, badge goes
    await repo.resolveRejected('entries', bad.entry.id, 'discard');
    expect(await repo.needsAttention()).toEqual([]);
    expect((await repo.listHome())[0].has_rejected).toBe(false);
    expect(await repo.balance(c.id)).toBe(50_000);
    // resend: pending again, counted, outboxed
    await repo.resolveRejected('entries', bad.entry.id, 'resend');
    expect(await repo.balance(c.id)).toBe(70_000);
    expect((await repo.getEntry(bad.entry.id))!.sync_state).toBe('pending');
    expect((await repo.outboxBatch(20)).entries.map((e) => e.id)).toContain(bad.entry.id);
  });

  it('two concurrent addEntry calls both persist (queue serialises)', async () => {
    const { repo } = await makeRepo();
    const c = await repo.createCustomer({ name: 'K' });
    const results = await Promise.all([
      repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 1_000 }),
      repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 2_000 }),
      ...Array.from({ length: 10 }, () => repo.addEntry({ customer_id: c.id, kind: 'RECEIVE', amount_paise: 100 })),
      repo.createCustomer({ name: 'Other' }),
    ]);
    expect(results.length).toBe(13);
    expect(await repo.balance(c.id)).toBe(2_000);
    expect((await repo.listEntries(c.id)).length).toBe(12);
    expect(await repo.pendingCount()).toBe(14);
  });

  it('a failed write inside the transaction leaves no partial rows', async () => {
    const t = await makeRepo();
    const c = await t.repo.createCustomer({ name: 'K' });
    const broken = new SqlRepo(failingDb(t.db, /INSERT INTO outbox/), { now: t.clock.now });
    await expect(broken.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 1_000 })).rejects.toThrow(/injected/);
    await expect(broken.createCustomer({ name: 'Ghost' })).rejects.toThrow(/injected/);
    await expect(broken.reverseEntry((await t.repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 5 })).entry.id)).rejects.toThrow(/injected/);
    const [{ k }] = await t.db.query<{ k: number }>('SELECT COUNT(*) AS k FROM entries');
    expect(k).toBe(1);
    expect((await t.db.query('SELECT id FROM customers')).length).toBe(1);
    expect(await t.repo.getMeta('code_next')).toBe('2'); // code allocation rolled back too
    expect((await t.repo.createCustomer({ name: 'Real' })).code).toBe(2);
  });
});

describe('statements and reports', () => {
  it('statement opening/closing/running with back-dated entries', async () => {
    const { repo, clock } = await makeRepo();
    const c = await repo.createCustomer({ name: 'Kamala' });
    await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 50_000, biz_date: '2026-10-01' });
    clock.advance(1000);
    await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 30_000, biz_date: '2026-10-05' });
    clock.advance(1000);
    await repo.addEntry({ customer_id: c.id, kind: 'RECEIVE', amount_paise: 20_000, biz_date: '2026-10-10', mode: 'CASH' });
    clock.advance(1000);
    await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 10_000, biz_date: '2026-10-03' }); // typed last
    const all = await repo.listEntries(c.id);
    expect(all.map((e) => [e.biz_date, e.running_paise])).toEqual([
      ['2026-10-01', 50_000], ['2026-10-03', 60_000], ['2026-10-05', 90_000], ['2026-10-10', 70_000],
    ]);
    const st = await repo.statement(c.id, '2026-10-04', '2026-10-10');
    expect(st.opening_paise).toBe(60_000);
    expect(st.rows.map((r) => r.running_paise)).toEqual([90_000, 70_000]);
    expect(st.closing_paise).toBe(70_000);
    expect([st.given_paise, st.received_paise]).toEqual([30_000, 20_000]);
    expect(st.customer.id).toBe(c.id);
    const empty = await repo.statement(c.id, '2026-10-11', '2026-10-12');
    expect([empty.opening_paise, empty.closing_paise, empty.rows.length]).toEqual([70_000, 70_000, 0]);
    expect(await code(repo.statement(c.id, '2026-10-12', '2026-10-01'))).toBe('BAD_DATE');
    expect(await code(repo.statement('nope', '2026-10-01', '2026-10-02'))).toBe('NOT_FOUND');
  });

  it('default period: since last zero, and settled receipt', async () => {
    const { repo, clock } = await makeRepo();
    const c = await repo.createCustomer({ name: 'K' });
    expect(await repo.defaultStatementPeriod(c.id)).toEqual({ from: '2026-10-12', to: '2026-10-12', kind: 'since_zero' });
    await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 1_000, biz_date: '2026-09-01' });
    await repo.addEntry({ customer_id: c.id, kind: 'RECEIVE', amount_paise: 1_000, biz_date: '2026-09-10' });
    clock.advance(1000);
    await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 2_000, biz_date: '2026-10-02' });
    expect(await repo.defaultStatementPeriod(c.id)).toEqual({ from: '2026-10-02', to: '2026-10-12', kind: 'since_zero' });
    clock.advance(1000);
    await repo.addEntry({ customer_id: c.id, kind: 'RECEIVE', amount_paise: 2_000, biz_date: '2026-10-08' });
    expect(await repo.defaultStatementPeriod(c.id)).toEqual({ from: '2026-10-02', to: '2026-10-08', kind: 'settled' });
  });

  it('enteredOn (typed today) vs biz_date (back-dated slip)', async () => {
    const { repo } = await makeRepo();
    const c = await repo.createCustomer({ name: 'K' });
    const slip = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 4_000, biz_date: '2026-10-09' });
    expect((await repo.enteredOn('2026-10-12')).map((r) => r.id)).toEqual([slip.entry.id]);
    expect((await repo.dayBook('2026-10-12')).rows).toEqual([]);
    expect((await repo.dayBook('2026-10-09')).rows.map((r) => r.id)).toEqual([slip.entry.id]);
    expect(await repo.enteredOn('2026-10-09')).toEqual([]);
  });

  it('IST boundary: created at 18:45Z counts as the next IST day', async () => {
    const { repo } = await makeRepo('2026-10-12T18:45:00.000Z');
    const c = await repo.createCustomer({ name: 'K' });
    const { entry } = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 100 });
    expect(entry.biz_date).toBe('2026-10-13');
    expect((await repo.enteredOn('2026-10-13')).map((r) => r.id)).toEqual([entry.id]);
    expect(await repo.enteredOn('2026-10-12')).toEqual([]);
    expect((await repo.dayBook('2026-10-13')).totals.given_paise).toBe(100);
  });

  it('day book split by mode; month totals', async () => {
    const { repo } = await makeRepo();
    const c = await repo.createCustomer({ name: 'K' });
    await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 100_000, biz_date: '2026-10-01' });
    await repo.addEntry({ customer_id: c.id, kind: 'RECEIVE', amount_paise: 10_000, mode: 'CASH' });
    await repo.addEntry({ customer_id: c.id, kind: 'RECEIVE', amount_paise: 20_000, mode: 'UPI' });
    await repo.addEntry({ customer_id: c.id, kind: 'RECEIVE', amount_paise: 3_000, mode: 'OTHER' });
    await repo.addEntry({ customer_id: c.id, kind: 'RECEIVE', amount_paise: 400 });
    await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 999, biz_date: '2026-09-30' });
    const d = await repo.dayBook('2026-10-12');
    expect(d.totals).toMatchObject({ received_paise: 33_400, received_cash_paise: 10_000, received_upi_paise: 20_000, received_other_paise: 3_400, net_paise: -33_400, entry_count: 4 });
    const m = await repo.monthTotals('2026-10');
    expect(m).toMatchObject({ biz_date: '2026-10', given_paise: 100_000, received_paise: 33_400, net_paise: 66_600, entry_count: 5 });
    expect((await repo.monthTotals('2026-09')).given_paise).toBe(999);
    expect(await code(repo.monthTotals('2026-13'))).toBe('BAD_DATE');
    expect(await code(repo.dayBook('12-10-2026'))).toBe('BAD_DATE');
  });

  it('home list: sorting fields, days_since, reversed payments ignored, totals with advances', async () => {
    const { repo, clock } = await makeRepo();
    const a = await repo.createCustomer({ name: 'Anbu' });
    const b = await repo.createCustomer({ name: 'Bala' });
    const z = await repo.createCustomer({ name: 'Zero' }); // no entries
    const d = await repo.createCustomer({ name: 'Devi' });
    await repo.addEntry({ customer_id: a.id, kind: 'GIVE', amount_paise: 5_000, biz_date: '2026-08-01' });
    await repo.addEntry({ customer_id: a.id, kind: 'RECEIVE', amount_paise: 1_000, biz_date: '2026-09-12' });
    const late = await repo.addEntry({ customer_id: a.id, kind: 'RECEIVE', amount_paise: 1_000, biz_date: '2026-10-10' });
    clock.advance(1000);
    await repo.reverseEntry(late.entry.id); // bounced: last real payment is 12 Sep
    await repo.addEntry({ customer_id: b.id, kind: 'GIVE', amount_paise: 2_000, biz_date: '2026-09-02' });
    await repo.addEntry({ customer_id: b.id, kind: 'GIVE', amount_paise: 2_000, biz_date: '2026-10-11' });
    await repo.addEntry({ customer_id: d.id, kind: 'RECEIVE', amount_paise: 3_000, biz_date: '2026-10-12' }); // advance
    const home = await repo.listHome();
    expect(home.map((h) => h.name)).toEqual(['Devi', 'Bala', 'Anbu', 'Zero']);
    const by = Object.fromEntries(home.map((h) => [h.name, h]));
    expect(by.Anbu).toMatchObject({ balance_paise: 4_000, last_activity: '2026-10-10', last_payment: '2026-09-12', first_give: '2026-08-01', days_since: 30 });
    expect(by.Bala).toMatchObject({ balance_paise: 4_000, last_payment: null, first_give: '2026-09-02', days_since: 40 });
    expect(by.Zero).toMatchObject({ balance_paise: 0, last_activity: null, days_since: null, has_pending: true });
    expect(by.Devi).toMatchObject({ balance_paise: -3_000, days_since: 0 });
    expect(await repo.totals()).toEqual({ receivable_paise: 8_000, advance_paise: 3_000, customers_owing: 2 });
    expect(z.code).toBe(3);
  });
});
