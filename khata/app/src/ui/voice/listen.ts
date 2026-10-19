/**
 * The voice entry flow: mic press -> listening sheet (live transcript, Cancel / Stop) -> parseUtterance() ->
 * one step per spoken entry: the customer's keypad prefilled (entry.ts shows the "Heard" banner), a picker when
 * several customers fit, "Add new customer?" when nobody does, a balance answer for "Ramu baaki evvalavu".
 * Several entries in one sentence run as a queue ("1 of 2"): the next one opens after Save (or after backing out).
 * Nothing is ever written here: only the entry screen's Save button saves, after the shopkeeper looked at it.
 *
 * Hold-to-talk (Settings → Voice, default on): the mic buttons (mic-button.ts, press.ts) call startVoice() on
 * pointerdown with `held: true` and releaseVoice() when the finger leaves after HOLD_MIN_MS: the session is stopped
 * at once (the adapter resolves with what was heard so far) and the sheet shows "Finishing…". While the mic is
 * held the sheet offers no Stop button (the release is the end; Cancel stays) and the recogniser is told so
 * (listen({ held }), so a pause mid-sentence does not end the session). A shorter press is a tap (voiceTapped()):
 * Stop comes back and listening goes on until Stop, the adapter's settle time or the cap.
 */
import { formatCode } from '../../core/ledger';
import { parseUtterance, type CustomerMatch, type VoiceIntent } from '../../core/voice';
import type { HomeRow } from '../../data/types';
import { getLang, t, type MsgKey } from '../../i18n';
import { SPEECH_PRIVACY_NOTE } from '../../platform/index';
import { app } from '../app';
import { button, clear as clearChildren, h } from '../components/dom';
import { alertDialog, dialog, pushLayer, toast } from '../components/overlay';
import { money, toneClass } from '../format';
import * as router from '../router';
import { signedBal } from '../screens/customer';
import { micIcon } from './icons';
import { planIntent, speechErrorKey, toVoiceCustomers } from './plan';
import { prefillFromIntent, type VoicePrefill } from './prefill';
import { bindPress } from './press';
import { bumpVoiceStats, loadVoicePrefs, saveVoicePrefs, voicePrefs } from './prefs';

export interface VoiceStartOptions {
  /** On a customer's page: a missing or matching name means this customer (finding 9). */
  contextCustomerId?: string;
  /** From the quick-entry list: the keypad opens in quick mode and returns there after Save. */
  quick?: boolean;
}

/** The UI's own cap on one listening session; the platform's safety cap (15 s) is longer. */
const LISTEN_MS = 12_000;
/** Background taps on the listening sheet are ignored this long after it opens (see openListening). */
const SCRIM_GRACE_MS = 600;

let running = false;
/** The live recogniser session (from listen() until it settles), so a release can end it. */
let live: { ctl: ListenCtl; stop: () => void; released: boolean } | null = null;
/** True while the shopkeeper holds a mic (hold-to-talk): the sheet hints "Release to finish". */
let held = false;

export interface VoicePressOptions {
  /** The mic is being held (hold-to-talk): releaseVoice() or voiceTapped() follows. */
  held?: boolean;
}

/** Mic press. Resolves when the flow has handed over to a screen or was cancelled; never throws. */
export async function startVoice(opts: VoiceStartOptions = {}, press: VoicePressOptions = {}): Promise<void> {
  if (running) return;
  running = true;
  held = !!press.held;
  try {
    await run(opts);
  } catch (e) {
    console.error('[voice] flow failed', e);
    toast(t('voice.error', { code: String((e as Error)?.message ?? e) }), { error: true });
  } finally {
    running = false;
    held = false;
  }
}

/**
 * Hold-to-talk: the finger left the mic after holding. Ends the live session now (listen() resolves with what was
 * heard so far) and shows "Finishing…"; nothing to do when no session is live yet (still in the preflight) or
 * the session already ended.
 */
export function releaseVoice(): void {
  held = false;
  const s = live;
  if (!s || s.released) return;
  s.released = true;
  s.ctl.finishing();
  s.stop();
}

/** A short press: it was a tap, not a hold. The sheet shows the tap hints (Stop ends the session). */
export function voiceTapped(): void {
  held = false;
  if (!live) return;
  live.ctl.setHeld(false);
  app.platform.speech.setHeld?.(false);
}

/** Tests only. */
export function _voiceLive(): boolean {
  return live !== null;
}

/**
 * Everything that must be true before the recogniser starts, for the mic buttons and for the Settings tester alike:
 * recogniser present, internet (Google speech is online-only), the privacy notice accepted once, mic permission.
 * Shows the reason as a toast or the notice dialog; resolves false when listening must not start.
 */
export async function voicePreflight(): Promise<boolean> {
  const speech = app.platform.speech;
  if (!(await speech.available())) {
    toast(t('voice.unavailable'), { error: true, ms: 5000 });
    return false;
  }
  if (!(await app.platform.isOnline())) {
    toast(t('voice.offline'), { error: true, ms: 5000 });
    return false;
  }
  if (!(await loadVoicePrefs()).notice_ok) {
    const ok = await dialog<boolean>({
      title: t('voice.noticeTitle'),
      body: h('p', { class: 'pre', attrs: { 'data-testid': 'voice-notice' }, text: SPEECH_PRIVACY_NOTE[getLang()] }),
      buttons: [
        { label: t('common.cancel'), value: false },
        { label: t('voice.noticeOk'), value: true, kind: 'primary' },
      ],
      dismissValue: false,
    });
    if (!ok) return false;
    await saveVoicePrefs({ notice_ok: true });
  }
  if (!(await speech.ensurePermission())) {
    toast(t('voice.denied'), { error: true, ms: 6000 });
    return false;
  }
  return true;
}

async function run(opts: VoiceStartOptions): Promise<void> {
  const prefs = await loadVoicePrefs();
  if (!prefs.on) return;
  const speech = app.platform.speech;
  if (!(await voicePreflight())) return;

  const rows = await app.repo.listHome();
  const customers = toVoiceCustomers(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const names = Array.from(new Set(customers.map((c) => c.name))).slice(0, 200);

  let cancelled = false;
  const ctl = openListening({
    onCancel: () => {
      cancelled = true;
      ctl.close();
      void speech.stop();
    },
    onStop: () => void speech.stop(),
  });

  for (let attempt = 0; ; attempt++) {
    let alts: string[];
    ctl.listening(held);
    // The first start was already felt at the press (mic-button.ts); a retry has no press of its own.
    if (attempt > 0) void app.platform.hapticTap();
    const session = { ctl, stop: () => void speech.stop(), released: false };
    live = session;
    try {
      alts = await speech.listen({ lang: prefs.lang, onPartial: (text) => ctl.setLive(text), maxAlternatives: 5, biasPhrases: names, maxMs: LISTEN_MS, held });
    } catch (e) {
      if (live === session) live = null;
      if (cancelled) return;
      const key = speechErrorKey(String((e as Error)?.message ?? e));
      const retry = key !== 'unavailable' && key !== 'denied';
      if (!(await ctl.fail(t(`voice.${key}` as MsgKey), retry))) return;
      continue;
    }
    if (live === session) live = null;
    if (cancelled) return;
    if (!alts.length) {
      if (!(await ctl.fail(t('voice.nothing'), true))) return;
      continue;
    }
    ctl.thinking(alts[0]);
    void bumpVoiceStats({ heard: 1 });
    const intents = parseUtterance(alts, customers, { bareKuduthaachu: prefs.bare }, opts.contextCustomerId ? { contextCustomerId: opts.contextCustomerId } : {});
    if (!intents.length) {
      if (!(await ctl.fail(t('voice.notUnderstood', { text: alts[0] }), true))) return;
      continue;
    }
    ctl.close();
    await runQueue(intents, byId, opts);
    return;
  }
}

// ------------------------------------------------------------------ listening sheet

interface ListenCtl {
  setLive(text: string): void;
  /** Back to "Listening…"; `held` = the mic is being held: the hint reads "Release to finish" and there is no Stop. */
  listening(held: boolean): void;
  /** The mic was released (hold-to-talk): "Finishing…", no Stop button, until the result arrives. */
  finishing(): void;
  /** The hold hint and the missing Stop button while listening (a short press turned out to be a tap). */
  setHeld(held: boolean): void;
  thinking(text: string): void;
  /** Show a failure under the mic. Resolves true when the shopkeeper taps "Try again", false on Cancel. */
  fail(message: string, retry: boolean): Promise<boolean>;
  close(): void;
}

function openListening(o: { onCancel: () => void; onStop: () => void }): ListenCtl {
  let retryResolve: ((again: boolean) => void) | null = null;
  let phase: 'listening' | 'finishing' | 'thinking' | 'failed' = 'listening';
  const state = h('div', { class: 'voice-state', attrs: { 'data-testid': 'voice-state' } });
  const mic = h('button', { class: 'voice-mic', attrs: { type: 'button', 'aria-label': t('voice.stop'), 'data-testid': 'voice-mic' } }, micIcon());
  const liveEl = h('div', { class: 'voice-live placeholder', attrs: { 'data-testid': 'voice-live' } });
  const hint = h('div', { class: 'voice-hint', attrs: { 'data-testid': 'voice-hint' } });
  /** `tip`: a tap session in hold mode also says that holding the mic is an option (nothing else on screen does). */
  const setHint = (isHeld: boolean, tip = false): void => {
    clearChildren(hint);
    hint.classList.remove('hidden');
    hint.classList.toggle('hold', isHeld);
    if (isHeld) hint.append(t('voice.hintRelease'));
    else hint.append(t('voice.hintSay'), ' ', h('b', { text: t('voice.hintExample') }), h('br'), t('voice.hintSub'));
    if (!isHeld && tip) hint.append(h('br'), h('span', { class: 'voice-hint-tip', attrs: { 'data-testid': 'voice-hint-hold' }, text: t('voice.hintHold') }));
  };
  setHint(false);
  const msg = h('div', { class: 'voice-msg hidden', attrs: { 'data-testid': 'voice-msg' } });
  // The big mic: while listening a tap is Stop and a hold ends on release (hold mode); after a failure a press is
  // "Try again" (hold it to speak and release to finish, or tap and speak until Stop).
  let pressWasRetry = false;
  bindPress(mic, {
    holdMode: () => voicePrefs().hold,
    onDown: () => {
      pressWasRetry = retryResolve !== null;
      if (pressWasRetry) {
        held = voicePrefs().hold;
        void app.platform.hapticTap();
        retryResolve?.(true);
      }
    },
    onUp: (kind) => {
      if (kind === 'hold') {
        if (live) releaseVoice();
        else held = false;
        return;
      }
      if (pressWasRetry) voiceTapped();
      else if (phase === 'listening') o.onStop();
    },
  });
  const cancelBtn = button(t('common.cancel'), () => (retryResolve ? retryResolve(false) : o.onCancel()), 'btn', { 'data-testid': 'voice-cancel' });
  const doneBtn = button(t('voice.stop'), () => (retryResolve ? retryResolve(true) : o.onStop()), 'btn btn-primary', { 'data-testid': 'voice-done' });
  const panel = h(
    'div',
    { class: 'voice-panel', attrs: { role: 'dialog', 'aria-modal': 'true', 'data-testid': 'voice-sheet' } },
    state, mic, liveEl, hint, msg, h('div', 'voice-actions', cancelBtn, doneBtn),
  );
  // Defence in depth for hold-to-talk on touch screens: the click a phone synthesizes when the finger lifts lands
  // where the sheet now is; a background tap only cancels once the sheet has been open for SCRIM_GRACE_MS.
  const openedAt = Date.now();
  const scrim = h('div', { class: 'scrim scrim-sheet voice-scrim', on: { click: (e) => { if (e.target === scrim && Date.now() - openedAt >= SCRIM_GRACE_MS) cancelBtn.click(); } } }, panel);
  let closed = false;
  const remove = pushLayer(scrim, () => cancelBtn.click());
  const setLive = (text: string): void => {
    liveEl.textContent = text || t('voice.listening');
    liveEl.classList.toggle('placeholder', !text);
  };
  return {
    setLive,
    listening(isHeld) {
      retryResolve = null;
      phase = 'listening';
      state.textContent = t('voice.listening');
      mic.className = 'voice-mic listening';
      setLive('');
      setHint(isHeld, !isHeld && voicePrefs().hold);
      msg.classList.add('hidden');
      doneBtn.textContent = t('voice.stop');
      doneBtn.disabled = false;
      // Held: releasing is the one way to finish; a Stop button beside it would be a second instruction.
      doneBtn.classList.toggle('hidden', isHeld);
    },
    finishing() {
      if (phase !== 'listening') return;
      phase = 'finishing';
      state.textContent = t('voice.finishing');
      mic.className = 'voice-mic finishing';
      // Nothing more can be said: no "Say: ..." example under a session that is ending.
      hint.classList.add('hidden');
      doneBtn.classList.add('hidden');
    },
    setHeld(isHeld) {
      if (phase !== 'listening') return;
      setHint(isHeld, !isHeld && voicePrefs().hold);
      doneBtn.classList.toggle('hidden', isHeld);
    },
    thinking(text) {
      retryResolve = null;
      phase = 'thinking';
      state.textContent = t('voice.thinking');
      mic.className = 'voice-mic thinking';
      setLive(text);
      setHint(false);
      doneBtn.disabled = true;
      doneBtn.classList.remove('hidden');
    },
    fail(message, retry) {
      phase = 'failed';
      state.textContent = t('voice.failed');
      mic.className = 'voice-mic failed';
      // The live line must not keep saying "Listening…" under a red mic: the message below carries what was heard.
      liveEl.textContent = '—';
      liveEl.classList.add('placeholder');
      setHint(false);
      msg.textContent = message;
      msg.classList.remove('hidden');
      doneBtn.textContent = t('voice.tryAgain');
      doneBtn.disabled = false;
      doneBtn.classList.toggle('hidden', !retry);
      return new Promise<boolean>((resolve) => {
        retryResolve = (again) => {
          retryResolve = null;
          if (!again) this.close();
          resolve(again);
        };
      });
    },
    close() {
      if (closed) return;
      closed = true;
      remove();
    },
  };
}

// ------------------------------------------------------------------ the steps after parsing

async function runQueue(intents: VoiceIntent[], byId: Map<string, HomeRow>, opts: VoiceStartOptions): Promise<void> {
  /** Customer page this run pushed under the keypad (replaced, not stacked, for the next entry of the queue). */
  let pushed: string | null = null;

  const openEntry = async (customerId: string, prefill: VoicePrefill): Promise<void> => {
    const params: Record<string, string> = { id: customerId };
    if (prefill.kind) params.kind = prefill.kind;
    if (opts.quick) params.quick = '1';
    else {
      // Save lands on the customer's page, like a typed entry: put that page under the keypad first.
      const cur = router.current();
      if (!(cur?.name === 'customer' && cur.params.id === customerId)) {
        if (cur?.name === 'customer' && pushed && cur.params.id === pushed) await router.replace('customer', { id: customerId });
        else await router.go('customer', { id: customerId });
        pushed = customerId;
      }
    }
    await router.go('entry', params, { voice: prefill });
  };

  const step = async (i: number): Promise<void> => {
    const intent = intents[i];
    const plan = planIntent(intent, opts.contextCustomerId ? { contextCustomerId: opts.contextCustomerId } : {});
    const prefill = prefillFromIntent(intent, { index: i + 1, total: intents.length });
    if (i + 1 < intents.length) prefill.next = () => void step(i + 1);
    const newName = intent.name_text && !intent.matches.length ? intent.name_text : null;
    switch (plan.type) {
      case 'entry':
        await openEntry(plan.customerId, prefill);
        return;
      case 'pick': {
        const id = await pickCustomer({ heard: intent.heard, candidates: plan.candidates, byId, newName });
        if (id === null) return;
        if (id === 'new') await addNew(newName ?? intent.name_text ?? '', prefill);
        else await openEntry(id, prefill);
        return;
      }
      case 'new': {
        const ok = await dialog<boolean>({
          title: t('voice.addNewTitle'),
          body: h('div', null, h('p', { class: 'muted', text: t('voice.heard', { text: intent.heard }) }), h('p', { text: t('voice.addNewBody', { name: plan.name }) })),
          buttons: [
            { label: t('common.cancel'), value: false },
            { label: t('voice.addNew', { name: plan.name }), value: true, kind: 'primary' },
          ],
          dismissValue: false,
        });
        if (ok) await addNew(plan.name, prefill);
        return;
      }
      case 'balance': {
        let id = plan.customerId;
        if (!id) {
          if (!plan.candidates.length) {
            toast(t('voice.notUnderstood', { text: intent.heard }), { error: true });
            return;
          }
          const picked = await pickCustomer({ heard: intent.heard, candidates: plan.candidates, byId, newName: null });
          if (picked === null || picked === 'new') return;
          id = picked;
        }
        const row = byId.get(id);
        const bal = row ? row.balance_paise : await app.repo.balance(id);
        await alertDialog(row?.name ?? t('voice.balanceTitle'), h('p', { class: 'amount-confirm', attrs: { 'data-testid': 'voice-balance' }, text: signedBal(bal) }));
        prefill.next?.();
        return;
      }
      case 'noname':
        toast(t('voice.noName'), { error: true, ms: 5000 });
        return;
      case 'unclear':
        toast(t('voice.notUnderstood', { text: intent.heard }), { error: true, ms: 5000 });
        return;
    }
  };

  const addNew = async (name: string, prefill: VoicePrefill): Promise<void> => {
    const params: Record<string, string> = { name };
    if (opts.quick) params.quick = '1';
    await router.go('customer-edit', params, { voice: prefill });
  };

  await step(0);
}

/** Bottom sheet: which customer did you mean? Resolves an id, 'new' (add "<name>") or null (cancel). */
function pickCustomer(o: { heard: string; candidates: CustomerMatch[]; byId: Map<string, HomeRow>; newName: string | null }): Promise<string | 'new' | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | 'new' | null): void => {
      if (done) return;
      done = true;
      remove();
      resolve(v);
    };
    const items: HTMLElement[] = [];
    for (const m of o.candidates) {
      const r = o.byId.get(m.id);
      if (!r) continue;
      const bits = [formatCode(r.code)];
      if (r.note) bits.push(r.note);
      else if (r.phone) bits.push(`•• ${r.phone.replace(/\D/g, '').slice(-4)}`);
      items.push(
        h(
          'button',
          { class: 'sheet-item', attrs: { type: 'button', 'data-testid': 'voice-pick', 'data-id': r.id }, on: { click: () => finish(r.id) } },
          h(
            'span',
            'voice-pick-row',
            h('span', 'voice-pick-main', h('span', { class: 'sheet-label', text: r.name }), h('span', { class: 'sub', text: bits.join(' · ') })),
            h('span', { class: `voice-pick-bal amt ${toneClass(r.balance_paise)}`, text: r.balance_paise === 0 ? money(0) : signedBal(r.balance_paise) }),
          ),
        ),
      );
    }
    if (o.newName) {
      items.push(h('button', { class: 'sheet-item', attrs: { type: 'button', 'data-testid': 'voice-pick-new' }, on: { click: () => finish('new') } }, h('span', { class: 'sheet-label', text: t('voice.addNew', { name: o.newName }) })));
    }
    const sheet = h(
      'div',
      { class: 'sheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'data-testid': 'voice-picker' } },
      h('div', 'sheet-grip'),
      h('div', { class: 'sheet-title', text: t('voice.pickTitle') }),
      h('div', { class: 'sheet-subtitle', text: t('voice.heard', { text: o.heard }) }),
      items,
      h('button', { class: 'sheet-item sheet-cancel', attrs: { type: 'button' }, on: { click: () => finish(null) } }, t('common.cancel')),
    );
    const scrim = h('div', { class: 'scrim scrim-sheet', on: { click: (e) => { if (e.target === scrim) finish(null); } } }, sheet);
    const remove = pushLayer(scrim, () => finish(null));
  });
}
