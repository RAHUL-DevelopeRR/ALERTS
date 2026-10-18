import { afterAll, describe, expect, it, vi } from 'vitest';
import { GOOGLE_JWKS_URL, resetGoogleKeyCache, verifyGoogleIdToken } from '../src/lib/google';
import { knownDeviceValue, verifyKnownDevice } from '../src/lib/lockout';
import { checkNonce, mintNonce } from '../src/lib/nonce';
import { checkClientKey, fakeSalt, passwordVerifier } from '../src/lib/password';
import { env } from 'cloudflare:test';
import { b64url, login, ownerWithUser, realClientKey } from './accounts-helpers';

/**
 * Workers Free allows 10 ms of CPU per request. These measure, inside workerd, the CPU-heavy pieces the new routes add
 * (local timers advance during execution, unlike production). Numbers are printed for the README.
 */

const PEPPER = 'cpu-test-pepper';
const time = async (n: number, fn: () => Promise<unknown>) => {
  for (let i = 0; i < 5; i++) await fn(); // warm up (JIT, key import cache)
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await fn();
  return (performance.now() - t0) / n;
};

afterAll(() => {
  vi.restoreAllMocks();
});

describe('free-plan CPU budget', () => {
  it('password verifier + constant-time compare and the fake salt take well under 1 ms', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const stored = await passwordVerifier(PEPPER, key);
    const verify = await time(500, () => checkClientKey(PEPPER, key, stored));
    const salt = await time(500, () => fakeSalt(PEPPER, 'some.user'));
    console.log(`cpu: verifier+compare ${(verify * 1000).toFixed(1)} us, fake salt ${(salt * 1000).toFixed(1)} us`);
    expect(verify).toBeLessThan(1);
    expect(salt).toBeLessThan(1);
  });

  it('nonce mint + check and the known-device MAC take well under 1 ms (step-up = one password check)', async () => {
    const mint = await time(300, () => mintNonce(PEPPER, new Date()));
    const nonce = await mintNonce(PEPPER, new Date());
    const check = await time(300, () => checkNonce(PEPPER, nonce, new Date()));
    const id = crypto.randomUUID();
    const known = await knownDeviceValue(PEPPER, id);
    const knownMac = await time(300, () => knownDeviceValue(PEPPER, id));
    // the full known-device check includes one indexed D1 SELECT (I/O, not CPU)
    const t0 = performance.now();
    await verifyKnownDevice(env.DB, PEPPER, known, 'nobody');
    const knownFull = performance.now() - t0;
    console.log(
      `cpu: nonce mint ${(mint * 1000).toFixed(1)} us, nonce check ${(check * 1000).toFixed(1)} us, known-device MAC ${(knownMac * 1000).toFixed(1)} us ` +
        `(full check incl. D1 ${knownFull.toFixed(2)} ms wall)`,
    );
    expect(mint).toBeLessThan(1);
    expect(check).toBeLessThan(1);
    expect(knownMac).toBeLessThan(1);
  });

  it('Google RS256 verification takes well under 2 ms (JWKS import under 5 ms)', async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const extra = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    const pub2 = (await crypto.subtle.exportKey('jwk', extra.publicKey)) as JsonWebKey;
    const body = JSON.stringify({
      keys: [
        { kty: 'RSA', n: pub.n, e: pub.e, kid: 'k1', alg: 'RS256', use: 'sig' },
        { kty: 'RSA', n: pub2.n, e: pub2.e, kid: 'k2', alg: 'RS256', use: 'sig' },
      ],
    });
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === GOOGLE_JWKS_URL) return new Response(body, { headers: { 'Cache-Control': 'public, max-age=3600' } });
      return realFetch(input, init);
    });
    const e = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
    const now = Math.floor(Date.now() / 1000);
    const h = e({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const p = e({ iss: 'https://accounts.google.com', aud: 'aud-1', sub: '42', email: 'a@b.co', email_verified: true, iat: now, exp: now + 3600 });
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${h}.${p}`)));
    const token = `${h}.${p}.${b64url(sig)}`;

    await resetGoogleKeyCache();
    const t0 = performance.now();
    const first = await verifyGoogleIdToken(token, ['aud-1']); // includes the (mocked) fetch + importing 2 RSA keys
    const firstMs = performance.now() - t0;
    expect(first.ok).toBe(true);
    const cached = await time(200, async () => {
      const v = await verifyGoogleIdToken(token, ['aud-1']);
      if (!v.ok) throw new Error('verify failed');
    });
    // CPU of a JWKS refresh = importing Google's (usually 2) RSA keys; the fetch and Cache API calls are I/O.
    const importMs = await time(50, () =>
      Promise.all(
        [pub, pub2].map((k) =>
          crypto.subtle.importKey('jwk', { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']),
        ),
      ),
    );
    console.log(
      `cpu: google verify (cached key) ${(cached * 1000).toFixed(1)} us, JWKS import (2 keys) ${(importMs * 1000).toFixed(1)} us, ` +
        `first call wall time incl. fetch + Cache API ${firstMs.toFixed(2)} ms`,
    );
    expect(cached).toBeLessThan(2);
    expect(importMs).toBeLessThan(5);
    expect(firstMs).toBeLessThan(100);
  });

  it('for comparison: the client-side PBKDF2 (600k) costs what the server no longer pays', async () => {
    const t0 = performance.now();
    await realClientKey('correct horse battery', 'AAAAAAAAAAAAAAAAAAAAAA', 600_000);
    const ms = performance.now() - t0;
    console.log(`cpu: PBKDF2-SHA256 600k in workerd ${ms.toFixed(0)} ms (runs on the phone / in the browser instead)`);
    expect(ms).toBeGreaterThan(10); // would blow the 10 ms Free limit on the server
  });

  it('a whole login request (wall time incl. local D1) stays small', async () => {
    const { password } = await ownerWithUser();
    await login('ravi', password); // warm
    const n = 10;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) expect((await login('ravi', password)).status).toBe(200);
    const per = (performance.now() - t0) / n;
    console.log(`wall: prelogin + login round trip ${per.toFixed(2)} ms (local D1 I/O included)`);
    expect(per).toBeLessThan(100);
  });
});
