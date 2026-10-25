#!/usr/bin/env node
/**
 * End-to-end walk through VOICE MODE (the always-listening counter mode) in Chromium at Redmi size, with the
 * scripted fake recogniser (window.__KK_FAKE_SPEECH__, src/platform/fake-speech.ts) standing in for Google's speech
 * service: every listen() takes the next scripted sentence, an empty script is silence.
 *   node e2e/voice-mode.mjs                 # vite build + vite preview on a free port
 *   E2E_URL=http://127.0.0.1:5173/ node e2e/voice-mode.mjs
 * Screenshots: e2e/screenshots/vm-NN-name.png (only vm-*.png are replaced).
 *
 * The brief: voice mode ON -> "Ramu 500 kudukkanum" -> card "Ramu ₹500 Debit" -> Approve (or Edit) -> saved ->
 * still listening -> "Seenu 200 kudutharu" -> card -> ... until Stop. Plus the counter's real life: talk that is not
 * an entry, a balance question, a new customer, no direction said, two customers with one name, Skip, Edit on the
 * keypad and back, Undo, two entries in one sentence, Pause / Resume, the app going to the background, no
 * internet, the idle pause, the early stop on a complete sentence, Tamil, settings, a refused microphone.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
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
  mkdirSync(SHOTS, { recursive: true });
  for (const f of readdirSync(SHOTS)) if (/^vm-/.test(f)) rmSync(join(SHOTS, f), { force: true });
  const server = await startServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 393, height: 851 },
    deviceScaleFactor: 2.75,
    isMobile: true,
    hasTouch: true,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });
  await context.addInitScript(() => {
    window.__KK_FAKE_SPEECH__ = [];
    window.__KK_FAKE_SPEECH_OPTIONS__ = { delayMs: 400 };
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  const tid = (id) => page.locator(`[data-testid="${id}"]`);
  const text = async (sel) => (await page.locator(sel).first().innerText()).trim();
  const settle = () => page.waitForTimeout(250);
  const say = (alts) => page.evaluate((a) => { window.__KK_FAKE_SPEECH__.push(a); }, alts);
  const speechOptions = (o) => page.evaluate((x) => { Object.assign(window.__KK_FAKE_SPEECH_OPTIONS__, x); }, o);
  const calls = () => page.evaluate(() => (window.__KK_FAKE_SPEECH_CALLS__ ?? []).map((c) => ({ quietStart: !!c.quietStart, maxMs: c.maxMs, bias: (c.biasPhrases ?? []).length })));
  const state = () => text('[data-testid="vm-state"]');
  const note = () => text('[data-testid="vm-note"]');
  const pressed = (id) => tid(id).getAttribute('aria-pressed');

  async function shot(name, { keepToast = false } = {}) {
    await settle();
    if (!keepToast) await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    const file = join(SHOTS, `vm-${String(++shotNo).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: file });
    const overflow = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const bad = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width && (r.right > w + 1 || r.left < -1) && getComputedStyle(el).position !== 'fixed') {
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
  async function toastText() {
    const el = page.locator('.toast .toast-msg');
    await el.waitFor({ timeout: 5000 });
    return (await el.innerText()).trim();
  }
  async function home() {
    for (let i = 0; i < 8 && !(await page.locator('.screen[data-route="home"]').count()); i++) {
      await page.keyboard.press('Escape');
      await settle();
    }
    await page.locator('.screen[data-route="home"]').waitFor();
  }
  async function addCustomer(name, { note: n, credit } = {}) {
    await home();
    await tid('add-customer').click();
    await tid('cust-name').fill(name);
    if (n) await tid('cust-note').fill(n);
    if (credit) {
      await tid('cust-save-credit').click();
      await page.locator('.screen[data-route="entry"]').waitFor();
      await typeAmount(credit);
      await tid('entry-save').click();
    } else await tid('cust-save').click();
    // a second customer with the same name asks "same person?": this one is new
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(100);
      const add = page.locator('.dialog button', { hasText: /new|புதிய/i });
      if (await add.count()) {
        await add.first().click();
        break;
      }
      if (await page.locator('.screen[data-route="customer"]').count()) break;
    }
    await page.locator('.screen[data-route="customer"]').waitFor();
  }
  async function balanceOf(rowText) {
    await home();
    const row = page.locator('[data-testid="cust-row"]', { hasText: rowText }).first();
    return (await row.locator('.cust-side').innerText()).replace(/\s+/g, ' ').trim();
  }
  /** Wait until voice mode is listening (a session is open and no card waits). */
  async function listening() {
    await page.waitForFunction(() => document.querySelector('[data-testid="vm-orb"]')?.classList.contains('listening'), null, { timeout: 8000 });
  }
  async function card() {
    await tid('vm-card').waitFor({ timeout: 8000 });
  }
  async function noCard() {
    await tid('vm-card').waitFor({ state: 'detached', timeout: 8000 });
  }
  /** Approve the card; the duplicate / big / advance questions are answered Yes. */
  async function approve() {
    await tid('vm-approve').click();
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(100);
      const yes = page.locator('.dialog .btn-gave, .dialog .btn-got, .dialog .btn-primary');
      if (await yes.count()) {
        log('    (confirmation answered)');
        await yes.first().click();
      }
      if (!(await tid('vm-card').count())) return;
      const busy = await tid('vm-card').getAttribute('class');
      if (busy && !busy.includes('busy') && !(await page.locator('.dialog').count())) {
        // either a next card of the same sentence, or still this one
        return;
      }
    }
  }
  async function hidden(on) {
    await page.evaluate((h) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, on);
  }

  try {
    console.log('setup: onboarding (English) + customers');
    await page.goto(server.url);
    await tid('onb-en').waitFor();
    await tid('onb-en').click();
    await tid('onb-shop').fill('Sri Murugan Stores');
    await tid('onb-next').click();
    await tid('pin-skip').waitFor();
    await tid('pin-skip').click();
    await tid('onb-start').click();
    await page.locator('.screen[data-route="home"]').waitFor();
    await addCustomer('Ramu', { credit: '300' });
    await addCustomer('Seenu');
    await addCustomer('Kamala');
    await addCustomer('Kumar');
    await home();
    check((await tid('nav-voice').count()) === 1, 'Home: "Voice mode" in the bottom bar');
    await shot('home-voice-nav');

    console.log('1. Voice mode ON: the Google notice, then voice mode\'s own notice, then it listens');
    await tid('nav-voice').click();
    await tid('voice-notice').waitFor();
    await page.locator('.dialog .btn-primary').click();
    await tid('vm-notice').waitFor();
    const noticeText = await text('[data-testid="vm-notice"]');
    check(/Approve/.test(noticeText) && /15 minutes/.test(noticeText) && /charger/.test(noticeText), 'voice-mode notice: Approve needed, pauses after 15 minutes, keep it on the charger');
    await shot('notice');
    await page.locator('.dialog .btn-primary').click();
    await page.locator('.screen[data-route="voice-mode"]').waitFor();
    await listening();
    check((await state()) === 'Listening…', 'listening');
    check((await text('.vm-hint')).includes('Ramu 500 kudukkanum'), 'the hint shows how to speak');
    const c0 = await calls();
    check(c0.length > 0 && c0.every((c) => c.quietStart && c.maxMs === 20000 && c.bias > 0), 'every session asks for a quiet start, caps at 20 s and carries the names for biasing');
    await shot('listening');

    console.log('2. "Ramu 500 kudukkanum" -> card: Ramu, ₹500, Debit, Due ₹300 -> Due ₹800; the mic is off meanwhile');
    await speechOptions({ delayMs: 1200 });
    await say(['Ramu 500 kudukkanum']);
    await page.waitForFunction(() => /Ramu/.test(document.querySelector('[data-testid="vm-live"]')?.textContent ?? ''), null, { timeout: 8000 });
    log('ok  live words show while speaking');
    await card();
    check((await text('[data-testid="vm-name"]')) === 'Ramu' && (await text('[data-testid="vm-amount"]')) === '₹500', 'card: Ramu ₹500');
    check((await pressed('vm-kind-GIVE')) === 'true' && (await pressed('vm-kind-RECEIVE')) === 'false', 'card: Debit preselected (kudukkanum = he has to give)');
    check((await text('[data-testid="vm-bal"]')) === 'Due ₹300 → Due ₹800', 'card: balance before -> after');
    check((await state()) === 'Mic is off until you Approve or Skip', 'status: mic off until Approve / Skip');
    check((await text('[data-testid="vm-approve"]')) === 'Approve Debit ₹500', 'Approve button names what it saves');
    const before = (await calls()).length;
    await page.waitForTimeout(1500);
    check((await calls()).length === before, 'no listening session runs while the card waits');
    await shot('card-ramu-debit');
    await approve();
    await noCard();
    check((await note()).startsWith('Saved: Ramu · Debit ₹500 · Due ₹800'), `saved note: ${await note()}`);
    check((await tid('vm-log-item').count()) === 1, 'session log: one entry');
    await listening();
    log('ok  still listening after Approve');

    console.log('3. "Seenu 200 kudutharu" -> card: Seenu ₹200 Credit -> Approve; the cycle goes on');
    await say(['Seenu 200 kudutharu']);
    await card();
    check((await text('[data-testid="vm-name"]')) === 'Seenu' && (await text('[data-testid="vm-amount"]')) === '₹200' && (await pressed('vm-kind-RECEIVE')) === 'true', 'card: Seenu ₹200 Credit');
    await approve();
    await noCard();
    check((await text('[data-testid="vm-sum"]')) === '2 saved · Debit ₹500 · Credit ₹200', 'session total: 2 saved · Debit ₹500 · Credit ₹200');
    await listening();
    await shot('saved-two');

    console.log('4. counter talk is not an entry: no card, the status says what was heard');
    await speechOptions({ delayMs: 400 });
    await say(['arisi 50 rupa']);
    await page.waitForFunction(() => /arisi 50 rupa/.test(document.querySelector('[data-testid="vm-note"]')?.textContent ?? ''), null, { timeout: 8000 });
    check((await note()) === 'Not an entry: “arisi 50 rupa”' && (await tid('vm-card').count()) === 0, '"arisi 50 rupa": ignored');
    await say(['enna anna epdi irukeenga']);
    await page.waitForFunction(() => /epdi/.test(document.querySelector('[data-testid="vm-note"]')?.textContent ?? ''), null, { timeout: 8000 });
    check((await tid('vm-card').count()) === 0, '"enna anna epdi irukeenga": ignored');
    await say(['Kumar vanthaan']);
    await page.waitForFunction(() => /Kumar vanthaan/.test(document.querySelector('[data-testid="vm-note"]')?.textContent ?? ''), null, { timeout: 8000 });
    check((await note()) === '“Kumar vanthaan”: say the amount too.', 'a customer without an amount: asks for the amount');
    await listening();

    console.log('5. a balance question is answered on the status line');
    await say(['Ramu baaki evvalavu']);
    await page.waitForFunction(() => /Ramu: Due/.test(document.querySelector('[data-testid="vm-note"]')?.textContent ?? ''), null, { timeout: 8000 });
    check((await note()) === 'Ramu: Due ₹800', 'Ramu: Due ₹800');
    await shot('balance-answer');

    console.log('6. a name nobody has, with an entry word -> new-customer card -> "Add & approve"');
    await say(['Murali 150 kuduthaaru']);
    await card();
    check((await text('.vm-who-main .badge')) === 'New customer' && (await text('[data-testid="vm-name"]')) === 'Murali', 'card: New customer Murali');
    check((await text('[data-testid="vm-approve"]')) === 'Add “Murali” & approve', 'Approve adds the customer too');
    await shot('card-new-customer');
    await approve();
    await noCard();
    check((await note()).startsWith('Saved: Murali · Credit ₹150'), 'Murali added and saved');

    console.log('6b. Edit on a new-customer card: the customer form, then the keypad, then back to voice mode');
    await say(['Velu 80 kuduthaaru']);
    await card();
    await tid('vm-edit').click();
    await page.locator('.screen[data-route="customer-edit"]').waitFor();
    check((await tid('cust-name').inputValue()) === 'Velu', 'customer form prefilled "Velu"');
    await tid('cust-save').click();
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await text('[data-testid="amount"]')) === '₹80' && (await pressed('kind-RECEIVE')) === 'true', 'keypad: Velu ₹80 Credit');
    await tid('entry-save').click();
    await page.locator('.screen[data-route="voice-mode"]').waitFor();
    await noCard();
    check((await note()).startsWith('Saved: Velu · Credit ₹80'), 'Velu added and saved, back in voice mode');
    await listening();

    console.log('6c. a near name ("Ramo" for Ramu): Ramu preselected, "+ Add “Ramo” as new" offered');
    await say(['Ramo 40 kattinaan']);
    await card();
    check((await text('[data-testid="vm-name"]')) === 'Ramu' && (await tid('vm-add-new').count()) === 1, 'Ramu preselected, add-as-new offered');
    await tid('vm-add-new').click();
    check((await text('[data-testid="vm-approve"]')) === 'Add “Ramo” & approve', 'switched to a new customer "Ramo"');
    await tid('vm-skip').click();
    await noCard();

    console.log('7. no direction said ("Kamala 250"): Debit or Credit must be tapped first');
    await say(['Kamala 250']);
    await card();
    check((await pressed('vm-kind-GIVE')) === 'false' && (await pressed('vm-kind-RECEIVE')) === 'false', 'nothing preselected');
    check((await tid('vm-approve').isDisabled()) && (await text('[data-testid="vm-approve"]')) === 'Pick Debit or Credit', 'Approve waits for Debit / Credit');
    await shot('card-pick-kind');
    await tid('vm-kind-GIVE').click();
    check(!(await tid('vm-approve').isDisabled()) && (await text('[data-testid="vm-approve"]')) === 'Approve Debit ₹250', 'Debit tapped: Approve Debit ₹250');
    await approve();
    await noCard();

    console.log('8. Skip saves nothing and listening goes on');
    await say(['Kumar 40 kattinaan']);
    await card();
    await tid('vm-skip').click();
    await noCard();
    await listening();
    check((await tid('vm-log-item').count()) === 5, 'still 5 entries in the session (Skip saved nothing)');

    console.log('9. Edit: the keypad opens prefilled; Save returns to voice mode, logged, listening again');
    await say(['Kumar 60 vaanginaan']);
    await card();
    await tid('vm-edit').click();
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await text('[data-testid="amount"]')) === '₹60' && (await pressed('kind-GIVE')) === 'true', 'keypad: Kumar ₹60 Debit prefilled');
    await page.locator('.keypad [data-key="back"]').click();
    await typeAmount('5');
    await tid('entry-save').click();
    await page.locator('.screen[data-route="voice-mode"]').waitFor();
    await noCard();
    check((await note()).startsWith('Saved: Kumar · Debit ₹65'), 'saved from the keypad as ₹65, logged in voice mode');
    check((await tid('vm-log-item').count()) === 6, '6 entries in the session');
    await listening();
    log('ok  listening again after the keypad');

    console.log('10. Edit and back without saving: the card comes back');
    await say(['Kamala 30 kattinaa']);
    await card();
    await tid('vm-edit').click();
    await page.locator('.screen[data-route="entry"]').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="voice-mode"]').waitFor();
    await card();
    check((await text('[data-testid="vm-name"]')) === 'Kamala' && (await text('[data-testid="vm-amount"]')) === '₹30', 'the Kamala ₹30 card is back');
    await tid('vm-skip').click();
    await noCard();

    console.log('11. Undo from the session log');
    await page.locator('[data-testid="vm-log-item"]', { hasText: 'Seenu' }).locator('[data-testid="vm-undo"]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="vm-log-item"]')].some((e) => e.classList.contains('undone') && /Seenu/.test(e.textContent ?? '')), null, { timeout: 5000 });
    check((await note()).startsWith('Undone: Seenu'), 'Seenu ₹200 undone');
    check((await text('[data-testid="vm-sum"]')).startsWith('5 saved'), 'session total leaves the undone entry out');
    await shot('session-log-undo');

    console.log('12. two entries in one sentence: one card after the other');
    await say(['Ramu 100 kattinaan Kumar 50 vaanginaan']);
    await card();
    check((await text('[data-testid="vm-name"]')) === 'Ramu' && (await text('[data-testid="vm-amount"]')) === '₹100' && (await text('.vm-card')).includes('1 more from the same sentence'), 'card 1 of 2: Ramu ₹100 (1 more after this)');
    await approve();
    await page.waitForFunction(() => document.querySelector('[data-testid="vm-name"]')?.textContent === 'Kumar', null, { timeout: 5000 });
    check((await text('[data-testid="vm-amount"]')) === '₹50' && (await pressed('vm-kind-GIVE')) === 'true', 'card 2 of 2: Kumar ₹50 Debit');
    await approve();
    await noCard();
    await listening();

    console.log('13. Stop: summary, back home; the balances are in the ledger');
    await tid('vm-stop').click();
    await page.locator('.screen[data-route="home"]').waitFor();
    const sum = await toastText();
    check(sum === 'Voice mode off. 7 saved: Debit ₹865, Credit ₹330.', `summary: ${sum}`);
    const after = (await calls()).length;
    await page.waitForTimeout(1200);
    check((await calls()).length === after, 'no listening after Stop');
    check((await balanceOf('Ramu')).includes('₹700'), 'Ramu: 300 + 500 - 100 = ₹700 due');
    check((await balanceOf('Kumar')).includes('₹115'), 'Kumar: 65 + 50 = ₹115 due');
    check((await balanceOf('Kamala')).includes('₹250'), 'Kamala: ₹250 due');
    check((await balanceOf('Seenu')).includes('₹0'), 'Seenu: ₹200 undone -> ₹0');
    check(/150/.test(await balanceOf('Murali')) && /Advance|முன்பணம்/i.test(await balanceOf('Murali')), 'Murali: new customer, advance ₹150');

    console.log('14. two customers called Ramu: the card asks which one');
    await addCustomer('Ramu', { note: 'school' });
    await home();
    await tid('nav-voice').click();
    await page.locator('.screen[data-route="voice-mode"]').waitFor();
    check((await page.locator('.dialog').count()) === 0, 'no notice the second time');
    await listening();
    await say(['Ramu 70 kattinaan']);
    await card();
    check((await tid('vm-pick').count()) === 2 && (await tid('vm-approve').isDisabled()) && (await text('[data-testid="vm-approve"]')) === 'Pick the customer', 'two Ramus listed, Approve waits for a pick');
    await shot('card-two-ramus');
    await page.locator('[data-testid="vm-pick"]', { hasText: 'school' }).click();
    check((await text('[data-testid="vm-approve"]')) === 'Approve Credit ₹70', 'the school Ramu picked: Approve Credit ₹70');
    await approve();
    await noCard();
    check((await text('[data-testid="vm-sum"]')) === '1 saved · Credit ₹70', 'session total names only the sides used: 1 saved · Credit ₹70');

    console.log('15. Pause / Resume: nothing is heard while paused');
    await listening();
    await tid('vm-pause').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="vm-orb"]')?.classList.contains('paused'), null, { timeout: 5000 });
    check((await state()).startsWith('Paused. Not listening'), 'paused');
    const pausedCalls = (await calls()).length;
    await say(['Kamala 20 kattinaa']);
    await page.waitForTimeout(1500);
    check((await calls()).length === pausedCalls && (await tid('vm-card').count()) === 0, 'no session while paused');
    await shot('paused');
    await tid('vm-pause').click();
    await card();
    check((await text('[data-testid="vm-name"]')) === 'Kamala', 'after Resume the next sentence is heard');
    await tid('vm-skip').click();
    await noCard();

    console.log('15b. Pause while a card waits, then Edit + Save: still paused afterwards');
    await listening();
    await say(['Kamala 15 kattinaa']);
    await card();
    await tid('vm-pause').click();
    await tid('vm-edit').click();
    await page.locator('.screen[data-route="entry"]').waitFor();
    await tid('entry-save').click();
    await page.locator('.screen[data-route="voice-mode"]').waitFor();
    await noCard();
    check((await note()).startsWith('Saved: Kamala · Credit ₹15'), 'saved from the keypad');
    await page.waitForTimeout(800);
    check((await page.locator('[data-testid="vm-orb"].paused').count()) === 1 && (await text('[data-testid="vm-pause"]')) === 'Resume', 'the Pause set before Edit is kept');
    await tid('vm-pause').click();

    console.log('16. the app goes to the background and comes back');
    await listening();
    await hidden(true);
    await page.waitForFunction(() => document.querySelector('[data-testid="vm-orb"]')?.classList.contains('paused'), null, { timeout: 5000 });
    check((await state()).includes('background'), 'paused while in the background');
    await hidden(false);
    await listening();
    log('ok  listening again when the app is back');

    console.log('17. no internet: retries by itself and carries on');
    await say(['!SPEECH_ERROR:NETWORK']);
    await say(['Kumar 20 kattinaan']);
    await page.waitForFunction(() => /No internet/.test(document.querySelector('[data-testid="vm-state"]')?.textContent ?? ''), null, { timeout: 8000 });
    log('ok  "No internet. Trying again…"');
    await shot('no-internet-retry');
    await card();
    check((await text('[data-testid="vm-name"]')) === 'Kumar', 'after the retry: Kumar ₹20 card');
    await tid('vm-skip').click();
    await noCard();

    console.log('18. pauses by itself after the idle time without an entry');
    await page.evaluate(() => { window.__KK_VM_IDLE_MS__ = 1500; });
    await page.waitForFunction(() => /No entry for/.test(document.querySelector('[data-testid="vm-state"]')?.textContent ?? ''), null, { timeout: 15000 });
    log('ok  idle pause');
    await page.evaluate(() => { delete window.__KK_VM_IDLE_MS__; });
    await tid('vm-pause').click();
    await listening();

    console.log('19. a complete sentence ends the session early, even with talk after it');
    await speechOptions({ delayMs: 7000 });
    await page.waitForTimeout(500);
    await say(['Kumar 25 kattinaan enna anna sollunga']);
    await page.waitForFunction(() => /^Kumar/.test(document.querySelector('[data-testid="vm-live"]')?.textContent ?? ''), null, { timeout: 15000 });
    const t0 = Date.now();
    await tid('vm-card').waitFor({ timeout: 10000 });
    const took = Date.now() - t0;
    check(took < 4200, `card ${took} ms after the first word (the session would have run ~6 s more)`);
    await speechOptions({ delayMs: 400 });
    await tid('vm-skip').click();
    await noCard();

    console.log('20. Tamil: the card in Tamil');
    await tid('vm-stop').click();
    await page.locator('.screen[data-route="home"]').waitFor();
    await tid('nav-settings').click();
    await tid('set-lang-ta').click();
    await page.waitForFunction(() => document.querySelector('.topbar h1')?.textContent === 'அமைப்புகள்');
    await home();
    await tid('nav-voice').click();
    await page.locator('.screen[data-route="voice-mode"]').waitFor();
    await listening();
    check((await state()) === 'கேட்கிறேன்…', 'Tamil: கேட்கிறேன்…');
    await say(['ராமு 500 குடுக்கணும்']);
    await card();
    check((await tid('vm-pick').count()) === 2, 'Tamil sentence: both Ramus offered');
    await page.locator('[data-testid="vm-pick"]', { hasText: 'C-0001' }).click();
    check((await text('.vm-who .vm-sub-label')) === 'எந்த வாடிக்கையாளர்?', 'the list keeps its "which customer?" title after a pick');
    check((await pressed('vm-kind-GIVE')) === 'true' && (await text('[data-testid="vm-approve"]')) === 'பற்று ₹500 அனுமதி', 'Tamil card: பற்று ₹500 அனுமதி');
    await shot('card-tamil');
    await tid('vm-skip').click();
    await noCard();
    await shot('listening-tamil');
    await tid('vm-stop').click();
    await page.locator('.screen[data-route="home"]').waitFor();
    check((await toastText()) === 'குரல் முறை நின்றது.', 'Tamil summary (nothing saved this time)');
    await shot('home-tamil-nav');

    console.log('21. settings: idle time and the beep');
    await tid('nav-settings').click();
    await tid('set-lang-en').click();
    await page.waitForFunction(() => document.querySelector('.topbar h1')?.textContent === 'Settings');
    await page.evaluate(() => document.querySelector('[data-testid="vm-settings"]')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(400);
    await tid('vm-idle-60').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="vm-idle-60"]')?.getAttribute('aria-pressed') === 'true');
    await tid('vm-quiet-off').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="vm-quiet-off"]')?.getAttribute('aria-pressed') === 'true');
    await page.evaluate(() => document.querySelector('[data-testid="vm-settings"]')?.scrollIntoView({ block: 'center' }));
    await shot('settings');
    await home();
    await tid('nav-voice').click();
    await page.locator('.screen[data-route="voice-mode"]').waitFor();
    await listening();
    const last = (await calls()).at(-1);
    check(last && last.quietStart === false, 'beep left on: the session starts without quietStart');
    await tid('vm-stop').click();
    await page.locator('.screen[data-route="home"]').waitFor();

    console.log('22. microphone refused: voice mode does not start');
    await speechOptions({ permission: false });
    await tid('nav-voice').click();
    const msg = await toastText();
    check(/Microphone permission/.test(msg) && (await page.locator('.screen[data-route="home"]').count()) === 1, 'refused microphone: message, stays on Home');
    await speechOptions({ permission: true });

    check(consoleErrors.length === 0, `no console errors ${consoleErrors.join(' | ')}`);
  } catch (e) {
    console.error(e);
    failures = Math.max(failures, 1);
    try {
      await page.screenshot({ path: join(SHOTS, `vm-${String(++shotNo).padStart(2, '0')}-FAILED.png`) });
    } catch {
      /* ignore */
    }
  } finally {
    await browser.close();
    server.stop();
  }
  console.log(failures ? `FAILED (${failures})` : 'ALL VOICE MODE FLOWS PASSED');
  process.exit(failures ? 1 : 0);
}

main();
