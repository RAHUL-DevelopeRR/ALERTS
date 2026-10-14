/**
 * Db adapter over @capacitor-community/sqlite 8.1.1 (Android). The phone's ledger of record.
 *
 * Plugin facts this adapter relies on (read from node_modules/@capacitor-community/sqlite, v8.1.1):
 *  - dist/esm/definitions.js SQLiteConnection.createConnection(): strips a trailing ".db", calls native
 *    createConnection and keeps a JS-side dict keyed "RW_<name>". isConnection()/retrieveConnection() only
 *    consult that JS dict, which is empty after a WebView reload while the native side may still hold the
 *    connection; checkConnectionsConsistency() sends the JS keys to native, and
 *    CapacitorSQLite.checkConnectionsConsistency() (Java) closes ALL native connections when the JS dict is
 *    empty/inconsistent and returns false (the JS side then clears its dict). So: check consistency first,
 *    then retrieve-or-create. CapacitorSQLite.createConnection() throws "Connection <db> already exists" if
 *    the native dict still has it; we close and retry once in that case.
 *  - Database.open() (Java): openOrCreateDatabase(file "<name>SQLite.db"), then setForeignKeyConstraintsEnabled(true).
 *    It only runs UtilsUpgrade (and touches user_version) when addUpgradeStatement() registered upgrades for
 *    a higher version; we never call it, so PRAGMA user_version is ours alone (src/db/schema.ts).
 *    UtilsSQLCipher.setVersion() is only reached in the encrypt/decrypt modes; we use 'no-encryption'.
 *  - SQLiteDBConnection.run(statement, values, transaction = true, returnMode = 'no', isSQL92):
 *    Database.runSQL() calls beginTransaction() itself when `transaction` is true, and
 *    Database.beginTransaction() throws "Already in transaction" if one is active. So every run() goes with
 *    transaction=false (inside our transaction it must; outside it SQLite autocommits the single statement).
 *    The result is { changes: { changes, lastId, values } } where changes = total_changes() delta
 *    (UtilsSQLite.dbChanges).
 *  - Database.prepareSQL(): binds values with SimpleSQLiteQuery.bind (null/JSONObject.NULL -> NULL, numbers
 *    -> long/double, strings); INSERT uses executeInsert(), everything else executeUpdateDelete(), which
 *    throws for a statement that returns rows ("PRAGMA journal_mode=..." etc.): use query() for those.
 *    It REWRITES SQL in two cases: (1) any statement whose words include "returning" is truncated before
 *    RETURNING (isReturning/getStmtAndRetColNames, even with returnMode 'no'), so we never use RETURNING;
 *    (2) DELETE goes through deleteSQL(), which only rewrites to "UPDATE ... SET sql_deleted = 1" when some
 *    table has both last_modified and sql_deleted columns (UtilsJson.isLastModified/isSqlDeleted) — none of
 *    ours do, so DELETE runs as written.
 *  - query(): Database.selectSQL() uses rawQuery with the bound values; rows come back as objects keyed by
 *    column name (INTEGER -> long, REAL -> double, NULL -> null). Duplicate column names collapse, so every
 *    selected expression is aliased. PRAGMA reads (user_version, integrity_check, foreign_keys) work here.
 *    The isSQL92 flag is ignored on Android (CapacitorSQLitePlugin.query/run never read it); no quote rewriting.
 *  - execute(statements, transaction = true): UtilsSQLite.getStatementsArray() splits on ";\n" and strips
 *    "--" comments per line, then Database.execute() wraps them in its own transaction when `transaction` is
 *    true. We pass false (PRAGMA foreign_keys is a no-op inside a transaction) and use exec() only for
 *    simple DDL/PRAGMA text without string literals.
 *  - beginTransaction/commitTransaction/rollbackTransaction (Database.java): beginTransaction() =
 *    SupportSQLiteDatabase.beginTransaction() (exclusive); commitTransaction() = setTransactionSuccessful()
 *    + endTransaction(); rollbackTransaction() = endTransaction() if inTransaction(). The Android database
 *    transaction is bound to the calling thread; Capacitor runs every plugin call on its single
 *    "CapacitorPlugins" handler thread, and our queue serialises calls, so begin/run/commit see one session.
 */
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite';
import type { Db, DbExec, Row, SqlValue } from './db';
import { SerialQueue, normParams } from './queue';

export const NATIVE_DB_NAME = 'kadan_kanakku';

function asError(e: unknown): Error {
  if (e instanceof Error) return e;
  return new Error(typeof e === 'string' ? e : JSON.stringify(e));
}

async function connect(sqlite: SQLiteConnection, name: string): Promise<SQLiteDBConnection> {
  let consistent = false;
  try {
    consistent = !!(await sqlite.checkConnectionsConsistency()).result;
  } catch {
    consistent = false; // the JS dict was reset by the plugin; fall through to createConnection
  }
  const isConn = !!(await sqlite.isConnection(name, false)).result;
  if (consistent && isConn) return sqlite.retrieveConnection(name, false);
  try {
    return await sqlite.createConnection(name, false, 'no-encryption', 1, false);
  } catch (e) {
    // Native side still holds a connection the JS side forgot about: close it and try once more.
    try {
      await sqlite.closeConnection(name, false);
    } catch {
      /* ignore */
    }
    try {
      return await sqlite.createConnection(name, false, 'no-encryption', 1, false);
    } catch {
      throw asError(e);
    }
  }
}

export async function openNative(opts: { name?: string } = {}): Promise<Db> {
  const name = opts.name ?? NATIVE_DB_NAME;
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  const conn = await connect(sqlite, name);
  let isOpen = false;
  try {
    isOpen = !!(await conn.isDBOpen()).result;
  } catch {
    isOpen = false;
  }
  if (!isOpen) await conn.open().catch((e) => Promise.reject(asError(e)));

  const queue = new SerialQueue();
  let closed = false;
  // Set when a native transaction may still be open and could not be rolled back. From then on every call fails
  // loudly: run() with transaction=false would otherwise land inside that never-committed transaction and be lost
  // when the process dies. Restarting the app closes the native connection, which rolls the transaction back.
  let broken: Error | null = null;

  const runOn = async (sql: string, params?: SqlValue[]): Promise<{ changes: number }> => {
    try {
      const res = await conn.run(sql, normParams(params), false, 'no');
      return { changes: Number(res.changes?.changes ?? 0) };
    } catch (e) {
      throw asError(e);
    }
  };
  const queryOn = async <T>(sql: string, params?: SqlValue[]): Promise<T[]> => {
    try {
      const res = await conn.query(sql, normParams(params));
      return (res.values ?? []) as T[];
    } catch (e) {
      throw asError(e);
    }
  };
  const ensureOpen = (): void => {
    if (closed) throw new Error('Database is closed');
    if (broken) throw broken;
  };
  /** End any native transaction still open. Returns false (and marks the Db broken) if that is not possible. */
  const endStaleTransaction = async (why: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (!(await conn.isTransactionActive()).result) return true;
        console.warn(`[db] rolling back a native transaction left open (${why})`);
        await conn.rollbackTransaction();
      } catch (e) {
        console.error('[db] rollback failed', e);
      }
    }
    broken = new Error('Database transaction could not be closed. Close and reopen the app.');
    return false;
  };

  const db: Db = {
    run(sql, params) {
      return queue.run(() => {
        ensureOpen();
        return runOn(sql, params);
      });
    },
    query<T = Row>(sql: string, params?: SqlValue[]) {
      return queue.run(() => {
        ensureOpen();
        return queryOn<T>(sql, params);
      });
    },
    exec(sql) {
      return queue.run(async () => {
        ensureOpen();
        try {
          await conn.execute(sql, false);
        } catch (e) {
          throw asError(e);
        }
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
            return runOn(sql, params);
          },
          query: async <R = Row>(sql: string, params?: SqlValue[]) => {
            guard();
            return queryOn<R>(sql, params);
          },
        };
        // Cheap guard (one native call): a transaction that leaked earlier would make beginTransaction() throw
        // "Already in transaction" forever and swallow autocommit writes; roll it back first.
        if (!(await endStaleTransaction('before begin'))) throw broken ?? new Error('Database unavailable');
        try {
          await conn.beginTransaction();
        } catch (e) {
          throw asError(e);
        }
        try {
          const result = await fn(tx);
          active = false;
          await conn.commitTransaction();
          return result;
        } catch (e) {
          active = false;
          await endStaleTransaction('after a failed transaction');
          throw asError(e);
        }
      });
    },
    close() {
      return queue.run(async () => {
        if (closed) return;
        closed = true;
        try {
          await sqlite.closeConnection(name, false);
        } catch (e) {
          throw asError(e);
        }
      });
    },
    engine() {
      return queue.run(async () => {
        ensureOpen();
        const [row] = await queryOn<{ v: string }>('SELECT sqlite_version() AS v');
        return `SQLCipher/SQLite ${row?.v ?? '?'}`;
      });
    },
  };
  return db;
}
