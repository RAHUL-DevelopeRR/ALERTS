import { fromBase64url } from './crypto';

/**
 * Google ID token (OpenID Connect JWT) verification with WebCrypto only: RS256 signature against Google's JWKS,
 * iss, aud, exp/iat (5 min skew), email_verified. About 0.1-0.3 ms of CPU once the key is cached (see README).
 *
 * JWKS caching: a module-global map (per isolate) valid for the response's Cache-Control max-age, backed by the
 * Cache API so a fresh isolate in the same colo does not refetch. An unknown `kid` (Google rotated keys) forces one
 * refetch at most every 60 s.
 */

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS: ReadonlySet<string> = new Set(['accounts.google.com', 'https://accounts.google.com']);
const SKEW_S = 300;
const DEFAULT_MAX_AGE_S = 3600;
const MIN_REFETCH_MS = 60_000;

interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

interface KeyCache {
  keys: Map<string, CryptoKey>;
  expiresAt: number;
  fetchedAt: number;
}

let cache: KeyCache | null = null;
let inflight: Promise<KeyCache> | null = null;

/** Test hook: forget the cached keys (module global and Cache API). */
export async function resetGoogleKeyCache(): Promise<void> {
  cache = null;
  inflight = null;
  try {
    await caches.default.delete(GOOGLE_JWKS_URL);
  } catch {
    /* Cache API unavailable */
  }
}

function maxAgeOf(res: Response): number {
  const m = /max-age=(\d+)/i.exec(res.headers.get('Cache-Control') ?? '');
  const n = m?.[1] ? Number.parseInt(m[1], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 86_400) : DEFAULT_MAX_AGE_S;
}

async function importKeys(jwks: unknown): Promise<Map<string, CryptoKey>> {
  const out = new Map<string, CryptoKey>();
  const list = (jwks as { keys?: unknown })?.keys;
  if (!Array.isArray(list)) return out;
  for (const k of list as Jwk[]) {
    if (!k || k.kty !== 'RSA' || typeof k.kid !== 'string' || typeof k.n !== 'string' || typeof k.e !== 'string') continue;
    if (k.alg !== undefined && k.alg !== 'RS256') continue;
    if (k.use !== undefined && k.use !== 'sig') continue;
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      out.set(k.kid, key);
    } catch {
      /* skip malformed key */
    }
  }
  return out;
}

async function loadKeys(forceNetwork: boolean): Promise<KeyCache> {
  const now = Date.now();
  let res: Response | undefined;
  let edge: Cache | undefined;
  try {
    edge = caches.default;
  } catch {
    edge = undefined;
  }
  if (!forceNetwork && edge) res = (await edge.match(GOOGLE_JWKS_URL)) ?? undefined;
  let fromNetwork = false;
  if (!res) {
    res = await fetch(GOOGLE_JWKS_URL, { headers: { Accept: 'application/json' } });
    fromNetwork = true;
    if (!res.ok) throw new Error(`jwks http ${res.status}`);
  }
  const maxAge = maxAgeOf(res);
  const text = await res.text();
  if (fromNetwork && edge) {
    const copy = new Response(text, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${maxAge}` },
    });
    try {
      await edge.put(GOOGLE_JWKS_URL, copy);
    } catch {
      /* best effort */
    }
  }
  const keys = await importKeys(JSON.parse(text));
  return { keys, expiresAt: now + maxAge * 1000, fetchedAt: now };
}

async function keysFor(kid: string): Promise<CryptoKey | undefined> {
  const now = Date.now();
  if (!cache || cache.expiresAt <= now) {
    inflight ??= loadKeys(false).finally(() => (inflight = null));
    cache = await inflight;
  }
  let key = cache.keys.get(kid);
  if (!key && now - cache.fetchedAt >= MIN_REFETCH_MS) {
    // Key rotation: Google published a new key we have not seen. Bypass every cache once.
    cache = await loadKeys(true);
    key = cache.keys.get(kid);
  }
  return key;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
}

export type GoogleVerifyError = 'malformed' | 'alg' | 'kid' | 'signature' | 'iss' | 'aud' | 'expired' | 'iat' | 'email';

const dec = new TextDecoder();

function decodeJson(part: string | undefined): Record<string, unknown> | null {
  const b = fromBase64url(part);
  if (!b) return null;
  try {
    const v = JSON.parse(dec.decode(b)) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Verifies a Google ID token. `audiences` = accepted OAuth client ids; `nowMs` is injectable for tests. */
export async function verifyGoogleIdToken(
  token: string,
  audiences: readonly string[],
  nowMs = Date.now(),
): Promise<{ ok: true; identity: GoogleIdentity } | { ok: false; error: GoogleVerifyError }> {
  if (typeof token !== 'string' || token.length > 8192) return { ok: false, error: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, error: 'malformed' };
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJson(h);
  const payload = decodeJson(p);
  const sig = fromBase64url(s);
  if (!header || !payload || !sig) return { ok: false, error: 'malformed' };
  if (header.alg !== 'RS256') return { ok: false, error: 'alg' };
  if (typeof header.kid !== 'string' || header.kid.length > 200) return { ok: false, error: 'kid' };

  const key = await keysFor(header.kid);
  if (!key) return { ok: false, error: 'kid' };
  const signed = new TextEncoder().encode(`${h}.${p}`);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, signed);
  if (!valid) return { ok: false, error: 'signature' };

  if (typeof payload.iss !== 'string' || !GOOGLE_ISSUERS.has(payload.iss)) return { ok: false, error: 'iss' };
  const aud = payload.aud;
  const auds = Array.isArray(aud) ? aud : [aud];
  if (!auds.some((a) => typeof a === 'string' && audiences.includes(a))) return { ok: false, error: 'aud' };
  const nowS = Math.floor(nowMs / 1000);
  if (typeof payload.exp !== 'number' || payload.exp + SKEW_S < nowS) return { ok: false, error: 'expired' };
  if (typeof payload.iat !== 'number' || payload.iat - SKEW_S > nowS) return { ok: false, error: 'iat' };
  if (payload.email_verified !== true && payload.email_verified !== 'true') return { ok: false, error: 'email' };
  if (typeof payload.email !== 'string' || payload.email.length > 254 || !payload.email.includes('@')) {
    return { ok: false, error: 'email' };
  }
  if (typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 255) {
    return { ok: false, error: 'malformed' };
  }
  return {
    ok: true,
    identity: {
      sub: payload.sub,
      email: payload.email.trim().toLowerCase(),
      name: typeof payload.name === 'string' ? payload.name.slice(0, 60) : null,
    },
  };
}

/** GOOGLE_CLIENT_IDS var -> list (empty = Google sign-in off). */
export function googleAudiences(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}
