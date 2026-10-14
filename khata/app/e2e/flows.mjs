#!/usr/bin/env node
/**
 * End-to-end walk through the main shop flows in Chromium at Redmi size (393x851 @2.75, touch).
 *   node e2e/flows.mjs                 # vite build + vite preview on a free port
 *   E2E_URL=http://127.0.0.1:5173/ node e2e/flows.mjs   # use a running server (npx vite)
 * Screenshots: e2e/screenshots/NN-name.png. Exits non-zero on the first failed assertion.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'e2e', 'screenshots');
const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

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

async function startServer() {
  if (process.env.E2E_URL) return { url: process.env.E2E_URL, stop: () => {} };
  execFileSync(process.execPath, [VITE, 'build'], { cwd: ROOT, stdio: 'inherit' });
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

async function main() {
  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 393, height: 851 },
    deviceScaleFactor: 2.75,
    isMobile: true,
    hasTouch: true,
    locale: 'ta-IN',
    timezoneId: 'Asia/Kolkata',
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  const tid = (id) => page.locator(`[data-testid="${id}"]`);
  const text = async (sel) => (await page.locator(sel).first().innerText()).trim();
  const settle = () => page.waitForTimeout(250);

  async function shot(name) {
    await settle();
    const file = join(SHOTS, `${String(++shotNo).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: file });
    const overflow = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const bad = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width && (r.right > w + 1 || r.left < -1) && getComputedStyle(el).position !== 'fixed') {
          // ignore children of horizontally scrolling chip rows
          if (el.closest('.chips.scroll')) continue;
          bad.push(`${el.tagName.toLowerCase()}.${el.className}`);
        }
      }
      return bad.slice(0, 5);
    });
    check(overflow.length === 0, `${name}: nothing wider than the screen ${overflow.join(', ')}`);
  }

  async function typeAmount(digits) {
    for (const d of digits) await page.locator(`.keypad [data-key="${d}"]`).click();
  }
  async function pin(digits) {
    for (const d of digits) await page.locator(`.gate .keypad [data-key="${d}"]`).click();
    await page.locator('.gate .keypad [data-key="ok"]').click();
  }
  async function toast() {
    const el = page.locator('.toast .toast-msg');
    await el.waitFor({ timeout: 5000 });
    return (await el.innerText()).trim();
  }
  async function home() {
    for (let i = 0; i < 6 && !(await page.locator('.screen[data-route="home"]').count()); i++) {
      await page.keyboard.press('Escape');
      await settle();
    }
    await page.locator('.screen[data-route="home"]').waitFor();
  }
  async function openCustomer(query, nth = 0) {
    await home();
    await tid('search').fill(query);
    await page.locator('[data-testid="cust-row"]').nth(nth).click();
    await page.locator('.screen[data-route="customer"]').waitFor();
  }

  try {
    console.log('onboarding (Tamil)');
    await page.goto(server.url);
    await tid('onb-ta').waitFor();
    await shot('onboarding-language');
    await tid('onb-ta').click();
    await tid('onb-shop').fill('ஸ்ரீ முருகன் ஸ்டோர்ஸ்');
    await tid('onb-upi').fill('murugan@okaxis');
    await shot('onboarding-shop-ta');
    await tid('onb-next').click();
    await tid('pin-skip').waitFor();
    await shot('onboarding-pin-ta');
    await tid('pin-skip').click();
    await tid('onb-start').click();
    await page.locator('.screen[data-route="home"]').waitFor();
    check((await text('.topbar h1')).includes('ஸ்ரீ முருகன் ஸ்டோர்ஸ்'), 'home shows the shop name');
    check((await text('[data-testid="sync-pill"]')) === 'இந்த போனில் மட்டும்', 'sync pill says "on this phone only"');
    await shot('home-empty-ta');

    console.log('Kamala: add, Gave ₹250, Got ₹100');
    await tid('add-customer').click();
    await tid('cust-name').fill('Kamala');
    await tid('cust-phone').fill('98765 43210');
    await tid('cust-note').fill('3வது தெரு');
    await shot('customer-new-ta');
    await tid('cust-save-credit').click();
    await page.locator('.screen[data-route="entry"]').waitFor();
    await typeAmount('250');
    check((await text('[data-testid="amount"]')) === '₹250', 'keypad shows ₹250');
    check((await text('[data-testid="amount-words"]')).includes('250 ரூபாய்'), 'amount in Tamil words');
    await shot('entry-gave-ta');
    await tid('entry-save').click();
    await page.locator('.screen[data-route="customer"]').waitFor();
    check((await toast()).includes('₹250'), 'toast repeats the amount');
    check((await text('[data-testid="balance"]')) === '₹250', 'balance ₹250 after Gave');
    await tid('btn-got').click();
    await typeAmount('100');
    await shot('entry-got-ta');
    await tid('entry-save').click();
    await page.locator('.screen[data-route="customer"]').waitFor();
    check((await toast()).includes('₹150'), 'toast shows new balance ₹150');
    check((await text('[data-testid="balance"]')) === '₹150', 'balance ₹150 after Got ₹100');
    await shot('customer-kamala-ta');

    console.log('Murugan twice (same-name prompt)');
    await home();
    await tid('search').fill('முருகன்');
    await tid('add-as-new').waitFor();
    await shot('home-add-as-new-ta');
    await tid('add-as-new').click();
    check((await tid('cust-name').inputValue()) === 'முருகன்', 'name prefilled from search');
    await tid('cust-note').fill('கோயில் தெரு, நீல வீடு');
    await tid('cust-save').click();
    await page.locator('.screen[data-route="customer"]').waitFor();
    await home();
    await tid('search').fill('');
    await tid('add-customer').click();
    await tid('cust-name').fill('முருகன்');
    await tid('cust-note').fill('பள்ளி அருகில்');
    await tid('cust-save').click();
    await page.locator('.dialog').waitFor();
    check((await text('.dialog')).includes('C-0002'), 'same-name prompt names the existing code');
    await shot('same-name-prompt-ta');
    await page.locator('.dialog .btn-primary').click();
    await page.locator('.screen[data-route="customer"]').waitFor();
    check((await text('.topbar .sub')) === 'C-0003', 'second Murugan gets C-0003');

    console.log('Murugan #1: Gave ₹1,500 then correct to ₹150');
    await home();
    await tid('search').fill('murugan');
    check((await page.locator('[data-testid="cust-row"]').count()) === 2, 'typing "murugan" finds both முருகன் (transliteration)');
    await shot('home-search-latin-ta');
    await page.locator('[data-testid="cust-row"]', { hasText: 'கோயில்' }).click();
    await tid('btn-gave').click();
    await typeAmount('1500');
    await tid('entry-save').click();
    await page.locator('.screen[data-route="customer"]').waitFor();
    check((await text('[data-testid="balance"]')) === '₹1,500', 'balance ₹1,500');
    await page.locator('[data-testid="entry-row"]').first().click();
    await page.locator('.sheet').waitFor();
    await shot('entry-sheet-ta');
    await page.locator('.sheet-item').first().click();
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await text('[data-testid="amount"]')) === '₹1,500', 'correction keypad prefilled with ₹1,500');
    await page.locator('.keypad [data-key="back"]').click();
    check((await text('[data-testid="amount"]')) === '₹150', 'one backspace -> ₹150');
    await shot('entry-correct-ta');
    await tid('entry-save').click();
    await page.locator('.screen[data-route="customer"]').waitFor();
    check((await text('[data-testid="balance"]')) === '₹150', 'balance ₹150 after the correction');
    check((await page.locator('[data-testid="entry-row"]').count()) === 2, 'corrected pair collapses to one line (+ the new entry)');
    check((await page.locator('[data-testid="entry-row"].struck').count()) === 1, 'one struck-through corrected line');
    await shot('customer-corrected-ta');
    await tid('toggle-corrections').click();
    check((await page.locator('[data-testid="entry-row"]').count()) === 3, '"show corrections" expands the reversal');
    await tid('toggle-corrections').click();

    console.log('Day book');
    await home();
    await tid('search').fill('');
    await shot('home-list-ta');
    await tid('nav-daybook').click();
    await page.locator('.screen[data-route="daybook"]').waitFor();
    const given = await text('[data-testid="tot-given"] .tot-val');
    check(given === '₹400', `day book Given = ₹400 (250 + 150; reversed 1,500 excluded), got ${given}`);
    check((await text('[data-testid="tot-received"] .tot-val')) === '₹100', 'day book Received ₹100');
    check((await text('[data-testid="tot-split"]')).includes('ரொக்கம் ₹100'), 'cash split ₹100');
    check((await text('[data-testid="tot-writeoff"]')).includes('1'), 'corrections count shown');
    await shot('daybook-ta');
    await tid('tab-entered').click();
    check((await text('[data-testid="tot-given"] .tot-val')) === '₹400', '"entered on this day" totals match');
    await tid('tab-business').click();

    console.log('Statement (Tamil + English)');
    await openCustomer('Kamala');
    await tid('act-statement').click();
    await page.locator('.screen[data-route="statement"]').waitFor();
    const taText = await text('[data-testid="st-preview"]');
    check(taText.includes('நிலவரப்படி நிலுவை ₹150'), 'Tamil statement closing line');
    check(taText.includes('கொடுத்தது ₹250') && taText.includes('பெற்றது ₹100'), 'Tamil statement lines');
    check(taText.includes('upi://pay?pa=murugan%40okaxis'), 'UPI link in statement');
    await shot('statement-ta');
    await tid('st-lang-en').click();
    const enText = await text('[data-testid="st-preview"]');
    check(enText.includes('Balance due ₹150 as of'), 'English statement closing line');
    check(enText.includes('Gave ₹250') && enText.includes('Got ₹100 · Cash'), 'English statement lines');
    await shot('statement-text-en');

    console.log('Settings: language -> English, backup');
    await home();
    await tid('nav-settings').click();
    await page.locator('.screen[data-route="settings"]').waitFor();
    await shot('settings-ta');
    await tid('set-lang-en').click();
    await page.waitForFunction(() => document.querySelector('.topbar h1')?.textContent === 'Settings');
    check(true, 'language switched to English immediately');
    await shot('settings-en');
    const dl = page.waitForEvent('download');
    await tid('save-backup').click();
    const download = await dl;
    check(/^kadan-kanakku-backup-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()), `backup download ${download.suggestedFilename()}`);
    const backupPath = join(SHOTS, '..', 'last-backup.json');
    await download.saveAs(backupPath);
    const backup = JSON.parse((await import('node:fs')).readFileSync(backupPath, 'utf8'));
    check(backup.customers.length === 3 && backup.entries.length === 5, 'backup has 3 customers and 5 entries');
    rmSync(backupPath, { force: true });
    await settle();
    check((await text('[data-testid="last-backup"]')).startsWith('Last backup copy:') && !(await text('[data-testid="last-backup"]')).includes('Never'), 'last backup time recorded');

    console.log('English screens');
    await home();
    check((await text('[data-testid="summary"]')).includes('To collect'), 'home in English');
    await shot('home-en');
    await openCustomer('Kamala');
    check((await text('[data-testid="hero"]')).includes('Owes'), 'customer screen in English');
    await shot('customer-en');
    await tid('btn-gave').click();
    await typeAmount('12345.5');
    check((await text('[data-testid="amount"]')) === '₹12,345.5', 'Indian grouping while typing');
    check((await text('[data-testid="amount-words"]')).startsWith('Twelve thousand three hundred forty-five rupees and fifty paise'), 'English amount in words');
    await shot('entry-gave-en');
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="customer"]').waitFor();
    await tid('btn-got').click();
    await tid('full-chip').click();
    check((await text('[data-testid="amount"]')) === '₹150', '"Full ₹150" chip fills the balance');
    await shot('entry-got-en');
    await page.keyboard.press('Escape');
    await home();
    await tid('nav-daybook').click();
    await shot('daybook-en');
    await tid('quick-entry').click();
    await page.locator('.screen[data-route="quick"]').waitFor();
    await shot('quick-entry-en');
    await tid('quick-finish').click();
    await openCustomer('Kamala');
    await tid('act-statement').click();
    await shot('statement-en');

    console.log('Lock: set PIN, reload, unlock');
    await home();
    await tid('nav-settings').click();
    await tid('set-pin').click();
    await pin('1234');
    await pin('1234');
    check((await toast()) === 'PIN saved', 'PIN saved');
    await page.waitForTimeout(1000); // the browser preview persists sql.js to IndexedDB 300 ms after a write
    await page.reload();
    await page.locator('.gate.pin-gate').waitFor();
    check((await text('.gate h2')) === 'Enter PIN', 'lock screen on cold start');
    await pin('9999');
    check((await text('[data-testid="pin-msg"]')).includes('Wrong PIN. 4 tries left'), 'wrong PIN message');
    await shot('lock-en');
    await pin('1234');
    await page.locator('.screen[data-route="home"]').waitFor();
    check((await page.locator('.gate').count()) === 0, 'unlocked to home');
    check((await text('.summary-amt')) === '₹300', 'home total ₹300 (Kamala 150 + Murugan 150)');

    check(consoleErrors.length === 0, `no console errors ${consoleErrors.join(' | ')}`);
  } catch (e) {
    console.error(e);
    failures = Math.max(failures, 1);
    try {
      await page.screenshot({ path: join(SHOTS, `${String(++shotNo).padStart(2, '0')}-FAILED.png`) });
    } catch {
      /* ignore */
    }
  } finally {
    await browser.close();
    server.stop();
  }
  console.log(failures ? `FAILED (${failures})` : 'ALL FLOWS PASSED');
  process.exit(failures ? 1 : 0);
}

main();
