/**
 * Security review of the Worker (auth, roles, pairing, throttle, cross-shop isolation, body abuse).
 *
 * Convention (same as review-ledger.test.ts): tests named `SEC-n` reproduce finding SEC-n of the review and assert
 * the corrected behaviour (they asserted the faulty behaviour until it was fixed). Tests named `OK` are attacks the
 * Worker already resisted; they guard the invariant.
 */
import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { PairResponse } from '../../shared/protocol';
import type { Bindings } from '../src/env';
import app from '../src/index';
import { addDevice, call, customer, entry, istToday, ORIGIN, owner, pair, pull, push, setup } from './helpers';

const utcDay = () => new Date().toISOString().slice(0, 10);
const openSlot = () => env.DB.prepare(`UPDATE pair_failures SET next_allowed_at = '2020-01-01T00:00:00.000Z'`).run();

/** Run one request through app.fetch with a replacement D1 binding. */
async function viaApp(db: D1Database, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${ORIGIN}/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { ...env, DB: db } as unknown as Bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ------------------------------------------------------------------------------------------- revoke
describe('revoke does not cut off what the revoked device minted', () => {
  it('SEC-1: recovery codes minted by a later-revoked owner phone die with it (no stolen-phone persistence)', async () => {
    const o = await owner();
    const stolen = await addDevice(o.token, 'owner', 'Second owner phone');
    // Thief, holding the unlocked second owner phone, mints recovery codes. This also DELETES the real owner's
    // unused recovery codes (replace-all semantics), so the shop's printed codes silently stop working.
    const rc = await call('POST', '/devices/recovery-codes', { token: stolen.token, body: { count: 3 } });
    expect(rc.status).toBe(200);
    // Owner notices and revokes the phone (with wipe).
    expect((await call('POST', `/devices/${stolen.device_id}/revoke`, { token: o.token, body: { wipe: true } })).status).toBe(200);
    expect((await call('GET', '/me', { token: stolen.token })).status).toBe(401);
    // ...and the thief's recovery codes (no expiry) were deleted in the same transaction as the revoke.
    for (const code of rc.body.codes as string[]) expect((await pair(code, { device_name: 'Thief' })).status).toBe(403);
    expect((await call('GET', '/me', { token: o.token })).status).toBe(200);
  });

  it('SEC-1b: re-pairing the SAME phone (previous_device_id) keeps the recovery codes it printed, and they stay revocable', async () => {
    const o = await owner();
    const rc = await call('POST', '/devices/recovery-codes', { token: o.token, body: { count: 3 } });
    // Forgot-PIN / lost Keystore key: the owner phone re-pairs with one printed code and names its old row
    const re = await pair(rc.body.codes[0], { device_name: 'Owner phone', previous_device_id: o.device_id });
    expect(re.status).toBe(200);
    expect((await call('GET', '/me', { token: o.token })).status).toBe(401);
    const left = await env.DB.prepare(`SELECT issued_by FROM pair_codes WHERE kind = 'recovery' AND used_at IS NULL`).all<{ issued_by: string }>();
    expect(left.results.map((r) => r.issued_by)).toEqual([re.body.device_id, re.body.device_id]);
    // the remaining printed codes still work...
    const spare = await addDevice(re.body.token, 'owner', 'Spare owner phone');
    expect((await pair(rc.body.codes[1], { device_name: 'Owner tablet' })).status).toBe(200);
    // ...and die when the device they now belong to is revoked
    expect((await call('POST', `/devices/${re.body.device_id}/revoke`, { token: spare.token, body: {} })).status).toBe(200);
    expect((await pair(rc.body.codes[2], { device_name: 'x' })).status).toBe(403);
  });

  it('SEC-2: an 8-digit OWNER pair code minted by a phone just before it was revoked dies with it', async () => {
    const o = await owner();
    const stolen = await addDevice(o.token, 'owner', 'Second owner phone');
    const pc = await call('POST', '/devices/pair-code', { token: stolen.token, body: { role: 'owner' } });
    expect((await call('POST', `/devices/${stolen.device_id}/revoke`, { token: o.token, body: {} })).status).toBe(200);
    const r = await pair(pc.body.code, { device_name: 'Thief 2' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('invalid_code');
  });
});

// ------------------------------------------------------------------------------------------- pair throttle
describe('pair throttle', () => {
  async function exhaust() {
    const limit = Number(env.PAIR_THROTTLE_AFTER);
    for (let i = 0; i < limit; i++) expect((await pair(String(20_000_000 + i))).status).toBe(403);
  }

  it('SEC-3: after 20 bad guesses by anyone, the owner\'s RECOVERY code still works (excluded from the throttle)', async () => {
    const o = await owner();
    const rc = await call('POST', '/devices/recovery-codes', { token: o.token, body: { count: 3 } });
    await exhaust();
    // a wrong recovery-shaped guess is not counted either
    expect((await pair('ZZZZ-ZZZZ-ZZZZ-ZZZZ')).status).toBe(403);
    const r = await pair(rc.body.codes[0], { device_name: 'Owner, new phone' });
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('owner');
    const f = await env.DB.prepare('SELECT count FROM pair_failures WHERE day = ?').bind(utcDay()).first<{ count: number }>();
    expect(f?.count).toBe(Number(env.PAIR_THROTTLE_AFTER));
  });

  it('SEC-4: junk bodies cannot spend the 30 s slot: they are refused before the throttle is touched', async () => {
    const s = await setup();
    await exhaust();
    await openSlot(); // the 30 s window has elapsed
    // junk bodies and codes of neither shape are refused without claiming the slot
    expect((await call('POST', '/pair', { body: {} })).status).toBe(400);
    expect((await pair('not-a-code')).status).toBe(403);
    // the owner, one second later, with a perfectly valid setup code
    const r = await pair(s.code, { device_name: 'Owner phone' });
    expect(r.status).toBe(200);
    // the successful attempt was given back: the day's count is still the number of failures
    const f = await env.DB.prepare('SELECT count FROM pair_failures WHERE day = ?').bind(utcDay()).first<{ count: number }>();
    expect(f?.count).toBe(Number(env.PAIR_THROTTLE_AFTER));
    // (a well-formed wrong 8-digit guess still claims a slot; the per-IP limiter below bounds one client)
  });

  it('SEC-5: the threshold is reserved atomically: a burst of N concurrent guesses gets at most PAIR_THROTTLE_AFTER through', async () => {
    await setup();
    const N = 40;
    const limit = Number(env.PAIR_THROTTLE_AFTER);
    const out = await Promise.all(Array.from({ length: N }, (_, i) => pair(String(30_000_000 + i), { device_name: 'x' })));
    const codes = out.map((r) => r.status);
    expect(codes.filter((x) => x === 403).length).toBe(limit);
    expect(codes.filter((x) => x === 429).length).toBe(N - limit);
    const f = await env.DB.prepare('SELECT count FROM pair_failures').first<{ count: number }>();
    expect(f?.count).toBe(limit);
  });

  it('SEC-5b: the per-IP limiter (Workers Rate Limiting) refuses one client after 10 /pair requests a minute', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await call('POST', '/pair', { body: {}, headers: { 'CF-Connecting-IP': '203.0.113.7' } });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(400));
    expect(statuses.slice(10)).toEqual([429, 429]);
    // another client is unaffected
    expect((await call('POST', '/pair', { body: {}, headers: { 'CF-Connecting-IP': '198.51.100.9' } })).status).toBe(400);
  });

  it('OK: a wrong guess burns no code, and past the threshold a valid code still works in its slot', async () => {
    const s = await setup();
    await exhaust();
    await openSlot();
    expect((await pair(s.code)).status).toBe(200);
  });

  it('OK: two concurrent pairs with one code -> exactly one device', async () => {
    const s = await setup();
    const [a, b] = await Promise.all([pair(s.code, { device_name: 'A' }), pair(s.code, { device_name: 'B' })]);
    expect([a.status, b.status].sort()).toEqual([200, 403]);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices').first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------- codes
describe('code entropy and normalisation', () => {
  it('OK: tokens are 43-char base64url (256 bit); stored only as sha256(token||PEPPER); codes stored hashed', async () => {
    const s = await setup();
    const o = (await pair(s.code)).body as PairResponse;
    expect(o.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const d = await env.DB.prepare('SELECT token_hash FROM devices').first<{ token_hash: string }>();
    expect(d?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(d?.token_hash).not.toContain(o.token);
    const codes = await env.DB.prepare('SELECT code_hash FROM pair_codes').all<{ code_hash: string }>();
    for (const c of codes.results) expect(c.code_hash).not.toContain(s.code);
  });

  it('SEC-6 (low): recovery codes are read the Crockford way: O/I/L typed for 0/1 still pair, with no throttle failure', async () => {
    const o = await owner();
    const rc = await call('POST', '/devices/recovery-codes', { token: o.token, body: { count: 5 } });
    const withDigit = (rc.body.codes as string[]).find((c) => /[01]/.test(c));
    if (!withDigit) return; // ~1e-7 chance that no code contains 0 or 1
    const misread = withDigit.replace(/0/g, 'O').replace(/1/g, 'I').toLowerCase();
    const r = await pair(misread.replace('i', 'l'), { device_name: 'Owner' }); // L reads as 1 too
    expect(r.status).toBe(200);
    const f = await env.DB.prepare('SELECT count FROM pair_failures').first<{ count: number }>();
    expect(f?.count ?? 0).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------- cross-shop
describe('cross-shop isolation (only reachable if a 2nd shop row ever exists: /setup only creates one)', () => {
  async function shopB() {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO shops (id, name, lang, sync_epoch, created_at) VALUES ('shop-b', 'B Stores', 'ta', 'e', ?)`).bind(now),
      env.DB.prepare(
        `INSERT INTO customers (id, shop_id, code, name, phone, created_at, updated_at, updated_by, received_at)
         VALUES ('11111111-1111-4111-8111-111111111111', 'shop-b', 7, 'B secret name', '+919999999999', ?1, ?1, 'x', ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO entries (id, shop_id, customer_id, kind, amount_paise, delta_paise, biz_date, device_id, created_at, received_at)
         VALUES ('22222222-2222-4222-8222-222222222222', 'shop-b', '11111111-1111-4111-8111-111111111111', 'GIVE', 999, 999, ?2, 'x', ?1, ?1)`,
      ).bind(now, istToday()),
    ]);
  }

  it('SEC-7 (low): another shop\'s customer/entry ids are refused, and pull never serves the other shop\'s rows', async () => {
    const o = await owner(); // shop A first: /setup reuses the OLDEST shop
    await shopB();
    const staff = await addDevice(o.token, 'staff');
    const k = customer({ id: '11111111-1111-4111-8111-111111111111', code: 900, name: 'mine' });
    const e = entry('11111111-1111-4111-8111-111111111111', 'GIVE', 5, { id: '22222222-2222-4222-8222-222222222222' });
    const e2 = entry('11111111-1111-4111-8111-111111111111', 'GIVE', 7);
    const r = await push(o.token, { customers: [k], entries: [e, e2] });
    expect(r.body.results.map((x) => x.reason ?? x.status)).toEqual(['MISMATCH', 'MISMATCH', 'BAD_ROW']);
    const p = await pull(staff.token);
    const rows = p.body.changes.map((c) => c.row as unknown as Record<string, unknown>);
    expect(rows.some((x) => x.name === 'B secret name' || x.phone === '+919999999999')).toBe(false);
    expect(rows.some((x) => x.amount_paise === 999)).toBe(false);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM entries WHERE id = ?`).bind(e2.id).first()).toEqual({ n: 0 });
    // even a change-log row pointing at another shop's row (e.g. written before this fix) is not served
    await env.DB.prepare(
      `INSERT INTO changelog (shop_id, tbl, row_id, device_id, received_at) VALUES (?, 'customers', '11111111-1111-4111-8111-111111111111', 'x', 'now')`,
    ).bind(o.shop.id).run();
    const p2 = await pull(staff.token);
    expect(p2.body.changes.some((c) => c.row.id === '11111111-1111-4111-8111-111111111111')).toBe(false);
  });

  it('OK: erase / revoke / previous_device_id / reversal targets of another shop are refused', async () => {
    const o = await owner();
    await shopB();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO devices (id, shop_id, name, role, token_hash, created_at) VALUES ('dev-b', 'shop-b', 'B', 'owner', 'h', ?)`,
    ).bind(now).run();
    expect((await call('POST', '/customers/11111111-1111-4111-8111-111111111111/erase', { token: o.token })).status).toBe(404);
    expect((await call('POST', '/devices/dev-b/revoke', { token: o.token, body: {} })).status).toBe(404);
    const pc = await call('POST', '/devices/pair-code', { token: o.token, body: { role: 'staff' } });
    expect((await pair(pc.body.code, { previous_device_id: 'dev-b' })).status).toBe(200);
    const b = await env.DB.prepare(`SELECT revoked_at FROM devices WHERE id = 'dev-b'`).first<{ revoked_at: string | null }>();
    expect(b?.revoked_at).toBeNull();
    const k = customer();
    await push(o.token, { customers: [k] });
    const rev = entry(k.id, 'REVERSAL', 999, { delta_paise: -999, reverses_entry_id: '22222222-2222-4222-8222-222222222222' });
    expect((await push(o.token, { entries: [rev] })).body.results[0]?.reason).toBe('UNKNOWN_ORIGINAL');
  });
});

// ------------------------------------------------------------------------------------------- auth + roles
describe('auth and roles', () => {
  it('OK: every non-public route answers 401 without a token, and staff gets 403 on every owner route', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const routes: [string, string, unknown?][] = [
      ['GET', '/me'],
      ['POST', '/devices/pair-code', { role: 'staff' }],
      ['POST', '/devices/recovery-codes', {}],
      ['POST', '/devices/code-block', {}],
      ['GET', '/devices'],
      ['POST', `/devices/${o.device_id}/revoke`, {}],
      ['PUT', '/shop', { name: 'x' }],
      ['POST', '/customers/00000000-0000-4000-8000-000000000000/erase'],
      ['POST', '/sync/push', { customers: [], entries: [] }],
      ['GET', '/sync/pull'],
      ['GET', '/export'],
    ];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, { body: b })).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, { body: b, token: 'A'.repeat(43) })).status, `${m} ${p} bad token`).toBe(401);
    }
    const ownerOnly = new Set(['/devices/pair-code', '/devices/recovery-codes', '/devices', `/devices/${o.device_id}/revoke`, '/shop', '/export']);
    for (const [m, p, b] of routes) {
      const r = await call(m, p, { body: b, token: s.token });
      if (ownerOnly.has(p) || p.endsWith('/erase')) expect(r.status, `${m} ${p}`).toBe(403);
      else expect(r.status, `${m} ${p}`).toBe(200);
    }
    // HEAD of an owner GET route is still guarded
    const h = await SELF.fetch(`${ORIGIN}/v1/export`, { method: 'HEAD', headers: { Authorization: `Bearer ${s.token}` } });
    expect(h.status).toBe(403);
  });

  it('OK: a revoked device is refused everywhere, including routes that take no body', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    await call('POST', `/devices/${s.device_id}/revoke`, { token: o.token, body: {} });
    for (const p of ['/me', '/sync/pull'] as const) expect((await call('GET', p, { token: s.token })).status).toBe(401);
    expect((await call('POST', '/sync/push', { token: s.token, body: { customers: [], entries: [] } })).status).toBe(401);
  });

  it('OK: /setup key compare is not prefix/length sensitive and a missing header is 403', async () => {
    await setup();
    for (const k of ['', 'test-setup-ke', 'TEST-SETUP-KEY', 'test-setup-keyX']) {
      expect((await call('POST', '/setup', { headers: { 'X-Setup-Key': k }, body: {} })).status, k).toBe(403);
    }
  });
});

// ------------------------------------------------------------------------------------------- body abuse
describe('JSON body abuse', () => {
  it('OK: deeply nested, wrong-typed or oversized bodies are 400/413, never 500', async () => {
    const o = await owner();
    const deep = '['.repeat(100_000) + ']'.repeat(100_000);
    expect((await call('POST', '/sync/push', { token: o.token, rawBody: deep })).status).toBe(400);
    const deepObj = '{"customers":' + '['.repeat(50_000) + ']'.repeat(50_000) + '}';
    expect((await call('POST', '/sync/push', { token: o.token, rawBody: deepObj })).status).toBe(400);
    const shapes: unknown[] = [
      null, 1, 'x', [], { customers: 'x' }, { customers: [1] }, { customers: [null] }, { entries: [[]] },
      { customers: [{ id: 5 }] }, { entries: [{ id: 'x'.repeat(65) }] },
      { customers: [{ id: 'a', code: { $gt: 1 }, name: ['x'] }] },
      { entries: [{ id: 'b', customer_id: { a: 1 }, reverses_entry_id: [1], delta_paise: '5', amount_paise: 1e400 }] },
      { customers: [{ id: '__proto__', __proto__: { code: 1 } }] },
    ];
    for (const b of shapes) {
      const r = await call('POST', '/sync/push', { token: o.token, rawBody: JSON.stringify(b) });
      expect([200, 400], JSON.stringify(b)).toContain(r.status);
    }
    for (const [m, p] of [['POST', '/devices/pair-code'], ['POST', '/devices/recovery-codes'], ['POST', '/devices/code-block'], ['PUT', '/shop'], ['POST', `/devices/x/revoke`]] as const) {
      for (const raw of ['[]', 'null', '"x"', '{"role":["owner"],"count":"5","max_local_code":-1,"name":1,"wipe":"yes"}', '{']) {
        const r = await call(m, p, { token: o.token, rawBody: raw });
        expect(r.status, `${m} ${p} ${raw}`).toBeLessThan(500);
      }
    }
    for (const raw of ['[]', 'null', '{"code":12345678,"device_name":"x"}', '{"code":"12345678","device_name":["x"]}', `{"code":"${'1'.repeat(65)}","device_name":"x"}`]) {
      expect((await call('POST', '/pair', { rawBody: raw })).status, raw).toBe(400);
    }
    // 256 KiB body limit, with and without Content-Length
    const big = JSON.stringify({ customers: [], entries: [], pad: 'x'.repeat(300 * 1024) });
    expect((await call('POST', '/sync/push', { token: o.token, rawBody: big })).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(new TextEncoder().encode(big));
        ctl.close();
      },
    });
    const r = await SELF.fetch(`${ORIGIN}/v1/sync/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.token}` },
      body: stream,
      // @ts-expect-error workerd accepts duplex for streamed request bodies
      duplex: 'half',
    });
    expect(r.status).toBe(413);
    // 20-row cap is checked before any per-row work
    const many = { customers: Array.from({ length: 21 }, () => ({})), entries: [] };
    expect((await call('POST', '/sync/push', { token: o.token, body: many })).status).toBe(413);
    // since/limit strings
    for (const q of ['since=-1', 'since=1e3', 'since=9999999999999999', 'limit=abc', 'since=0x10']) {
      expect((await call('GET', `/sync/pull?${q}`, { token: o.token })).status, q).toBe(400);
    }
  });
});

// ------------------------------------------------------------------------------------------- PEPPER, logs, CORS
describe('configuration, leaks and CORS', () => {
  it('OK: missing or empty PEPPER refuses /pair and authenticated routes (no token minted with an empty pepper)', async () => {
    for (const pepper of [undefined, '']) {
      const p = await viaApp(env.DB, 'POST', '/pair', { code: '12345678', device_name: 'x' }, {});
      expect(p.status).not.toBe(500); // control: with PEPPER from env the route works (403 invalid_code)
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request(`${ORIGIN}/v1/pair`, { method: 'POST', body: JSON.stringify({ code: '12345678', device_name: 'x' }) }),
        { ...env, PEPPER: pepper } as unknown as Bindings,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'misconfigured' });
    }
  });

  it('OK: errors carry no SQL, stack or token; 500s are generic', async () => {
    const o = await owner();
    const broken = new Proxy(env.DB, {
      get(t, k) {
        if (k === 'batch') return async () => { throw new Error('D1_ERROR: no such table: devices SELECT token_hash FROM devices'); };
        const v = Reflect.get(t, k) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as D1Database;
    const r = await viaApp(broken, 'GET', '/me', undefined, { Authorization: `Bearer ${o.token}` });
    expect(r).toEqual({ status: 500, body: { error: 'internal' } });
  });

  it('OK: CORS reflects only the app origins; no credentials header', async () => {
    const bad = await SELF.fetch(`${ORIGIN}/v1/me`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
    });
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const good = await SELF.fetch(`${ORIGIN}/v1/me`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://localhost', 'Access-Control-Request-Method': 'GET' },
    });
    expect(good.headers.get('Access-Control-Allow-Origin')).toBe('https://localhost');
    expect(good.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------- daily cap
describe('daily cap', () => {
  it('OK: the cap is per device and per UTC day; a capped device is refused before any route work', async () => {
    const o = await owner();
    const s = await addDevice(o.token, 'staff');
    const cap = Number(env.DAILY_REQUEST_CAP);
    await env.DB.prepare('UPDATE devices SET requests_today = ?, requests_day = ? WHERE id = ?').bind(cap, utcDay(), s.device_id).run();
    const r = await call('POST', '/sync/push', { token: s.token, body: { customers: [customer()], entries: [] } });
    expect(r.status).toBe(429);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM customers').first<{ n: number }>())?.n).toBe(0);
    expect((await call('GET', '/me', { token: o.token })).status).toBe(200);
    // yesterday's count resets
    await env.DB.prepare(`UPDATE devices SET requests_day = '2000-01-01' WHERE id = ?`).bind(s.device_id).run();
    expect((await call('GET', '/me', { token: s.token })).status).toBe(200);
  });
});
