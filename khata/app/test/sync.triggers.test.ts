/**
 * Engine scheduling: triggers, debounce, interval, backoff, mutex, status notifications.
 */
import { describe, it, expect } from 'vitest';
import type { SyncStatus } from '../src/sync/types';
import { DEBOUNCE_MS, FRESH_MS, IDLE_AFTER_MS, IDLE_INTERVAL_MS, INTERVAL_MS } from '../src/sync';
import { makePhone, makeWorld, pairPhone, type Phone, type World } from './helpers/sync';

const pulls = (p: Phone) => p.fetchCalls.filter((c) => c.includes('/sync/pull')).length;

async function paired(): Promise<{ w: World; p: Phone; cid: string }> {
  const w = makeWorld();
  const p = await makePhone(w);
  await pairPhone(w, p, 'Owner');
  const c = await p.repo.createCustomer({ name: 'Anbu' });
  return { w, p, cid: c.id };
}

/** Advance fake time and wait for any cycle the timers started. */
async function tick(w: World, p: Phone, ms: number): Promise<void> {
  w.timers.advance(ms);
  await p.engine.whenIdle();
}

/** Advance fake time in 10-s steps, letting each poll finish (on a phone they never overlap). */
async function walk(w: World, p: Phone, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 10_000) await tick(w, p, Math.min(10_000, left));
}

describe('triggers', () => {
  it('start() syncs immediately; foreground and network-regained sync; stop() removes everything', async () => {
    const { w, p } = await paired();
    const base = pulls(p);
    p.engine.start();
    await p.engine.whenIdle();
    expect(pulls(p)).toBe(base + 1);
    p.platform.setActive(true);
    await p.engine.whenIdle();
    expect(pulls(p)).toBe(base + 2);
    p.platform.setOnline(true);
    await p.engine.whenIdle();
    expect(pulls(p)).toBe(base + 3);
    p.platform.setOnline(false);
    await p.engine.whenIdle();
    expect(pulls(p)).toBe(base + 3);

    p.engine.stop();
    expect(p.platform.listenerCount()).toBe(0);
    expect(w.timers.pending()).toEqual([]);
    p.platform.setActive(true);
    p.platform.setOnline(true);
    p.engine.notifyLocalWrite();
    await tick(w, p, 24 * 3600_000);
    expect(pulls(p)).toBe(base + 3);
  });

  it('notifyLocalWrite is debounced to 2 s after the last write (a burst goes out in one cycle)', async () => {
    expect(DEBOUNCE_MS).toBe(2_000);
    const { w, p, cid } = await paired();
    p.engine.start();
    await p.engine.whenIdle();
    const base = pulls(p);
    for (let i = 0; i < 3; i++) {
      await p.repo.addEntry({ customer_id: cid, kind: 'GIVE', amount_paise: 100 + i });
      p.engine.notifyLocalWrite();
      await tick(w, p, 1_000);
    }
    expect(pulls(p)).toBe(base);
    await tick(w, p, 999);
    expect(pulls(p)).toBe(base);
    await tick(w, p, 1);
    expect(pulls(p)).toBe(base + 1);
    expect(p.engine.status().pending).toBe(0);
    p.engine.stop();
  });

  it('a save that a later cycle already sent is not sent again 2 s later (no extra request)', async () => {
    const { w, p, cid } = await paired();
    p.engine.start();
    await p.engine.whenIdle();
    const base = p.fetchCalls.length;
    await p.repo.addEntry({ customer_id: cid, kind: 'GIVE', amount_paise: 100 });
    p.engine.notifyLocalWrite();
    await p.engine.syncNow(); // Sync tapped right after the save (or a screen's refreshIfStale)
    const afterTap = p.fetchCalls.length;
    expect(afterTap - base).toBe(2); // push + pull
    expect(p.engine.status().pending).toBe(0);
    await tick(w, p, DEBOUNCE_MS);
    expect(p.fetchCalls.length).toBe(afterTap); // the 2-s timer finds nothing left to send

    // A save made while a cycle runs is still sent by its own timer.
    await p.repo.addEntry({ customer_id: cid, kind: 'GIVE', amount_paise: 200 });
    const running = p.engine.syncNow();
    await p.repo.addEntry({ customer_id: cid, kind: 'GIVE', amount_paise: 300 });
    p.engine.notifyLocalWrite();
    await running;
    await tick(w, p, DEBOUNCE_MS);
    expect(p.engine.status().pending).toBe(0);
    expect(w.server.entries.size).toBe(3);
    p.engine.stop();
  });

  it('notifyLocalWrite refreshes the pending count right away', async () => {
    const { p, cid } = await paired();
    await p.engine.syncNow();
    const seen: number[] = [];
    p.engine.subscribe((s) => seen.push(s.pending));
    await p.repo.addEntry({ customer_id: cid, kind: 'GIVE', amount_paise: 100 });
    p.engine.notifyLocalWrite();
    await p.engine.refreshStatus();
    expect(p.engine.status().pending).toBe(1);
    expect(seen).toContain(1);
  });

  it('looks for other phones\' entries every 20 s while active, not while in the background', async () => {
    expect(INTERVAL_MS).toBe(20_000);
    const { w, p } = await paired();
    p.engine.start();
    await p.engine.whenIdle();
    const base = pulls(p);
    await tick(w, p, INTERVAL_MS);
    expect(pulls(p)).toBe(base + 1);
    await tick(w, p, INTERVAL_MS);
    expect(pulls(p)).toBe(base + 2);
    p.platform.setActive(false);
    await tick(w, p, 60 * 60_000);
    expect(pulls(p)).toBe(base + 2);
    p.platform.setActive(true); // foreground sync + interval re-armed
    await p.engine.whenIdle();
    expect(pulls(p)).toBe(base + 3);
    await tick(w, p, INTERVAL_MS);
    expect(pulls(p)).toBe(base + 4);
    p.engine.stop();
  });

  it('the 20-s poll is quiet (no "Syncing" flash); a write-triggered cycle still shows it', async () => {
    const { w, p, cid } = await paired();
    p.engine.start();
    await p.engine.whenIdle();
    const phases: string[] = [];
    p.engine.subscribe((s) => phases.push(s.phase));
    await tick(w, p, INTERVAL_MS);
    expect(phases).not.toContain('syncing');
    expect(p.engine.status().phase).toBe('idle');
    await p.repo.addEntry({ customer_id: cid, kind: 'GIVE', amount_paise: 500 });
    p.engine.notifyLocalWrite();
    await tick(w, p, DEBOUNCE_MS);
    expect(phases).toContain('syncing');
    p.engine.stop();
  });

  it('refreshIfStale syncs when the last cycle is older than FRESH_MS, not when it is fresh, and never while unpaired', async () => {
    const { w, p } = await paired();
    p.engine.start();
    await p.engine.whenIdle();
    const base = pulls(p);
    p.engine.refreshIfStale();
    await p.engine.whenIdle();
    expect(pulls(p)).toBe(base); // just synced
    await tick(w, p, FRESH_MS);
    p.engine.refreshIfStale();
    await p.engine.whenIdle();
    expect(pulls(p)).toBe(base + 1);
    p.engine.refreshIfStale(60_000);
    await p.engine.whenIdle();
    expect(pulls(p)).toBe(base + 1);
    p.engine.stop();

    const u = await makePhone(makeWorld());
    u.engine.start();
    await u.engine.whenIdle();
    const before = u.fetchCalls.length;
    u.engine.refreshIfStale(0);
    await u.engine.whenIdle();
    expect(u.fetchCalls.length).toBe(before);
    u.engine.stop();
  });

  it('refreshIfStale respects the retry backoff (a dead network is not hammered)', async () => {
    const { w, p } = await paired();
    w.server.fault({ path: /.*/, mode: 'network', times: 1_000 });
    p.engine.start();
    await p.engine.whenIdle();
    const calls = p.fetchCalls.length;
    expect(p.engine.retryAt()).toBeGreaterThan(w.timers.t);
    p.engine.refreshIfStale(0);
    await p.engine.whenIdle();
    expect(p.fetchCalls.length).toBe(calls); // the retry (about 5 s) is still ahead: the screen does not jump it
    p.engine.stop();
  });

  it('onRemoteChange fires after a cycle that brought another phone\'s entries, not after an empty poll', async () => {
    const w = makeWorld();
    const a = await makePhone(w);
    await pairPhone(w, a, 'Counter 1');
    const b = await makePhone(w);
    await pairPhone(w, b, 'Counter 2', 'staff');
    const seen: number[] = [];
    b.engine.onRemoteChange((n) => seen.push(n));
    b.engine.start();
    await b.engine.whenIdle();
    seen.length = 0;
    await w.timers.advance(INTERVAL_MS);
    await b.engine.whenIdle();
    expect(seen).toEqual([]); // nothing new
    const c = await a.repo.createCustomer({ name: 'Ramu' });
    await a.repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 50_000 });
    await a.engine.syncNow();
    await w.timers.advance(INTERVAL_MS);
    await b.engine.whenIdle();
    expect(seen.length).toBe(1);
    expect(seen[0]).toBeGreaterThanOrEqual(2); // the customer and the entry
    expect(await b.repo.balance(c.id)).toBe(50_000);
    b.engine.stop();
  });

  it('slows to a poll a minute after 5 minutes without use; a touch fetches at once and brings 20-s polls back', async () => {
    expect([IDLE_AFTER_MS, IDLE_INTERVAL_MS]).toEqual([5 * 60_000, 60_000]);
    const { w, p } = await paired();
    p.engine.start();
    await p.engine.whenIdle();
    const t0 = pulls(p);
    await walk(w, p, IDLE_AFTER_MS);
    expect(pulls(p)).toBe(t0 + IDLE_AFTER_MS / INTERVAL_MS); // every 20 s while in use
    const base = pulls(p);
    await tick(w, p, IDLE_INTERVAL_MS - 1);
    expect(pulls(p)).toBe(base); // nobody touched the phone: no 20-s polls now
    await tick(w, p, 1);
    expect(pulls(p)).toBe(base + 1); // one a minute
    await tick(w, p, 30_000);
    p.engine.notifyActivity(); // a touch: the last poll is 30 s old, so fetch for the screen being looked at
    await p.engine.whenIdle();
    expect(pulls(p)).toBe(base + 2);
    await tick(w, p, INTERVAL_MS);
    expect(pulls(p)).toBe(base + 3); // 20-s polls again
    p.engine.notifyActivity(); // touches while in use cost nothing
    await p.engine.whenIdle();
    expect(pulls(p)).toBe(base + 3);
    p.engine.stop();
  });

  it('a save, another phone\'s entries and coming back to the app all count as use (20-s polls)', async () => {
    const w = makeWorld();
    const a = await makePhone(w);
    await pairPhone(w, a, 'Counter 1');
    const b = await makePhone(w);
    await pairPhone(w, b, 'Counter 2', 'staff');
    const step = (ms: number): Promise<void> => walk(w, b, ms);
    b.engine.start();
    await b.engine.whenIdle();
    await step(IDLE_AFTER_MS); // idle from here: next poll in a minute
    const base = pulls(b);
    const c = await a.repo.createCustomer({ name: 'Ramu' });
    await a.repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 50_000 });
    await a.engine.syncNow();
    await step(IDLE_INTERVAL_MS);
    expect(pulls(b)).toBe(base + 1);
    expect(await b.repo.balance(c.id)).toBe(50_000); // counter 1's sale, within a minute while idle
    await step(INTERVAL_MS);
    expect(pulls(b)).toBe(base + 2); // the shop is busy: back to every 20 s

    await step(IDLE_AFTER_MS + IDLE_INTERVAL_MS); // quiet again
    const quiet = pulls(b);
    await b.repo.addEntry({ customer_id: c.id, kind: 'RECEIVE', amount_paise: 10_000 });
    b.engine.notifyLocalWrite();
    await step(DEBOUNCE_MS);
    expect(pulls(b)).toBe(quiet + 1); // the save went out after 2 s
    await step(INTERVAL_MS);
    expect(pulls(b)).toBe(quiet + 2); // and 20-s polls are back

    b.platform.setActive(false);
    await step(60 * 60_000);
    b.platform.setActive(true); // opened again after an hour: foreground sync, then every 20 s
    await b.engine.whenIdle();
    const back = pulls(b);
    await step(INTERVAL_MS);
    expect(pulls(b)).toBe(back + 1);
    b.engine.stop();
  });

  it('automatic cycles do not call the server while the OS reports offline; manual syncNow still tries', async () => {
    const { w, p } = await paired();
    p.platform.online = false;
    p.engine.start();
    await p.engine.whenIdle();
    const base = p.fetchCalls.length;
    await tick(w, p, INTERVAL_MS);
    expect(p.fetchCalls.length).toBe(base);
    expect(p.engine.status()).toMatchObject({ phase: 'offline', error: 'network' });
    expect((await p.engine.syncNow()).phase).toBe('idle');
    expect(p.fetchCalls.length).toBeGreaterThan(base);
    p.engine.stop();
  });
});

describe('backoff', () => {
  it('5 s, 30 s, 2 min, 10 min, then hourly; success resets it', async () => {
    const { w, p } = await paired();
    w.server.fault({ path: /.*/, mode: 'network', times: 1_000 });
    p.engine.start();
    await p.engine.whenIdle();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      const d = p.engine.retryAt() - w.timers.t;
      delays.push(d);
      await tick(w, p, d);
    }
    expect(delays).toEqual([5_000, 30_000, 120_000, 600_000, 3_600_000, 3_600_000]);
    expect(p.engine.status()).toMatchObject({ phase: 'offline', error: 'network' });

    w.server.faults = [];
    await tick(w, p, p.engine.retryAt() - w.timers.t);
    expect(p.engine.status()).toMatchObject({ phase: 'idle', error: null });
    expect(p.engine.retryAt()).toBe(0);
    // The next failure starts from 5 s again.
    w.server.fault({ path: '/sync/pull', mode: 'status', status: 503, body: {} });
    await p.engine.syncNow();
    expect(p.engine.status()).toMatchObject({ phase: 'error', error: 'server' });
    expect(p.engine.retryAt() - w.timers.t).toBe(5_000);
    p.engine.stop();
  });

  it('adds +/-20 % jitter', async () => {
    for (const [r, want] of [[0, 4_000], [0.999999, 6_000]] as const) {
      const w = makeWorld();
      const p = await makePhone(w, { random: () => r });
      await pairPhone(w, p, 'Owner');
      w.server.fault({ path: /.*/, mode: 'network', times: 10 });
      await p.engine.syncNow();
      expect(p.engine.retryAt() - w.timers.t).toBe(want);
    }
  });

  it('write/interval triggers wait for the backoff; manual syncNow and network-regained go now', async () => {
    const { w, p, cid } = await paired();
    w.server.fault({ path: /.*/, mode: 'network', times: 1_000 });
    p.engine.start();
    await p.engine.whenIdle();
    await tick(w, p, 5_000); // second failure: next retry in 30 s
    const n = w.server.requests.length;
    await p.repo.addEntry({ customer_id: cid, kind: 'GIVE', amount_paise: 100 });
    p.engine.notifyLocalWrite();
    await tick(w, p, 29_000); // debounce fired at 30 s? no: 29 s; and retry not due
    expect(w.server.requests.length).toBe(n);
    await p.engine.syncNow(); // manual: immediately
    expect(w.server.requests.length).toBe(n + 1);
    p.platform.setOnline(true); // network regained: immediately
    await p.engine.whenIdle();
    expect(w.server.requests.length).toBe(n + 2);
    p.engine.stop();
  });

  it('timers are not armed before start(); syncNow alone never schedules retries', async () => {
    const { w, p } = await paired();
    w.server.fault({ path: /.*/, mode: 'network', times: 10 });
    await p.engine.syncNow();
    expect(p.engine.retryAt()).toBe(w.timers.t + 5_000);
    expect(w.timers.pending()).toEqual([]);
  });
});

describe('mutex and status', () => {
  it('two syncNow calls at once run one cycle; the second awaits it', async () => {
    const { p, cid } = await paired();
    await p.repo.addEntry({ customer_id: cid, kind: 'GIVE', amount_paise: 100 });
    const before = p.fetchCalls.length;
    const [a, b] = await Promise.all([p.engine.syncNow(), p.engine.syncNow()]);
    const calls = p.fetchCalls.slice(before);
    expect(calls.filter((c) => c.includes('/sync/pull')).length).toBe(1);
    expect(calls.filter((c) => c.includes('/sync/push')).length).toBe(1);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ phase: 'idle', pending: 0 });
  });

  it('an automatic trigger during a cycle runs one more cycle afterwards (the run-again flag)', async () => {
    const { w, p, cid } = await paired();
    p.engine.start();
    await p.engine.whenIdle();
    const base = pulls(p);
    await p.repo.addEntry({ customer_id: cid, kind: 'GIVE', amount_paise: 100 });
    // The network-regained trigger fires while this cycle's push is in flight.
    const real = w.server.fetch;
    let fired = false;
    (w.server as { fetch: typeof fetch }).fetch = (input, init) => {
      if (!fired && String(input).includes('/sync/push')) {
        fired = true;
        p.platform.setOnline(true);
      }
      return real(input, init);
    };
    const run = p.engine.syncNow();
    await run;
    await p.engine.whenIdle();
    expect(pulls(p)).toBe(base + 2);
    expect(p.engine.status().pending).toBe(0);
    expect(w.server.entries.size).toBe(1);
    p.engine.stop();
  });

  it('notifies subscribers on every change: syncing -> idle, pending going down, unsubscribe works', async () => {
    const { w, p, cid } = await paired();
    for (let i = 0; i < 25; i++) await p.repo.addEntry({ customer_id: cid, kind: 'GIVE', amount_paise: 100 + i });
    await p.engine.refreshStatus();
    const seen: SyncStatus[] = [];
    const off = p.engine.subscribe((s) => seen.push(s));
    await p.engine.syncNow();
    off();
    expect(seen[0]).toMatchObject({ phase: 'syncing', pending: 26 });
    expect(seen.at(-1)).toMatchObject({ phase: 'idle', pending: 0, error: null, last_sync_at: new Date(w.timers.t).toISOString() });
    const pendings = seen.map((s) => s.pending);
    expect(pendings).toContain(6); // after the first 20-row push
    for (let i = 1; i < pendings.length; i++) expect(pendings[i]).toBeLessThanOrEqual(pendings[i - 1]);
    // consecutive notifications always differ
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toEqual(seen[i - 1]);
    const n = seen.length;
    await p.engine.syncNow();
    expect(seen.length).toBe(n);
  });

  it('a throwing subscriber does not break sync', async () => {
    const { p } = await paired();
    p.engine.subscribe(() => {
      throw new Error('boom');
    });
    expect((await p.engine.syncNow()).phase).toBe('idle');
  });

  it('status survives a restart: last_sync_at and last error come from meta', async () => {
    const { w, p } = await paired();
    w.server.fault({ path: '/sync/pull', mode: 'status', status: 429, body: { error: 'daily_cap' } });
    await p.engine.syncNow();
    const { Engine } = await import('../src/sync/engine');
    const fresh = new Engine(p.repo, p.platform, { fetch: w.server.fetch, now: w.timers.now });
    const s = await fresh.refreshStatus();
    expect(s).toMatchObject({ phase: 'error', error: 'daily_cap' });
    expect(s.last_sync_at).not.toBeNull();
  });
});
