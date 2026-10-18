/**
 * Security review of the accounts client (src/sync, src/ui/web, src/ui/screens/login.ts) against plan-findings 12-20.
 * Static checks (XSS sinks, CSP, storage names, built bundle) plus engine traces of the shared-computer reload path
 * (R-WEB-3: a shared session is recognisable from GET /me and is never rebuilt into the persisted database).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SQLJS_IDB_NAME } from '../src/ui/web/storage';
import { fakeDerive } from './helpers/fake-server';
import { makePhone, makeWorld, type World } from './helpers/sync';

const APP = join(__dirname, '..');
const API = join(APP, '..', 'api');
const read = (p: string) => readFileSync(p, 'utf8');
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));

describe('R-WEB-1 [F20] CSP and the built web app', () => {
  it('api/web/_headers carries the CSP the sql.js + GIS web app needs, and the hardening headers', () => {
    const headers = read(join(API, 'web', '_headers'));
    const csp = /Content-Security-Policy:\s*(.+)/.exec(headers)?.[1] ?? '';
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style");
    expect(csp).toContain("connect-src 'self' https://accounts.google.com");
    expect(csp).toContain('frame-src https://accounts.google.com');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(headers).toMatch(/X-Content-Type-Options:\s*nosniff/);
    expect(headers).toMatch(/Referrer-Policy:\s*no-referrer/);
    expect(headers).toMatch(/X-Frame-Options:\s*DENY/);
  });

  it('the built web app (dist-web, when present) has no inline script and no eval-style code the CSP would block', () => {
    const html = join(APP, 'dist-web', 'index.html');
    if (!existsSync(html) || !existsSync(join(APP, 'dist-web', 'assets'))) return; // placeholder from prepare-assets.mjs
    const page = read(html);
    const scripts = page.match(/<script[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(s, s).toMatch(/\ssrc=/);
    expect(page).not.toMatch(/\son[a-z]+=/i);
    for (const f of readdirSync(join(APP, 'dist-web', 'assets')).filter((x) => x.endsWith('.js'))) {
      const js = read(join(APP, 'dist-web', 'assets', f));
      expect(js, f).not.toMatch(/\bnew Function\(/);
      expect(js, f).not.toMatch(/[^.\w]eval\(/);
    }
  });
});

describe('R-WEB-2 [F15/F20] XSS sinks and storage names in the new UI', () => {
  it('no innerHTML / outerHTML / insertAdjacentHTML / document.write / srcdoc in the accounts and web UI', () => {
    const files = [
      ...walk(join(APP, 'src', 'ui', 'web')),
      join(APP, 'src', 'ui', 'screens', 'login.ts'),
      join(APP, 'src', 'ui', 'screens', 'settings.ts'),
      join(APP, 'src', 'ui', 'app.ts'),
      join(APP, 'src', 'main.ts'),
      ...walk(join(APP, 'src', 'sync')),
    ];
    expect(files.length).toBeGreaterThan(8);
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|srcdoc/);
    }
    // the only innerHTML in the whole UI is the constant icon markup in components/dom.ts
    const dom = read(join(APP, 'src', 'ui', 'components', 'dom.ts'));
    expect(dom.match(/\.innerHTML\s*=/g)?.length).toBe(1); // the one constant-markup assignment
    expect(dom).toMatch(/t\.innerHTML = `<svg[\s\S]*\$\{ICONS\[name\]\}/);
  });

  it('wipeWebStorage deletes the IndexedDB database sql.js actually writes (the names are kept in sync here)', () => {
    const sqljs = read(join(APP, 'src', 'db', 'sqljs.ts'));
    expect(/const IDB_NAME = '([^']+)'/.exec(sqljs)?.[1]).toBe(SQLJS_IDB_NAME);
    const storage = read(join(APP, 'src', 'ui', 'web', 'storage.ts'));
    expect(storage).toMatch(/localStorage\.clear\(\)/);
    expect(storage).toMatch(/sessionStorage\.clear\(\)/);
    expect(storage).toMatch(/indexedDB\.deleteDatabase\(SQLJS_IDB_NAME\)/);
    // sign-out on the web always wipes (settings.ts offers no "keep data" on the web)
    const settings = read(join(APP, 'src', 'ui', 'screens', 'settings.ts'));
    expect(settings).toMatch(/if \(web\) \{[\s\S]*?endWebSession\(\{ logout: true \}\)/);
    const session = read(join(APP, 'src', 'ui', 'web', 'session.ts'));
    expect(session).toMatch(/logout\(\{ removeData: true, force: true \}\)/);
    expect(session).toMatch(/await wipeWebStorage\(\);\s*window\.location\.replace/);
  });

  it('the web client never stores a token and sends the CSRF header; the Android client refuses weakened PBKDF2 parameters', () => {
    const api = read(join(APP, 'src', 'sync', 'api.ts'));
    expect(api).toMatch(/if \(this\.mode === 'cookie'\) headers\[WEB_CLIENT_HEADER\] = 'web'/);
    expect(api).toMatch(/o\.auth !== false && this\.mode === 'bearer'/);
    expect(api).toMatch(/credentials: 'same-origin'/);
    const pw = read(join(APP, 'src', 'sync', 'password.ts'));
    expect(pw).toMatch(/< PBKDF2_MIN_ITERATIONS/);
    expect(pw).toMatch(/normalize\('NFC'\)/);
  });
});

describe('R-WEB-3 [F17] shared-computer mode: what survives a reload', () => {
  let w: World;
  beforeEach(async () => {
    w = makeWorld();
    await w.server.addUser('ravi', 'owner-pass-1', 'owner', { display_name: 'Ravi' });
  });

  /**
   * Fixed: GET /me now reports device.shared / expires_at (api/src/lib/rows.ts toDeviceInfo, derived from the 12 h
   * expiry) and LoginResponse.shared; the engine records `shared` on the account and exposes webSession() so that
   * src/ui/web/boot.ts can ask the server BEFORE it opens any database: a shared session is rebuilt in the in-memory
   * database again, the persisted one is opened only for a session the server says is not shared. The boot order
   * itself is checked statically below and end to end by e2e/web-login.mjs (shared sign-in -> reload -> no IndexedDB).
   */
  it('a shared-computer session is recognisable on reload: webSession() says shared, the resumed account says shared', async () => {
    const first = await makePhone(w, { deriveKey: fakeDerive, web: true });
    const acc = await first.engine.login('http://localhost:8787', 'ravi', 'owner-pass-1', 'Shared PC', { shared: true });
    expect(acc.shared).toBe(true);
    await first.engine.requestCodes();
    const c = await first.repo.createCustomer({ name: 'Kamala' });
    await first.repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 10_000 });
    await first.engine.syncNow();
    expect(w.server.webCookie).toMatch(/^tok-/); // the cookie the browser still holds after a reload (12 h, no Max-Age)
    expect(w.server.knownCookie).toBeNull(); // and no one-year kk_known cookie on the shared PC (R2d)
    const login = w.server.requests.find((r) => r.path === '/auth/login')!.body as Record<string, unknown>;
    expect(login.shared_computer).toBe(true);

    // reload: boot.ts asks the server first, with no database chosen yet
    const reloaded = await makePhone(w, { deriveKey: fakeDerive, web: true });
    const me = await reloaded.engine.webSession();
    expect(me?.device.shared).toBe(true);
    expect(me?.device.expires_at).toBeTruthy();
    expect(await reloaded.engine.resumeWebSession('http://localhost:8787', me!)).toBe(true);
    expect((await reloaded.repo.getSettings()).paired).toBe(true);
    expect(await reloaded.repo.getCustomer(c.id)).not.toBeNull();
    expect(reloaded.engine.getAccount()).toMatchObject({ client: 'web', shared: true, expires_at: me!.device.expires_at });
  });

  it('a normal (not shared) session resumes with shared absent, and no session at all answers null', async () => {
    const first = await makePhone(w, { deriveKey: fakeDerive, web: true });
    await first.engine.login('http://localhost:8787', 'ravi', 'owner-pass-1', 'Own laptop');
    const reloaded = await makePhone(w, { deriveKey: fakeDerive, web: true });
    const me = await reloaded.engine.webSession();
    expect(me?.device.shared).toBe(false);
    expect(await reloaded.engine.resumeWebSession('http://localhost:8787', me!)).toBe(true);
    expect(reloaded.engine.getAccount()?.shared).toBeUndefined();
    await reloaded.engine.logout({ removeData: true });
    expect(await (await makePhone(w, { deriveKey: fakeDerive, web: true })).engine.webSession()).toBeNull();
  });

  it('boot.ts opens the persisted database only for a known non-shared session and treats an unknown answer as shared', () => {
    const boot = read(join(APP, 'src', 'ui', 'web', 'boot.ts'));
    // the persisted database is opened in exactly two places: an existing copy, and after the server said "not shared"
    expect(boot.match(/openWebRepo\(false\)/g)?.length).toBe(2);
    expect(boot).toMatch(/if \(await hasWebDatabase\(\)\) \{[\s\S]*?openWebRepo\(false\)/);
    expect(boot).toMatch(/if \(!isSharedSession\(me\)\) await goPersisted\(\);/);
    expect(boot).toMatch(/return me\.device\.shared !== false;/); // unknown -> in memory
    // the login gate switches to the persisted database only when the box is not ticked
    expect(boot).toMatch(/if \(shared && mode !== 'memory'\) await goMemory\(\);\s*if \(!shared && mode !== 'persisted'\) await goPersisted\(\);/);
    // the resume path never runs before the session check
    expect(boot.indexOf('app.sync.webSession()')).toBeLessThan(boot.indexOf('resumeWebSession(origin, me)'));
  });
});
