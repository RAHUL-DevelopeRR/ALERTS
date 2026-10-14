import { describe, it, expect } from 'vitest';
import { openSqlJs } from '../src/db/sqljs';
import { migrate, SCHEMA_VERSION } from '../src/db/schema';
import { selfTest, compareVersions } from '../src/data/index';
import { SerialQueue } from '../src/db/queue';

describe('sql.js adapter', () => {
  it('migrates, enables foreign keys, reports engine', async () => {
    const db = await openSqlJs();
    expect(await migrate(db)).toBe(SCHEMA_VERSION);
    expect(await migrate(db)).toBe(SCHEMA_VERSION); // idempotent
    const [{ foreign_keys }] = await db.query<{ foreign_keys: number }>('PRAGMA foreign_keys');
    expect(foreign_keys).toBe(1);
    expect(await db.engine()).toMatch(/^sql\.js \/ SQLite 3\.\d+\.\d+$/);
    await expect(db.run(`INSERT INTO entries (id, customer_id, kind, amount_paise, delta_paise, biz_date, device_id, created_at)
      VALUES ('e', 'missing', 'GIVE', 1, 1, '2026-10-12', 'd', 'x')`)).rejects.toThrow(/FOREIGN KEY/);
    await db.close();
    await expect(db.query('SELECT 1')).rejects.toThrow(/closed/);
  });

  it('run/query params: undefined -> null, changes count', async () => {
    const db = await openSqlJs();
    await db.exec('CREATE TABLE t (a, b); CREATE TABLE u (x)');
    const r = await db.run('INSERT INTO t (a, b) VALUES (?, ?)', [1, undefined as unknown as null]);
    expect(r.changes).toBe(1);
    await db.run('INSERT INTO t (a, b) VALUES (?, ?)', [2, 'two']);
    expect((await db.run('UPDATE t SET b = ? WHERE a > ?', ['x', 0])).changes).toBe(2);
    expect(await db.query('SELECT a, b FROM t WHERE b IS NULL OR a = ? ORDER BY a', [1])).toEqual([{ a: 1, b: 'x' }]);
    expect(await db.query('SELECT a FROM t WHERE a = ?', [99])).toEqual([]);
  });

  it('transaction commits, rolls back on throw, and holds the queue', async () => {
    const db = await openSqlJs();
    await db.exec('CREATE TABLE t (a INTEGER)');
    const order: string[] = [];
    const tx1 = db.transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (1)');
      order.push('tx1-a');
      await new Promise((r) => setTimeout(r, 20));
      await tx.run('INSERT INTO t VALUES (2)');
      order.push('tx1-b');
    });
    const outside = db.query('SELECT COUNT(*) AS k FROM t').then((r) => {
      order.push(`outside-${(r[0] as { k: number }).k}`);
    });
    await Promise.all([tx1, outside]);
    expect(order).toEqual(['tx1-a', 'tx1-b', 'outside-2']);
    let stale: Parameters<Parameters<typeof db.transaction>[0]>[0] | null = null;
    await expect(db.transaction(async (tx) => {
      stale = tx;
      await tx.run('INSERT INTO t VALUES (3)');
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await db.query('SELECT a FROM t ORDER BY a')).toEqual([{ a: 1 }, { a: 2 }]);
    await expect(stale!.run('INSERT INTO t VALUES (4)')).rejects.toThrow(/finished/);
    // a failing statement inside a transaction rolls back everything before it
    await expect(db.transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (5)');
      await tx.run('INSERT INTO nope VALUES (1)');
    })).rejects.toThrow(/no such table/);
    expect((await db.query('SELECT a FROM t')).length).toBe(2);
    // and the connection is usable afterwards
    expect(await db.transaction(async (tx) => (await tx.run('INSERT INTO t VALUES (6)')).changes)).toBe(1);
  });

  it('selfTest passes on a migrated database', async () => {
    const db = await openSqlJs();
    await migrate(db);
    const r = await selfTest(db);
    expect(r.ok, r.lines.join('\n')).toBe(true);
    expect(r.lines.some((l) => l.includes('integrity_check: ok'))).toBe(true);
    expect(r.lines.at(-1)).toMatch(/^ok total \d+ ms$/);
    const unmigrated = await openSqlJs();
    const bad = await selfTest(unmigrated);
    expect(bad.ok).toBe(false);
    expect(bad.lines.some((l) => l.startsWith('FAIL user_version'))).toBe(true);
  });

  it('helpers', async () => {
    expect(compareVersions('3.49.1', '3.35.0')).toBe(1);
    expect(compareVersions('3.35', '3.35.0')).toBe(0);
    expect(compareVersions('3.9.2', '3.35.0')).toBe(-1);
    const q = new SerialQueue();
    const seen: number[] = [];
    await Promise.allSettled([
      q.run(async () => { await new Promise((r) => setTimeout(r, 5)); seen.push(1); }),
      q.run(() => { throw new Error('x'); }),
      q.run(() => { seen.push(3); }),
    ]);
    expect(seen).toEqual([1, 3]);
  });
});
