import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExportFile } from '../../shared/protocol';
import { addDevice, call, customer, entry, ORIGIN, owner, pull, push } from './helpers';

describe('pull', () => {
  it('excludes the caller\'s own rows and returns rows with current content', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const k = customer();
    const g = entry(k.id, 'GIVE', 1000);
    const first = await push(o.token, { customers: [customer()] });
    const pr = await push(o.token, { customers: [k], entries: [g] });
    // own rows are skipped on an incremental pull (since > 0)...
    const mine = await pull(o.token, first.body.results[0]!.seq);
    expect(mine.status).toBe(200);
    expect(mine.body.changes).toEqual([]);
    // ...but not on a full re-pull (since=0: local database rebuilt with the same token)
    const full = await pull(o.token, 0);
    expect(full.body.changes.map((ch) => ch.row.id)).toEqual([first.body.results[0]!.id, k.id, g.id]);
    const theirs = await pull(s.token, first.body.results[0]!.seq);
    expect(theirs.body.changes.map((ch) => [ch.seq, ch.tbl, ch.row.id])).toEqual([
      [pr.body.results[0]!.seq, 'customers', k.id],
      [pr.body.results[1]!.seq, 'entries', g.id],
    ]);
    expect(theirs.body.changes[1]!.row).toMatchObject({ amount_paise: 1000, delta_paise: 1000, device_id: o.device_id });
    expect(theirs.body.shop.id).toBe(o.shop.id);
    expect(theirs.body.devices.map((d) => d.id).sort()).toEqual([o.device_id, s.device_id].sort());
    expect(theirs.body.sync_epoch).toBe(o.sync_epoch);
    expect(theirs.body.has_more).toBe(false);
    expect(theirs.body.next_since).toBe(pr.body.results[1]!.seq);
  });

  it('advances the cursor past own rows when nothing else exists', async () => {
    const o = await owner();
    const k = customer();
    const pr = await push(o.token, { customers: [k], entries: [entry(k.id, 'GIVE', 5), entry(k.id, 'GIVE', 6)] });
    const p = await pull(o.token, pr.body.results[0]!.seq);
    expect(p.body.changes).toEqual([]);
    expect(p.body.has_more).toBe(false);
    expect(p.body.next_since).toBe(pr.body.results[2]!.seq);
    const again = await pull(o.token, p.body.next_since);
    expect(again.body.next_since).toBe(p.body.next_since);
    // and never goes backwards
    const ahead = await pull(o.token, 999);
    expect(ahead.body.next_since).toBe(999);
  });

  it('pages with has_more and next_since', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const k = customer();
    const es = Array.from({ length: 4 }, (_, i) => entry(k.id, 'GIVE', 10 + i));
    await push(o.token, { customers: [k], entries: es });
    // a row of the caller in between is skipped but does not break paging
    await push(s.token, { entries: [entry(k.id, 'GIVE', 99)] });
    await push(o.token, { entries: [entry(k.id, 'GIVE', 77)] });
    const seen: string[] = [];
    let since = 0;
    let pages = 0;
    for (;;) {
      const p = await pull(s.token, since, 2);
      pages++;
      seen.push(...p.body.changes.map((ch) => ch.row.id));
      expect(p.body.changes.length).toBeLessThanOrEqual(2);
      expect(p.body.next_since).toBeGreaterThanOrEqual(since);
      since = p.body.next_since;
      if (!p.body.has_more) break;
    }
    expect(pages).toBe(3);
    expect(seen).toHaveLength(6); // customer + 4 + the last GIVE; staff's own row excluded
    expect(seen[0]).toBe(k.id);
    const maxSeq = (await env.DB.prepare('SELECT MAX(seq) AS m FROM changelog').first<{ m: number }>())!.m;
    expect(since).toBe(maxSeq);
    expect((await pull(s.token, 0, 1000)).status).toBe(200); // limit is clamped
    expect((await pull(s.token, -1 as number)).status).toBe(400);
  });

  it('a fresh device gets the customer before its entries even after a later edit', async () => {
    const o = await owner();
    const k = customer();
    const es = [entry(k.id, 'GIVE', 100), entry(k.id, 'GIVE', 200)];
    await push(o.token, { customers: [k], entries: es });
    await push(o.token, { customers: [{ ...k, name: 'Kamala Devi', updated_at: new Date().toISOString() }] });
    const fresh = await addDevice(o.token, 'owner', 'New phone');
    const p = await pull(fresh.token, 0);
    const order = p.body.changes.map((ch) => ch.tbl);
    expect(order[0]).toBe('customers');
    expect(order.indexOf('entries')).toBeGreaterThan(order.indexOf('customers'));
    // every customer change carries the CURRENT row content
    for (const ch of p.body.changes.filter((x) => x.tbl === 'customers')) expect(ch.row).toMatchObject({ name: 'Kamala Devi' });
    const seqs = p.body.changes.map((ch) => ch.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });
});

describe('push batch failure', () => {
  afterEach(async () => {
    await env.DB.prepare('DROP TRIGGER IF EXISTS test_boom').run();
  });

  it('single-row chunk -> 200 BATCH_FAILED; larger chunk -> 500 batch_failed and nothing stored', async () => {
    const o = await owner();
    const k = customer();
    await push(o.token, { customers: [k] });
    await env.DB.prepare(
      `CREATE TRIGGER test_boom BEFORE INSERT ON entries WHEN NEW.note = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    ).run();
    const one = await push(o.token, { entries: [entry(k.id, 'GIVE', 100, { note: 'boom' })] });
    expect(one.status).toBe(200);
    expect(one.body.results[0]).toMatchObject({ status: 'rejected', reason: 'BATCH_FAILED' });
    const two = await push(o.token, { entries: [entry(k.id, 'GIVE', 100), entry(k.id, 'GIVE', 100, { note: 'boom' })] });
    expect(two.status).toBe(500);
    expect(two.body).toEqual({ error: 'batch_failed' });
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM entries').first<{ n: number }>();
    expect(n?.n).toBe(0);
    const log = await env.DB.prepare('SELECT COUNT(*) AS n FROM changelog').first<{ n: number }>();
    expect(log?.n).toBe(1);
  });
});

describe('export', () => {
  it('is owner-only and streams every row', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    expect((await call('GET', '/export', { token: s.token })).status).toBe(403);
    const ks = Array.from({ length: 3 }, () => customer());
    await push(o.token, { customers: ks, entries: ks.map((k) => entry(k.id, 'GIVE', 100)) });
    await push(s.token, { entries: [entry(ks[0]!.id, 'RECEIVE', 50)] });
    const res = await SELF.fetch(`${ORIGIN}/v1/export`, { headers: { Authorization: `Bearer ${o.token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="kadan-kanakku-\d{4}-\d{2}-\d{2}\.json"$/);
    const file = (await res.json()) as ExportFile;
    expect(file.format).toBe('kadan-kanakku-export');
    expect(file.version).toBe(1);
    expect(file.shop.id).toBe(o.shop.id);
    expect(file.devices).toHaveLength(2);
    expect(file.customers.map((c) => c.id).sort()).toEqual(ks.map((k) => k.id).sort());
    expect(file.entries).toHaveLength(4);
    expect(file.entries.reduce((a, e) => a + e.delta_paise, 0)).toBe(250);
  });

  it('exports an empty shop as valid JSON', async () => {
    const o = await owner();
    const res = await call<ExportFile>('GET', '/export', { token: o.token });
    expect(res.status).toBe(200);
    expect(res.body.customers).toEqual([]);
    expect(res.body.entries).toEqual([]);
  });
});
