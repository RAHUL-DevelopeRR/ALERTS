/**
 * Shared test setup: an in-memory sql.js database, migrated, with a SqlRepo on a controllable clock.
 * Used by test/repo*.test.ts and available to test/sync*.test.ts.
 */
import { openSqlJs } from '../../src/db/sqljs';
import { migrate } from '../../src/db/schema';
import type { Db, DbExec } from '../../src/db/db';
import { SqlRepo } from '../../src/data/repo';
import type { PullResponse, CustomerRow, EntryRow, DeviceInfo, ShopInfo, Change } from '../../../shared/protocol';
import { uuid } from '../../src/core/ledger';

export const T0 = '2026-10-12T05:00:00.000Z'; // 10:30 IST, Monday 12 Oct 2026

export class TestClock {
  private t: number;
  constructor(iso: string = T0) {
    this.t = Date.parse(iso);
  }
  now = (): Date => new Date(this.t);
  set(iso: string): void {
    this.t = Date.parse(iso);
  }
  advance(ms: number): void {
    this.t += ms;
  }
  iso(): string {
    return new Date(this.t).toISOString();
  }
}

export interface TestRepo {
  db: Db;
  repo: SqlRepo;
  clock: TestClock;
}

/** Fresh migrated in-memory DB + initialised repo. */
export async function makeRepo(startIso: string = T0): Promise<TestRepo> {
  const db = await openSqlJs();
  await migrate(db);
  const clock = new TestClock(startIso);
  const repo = new SqlRepo(db, { now: clock.now });
  await repo.init();
  return { db, repo, clock };
}

/** A Db wrapper whose transactions throw when a statement matches `failOn` (to prove atomicity). */
export function failingDb(db: Db, failOn: RegExp): Db {
  const wrapTx = (tx: DbExec): DbExec => ({
    run: (sql, params) => (failOn.test(sql) ? Promise.reject(new Error(`injected failure: ${sql.slice(0, 40)}`)) : tx.run(sql, params)),
    query: (sql, params) => tx.query(sql, params),
  });
  return {
    run: (sql, params) => db.run(sql, params),
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction((tx) => fn(wrapTx(tx))),
    close: () => db.close(),
    engine: () => db.engine(),
  };
}

export const SHOP: ShopInfo = { id: 'shop-1', name: 'Murugan Stores', upi_id: 'murugan@upi', lang: 'ta' };

export function device(id: string, name: string, role: 'owner' | 'staff' = 'staff'): DeviceInfo {
  return { id, name, role, created_at: T0, last_seen_at: null, revoked_at: null };
}

export function serverCustomer(over: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: uuid(), code: 900, name: 'Server Customer', search_name: null, phone: null, note: null,
    archived_at: null, erased_at: null, created_at: T0, updated_at: T0, updated_by: 'dev-other', received_at: T0,
    ...over,
  };
}

export function serverEntry(customer_id: string, over: Partial<EntryRow> = {}): EntryRow {
  const amount = over.amount_paise ?? 10_000;
  return {
    id: uuid(), customer_id, kind: 'GIVE', amount_paise: amount, delta_paise: amount, biz_date: '2026-10-12',
    note: null, mode: null, reverses_entry_id: null, device_id: 'dev-other', created_at: T0, received_at: T0,
    ...over,
  };
}

export function page(changes: Change[], over: Partial<PullResponse> = {}): PullResponse {
  const last = changes.length ? changes[changes.length - 1].seq : 0;
  return {
    changes, next_since: last, has_more: false, devices: [device('dev-other', 'Helper phone')], shop: SHOP,
    server_time: T0, sync_epoch: 'epoch-1', ...over,
  };
}

export async function pair(repo: SqlRepo, over: Partial<Parameters<SqlRepo['completePairing']>[0]> = {}): Promise<void> {
  await repo.completePairing({
    server_url: 'https://khata.example.workers.dev', device_id: 'dev-me', device_name: 'Owner phone', role: 'owner',
    shop: SHOP, sync_epoch: 'epoch-1', code_block: { start: 101, end: 150 }, ...over,
  });
}
