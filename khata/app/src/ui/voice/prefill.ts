/**
 * What the voice flow hands to the entry screen (route.state.voice, in memory only). The entry screen shows it
 * as a prefilled keypad with a "Heard: ..." banner; nothing is written until the shopkeeper taps Save.
 */
import type { VoiceIntent } from '../../core/voice';

export interface VoicePrefill {
  /** The alternative the parser used. */
  heard: string;
  amount_paise: number | null;
  /** The words or digits the amount came from, as heard ("ஐநூறு", "1,500"). */
  amount_text?: string;
  /** Other amounts other alternatives heard (paise), offered as chips. */
  amount_alternatives: number[];
  /** null = direction unclear: nothing preselected, Save disabled until Debit or Credit is chosen. */
  kind: 'GIVE' | 'RECEIVE' | null;
  kind_reason: string | null;
  note: string | null;
  mode?: 'UPI';
  date_offset?: 0 | -1 | -2;
  confidence: 'high' | 'medium' | 'low';
  /** Position in a multi-entry utterance ("1 of 2"). */
  queue?: { index: number; total: number };
  /** Continue with the next entry of the utterance (after Save, or after leaving without saving). */
  next?: () => void;
  /**
   * Voice mode: the keypad (and a new customer's form before it) returns to the voice-mode screen, and reports the
   * outcome here instead of a toast: the saved entry, or null when the shopkeeper went back without saving.
   */
  onDone?: (saved: VoiceSaved | null) => void;
}

/** What the keypad saved for a voice prefill (voice mode logs it). */
export interface VoiceSaved {
  entryId: string;
  customerId: string;
  name: string;
  kind: 'GIVE' | 'RECEIVE';
  amount_paise: number;
  balance_paise: number;
}

export function prefillFromIntent(intent: VoiceIntent, queue?: { index: number; total: number }): VoicePrefill {
  const p: VoicePrefill = {
    heard: intent.heard,
    amount_paise: intent.amount_paise,
    amount_alternatives: (intent.amount_alternatives ?? []).filter((a) => a !== intent.amount_paise),
    kind: intent.kind,
    kind_reason: intent.kind_reason,
    note: intent.note,
    confidence: intent.confidence,
  };
  if (intent.amount_text) p.amount_text = intent.amount_text;
  if (intent.mode) p.mode = intent.mode;
  if (intent.date_offset !== undefined) p.date_offset = intent.date_offset;
  if (queue && queue.total > 1) p.queue = queue;
  return p;
}
