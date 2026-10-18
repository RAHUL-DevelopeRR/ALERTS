import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sourceOfIp } from '../src/lib/lockout';
import { createUser, login, OWNER, ownerStepup, ownerWithUser, passwordSet, prelogin, sessionCookie, stepup, webCall } from './accounts-helpers';
import { addDevice, call, owner, pair } from './helpers';

const utcDay = () => new Date().toISOString().slice(0, 10);
const actions = async (shopId: string) =>
  (await env.DB.prepare('SELECT action FROM auth_events WHERE shop_id = ? ORDER BY at, id').bind(shopId).all<{ action: string }>()).results.map((r) => r.action);

/** A second, legacy (user_id NULL) owner phone paired with a code the bootstrap owner minted. */
async function legacyOwnerPhone(ownerToken: string, name = 'Owner tablet') {
  return addDevice(ownerToken, 'owner', name, await ownerStepup());
}

// ------------------------------------------------------------------------------------------------ A (F14)
describe('A. login takeover of previous_device_id needs proof', () => {
  it("another user's device id revokes nothing, even with a token", async () => {
    const { o } = await ownerWithUser();
    await createUser(o.token, 'meena', 'meena-pass', { role: 'owner' });
    const m = await login('meena', 'meena-pass');
    const r1 = await login(OWNER.username, OWNER.password, { previous_device_id: m.body.device_id });
    expect(r1.status).toBe(200);
    const r2 = await login(OWNER.username, OWNER.password, { previous_device_id: m.body.device_id, previous_device_token: m.body.token! });
    expect(r2.status).toBe(200);
    expect((await call('GET', '/me', { token: m.body.token! })).status).toBe(200);
    // the linked bootstrap phone (another device of the SAME user) is a legitimate target
    const r3 = await login(OWNER.username, OWNER.password, { previous_device_id: o.device_id });
    expect(r3.status).toBe(200);
    expect((await call('GET', '/me', { token: o.token })).body.error).toBe('revoked');
  });

  it("the same user's device is revoked and the pair codes it minted move to the new row", async () => {
    const { password } = await ownerWithUser();
    const a = await login(OWNER.username, password, { device_name: 'Phone A' });
    const pc = await call('POST', '/devices/pair-code', { token: a.body.token!, headers: await ownerStepup(), body: { role: 'staff' } });
    expect(pc.status).toBe(200);
    const b = await login(OWNER.username, password, { device_name: 'Phone A again', previous_device_id: a.body.device_id });
    expect(b.status).toBe(200);
    expect((await call('GET', '/me', { token: a.body.token! })).body.error).toBe('revoked');
    const issuedBy = await env.DB.prepare(`SELECT issued_by FROM pair_codes WHERE kind = 'pair' AND used_at IS NULL`).first('issued_by');
    expect(issuedBy).toBe(b.body.device_id);
    expect((await pair(pc.body.code)).status).toBe(200);
  });

  it('a legacy id without its token revokes nothing; with the token it is revoked and its recovery codes move', async () => {
    const { o, password } = await ownerWithUser();
    const t = await legacyOwnerPhone(o.token);
    // the tablet steps up with a printed code (it has no password of its own) and prints the shop's codes
    const printed = await call('POST', '/devices/recovery-codes', { token: o.token, body: {} });
    const rc = await call('POST', '/devices/recovery-codes', { token: t.token, headers: { 'X-KK-Recovery': printed.body.codes[0] }, body: { count: 3 } });
    expect(rc.status).toBe(200);
    const bare = await login(OWNER.username, password, { previous_device_id: t.device_id });
    expect(bare.status).toBe(200);
    expect((await call('GET', '/me', { token: t.token })).status).toBe(200);
    const wrong = await login(OWNER.username, password, { previous_device_id: t.device_id, previous_device_token: 'A'.repeat(43) });
    expect(wrong.status).toBe(200);
    expect((await call('GET', '/me', { token: t.token })).status).toBe(200);
    const proved = await login(OWNER.username, password, { previous_device_id: t.device_id, previous_device_token: t.token });
    expect(proved.status).toBe(200);
    expect((await call('GET', '/me', { token: t.token })).body.error).toBe('revoked');
    const rows = await env.DB.prepare(`SELECT issued_by FROM pair_codes WHERE kind = 'recovery' AND used_at IS NULL`).all<{ issued_by: string }>();
    expect(rows.results.length).toBe(3);
    expect(rows.results.every((r) => r.issued_by === proved.body.device_id)).toBe(true);
    expect((await pair(rc.body.codes[1])).status).toBe(200);
  });

  it('a web login never takes recovery codes with it (they stay on the revoked phone row and keep working)', async () => {
    const { o, password } = await ownerWithUser();
    const t = await legacyOwnerPhone(o.token);
    const printed = await call('POST', '/devices/recovery-codes', { token: o.token, body: {} });
    const rc = await call('POST', '/devices/recovery-codes', { token: t.token, headers: { 'X-KK-Recovery': printed.body.codes[0] }, body: {} });
    const pc = await call('POST', '/devices/pair-code', { token: t.token, body: { role: 'staff' } });
    expect(pc.status).toBe(200);
    const web = await login(OWNER.username, password, { client: 'web', previous_device_id: t.device_id, previous_device_token: t.token });
    expect(web.status).toBe(200);
    expect((await call('GET', '/me', { token: t.token })).body.error).toBe('revoked');
    const byKind = await env.DB.prepare('SELECT kind, issued_by FROM pair_codes WHERE used_at IS NULL').all<{ kind: string; issued_by: string }>();
    expect(byKind.results.find((r) => r.kind === 'pair')?.issued_by).toBe(web.body.device_id);
    expect(byKind.results.filter((r) => r.kind === 'recovery').every((r) => r.issued_by === t.device_id)).toBe(true);
    expect((await pair(rc.body.codes[0])).status).toBe(200);
    // revoking the browser later does not destroy the printed codes
    expect((await call('POST', `/devices/${web.body.device_id}/revoke`, { token: o.token, body: {} })).status).toBe(200);
    expect((await pair(rc.body.codes[1])).status).toBe(200);
  });
});

// ------------------------------------------------------------------------------------------------ B (F15)
describe('B. step-up on owner-power routes', () => {
  it('a linked owner device without a fresh proof is refused on every owner-power route, told what it can give', async () => {
    const { o, user } = await ownerWithUser();
    const other = await createUser(o.token, 'kumar', 'k-pass'); // o is now inside its window: expire it
    await env.DB.prepare(`UPDATE devices SET stepup_until = '2000-01-01T00:00:00.000Z' WHERE id = ?`).bind(o.device_id).run();
    const refused: Array<[string, string, unknown]> = [
      ['POST', '/users', { username: 'newbie', display_name: 'N', role: 'staff', ...(await passwordSet('p')) }],
      ['PUT', `/users/${other.id}`, { role: 'owner' }],
      ['PUT', `/users/${other.id}`, { google_email: 'k@gmail.com' }],
      ['PUT', `/users/${other.id}`, { disabled: true }],
      ['PUT', `/users/${other.id}/password`, await passwordSet('reset')],
      ['POST', '/devices/pair-code', { role: 'staff' }],
      ['POST', '/devices/recovery-codes', {}],
      ['POST', `/devices/${crypto.randomUUID()}/revoke`, {}],
    ];
    for (const [m, p, b] of refused) {
      const r = await call(m, p, { token: o.token, body: b });
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.body, `${m} ${p}`).toEqual({ error: 'stepup_required', stepup: ['password', 'recovery'] });
    }
    // display_name alone is not owner power; reading is never gated
    expect((await call('PUT', `/users/${other.id}`, { token: o.token, body: { display_name: 'Kumar S' } })).status).toBe(200);
    expect((await call('GET', '/users', { token: o.token })).status).toBe(200);
    expect((await call('GET', '/devices', { token: o.token })).status).toBe(200);
    expect(user.role).toBe('owner');
  });

  it('X-KK-Stepup: a wrong key is refused and counted (5 -> locked); the right key opens a 5-minute window', async () => {
    const { o } = await ownerWithUser();
    const p = await prelogin(OWNER.username);
    const wrong = { 'X-KK-Stepup': (await stepup(OWNER.username, 'not-it'))['X-KK-Stepup']! };
    const body = { role: 'staff' };
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/devices/pair-code', { token: o.token, headers: wrong, body });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('stepup_invalid');
    }
    const locked = await call('POST', '/devices/pair-code', { token: o.token, headers: await ownerStepup(), body });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe('locked');
    expect(locked.headers.get('Retry-After')).toBeTruthy();
    // the lock is on (username, stepup:<device>); a password login of the same user elsewhere is not affected
    expect((await login(OWNER.username, OWNER.password)).status).toBe(200);
    await env.DB.prepare(`UPDATE login_locks SET locked_until = '2000-01-01T00:00:00.000Z'`).run();
    const ok = await call('POST', '/devices/pair-code', { token: o.token, headers: await ownerStepup(), body });
    expect(ok.status).toBe(200);
    const until = await env.DB.prepare('SELECT stepup_until FROM devices WHERE id = ?').bind(o.device_id).first<string>('stepup_until');
    const mins = (Date.parse(until!) - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(4.5);
    expect(mins).toBeLessThanOrEqual(5);
    // inside the window no header is needed; after it, it is again
    expect((await call('POST', '/devices/pair-code', { token: o.token, body })).status).toBe(200);
    await env.DB.prepare(`UPDATE devices SET stepup_until = '2000-01-01T00:00:00.000Z' WHERE id = ?`).bind(o.device_id).run();
    expect((await call('POST', '/devices/pair-code', { token: o.token, body })).status).toBe(403);
    // a malformed header is refused without touching the counter
    expect((await call('POST', '/devices/pair-code', { token: o.token, headers: { 'X-KK-Stepup': 'short' }, body })).body.error).toBe('stepup_invalid');
    expect(p.body.iterations).toBe(600_000);
    expect(await actions(o.shop.id)).toEqual(
      expect.arrayContaining(['stepup.failed', 'stepup.ok', 'pair_code.mint']),
    );
  });

  it('X-KK-Recovery: a printed code steps up any device once (consumed), including a legacy phone', async () => {
    const { o } = await ownerWithUser();
    const t = await legacyOwnerPhone(o.token);
    const printed = await call('POST', '/devices/recovery-codes', { token: o.token, body: { count: 3 } });
    expect(printed.status).toBe(200);
    const need = await call('POST', '/devices/pair-code', { token: t.token, body: { role: 'staff' } });
    expect(need.status).toBe(403);
    expect(need.body).toEqual({ error: 'stepup_required', stepup: ['recovery'] });
    const bad = await call('POST', '/devices/pair-code', { token: t.token, headers: { 'X-KK-Recovery': 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' }, body: { role: 'staff' } });
    expect(bad.status).toBe(403);
    expect(bad.body.error).toBe('stepup_invalid');
    const code = printed.body.codes[0] as string;
    const ok = await call('POST', '/devices/pair-code', { token: t.token, headers: { 'X-KK-Recovery': code.toLowerCase() }, body: { role: 'staff' } });
    expect(ok.status).toBe(200);
    // consumed: it no longer pairs and no longer steps up
    expect((await pair(code)).status).toBe(403);
    await env.DB.prepare(`UPDATE devices SET stepup_until = NULL WHERE id = ?`).bind(t.device_id).run();
    expect((await call('POST', '/devices/pair-code', { token: t.token, headers: { 'X-KK-Recovery': code }, body: { role: 'staff' } })).body.error).toBe('stepup_invalid');
    // inside the window the tablet can also revoke and reset a password
    await env.DB.prepare(`UPDATE devices SET stepup_until = NULL WHERE id = ?`).bind(t.device_id).run();
    const u = await createUser(o.token, 'kumar', 'k-pass');
    const reset = await call('PUT', `/users/${u.id}/password`, { token: t.token, headers: { 'X-KK-Recovery': printed.body.codes[1] }, body: await passwordSet('new') });
    expect(reset.status).toBe(200);
    expect((await login('kumar', 'new')).status).toBe(200);
    expect(await actions(o.shop.id)).toEqual(expect.arrayContaining(['stepup.failed', 'stepup.ok', 'password.reset']));
  });

  it('a Google-only owner can only step up with a recovery code', async () => {
    const { o } = await ownerWithUser();
    const g = await createUser(o.token, 'gowner', null, { role: 'owner', google_email: 'g.owner@gmail.com' });
    await env.DB.prepare('UPDATE devices SET user_id = ?, stepup_until = NULL WHERE id = ?').bind(g.id, o.device_id).run();
    const r = await call('POST', '/devices/pair-code', { token: o.token, body: { role: 'staff' } });
    expect(r.body).toEqual({ error: 'stepup_required', stepup: ['recovery'] });
    const k = await call('POST', '/devices/pair-code', { token: o.token, headers: await ownerStepup(), body: { role: 'staff' } });
    expect(k.body.error).toBe('stepup_invalid');
  });

  it('web sessions are refused on every owner-power route (403 web_forbidden) but may read and change their own password', async () => {
    const { o, user, password } = await ownerWithUser();
    const other = await createUser(o.token, 'kumar', 'k-pass');
    const w = await login(OWNER.username, password, { client: 'web' });
    const cookie = sessionCookie(w);
    const routes: Array<[string, string, unknown]> = [
      ['POST', '/users', { username: 'newbie', display_name: 'N', role: 'staff', ...(await passwordSet('p')) }],
      ['PUT', `/users/${other.id}`, { display_name: 'K' }],
      ['PUT', `/users/${other.id}/password`, await passwordSet('reset')],
      ['POST', '/devices/pair-code', { role: 'staff' }],
      ['POST', '/devices/recovery-codes', {}],
      ['POST', `/devices/${o.device_id}/revoke`, {}],
    ];
    for (const [m, p, b] of routes) {
      const r = await webCall(m, p, cookie, { body: b });
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.body.error, `${m} ${p}`).toBe('web_forbidden');
    }
    // a step-up header does not help a browser
    const hdr = await ownerStepup();
    const r = await webCall('POST', '/devices/pair-code', cookie, { body: { role: 'staff' } });
    expect(r.body.error).toBe('web_forbidden');
    expect(hdr['X-KK-Stepup']).toBeTruthy();
    expect((await webCall('GET', '/users', cookie)).status).toBe(200);
    expect((await webCall('GET', '/auth/events', cookie)).status).toBe(200);
    expect((await webCall('GET', '/devices', cookie)).status).toBe(200);
    const p = await prelogin(OWNER.username);
    const mine = await webCall('PUT', `/users/${user.id}/password`, cookie, {
      body: { ...(await passwordSet('owner-pass-2')), current_client_key: (await stepup(OWNER.username, password))['X-KK-Stepup'] },
    });
    expect(mine.status).toBe(200);
    expect(p.body.salt).toBeTruthy();
    expect((await login(OWNER.username, 'owner-pass-2')).status).toBe(200);
  });

  it('bootstrap: a legacy owner phone keeps its v1 powers only while the shop has no users', async () => {
    const o = await owner();
    expect((await call('POST', '/devices/pair-code', { token: o.token, body: { role: 'staff' } })).status).toBe(200);
    const rc = await call('POST', '/devices/recovery-codes', { token: o.token, body: {} });
    expect(rc.status).toBe(200);
    const spare = await addDevice(o.token, 'owner', 'Spare');
    expect((await call('POST', `/devices/${spare.device_id}/revoke`, { token: o.token, body: {} })).status).toBe(200);
    // first user, link_me, no step-up
    const made = await call('POST', '/users', {
      token: o.token,
      body: { username: OWNER.username, display_name: 'Ravi', role: 'owner', link_me: true, ...(await passwordSet(OWNER.password)) },
    });
    expect(made.status).toBe(200);
    expect(await env.DB.prepare('SELECT stepup_until FROM devices WHERE id = ?').bind(o.device_id).first('stepup_until')).toBeNull();
    // from now on the linked phone and any other legacy phone need a proof
    expect((await call('POST', '/devices/pair-code', { token: o.token, body: { role: 'staff' } })).body.error).toBe('stepup_required');
    const t = await legacyOwnerPhone(o.token);
    expect((await call('POST', '/devices/pair-code', { token: t.token, body: { role: 'staff' } })).body).toEqual({ error: 'stepup_required', stepup: ['recovery'] });
    expect((await call('POST', '/devices/pair-code', { token: t.token, headers: { 'X-KK-Recovery': rc.body.codes[0] }, body: { role: 'staff' } })).status).toBe(200);
    // a legacy phone can still create a user: with a recovery code
    await env.DB.prepare(`UPDATE devices SET stepup_until = NULL WHERE id = ?`).bind(t.device_id).run();
    const viaCode = await call('POST', '/users', {
      token: t.token,
      headers: { 'X-KK-Recovery': rc.body.codes[1] },
      body: { username: 'kumar', display_name: 'K', role: 'staff', ...(await passwordSet('k')) },
    });
    expect(viaCode.status).toBe(200);
  });

  it('auth_events records every owner-power action and login outcome; GET /auth/events is owner-only, newest first, 200 max', async () => {
    const { o, password } = await ownerWithUser();
    const k = await createUser(o.token, 'kumar', 'k-pass');
    const pc = await call('POST', '/devices/pair-code', { token: o.token, body: { role: 'staff' } });
    await call('POST', '/devices/recovery-codes', { token: o.token, body: {} });
    const phone = await pair(pc.body.code);
    await call('POST', `/devices/${phone.body.device_id}/revoke`, { token: o.token, body: { wipe: true } });
    await call('PUT', `/users/${k.id}`, { token: o.token, body: { role: 'owner', google_email: 'kumar@gmail.com' } });
    await call('PUT', `/users/${k.id}/password`, { token: o.token, body: await passwordSet('k2') });
    await login('kumar', 'wrong');
    const kd = await login('kumar', 'k2');
    await call('POST', '/auth/logout', { token: kd.body.token! });
    const web = await login(OWNER.username, password, { client: 'web' });
    const got = await webCall('GET', '/auth/events', sessionCookie(web));
    expect(got.status).toBe(200);
    const list = got.body.events as Array<Record<string, unknown>>;
    const seq = [...list].reverse().map((e) => e.action);
    expect(seq).toEqual([
      'user.create', // ravi (bootstrap)
      'stepup.ok',
      'user.create', // kumar
      'pair_code.mint',
      'recovery_codes.mint',
      'device.revoke',
      'user.update',
      'password.reset',
      'login.failed',
      'login.ok',
      'logout',
      'login.ok',
    ]);
    const upd = list.find((e) => e.action === 'user.update')!;
    expect(upd).toMatchObject({ actor_device_id: o.device_id, target_user_id: k.id, detail: { role: 'owner', google_email: 'kumar@gmail.com' } });
    const rev = list.find((e) => e.action === 'device.revoke')!;
    expect(rev).toMatchObject({ target_device_id: phone.body.device_id, detail: { wipe: true } });
    const failed = list.find((e) => e.action === 'login.failed')!;
    expect(failed).toMatchObject({ target_user_id: k.id, detail: { username: 'kumar', source: 'unknown', client: 'android' } });
    expect(JSON.stringify(list)).not.toMatch(/client_key|verifier|token/);
    // staff cannot read it; the list is capped at the newest 200
    const staff = await createUser(o.token, 'selvi', 's-pass');
    const sd = await login('selvi', 's-pass');
    expect((await call('GET', '/auth/events', { token: sd.body.token! })).status).toBe(403);
    expect(staff.role).toBe('staff');
    const stmts = Array.from({ length: 250 }, (_, i) =>
      env.DB.prepare(`INSERT INTO auth_events (id, shop_id, at, action) VALUES (?1, ?2, ?3, 'login.failed')`).bind(
        `bulk-${i}`,
        o.shop.id,
        `2030-01-01T00:00:${String(i % 60).padStart(2, '0')}.${String(Math.floor(i / 60)).padStart(3, '0')}Z`,
      ),
    );
    await env.DB.batch(stmts);
    const capped = await call('GET', '/auth/events', { token: o.token });
    expect(capped.body.events.length).toBe(200);
    expect(capped.body.events[0].at > capped.body.events[199].at).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ D (F6)
describe('D. staff cannot use the web', () => {
  it('a staff password login with client web is refused with 403 web_owner_only (and recorded), android works', async () => {
    const { o } = await ownerWithUser();
    const k = await createUser(o.token, 'kumar', 'k-pass');
    const w = await login('kumar', 'k-pass', { client: 'web' });
    expect(w.status).toBe(403);
    expect(w.body).toEqual({ error: 'web_owner_only' });
    expect(w.headers.get('Set-Cookie')).toBeNull();
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM devices WHERE user_id = ?`).bind(k.id).first('n')).toBe(0);
    expect((await login('kumar', 'k-pass', { client: 'android' })).status).toBe(200);
    expect(await actions(o.shop.id)).toContain('login.refused');
    // promoted to owner, the web works
    await call('PUT', `/users/${k.id}`, { token: o.token, body: { role: 'owner' } });
    expect((await login('kumar', 'k-pass', { client: 'web' })).status).toBe(200);
  });
});

// ------------------------------------------------------------------------------------------------ E (F16)
describe('E. lockout keyed on (username, source) with a known-device exemption', () => {
  const from = (ip: string) => ({ 'CF-Connecting-IP': ip });

  it('maps addresses to /24 and /48 prefixes', () => {
    expect(sourceOfIp('203.0.113.77')).toBe('203.0.113.0/24');
    expect(sourceOfIp('203.0.113.1')).toBe('203.0.113.0/24');
    expect(sourceOfIp('2401:4900:1f3b:abcd:1234:5678:9abc:def0')).toBe('2401:4900:1f3b::/48');
    expect(sourceOfIp('2401:4900::1')).toBe('2401:4900:0000::/48');
    expect(sourceOfIp('::ffff:203.0.113.5')).toBe('0000:0000:0000::/48');
    expect(sourceOfIp(undefined)).toBe('unknown');
    expect(sourceOfIp('not an ip')).toBe('unknown');
    expect(sourceOfIp('1:2:3:4:5:6:7:8:9')).toBe('unknown');
  });

  it("an attacker's failures lock only their own /24; the owner logs in from elsewhere", async () => {
    const { password } = await ownerWithUser();
    for (let i = 0; i < 5; i++) expect((await login(OWNER.username, 'guess', { headers: from('198.51.100.10') })).status).toBe(403);
    const sameNet = await login(OWNER.username, password, { headers: from('198.51.100.200') });
    expect(sameNet.status).toBe(429);
    expect(sameNet.body.error).toBe('locked');
    expect((await login(OWNER.username, password, { headers: from('203.0.113.9') })).status).toBe(200);
    expect((await login(OWNER.username, password)).status).toBe(200); // source 'unknown' has its own counter
    const keys = await env.DB.prepare('SELECT username, source FROM login_locks ORDER BY source').all();
    expect(keys.results).toEqual([{ username: 'ravi', source: '198.51.100.0/24' }]);
  });

  it('a known device is exempt from the per-source lock and the shop-wide throttle, but has its own 5-failure backoff', async () => {
    const { password } = await ownerWithUser();
    const first = await login(OWNER.username, password, { headers: from('203.0.113.9') });
    const known = { 'X-KK-Known': first.body.known_device };
    // attacker from the owner's own carrier /24 (CGNAT) burns the pair and the daily budget
    for (let i = 0; i < 5; i++) expect((await login(OWNER.username, 'guess', { headers: from('203.0.113.77') })).status).toBe(403);
    expect((await login(OWNER.username, password, { headers: from('203.0.113.9') })).status).toBe(429);
    const future = new Date(Date.now() + 30_000).toISOString();
    await env.DB.prepare('UPDATE auth_failures SET count = 100, next_allowed_at = ? WHERE day = ?').bind(future, utcDay()).run();
    expect((await login(OWNER.username, password, { headers: from('192.0.2.1') })).body.error).toBe('throttled');
    // the owner's known phone still gets in, and its attempts are not charged to the shop-wide budget
    const ok = await login(OWNER.username, password, { headers: { ...from('203.0.113.9'), ...known } });
    expect(ok.status).toBe(200);
    expect((await login(OWNER.username, 'typo', { headers: { ...from('203.0.113.9'), ...known } })).status).toBe(403);
    expect(await env.DB.prepare('SELECT count FROM auth_failures WHERE day = ?').bind(utcDay()).first('count')).toBe(100);
    // ... but its own wrong guesses lock the (username, device) pair
    for (let i = 0; i < 4; i++) expect((await login(OWNER.username, 'typo', { headers: known })).status).toBe(403);
    const self = await login(OWNER.username, password, { headers: known });
    expect(self.status).toBe(429);
    expect(self.body.error).toBe('locked');
    const row = await env.DB.prepare('SELECT source FROM login_locks WHERE source LIKE ?').bind('known:%').first('source');
    expect(row).toBe(`known:${first.body.device_id}`);
  });

  it('a forged or foreign known-device value is just an unknown source; the web gets it as a cookie', async () => {
    const { o, password } = await ownerWithUser();
    await createUser(o.token, 'kumar', 'k-pass');
    const k = await login('kumar', 'k-pass');
    const future = new Date(Date.now() + 30_000).toISOString();
    const spend = () =>
      env.DB.prepare('INSERT INTO auth_failures (day, count, next_allowed_at) VALUES (?1, 100, ?2) ON CONFLICT(day) DO UPDATE SET count = 100, next_allowed_at = ?2')
        .bind(utcDay(), future)
        .run();
    await spend();
    // staff's value does not exempt the owner's username; a wrong MAC does not either
    expect((await login(OWNER.username, password, { headers: { 'X-KK-Known': k.body.known_device } })).body.error).toBe('throttled');
    const forged = `${k.body.device_id}.${'0'.repeat(64)}`;
    expect((await login('kumar', 'k-pass', { headers: { 'X-KK-Known': forged } })).body.error).toBe('throttled');
    expect((await login('kumar', 'k-pass', { headers: { 'X-KK-Known': k.body.known_device } })).status).toBe(200);
    // web: the cookie
    await env.DB.prepare('DELETE FROM auth_failures').run();
    const w = await login(OWNER.username, password, { client: 'web' });
    const sc = w.headers.get('Set-Cookie') ?? '';
    expect(sc).toMatch(new RegExp(`kk_known=${w.body.device_id}\\.[0-9a-f]{64};[^,]*HttpOnly`, 'i'));
    expect(sc).toMatch(/kk_known=[^;]*;[^,]*Max-Age=31536000/);
    await spend();
    const again = await call('POST', '/auth/login', {
      headers: { Cookie: `kk_known=${w.body.known_device}` },
      body: { username: OWNER.username, client_key: (await stepup(OWNER.username, password))['X-KK-Stepup'], device_name: 'Chrome', client: 'web' },
    });
    expect(again.status).toBe(200);
  });
});

// ------------------------------------------------------------------------------------------------ F (F17)
describe('F. web sessions: no code block, 30 days, or 12 h session-scoped on a shared computer', () => {
  it('shared_computer shortens the session and drops Max-Age from the cookie', async () => {
    const { password } = await ownerWithUser();
    const normal = await login(OWNER.username, password, { client: 'web' });
    expect(normal.body.code_block).toBeNull();
    expect(normal.headers.get('Set-Cookie')).toMatch(/kk_session=[^;]+;[^,]*Max-Age=2592000/);
    const days = (Date.parse(normal.body.expires_at!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    const shared = await login(OWNER.username, password, { client: 'web', shared_computer: true });
    expect(shared.status).toBe(200);
    const sc = shared.headers.get('Set-Cookie') ?? '';
    const session = sc.split(/,(?=\s*kk_)/).find((x) => x.trim().startsWith('kk_session='))!;
    expect(session).not.toMatch(/Max-Age/i);
    expect(session).toMatch(/HttpOnly/i);
    const hours = (Date.parse(shared.body.expires_at!) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThanOrEqual(12);
    const row = await env.DB.prepare('SELECT expires_at FROM devices WHERE id = ?').bind(shared.body.device_id).first<string>('expires_at');
    expect(row).toBe(shared.body.expires_at);
    expect((await webCall('GET', '/me', sessionCookie(shared))).status).toBe(200);
    // android ignores the flag; a non-boolean is refused
    expect((await login(OWNER.username, password, { shared_computer: true })).body.expires_at).toBeNull();
    const bad = await login(OWNER.username, password, { client: 'web', shared_computer: 'yes' as unknown as boolean });
    expect(bad.status).toBe(400);
  });
});

// ------------------------------------------------------------------------------------------------ G (F12)
describe('G. PBKDF2 count is pinned to 600,000', () => {
  it('prelogin answers the default count for everyone, whatever is stored', async () => {
    const { o } = await ownerWithUser();
    const u = await createUser(o.token, 'kumar', 'k-pass');
    expect((await prelogin('kumar')).body.iterations).toBe(600_000);
    expect((await prelogin('nobody')).body.iterations).toBe(600_000);
    await env.DB.prepare('UPDATE users SET pw_iterations = 300000 WHERE id = ?').bind(u.id).run();
    expect((await prelogin('kumar')).body.iterations).toBe(600_000);
    // a password change with another count is refused too
    const p = await prelogin(OWNER.username);
    const r = await call('PUT', `/users/${u.id}/password`, { token: o.token, body: { ...(await passwordSet('x', 599_999)) } });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('iterations');
    expect(p.body.iterations).toBe(600_000);
  });
});

// ------------------------------------------------------------------------------------------------ H (F7)
describe('H. owner-initiated password resets need step-up; self changes need the current key', () => {
  it('an owner reset without a fresh proof is refused; with one the target devices are revoked', async () => {
    const { o } = await ownerWithUser();
    const k = await createUser(o.token, 'kumar', 'k-pass');
    const kd = await login('kumar', 'k-pass');
    await env.DB.prepare(`UPDATE devices SET stepup_until = NULL WHERE id = ?`).bind(o.device_id).run();
    const no = await call('PUT', `/users/${k.id}/password`, { token: o.token, body: await passwordSet('new') });
    expect(no.status).toBe(403);
    expect(no.body.error).toBe('stepup_required');
    expect((await login('kumar', 'k-pass')).status).toBe(200);
    const yes = await call('PUT', `/users/${k.id}/password`, { token: o.token, headers: await ownerStepup(), body: await passwordSet('new') });
    expect(yes.status).toBe(200);
    expect((await call('GET', '/me', { token: kd.body.token! })).body.error).toBe('revoked');
    expect((await login('kumar', 'new')).status).toBe(200);
    // the reset also clears any lock on that username
    for (let i = 0; i < 5; i++) await login('kumar', 'bad');
    expect((await login('kumar', 'new')).status).toBe(429);
    expect((await call('PUT', `/users/${k.id}/password`, { token: o.token, body: await passwordSet('new2') })).status).toBe(200);
    expect((await login('kumar', 'new2')).status).toBe(200);
  });
});
