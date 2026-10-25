/**
 * Voice mode decisions (src/ui/voice/mode-logic.ts): the always-listening counter mode must turn spoken entries
 * into approval cards and leave shop talk alone, stop listening as soon as a sentence is complete, and retry or
 * pause sensibly.
 */
import { describe, expect, it } from 'vitest';
import { parseUtterance, type VoiceCustomer } from '../src/core/voice';
import {
  EARLY_STOP_MS, IDLE_CHOICES, MIN_GAP_MS, StableSignature, cardWho, entrySignature, entryWord, errorPolicy, idleExpired,
  modeAction, restartDelay, sessionTotals,
} from '../src/ui/voice/mode-logic';

const book = (names: string[]): VoiceCustomer[] =>
  names.map((n, i) => ({ id: n.toLowerCase().replace(/\s+/g, '-'), name: n, search_name: null, code: i + 1, phone: null, note: null, archived_at: null, erased_at: null, balance_paise: 0 }));
const CS = book(['Ramu', 'Seenu', 'Kamala', 'Kumar']);
const one = (text: string, cs = CS) => parseUtterance([text], cs)[0];
const action = (text: string, cs = CS) => modeAction(one(text, cs));

describe('modeAction: entries become cards, shop talk is ignored', () => {
  it('the two sentences of the brief', () => {
    const a = action('Ramu 500 kudukkanum');
    expect(a.type).toBe('card');
    expect(a.intent).toMatchObject({ kind: 'GIVE', amount_paise: 50000 });
    expect(a.intent.matches[0].id).toBe('ramu');
    const b = action('Seenu 200 kudutharu');
    expect(b.type).toBe('card');
    expect(b.intent).toMatchObject({ kind: 'RECEIVE', amount_paise: 20000 });
  });
  it('Tamil script and other verbs', () => {
    for (const s of ['ராமு 500 குடுக்கணும்', 'சீனு 200 குடுத்தாரு', 'Kamala 300 vaanginaa', 'Kumar 100 kattinaan', 'Ramu debit 250', 'Seenu credit 60']) {
      expect(action(s).type, s).toBe('card');
    }
  });
  it('a known customer and an amount without a direction still gets a card (the card asks Debit or Credit)', () => {
    const a = action('Ramu 500');
    expect(a.type).toBe('card');
    expect(a.intent.kind).toBeNull();
  });
  it('a new name needs an entry word; with one it is a card for a new customer', () => {
    const a = action('Murali 200 kuduthaaru');
    expect(a.type).toBe('card');
    expect(cardWho(a.intent)).toMatchObject({ choice: 'new', newName: 'Murali' });
    expect(action('Murali 200 rupees')).toMatchObject({ type: 'ignore', why: 'noise' });
  });
  it('counter talk is ignored', () => {
    for (const s of ['arisi 50 rupa', 'oru kilo 60 rupees', 'enna anna epdi irukeenga', 'paal 20 rupees', 'naalaikku varen']) {
      const a = action(s);
      expect(a.type, s).toBe('ignore');
    }
  });
  it('why it was ignored: name without amount, amount with an entry word but no name, a negation', () => {
    expect(action('Ramu vanthaan')).toMatchObject({ type: 'ignore', why: 'noAmount' });
    expect(action('500 kattinaan')).toMatchObject({ type: 'ignore', why: 'noName' });
    expect(action('Ramu 500 kudukkala')).toMatchObject({ type: 'ignore', why: 'negated' });
  });
  it('a balance question is answered, not carded', () => {
    expect(action('Ramu baaki evvalavu')).toMatchObject({ type: 'balance', customerId: 'ramu' });
  });
  it('entryWord: verbs, labels and idioms count; guesses do not', () => {
    expect(entryWord(one('Ramu 500 kudukkanum'))).toBe(true);
    expect(entryWord(one('Ramu credit 500'))).toBe(true);
    expect(entryWord(one('Ramu 500 kadan sollirukkan'))).toBe(true);
    expect(entryWord(one('Ramu 500'))).toBe(false);
    expect(entryWord(one('Ramu arisi 500'))).toBe(false);
  });
});

describe('cardWho', () => {
  it('a clear customer is preselected; an exact name offers no "add new"', () => {
    expect(cardWho(one('Ramu 500 kudukkanum'))).toMatchObject({ choice: 'ramu', newName: null });
  });
  it('two customers with the same name: nobody preselected', () => {
    const cs = book(['Ramu', 'Ramu ', 'Kumar']).map((c, i) => ({ ...c, id: `r${i}` }));
    const w = cardWho(one('Ramu 500 kudukkanum', cs));
    expect(w.choice).toBeNull();
    expect(w.candidates.map((c) => c.id).sort()).toEqual(['r0', 'r1']);
  });
  it('a different, similar name is a new customer with the similar ones offered', () => {
    const w = cardWho(one('Rahul 300 kattinaan', book(['Ramu', 'Kumar'])));
    expect(w).toMatchObject({ choice: 'new', newName: 'Rahul' });
    expect(w.candidates.map((c) => c.id)).toContain('ramu');
  });
});

describe('early stop: a complete sentence ends the session without waiting for silence', () => {
  const sigOf = (text: string) => entrySignature(parseUtterance([text], CS));
  it('no signature until the entry word arrives', () => {
    expect(sigOf('Ramu')).toBeNull();
    expect(sigOf('Ramu 500')).toBeNull();
    expect(sigOf('Ramu 500 kudukkanum')).toBe('ramu|50000|GIVE');
    expect(sigOf('Seenu 200 kudutharu')).toBe('seenu|20000|RECEIVE');
    expect(sigOf('Murali 200 kuduthaaru')).toBe('new:murali|20000|RECEIVE');
    expect(sigOf('arisi 50 rupa')).toBeNull();
  });
  it('noise after the sentence does not change the signature', () => {
    expect(sigOf('Ramu 500 kudukkanum enna anna')).toBe('ramu|50000|GIVE');
  });
  it('stable after EARLY_STOP_MS unchanged; a change restarts the clock', () => {
    const s = new StableSignature();
    expect(s.update(null, 0)).toBeNull();
    expect(s.update('ramu|50000|GIVE', 100)).toBe(100 + EARLY_STOP_MS);
    expect(s.isStable(100 + EARLY_STOP_MS - 1)).toBe(false);
    expect(s.update('ramu|50000|GIVE', 500)).toBe(100 + EARLY_STOP_MS);
    expect(s.isStable(100 + EARLY_STOP_MS)).toBe(true);
    // "Ramu paid one thousand" ... "five hundred": the amount grows, so wait again
    expect(s.update('ramu|150000|GIVE', 1200)).toBe(1200 + EARLY_STOP_MS);
    expect(s.isStable(1300)).toBe(false);
    s.update(null, 1400);
    expect(s.isStable(5000)).toBe(false);
  });
});

describe('retries and pauses', () => {
  it('no internet: retry with growing delay, capped at 30 s', () => {
    expect(errorPolicy('SPEECH_ERROR:NETWORK', 1)).toEqual({ action: 'retry', delayMs: 3000, key: 'offline' });
    expect(errorPolicy('SPEECH_ERROR:NETWORK', 2)).toMatchObject({ delayMs: 6000 });
    expect(errorPolicy('SPEECH_ERROR:NETWORK', 9)).toMatchObject({ delayMs: 30_000 });
  });
  it('busy recogniser: retry from 1 s', () => {
    expect(errorPolicy('SPEECH_ERROR:RECOGNIZER_BUSY', 1)).toEqual({ action: 'retry', delayMs: 1000, key: 'busy' });
    expect(errorPolicy('SPEECH_ERROR:WHATEVER', 3)).toEqual({ action: 'retry', delayMs: 4000, key: 'error' });
  });
  it('no recogniser or no microphone permission: stop, do not retry', () => {
    expect(errorPolicy('SPEECH_UNAVAILABLE', 1)).toEqual({ action: 'stop', key: 'unavailable' });
    expect(errorPolicy('SPEECH_PERMISSION', 1)).toEqual({ action: 'stop', key: 'denied' });
  });
  it('sessions that end at once with nothing back off instead of spinning', () => {
    expect(restartDelay(0)).toBe(MIN_GAP_MS);
    expect(restartDelay(1)).toBe(500);
    expect(restartDelay(4)).toBe(2000);
    expect(restartDelay(50)).toBe(5000);
  });
  it('pauses by itself after the chosen minutes without an entry; never when 0', () => {
    expect(IDLE_CHOICES).toEqual([15, 60, 0]);
    expect(idleExpired(0, 15 * 60_000 - 1, 15)).toBe(false);
    expect(idleExpired(0, 15 * 60_000, 15)).toBe(true);
    expect(idleExpired(0, 10 * 3_600_000, 0)).toBe(false);
  });
  it('session totals leave undone entries out', () => {
    expect(sessionTotals([
      { kind: 'GIVE', amount_paise: 50000, undone: false },
      { kind: 'RECEIVE', amount_paise: 20000, undone: false },
      { kind: 'GIVE', amount_paise: 9900, undone: true },
    ])).toEqual({ n: 2, gave: 50000, got: 20000 });
  });
});
