/**
 * Pure decisions of the voice flow (no DOM, no I/O): which customers the parser may see, and what the UI does
 * with each parsed intent. Kept separate from listen.ts so it can be unit-tested in Node.
 */
import type { CustomerMatch, VoiceCustomer, VoiceIntent } from '../../core/voice';
import type { HomeRow } from '../../data/types';

/** A match this sure, and this far ahead of the runner-up, opens the entry screen without asking. */
export const STRONG_SCORE = 0.85;
export const STRONG_GAP = 0.10;

export type VoiceStep =
  /** Open the keypad for this customer, prefilled. */
  | { type: 'entry'; customerId: string; intent: VoiceIntent }
  /** Several customers fit (or one fits only loosely): show a picker with these candidates. */
  | { type: 'pick'; candidates: CustomerMatch[]; intent: VoiceIntent }
  /** Nobody fits the spoken name: offer to add a customer with this name. */
  | { type: 'new'; name: string; intent: VoiceIntent }
  /** A balance question ("Ramu baaki evvalavu"), answered without an entry. */
  | { type: 'balance'; customerId: string | null; candidates: CustomerMatch[]; intent: VoiceIntent }
  /** No customer name was spoken (and no page customer to fall back to). */
  | { type: 'noname'; intent: VoiceIntent }
  /** Nothing usable (no name, no amount). */
  | { type: 'unclear'; intent: VoiceIntent };

/** Home rows -> what the parser needs. Erased customers never match. */
export function toVoiceCustomers(rows: HomeRow[]): VoiceCustomer[] {
  return rows
    .filter((r) => !r.erased_at)
    .map((r) => ({
      id: r.id, name: r.name, search_name: r.search_name, code: r.code, phone: r.phone, note: r.note,
      archived_at: r.archived_at, erased_at: r.erased_at, balance_paise: r.balance_paise,
    }));
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
  if (intent.matches.length === 0) {
    if (intent.name_text) return { type: 'new', name: intent.name_text, intent };
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
