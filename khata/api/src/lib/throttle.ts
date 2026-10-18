import { addMs, iso, utcDay } from './time';

const THROTTLE_WINDOW_MS = 30_000;

/** Tables holding a global per-UTC-day failure counter (same shape). */
export type DailyFailureTable = 'pair_failures' | 'auth_failures';

/**
 * Global per-UTC-day attempt counter (this Worker serves one shop). Reserving an attempt is ONE atomic statement,
 * so a burst cannot slip past the threshold: below `threshold` every attempt is allowed; past it only the request
 * that moves next_allowed_at (one per 30 s) is. A success gives its attempt back (giveBackDailyAttempt), so the count
 * is the day's failures. A throttle, never a lockout.
 */
export async function reserveDailyAttempt(db: D1Database, table: DailyFailureTable, now: Date, threshold: number): Promise<boolean> {
  const next = iso(addMs(now, THROTTLE_WINDOW_MS));
  const row = await db
    .prepare(
      `INSERT INTO ${table} (day, count, next_allowed_at) VALUES (?1, 1, CASE WHEN 1 >= ?2 THEN ?3 END)
       ON CONFLICT(day) DO UPDATE SET count = count + 1,
         next_allowed_at = CASE WHEN count + 1 >= ?2 THEN ?3 ELSE next_allowed_at END
       WHERE count < ?2 OR next_allowed_at IS NULL OR next_allowed_at <= ?4
       RETURNING count`,
    )
    .bind(utcDay(now), threshold, next, iso(now))
    .first();
  return row !== null;
}

/** Gives a reserved attempt back, only if device `deviceId` now exists (i.e. the batch's sign-in succeeded). */
export function giveBackDailyAttempt(db: D1Database, table: DailyFailureTable, now: Date, deviceId: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE ${table} SET count = count - 1
       WHERE day = ?1 AND count > 0 AND EXISTS (SELECT 1 FROM devices WHERE id = ?2)`,
    )
    .bind(utcDay(now), deviceId);
}
