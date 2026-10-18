#!/usr/bin/env node
/**
 * End-to-end check of the WEB APP against a real local Worker:
 *   vite build --mode web  ->  wrangler dev --local (fresh D1, migrations applied)  ->  bootstrap a shop, a paired owner
 *   phone, the owner login "ravi" and a staff login "mala" through the API  ->  Chromium: login screen (ta/en), wrong
 *   password, staff refused (web_owner_only, bilingual), sign in, synced customers, add an entry and a customer (code
 *   block on demand), Settings (account, users, activity), session revoked from the phone -> "session ended", sign out
 *   wipes IndexedDB + localStorage, shared-computer mode leaves no IndexedDB and ends with the browser.
 * Screenshots: e2e/screenshots/web-NN-name.png. Exits non-zero on the first failed assertion. Stops wrangler dev.
 *
 *   node e2e/web-login.mjs                 # everything
 *   E2E_KEEP_BUILD=1 node e2e/web-login.mjs   # skip `vite build --mode web` (use the existing dist-web)
 */
import { execFileSync, spawn } from 'node:child_process';
import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = join(ROOT, '..', 'api');
const SHOTS = join(ROOT, 'e2e', 'screenshots');
const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const WRANGLER = join(API, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const STATE = join(API, '.wrangler', 'e2e-web-state'); // isolated local D1 (gitignored with .wrangler/)
const ITER = 600_000;
const OWNER = { username: 'ravi', password: 'owner-pass-1' };
const STAFF = { username: 'mala', password: 'staff-pass-1' };

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const derive = (password, saltB64) => b64url(pbkdf2Sync(password.normalize('NFC'), Buffer.from(saltB64, 'base64url'), ITER, 32, 'sha256'));

function devVars() {
  const file = join(API, '.dev.vars');
  if (!existsSync(file)) writeFileSync(file, `PEPPER=${randomBytes(24).toString('base64url')}\nSETUP_KEY=${randomBytes(12).toString('base64url')}\n`);
  const vars = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) vars[m[1]] = m[2];
  }
  if (!vars.SETUP_KEY) {
    vars.SETUP_KEY = randomBytes(12).toString('base64url');
    writeFileSync(file, readFileSync(file, 'utf8').trimEnd() + `\nSETUP_KEY=${vars.SETUP_KEY}\n`);
  }
  return vars;
}

async function startWorker() {
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true });
  execFileSync(process.execPath, [WRANGLER, 'd1', 'migrations', 'apply', 'khata', '--local', '--persist-to', STATE], {
    cwd: API, stdio: 'inherit', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
  });
  const port = await freePort();
  const proc = spawn(process.execPath, [WRANGLER, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', STATE, '--show-interactive-dev-session=false'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 600; i++) {
    try {
      const r = await fetch(`${url}/v1/health`);
      if (r.ok) return { url, stop: () => proc.kill('SIGTERM'), log: () => out };
    } catch {
      /* not up yet */
    }
    if (proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill('SIGTERM');
  throw new Error(`wrangler dev did not come up:\n${out}`);
}

/** JSON call helper for the bootstrap (bearer token of the paired owner phone). */
async function api(base, method, path, { token, headers = {}, body } = {}) {
  const r = await fetch(`${base}/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json ?? text };
}

function must(res, what) {
  if (res.status !== 200) throw new Error(`${what}: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Shop + owner phone + logins + two customers with entries, all through the API as the phone app would. */
async function bootstrap(base, setupKey) {
  const setup = must(await api(base, 'POST', '/setup', { headers: { 'X-Setup-Key': setupKey }, body: { shop_name: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்' } }), 'setup');
  const phone = must(await api(base, 'POST', '/pair', { body: { code: setup.code, device_name: 'Owner phone' } }), 'pair');
  const salt = b64url(randomBytes(16));
  const owner = must(await api(base, 'POST', '/users', {
    token: phone.token,
    body: { username: OWNER.username, display_name: 'Ravi', role: 'owner', link_me: true, salt, iterations: ITER, client_key: derive(OWNER.password, salt) },
  }), 'create owner user');
  const stepup = { 'X-KK-Stepup': derive(OWNER.password, salt) };
  const staffSalt = b64url(randomBytes(16));
  must(await api(base, 'POST', '/users', {
    token: phone.token, headers: stepup,
    body: { username: STAFF.username, display_name: 'Mala', role: 'staff', salt: staffSalt, iterations: ITER, client_key: derive(STAFF.password, staffSalt) },
  }), 'create staff user');
  const now = new Date().toISOString();
  const day = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10); // today in IST
  const cust = (code, name, phoneNo) => ({
    id: randomUUID(), code, name, search_name: null, phone: phoneNo, note: null, archived_at: null, erased_at: null,
    created_at: now, updated_at: now, updated_by: phone.device_id,
  });
  const kamala = cust(phone.code_block.start, 'Kamala', '+919876543210');
  const murugan = cust(phone.code_block.start + 1, 'Murugan', null);
  const entry = (c, kind, amount, mode = null) => ({
    id: randomUUID(), customer_id: c.id, kind, amount_paise: amount, delta_paise: kind === 'GIVE' ? amount : -amount,
    biz_date: day, note: null, mode, reverses_entry_id: null, device_id: phone.device_id, created_at: now,
  });
  const push = must(await api(base, 'POST', '/sync/push', {
    token: phone.token,
    body: { customers: [kamala, murugan], entries: [entry(kamala, 'GIVE', 25_000), entry(kamala, 'RECEIVE', 10_000, 'CASH'), entry(murugan, 'GIVE', 15_000)] },
  }), 'push');
  if (push.results.some((r) => r.status !== 'stored')) throw new Error(`push rejected: ${JSON.stringify(push.results)}`);
  return { phone, owner, stepup, kamala, murugan };
}

let failures = 0;
let shotNo = 0;
const log = (...a) => console.log('  ', ...a);

function check(cond, msg) {
  if (!cond) {
    failures++;
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
  log(`ok  ${msg}`);
}

async function main() {
  if (!process.env.E2E_KEEP_BUILD) execFileSync(process.execPath, [VITE, 'build', '--mode', 'web'], { cwd: ROOT, stdio: 'inherit' });
  for (const f of ['web-']) {
    mkdirSync(SHOTS, { recursive: true });
    for (const name of (await import('node:fs')).readdirSync(SHOTS)) if (name.startsWith(f)) rmSync(join(SHOTS, name));
  }
  const vars = devVars();
  const worker = await startWorker();
  console.log(`worker: ${worker.url}`);
  const browser = await chromium.launch();
  const makeContext = () => browser.newContext({ viewport: { width: 1024, height: 768 }, locale: 'ta-IN', timezoneId: 'Asia/Kolkata', acceptDownloads: true });
  let context = await makeContext();
  let page = await context.newPage();
  const consoleErrors = [];
  const watch = (p) => {
    p.on('console', (m) => {
      // Chromium logs failed HTTP responses (our expected 401/403 answers) as console errors: not app errors.
      if (m.type() === 'error' && !/Failed to load resource|status of (401|403|404|429)/.test(m.text())) consoleErrors.push(m.text());
    });
    p.on('pageerror', (e) => consoleErrors.push(String(e)));
  };
  watch(page);

  const tid = (id) => page.locator(`[data-testid="${id}"]`);
  const text = async (sel) => (await page.locator(sel).first().innerText()).trim();
  const settle = () => page.waitForTimeout(300);
  async function shot(name) {
    await settle();
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    const file = join(SHOTS, `web-${String(++shotNo).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: file });
    log(`shot ${file}`);
  }
  async function typeAmount(digits) {
    for (const d of digits) await page.locator(`.keypad [data-key="${d}"]`).click();
  }
  async function toast() {
    const el = page.locator('.toast .toast-msg');
    await el.waitFor({ timeout: 8000 });
    return (await el.innerText()).trim();
  }
  const storageState = () => page.evaluate(async () => ({
    idb: (await indexedDB.databases()).map((d) => d.name),
    ls: Object.keys(localStorage),
  }));
  /** Does the persisted sql.js database (if any) contain `needle` (e.g. a customer name)? */
  const ledgerContains = (needle) => page.evaluate(async (needle) => {
    const names = (await indexedDB.databases()).map((d) => d.name);
    if (!names.includes('kadan-kanakku-sqljs')) return false;
    return new Promise((resolve) => {
      const req = indexedDB.open('kadan-kanakku-sqljs');
      req.onsuccess = () => {
        const db = req.result;
        try {
          const get = db.transaction('db', 'readonly').objectStore('db').get('kadan-kanakku');
          get.onsuccess = () => {
            const v = get.result;
            const bytes = v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array();
            db.close();
            resolve(new TextDecoder('latin1').decode(bytes).includes(needle));
          };
          get.onerror = () => { db.close(); resolve(false); };
        } catch { db.close(); resolve(false); }
      };
      req.onerror = () => resolve(false);
    });
  }, needle);
  async function signIn(user, pw, { shared = false } = {}) {
    await tid('web-user').fill(user);
    await tid('web-pw').fill(pw);
    if (shared) await tid('web-shared').check();
    await tid('web-submit').click();
  }
  const home = () => page.locator('.screen[data-route="home"]').waitFor({ timeout: 30_000 });
  /** Back to home, Settings -> "Sync now" (instead of waiting for the 30 s write debounce), back to home. */
  async function syncNow() {
    for (let i = 0; i < 4 && !(await page.locator('.screen[data-route="home"]').count()); i++) await page.keyboard.press('Escape');
    await home();
    await tid('nav-settings').click();
    await page.locator('.screen[data-route="settings"]').waitFor();
    await tid('sync-now').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="sync-now"]')?.disabled, null, { timeout: 40_000 });
    await page.keyboard.press('Escape');
    await home();
    await page.waitForFunction(() => document.querySelector('[data-testid="sync-pill"]')?.textContent === 'Online copy', null, { timeout: 40_000 });
  }
  const loginForm = () => tid('web-form').waitFor({ timeout: 30_000 });

  try {
    console.log('bootstrap');
    const boot = await bootstrap(worker.url, vars.SETUP_KEY);
    log(`owner user ${boot.owner.user.username}, phone ${boot.phone.device_id}`);

    console.log('login screen');
    await page.goto(`${worker.url}/`);
    await loginForm();
    check((await text('.web-login-card h2')) === 'கடைக் கணக்கில் உள்நுழை', 'Tamil login title');
    check((await page.locator('[data-testid="web-google"]:visible').count()) === 0, 'no Google button while GOOGLE_CLIENT_IDS is empty');
    await shot('login-ta');
    await tid('web-lang-en').click();
    await loginForm();
    check((await text('.web-login-card h2')) === 'Sign in to the shop ledger', 'English login title after the toggle');
    await shot('login-en');

    console.log('wrong password');
    await signIn(OWNER.username, 'wrong-pass-1');
    await page.waitForFunction(() => document.querySelector('[data-testid="web-error"]')?.classList.contains('hidden') === false);
    check((await text('[data-testid="web-error"]')) === 'Wrong user id or password.', 'wrong password message');
    check((await tid('web-pw').inputValue()) === '', 'password field cleared after a wrong password');
    await shot('login-wrong-password');

    console.log('staff refused on the web');
    await signIn(STAFF.username, STAFF.password);
    await page.waitForFunction(() => /owner only/.test(document.querySelector('[data-testid="web-error"]')?.textContent ?? ''));
    const refused = await text('[data-testid="web-error"]');
    check(refused.includes('இணைய உள்நுழைவு உரிமையாளருக்கு மட்டும்') && refused.includes('Web sign-in is for the owner only'), 'web_owner_only shown in Tamil + English');
    await shot('login-staff-refused');

    console.log('owner signs in');
    await signIn(OWNER.username, OWNER.password);
    await page.waitForFunction(() => /Signing in|Securing|Contacting/.test(document.querySelector('[data-testid="web-submit"]')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => undefined);
    await home();
    check((await text('.topbar h1')).includes('ஸ்ரீ முருகன் ஸ்டோர்ஸ்'), 'home shows the shop name from the server');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="cust-row"]').length >= 2, null, { timeout: 15_000 });
    const names = await page.locator('[data-testid="cust-row"]').allInnerTexts();
    check(names.some((n) => n.includes('Kamala')) && names.some((n) => n.includes('Murugan')), 'synced customers Kamala and Murugan are listed');
    // The shop language (Tamil, shared by every device) wins over the login page's toggle after sign-in.
    await page.waitForFunction(() => document.querySelector('[data-testid="sync-pill"]')?.textContent === 'ஆன்லைன் நகல்', null, { timeout: 15_000 });
    check((await text('[data-testid="sync-pill"]')) === 'ஆன்லைன் நகல்', 'pill says "Online copy" in the shop language (Tamil)');
    await shot('home-ta');
    await tid('nav-settings').click();
    await page.locator('.screen[data-route="settings"]').waitFor();
    await tid('set-lang-en').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="set-lang-en"]')?.classList.contains('on'));
    await page.keyboard.press('Escape');
    await home();
    await page.waitForFunction(() => document.querySelector('[data-testid="sync-pill"]')?.textContent?.includes('Online copy'), null, { timeout: 15_000 });
    check((await text('[data-testid="sync-pill"]')) === 'Online copy', 'pill says "Online copy"');
    check((await text('.summary-amt')) === '₹300', 'home total ₹300 (Kamala 150 + Murugan 150)');
    const st1 = await storageState();
    check(st1.idb.includes('kadan-kanakku-sqljs'), 'IndexedDB copy exists after a normal sign-in');
    check(!st1.ls.some((k) => /token|secret/.test(k)), `no token in localStorage (${st1.ls.join(',')})`);
    const cookies = await context.cookies();
    check(cookies.some((c) => c.name === 'kk_session' && c.httpOnly), 'kk_session cookie is HttpOnly');
    check(cookies.some((c) => c.name === 'kk_known'), 'kk_known cookie set');
    await shot('home-en');

    console.log('add an entry from the web');
    await page.locator('[data-testid="cust-row"]', { hasText: 'Kamala' }).first().click();
    await page.locator('.screen[data-route="customer"]').waitFor();
    check((await page.locator('[data-testid="act-call"]:visible').count()) === 0, 'Call button hidden on the web');
    await tid('btn-got').click();
    await page.locator('.screen[data-route="entry"]').waitFor();
    await typeAmount('100');
    await shot('entry-got');
    await tid('entry-save').click();
    await page.locator('.screen[data-route="customer"]').waitFor();
    check((await toast()).includes('₹50'), 'toast shows the new balance ₹50');
    check((await text('[data-testid="balance"]')) === '₹50', 'balance ₹50 after the credit');
    await shot('customer-after-credit');
    await syncNow();
    const exp1 = must(await api(worker.url, 'GET', '/export', { token: boot.phone.token }), 'export');
    check(exp1.entries.filter((e) => e.customer_id === boot.kamala.id).length === 3, 'server has the entry the web added');
    check(exp1.entries.some((e) => e.device_id !== boot.phone.device_id && e.amount_paise === 10_000 && e.kind === 'RECEIVE'), 'entry authored by the web device');

    console.log('add a customer from the web (code block on demand)');
    await tid('add-customer').click();
    await tid('cust-name').fill('Selvi');
    await tid('cust-save').click();
    await page.locator('.screen[data-route="customer"]').waitFor({ timeout: 30_000 });
    check((await text('.topbar h1')).includes('Selvi'), 'new customer Selvi opened');
    await syncNow();
    const exp2 = must(await api(worker.url, 'GET', '/export', { token: boot.phone.token }), 'export');
    const selvi = exp2.customers.find((c) => c.name === 'Selvi');
    check(!!selvi && selvi.code > boot.phone.code_block.end, `Selvi on the server with a code from the web's own block (${selvi?.code})`);
    const webDevices = exp2.devices.filter((d) => d.client === 'web' && !d.revoked_at);
    check(webDevices.length === 1, 'exactly one live web device on the server');

    console.log('settings on the web');
    await tid('nav-settings').click();
    await page.locator('.screen[data-route="settings"]').waitFor();
    await page.waitForFunction(() => /ravi/.test(document.querySelector('[data-testid="account-line"]')?.textContent ?? ''));
    check((await text('[data-testid="account-line"]')).includes('Ravi (ravi)'), 'account line shows the signed-in owner');
    await page.waitForFunction(() => document.querySelector('[data-testid="user-mala"]'), null, { timeout: 15_000 });
    check((await page.locator('[data-testid="user-mala"]').count()) === 1, 'users list shows mala (read-only on the web)');
    check((await page.locator('[data-testid="add-user"]').count()) === 0, 'no "Add user" on the web (phone only)');
    await page.waitForFunction(() => document.querySelector('[data-testid="activity-list"] .set-row'), null, { timeout: 15_000 });
    const activity = await page.locator('[data-testid="activity-list"]').innerText();
    check(activity.includes('Signed in'), 'activity list shows the sign-in');
    check((await page.locator('[data-testid="set-pin"]').count()) === 0, 'no PIN section on the web');
    check((await page.locator('[data-testid="srv-open"]').count()) === 0, 'no pairing form on the web');
    await page.locator('#sec-sync').scrollIntoViewIfNeeded();
    await shot('settings-en');

    console.log('session revoked from the owner phone -> session ended');
    must(await api(worker.url, 'POST', `/devices/${webDevices[0].id}/revoke`, { token: boot.phone.token, headers: boot.stepup, body: { wipe: false } }), 'revoke web device');
    await page.reload();
    await loginForm();
    await page.waitForFunction(() => document.querySelector('[data-testid="web-notice"]'), null, { timeout: 15_000 });
    check((await text('[data-testid="web-notice"]')).includes('session has ended'), 'login page explains that the session ended');
    check(!(await ledgerContains('Kamala')), 'local ledger copy dropped after the revoked session');
    check((await page.locator('[data-testid="web-notice"]').innerText()).includes('session has ended') && (await text('.web-login-card h2')) === 'Sign in to the shop ledger', 'language kept (English) across the wipe');
    await shot('session-ended');

    console.log('sign in again, then sign out (wipes the browser copy)');
    await signIn(OWNER.username, OWNER.password);
    await home();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="cust-row"]').length >= 3, null, { timeout: 15_000 });
    await tid('nav-settings').click();
    await page.locator('.screen[data-route="settings"]').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="sign-out"]'));
    await tid('sign-out').click();
    await page.locator('.dialog .btn-danger').click();
    await loginForm();
    const st3 = await storageState();
    check(!(await ledgerContains('Kamala')) && !(await ledgerContains('Selvi')), 'IndexedDB ledger copy wiped at sign-out');
    check(!st3.ls.includes('preview-file:account.json'), 'account file removed from localStorage');
    const cookies2 = await context.cookies();
    check(!cookies2.some((c) => c.name === 'kk_session'), 'session cookie cleared by /auth/logout');
    const exp3 = must(await api(worker.url, 'GET', '/export', { token: boot.phone.token }), 'export');
    check(exp3.devices.filter((d) => d.client === 'web' && !d.revoked_at).length === 0, 'web device revoked on the server');
    await shot('signed-out');

    console.log('shared computer mode');
    await signIn(OWNER.username, OWNER.password, { shared: true });
    await home();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="cust-row"]').length >= 3, null, { timeout: 15_000 });
    const st4 = await storageState();
    check(!st4.idb.includes('kadan-kanakku-sqljs'), `shared mode: no IndexedDB database (${st4.idb.join(',')})`);
    check(!st4.ls.includes('preview-file:account.json'), 'shared mode: no account file in localStorage');
    const cookies3 = await context.cookies();
    const sess = cookies3.find((c) => c.name === 'kk_session');
    check(!!sess && (sess.expires === -1 || sess.expires === undefined), 'shared mode: session cookie has no Max-Age (dies with the browser)');
    const exp4 = must(await api(worker.url, 'GET', '/export', { token: boot.phone.token }), 'export');
    const sharedDev = exp4.devices.find((d) => d.client === 'web' && !d.revoked_at);
    check(!!sharedDev, 'shared session device live on the server');
    await shot('shared-home');
    await tid('nav-settings').click();
    await page.locator('.screen[data-route="settings"]').waitFor();
    await page.waitForFunction(() => /ravi/.test(document.querySelector('[data-testid="account-line"]')?.textContent ?? ''));
    check((await text('#sec-sync')).includes('Session ends'), 'settings shows when the shared session ends');
    await page.locator('#sec-sync').scrollIntoViewIfNeeded();
    await shot('shared-settings');
    // The browser closes: a new context has no session cookie -> login page, and nothing was left behind.
    await context.close();
    context = await makeContext();
    page = await context.newPage();
    watch(page);
    await page.goto(`${worker.url}/`);
    await loginForm();
    const st5 = await storageState();
    check(!st5.ls.includes('preview-file:account.json'), 'new browser session: nothing kept');
    await shot('after-shared-browser-closed');

    check(consoleErrors.length === 0, `no console errors ${consoleErrors.join(' | ')}`);
  } catch (e) {
    console.error(e);
    failures = Math.max(failures, 1);
    try {
      await page.screenshot({ path: join(SHOTS, `web-${String(++shotNo).padStart(2, '0')}-FAILED.png`) });
    } catch {
      /* ignore */
    }
  } finally {
    await browser.close();
    worker.stop();
  }
  console.log(failures ? `FAILED (${failures})` : 'ALL WEB FLOWS PASSED');
  process.exit(failures ? 1 : 0);
}

main();
