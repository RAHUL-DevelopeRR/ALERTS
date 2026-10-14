import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MAX_PUSH_ROWS } from '../../shared/protocol';
import { addDevice, call, customer, entry, istToday, owner, push, reversal, uuid } from './helpers';

const count = async (sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? -1;

describe('push: storing and idempotency', () => {
  it('stores a new customer and first entries in one chunk', async () => {
    const o = await owner();
    const k = customer();
    const e1 = entry(k.id, 'GIVE', 15000);
    const e2 = entry(k.id, 'RECEIVE', 5000, { mode: 'UPI' });
    const r = await push(o.token, { customers: [k], entries: [e1, e2] });
    expect(r.status).toBe(200);
    expect(r.body.sync_epoch).toBe(o.sync_epoch);
    expect(r.body.results.map((x) => [x.tbl, x.id, x.status])).toEqual([
      ['customers', k.id, 'stored'],
      ['entries', e1.id, 'stored'],
      ['entries', e2.id, 'stored'],
    ]);
    const seqs = r.body.results.map((x) => x.seq!);
    expect(seqs[1]).toBe(seqs[0]! + 1);
    expect(seqs[2]).toBe(seqs[0]! + 2);
    const stored = await env.DB.prepare('SELECT * FROM entries WHERE id = ?').bind(e1.id).first<any>();
    expect(stored.device_id).toBe(o.device_id); // server overrides the pushed device_id
    expect(stored.received_at).not.toBeNull();
    const cust = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(k.id).first<any>();
    expect(cust.updated_by).toBe(o.device_id);
    expect(cust.erased_at).toBeNull();
    const log = await env.DB.prepare('SELECT seq, tbl, row_id, device_id FROM changelog ORDER BY seq').all<any>();
    expect(log.results.map((l) => [l.seq, l.row_id])).toEqual(seqs.map((s, i) => [s, r.body.results[i]!.id]));
  });

  it('a resent identical chunk answers already with the SAME seqs', async () => {
    const o = await owner();
    const k = customer();
    const es = [entry(k.id, 'GIVE', 100), entry(k.id, 'GIVE', 200), entry(k.id, 'RECEIVE', 300)];
    const first = await push(o.token, { customers: [k], entries: es });
    const second = await push(o.token, { customers: [k], entries: es });
    expect(second.status).toBe(200);
    expect(second.body.results.every((x) => x.status === 'already')).toBe(true);
    expect(second.body.results.map((x) => x.seq)).toEqual(first.body.results.map((x) => x.seq));
    expect(await count('SELECT COUNT(*) AS n FROM changelog')).toBe(4);
    // partially-new chunk: old rows already, new row stored
    const e4 = entry(k.id, 'GIVE', 400);
    const third = await push(o.token, { entries: [es[0]!, e4] });
    expect(third.body.results.map((x) => x.status)).toEqual(['already', 'stored']);
    expect(third.body.results[0]!.seq).toBe(first.body.results[1]!.seq);
  });

  it('same entry id with different content -> MISMATCH', async () => {
    const o = await owner();
    const k = customer();
    const e = entry(k.id, 'GIVE', 100);
    await push(o.token, { customers: [k], entries: [e] });
    const r = await push(o.token, { entries: [{ ...e, amount_paise: 200, delta_paise: 200 }] });
    expect(r.body.results[0]).toMatchObject({ status: 'rejected', reason: 'MISMATCH' });
    // device_id and received_at are not canonical
    const r2 = await push(o.token, { entries: [{ ...e, device_id: 'other', received_at: 'x' }] });
    expect(r2.body.results[0]!.status).toBe('already');
  });

  it('customer last-write-wins update is accepted with a new seq', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const k = customer();
    const r1 = await push(o.token, { customers: [k] });
    const edited = { ...k, phone: '+919000000001', note: 'blue house', updated_at: '2000-01-01T00:00:00.000Z' };
    const r2 = await push(s.token, { customers: [edited] });
    expect(r2.body.results[0]!.status).toBe('stored');
    expect(r2.body.results[0]!.seq).toBeGreaterThan(r1.body.results[0]!.seq!);
    const row = await env.DB.prepare('SELECT phone, note, updated_by, created_at FROM customers WHERE id = ?').bind(k.id).first<any>();
    // server order wins even though the edit carries an older phone clock
    expect(row).toEqual({ phone: '+919000000001', note: 'blue house', updated_by: s.device_id, created_at: k.created_at });
    // created_at is never rewritten by an update
    await push(o.token, { customers: [{ ...edited, name: 'Kamala Devi', created_at: '1999-01-01T00:00:00.000Z' }] });
    const row2 = await env.DB.prepare('SELECT name, created_at FROM customers WHERE id = ?').bind(k.id).first<any>();
    expect(row2).toEqual({ name: 'Kamala Devi', created_at: k.created_at });
  });

  it('answers 413 above MAX_PUSH_ROWS and 400 for malformed bodies', async () => {
    const o = await owner();
    const k = customer();
    const es = Array.from({ length: MAX_PUSH_ROWS }, () => entry(k.id, 'GIVE', 100));
    const r = await push(o.token, { customers: [k], entries: es });
    expect(r.status).toBe(413);
    expect(r.body.error).toBe('too_many_rows');
    expect((await call('POST', '/sync/push', { token: o.token, rawBody: '{oops', headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
    expect((await call('POST', '/sync/push', { token: o.token, body: { customers: 'x' } })).status).toBe(400);
    expect((await call('POST', '/sync/push', { token: o.token, body: { entries: [null] } })).status).toBe(400);
    const empty = await push(o.token, {});
    expect(empty.status).toBe(200);
    expect(empty.body.results).toEqual([]);
  });
});

describe('push: customer rejections', () => {
  it('CODE_TAKEN from two devices with the same code and different ids (200, never 500)', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const a = customer({ code: 7 });
    const b = customer({ code: 7, name: 'Murugan' });
    const ra = await push(o.token, { customers: [a], entries: [entry(a.id, 'GIVE', 100)] });
    expect(ra.body.results.map((x) => x.status)).toEqual(['stored', 'stored']);
    const eb = entry(b.id, 'GIVE', 500);
    const rb = await push(s.token, { customers: [b], entries: [eb] });
    expect(rb.status).toBe(200);
    expect(rb.body.results[0]).toMatchObject({ status: 'rejected', reason: 'CODE_TAKEN' });
    // a rejected customer and its entry in one chunk: the entry is UNKNOWN_CUSTOMER, not a 500
    expect(rb.body.results[1]).toMatchObject({ status: 'rejected', reason: 'UNKNOWN_CUSTOMER' });
    // client reallocates the code and resends both
    const rc = await push(s.token, { customers: [{ ...b, code: 8 }], entries: [eb] });
    expect(rc.body.results.map((x) => x.status)).toEqual(['stored', 'stored']);
    // two new customers with the same code in ONE chunk
    const c1 = customer({ code: 20 });
    const c2 = customer({ code: 20 });
    const rd = await push(o.token, { customers: [c1, c2] });
    expect(rd.body.results.map((x) => x.reason ?? x.status)).toEqual(['stored', 'CODE_TAKEN']);
  });

  it('BAD_ROW for malformed customers', async () => {
    const o = await owner();
    const bad = [
      customer({ id: 'not-a-uuid' }),
      customer({ name: '   ' }),
      customer({ name: 'x'.repeat(101) }),
      customer({ code: 0 }),
      customer({ code: 1.5 }),
      customer({ phone: '9876543210' }),
      customer({ note: 'n'.repeat(201) }),
      customer({ created_at: 'yesterday' }),
    ];
    const r = await push(o.token, { customers: bad });
    expect(r.status).toBe(200);
    expect(r.body.results.map((x) => x.reason)).toEqual(Array(bad.length).fill('BAD_ROW'));
    expect(r.body.results.map((x) => x.id)).toEqual(bad.map((x) => x.id));
  });

  it('ARCHIVE_NONZERO counts server balance and same-chunk entries', async () => {
    const o = await owner();
    const k = customer();
    await push(o.token, { customers: [k], entries: [entry(k.id, 'GIVE', 1000)] });
    const archived = { ...k, archived_at: new Date().toISOString() };
    const r1 = await push(o.token, { customers: [archived] });
    expect(r1.body.results[0]).toMatchObject({ status: 'rejected', reason: 'ARCHIVE_NONZERO' });
    // a settling payment in the same chunk makes it zero -> accepted
    const pay = entry(k.id, 'RECEIVE', 1000);
    const r2 = await push(o.token, { customers: [archived], entries: [pay] });
    expect(r2.body.results.map((x) => x.status)).toEqual(['stored', 'stored']);
    // archived and zero; a GIVE in the same chunk as a fresh archive of another customer refuses the archive, and the
    // GIVE itself is stored (the customer is on the server, so UNKNOWN_CUSTOMER would only delay it)
    const m = customer();
    await push(o.token, { customers: [m] });
    const r3 = await push(o.token, { customers: [{ ...m, archived_at: new Date().toISOString() }], entries: [entry(m.id, 'GIVE', 50)] });
    expect(r3.body.results[0]).toMatchObject({ status: 'rejected', reason: 'ARCHIVE_NONZERO' });
    expect(r3.body.results[1]).toMatchObject({ status: 'stored' });
    const mRow = await env.DB.prepare('SELECT archived_at FROM customers WHERE id = ?').bind(m.id).first<any>();
    expect(mRow.archived_at).toBeNull();
    // a NEW customer pushed archived with money in the same chunk: refused, and its entries wait (UNKNOWN_CUSTOMER)
    const n = customer({ archived_at: new Date().toISOString() });
    const r4 = await push(o.token, { customers: [n], entries: [entry(n.id, 'GIVE', 70)] });
    expect(r4.body.results.map((x) => x.reason)).toEqual(['ARCHIVE_NONZERO', 'UNKNOWN_CUSTOMER']);
  });

  it('staff archive or unarchive -> FORBIDDEN_ROLE; staff WRITEOFF -> FORBIDDEN_ROLE', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const k = customer();
    await push(o.token, { customers: [k] });
    const r = await push(s.token, { customers: [{ ...k, archived_at: new Date().toISOString() }] });
    expect(r.body.results[0]).toMatchObject({ status: 'rejected', reason: 'FORBIDDEN_ROLE' });
    const archived = { ...k, archived_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    expect((await push(o.token, { customers: [archived] })).body.results[0]!.status).toBe('stored');
    const un = await push(s.token, { customers: [{ ...archived, archived_at: null }] });
    expect(un.body.results[0]).toMatchObject({ status: 'rejected', reason: 'FORBIDDEN_ROLE' });
    // staff may still edit an archived customer's details without touching archived_at
    expect((await push(s.token, { customers: [{ ...archived, note: 'moved' }] })).body.results[0]!.status).toBe('stored');
    const m = customer();
    await push(o.token, { customers: [m], entries: [entry(m.id, 'GIVE', 300)] });
    const wo = await push(s.token, { entries: [entry(m.id, 'WRITEOFF', 300)] });
    expect(wo.body.results[0]).toMatchObject({ status: 'rejected', reason: 'FORBIDDEN_ROLE' });
    expect((await push(o.token, { entries: [entry(m.id, 'WRITEOFF', 300)] })).body.results[0]!.status).toBe('stored');
  });

  it('erase, then a later push of the old details -> ERASED; the erased row is pulled by others', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const k = customer();
    await push(s.token, { customers: [k], entries: [entry(k.id, 'GIVE', 900)] });
    expect((await call('POST', `/customers/${uuid()}/erase`, { token: o.token })).status).toBe(404);
    const er = await call('POST', `/customers/${k.id}/erase`, { token: o.token });
    expect(er.status).toBe(200);
    expect(er.body.customer).toMatchObject({ id: k.id, search_name: null, phone: null, note: null, updated_by: o.device_id });
    expect(er.body.customer.name).toMatch(/^Erased \d{4}-\d{2}-\d{2}$/);
    expect(er.body.customer.erased_at).not.toBeNull();
    const late = await push(s.token, { customers: [{ ...k, name: 'Kamala again', updated_at: new Date().toISOString() }] });
    expect(late.body.results[0]).toMatchObject({ status: 'rejected', reason: 'ERASED' });
    const row = await env.DB.prepare('SELECT name, phone FROM customers WHERE id = ?').bind(k.id).first<any>();
    expect(row).toEqual({ name: er.body.customer.name, phone: null });
    // entries for an erased customer are kept and still accepted
    expect((await push(s.token, { entries: [entry(k.id, 'RECEIVE', 900)] })).body.results[0]!.status).toBe('stored');
    // since=0 also returns staff's own create row; every change carries the CURRENT (erased) content
    const p = await call('GET', '/sync/pull?since=0', { token: s.token });
    const erased = p.body.changes.filter((ch: any) => ch.tbl === 'customers' && ch.row.id === k.id);
    expect(erased).toHaveLength(2);
    for (const ch of erased) expect(ch.row).toMatchObject({ phone: null, name: er.body.customer.name });
    expect(erased[1].row.erased_at).not.toBeNull();
    const inc = await call('GET', `/sync/pull?since=${erased[0].seq}`, { token: s.token });
    expect(inc.body.changes.filter((ch: any) => ch.tbl === 'customers' && ch.row.id === k.id)).toHaveLength(1);
  });
});

describe('push: entry rejections', () => {
  it('UNKNOWN_CUSTOMER when the customer is nowhere', async () => {
    const o = await owner();
    const r = await push(o.token, { entries: [entry(uuid(), 'GIVE', 100)] });
    expect(r.status).toBe(200);
    expect(r.body.results[0]).toMatchObject({ status: 'rejected', reason: 'UNKNOWN_CUSTOMER' });
  });

  it('FUTURE_DATE beyond IST today + 1; tomorrow is allowed', async () => {
    const o = await owner();
    const k = customer();
    const r = await push(o.token, {
      customers: [k],
      entries: [entry(k.id, 'GIVE', 100, { biz_date: istToday(2) }), entry(k.id, 'GIVE', 100, { biz_date: istToday(1) }), entry(k.id, 'GIVE', 100, { biz_date: '2024-02-29' })],
    });
    expect(r.body.results.slice(1).map((x) => x.reason ?? x.status)).toEqual(['FUTURE_DATE', 'stored', 'stored']);
  });

  it('BAD_AMOUNT: float, zero, negative, too large, wrong delta sign', async () => {
    const o = await owner();
    const k = customer();
    await push(o.token, { customers: [k] });
    const bad = [
      entry(k.id, 'GIVE', 10.5),
      entry(k.id, 'GIVE', 0),
      entry(k.id, 'GIVE', -100, { delta_paise: -100 }),
      entry(k.id, 'GIVE', 1e13),
      entry(k.id, 'GIVE', 100, { delta_paise: -100 }),
      entry(k.id, 'RECEIVE', 100, { delta_paise: 100 }),
      entry(k.id, 'WRITEOFF', 100, { delta_paise: 100 }),
      entry(k.id, 'GIVE', '100' as unknown as number),
    ];
    const r = await push(o.token, { entries: bad });
    expect(r.body.results.map((x) => x.reason)).toEqual(Array(bad.length).fill('BAD_AMOUNT'));
    expect(await count('SELECT COUNT(*) AS n FROM entries')).toBe(0);
  });

  it('BAD_ROW: bad dates, kinds, modes and reversal links', async () => {
    const o = await owner();
    const k = customer();
    await push(o.token, { customers: [k] });
    const bad = [
      entry(k.id, 'GIVE', 100, { biz_date: '2026-02-30' }),
      entry(k.id, 'GIVE', 100, { biz_date: '13/10/2026' }),
      entry(k.id, 'LEND' as never, 100),
      entry(k.id, 'GIVE', 100, { mode: 'CASH' }),
      entry(k.id, 'RECEIVE', 100, { mode: 'CHEQUE' as never }),
      entry(k.id, 'GIVE', 100, { reverses_entry_id: uuid() }),
      entry(k.id, 'REVERSAL', 100, { delta_paise: -100, reverses_entry_id: null }),
      entry('nope', 'GIVE', 100),
    ];
    const r = await push(o.token, { entries: bad });
    expect(r.body.results.map((x) => x.reason)).toEqual(Array(bad.length).fill('BAD_ROW'));
  });
});

describe('push: reversals', () => {
  it('ALREADY_REVERSED across devices (200, never 500)', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const k = customer();
    const g = entry(k.id, 'GIVE', 1500);
    await push(o.token, { customers: [k], entries: [g] });
    const r1 = reversal(g);
    expect((await push(o.token, { entries: [r1] })).body.results[0]!.status).toBe('stored');
    const r2 = reversal(g);
    const res = await push(s.token, { entries: [r2] });
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', reason: 'ALREADY_REVERSED' });
    // the first reversal resent answers already, not ALREADY_REVERSED
    expect((await push(o.token, { entries: [r1] })).body.results[0]!.status).toBe('already');
    // two reversals of one original inside one chunk
    const g2 = entry(k.id, 'GIVE', 700);
    const both = await push(o.token, { entries: [g2, reversal(g2), reversal(g2)] });
    expect(both.body.results.map((x) => x.reason ?? x.status)).toEqual(['stored', 'stored', 'ALREADY_REVERSED']);
  });

  it('REVERSAL_OF_REVERSAL', async () => {
    const o = await owner();
    const k = customer();
    const g = entry(k.id, 'GIVE', 1500);
    const rv = reversal(g);
    await push(o.token, { customers: [k], entries: [g, rv] });
    const rr = reversal(rv);
    const res = await push(o.token, { entries: [rr] });
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', reason: 'REVERSAL_OF_REVERSAL' });
  });

  it('REVERSAL_MISMATCH for customer, amount, date, mode or delta', async () => {
    const o = await owner();
    const k = customer();
    const other = customer();
    const pay = entry(k.id, 'RECEIVE', 1000, { mode: 'UPI', biz_date: istToday(-3) });
    await push(o.token, { customers: [k, other], entries: [pay] });
    const variants = [
      reversal(pay, { customer_id: other.id }),
      reversal(pay, { amount_paise: 999, delta_paise: 999 }),
      reversal(pay, { biz_date: istToday() }),
      reversal(pay, { mode: 'CASH' }),
      reversal(pay, { delta_paise: -1000 }),
    ];
    const res = await push(o.token, { entries: variants });
    expect(res.body.results.map((x) => x.reason)).toEqual(Array(variants.length).fill('REVERSAL_MISMATCH'));
    const good = await push(o.token, { entries: [reversal(pay)] });
    expect(good.body.results[0]!.status).toBe('stored');
  });

  it('UNKNOWN_ORIGINAL when the target is nowhere; original earlier in the chunk works', async () => {
    const o = await owner();
    const k = customer();
    await push(o.token, { customers: [k] });
    const g = entry(k.id, 'GIVE', 100);
    const missing = await push(o.token, { entries: [reversal(g)] });
    expect(missing.body.results[0]).toMatchObject({ status: 'rejected', reason: 'UNKNOWN_ORIGINAL' });
    const ok = await push(o.token, { entries: [g, reversal(g)] });
    expect(ok.body.results.map((x) => x.status)).toEqual(['stored', 'stored']);
    const sum = await env.DB.prepare('SELECT SUM(delta_paise) AS s FROM entries WHERE customer_id = ?').bind(k.id).first<{ s: number }>();
    expect(sum?.s).toBe(0);
  });
});

describe('push: un-archive', () => {
  it('20 entries on one archived customer: one un-archive, all stored', async () => {
    const o = await owner();
    const k = customer();
    await push(o.token, { customers: [k] });
    const archivedAt = new Date().toISOString();
    expect((await push(o.token, { customers: [{ ...k, archived_at: archivedAt }] })).body.results[0]!.status).toBe('stored');
    const before = await count('SELECT COUNT(*) AS n FROM changelog');
    const es = Array.from({ length: MAX_PUSH_ROWS }, (_, i) => entry(k.id, 'GIVE', 100 + i));
    const r = await push(o.token, { entries: es });
    expect(r.status).toBe(200);
    expect(r.body.results).toHaveLength(MAX_PUSH_ROWS);
    expect(r.body.results.every((x) => x.status === 'stored' && x.tbl === 'entries')).toBe(true);
    expect(new Set(r.body.results.map((x) => x.seq)).size).toBe(MAX_PUSH_ROWS);
    expect(await count('SELECT COUNT(*) AS n FROM entries WHERE customer_id = ?', k.id)).toBe(MAX_PUSH_ROWS);
    const cust = await env.DB.prepare('SELECT archived_at, updated_by FROM customers WHERE id = ?').bind(k.id).first<any>();
    expect(cust.archived_at).toBeNull();
    // exactly one change-log row for the un-archive, after the 20 entries
    expect(await count('SELECT COUNT(*) AS n FROM changelog') - before).toBe(MAX_PUSH_ROWS + 1);
    const last = await env.DB.prepare('SELECT tbl, row_id FROM changelog ORDER BY seq DESC LIMIT 1').first<any>();
    expect(last).toEqual({ tbl: 'customers', row_id: k.id });
  });

  it('an archive racing an offline GIVE from another phone ends un-archived', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const k = customer();
    await push(o.token, { customers: [k] });
    const ar = await push(o.token, { customers: [{ ...k, archived_at: new Date().toISOString() }] });
    const g = entry(k.id, 'GIVE', 80000);
    expect((await push(s.token, { entries: [g] })).body.results[0]!.status).toBe('stored');
    const row = await env.DB.prepare('SELECT archived_at FROM customers WHERE id = ?').bind(k.id).first<any>();
    expect(row.archived_at).toBeNull();
    const p = await call('GET', `/sync/pull?since=${ar.body.results[0]!.seq}`, { token: o.token });
    const kinds = p.body.changes.map((ch: any) => `${ch.tbl}:${ch.row.id === k.id ? 'K' : 'E'}`);
    expect(kinds).toEqual(['entries:E', 'customers:K']);
    expect(p.body.changes[1].row.archived_at).toBeNull();
  });
});
