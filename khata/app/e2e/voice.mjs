#!/usr/bin/env node
/**
 * End-to-end walk through voice entry in Chromium at Redmi size, with the scripted fake recogniser
 * (window.__KK_FAKE_SPEECH__, see src/platform/fake-speech.ts) injected before the app loads.
 *   node e2e/voice.mjs                 # vite build + vite preview on a free port
 *   E2E_URL=http://127.0.0.1:5173/ node e2e/voice.mjs
 * Screenshots: e2e/screenshots/voice-NN-name.png (only voice-*.png are replaced; flows.mjs owns the rest).
 * Flows 13-16 cover hold-to-talk (press, release = finish, the "Finishing…" state), the short tap in hold mode,
 * the overlay mic (tap = Stop, hold = retry) and Settings -> Tap to talk, all driven with the mouse (the desktop /
 * web build). Flows 17-19 repeat the press, the tap and tap mode with REAL TOUCH input (CDP Input.dispatchTouchEvent
 * for a hold, page.touchscreen.tap for a tap): a touch tap's click is synthesized at the finger's position, which by
 * then is the listening sheet's scrim, so these flows assert that the sheet survives the release and the entry opens.
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
  for (const f of readdirSync(SHOTS)) if (/^voice-/.test(f)) rmSync(join(SHOTS, f), { force: true });
  const server = await startServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 393, height: 851 },
    deviceScaleFactor: 2.75,
    isMobile: true,
    hasTouch: true,
    locale: 'ta-IN',
    timezoneId: 'Asia/Kolkata',
  });
  // The fake recogniser must exist before the first mic tap; entries are pushed per flow with say().
  await context.addInitScript(() => {
    window.__KK_FAKE_SPEECH__ = [];
    window.__KK_FAKE_SPEECH_OPTIONS__ = { delayMs: 150 };
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  const tid = (id) => page.locator(`[data-testid="${id}"]`);
  const text = async (sel) => (await page.locator(sel).first().innerText()).trim();
  const settle = () => page.waitForTimeout(250);
  const say = (alts) => page.evaluate((a) => { window.__KK_FAKE_SPEECH__.push(a); }, alts);
  const speechOptions = (o) => page.evaluate((x) => { Object.assign(window.__KK_FAKE_SPEECH_OPTIONS__, x); }, o);

  async function shot(name, { keepToast = false } = {}) {
    await settle();
    if (!keepToast) await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    const file = join(SHOTS, `voice-${String(++shotNo).padStart(2, '0')}-${name}.png`);
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
  async function toast() {
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
  async function openCustomer(hasText) {
    await home();
    await page.locator('[data-testid="cust-row"]', { hasText }).first().click();
    await page.locator('.screen[data-route="customer"]').waitFor();
  }
  async function addCustomer(name, { phone, note, credit } = {}) {
    await home();
    await tid('add-customer').click();
    await tid('cust-name').fill(name);
    if (phone) await tid('cust-phone').fill(phone);
    if (note) await tid('cust-note').fill(note);
    if (credit) {
      await tid('cust-save-credit').click();
      await page.locator('.screen[data-route="entry"]').waitFor();
      await typeAmount(credit);
      await tid('entry-save').click();
    } else await tid('cust-save').click();
    await page.locator('.screen[data-route="customer"]').waitFor();
  }
  /** Tap a mic and wait for the listening sheet to go away (the fake resolves after delayMs). */
  async function speak(micId, alts, { beforeSheetGone } = {}) {
    await say(alts);
    await tid(micId).click();
    await tid('voice-sheet').waitFor();
    if (beforeSheetGone) await beforeSheetGone();
    await tid('voice-sheet').waitFor({ state: 'detached', timeout: 8000 });
  }
  const pressed = (id) => tid(id).getAttribute('aria-pressed');
  /** Scroll the settings body to the Voice section and let Chromium repaint (a big programmatic jump can leave
   *  a stale strip under the top bar in the very next headless screenshot). */
  async function scrollToVoice(sel = '#sec-voice') {
    await page.evaluate((q) => document.querySelector(q)?.scrollIntoView({ block: 'start' }), sel);
    await page.waitForTimeout(300);
    // a second, tiny scroll makes the compositor re-raster the strip under the top bar
    await page.evaluate(() => { const b = document.querySelector('.body'); b.scrollTop -= 2; });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(400);
  }
  /** Tap Save; the normal path may ask "same amount just saved, again?" (duplicate check) -> confirm it. */
  async function saveEntry() {
    await tid('entry-save').click();
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(100);
      if (await page.locator('.dialog .btn-primary').count()) {
        log('    (duplicate confirmation answered)');
        await page.locator('.dialog .btn-primary').click();
        return;
      }
      if (!(await page.locator('.screen[data-route="entry"]').count())) return;
    }
  }

  try {
    console.log('onboarding (Tamil) + customers');
    await page.goto(server.url);
    await tid('onb-ta').waitFor();
    await tid('onb-ta').click();
    await tid('onb-shop').fill('ஸ்ரீ முருகன் ஸ்டோர்ஸ்');
    await tid('onb-next').click();
    await tid('pin-skip').waitFor();
    await tid('pin-skip').click();
    await tid('onb-start').click();
    await page.locator('.screen[data-route="home"]').waitFor();
    check((await tid('mic').count()) === 1, 'empty ledger: the Speak button is already on Home');
    await addCustomer('Ramu', { phone: '98765 00001', note: 'கோயில் தெரு', credit: '250' });
    check((await text('[data-testid="balance"]')) === '₹250', 'Ramu owes ₹250');
    check((await text('[data-testid="hero"]')).includes('கோயில் தெரு'), 'Ramu was created with the note (the picker later tells the two Ramus apart by it)');
    await addCustomer('Kamala', { phone: '98765 43210' });
    await addCustomer('Kumar');
    await addCustomer('Ravi');
    await home();
    check((await tid('mic').count()) === 1, 'home: Speak button');
    await shot('home-mic-ta');
    // Flows 1-19 check the prefilled keypad; auto-save has its own flow (20) at the end.
    await tid('nav-settings').click();
    await tid('voice-auto-off').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="voice-auto-off"]')?.getAttribute('aria-pressed') === 'true');
    await home();

    console.log('1. "Ramu 100 kuduthaachu" -> Ramu, Credit ₹100, Save -> balance 150');
    await say(['Ramu 100 kuduthaachu']);
    await tid('mic').click();
    await tid('voice-notice').waitFor();
    check((await text('[data-testid="voice-notice"]')).includes('Google'), 'first mic tap: privacy notice names Google');
    await shot('privacy-notice-ta');
    await speechOptions({ delayMs: 2500 });
    await page.locator('.dialog .btn-primary').click();
    await tid('voice-sheet').waitFor();
    check((await text('[data-testid="voice-state"]')) === 'கேட்கிறேன்…', 'listening state in Tamil');
    const sheetText = await text('[data-testid="voice-sheet"]');
    check(sheetText.includes('ராமு 100 கட்டினான்') && sheetText.includes('ராமுக்கு 100 குடுத்தேன்'), 'hint shows one unambiguous sentence per direction');
    check((await text('[data-testid="voice-done"]')) === 'போதும்', 'stop button is an imperative, not a status');
    await page.waitForFunction(() => /Ramu/.test(document.querySelector('[data-testid="voice-live"]')?.textContent ?? ''));
    check(true, 'live transcript appears while listening');
    await shot('listening-ta');
    await tid('voice-sheet').waitFor({ state: 'detached', timeout: 8000 });
    await speechOptions({ delayMs: 150 });
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await text('.topbar .sub')) === 'Ramu', 'keypad opened for Ramu');
    check((await pressed('kind-RECEIVE')) === 'true' && (await pressed('kind-GIVE')) === 'false', 'Credit preselected (bare kuduthaachu = paid)');
    check((await text('[data-testid="amount"]')) === '₹100', 'amount ₹100 prefilled');
    check((await text('[data-testid="voice-heard"]')).includes('Ramu 100 kuduthaachu'), 'banner shows what was heard');
    const balLine = await text('[data-testid="voice-balance-line"]');
    check(balLine.includes('₹250') && balLine.includes('₹150'), `balance before -> after (${balLine})`);
    check((await text('[data-testid="voice-banner"]')).includes('சரிபார்க்கவும்'), 'medium confidence: "check before saving" line');
    await shot('entry-credit-prefilled-ta');
    await tid('entry-save').click();
    await page.locator('.screen[data-route="customer"]').waitFor();
    check((await toast()).includes('₹100'), 'saved through the normal path (toast)');
    check((await text('[data-testid="balance"]')) === '₹150', 'balance ₹150 after the voice Credit');
    check((await page.locator('.toast .toast-action').count()) === 1, 'Undo offered');
    await shot('customer-after-voice-credit-ta', { keepToast: true });

    console.log('2. "ராமுக்கு 250 அரிசி குடுத்தேன்" -> Debit ₹250, note அரிசி');
    await home();
    await speak('mic', ['ராமுக்கு 250 அரிசி குடுத்தேன்']);
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await pressed('kind-GIVE')) === 'true', 'Debit preselected (dative + kuduthen)');
    check((await text('[data-testid="amount"]')) === '₹250', 'amount ₹250');
    check((await tid('entry-note').inputValue()) === 'அரிசி', 'note prefilled with the item');
    check((await page.locator('.topbar.gave').count()) === 1, 'red Debit top bar');
    await shot('entry-debit-prefilled-ta');
    await tid('entry-save').click();
    await page.locator('.dialog').waitFor();
    check((await text('.dialog')).includes('₹250'), 'same ₹250 Debit minutes ago: the normal duplicate confirmation asks first');
    await shot('entry-duplicate-confirm-ta');
    await page.locator('.dialog .btn-primary').click();
    await page.locator('.screen[data-route="customer"]').waitFor();
    check((await text('[data-testid="balance"]')) === '₹400', 'balance ₹400 after the voice Debit');

    console.log('3. two Ramus -> picker');
    await home();
    await tid('add-customer').click();
    await tid('cust-name').fill('Ramu');
    await tid('cust-note').fill('பள்ளி அருகில்');
    await tid('cust-save').click();
    await page.locator('.dialog').waitFor();
    await page.locator('.dialog .btn-primary').click();
    await page.locator('.screen[data-route="customer"]').waitFor();
    await home();
    await speak('mic', ['Ramu 100 kattinaan']);
    await tid('voice-picker').waitFor();
    check((await page.locator('[data-testid="voice-pick"]').count()) === 2, 'picker lists both Ramus');
    const pickerText = await text('[data-testid="voice-picker"]');
    check(pickerText.includes('C-0001') && pickerText.includes('C-0005') && pickerText.includes('கோயில் தெரு') && pickerText.includes('₹400'), 'picker rows show code, note and balance');
    await shot('picker-two-ramus-ta');
    await page.locator('[data-testid="voice-pick"][data-id]', { hasText: 'பள்ளி' }).click();
    await page.locator('.screen[data-route="entry"]').waitFor();
    const line2 = await text('[data-testid="voice-balance-line"]');
    check(!line2.includes('₹400') && line2.startsWith('கணக்கு முடிந்தது'), `picked the second Ramu (settled -> ${line2})`);
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="customer"]').waitFor();
    check((await text('.topbar .sub')) === 'C-0005', 'backing out of an untouched voice prefill asks nothing; lands on that customer');

    console.log("4. on Ramu-1's page, 'Ramu 100 kattinaan' stays on Ramu-1");
    await openCustomer('கோயில்');
    check((await text('.topbar .sub')) === 'C-0001', 'on Ramu-1 (C-0001)');
    check((await tid('mic-customer').count()) === 1, 'customer page has a mic');
    await shot('customer-mic-ta');
    await speak('mic-customer', ['Ramu 100 kattinaan']);
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await page.locator('[data-testid="voice-picker"]').count()) === 0, 'no picker on the namesake page');
    check((await text('[data-testid="voice-balance-line"]')).includes('₹400'), 'keypad is for Ramu-1 (balance ₹400 -> ₹300)');
    await saveEntry();
    await page.locator('.screen[data-route="customer"]').waitFor();
    check((await text('.topbar .sub')) === 'C-0001' && (await text('[data-testid="balance"]')) === '₹300', 'saved on Ramu-1, balance ₹300');

    console.log('5. unknown name -> add customer -> entry');
    await home();
    await speak('mic', ['Suresh 150 kattinaan']);
    await tid('voice-new').waitFor();
    check((await text('[data-testid="voice-new"]')).includes('Suresh'), 'asks to add "Suresh"');
    await shot('add-new-prompt-ta');
    await tid('voice-pick-new').click();
    await page.locator('.screen[data-route="customer-edit"]').waitFor();
    check((await tid('cust-name').inputValue()) === 'Suresh', 'customer form prefilled with the heard name');
    await tid('cust-save').click();
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await text('.topbar .sub')) === 'Suresh' && (await pressed('kind-RECEIVE')) === 'true' && (await text('[data-testid="amount"]')) === '₹150', 'new customer keypad prefilled Credit ₹150');
    await saveEntry();
    await page.locator('.screen[data-route="customer"]').waitFor();
    check((await text('[data-testid="hero"]')).includes('முன்பணம்') && (await text('[data-testid="balance"]')) === '₹150', 'Suresh: advance ₹150');
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="home"]').waitFor();
    check(true, 'back from the new customer goes straight home');

    console.log('6. unclear direction: "Ramu 100 paaru" -> nothing preselected, Save disabled');
    await openCustomer('கோயில்');
    await speak('mic-customer', ['Ramu 100 paaru']);
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await pressed('kind-GIVE')) === 'false' && (await pressed('kind-RECEIVE')) === 'false', 'neither Debit nor Credit preselected');
    check(await tid('entry-save').isDisabled(), 'Save disabled until a direction is chosen');
    check((await tid('voice-ask').isVisible()) && (await text('.topbar h1')).includes('பற்றா'), 'asks "Debit or Credit?"');
    await shot('entry-unclear-direction-ta');
    await tid('kind-RECEIVE').click();
    check(!(await tid('entry-save').isDisabled()), 'Save enabled after tapping Credit');
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="customer"]').waitFor();
    check((await text('[data-testid="balance"]')) === '₹300', 'nothing saved without the tap');

    console.log('7. multi-entry queue "1 of 2"');
    await home();
    await speak('mic', ['Kumar 200 kattinaan Ravi 300 vaanginaan']);
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await text('.topbar .sub')) === 'Kumar' && (await text('[data-testid="voice-queue"]')) === '2-இல் 1', 'first keypad: Kumar, "1 of 2"');
    await shot('queue-1-of-2-ta');
    await saveEntry();
    await page.locator('.screen[data-route="entry"] [data-testid="voice-queue"]').waitFor();
    check((await text('.topbar .sub')) === 'Ravi' && (await text('[data-testid="voice-queue"]')) === '2-இல் 2' && (await pressed('kind-GIVE')) === 'true', 'second keypad: Ravi, "2 of 2", Debit');
    await saveEntry();
    await page.locator('.screen[data-route="customer"]').waitFor();
    check((await text('.topbar h1')).startsWith('Ravi') && (await text('[data-testid="balance"]')) === '₹300', 'lands on Ravi with ₹300');
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="home"]').waitFor();
    check((await text('[data-testid="summary"]')).includes('₹600'), 'home total ₹600 (Ramu 300 + Ravi 300); advances Suresh 150 + Kumar 200');

    console.log('8. alternatives disagree on the amount -> chips');
    await openCustomer('கோயில்');
    await speak('mic-customer', ['Ramu 100 kattinaan', 'Ramu 1000 kattinaan']);
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await page.locator('[data-testid="voice-alt"]').count()) === 2, 'two amount chips (₹100, ₹1,000)');
    await page.locator('[data-testid="voice-alt"][data-paise="100000"]').click();
    check((await text('[data-testid="amount"]')) === '₹1,000', 'tapping ₹1,000 sets the amount');
    const srcLine = await text('[data-testid="voice-amount-src"]');
    check((await text('[data-testid="voice-amount-was"]')) === '₹100' && srcLine.includes('₹1,000'), `banner follows the keypad: heard ₹100 struck, ₹1,000 shown (${srcLine.replace(/\n/g, ' ')})`);
    await shot('entry-amount-chips-ta');
    await page.locator('[data-testid="voice-alt"][data-paise="10000"]').click();
    check((await page.locator('[data-testid="voice-amount-was"]').count()) === 0 && (await text('[data-testid="voice-amount-src"]')) === '₹100', 'back on the heard amount: nothing struck');
    await page.locator('[data-testid="voice-alt"][data-paise="100000"]').click();
    await page.keyboard.press('Escape');
    await page.locator('.dialog').waitFor();
    check((await text('.dialog')).includes('₹1,000'), 'edited voice amount: back asks before discarding');
    await page.locator('.dialog .btn-danger').click();
    await page.locator('.screen[data-route="customer"]').waitFor();

    console.log('9. balance question, silence, errors, unavailable');
    await speak('mic-customer', ['baaki evvalavu']);
    await page.locator('.dialog').waitFor();
    check((await text('[data-testid="voice-balance"]')).includes('₹300'), 'balance question answered on the page customer');
    await page.locator('.dialog .btn').first().click();
    await say([]);
    await tid('mic-customer').click();
    await tid('voice-msg').waitFor();
    check((await text('[data-testid="voice-msg"]')).includes('கேட்கவில்லை'), 'silence: "nothing heard" with Try again');
    check(!(await text('[data-testid="voice-live"]')).includes('கேட்கிறேன்') && (await page.locator('.voice-mic.listening').count()) === 0, 'silence: live line no longer says "listening", pulse stopped');
    await shot('nothing-heard-ta');
    await say(['!SPEECH_ERROR:NETWORK']);
    await tid('voice-done').click();
    await page.waitForFunction(() => /இணையம்/.test(document.querySelector('[data-testid="voice-msg"]')?.textContent ?? ''));
    check(!(await text('[data-testid="voice-live"]')).includes('கேட்கிறேன்'), 'network error: live line no longer says "listening"');
    await tid('voice-cancel').click();
    await tid('voice-sheet').waitFor({ state: 'detached' });
    await speechOptions({ available: false });
    await tid('mic-customer').click();
    check((await toast()).includes('Google'), 'unavailable recogniser: clear message, no crash');
    await shot('unavailable-toast-ta', { keepToast: true });
    await speechOptions({ available: true });

    console.log('10. Settings -> Voice (Tamil), bare meaning flip, tester');
    await home();
    await tid('nav-settings').click();
    await page.locator('.screen[data-route="settings"]').waitFor();
    await scrollToVoice();
    await shot('settings-voice-ta');
    const saved = Number(await text('[data-testid="voice-stat-saved"] .v'));
    const cancelled = Number(await text('[data-testid="voice-stat-cancelled"] .v'));
    const heard = Number(await text('[data-testid="voice-stat-heard"] .v'));
    check(saved === 6 && cancelled === 3 && heard === 9, `voice_stats: saved ${saved} (6), cancelled ${cancelled} (3), heard ${heard}`);
    await tid('voice-try-input').fill('Ramu 100 kuduthaachu');
    await tid('voice-try-parse').click();
    await tid('voice-try-result').waitFor();
    check((await text('[data-testid="voice-try-result"]')).includes('வரவு'), 'tester: bare kuduthaachu = Credit by default');
    await tid('voice-bare-GIVE').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="voice-bare-GIVE"]')?.getAttribute('aria-pressed') === 'true');
    await tid('voice-try-input').fill('Ramu 100 kuduthaachu');
    await tid('voice-try-parse').click();
    await tid('voice-try-result').waitFor();
    check((await text('[data-testid="voice-try-result"]')).includes('பற்று'), 'tester: after the flip it means Debit');
    check((await text('[data-testid="voice-try-result"]')).includes('உறுதி:'), 'tester shows "certainty", not a technical word');
    await scrollToVoice('[data-testid="voice-try-result"]');
    await shot('settings-voice-tester-ta');
    await tid('voice-bare-RECEIVE').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="voice-bare-RECEIVE"]')?.getAttribute('aria-pressed') === 'true');
    const secText = await text('[data-testid="sec-voice"]');
    check(secText.includes('Google') && secText.includes('குரல் தனியுரிமை'), 'privacy line in the Voice section under its own "Voice privacy" heading');
    await context.setOffline(true);
    await tid('voice-try-mic').click();
    check((await toast()).includes('இணையம்'), 'Settings Try mic offline: the same "needs internet" message as the mic buttons');
    await context.setOffline(false);
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await say(['Kamala 40 kattinaan']);
    await tid('voice-try-mic').click();
    await page.waitForFunction(() => /Kamala/.test(document.querySelector('[data-testid="voice-try-result"]')?.textContent ?? ''));
    check((await text('[data-testid="voice-try-result"]')).includes('வரவு'), 'Settings Try mic online: heard sentence parsed, nothing saved');

    console.log('11. English UI');
    await tid('set-lang-en').click();
    await page.waitForFunction(() => document.querySelector('.topbar h1')?.textContent === 'Settings');
    await scrollToVoice();
    await shot('settings-voice-en');
    await home();
    await speechOptions({ delayMs: 2500 });
    await say(['Ramu five hundred paid']);
    await tid('mic').click();
    await tid('voice-sheet').waitFor();
    check((await text('[data-testid="voice-state"]')) === 'Listening…', 'listening in English');
    await page.waitForFunction(() => /Ramu five/.test(document.querySelector('[data-testid="voice-live"]')?.textContent ?? ''));
    await shot('listening-en');
    await tid('voice-sheet').waitFor({ state: 'detached', timeout: 8000 });
    await speechOptions({ delayMs: 150 });
    await tid('voice-picker').waitFor();
    await shot('picker-en');
    await page.locator('[data-testid="voice-pick"][data-id]', { hasText: 'C-0001' }).click();
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await text('[data-testid="voice-amount-src"]')).includes('five hundred') && (await text('[data-testid="amount"]')) === '₹500', 'amount source in large type: "five hundred → ₹500"');
    check((await text('[data-testid="voice-banner"]')).includes('Heard:'), 'banner in English');
    await shot('entry-prefilled-en');
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="customer"]').waitFor();
    await speak('mic-customer', ['Ramu 100 paaru']);
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await text('.topbar h1')).includes('Debit or Credit?'), 'unclear direction title in English');
    await shot('entry-unclear-direction-en');
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="customer"]').waitFor();

    console.log('12. Voice off hides the customer mic; the Home Speak button stays');
    await home();
    await tid('nav-settings').click();
    await tid('voice-off').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="voice-off"]')?.getAttribute('aria-pressed') === 'true');
    await home();
    check((await tid('mic').count()) === 1, 'home Speak button stays when voice is off');
    await openCustomer('Kamala');
    check((await tid('mic-customer').count()) === 0, 'customer mic hidden when voice is off');
    await home();
    await tid('nav-settings').click();
    await tid('voice-on').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="voice-on"]')?.getAttribute('aria-pressed') === 'true');

    console.log('13. hold-to-talk (default): press the mic, speak, release -> "Finishing…" -> prefilled entry');
    await tid('set-lang-ta').click();
    await page.waitForFunction(() => document.querySelector('.topbar h1')?.textContent === 'அமைப்புகள்');
    await scrollToVoice();
    check((await pressed('voice-hold-on')) === 'true' && (await pressed('voice-hold-off')) === 'false', 'Settings: hold-to-talk is the default');
    check((await text('[data-testid="sec-voice"]')).includes('வாயருகில்'), 'Settings: hint that holding the phone near the mouth helps');
    await shot('settings-hold-ta');
    await home();
    /** Press (pointerdown) a button with the mouse and keep it down; the caller releases with page.mouse.up(). */
    async function pressDown(id) {
      const box = await tid(id).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
    }
    // The fake would answer by itself after delayMs; the release must come first and the result follows stopDelayMs later.
    await speechOptions({ delayMs: 2000, stopDelayMs: 600 });
    await say(['Kamala 70 kattinaan']);
    const t0 = Date.now();
    await pressDown('mic');
    await tid('voice-sheet').waitFor();
    check((await text('[data-testid="voice-state"]')) === 'கேட்கிறேன்…', 'holding: listening');
    check((await text('[data-testid="voice-hint"]')) === 'விரலை எடுத்தால் முடியும்' && (await page.locator('.voice-hint.hold').count()) === 1, 'holding: hint reads "Release to finish"');
    check(!(await tid('voice-done').isVisible()) && (await tid('voice-cancel').isVisible()), 'holding: no Stop button (the release is the end), Cancel stays');
    await page.waitForFunction(() => /Kamala/.test(document.querySelector('[data-testid="voice-live"]')?.textContent ?? ''));
    await shot('hold-listening-ta');
    if (Date.now() - t0 < 600) await page.waitForTimeout(600 - (Date.now() - t0));
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('[data-testid="voice-state"]')?.textContent === 'முடிக்கிறேன்…');
    check(true, 'release: "Finishing…"');
    check(!(await tid('voice-done').isVisible()), 'finishing: no Stop button');
    check((await page.locator('.voice-mic.listening').count()) === 0 && (await page.locator('.voice-mic.finishing').count()) === 1, 'finishing: pulse stopped');
    check(!(await tid('voice-hint').isVisible()), 'finishing: no hint at all (nothing more can be said)');
    await shot('hold-finishing-ta');
    await tid('voice-sheet').waitFor({ state: 'detached', timeout: 8000 });
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await text('.topbar .sub')) === 'Kamala' && (await text('[data-testid="amount"]')) === '₹70' && (await pressed('kind-RECEIVE')) === 'true', 'release delivered the entry: Kamala, Credit ₹70');
    await shot('hold-entry-prefilled-ta');
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="customer"]').waitFor();
    check((await text('.topbar h1')).startsWith('Kamala') && (await text('[data-testid="balance"]')) === '₹0' && (await page.locator('.toast').count()) === 0, 'nothing saved on release: Kamala still ₹0, no toast (back out)');

    console.log('14. hold mode: a short tap (< 350 ms) still works like before');
    await home();
    await speechOptions({ delayMs: 2500, stopDelayMs: 0 });
    await say(['Ravi 20 kattinaan']);
    await tid('mic').click();
    await tid('voice-sheet').waitFor();
    check((await text('[data-testid="voice-hint"]')).includes('சொல்லுங்கள்') && (await page.locator('.voice-hint.hold').count()) === 0, 'tap: normal "Say:" hint, no "Release to finish"');
    check((await text('[data-testid="voice-hint-hold"]')).includes('மைக்கை அழுத்திப் பிடித்து'), 'tap in hold mode: the hint also says the mic can be held');
    check((await text('[data-testid="voice-done"]')) === 'போதும்' && (await tid('voice-done').isVisible()), 'tap: Stop offered');
    await shot('hold-mode-tap-listening-ta');
    await tid('voice-sheet').waitFor({ state: 'detached', timeout: 8000 });
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await text('.topbar .sub')) === 'Ravi' && (await text('[data-testid="amount"]')) === '₹20', 'tap: listening ran to the end by itself, Ravi ₹20 prefilled');
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="customer"]').waitFor();

    console.log('15. overlay mic: short tap while listening = Stop; after "nothing heard", hold it to retry and release to finish');
    await home();
    await speechOptions({ delayMs: 10_000, stopDelayMs: 0 });
    await say(['Kumar 30 kattinaan']);
    await tid('mic').click();
    await tid('voice-sheet').waitFor();
    await tid('voice-mic').click();
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await text('.topbar .sub')) === 'Kumar' && (await text('[data-testid="amount"]')) === '₹30', 'overlay mic tap stopped the session and delivered Kumar ₹30');
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="customer"]').waitFor();
    await home();
    await speechOptions({ delayMs: 150 });
    await say([]);
    await tid('mic').click();
    await tid('voice-msg').waitFor();
    await speechOptions({ delayMs: 2000, stopDelayMs: 300 });
    await say(['Kamala 90 vaanginaal']);
    const t1 = Date.now();
    await pressDown('voice-mic');
    await page.waitForFunction(() => document.querySelector('[data-testid="voice-state"]')?.textContent === 'கேட்கிறேன்…');
    check((await text('[data-testid="voice-hint"]')) === 'விரலை எடுத்தால் முடியும்', 'overlay mic held: retry started with the "Release to finish" hint');
    await page.waitForFunction(() => /Kamala/.test(document.querySelector('[data-testid="voice-live"]')?.textContent ?? ''));
    await shot('hold-retry-listening-ta');
    if (Date.now() - t1 < 600) await page.waitForTimeout(600 - (Date.now() - t1));
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('[data-testid="voice-state"]')?.textContent === 'முடிக்கிறேன்…');
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await text('.topbar .sub')) === 'Kamala' && (await text('[data-testid="amount"]')) === '₹90' && (await pressed('kind-GIVE')) === 'true', 'overlay mic release delivered Kamala Debit ₹90');
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="customer"]').waitFor();

    console.log('16. Settings -> Tap to talk: holding does not finish on release; a click works as before');
    await home();
    await tid('nav-settings').click();
    await page.locator('.screen[data-route="settings"]').waitFor();
    await tid('voice-hold-off').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="voice-hold-off"]')?.getAttribute('aria-pressed') === 'true');
    await scrollToVoice();
    await shot('settings-tap-mode-ta');
    await home();
    await speechOptions({ delayMs: 1500, stopDelayMs: 0 });
    await say(['Ravi 40 kattinaan']);
    await pressDown('mic');
    await tid('voice-sheet').waitFor();
    check((await page.locator('.voice-hint.hold').count()) === 0 && (await tid('voice-hint-hold').count()) === 0, 'tap mode: no hold hint while the mic is held, no "hold the mic" tip');
    await page.waitForTimeout(600);
    await page.mouse.up();
    await page.waitForTimeout(100);
    check((await text('[data-testid="voice-state"]')) === 'கேட்கிறேன்…' && (await tid('voice-done').isVisible()), 'tap mode: releasing after 600 ms does not end the session (still listening, Stop offered)');
    await tid('voice-sheet').waitFor({ state: 'detached', timeout: 8000 });
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await text('.topbar .sub')) === 'Ravi' && (await text('[data-testid="amount"]')) === '₹40', 'tap mode: the recogniser ended the session itself, Ravi ₹40');
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="customer"]').waitFor();
    await home();
    await speechOptions({ delayMs: 150 });
    await speak('mic', ['Kumar 55 kattinaan']);
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await text('.topbar .sub')) === 'Kumar' && (await text('[data-testid="amount"]')) === '₹55', 'tap mode: click works as before');
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="customer"]').waitFor();
    await home();
    await tid('nav-settings').click();
    await tid('voice-hold-on').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="voice-hold-on"]')?.getAttribute('aria-pressed') === 'true');
    await tid('set-lang-en').click();
    await page.waitForFunction(() => document.querySelector('.topbar h1')?.textContent === 'Settings');
    await scrollToVoice();
    await shot('settings-hold-en');
    await home();
    await speechOptions({ delayMs: 2000, stopDelayMs: 600 });
    await say(['Kamala 15 paid']);
    await pressDown('mic');
    await tid('voice-sheet').waitFor();
    check((await text('[data-testid="voice-hint"]')) === 'Release to finish', 'English: "Release to finish"');
    await page.waitForFunction(() => /Kamala/.test(document.querySelector('[data-testid="voice-live"]')?.textContent ?? ''));
    await shot('hold-listening-en');
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('[data-testid="voice-state"]')?.textContent === 'Finishing…');
    await shot('hold-finishing-en');
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await text('[data-testid="amount"]')) === '₹15', 'English hold release delivered ₹15');
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="customer"]').waitFor();

    // ---- real touch input. A finger is one touch point; Chromium then synthesizes pointer events and, on release,
    // a click at the finger's position (now the sheet's scrim): the press must swallow it (press.ts).
    const center = async (id) => {
      const b = await tid(id).boundingBox();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    const touchStart = (pt) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
    const touchEnd = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    console.log('17. touch: hold the home mic with a finger (CDP touch), release -> sheet survives the release, "Finishing…", entry');
    await home();
    await speechOptions({ delayMs: 3000, stopDelayMs: 600 });
    await say(['Kamala 80 paid']);
    const t2 = Date.now();
    await touchStart(await center('mic'));
    await tid('voice-sheet').waitFor();
    check((await text('[data-testid="voice-hint"]')) === 'Release to finish' && !(await tid('voice-done').isVisible()), 'touch hold: "Release to finish", no Stop');
    await page.waitForFunction(() => /Kamala/.test(document.querySelector('[data-testid="voice-live"]')?.textContent ?? ''));
    if (Date.now() - t2 < 700) await page.waitForTimeout(700 - (Date.now() - t2));
    await touchEnd();
    await page.waitForTimeout(300);
    check((await page.locator('[data-testid="voice-sheet"]').count()) === 1 && (await text('[data-testid="voice-state"]')) === 'Finishing…', 'touch hold: 300 ms after the release the sheet is still there, finishing (the synthesized click did not cancel it)');
    await shot('touch-hold-finishing-en');
    await page.locator('.screen[data-route="entry"]').waitFor({ timeout: 5000 });
    check((await text('.topbar .sub')) === 'Kamala' && (await text('[data-testid="amount"]')) === '₹80' && (await pressed('kind-RECEIVE')) === 'true', 'touch hold: release delivered Kamala, Credit ₹80');
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="customer"]').waitFor();
    check((await text('[data-testid="balance"]')) === '₹0' && (await page.locator('.toast').count()) === 0, 'touch hold: nothing saved without a tap on Save');

    console.log('18. touch: a plain finger tap on the mic in hold mode -> tap session stays open, entry');
    await home();
    await speechOptions({ delayMs: 1500, stopDelayMs: 0 });
    await say(['Ravi 60 paid']);
    const c18 = await center('mic');
    await page.touchscreen.tap(c18.x, c18.y);
    await tid('voice-sheet').waitFor();
    await page.waitForTimeout(300);
    check((await page.locator('[data-testid="voice-sheet"]').count()) === 1 && (await text('[data-testid="voice-state"]')) === 'Listening…', 'touch tap: 300 ms later the sheet is still listening');
    check((await tid('voice-done').isVisible()) && (await page.locator('.voice-hint.hold').count()) === 0 && (await text('[data-testid="voice-hint-hold"]')).startsWith('Hold the mic'), 'touch tap: Stop offered, "Say:" hint plus the "hold the mic" tip');
    await shot('touch-tap-listening-en');
    await page.locator('.screen[data-route="entry"]').waitFor({ timeout: 5000 });
    check((await text('.topbar .sub')) === 'Ravi' && (await text('[data-testid="amount"]')) === '₹60', 'touch tap: the session ran to the end by itself, Ravi ₹60');
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="customer"]').waitFor();

    console.log('19. touch in Tap-to-talk mode: a finger tap, and a 700 ms press that must NOT finish on release');
    await home();
    await tid('nav-settings').click();
    await tid('voice-hold-off').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="voice-hold-off"]')?.getAttribute('aria-pressed') === 'true');
    await home();
    await speechOptions({ delayMs: 1500, stopDelayMs: 0 });
    await say(['Kumar 25 paid']);
    const c19 = await center('mic');
    await page.touchscreen.tap(c19.x, c19.y);
    await tid('voice-sheet').waitFor();
    await page.waitForTimeout(300);
    check((await page.locator('[data-testid="voice-sheet"]').count()) === 1 && (await tid('voice-done').isVisible()) && (await tid('voice-hint-hold').count()) === 0, 'tap mode, touch tap: sheet still open with Stop, no hold tip');
    await page.locator('.screen[data-route="entry"]').waitFor({ timeout: 5000 });
    check((await text('.topbar .sub')) === 'Kumar' && (await text('[data-testid="amount"]')) === '₹25', 'tap mode, touch tap: Kumar ₹25');
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="customer"]').waitFor();
    await home();
    await speechOptions({ delayMs: 2000, stopDelayMs: 0 });
    await say(['Ravi 35 paid']);
    await touchStart(await center('mic'));
    await tid('voice-sheet').waitFor();
    await page.waitForTimeout(700);
    await touchEnd();
    await page.waitForTimeout(300);
    check((await page.locator('[data-testid="voice-sheet"]').count()) === 1 && (await text('[data-testid="voice-state"]')) === 'Listening…' && (await tid('voice-done').isVisible()), 'tap mode, 700 ms touch press: release neither finishes nor cancels (still listening, Stop offered)');
    await page.locator('.screen[data-route="entry"]').waitFor({ timeout: 5000 });
    check((await text('.topbar .sub')) === 'Ravi' && (await text('[data-testid="amount"]')) === '₹35', 'tap mode, touch press: the recogniser ended the session itself, Ravi ₹35');
    await page.keyboard.press('Escape');
    await page.locator('.screen[data-route="customer"]').waitFor();
    await home();
    await tid('nav-settings').click();
    await tid('voice-hold-on').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="voice-hold-on"]')?.getAttribute('aria-pressed') === 'true');

    console.log('20. auto-save: a clear entry saves itself after the countdown; Undo, Cancel, Speak turns voice on');
    await tid('voice-auto-on').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="voice-auto-on"]')?.getAttribute('aria-pressed') === 'true');
    await openCustomer('Kumar');
    const kumarBefore = await text('[data-testid="balance"]');
    await home();
    await say(['Kumar 40 kattinaan']);
    await tid('mic').click();
    await tid('qs-card').waitFor({ timeout: 5000 });
    check((await text('[data-testid="qs-amount"]')) === '₹40', 'auto-save card: ₹40');
    check((await text('[data-testid="qs-kind"]')).length > 0, `auto-save card: kind ${await text('[data-testid="qs-kind"]')}`);
    await shot('auto-save-card');
    await page.locator('.screen[data-route="customer"]').waitFor({ timeout: 6000 });
    check((await tid('qs-card').count()) === 0, 'card gone after the countdown');
    const msg = await toast();
    check(msg.includes('Kumar') && msg.includes('₹40'), `saved toast: ${msg}`);
    const kumarAfter = await text('[data-testid="balance"]');
    check(kumarAfter !== kumarBefore, `Kumar balance changed ${kumarBefore} -> ${kumarAfter}`);
    await shot('auto-saved', { keepToast: true });
    await page.locator('.toast button').first().click();
    await page.waitForFunction((b) => document.querySelector('[data-testid="balance"]')?.textContent?.trim() === b, kumarBefore, { timeout: 5000 });
    check(true, `Undo restored Kumar to ${kumarBefore}`);
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

    await home();
    await say(['Kumar 45 kattinaan']);
    await tid('mic').click();
    await tid('qs-card').waitFor({ timeout: 5000 });
    await tid('qs-cancel').click();
    await page.waitForTimeout(3800);
    check((await page.locator('.screen[data-route="home"]').count()) === 1 && (await tid('qs-card').count()) === 0, 'Cancel: card closed, still on Home');
    await openCustomer('Kumar');
    check((await text('[data-testid="balance"]')) === kumarBefore, 'Cancel saved nothing');

    await home();
    await say(['Kumar 47 kattinaan']);
    await tid('mic').click();
    await tid('qs-card').waitFor({ timeout: 5000 });
    await tid('qs-edit').click();
    await page.locator('.screen[data-route="entry"]').waitFor({ timeout: 5000 });
    check((await text('[data-testid="amount"]')) === '₹47', 'Edit: prefilled keypad with ₹47');
    await page.keyboard.press('Escape');
    await home();

    for (const [phrase, kind] of [['Ravi 33 kadan sollirukkan', 'Debit'], ['Ravi 34 varavu vachirukkan', 'Credit'], ['Ravi 36 kadan vachurikkan', 'Debit']]) {
      await say([phrase]);
      await tid('mic').click();
      await tid('qs-card').waitFor({ timeout: 5000 });
      check((await text('[data-testid="qs-kind"]')) === kind, `slang "${phrase}": auto-save card says ${kind}`);
      if (phrase.includes('sollirukkan')) await shot('auto-save-slang');
      await tid('qs-cancel').click();
      await tid('qs-card').waitFor({ state: 'detached' });
    }

    await tid('nav-settings').click();
    await tid('voice-off').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="voice-off"]')?.getAttribute('aria-pressed') === 'true');
    await home();
    await say(['Ravi 23 kattinaan']);
    await tid('mic').click();
    await tid('qs-card').waitFor({ timeout: 5000 });
    check(true, 'Speak with voice off: switched voice on and listened');
    await tid('qs-cancel').click();
    await tid('nav-settings').click();
    check((await tid('voice-on').getAttribute('aria-pressed')) === 'true', 'Settings shows voice On again');
    await home();

    console.log('21. a different, similar name is a new customer; a picked near name is learned');
    // The book has Ramu (two), Kamala, Kumar, Ravi, Suresh: "Rahul" is nobody's name (Ramu scores 0.6).
    await home();
    await say(['Rahul 500 kattinaan']);
    await tid('mic').click();
    await tid('voice-new').waitFor({ timeout: 5000 });
    const newText = await text('[data-testid="voice-new"]');
    check(newText.includes('Rahul') && (await tid('voice-pick-new').count()) === 1, `"Rahul": add-new sheet (${newText.replace(/\s+/g, ' ').slice(0, 80)})`);
    check((await page.locator('[data-testid="voice-new"] [data-testid="voice-pick"]', { hasText: 'Ramu' }).count()) >= 1, 'Ramu offered under "Or did you mean"');
    await shot('new-or-did-you-mean');
    await tid('voice-pick-new').click();
    await page.locator('.screen[data-route="customer-edit"]').waitFor();
    check((await tid('cust-name').inputValue()) === 'Rahul', 'customer form prefilled "Rahul"');
    await tid('cust-save').click();
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await text('.topbar .sub')) === 'Rahul' && (await text('[data-testid="amount"]')) === '₹500', 'new customer Rahul, keypad ₹500');
    await saveEntry();
    await page.locator('.screen[data-route="customer"]').waitFor();

    await home();
    await say(['Raghu 30 kattinaan']);
    await tid('mic').click();
    await tid('voice-picker').waitFor({ timeout: 5000 });
    check((await tid('voice-pick-new').count()) === 1, '"Raghu" (near Rahul): picker also offers Add new');
    await page.locator('[data-testid="voice-picker"] [data-testid="voice-pick"]', { hasText: 'Rahul' }).click();
    await page.locator('.screen[data-route="entry"]').waitFor();
    check((await text('.topbar .sub')) === 'Rahul', 'picked Rahul for "Raghu"');
    await page.keyboard.press('Escape');
    await home();
    await say(['Raghu 31 kattinaan']);
    await tid('mic').click();
    await tid('qs-card').waitFor({ timeout: 5000 });
    check((await text('[data-testid="qs-card"]')).includes('Rahul'), 'next time "Raghu" is Rahul straight away (auto-save card)');
    await tid('qs-cancel').click();
    await tid('nav-settings').click();
    await scrollToVoice('[data-testid="voice-aliases"]');
    check((await text('[data-testid="voice-aliases"]')).includes('Raghu'), 'Settings lists the learned name');
    await shot('learned-names');
    await tid('voice-alias-forget').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="voice-aliases"]')?.textContent?.includes('Raghu'));
    check(true, 'Forget learned names clears it');
    await home();

    check(consoleErrors.length === 0, `no console errors ${consoleErrors.join(' | ')}`);
  } catch (e) {
    console.error(e);
    failures = Math.max(failures, 1);
    try {
      await page.screenshot({ path: join(SHOTS, `voice-${String(++shotNo).padStart(2, '0')}-FAILED.png`) });
    } catch {
      /* ignore */
    }
  } finally {
    await browser.close();
    server.stop();
  }
  console.log(failures ? `FAILED (${failures})` : 'ALL VOICE FLOWS PASSED');
  process.exit(failures ? 1 : 0);
}

main();
