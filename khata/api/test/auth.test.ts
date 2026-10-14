import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CODE_BLOCK_SIZE, SETUP_CODE_TTL_MIN } from '../../shared/protocol';
import { addDevice, call, owner, pair, setup } from './helpers';

const utcDay = () => new Date().toISOString().slice(0, 10);

describe('health, setup, routing', () => {
  it('health answers ok without auth', async () => {
    const r = await call('GET', '/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it('unknown routes answer JSON 404', async () => {
    expect((await call('GET', '/nope')).body).toEqual({ error: 'not_found' });
    const root = await call('GET', '/../nothing-here');
    expect(root.status).toBe(404);
  });

  it('setup rejects a wrong or missing key with 403', async () => {
    const wrong = await call('POST', '/setup', { headers: { 'X-Setup-Key': 'nope' }, body: {} });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe('forbidden');
    expect((await call('POST', '/setup', { body: {} })).status).toBe(403);
    const shops = await env.DB.prepare('SELECT COUNT(*) AS n FROM shops').first<{ n: number }>();
    expect(shops?.n).toBe(0);
  });

  it('setup creates the shop once and mints 8-digit owner codes', async () => {
    const before = Date.now();
    const a = await setup('Murugan Stores');
    expect(a.shop.name).toBe('Murugan Stores');
    expect(a.shop.lang).toBe('ta');
    expect(a.code).toMatch(/^\d{8}$/);
    const ttl = Date.parse(a.expires_at) - before;
    expect(ttl).toBeGreaterThan(SETUP_CODE_TTL_MIN * 60_000 - 5_000);
    const b = await setup('Other name');
    expect(b.shop.id).toBe(a.shop.id);
    expect(b.shop.name).toBe('Murugan Stores');
    expect(b.code).not.toBe(a.code);
    const row = await env.DB.prepare(`SELECT kind, role, issued_by FROM pair_codes LIMIT 1`).first();
    expect(row).toEqual({ kind: 'setup', role: 'owner', issued_by: 'setup' });
    const seq = await env.DB.prepare(`SELECT value FROM seq WHERE name = 'customer_code'`).first<{ value: number }>();
    expect(seq?.value).toBe(0);
  });

  it('answers CORS preflight for the app origin only', async () => {
    const { SELF } = await import('cloudflare:test');
    const ok = await SELF.fetch('https://kadan.test/v1/sync/push', {
      method: 'OPTIONS',
      headers: { Origin: 'https://localhost', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
    });
    expect(ok.status).toBeLessThan(300);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://localhost');
    expect((ok.headers.get('Access-Control-Allow-Headers') ?? '').toLowerCase()).toContain('authorization');
    const bad = await SELF.fetch('https://kadan.test/v1/health', { headers: { Origin: 'https://evil.example' } });
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('pairing', () => {
  it('pairs the owner, then /me works', async () => {
    const s = await setup();
    const r = await pair(s.code, { device_name: 'Owner phone' });
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('owner');
    expect(r.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.body.shop.id).toBe(s.shop.id);
    expect(r.body.code_block).toEqual({ start: 1, end: CODE_BLOCK_SIZE });
    expect(typeof r.body.sync_epoch).toBe('string');
    const me = await call('GET', '/me', { token: r.body.token });
    expect(me.status).toBe(200);
    expect(me.body.device).toMatchObject({ id: r.body.device_id, name: 'Owner phone', role: 'owner', revoked_at: null });
    expect(me.body.shop.id).toBe(s.shop.id);
    expect(me.body.sync_epoch).toBe(r.body.sync_epoch);
    expect(Math.abs(Date.parse(me.body.server_time) - Date.now())).toBeLessThan(60_000);
    // the token is stored hashed, never in plaintext
    const stored = await env.DB.prepare('SELECT token_hash FROM devices WHERE id = ?').bind(r.body.device_id).first<{ token_hash: string }>();
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.token_hash).not.toContain(r.body.token);
  });

  it('accepts codes with spaces and dashes', async () => {
    const s = await setup();
    const spaced = `${s.code.slice(0, 4)} - ${s.code.slice(4)}`;
    expect((await pair(spaced)).status).toBe(200);
  });

  it('codes are single-use', async () => {
    const s = await setup();
    expect((await pair(s.code)).status).toBe(200);
    const again = await pair(s.code);
    expect(again.status).toBe(403);
    expect(again.body.error).toBe('invalid_code');
  });

  it('expired codes are refused', async () => {
    const s = await setup();
    await env.DB.prepare(`UPDATE pair_codes SET expires_at = '2020-01-01T00:00:00.000Z'`).run();
    const r = await pair(s.code);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('invalid_code');
  });

  it('validates the pair body', async () => {
    const s = await setup();
    expect((await call('POST', '/pair', { body: { code: s.code } })).status).toBe(400);
    expect((await call('POST', '/pair', { rawBody: '{not json', headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
    expect((await pair(s.code, { max_local_code: -1 })).status).toBe(400);
    expect((await pair(s.code)).status).toBe(200); // still unused after the bad requests
  });

  it('owner pair-code pairs a staff phone with the next code block', async () => {
    const o = await owner();
    const pc = await call('POST', '/devices/pair-code', { token: o.token, body: { role: 'staff' } });
    expect(pc.status).toBe(200);
    expect(pc.body.code).toMatch(/^\d{8}$/);
    expect(pc.body.role).toBe('staff');
    expect(Date.parse(pc.body.expires_at) - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    const s = await pair(pc.body.code, { device_name: 'Helper' });
    expect(s.status).toBe(200);
    expect(s.body.role).toBe('staff');
    expect(s.body.code_block).toEqual({ start: 51, end: 100 });
    expect((await call('POST', '/devices/pair-code', { token: o.token, body: { role: 'boss' } })).status).toBe(400);
  });

  it('recovery codes pair as owner and are single-use', async () => {
    const o = await owner();
    const r = await call('POST', '/devices/recovery-codes', { token: o.token, body: {} });
    expect(r.status).toBe(200);
    expect(r.body.codes).toHaveLength(5);
    for (const code of r.body.codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    const typed = (r.body.codes[0] as string).toLowerCase().replace(/-/g, ' ');
    const p = await pair(typed, { device_name: 'Replacement' });
    expect(p.status).toBe(200);
    expect(p.body.role).toBe('owner');
    expect((await pair(r.body.codes[0])).status).toBe(403);
    const rows = await env.DB.prepare(`SELECT expires_at, role FROM pair_codes WHERE kind = 'recovery'`).all();
    expect(rows.results.every((x) => x.expires_at === null && x.role === 'owner')).toBe(true);
  });

  it('re-issuing recovery codes replaces the unused ones only', async () => {
    const o = await owner();
    const first = (await call('POST', '/devices/recovery-codes', { token: o.token, body: { count: 3 } })).body.codes as string[];
    expect(first).toHaveLength(3);
    expect((await pair(first[0]!)).status).toBe(200);
    const second = (await call('POST', '/devices/recovery-codes', { token: o.token, body: { count: 4 } })).body.codes as string[];
    expect(second).toHaveLength(4);
    expect((await pair(first[1]!)).status).toBe(403);
    expect((await pair(second[0]!)).status).toBe(200);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM pair_codes WHERE kind = 'recovery'`).first<{ n: number }>();
    expect(n?.n).toBe(5); // 1 used from the first set + 4 new
    expect((await call('POST', '/devices/recovery-codes', { token: o.token, body: { count: 6 } })).status).toBe(400);
    expect((await call('POST', '/devices/recovery-codes', { token: o.token, body: { count: 2 } })).status).toBe(400);
  });

  it('throttles after PAIR_THROTTLE_AFTER failures without burning codes', async () => {
    const s = await setup();
    const limit = Number(env.PAIR_THROTTLE_AFTER);
    for (let i = 0; i < limit; i++) {
      const r = await pair(String(10_000_000 + i));
      expect(r.status).toBe(403);
    }
    const blocked = await pair(s.code);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('throttled');
    const f = await env.DB.prepare('SELECT count, next_allowed_at FROM pair_failures WHERE day = ?').bind(utcDay()).first<{ count: number; next_allowed_at: string }>();
    expect(f?.count).toBe(limit);
    expect(Date.parse(f!.next_allowed_at)).toBeGreaterThan(Date.now());
    // 30 s later (simulated): one attempt is let through, and the code still works
    await env.DB.prepare(`UPDATE pair_failures SET next_allowed_at = '2020-01-01T00:00:00.000Z'`).run();
    const ok = await pair(s.code);
    expect(ok.status).toBe(200);
    // the slot was consumed: the next immediate attempt waits again
    expect((await pair('12345678')).status).toBe(429);
    // a wrong guess in a later slot is counted and pushes the window again
    await env.DB.prepare(`UPDATE pair_failures SET next_allowed_at = '2020-01-01T00:00:00.000Z'`).run();
    expect((await pair('12345678')).status).toBe(403);
    const g = await env.DB.prepare('SELECT count FROM pair_failures').first<{ count: number }>();
    expect(g?.count).toBe(limit + 1);
    expect((await pair('12345679')).status).toBe(429);
  });

  it('revokes previous_device_id of the same shop on re-pair', async () => {
    const o = await owner();
    const pc = await call('POST', '/devices/pair-code', { token: o.token, body: { role: 'owner' } });
    const again = await pair(pc.body.code, { previous_device_id: o.device_id, device_name: 'Same phone' });
    expect(again.status).toBe(200);
    const old = await call('GET', '/me', { token: o.token });
    expect(old.status).toBe(401);
    expect(old.body).toEqual({ error: 'revoked', wipe: false });
    expect((await call('GET', '/me', { token: again.body.token })).status).toBe(200);
  });

  it('max_local_code raises the sequence and blocks never overlap', async () => {
    const o = await owner({ max_local_code: 42 });
    const b1 = o.code_block;
    expect(b1).toEqual({ start: 43, end: 92 });
    const staff = await addDevice(o.token, 'staff');
    const b2 = staff.code_block;
    const b3 = (await call('POST', '/devices/code-block', { token: staff.token, body: {} })).body;
    const b4 = (await call('POST', '/devices/code-block', { token: o.token, body: { max_local_code: 500 } })).body;
    const b5 = (await call('POST', '/devices/code-block', { token: o.token, body: { max_local_code: 10 } })).body;
    expect(b4.start).toBe(501);
    const blocks = [b1, b2, { start: b3.start, end: b3.end }, { start: b4.start, end: b4.end }, { start: b5.start, end: b5.end }];
    for (const b of blocks) expect(b.end - b.start + 1).toBe(CODE_BLOCK_SIZE);
    const sorted = [...blocks].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.start).toBeGreaterThan(sorted[i - 1]!.end);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM code_blocks').first<{ n: number }>();
    expect(rows?.n).toBe(5);
    expect(b3.sync_epoch).toBe(o.sync_epoch);
  });
});

describe('auth middleware and roles', () => {
  it('missing or invalid token -> 401 unauthorized', async () => {
    await owner();
    const none = await call('GET', '/me');
    expect(none.status).toBe(401);
    expect(none.body).toEqual({ error: 'unauthorized' });
    const bad = await call('GET', '/me', { token: 'A'.repeat(43) });
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: 'unauthorized' });
  });

  it('revoked with wipe -> 401 revoked wipe:true; self-revoke and unknown ids are refused', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    expect((await call('POST', `/devices/${o.device_id}/revoke`, { token: o.token, body: {} })).body).toEqual({ error: 'cannot_revoke_self' });
    expect((await call('POST', `/devices/${crypto.randomUUID()}/revoke`, { token: o.token, body: {} })).status).toBe(404);
    const r = await call('POST', `/devices/${s.device_id}/revoke`, { token: o.token, body: { wipe: true } });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const me = await call('GET', '/me', { token: s.token });
    expect(me.status).toBe(401);
    expect(me.body).toEqual({ error: 'revoked', wipe: true });
    const list = await call('GET', '/devices', { token: o.token });
    expect(list.body.devices).toHaveLength(2);
    expect(list.body.devices.find((d: any) => d.id === s.device_id).revoked_at).not.toBeNull();
  });

  it('staff cannot call owner routes', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const t = { token: s.token };
    const calls = [
      call('POST', '/devices/pair-code', { ...t, body: { role: 'staff' } }),
      call('POST', '/devices/recovery-codes', { ...t, body: {} }),
      call('GET', '/devices', t),
      call('POST', `/devices/${o.device_id}/revoke`, { ...t, body: {} }),
      call('PUT', '/shop', { ...t, body: { name: 'X' } }),
      call('POST', `/customers/${crypto.randomUUID()}/erase`, t),
      call('GET', '/export', t),
    ];
    for (const r of await Promise.all(calls)) {
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'forbidden' });
    }
    // but staff can use the shared routes
    expect((await call('GET', '/me', t)).status).toBe(200);
    expect((await call('POST', '/devices/code-block', { ...t, body: {} })).status).toBe(200);
  });

  it('daily request cap -> 429 daily_cap', async () => {
    const o = await owner();
    const cap = Number(env.DAILY_REQUEST_CAP);
    await env.DB.prepare('UPDATE devices SET requests_today = ?, requests_day = ? WHERE id = ?').bind(cap, utcDay(), o.device_id).run();
    const r = await call('GET', '/me', { token: o.token });
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('daily_cap');
    // a new UTC day resets the counter
    await env.DB.prepare(`UPDATE devices SET requests_day = '2020-01-01' WHERE id = ?`).bind(o.device_id).run();
    expect((await call('GET', '/me', { token: o.token })).status).toBe(200);
    const row = await env.DB.prepare('SELECT requests_today, last_seen_at FROM devices WHERE id = ?').bind(o.device_id).first<{ requests_today: number; last_seen_at: string }>();
    expect(row?.requests_today).toBe(1);
    expect(row?.last_seen_at).not.toBeNull();
  });

  it('PUT /shop validates and updates', async () => {
    const o = await owner();
    const ok = await call('PUT', '/shop', { token: o.token, body: { name: '  Murugan Stores ', upi_id: 'murugan.stores@okaxis', lang: 'en' } });
    expect(ok.status).toBe(200);
    expect(ok.body.shop).toMatchObject({ name: 'Murugan Stores', upi_id: 'murugan.stores@okaxis', lang: 'en' });
    expect(ok.body.sync_epoch).toBe(o.sync_epoch);
    expect((await call('PUT', '/shop', { token: o.token, body: { name: '' } })).status).toBe(400);
    expect((await call('PUT', '/shop', { token: o.token, body: { name: 'x'.repeat(81) } })).status).toBe(400);
    expect((await call('PUT', '/shop', { token: o.token, body: { upi_id: 'not-a-upi' } })).status).toBe(400);
    expect((await call('PUT', '/shop', { token: o.token, body: { lang: 'hi' } })).status).toBe(400);
    const cleared = await call('PUT', '/shop', { token: o.token, body: { upi_id: null } });
    expect(cleared.body.shop).toMatchObject({ name: 'Murugan Stores', upi_id: null, lang: 'en' });
  });
});
