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

  async function shot(name, { keepToast = false } = {}) {
    await settle();
    if (!keepToast) await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
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
    await shot('customer-kamala-toast-ta', { keepToast: true });
    check((await page.locator('.toast .toast-action').count()) === 1, 'Undo toast on the customer the entry was for');
    await tid('act-statement').click();
    await page.locator('.screen[data-route="statement"]').waitFor();
    check((await page.locator('.toast').count()) === 0, 'Undo toast is removed when leaving that screen');
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="customer"]').waitFor();

    console.log('Got more than the due asks first; Back with an amount typed asks first');
    await tid('btn-got').click();
    await typeAmount('500');
    await tid('entry-save').click();
    await page.locator('.dialog').waitFor();
    const advText = await text('.dialog');
    check(advText.includes('₹150') && advText.includes('₹350'), `advance confirm names due ₹150 and advance ₹350: ${advText}`);
    await shot('entry-got-more-than-due-ta');
    await page.locator('.dialog .btn').first().click();
    await settle();
    check((await page.locator('.screen[data-route="entry"]').count()) === 1, '"No" keeps the keypad open, nothing saved');
    await page.keyboard.press('Escape');
    await page.locator('.dialog').waitFor();
    check((await text('.dialog')).includes('₹500'), 'Back with ₹500 typed asks before discarding');
    await shot('entry-discard-prompt-ta');
    await page.locator('.dialog .btn-primary').click();
    await settle();
    check((await page.locator('.screen[data-route="entry"]').count()) === 1, '"Keep editing" stays on the keypad');
    await page.keyboard.press('Escape');
    await page.locator('.dialog .btn-danger').click();
    await page.locator('.screen[data-route="customer"]').waitFor();
    check((await text('[data-testid="balance"]')) === '₹150', 'discarded: balance still ₹150');

    console.log('Customer form: invalid number + immediate Save keeps the warning');
    await home();
    await tid('add-customer').click();
    await tid('cust-name').fill('Test Phone');
    await tid('cust-phone').fill('12345');
    await tid('cust-save').click();
    await page.waitForTimeout(500);
    check((await tid('phone-err').isVisible()) && (await text('[data-testid="phone-err"]')).length > 0, 'bad-number message survives the debounced duplicate check');
    await shot('customer-bad-phone-ta');
    await page.keyboard.press('Escape');

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
    check((await page.locator('[data-testid="cust-list"] > *').first().getAttribute('data-testid')) === 'cust-row', 'first row is a matching customer, not "add as new"');
    check((await page.locator('[data-testid="cust-list"] > *').last().getAttribute('data-testid')) === 'add-as-new', '"add as new" comes after the matches');
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
    check((await tid('search').inputValue()) === '', 'home search is cleared after an entry was saved');
    await tid('search').fill('abc');
    await tid('search-clear').click();
    check((await tid('search').inputValue()) === '' && (await page.locator('[data-testid="cust-row"]').count()) === 3, 'the visible × clears the search in one tap');
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
    check(taText.includes('வரை நீங்கள் தர வேண்டியது ₹150'), 'Tamil statement closing line says the customer owes');
    check(taText.includes('பற்று ₹250') && taText.includes('வரவு ₹100'), 'Tamil statement lines in customer-side words');
    check(!taText.includes('upi://') && taText.includes('UPI மூலம் செலுத்த: murugan@okaxis'), 'UPI id, no raw upi:// link');
    const wa = await tid('st-whatsapp').boundingBox();
    check(wa && wa.y + wa.height <= 851, `WhatsApp button is on screen without scrolling (y=${wa && Math.round(wa.y)})`);
    check((await text('[data-testid="st-summary"]')).includes('₹150'), 'summary line with the closing balance');
    await shot('statement-ta');
    await tid('st-lang-en').click();
    const enText = await text('[data-testid="st-preview"]');
    check(enText.includes('You owe ₹150 as of'), 'English statement closing line');
    check(enText.includes('Debit ₹250') && enText.includes('Credited ₹100 · Cash'), 'English statement lines');
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
    await settle();
    await tid('restore-file').setInputFiles(backupPath);
    await page.locator('.dialog').waitFor();
    const restoreText = await text('.dialog');
    check(restoreText.includes('3 customers, 5 entries') && restoreText.includes('Now on this phone: 3 customers, 5 entries'), 'restore confirm shows both the file and what is on the phone');
    await shot('settings-restore-confirm-en');
    await page.locator('.dialog .btn-danger').click();
    check((await toast()).startsWith('Restored 3 customers, 5 entries'), 'restore done');
    rmSync(backupPath, { force: true });
    await tid('restore-daily').click();
    await page.locator('.sheet').waitFor();
    check((await text('.sheet')).includes('Before a restore'), 'a safety copy was kept before the restore and can be restored');
    await shot('settings-daily-copies-en');
    await page.locator('.sheet-cancel').click();
    await settle();
    check((await text('[data-testid="last-backup"]')).startsWith('Last backup copy:') && !(await text('[data-testid="last-backup"]')).includes('Never'), 'last backup time recorded');

    await page.evaluate(() => document.getElementById('sec-sync')?.scrollIntoView());
    await tid('srv-open').click();
    await shot('settings-backup-server-en');
    await tid('run-selftest').click();
    await page.waitForFunction(() => /total/.test(document.querySelector('[data-testid="selftest"]')?.textContent ?? ''));
    const st = await text('[data-testid="selftest"]');
    check(!st.includes('FAIL'), 'self-test passes in the browser preview');
    await page.evaluate(() => document.querySelector('[data-testid="selftest"]')?.scrollIntoView({ block: 'end' }));
    await shot('settings-about-en');

    console.log('English screens');
    await home();
    check((await text('[data-testid="summary"]')).includes('To collect'), 'home in English');
    const dueChip = await tid('due-list').boundingBox();
    check(dueChip && dueChip.x >= 0 && dueChip.x + dueChip.width <= 393, 'due-list chip is fully on screen (chips wrap, no hidden 4th chip)');
    await shot('home-en');
    await tid('search-clear').click();
    await tid('due-list').click();
    await page.locator('.dialog').waitFor();
    await tid('due-days-0').click();
    await tid('due-min-10000').click();
    await shot('home-due-sheet-en');
    await page.locator('.dialog .btn-primary').click();
    await settle();
    check((await page.locator('[data-testid="cust-row"]').count()) === 2 && (await text('[data-testid="due-total"]')).includes('₹300'), 'due list (any days, ₹100+): 2 customers, ₹300 total');
    await shot('home-due-list-en');
    await tid('due-list').click();
    await page.locator('.dialog .btn').first().click();
    await settle();
    await openCustomer('Kamala');
    check((await text('[data-testid="hero"]')).includes('Owes'), 'customer screen in English');
    await shot('customer-en');
    await tid('btn-gave').click();
    await typeAmount('12345.5');
    check((await text('[data-testid="amount"]')) === '₹12,345.5', 'Indian grouping while typing');
    check((await text('[data-testid="amount-words"]')).startsWith('Twelve thousand three hundred forty-five rupees and fifty paise'), 'English amount in words');
    await shot('entry-gave-en');
    await page.keyboard.press('Escape');
    await page.locator('.dialog .btn-danger').click();
    await page.locator('.screen[data-route="customer"]').waitFor();
    await tid('btn-got').click();
    await tid('full-chip').click();
    check((await text('[data-testid="amount"]')) === '₹150', '"Full ₹150" chip fills the balance');
    await shot('entry-got-en');
    await page.keyboard.press('Escape');
    await page.locator('.dialog .btn-danger').click();
    await home();
    await tid('nav-daybook').click();
    await shot('daybook-en');
    await tid('quick-entry').click();
    await page.locator('.screen[data-route="quick"]').waitFor();
    await shot('quick-entry-en');
    await page.locator('[data-testid="quick-row"]', { hasText: 'Kamala' }).click();
    await typeAmount('50');
    check((await text('[data-testid="entry-save"]')) === 'Save & next', 'quick entry keypad says "Save & next"');
    await tid('entry-save').click();
    await page.locator('.screen[data-route="quick"]').waitFor();
    check((await text('[data-testid="quick-sitting"]')).includes('1 entry · debit ₹50'), 'sitting count + total');
    check((await toast()).startsWith('Kamala:'), 'quick-entry Undo toast names the customer');
    await shot('quick-entry-after-save-en', { keepToast: true });
    await page.locator('.toast-action').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="quick-sitting"]')?.textContent?.includes('0 entries'));
    check(true, 'Undo from the toast reverses the quick entry');

    console.log('Quick entry: a new customer from a back-dated slip');
    await tid('quick-date').click();
    await page.locator('.sheet .sheet-item').nth(1).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="quick-date"]')?.textContent?.includes('Yesterday'));
    await tid('quick-search').fill('Pushpa');
    check((await page.locator('[data-testid="quick-row"]').count()) === 0, 'unknown name: no rows');
    await tid('quick-add-as-new').click();
    await page.locator('.screen[data-route="customer-edit"]').waitFor();
    check((await tid('cust-name').inputValue()) === 'Pushpa', 'name carried into the new-customer form');
    await tid('cust-save-credit').click();
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await text('[data-testid="date-chip"]')).includes('Yesterday') && (await text('[data-testid="entry-save"]')) === 'Save & next', 'keypad in quick mode with the sticky date');
    await typeAmount('20');
    await tid('entry-save').click();
    await page.locator('.screen[data-route="quick"]').waitFor();
    check((await text('[data-testid="quick-sitting"]')).includes('1 entry · debit ₹20'), 'back on the quick list, sitting carried on');
    await shot('quick-entry-new-customer-en', { keepToast: true });
    await page.locator('.toast-action').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="quick-sitting"]')?.textContent?.includes('0 entries'));
    await tid('quick-finish').click();
    await page.locator('.screen[data-route="daybook"]').waitFor();
    await page.locator('.date-nav .icon-btn').first().click();
    await page.waitForFunction(() => document.querySelector('[data-testid="day-date"]')?.textContent?.includes('Yesterday'));
    check((await page.locator('[data-testid="typed-on"]').count()) >= 1, 'back-dated slip shows "typed <date>" instead of a misleading time');
    await shot('daybook-yesterday-en');
    await openCustomer('Pushpa');
    check((await tid('act-receipt').count()) === 1 && (await text('[data-testid="hero"]')).includes('Settled'), 'settled customer: green Settled + "Send receipt"');
    await shot('customer-settled-en');
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
    await page.waitForFunction(() => document.querySelector('[data-testid="pin-msg"]')?.textContent);
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
