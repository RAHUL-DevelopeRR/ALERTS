import { describe, it, expect } from 'vitest';
import { makeRepo, pair } from './helpers/repo';
import { RepoError, type BackupFile } from '../src/data/types';
import { validateBackup } from '../src/data/repo';

async function seed() {
  const t = await makeRepo();
  const { repo, clock } = t;
  await repo.saveSettings({ shop_name: 'Murugan Stores' });
  const a = await repo.createCustomer({ name: 'முருகன்', phone: '9876543210', note: '3rd street' });
  const b = await repo.createCustomer({ name: 'Bala' });
  await repo.addEntry({ customer_id: a.id, kind: 'GIVE', amount_paise: 150_000, biz_date: '2026-10-01' });
  clock.advance(1000);
  const wrong = await repo.addEntry({ customer_id: a.id, kind: 'GIVE', amount_paise: 99_900 });
  clock.advance(1000);
  await repo.reverseEntry(wrong.entry.id);
  await repo.addEntry({ customer_id: a.id, kind: 'RECEIVE', amount_paise: 50_000, mode: 'UPI' });
  await repo.addEntry({ customer_id: b.id, kind: 'GIVE', amount_paise: 1_234 });
  const rejected = await repo.addEntry({ customer_id: b.id, kind: 'GIVE', amount_paise: 777 });
  await repo.applyPushResults([{ tbl: 'entries', id: rejected.entry.id, status: 'rejected', reason: 'FUTURE_DATE' }], clock.iso());
  return { ...t, a, b };
}

describe('backup', () => {
  it('export -> import round trip keeps the ledger and this phone’s identity', async () => {
    const src = await seed();
    const file = await src.repo.exportBackup();
    expect(file).toMatchObject({ format: 'kadan-kanakku-backup', version: 1, shop_name: 'Murugan Stores' });
    expect(file.customers.length).toBe(2);
    expect(file.entries.length).toBe(5); // the rejected entry is not carried
    const json = JSON.parse(JSON.stringify(file)) as BackupFile;

    const dst = await makeRepo();
    const before = await dst.repo.getSettings();
    await dst.repo.saveSettings({ shop_name: 'Keep me', lang: 'en' });
    const old = await dst.repo.createCustomer({ name: 'Will be replaced' });
    expect(await dst.repo.importBackup(json)).toEqual({ customers: 2, entries: 5 });
    expect(await dst.repo.getCustomer(old.id)).toBeNull();
    const after = await dst.repo.getSettings();
    expect([after.device_id, after.shop_name, after.lang]).toEqual([before.device_id, 'Keep me', 'en']);

    const strip = (rows: { id: string; balance_paise: number; name: string; days_since: number | null }[]) =>
      rows.map((r) => [r.id, r.name, r.balance_paise, r.days_since]);
    expect(strip(await dst.repo.listHome())).toEqual(strip(await src.repo.listHome()));
    for (const c of [src.a, src.b]) {
      const x = (await src.repo.listEntries(c.id)).map((e) => [e.id, e.running_paise, e.is_reversed, e.delta_paise]);
      const y = (await dst.repo.listEntries(c.id)).map((e) => [e.id, e.running_paise, e.is_reversed, e.delta_paise]);
      expect(y).toEqual(x);
    }
    expect(await dst.repo.getCustomer(src.a.id)).toMatchObject({ name: 'முருகன்', search_name: 'murukan', phone: '+919876543210', sync_state: 'pending', server_seq: null });
    expect(await dst.repo.pendingCount()).toBe(7);
    expect(await dst.repo.getMeta('cursor')).toBe('0');
    // export of the import is the same ledger
    const again = await dst.repo.exportBackup();
    expect(again.customers).toEqual(file.customers.map((c) => ({ ...c, received_at: null })));
    expect(again.entries).toEqual(file.entries.map((e) => ({ ...e, received_at: null })));
    // codes continue above the imported ones while unpaired
    expect((await dst.repo.createCustomer({ name: 'New' })).code).toBe(3);
  });

  it('import while paired keeps pairing and queues everything', async () => {
    const src = await seed();
    const file = await src.repo.exportBackup();
    const dst = await makeRepo();
    await pair(dst.repo);
    await dst.repo.setMeta('cursor', '500');
    await dst.repo.importBackup(file);
    const s = await dst.repo.getSettings();
    expect([s.paired, s.device_id]).toEqual([true, 'dev-me']);
    expect(await dst.repo.getMeta('cursor')).toBe('0');
    const batch = await dst.repo.outboxBatch(20);
    expect(batch.customers.length).toBe(2);
    expect(batch.entries.length).toBe(5);
    const ids = batch.entries.map((e) => e.id);
    const rev = batch.entries.find((e) => e.kind === 'REVERSAL')!;
    expect(ids.indexOf(rev.reverses_entry_id!)).toBeLessThan(ids.indexOf(rev.id));
  });

  it('BAD_BACKUP on any problem, and nothing is changed', async () => {
    const src = await seed();
    const good = JSON.parse(JSON.stringify(await src.repo.exportBackup())) as BackupFile;
    const dst = await makeRepo();
    const keep = await dst.repo.createCustomer({ name: 'Keep' });
    const mutate = (fn: (f: BackupFile) => void): BackupFile => {
      const f = JSON.parse(JSON.stringify(good)) as BackupFile;
      fn(f);
      return f;
    };
    const rev = good.entries.findIndex((e) => e.kind === 'REVERSAL');
    const cases: [string, BackupFile][] = [
      ['format', mutate((f) => { (f as { format: string }).format = 'other'; })],
      ['version', mutate((f) => { (f as { version: number }).version = 2; })],
      ['customer uuid', mutate((f) => { f.customers[0].id = 'not-a-uuid'; })],
      ['dup customer', mutate((f) => { f.customers[1].id = f.customers[0].id; })],
      ['empty name', mutate((f) => { f.customers[0].name = ' '; })],
      ['code', mutate((f) => { f.customers[0].code = 0; })],
      ['kind', mutate((f) => { (f.entries[0] as { kind: string }).kind = 'LOAN'; })],
      ['amount', mutate((f) => { f.entries[0].amount_paise = 12.5; })],
      ['delta sign', mutate((f) => { f.entries[0].delta_paise = -f.entries[0].delta_paise; })],
      ['missing customer', mutate((f) => { f.entries[0].customer_id = '00000000-0000-4000-8000-000000000000'; })],
      ['date', mutate((f) => { f.entries[0].biz_date = '2026-02-30'; })],
      ['mode', mutate((f) => { (f.entries[0] as { mode: string }).mode = 'GPAY'; })],
      ['reversal target missing', mutate((f) => { f.entries[rev].reverses_entry_id = '00000000-0000-4000-8000-000000000001'; })],
      ['reversal mismatch', mutate((f) => { f.entries[rev].delta_paise = 1; })],
      ['double reversal', mutate((f) => { f.entries.push({ ...f.entries[rev], id: '00000000-0000-4000-8000-000000000002' }); })],
      ['not an object', null as unknown as BackupFile],
    ];
    for (const [label, f] of cases) {
      let codeSeen = '';
      try {
        await dst.repo.importBackup(f);
      } catch (e) {
        codeSeen = e instanceof RepoError ? e.code : String(e);
      }
      expect(codeSeen, label).toBe('BAD_BACKUP');
    }
    expect((await dst.repo.listHome()).map((h) => h.id)).toEqual([keep.id]);
    expect(validateBackup(good).entries.length).toBe(5);
  });

  it('snapshotIfDue: once per 20 hours', async () => {
    const { repo, clock } = await seed();
    const first = await repo.snapshotIfDue();
    expect(first?.format).toBe('kadan-kanakku-backup');
    expect(await repo.getMeta('last_snapshot_at')).toBe(clock.iso());
    clock.advance(19 * 3600_000);
    expect(await repo.snapshotIfDue()).toBeNull();
    clock.advance(2 * 3600_000);
    expect((await repo.snapshotIfDue())?.entries.length).toBe(5);
    // an erasure forces the next snapshot so old copies are rotated out sooner
    expect(await repo.snapshotIfDue()).toBeNull();
    const c = await repo.createCustomer({ name: 'Gone' });
    await repo.applyErasure(c.id);
    expect(await repo.snapshotIfDue()).not.toBeNull();
  });
});
