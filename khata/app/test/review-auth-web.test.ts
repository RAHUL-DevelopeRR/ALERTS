/**
 * Security review of the accounts client (src/sync, src/ui/web, src/ui/screens/login.ts) against plan-findings 12-20.
 * Static checks (XSS sinks, CSP, storage names, built bundle) plus one engine trace that documents an open gap in the
 * web boot path (shared-computer sessions survive a reload into the persisted database; see R-WEB-3).
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
   * Documents the gap, at the engine level: after a shared-computer login the session cookie is alive for 12 h and
   * GET /me says nothing about `shared_computer`, so the resume path (src/ui/web/boot.ts: no local copy -> GET /me ->
   * completePairing + full pull) rebuilds the ledger into whatever repo boot.ts opened, which is the PERSISTED one
   * (openWebRepo(false)). A reload of the tab on a shared computer therefore leaves the whole ledger in IndexedDB.
   * The engine itself cannot tell; the fix belongs in boot.ts (+ a shared/expires flag from /me).
   */
  it('a shared-computer session resumes from the cookie into a fresh (persisted-style) repo with the full ledger', async () => {
    const first = await makePhone(w, { deriveKey: fakeDerive, web: true });
    await first.engine.login('http://localhost:8787', 'ravi', 'owner-pass-1', 'Shared PC', { shared: true });
    await first.engine.requestCodes();
    const c = await first.repo.createCustomer({ name: 'Kamala' });
    await first.repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 10_000 });
    await first.engine.syncNow();
    expect(w.server.webCookie).toMatch(/^tok-/); // the cookie the browser still holds after a reload (12 h, no Max-Age)
    const login = w.server.requests.find((r) => r.path === '/auth/login')!.body as Record<string, unknown>;
    expect(login.shared_computer).toBe(true);

    // reload: boot.ts opens the persisted repo (the memory repo is gone with the page) and calls resumeWebSession
    const reloaded = await makePhone(w, { deriveKey: fakeDerive, web: true });
    expect(await reloaded.engine.resumeWebSession('http://localhost:8787')).toBe(true);
    expect((await reloaded.repo.getSettings()).paired).toBe(true);
    expect(await reloaded.repo.getCustomer(c.id)).not.toBeNull();
    expect(reloaded.engine.getAccount()?.client).toBe('web');
    // nothing in the resumed account says "shared": the UI cannot choose the in-memory database
    expect(JSON.stringify(reloaded.engine.getAccount())).not.toMatch(/shared/);
    const me = w.server.requests.filter((r) => r.path === '/me').at(-1);
    expect(me).toBeDefined();
  });
});
