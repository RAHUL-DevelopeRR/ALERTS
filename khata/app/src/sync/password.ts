/**
 * Client-side password stretching (shared/protocol.ts "v2: accounts").
 *
 *   client_key = PBKDF2-HMAC-SHA256(NFC(password), base64url_decode(salt), iterations, 32 bytes)
 *
 * The password itself never leaves the device; the server stores only HMAC(PEPPER, client_key). The 600,000
 * iterations (OWASP) cost about 0.1 s on a laptop and up to a second or two on a budget phone's WebView, which is why
 * the UI shows "Signing in…" while this runs. WebCrypto only (Android System WebView 80+, every modern browser).
 *
 * Bytes on the wire are base64url WITHOUT padding: salt 16 bytes (22 chars), client_key 32 bytes (43 chars).
 */
import {
  CLIENT_KEY_BYTES,
  PBKDF2_DEFAULT_ITERATIONS,
  PBKDF2_MAX_ITERATIONS,
  PBKDF2_MIN_ITERATIONS,
  PW_SALT_BYTES,
  USERNAME_RE,
  type PasswordSet,
} from '../../../shared/protocol';
import { SyncError } from './types';

/** Shortest password the app accepts when one is set (the server does not see passwords, so this is the only check). */
export const PASSWORD_MIN_LENGTH = 8;

export function toBase64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes base64url (padding optional). Throws SyncError('bad_request') on malformed input. */
export function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new SyncError('bad_request', 'base64url');
  const clean = s.replace(/=+$/, '');
  const pad = clean.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((clean.length + 3) % 4);
  let bin: string;
  try {
    bin = atob(pad);
  } catch {
    throw new SyncError('bad_request', 'base64url');
  }
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A fresh random salt (PW_SALT_BYTES bytes, base64url). */
export function newSalt(): string {
  const bytes = new Uint8Array(PW_SALT_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64url(bytes);
}

/** Iteration count the server announced; refused outside the protocol bounds (a server must not weaken the client). */
export function checkIterations(iterations: unknown): number {
  if (!Number.isSafeInteger(iterations) || (iterations as number) < PBKDF2_MIN_ITERATIONS || (iterations as number) > PBKDF2_MAX_ITERATIONS) {
    throw new SyncError('server', 'iterations');
  }
  return iterations as number;
}

/** PBKDF2-HMAC-SHA256 of the NFC-normalised password; base64url of CLIENT_KEY_BYTES bytes. */
export async function deriveClientKey(password: string, saltB64url: string, iterations: number): Promise<string> {
  const salt = fromBase64url(saltB64url);
  if (salt.length !== PW_SALT_BYTES) throw new SyncError('server', 'salt');
  const iter = checkIterations(iterations);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new SyncError('local', 'WebCrypto unavailable');
  const base = await subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, CLIENT_KEY_BYTES * 8);
  return toBase64url(new Uint8Array(bits));
}

/** Throws SyncError('password_short') when the password is too short. Returns the password unchanged. */
export function checkNewPassword(password: string): string {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) throw new SyncError('password_short');
  return password;
}

/** Material for a NEW password: fresh salt, the default iteration count, and the derived key. */
export async function newPasswordSet(password: string, derive: typeof deriveClientKey = deriveClientKey): Promise<PasswordSet> {
  checkNewPassword(password);
  const salt = newSalt();
  return { salt, iterations: PBKDF2_DEFAULT_ITERATIONS, client_key: await derive(password, salt, PBKDF2_DEFAULT_ITERATIONS) };
}

/** Lower-cased, trimmed username; throws SyncError('bad_username') unless it matches USERNAME_RE. */
export function normalizeUsername(input: string): string {
  const u = (input ?? '').trim().toLowerCase();
  if (!USERNAME_RE.test(u)) throw new SyncError('bad_username');
  return u;
}
