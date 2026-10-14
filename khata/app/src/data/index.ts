/**
 * Opens the ledger: native SQLite on Android, sql.js (IndexedDB-persisted) in the browser preview.
 * Runs migrations and Repo.init(). Also hosts the Settings -> About "Run self-test".
 */
import { Capacitor } from '@capacitor/core';
import type { Db } from '../db/db';
import { migrate, SCHEMA_VERSION } from '../db/schema';
import { SqlRepo } from './repo';
import { RepoError, type Repo } from './types';

export { SqlRepo, validateBackup } from './repo';

/** Minimum SQLite: UPSERT (3.24), window functions (3.25), NULLS LAST (3.30), RETURNING (3.35). */
export const MIN_SQLITE = '3.35.0';
/** IndexedDB key of the browser-preview database. */
export const PREVIEW_DB_KEY = 'kadan-kanakku';

/** -1 / 0 / 1 comparison of dotted versions ("3.49.1" vs "3.35"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

async function openDb(): Promise<Db> {
  if (typeof __NATIVE_BUILD__ !== 'undefined' && __NATIVE_BUILD__) {
    const { openNative } = await import('../db/native');
    return openNative();
  }
  if (Capacitor.isNativePlatform()) {
    const { openNative } = await import('../db/native');
    return openNative();
  }
  const { openSqlJs } = await import('../db/sqljs');
  return openSqlJs({ persistKey: PREVIEW_DB_KEY });
}

/** Open the database for this platform, migrate it, and initialise the repo. Throws RepoError('SQLITE_TOO_OLD')
 *  if the engine is older than MIN_SQLITE (the app must not run on it). */
export async function openRepo(): Promise<{ repo: Repo; db: Db }> {
  const db = await openDb();
  const [{ v }] = await db.query<{ v: string }>('SELECT sqlite_version() AS v');
  if (compareVersions(String(v), MIN_SQLITE) < 0) {
    await db.close().catch(() => undefined);
    throw new RepoError('SQLITE_TOO_OLD', `SQLite ${v} < ${MIN_SQLITE}`);
  }
  await migrate(db);
  const repo = new SqlRepo(db);
  await repo.init();
  return { repo, db };
}

/** Diagnostics for Settings -> About. Never throws; each line is "ok"/"FAIL" plus detail and timing. */
export async function selfTest(db: Db): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t0 = now();
  const step = async (label: string, fn: () => Promise<{ pass: boolean; detail: string }>): Promise<void> => {
    const t = now();
    try {
      const { pass, detail } = await fn();
      if (!pass) ok = false;
      lines.push(`${pass ? 'ok' : 'FAIL'} ${label}: ${detail} (${Math.round(now() - t)} ms)`);
    } catch (e) {
      ok = false;
      lines.push(`FAIL ${label}: ${e instanceof Error ? e.message : String(e)} (${Math.round(now() - t)} ms)`);
    }
  };

  await step('engine', async () => ({ pass: true, detail: await db.engine() }));
  await step('sqlite_version', async () => {
    const [{ v }] = await db.query<{ v: string }>('SELECT sqlite_version() AS v');
    return { pass: compareVersions(String(v), MIN_SQLITE) >= 0, detail: `${v} (need >= ${MIN_SQLITE})` };
  });
  await step('integrity_check', async () => {
    const rows = await db.query<Record<string, unknown>>('PRAGMA integrity_check');
    const vals = rows.map((r) => String(Object.values(r)[0]));
    return { pass: vals.length === 1 && vals[0] === 'ok', detail: vals.slice(0, 3).join('; ') || '(no result)' };
  });
  await step('foreign_keys', async () => {
    const rows = await db.query<Record<string, unknown>>('PRAGMA foreign_keys');
    const v = Number(rows.length ? Object.values(rows[0])[0] : 0);
    return { pass: v === 1, detail: String(v) };
  });
  await step('user_version', async () => {
    const rows = await db.query<Record<string, unknown>>('PRAGMA user_version');
    const v = Number(rows.length ? Object.values(rows[0])[0] : 0);
    return { pass: v === SCHEMA_VERSION, detail: `${v} (app schema ${SCHEMA_VERSION})` };
  });
  await step('transaction rollback', async () => {
    await db.run('CREATE TEMP TABLE IF NOT EXISTS kk_selftest (x INTEGER)');
    try {
      await db.run('DELETE FROM temp.kk_selftest');
      const marker = new Error('selftest-rollback');
      try {
        await db.transaction(async (tx) => {
          await tx.run('INSERT INTO temp.kk_selftest (x) VALUES (?)', [1]);
          await tx.run('INSERT INTO temp.kk_selftest (x) VALUES (?)', [2]);
          throw marker;
        });
      } catch (e) {
        if (e !== marker) throw e;
      }
      const [{ k }] = await db.query<{ k: number }>('SELECT COUNT(*) AS k FROM temp.kk_selftest');
      const committed = await db.transaction(async (tx) => {
        await tx.run('INSERT INTO temp.kk_selftest (x) VALUES (?)', [3]);
        const [{ c }] = await tx.query<{ c: number }>('SELECT COUNT(*) AS c FROM temp.kk_selftest');
        return Number(c);
      });
      return { pass: Number(k) === 0 && committed === 1, detail: `after rollback ${k} rows, after commit ${committed}` };
    } finally {
      await db.run('DROP TABLE IF EXISTS temp.kk_selftest');
    }
  });
  await step('window function', async () => {
    const rows = await db.query<{ s: number }>(
      `SELECT SUM(x) OVER (ORDER BY x ROWS UNBOUNDED PRECEDING) AS s
       FROM (SELECT 1 AS x UNION ALL SELECT 2 UNION ALL SELECT 3) ORDER BY s`,
    );
    const got = rows.map((r) => Number(r.s)).join(',');
    return { pass: got === '1,3,6', detail: got };
  });
  await step('ledger counts', async () => {
    const [r] = await db.query<{ c: number; e: number; o: number }>(
      `SELECT (SELECT COUNT(*) FROM customers) AS c, (SELECT COUNT(*) FROM entries) AS e, (SELECT COUNT(*) FROM outbox) AS o`,
    );
    return { pass: true, detail: `${r.c} customers, ${r.e} entries, ${r.o} queued` };
  });
  lines.push(`${ok ? 'ok' : 'FAIL'} total ${Math.round(now() - t0)} ms`);
  return { ok, lines };
}
