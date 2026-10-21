/**
 * Pure decisions of the voice flow (no DOM, no I/O): which customers the parser may see, and what the UI does
 * with each parsed intent. Kept separate from listen.ts so it can be unit-tested in Node.
 */
import { nameFold, type CustomerMatch, type VoiceCustomer, type VoiceIntent } from '../../core/voice';
import type { HomeRow } from '../../data/types';

/** A match this sure, and this far ahead of the runner-up, opens the entry screen without asking. */
export const STRONG_SCORE = 0.85;
export const STRONG_GAP = 0.10;
/**
 * Below this the spoken name is a different name, not a mis-hearing: "Ramu" with only Rahul (0.6) or Raju (0.75)
 * in the book is a new customer, and the near names are only offered as "Did you mean …?".
 */
export const NEW_NAME_BELOW = 0.8;
/** A match this good is the same name (exact, its Tamil/Latin spelling, or a name learned on this phone). */
export const EXACT_SCORE = 0.95;

export type VoiceStep =
  /** Open the keypad for this customer, prefilled. */
  | { type: 'entry'; customerId: string; intent: VoiceIntent }
  /** Several customers fit (or one fits only loosely): show a picker with these candidates. */
  | { type: 'pick'; candidates: CustomerMatch[]; intent: VoiceIntent }
  /** Nobody fits the spoken name: offer to add a customer with this name (similar names offered below it). */
  | { type: 'new'; name: string; similar: CustomerMatch[]; intent: VoiceIntent }
  /** A balance question ("Ramu baaki evvalavu"), answered without an entry. */
  | { type: 'balance'; customerId: string | null; candidates: CustomerMatch[]; intent: VoiceIntent }
  /** No customer name was spoken (and no page customer to fall back to). */
  | { type: 'noname'; intent: VoiceIntent }
  /** Nothing usable (no name, no amount). */
  | { type: 'unclear'; intent: VoiceIntent };

/**
 * Home rows -> what the parser needs. Erased customers never match. `aliases` (spoken form -> customer id, learned on
 * this phone) are attached to their customer, except a form that is now some customer's real name: the real Ramu wins
 * over "Ramu" once learned for Rahul.
 */
export function toVoiceCustomers(rows: HomeRow[], aliases: readonly (readonly [string, string])[] = []): VoiceCustomer[] {
  const live = rows.filter((r) => !r.erased_at);
  const real = new Set(live.flatMap((r) => [nameFold(r.name), r.search_name ? nameFold(r.search_name) : '']).filter(Boolean));
  const byId = new Map<string, string[]>();
  for (const [heard, id] of aliases) {
    const k = nameFold(heard);
    if (!k || real.has(k)) continue;
    byId.set(id, [...(byId.get(id) ?? []), heard]);
  }
  return live.map((r) => ({
    id: r.id, name: r.name, search_name: r.search_name, code: r.code, phone: r.phone, note: r.note,
    archived_at: r.archived_at, erased_at: r.erased_at, balance_paise: r.balance_paise,
    ...(byId.has(r.id) ? { aliases: byId.get(r.id) } : {}),
  }));
}

/** The spoken name is not exactly a customer's: the picker also offers "Add <name> as new". */
export function offerNew(intent: VoiceIntent): boolean {
  return !!intent.name_text && (intent.matches[0]?.score ?? 0) < EXACT_SCORE;
}

/** True when the best match is sure and clearly ahead of the runner-up (same-name customers tie, so they ask). */
export function isStrong(matches: CustomerMatch[]): boolean {
  const top = matches[0];
  if (!top || top.score < STRONG_SCORE) return false;
  const second = matches[1];
  return !second || second.score <= top.score - STRONG_GAP;
}

export function planIntent(intent: VoiceIntent, opts: { contextCustomerId?: string } = {}): VoiceStep {
  const ctx = opts.contextCustomerId;
  const kept = !!ctx && intent.context_kept === true;
  if (intent.balance_query) {
    if (kept) return { type: 'balance', customerId: ctx!, candidates: [], intent };
    if (isStrong(intent.matches)) return { type: 'balance', customerId: intent.matches[0].id, candidates: [], intent };
    return { type: 'balance', customerId: null, candidates: intent.matches, intent };
  }
  // On a customer's page the parser already decided whether the page's customer is meant (finding 9).
  if (kept) return { type: 'entry', customerId: ctx!, intent };
  const top = intent.matches[0]?.score ?? 0;
  if (intent.name_text && top < NEW_NAME_BELOW) return { type: 'new', name: intent.name_text, similar: intent.matches, intent };
  if (intent.matches.length === 0) {
    if (intent.amount_paise !== null) return { type: 'noname', intent };
    return { type: 'unclear', intent };
  }
  if (isStrong(intent.matches)) return { type: 'entry', customerId: intent.matches[0].id, intent };
  return { type: 'pick', candidates: intent.matches, intent };
}

/** Error code -> i18n key suffix for the message shown under the mic. */
export function speechErrorKey(message: string): 'unavailable' | 'denied' | 'offline' | 'busy' | 'error' {
  if (message === 'SPEECH_UNAVAILABLE') return 'unavailable';
  if (message === 'SPEECH_PERMISSION') return 'denied';
  const code = message.startsWith('SPEECH_ERROR:') ? message.slice('SPEECH_ERROR:'.length) : '';
  if (/^(NETWORK|NETWORK_TIMEOUT|SERVER|SERVER_DISCONNECTED|network)$/.test(code)) return 'offline';
  if (/^(RECOGNIZER_BUSY|BUSY|CLIENT|aborted)$/.test(code)) return 'busy';
  if (/^(INSUFFICIENT_PERMISSIONS|not-allowed|service-not-allowed|audio-capture|AUDIO)$/.test(code)) return 'denied';
  if (/^(UNKNOWN_12|UNKNOWN_13|language-not-supported)$/.test(code)) return 'unavailable';
  return 'error';
}
