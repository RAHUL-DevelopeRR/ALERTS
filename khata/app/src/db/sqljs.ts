/**
 * Db adapter over sql.js (SQLite compiled to WASM). Used by the browser preview, Playwright e2e and Vitest.
 * The shipped Android app uses src/db/native.ts instead (this module is dead code in the Android bundle).
 *
 *  - Node (Vitest): pure in-memory database; the wasm file is located with createRequire().
 *  - Browser: if `persistKey` is given, the database bytes are loaded from IndexedDB at open and written back
 *    300 ms after the last committed write (debounced), and again on pagehide / when the page is hidden.
 *
 * sql.js facts this relies on (checked against sql.js 1.14.2):
 *  - Database.export() closes and re-opens the underlying connection, so it must never run inside a
 *    transaction, it drops TEMP tables, and it resets PRAGMA foreign_keys (we re-apply it after export).
 *  - getRowsModified() is sqlite3_changes() of the last statement.
 */
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import type { Db, DbExec, Row, SqlValue } from './db';
import { SerialQueue, normParams } from './queue';

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>;
type SqlJsDatabase = InstanceType<SqlJsStatic['Database']>;

const isNode =
  typeof window === 'undefined' &&
  typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === 'string';

let sqlPromise: Promise<SqlJsStatic> | null = null;

async function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      if (isNode) {
        // Kept out of the browser bundle's static graph: the specifier is a runtime value.
        const modName = 'node:module';
        const { createRequire } = (await import(/* @vite-ignore */ modName)) as {
          createRequire: (url: string) => { resolve: (id: string) => string };
        };
        const wasmPath = createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm');
        return initSqlJs({ locateFile: () => wasmPath });
      }
      return initSqlJs({ locateFile: () => wasmUrl });
    })();
    sqlPromise.catch(() => {
      sqlPromise = null;
    });
  }
  return sqlPromise;
}

// ------------------------------------------------------------------ IndexedDB persistence (browser only)

const IDB_NAME = 'kadan-kanakku-sqljs';
const IDB_STORE = 'db';

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key: string): Promise<Uint8Array | null> {
  const idb = await idbOpen();
  try {
    return await new Promise((resolve, reject) => {
      const req = idb.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      req.onsuccess = () => {
        const v = req.result as unknown;
        if (v instanceof Uint8Array) resolve(v);
        else if (v instanceof ArrayBuffer) resolve(new Uint8Array(v));
        else resolve(null);
      };
      req.onerror = () => reject(req.error);
    });
  } finally {
    idb.close();
  }
}

async function idbPut(key: string, bytes: Uint8Array): Promise<void> {
  const idb = await idbOpen();
  try {
    await new Promise<void>((resolve, reject) => {
      const t = idb.transaction(IDB_STORE, 'readwrite');
      t.objectStore(IDB_STORE).put(bytes, key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    idb.close();
  }
}

// ------------------------------------------------------------------ adapter

function runOn(db: SqlJsDatabase, sql: string, params?: SqlValue[]): { changes: number } {
  db.run(sql, normParams(params));
  return { changes: db.getRowsModified() };
}

function queryOn<T>(db: SqlJsDatabase, sql: string, params?: SqlValue[]): T[] {
  const stmt = db.prepare(sql);
  try {
    const p = normParams(params);
    if (p.length) stmt.bind(p);
    const out: T[] = [];
    while (stmt.step()) out.push(stmt.getAsObject() as unknown as T);
    return out;
  } finally {
    stmt.free();
  }
}

/** Statements that only touch TEMP objects must not trigger a save (export() would drop the TEMP table). */
const TEMP_ONLY = /^\s*(CREATE\s+TEMP(ORARY)?\s|DROP\s+TABLE\s+(IF\s+EXISTS\s+)?temp\.)/i;

export interface SqlJsOptions {
  /** Browser only: IndexedDB key to load from and save to. Omit for a throwaway in-memory database. */
  persistKey?: string;
}

export async function openSqlJs(opts: SqlJsOptions = {}): Promise<Db> {
  const SQL = await loadSqlJs();
  const persistKey = !isNode && typeof indexedDB !== 'undefined' ? opts.persistKey : undefined;
  let initial: Uint8Array | null = null;
  if (persistKey) {
    try {
      initial = await idbGet(persistKey);
    } catch (e) {
      console.warn('sql.js: could not read IndexedDB, starting empty', e);
    }
  }
  const db: SqlJsDatabase = initial ? new SQL.Database(initial) : new SQL.Database();
  const queue = new SerialQueue();
  let closed = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const exportBytes = (): Uint8Array => {
    const [{ foreign_keys }] = queryOn<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys');
    const bytes = db.export();
    db.exec(`PRAGMA foreign_keys = ${foreign_keys ? 'ON' : 'OFF'}`);
    return bytes;
  };

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!persistKey || !dirty || closed) return;
    dirty = false;
    try {
      const bytes = await queue.run(exportBytes);
      await idbPut(persistKey, bytes);
    } catch (e) {
      dirty = true;
      console.warn('sql.js: save to IndexedDB failed', e);
    }
  };

  const scheduleSave = (): void => {
    if (!persistKey) return;
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), 300);
  };

  const onHide = (): void => {
    if (document.visibilityState === 'hidden') void flush();
  };
  const onPageHide = (): void => void flush();
  if (persistKey) {
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onHide);
  }

  const ensureOpen = (): void => {
    if (closed) throw new Error('Database is closed');
  };

  const adapter: Db = {
    run(sql, params) {
      return queue.run(() => {
        ensureOpen();
        const r = runOn(db, sql, params);
        if (!TEMP_ONLY.test(sql)) scheduleSave();
        return r;
      });
    },
    query<T = Row>(sql: string, params?: SqlValue[]) {
      return queue.run(() => {
        ensureOpen();
        return queryOn<T>(db, sql, params);
      });
    },
    exec(sql) {
      return queue.run(() => {
        ensureOpen();
        db.exec(sql);
        scheduleSave();
      });
    },
    transaction<T>(fn: (tx: DbExec) => Promise<T>): Promise<T> {
      return queue.run(async () => {
        ensureOpen();
        let active = true;
        const guard = (): void => {
          if (!active) throw new Error('Transaction already finished: use the Db, not a stale tx');
        };
        const tx: DbExec = {
          run: async (sql, params) => {
            guard();
            return runOn(db, sql, params);
          },
          query: async <R = Row>(sql: string, params?: SqlValue[]) => {
            guard();
            return queryOn<R>(db, sql, params);
          },
        };
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(tx);
          active = false;
          db.exec('COMMIT');
          scheduleSave();
          return result;
        } catch (e) {
          active = false;
          try {
            db.exec('ROLLBACK');
          } catch {
            /* SQLite may already have rolled back (e.g. after SQLITE_FULL); nothing left to undo */
          }
          throw e;
        }
      });
    },
    async close() {
      await flush();
      await queue.run(() => {
        if (closed) return;
        closed = true;
        if (persistKey) {
          window.removeEventListener('pagehide', onPageHide);
          document.removeEventListener('visibilitychange', onHide);
        }
        db.close();
      });
    },
    engine() {
      return queue.run(() => {
        ensureOpen();
        const [{ v }] = queryOn<{ v: string }>(db, 'SELECT sqlite_version() AS v');
        return `sql.js / SQLite ${v}`;
      });
    },
  };
  return adapter;
}
