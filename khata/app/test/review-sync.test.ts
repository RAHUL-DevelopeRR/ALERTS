/**
 * Adversarial review of src/sync/** + src/data/repo.ts sync paths, end to end: the real Engine and SqlRepo
 * against the in-memory FakeServer. Every finding here is fixed, so these are plain regression tests.
 */
import { describe, it, expect } from 'vitest';
import { FakeServer } from './helpers/fake-server';
import { ledgerView, makePhone, makeWorld, pairPhone, type Phone, type World } from './helpers/sync';
import { UNSYNCED_FILE_PREFIX, type UnsyncedFile } from '../src/sync/engine';
import type { BackupFile } from '../src/data/types';

const ST = '2026-10-12T05:00:05.000Z';

async function give(p: Phone, customerId: string, paise: number) {
  return (await p.repo.addEntry({ customer_id: customerId, kind: 'GIVE', amount_paise: paise })).entry;
}

describe('review sync: rejected original + pending reversal', () => {
  it('two phones agree on the balance after an offline WRITEOFF (+ correction) is refused for a staff pairing', async () => {
    const w = makeWorld();
    const owner = await makePhone(w);
    await pairPhone(w, owner, 'Owner');
    // A second phone used offline first (owner role while unpaired), then paired as staff.
    const helper = await makePhone(w);
    const c = await helper.repo.createCustomer({ name: 'Kamala' });
    const wo = await helper.repo.addEntry({ customer_id: c.id, kind: 'WRITEOFF', amount_paise: 30_000 });
    await helper.repo.reverseEntry(wo.entry.id); // "oops", corrected at once: balance 0 on this phone
    expect(await helper.repo.balance(c.id)).toBe(0);
    await pairPhone(w, helper, 'Helper', 'staff'); // server: WRITEOFF -> FORBIDDEN_ROLE, reversal -> UNKNOWN_ORIGINAL
    await owner.engine.syncNow();
    await helper.engine.syncNow();
    expect(w.server.balance(c.id)).toBe(0);
    expect(await owner.repo.balance(c.id)).toBe(0);
    expect(await helper.repo.balance(c.id)).toBe(0); // today: +30,000 (Kamala "owes" a write-off that never happened)
  });
});

describe('review sync: re-pairing with a different (fresh) server', () => {
  it('re-uploads the whole local ledger, not only rows that were still pending', async () => {
    const w: World = makeWorld();
    const a = await makePhone(w);
    await pairPhone(w, a, 'Owner');
    const c = await a.repo.createCustomer({ name: 'Anbu' });
    await give(a, c.id, 50_000);
    await a.engine.syncNow();
    expect(w.server.balance(c.id)).toBe(50_000);

    // The Cloudflare account is lost; the developer redeploys the Worker on a new, empty D1 (plan:
    // "redeploying elsewhere is a day's work; re-pair"). The owner disconnects and pairs with the new server.
    await a.engine.disconnect();
    const fresh = new FakeServer();
    fresh.clock = w.timers.now;
    fresh.epoch = 'epoch-new-server';
    w.server = fresh;
    await pairPhone(w, a, 'Owner');
    expect(a.engine.status()).toMatchObject({ phase: 'idle', pending: 0 });

    // The new server, and every phone paired with it, must hold the shop's ledger.
    expect(fresh.customers.has(c.id)).toBe(true); // today: false, nothing was re-pushed
    expect(fresh.balance(c.id)).toBe(50_000);
    const b = await makePhone(w);
    await pairPhone(w, b, 'Helper', 'staff');
    expect(await b.repo.balance(c.id)).toBe(50_000);
  });
});

describe('review sync: remote wipe keeps every row that exists nowhere else', () => {
  it('entries under a never-accepted (rejected) customer are saved to the unsynced file before the wipe', async () => {
    const w = makeWorld();
    const p = await makePhone(w);
    await pairPhone(w, p, 'Helper', 'staff');
    const bad = await p.repo.createCustomer({ name: 'Kumar' });
    const e1 = await give(p, bad.id, 12_000);
    const e2 = await give(p, bad.id, 3_000);
    // An earlier push had the customer row refused permanently (e.g. BAD_ROW); its entries wait behind it.
    await p.repo.outboxBatch(20);
    await p.repo.applyPushResults([{ tbl: 'customers', id: bad.id, status: 'rejected', reason: 'BAD_ROW' }], ST);
    // The owner revokes this phone and asks to wipe it.
    const me = (await p.repo.getSettings()).device_id;
    const dev = w.server.devices.get(me)!;
    dev.info.revoked_at = ST;
    dev.wipe = true;
    expect((await p.engine.syncNow()).phase).toBe('revoked');
    expect(await p.repo.getEntry(e1.id)).toBeNull(); // wiped
    const name = [...p.platform.files.keys()].find((k) => k.startsWith(UNSYNCED_FILE_PREFIX));
    expect(name).toBeDefined();
    const file = JSON.parse(p.platform.files.get(name!)!) as UnsyncedFile;
    expect(file.entries.map((e) => e.id).sort()).toEqual([e1.id, e2.id].sort()); // today: [] -> ₹150 lost
  });
});

describe('sync: unsynced file before a remote wipe', () => {
  async function revokeAndRead(w: World, p: Phone): Promise<UnsyncedFile> {
    const me = (await p.repo.getSettings()).device_id;
    const dev = w.server.devices.get(me)!;
    dev.info.revoked_at = ST;
    dev.wipe = true;
    expect((await p.engine.syncNow()).phase).toBe('revoked');
    const name = [...p.platform.files.keys()].find((k) => k.startsWith(UNSYNCED_FILE_PREFIX));
    expect(name).toBeDefined();
    return JSON.parse(p.platform.files.get(name!)!) as UnsyncedFile;
  }

  it('keeps refused entries and their void reversals, leaves out dismissed rows and accepted ones', async () => {
    const w = makeWorld();
    const p = await makePhone(w);
    await pairPhone(w, p, 'Helper', 'staff');
    const ok = await p.repo.createCustomer({ name: 'Anbu' });
    const synced = await give(p, ok.id, 1_000);
    await p.engine.syncNow();
    const refused = await give(p, ok.id, 7_000);
    const dismissedE = await give(p, ok.id, 9_000);
    const pending = await give(p, ok.id, 500);
    const gone = await p.repo.createCustomer({ name: 'Gone' });
    const goneE = await give(p, gone.id, 4_000);
    await p.repo.outboxBatch(50);
    await p.repo.applyPushResults([
      { tbl: 'entries', id: refused.id, status: 'rejected', reason: 'BAD_ROW' },
      { tbl: 'entries', id: dismissedE.id, status: 'rejected', reason: 'BAD_ROW' },
      { tbl: 'customers', id: gone.id, status: 'rejected', reason: 'BAD_ROW' },
    ], ST);
    await p.repo.resolveRejected('entries', dismissedE.id, 'discard');
    await p.repo.resolveRejected('customers', gone.id, 'discard');
    const file = await revokeAndRead(w, p);
    const ids = file.entries.map((e) => e.id);
    expect(ids).toContain(refused.id);
    expect(ids).toContain(pending.id);
    expect(ids).not.toContain(dismissedE.id);
    expect(ids).not.toContain(goneE.id);
    expect(ids).not.toContain(synced.id);
    expect(file.customers.map((c) => c.id)).toEqual([ok.id]);
    expect(await p.repo.getCustomer(ok.id)).toBeNull(); // wiped after the file was written
  });

  it('keeps a reversal voided because its original was refused', async () => {
    const w = makeWorld();
    const p = await makePhone(w);
    const c = await p.repo.createCustomer({ name: 'Kamala' });
    const wo = await p.repo.addEntry({ customer_id: c.id, kind: 'WRITEOFF', amount_paise: 30_000 });
    const rev = await p.repo.reverseEntry(wo.entry.id);
    await pairPhone(w, p, 'Helper', 'staff'); // WRITEOFF -> FORBIDDEN_ROLE, reversal voided
    const file = await revokeAndRead(w, p);
    expect(file.entries.map((e) => e.id).sort()).toEqual([wo.entry.id, rev.reversal.id].sort());
    expect(file.customers.map((x) => x.id)).toEqual([c.id]);
  });
});

describe('review sync: restore while a sync is in flight', () => {
  it('importBackup() during an in-flight pull does not let the stale page move the cursor past rows it wiped', async () => {
    const w = makeWorld();
    let hook: (() => Promise<void>) | null = null;
    const a = await makePhone(w, {
      fetch: async (input, init) => {
        const res = await w.server.fetch(input, init);
        if (hook && String(input).includes('/sync/pull')) {
          const h = hook;
          hook = null;
          await h(); // the user confirms "Restore" while this response is on its way back
        }
        return res;
      },
    });
    const b = await makePhone(w);
    await pairPhone(w, a, 'Owner');
    await pairPhone(w, b, 'Helper', 'staff');
    const y = await a.repo.createCustomer({ name: 'Own customer' });
    const backup: BackupFile = await a.repo.exportBackup(); // yesterday's copy on Drive: only Y
    await a.engine.syncNow();

    const x = await b.repo.createCustomer({ name: 'Kamala' });
    await give(b, x.id, 25_000);
    await b.engine.syncNow();
    await a.engine.syncNow(); // A now holds X + ₹250 (cursor past them)
    expect(await a.repo.balance(x.id)).toBe(25_000);

    await b.repo.updateCustomer(x.id, { note: 'Teacher' }); // a later customer-only change
    await b.engine.syncNow();

    hook = async () => {
      await a.repo.importBackup(backup); // wipes X and its entry, cursor = 0 so a full re-pull brings them back
    };
    await a.engine.syncNow(); // the in-flight page (X's note change) commits after the restore
    await a.engine.syncNow();
    await a.engine.syncNow();
    expect(await a.repo.getCustomer(y.id)).not.toBeNull();
    expect(await a.repo.balance(x.id)).toBe(25_000); // today: 0, the GIVE is never pulled again
    expect(await ledgerView(a.repo)).toEqual(await ledgerView(b.repo));
  });
});

describe('review sync: refused customer update', () => {
  it('an archive refused with ARCHIVE_NONZERO does not leave the two phones disagreeing on the home list', async () => {
    const w = makeWorld();
    const a = await makePhone(w);
    const b = await makePhone(w);
    await pairPhone(w, a, 'Owner');
    await pairPhone(w, b, 'Helper', 'staff');
    const x = await a.repo.createCustomer({ name: 'Kamala' });
    await a.engine.syncNow();
    await b.engine.syncNow();

    await give(b, x.id, 20_000); // helper gives on credit and syncs
    await b.engine.syncNow();
    await a.repo.archiveCustomer(x.id); // owner, not yet synced, sees balance 0 and archives
    await a.engine.syncNow(); // server: ARCHIVE_NONZERO; A keeps archived_at locally (rejected), B does not
    // She pays in full at the helper's phone.
    await b.repo.addEntry({ customer_id: x.id, kind: 'RECEIVE', amount_paise: 20_000, mode: 'CASH' });
    await b.engine.syncNow();
    await a.engine.syncNow();
    expect(await a.repo.balance(x.id)).toBe(0);
    expect(await b.repo.balance(x.id)).toBe(0);
    // Same server state, same home list on both phones.
    expect((await a.repo.listHome()).map((h) => h.id)).toEqual((await b.repo.listHome()).map((h) => h.id));
    expect((await a.repo.getCustomer(x.id))?.archived_at ?? null).toBe(w.server.customers.get(x.id)?.archived_at ?? null);
  });
});
