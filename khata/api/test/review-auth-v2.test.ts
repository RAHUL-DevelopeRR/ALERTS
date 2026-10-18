/**
 * Security review of the v2 accounts code against plan-findings 5-7 and 12-20 (second pass, after the hardening
 * build). Two groups:
 *   R1. contract checks that PROVE a finding is fixed (all pass);
 *   R2. gaps found by the review, since fixed (each test asserts the correct behaviour; they were `it.fails` while the
 *       gap existed).
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PBKDF2_DEFAULT_ITERATIONS, PBKDF2_MIN_ITERATIONS } from '../../shared/protocol';
import { createUser, login, OWNER, ownerStepup, ownerWithUser, passwordSet, prelogin, sessionCookie, stepup, webCall } from './accounts-helpers';
import { call, customer, owner, pull, push } from './helpers';

const utcDay = () => new Date().toISOString().slice(0, 10);
const from = (ip: string) => ({ 'CF-Connecting-IP': ip });
const dailyCount = async () => (await env.DB.prepare('SELECT count FROM auth_failures WHERE day = ?').bind(utcDay()).first<number>('count')) ?? 0;
/** The named cookie's attributes out of a Set-Cookie header holding several cookies. */
const cookiePart = (res: { headers: Headers }, name: string): string =>
  (res.headers.get('Set-Cookie') ?? '').split(/,(?=\s*kk_)/).find((x) => x.trim().startsWith(`${name}=`)) ?? '';

// ================================================================================================ R1: fixed
describe('R1. verified fixes (contracts beyond hardening.test.ts)', () => {
  it('R1a [F5/F17/F19] web login: cookie flags, token null, code_block null, CSRF header on every method, transport binding', async () => {
    const { password } = await ownerWithUser();
    const w = await login(OWNER.username, password, { client: 'web' });
    expect(w.status).toBe(200);
    expect(w.body.token).toBeNull();
    expect(w.body.code_block).toBeNull();
    const session = cookiePart(w, 'kk_session');
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/Secure/i);
    expect(session).toMatch(/SameSite=Strict/i);
    expect(session).toMatch(/Path=\/v1/);
    expect(session).toMatch(/Max-Age=2592000/);
    const cookie = sessionCookie(w);
    // a 50-code block is not burnt per web login (F19): no code_blocks row for the web device
    const blocks = await env.DB.prepare('SELECT COUNT(*) AS n FROM code_blocks WHERE device_id = ?').bind(w.body.device_id).first<number>('n');
    expect(blocks).toBe(0);
    // CSRF header: required on GET and on POST
    expect((await webCall('GET', '/me', cookie, { csrfHeader: false })).body.error).toBe('csrf');
    expect((await webCall('POST', '/sync/push', cookie, { csrfHeader: false, body: { customers: [], entries: [] } })).body.error).toBe('csrf');
    expect((await webCall('GET', '/me', cookie)).status).toBe(200);
    // the cookie value is never a bearer token
    expect((await call('GET', '/me', { token: cookie })).status).toBe(401);
  });

  it('R1b [F12] PBKDF2 floor: only 600,000 is stored; cheaper verifiers are refused on create and on password set; prelogin says 600k', async () => {
    expect(PBKDF2_MIN_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    expect(PBKDF2_DEFAULT_ITERATIONS).toBe(600_000);
    const { o, user } = await ownerWithUser();
    const cheap = await passwordSet('cheap-pass', 300_000);
    const made = await call('POST', '/users', { token: o.token, headers: await ownerStepup(), body: { username: 'weak', display_name: 'W', role: 'staff', ...cheap } });
    expect(made.status).toBe(400);
    expect(made.body.message).toBe('iterations');
    const reset = await call('PUT', `/users/${user.id}/password`, {
      token: o.token,
      body: { ...cheap, current_client_key: (await stepup(OWNER.username, OWNER.password))['X-KK-Stepup'] },
    });
    expect(reset.status).toBe(400);
    expect(reset.body.message).toBe('iterations');
    expect((await prelogin('nobody-here')).body.iterations).toBe(600_000);
    expect((await prelogin(OWNER.username)).body.iterations).toBe(600_000);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE pw_iterations <> 600000').first<number>('n')).toBe(0);
  });

  it('R1c [F17] client kind is not a boundary, step-up is: a client_key captured on the web logs in as android and gets a bearer token, but owner powers still need a proof (the same key works as that proof: pass-the-hash)', async () => {
    const { o, password } = await ownerWithUser();
    const captured = (await stepup(OWNER.username, password))['X-KK-Stepup']!; // what an XSS on the login page sees
    const asApp = await call('POST', '/auth/login', { body: { username: OWNER.username, client_key: captured, device_name: 'Attacker', client: 'android' } });
    expect(asApp.status).toBe(200);
    expect(typeof asApp.body.token).toBe('string');
    expect(asApp.body.code_block).not.toBeNull();
    expect(asApp.body.expires_at).toBeNull(); // never expires
    // owner powers: refused without a proof...
    const noProof = await call('POST', '/devices/pair-code', { token: asApp.body.token, body: { role: 'owner' } });
    expect(noProof.status).toBe(403);
    expect(noProof.body.error).toBe('stepup_required');
    // ...but the captured key IS the proof: full owner power from the captured key alone
    const withKey = await call('POST', '/devices/pair-code', { token: asApp.body.token, headers: { 'X-KK-Stepup': captured }, body: { role: 'owner' } });
    expect(withKey.status).toBe(200);
    // including revoking the ledger-of-record phone (same user) through previous_device_id at login
    const takeover = await call('POST', '/auth/login', {
      body: { username: OWNER.username, client_key: captured, device_name: 'Attacker 2', client: 'android', previous_device_id: o.device_id },
    });
    expect(takeover.status).toBe(200);
    expect((await call('GET', '/me', { token: o.token })).status).toBe(401);
  });

  it('R1d [F15] the step-up window belongs to one device row: another session of the same user is not stepped up', async () => {
    const { o, password } = await ownerWithUser();
    expect((await call('POST', '/devices/pair-code', { token: o.token, headers: await ownerStepup(), body: { role: 'staff' } })).status).toBe(200);
    expect((await call('POST', '/devices/pair-code', { token: o.token, body: { role: 'staff' } })).status).toBe(200); // inside the window
    const second = await login(OWNER.username, password);
    const r = await call('POST', '/devices/pair-code', { token: second.body.token!, body: { role: 'staff' } });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('stepup_required');
  });

  it('R1e [F18] existing v1 paired phones are unchanged: pair, push, pull, owner routes without step-up while no user exists; 0003 columns default', async () => {
    const o = await owner();
    const k = customer({ code: o.code_block.start });
    expect((await push(o.token, { customers: [k] })).status).toBe(200);
    expect((await pull(o.token, 0)).status).toBe(200);
    expect((await call('POST', '/devices/pair-code', { token: o.token, body: { role: 'staff' } })).status).toBe(200);
    expect((await call('GET', '/me', { token: o.token })).body.user).toBeNull();
    const row = await env.DB.prepare('SELECT user_id, client, expires_at, stepup_until FROM devices WHERE id = ?').bind(o.device_id).first();
    expect(row).toEqual({ user_id: null, client: null, expires_at: null, stepup_until: null });
  });

  it('R1f [F16/F18] failures are keyed in login_locks only: users.failed_count and login_throttle (0002) are no longer written', async () => {
    await ownerWithUser();
    for (let i = 0; i < 3; i++) expect((await login(OWNER.username, 'wrong', { headers: from('198.51.100.5') })).status).toBe(403);
    for (let i = 0; i < 3; i++) expect((await login('ghost.user', 'wrong', { headers: from('198.51.100.5') })).status).toBe(403);
    expect(await env.DB.prepare('SELECT failed_count FROM users WHERE username = ?').bind(OWNER.username).first<number>('failed_count')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM login_throttle').first<number>('n')).toBe(0);
    const locks = await env.DB.prepare('SELECT username, source, failed_count FROM login_locks ORDER BY username').all();
    expect(locks.results).toEqual([
      { username: 'ghost.user', source: '198.51.100.0/24', failed_count: 3 },
      { username: 'ravi', source: '198.51.100.0/24', failed_count: 3 },
    ]);
  });

  it('R1g [F16] 100 requests from one /24 (5 failures + 95 refused by its own lock) cost the shop 5 of its daily budget, not 100: a NEW device elsewhere still logs in, and so does the known phone', async () => {
    const { password } = await ownerWithUser();
    const first = await login(OWNER.username, password, { headers: from('203.0.113.9') }); // the owner's phone, known from now on
    const known = { 'X-KK-Known': first.body.known_device };
    const statuses = new Set<number>();
    for (let i = 0; i < 100; i++) {
      // 15 requests per IP keeps each under the per-IP limiter (20/min, shared across the tests of this file, hence
      // a /24 no other test uses); the /24 lock engages after 5
      const r = await login(OWNER.username, 'guess', { headers: from(`198.51.101.${1 + Math.floor(i / 15)}`) });
      statuses.add(r.status);
    }
    expect([...statuses].sort()).toEqual([403, 429]);
    expect(await dailyCount()).toBe(5);
    const newLaptop = await login(OWNER.username, password, { headers: from('192.0.2.10') });
    expect(newLaptop.status).toBe(200);
    expect(await dailyCount()).toBe(5); // a success gives its own attempt back
    expect((await login(OWNER.username, password, { headers: { ...from('203.0.113.9'), ...known } })).status).toBe(200);
  });
});

// ================================================================================================ R2: open gaps
describe('R2. gaps found by the review, now fixed', () => {
  it('R2a [F6] demoting an owner to staff ends their WEB sessions (the web is owner-only); their phone session stays', async () => {
    const { o } = await ownerWithUser();
    const kavi = await createUser(o.token, 'kavi', 'k-pass', { role: 'owner', display_name: 'Kavi' });
    const w = await login('kavi', 'k-pass', { client: 'web' });
    expect(w.status).toBe(200);
    const cookie = sessionCookie(w);
    const phone = await login('kavi', 'k-pass');
    expect(phone.status).toBe(200);
    const demote = await call('PUT', `/users/${kavi.id}`, { token: o.token, headers: await ownerStepup(), body: { role: 'staff' } });
    expect(demote.status).toBe(200);
    expect(demote.body.user.role).toBe('staff');
    // a fresh staff web login is refused...
    expect((await login('kavi', 'k-pass', { client: 'web' })).body.error).toBe('web_owner_only');
    // ...so the existing one must be gone too
    expect((await webCall('GET', '/me', cookie)).status).toBe(401);
    expect((await webCall('GET', '/sync/pull?since=0', cookie)).status).toBe(401);
    // the phone session of the demoted user keeps working, now as staff; the audit row says the web sessions ended
    expect((await call('GET', '/me', { token: phone.body.token! })).body.device.role).toBe('staff');
    const ev = await env.DB.prepare(`SELECT detail FROM auth_events WHERE action = 'user.update' ORDER BY at DESC LIMIT 1`).first<string>('detail');
    expect(JSON.parse(ev ?? '{}')).toEqual({ role: 'staff', web_sessions_ended: true });
    // promoting back does not resurrect the revoked browser session
    expect((await call('PUT', `/users/${kavi.id}`, { token: o.token, headers: await ownerStepup(), body: { role: 'owner' } })).status).toBe(200);
    expect((await webCall('GET', '/me', cookie)).status).toBe(401);
  });

  it('R2b [F16] attempts refused by the per-source lock never reach the verifier and do not burn the shop-wide daily budget', async () => {
    await ownerWithUser();
    for (let i = 0; i < 5; i++) expect((await login(OWNER.username, 'guess', { headers: from('198.51.100.10') })).status).toBe(403);
    expect(await dailyCount()).toBe(5);
    for (let i = 0; i < 10; i++) expect((await login(OWNER.username, 'guess', { headers: from('198.51.100.11') })).body.error).toBe('locked');
    expect(await dailyCount()).toBe(5);
    // a throttled day: the lock still answers first and costs nothing; a locked source cannot grab the 30 s slot
    const future = new Date(Date.now() + 30_000).toISOString();
    await env.DB.prepare('UPDATE auth_failures SET count = 100, next_allowed_at = ? WHERE day = ?').bind(future, utcDay()).run();
    expect((await login(OWNER.username, 'guess', { headers: from('198.51.100.12') })).body.error).toBe('locked');
    expect((await login(OWNER.username, 'guess', { headers: from('198.51.102.1') })).body.error).toBe('throttled');
    expect(await dailyCount()).toBe(100);
  });

  it('R2c [F15] money-relevant owner routes PUT /shop (UPI id) and POST /customers/:id/erase need step-up from every session; name/lang do not', async () => {
    const { o, password } = await ownerWithUser();
    const k = customer({ code: o.code_block.start });
    expect((await push(o.token, { customers: [k] })).status).toBe(200);
    const cookie = sessionCookie(await login(OWNER.username, password, { client: 'web' }));
    const upi = await webCall('PUT', '/shop', cookie, { body: { upi_id: 'attacker@upi' } });
    expect(upi.status).toBe(403);
    expect(upi.body.error).toBe('stepup_required');
    const erase = await webCall('POST', `/customers/${k.id}/erase`, cookie, { body: {} });
    expect(erase.status).toBe(403);
    expect(erase.body.error).toBe('stepup_required');
    // the phone too (the shop has users now, so the bootstrap exemption is over)
    expect((await call('PUT', '/shop', { token: o.token, body: { upi_id: 'ravi@okaxis' } })).body.error).toBe('stepup_required');
    expect((await call('POST', `/customers/${k.id}/erase`, { token: o.token, body: {} })).body.error).toBe('stepup_required');
    expect((await env.DB.prepare('SELECT upi_id FROM shops').first<string | null>('upi_id'))).toBeNull();
    expect((await env.DB.prepare('SELECT erased_at FROM customers WHERE id = ?').bind(k.id).first('erased_at'))).toBeNull();
    // name and language stay free of step-up; the same UPI value is not a change
    expect((await call('PUT', '/shop', { token: o.token, body: { name: 'Ravi Stores', lang: 'en', upi_id: null } })).status).toBe(200);
    // with a proof both go through (from the phone and from the web), and both are audited
    const ok = await call('PUT', '/shop', { token: o.token, headers: await ownerStepup(), body: { upi_id: 'ravi@okaxis' } });
    expect(ok.status).toBe(200);
    expect(ok.body.shop.upi_id).toBe('ravi@okaxis');
    const webStep = await webCall('POST', `/customers/${k.id}/erase`, cookie, { body: {} });
    expect(webStep.status).toBe(403); // the window belongs to the phone's device row, not to the browser
    const erased = await call('POST', `/customers/${k.id}/erase`, { token: o.token, body: {} }); // inside the phone's window
    expect(erased.status).toBe(200);
    expect(erased.body.customer.erased_at).not.toBeNull();
    const actions = await env.DB.prepare(`SELECT action, detail FROM auth_events WHERE action IN ('shop.update', 'customer.erase') ORDER BY at, id`).all();
    expect(actions.results).toEqual([
      { action: 'shop.update', detail: JSON.stringify({ upi_id: 'ravi@okaxis' }) },
      { action: 'customer.erase', detail: JSON.stringify({ customer_id: k.id }) },
    ]);
    expect((await call('POST', `/customers/${crypto.randomUUID()}/erase`, { token: o.token, body: {} })).status).toBe(404);
  });

  it('R2d [F17] on a shared computer no persistent cookie is left behind: kk_session and kk_known both die with the browser', async () => {
    const { password } = await ownerWithUser();
    const shared = await login(OWNER.username, password, { client: 'web', shared_computer: true });
    expect(shared.status).toBe(200);
    expect(cookiePart(shared, 'kk_session')).not.toMatch(/Max-Age/i);
    expect(cookiePart(shared, 'kk_known')).toBe('');
    expect(typeof shared.body.known_device).toBe('string'); // the page may keep it in memory for its own life
    const kept = await login(OWNER.username, password, { client: 'web' });
    expect(cookiePart(kept, 'kk_known')).toMatch(/Max-Age=31536000/);
  });

  it('R2e [F17, for the web boot fix] a resumed session can tell it is shared: LoginResponse.shared and GET /me device.shared / expires_at', async () => {
    const { o, password } = await ownerWithUser();
    const shared = await login(OWNER.username, password, { client: 'web', shared_computer: true });
    expect(shared.body.shared).toBe(true);
    expect(typeof shared.body.expires_at).toBe('string');
    const me = await webCall('GET', '/me', sessionCookie(shared));
    expect(me.status).toBe(200);
    expect(me.body.device.shared).toBe(true);
    expect(me.body.device.expires_at).toBe(shared.body.expires_at);
    expect(Date.parse(me.body.device.expires_at) - Date.parse(me.body.device.created_at)).toBe(12 * 3_600_000);
    const kept = await login(OWNER.username, password, { client: 'web' });
    expect(kept.body.shared).toBe(false);
    const me2 = await webCall('GET', '/me', sessionCookie(kept));
    expect(me2.body.device.shared).toBe(false);
    expect(Date.parse(me2.body.device.expires_at) - Date.parse(me2.body.device.created_at)).toBe(30 * 86_400_000);
    const phone = await login(OWNER.username, password);
    expect(phone.body.shared).toBe(false);
    expect((await call('GET', '/me', { token: phone.body.token! })).body.device).toMatchObject({ shared: false, expires_at: null });
    expect((await call('GET', '/me', { token: o.token })).body.device).toMatchObject({ shared: false, expires_at: null, client: null });
    const list = await call('GET', '/devices', { token: o.token });
    expect(list.body.devices.filter((d: { shared: boolean }) => d.shared).map((d: { id: string }) => d.id)).toEqual([shared.body.device_id]);
  });
});
