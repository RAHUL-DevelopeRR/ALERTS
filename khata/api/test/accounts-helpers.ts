import { SELF } from 'cloudflare:test';
import type { LoginResponse, PairResponse, UserInfo } from '../../shared/protocol';
import { call, ORIGIN, owner, type Res } from './helpers';

export const b64url = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const randomSalt = () => b64url(crypto.getRandomValues(new Uint8Array(16)));

/**
 * Stand-in for the client's PBKDF2 (the server cannot tell): SHA-256(password || salt). Tests that check the real
 * derivation use realClientKey().
 */
export async function fastClientKey(password: string, salt: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${password}\u0000${salt}`));
  return b64url(new Uint8Array(d));
}

/** What the app does: PBKDF2-HMAC-SHA256(password, salt, iterations, 32 bytes) with WebCrypto. */
export async function realClientKey(password: string, salt: string, iterations: number): Promise<string> {
  const pad = salt.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((salt.length + 3) % 4);
  const saltBytes = Uint8Array.from(atob(pad), (ch) => ch.charCodeAt(0));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, base, 256);
  return b64url(new Uint8Array(bits));
}

export const ITER = 600_000;

export async function passwordSet(password: string, iterations = ITER) {
  const salt = randomSalt();
  return { salt, iterations, client_key: await fastClientKey(password, salt) };
}

/** Paired owner phone + its own owner login ("ravi" / "owner-pass") linked with link_me. */
export async function ownerWithUser(): Promise<{ o: PairResponse; user: UserInfo; password: string }> {
  const o = await owner();
  const password = 'owner-pass';
  const r = await call('POST', '/users', {
    token: o.token,
    body: { username: 'ravi', display_name: 'Ravi', role: 'owner', link_me: true, ...(await passwordSet(password)) },
  });
  if (r.status !== 200) throw new Error(`create owner user failed ${r.status} ${JSON.stringify(r.body)}`);
  return { o, user: r.body.user, password };
}

export async function createUser(
  ownerToken: string,
  username: string,
  password: string | null,
  extra: { role?: 'owner' | 'staff'; display_name?: string; google_email?: string } = {},
): Promise<UserInfo> {
  const r = await call('POST', '/users', {
    token: ownerToken,
    body: {
      username,
      display_name: extra.display_name ?? username,
      role: extra.role ?? 'staff',
      ...(password === null ? {} : await passwordSet(password)),
      ...(extra.google_email ? { google_email: extra.google_email } : {}),
    },
  });
  if (r.status !== 200) throw new Error(`create user failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.user;
}

export const prelogin = (username: string) => call<{ salt: string; iterations: number }>('POST', '/auth/prelogin', { body: { username } });

/** Full password login the way the client does it: prelogin, derive, login. */
export async function login(
  username: string,
  password: string,
  extra: { client?: 'android' | 'web'; device_name?: string; previous_device_id?: string; max_local_code?: number } = {},
): Promise<Res<LoginResponse>> {
  const p = await prelogin(username);
  const client_key = await fastClientKey(password, p.body.salt);
  return call<LoginResponse>('POST', '/auth/login', {
    body: { username, client_key, device_name: extra.device_name ?? 'Login phone', client: extra.client ?? 'android', ...extra },
  });
}

/** The kk_session value from a login response's Set-Cookie. */
export function sessionCookie(res: Res): string {
  const sc = res.headers.get('Set-Cookie') ?? '';
  const m = /kk_session=([^;]*)/.exec(sc);
  if (!m?.[1]) throw new Error(`no kk_session cookie in ${sc}`);
  return m[1];
}

/** Request authenticated by the web cookie (+ the X-KK-Client header unless csrfHeader is false). */
export async function webCall<T = any>(
  method: string,
  path: string,
  cookie: string,
  opts: { body?: unknown; csrfHeader?: boolean } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = { Cookie: `kk_session=${cookie}` };
  if (opts.csrfHeader !== false) headers['X-KK-Client'] = 'web';
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await SELF.fetch(`${ORIGIN}/v1${path}`, { method, headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed as any, headers: res.headers };
}
