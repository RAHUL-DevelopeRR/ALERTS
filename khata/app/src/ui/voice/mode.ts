/**
 * Voice mode: the counter's always-listening mode (the "Voice mode" screen, screens/voice-mode.ts).
 *
 *   listening ──(a sentence that looks like an entry)──> approval card ──Approve / Skip / Edit──> listening …
 *
 * One recogniser session after another (each ends on silence, on a complete sentence, or at MODE_LISTEN_MS),
 * until Stop. Every heard sentence goes through parseUtterance(); mode-logic.ts decides what becomes a card and
 * what is counter talk to ignore. While a card waits for the shopkeeper the microphone is OFF (nothing queues up
 * behind it, nothing is streamed); after Approve or Skip the next session starts at once. Nothing is written
 * without Approve (or Save on the keypad after Edit).
 *
 * Pauses: Pause button; the app going to the background (Android cuts the mic; resumes when back, after the PIN
 * if it locked); Edit (the keypad is open); N minutes without an entry (Settings, default 15); a recogniser that
 * keeps failing or has no permission. Saying "pause" is deliberately not a command: in a noisy shop it would
 * misfire both ways.
 *
 * State lives here (a module singleton), not in the screen, so the keypad can open over it (Edit) and the
 * session, its log and its card survive the round trip. The screen subscribes and renders.
 */
import { addDays } from '../../core/ledger';
import { ENTRY_BIAS_PHRASES, parseUtterance, type VoiceCustomer, type VoiceIntent } from '../../core/voice';
import type { HomeRow } from '../../data/types';
import { afterWrite, app, refreshSettings } from '../app';
import { today } from '../format';
import { gateOpen } from '../gate';
import * as router from '../router';
import { learnAlias, loadAliases } from './aliases';
import {
  EARLY_STOP_MS, MAX_ERRORS, MIN_GAP_MS, MODE_LISTEN_MS, QUICK_EMPTY_MS, StableSignature, cardWho, entrySignature,
  errorPolicy, idleExpired, modeAction, restartDelay, sessionTotals, type CardWho, type IgnoreWhy, type SessionLine,
} from './mode-logic';
import { offerNew, toVoiceCustomers } from './plan';
import { prefillFromIntent, type VoicePrefill, type VoiceSaved } from './prefill';
import { bumpVoiceStats, loadVoicePrefs, type VoicePrefs } from './prefs';

export type PauseReason = 'user' | 'idle' | 'background' | 'editing' | 'failed';

export interface ModeCard {
  id: number;
  intent: VoiceIntent;
  who: CardWho;
  /** null until Debit or Credit is tapped (the sentence did not say). */
  kind: 'GIVE' | 'RECEIVE' | null;
  amount_paise: number;
  /** Other amounts the recogniser's alternatives heard (paise), offered as chips. */
  alternatives: number[];
  /** Saving (Approve tapped, the confirm dialogs or the write still running). */
  busy: boolean;
}

export interface ModeLogItem extends SessionLine {
  entryId: string;
  customerId: string;
  name: string;
  balance_paise: number;
  at: number;
}

/** The status line under the microphone: what just happened. */
export type ModeNote =
  | { type: 'ignored'; why: IgnoreWhy; heard: string; name: string | null; amount_paise: number | null }
  | { type: 'saved'; name: string; kind: 'GIVE' | 'RECEIVE'; amount_paise: number; balance_paise: number }
  | { type: 'undone'; name: string; balance_paise: number }
  | { type: 'balance'; name: string; balance_paise: number }
  | { type: 'error'; text: string };

export interface ModeState {
  active: boolean;
  /** Derived: a card waits, or paused, or listening (active), or off. */
  phase: 'off' | 'listening' | 'card' | 'paused';
  pause: PauseReason | null;
  /** Why it paused for good ('failed'): 'unavailable' | 'denied' | 'offline' | 'busy' | 'error'. */
  failKey: string | null;
  /** A retry is pending after a recogniser error. */
  retrying: 'offline' | 'busy' | 'error' | null;
  /** Live transcript of the current session. */
  live: string;
  note: ModeNote | null;
  card: ModeCard | null;
  /** More entries from the same sentence, shown one after another. */
  queued: number;
  /** Entries approved in this session, newest first. */
  log: ModeLogItem[];
  /** Pause after this many minutes without an entry (0 = never). */
  idleMin: number;
}

/** What the screen's Approve handler is asked to confirm (the same questions the keypad asks). */
export type ApproveCheck =
  | { type: 'big'; amount_paise: number; kind: 'GIVE' | 'RECEIVE' }
  | { type: 'advance'; due_paise: number; amount_paise: number }
  | { type: 'dup'; amount_paise: number };

const OFF: ModeState = {
  active: false, phase: 'off', pause: null, failKey: null, retrying: null, live: '', note: null, card: null, queued: 0, log: [], idleMin: 15,
};

let state: ModeState = OFF;
const subs = new Set<(s: ModeState) => void>();
let prefs: VoicePrefs | null = null;
let rows: HomeRow[] = [];
let customers: VoiceCustomer[] = [];
let queue: VoiceIntent[] = [];
/** Bumped to drop the result of a session that was paused / stopped meanwhile. */
let cycle = 0;
let cardSeq = 0;
let lastActivity = 0;
let errorStreak = 0;
let quickEmptyStreak = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let earlyTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setInterval> | null = null;
let resumeTimer: ReturnType<typeof setInterval> | null = null;
let appStateOff: (() => void) | null = null;
let remoteOff: (() => void) | null = null;
/** A Pause the shopkeeper set before Edit is put back when the keypad returns. */
let pauseBeforeEdit: PauseReason | null = null;

function derive(s: ModeState): ModeState {
  const phase = !s.active ? 'off' : s.card ? 'card' : s.pause ? 'paused' : 'listening';
  return { ...s, phase, queued: queue.length };
}

function set(patch: Partial<ModeState>): void {
  state = derive({ ...state, ...patch });
  for (const f of subs) {
    try {
      f(state);
    } catch (e) {
      console.error('[voice-mode] subscriber failed', e);
    }
  }
}

export function modeState(): ModeState {
  return state;
}

export function subscribeMode(fn: (s: ModeState) => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** Test hook: e2e sets window.__KK_VM_IDLE_MS__ to see the idle pause without waiting 15 minutes. */
function idleMinutes(): number {
  const ms = (globalThis as { __KK_VM_IDLE_MS__?: unknown }).__KK_VM_IDLE_MS__;
  if (typeof ms === 'number' && ms > 0) return ms / 60_000;
  return state.idleMin;
}

function clearTimers(): void {
  if (restartTimer) clearTimeout(restartTimer);
  if (earlyTimer) clearTimeout(earlyTimer);
  if (resumeTimer) clearInterval(resumeTimer);
  restartTimer = earlyTimer = resumeTimer = null;
}

// ------------------------------------------------------------------ start / stop / pause

/** Start listening (the screen ran the preflight and the notice). No-op when already on. */
export async function startMode(): Promise<void> {
  if (state.active) return;
  prefs = await loadVoicePrefs();
  queue = [];
  errorStreak = 0;
  quickEmptyStreak = 0;
  lastActivity = Date.now();
  state = derive({ ...OFF, active: true, idleMin: prefs.mode_idle });
  set({});
  void app.platform.keepAwake?.(true);
  appStateOff = app.platform.onAppStateChange((on) => (on ? onForeground() : pauseMode('background')));
  // Another counter's entries arrived (fast sync): new balances on the waiting card and for the next sentence.
  remoteOff = app.sync.onRemoteChange(() => {
    void refreshCustomers().then(() => {
      if (state.active) set({ card: state.card ? { ...state.card } : null });
    });
  });
  idleTimer = setInterval(checkIdle, 5000);
  listenNext(0);
}

/** End voice mode; returns what was approved in this session. */
export function stopMode(): { n: number; gave: number; got: number } {
  const totals = sessionTotals(state.log);
  if (!state.active) return totals;
  cycle++;
  clearTimers();
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
  appStateOff?.();
  appStateOff = null;
  remoteOff?.();
  remoteOff = null;
  queue = [];
  void app.platform.speech.stop();
  void app.platform.keepAwake?.(false);
  set({ active: false, card: null, pause: null, live: '', retrying: null });
  return totals;
}

/** Stop listening but keep the session (log, card). A later reason never overrides Pause / idle / editing. */
export function pauseMode(reason: PauseReason): void {
  if (!state.active) return;
  if (state.pause && reason === 'background') return;
  cycle++;
  clearTimers();
  void app.platform.speech.stop();
  // Paused at the counter (Pause, idle, a failure): the screen may sleep again; Resume keeps it on once more.
  if (reason === 'user' || reason === 'idle' || reason === 'failed') void app.platform.keepAwake?.(false);
  set({ pause: reason, live: '', retrying: null, ...(reason !== 'failed' ? { failKey: null } : {}) });
}

export function resumeMode(): void {
  if (!state.active) return;
  errorStreak = 0;
  quickEmptyStreak = 0;
  lastActivity = Date.now();
  void app.platform.keepAwake?.(true);
  set({ pause: null, failKey: null, retrying: null, note: state.note?.type === 'error' ? null : state.note });
  if (!state.card) listenNext(0);
}

/** Back from the background: resume once the PIN gate (if it locked) is gone and the screen is showing again. */
function onForeground(): void {
  if (!state.active || state.pause !== 'background') return;
  if (resumeTimer) clearInterval(resumeTimer);
  const tryResume = (): boolean => {
    if (!state.active || state.pause !== 'background') return true;
    if (gateOpen() || router.current()?.name !== 'voice-mode') return false;
    resumeMode();
    return true;
  };
  if (tryResume()) return;
  resumeTimer = setInterval(() => {
    if (tryResume() && resumeTimer) {
      clearInterval(resumeTimer);
      resumeTimer = null;
    }
  }, 400);
}

function checkIdle(): void {
  if (!state.active || state.pause || state.card) return;
  if (idleExpired(lastActivity, Date.now(), idleMinutes())) pauseMode('idle');
}

// ------------------------------------------------------------------ the listening loop

function listenNext(delayMs: number): void {
  if (restartTimer) clearTimeout(restartTimer);
  const my = ++cycle;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void listenOnce(my);
  }, delayMs);
}

async function refreshCustomers(): Promise<void> {
  try {
    rows = await app.repo.listHome();
    customers = toVoiceCustomers(rows, await loadAliases());
  } catch (e) {
    console.warn('[voice-mode] customer list failed', e);
  }
}

async function listenOnce(my: number): Promise<void> {
  if (my !== cycle || !state.active || state.pause || state.card) return;
  await refreshCustomers();
  if (my !== cycle || !state.active || state.pause || state.card) return;
  const p = prefs ?? (await loadVoicePrefs());
  const entryWords = p.lang.startsWith('ta') ? ENTRY_BIAS_PHRASES.ta : ENTRY_BIAS_PHRASES.en;
  const names = [...Array.from(new Set(customers.map((c) => c.name))).slice(0, 200 - entryWords.length), ...entryWords];
  const stable = new StableSignature(EARLY_STOP_MS);
  const speech = app.platform.speech;
  const startedAt = Date.now();
  set({ live: '' });
  let alts: string[];
  try {
    alts = await speech.listen({
      lang: p.lang,
      maxAlternatives: 5,
      biasPhrases: names,
      maxMs: MODE_LISTEN_MS,
      quietStart: p.mode_quiet,
      onPartial: (text) => {
        if (my !== cycle) return;
        set({ live: text });
        // A complete entry ("Ramu 500 kudukkanum") that stays the same for EARLY_STOP_MS ends the session now,
        // even if the shop keeps talking after it.
        const at = stable.update(entrySignature(parseUtterance([text], customers, { bareKuduthaachu: p.bare })), Date.now());
        if (earlyTimer) clearTimeout(earlyTimer);
        earlyTimer = null;
        if (at === null) return;
        earlyTimer = setTimeout(() => {
          earlyTimer = null;
          if (my === cycle && stable.isStable(Date.now())) void speech.stop();
        }, Math.max(0, at - Date.now()));
      },
    });
  } catch (e) {
    if (earlyTimer) clearTimeout(earlyTimer);
    earlyTimer = null;
    if (my !== cycle || !state.active) return;
    onListenError(e);
    return;
  }
  if (earlyTimer) clearTimeout(earlyTimer);
  earlyTimer = null;
  if (my !== cycle || !state.active || state.pause) return;
  errorStreak = 0;
  if (!alts.length) {
    quickEmptyStreak = Date.now() - startedAt < QUICK_EMPTY_MS ? quickEmptyStreak + 1 : 0;
    set({ retrying: null });
    listenNext(restartDelay(quickEmptyStreak));
    return;
  }
  quickEmptyStreak = 0;
  heard(alts, p);
}

function onListenError(e: unknown): void {
  errorStreak++;
  const message = String((e as Error)?.message ?? e);
  const pol = errorPolicy(message, errorStreak);
  if (pol.action === 'stop') {
    pauseMode('failed');
    set({ failKey: pol.key });
    return;
  }
  if (pol.key !== 'offline' && errorStreak >= MAX_ERRORS) {
    pauseMode('failed');
    set({ failKey: pol.key });
    return;
  }
  set({ retrying: pol.key, live: '' });
  listenNext(pol.delayMs);
}

function heard(alts: string[], p: VoicePrefs): void {
  const intents = parseUtterance(alts, customers, { bareKuduthaachu: p.bare });
  const cards: VoiceIntent[] = [];
  let note: ModeNote | null = null;
  for (const it of intents) {
    const a = modeAction(it);
    if (a.type === 'card') cards.push(it);
    else if (a.type === 'balance') {
      const r = rows.find((x) => x.id === a.customerId);
      if (r) note = { type: 'balance', name: r.name, balance_paise: r.balance_paise };
    } else if (!note) note = { type: 'ignored', why: a.why, heard: it.heard, name: it.name_text, amount_paise: it.amount_paise };
  }
  if (!intents.length) note = { type: 'ignored', why: 'noise', heard: alts[0], name: null, amount_paise: null };
  if (!cards.length) {
    set({ note, live: '' });
    listenNext(MIN_GAP_MS);
    return;
  }
  // The accuracy log counts sentences that were entries; the counter's other talk would drown it.
  void bumpVoiceStats({ heard: 1 });
  queue = cards.slice(1);
  showCard(cards[0]);
}

function showCard(intent: VoiceIntent): void {
  lastActivity = Date.now();
  const card: ModeCard = {
    id: ++cardSeq,
    intent,
    who: cardWho(intent),
    kind: intent.kind,
    amount_paise: intent.amount_paise ?? 0,
    alternatives: (intent.amount_alternatives ?? []).filter((a) => a !== intent.amount_paise && a > 0),
    busy: false,
  };
  set({ card, live: '' });
  void app.platform.hapticTap();
  // The card shows "Due before -> after": make sure the other counters' latest entries are in.
  app.sync.refreshIfStale();
}

/** The card is done (approved, skipped, saved from the keypad): the next one of the sentence, or listen again. */
function finishCard(): void {
  lastActivity = Date.now();
  const next = queue.shift();
  if (next) {
    showCard(next);
    return;
  }
  set({ card: null });
  if (state.active && !state.pause) listenNext(MIN_GAP_MS);
}

// ------------------------------------------------------------------ card actions

export function setCardKind(kind: 'GIVE' | 'RECEIVE'): void {
  if (state.card && !state.card.busy) set({ card: { ...state.card, kind } });
}

export function setCardChoice(choice: string | 'new'): void {
  if (state.card && !state.card.busy) set({ card: { ...state.card, who: { ...state.card.who, choice } } });
}

export function setCardAmount(amount_paise: number): void {
  if (!state.card || state.card.busy || amount_paise <= 0) return;
  const c = state.card;
  const alternatives = [c.amount_paise, ...c.alternatives].filter((a) => a !== amount_paise);
  set({ card: { ...c, amount_paise, alternatives } });
}

export function skipCard(): void {
  if (!state.card || state.card.busy) return;
  void bumpVoiceStats({ cancelled: 1 });
  finishCard();
}

/** The name the card will save under (for messages), or null for a choice not made yet. */
export function cardCustomerName(card: ModeCard): string | null {
  const ch = card.who.choice;
  if (ch === null) return null;
  if (ch === 'new') return card.who.newName;
  return rows.find((r) => r.id === ch)?.name ?? null;
}

export function customerRow(id: string): HomeRow | undefined {
  return rows.find((r) => r.id === id);
}

/**
 * Approve: the same questions as the keypad (big amount, more than the due, the same entry a minute ago) through
 * `confirm`, then add the customer (a new name) and the entry. Resolves true when saved.
 */
export async function approveCard(confirm: (check: ApproveCheck) => Promise<boolean>): Promise<boolean> {
  const c = state.card;
  if (!c || c.busy || c.who.choice === null || c.kind === null || c.amount_paise <= 0) return false;
  const kind = c.kind;
  const amount = c.amount_paise;
  const choice = c.who.choice;
  set({ card: { ...c, busy: true } });
  const release = (): false => {
    if (state.card?.id === c.id) set({ card: { ...state.card, busy: false } });
    return false;
  };
  try {
    const s = await refreshSettings();
    const existing = choice === 'new' ? null : choice;
    const due = existing ? await app.repo.balance(existing) : 0;
    if (amount >= s.confirm_above_paise && !(await confirm({ type: 'big', amount_paise: amount, kind }))) return release();
    if (kind === 'RECEIVE' && due > 0 && amount > due && !(await confirm({ type: 'advance', due_paise: due, amount_paise: amount }))) return release();
    if (existing && (await app.repo.recentDuplicate(existing, kind, amount)) && !(await confirm({ type: 'dup', amount_paise: amount }))) return release();
    if (state.card?.id !== c.id || !state.active) return false;
    let customerId: string;
    let name: string;
    if (choice === 'new') {
      const created = await app.repo.createCustomer({ name: c.who.newName ?? '' });
      afterWrite();
      customerId = created.id;
      name = created.name;
    } else {
      customerId = choice;
      name = rows.find((r) => r.id === choice)?.name ?? (await app.repo.getCustomer(choice))?.name ?? '';
    }
    const it = c.intent;
    const res = await app.repo.addEntry({
      customer_id: customerId,
      kind,
      amount_paise: amount,
      note: it.note,
      mode: kind === 'RECEIVE' ? (it.mode ?? 'CASH') : null,
      ...(it.date_offset ? { biz_date: addDays(today(s.clock_offset_ms), it.date_offset) } : {}),
    });
    afterWrite();
    void app.platform.hapticTap();
    // A near name the shopkeeper confirmed for this customer is remembered (aliases.ts), as in the picker.
    if (choice !== 'new' && c.who.newName && offerNew(it)) void learnAlias(c.who.newName, customerId).catch(() => undefined);
    void bumpVoiceStats({ saved: 1, amount_edited: amount !== it.amount_paise ? 1 : 0, kind_changed: it.kind && it.kind !== kind ? 1 : 0 });
    logSaved({ entryId: res.entry.id, customerId, name, kind, amount_paise: amount, balance_paise: res.balance_paise });
    if (state.card?.id === c.id) finishCard();
    return true;
  } catch (e) {
    release();
    throw e;
  }
}

function logSaved(v: VoiceSaved): void {
  const item: ModeLogItem = { ...v, at: Date.now(), undone: false };
  set({ log: [item, ...state.log], note: { type: 'saved', name: v.name, kind: v.kind, amount_paise: v.amount_paise, balance_paise: v.balance_paise } });
}

/**
 * Edit: the card's entry goes to the keypad (a new name to the customer form first). Returns the route to open;
 * the keypad reports back through prefill.onDone and returns to the voice-mode screen.
 */
export function beginEdit(): { name: 'entry' | 'customer-edit'; params: Record<string, string>; state: { voice: VoicePrefill } } | null {
  const c = state.card;
  if (!c || c.busy || c.who.choice === null) return null;
  const prefill: VoicePrefill = {
    ...prefillFromIntent(c.intent),
    amount_paise: c.amount_paise,
    amount_alternatives: c.alternatives,
    kind: c.kind,
    onDone: (saved) => editDone(c.id, saved),
  };
  pauseBeforeEdit = state.pause;
  pauseMode('editing');
  if (c.who.choice === 'new') return { name: 'customer-edit', params: { name: c.who.newName ?? '' }, state: { voice: prefill } };
  const params: Record<string, string> = { id: c.who.choice };
  if (c.kind) params.kind = c.kind;
  return { name: 'entry', params, state: { voice: prefill } };
}

function editDone(cardId: number, saved: VoiceSaved | null): void {
  if (!state.active || state.card?.id !== cardId) return;
  if (state.pause === 'editing') set({ pause: pauseBeforeEdit });
  pauseBeforeEdit = null;
  if (saved) {
    // Saved on the keypad (it counted the voice stats): log it and move on.
    logSaved(saved);
    finishCard();
  }
  // Back without saving: the card stays for Approve / Skip.
}

/**
 * The voice-mode screen is showing again. If an Edit is still open on paper (the customer form was left with
 * Back, which reports nothing), the card comes back.
 */
export function screenShown(): void {
  if (state.active && state.pause === 'editing' && state.card) editDone(state.card.id, null);
}

export async function undoLogged(entryId: string): Promise<void> {
  const item = state.log.find((l) => l.entryId === entryId);
  if (!item || item.undone) return;
  const u = await app.repo.reverseEntry(entryId, null);
  afterWrite();
  set({
    log: state.log.map((l) => (l.entryId === entryId ? { ...l, undone: true } : l)),
    note: { type: 'undone', name: item.name, balance_paise: u.balance_paise },
  });
}

/** Tests only. */
export function _resetMode(): void {
  stopMode();
  state = OFF;
  subs.clear();
}
