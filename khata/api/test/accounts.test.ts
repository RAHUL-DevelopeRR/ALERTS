import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CODE_BLOCK_SIZE } from '../../shared/protocol';
import {
  createUser,
  fastClientKey,
  ITER,
  login,
  ownerStepup,
  ownerWithUser,
  passwordSet,
  prelogin,
  randomSalt,
  realClientKey,
  sessionCookie,
  stepup,
  webCall,
} from './accounts-helpers';
import { addDevice, call, customer, entry, owner, pair, pull, push } from './helpers';

const utcDay = () => new Date().toISOString().slice(0, 10);
const loginBody = (username: string, client_key: string, extra: Record<string, unknown> = {}) => ({
  body: { username, client_key, device_name: 'Phone', client: 'android', ...extra },
});

describe('config and prelogin', () => {
  it('GET /config is public and names the web Google client id', async () => {
    const r = await call('GET', '/config');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      google_client_id: 'web-client.apps.googleusercontent.com',
      auth: { password: true },
      version: '2.0.0',
    });
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns the stored salt for a real user and a deterministic fake one otherwise, same shape', async () => {
    const { o } = await ownerWithUser();
    const set = await passwordSet('pw-for-kumar');
    const made = await call('POST', '/users', {
      token: o.token,
      headers: await ownerStepup(),
      body: { username: 'kumar', display_name: 'Kumar', role: 'staff', ...set },
    });
    expect(made.status).toBe(200);
    const real = await prelogin('kumar');
    expect(real.status).toBe(200);
    expect(real.body).toEqual({ salt: set.salt, iterations: ITER });
    // case and spaces are normalised
    expect((await prelogin('  KUMAR ')).body).toEqual(real.body);

    const fake1 = await prelogin('nobody');
    const fake2 = await prelogin('nobody');
    const fake3 = await prelogin('someone.else');
    expect(fake1.status).toBe(200);
    expect(Object.keys(fake1.body).sort()).toEqual(Object.keys(real.body).sort());
    expect(fake1.body.salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(fake1.body.iterations).toBe(ITER);
    expect(fake2.body).toEqual(fake1.body);
    expect(fake3.body.salt).not.toBe(fake1.body.salt);
    expect(real.body.salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // headers do not differ either
    expect([...fake1.headers.keys()].sort()).toEqual([...real.headers.keys()].sort());
  });

  it('is rate limited per client IP (AUTH_LIMITER, 20 per minute per route)', async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      statuses.push((await call('POST', '/auth/prelogin', { body: { username: 'nobody' }, headers: { 'CF-Connecting-IP': ip } })).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // other routes and other clients have their own budget
    expect((await call('POST', '/auth/login', { ...loginBody('nobody', 'x'), headers: { 'CF-Connecting-IP': ip } })).status).toBe(400);
    expect((await call('POST', '/auth/prelogin', { body: { username: 'nobody' }, headers: { 'CF-Connecting-IP': '198.51.100.7' } })).status).toBe(200);
  });

  it('rejects malformed usernames with 400 (format is public, says nothing about existence)', async () => {
    for (const u of ['ab', 'a'.repeat(33), 'has space', 'ராமு', 42, null]) {
      const r = await call('POST', '/auth/prelogin', { body: { username: u } });
      expect(r.status).toBe(400);
    }
  });
});

describe('password login', () => {
  it('creates a device row like /pair and returns a PairResponse-compatible body', async () => {
    const { o, user, password } = await ownerWithUser();
    const r = await login('ravi', password, { device_name: 'Second phone', max_local_code: 120 });
    expect(r.status).toBe(200);
    expect(r.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.body.role).toBe('owner');
    expect(r.body.shop.id).toBe(o.shop.id);
    expect(r.body.code_block!.end - r.body.code_block!.start + 1).toBe(CODE_BLOCK_SIZE);
    expect(r.body.code_block!.start).toBeGreaterThan(120);
    expect(r.body.known_device).toMatch(new RegExp(`^${r.body.device_id}\\.[0-9a-f]{64}$`));
    expect(r.body.expires_at).toBeNull();
    expect(typeof r.body.sync_epoch).toBe('string');
    expect(r.body.user).toEqual({ id: user.id, username: 'ravi', display_name: 'Ravi', role: 'owner' });
    expect(r.headers.get('Set-Cookie')).toBeNull();
    const row = await env.DB.prepare('SELECT user_id, client, role, expires_at, name FROM devices WHERE id = ?')
      .bind(r.body.device_id)
      .first();
    expect(row).toEqual({ user_id: user.id, client: 'android', role: 'owner', expires_at: null, name: 'Second phone' });
    const me = await call('GET', '/me', { token: r.body.token! });
    expect(me.status).toBe(200);
    expect(me.body.user).toEqual(r.body.user);
    expect(me.body.device).toMatchObject({ id: r.body.device_id, client: 'android', user_id: user.id });
  });

  it('works with the real PBKDF2 derivation the app uses', async () => {
    const { o } = await ownerWithUser();
    const salt = randomSalt();
    const client_key = await realClientKey('கடை-password-1', salt, ITER);
    const made = await call('POST', '/users', {
      token: o.token,
      headers: await ownerStepup(),
      body: { username: 'selvi', display_name: 'Selvi', role: 'staff', salt, iterations: ITER, client_key },
    });
    expect(made.status).toBe(200);
    const p = await prelogin('selvi');
    const key = await realClientKey('கடை-password-1', p.body.salt, p.body.iterations);
    const ok = await call('POST', '/auth/login', loginBody('selvi', key));
    expect(ok.status).toBe(200);
    const wrong = await realClientKey('கடை-password-2', p.body.salt, p.body.iterations);
    expect((await call('POST', '/auth/login', loginBody('selvi', wrong))).status).toBe(403);
  });

  it('answers an unknown user and a wrong password identically', async () => {
    await ownerWithUser();
    const wrong = await login('ravi', 'not-the-password');
    const unknown = await login('nosuchuser', 'whatever-pass');
    expect(wrong.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(wrong.body).toEqual({ error: 'invalid_login' });
    expect(unknown.body).toEqual(wrong.body);
    expect([...unknown.headers.keys()].sort()).toEqual([...wrong.headers.keys()].sort());
  });

  it('validates the body before touching any counter', async () => {
    await ownerWithUser();
    const key = await fastClientKey('x', randomSalt());
    const bad = [
      loginBody('ravi', key.slice(0, 42)),
      loginBody('ravi', `${key}A`),
      loginBody('ravi', key, { client: 'ios' }),
      loginBody('ravi', key, { device_name: '' }),
      loginBody('ravi', key, { max_local_code: -1 }),
      loginBody('r', key),
    ];
    for (const b of bad) expect((await call('POST', '/auth/login', b)).status).toBe(400);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_failures').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM login_locks').first('n')).toBe(0);
  });

  it('locks a username after 5 failures with exponential backoff, never permanently; success resets', async () => {
    const { password } = await ownerWithUser();
    for (let i = 0; i < 5; i++) expect((await login('ravi', 'bad-guess')).status).toBe(403);
    const locked = await login('ravi', password); // even the right password waits
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe('locked');
    expect(locked.body.retry_after).toBeGreaterThan(20);
    expect(locked.body.retry_after).toBeLessThanOrEqual(30);
    expect(locked.headers.get('Retry-After')).toBe(String(locked.body.retry_after));
    // the lock is keyed on (username, source); without CF-Connecting-IP the source is 'unknown'
    const LOCK = `FROM login_locks WHERE username = 'ravi' AND source = 'unknown'`;
    // the lock expires (simulate the 30 s passing); the next failure doubles it
    await env.DB.prepare(`UPDATE login_locks SET locked_until = '2000-01-01T00:00:00.000Z' WHERE username = 'ravi'`).run();
    expect((await login('ravi', 'bad-guess')).status).toBe(403);
    const lock2 = await env.DB.prepare(`SELECT failed_count, locked_until ${LOCK}`).first<{ failed_count: number; locked_until: string }>();
    expect(lock2?.failed_count).toBe(6);
    const secs = (Date.parse(lock2!.locked_until) - Date.now()) / 1000;
    expect(secs).toBeGreaterThan(50);
    expect(secs).toBeLessThanOrEqual(60);
    // capped at 15 minutes
    await env.DB.prepare(`UPDATE login_locks SET failed_count = 20, locked_until = NULL WHERE username = 'ravi'`).run();
    expect((await login('ravi', 'bad-guess')).status).toBe(403);
    const cap = await env.DB.prepare(`SELECT locked_until ${LOCK}`).first<string>('locked_until');
    const capSecs = (Date.parse(cap!) - Date.now()) / 1000;
    expect(capSecs).toBeGreaterThan(890);
    expect(capSecs).toBeLessThanOrEqual(900);
    // after it expires the right password works and resets the counter
    await env.DB.prepare(`UPDATE login_locks SET locked_until = '2000-01-01T00:00:00.000Z' WHERE username = 'ravi'`).run();
    expect((await login('ravi', password)).status).toBe(200);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n ${LOCK}`).first('n')).toBe(0);
    // the user row's legacy counters are untouched (login_locks is the only lock now)
    expect(await env.DB.prepare(`SELECT failed_count FROM users WHERE username = 'ravi'`).first('failed_count')).toBe(0);
  });

  it('locks unknown usernames the same way (a lockout does not reveal that a user exists)', async () => {
    await ownerWithUser();
    const real: number[] = [];
    const ghost: number[] = [];
    for (let i = 0; i < 6; i++) {
      real.push((await login('ravi', 'bad-guess')).status);
      ghost.push((await login('ghost.user', 'bad-guess')).status);
    }
    expect(real).toEqual([403, 403, 403, 403, 403, 429]);
    expect(ghost).toEqual(real);
    const g = await login('ghost.user', 'bad-guess');
    expect(g.body.error).toBe('locked');
    expect(g.body.retry_after).toBeGreaterThan(20);
  });

  it('throttles shop-wide after AUTH_THROTTLE_AFTER failures per UTC day; a success gives its attempt back', async () => {
    const { password } = await ownerWithUser();
    expect((await login('ravi', 'bad-guess')).status).toBe(403);
    expect(await env.DB.prepare('SELECT count FROM auth_failures WHERE day = ?').bind(utcDay()).first('count')).toBe(1);
    expect((await login('ravi', password)).status).toBe(200);
    expect(await env.DB.prepare('SELECT count FROM auth_failures WHERE day = ?').bind(utcDay()).first('count')).toBe(1);
    const future = new Date(Date.now() + 30_000).toISOString();
    await env.DB.prepare('UPDATE auth_failures SET count = 100, next_allowed_at = ? WHERE day = ?').bind(future, utcDay()).run();
    const t = await login('ravi', password);
    expect(t.status).toBe(429);
    expect(t.body.error).toBe('throttled');
    // one attempt per 30 s is still allowed once the window passes
    await env.DB.prepare(`UPDATE auth_failures SET next_allowed_at = '2000-01-01T00:00:00.000Z'`).run();
    expect((await login('ravi', password)).status).toBe(200);
  });

  it('a disabled user or a user without a password cannot log in and gets the fake salt', async () => {
    const { o } = await ownerWithUser();
    const staff = await createUser(o.token, 'kumar', 'kumar-pass');
    const googleOnly = await createUser(o.token, 'gonly', null, { google_email: 'g.only@gmail.com' });
    expect(googleOnly.has_password).toBe(false);
    const realSalt = (await prelogin('kumar')).body.salt;
    const dev = await login('kumar', 'kumar-pass');
    expect(dev.status).toBe(200);
    expect((await call('PUT', `/users/${staff.id}`, { token: o.token, headers: await ownerStepup(), body: { disabled: true } })).status).toBe(200);
    expect((await prelogin('kumar')).body.salt).not.toBe(realSalt);
    expect((await login('kumar', 'kumar-pass')).status).toBe(403);
    expect((await call('GET', '/me', { token: dev.body.token! })).body.error).toBe('revoked');
    expect((await login('gonly', 'anything-at-all')).status).toBe(403);
    // re-enabled: logs in again (old devices stay revoked)
    expect((await call('PUT', `/users/${staff.id}`, { token: o.token, body: { disabled: false } })).status).toBe(200);
    expect((await prelogin('kumar')).body.salt).toBe(realSalt);
    expect((await login('kumar', 'kumar-pass')).status).toBe(200);
    expect((await call('GET', '/me', { token: dev.body.token! })).status).toBe(401);
  });
});

describe('web sessions (cookie)', () => {
  it('sets an HttpOnly Secure SameSite=Strict cookie and returns token: null', async () => {
    const { password, user } = await ownerWithUser();
    const r = await login('ravi', password, { client: 'web', device_name: 'Chrome' });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeNull();
    const sc = r.headers.get('Set-Cookie') ?? '';
    expect(sc).toMatch(/^kk_session=[A-Za-z0-9_-]{43};/);
    expect(sc).toMatch(/;\s*HttpOnly/i);
    expect(sc).toMatch(/;\s*Secure/i);
    expect(sc).toMatch(/;\s*SameSite=Strict/i);
    expect(sc).toMatch(/;\s*Path=\/v1(;|$)/);
    expect(sc).toMatch(/;\s*Max-Age=2592000/);
    const row = await env.DB.prepare('SELECT client, user_id, expires_at FROM devices WHERE id = ?')
      .bind(r.body.device_id)
      .first<{ client: string; user_id: string; expires_at: string }>();
    expect(row?.client).toBe('web');
    expect(row?.user_id).toBe(user.id);
    const days = (Date.parse(row!.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
  });

  it('cookie auth requires X-KK-Client: web on every method; tokens are bound to their transport', async () => {
    const { password } = await ownerWithUser();
    const r = await login('ravi', password, { client: 'web' });
    const cookie = sessionCookie(r);
    const me = await webCall('GET', '/me', cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('ravi');
    expect(me.body.device.client).toBe('web');
    const noHeader = await webCall('GET', '/me', cookie, { csrfHeader: false });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error).toBe('csrf');
    const pushNoHeader = await webCall('POST', '/sync/push', cookie, { body: { customers: [], entries: [] }, csrfHeader: false });
    expect(pushNoHeader.status).toBe(403);
    // the web token as a Bearer, and an app token as a cookie, are both refused
    expect((await call('GET', '/me', { token: cookie })).status).toBe(401);
    const app = await login('ravi', password, { client: 'android' });
    expect((await webCall('GET', '/me', app.body.token!)).status).toBe(401);
    expect((await call('GET', '/me', { token: app.body.token! })).status).toBe(200);
  });

  it('an expired web session is refused', async () => {
    const { password } = await ownerWithUser();
    const r = await login('ravi', password, { client: 'web' });
    await env.DB.prepare(`UPDATE devices SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).bind(r.body.device_id).run();
    const me = await webCall('GET', '/me', sessionCookie(r));
    expect(me.status).toBe(401);
    expect(me.body.error).toBe('unauthorized');
  });

  it('existing bearer devices are unaffected (paired phones have no user)', async () => {
    const o = await owner();
    const me = await call('GET', '/me', { token: o.token });
    expect(me.status).toBe(200);
    expect(me.body.user).toBeNull();
    expect(me.body.device).toMatchObject({ client: null, user_id: null });
    // a stray cookie does not matter when a Bearer token is sent
    const both = await call('GET', '/me', { token: o.token, headers: { Cookie: 'kk_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } });
    expect(both.status).toBe(200);
  });
});

describe('logout', () => {
  it('revokes the calling app device', async () => {
    const { password } = await ownerWithUser();
    const r = await login('ravi', password);
    const out = await call('POST', '/auth/logout', { token: r.body.token! });
    expect(out.status).toBe(200);
    expect(out.body.ok).toBe(true);
    const me = await call('GET', '/me', { token: r.body.token! });
    expect(me.status).toBe(401);
    expect(me.body).toEqual({ error: 'revoked', wipe: false });
  });

  it('revokes the web session and clears the cookie', async () => {
    const { password } = await ownerWithUser();
    const r = await login('ravi', password, { client: 'web' });
    const cookie = sessionCookie(r);
    expect((await webCall('POST', '/auth/logout', cookie, { csrfHeader: false })).status).toBe(403);
    const out = await webCall('POST', '/auth/logout', cookie);
    expect(out.status).toBe(200);
    const sc = out.headers.get('Set-Cookie') ?? '';
    expect(sc).toMatch(/^kk_session=;/);
    expect(sc).toMatch(/Max-Age=0/);
    expect(sc).toMatch(/Path=\/v1/);
    expect((await webCall('GET', '/me', cookie)).status).toBe(401);
  });

  it('needs a session', async () => {
    expect((await call('POST', '/auth/logout', { body: {} })).status).toBe(401);
  });
});

describe('user management', () => {
  it('owner creates, lists and edits users; staff devices are forbidden', async () => {
    const { o, user } = await ownerWithUser();
    const staff = await createUser(o.token, 'kumar', 'kumar-pass', { display_name: 'Kumar', google_email: 'Kumar@GMail.com' });
    expect(staff).toMatchObject({ username: 'kumar', role: 'staff', google_email: 'kumar@gmail.com', google_linked: false, has_password: true, disabled_at: null });
    const list = await call('GET', '/users', { token: o.token });
    expect(list.status).toBe(200);
    expect(list.body.users.map((u: { id: string }) => u.id)).toEqual([user.id, staff.id]);
    expect(JSON.stringify(list.body)).not.toMatch(/verifier|pw_salt|failed_count/);
    // never leaks secrets in the row either
    const upd = await call('PUT', `/users/${staff.id}`, { token: o.token, body: { display_name: 'Kumar S' } });
    expect(upd.status).toBe(200);
    expect(upd.body.user.display_name).toBe('Kumar S');

    const staffDev = await login('kumar', 'kumar-pass');
    const t = staffDev.body.token!;
    expect((await call('GET', '/users', { token: t })).status).toBe(403);
    expect((await call('POST', '/users', { token: t, body: { username: 'x1x', display_name: 'X', role: 'staff', ...(await passwordSet('p')) } })).status).toBe(403);
    expect((await call('PUT', `/users/${staff.id}`, { token: t, body: { role: 'owner' } })).status).toBe(403);
  });

  it('refuses duplicates, bad password material and bad link_me', async () => {
    const { o } = await ownerWithUser();
    const dup = await call('POST', '/users', { token: o.token, headers: await ownerStepup(), body: { username: 'RAVI', display_name: 'R2', role: 'staff', ...(await passwordSet('p')) } });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('username_taken');
    await createUser(o.token, 'kumar', 'p', { google_email: 'k@gmail.com' });
    const dupMail = await call('POST', '/users', { token: o.token, body: { username: 'kumar2', display_name: 'K2', role: 'staff', google_email: 'K@gmail.com' } });
    expect(dupMail.status).toBe(409);
    expect(dupMail.body.error).toBe('google_email_taken');
    const base = { username: 'newbie', display_name: 'N', role: 'staff' };
    const good = await passwordSet('p');
    for (const bad of [
      { ...good, iterations: 599_999 }, // only the default count is stored (F12)
      { ...good, iterations: 700_000 },
      { ...good, iterations: 2_000_000 },
      { ...good, iterations: 600_000.5 },
      { ...good, salt: good.salt.slice(0, 21) },
      { ...good, salt: `${good.salt}AA` },
      { ...good, client_key: good.client_key.slice(0, 40) },
      { salt: good.salt, iterations: good.iterations }, // client_key missing
      {}, // no password and no google_email
    ]) {
      expect((await call('POST', '/users', { token: o.token, body: { ...base, ...bad } })).status).toBe(400);
    }
    expect((await call('POST', '/users', { token: o.token, body: { ...base, ...good } })).status).toBe(200);
    // link_me: staff role refused, and a device already linked cannot link again
    expect((await call('POST', '/users', { token: o.token, body: { ...base, username: 'l1x', ...good, link_me: true } })).status).toBe(400);
    const again = await call('POST', '/users', { token: o.token, body: { ...base, username: 'l2x', role: 'owner', ...good, link_me: true } });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('already_linked');
  });

  it('protects the last owner and the caller own role', async () => {
    const { o, user } = await ownerWithUser();
    // the owner's own device cannot change its own role or disable itself
    const self = await call('PUT', `/users/${user.id}`, { token: o.token, body: { role: 'staff' } });
    expect(self.status).toBe(400);
    expect(self.body.error).toBe('cannot_change_own_role');
    expect((await call('PUT', `/users/${user.id}`, { token: o.token, body: { disabled: true } })).body.error).toBe('cannot_disable_self');
    // another owner phone (paired, no user; steps up with a printed recovery code) cannot demote or disable the only
    // owner user
    const other = await addDevice(o.token, 'owner', 'Owner tablet', await ownerStepup());
    const rc = await call('POST', '/devices/recovery-codes', { token: o.token, body: {} });
    expect(rc.status).toBe(200);
    const demote = await call('PUT', `/users/${user.id}`, { token: other.token, headers: { 'X-KK-Recovery': rc.body.codes[0] }, body: { role: 'staff' } });
    expect(demote.status).toBe(409);
    expect(demote.body.error).toBe('last_owner');
    expect((await call('PUT', `/users/${user.id}`, { token: other.token, body: { disabled: true } })).body.error).toBe('last_owner');
    expect(await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(user.id).first('role')).toBe('owner');
    // with a second owner user it is allowed, and the demoted user's devices follow the role
    await createUser(o.token, 'meena', 'meena-pass', { role: 'owner' });
    const ok = await call('PUT', `/users/${user.id}`, { token: other.token, body: { role: 'staff' } });
    expect(ok.status).toBe(200);
    expect(ok.body.user.role).toBe('staff');
    expect(await env.DB.prepare('SELECT role FROM devices WHERE id = ?').bind(o.device_id).first('role')).toBe('staff');
    expect((await call('GET', '/users', { token: o.token })).status).toBe(403);
  });

  it('promoting a user applies to their live devices', async () => {
    const { o } = await ownerWithUser();
    const staff = await createUser(o.token, 'kumar', 'kumar-pass');
    const d = await login('kumar', 'kumar-pass');
    expect(d.body.role).toBe('staff');
    expect((await call('POST', '/devices/pair-code', { token: d.body.token!, body: { role: 'staff' } })).status).toBe(403);
    expect((await call('PUT', `/users/${staff.id}`, { token: o.token, body: { role: 'owner' } })).status).toBe(200);
    const hdr = await stepup('kumar', 'kumar-pass');
    expect((await call('POST', '/devices/pair-code', { token: d.body.token!, headers: hdr, body: { role: 'staff' } })).status).toBe(200);
  });

  it('disabling revokes every device of the user and the unused codes they minted', async () => {
    const { o } = await ownerWithUser();
    const u = await createUser(o.token, 'meena', 'meena-pass', { role: 'owner' });
    const a = await login('meena', 'meena-pass');
    const b = await login('meena', 'meena-pass', { client: 'web' });
    const code = await call('POST', '/devices/pair-code', { token: a.body.token!, headers: await stepup('meena', 'meena-pass'), body: { role: 'staff' } });
    expect(code.status).toBe(200);
    const r = await call('PUT', `/users/${u.id}`, { token: o.token, body: { disabled: true } });
    expect(r.status).toBe(200);
    expect(r.body.user.disabled_at).not.toBeNull();
    expect((await call('GET', '/me', { token: a.body.token! })).body.error).toBe('revoked');
    expect((await webCall('GET', '/me', sessionCookie(b))).body.error).toBe('revoked');
    expect((await pair(code.body.code)).status).toBe(403);
    // the owner's own devices are untouched
    expect((await call('GET', '/me', { token: o.token })).status).toBe(200);
  });

  it('unknown user ids answer 404', async () => {
    const { o } = await ownerWithUser();
    expect((await call('PUT', `/users/${crypto.randomUUID()}`, { token: o.token, body: { display_name: 'X' } })).status).toBe(404);
  });
});

describe('password change', () => {
  it('a user changes their own password with the current key; their other devices are revoked', async () => {
    const { o } = await ownerWithUser();
    const staff = await createUser(o.token, 'kumar', 'old-pass');
    const a = await login('kumar', 'old-pass');
    const b = await login('kumar', 'old-pass', { device_name: 'Old phone' });
    const p = await prelogin('kumar');
    const current = await fastClientKey('old-pass', p.body.salt);
    const next = await passwordSet('new-pass');
    const noCurrent = await call('PUT', `/users/${staff.id}/password`, { token: a.body.token!, body: next });
    expect(noCurrent.status).toBe(400);
    const wrongCurrent = await call('PUT', `/users/${staff.id}/password`, {
      token: a.body.token!,
      body: { ...next, current_client_key: await fastClientKey('nope', p.body.salt) },
    });
    expect(wrongCurrent.status).toBe(403);
    const ok = await call('PUT', `/users/${staff.id}/password`, { token: a.body.token!, body: { ...next, current_client_key: current } });
    expect(ok.status).toBe(200);
    expect((await call('GET', '/me', { token: a.body.token! })).status).toBe(200);
    expect((await call('GET', '/me', { token: b.body.token! })).status).toBe(401);
    expect((await login('kumar', 'old-pass')).status).toBe(403);
    expect((await login('kumar', 'new-pass')).status).toBe(200);
    expect((await prelogin('kumar')).body).toEqual({ salt: next.salt, iterations: next.iterations });
  });

  it('staff cannot set another user password; the owner can set anyone (their devices are revoked)', async () => {
    const { o, user } = await ownerWithUser();
    const k = await createUser(o.token, 'kumar', 'k-pass');
    await createUser(o.token, 'selvi', 's-pass');
    const kd = await login('kumar', 'k-pass');
    const sd = await login('selvi', 's-pass');
    expect((await call('PUT', `/users/${k.id}/password`, { token: sd.body.token!, body: await passwordSet('x') })).status).toBe(403);
    expect((await call('PUT', `/users/${user.id}/password`, { token: sd.body.token!, body: await passwordSet('x') })).status).toBe(403);
    const reset = await call('PUT', `/users/${k.id}/password`, { token: o.token, body: await passwordSet('fresh-pass') });
    expect(reset.status).toBe(200); // o is still inside its 5-minute step-up window from createUser
    expect((await call('GET', '/me', { token: kd.body.token! })).body.error).toBe('revoked');
    expect((await login('kumar', 'fresh-pass')).status).toBe(200);
  });
});

describe('login devices and the sync protocol', () => {
  it('app and web login devices push and pull like paired phones; paired phones still work', async () => {
    const { o, password } = await ownerWithUser();
    const app = await login('ravi', password);
    const web = await login('ravi', password, { client: 'web' });
    const cookie = sessionCookie(web);

    const c1 = customer({ code: app.body.code_block!.start });
    const e1 = entry(c1.id, 'GIVE', 5000);
    const p1 = await push(app.body.token!, { customers: [c1], entries: [e1] });
    expect(p1.status).toBe(200);
    expect(p1.body.results.map((r) => r.status)).toEqual(['stored', 'stored']);

    // the web gets no block at login; it asks for one when it needs to create a customer (online)
    expect(web.body.code_block).toBeNull();
    const wb = await webCall('POST', '/devices/code-block', cookie, { body: {} });
    expect(wb.status).toBe(200);
    const c2 = customer({ code: wb.body.start });
    const p2 = await webCall('POST', '/sync/push', cookie, { body: { customers: [c2], entries: [entry(c2.id, 'RECEIVE', 100)] } });
    expect(p2.status).toBe(200);
    expect(p2.body.results.map((r: { status: string }) => r.status)).toEqual(['stored', 'stored']);

    // the paired owner phone sees both; authorship is the login device
    const pl = await pull(o.token, 0);
    expect(pl.status).toBe(200);
    const ent = pl.body.changes.filter((ch) => ch.tbl === 'entries');
    expect(ent.map((ch) => ch.row.device_id).sort()).toEqual([app.body.device_id, web.body.device_id].sort());
    expect(pl.body.devices.find((d) => d.id === web.body.device_id)).toMatchObject({ client: 'web' });

    // the web session pulls the app's rows and skips its own
    const wp = await webCall('GET', '/sync/pull?since=1', cookie);
    expect(wp.status).toBe(200);
    expect(wp.body.changes.every((ch: { row: { id: string } }) => ch.row.id !== c2.id)).toBe(true);
    expect(wp.body.changes.some((ch: { row: { id: string } }) => ch.row.id === e1.id)).toBe(true);
  });

  it('previous_device_id migrates a paired phone to its login only with that phone token (never another phone)', async () => {
    const { o } = await ownerWithUser();
    await createUser(o.token, 'kumar', 'k-pass');
    const paired = await addDevice(o.token, 'staff', 'Kumar phone');
    // a legacy row's bare id is no proof (ids are public through pulled entries)
    const bare = await login('kumar', 'k-pass', { previous_device_id: paired.device_id });
    expect(bare.status).toBe(200);
    expect((await call('GET', '/me', { token: paired.token })).status).toBe(200);
    const viaLogin = await login('kumar', 'k-pass', { previous_device_id: paired.device_id, previous_device_token: paired.token });
    expect(viaLogin.status).toBe(200);
    expect((await call('GET', '/me', { token: paired.token })).body.error).toBe('revoked');
    // a staff login cannot revoke the owner's phone (even an owner-role login could not: it is another user's)
    const sneaky = await login('kumar', 'k-pass', { previous_device_id: o.device_id });
    expect(sneaky.status).toBe(200);
    expect((await call('GET', '/me', { token: o.token })).status).toBe(200);
  });

  it('the bootstrap owner (link_me) keeps its pairing token and gains a user', async () => {
    const { o, user } = await ownerWithUser();
    const me = await call('GET', '/me', { token: o.token });
    expect(me.body.user).toEqual({ id: user.id, username: 'ravi', display_name: 'Ravi', role: 'owner' });
    expect(me.body.device.user_id).toBe(user.id);
    expect(me.body.device.client).toBeNull();
  });
});
