/**
 * Name recognition between registered and new customers (2.1.2): a spoken name that is a different name from every
 * customer ("Ramu" with only Rahul / Raju / Ramesh in the book) is a new customer, never somebody else's entry; the
 * same name in another spelling or script is that customer; names the shopkeeper picked are learned on the phone.
 */
import { describe, expect, it } from 'vitest';
import { matchCustomers, parseUtterance, type VoiceCustomer } from '../src/core/voice';
import { EXACT_SCORE, NEW_NAME_BELOW, STRONG_SCORE, offerNew, planIntent, toVoiceCustomers } from '../src/ui/voice/plan';
import { MAX_ALIASES, parseAliases, withAlias } from '../src/ui/voice/aliases';
import { autoSaveEligible } from '../src/ui/voice/quick-save';
import type { HomeRow } from '../src/data/types';

const book = (names: string[]): VoiceCustomer[] =>
  names.map((n, i) => ({ id: n.toLowerCase(), name: n, search_name: null, code: i + 1, phone: null, note: null, archived_at: null, erased_at: null, balance_paise: 0 }));
const score = (registered: string, heard: string) => matchCustomers(heard, book([registered]))[0]?.score ?? 0;

/** Common shop names, several of them one letter apart. */
const NAMES = [
  'Ramu', 'Rahul', 'Raju', 'Ramesh', 'Raman', 'Rajesh', 'Raja', 'Rani', 'Ravi', 'Ravindran', 'Kumar', 'Kumaran', 'Kumari',
  'Mani', 'Mari', 'Manikandan', 'Selvi', 'Selvam', 'Gopi', 'Gopal', 'Latha', 'Lakshmi', 'Bala', 'Balu', 'Kannan', 'Senthil',
  'Muthu', 'Mathi', 'Saravanan', 'Sarathy', 'Arun', 'Varun', 'Anitha', 'Kavitha', 'Suresh', 'Mohan', 'Madhan', 'Vijay',
  'Ajay', 'Prakash', 'Prasad', 'Ganesh', 'Dinesh', 'Murugan', 'Revathi', 'Radha', 'Siva', 'Devi', 'Deva', 'Karthik',
  'Kathir', 'Priya', 'Velu', 'Kamala', 'Komala', 'Sundar', 'Chandar', 'Meena', 'Meera', 'Seetha', 'Geetha', 'Anand',
  'Aravind', 'Babu', 'Basha', 'Fathima', 'Kasi', 'Pandi', 'Ponni', 'Valli', 'Malar', 'Malathi', 'Jaya', 'Vasanth',
  'Vasantha', 'Saranya', 'Sangeetha', 'Arjun', 'Mahesh', 'Naresh', 'Ramya', 'Ramani',
];

describe('different names never pass for each other', () => {
  it(`all ${NAMES.length * (NAMES.length - 1)} ordered pairs: below the keypad level, far below auto-save`, () => {
    const bad: string[] = [];
    for (const a of NAMES) for (const b of NAMES) {
      if (a === b) continue;
      const s = score(a, b);
      if (s >= STRONG_SCORE) bad.push(`${a} <- "${b}" ${s}`);
    }
    expect(bad).toEqual([]);
  });

  const pairs: [string, string][] = [
    ['Rahul', 'Ramu'], ['Raju', 'Ramu'], ['Ramesh', 'Ramu'], ['Raman', 'Ramu'], ['Rani', 'Ravi'], ['Mari', 'Mani'],
    ['Selvam', 'Selvi'], ['Gopi', 'Gopal'], ['Bala', 'Balu'], ['Raja', 'Raju'], ['Mohan', 'Madhan'], ['Vijay', 'Ajay'],
    ['Prakash', 'Prasad'], ['Ganesh', 'Dinesh'], ['Devi', 'Deva'], ['Karthik', 'Kathir'], ['Kumar', 'Kumari'],
    ['Vasanth', 'Vasantha'], ['Raman', 'Ramani'], ['Ramu', 'Rahul'],
  ];
  for (const [registered, heard] of pairs) {
    it(`"${heard}" with only ${registered} in the book is a new customer`, () => {
      expect(score(registered, heard)).toBeLessThan(NEW_NAME_BELOW);
      const [it1] = parseUtterance([`${heard} 500 kattinaan`], book([registered]));
      const plan = planIntent(it1);
      expect(plan.type).toBe('new');
      if (plan.type === 'new') expect(plan.name).toBe(heard);
    });
  }
});

describe('the same name in another spelling or script is that customer', () => {
  const same: [string, string][] = [
    ['Rahul', 'Raghul'], ['Rahul', 'ராகுல்'], ['Ramu', 'ராமு'], ['Ramu', 'Raamu'], ['Mohan', 'மோகன்'], ['Senthil', 'செந்தில்'],
    ['Senthil', 'Sendhil'], ['Lakshmi', 'லட்சுமி'], ['Lakshmi', 'Laxmi'], ['Murugan', 'முருகன்'], ['Selvi', 'Selvee'],
    ['Kumar', 'குமார்'], ['Kumar', 'Kumaar'], ['Ganesh', 'கணேஷ்'], ['Suresh', 'சுரேஷ்'], ['Karthik', 'கார்த்திக்'],
    ['Priya', 'பிரியா'], ['Priya', 'Piriya'], ['Vijay', 'விஜய்'], ['Saravanan', 'சரவணன்'], ['Mahesh', 'மகேஷ்'],
    ['Prakash', 'பிரகாஷ்'], ['Shiva', 'Siva'], ['Muthu', 'முத்து'], ['Anand', 'Aanandh'], ['Rajesh', 'ராஜேஷ்'],
    ['Rahim', 'ரஹீம்'], ['Fathima', 'பாத்திமா'], ['Abdul', 'அப்துல்'],
  ];
  for (const [registered, heard] of same) {
    it(`${registered} <- "${heard}"`, () => {
      expect(score(registered, heard)).toBeGreaterThanOrEqual(EXACT_SCORE);
    });
  }

  it('in a crowded book the right one of Rahul / Raju / Ramesh / Ramu is chosen', () => {
    const cs = book(['Rahul', 'Raju', 'Ramesh', 'Ramu', 'Raman', 'Rajesh']);
    for (const n of ['Rahul', 'Raju', 'Ramesh', 'Ramu', 'Raman', 'Rajesh']) {
      const [it1] = parseUtterance([`${n} 200 kattinaan`], cs);
      expect(planIntent(it1)).toMatchObject({ type: 'entry', customerId: n.toLowerCase() });
      expect(it1.confidence).toBe('high');
    }
  });

  it('the reported case: "ramu gives me 500rs credit" with only Rahul -> add Ramu, Rahul offered below', () => {
    const [it1] = parseUtterance(['ramu gives me 500rs credit'], book(['Rahul']));
    expect(it1.kind).toBe('RECEIVE');
    expect(it1.amount_paise).toBe(50000);
    const plan = planIntent(it1);
    expect(plan).toMatchObject({ type: 'new', name: 'ramu' });
    if (plan.type === 'new') expect(plan.similar.map((m) => m.id)).toEqual(['rahul']);
  });
});

describe('a near name asks, and always offers "Add new"', () => {
  it('Arun with only Varun in the book: picker, with Add new', () => {
    const [it1] = parseUtterance(['Arun 50 kattinaan'], book(['Varun']));
    expect(planIntent(it1).type).toBe('pick');
    expect(offerNew(it1)).toBe(true);
  });
  it('a near-but-strong name opens the keypad, never auto-saves', () => {
    const [it1] = parseUtterance(['Ramo 50 kattinaan'], book(['Ramu']));
    expect(planIntent(it1)).toMatchObject({ type: 'entry', customerId: 'ramu' });
    expect(it1.matches[0].score).toBeLessThan(EXACT_SCORE);
    expect(autoSaveEligible(it1, { autosave: true, confirmAbovePaise: 1e9, balancePaise: 0, recentDuplicate: false, nameExact: false })).toBe(false);
  });
});

describe('learned names (aliases)', () => {
  const rows = (names: string[]) => book(names) as unknown as HomeRow[];
  it('a picked spoken form matches its customer exactly next time', () => {
    const before = parseUtterance(['Raghu 100 kattinaan'], toVoiceCustomers(rows(['Rahul', 'Ramu'])))[0];
    expect((before.matches[0]?.score ?? 0)).toBeLessThan(EXACT_SCORE);
    const learned = withAlias([], 'Raghu', 'rahul');
    const after = parseUtterance(['Raghu 100 kattinaan'], toVoiceCustomers(rows(['Rahul', 'Ramu']), learned))[0];
    expect(planIntent(after)).toMatchObject({ type: 'entry', customerId: 'rahul' });
    expect(after.matches[0].score).toBe(1);
    expect(after.confidence).toBe('high');
  });
  it('a real customer with that name wins over the learned form', () => {
    const learned = withAlias([], 'Ramu', 'rahul');
    const [it1] = parseUtterance(['Ramu 100 kattinaan'], toVoiceCustomers(rows(['Rahul', 'Ramu']), learned));
    expect(planIntent(it1)).toMatchObject({ type: 'entry', customerId: 'ramu' });
  });
  it('one customer per spoken form, Tamil and Latin spellings are one form; capped; bad JSON ignored', () => {
    let l = withAlias([], 'Raghu', 'rahul');
    l = withAlias(l, 'ரகு', 'ramu');
    expect(l).toEqual([['ரகு', 'ramu']]);
    for (let i = 0; i < MAX_ALIASES + 5; i++) l = withAlias(l, `Name${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}x`, 'x');
    expect(l.length).toBeLessThanOrEqual(MAX_ALIASES);
    expect(parseAliases('{"a":1}')).toEqual([]);
    expect(parseAliases('nope')).toEqual([]);
    expect(parseAliases('[["Raghu","rahul"],[1,2],["", "x"]]')).toEqual([['Raghu', 'rahul']]);
  });
});
