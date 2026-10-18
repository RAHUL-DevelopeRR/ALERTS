import { NONCE_TTL_MIN } from '../../../shared/protocol';
import { base64url, constantTimeEqual, hmacSha256, pepperHash, toHex } from './crypto';
import { iso } from './time';

/**
 * Single-use nonces for Google sign-in. `<random 16 bytes b64url>.<expiry unix seconds>.<32 hex of HMAC(PEPPER)>`:
 * stateless to mint (no row), checked by MAC + expiry, then consumed by an INSERT into used_nonces (PRIMARY KEY, so a
 * replay within the TTL fails the insert). Expired rows are pruned opportunistically.
 */
const PREFIX = 'kk-nonce-v1:';
const NONCE_RE = /^[A-Za-z0-9_-]{22}\.\d{1,12}\.[0-9a-f]{32}$/;

async function mac(pepper: string, rand: string, exp: number): Promise<string> {
  return toHex(await hmacSha256(pepper, `${PREFIX}${rand}.${exp}`)).slice(0, 32);
}

export async function mintNonce(pepper: string, now: Date): Promise<string> {
  const rand = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const exp = Math.floor(now.getTime() / 1000) + NONCE_TTL_MIN * 60;
  return `${rand}.${exp}.${await mac(pepper, rand, exp)}`;
}

/** Checks shape, MAC and expiry (not single use). Returns the expiry instant, or null. */
export async function checkNonce(pepper: string, nonce: unknown, now: Date): Promise<Date | null> {
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return null;
  const [rand, expS, tag] = nonce.split('.') as [string, string, string];
  const exp = Number.parseInt(expS, 10);
  if (!Number.isFinite(exp) || exp * 1000 <= now.getTime()) return null;
  if (exp * 1000 > now.getTime() + (NONCE_TTL_MIN + 1) * 60_000) return null;
  if (!(await constantTimeEqual(tag, await mac(pepper, rand, exp)))) return null;
  return new Date(exp * 1000);
}

/** Consumes a checked nonce: true the first time, false on replay. Also prunes expired rows. */
export async function consumeNonce(db: D1Database, pepper: string, nonce: string, expires: Date, now: Date): Promise<boolean> {
  const hash = await pepperHash(nonce, pepper);
  const [, ins] = await db.batch([
    db.prepare('DELETE FROM used_nonces WHERE expires_at < ?').bind(iso(now)),
    db
      .prepare('INSERT OR IGNORE INTO used_nonces (nonce_hash, used_at, expires_at) VALUES (?1, ?2, ?3)')
      .bind(hash, iso(now), iso(expires)),
  ]);
  return (ins?.meta?.changes ?? 0) === 1;
}
