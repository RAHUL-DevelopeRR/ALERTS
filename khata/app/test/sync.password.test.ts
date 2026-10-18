/**
 * Client-side password stretching (src/sync/password.ts): the derivation matches Node's PBKDF2 bit for bit, Unicode is
 * NFC-normalised, bounds are enforced, and the 600k-iteration cost is measured (printed, and sanity-capped).
 */
import { pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PBKDF2_DEFAULT_ITERATIONS, PBKDF2_MAX_ITERATIONS, PBKDF2_MIN_ITERATIONS } from '../../shared/protocol';
import {
  checkIterations,
  checkNewPassword,
  deriveClientKey,
  fromBase64url,
  newPasswordSet,
  newSalt,
  normalizeUsername,
  toBase64url,
} from '../src/sync/password';
import { SyncError } from '../src/sync/types';

const code = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return e instanceof SyncError ? e.code : `other:${String(e)}`;
  }
  return 'no-throw';
};

describe('base64url', () => {
  it('round-trips without padding', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 62, 63]);
    const s = toBase64url(bytes);
    expect(s).not.toMatch(/[+/=]/);
    expect([...fromBase64url(s)]).toEqual([...bytes]);
    expect([...fromBase64url(s + '=')]).toEqual([...bytes]);
  });
  it('refuses junk', async () => {
    expect(await code(() => fromBase64url('not base64!'))).toBe('bad_request');
  });
});

describe('deriveClientKey', () => {
  it('equals PBKDF2-HMAC-SHA256(password, salt, iterations, 32 bytes) and is 43 chars', async () => {
    const salt = newSalt();
    expect(salt).toHaveLength(22);
    const key = await deriveClientKey('owner-pass', salt, PBKDF2_MIN_ITERATIONS);
    const ref = pbkdf2Sync('owner-pass', Buffer.from(fromBase64url(salt)), PBKDF2_MIN_ITERATIONS, 32, 'sha256');
    expect(key).toBe(ref.toString('base64url'));
    expect(key).toHaveLength(43);
  });

  it('normalises the password to NFC (composed and decomposed Tamil/Latin input give one key)', async () => {
    const salt = newSalt();
    const composed = 'கடன்é-secret';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);
    expect(await deriveClientKey(decomposed, salt, PBKDF2_MIN_ITERATIONS)).toBe(await deriveClientKey(composed, salt, PBKDF2_MIN_ITERATIONS));
  });

  it('different salts or passwords give different keys', async () => {
    const a = newSalt();
    const b = newSalt();
    expect(a).not.toBe(b);
    expect(await deriveClientKey('pw1', a, PBKDF2_MIN_ITERATIONS)).not.toBe(await deriveClientKey('pw1', b, PBKDF2_MIN_ITERATIONS));
    expect(await deriveClientKey('pw1', a, PBKDF2_MIN_ITERATIONS)).not.toBe(await deriveClientKey('pw2', a, PBKDF2_MIN_ITERATIONS));
  });

  it('refuses iteration counts outside the protocol bounds and bad salts', async () => {
    const salt = newSalt();
    expect(await code(deriveClientKey('x', salt, 1000))).toBe('server');
    expect(await code(deriveClientKey('x', salt, PBKDF2_MAX_ITERATIONS + 1))).toBe('server');
    expect(await code(deriveClientKey('x', 'c2hvcnQ', PBKDF2_MIN_ITERATIONS))).toBe('server'); // 5 bytes, not 16
    expect(await code(deriveClientKey('x', 'not base64!', PBKDF2_MIN_ITERATIONS))).toBe('bad_request');
    expect(checkIterations(PBKDF2_DEFAULT_ITERATIONS)).toBe(PBKDF2_DEFAULT_ITERATIONS);
  });

  it(`measures the default ${PBKDF2_DEFAULT_ITERATIONS} iterations (what a login costs on the client)`, async () => {
    const salt = newSalt();
    const t0 = performance.now();
    const key = await deriveClientKey('measure-me-please', salt, PBKDF2_DEFAULT_ITERATIONS);
    const ms = Math.round(performance.now() - t0);
    console.info(`[password] PBKDF2-HMAC-SHA256 x ${PBKDF2_DEFAULT_ITERATIONS}: ${ms} ms in Node ${process.version}`);
    expect(key).toHaveLength(43);
    expect(ms).toBeLessThan(10_000);
  });
});

describe('newPasswordSet / checkNewPassword / normalizeUsername', () => {
  it('builds salt + default iterations + key, refusing short passwords', async () => {
    const set = await newPasswordSet('long-enough');
    expect(set.iterations).toBe(PBKDF2_DEFAULT_ITERATIONS);
    expect(set.salt).toHaveLength(22);
    expect(set.client_key).toBe(await deriveClientKey('long-enough', set.salt, PBKDF2_DEFAULT_ITERATIONS));
    expect(await code(newPasswordSet('short'))).toBe('password_short');
    expect(checkNewPassword('12345678')).toBe('12345678');
  });

  it('lower-cases and trims usernames and refuses bad ones', async () => {
    expect(normalizeUsername('  Ravi.Kumar_1 ')).toBe('ravi.kumar_1');
    expect(await code(() => normalizeUsername('ab'))).toBe('bad_username');
    expect(await code(() => normalizeUsername('has space'))).toBe('bad_username');
    expect(await code(() => normalizeUsername('ராமு'))).toBe('bad_username');
  });
});
