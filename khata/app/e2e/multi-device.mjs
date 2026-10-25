#!/usr/bin/env node
/**
 * Two phones of one shop against a real local Worker (wrangler dev --local, fresh D1): fast sync and sign-in with
 * user id + password.
 *
 *   wrangler dev  ->  vite build with the server built in (VITE_SHOP_SERVER_URL, as the release APK gets it)  ->
 *   Chromium, two isolated profiles (two phones):
 *     owner phone: first run "Start a new shop", customers, Settings -> First-time setup with the setup key AND the
 *       owner's own user id + password, Users -> Add user (staff, step-up with the owner's password);
 *     counter phone: first run "Sign in to my shop" with only the staff user id + password (server built in);
 *   then: an entry on one phone appears on the other by itself (2 s push + 20 s poll, live redraw), a customer's
 *   page is fresh at once when opened, the other direction, the Home "Sync" button (top right; before connecting it
 *   says the phone is not connected) fetches the other phone's entry at once and says so, Sync with no internet says so, an offline phone
 *   catches up when back online, and a phone where someone is typing in the search box is not redrawn under their
 *   fingers.
 * Screenshots: e2e/screenshots/md-NN-name.png. Exits non-zero on the first failed assertion. Stops wrangler dev.
 *
 *   node e2e/multi-device.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = join(ROOT, '..', 'api');
const SHOTS = join(ROOT, 'e2e', 'screenshots');
const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const WRANGLER = join(API, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const STATE = join(API, '.wrangler', 'e2e-multi-state'); // isolated local D1 (gitignored with .wrangler/)
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

function setupKey() {
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
  return vars.SETUP_KEY;
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

async function startApp(serverUrl) {
  // The phone app (not the web app), with the shop server built in exactly as tools/build-release-apk.sh does.
  execFileSync(process.execPath, [VITE, 'build'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, VITE_SHOP_SERVER_URL: serverUrl } });
  const port = await freePort();
  const proc = spawn(process.execPath, [VITE, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { url, stop: () => proc.kill() };
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

/** Helpers bound to one phone (one browser profile). */
function phone(page, label) {
  const tid = (id) => page.locator(`[data-testid="${id}"]`);
  const text = async (sel) => (await page.locator(sel).first().innerText()).trim();
  const settle = () => page.waitForTimeout(250);
  const pulls = [];
  const reqs = [];
  page.on('request', (r) => {
    if (r.url().includes('/v1/sync/pull')) pulls.push(Date.now());
    const m = /\/v1\/sync\/(push|pull)/.exec(r.url());
    if (m) reqs.push({ t: Date.now(), what: m[1] });
  });
  page.on('requestfailed', (r) => { if (/\/v1\/sync\//.test(r.url())) reqs.push({ t: Date.now(), what: 'failed' }); });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR/.test(m.text())) errors.push(`${label}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${label}: ${String(e)}`));
  return {
    page, label, tid, text, settle, pulls, reqs, errors,
    async shot(name, keepToast = false) {
      await settle();
      if (!keepToast) await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
      await page.screenshot({ path: join(SHOTS, `md-${String(++shotNo).padStart(2, '0')}-${name}.png`) });
    },
    async toast() {
      const el = page.locator('.toast .toast-msg');
      await el.waitFor({ timeout: 8000 });
      return (await el.innerText()).trim();
    },
    async home() {
      for (let i = 0; i < 8 && !(await page.locator('.screen[data-route="home"]').count()); i++) {
        await page.keyboard.press('Escape');
        await settle();
      }
      await page.locator('.screen[data-route="home"]').waitFor();
    },
    async typeAmount(digits) {
      for (const d of digits) await page.locator(`.keypad [data-key="${d}"]`).click();
    },
    rowSide(name) {
      return page.locator('[data-testid="cust-row"]', { hasText: name }).first().locator('.cust-side');
    },
  };
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  for (const f of readdirSync(SHOTS)) if (/^md-/.test(f)) rmSync(join(SHOTS, f), { force: true });
  const key = setupKey();
  const worker = await startWorker();
  const app = await startApp(worker.url);
  // The Worker's CORS list names the app's own origins (https://localhost, capacitor://localhost); the preview runs
  // on 127.0.0.1, so this test browser skips the CORS check. Everything else is the real request path.
  const browser = await chromium.launch({ args: ['--disable-web-security'] });
  const device = { viewport: { width: 393, height: 851 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, locale: 'en-IN', timezoneId: 'Asia/Kolkata' };
  const ctxA = await browser.newContext(device);
  const ctxB = await browser.newContext(device);
  const A = phone(await ctxA.newPage(), 'owner phone');
  const B = phone(await ctxB.newPage(), 'counter phone');

  try {
    console.log('owner phone: first run, "Start a new shop", two customers');
    await A.page.goto(app.url);
    await A.tid('onb-en').click();
    await A.tid('onb-join').waitFor();
    await A.shot('first-run-choice');
    await A.tid('onb-new').click();
    await A.tid('onb-shop').fill('Sri Murugan Stores');
    await A.tid('onb-next').click();
    await A.tid('pin-skip').click();
    await A.tid('onb-start').click();
    await A.page.locator('.screen[data-route="home"]').waitFor();
    for (const [name, credit] of [['Ramu', '300'], ['Kamala', '']]) {
      await A.home();
      await A.tid('add-customer').click();
      await A.tid('cust-name').fill(name);
      if (credit) {
        await A.tid('cust-save-credit').click();
        await A.page.locator('.screen[data-route="entry"]').waitFor();
        await A.typeAmount(credit);
        await A.tid('entry-save').click();
      } else await A.tid('cust-save').click();
      await A.page.locator('.screen[data-route="customer"]').waitFor();
    }

    console.log('owner phone: First-time setup with the setup key and the owner\'s own user id + password');
    await A.home();
    check(await A.tid('home-sync').isVisible(), 'the Sync button is on Home before connecting too');
    await A.tid('home-sync').click();
    await A.page.locator('.dialog').waitFor();
    check((await A.text('.dialog-title')) === 'Not connected to the shop server', 'tapping it before connecting says so (and offers Sign in)');
    await A.page.locator('.dialog .btn-plain').click();
    await A.tid('nav-settings').click();
    await A.page.evaluate(() => document.getElementById('sec-sync')?.scrollIntoView());
    await A.tid('srv-open').click();
    check((await A.tid('srv-mode-login').getAttribute('class')) === 'on', 'the connect form opens on "User id & password"');
    check((await A.tid('srv-url-line').isVisible()) && (await A.tid('srv-url').isHidden()), 'Settings shows the built-in shop server as one line, no address to type');
    check((await A.text('[data-testid="srv-url-line"]')).includes(new URL(worker.url).host) && (await A.tid('srv-url').inputValue()) === worker.url, 'the line names the shop server');
    await A.tid('srv-mode-setup').click();
    await A.tid('srv-key').fill(key);
    await A.tid('srv-own-user').fill(OWNER.username);
    await A.tid('srv-own-pw').fill(OWNER.password);
    await A.tid('srv-own-pw2').fill(OWNER.password);
    await A.tid('srv-device').fill('Owner phone');
    await A.page.evaluate(() => document.querySelector('[data-testid="srv-own"]')?.scrollIntoView({ block: 'center' }));
    await A.shot('owner-first-time-setup');
    await A.tid('srv-connect').click();
    const created = await A.toast();
    check(created === `Login created for ${OWNER.username}`, `owner login made during setup: ${created}`);
    await A.page.waitForFunction(() => /Signed in as/.test(document.querySelector('[data-testid="account-line"]')?.textContent ?? ''), null, { timeout: 15000 });
    log('ok  Settings shows the owner signed in');

    console.log('owner phone: Users -> Add user (staff), step-up with the owner\'s password');
    await A.tid('add-user').click();
    await A.tid('new-user').fill(STAFF.username);
    await A.tid('new-name').fill('Mala');
    await A.tid('new-pw').fill(STAFF.password);
    await A.tid('new-pw2').fill(STAFF.password);
    await A.page.locator('.dialog .btn-primary').click();
    await A.tid('stepup-pw').waitFor({ timeout: 15000 });
    await A.page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await A.tid('stepup-pw').fill(OWNER.password);
    await A.page.locator('.dialog .btn-primary').click();
    await A.page.waitForFunction((u) => [...document.querySelectorAll('.toast .toast-msg')].some((t) => t.textContent === `Login created for ${u}`), STAFF.username, { timeout: 20000 });
    check(true, `staff login "${STAFF.username}" made after the owner's password (step-up)`);

    console.log('counter phone: first run, "Sign in to my shop" with only user id + password');
    await B.page.goto(app.url);
    await B.tid('onb-en').click();
    await B.tid('onb-join').click();
    await B.tid('onb-user').waitFor();
    check((await B.tid('onb-srv-line').isVisible()) && (await B.tid('onb-srv').isHidden()), 'the server address is built in: shown as one line, no field to type');
    check((await B.text('[data-testid="onb-srv-line"]')).includes(new URL(worker.url).host), 'the line names the shop server');
    await B.tid('onb-user').fill(STAFF.username);
    await B.tid('onb-pw').fill('wrong-password');
    await B.tid('onb-device').fill('Counter 2');
    await B.tid('onb-submit').click();
    await B.page.waitForFunction(() => !document.querySelector('[data-testid="onb-error"]')?.classList.contains('hidden'), null, { timeout: 20000 });
    check((await B.text('[data-testid="onb-error"]')).length > 0, `wrong password refused: ${await B.text('[data-testid="onb-error"]')}`);
    await B.tid('onb-pw').fill(STAFF.password);
    await B.shot('staff-sign-in');
    await B.tid('onb-submit').click();
    await B.tid('pin-skip').waitFor({ timeout: 20000 });
    await B.tid('pin-skip').click();
    await B.tid('onb-start').click();
    await B.page.locator('.screen[data-route="home"]').waitFor();
    await B.page.waitForFunction(() => document.querySelectorAll('[data-testid="cust-row"]').length >= 2, null, { timeout: 15000 });
    check((await B.rowSide('Ramu').innerText()).includes('₹300'), 'counter phone got the shop\'s ledger: Ramu ₹300');
    check((await B.text('.topbar h1')).includes('Sri Murugan Stores'), 'counter phone shows the shop\'s name');
    const box = await B.tid('home-sync').boundingBox();
    check(!!box && box.x > 393 / 2 && box.y < 120, `signed in: the Sync button is in the top-right corner of Home (x ${Math.round(box?.x ?? -1)}, y ${Math.round(box?.y ?? -1)})`);
    await B.shot('staff-home-after-sign-in');

    console.log('fast sync: owner phone saves, the counter phone shows it by itself');
    await A.home();
    await A.page.locator('[data-testid="cust-row"]', { hasText: 'Ramu' }).click();
    await A.tid('btn-gave').click();
    await A.page.locator('.screen[data-route="entry"]').waitFor();
    await A.typeAmount('500');
    const t0 = Date.now();
    await A.tid('entry-save').click();
    await B.page.waitForFunction(() => {
      const row = [...document.querySelectorAll('[data-testid="cust-row"]')].find((r) => /Ramu/.test(r.textContent ?? ''));
      return !!row && /₹800/.test(row.querySelector('.cust-side')?.textContent ?? '');
    }, null, { timeout: 30000 });
    const took = Date.now() - t0;
    check(took < 25000, `counter phone's Home redrew with Ramu ₹800 ${(took / 1000).toFixed(1)} s after the save, without a touch (2 s push + 20 s poll)`);
    await B.shot('staff-home-updated');

    console.log('a customer\'s page is fresh the moment it opens');
    const lastPull = () => B.pulls[B.pulls.length - 1] ?? 0;
    const before = B.pulls.length;
    for (let i = 0; i < 60 && B.pulls.length === before; i++) await B.page.waitForTimeout(500); // wait for a poll
    await B.page.waitForTimeout(6000); // the last cycle is now older than FRESH_MS, the next poll ~14 s away
    await A.page.locator('.topbar .icon-btn').first().click(); // back to Ramu's page
    await A.home();
    await A.page.locator('[data-testid="cust-row"]', { hasText: 'Kamala' }).click();
    await A.tid('btn-gave').click();
    await A.page.locator('.screen[data-route="entry"]').waitFor();
    await A.typeAmount('250');
    await A.tid('entry-save').click();
    await A.page.waitForTimeout(3000); // the owner phone pushes 2 s after the save
    const opened = Date.now();
    await B.page.locator('[data-testid="cust-row"]', { hasText: 'Kamala' }).click();
    await B.page.locator('.screen[data-route="customer"]').waitFor();
    await B.page.waitForFunction(() => document.querySelector('[data-testid="balance"]')?.textContent?.trim() === '₹250', null, { timeout: 20000 });
    const fresh = Date.now() - opened;
    check(fresh < 5000 && lastPull() >= opened, `Kamala's page showed ₹250 ${(fresh / 1000).toFixed(1)} s after it was opened (a pull on open, not the next poll)`);
    await B.shot('staff-customer-fresh');

    console.log('the other direction: the counter phone saves, the owner phone (on Kamala\'s page) redraws');
    await A.page.locator('.screen[data-route="customer"]').waitFor();
    await B.tid('btn-got').click();
    await B.page.locator('.screen[data-route="entry"]').waitFor();
    await B.typeAmount('100');
    const t1 = Date.now();
    await B.tid('entry-save').click();
    await A.page.waitForFunction(() => document.querySelector('[data-testid="balance"]')?.textContent?.trim() === '₹150', null, { timeout: 30000 });
    const took2 = Date.now() - t1;
    check(took2 < 25000, `owner phone's open customer page redrew to ₹150 ${(took2 / 1000).toFixed(1)} s later`);
    check((await A.page.locator('.badge-dev', { hasText: 'Counter 2' }).count()) >= 1, 'the entry shows it came from "Counter 2"');
    await A.shot('owner-customer-updated');

    console.log('Sync button: the counter phone taps Sync and has the owner\'s new entry at once');
    await B.home();
    const polls = B.pulls.length;
    for (let i = 0; i < 60 && B.pulls.length === polls; i++) await B.page.waitForTimeout(500); // just polled: the next is ~20 s away
    await A.tid('btn-gave').click(); // the owner phone is on Kamala's page
    await A.page.locator('.screen[data-route="entry"]').waitFor();
    await A.typeAmount('40');
    await A.tid('entry-save').click();
    await A.page.waitForTimeout(3000); // pushed 2 s after the save
    const kamalaOnB = () => B.page.evaluate(() => [...document.querySelectorAll('[data-testid="cust-row"]')].find((r) => /Kamala/.test(r.textContent ?? ''))?.querySelector('.cust-side')?.textContent ?? '');
    check((await kamalaOnB()).includes('₹150'), 'before the tap the counter phone still shows Kamala ₹150');
    const tapped = Date.now();
    await B.tid('home-sync').click();
    await B.page.waitForFunction(() => /₹190/.test([...document.querySelectorAll('[data-testid="cust-row"]')].find((r) => /Kamala/.test(r.textContent ?? ''))?.querySelector('.cust-side')?.textContent ?? ''), null, { timeout: 15000 });
    const tookTap = Date.now() - tapped;
    check(tookTap < 3000, `Kamala ₹190 on the counter phone ${(tookTap / 1000).toFixed(1)} s after tapping Sync (no waiting for the 20-s poll)`);
    const synced = await B.toast();
    check(/^Synced\. (1 update|\d+ updates) from the other phones\.$/.test(synced), `the toast says what came: ${synced}`);
    await B.shot('staff-sync-tapped', true);

    console.log('offline counter phone: entry waits, goes out when the network is back');
    await B.page.locator('[data-testid="cust-row"]', { hasText: 'Kamala' }).click();
    await B.page.locator('.screen[data-route="customer"]').waitFor();
    await ctxB.setOffline(true);
    await B.tid('btn-got').click();
    await B.page.locator('.screen[data-route="entry"]').waitFor();
    await B.typeAmount('50');
    await B.tid('entry-save').click();
    await B.home();
    await B.page.waitForFunction(() => /1/.test(document.querySelector('[data-testid="sync-pill"]')?.textContent ?? ''), null, { timeout: 10000 });
    log(`ok  counter phone offline, its pill says: ${await B.text('[data-testid="sync-pill"]')}`);
    await B.page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await B.tid('home-sync').click();
    const offMsg = await B.toast();
    check(/^No internet\./.test(offMsg), `Sync with no internet says so: ${offMsg}`);
    await B.shot('staff-offline-waiting');
    await B.page.waitForTimeout(3000);
    check((await A.text('[data-testid="balance"]')) === '₹190', 'nothing reached the owner phone while the counter phone was offline');
    await ctxB.setOffline(false);
    const t2 = Date.now();
    await A.page.waitForFunction(() => document.querySelector('[data-testid="balance"]')?.textContent?.trim() === '₹140', null, { timeout: 30000 });
    check(Date.now() - t2 < 25000, `back online: the owner phone shows Kamala ₹140 ${((Date.now() - t2) / 1000).toFixed(1)} s later`);
    const since = (p) => p.reqs.filter((r) => r.t >= t2 - 8000).map((r) => `${r.what}@${((r.t - t2) / 1000).toFixed(1)}`).join(' ');
    log(`   requests around going online (s from it): counter [${since(B)}] owner [${since(A)}]`);

    console.log('no redraw under the fingers: typing in the search box on the counter phone');
    await B.home();
    await B.tid('search').fill('Ra');
    await B.tid('search').focus();
    await A.home();
    await A.page.locator('[data-testid="cust-row"]', { hasText: 'Ramu' }).click();
    await A.tid('btn-gave').click();
    await A.page.locator('.screen[data-route="entry"]').waitFor();
    await A.typeAmount('20');
    await A.tid('entry-save').click();
    for (let i = 0; i < 60 && !(B.pulls.length && B.pulls[B.pulls.length - 1] > Date.now() - 1000); i++) await B.page.waitForTimeout(500);
    await B.page.waitForTimeout(25000);
    const stillTyping = await B.page.evaluate(() => {
      const el = document.activeElement;
      return el?.getAttribute('data-testid') === 'search' && el.value === 'Ra';
    });
    check(stillTyping, 'the search box kept its focus and its text while new entries arrived');
    await B.page.locator('.topbar h1').click(); // finger off the search box
    await B.page.evaluate(() => document.activeElement?.blur());
    await B.page.waitForFunction(() => {
      const row = [...document.querySelectorAll('[data-testid="cust-row"]')].find((r) => /Ramu/.test(r.textContent ?? ''));
      return !!row && /₹820/.test(row.querySelector('.cust-side')?.textContent ?? '');
    }, null, { timeout: 10000 });
    check((await B.tid('search').inputValue()) === 'Ra', 'after the redraw the search text is still there: Ramu ₹820');

    const errs = [...A.errors, ...B.errors];
    check(errs.length === 0, `no console errors ${errs.join(' | ')}`);
  } catch (e) {
    console.error(e);
    failures = Math.max(failures, 1);
    try {
      await A.page.screenshot({ path: join(SHOTS, `md-${String(++shotNo).padStart(2, '0')}-FAILED-owner.png`) });
      await B.page.screenshot({ path: join(SHOTS, `md-${String(++shotNo).padStart(2, '0')}-FAILED-counter.png`) });
    } catch {
      /* ignore */
    }
    console.error(worker.log().split('\n').slice(-30).join('\n'));
  } finally {
    await browser.close();
    app.stop();
    worker.stop();
  }
  console.log(failures ? `FAILED (${failures})` : 'ALL MULTI-DEVICE FLOWS PASSED');
  process.exit(failures ? 1 : 0);
}

main();
