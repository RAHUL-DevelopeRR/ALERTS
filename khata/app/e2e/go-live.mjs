#!/usr/bin/env node
/**
 * Go-live, end to end against a real local Worker (wrangler dev --local, fresh D1): the owner's login is made by
 * tools/create-owner.mjs exactly as tools/go-live.sh runs it (setup key -> temporary device -> owner -> signed out),
 * then tools/reset-unused-codes.sql, then a phone build with the server built in signs in with only that user id and
 * password, sees no address field, syncs, gets C-0001 for its first customer, and the owner adds a staff login.
 * A second create-owner run creates nothing. The password is passed with a trailing space (trimmed, as from a
 * settings box). Screenshots: e2e/screenshots/gl-NN-name.png. Stops wrangler dev.
 *
 *   node e2e/go-live.mjs
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
const STATE = join(API, '.wrangler', 'e2e-golive-state'); // isolated local D1 (gitignored with .wrangler/)
const TOOLS = join(ROOT, '..', 'tools');
const OWNER = { username: 'rahul', password: 'rahul-pass-1' };
const STAFF = { username: 'seenu', password: 'seenu-pass-1' };

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

function tool(args, env) {
  return execFileSync(process.execPath, [join(TOOLS, args[0]), ...args.slice(1)], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  for (const f of readdirSync(SHOTS)) if (/^gl-/.test(f)) rmSync(join(SHOTS, f), { force: true });
  const key = setupKey();
  const worker = await startWorker();
  let app = null;
  let browser = null;
  try {
    console.log('create-owner.mjs: the owner login, made once on the server');
    const env = { SETUP_KEY: key, KK_OWNER_USER: 'Rahul', KK_OWNER_PASSWORD: `${OWNER.password} `, KK_SHOP_NAME: 'Rahul Stores' };
    const first = tool(['create-owner.mjs', worker.url], env).trim();
    check(first === 'Owner login created: user id "rahul" (shop "Rahul Stores").', first);
    const sql = readFileSync(join(TOOLS, 'reset-unused-codes.sql'), 'utf8').split('\n').filter((l) => !l.startsWith('--')).join('\n');
    execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'khata', '--local', '--persist-to', STATE, '--command', sql], {
      cwd: API, stdio: 'pipe', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    });
    log('ok  reset-unused-codes.sql ran');
    // The same count go-live.sh reads before deciding to create the owner (wrangler d1 execute --json).
    const countOut = execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'khata', '--local', '--persist-to', STATE, '--json', '--command', 'SELECT COUNT(*) AS n FROM users'], {
      cwd: API, encoding: 'utf8', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    });
    const users = JSON.parse(countOut.slice(countOut.indexOf('[')))[0]?.results?.[0]?.n;
    check(users === 1, `the users count go-live.sh checks reads 1 after the owner is made (${users})`);

    console.log('the owner\'s phone: only user id + password');
    app = await startApp(worker.url);
    // The Worker's CORS list names the app's own origins; the preview runs on 127.0.0.1 (see multi-device.mjs).
    browser = await chromium.launch({ args: ['--disable-web-security'] });
    const ctx = await browser.newContext({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    const tid = (id) => page.locator(`[data-testid="${id}"]`);
    const text = async (sel) => (await page.locator(sel).first().innerText()).trim();
    const shot = async (name) => {
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(SHOTS, `gl-${String(++shotNo).padStart(2, '0')}-${name}.png`) });
    };
    const toast = async (re) => {
      await page.waitForFunction((src) => [...document.querySelectorAll('.toast .toast-msg')].some((t) => new RegExp(src).test(t.textContent ?? '')), re.source, { timeout: 20000 });
      return (await page.locator('.toast .toast-msg').last().innerText()).trim();
    };
    await page.goto(app.url);
    await tid('onb-en').click();
    await tid('onb-join').click();
    await tid('onb-user').waitFor();
    check((await tid('onb-srv-line').isVisible()) && (await tid('onb-srv').isHidden()), 'no server address to type: one "Shop server" line');
    await tid('onb-user').fill(OWNER.username);
    await tid('onb-pw').fill(OWNER.password);
    await tid('onb-device').fill('Owner phone');
    await shot('owner-sign-in');
    await tid('onb-submit').click();
    await tid('pin-skip').waitFor({ timeout: 30000 });
    await tid('pin-skip').click();
    await tid('onb-start').click();
    await page.locator('.screen[data-route="home"]').waitFor();
    check((await text('.topbar h1')) === 'Rahul Stores', 'signed in: Home shows the shop name from the server');
    await tid('home-sync').click();
    check((await toast(/^Synced\./)) === 'Synced. Everything is up to date.', 'Sync: everything is up to date');
    await tid('add-customer').click();
    await tid('cust-name').fill('Seetha');
    await tid('cust-save').click();
    await page.locator('.screen[data-route="customer"]').waitFor();
    check((await page.locator('.screen[data-route="customer"]').innerText()).includes('C-0001'), 'the shop\'s first customer is C-0001 (numbers handed back after setup)');

    console.log('the owner gives an employee a user id and password');
    for (let i = 0; i < 6 && !(await page.locator('.screen[data-route="home"]').count()); i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
    }
    await page.locator('.screen[data-route="home"]').waitFor();
    await tid('nav-settings').click();
    await page.locator('.screen[data-route="settings"]').waitFor();
    await page.evaluate(() => document.querySelector('[data-testid="add-user"]')?.scrollIntoView({ block: 'center' }));
    await shot('owner-settings-users');
    await tid('add-user').click();
    await tid('new-user').fill(STAFF.username);
    await tid('new-name').fill('Seenu');
    await tid('new-pw').fill(STAFF.password);
    await tid('new-pw2').fill(STAFF.password);
    await shot('owner-add-user');
    await page.locator('.dialog .btn-primary').click();
    await tid('stepup-pw').waitFor({ timeout: 20000 });
    await tid('stepup-pw').fill(OWNER.password);
    await page.locator('.dialog .btn-primary').click();
    check((await toast(/Login created for/)) === `Login created for ${STAFF.username}`, `staff login "${STAFF.username}" created after the owner's password`);

    console.log('create-owner.mjs again (go-live.sh skips it when the users table has rows; on its own it creates nothing)');
    const again = tool(['create-owner.mjs', worker.url], { ...env, KK_OWNER_USER: 'someone' }).trim();
    check(/already has logins: rahul \(owner\), seenu \(staff\)\. Nothing created\.$/.test(again), `a second run creates nothing: ${again}`);
    check(errors.length === 0, `no console errors ${errors.join(' | ')}`);
  } catch (e) {
    console.error(e);
    failures = Math.max(failures, 1);
  } finally {
    await browser?.close();
    app?.stop();
    worker.stop();
  }
  console.log(failures ? `FAILED (${failures})` : 'ALL GO-LIVE FLOWS PASSED');
  process.exit(failures ? 1 : 0);
}

await main();
