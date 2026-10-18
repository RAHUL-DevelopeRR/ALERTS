import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// SELF calls the Worker directly (no asset router), so the asset tests go through the ASSETS binding, which is the
// same asset worker (it applies _headers and the SPA fallback). The router itself (run_worker_first: /v1/*) is checked
// against `wrangler dev` (README).
const assets = (path: string, init?: RequestInit) => env.ASSETS.fetch(`https://kadan.test${path}`, init);

describe('web app (Workers static assets)', () => {
  it('serves the web app at / with the security headers from _headers', async () => {
    const res = await assets('/', { headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type') ?? '').toMatch(/text\/html/);
    expect(await res.text()).toMatch(/<title>[^<]*Kadan/i);
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client");
    expect(csp).toContain("frame-ancestors 'none'");
    // Google Identity Services (F20): script, its stylesheet, its XHR and its iframe; sql.js needs wasm-unsafe-eval
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).toContain('https://accounts.google.com/gsi/client');
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style");
    expect(csp).toContain("connect-src 'self' https://accounts.google.com");
    expect(csp).toContain('frame-src https://accounts.google.com');
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Permissions-Policy') ?? '').toContain('microphone=(self)');
  });

  it('falls back to index.html for app routes (single-page application)', async () => {
    const res = await assets('/customers/42', { headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/<title>[^<]*Kadan/i);
    expect(res.headers.get('Content-Security-Policy') ?? '').toContain("default-src 'self'");
  });

  it('never serves the _headers file itself, and /v1 stays with the Worker', async () => {
    const h = await assets('/_headers');
    expect(await h.text()).not.toContain('Content-Security-Policy:');
    const api = await SELF.fetch('https://kadan.test/v1/nope');
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: 'not_found' });
  });
});
