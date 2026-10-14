/**
 * Protocol-conformance review tests. Each `it` asserts the CORRECT behaviour per shared/protocol.ts and the plan;
 * a failing test here demonstrates a finding in the current implementation.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { addDevice, call, customer, entry, istToday, owner, pull, push, reversal } from './helpers';

const balance = async (id: string) =>
  (await env.DB.prepare('SELECT COALESCE(SUM(delta_paise), 0) AS s FROM entries WHERE customer_id = ?').bind(id).first<{ s: number }>())
    ?.s ?? NaN;
const archivedAt = async (id: string) =>
  (await env.DB.prepare('SELECT archived_at FROM customers WHERE id = ?').bind(id).first<{ archived_at: string | null }>())
    ?.archived_at;

describe('review: ARCHIVE_NONZERO must only count entries that are actually accepted', () => {
  it('archive + a same-chunk RECEIVE that is rejected (FUTURE_DATE) must not leave an archived customer owing money', async () => {
    const o = await owner();
    const k = customer();
    await push(o.token, { customers: [k], entries: [entry(k.id, 'GIVE', 10000)] });
    const settle = entry(k.id, 'RECEIVE', 10000, { biz_date: istToday(5) }); // will be FUTURE_DATE
    const r = await push(o.token, { customers: [{ ...k, archived_at: new Date().toISOString() }], entries: [settle] });
    expect(r.status).toBe(200);
    expect(r.body.results.find((x) => x.id === settle.id)).toMatchObject({ status: 'rejected', reason: 'FUTURE_DATE' });
    // The archive was checked against server balance 10000 + chunk -10000 = 0, but the -10000 was refused.
    const cust = r.body.results.find((x) => x.id === k.id);
    const nowArchived = await archivedAt(k.id);
    const bal = await balance(k.id);
    // invariant: never archived with a non-zero balance
    expect({ status: cust?.status, reason: cust?.reason, archived: nowArchived !== null, bal }).toEqual({
      status: 'rejected',
      reason: 'ARCHIVE_NONZERO',
      archived: false,
      bal: 10000,
    });
  });

  it('archive + a same-chunk reversal answered ALREADY_REVERSED (other phone reversed first) must not archive a debtor', async () => {
    const o = await owner();
    const o2 = await addDevice(o.token, 'owner', 'Second owner phone');
    const k = customer();
    const g = entry(k.id, 'GIVE', 10000);
    await push(o.token, { customers: [k], entries: [g] });
    // Phone 2 "corrects" G: reversal + corrected GIVE dated yesterday (server balance: 10000).
    await push(o2.token, { entries: [reversal(g), entry(k.id, 'GIVE', 10000, { biz_date: istToday(-1) })] });
    // Phone 1 (offline view: balance 10000) reverses G and archives.
    const mine = reversal(g);
    const r = await push(o.token, { customers: [{ ...k, archived_at: new Date().toISOString() }], entries: [mine] });
    expect(r.body.results.find((x) => x.id === mine.id)).toMatchObject({ reason: 'ALREADY_REVERSED' });
    expect(await balance(k.id)).toBe(10000);
    expect(await archivedAt(k.id)).toBeNull(); // currently archived: 10000 owed by an archived customer
  });
});

describe('review: server-side un-archive is invisible to the device that caused it', () => {
  it('the pushing device learns about the un-archive (pull or push result) so its next edit is not refused', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const k = customer();
    await push(o.token, { customers: [k] });
    const archived = { ...k, archived_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    await push(o.token, { customers: [archived] });
    // staff pulls and now holds the archived row
    const sp = await pull(s.token, 0);
    expect(sp.body.changes.at(-1)?.row).toMatchObject({ id: k.id });
    // staff GIVE on the archived customer -> server un-archives it
    const g = entry(k.id, 'GIVE', 2500);
    const pr = await push(s.token, { entries: [g] });
    expect(pr.body.results).toHaveLength(1);
    expect(await archivedAt(k.id)).toBeNull();
    // the un-archive change-log row is authored by the staff device, so staff's pull filters it out
    const after = await pull(s.token, sp.body.next_since);
    const sawUnarchive = after.body.changes.some((ch) => ch.tbl === 'customers' && ch.row.id === k.id && ch.row.archived_at === null);
    expect(sawUnarchive).toBe(true);
  });

  // Corrected: the original version renamed from the stale archived copy WITHOUT the pull that follows every push in
  // the sync cycle (and the app already clears archived_at locally when it posts an entry). With the un-archive now
  // logged as 'server', the pull delivers it, and a rename from the pulled row is accepted.
  it('consequence: after its sync cycle (push, then pull) staff renames from the un-archived row and is accepted', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const k = customer();
    await push(o.token, { customers: [k] });
    const archived = { ...k, archived_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    await push(o.token, { customers: [archived] });
    const sp = await pull(s.token, 0);
    await push(s.token, { entries: [entry(k.id, 'GIVE', 2500)] });
    const after = await pull(s.token, sp.body.next_since);
    const local = after.body.changes.find((ch) => ch.tbl === 'customers' && ch.row.id === k.id)?.row as typeof archived;
    expect(local.archived_at).toBeNull();
    const rename = { ...local, name: 'Kamala S', updated_at: new Date().toISOString() };
    const r = await push(s.token, { customers: [rename] });
    expect(r.body.results[0]).toMatchObject({ status: 'stored' });
    expect(r.body.results[0]!.reason).toBeUndefined();
  });
});

describe('review: re-pushed archived customer + money in the same chunk', () => {
  it('an archived customer re-pushed unchanged (already) with a GIVE in the same chunk must not stay archived', async () => {
    const o = await owner();
    const k = customer();
    await push(o.token, { customers: [k] });
    const archived = { ...k, archived_at: new Date().toISOString() };
    await push(o.token, { customers: [archived] });
    const g = entry(k.id, 'GIVE', 4200);
    const r = await push(o.token, { customers: [archived], entries: [g] });
    expect(r.body.results.map((x) => x.status)).toEqual(['already', 'stored']);
    expect(await balance(k.id)).toBe(4200);
    expect(await archivedAt(k.id)).toBeNull();
  });
});

describe('review: UNKNOWN_CUSTOMER means "not on server"', () => {
  it('entries for a customer that IS on the server are accepted even when its update in the same chunk is refused', async () => {
    const o = await owner();
    const k = customer();
    await push(o.token, { customers: [k] });
    // owner erases; a phone with a stale pending rename + a GIVE pushes both
    const er = await call('POST', `/customers/${k.id}/erase`, { token: o.token });
    expect(er.status).toBe(200);
    const g = entry(k.id, 'GIVE', 999);
    const r = await push(o.token, { customers: [{ ...k, name: 'Kamala S', updated_at: new Date().toISOString() }], entries: [g] });
    expect(r.body.results[0]).toMatchObject({ reason: 'ERASED' });
    expect(r.body.results[1]).toMatchObject({ id: g.id, status: 'stored' });
    expect(r.body.results[1]!.reason).toBeUndefined();
  });
});

describe('review: write-batch constraint races must classify, not fail', () => {
  it('two phones pushing different customers with the same code concurrently -> one stored, one CODE_TAKEN (never 500/BATCH_FAILED)', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    let worst: string[] = [];
    for (let i = 0; i < 8; i++) {
      const code = 5000 + i;
      const a = customer({ code });
      const b = customer({ code });
      const [ra, rb] = await Promise.all([
        push(o.token, { customers: [a], entries: [entry(a.id, 'GIVE', 100)] }),
        push(s.token, { customers: [b], entries: [entry(b.id, 'GIVE', 100)] }),
      ]);
      const outcome = [ra, rb].map((r) => (r.status === 200 ? r.body.results[0]!.reason ?? r.body.results[0]!.status : `${r.status}`));
      if (outcome.some((x) => x !== 'stored' && x !== 'CODE_TAKEN')) worst = outcome;
    }
    expect(worst).toEqual([]);
  });

  it('two phones reversing the same entry concurrently (single-row chunks) -> ALREADY_REVERSED, never BATCH_FAILED', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const k = customer();
    await push(o.token, { customers: [k] });
    let worst: string[] = [];
    for (let i = 0; i < 8; i++) {
      const g = entry(k.id, 'GIVE', 100 + i);
      await push(o.token, { entries: [g] });
      const [ra, rb] = await Promise.all([push(o.token, { entries: [reversal(g)] }), push(s.token, { entries: [reversal(g)] })]);
      const outcome = [ra, rb].map((r) => (r.status === 200 ? r.body.results[0]!.reason ?? r.body.results[0]!.status : `${r.status}`));
      if (outcome.some((x) => x !== 'stored' && x !== 'ALREADY_REVERSED')) worst = outcome;
    }
    expect(worst).toEqual([]);
  });
});

describe('review: idempotent resends', () => {
  it('a resent customer whose created_at differs from the stored one is not re-stored with a new seq each time', async () => {
    const o = await owner();
    const k = customer();
    await push(o.token, { customers: [k] });
    const edit = { ...k, name: 'Kamala R', created_at: '2020-01-01T00:00:00.000Z', updated_at: new Date().toISOString() };
    const r1 = await push(o.token, { customers: [edit] });
    const r2 = await push(o.token, { customers: [edit] });
    expect(r1.body.results[0]!.status).toBe('stored');
    expect(r2.body.results[0]).toMatchObject({ status: 'already', seq: r1.body.results[0]!.seq });
  });
});

describe('review: pull own-row filter vs. customers-before-entries', () => {
  it('the authoring device pulling since=0 (local DB rebuilt, same token) never receives an entry whose customer it is not sent', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const k = customer();
    await push(o.token, { customers: [k] });
    await push(s.token, { entries: [entry(k.id, 'GIVE', 100)] });
    const p = await pull(o.token, 0);
    const custIds = new Set(p.body.changes.filter((c) => c.tbl === 'customers').map((c) => c.row.id));
    const orphans = p.body.changes.filter((c) => c.tbl === 'entries' && !custIds.has((c.row as any).customer_id));
    expect(orphans).toEqual([]);
  });
});
