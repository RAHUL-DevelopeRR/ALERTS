/** voice-ui: the DOM-free parts of src/ui/voice (step planning, prefill mapping, prefs/stats parsing). */
import { describe, expect, it } from 'vitest';
import { parseUtterance, type VoiceCustomer, type VoiceIntent } from '../src/core/voice';
import type { HomeRow } from '../src/data/types';
import { isStrong, offerNew, planIntent, speechErrorKey, toVoiceCustomers } from '../src/ui/voice/plan';
import { prefillFromIntent } from '../src/ui/voice/prefill';
import { DEFAULT_VOICE_PREFS, EMPTY_VOICE_STATS, parseVoicePrefs, parseVoiceStats } from '../src/ui/voice/prefs';

const row = (p: Partial<HomeRow> & { id: string; name: string; code: number }): HomeRow => ({
  search_name: null, phone: null, note: null, archived_at: null, erased_at: null, balance_paise: 0,
  last_activity: null, last_payment: null, first_give: null, days_since: null, has_pending: false, has_rejected: false,
  ...p,
});
const rows: HomeRow[] = [
  row({ id: 'r1', name: 'Ramu', code: 1, note: 'கோயில் தெரு', balance_paise: 25000 }),
  row({ id: 'r2', name: 'Ramu', code: 2, note: 'பள்ளி அருகில்' }),
  row({ id: 'k', name: 'Kamala', code: 3, phone: '+919876543210' }),
  row({ id: 'ku', name: 'Kumar', code: 4 }),
  row({ id: 'gone', name: 'Gopal', code: 5, erased_at: '2026-01-01T00:00:00Z' }),
];
const customers: VoiceCustomer[] = toVoiceCustomers(rows);
const one = customers.filter((c) => c.id !== 'r2');
const parse = (alts: string[], cs = customers, ctx?: string): VoiceIntent[] => parseUtterance(alts, cs, { bareKuduthaachu: 'RECEIVE' }, ctx ? { contextCustomerId: ctx } : {});

describe('toVoiceCustomers', () => {
  it('drops erased customers and keeps the balance for the parser', () => {
    expect(customers.map((c) => c.id)).toEqual(['r1', 'r2', 'k', 'ku']);
    expect(customers[0].balance_paise).toBe(25000);
    expect(customers[0].note).toBe('கோயில் தெரு');
  });
});

describe('planIntent', () => {
  it('one strong match -> entry', () => {
    const [it1] = parse(['Ramu 100 kuduthaachu'], one);
    expect(planIntent(it1)).toMatchObject({ type: 'entry', customerId: 'r1' });
  });
  it('two Ramus -> picker with both', () => {
    const [it1] = parse(['Ramu 100 kattinaan']);
    const plan = planIntent(it1);
    expect(plan.type).toBe('pick');
    if (plan.type === 'pick') expect(plan.candidates.map((c) => c.id).sort()).toEqual(['r1', 'r2']);
  });
  it("on Ramu-1's page a namesake stays on Ramu-1 (finding 9)", () => {
    const [it1] = parse(['Ramu 100 kattinaan'], customers, 'r1');
    expect(planIntent(it1, { contextCustomerId: 'r1' })).toMatchObject({ type: 'entry', customerId: 'r1' });
    const [it2] = parse(['100 kattinaan'], customers, 'r2');
    expect(planIntent(it2, { contextCustomerId: 'r2' })).toMatchObject({ type: 'entry', customerId: 'r2' });
  });
  it('on a page, another clear name leaves the page customer', () => {
    const [it1] = parse(['Kamala 100 kattinaan'], customers, 'r1');
    expect(it1.context_kept).toBe(false);
    expect(planIntent(it1, { contextCustomerId: 'r1' })).toMatchObject({ type: 'entry', customerId: 'k' });
  });
  it('unknown name -> add new with the heard name', () => {
    const [it1] = parse(['Suresh 150 kattinaan']);
    expect(planIntent(it1)).toMatchObject({ type: 'new', name: 'Suresh' });
  });
  it('amount without a name on home -> noname; garbage -> unclear', () => {
    expect(planIntent(parse(['100 kattinaan'])[0]).type).toBe('noname');
    expect(planIntent(parse(['hello world'])[0]).type).toBe('new'); // "world" is treated as a name: the shopkeeper can cancel
    const garbage: VoiceIntent = { heard: 'uh', name_text: null, matches: [], amount_paise: null, kind: null, kind_reason: null, note: null, confidence: 'low' };
    expect(planIntent(garbage).type).toBe('unclear');
  });
  it('balance question -> balance step', () => {
    const [it1] = parse(['Ramu baaki evvalavu'], one);
    expect(planIntent(it1)).toMatchObject({ type: 'balance', customerId: 'r1' });
    const [it2] = parse(['baaki evvalavu'], customers, 'r2');
    expect(planIntent(it2, { contextCustomerId: 'r2' })).toMatchObject({ type: 'balance', customerId: 'r2' });
  });
  it('a loose single match is a new customer, the near name offered as "Did you mean"', () => {
    expect(isStrong([{ id: 'a', score: 0.7 }])).toBe(false);
    expect(isStrong([{ id: 'a', score: 0.9 }, { id: 'b', score: 0.85 }])).toBe(false);
    expect(isStrong([{ id: 'a', score: 0.9 }, { id: 'b', score: 0.7 }])).toBe(true);
    const loose: VoiceIntent = { heard: 'x', name_text: 'Ramesh', matches: [{ id: 'r1', score: 0.7 }], amount_paise: 100, kind: 'GIVE', kind_reason: 'verb', note: null, confidence: 'low' };
    expect(planIntent(loose)).toMatchObject({ type: 'new', name: 'Ramesh', similar: [{ id: 'r1', score: 0.7 }] });
    const near: VoiceIntent = { ...loose, matches: [{ id: 'r1', score: 0.82 }] };
    expect(planIntent(near).type).toBe('pick');
    expect(offerNew(near)).toBe(true);
    expect(offerNew({ ...loose, matches: [{ id: 'r1', score: 1 }] })).toBe(false);
  });
});

describe('prefillFromIntent', () => {
  it('carries amount text, alternatives, note, kind and the queue position', () => {
    const [it1] = parse(['Ramu 100 kattinaan', 'Ramu 1000 kattinaan'], one);
    const p = prefillFromIntent(it1, { index: 1, total: 2 });
    expect(p).toMatchObject({ heard: 'Ramu 100 kattinaan', amount_paise: 10000, amount_text: '100', amount_alternatives: [100000], kind: 'RECEIVE', confidence: 'medium', queue: { index: 1, total: 2 } });
    const single = prefillFromIntent(it1, { index: 1, total: 1 });
    expect(single.queue).toBeUndefined();
    const [it2] = parse(['ராமுக்கு 250 அரிசி குடுத்தேன்'], one);
    expect(prefillFromIntent(it2)).toMatchObject({ kind: 'GIVE', amount_paise: 25000, note: 'அரிசி', amount_alternatives: [] });
    const [it3] = parse(['Ramu 100 paaru'], one);
    expect(prefillFromIntent(it3).kind).toBeNull();
  });
});

describe('prefs and stats parsing', () => {
  it('defaults, field-by-field validation, junk tolerated', () => {
    expect(parseVoicePrefs(null)).toEqual(DEFAULT_VOICE_PREFS);
    expect(parseVoicePrefs('{"on":false,"lang":"en-IN","bare":"GIVE","notice_ok":true}')).toEqual({ on: false, lang: 'en-IN', bare: 'GIVE', notice_ok: true, hold: true, autosave: true });
    expect(parseVoicePrefs('{"autosave":false}')).toEqual({ ...DEFAULT_VOICE_PREFS, autosave: false });
    expect(parseVoicePrefs('{"hold":false}')).toEqual({ ...DEFAULT_VOICE_PREFS, hold: false });
    expect(parseVoicePrefs('{"hold":"no"}').hold).toBe(true);
    expect(parseVoicePrefs('{"on":"no","lang":"fr-FR","bare":"X"}')).toEqual(DEFAULT_VOICE_PREFS);
    expect(parseVoicePrefs('not json')).toEqual(DEFAULT_VOICE_PREFS);
    expect(parseVoiceStats(null)).toEqual(EMPTY_VOICE_STATS);
    expect(parseVoiceStats('{"heard":3,"saved":2.7,"cancelled":-1,"amount_edited":"x"}')).toEqual({ ...EMPTY_VOICE_STATS, heard: 3, saved: 2 });
  });
});

describe('speechErrorKey', () => {
  it('maps platform errors to the message shown', () => {
    expect(speechErrorKey('SPEECH_UNAVAILABLE')).toBe('unavailable');
    expect(speechErrorKey('SPEECH_PERMISSION')).toBe('denied');
    expect(speechErrorKey('SPEECH_ERROR:NETWORK')).toBe('offline');
    expect(speechErrorKey('SPEECH_ERROR:network')).toBe('offline');
    expect(speechErrorKey('SPEECH_ERROR:RECOGNIZER_BUSY')).toBe('busy');
    expect(speechErrorKey('SPEECH_ERROR:UNKNOWN_12')).toBe('unavailable');
    expect(speechErrorKey('SPEECH_ERROR:AUDIO')).toBe('denied');
    expect(speechErrorKey('SPEECH_ERROR:SERVER')).toBe('offline');
    expect(speechErrorKey('whatever')).toBe('error');
  });
});
