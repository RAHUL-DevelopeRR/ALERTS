import { describe, it, expect } from 'vitest';
import { ApiClient, ApiFailure, errorCodeFor, isDevHost, normalizePairCode, normalizeServerUrl } from '../src/sync/api';
import { SyncError } from '../src/sync/types';
import { FakeTimers } from './helpers/fake-server';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof SyncError ? e.code : `other:${String(e)}`;
  }
  return 'no-throw';
}

async function codeOfAsync(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof SyncError ? e.code : `other:${String(e)}`;
  }
  return 'no-throw';
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('normalizeServerUrl', () => {
  it('trims, adds https, strips trailing slashes and /v1, drops query and hash', () => {
    expect(normalizeServerUrl('  khata-api.shop.workers.dev/  ')).toBe('https://khata-api.shop.workers.dev');
    expect(normalizeServerUrl('https://khata-api.shop.workers.dev///')).toBe('https://khata-api.shop.workers.dev');
    expect(normalizeServerUrl('https://khata-api.shop.workers.dev/v1/')).toBe('https://khata-api.shop.workers.dev');
    expect(normalizeServerUrl('HTTPS://Example.COM/api/v1?x=1#y')).toBe('https://example.com/api');
    expect(normalizeServerUrl('example.com:8443')).toBe('https://example.com:8443');
  });

  it('allows http only for LAN / localhost dev hosts', () => {
    expect(normalizeServerUrl('http://192.168.1.20:8787')).toBe('http://192.168.1.20:8787');
    expect(normalizeServerUrl('http://localhost:8787/')).toBe('http://localhost:8787');
    expect(normalizeServerUrl('http://10.0.2.2:8787')).toBe('http://10.0.2.2:8787');
    expect(normalizeServerUrl('http://laptop.local:8787')).toBe('http://laptop.local:8787');
    expect(codeOf(() => normalizeServerUrl('http://khata-api.shop.workers.dev'))).toBe('bad_url');
    expect(codeOf(() => normalizeServerUrl('http://172.32.0.1'))).toBe('bad_url');
    expect(isDevHost('172.16.5.5')).toBe(true);
    expect(isDevHost('[::1]')).toBe(true);
    expect(isDevHost('8.8.8.8')).toBe(false);
    expect(isDevHost('999.168.1.1')).toBe(false);
  });

  it('rejects empty, non-http schemes and credentials', () => {
    for (const bad of ['', '   ', 'ftp://example.com', 'https://user:pw@example.com', 'https://', 'javascript://x']) {
      expect(codeOf(() => normalizeServerUrl(bad))).toBe('bad_url');
    }
  });
});

describe('normalizePairCode', () => {
  it('accepts 8 digits (spaces/dashes/Tamil digits) and 16-char recovery codes', () => {
    expect(normalizePairCode(' 1234 5678 ')).toBe('12345678');
    expect(normalizePairCode('1234-5678')).toBe('12345678');
    expect(normalizePairCode('௧௨௩௪௫௬௭௮')).toBe('12345678');
    expect(normalizePairCode('abcd-efgh-jkmn-pqrs')).toBe('ABCDEFGHJKMNPQRS');
  });
  it('rejects anything else without a request', () => {
    for (const bad of ['', '1234567', '123456789', 'abcd-efgh', '1234 567x']) expect(codeOf(() => normalizePairCode(bad))).toBe('invalid_code');
  });
});

describe('errorCodeFor', () => {
  it('maps statuses and bodies to SyncError codes', () => {
    expect(errorCodeFor(403, { error: 'invalid_code' }, '/pair')).toBe('invalid_code');
    expect(errorCodeFor(429, { error: 'throttled' }, '/pair')).toBe('throttled');
    expect(errorCodeFor(429, null, '/pair')).toBe('throttled');
    expect(errorCodeFor(429, { error: 'daily_cap' }, '/sync/push')).toBe('daily_cap');
    expect(errorCodeFor(429, null, '/sync/push')).toBe('daily_cap'); // Cloudflare 1027 HTML page
    expect(errorCodeFor(401, { error: 'revoked', wipe: true }, '/sync/pull')).toBe('revoked');
    expect(errorCodeFor(401, { error: 'unauthorized' }, '/sync/pull')).toBe('unauthorized');
    expect(errorCodeFor(403, { error: 'forbidden' }, '/devices')).toBe('forbidden');
    expect(errorCodeFor(404, { error: 'not_found' }, '/setup')).toBe('setup_disabled');
    expect(errorCodeFor(403, { error: 'forbidden' }, '/setup')).toBe('bad_setup_key');
    expect(errorCodeFor(413, { error: 'too_many_rows' }, '/sync/push')).toBe('too_many_rows');
    expect(errorCodeFor(500, { error: 'batch_failed' }, '/sync/push')).toBe('batch_failed');
    expect(errorCodeFor(500, { error: 'internal' }, '/sync/push')).toBe('server');
    expect(errorCodeFor(502, null, '/sync/push')).toBe('server');
    expect(errorCodeFor(503, null, '/sync/push')).toBe('server');
    expect(errorCodeFor(400, { error: 'cannot_revoke_self' }, '/devices/x/revoke')).toBe('cannot_revoke_self');
  });
});

describe('ApiClient', () => {
  it('sends /v1 paths, JSON and the bearer token', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const api = new ApiClient('https://h.example', async () => 'tok-1', {
      fetch: async (u, init) => {
        seen.push({ url: String(u), init: init ?? {} });
        return json(200, { results: [], server_time: 't', sync_epoch: 'e' });
      },
    });
    await api.push({ customers: [], entries: [] });
    expect(seen[0].url).toBe('https://h.example/v1/sync/push');
    const h = new Headers(seen[0].init.headers);
    expect(h.get('Authorization')).toBe('Bearer tok-1');
    expect(h.get('Content-Type')).toBe('application/json');
    expect(seen[0].init.body).toBe('{"customers":[],"entries":[]}');
  });

  it('sends no Authorization on /pair and /setup; X-Setup-Key on /setup', async () => {
    const seen: Headers[] = [];
    const api = new ApiClient('https://h.example', async () => 'tok-1', {
      fetch: async (_u, init) => {
        seen.push(new Headers(init?.headers));
        return json(200, { shop: { id: 's' }, code: '12345678', expires_at: 'x' });
      },
    });
    await api.setup('key-1', 'Shop');
    expect(seen[0].get('Authorization')).toBeNull();
    expect(seen[0].get('X-Setup-Key')).toBe('key-1');
  });

  it('maps fetch rejection to network, 401 to revoked with the wipe flag, non-JSON 2xx to server', async () => {
    const net = new ApiClient('https://h.example', async () => 't', { fetch: async () => Promise.reject(new TypeError('Failed to fetch')) });
    expect(await codeOfAsync(net.pull(0))).toBe('network');

    const rev = new ApiClient('https://h.example', async () => 't', { fetch: async () => json(401, { error: 'revoked', wipe: true }) });
    try {
      await rev.pull(0);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiFailure);
      expect((e as ApiFailure).code).toBe('revoked');
      expect((e as ApiFailure).wipe).toBe(true);
      expect((e as ApiFailure).status).toBe(401);
    }

    const html = new ApiClient('https://h.example', async () => 't', {
      fetch: async () => new Response('<html>captive</html>', { status: 200 }),
    });
    expect(await codeOfAsync(html.pull(0))).toBe('server');
    const missing = new ApiClient('https://h.example', async () => 't', { fetch: async () => json(200, { ok: true }) });
    expect(await codeOfAsync(missing.pull(0))).toBe('server');
  });

  it('does not call the server without a token (unpaired, never treated as revoked)', async () => {
    let calls = 0;
    const api = new ApiClient('https://h.example', async () => null, {
      fetch: async () => {
        calls++;
        return json(200, {});
      },
    });
    expect(await codeOfAsync(api.pull(0))).toBe('unpaired');
    expect(calls).toBe(0);
  });

  it('times out after 20 s even when fetch ignores the abort signal (CapacitorHttp POST)', async () => {
    const timers = new FakeTimers(0);
    let aborted = false;
    const api = new ApiClient('https://h.example', async () => 't', {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      fetch: (_u, init) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise<Response>(() => undefined); // never settles
      },
    });
    const p = codeOfAsync(api.push({ customers: [], entries: [] }));
    await Promise.resolve();
    await Promise.resolve();
    expect(timers.pending()).toEqual([20_000]);
    timers.advance(20_000);
    expect(await p).toBe('network');
    expect(aborted).toBe(true);
  });

  it('clears the timeout timer after a response', async () => {
    const timers = new FakeTimers(0);
    const api = new ApiClient('https://h.example', async () => 't', {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      fetch: async () => json(200, { changes: [], next_since: 0, has_more: false, devices: [], shop: {}, server_time: 't', sync_epoch: 'e' }),
    });
    await api.pull(0);
    expect(timers.pending()).toEqual([]);
  });

  it('returns the export as text', async () => {
    const api = new ApiClient('https://h.example', async () => 't', { fetch: async () => json(200, { format: 'kadan-kanakku-export' }) });
    expect(await api.exportText()).toBe('{"format":"kadan-kanakku-export"}');
  });
});
