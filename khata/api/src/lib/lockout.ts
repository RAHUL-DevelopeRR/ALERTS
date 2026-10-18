import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { KNOWN_DEVICE_COOKIE, KNOWN_DEVICE_HEADER } from '../../../shared/protocol';
import type { AppEnv } from '../env';
import { constantTimeEqual, hmacSha256, toHex } from './crypto';
import { addMs, iso } from './time';

/**
 * Login backoff keyed on (username, source), table login_locks. 5 failures lock the pair for 30 s, doubling to 15 min,
 * never permanently. Real and unknown usernames are treated identically (no enumeration through lockouts).
 */
export const LOCK_AFTER = 5;
export const LOCK_BASE_S = 30;
export const LOCK_MAX_S = 900;

/** SQL: locked_until after one more failure is recorded (failed_count = the OLD value). Needs ?now bound as ?3. */
const NEXT_LOCK = `CASE WHEN failed_count + 1 >= ${LOCK_AFTER}
  THEN strftime('%Y-%m-%dT%H:%M:%fZ', ?3,
         '+' || MIN(${LOCK_MAX_S}, ${LOCK_BASE_S} << MIN(failed_count + 1 - ${LOCK_AFTER}, 5)) || ' seconds')
  ELSE NULL END`;

/**
 * Records one attempt as a failure for (username, source) unless the pair is locked: RETURNING a row = attempt allowed
 * (the caller gives it back with lockReset on success); no row = locked. One atomic statement, so a burst cannot slip
 * past the threshold.
 */
export const lockRecordAttempt = (db: D1Database, username: string, source: string, now: Date): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO login_locks (username, source, failed_count, locked_until, updated_at) VALUES (?1, ?2, 1, NULL, ?3)
       ON CONFLICT(username, source) DO UPDATE SET failed_count = failed_count + 1, locked_until = ${NEXT_LOCK}, updated_at = ?3
       WHERE locked_until IS NULL OR locked_until <= ?3
       RETURNING failed_count, locked_until`,
    )
    .bind(username, source, iso(now));

export const lockRead = (db: D1Database, username: string, source: string): D1PreparedStatement =>
  db.prepare('SELECT locked_until FROM login_locks WHERE username = ?1 AND source = ?2').bind(username, source);

export const lockReset = (db: D1Database, username: string, source: string): D1PreparedStatement =>
  db.prepare('DELETE FROM login_locks WHERE username = ?1 AND source = ?2').bind(username, source);

/** Housekeeping: forget pairs untouched for 30 days. */
export const lockPrune = (db: D1Database, now: Date): D1PreparedStatement =>
  db.prepare('DELETE FROM login_locks WHERE updated_at < ?').bind(iso(addMs(now, -30 * 86_400_000)));

/** Seconds to wait as told to the client: from locked_until, else the base lock. */
export function retryAfterSeconds(lockedUntil: string | null | undefined, now: Date): number {
  return lockedUntil ? Math.max(1, Math.ceil((Date.parse(lockedUntil) - now.getTime()) / 1000)) : LOCK_BASE_S;
}

/**
 * Lockout source of a request: the client's /24 (IPv4) or /48 (IPv6) from CF-Connecting-IP, else 'unknown'.
 * Keyed on a prefix rather than the exact address so one attacker cannot rotate through a /24 cheaply, and wide
 * enough that the owner's own CGNAT carrier does not share a key with the whole state.
 */
export function requestSource(c: Context<AppEnv>): string {
  return sourceOfIp(c.req.header('CF-Connecting-IP'));
}

export function sourceOfIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip.trim());
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  const v6 = expandIpv6(ip.trim());
  if (v6) return `${v6.slice(0, 3).join(':')}::/48`;
  return 'unknown';
}

/** Eight 4-hex-digit groups of an IPv6 address, or null when it does not parse. */
function expandIpv6(ip: string): string[] | null {
  if (!/^[0-9a-fA-F:.]{2,45}$/.test(ip)) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string): string[] | null => {
    if (s === '') return [];
    const groups = s.split(':');
    const out: string[] = [];
    for (const g of groups) {
      if (/^[0-9a-fA-F]{1,4}$/.test(g)) out.push(g.toLowerCase().padStart(4, '0'));
      else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(g)) {
        // embedded IPv4 (last 32 bits)
        const b = g.split('.').map((x) => Number.parseInt(x, 10));
        if (b.some((x) => x > 255)) return null;
        out.push(((b[0]! << 8) | b[1]!).toString(16).padStart(4, '0'), ((b[2]! << 8) | b[3]!).toString(16).padStart(4, '0'));
      } else return null;
    }
    return out;
  };
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  return [...head, ...Array.from({ length: missing }, () => '0000'), ...tail];
}

// ---------------------------------------------------------------- known devices

const KNOWN_PREFIX = 'kk-known-v1:';

/** `<device id>.<hex HMAC(PEPPER, 'kk-known-v1:' + device id)>`: proves this client logged in successfully before. */
export async function knownDeviceValue(pepper: string, deviceId: string): Promise<string> {
  return `${deviceId}.${toHex(await hmacSha256(pepper, KNOWN_PREFIX + deviceId))}`;
}

/** The known-device value a login request carries (header first, then the cookie), or null. */
export function readKnownDevice(c: Context<AppEnv>): string | null {
  const v = c.req.header(KNOWN_DEVICE_HEADER) ?? getCookie(c, KNOWN_DEVICE_COOKIE) ?? null;
  return v && v.length <= 160 ? v : null;
}

/**
 * The device id behind a known-device value when its MAC is right and the device was created by a login of the user
 * `username` (any state: a logged-out or revoked device still proves the client is known). null otherwise.
 */
export async function verifyKnownDevice(db: D1Database, pepper: string, value: string | null, username: string): Promise<string | null> {
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot < 1) return null;
  const id = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!/^[0-9a-f-]{1,64}$/.test(id) || !/^[0-9a-f]{64}$/.test(mac)) return null;
  const expected = toHex(await hmacSha256(pepper, KNOWN_PREFIX + id));
  if (!(await constantTimeEqual(mac, expected))) return null;
  const row = await db
    .prepare('SELECT d.id FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ?1 AND u.username = ?2')
    .bind(id, username)
    .first<{ id: string }>();
  return row ? row.id : null;
}
