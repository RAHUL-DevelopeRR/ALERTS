import { CODE_BLOCK_SIZE, type Role } from '../../../shared/protocol';
import { normaliseCode, pepperHash, randomDigits } from './crypto';
import { addMinutes, iso } from './time';

export type CodeKind = 'pair' | 'setup' | 'recovery';

/**
 * Mints an 8-digit pairing code. A hash collision with a used or expired row overwrites it; a collision with
 * a live code (1 in 10^8 per live code) retries with fresh digits instead of failing.
 */
export async function mintPairCode(
  db: D1Database,
  pepper: string,
  opts: { shopId: string; role: Role; kind: CodeKind; issuedBy: string; now: Date; ttlMin: number },
): Promise<{ code: string; expires_at: string }> {
  const nowIso = iso(opts.now);
  const expires = iso(addMinutes(opts.now, opts.ttlMin));
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomDigits(8);
    const hash = await pepperHash(normaliseCode(code), pepper);
    const res = await db
      .prepare(
        `INSERT INTO pair_codes (code_hash, shop_id, role, kind, issued_by, created_at, expires_at, used_at, used_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL)
         ON CONFLICT(code_hash) DO UPDATE SET shop_id = excluded.shop_id, role = excluded.role, kind = excluded.kind,
           issued_by = excluded.issued_by, created_at = excluded.created_at, expires_at = excluded.expires_at,
           used_at = NULL, used_by = NULL
         WHERE pair_codes.used_at IS NOT NULL OR (pair_codes.expires_at IS NOT NULL AND pair_codes.expires_at <= ?6)`,
      )
      .bind(hash, opts.shopId, opts.role, opts.kind, opts.issuedBy, nowIso, expires)
      .run();
    if (res.meta.changes > 0) return { code, expires_at: expires };
  }
  throw new Error('could not mint a unique pairing code');
}

/**
 * Two statements that hand device `deviceId` its next block of customer codes, inside the caller's batch:
 * raise seq.customer_code to max(current, maxLocal), advance it by CODE_BLOCK_SIZE (RETURNING the new end),
 * and record the block. The shop is resolved through the device row, so this works in the same batch that
 * inserts the device (POST /pair). Both statements are no-ops when the device does not exist.
 */
export function codeBlockStatements(db: D1Database, deviceId: string, maxLocal: number, now: Date): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO seq (shop_id, name, value)
         SELECT shop_id, 'customer_code', MAX(0, ?2) + ?3 FROM devices WHERE id = ?1
         ON CONFLICT(shop_id, name) DO UPDATE SET value = MAX(seq.value, ?2) + ?3
         RETURNING value`,
      )
      .bind(deviceId, maxLocal, CODE_BLOCK_SIZE),
    db
      .prepare(
        `INSERT INTO code_blocks (shop_id, block_start, block_end, device_id, issued_at)
         SELECT s.shop_id, s.value - ?2 + 1, s.value, d.id, ?3
         FROM devices d JOIN seq s ON s.shop_id = d.shop_id AND s.name = 'customer_code'
         WHERE d.id = ?1`,
      )
      .bind(deviceId, CODE_BLOCK_SIZE, iso(now)),
  ];
}

/** Reads the block end returned by the first codeBlockStatements() statement. */
export function blockFromResult(res: D1Result | undefined): { start: number; end: number } | null {
  const row = res?.results?.[0] as { value?: number } | undefined;
  if (!row || typeof row.value !== 'number') return null;
  return { start: row.value - CODE_BLOCK_SIZE + 1, end: row.value };
}
