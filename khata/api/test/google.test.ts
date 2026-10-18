import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { GOOGLE_JWKS_URL, resetGoogleKeyCache, verifyGoogleIdToken } from '../src/lib/google';
import { mintNonce } from '../src/lib/nonce';
import { b64url, createUser, login, OWNER, ownerStepup, ownerWithUser, passwordSet, sessionCookie, webCall } from './accounts-helpers';
import { call, customer, push } from './helpers';

const WEB_AUD = 'web-client.apps.googleusercontent.com';
const ANDROID_AUD = 'android-client.apps.googleusercontent.com';

interface Signer {
  kid: string;
  key: CryptoKey;
  jwk: JsonWebKey & { kid: string; alg: string; use: string };
}

async function makeSigner(kid: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return { kid, key: pair.privateKey, jwk: { kty: 'RSA', n: pub.n, e: pub.e, kid, alg: 'RS256', use: 'sig' } };
}

const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

/** A fresh single-use nonce from the Worker (what the web app passes to Google Identity Services). */
export async function freshNonce(): Promise<string> {
  const r = await call<{ nonce: string }>('POST', '/auth/nonce');
  if (r.status !== 200) throw new Error(`nonce failed ${r.status}`);
  return r.body.nonce;
}

/** Signs an ID token; unless the claims name a `nonce` (even undefined), a fresh one from /auth/nonce is used. */
async function sign(signer: Signer, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  if (!('nonce' in claims)) claims = { ...claims, nonce: await freshNonce() };
  const h = enc({ alg: 'RS256', typ: 'JWT', kid: signer.kid, ...header });
  const p = enc(claims);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer.key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

const nowS = () => Math.floor(Date.now() / 1000);
const claims = (over: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: WEB_AUD,
  azp: WEB_AUD,
  sub: '1000000000000000001',
  email: 'kumar@gmail.com',
  email_verified: true,
  name: 'Kumar',
  iat: nowS() - 10,
  exp: nowS() + 3600,
  ...over,
});

let k1: Signer;
let k2: Signer;
let other: Signer;
let published: Signer[] = [];
let jwksFetches = 0;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  [k1, k2, other] = await Promise.all([makeSigner('k1'), makeSigner('k2'), makeSigner('k1')]);
  // The Worker runs in the same isolate as the tests, so this stands in for www.googleapis.com.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === GOOGLE_JWKS_URL) {
      jwksFetches++;
      return new Response(JSON.stringify({ keys: published.map((s) => s.jwk) }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=19800, must-revalidate, no-transform' },
      });
    }
    return realFetch(input, init);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  published = [k1];
  jwksFetches = 0;
  await resetGoogleKeyCache();
});

const google = (id_token: string, extra: Record<string, unknown> = {}) =>
  call('POST', '/auth/google', { body: { id_token, device_name: 'Chrome', client: 'web', ...extra } });

describe('POST /auth/google', () => {
  it('signs in a pre-registered email once, links google_sub, and then signs in by sub', async () => {
    const { o } = await ownerWithUser();
    const u = await createUser(o.token, 'kumar', null, { google_email: 'Kumar@GMail.com', role: 'owner' });
    const r = await google(await sign(k1, claims({ email: 'KUMAR@gmail.com' })));
    expect(r.status).toBe(200);
    expect(r.body.token).toBeNull();
    expect(r.body.user).toEqual({ id: u.id, username: 'kumar', display_name: 'kumar', role: 'owner' });
    expect(r.body.role).toBe('owner');
    const sc = r.headers.get('Set-Cookie') ?? '';
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    expect(await env.DB.prepare('SELECT google_sub FROM users WHERE id = ?').bind(u.id).first('google_sub')).toBe('1000000000000000001');
    const list = await call('GET', '/users', { token: o.token });
    expect(list.body.users.find((x: { id: string }) => x.id === u.id).google_linked).toBe(true);
    // the session works, and the device syncs
    const cookie = sessionCookie(r);
    expect((await webCall('GET', '/me', cookie)).body.user.id).toBe(u.id);
    expect(r.body.code_block).toBeNull(); // the web never creates customers offline
    const wb = await webCall('POST', '/devices/code-block', cookie, { body: {} });
    const pushed = await webCall('POST', '/sync/push', cookie, { body: { customers: [customer({ code: wb.body.start })], entries: [] } });
    expect(pushed.body.results[0].status).toBe('stored');
    // android client gets a bearer token; the Android client id is an accepted audience
    const a = await google(await sign(k1, claims({ aud: ANDROID_AUD })), { client: 'android' });
    expect(a.status).toBe(200);
    expect(a.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await push(a.body.token, { customers: [customer({ code: a.body.code_block.start })] })).status).toBe(200);
    // the JWKS was fetched once and cached
    expect(jwksFetches).toBe(1);
  });

  it('refuses bad tokens with 403 invalid_token', async () => {
    const { o } = await ownerWithUser();
    await createUser(o.token, 'kumar', null, { google_email: 'kumar@gmail.com', role: 'owner' });
    const cases: Array<[string, string]> = [
      ['aud', await sign(k1, claims({ aud: 'someone-else.apps.googleusercontent.com' }))],
      ['iss', await sign(k1, claims({ iss: 'https://evil.example' }))],
      ['expired', await sign(k1, claims({ iat: nowS() - 7200, exp: nowS() - 301 }))],
      ['iat', await sign(k1, claims({ iat: nowS() + 600 }))],
      ['email', await sign(k1, claims({ email_verified: false }))],
      ['email', await sign(k1, claims({ email_verified: undefined }))],
      ['signature', await sign(other, claims())], // same kid, different key
      ['kid', await sign(k2, claims())], // key not published
      ['alg', (await sign(k1, claims(), { alg: 'HS256' }))],
      ['alg', `${enc({ alg: 'none', kid: 'k1' })}.${enc(claims())}.`],
      ['malformed', 'not.a.jwt'],
    ];
    for (const [why, token] of cases) {
      const r = await google(token);
      expect(r.status, why).toBe(403);
      expect(r.body.error, why).toBe('invalid_token');
      expect(r.body.message, why).toBe(why);
    }
    // a token tampered after signing
    const good = await sign(k1, claims());
    const [h, , s] = good.split('.');
    const forged = `${h}.${enc(claims({ email: 'owner@gmail.com', nonce: 'x' }))}.${s}`;
    expect((await google(forged)).body.message).toBe('signature');
    // within the 5 minute skew is fine
    expect((await google(await sign(k1, claims({ exp: nowS() - 200 })))).status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE client = ?').bind('web').first('n')).toBe(1);
  });

  it('never creates users: an unknown email answers 403 not_linked', async () => {
    await ownerWithUser();
    const r = await google(await sign(k1, claims({ email: 'stranger@gmail.com', sub: '999' })));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('not_linked');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first('n')).toBe(1);
  });

  it('a second Google account (other sub) with the same email is refused once linked', async () => {
    const { o } = await ownerWithUser();
    await createUser(o.token, 'kumar', null, { google_email: 'kumar@gmail.com', role: 'owner' });
    expect((await google(await sign(k1, claims({ sub: 'sub-A' })))).status).toBe(200);
    const second = await google(await sign(k1, claims({ sub: 'sub-B' })));
    expect(second.status).toBe(403);
    expect(second.body.error).toBe('not_linked');
    expect((await google(await sign(k1, claims({ sub: 'sub-A' })))).status).toBe(200);
  });

  it('a disabled user cannot sign in with Google; changing google_email unlinks', async () => {
    const { o } = await ownerWithUser();
    const u = await createUser(o.token, 'kumar', 'k-pass', { google_email: 'kumar@gmail.com', role: 'owner' });
    expect((await google(await sign(k1, claims({ sub: 'sub-A' })))).status).toBe(200);
    expect((await call('PUT', `/users/${u.id}`, { token: o.token, headers: await ownerStepup(), body: { disabled: true } })).status).toBe(200);
    expect((await google(await sign(k1, claims({ sub: 'sub-A' })))).body.error).toBe('not_linked');
    expect((await call('PUT', `/users/${u.id}`, { token: o.token, body: { disabled: false, google_email: 'kumar.new@gmail.com' } })).status).toBe(200);
    expect((await google(await sign(k1, claims({ sub: 'sub-A' })))).body.error).toBe('not_linked');
    const relinked = await google(await sign(k1, claims({ sub: 'sub-C', email: 'kumar.new@gmail.com' })));
    expect(relinked.status).toBe(200);
  });

  it('refetches the JWKS once when Google rotates keys (unknown kid, at most once a minute)', async () => {
    const { o } = await ownerWithUser();
    await createUser(o.token, 'kumar', null, { google_email: 'kumar@gmail.com', role: 'owner' });
    expect((await google(await sign(k1, claims()))).status).toBe(200);
    expect(jwksFetches).toBe(1);
    published = [k1, k2];
    // within a minute of the last fetch an unknown kid does not hammer Google
    expect((await google(await sign(k2, claims()))).body.message).toBe('kid');
    expect(jwksFetches).toBe(1);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    try {
      const r = await google(await sign(k2, claims()));
      expect(r.status).toBe(200);
      expect(jwksFetches).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers 503 (not 500) when Google keys cannot be fetched', async () => {
    await ownerWithUser();
    published = [];
    const spy = vi.mocked(globalThis.fetch);
    spy.mockImplementationOnce(async () => new Response('down', { status: 502 }));
    const r = await google(await sign(k1, claims()));
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('unavailable');
  });

  it('validates the body', async () => {
    await ownerWithUser();
    expect((await call('POST', '/auth/google', { body: { device_name: 'x', client: 'web' } })).status).toBe(400);
    expect((await google(await sign(k1, claims()), { client: 'desktop' })).status).toBe(400);
    expect((await google('x'.repeat(9000))).status).toBe(400);
  });
});

describe('Google hardening (C, D, F)', () => {
  it('C. google_email must be a Google-owned domain (or GOOGLE_HD); setting it needs step-up and is audited', async () => {
    const { o } = await ownerWithUser();
    const base = { username: 'newbie', display_name: 'N', role: 'staff' };
    for (const bad of ['kumar@yahoo.com', 'kumar@rediffmail.com', 'kumar@gmail.com.evil.in', 'kumar@murugan-stores.in.example']) {
      const r = await call('POST', '/users', { token: o.token, body: { ...base, google_email: bad } });
      expect(r.status, bad).toBe(400);
      expect(r.body.message, bad).toBe('google_email_domain');
    }
    const hdr = await ownerStepup(); // the bad ones above were refused by validation, before step-up
    for (const good of ['Kumar@Gmail.com', 'kumar@googlemail.com', 'kumar@Murugan-Stores.in']) {
      const r = await call('POST', '/users', { token: o.token, headers: hdr, body: { ...base, username: `u${good.length}${good.indexOf('@')}`, google_email: good } });
      expect(r.status, good).toBe(200);
      expect(r.body.user.google_email).toBe(good.toLowerCase());
      expect(r.body.user.google_email_expires_at).toBeTruthy();
    }
    const u = await createUser(o.token, 'selvi', 's-pass');
    expect(u.google_email_expires_at).toBeNull();
    await env.DB.prepare(`UPDATE devices SET stepup_until = NULL WHERE id = ?`).bind(o.device_id).run();
    const need = await call('PUT', `/users/${u.id}`, { token: o.token, body: { google_email: 'selvi@gmail.com' } });
    expect(need.status).toBe(403);
    expect(need.body.error).toBe('stepup_required');
    const bad = await call('PUT', `/users/${u.id}`, { token: o.token, headers: await ownerStepup(), body: { google_email: 'selvi@hotmail.com' } });
    expect(bad.body.message).toBe('google_email_domain'); // validation runs before step-up: no window opened
    const ok = await call('PUT', `/users/${u.id}`, { token: o.token, headers: await ownerStepup(), body: { google_email: 'selvi@gmail.com' } });
    expect(ok.status).toBe(200);
    const hours = (Date.parse(ok.body.user.google_email_expires_at) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47.9);
    expect(hours).toBeLessThanOrEqual(48);
    const ev = await env.DB.prepare(`SELECT detail FROM auth_events WHERE action = 'user.update' AND target_user_id = ?`).bind(u.id).first<string>('detail');
    expect(JSON.parse(ev!)).toEqual({ google_email: 'selvi@gmail.com' });
  });

  it('C. an unlinked pre-registered address expires after 48 h; a linked one does not', async () => {
    const { o } = await ownerWithUser();
    const u = await createUser(o.token, 'kumar', null, { google_email: 'kumar@gmail.com', role: 'owner' });
    const old = new Date(Date.now() - 49 * 3_600_000).toISOString();
    await env.DB.prepare('UPDATE users SET google_email_set_at = ? WHERE id = ?').bind(old, u.id).run();
    const late = await google(await sign(k1, claims()));
    expect(late.status).toBe(403);
    expect(late.body.error).toBe('not_linked');
    expect(await env.DB.prepare('SELECT google_sub FROM users WHERE id = ?').bind(u.id).first('google_sub')).toBeNull();
    // the owner sets it again: a fresh window
    expect((await call('PUT', `/users/${u.id}`, { token: o.token, headers: await ownerStepup(), body: { google_email: 'kumar@gmail.com' } })).status).toBe(200);
    expect((await google(await sign(k1, claims()))).status).toBe(200);
    // once linked by sub the age of the pre-registration no longer matters
    await env.DB.prepare('UPDATE users SET google_email_set_at = ? WHERE id = ?').bind(old, u.id).run();
    expect((await google(await sign(k1, claims()))).status).toBe(200);
    const list = await call('GET', '/users', { token: o.token });
    expect(list.body.users.find((x: { id: string }) => x.id === u.id).google_email_expires_at).toBeNull();
  });

  it('C. the ID token must carry a live, unused nonce from POST /auth/nonce', async () => {
    const { o } = await ownerWithUser();
    await createUser(o.token, 'kumar', null, { google_email: 'kumar@gmail.com', role: 'owner' });
    const n = await call('POST', '/auth/nonce');
    expect(n.status).toBe(200);
    expect(n.body.nonce).toMatch(/^[A-Za-z0-9_-]{22}\.\d+\.[0-9a-f]{32}$/);
    const cases: Array<[string, Record<string, unknown>]> = [
      ['missing', { nonce: undefined }],
      ['garbage', { nonce: 'not-a-nonce' }],
      ['tampered', { nonce: `${n.body.nonce.slice(0, -1)}${n.body.nonce.endsWith('0') ? '1' : '0'}` }],
      ['expired', { nonce: await mintNonce('test-pepper', new Date(Date.now() - 11 * 60_000)) }],
      ['other pepper', { nonce: await mintNonce('another-pepper', new Date()) }],
    ];
    for (const [why, over] of cases) {
      const r = await google(await sign(k1, claims(over)));
      expect(r.status, why).toBe(403);
      expect(r.body, why).toEqual({ error: 'invalid_token', message: 'nonce' });
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE client = ?').bind('web').first('n')).toBe(0);
    // a good one works once: the same token replayed (or another token with the same nonce) is refused
    const token = await sign(k1, claims({ nonce: n.body.nonce }));
    expect((await google(token)).status).toBe(200);
    const replay = await google(token);
    expect(replay.status).toBe(403);
    expect(replay.body.message).toBe('nonce');
    expect((await google(await sign(k1, claims({ nonce: n.body.nonce })))).body.message).toBe('nonce');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM used_nonces').first('n')).toBe(1);
    // a nonce consumed by a sign-in that then fails (not_linked) is spent too
    const n2 = await call('POST', '/auth/nonce');
    expect((await google(await sign(k1, claims({ nonce: n2.body.nonce, email: 'nobody@gmail.com', sub: '7' })))).body.error).toBe('not_linked');
    expect((await google(await sign(k1, claims({ nonce: n2.body.nonce })))).body.message).toBe('nonce');
  });

  it('D. staff on the web via Google is refused (403 web_owner_only); the phone app works', async () => {
    const { o } = await ownerWithUser();
    await createUser(o.token, 'kumar', null, { google_email: 'kumar@gmail.com', role: 'staff' });
    const w = await google(await sign(k1, claims()));
    expect(w.status).toBe(403);
    expect(w.body).toEqual({ error: 'web_owner_only' });
    expect(w.headers.get('Set-Cookie')).toBeNull();
    const a = await google(await sign(k1, claims({ aud: ANDROID_AUD })), { client: 'android' });
    expect(a.status).toBe(200);
    expect(a.body.role).toBe('staff');
  });

  it('F. client android accepts only GOOGLE_ANDROID_CLIENT_IDS audiences; web never accepts the android id', async () => {
    const { o } = await ownerWithUser();
    await createUser(o.token, 'kumar', null, { google_email: 'kumar@gmail.com', role: 'owner' });
    const webTokenOnAndroid = await google(await sign(k1, claims({ aud: WEB_AUD })), { client: 'android' });
    expect(webTokenOnAndroid.status).toBe(403);
    expect(webTokenOnAndroid.body.message).toBe('aud');
    const androidTokenOnWeb = await google(await sign(k1, claims({ aud: ANDROID_AUD })), { client: 'web' });
    expect(androidTokenOnWeb.status).toBe(403);
    expect(androidTokenOnWeb.body.message).toBe('aud');
    const ok = await google(await sign(k1, claims({ aud: ANDROID_AUD })), { client: 'android' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ok.body.code_block).not.toBeNull();
    // with no Android ids configured, android Google logins are 404 while the web still works
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('https://kadan.test/v1/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_token: await sign(k1, claims({ aud: ANDROID_AUD })), device_name: 'Phone', client: 'android' }),
      }),
      { ...env, GOOGLE_ANDROID_CLIENT_IDS: '' },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
    expect((await google(await sign(k1, claims()))).status).toBe(200);
  });

  it('F. a Google web login gets no code block and the known-device cookie; password users unaffected', async () => {
    const { o } = await ownerWithUser();
    await createUser(o.token, 'kumar', null, { google_email: 'kumar@gmail.com', role: 'owner' });
    const r = await google(await sign(k1, claims()));
    expect(r.status).toBe(200);
    expect(r.body.code_block).toBeNull();
    expect(r.body.known_device).toMatch(new RegExp(`^${r.body.device_id}\\.[0-9a-f]{64}$`));
    expect(r.headers.get('Set-Cookie') ?? '').toMatch(/kk_known=/);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM code_blocks`).first('n')).toBe(1); // only the paired phone's
    expect((await login(OWNER.username, OWNER.password)).body.code_block).not.toBeNull();
    expect((await passwordSet('x')).iterations).toBe(600_000);
  });
});

describe('Google sign-in switched off', () => {
  async function direct(path: string, init: RequestInit = {}) {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`https://kadan.test/v1${path}`, init), { ...env, GOOGLE_CLIENT_IDS: '' }, ctx);
    await waitOnExecutionContext(ctx);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('answers 404 and /config reports google_client_id: null', async () => {
    const token = await sign(k1, claims());
    const r = await direct('/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_token: token, device_name: 'Chrome', client: 'web' }),
    });
    expect(r.status).toBe(404);
    // and no nonce is handed out while every list is empty
    const ctx = createExecutionContext();
    const n = await app.fetch(new Request('https://kadan.test/v1/auth/nonce', { method: 'POST' }), { ...env, GOOGLE_CLIENT_IDS: '', GOOGLE_ANDROID_CLIENT_IDS: '' }, ctx);
    await waitOnExecutionContext(ctx);
    expect(n.status).toBe(404);
    const cfg = await direct('/config');
    expect(cfg.status).toBe(200);
    expect(cfg.body.google_client_id).toBeNull();
    expect(cfg.body.auth).toEqual({ password: true });
  });
});

describe('verifyGoogleIdToken (unit)', () => {
  it('accepts both issuer spellings and an aud array', async () => {
    for (const iss of ['accounts.google.com', 'https://accounts.google.com']) {
      const v = await verifyGoogleIdToken(await sign(k1, claims({ iss })), [WEB_AUD]);
      expect(v).toEqual({ ok: true, identity: { sub: '1000000000000000001', email: 'kumar@gmail.com', name: 'Kumar', nonce: expect.any(String) } });
    }
    const arr = await verifyGoogleIdToken(await sign(k1, claims({ aud: ['x', WEB_AUD] })), [WEB_AUD]);
    expect(arr.ok).toBe(true);
    const none = await verifyGoogleIdToken(await sign(k1, claims()), []);
    expect(none).toEqual({ ok: false, error: 'aud' });
  });

  it('a GOOGLE_HD address must carry the matching hd claim (Workspace account), other addresses never need one', async () => {
    const ws = claims({ email: 'ravi@murugan-stores.in', hd: 'murugan-stores.in' });
    expect((await verifyGoogleIdToken(await sign(k1, ws), [WEB_AUD], Date.now(), 'Murugan-Stores.in')).ok).toBe(true);
    const consumer = claims({ email: 'ravi@murugan-stores.in' });
    expect(await verifyGoogleIdToken(await sign(k1, consumer), [WEB_AUD], Date.now(), 'murugan-stores.in')).toEqual({ ok: false, error: 'hd' });
    const other = claims({ email: 'ravi@murugan-stores.in', hd: 'other.in' });
    expect(await verifyGoogleIdToken(await sign(k1, other), [WEB_AUD], Date.now(), 'murugan-stores.in')).toEqual({ ok: false, error: 'hd' });
    // gmail users are unaffected by the var; without the var the claim is not checked
    expect((await verifyGoogleIdToken(await sign(k1, claims()), [WEB_AUD], Date.now(), 'murugan-stores.in')).ok).toBe(true);
    expect((await verifyGoogleIdToken(await sign(k1, consumer), [WEB_AUD])).ok).toBe(true);
  });

  it('checks exp/iat against the injected clock with 5 minutes of skew', async () => {
    const t = await sign(k1, claims({ iat: 1_000_000, exp: 1_003_600 }));
    expect((await verifyGoogleIdToken(t, [WEB_AUD], 1_003_600_000 + 299_000)).ok).toBe(true);
    expect(await verifyGoogleIdToken(t, [WEB_AUD], 1_003_600_000 + 301_000)).toEqual({ ok: false, error: 'expired' });
    expect(await verifyGoogleIdToken(t, [WEB_AUD], 1_000_000_000 - 301_000)).toEqual({ ok: false, error: 'iat' });
  });
});
