/**
 * v2 accounts in the sync engine against the fake server (test/helpers/fake-server.ts): Android bearer logins, the web
 * app's cookie mode, lockout + known device, logout, step-up for owner powers, user management and web restrictions.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { KNOWN_DEVICE_HEADER, WEB_CLIENT_HEADER } from '../../shared/protocol';
import { RepoError } from '../src/data/types';
import { ACCOUNT_FILE, KNOWN_DEVICE_KEY, TOKEN_KEY } from '../src/sync/engine';
import { SyncError, type StepUpAnswer } from '../src/sync/types';
import { fakeDerive, LOCK_AFTER } from './helpers/fake-server';
import { makePhone, makeWorld, pairPhone, URL_, type Phone, type World } from './helpers/sync';

const PW = 'owner-pass-1';

async function failCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SyncError) return e.code;
    if (e instanceof RepoError) return e.code;
    return `other:${String(e)}`;
  }
  return 'no-throw';
}

/** Records every request's headers (the engine's fetch is wrapped before it reaches the fake server). */
function tapHeaders(w: World): { headers: Record<string, string>[]; fetch: typeof fetch } {
  const headers: Record<string, string>[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const h: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      h[k.toLowerCase()] = v;
    });
    h['__credentials'] = String((init as RequestInit & { credentials?: string })?.credentials ?? '');
    h['__url'] = String(input);
    headers.push(h);
    return w.server.fetch(input, init);
  };
  return { headers, fetch: fetchFn };
}

let w: World;
beforeEach(async () => {
  w = makeWorld();
  await w.server.addUser('ravi', PW, 'owner', { display_name: 'Ravi' });
  await w.server.addUser('mala', 'staff-pass-1', 'staff', { display_name: 'Mala' });
});

async function androidPhone(): Promise<Phone & { headers: Record<string, string>[] }> {
  const tap = tapHeaders(w);
  const p = await makePhone(w, { fetch: tap.fetch, deriveKey: fakeDerive });
  return Object.assign(p, { headers: tap.headers });
}

async function webBrowser(): Promise<Phone & { headers: Record<string, string>[] }> {
  const tap = tapHeaders(w);
  const p = await makePhone(w, { fetch: tap.fetch, deriveKey: fakeDerive, web: true });
  return Object.assign(p, { headers: tap.headers });
}

describe('Android login (bearer)', () => {
  it('prelogin -> derive -> login stores the token and known device, pairs, records the account and syncs', async () => {
    const p = await androidPhone();
    const progress: string[] = [];
    const acc = await p.engine.login(URL_, ' Ravi ', PW, 'Redmi', { onProgress: (x) => progress.push(x) });
    expect(progress).toEqual(['prelogin', 'deriving', 'login']);
    expect(acc.user).toMatchObject({ username: 'ravi', display_name: 'Ravi', role: 'owner' });
    expect(acc.client).toBe('android');
    expect(p.platform.secrets.get(TOKEN_KEY)).toMatch(/^tok-/);
    expect(p.platform.secrets.get(KNOWN_DEVICE_KEY)).toMatch(/\.known$/);
    expect(JSON.parse(p.platform.files.get(ACCOUNT_FILE)!).user.username).toBe('ravi');
    const s = await p.repo.getSettings();
    expect(s.paired).toBe(true);
    expect(s.role).toBe('owner');
    expect(s.device_name).toBe('Redmi');
    expect(p.engine.status()).toMatchObject({ phase: 'idle', pending: 0 });
    expect(await p.repo.codesRemaining()).toBe(50);
    expect(p.engine.getAccount()?.user.username).toBe('ravi');
    expect(w.server.devicesOf('ravi')).toHaveLength(1);
    // The login body carries the derived key only (fakeDerive is a readable stand-in; the real PBKDF2 is covered by
    // test/sync.password.test.ts): no password field, exactly the LoginRequest fields.
    const login = w.server.requests.find((r) => r.path === '/auth/login')!.body as Record<string, unknown>;
    expect(Object.keys(login).sort()).toEqual(['client', 'client_key', 'device_name', 'username']);
    expect(login.client).toBe('android');
    expect(login.client_key).toBe(await fakeDerive(PW, 'salt-user-1', 600_000));
  });

  it('a second login sends X-KK-Known and takes over this phone\'s previous row of the same user', async () => {
    const p = await androidPhone();
    await p.engine.login(URL_, 'ravi', PW, 'Redmi');
    const first = (await p.repo.getSettings()).device_id;
    await p.engine.login(URL_, 'ravi', PW, 'Redmi');
    const loginHeaders = p.headers.filter((h) => h.__url.endsWith('/auth/login'));
    expect(loginHeaders[0][KNOWN_DEVICE_HEADER.toLowerCase()]).toBeUndefined();
    expect(loginHeaders[1][KNOWN_DEVICE_HEADER.toLowerCase()]).toMatch(/\.known$/);
    expect(w.server.devices.get(first)!.info.revoked_at).not.toBeNull();
    expect(w.server.devicesOf('ravi')).toHaveLength(1);
  });

  it('a paired (v1) phone that signs in proves its old row with its token; the old row is revoked', async () => {
    const p = await androidPhone();
    await pairPhone(w, p, 'Old phone');
    const oldId = (await p.repo.getSettings()).device_id;
    const oldToken = p.platform.secrets.get(TOKEN_KEY);
    await p.engine.login(URL_, 'ravi', PW, 'Old phone');
    const login = w.server.requests.find((r) => r.path === '/auth/login')!.body as Record<string, unknown>;
    expect(login.previous_device_id).toBe(oldId);
    expect(login.previous_device_token).toBe(oldToken);
    expect(w.server.devices.get(oldId)!.info.revoked_at).not.toBeNull();
  });

  it('another phone\'s id without its token revokes nothing', async () => {
    const victim = await androidPhone();
    await victim.engine.login(URL_, 'ravi', PW, 'Victim');
    const victimId = (await victim.repo.getSettings()).device_id;
    const attacker = await androidPhone();
    await attacker.repo.setMeta('device_id', victimId); // a device id is public through pulled entries
    await attacker.engine.login(URL_, 'mala', 'staff-pass-1', 'Attacker');
    expect(w.server.devices.get(victimId)!.info.revoked_at).toBeNull();
  });

  it('wrong password and unknown user both fail with invalid_login; 5 failures lock the username', async () => {
    const p = await androidPhone();
    expect(await failCode(p.engine.login(URL_, 'ravi', 'wrong-pass', 'Redmi'))).toBe('invalid_login');
    expect(await failCode(p.engine.login(URL_, 'nobody', 'wrong-pass', 'Redmi'))).toBe('invalid_login');
    expect(await failCode(p.engine.login(URL_, 'ravi', '', 'Redmi'))).toBe('invalid_login');
    expect(await failCode(p.engine.login(URL_, 'r', PW, 'Redmi'))).toBe('bad_username');
    expect((await p.repo.getSettings()).paired).toBe(false);
    expect(p.platform.secrets.has(TOKEN_KEY)).toBe(false);
    for (let i = 1; i < LOCK_AFTER; i++) await failCode(p.engine.login(URL_, 'ravi', 'wrong-pass', 'Redmi'));
    expect(await failCode(p.engine.login(URL_, 'ravi', PW, 'Redmi'))).toBe('locked');
  });

  it('a known device is exempt from the lockout caused by someone else', async () => {
    const owner = await androidPhone();
    await owner.engine.login(URL_, 'ravi', PW, 'Owner phone');
    const attacker = await androidPhone();
    for (let i = 0; i < LOCK_AFTER + 2; i++) await failCode(attacker.engine.login(URL_, 'ravi', 'guess', 'Attacker'));
    expect(await failCode(attacker.engine.login(URL_, 'ravi', PW, 'Attacker'))).toBe('locked');
    await owner.engine.login(URL_, 'ravi', PW, 'Owner phone'); // X-KK-Known from the first login
    expect(owner.engine.getAccount()?.user.username).toBe('ravi');
  });

  it('a disabled user cannot sign in', async () => {
    w.server.userByName('mala')!.info.disabled_at = '2026-01-01T00:00:00.000Z';
    const p = await androidPhone();
    expect(await failCode(p.engine.login(URL_, 'mala', 'staff-pass-1', 'Redmi'))).toBe('invalid_login');
  });
});

describe('logout', () => {
  it('revokes the session on the server and forgets it locally, keeping the data by default', async () => {
    const p = await androidPhone();
    await p.engine.login(URL_, 'ravi', PW, 'Redmi');
    const c = await p.repo.createCustomer({ name: 'Kamala' });
    await p.engine.syncNow();
    const devId = (await p.repo.getSettings()).device_id;
    await p.engine.logout({ removeData: false });
    expect(w.server.devices.get(devId)!.info.revoked_at).not.toBeNull();
    expect(p.platform.secrets.has(TOKEN_KEY)).toBe(false);
    expect(p.platform.secrets.has(KNOWN_DEVICE_KEY)).toBe(true); // keeps the throttle exemption
    expect(p.platform.files.has(ACCOUNT_FILE)).toBe(false);
    expect(p.engine.getAccount()).toBeNull();
    expect((await p.repo.getSettings()).paired).toBe(false);
    expect(await p.repo.getCustomer(c.id)).not.toBeNull();
    expect(p.engine.status().phase).toBe('unpaired');
    expect(w.server.authEvents[0].action).toBe('logout');
  });

  it('removeData deletes the local ledger; offline sign-out needs force', async () => {
    const p = await androidPhone();
    await p.engine.login(URL_, 'ravi', PW, 'Redmi');
    const c = await p.repo.createCustomer({ name: 'Kamala' });
    await p.engine.syncNow();
    w.server.fault({ path: '/auth/logout', mode: 'network' });
    expect(await failCode(p.engine.logout({ removeData: true }))).toBe('network');
    expect((await p.repo.getSettings()).paired).toBe(true);
    w.server.fault({ path: '/auth/logout', mode: 'network' });
    await p.engine.logout({ removeData: true, force: true });
    expect((await p.repo.getSettings()).paired).toBe(false);
    expect(await p.repo.getCustomer(c.id)).toBeNull();
  });
});

describe('web app (cookie mode)', () => {
  it('never sends Authorization, always sends X-KK-Client: web with same-origin credentials, stores no token', async () => {
    const b = await webBrowser();
    const acc = await b.engine.login('http://localhost:8787', 'ravi', PW, 'Chrome on Windows');
    expect(acc.client).toBe('web');
    expect(acc.expires_at).not.toBeNull();
    expect(b.platform.secrets.size).toBe(0);
    expect(w.server.webCookie).toMatch(/^tok-/);
    for (const h of b.headers) {
      expect(h.authorization).toBeUndefined();
      expect(h[WEB_CLIENT_HEADER.toLowerCase()]).toBe('web');
      expect(h.__credentials).toBe('same-origin');
      expect(h.__url.startsWith('/v1/')).toBe(true); // same-origin relative URL
    }
    const s = await b.repo.getSettings();
    expect(s.paired).toBe(true);
    expect(s.server_url).toBe('http://localhost:8787');
    expect(b.engine.status()).toMatchObject({ phase: 'idle', pending: 0 });
    const login = w.server.requests.find((r) => r.path === '/auth/login')!.body as Record<string, unknown>;
    expect(login.client).toBe('web');
    expect(login.previous_device_id).toBeUndefined();
    expect(login.shared_computer).toBeUndefined();
  });

  it('gets no code block: a customer needs requestCodes() first; entries sync; shared flag is sent', async () => {
    const b = await webBrowser();
    await b.engine.login('http://localhost:8787', 'ravi', PW, 'Chrome', { shared: true });
    const login = w.server.requests.find((r) => r.path === '/auth/login')!.body as Record<string, unknown>;
    expect(login.shared_computer).toBe(true);
    expect(await b.repo.codesRemaining()).toBe(0);
    expect(await failCode(b.repo.createCustomer({ name: 'Kamala' }))).toBe('CODES_EXHAUSTED');
    await b.engine.syncNow();
    expect(await b.repo.codesRemaining()).toBe(0); // the web never tops up by itself
    await b.engine.requestCodes();
    expect(await b.repo.codesRemaining()).toBe(50);
    const c = await b.repo.createCustomer({ name: 'Kamala' });
    await b.repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 10_000 });
    await b.engine.syncNow();
    expect(b.engine.status()).toMatchObject({ phase: 'idle', pending: 0 });
    expect(w.server.balance(c.id)).toBe(10_000);
  });

  it('staff cannot sign in on the web (web_owner_only) even with the right password', async () => {
    const b = await webBrowser();
    expect(await failCode(b.engine.login('http://localhost:8787', 'mala', 'staff-pass-1', 'Chrome'))).toBe('web_owner_only');
    expect(w.server.webCookie).toBeNull();
    expect((await b.repo.getSettings()).paired).toBe(false);
  });

  it('a request without the CSRF header is refused by the server (csrf)', async () => {
    const b = await webBrowser();
    await b.engine.login('http://localhost:8787', 'ravi', PW, 'Chrome');
    const r = await w.server.fetch('https://x/v1/me', { method: 'GET' });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toBe('csrf');
  });

  it('resumeWebSession rebuilds the pairing from a valid cookie (and answers false without one)', async () => {
    const first = await webBrowser();
    await first.engine.login('http://localhost:8787', 'ravi', PW, 'Chrome');
    await first.engine.requestCodes();
    const c = await first.repo.createCustomer({ name: 'Kamala' });
    await first.engine.syncNow();
    const again = await webBrowser(); // same browser, site data cleared: the cookie survived
    expect(await again.engine.resumeWebSession('http://localhost:8787')).toBe(true);
    expect(again.engine.getAccount()?.user.username).toBe('ravi');
    expect(await again.repo.getCustomer(c.id)).not.toBeNull();
    await again.engine.logout({ removeData: true });
    const third = await webBrowser();
    expect(await third.engine.resumeWebSession('http://localhost:8787')).toBe(false);
  });

  it('an expired session (401) turns into phase revoked with the unsynced count kept for the UI', async () => {
    const b = await webBrowser();
    await b.engine.login('http://localhost:8787', 'ravi', PW, 'Chrome');
    await b.engine.requestCodes();
    const c = await b.repo.createCustomer({ name: 'Kamala' });
    await b.engine.syncNow();
    await b.repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 500 });
    w.server.webCookie = null; // the browser lost the cookie (expired)
    const st = await b.engine.syncNow();
    expect(st.phase).toBe('revoked');
    expect(b.engine.lastRevokedPending).toBe(1);
    expect(b.engine.getAccount()).toBeNull();
  });

  it('web sessions cannot use owner powers (web_forbidden) but can read users and events', async () => {
    const b = await webBrowser();
    await b.engine.login('http://localhost:8787', 'ravi', PW, 'Chrome');
    expect(await failCode(b.engine.createPairCode('staff'))).toBe('web_forbidden');
    expect(await failCode(b.engine.createUser({ username: 'newuser', display_name: 'New', role: 'staff', password: 'password-9' }))).toBe('web_forbidden');
    expect((await b.engine.listUsers()).map((u) => u.username)).toEqual(['ravi', 'mala']);
    expect((await b.engine.authEvents())[0].action).toBe('login.ok');
  });

  it('Google sign-in: nonce from the server, id token to /auth/google (404 -> google_off when off)', async () => {
    const b = await webBrowser();
    expect(await failCode(b.engine.nonce('http://localhost:8787'))).toBe('google_off');
    expect((await b.engine.config('http://localhost:8787')).google_client_id).toBeNull();
    w.server.googleIds = ['web-client-id.apps.googleusercontent.com'];
    expect((await b.engine.config('http://localhost:8787')).google_client_id).toBe('web-client-id.apps.googleusercontent.com');
    const nonce = await b.engine.nonce('http://localhost:8787');
    expect(await failCode(b.engine.googleLogin('http://localhost:8787', `fake-google:ravi@gmail.com:${nonce}`, 'Chrome'))).toBe('not_linked');
    w.server.userByName('ravi')!.info.google_email = 'ravi@gmail.com';
    const nonce2 = await b.engine.nonce('http://localhost:8787');
    const acc = await b.engine.googleLogin('http://localhost:8787', `fake-google:ravi@gmail.com:${nonce2}`, 'Chrome');
    expect(acc.user.username).toBe('ravi');
    // The nonce is single use.
    expect(await failCode(b.engine.googleLogin('http://localhost:8787', `fake-google:ravi@gmail.com:${nonce2}`, 'Chrome'))).toBe('invalid_token');
  });
});

describe('step-up and user management (owner phone)', () => {
  async function ownerPhone(answers: StepUpAnswer[] = []): Promise<Phone & { headers: Record<string, string>[]; asked: number }> {
    const p = await androidPhone();
    const out = Object.assign(p, { asked: 0 });
    p.engine.setStepUpProvider(async () => {
      out.asked++;
      return answers.shift() ?? null;
    });
    await p.engine.login(URL_, 'ravi', PW, 'Owner phone');
    return out;
  }

  it('owner powers need step-up: without a provider the error passes through, with the password it succeeds once per window', async () => {
    const p = await androidPhone();
    await p.engine.login(URL_, 'ravi', PW, 'Owner phone');
    const err = await failCode(p.engine.createPairCode('staff'));
    expect(err).toBe('stepup_required');
    p.engine.setStepUpProvider(async (req) => {
      expect(req.can).toEqual(['password', 'recovery']);
      return { kind: 'password', password: PW };
    });
    const code = await p.engine.createPairCode('staff');
    expect(code.code).toMatch(/^\d{8}$/);
    const stepups = p.headers.filter((h) => h['x-kk-stepup']);
    expect(stepups).toHaveLength(1);
    expect(stepups[0]['x-kk-stepup']).toBe(w.server.userByName('ravi')!.client_key);
    // Inside the 5-minute window no new proof is needed.
    await p.engine.createPairCode('owner');
    expect(p.headers.filter((h) => h['x-kk-stepup'])).toHaveLength(1);
    w.timers.advance(6 * 60_000);
    await p.engine.createPairCode('owner');
    expect(p.headers.filter((h) => h['x-kk-stepup'])).toHaveLength(2);
    expect(w.server.authEvents.filter((e) => e.action === 'stepup.ok')).toHaveLength(2);
  });

  it('a wrong password is asked again (retry flag), cancelling gives "cancelled", a recovery code works too', async () => {
    const p = await ownerPhone([{ kind: 'password', password: 'wrong-one' }, { kind: 'password', password: PW }]);
    const seen: boolean[] = [];
    const prev = async (): Promise<StepUpAnswer | null> => null;
    void prev;
    p.engine.setStepUpProvider(async (req) => {
      seen.push(req.retry);
      return seen.length === 1 ? { kind: 'password', password: 'wrong-one' } : { kind: 'password', password: PW };
    });
    await p.engine.createPairCode('staff');
    expect(seen).toEqual([false, true]);
    expect(w.server.authEvents.some((e) => e.action === 'stepup.failed')).toBe(true);

    w.timers.advance(6 * 60_000);
    p.engine.setStepUpProvider(async () => null);
    expect(await failCode(p.engine.createRecoveryCodes())).toBe('cancelled');

    p.engine.setStepUpProvider(async () => ({ kind: 'password', password: PW }));
    const codes = await p.engine.createRecoveryCodes();
    w.timers.advance(6 * 60_000);
    p.engine.setStepUpProvider(async () => ({ kind: 'recovery', code: codes[0] }));
    await p.engine.createPairCode('staff');
    expect(p.headers.filter((h) => h['x-kk-recovery'])).toHaveLength(1);
    expect(w.server.recovery.size).toBe(codes.length - 1);
  });

  it('creates, lists, edits, disables and resets users; a disabled user\'s phone is revoked', async () => {
    const p = await ownerPhone([{ kind: 'password', password: PW }]);
    const u = await p.engine.createUser({ username: 'Kumar', display_name: 'Kumar', role: 'staff', password: 'kumar-pass-1' });
    expect(u).toMatchObject({ username: 'kumar', role: 'staff', has_password: true });
    expect(p.asked).toBe(1);
    expect(await failCode(p.engine.createUser({ username: 'kumar', display_name: 'K', role: 'staff', password: 'kumar-pass-1' }))).toBe('username_taken');
    expect(await failCode(p.engine.createUser({ username: 'short', display_name: 'S', role: 'staff', password: 'short' }))).toBe('password_short');
    expect(await failCode(p.engine.createUser({ username: 'gonly', display_name: 'G', role: 'staff', google_email: 'g@yahoo.com' }))).toBe('bad_request');
    const g = await p.engine.createUser({ username: 'gonly', display_name: 'G', role: 'staff', google_email: 'G@Gmail.com' });
    expect(g).toMatchObject({ has_password: false, google_email: 'g@gmail.com', google_linked: false });
    expect((await p.engine.listUsers()).map((x) => x.username)).toEqual(['ravi', 'mala', 'kumar', 'gonly']);

    const kumar = await androidPhone();
    await kumar.engine.login(URL_, 'kumar', 'kumar-pass-1', 'Kumar phone');
    const renamed = await p.engine.updateUser(u.id, { display_name: 'Kumar S' });
    expect(renamed.display_name).toBe('Kumar S');
    const disabled = await p.engine.updateUser(u.id, { disabled: true });
    expect(disabled.disabled_at).not.toBeNull();
    expect((await kumar.engine.syncNow()).phase).toBe('revoked');
    await p.engine.updateUser(u.id, { disabled: false });
    expect(await failCode(kumar.engine.login(URL_, 'kumar', 'kumar-pass-1', 'Kumar phone'))).toBe('no-throw');

    await p.engine.resetPassword(u.id, 'new-kumar-pass');
    expect((await kumar.engine.syncNow()).phase).toBe('revoked');
    expect(await failCode(kumar.engine.login(URL_, 'kumar', 'kumar-pass-1', 'Kumar phone'))).toBe('invalid_login');
    await kumar.engine.login(URL_, 'kumar', 'new-kumar-pass', 'Kumar phone');
    expect(await failCode(p.engine.updateUser(p.engine.getAccount()!.user.id, { role: 'staff' }))).toBe('cannot_change_own_role');
    expect(await failCode(p.engine.updateUser(p.engine.getAccount()!.user.id, { disabled: true }))).toBe('cannot_disable_self');
    const actions = (await p.engine.authEvents()).map((e) => e.action);
    expect(actions).toContain('user.create');
    expect(actions).toContain('password.reset');
  });

  it('a paired owner phone without a login creates its own (link_me) with no step-up while the shop has no users', async () => {
    w.server.users.clear();
    const p = await androidPhone();
    await pairPhone(w, p, 'Owner phone');
    expect(p.engine.getAccount()).toBeNull();
    const me = await p.engine.createUser({ username: 'ravi', display_name: 'Ravi', role: 'owner', password: PW, link_me: true });
    expect(me.username).toBe('ravi');
    expect(p.engine.getAccount()?.user.id).toBe(me.id);
    expect(p.headers.filter((h) => h['x-kk-stepup'] || h['x-kk-recovery'])).toHaveLength(0);
    // From now on the phone must step up (its password works since the device is linked).
    expect(await failCode(p.engine.createPairCode('staff'))).toBe('stepup_required');
    p.engine.setStepUpProvider(async () => ({ kind: 'password', password: PW }));
    await p.engine.createPairCode('staff');
    expect(await failCode(p.engine.createUser({ username: 'other', display_name: 'O', role: 'owner', password: PW, link_me: true }))).toBe('already_linked');
  });

  it('the signed-in user changes their own password; other sessions of that user are revoked', async () => {
    const p = await ownerPhone();
    const other = await androidPhone();
    await other.engine.login(URL_, 'ravi', PW, 'Second phone');
    expect(await failCode(p.engine.changeOwnPassword('wrong', 'brand-new-pass'))).toBe('invalid_login');
    expect(await failCode(p.engine.changeOwnPassword(PW, 'short'))).toBe('password_short');
    await p.engine.changeOwnPassword(PW, 'brand-new-pass');
    expect((await p.engine.syncNow()).phase).toBe('idle');
    expect((await other.engine.syncNow()).phase).toBe('revoked');
    await other.engine.login(URL_, 'ravi', 'brand-new-pass', 'Second phone');
  });
});
