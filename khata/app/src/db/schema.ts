import type { Db } from './db';

/**
 * On-device schema. Versioned with PRAGMA user_version, which is the ONLY migration counter
 * (the Capacitor SQLite plugin's own upgrade mechanism is deliberately not used).
 * Rules: migrations are append-only and additive; never edit a shipped migration.
 *
 * sync_state: 'pending' (not yet accepted by the server, or never paired), 'accepted', 'rejected'.
 * Rows with sync_state = 'rejected' are excluded from EVERY balance, statement and day-book query.
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE customers (
  id            TEXT PRIMARY KEY,
  code          INTEGER NOT NULL,
  name          TEXT NOT NULL,
  search_name   TEXT,
  phone         TEXT,
  note          TEXT,
  archived_at   TEXT,
  erased_at     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  updated_by    TEXT NOT NULL,
  received_at   TEXT,
  server_seq    INTEGER,
  sync_state    TEXT NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending','accepted','rejected')),
  reject_reason TEXT
);
CREATE INDEX customers_code  ON customers(code);
CREATE INDEX customers_phone ON customers(phone);
CREATE INDEX customers_name  ON customers(name);

CREATE TABLE entries (
  id                 TEXT PRIMARY KEY,
  customer_id        TEXT NOT NULL REFERENCES customers(id),
  kind               TEXT NOT NULL CHECK (kind IN ('GIVE','RECEIVE','WRITEOFF','REVERSAL')),
  amount_paise       INTEGER NOT NULL CHECK (amount_paise > 0),
  delta_paise        INTEGER NOT NULL,
  biz_date           TEXT NOT NULL,
  note               TEXT,
  mode               TEXT CHECK (mode IN ('CASH','UPI','OTHER')),
  reverses_entry_id  TEXT,
  device_id          TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  received_at        TEXT,
  server_seq         INTEGER,
  sync_state         TEXT NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending','accepted','rejected')),
  reject_reason      TEXT,
  CHECK ((kind = 'GIVE' AND delta_paise = amount_paise)
      OR (kind IN ('RECEIVE','WRITEOFF') AND delta_paise = -amount_paise)
      OR (kind = 'REVERSAL' AND reverses_entry_id IS NOT NULL AND abs(delta_paise) = amount_paise))
);
CREATE INDEX entries_cust     ON entries(customer_id, biz_date, created_at, id);
CREATE INDEX entries_day      ON entries(biz_date);
CREATE INDEX entries_created  ON entries(created_at);
CREATE INDEX entries_reverses ON entries(reverses_entry_id);
CREATE INDEX entries_state    ON entries(sync_state);

-- One row per local write still to be pushed. Several rows for one customer collapse to its current content.
CREATE TABLE outbox (
  n          INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl        TEXT NOT NULL CHECK (tbl IN ('customers','entries')),
  row_id     TEXT NOT NULL,
  queued_at  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX outbox_row ON outbox(tbl, row_id);

-- Mirror of the server's device list (names for "entered by" chips).
CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL,
  created_at   TEXT,
  last_seen_at TEXT,
  revoked_at   TEXT
);

-- Key/value settings and sync state. See META_KEYS in src/data/types.ts.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Apply pending migrations, each in its own transaction, and enable foreign keys. */
export async function migrate(db: Db): Promise<number> {
  await db.exec('PRAGMA foreign_keys = ON;');
  const [{ user_version }] = await db.query<{ user_version: number }>('PRAGMA user_version');
  let current = Number(user_version) || 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    await db.transaction(async (tx) => {
      for (const stmt of splitSql(m.sql)) await tx.run(stmt);
      await tx.run(`PRAGMA user_version = ${m.version}`);
    });
    current = m.version;
  }
  return current;
}

/** Split a migration into statements on `;` at line ends (migrations contain no string literals with `;`). */
export function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter((s) => s.length > 0);
}
