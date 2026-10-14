/**
 * Minimal async SQLite interface used by the whole app. Two adapters implement it:
 *  - src/db/native.ts  : @capacitor-community/sqlite on Android (the shipped app)
 *  - src/db/sqljs.ts   : sql.js (WASM) for the browser preview, Playwright e2e and Vitest (Node)
 *
 * Concurrency contract: every adapter serialises access with an internal queue. `transaction(fn)` holds the
 * queue for the whole callback, so no other statement can interleave with it. Inside the callback use ONLY the
 * `tx` argument (calling the outer Db from inside a transaction would deadlock). A thrown error rolls back.
 */
export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

export interface DbExec {
  /** INSERT/UPDATE/DELETE/DDL with positional `?` params. */
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  /** SELECT (or ... RETURNING) with positional params; returns plain row objects. */
  query<T = Row>(sql: string, params?: SqlValue[]): Promise<T[]>;
}

export interface Db extends DbExec {
  /** Run several `;`-separated statements without params (schema DDL). Not transactional by itself. */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DbExec) => Promise<T>): Promise<T>;
  /** Close the connection (tests, wipe). */
  close(): Promise<void>;
  /** Human-readable engine info for Settings → About, e.g. "SQLCipher 4.17 / SQLite 3.50.4". */
  engine(): Promise<string>;
}
