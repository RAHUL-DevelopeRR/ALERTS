/**
 * Security review of the v2 accounts code against plan-findings 5-7 and 12-20 (second pass, after the hardening
 * build). Two groups:
 *   R1. contract checks that PROVE a finding is fixed (all pass);
 *   R2. gaps still open. Each R2 test asserts the CORRECT behaviour and is marked `it.fails`, so the suite stays green
 *       while the gap exists: once the server fixes it, the test "unexpectedly passes" and `.fails` must be removed.
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

  it('R1g [F16] consequence of the daily budget design: 100 requests from one /24 (5 failures + 95 refused by its own lock) throttle every NEW device of the shop for the day; known devices still get in', async () => {
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
    expect(await dailyCount()).toBe(100);
    const newLaptop = await login(OWNER.username, password, { headers: from('192.0.2.10') });
    expect(newLaptop.status).toBe(429);
    expect(newLaptop.body.error).toBe('throttled');
    expect((await login(OWNER.username, password, { headers: { ...from('203.0.113.9'), ...known } })).status).toBe(200);
  });
});

// ================================================================================================ R2: open gaps
describe('R2. open gaps (each asserts the correct behaviour; it.fails until the server fixes it)', () => {
  it.fails('R2a [F6] demoting an owner to staff must end their WEB sessions (the web is owner-only); today the staff web session stays alive', async () => {
    const { o } = await ownerWithUser();
    const kavi = await createUser(o.token, 'kavi', 'k-pass', { role: 'owner', display_name: 'Kavi' });
    const w = await login('kavi', 'k-pass', { client: 'web' });
    expect(w.status).toBe(200);
    const cookie = sessionCookie(w);
    const demote = await call('PUT', `/users/${kavi.id}`, { token: o.token, headers: await ownerStepup(), body: { role: 'staff' } });
    expect(demote.status).toBe(200);
    expect(demote.body.user.role).toBe('staff');
    // a fresh staff web login is refused...
    expect((await login('kavi', 'k-pass', { client: 'web' })).body.error).toBe('web_owner_only');
    // ...so the existing one must be gone too
    expect((await webCall('GET', '/me', cookie)).status).toBe(401);
    expect((await webCall('GET', '/sync/pull?since=0', cookie)).status).toBe(401);
  });

  it.fails('R2b [F16] attempts refused by the per-source lock never reached the verifier and must not burn the shop-wide daily budget; today each one does', async () => {
    await ownerWithUser();
    for (let i = 0; i < 5; i++) expect((await login(OWNER.username, 'guess', { headers: from('198.51.100.10') })).status).toBe(403);
    expect(await dailyCount()).toBe(5);
    for (let i = 0; i < 10; i++) expect((await login(OWNER.username, 'guess', { headers: from('198.51.100.11') })).body.error).toBe('locked');
    expect(await dailyCount()).toBe(5);
  });

  it.fails('R2c [F15] money-relevant owner routes PUT /shop (UPI id) and POST /customers/:id/erase are reachable from a web session with no step-up', async () => {
    const { o, password } = await ownerWithUser();
    const k = customer({ code: o.code_block.start });
    expect((await push(o.token, { customers: [k] })).status).toBe(200);
    const cookie = sessionCookie(await login(OWNER.username, password, { client: 'web' }));
    const upi = await webCall('PUT', '/shop', cookie, { body: { upi_id: 'attacker@upi' } });
    expect(upi.status).toBe(403);
    const erase = await webCall('POST', `/customers/${k.id}/erase`, cookie, { body: {} });
    expect(erase.status).toBe(403);
  });

  it.fails('R2d [F17] on a shared computer no persistent cookie may be left behind: kk_known is set for a year', async () => {
    const { password } = await ownerWithUser();
    const shared = await login(OWNER.username, password, { client: 'web', shared_computer: true });
    expect(shared.status).toBe(200);
    expect(cookiePart(shared, 'kk_session')).not.toMatch(/Max-Age/i);
    expect(cookiePart(shared, 'kk_known')).not.toMatch(/Max-Age/i);
  });
});
