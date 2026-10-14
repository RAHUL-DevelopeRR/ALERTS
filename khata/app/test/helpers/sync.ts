/**
 * Sync test setup: phones (real SqlRepo on in-memory sql.js + FakePlatform + the real Engine) talking to one
 * FakeServer, all on one FakeTimers clock.
 */
import { openSqlJs } from '../../src/db/sqljs';
import { migrate } from '../../src/db/schema';
import { SqlRepo } from '../../src/data/repo';
import { Engine, type SyncEngineOptions } from '../../src/sync/engine';
import { FakePlatform, FakeServer, FakeTimers } from './fake-server';
import { T0 } from './repo';

export const URL_ = 'https://khata.example.workers.dev';

export interface World {
  server: FakeServer;
  timers: FakeTimers;
}

export function makeWorld(startIso: string = T0): World {
  const timers = new FakeTimers(Date.parse(startIso));
  const server = new FakeServer();
  server.clock = timers.now;
  return { server, timers };
}

export interface Phone {
  repo: SqlRepo;
  platform: FakePlatform;
  engine: Engine;
  fetchCalls: string[];
}

export async function makePhone(w: World, opts: Partial<SyncEngineOptions> = {}): Promise<Phone> {
  const db = await openSqlJs();
  await migrate(db);
  const repo = new SqlRepo(db, { now: () => new Date(w.timers.t) });
  await repo.init();
  const platform = new FakePlatform();
  const fetchCalls: string[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    fetchCalls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return w.server.fetch(input, init);
  };
  const engine = new Engine(repo, platform, {
    fetch: fetchFn,
    now: w.timers.now,
    setTimeout: w.timers.setTimeout,
    clearTimeout: w.timers.clearTimeout,
    random: () => 0.5,
    ...opts,
  });
  return { repo, platform, engine, fetchCalls };
}

/** Pair a phone as owner (or staff) with a freshly minted code; the engine runs its first sync. */
export async function pairPhone(w: World, p: Phone, name: string, role: 'owner' | 'staff' = 'owner'): Promise<void> {
  await p.engine.pair(URL_, w.server.mintCode(role), name);
}

/** Comparable view of a phone's ledger: home rows and per-customer entry ids/amounts (device-independent). */
export async function ledgerView(repo: SqlRepo): Promise<unknown> {
  const home = (await repo.listHome()).map((h) => ({ id: h.id, code: h.code, name: h.name, balance: h.balance_paise, archived: h.archived_at }));
  home.sort((a, b) => a.id.localeCompare(b.id));
  const entries: Record<string, unknown[]> = {};
  for (const h of home) {
    entries[h.id] = (await repo.listEntries(h.id))
      .map((e) => [e.id, e.kind, e.delta_paise, e.biz_date, e.is_reversed, e.sync_state])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  }
  return { home, entries, totals: await repo.totals() };
}

export async function dayBookView(repo: SqlRepo, day: string): Promise<unknown> {
  const d = await repo.dayBook(day);
  return { totals: d.totals, rows: d.rows.map((r) => [r.id, r.kind, r.delta_paise, r.customer_code, r.is_reversed]).sort() };
}
