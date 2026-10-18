import { afterAll, describe, expect, it } from 'vitest';
import {
  detectKind, FOLDED_CUE_KEYS, LEXICON_SIZE, matchCustomers, needsHelp, parseAmount, parseUtterance,
  type VoiceCustomer, type VoiceIntent, type VoiceSettings,
} from '../src/core/voice';
import { MAX_AMOUNT_PAISE } from '../src/core/ledger';
import cases from './fixtures/voice-utterances.json';
import customerSets from './fixtures/voice-customers.json';

type Conf = 'high' | 'medium' | 'low';
const CONF_RANK: Record<Conf, number> = { low: 0, medium: 1, high: 2 };
type ExpectEntry = {
  /** customer id, a tie of ids (equal top scores), or null = no match */
  name: string | string[] | null;
  /** rupees */
  amount: number | null;
  kind: 'GIVE' | 'RECEIVE' | null;
  note?: string;
  name_text?: string;
  kind_reason?: string;
  /** exact confidence, or an upper bound */
  confidence?: Conf;
  confidence_max?: Conf;
  /** the words the amount came from, as heard */
  amount_text?: string;
  /** rupees heard by other alternatives (order-free) */
  amount_alternatives?: number[];
  context_kept?: boolean;
};
type Case = {
  cat: string;
  alts: string[];
  customers: keyof typeof customerSets;
  settings?: Partial<VoiceSettings>;
  /** opts.contextCustomerId: the shopkeeper is on this customer's page */
  context?: string;
  expect: ExpectEntry | ExpectEntry[];
  known_weak?: string;
};

const SETS = customerSets as unknown as Record<string, VoiceCustomer[]>;
const DEFAULT = SETS.default;
const TWO_RAMUS = SETS.two_ramus;

/** Field-by-field comparison; returns the list of mismatches (empty = correct). */
function check(got: VoiceIntent[], want: ExpectEntry[]): { name: boolean; amount: boolean; kind: boolean; problems: string[] } {
  const problems: string[] = [];
  let name = true;
  let amount = true;
  let kind = true;
  if (got.length !== want.length) {
    problems.push(`entries ${got.length} != ${want.length}`);
    return { name: false, amount: false, kind: false, problems };
  }
  want.forEach((w, i) => {
    const g = got[i];
    if (w.name === null) {
      if (g.matches.length) { name = false; problems.push(`#${i} name: expected no match, got ${JSON.stringify(g.matches)}`); }
    } else if (Array.isArray(w.name)) {
      const top = g.matches[0]?.score ?? -1;
      const tied = g.matches.filter((m) => m.score === top).map((m) => m.id).sort();
      if (JSON.stringify(tied) !== JSON.stringify([...w.name].sort())) {
        name = false;
        problems.push(`#${i} name: expected tie ${w.name}, got ${JSON.stringify(g.matches)}`);
      }
    } else {
      const ok = g.matches[0]?.id === w.name && (g.matches.length < 2 || g.matches[1].score < g.matches[0].score);
      if (!ok) { name = false; problems.push(`#${i} name: expected ${w.name}, got ${JSON.stringify(g.matches)} (${g.name_text})`); }
    }
    if (w.name_text !== undefined && g.name_text !== w.name_text) { name = false; problems.push(`#${i} name_text: ${g.name_text} != ${w.name_text}`); }
    const wantPaise = w.amount === null ? null : Math.round(w.amount * 100);
    if (g.amount_paise !== wantPaise) { amount = false; problems.push(`#${i} amount: ${g.amount_paise} != ${wantPaise}`); }
    if (g.kind !== w.kind) { kind = false; problems.push(`#${i} kind: ${g.kind} (${g.kind_reason}) != ${w.kind}`); }
    if (w.kind_reason !== undefined && g.kind_reason !== w.kind_reason) { kind = false; problems.push(`#${i} kind_reason: ${g.kind_reason} != ${w.kind_reason}`); }
    if (w.note !== undefined && g.note !== w.note) { problems.push(`#${i} note: ${g.note} != ${w.note}`); }
    if (w.confidence !== undefined && g.confidence !== w.confidence) { problems.push(`#${i} confidence: ${g.confidence} != ${w.confidence}`); }
    if (w.confidence_max !== undefined && CONF_RANK[g.confidence] > CONF_RANK[w.confidence_max]) { problems.push(`#${i} confidence ${g.confidence} above ${w.confidence_max}`); }
    if (w.amount_text !== undefined && g.amount_text !== w.amount_text) { amount = false; problems.push(`#${i} amount_text: ${g.amount_text} != ${w.amount_text}`); }
    if (w.amount_alternatives !== undefined) {
      const got = [...(g.amount_alternatives ?? [])].sort((a, b) => a - b);
      const want = w.amount_alternatives.map((r) => Math.round(r * 100)).sort((a, b) => a - b);
      if (JSON.stringify(got) !== JSON.stringify(want)) { amount = false; problems.push(`#${i} amount_alternatives: ${JSON.stringify(got)} != ${JSON.stringify(want)}`); }
    }
    if (w.context_kept !== undefined && g.context_kept !== w.context_kept) { name = false; problems.push(`#${i} context_kept: ${g.context_kept} != ${w.context_kept}`); }
  });
  return { name, amount, kind, problems };
}

const stats = new Map<string, { n: number; name: number; amount: number; kind: number; all: number }>();
const weakFailures: string[] = [];

describe('voice fixture: utterances -> intents', () => {
  const all = cases as unknown as Case[];
  it('has at least 150 cases', () => {
    expect(all.length).toBeGreaterThanOrEqual(150);
  });
  for (const c of all) {
    const label = `[${c.cat}] ${c.alts.join(' || ')}`;
    it(label, () => {
      const got = parseUtterance(c.alts, SETS[c.customers], c.settings, c.context ? { contextCustomerId: c.context } : {});
      const want = Array.isArray(c.expect) ? c.expect : [c.expect];
      const r = check(got, want);
      const s = stats.get(c.cat) ?? { n: 0, name: 0, amount: 0, kind: 0, all: 0 };
      s.n++;
      if (r.name) s.name++;
      if (r.amount) s.amount++;
      if (r.kind) s.kind++;
      if (!r.problems.length) s.all++;
      stats.set(c.cat, s);
      if (c.known_weak) {
        if (r.problems.length) weakFailures.push(`${label}: ${r.problems.join('; ')} [known weak: ${c.known_weak}]`);
        return;
      }
      expect(r.problems, label).toEqual([]);
      // Safety invariants on every intent
      for (const g of got) {
        expect(['high', 'medium', 'low']).toContain(g.confidence);
        if (g.confidence === 'high') {
          expect(g.amount_paise).not.toBeNull();
          expect(g.amount_text).toBeTruthy();
          expect(g.amount_alternatives).toBeUndefined();
          expect(g.kind).not.toBeNull();
          // never from the shop setting, a dative alone, a fuzzy verb, a mixed vote or an item guess
          expect(g.kind_reason).not.toMatch(/bare-kuduthaachu|dative|~|^mixed|^item|^noun|^conflict|^inherited/);
          expect(g.matches.length).toBeGreaterThan(0);
          expect(g.matches[0].score).toBeGreaterThanOrEqual(0.85);
          if (g.matches.length > 1) expect(g.matches[0].score - g.matches[1].score).toBeGreaterThanOrEqual(0.1);
        }
        if (g.amount_paise !== null) {
          expect(g.amount_text).toBeTruthy();
          expect(g.heard.normalize('NFC')).toContain(g.amount_text!);
        } else {
          expect(g.amount_text).toBeUndefined();
        }
        if (g.amount_alternatives) {
          expect(g.confidence).not.toBe('high');
          expect(g.amount_alternatives).not.toContain(g.amount_paise);
        }
        if (g.kind_reason === 'bare-kuduthaachu') expect(g.confidence).not.toBe('high');
        expect(g.matches.length).toBeLessThanOrEqual(3);
        expect(g.heard.length).toBeGreaterThan(0);
      }
    });
  }
  afterAll(() => {
    const rows = [...stats.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const pct = (a: number, n: number) => `${((100 * a) / n).toFixed(1)}%`.padStart(7);
    const lines = ['', 'Voice parser accuracy by category (name / amount / kind / all fields):'];
    let T = { n: 0, name: 0, amount: 0, kind: 0, all: 0 };
    for (const [cat, s] of rows) {
      lines.push(`  ${cat.padEnd(22)} n=${String(s.n).padStart(3)}  name${pct(s.name, s.n)}  amount${pct(s.amount, s.n)}  kind${pct(s.kind, s.n)}  all${pct(s.all, s.n)}`);
      T = { n: T.n + s.n, name: T.name + s.name, amount: T.amount + s.amount, kind: T.kind + s.kind, all: T.all + s.all };
    }
    lines.push(`  ${'TOTAL'.padEnd(22)} n=${String(T.n).padStart(3)}  name${pct(T.name, T.n)}  amount${pct(T.amount, T.n)}  kind${pct(T.kind, T.n)}  all${pct(T.all, T.n)}`);
    if (weakFailures.length) lines.push('  Known weak cases still failing:', ...weakFailures.map((w) => `    - ${w}`));
    // process.stdout: vitest's default reporter hides console.log from hooks when every test passes
    process.stdout.write(`${lines.join('\n')}\n\n`);
  });
});

// ------------------------------------------------------------------ parseAmount

describe('parseAmount', () => {
  const rupees = (s: string) => {
    const r = parseAmount(s);
    return r ? r.paise / 100 : null;
  };
  it('digits, grouping, decimals, Tamil digits', () => {
    expect(rupees('100')).toBe(100);
    expect(rupees('1,500')).toBe(1500);
    expect(rupees('1,25,000')).toBe(125000);
    expect(rupees('12,500')).toBe(12500);
    expect(rupees('12.50')).toBe(12.5);
    expect(rupees('௧௫௦')).toBe(150);
    expect(rupees('₹250')).toBe(250);
    expect(rupees('Rs.75')).toBe(75);
    expect(rupees('100ரூபாய்')).toBe(100);
    expect(rupees('rs100')).toBe(100);
  });
  it('rupee words', () => {
    expect(rupees('100 rupees')).toBe(100);
    expect(rupees('100 ரூபாய்')).toBe(100);
    expect(rupees('100 rubaa')).toBe(100);
    expect(rupees('நூறு ரூபா')).toBe(100);
    expect(rupees('100 rupees 50 paise')).toBe(100.5);
  });
  it('Tamil number words', () => {
    expect(rupees('ஒன்று')).toBe(1);
    expect(rupees('onnu')).toBe(1);
    expect(rupees('rendu')).toBe(2);
    expect(rupees('இரண்டு')).toBe(2);
    expect(rupees('moonu')).toBe(3);
    expect(rupees('naalu')).toBe(4);
    expect(rupees('anju')).toBe(5);
    expect(rupees('ஆறு')).toBe(6);
    expect(rupees('ஏழு')).toBe(7);
    expect(rupees('எட்டு')).toBe(8);
    expect(rupees('ஒன்பது')).toBe(9);
    expect(rupees('pathu')).toBe(10);
    expect(rupees('பதினஞ்சு')).toBe(15);
    expect(rupees('irupathu')).toBe(20);
    expect(rupees('முப்பது')).toBe(30);
    expect(rupees('நாப்பது')).toBe(40);
    expect(rupees('ambathu')).toBe(50);
    expect(rupees('ஐம்பது')).toBe(50);
    expect(rupees('அறுபது')).toBe(60);
    expect(rupees('எழுபது')).toBe(70);
    expect(rupees('எண்பது')).toBe(80);
    expect(rupees('தொண்ணூறு')).toBe(90);
    expect(rupees('nooru')).toBe(100);
    expect(rupees('irunooru')).toBe(200);
    expect(rupees('munnooru')).toBe(300);
    expect(rupees('நானூறு')).toBe(400);
    expect(rupees('ainooru')).toBe(500);
    expect(rupees('அறுநூறு')).toBe(600);
    expect(rupees('எழுநூறு')).toBe(700);
    expect(rupees('எண்ணூறு')).toBe(800);
    expect(rupees('தொள்ளாயிரம்')).toBe(900);
    expect(rupees('aayiram')).toBe(1000);
    expect(rupees('ரெண்டாயிரம்')).toBe(2000);
    expect(rupees('பத்தாயிரம்')).toBe(10000);
    expect(rupees('laksham')).toBe(100000);
    expect(rupees('ஒரு லட்சம்')).toBe(100000);
  });
  it('Tamil combinations', () => {
    expect(rupees('ஆயிரத்து ஐநூறு')).toBe(1500);
    expect(rupees('ரெண்டாயிரத்து முந்நூத்தி அம்பது')).toBe(2350);
    expect(rupees('நூத்தி இருபது')).toBe(120);
    expect(rupees('irunoothi ambathu')).toBe(250);
    expect(rupees('irupathanju')).toBe(25);
    expect(rupees('muppathanju')).toBe(35);
    expect(rupees('rendarai aayiram')).toBe(2500);
    expect(rupees('ரெண்டு நூறு')).toBe(200);
    expect(rupees('அஞ்சு ஆயிரம்')).toBe(5000);
    expect(rupees('ஆயிரத்து நூறு')).toBe(1100);
    expect(rupees('ரெண்டு லட்சத்து ஐம்பதாயிரம்')).toBe(250000);
  });
  it('English number words', () => {
    expect(rupees('one fifty')).toBe(150);
    expect(rupees('two fifty')).toBe(250);
    expect(rupees('twelve fifty')).toBe(1250);
    expect(rupees('fifteen hundred')).toBe(1500);
    expect(rupees('two thousand five hundred')).toBe(2500);
    expect(rupees('one hundred and twenty')).toBe(120);
    expect(rupees('a hundred')).toBe(100);
    expect(rupees('twenty-five')).toBe(25);
    expect(rupees('seventy five')).toBe(75);
    expect(rupees('two and a half thousand')).toBe(2500);
    expect(rupees('one lakh fifty thousand')).toBe(150000);
    expect(rupees('2 thousand')).toBe(2000);
    expect(rupees('1.5 lakh')).toBe(150000);
    expect(rupees('5 hundred')).toBe(500);
  });
  it('skips quantities, codes, phone numbers; handles corrections', () => {
    expect(rupees('2 kilo sakkarai 120')).toBe(120);
    expect(rupees('arisi 5 கிலோ 300')).toBe(300);
    expect(rupees('C 42 500')).toBe(500);
    expect(rupees('9876543210 200')).toBe(200);
    expect(rupees('100 illa 150')).toBe(150);
    expect(rupees('100 no sorry 120')).toBe(120);
    expect(rupees('2 muttai 20 rupees')).toBe(20);
  });
  it('rejects zero, too large and empty', () => {
    expect(parseAmount('0')).toBeNull();
    expect(parseAmount('Ramu kuduthaan')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(String(MAX_AMOUNT_PAISE))).toBeNull();
    expect(parseAmount('12.345')).toBeNull();
    expect(parseAmount('half')).toBeNull();
  });
  it('returns the span of the amount', () => {
    const s = 'Ramu 1,500 kuduthaan';
    const r = parseAmount(s)!;
    expect(s.slice(r.span[0], r.span[1])).toBe('1,500');
    const t = 'முருகன் ஆயிரத்து ஐநூறு கட்டினான்';
    const q = parseAmount(t)!;
    expect(t.slice(q.span[0], q.span[1])).toBe('ஆயிரத்து ஐநூறு');
  });
  it('does not read names as numbers', () => {
    expect(parseAmount('Patel kuduthaan')).toBeNull();
    expect(parseAmount('Arun vaanginaan')).toBeNull();
    expect(parseAmount('Muni')).toBeNull();
  });
});

// ------------------------------------------------------------------ detectKind

describe('detectKind', () => {
  const k = (s: string, st?: Partial<VoiceSettings>) => detectKind(s, st).kind;
  it('client semantics', () => {
    expect(k('Ramu 100 kuduthaachu')).toBe('RECEIVE');
    expect(detectKind('Ramu 100 kuduthaachu').reason).toBe('bare-kuduthaachu');
    expect(k('Ramu-kku 100 kuduthaachu')).toBe('GIVE');
    expect(detectKind('Ramu-kku 100 kuduthaachu').dativeName).toBe(true);
    expect(detectKind('Ramu 100 kuduthaachu').dativeName).toBe(false);
    expect(k('Ramukku 100 kuduthen')).toBe('GIVE');
    expect(k('vaanginaan')).toBe('GIVE');
    expect(k('vaangitaan')).toBe('GIVE');
    expect(k('eduthaan')).toBe('GIVE');
    expect(k('kattinaan')).toBe('RECEIVE');
    expect(k('settle pannitaan')).toBe('RECEIVE');
    expect(k('kuduthaan')).toBe('RECEIVE');
    expect(k('kuduthaaru')).toBe('RECEIVE');
    expect(k('kanakkula ezhuthu')).toBe('GIVE');
    expect(k('kanakkula podu')).toBe('GIVE');
  });
  it('setting flips only the bare kuduthaachu', () => {
    expect(k('Ramu 100 kuduthaachu', { bareKuduthaachu: 'GIVE' })).toBe('GIVE');
    expect(k('Ramu 100 kuduthaan', { bareKuduthaachu: 'GIVE' })).toBe('RECEIVE');
    expect(k('Ramukku 100 kuduthaachu', { bareKuduthaachu: 'GIVE' })).toBe('GIVE');
  });
  it('English', () => {
    expect(k('paid')).toBe('RECEIVE');
    expect(k('Ramu gave 100')).toBe('RECEIVE');
    expect(k('gave to Ramu')).toBe('GIVE');
    expect(k('I gave Ramu 100')).toBe('GIVE');
    expect(k('took')).toBe('GIVE');
    expect(k('bought')).toBe('GIVE');
    expect(k('debit')).toBe('GIVE');
    expect(k('credit')).toBe('RECEIVE');
    expect(k('credit-la podu')).toBe('GIVE');
    expect(k('creditla')).toBe('GIVE');
    expect(k('on credit')).toBe('GIVE');
  });
  it('app labels are matched raw, never folded: paaru (look) is not patru (finding 21)', () => {
    expect(k('பற்று')).toBe('GIVE');
    expect(k('patru')).toBe('GIVE');
    expect(k('pattru')).toBe('GIVE');
    expect(k('வரவு')).toBe('RECEIVE');
    expect(k('Ramu 100 paaru')).toBeNull();
    expect(k('ராமு 100 பாரு')).toBeNull();
    expect(k('paru')).toBeNull();
    expect(k('parru')).toBeNull();
    expect(k('paaru')).toBeNull();
    expect(FOLDED_CUE_KEYS.has('paru')).toBe(false);
    expect(FOLDED_CUE_KEYS.has('patru')).toBe(false);
    expect(FOLDED_CUE_KEYS.has('varavu')).toBe(false);
  });
  it('Tamil labels and nouns', () => {
    expect(k('பற்று')).toBe('GIVE');
    expect(k('வரவு')).toBe('RECEIVE');
    expect(k('varavu podu')).toBe('RECEIVE');
    expect(k('kadan')).toBe('GIVE');
    expect(k('kadan kattinaan')).toBe('RECEIVE'); // verbs outrank nouns
    expect(k('udhaar')).toBe('GIVE');
    expect(k('gpay')).toBe('RECEIVE');
    expect(k('panam vanthuchu')).toBe('RECEIVE');
  });
  it('speaker and recipient', () => {
    expect(k('kuduthen')).toBe('GIVE');
    expect(k('kuduthom')).toBe('GIVE');
    expect(k('Ramu kitta vaanginen')).toBe('RECEIVE');
    expect(k('Ramu kitta kuduthen')).toBe('GIVE');
    expect(k('naan kuduthaachu')).toBe('GIVE');
    expect(k('enakku kuduthaachu')).toBe('RECEIVE');
    expect(k('avanukku kuduthaachu')).toBe('GIVE');
  });
  it('unclear and negated directions are null', () => {
    expect(k('Ramu 100')).toBeNull();
    expect(k('')).toBeNull();
    expect(k('Ramu kudukkala')).toBeNull();
    expect(detectKind('Ramu kudukkala').reason).toMatch(/^negated/);
    expect(k('kattinaan vaanginaan')).toBeNull(); // equal opposite verbs
    expect(k('Ramu 100 kudu')).toBeNull();
  });
  it('morphological fallbacks and misspellings', () => {
    expect(k('kuduthuttaanga')).toBe('RECEIVE');
    expect(k('vaangikittaanga')).toBe('GIVE');
    expect(k('கட்டிட்டாங்க')).toBe('RECEIVE');
    expect(k('kuduthachu')).toBe('RECEIVE');
    expect(k('vanginan')).toBe('GIVE');
    expect(k('kattinan')).toBe('RECEIVE');
    expect(k('vaanginaaan')).toBe('GIVE');
  });
  it('lexicon has at least 50 forms', () => {
    expect(LEXICON_SIZE).toBeGreaterThanOrEqual(50);
  });
});

// ------------------------------------------------------------------ matchCustomers

describe('matchCustomers', () => {
  const top = (q: string, cs = DEFAULT) => matchCustomers(q, cs)[0]?.id ?? null;
  it('exact, transliterated and folded names', () => {
    expect(top('Ramu')).toBe('ramu');
    expect(top('ராமு')).toBe('ramu');
    expect(top('Seetha')).toBe('sita');
    expect(top('சீதா')).toBe('sita');
    expect(top('Murugan')).toBe('murugan');
    expect(top('Lakshmi')).toBe('lakshmi');
    expect(top('Laxmi')).toBe('lakshmi');
    expect(top('Sendhil')).toBe('senthil');
    expect(top('Fatima')).toBe('fathima');
    expect(top('கார்த்திக்')).toBe('karthik');
    expect(top('Kumaru')).toBe('kumar');
  });
  it('first word of a longer name', () => {
    const r = matchCustomers('Velu', DEFAULT);
    expect(r[0].id).toBe('velu');
    expect(r[0].score).toBeGreaterThanOrEqual(0.9);
    expect(top('Velu Tea Kadai')).toBe('velu');
  });
  it('same-name customers tie', () => {
    const r = matchCustomers('Ramu', TWO_RAMUS);
    expect(r.map((m) => m.id).sort()).toEqual(['ramu', 'ramu_b']);
    expect(r[0].score).toBe(r[1].score);
  });
  it('codes', () => {
    expect(matchCustomers('C-0042', DEFAULT)).toEqual([{ id: 'mani', score: 1 }]);
    expect(matchCustomers('C 42', DEFAULT)).toEqual([{ id: 'mani', score: 1 }]);
    expect(matchCustomers('code 7', DEFAULT)).toEqual([{ id: 'ravi', score: 1 }]);
    expect(matchCustomers('C 999', DEFAULT)).toEqual([]);
  });
  it('ignores erased and archived-without-balance customers', () => {
    expect(top('Babu')).toBeNull();
    expect(top('Raja')).toBeNull();
    expect(top('Devi')).toBe('devi'); // archived but still owes
  });
  it('unknown names, empty input, limit', () => {
    expect(matchCustomers('Gopal', DEFAULT)).toEqual([]);
    expect(matchCustomers('', DEFAULT)).toEqual([]);
    expect(matchCustomers('x', DEFAULT)).toEqual([]);
    expect(matchCustomers('Ramu', TWO_RAMUS, 1)).toHaveLength(1);
    expect(matchCustomers('a', DEFAULT).length).toBeLessThanOrEqual(3);
  });
  it('scores are in 0..1 and sorted', () => {
    const r = matchCustomers('Ravi', DEFAULT);
    for (const m of r) { expect(m.score).toBeGreaterThan(0); expect(m.score).toBeLessThanOrEqual(1); }
    for (let i = 1; i < r.length; i++) expect(r[i - 1].score).toBeGreaterThanOrEqual(r[i].score);
  });
});

// ------------------------------------------------------------------ parseUtterance details

describe('parseUtterance details', () => {
  const one = (alts: string | string[], st?: Partial<VoiceSettings>, cs = DEFAULT) =>
    parseUtterance(Array.isArray(alts) ? alts : [alts], cs, st)[0];
  it('client sample: Ramu 100 kuduthaachu -> Ramu, ₹100, RECEIVE, never high', () => {
    const r = one('Ramu 100 kuduthaachu');
    expect(r).toMatchObject({ name_text: 'Ramu', amount_paise: 10000, amount_text: '100', kind: 'RECEIVE', kind_reason: 'bare-kuduthaachu' });
    expect(r.matches[0]).toEqual({ id: 'ramu', score: 1 });
    // a dropped -kku would flip the meaning, so this is not "high"
    expect(r.confidence).toBe('medium');
  });
  it('confidence', () => {
    expect(one('Ramu 100 kattinaan').confidence).toBe('high');
    expect(one('Ramukku 100 kuduthaachu').confidence).toBe('medium');
    expect(one('Ramu 100').confidence).toBe('low');
    expect(one('Ramu arisi 100').confidence).toBe('low');
    expect(one('Gopal 100 kattinaan').confidence).toBe('low');
    expect(one('Ramu 100 kattinaan', undefined, TWO_RAMUS).confidence).toBe('medium');
    expect(one('Ramu kattinaan').confidence).toBe('low');
  });
  it('extras: date, mode, balance query, ambiguous amount', () => {
    expect(one('நேத்து செல்வி 2000 கட்டினாங்க').date_offset).toBe(-1);
    expect(one('Ramu inniku 100 kattinaan').date_offset).toBe(0);
    expect(one('munthaanethu Ramu 100 kattinaan').date_offset).toBe(-2);
    expect(one('Kumar gpay one fifty').mode).toBe('UPI');
    const q = one('Ramu baaki evvalavu');
    expect(q.balance_query).toBe(true);
    expect(q.kind).toBeNull();
    expect(q.matches[0].id).toBe('ramu');
    const amb = one('Ramu 100 50 kattinaan');
    expect(amb.amount_paise).toBeNull();
    expect(amb.amount_candidates).toEqual([10000, 5000]);
    expect(amb.confidence).toBe('low');
  });
  it('customer code inside a sentence', () => {
    const r = one('C 42 500 kattinaan');
    expect(r.matches).toEqual([{ id: 'mani', score: 1 }]);
    expect(r.amount_paise).toBe(50000);
  });
  it('name correction with illa', () => {
    const r = one('Sita illa Selvi 300 kattinaanga');
    expect(r.matches[0].id).toBe('selvi');
  });
  it('a customer named like a number (Anju) is read as the name when another amount is spoken', () => {
    const r = one('Anju 100 kuduthaachu');
    expect(r.matches[0].id).toBe('anju');
    expect(r.amount_paise).toBe(10000);
    expect(one('Ramu anju rupees kattinaan').amount_paise).toBe(500);
  });
  it('context customer (customer page): no name needed', () => {
    const [r] = parseUtterance(['100 kattinaan'], DEFAULT, undefined, { contextCustomerId: 'ravi' });
    expect(r.matches).toEqual([{ id: 'ravi', score: 1 }]);
    expect(r.name_text).toBeNull();
    expect(r.confidence).toBe('high');
    const [g] = parseUtterance(['ஐநூறு வாங்கினான்'], DEFAULT, undefined, { contextCustomerId: 'ravi' });
    expect(g).toMatchObject({ amount_paise: 50000, kind: 'GIVE' });
  });
  it('dative disagreement between alternatives blanks the direction', () => {
    const r = one(['ராமுக்கு 100 குடுத்தாச்சு', 'ராமு 100 குடுத்தாச்சு']);
    expect(r.kind).toBeNull();
    expect(r.kind_reason).toMatch(/^conflict:dative/);
    expect(r.confidence).toBe('low');
    // a dative alone, not heard by the other alternative
    const d = one(['Ramukku 100', 'Ramu 100']);
    expect(d.kind).toBeNull();
    expect(d.kind_reason).toMatch(/^conflict:dative\(dative\|none\)/);
    // both alternatives agree (setting GIVE): no conflict, but never high
    const g = one(['Ramukku 100 kuduthaachu', 'Ramu 100 kuduthaachu'], { bareKuduthaachu: 'GIVE' });
    expect(g.kind).toBe('GIVE');
    expect(g.confidence).toBe('medium');
    // an explicit verb in both: the dative does not matter
    const v = one(['Ramukku 100 kattinaan', 'Ramu 100 kattinaan']);
    expect(v.kind).toBe('RECEIVE');
    expect(v.confidence).toBe('high');
  });
  it('dative alone is never high', () => {
    const r = one('Ramukku 100');
    expect(r).toMatchObject({ kind: 'GIVE', kind_reason: 'dative', confidence: 'medium' });
    expect(one('I gave Ravi 200').confidence).toBe('high');
    expect(one('gave Ravikku 200')).toMatchObject({ kind: 'GIVE', kind_reason: 'verb:gave+dative', confidence: 'medium' });
  });
  it('amount_text and amount_alternatives (finding 8)', () => {
    expect(one('Ramu ஐநூறு kattinaan')).toMatchObject({ amount_paise: 50000, amount_text: 'ஐநூறு', confidence: 'high' });
    expect(one('Sita aayirathu ainooru kattinaa').amount_text).toBe('aayirathu ainooru');
    expect(one('Ramu 1,500 rupees kattinaan').amount_text).toBe('1,500');
    expect(one('Kumar two fifty paid').amount_text).toBe('two fifty');
    expect(one('Ramu 100 rupees 50 paise kattinaan')).toMatchObject({ amount_paise: 10050, amount_text: '100 rupees 50 paise' });
    expect(one('Ramu kattinaan').amount_text).toBeUndefined();
    const d = one(['Sita ainooru kattinaa', 'Sita aayirathu ainooru kattinaa']);
    expect(d.amount_paise).toBe(50000);
    expect(d.amount_alternatives).toEqual([150000]);
    expect(d.confidence).toBe('medium');
    const same = one(['Ramu 500 kattinaan', 'Ramu 500 kattinaan', 'Ramu 500 kattinan']);
    expect(same.amount_alternatives).toBeUndefined();
    expect(same.confidence).toBe('high');
    const three = one(['Ramu 100 kattinaan', 'Ramu 1000 kattinaan', 'Ramu 10000 kattinaan']);
    expect([...three.amount_alternatives!].sort((a, b) => a - b)).toEqual([100000, 1000000]);
  });
  it('customer page with a spoken name keeps the page customer unless clearly beaten (finding 9)', () => {
    const ctx = (alts: string | string[], id: string, cs = TWO_RAMUS) => parseUtterance(Array.isArray(alts) ? alts : [alts], cs, undefined, { contextCustomerId: id })[0];
    expect(ctx('Ramu 100 kattinaan', 'ramu')).toMatchObject({ matches: [{ id: 'ramu', score: 1 }], context_kept: true, confidence: 'high' });
    expect(ctx('Ramu 100 kattinaan', 'ramu_b')).toMatchObject({ matches: [{ id: 'ramu_b', score: 1 }], context_kept: true, confidence: 'high' });
    expect(ctx('ராமு 200 வாங்கினான்', 'ramu_b')).toMatchObject({ matches: [{ id: 'ramu_b', score: 1 }], kind: 'GIVE', context_kept: true });
    // another customer named: the UI must ask
    const s = ctx('Sita 100 kattinaan', 'ramu');
    expect(s.matches[0].id).toBe('sita');
    expect(s.context_kept).toBe(false);
    const r = ctx('Ramu 100 kattinaan', 'sita');
    expect(r.matches.map((m) => m.id).sort()).toEqual(['ramu', 'ramu_b']);
    expect(r.context_kept).toBe(false);
    // misspelt name still within 0.10 of the best match
    expect(ctx('Raamu 100 kattinaan', 'ramu')).toMatchObject({ matches: [{ id: 'ramu', score: 1 }], context_kept: true });
    expect(ctx('Kumaru 100 kuduthaan', 'kumar', DEFAULT)).toMatchObject({ matches: [{ id: 'kumar', score: 0.95 }], context_kept: true });
    // a spoken code that is not the page customer wins
    expect(ctx('C 42 500 kattinaan', 'ramu', DEFAULT)).toMatchObject({ matches: [{ id: 'mani', score: 1 }], context_kept: false });
    // an unknown name on the page: nothing matched, the page customer is not assumed
    const u = ctx('Gopal 100 kattinaan', 'ramu', DEFAULT);
    expect(u.matches).toEqual([]);
    expect(u.context_kept).toBe(false);
  });
  it('alt_index points at the alternative used', () => {
    const [r] = parseUtterance(['Ramu 100 good at that you', 'Ramu 100 kuduthaachu'], DEFAULT);
    expect(r.alt_index).toBe(1);
    expect(r.heard).toBe('Ramu 100 kuduthaachu');
  });
  it('empty input', () => {
    expect(parseUtterance([], DEFAULT)).toEqual([]);
    expect(parseUtterance(['', '  '], DEFAULT)).toEqual([]);
    const [r] = parseUtterance(['hmm'], DEFAULT);
    expect(r).toMatchObject({ matches: [], amount_paise: null, kind: null, confidence: 'low' });
  });
  it('needsHelp flags unsure intents', () => {
    expect(needsHelp(one('Ramu 100 kattinaan'))).toBe(false);
    expect(needsHelp(one('Ramu 100'))).toBe(true);
  });
  it('is fast enough for 300 customers and 5 alternatives', () => {
    const many: VoiceCustomer[] = [...DEFAULT];
    for (let i = 0; i < 300; i++) many.push({ id: `x${i}`, name: `Customer ${i} ${['Raman', 'Selvam', 'Kannan', 'Mala'][i % 4]}`, search_name: null, code: 100 + i, phone: null, note: null });
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) parseUtterance(['Ramu 100 kuduthaachu', 'ராமு 100 குடுத்தாச்சு', 'Ramu 100 kuduthachu', 'Ramu nooru kuduthaachu', 'Ramu 100 kodutachu'], many);
    expect((performance.now() - t0) / 5).toBeLessThan(250);
  });
});
