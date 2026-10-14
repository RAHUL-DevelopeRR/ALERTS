import { describe, it, expect } from 'vitest';
import { makeRepo, pair, page, serverCustomer, serverEntry, device, SHOP, T0 } from './helpers/repo';
import type { Change } from '../../shared/protocol';

const ST = '2026-10-12T05:00:05.000Z';

describe('outbox', () => {
  it('outboxBatch: current content, customers first, dedup, entry order, limit', async () => {
    const { repo, clock } = await makeRepo();
    const a = await repo.createCustomer({ name: 'Anbu' });
    const e1 = await repo.addEntry({ customer_id: a.id, kind: 'GIVE', amount_paise: 1_000 });
    clock.advance(1000);
    await repo.updateCustomer(a.id, { name: 'Anbu Selvan', phone: '9876543210' });
    const b = await repo.createCustomer({ name: 'Bala' });
    const e2 = await repo.addEntry({ customer_id: b.id, kind: 'RECEIVE', amount_paise: 500, mode: 'CASH' });
    clock.advance(1000);
    const r1 = await repo.reverseEntry(e1.entry.id);
    expect(await repo.pendingCount()).toBe(5);
    const batch = await repo.outboxBatch(20);
    expect(batch.customers.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(batch.customers[0]).toEqual({
      id: a.id, code: 1, name: 'Anbu Selvan', search_name: null, phone: '+919876543210', note: null, archived_at: null,
      erased_at: null, created_at: a.created_at, updated_at: '2026-10-12T05:00:01.000Z', updated_by: a.updated_by,
      received_at: null,
    });
    expect(batch.entries.map((e) => e.id)).toEqual([e1.entry.id, e2.entry.id, r1.reversal.id]);
    expect(Object.keys(batch.entries[0]).sort()).toEqual([
      'amount_paise', 'biz_date', 'created_at', 'customer_id', 'delta_paise', 'device_id', 'id', 'kind', 'mode', 'note',
      'received_at', 'reverses_entry_id',
    ]);
    const small = await repo.outboxBatch(3);
    expect([small.customers.length, small.entries.map((e) => e.id)]).toEqual([2, [e1.entry.id]]);
    const one = await repo.outboxBatch(1);
    expect([one.customers.length, one.entries.length]).toEqual([1, 0]);
    expect(await repo.outboxBatch(0)).toEqual({ customers: [], entries: [] });
  });

  it('skips entries of a never-accepted rejected customer without blocking others', async () => {
    const { repo } = await makeRepo();
    const bad = await repo.createCustomer({ name: 'Bad' });
    const ok = await repo.createCustomer({ name: 'Ok' });
    const eb = await repo.addEntry({ customer_id: bad.id, kind: 'GIVE', amount_paise: 100 });
    const eo = await repo.addEntry({ customer_id: ok.id, kind: 'GIVE', amount_paise: 200 });
    await repo.applyPushResults([
      { tbl: 'customers', id: bad.id, status: 'rejected', reason: 'BAD_ROW' },
      { tbl: 'customers', id: ok.id, status: 'stored', seq: 1 },
    ], ST);
    const batch = await repo.outboxBatch(20);
    expect(batch.customers).toEqual([]);
    expect(batch.entries.map((e) => e.id)).toEqual([eo.entry.id]);
    expect(await repo.pendingCount()).toBe(1);
    // the rejected customer is hidden from home/totals but listed for attention
    expect((await repo.listHome()).map((h) => h.id)).toEqual([ok.id]);
    expect((await repo.totals()).receivable_paise).toBe(200);
    expect((await repo.needsAttention()).map((i) => [i.tbl, i.id, i.reason, i.summary])).toEqual([['customers', bad.id, 'BAD_ROW', 'Bad (C-0001)']]);
    // fixing the customer re-queues it and unblocks its entries
    await repo.updateCustomer(bad.id, { name: 'Fixed' });
    const again = await repo.outboxBatch(20);
    expect(again.customers.map((c) => c.name)).toEqual(['Fixed']);
    expect(again.entries.map((e) => e.id).sort()).toEqual([eb.entry.id, eo.entry.id].sort());
  });
});

describe('applyPushResults', () => {
  it('stored / already -> accepted with seq and received_at, outbox emptied', async () => {
    const { repo, db } = await makeRepo();
    const c = await repo.createCustomer({ name: 'K' });
    const e = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 100 });
    await repo.updateCustomer(c.id, { note: 'n' }); // second outbox row for the same customer
    await repo.outboxBatch(20);
    const res = await repo.applyPushResults([
      { tbl: 'customers', id: c.id, status: 'stored', seq: 7 },
      { tbl: 'entries', id: e.entry.id, status: 'already', seq: 8 },
      { tbl: 'entries', id: 'unknown-id', status: 'stored', seq: 9 },
    ], ST);
    expect(res).toEqual({ accepted: 2, rejected: 0, retry: 0 });
    expect(await repo.getCustomer(c.id)).toMatchObject({ sync_state: 'accepted', server_seq: 7, received_at: ST });
    expect(await repo.getEntry(e.entry.id)).toMatchObject({ sync_state: 'accepted', server_seq: 8, received_at: ST });
    expect((await db.query('SELECT * FROM outbox')).length).toBe(0);
    expect(await repo.pendingCount()).toBe(0);
    expect((await repo.listHome())[0].has_pending).toBe(false);
  });

  it('an edit made while the push was in flight stays queued', async () => {
    const { repo } = await makeRepo();
    const c = await repo.createCustomer({ name: 'K' });
    const batch = await repo.outboxBatch(20);
    expect(batch.customers[0].name).toBe('K');
    await repo.updateCustomer(c.id, { name: 'K2' });
    await repo.applyPushResults([{ tbl: 'customers', id: c.id, status: 'stored', seq: 3 }], ST);
    expect(await repo.getCustomer(c.id)).toMatchObject({ sync_state: 'pending', server_seq: 3 });
    expect((await repo.outboxBatch(20)).customers.map((x) => x.name)).toEqual(['K2']);
  });

  it('CODE_TAKEN reallocates the code (same UUID) and keeps it queued; other retriables count attempts', async () => {
    const { repo, db } = await makeRepo();
    await pair(repo, { code_block: { start: 101, end: 150 } });
    const c = await repo.createCustomer({ name: 'K' });
    expect(c.code).toBe(101);
    const e = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 100 });
    const res = await repo.applyPushResults([
      { tbl: 'customers', id: c.id, status: 'rejected', reason: 'CODE_TAKEN' },
      { tbl: 'entries', id: e.entry.id, status: 'rejected', reason: 'UNKNOWN_CUSTOMER' },
    ], ST);
    expect(res).toEqual({ accepted: 0, rejected: 0, retry: 2 });
    const after = await repo.getCustomer(c.id);
    expect(after).toMatchObject({ id: c.id, code: 102, sync_state: 'pending' });
    const ob = await db.query<{ tbl: string; attempts: number; last_error: string }>('SELECT tbl, attempts, last_error FROM outbox ORDER BY n');
    expect(ob).toEqual([
      { tbl: 'customers', attempts: 1, last_error: 'CODE_TAKEN' },
      { tbl: 'entries', attempts: 1, last_error: 'UNKNOWN_CUSTOMER' },
    ]);
    expect((await repo.outboxBatch(20)).customers[0].code).toBe(102);
  });

  it('ALREADY_REVERSED hides the duplicate reversal (not in needsAttention); permanent reasons are listed', async () => {
    const { repo, db } = await makeRepo();
    const c = await repo.createCustomer({ name: 'K' });
    const g = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 1_000 });
    const r = await repo.reverseEntry(g.entry.id);
    const w = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 300 });
    const res = await repo.applyPushResults([
      { tbl: 'customers', id: c.id, status: 'stored', seq: 1 },
      { tbl: 'entries', id: g.entry.id, status: 'stored', seq: 2 },
      { tbl: 'entries', id: r.reversal.id, status: 'rejected', reason: 'ALREADY_REVERSED' },
      { tbl: 'entries', id: w.entry.id, status: 'rejected', reason: 'MISMATCH' },
    ], ST);
    expect(res).toEqual({ accepted: 2, rejected: 2, retry: 0 });
    expect(await repo.getEntry(r.reversal.id)).toMatchObject({ sync_state: 'rejected', reject_reason: 'ALREADY_REVERSED' });
    expect(await repo.balance(c.id)).toBe(1_000); // the duplicate reversal no longer counts
    const na = await repo.needsAttention();
    expect(na.map((i) => [i.id, i.reason])).toEqual([[w.entry.id, 'MISMATCH']]);
    expect((await db.query('SELECT * FROM outbox')).length).toBe(0);
    // the original is reversible again from this phone's point of view only via the other phone's reversal
    expect((await repo.listEntries(c.id)).find((e) => e.id === g.entry.id)!.is_reversed).toBe(false);
  });
});

describe('applyPullPage', () => {
  it('inserts server rows, keeps a pending local edit, replaces devices/shop, advances cursor', async () => {
    const { repo } = await makeRepo();
    await pair(repo);
    const mine = await repo.createCustomer({ name: 'Local edit' });
    await repo.applyPushResults([{ tbl: 'customers', id: mine.id, status: 'stored', seq: 5 }], ST);
    await repo.updateCustomer(mine.id, { note: 'my newer note' }); // pending outbox edit
    const other = serverCustomer({ code: 900, name: 'Remote' });
    const e = serverEntry(other.id, { amount_paise: 7_000, delta_paise: 7_000 });
    const changes: Change[] = [
      { seq: 10, tbl: 'customers', row: other },
      { seq: 11, tbl: 'customers', row: { ...serverCustomer({ id: mine.id, code: mine.code, name: 'Server version' }) } },
      { seq: 12, tbl: 'entries', row: e },
    ];
    await repo.applyPullPage(page(changes, { next_since: 15, devices: [device('dev-other', 'Helper phone'), device('dev-me', 'Owner phone', 'owner')], shop: { ...SHOP, name: 'New name', lang: 'en' } }));
    expect(await repo.getCustomer(other.id)).toMatchObject({ name: 'Remote', sync_state: 'accepted', server_seq: 10 });
    expect(await repo.getCustomer(mine.id)).toMatchObject({ name: 'Local edit', note: 'my newer note', sync_state: 'pending' });
    expect(await repo.getEntry(e.id)).toMatchObject({ sync_state: 'accepted', server_seq: 12, amount_paise: 7_000 });
    expect(await repo.getMeta('cursor')).toBe('15');
    const s = await repo.getSettings();
    expect([s.shop_name, s.lang, s.upi_id]).toEqual(['New name', 'en', 'murugan@upi']);
    const view = await repo.listEntries(other.id);
    expect(view[0].device_name).toBe('Helper phone');
    expect((await repo.dayBook('2026-10-12')).rows[0].device_name).toBe('Helper phone');
    // the same page again is idempotent
    await repo.applyPullPage(page(changes, { next_since: 15 }));
    expect((await repo.listEntries(other.id)).length).toBe(1);
    expect(await repo.balance(other.id)).toBe(7_000);
    // with no pending edit, the server row wins
    await repo.outboxBatch(20);
    await repo.applyPushResults([{ tbl: 'customers', id: mine.id, status: 'stored', seq: 16 }], ST);
    await repo.applyPullPage(page([{ seq: 20, tbl: 'customers', row: serverCustomer({ id: mine.id, code: mine.code, name: 'Renamed on helper' }) }]));
    expect(await repo.getCustomer(mine.id)).toMatchObject({ name: 'Renamed on helper', sync_state: 'accepted', server_seq: 20 });
    expect(await repo.getMeta('cursor')).toBe('20');
  });

  it('a server row with erased_at wins over a pending local edit and drops it', async () => {
    const { repo, db } = await makeRepo();
    await pair(repo);
    const c = await repo.createCustomer({ name: 'Kamala', phone: '9876543210' });
    await repo.updateCustomer(c.id, { note: 'stale' });
    await repo.applyPullPage(page([{ seq: 30, tbl: 'customers', row: serverCustomer({ id: c.id, code: c.code, name: 'Erased 2026-10-12', erased_at: T0 }) }]));
    expect(await repo.getCustomer(c.id)).toMatchObject({ name: 'Erased 2026-10-12', phone: null, note: null, sync_state: 'accepted' });
    expect((await db.query(`SELECT * FROM outbox WHERE tbl = 'customers'`)).length).toBe(0);
  });

  it('a page that fails midway applies nothing (cursor unchanged)', async () => {
    const { repo } = await makeRepo();
    await pair(repo);
    const good = serverCustomer({ name: 'Good' });
    const orphan = serverEntry('00000000-0000-4000-8000-000000000000'); // FK violation
    await expect(repo.applyPullPage(page([
      { seq: 40, tbl: 'customers', row: good },
      { seq: 41, tbl: 'entries', row: serverEntry(good.id) },
      { seq: 42, tbl: 'entries', row: orphan },
    ], { shop: { ...SHOP, name: 'Should not apply' } }))).rejects.toThrow();
    expect(await repo.getCustomer(good.id)).toBeNull();
    expect(await repo.getMeta('cursor')).toBe('0');
    expect((await repo.getSettings()).shop_name).toBe('Murugan Stores');
  });

  it('a pulled reversal hides this phone’s unsent duplicate reversal of the same entry', async () => {
    const { repo } = await makeRepo();
    await pair(repo);
    const c = serverCustomer();
    const g = serverEntry(c.id, { amount_paise: 1_000, delta_paise: 1_000 });
    await repo.applyPullPage(page([{ seq: 1, tbl: 'customers', row: c }, { seq: 2, tbl: 'entries', row: g }]));
    const mine = await repo.reverseEntry(g.id);
    const theirs = serverEntry(c.id, { kind: 'REVERSAL', amount_paise: 1_000, delta_paise: -1_000, reverses_entry_id: g.id });
    await repo.applyPullPage(page([{ seq: 3, tbl: 'entries', row: theirs }]));
    expect(await repo.getEntry(mine.reversal.id)).toMatchObject({ sync_state: 'rejected', reject_reason: 'ALREADY_REVERSED' });
    expect(await repo.balance(c.id)).toBe(0);
    expect(await repo.pendingCount()).toBe(0);
    expect(await repo.needsAttention()).toEqual([]);
  });
});

describe('epoch change, pairing, unpairing', () => {
  it('handleEpochChange requeues everything in a valid order', async () => {
    const { repo, db, clock } = await makeRepo();
    await pair(repo);
    // remote customer + entry, where the remote phone's reversal has an EARLIER created_at than its original
    const rc = serverCustomer({ created_at: '2026-10-10T00:00:00.000Z' });
    const orig = serverEntry(rc.id, { created_at: '2026-10-12T04:00:00.000Z' });
    const rev = serverEntry(rc.id, { kind: 'REVERSAL', delta_paise: -orig.delta_paise, reverses_entry_id: orig.id, created_at: '2026-10-12T03:00:00.000Z' });
    await repo.applyPullPage(page([
      { seq: 1, tbl: 'customers', row: rc }, { seq: 2, tbl: 'entries', row: orig }, { seq: 3, tbl: 'entries', row: rev },
    ]));
    const c = await repo.createCustomer({ name: 'Local' });
    clock.advance(1000);
    const e = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 100 });
    const dupe = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 50 });
    const dupeRev = await repo.reverseEntry(dupe.entry.id);
    await repo.outboxBatch(20);
    await repo.applyPushResults([
      { tbl: 'customers', id: c.id, status: 'stored', seq: 4 },
      { tbl: 'entries', id: e.entry.id, status: 'stored', seq: 5 },
      { tbl: 'entries', id: dupe.entry.id, status: 'stored', seq: 6 },
      { tbl: 'entries', id: dupeRev.reversal.id, status: 'rejected', reason: 'ALREADY_REVERSED' },
    ], ST);
    expect(await repo.pendingCount()).toBe(0);
    await repo.handleEpochChange('epoch-2');
    expect(await repo.getMeta('sync_epoch')).toBe('epoch-2');
    expect(await repo.getMeta('cursor')).toBe('0');
    const ob = await db.query<{ tbl: string; row_id: string }>('SELECT tbl, row_id FROM outbox ORDER BY n');
    expect(ob.map((o) => o.tbl)).toEqual(['customers', 'customers', 'entries', 'entries', 'entries', 'entries']);
    expect(ob.slice(0, 2).map((o) => o.row_id)).toEqual([rc.id, c.id]);
    const ids = ob.map((o) => o.row_id);
    expect(ids.indexOf(orig.id)).toBeLessThan(ids.indexOf(rev.id));
    expect(ids).not.toContain(dupeRev.reversal.id);
    const states = await db.query<{ k: number }>(`SELECT COUNT(*) AS k FROM entries WHERE sync_state = 'pending' AND server_seq IS NULL`);
    expect(states[0].k).toBe(4);
    expect(await repo.getEntry(dupeRev.reversal.id)).toMatchObject({ sync_state: 'rejected', reject_reason: 'ALREADY_REVERSED' });
    expect(await repo.requeueEverything()).toBe(6);
    expect(await repo.pendingCount()).toBe(6);
  });

  it('completePairing rewrites provisional device ids and installs the code block', async () => {
    const { repo, db } = await makeRepo();
    const local = (await repo.getSettings()).device_id;
    const c = await repo.createCustomer({ name: 'Before pairing' });
    const e = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 100 });
    expect(e.entry.device_id).toBe(local);
    await db.run('DELETE FROM outbox'); // even rows that somehow lost their outbox row get queued again
    await repo.setMeta('cursor', '99');
    await pair(repo, { device_id: 'dev-123', role: 'owner', code_block: { start: 51, end: 100 } });
    expect(await repo.getEntry(e.entry.id)).toMatchObject({ device_id: 'dev-123' });
    expect(await repo.getCustomer(c.id)).toMatchObject({ updated_by: 'dev-123' });
    const s = await repo.getSettings();
    expect(s).toMatchObject({ paired: true, device_id: 'dev-123', device_name: 'Owner phone', role: 'owner', shop_name: 'Murugan Stores', upi_id: 'murugan@upi', server_url: 'https://khata.example.workers.dev' });
    expect(await repo.getMeta('cursor')).toBe('0');
    expect(await repo.getMeta('sync_epoch')).toBe('epoch-1');
    expect(await repo.codesRemaining()).toBe(50);
    expect((await repo.createCustomer({ name: 'After' })).code).toBe(51);
    expect(await repo.pendingCount()).toBe(3);
    expect(await repo.maxLocalCode()).toBe(51);
    // listEntries: own device -> null device_name
    expect((await repo.listEntries(c.id))[0].device_name).toBeNull();
  });

  it('unpair keeps or wipes local data; setDevices', async () => {
    const { repo, db } = await makeRepo();
    await pair(repo, { role: 'staff' });
    await repo.setDevices([device('a', 'A'), device('b', 'B', 'owner')]);
    expect((await db.query('SELECT * FROM devices')).length).toBe(2);
    const c = await repo.createCustomer({ name: 'K' });
    await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 100 });
    await repo.unpair(false);
    let s = await repo.getSettings();
    expect(s).toMatchObject({ paired: false, role: 'owner', server_url: null });
    expect(s.device_id).toMatch(/^local-/);
    expect(await repo.balance(c.id)).toBe(100);
    expect((await repo.createCustomer({ name: 'Next' })).code).toBe(102);
    await pair(repo);
    await repo.unpair(true);
    s = await repo.getSettings();
    expect(s.paired).toBe(false);
    expect(await repo.listHome()).toEqual([]);
    expect((await db.query('SELECT * FROM outbox')).length).toBe(0);
    expect((await db.query('SELECT * FROM devices')).length).toBe(0);
    expect((await repo.createCustomer({ name: 'Fresh' })).code).toBe(1);
  });
});
