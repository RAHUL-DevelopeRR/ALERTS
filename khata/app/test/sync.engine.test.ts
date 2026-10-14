/**
 * End-to-end sync scenarios: the real SqlRepo (sql.js in memory) + the real Engine against the in-memory
 * FakeServer (test/helpers/fake-server.ts).
 */
import { describe, it, expect } from 'vitest';
import { SyncError } from '../src/sync/types';
import { TOKEN_KEY, UNSYNCED_FILE_PREFIX, type UnsyncedFile } from '../src/sync/engine';
import { URL_, dayBookView, ledgerView, makePhone, makeWorld, pairPhone, type Phone, type World } from './helpers/sync';

async function errCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof SyncError ? e.code : `other:${String(e)}`;
  }
  return 'no-throw';
}

const DAY = '2026-10-12';

function pushSizes(w: World): number[] {
  return w.server.requests
    .filter((r) => r.path === '/sync/push')
    .map((r) => {
      const b = r.body as { customers: unknown[]; entries: unknown[] };
      return b.customers.length + b.entries.length;
    });
}

async function give(p: Phone, customerId: string, rupees: number) {
  return (await p.repo.addEntry({ customer_id: customerId, kind: 'GIVE', amount_paise: rupees * 100 })).entry;
}

describe('unpaired', () => {
  it('never touches the network: syncNow, triggers, timers', async () => {
    const w = makeWorld();
    const p = await makePhone(w);
    const c = await p.repo.createCustomer({ name: 'Anbu' });
    await give(p, c.id, 100);
    p.engine.start();
    p.engine.notifyLocalWrite();
    p.platform.setOnline(true);
    p.platform.setActive(true);
    w.timers.advance(2 * 3600_000);
    await p.engine.whenIdle();
    const s = await p.engine.syncNow();
    expect(s.phase).toBe('unpaired');
    expect(s.error).toBeNull();
    expect(p.fetchCalls).toEqual([]);
    p.engine.stop();
  });

  it('a lost token (Keystore key gone) reads as unpaired, never calls the server and never wipes', async () => {
    const w = makeWorld();
    const p = await makePhone(w);
    await pairPhone(w, p, 'Owner');
    const c = await p.repo.createCustomer({ name: 'Anbu' });
    await give(p, c.id, 50);
    p.platform.secretBroken = true;
    const before = p.fetchCalls.length;
    const s = await p.engine.syncNow();
    expect(s.phase).toBe('unpaired');
    expect(p.fetchCalls.length).toBe(before);
    expect((await p.repo.listHome()).length).toBe(1);
    expect((await p.repo.getSettings()).paired).toBe(true);
  });

  it('owner calls refuse with "unpaired"', async () => {
    const p = await makePhone(makeWorld());
    expect(await errCode(p.engine.createPairCode('staff'))).toBe('unpaired');
    expect(await errCode(p.engine.listDevices())).toBe('unpaired');
  });
});

describe('pairing', () => {
  it('pairs, stores the token, uploads pre-pairing data with its codes, and allocates from the server block', async () => {
    const w = makeWorld();
    const p = await makePhone(w);
    const a = await p.repo.createCustomer({ name: 'Anbu' });
    const b = await p.repo.createCustomer({ name: 'Bala', phone: '9876543210' });
    const c = await p.repo.createCustomer({ name: 'Chitra' });
    const e1 = await give(p, a.id, 250);
    await p.repo.addEntry({ customer_id: b.id, kind: 'RECEIVE', amount_paise: 5000, mode: 'UPI' });
    await p.repo.reverseEntry(e1.id);
    await give(p, c.id, 75);
    expect([a.code, b.code, c.code]).toEqual([1, 2, 3]);

    await pairPhone(w, p, 'Owner phone');

    const pairReq = w.server.requests.find((r) => r.path === '/pair')!;
    expect(pairReq.body).toMatchObject({ device_name: 'Owner phone', max_local_code: 3 });
    expect((pairReq.body as Record<string, unknown>).previous_device_id).toBeUndefined();
    const s = p.engine.status();
    expect(s).toMatchObject({ phase: 'idle', pending: 0, error: null, rejected: 0 });
    expect(s.last_sync_at).toBe(new Date(w.timers.t).toISOString());
    const settings = await p.repo.getSettings();
    expect(settings).toMatchObject({ paired: true, server_url: URL_, role: 'owner', device_name: 'Owner phone' });
    expect(p.platform.secrets.get(TOKEN_KEY)).toMatch(/^tok-/);
    // Server holds exactly the pre-pairing rows, with the phone's codes and the server-assigned device id.
    expect([...w.server.customers.values()].map((x) => [x.name, x.code]).sort()).toEqual([['Anbu', 1], ['Bala', 2], ['Chitra', 3]]);
    expect(w.server.entries.size).toBe(4);
    expect([...w.server.entries.values()].every((e) => e.device_id === settings.device_id)).toBe(true);
    expect(w.server.balance(a.id)).toBe(0);
    expect(w.server.balance(b.id)).toBe(-5000);
    // Next customer comes from the server's block, which starts above max_local_code.
    expect((await p.repo.createCustomer({ name: 'Devi' })).code).toBe(4);
    const local = await p.repo.getEntry(e1.id);
    expect(local).toMatchObject({ sync_state: 'accepted', device_id: settings.device_id });
    expect(local!.server_seq).toBeGreaterThan(0);
  });

  it('normalises the URL and code; maps invalid codes, bad urls and setup errors', async () => {
    const w = makeWorld();
    const p = await makePhone(w);
    const code = w.server.mintCode();
    await p.engine.pair('  khata.example.workers.dev/v1/ ', `${code.slice(0, 4)} ${code.slice(4)}`, '  ');
    expect((await p.repo.getSettings()).server_url).toBe(URL_);
    expect((await p.repo.getSettings()).device_name).toBe('Redmi Note 12'); // default from the platform

    const q = await makePhone(w);
    expect(await errCode(q.engine.pair(URL_, '99999999', 'X'))).toBe('invalid_code');
    expect(await errCode(q.engine.pair(URL_, code, 'X'))).toBe('invalid_code'); // single use
    expect(await errCode(q.engine.pair(URL_, '12', 'X'))).toBe('invalid_code');
    expect(await errCode(q.engine.pair('http://khata.example.workers.dev', w.server.mintCode(), 'X'))).toBe('bad_url');
    expect(await errCode(q.engine.setupAndPair(URL_, 'wrong', 'Shop', 'X'))).toBe('bad_setup_key');
    w.server.setupKey = null;
    expect(await errCode(q.engine.setupAndPair(URL_, 'anything', 'Shop', 'X'))).toBe('setup_disabled');
    w.server.fault({ path: '/pair', mode: 'status', status: 429, body: { error: 'throttled' } });
    expect(await errCode(q.engine.pair(URL_, w.server.mintCode(), 'X'))).toBe('throttled');
    w.server.fault({ path: '/pair', mode: 'network' });
    expect(await errCode(q.engine.pair(URL_, w.server.mintCode(), 'X'))).toBe('network');
    expect((await q.repo.getSettings()).paired).toBe(false);
    expect(q.platform.secrets.size).toBe(0);
  });

  it('setupAndPair creates the shop and pairs as owner', async () => {
    const w = makeWorld();
    const p = await makePhone(w);
    await p.engine.setupAndPair(URL_, 'setup-secret', 'Kumar Stores', 'Owner phone');
    const s = await p.repo.getSettings();
    expect(s).toMatchObject({ paired: true, role: 'owner', shop_name: 'Kumar Stores' });
    expect(p.engine.status().phase).toBe('idle');
  });

  it('re-pairing after a lost token sends previous_device_id so the server revokes the ghost', async () => {
    const w = makeWorld();
    const p = await makePhone(w);
    await pairPhone(w, p, 'Owner');
    const oldId = (await p.repo.getSettings()).device_id;
    p.platform.secrets.clear();
    expect((await p.engine.syncNow()).phase).toBe('unpaired');
    await pairPhone(w, p, 'Owner');
    const pairs = w.server.requests.filter((r) => r.path === '/pair');
    expect((pairs[1].body as Record<string, unknown>).previous_device_id).toBe(oldId);
    expect(w.server.devices.get(oldId)!.info.revoked_at).not.toBeNull();
    expect((await p.repo.getSettings()).device_id).not.toBe(oldId);
  });
});

describe('two phones', () => {
  it('converge: A writes, B pulls; B writes, A pulls; identical balances and day books', async () => {
    const w = makeWorld();
    const A = await makePhone(w);
    const B = await makePhone(w);
    await pairPhone(w, A, 'Owner');
    const k = await A.repo.createCustomer({ name: 'கமலா', phone: '9876543210' });
    const m = await A.repo.createCustomer({ name: 'Murugan' });
    await give(A, k.id, 500);
    await give(A, m.id, 120);
    await A.repo.addEntry({ customer_id: k.id, kind: 'RECEIVE', amount_paise: 20_000, mode: 'CASH' });
    await A.engine.syncNow();

    const code = await A.engine.createPairCode('staff');
    await B.engine.pair(URL_, code.code, 'Counter phone');
    expect((await B.repo.getSettings()).role).toBe('staff');
    expect(await ledgerView(B.repo)).toEqual(await ledgerView(A.repo));

    const be = await give(B, k.id, 330);
    await B.repo.addEntry({ customer_id: m.id, kind: 'RECEIVE', amount_paise: 12_000, mode: 'UPI' });
    await B.repo.reverseEntry(be.id);
    const n = await B.repo.createCustomer({ name: 'Nila' });
    await give(B, n.id, 40);
    await B.engine.syncNow();
    await A.engine.syncNow();

    expect(await ledgerView(A.repo)).toEqual(await ledgerView(B.repo));
    expect(await dayBookView(A.repo, DAY)).toEqual(await dayBookView(B.repo, DAY));
    expect(await A.repo.balance(k.id)).toBe(50_000 - 20_000);
    expect(await A.repo.balance(m.id)).toBe(0);
    expect(n.code).toBeGreaterThan(m.code);
    // A sees who wrote B's rows.
    const rows = await A.repo.listEntries(n.id);
    expect(rows[0].device_name).toBe('Counter phone');
    expect(A.engine.status().pending).toBe(0);
    expect(B.engine.status().pending).toBe(0);
  });
});

describe('failures and retries', () => {
  it('offline then online: the outbox drains with no duplicates', async () => {
    const w = makeWorld();
    const p = await makePhone(w);
    await pairPhone(w, p, 'Owner');
    const c = await p.repo.createCustomer({ name: 'Anbu' });
    for (let i = 1; i <= 5; i++) await give(p, c.id, i);
    w.server.fault({ path: /.*/, mode: 'network', times: 1000 });
    p.engine.start();
    await p.engine.whenIdle();
    expect(p.engine.status()).toMatchObject({ phase: 'offline', error: 'network', pending: 6 });
    expect(await p.repo.getMeta('last_sync_error')).toBe('network');

    w.server.faults = [];
    p.platform.setOnline(true);
    await p.engine.whenIdle();
    expect(p.engine.status()).toMatchObject({ phase: 'idle', error: null, pending: 0 });
    expect(w.server.entries.size).toBe(5);
    expect(w.server.log.filter((l) => l.tbl === 'entries').length).toBe(5);
    expect(await p.repo.getMeta('last_sync_error')).toBeNull();
    p.engine.stop();
  });

  it('response lost after the server committed: the retry gets "already" with the same seqs', async () => {
    const w = makeWorld();
    const p = await makePhone(w);
    await pairPhone(w, p, 'Owner');
    const c = await p.repo.createCustomer({ name: 'Anbu' });
    const e1 = await give(p, c.id, 10);
    const e2 = await give(p, c.id, 20);
    w.server.fault({ path: '/sync/push', mode: 'drop-response' });
    const s1 = await p.engine.syncNow();
    expect(s1).toMatchObject({ phase: 'offline', error: 'network', pending: 3 });
    expect(w.server.entries.size).toBe(2); // committed on the server
    const seqs = new Map(w.server.log.map((l) => [l.row_id, l.seq]));
    const logLen = w.server.log.length;

    const s2 = await p.engine.syncNow();
    expect(s2).toMatchObject({ phase: 'idle', pending: 0 });
    const replay = w.server.requests.filter((r) => r.path === '/sync/push').at(-1)!;
    expect(replay.status).toBe(200);
    expect(w.server.log.length).toBe(logLen); // nothing re-stored
    expect(w.server.entries.size).toBe(2);
    expect((await p.repo.getEntry(e1.id))!.server_seq).toBe(seqs.get(e1.id));
    expect((await p.repo.getEntry(e2.id))!.server_seq).toBe(seqs.get(e2.id));
    expect((await p.repo.getCustomer(c.id))!.server_seq).toBe(seqs.get(c.id));
    expect(await p.repo.balance(c.id)).toBe(3000);
  });

  it('chunks 45 rows into 3 pushes (20 + 20 + 5)', async () => {
    const w = makeWorld();
    const p = await makePhone(w);
    const c = await p.repo.createCustomer({ name: 'Anbu' });
    for (let i = 1; i <= 44; i++) await give(p, c.id, i);
    await pairPhone(w, p, 'Owner');
    expect(pushSizes(w)).toEqual([20, 20, 5]);
    expect(w.server.entries.size).toBe(44);
    expect(p.engine.status().pending).toBe(0);
  });

  it('413 and 500 batch_failed halve the chunk for the rest of the cycle', async () => {
    const w = makeWorld();
    const p = await makePhone(w);
    const c = await p.repo.createCustomer({ name: 'Anbu' });
    for (let i = 1; i <= 44; i++) await give(p, c.id, i);
    w.server.fault({ path: '/sync/push', mode: 'status', status: 413, body: { error: 'too_many_rows' } });
    await pairPhone(w, p, 'Owner');
    expect(pushSizes(w)).toEqual([20, 10, 10, 10, 10, 5]);
    expect(w.server.entries.size).toBe(44);

    const before = w.server.requests.length;
    for (let i = 1; i <= 12; i++) await give(p, c.id, 100 + i);
    w.server.fault({ path: '/sync/push', mode: 'status', status: 500, body: { error: 'batch_failed' }, times: 2 });
    await p.engine.syncNow();
    const sizes = w.server.requests.slice(before).filter((r) => r.path === '/sync/push')
      .map((r) => (r.body as { entries: unknown[] }).entries.length);
    expect(sizes).toEqual([12, 10, 5, 5, 2]);
    expect(p.engine.status()).toMatchObject({ phase: 'idle', pending: 0 });
    expect(w.server.entries.size).toBe(56);
  });

  it('a plain 500 is a server error with backoff, not a halving', async () => {
    const w = makeWorld();
    const p = await makePhone(w);
    await pairPhone(w, p, 'Owner');
    const c = await p.repo.createCustomer({ name: 'Anbu' });
    await give(p, c.id, 5);
    w.server.fault({ path: '/sync/push', mode: 'status', status: 500, body: { error: 'internal' } });
    const s = await p.engine.syncNow();
    expect(s).toMatchObject({ phase: 'error', error: 'server', pending: 2 });
    expect(p.engine.retryAt()).toBe(w.timers.t + 5_000);
    expect((await p.engine.syncNow()).phase).toBe('idle');
    expect(p.engine.retryAt()).toBe(0);
  });

  it('daily cap (429) is an error with backoff; the local ledger is untouched', async () => {
    const w = makeWorld();
    const p = await makePhone(w);
    await pairPhone(w, p, 'Owner');
    const c = await p.repo.createCustomer({ name: 'Anbu' });
    await give(p, c.id, 5);
    w.server.fault({ path: '/sync/push', mode: 'status', status: 429, body: { error: 'daily_cap' } });
    expect(await p.engine.syncNow()).toMatchObject({ phase: 'error', error: 'daily_cap', pending: 2 });
    expect(await p.repo.balance(c.id)).toBe(500);
  });
});

describe('conflicts', () => {
  it('CODE_TAKEN: two phones used the same code offline; the second reallocates and is accepted next round', async () => {
    const w = makeWorld();
    const A = await makePhone(w);
    const B = await makePhone(w);
    const anbu = await A.repo.createCustomer({ name: 'Anbu' });
    const bala = await B.repo.createCustomer({ name: 'Bala' });
    await give(B, bala.id, 90);
    expect([anbu.code, bala.code]).toEqual([1, 1]);
    await pairPhone(w, A, 'Owner');
    await B.engine.pair(URL_, await A.engine.createPairCode('staff').then((r) => r.code), 'Counter');

    const bId = (await B.repo.getSettings()).device_id;
    const reasons = w.server.requests.filter((r) => r.path === '/sync/push' && r.device_id === bId).length;
    expect(reasons).toBe(2); // CODE_TAKEN round, then accepted with the new code
    const balaNow = (await B.repo.getCustomer(bala.id))!;
    expect(balaNow.code).not.toBe(1);
    expect(balaNow.sync_state).toBe('accepted');
    expect(w.server.customers.get(bala.id)!.code).toBe(balaNow.code);
    expect(w.server.balance(bala.id)).toBe(9000);
    expect(B.engine.status()).toMatchObject({ phase: 'idle', pending: 0, rejected: 0 });
    await A.engine.syncNow();
    expect(await ledgerView(A.repo)).toEqual(await ledgerView(B.repo));
  });

  it('cross-device double reversal: one counted reversal on both phones, nothing in Needs attention', async () => {
    const w = makeWorld();
    const A = await makePhone(w);
    const B = await makePhone(w);
    await pairPhone(w, A, 'Owner');
    const c = await A.repo.createCustomer({ name: 'Anbu' });
    const e = await give(A, c.id, 300);
    await give(A, c.id, 50);
    await A.engine.syncNow();
    await B.engine.pair(URL_, (await A.engine.createPairCode('owner')).code, 'Second');

    const ra = await A.repo.reverseEntry(e.id);
    const rb = await B.repo.reverseEntry(e.id);
    expect(ra.balance_paise).toBe(5000);
    expect(rb.balance_paise).toBe(5000);
    await A.engine.syncNow();
    await B.engine.syncNow();
    await A.engine.syncNow();

    for (const p of [A, B]) {
      expect(await p.repo.balance(c.id)).toBe(5000);
      const rows = await p.repo.listEntries(c.id);
      expect(rows.filter((r) => r.kind === 'REVERSAL').map((r) => r.id)).toEqual([ra.reversal.id]);
      expect(await p.repo.needsAttention()).toEqual([]);
      expect(p.engine.status()).toMatchObject({ pending: 0, rejected: 0 });
    }
    expect((await B.repo.getEntry(rb.reversal.id))!).toMatchObject({ sync_state: 'rejected', reject_reason: 'ALREADY_REVERSED' });
    expect([...w.server.entries.values()].filter((x) => x.kind === 'REVERSAL').length).toBe(1);
    expect(await ledgerView(A.repo)).toEqual(await ledgerView(B.repo));
  });

  it('permanent rejection shows in Needs attention and does not block the rest', async () => {
    const w = makeWorld();
    const p = await makePhone(w);
    await pairPhone(w, p, 'Owner');
    const c = await p.repo.createCustomer({ name: 'Anbu' });
    const good = await give(p, c.id, 10);
    // A row the server refuses (pretend the phone clock was far ahead when it was written).
    w.server.clock = () => w.timers.t - 3 * 86_400_000;
    await p.engine.syncNow();
    expect(w.server.entries.has(good.id)).toBe(false);
    expect(p.engine.status()).toMatchObject({ phase: 'idle', rejected: 1, pending: 0 });
    expect((await p.repo.needsAttention())[0]).toMatchObject({ tbl: 'entries', id: good.id, reason: 'FUTURE_DATE' });
    expect(await p.repo.balance(c.id)).toBe(0);
  });
});

describe('epoch change (server restored)', () => {
  it('re-pushes everything automatically, pulls from 0, and both phones end identical', async () => {
    const w = makeWorld();
    const A = await makePhone(w);
    const B = await makePhone(w);
    await pairPhone(w, A, 'Owner');
    await B.engine.pair(URL_, (await A.engine.createPairCode('staff')).code, 'Counter');
    const c = await A.repo.createCustomer({ name: 'Anbu' });
    await give(A, c.id, 10);
    await A.engine.syncNow();
    await B.engine.syncNow();
    const snap = w.server.snapshot();

    // Work after the restore point that the restored server will not have.
    const d = await A.repo.createCustomer({ name: 'Devi' });
    await give(A, d.id, 20);
    await give(B, c.id, 30);
    await A.engine.syncNow();
    await B.engine.syncNow();
    await A.engine.syncNow();
    expect(w.server.entries.size).toBe(3);

    w.server.restore(snap, 'epoch-2');
    expect(w.server.entries.size).toBe(1);
    await give(A, c.id, 40); // an ordinary offline write on top
    const aId = (await A.repo.getSettings()).device_id;
    const mark = w.server.requests.length;
    await A.engine.syncNow();
    // The push response already carries the new epoch: re-queue and re-push before the first pull.
    const paths = w.server.requests.slice(mark).filter((r) => r.device_id === aId).map((r) => r.path);
    expect(paths.filter((x) => x === '/sync/pull').length).toBe(1);
    expect(paths.indexOf('/sync/pull')).toBeGreaterThan(1);
    expect(await A.repo.getMeta('sync_epoch')).toBe('epoch-2');
    await B.engine.syncNow();
    await A.engine.syncNow();

    expect(w.server.entries.size).toBe(4);
    expect(w.server.customers.size).toBe(2);
    expect(await ledgerView(A.repo)).toEqual(await ledgerView(B.repo));
    expect(await A.repo.balance(c.id)).toBe(8000);
    expect(A.engine.status()).toMatchObject({ phase: 'idle', pending: 0 });
    expect(B.engine.status()).toMatchObject({ phase: 'idle', pending: 0 });
    // Nothing was duplicated on the server.
    const ids = w.server.log.filter((l) => l.tbl === 'entries').map((l) => l.row_id);
    expect(new Set(ids).size).toBe(4);
  });
});

describe('revoke', () => {
  async function setup() {
    const w = makeWorld();
    const A = await makePhone(w);
    const B = await makePhone(w);
    await pairPhone(w, A, 'Owner');
    const c = await A.repo.createCustomer({ name: 'Anbu' });
    await give(A, c.id, 100);
    await A.engine.syncNow();
    await B.engine.pair(URL_, (await A.engine.createPairCode('staff')).code, 'Counter');
    const bId = (await B.repo.getSettings()).device_id;
    // B writes but has not synced yet.
    const e = await give(B, c.id, 77);
    const n = await B.repo.createCustomer({ name: 'Nila' });
    const ne = await give(B, n.id, 5);
    return { w, A, B, bId, c, e, n, ne };
  }

  it('with wipe: pending rows saved to a private file first, then local data wiped and pairing forgotten', async () => {
    const { A, B, bId, c, e, n, ne } = await setup();
    await A.engine.revokeDevice(bId, true);
    const s = await B.engine.syncNow();
    expect(s).toMatchObject({ phase: 'revoked', error: 'revoked' });
    expect(B.platform.secrets.has(TOKEN_KEY)).toBe(false);
    const settings = await B.repo.getSettings();
    expect(settings.paired).toBe(false);
    expect(settings.device_id.startsWith('local-')).toBe(true);
    expect(await B.repo.listHome()).toEqual([]);

    const files = await B.platform.listPrivateFiles(UNSYNCED_FILE_PREFIX);
    expect(files.length).toBe(1);
    const saved = JSON.parse(B.platform.files.get(files[0])!) as UnsyncedFile;
    expect(saved.unsynced).toBe(true);
    expect(saved.entries.map((x) => x.id).sort()).toEqual([e.id, ne.id].sort());
    expect(saved.customers.map((x) => x.id).sort()).toEqual([c.id, n.id].sort());

    // Stays revoked, and quiet, until paired again.
    const calls = B.fetchCalls.length;
    expect((await B.engine.syncNow()).phase).toBe('revoked');
    expect(B.fetchCalls.length).toBe(calls);
  });

  it('without wipe: the ledger and outbox stay, no file is written', async () => {
    const { A, B, bId, c } = await setup();
    await A.engine.revokeDevice(bId, false);
    expect((await B.engine.syncNow()).phase).toBe('revoked');
    expect(B.platform.files.size).toBe(0);
    expect(await B.repo.balance(c.id)).toBe(17_700);
    expect(await B.repo.pendingCount()).toBe(3);
    expect((await B.repo.getSettings()).paired).toBe(false);
  });

  it('wipe is skipped (data kept) if the unsynced rows cannot be saved', async () => {
    const { A, B, bId, c } = await setup();
    B.platform.writePrivateFile = async () => {
      throw new Error('disk full');
    };
    await A.engine.revokeDevice(bId, true);
    expect((await B.engine.syncNow()).phase).toBe('revoked');
    expect(await B.repo.balance(c.id)).toBe(17_700);
  });

  it('a 401 on an owner call also revokes and rethrows', async () => {
    const w = makeWorld();
    const A = await makePhone(w);
    const B = await makePhone(w);
    await pairPhone(w, A, 'Owner');
    await B.engine.pair(URL_, (await A.engine.createPairCode('owner')).code, 'Second');
    await B.engine.revokeDevice((await A.repo.getSettings()).device_id, false);
    expect(await errCode(A.engine.listDevices())).toBe('revoked');
    expect(A.engine.status().phase).toBe('revoked');
    expect((await A.repo.getSettings()).paired).toBe(false);
  });
});

describe('owner calls', () => {
  it('pair codes, devices, recovery codes, shop update, erase, export; staff is forbidden', async () => {
    const w = makeWorld();
    const A = await makePhone(w);
    const B = await makePhone(w);
    await pairPhone(w, A, 'Owner');
    const c = await A.repo.createCustomer({ name: 'Kamala', phone: '9876543210', note: 'near temple' });
    await give(A, c.id, 60);
    await A.engine.syncNow();
    await B.engine.pair(URL_, (await A.engine.createPairCode('staff')).code, 'Counter');

    const devices = await A.engine.listDevices();
    expect(devices.map((d) => [d.name, d.role])).toEqual([['Owner', 'owner'], ['Counter', 'staff']]);
    const codes = await A.engine.createRecoveryCodes(3);
    expect(codes.length).toBe(3);
    const shop = await A.engine.updateShop({ name: 'Murugan Stores', upi_id: 'murugan@upi', lang: 'en' });
    expect(shop).toMatchObject({ name: 'Murugan Stores', upi_id: 'murugan@upi', lang: 'en' });

    expect(await errCode(B.engine.createPairCode('staff'))).toBe('forbidden');
    expect(await errCode(B.engine.listDevices())).toBe('forbidden');
    expect(B.engine.status().phase).not.toBe('revoked');

    await A.engine.eraseCustomer(c.id);
    const erased = (await A.repo.getCustomer(c.id))!;
    expect(erased.erased_at).not.toBeNull();
    expect(erased.phone).toBeNull();
    expect(erased.name.startsWith('Erased')).toBe(true);
    await B.engine.syncNow();
    const onB = (await B.repo.getCustomer(c.id))!;
    expect(onB.erased_at).not.toBeNull();
    expect(onB.note).toBeNull();
    expect(await B.repo.balance(c.id)).toBe(6000); // money is kept
    expect((await B.repo.getSettings()).shop_name).toBe('Murugan Stores');

    const exported = JSON.parse(await A.engine.downloadServerExport()) as { format: string; entries: unknown[] };
    expect(exported.format).toBe('kadan-kanakku-export');
    expect(exported.entries.length).toBe(1);

    const recovered = await makePhone(w);
    await recovered.engine.pair(URL_, codes[0].toLowerCase(), 'Replacement');
    expect((await recovered.repo.getSettings()).role).toBe('owner');
    expect(await ledgerView(recovered.repo)).toEqual(await ledgerView(A.repo));
  });

  it('disconnect forgets the server but keeps the ledger', async () => {
    const w = makeWorld();
    const p = await makePhone(w);
    await pairPhone(w, p, 'Owner');
    const c = await p.repo.createCustomer({ name: 'Anbu' });
    await give(p, c.id, 5);
    await p.engine.disconnect();
    expect(p.engine.status().phase).toBe('unpaired');
    expect(p.platform.secrets.size).toBe(0);
    expect(await p.repo.balance(c.id)).toBe(500);
    const calls = p.fetchCalls.length;
    await p.engine.syncNow();
    expect(p.fetchCalls.length).toBe(calls);
  });
});

describe('codes and clock', () => {
  it('requests a new code block when fewer than 10 codes are left', async () => {
    const w = makeWorld();
    const p = await makePhone(w);
    await pairPhone(w, p, 'Owner'); // block 1..50
    expect(await p.repo.codesRemaining()).toBe(50);
    expect(w.server.requests.some((r) => r.path === '/devices/code-block')).toBe(false);
    await p.repo.setMeta('code_next', '45');
    await p.engine.syncNow();
    const req = w.server.requests.filter((r) => r.path === '/devices/code-block');
    expect(req.length).toBe(1);
    expect(await p.repo.codesRemaining()).toBe(56);
  });

  it('tracks clock skew; stores an offset only beyond 10 minutes', async () => {
    const w = makeWorld();
    const p = await makePhone(w);
    await pairPhone(w, p, 'Owner');
    w.server.clock = () => w.timers.t + 5_000;
    expect((await p.engine.syncNow()).clock_skew_ms).toBe(5_000);
    expect(Number(await p.repo.getMeta('clock_offset_ms')) || 0).toBe(0);
    w.server.clock = () => w.timers.t - 3_600_000;
    expect((await p.engine.syncNow()).clock_skew_ms).toBe(3_600_000);
    expect(await p.repo.getMeta('clock_offset_ms')).toBe('-3600000');
    expect((await p.repo.getSettings()).clock_offset_ms).toBe(-3_600_000);
    w.server.clock = w.timers.now;
    await p.engine.syncNow();
    expect(await p.repo.getMeta('clock_offset_ms')).toBe('0');
  });
});
