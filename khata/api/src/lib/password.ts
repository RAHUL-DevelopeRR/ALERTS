import {
  CLIENT_KEY_BYTES,
  PBKDF2_MAX_ITERATIONS,
  PBKDF2_MIN_ITERATIONS,
  PW_SALT_BYTES,
  USERNAME_RE,
} from '../../../shared/protocol';
import { base64url, constantTimeEqual, fromBase64url, hmacSha256, toHex } from './crypto';

/**
 * Client-side key stretching (Bitwarden-style). The phone / browser runs PBKDF2-SHA256 (600k iterations by default)
 * and sends the 32-byte result (`client_key`). The server only computes ONE HMAC-SHA256 with the PEPPER secret, so a
 * login costs microseconds of CPU on the Workers Free plan, and a stolen D1 copy without the PEPPER is useless for
 * offline guessing (with the PEPPER, each guess still costs the full PBKDF2).
 */

/** Domain-separation prefix of the stored verifier (keeps it unrelated to the fake-salt HMAC below). */
const VERIFIER_PREFIX = new TextEncoder().encode('kk-pw-verifier-v1:');

/** hex HMAC-SHA256(PEPPER, prefix || client_key) as stored in users.pw_verifier. */
export async function passwordVerifier(pepper: string, clientKey: Uint8Array): Promise<string> {
  const msg = new Uint8Array(VERIFIER_PREFIX.length + clientKey.length);
  msg.set(VERIFIER_PREFIX, 0);
  msg.set(clientKey, VERIFIER_PREFIX.length);
  return toHex(await hmacSha256(pepper, msg));
}

/** A verifier-shaped value no real key maps to: compared against when the user does not exist (same work). */
const DUMMY_VERIFIER = '0'.repeat(64);

/** Constant-time check of client_key against a stored verifier (or the dummy when there is none). */
export async function checkClientKey(pepper: string, clientKey: Uint8Array, stored: string | null | undefined): Promise<boolean> {
  const v = await passwordVerifier(pepper, clientKey);
  const ok = await constantTimeEqual(v, stored ?? DUMMY_VERIFIER);
  return ok && typeof stored === 'string' && stored.length === 64;
}

/** Deterministic fake salt for unknown usernames: base64url(HMAC(PEPPER, 'salt:' + username)[0..16]). */
export async function fakeSalt(pepper: string, username: string): Promise<string> {
  const mac = await hmacSha256(pepper, `salt:${username}`);
  return base64url(mac.slice(0, PW_SALT_BYTES));
}

/** Lower-cases + trims, then checks USERNAME_RE. null when invalid. */
export function normaliseUsername(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 64) return null;
  const u = v.trim().toLowerCase();
  return USERNAME_RE.test(u) ? u : null;
}

export const parseClientKey = (v: unknown): Uint8Array | null => fromBase64url(v, CLIENT_KEY_BYTES);

export interface PasswordMaterial {
  salt: string;
  iterations: number;
  clientKey: Uint8Array;
}

/**
 * Validates {salt, iterations, client_key}. Returns the material, null when all three are absent, or the name of the
 * first bad field.
 */
export function parsePasswordSet(body: Record<string, unknown>): PasswordMaterial | null | string {
  const { salt, iterations, client_key } = body;
  if (salt === undefined && iterations === undefined && client_key === undefined) return null;
  if (!fromBase64url(salt, PW_SALT_BYTES)) return 'salt';
  if (
    typeof iterations !== 'number' ||
    !Number.isSafeInteger(iterations) ||
    iterations < PBKDF2_MIN_ITERATIONS ||
    iterations > PBKDF2_MAX_ITERATIONS
  ) {
    return 'iterations';
  }
  const clientKey = parseClientKey(client_key);
  if (!clientKey) return 'client_key';
  return { salt: salt as string, iterations, clientKey };
}


/** Lower-cased Google address, null for null, undefined when absent, 'invalid' otherwise. */
export function parseEmail(v: unknown): string | null | undefined | 'invalid' {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') return 'invalid';
  const e = v.trim().toLowerCase();
  if (e.length < 3 || e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'invalid';
  return e;
}

/** Display name: trimmed, 1-60 chars. */
export function parseDisplayName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length >= 1 && t.length <= 60 ? t : null;
}

/** Backoff after the 5th consecutive failure: 30 s doubling up to 15 min (SQL fragment needs ?now bound). */
export const LOCK_AFTER = 5;
export const LOCK_BASE_S = 30;
export const LOCK_MAX_S = 900;
