/**
 * Review harness for src/db/native.ts. No device or emulator exists here, so @capacitor-community/sqlite 8.1.1 is
 * replaced by an emulator of its JS wrapper + Android Java behaviour as read from node_modules:
 *  - dist/esm/definitions.js: SQLiteConnection keeps a JS-side "RW_<db>" dict; checkConnectionsConsistency() with
 *    an empty dict makes native close ALL connections and returns false; run() returns { changes: {changes,lastId} }.
 *  - CapacitorSQLite.java createConnection(): throws "Connection <db> already exists" if the native dict has it.
 *  - Database.java runSQL(transaction=true) calls beginTransaction(), which throws "Already in transaction";
 *    prepareSQL() runs executeUpdateDelete() for non-INSERT, which throws for a statement that returns rows;
 *    any "returning" makes isReturning() rewrite the SQL; changes = total_changes() delta (UtilsSQLite.dbChanges).
 *  - Database.open() calls setForeignKeyConstraintsEnabled(true); beginTransaction() is exclusive.
 *  - Values cross the Capacitor bridge as JSON (undefined -> null, numbers stay numbers).
 * The emulator is strict where the plugin would fail, so a misuse in native.ts fails here first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface NativeState {
  /** Native-side connection dict (survives a "WebView reload", i.e. a new SQLiteConnection instance). */
  conns: Map<string, { open: boolean; inTx: boolean; file: string }>;
  calls: { method: string; statement?: string; transaction?: boolean }[];
  reset(): void;
}

vi.mock('@capacitor-community/sqlite', async () => {
  const { createRequire } = await import('node:module');
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs({ locateFile: () => createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm') });
  type SqlDb = InstanceType<typeof SQL.Database>;
  const files = new Map<string, SqlDb>();
  const native: NativeState = {
    conns: new Map(),
    calls: [],
    reset() {
      for (const f of files.values()) f.close();
      files.clear();
      this.conns.clear();
      this.calls.length = 0;
    },
  };
  const bridge = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;
  const fileOf = (name: string): SqlDb => {
    let f = files.get(name);
    if (!f) {
      f = new SQL.Database();
      files.set(name, f);
    }
    return f;
  };
  const totalChanges = (f: SqlDb): number => Number(f.exec('SELECT total_changes()')[0].values[0][0]);
  const closeNative = (key: string): void => {
    const c = native.conns.get(key);
    if (c?.inTx) fileOf(c.file).exec('ROLLBACK');
    native.conns.delete(key);
  };

  class SQLiteDBConnection {
    constructor(private readonly name: string) {}
    private c() {
      const c = native.conns.get(`RW_${this.name}`);
      if (!c) throw new Error(`No available connection for database ${this.name}`);
      return c;
    }
    private db(): SqlDb {
      const c = this.c();
      if (!c.open) throw new Error(`database ${this.name} not opened`);
      return fileOf(c.file);
    }
    async isDBOpen() {
      return { result: this.c().open };
    }
    async open() {
      const c = this.c();
      fileOf(c.file).exec('PRAGMA foreign_keys = ON'); // setForeignKeyConstraintsEnabled(true)
      c.open = true;
    }
    async beginTransaction() {
      native.calls.push({ method: 'beginTransaction' });
      const c = this.c();
      if (c.inTx) throw new Error('BeginTransaction: Failed in beginTransactionAlready in transaction');
      this.db().exec('BEGIN EXCLUSIVE');
      c.inTx = true;
      return { changes: { changes: 0 } };
    }
    async commitTransaction() {
      native.calls.push({ method: 'commitTransaction' });
      const c = this.c();
      if (!c.inTx) throw new Error('CommitTransaction: Failed in commitTransactionNo transaction active');
      c.inTx = false;
      this.db().exec('COMMIT');
      return { changes: { changes: 0 } };
    }
    async rollbackTransaction() {
      native.calls.push({ method: 'rollbackTransaction' });
      const c = this.c();
      if (c.inTx) {
        this.db().exec('ROLLBACK');
        c.inTx = false;
      }
      return { changes: { changes: 0 } };
    }
    async isTransactionActive() {
      return { result: this.c().inTx };
    }
    async run(statement: string, values?: unknown[], transaction = true, returnMode = 'no') {
      native.calls.push({ method: 'run', statement, transaction });
      if (returnMode !== 'no') throw new Error('emulator: returnMode is not used by the app');
      if (/\breturning\b/i.test(statement)) throw new Error('emulator: Database.isReturning() would rewrite this SQL');
      const c = this.c();
      const f = this.db();
      const vals = bridge(values ?? []) as (string | number | null)[];
      if (transaction) {
        if (c.inTx) throw new Error('Run: Failed in beginTransactionAlready in transaction');
      }
      const before = totalChanges(f);
      if (transaction) f.exec('BEGIN EXCLUSIVE');
      try {
        const stmt = f.prepare(statement);
        try {
          if (stmt.getColumnNames().length > 0) {
            throw new Error('Run: Queries can be performed using SQLiteDatabase query or rawQuery methods only.');
          }
          if (vals.length) stmt.bind(vals);
          stmt.step();
        } finally {
          stmt.free();
        }
        if (transaction) f.exec('COMMIT');
      } catch (e) {
        if (transaction) f.exec('ROLLBACK');
        throw e;
      }
      return bridge({ changes: { changes: totalChanges(f) - before, lastId: -1, values: [] } });
    }
    async query(statement: string, values?: unknown[]) {
      native.calls.push({ method: 'query', statement });
      const f = this.db();
      const stmt = f.prepare(statement);
      const out: Record<string, unknown>[] = [];
      try {
        const vals = bridge(values ?? []) as (string | number | null)[];
        if (vals.length) stmt.bind(vals);
        while (stmt.step()) out.push(stmt.getAsObject());
      } finally {
        stmt.free();
      }
      return bridge({ values: out });
    }
    async execute(statements: string, transaction = true) {
      native.calls.push({ method: 'execute', statement: statements, transaction });
      const c = this.c();
      const f = this.db();
      // UtilsSQLite.getStatementsArray(): split on ";\n", strip "--" per line.
      const parts = statements.replace('end;', 'END;').split(';\n').map((s) =>
        s.split('\n').map((l) => (l.includes('--') ? l.slice(0, l.indexOf('--')) : l).trim()).filter(Boolean).join(' '))
        .filter(Boolean);
      if (transaction) {
        if (c.inTx) throw new Error('Execute: Failed in beginTransactionAlready in transaction');
        f.exec('BEGIN EXCLUSIVE');
      }
      try {
        for (const p of parts) f.exec(p.endsWith(';') ? p : `${p};`);
        if (transaction) f.exec('COMMIT');
      } catch (e) {
        if (transaction) f.exec('ROLLBACK');
        throw e;
      }
      return { changes: { changes: 0 } };
    }
  }

  class SQLiteConnection {
    private dict = new Map<string, SQLiteDBConnection>();
    async checkConnectionsConsistency() {
      native.calls.push({ method: 'checkConnectionsConsistency' });
      const keys = [...this.dict.keys()];
      const nativeKeys = [...native.conns.keys()];
      const ok = keys.length > 0 && keys.length === nativeKeys.length && keys.every((k) => native.conns.has(k));
      if (!ok) {
        for (const k of nativeKeys) closeNative(k); // closeAllConnections()
        this.dict = new Map();
      }
      return { result: ok };
    }
    async isConnection(name: string) {
      return { result: this.dict.has(`RW_${name.replace(/\.db$/, '')}`) };
    }
    async retrieveConnection(name: string) {
      const c = this.dict.get(`RW_${name.replace(/\.db$/, '')}`);
      if (!c) throw new Error(`Connection ${name} does not exist`);
      return c;
    }
    async createConnection(name: string, encrypted: boolean, mode: string, version: number, readonly: boolean) {
      native.calls.push({ method: 'createConnection' });
      const db = name.replace(/\.db$/, '');
      if (readonly || encrypted || mode !== 'no-encryption' || version !== 1) throw new Error('emulator: unexpected options');
      if (native.conns.has(`RW_${db}`)) throw new Error(`CreateConnection: Connection ${db} already exists`);
      native.conns.set(`RW_${db}`, { open: false, inTx: false, file: db });
      const conn = new SQLiteDBConnection(db);
      this.dict.set(`RW_${db}`, conn);
      return conn;
    }
    async closeConnection(name: string) {
      const db = name.replace(/\.db$/, '');
      if (!native.conns.has(`RW_${db}`)) throw new Error(`No available connection for database ${db}`);
      closeNative(`RW_${db}`);
      this.dict.delete(`RW_${db}`);
    }
  }

  return { CapacitorSQLite: {}, SQLiteConnection, SQLiteDBConnection, __native: native };
});

// Imported after the mock is registered (vi.mock is hoisted).
import * as plugin from '@capacitor-community/sqlite';
import { openNative } from '../src/db/native';
import { migrate, SCHEMA_VERSION } from '../src/db/schema';
import { SqlRepo } from '../src/data/repo';
import { selfTest } from '../src/data/index';
import { page, serverCustomer, serverEntry, pair } from './helpers/repo';

const native = (plugin as unknown as { __native: NativeState }).__native;
let tick = 0;
/** Advancing clock: entries get distinct created_at, so running-balance order is deterministic. */
const NOW = () => new Date(Date.parse('2026-10-12T05:00:00.000Z') + 1000 * tick++);

beforeEach(() => {
  native.reset();
  tick = 0;
});

describe('review native: src/db/native.ts against the plugin emulator', () => {
  it('migrates, runs the whole Repo, and never asks the plugin for its own transaction', async () => {
    const db = await openNative({ name: 'kk_test' });
    expect(await migrate(db)).toBe(SCHEMA_VERSION);
    const repo = new SqlRepo(db, { now: NOW });
    await repo.init();
    const c = await repo.createCustomer({ name: 'கமலா', phone: '98765 43210' });
    const g = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 123_45 });
    await repo.addEntry({ customer_id: c.id, kind: 'RECEIVE', amount_paise: 45, mode: 'UPI' });
    await repo.reverseEntry(g.entry.id);
    await pair(repo);
    const b = await repo.outboxBatch(20);
    await repo.applyPushResults(b.entries.map((e, i) => ({ tbl: 'entries' as const, id: e.id, status: 'stored' as const, seq: i + 1 })), NOW().toISOString());
    const x = serverCustomer({ code: 901 });
    await repo.applyPullPage(page([{ seq: 9, tbl: 'customers', row: x }, { seq: 10, tbl: 'entries', row: serverEntry(x.id, { amount_paise: 700, delta_paise: 700 }) }]));
    expect(await repo.balance(c.id)).toBe(-45);
    expect(await repo.balance(x.id)).toBe(700);
    const st = await repo.statement(c.id, '2026-10-01', '2026-10-12');
    expect(st.rows.map((r) => r.running_paise)).toEqual([12_345, 12_300, -45]);
    expect(await repo.requeueEverything()).toBeGreaterThan(0); // INSERT ... SELECT counts via total_changes
    await repo.importBackup(await repo.exportBackup());
    expect(await repo.balance(c.id)).toBe(-45);
    const runs = native.calls.filter((k) => k.method === 'run' || k.method === 'execute');
    expect(runs.every((k) => k.transaction === false)).toBe(true);
    const begins = native.calls.filter((k) => k.method === 'beginTransaction').length;
    expect(native.calls.filter((k) => k.method === 'commitTransaction').length).toBe(begins);
  });

  it('rolls back a failed transaction and leaves no native transaction open', async () => {
    const db = await openNative({ name: 'kk_test' });
    await migrate(db);
    const repo = new SqlRepo(db, { now: NOW });
    await repo.init();
    const c = await repo.createCustomer({ name: 'Anbu' });
    await expect(db.transaction(async (tx) => {
      await tx.run('INSERT INTO outbox (tbl, row_id, queued_at) VALUES (?, ?, ?)', ['customers', c.id, 'x']);
      await tx.run('INSERT INTO entries (id, customer_id, kind, amount_paise, delta_paise, biz_date, device_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['e1', 'no-such-customer', 'GIVE', 1, 1, '2026-10-12', 'd', 'x']); // FK violation
    })).rejects.toThrow();
    expect(native.conns.get('RW_kk_test')?.inTx).toBe(false);
    const [{ k }] = await db.query<{ k: number }>('SELECT COUNT(*) AS k FROM outbox');
    expect(k).toBe(1); // only createCustomer's row
    expect((await selfTest(db)).lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
  });

  it('reconnects after a WebView reload, even if the old page died inside a transaction', async () => {
    const db1 = await openNative({ name: 'kk_test' });
    await migrate(db1);
    const repo1 = new SqlRepo(db1, { now: NOW });
    await repo1.init();
    const c = await repo1.createCustomer({ name: 'Anbu' });
    await repo1.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 500 });
    // The page dies half-way through a transaction (begin + one statement, no commit).
    void db1.transaction(async (tx) => {
      await tx.run('UPDATE meta SET value = ? WHERE key = ?', ['zzz', 'shop_name']);
      await new Promise(() => undefined);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(native.conns.get('RW_kk_test')?.inTx).toBe(true);
    // New JS context: openNative() again with a fresh SQLiteConnection (empty JS dict).
    const db2 = await openNative({ name: 'kk_test' });
    await migrate(db2);
    const repo2 = new SqlRepo(db2, { now: NOW });
    await repo2.init();
    expect(await repo2.balance(c.id)).toBe(500);
    expect((await repo2.getSettings()).shop_name).toBe(''); // the half-done write was rolled back
    await repo2.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 1 });
    expect(await repo2.balance(c.id)).toBe(501);
  });
  it('rolls back a native transaction that leaked before starting the next one', async () => {
    const db = await openNative({ name: 'kk_test' });
    await migrate(db);
    const proto = (plugin as unknown as { SQLiteDBConnection: { prototype: { isTransactionActive(): Promise<{ result: boolean }> } } })
      .SQLiteDBConnection.prototype;
    // The catch block is told "no transaction" although one is open: the transaction leaks.
    const spy = vi.spyOn(proto, 'isTransactionActive').mockResolvedValueOnce({ result: false }).mockResolvedValueOnce({ result: false });
    await expect(db.transaction(async (tx) => {
      await tx.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['leaked', '1']);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    spy.mockRestore();
    expect(native.conns.get('RW_kk_test')?.inTx).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['probe', '1']);
    });
    warn.mockRestore();
    expect(native.conns.get('RW_kk_test')?.inTx).toBe(false);
    const rows = await db.query<{ key: string }>("SELECT key AS key FROM meta WHERE key IN ('probe', 'leaked') ORDER BY key");
    expect(rows.map((r) => r.key)).toEqual(['probe']); // the leaked write was rolled back, the new one committed
  });

  it('fails loudly instead of autocommitting into an open transaction when rollback is impossible', async () => {
    const db = await openNative({ name: 'kk_test' });
    await migrate(db);
    const proto = (plugin as unknown as { SQLiteDBConnection: { prototype: { rollbackTransaction(): Promise<unknown> } } })
      .SQLiteDBConnection.prototype;
    const spy = vi.spyOn(proto, 'rollbackTransaction').mockRejectedValue(new Error('native rollback failed'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(db.transaction(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    await expect(db.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['lost', '1'])).rejects.toThrow(/could not be closed/);
    await expect(db.transaction(async () => 1)).rejects.toThrow(/could not be closed/);
    spy.mockRestore();
    err.mockRestore();
    warn.mockRestore();
    // Restarting the app (new JS context) closes the native connection, which rolls the transaction back.
    const db2 = await openNative({ name: 'kk_test' });
    await migrate(db2);
    await db2.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['ok', '1']);
    expect(native.conns.get('RW_kk_test')?.inTx).toBe(false);
  });
});
