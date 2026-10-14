/** WebCrypto helpers: hashing, constant-time comparison, random tokens and codes. */

const enc = new TextEncoder();

export async function sha256Bytes(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export async function sha256Hex(s: string): Promise<string> {
  const b = await sha256Bytes(s);
  let out = '';
  for (const x of b) out += x.toString(16).padStart(2, '0');
  return out;
}

/** hex sha256(secret || PEPPER): how tokens and pairing codes are stored. */
export const pepperHash = (secret: string, pepper: string): Promise<string> => sha256Hex(secret + pepper);

/** Constant-time string equality: compares fixed-length sha256 digests, so neither length nor prefix leaks. */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 256-bit device token, base64url (43 chars). */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Uniformly random decimal code of `digits` digits (rejection sampling, no modulo bias). */
export function randomDigits(digits = 8): string {
  const mod = 10 ** digits;
  const limit = Math.floor(2 ** 32 / mod) * mod;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const v = buf[0] ?? 0;
    if (v < limit) return String(v % mod).padStart(digits, '0');
  }
}

/** Crockford-style base32 alphabet without I, L, O, U (32 symbols, so `byte & 31` is uniform). */
export const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 16 random base32 characters (80 bits) displayed as XXXX-XXXX-XXXX-XXXX. */
export function randomRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of bytes) s += RECOVERY_ALPHABET[b & 31];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}

/**
 * Pairing/recovery code as hashed: spaces and dashes removed, upper case. A 16-character (recovery) code is read the
 * Crockford way: the look-alike letters a person may type from the printed page map to digits (O -> 0, I/L -> 1);
 * the alphabet has no I, L or O, so generated codes are unchanged. 8-digit codes are untouched.
 */
export function normaliseCode(s: string): string {
  const t = s.replace(/[\s-]+/g, '').toUpperCase();
  return t.length === 16 ? t.replace(/O/g, '0').replace(/[IL]/g, '1') : t;
}
