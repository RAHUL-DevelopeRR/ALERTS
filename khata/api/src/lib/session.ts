import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { SESSION_COOKIE, WEB_SESSION_DAYS, type ClientKind } from '../../../shared/protocol';
import type { AppEnv } from '../env';
import { codeBlockStatements } from './codes';
import { iso } from './time';
import { optionalCode } from './util';
import type { Json } from './http';

/**
 * Statements that follow the INSERT of a new device row in the same batch (POST /pair and every login):
 * revoke this phone's previous device row (same shop, role not above the new device's) and move the unused codes it
 * issued to the new row, then raise + advance the customer-code sequence and record the block.
 * `blockIdx` is the index (within `stmts`) of the statement whose RETURNING carries the block end.
 * All of them are no-ops when the new device row does not exist (e.g. the code claim or the user check failed).
 */
export function newDeviceTail(
  db: D1Database,
  opts: { deviceId: string; prev: string | null; maxLocal: number; now: Date },
): { stmts: D1PreparedStatement[]; blockIdx: number } {
  const { deviceId, prev, maxLocal, now } = opts;
  const nowIso = iso(now);
  const stmts: D1PreparedStatement[] = [];
  if (prev !== null) {
    // previous_device_id is this phone's old row. Only a device of the same shop and of the same or a lower role
    // is revoked: a staff code/login can never revoke an owner phone (device ids are visible to every phone via
    // pull). The unused codes the old row issued (e.g. printed recovery codes) move to the new row, so they stay
    // valid and are cut off if this device is revoked later.
    stmts.push(
      db
        .prepare(
          `UPDATE devices SET revoked_at = ?1
           WHERE id = ?2 AND id <> ?3 AND revoked_at IS NULL
             AND shop_id = (SELECT shop_id FROM devices WHERE id = ?3)
             AND (role = 'staff' OR (SELECT role FROM devices WHERE id = ?3) = 'owner')`,
        )
        .bind(nowIso, prev, deviceId),
      db
        .prepare(
          `UPDATE pair_codes SET issued_by = ?1
           WHERE issued_by = ?2 AND used_at IS NULL
             AND shop_id = (SELECT shop_id FROM devices WHERE id = ?1)
             AND EXISTS (SELECT 1 FROM devices WHERE id = ?2 AND revoked_at = ?3)`,
        )
        .bind(deviceId, prev, nowIso),
    );
  }
  const blockIdx = stmts.length;
  stmts.push(...codeBlockStatements(db, deviceId, maxLocal, now));
  return { stmts, blockIdx };
}

/** The shop SELECT that closes a new-device batch. */
export const shopOfDevice = (db: D1Database, deviceId: string) =>
  db
    .prepare(
      `SELECT s.id, s.name, s.upi_id, s.lang, s.sync_epoch, s.created_at
       FROM devices d JOIN shops s ON s.id = d.shop_id WHERE d.id = ?`,
    )
    .bind(deviceId);

export interface LoginExtrasParsed {
  deviceName: string;
  client: ClientKind;
  maxLocal: number;
  prev: string | null;
}

/** Validates device_name, client, max_local_code, previous_device_id; returns the bad field's name on error. */
export function parseLoginExtras(body: Json): LoginExtrasParsed | string {
  const deviceName = typeof body.device_name === 'string' ? body.device_name.trim() : '';
  if (deviceName.length < 1 || deviceName.length > 60) return 'device_name';
  if (body.client !== 'android' && body.client !== 'web') return 'client';
  const maxLocal = optionalCode(body.max_local_code);
  if (maxLocal === 'invalid') return 'max_local_code';
  const prev = body.previous_device_id;
  if (prev !== undefined && prev !== null && (typeof prev !== 'string' || prev.length > 64)) return 'previous_device_id';
  return { deviceName, client: body.client, maxLocal: maxLocal ?? 0, prev: typeof prev === 'string' ? prev : null };
}

export const WEB_SESSION_MS = WEB_SESSION_DAYS * 86_400_000;

/** Sets the web session cookie (HttpOnly; Secure; SameSite=Strict; Path=/v1; 30 days). */
export function setSessionCookie(c: Context<AppEnv>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/v1',
    maxAge: WEB_SESSION_DAYS * 86_400,
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/v1' });
}
