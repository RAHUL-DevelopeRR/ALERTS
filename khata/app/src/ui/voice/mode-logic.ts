/**
 * Pure decisions of voice mode (the always-listening counter mode, mode.ts): which spoken sentences become an
 * approval card and which are shop talk to ignore, who the card is for, when a sentence is complete enough to stop
 * listening early, how errors and empty sessions are retried, and when to pause by itself. No DOM, no I/O, so
 * Vitest covers it directly (test/ui.voice-mode.test.ts).
 *
 * In voice mode the microphone stays open at a noisy counter: prices, greetings and customers' own talk reach the
 * recogniser all day. So a card is shown only for a sentence that looks like a ledger entry: an amount plus a
 * customer in the book (direction may be unclear: the card asks), or an amount plus an entry word for a name
 * nobody has ("Seenu 200 kuduthaaru": a new customer). "arisi 50 rupa", "epdi irukeenga" and the like are
 * ignored; the status line shows what was heard so the shopkeeper knows why nothing happened.
 */
import { nameFold, type CustomerMatch, type VoiceIntent } from '../../core/voice';
import { NEW_NAME_BELOW, offerNew, planIntent, speechErrorKey } from './plan';

/** Stop listening this long after a complete entry ("Ramu 500 kudukkanum") was first heard unchanged. */
export const EARLY_STOP_MS = 900;
/** One listening session in voice mode; Google ends most sooner (silence), this caps a noisy shop. */
export const MODE_LISTEN_MS = 20_000;
/** Gap before the next session after a normal one. */
export const MIN_GAP_MS = 250;
/** A session shorter than this that heard nothing counts as "ended at once" (recogniser refusing to listen). */
export const QUICK_EMPTY_MS = 1000;
/** After this many errors in a row (other than no internet) voice mode pauses and asks for Resume. */
export const MAX_ERRORS = 6;
/** Choices for "pause by itself after … without an entry" (minutes; 0 = never). */
export const IDLE_CHOICES = [15, 60, 0] as const;
export type IdleMinutes = (typeof IDLE_CHOICES)[number];

/** The direction came from an entry word (verb, Debit/Credit label, kadan idiom, UPI, kuduthaachu), not a guess. */
export function entryWord(intent: Pick<VoiceIntent, 'kind' | 'kind_reason'>): boolean {
  const r = intent.kind_reason;
  if (!intent.kind || !r || r.includes('~')) return false;
  return /^(verb|label|idiom|upi|bare-kuduthaachu|noun:kadan)/.test(r);
}

/** The best match is a customer in the book (not just a similar name). */
export function knownCustomer(intent: Pick<VoiceIntent, 'matches'>): boolean {
  return (intent.matches[0]?.score ?? 0) >= NEW_NAME_BELOW;
}

export type IgnoreWhy = 'noise' | 'noAmount' | 'noName' | 'negated' | 'unsure';

export type ModeAction =
  | { type: 'card'; intent: VoiceIntent }
  | { type: 'balance'; customerId: string; intent: VoiceIntent }
  | { type: 'ignore'; why: IgnoreWhy; intent: VoiceIntent };

/** What voice mode does with one parsed entry. */
export function modeAction(intent: VoiceIntent): ModeAction {
  if (intent.balance_query) {
    const plan = planIntent(intent);
    if (plan.type === 'balance' && plan.customerId) return { type: 'balance', customerId: plan.customerId, intent };
    return { type: 'ignore', why: 'unsure', intent };
  }
  if (intent.kind_reason?.startsWith('negated')) return { type: 'ignore', why: 'negated', intent };
  const known = knownCustomer(intent);
  if (intent.amount_paise === null || intent.amount_paise <= 0) return { type: 'ignore', why: known ? 'noAmount' : 'noise', intent };
  if (!intent.name_text && !intent.matches.length) return { type: 'ignore', why: entryWord(intent) ? 'noName' : 'noise', intent };
  if (known) return { type: 'card', intent };
  // A name nobody has: only with an entry word; "paal 20 rupees" or "anna 50" is talk at the counter.
  if (entryWord(intent)) return { type: 'card', intent };
  return { type: 'ignore', why: 'noise', intent };
}

/** Who an approval card is for, and what the shopkeeper may switch to. */
export interface CardWho {
  /** Customers offered, best first (the chosen one, the candidates, or the similar names of a new one). */
  candidates: CustomerMatch[];
  /** A customer id, 'new' (add `newName`), or null until one is tapped (several fit). */
  choice: string | 'new' | null;
  /** The spoken name, when adding it as a new customer is offered (the name is not exactly anyone's). */
  newName: string | null;
}

export function cardWho(intent: VoiceIntent): CardWho {
  const plan = planIntent(intent);
  const newName = offerNew(intent) ? intent.name_text : null;
  if (plan.type === 'entry') return { candidates: intent.matches.slice(0, 3), choice: plan.customerId, newName };
  if (plan.type === 'pick') return { candidates: plan.candidates, choice: null, newName };
  if (plan.type === 'new') return { candidates: plan.similar, choice: 'new', newName: plan.name };
  return { candidates: intent.matches.slice(0, 3), choice: null, newName };
}

/**
 * Signature of a complete entry in a live (partial) transcript, or null: a card-worthy first entry with an amount
 * and an entry word. While it stays the same for EARLY_STOP_MS the sentence is over, even if shop noise keeps
 * adding words after it (so the session need not wait for silence that never comes).
 */
export function entrySignature(intents: VoiceIntent[]): string | null {
  const it = intents[0];
  if (!it || it.amount_paise === null || !entryWord(it)) return null;
  if (modeAction(it).type !== 'card') return null;
  const who = knownCustomer(it) ? it.matches[0].id : `new:${nameFold(it.name_text ?? '')}`;
  return `${who}|${it.amount_paise}|${it.kind}`;
}

/** Tracks how long the latest signature has stayed unchanged. */
export class StableSignature {
  private sig: string | null = null;
  private since = 0;
  constructor(private readonly ms: number = EARLY_STOP_MS) {}
  /** Feed the signature of the latest partial; returns when it counts as stable (ms timestamp), or null. */
  update(sig: string | null, now: number): number | null {
    if (sig !== this.sig) {
      this.sig = sig;
      this.since = now;
    }
    return sig ? this.since + this.ms : null;
  }
  isStable(now: number): boolean {
    return this.sig !== null && now - this.since >= this.ms;
  }
}

export type ErrorPolicy =
  | { action: 'retry'; delayMs: number; key: 'offline' | 'busy' | 'error' }
  | { action: 'stop'; key: 'unavailable' | 'denied' };

/** What to do after the `streak`-th recogniser error in a row. */
export function errorPolicy(message: string, streak: number): ErrorPolicy {
  const key = speechErrorKey(message);
  if (key === 'unavailable' || key === 'denied') return { action: 'stop', key };
  const base = key === 'offline' ? 3000 : 1000;
  const n = Math.max(1, streak);
  return { action: 'retry', delayMs: Math.min(30_000, base * 2 ** Math.min(n - 1, 4)), key };
}

/** Gap before the next session: a short one that heard nothing must not spin (0.5 s, 1 s, ... up to 5 s). */
export function restartDelay(quickEmptyStreak: number): number {
  return quickEmptyStreak > 0 ? Math.min(5000, 500 * quickEmptyStreak) : MIN_GAP_MS;
}

/** Pause by itself: `idleMin` minutes since the last entry (or start / resume); 0 = never. */
export function idleExpired(lastActivity: number, now: number, idleMin: number): boolean {
  return idleMin > 0 && now - lastActivity >= idleMin * 60_000;
}

export interface SessionLine {
  kind: 'GIVE' | 'RECEIVE';
  amount_paise: number;
  undone: boolean;
}

/** Count and Debit / Credit totals of the entries approved in one voice-mode session (undone ones left out). */
export function sessionTotals(log: readonly SessionLine[]): { n: number; gave: number; got: number } {
  let n = 0;
  let gave = 0;
  let got = 0;
  for (const l of log) {
    if (l.undone) continue;
    n++;
    if (l.kind === 'GIVE') gave += l.amount_paise;
    else got += l.amount_paise;
  }
  return { n, gave, got };
}
