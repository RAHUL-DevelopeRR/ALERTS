/**
 * NLU review: 120 NEW shop utterances (none copied from test/fixtures/voice-utterances.json) written the way a
 * Tamil Nadu kirana owner and the shop boys actually talk: Tamil script as Google's recogniser outputs it,
 * Tanglish, mixed script, numbers in words, recogniser misspellings, dative vs subject on confusable names
 * (ராமு / ராம் / ராமன், முருகன் / முருகேசன், செல்வி / செல்வம்), honorifics, fillers (பாரு / paaru, சரி, okay),
 * both directions. Each case carries the expected {name, amount, kind}.
 *
 * The suite is a report AND a guard:
 *  - every case is run through parseUtterance and name / amount / kind accuracy is printed per category,
 *    together with every WRONG direction (opposite of what was meant), every unsure (null) direction and
 *    every 'high' confidence that was wrong;
 *  - a case without `known` must match exactly (name, amount, kind) or the test fails;
 *  - a case with `known` documents a parser gap found by this review: it passes either way, is listed in the
 *    report under KNOWN GAPS, and says "now passes" when a later voice-core fix closes it (then drop the marker);
 *  - the money-safety invariant is enforced on every case, known or not: a 'high' intent must never carry a
 *    wrong name, amount or direction.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { parseUtterance, type VoiceCustomer, type VoiceIntent, type VoiceSettings } from '../src/core/voice';
import { NEW_NAME_BELOW } from '../src/ui/voice/plan';
import fixtures from './fixtures/voice-utterances.json';

type Kind = 'GIVE' | 'RECEIVE' | null;
interface Want { name: string | null; amount: number | null; kind: Kind }
interface Case {
  cat: string;
  alts: string[];
  expect: Want | Want[];
  settings?: Partial<VoiceSettings>;
  context?: string;
  /** why the expected reading is what a native speaker means (for the report) */
  why?: string;
  /** documented parser gap (this review's finding): the case may mismatch without failing the suite */
  known?: string;
  /**
   * The documented gap currently also breaks the money-safety invariant (a 'high' intent with a wrong field).
   * Such a case runs under `it.fails`, like the server review's R2 tests: it passes while the bug exists and
   * fails as soon as voice-core fixes it, so the marker gets removed.
   */
  unsafe?: true;
}

const c = (id: string, name: string, search_name: string | null = null, code = 0): VoiceCustomer =>
  ({ id, name, search_name, code, phone: null, note: null });

/** A realistic shop list with confusable names: ராமு / ராம் / ராமன், முருகன் / முருகேசன், செல்வி / செல்வம். */
const SHOP: VoiceCustomer[] = [
  c('ramu', 'Ramu', null, 1), c('ram', 'ராம்', 'raam', 2), c('raman', 'ராமன்', 'raaman', 3),
  c('murugan', 'முருகன்', 'murugan', 4), c('murugesan', 'முருகேசன்', 'murugesan', 5),
  c('sita', 'சீதா', 'seetha', 6), c('selvi', 'Selvi', null, 7), c('selvam', 'Selvam', null, 8),
  c('kumar', 'Kumar', null, 9), c('lakshmi', 'லட்சுமி', 'latchumi', 10), c('ravi', 'Ravi', null, 11),
  c('meena', 'மீனா', 'meena', 12), c('karthik', 'Karthik', null, 13), c('ganesh', 'Ganesh', null, 14),
  c('pandi', 'பாண்டி', 'pandi', 15), c('saravanan', 'சரவணன்', 'saravanan', 16), c('priya', 'Priya', null, 17),
  c('muthu', 'Muthu', null, 18), c('senthil', 'Senthil', null, 19), c('fathima', 'Fathima', null, 20),
  c('devi', 'Devi', null, 21), c('mani', 'Mani', null, 22), c('velu', 'Velu', null, 23), c('babu', 'Babu', null, 24),
  c('raja', 'Raja', null, 25), c('anbu', 'Anbu', null, 26), c('kalai', 'Kalai', null, 27), c('suresh', 'Suresh', null, 28),
  c('mohan', 'Mohan', null, 29), c('gopal', 'Gopal', null, 30), c('rajesh', 'Rajesh', null, 31),
  c('nagaraj', 'Nagaraj', null, 32), c('jothi', 'Jothi', null, 33), c('palani', 'பழனி', 'palani', 34),
  c('kannan', 'கண்ணன்', 'kannan', 35), c('balu', 'Balu', null, 36),
];

const G = 'GIVE' as const;
const R = 'RECEIVE' as const;

export const CASES: Case[] = [
  // ---------------------------------------------------------------- Tamil script, as Google writes it (26)
  { cat: 'ta_script', alts: ['ராமு நூத்தி அம்பது ரூபா கட்டிட்டான்'], expect: { name: 'ramu', amount: 150, kind: R } },
  { cat: 'ta_script', alts: ['ராமனுக்கு ரெண்டு கிலோ அரிசி நூத்தி இருபது'], expect: { name: 'raman', amount: 120, kind: G }, why: 'dative -க்கு, goods, no verb: he took rice on udhaar' },
  { cat: 'ta_script', alts: ['ராம் ஐநூறு ரூபாய் கொடுத்துட்டு போனாரு'], expect: { name: 'ram', amount: 500, kind: R }, why: 'he handed the money over and left' },
  { cat: 'ta_script', alts: ['முருகேசன் கணக்குல முன்னூறு எழுதிடு'], expect: { name: 'murugesan', amount: 300, kind: G } },
  { cat: 'ta_script', alts: ['முருகன் முன்னூறு தந்துட்டு போயிட்டான்'], expect: { name: 'murugan', amount: 300, kind: R } },
  { cat: 'ta_script', alts: ['சீதா அக்கா பழைய பாக்கி எல்லாம் கட்டிட்டாங்க ஆயிரம்'], expect: { name: 'sita', amount: 1000, kind: R }, why: 'amount said after the verb, as an afterthought' },
  { cat: 'ta_script', alts: ['செல்வி கிட்ட இருந்து 250 வந்துச்சு'], expect: { name: 'selvi', amount: 250, kind: R } },
  { cat: 'ta_script', alts: ['குமார் பால் பாக்கெட் ரெண்டு 60 ரூபா'], expect: { name: 'kumar', amount: 60, kind: G }, why: 'items + price, no verb: took on udhaar (weak)' },
  { cat: 'ta_script', alts: ['லட்சுமி அம்மா 500 ரூபா கையில குடுத்தாங்க'], expect: { name: 'lakshmi', amount: 500, kind: R }, why: 'கையில = in hand (cash)' },
  { cat: 'ta_script', alts: ['ரவி ஜிபே பண்ணிட்டான் 1200'], expect: { name: 'ravi', amount: 1200, kind: R } },
  { cat: 'ta_script', alts: ['மீனா பாக்கி 300 இன்னும் கட்டல'], expect: { name: 'meena', amount: 300, kind: null }, why: 'has not paid yet: no entry' },
  { cat: 'ta_script', alts: ['கார்த்திக் 650 ரூபாய்க்கு சாமான் எடுத்துட்டு போயிட்டான்'], expect: { name: 'karthik', amount: 650, kind: G } },
  { cat: 'ta_script', alts: ['கணேஷ் கிட்ட ஐநூறு வாங்கிக்கிட்டேன்'], expect: { name: 'ganesh', amount: 500, kind: R }, why: 'I took 500 from Ganesh = he paid' },
  { cat: 'ta_script', alts: ['பாண்டி சிகரெட் 20 ரூபா எடுத்தான்'], expect: { name: 'pandi', amount: 20, kind: G } },
  { cat: 'ta_script', alts: ['சரவணன் மொத்தமா 2500 கட்டி முடிச்சுட்டாரு'], expect: { name: 'saravanan', amount: 2500, kind: R }, why: 'கட்டி முடிச்சுட்டாரு = finished paying (participle + "finish" auxiliary)' },
  { cat: 'ta_script', alts: ['பிரியா முட்டை ஒரு டஜன் 72 வாங்கிட்டா'], expect: { name: 'priya', amount: 72, kind: G } },
  { cat: 'ta_script', alts: ['முத்து அண்ணன் எழுநூறு ரூபா கட்டுனாரு'], expect: { name: 'muthu', amount: 700, kind: R } },
  { cat: 'ta_script', alts: ['செந்தில் ஆயிரம் ரூபா கடன் கேட்டான் குடுத்துட்டேன்'], expect: { name: 'senthil', amount: 1000, kind: G } },
  { cat: 'ta_script', alts: ['பாத்திமா 220 ரூபா காசு குடுத்தாங்க'], expect: { name: 'fathima', amount: 220, kind: R } },
  { cat: 'ta_script', alts: ['மணி ஆயிரத்து ஐநூறு உதாரி வாங்கினான்'], expect: { name: 'mani', amount: 1500, kind: G } },
  { cat: 'ta_script', alts: ['வேலு பழைய கணக்கு 800 தீர்த்துட்டாரு'], expect: { name: 'velu', amount: 800, kind: R }, why: 'கணக்கு தீர்த்துட்டாரு = settled the account (paid)' },
  { cat: 'ta_script', alts: ['பாபு டீ பொடி சோப்பு எல்லாம் சேர்த்து 160'], expect: { name: 'babu', amount: 160, kind: G }, why: 'items + total, no verb: took goods (weak)' },
  { cat: 'ta_script', alts: ['ராஜா நூத்தி அம்பது திருப்பி தந்துட்டான்'], expect: { name: 'raja', amount: 150, kind: R } },
  { cat: 'ta_script', alts: ['அன்பு 2000 அனுப்பிட்டான் போன்பேல'], expect: { name: 'anbu', amount: 2000, kind: R } },
  { cat: 'ta_script', alts: ['ராமு வரவு வைங்க இருநூறு'], expect: { name: 'ramu', amount: 200, kind: R } },
  { cat: 'ta_script', alts: ['ராமன் கடைக்கு வந்து 300 கட்டிட்டு போனான்'], expect: { name: 'raman', amount: 300, kind: R } },
  // ---------------------------------------------------------------- numbers in words (16)
  { cat: 'ta_numbers', alts: ['சுரேஷ் ஆயிரத்து எண்ணூத்தி அம்பது கட்டினாரு'], expect: { name: 'suresh', amount: 1850, kind: R } },
  { cat: 'ta_numbers', alts: ['மோகன் ரெண்டு நூறு வாங்கினான்'], expect: { name: 'mohan', amount: 200, kind: G }, why: 'colloquial ரெண்டு நூறு = 200' },
  { cat: 'ta_numbers', alts: ['கோபால் ஒன்னரை ஆயிரம் கட்டிட்டான்'], expect: { name: 'gopal', amount: 1500, kind: R } },
  { cat: 'ta_numbers', alts: ['ராஜேஷ் மூணு நூத்தி இருபது ரூபா வாங்கினான்'], expect: { name: 'rajesh', amount: 320, kind: G } },
  { cat: 'ta_numbers', alts: ['நாகராஜ் அஞ்சு நூறு கட்டினான்'], expect: { name: 'nagaraj', amount: 500, kind: R } },
  { cat: 'ta_numbers', alts: ['ஜோதி எழுபத்தி அஞ்சு ரூபா எடுத்தா'], expect: { name: 'jothi', amount: 75, kind: G }, why: 'எழுபத்தி அஞ்சு (spoken form of எழுபத்தைந்து)' },
  { cat: 'ta_numbers', alts: ['பழனி பத்தொன்பது ரூபா பிஸ்கட்'], expect: { name: 'palani', amount: 19, kind: G } },
  { cat: 'ta_numbers', alts: ['கண்ணன் நாலாயிரத்து ஐநூத்தி அறுபது கட்டினான்'], expect: { name: 'kannan', amount: 4560, kind: R } },
  { cat: 'ta_numbers', alts: ['பாலு இருநூத்தி ஐம்பத்தஞ்சு கட்டினான்'], expect: { name: 'balu', amount: 255, kind: R } },
  { cat: 'ta_numbers', alts: ['Ramu aayiram rooba kuduthutu ponan'], expect: { name: 'ramu', amount: 1000, kind: R } },
  { cat: 'ta_numbers', alts: ['Kumar moonu aayirathu nooru kattittaaru'], expect: { name: 'kumar', amount: 3100, kind: R } },
  { cat: 'ta_numbers', alts: ['Murugan arai kilo sakkarai 25 vaanginaan'], expect: { name: 'murugan', amount: 25, kind: G }, why: 'arai kilo = half a kilo, not an amount' },
  { cat: 'ta_numbers', alts: ['Selvi one and half thousand kattinaanga'], expect: { name: 'selvi', amount: 1500, kind: R } },
  { cat: 'ta_numbers', alts: ['Senthil rendu aayiram anjooru kattinaan'], expect: { name: 'senthil', amount: 2500, kind: R }, why: 'anjooru = ஐநூறு as many Tanglish speakers spell it' },
  { cat: 'ta_numbers', alts: ['லட்சுமி பதினெட்டு ரூபா பேஸ்ட்'], expect: { name: 'lakshmi', amount: 18, kind: G } },
  { cat: 'ta_numbers', alts: ['ராஜா ஆயிரத்தி ஐநூத்தி ஐம்பது'], expect: { name: 'raja', amount: 1550, kind: null }, why: 'no verb at all: the UI must ask' },
  // ---------------------------------------------------------------- Tanglish (22)
  { cat: 'tanglish', alts: ['Ramu ku nooru rooba saaman kuduthen'], expect: { name: 'ramu', amount: 100, kind: G }, why: 'separate -ku particle + I gave' },
  { cat: 'tanglish', alts: ['Raman 100 rooba kuduthutaan'], expect: { name: 'raman', amount: 100, kind: R } },
  { cat: 'tanglish', alts: ['Ram anna 500 kattitaaru paaru'], expect: { name: 'ram', amount: 500, kind: R } },
  { cat: 'tanglish', alts: ['Murugesan kadaila 300 ku saaman vaangunaaru'], expect: { name: 'murugesan', amount: 300, kind: G } },
  { cat: 'tanglish', alts: ['Murugan kitta 1000 vaangikitten'], expect: { name: 'murugan', amount: 1000, kind: R } },
  { cat: 'tanglish', alts: ['Seetha akka 120 paal kanakkula ezhuthunga'], expect: { name: 'sita', amount: 120, kind: G } },
  { cat: 'tanglish', alts: ['Selvi innaikku 2 kilo arisi 90 eduthaanga'], expect: { name: 'selvi', amount: 90, kind: G } },
  { cat: 'tanglish', alts: ['Kumar anna full ah settle pannitaaru 1500'], expect: { name: 'kumar', amount: 1500, kind: R } },
  { cat: 'tanglish', alts: ['Lakshmi gpay la 450 anuppinaanga'], expect: { name: 'lakshmi', amount: 450, kind: R } },
  { cat: 'tanglish', alts: ['Ravi 75 rooba udhaar la eduthaan'], expect: { name: 'ravi', amount: 75, kind: G } },
  { cat: 'tanglish', alts: ['Meena 200 kuduthuttu ponaanga'], expect: { name: 'meena', amount: 200, kind: R } },
  { cat: 'tanglish', alts: ['Karthik ku 600 rooba cash kuduthom'], expect: { name: 'karthik', amount: 600, kind: G } },
  { cat: 'tanglish', alts: ['Ganesh oru 350 kattinaan'], expect: { name: 'ganesh', amount: 350, kind: R }, why: 'oru = "a" (article), not 1' },
  { cat: 'tanglish', alts: ['Pandi baaki motham 1000 kattitaan'], expect: { name: 'pandi', amount: 1000, kind: R } },
  { cat: 'tanglish', alts: ['Saravanan 40 rooba beedi eduthukittu poitaan'], expect: { name: 'saravanan', amount: 40, kind: G } },
  { cat: 'tanglish', alts: ['Muthu nethu 300 thanthaaru'], expect: { name: 'muthu', amount: 300, kind: R } },
  { cat: 'tanglish', alts: ['Fathima 2 thousand kattiruchu'], expect: { name: 'fathima', amount: 2000, kind: R }, why: 'kattiruchu / கட்டிருச்சு = (payment) got paid' },
  { cat: 'tanglish', alts: ['Mani 800 cash la thanthaan'], expect: { name: 'mani', amount: 800, kind: R } },
  { cat: 'tanglish', alts: ['Velu-kku 150 kudu'], expect: { name: 'velu', amount: 150, kind: G }, why: 'imperative "give him 150" (goods / cash on udhaar)' },
  { cat: 'tanglish', alts: ['Balu 1000 katnan'], expect: { name: 'balu', amount: 1000, kind: R }, why: 'recogniser drops the vowel: kattinaan' },
  { cat: 'tanglish', alts: ['Mohan 250 rooba thirumba kuduthaan'], expect: { name: 'mohan', amount: 250, kind: R } },
  { cat: 'tanglish', alts: ['Nagaraj kaasu 700 kuduthaaru'], expect: { name: 'nagaraj', amount: 700, kind: R } },
  // ---------------------------------------------------------------- mixed script (8)
  { cat: 'mixed', alts: ['Anbu 500 rupees கட்டிட்டு போனான்'], expect: { name: 'anbu', amount: 500, kind: R } },
  { cat: 'mixed', alts: ['கலை two hundred rooba வாங்கினா'], expect: { name: 'kalai', amount: 200, kind: G } },
  { cat: 'mixed', alts: ['Suresh ஐநூத்தி அம்பது gpay pannitaan'], expect: { name: 'suresh', amount: 550, kind: R } },
  { cat: 'mixed', alts: ['மோகன் 1200 credit ah podu'], expect: { name: 'mohan', amount: 1200, kind: R } },
  { cat: 'mixed', alts: ['Gopal 300 பற்று எழுது'], expect: { name: 'gopal', amount: 300, kind: G } },
  { cat: 'mixed', alts: ['ராஜேஷ் phonepe la 700 pottaan'], expect: { name: 'rajesh', amount: 700, kind: R } },
  { cat: 'mixed', alts: ['Nagaraj அரிசி 10 கிலோ 520 took'], expect: { name: 'nagaraj', amount: 520, kind: G } },
  { cat: 'mixed', alts: ['கண்ணன் 150 paid pannitaan'], expect: { name: 'kannan', amount: 150, kind: R } },
  // ---------------------------------------------------------------- dative vs subject on confusable names (16)
  { cat: 'dative_names', alts: ['ராமுக்கு நூறு குடுத்தேன்'], expect: { name: 'ramu', amount: 100, kind: G } },
  { cat: 'dative_names', alts: ['ராமன் நூறு குடுத்தான்'], expect: { name: 'raman', amount: 100, kind: R } },
  { cat: 'dative_names', alts: ['ராமுக்கு 100 ரூபா கொடுத்தான்'], expect: { name: 'ramu', amount: 100, kind: G }, why: 'the shop boy gave Ramu 100 (cash on udhaar)' },
  { cat: 'dative_names', alts: ['ராம் நூறு குடுத்தாச்சு'], expect: { name: 'ram', amount: 100, kind: R }, why: 'bare kuduthaachu, default setting' },
  { cat: 'dative_names', alts: ['முருகேசனுக்கு ஐநூறு குடுத்தாச்சு'], expect: { name: 'murugesan', amount: 500, kind: G } },
  { cat: 'dative_names', alts: ['முருகன் ஐநூறு குடுத்தாச்சு'], expect: { name: 'murugan', amount: 500, kind: R } },
  { cat: 'dative_names', alts: ['Muruganukku 200 rooba saaman kuduthaachu'], expect: { name: 'murugan', amount: 200, kind: G } },
  { cat: 'dative_names', alts: ['Murugesan 200 enakku kuduthaan'], expect: { name: 'murugesan', amount: 200, kind: R } },
  { cat: 'dative_names', alts: ['naan Ramanukku 300 kuduthen'], expect: { name: 'raman', amount: 300, kind: G } },
  { cat: 'dative_names', alts: ['Ram ku 50 kuduthaachu'], expect: { name: 'ram', amount: 50, kind: G } },
  { cat: 'dative_names', alts: ['Raman anna 50 kuduthaachu'], expect: { name: 'raman', amount: 50, kind: R } },
  { cat: 'dative_names', alts: ['செல்வத்துக்கு 400 குடுத்தாச்சு'], expect: { name: 'selvam', amount: 400, kind: G }, why: 'செல்வம் + dative = செல்வத்துக்கு (stem change -ம் -> -த்து)' },
  { cat: 'dative_names', alts: ['Selvi-kku 400 kuduthaachu'], expect: { name: 'selvi', amount: 400, kind: G } },
  { cat: 'dative_names', alts: ['ராமு ஐம்பது குடுத்தாச்சு'], settings: { bareKuduthaachu: 'GIVE' }, expect: { name: 'ramu', amount: 50, kind: G }, why: 'shop setting flipped' },
  { cat: 'dative_names', alts: ['ராமுவுக்கு ஐம்பது ரூபா சாமான்'], expect: { name: 'ramu', amount: 50, kind: G }, why: 'dative + goods, no verb' },
  { cat: 'dative_names', alts: ['Sitakku 100 kuduthaan'], expect: { name: 'sita', amount: 100, kind: G }, why: 'someone gave Sita 100 on our behalf' },
  // ---------------------------------------------------------------- honorifics (9)
  { cat: 'honorifics', alts: ['ராமு அண்ணாச்சி 250 குடுத்தாரு'], expect: { name: 'ramu', amount: 250, kind: R }, why: 'அண்ணாச்சி = elder brother (Nadar / southern usage)' },
  { cat: 'honorifics', alts: ['சீதா அக்காவுக்கு பால் 60 குடுத்தாச்சு'], expect: { name: 'sita', amount: 60, kind: G } },
  { cat: 'honorifics', alts: ['Kumar sir 1200 kattiyirukkaaru'], expect: { name: 'kumar', amount: 1200, kind: R } },
  { cat: 'honorifics', alts: ['லட்சுமி அம்மாவுக்கு 300 குடுத்தேன்'], expect: { name: 'lakshmi', amount: 300, kind: G } },
  { cat: 'honorifics', alts: ['Pandi thambi 80 vaangittaan'], expect: { name: 'pandi', amount: 80, kind: G } },
  { cat: 'honorifics', alts: ['Velu ayya 1000 kuduthaaru'], expect: { name: 'velu', amount: 1000, kind: R } },
  { cat: 'honorifics', alts: ['Devi akka ku 200 kuduthen'], expect: { name: 'devi', amount: 200, kind: G } },
  { cat: 'honorifics', alts: ['முருகேசன் மாமா 300 கட்டினாரு'], expect: { name: 'murugesan', amount: 300, kind: R }, why: 'மாமா = uncle, very common address' },
  { cat: 'honorifics', alts: ['ரவி சார்க்கு 500 குடுத்தாச்சு'], expect: { name: 'ravi', amount: 500, kind: G }, why: 'சார் + dative' },
  // ---------------------------------------------------------------- fillers / noise (பாரு, சரி, அது வந்து, டேய் ...) (9)
  { cat: 'fillers', alts: ['பாரு ராமு 100 கட்டிட்டான்'], expect: { name: 'ramu', amount: 100, kind: R } },
  { cat: 'fillers', alts: ['Ramu 100 paaru, vaangitaan'], expect: { name: 'ramu', amount: 100, kind: G } },
  { cat: 'fillers', alts: ['அது வந்து செல்வி 250 ரூபா வாங்கினாங்க'], expect: { name: 'selvi', amount: 250, kind: G } },
  { cat: 'fillers', alts: ['சரி சரி முருகன் 300 கட்டினான் ஓகே'], expect: { name: 'murugan', amount: 300, kind: R } },
  { cat: 'fillers', alts: ['enna Ganesh 150 vaanginaan ah'], expect: { name: 'ganesh', amount: 150, kind: G } },
  { cat: 'fillers', alts: ['ஆமா ராமன் 1000 கட்டிட்டாரு பாரு'], expect: { name: 'raman', amount: 1000, kind: R } },
  { cat: 'fillers', alts: ['Ramu 100 kuduthaachu paaru'], expect: { name: 'ramu', amount: 100, kind: R }, why: 'paaru is a filler, not பற்று' },
  { cat: 'fillers', alts: ['டேய் பாண்டி 50 ரூபா வாங்கிட்டு போயிட்டான் பாரு'], expect: { name: 'pandi', amount: 50, kind: G } },
  { cat: 'fillers', alts: ['ஏன்னா ராமு 100 கட்டினான்னு எழுதிடு'], expect: { name: 'ramu', amount: 100, kind: R }, why: 'quotative -னு on the verb: "write that Ramu paid 100"' },
  // ---------------------------------------------------------------- multi-entry, corrections, negation (6)
  { cat: 'multi', alts: ['ராமு 100 கட்டினான், ராமன் 200 வாங்கினான்'], expect: [{ name: 'ramu', amount: 100, kind: R }, { name: 'raman', amount: 200, kind: G }] },
  { cat: 'multi', alts: ['Murugan 500 kuduthaan appuram Murugesan 300 vaanginaan'], expect: [{ name: 'murugan', amount: 500, kind: R }, { name: 'murugesan', amount: 300, kind: G }] },
  { cat: 'multi', alts: ['Sita 100 illa 150 kattinaa'], expect: { name: 'sita', amount: 150, kind: R } },
  { cat: 'multi', alts: ['Kumar 300 vaanginaan illa kattinaan'], expect: { name: 'kumar', amount: 300, kind: R }, why: 'self-correction: the last verb counts (null = ask is acceptable)' },
  { cat: 'multi', alts: ['ராமு 100 ராம் 200 ராமன் 300 குடுத்தாங்க'], expect: [{ name: 'ramu', amount: 100, kind: R }, { name: 'ram', amount: 200, kind: R }, { name: 'raman', amount: 300, kind: R }] },
  { cat: 'multi', alts: ['Selvi 500 innum kudukkala'], expect: { name: 'selvi', amount: 500, kind: null }, why: 'has not paid yet: no entry' },
  // ---------------------------------------------------------------- recogniser misspellings (as Google really outputs) (8)
  { cat: 'misspelt', alts: ['ராமு 100 குடுத்தாச்சி'], expect: { name: 'ramu', amount: 100, kind: R } },
  { cat: 'misspelt', alts: ['Ravi 100 kuduthachchu'], expect: { name: 'ravi', amount: 100, kind: R } },
  { cat: 'misspelt', alts: ['Lakshmi 600 pannam kattiyirukkanga'], expect: { name: 'lakshmi', amount: 600, kind: R } },
  { cat: 'misspelt', alts: ['Saravanan 150 eduthukitan'], expect: { name: 'saravanan', amount: 150, kind: G } },
  { cat: 'misspelt', alts: ['ராமு நூறு ரூபா கட்னான்'], expect: { name: 'ramu', amount: 100, kind: R }, why: 'Google drops the vowel: கட்டினான்' },
  { cat: 'misspelt', alts: ['Sita 250 wanginaa'], expect: { name: 'sita', amount: 250, kind: G }, why: 'w for v, Google does this often' },
  { cat: 'misspelt', alts: ['Ramu 100 gudutthan'], expect: { name: 'ramu', amount: 100, kind: R }, why: 'g for k' },
  { cat: 'misspelt', alts: ['முருகன் 500 வாங்கிட்டாண்'], expect: { name: 'murugan', amount: 500, kind: G }, why: 'ண் for ன்' },
];

// ------------------------------------------------------------------ harness

interface Row {
  label: string;
  cat: string;
  known?: string;
  nameOk: boolean;
  amountOk: boolean;
  kindOk: boolean;
  /** direction given and opposite to what was meant */
  wrongDir: string[];
  /** direction expected but left null */
  unsure: string[];
  /** 'high' with a wrong field */
  wrongHigh: string[];
  /** 'high' intents */
  high: number;
  problems: string[];
  got: VoiceIntent[];
}

function run(cs: Case): Row {
  const got = parseUtterance(cs.alts, SHOP, cs.settings, cs.context ? { contextCustomerId: cs.context } : {});
  const want = Array.isArray(cs.expect) ? cs.expect : [cs.expect];
  const label = `[${cs.cat}] ${cs.alts.join(' || ')}`;
  const row: Row = { label, cat: cs.cat, known: cs.known, nameOk: true, amountOk: true, kindOk: true, wrongDir: [], unsure: [], wrongHigh: [], high: 0, problems: [], got };
  if (got.length !== want.length) {
    row.nameOk = row.amountOk = row.kindOk = false;
    row.problems.push(`entries ${got.length} != ${want.length}: ${got.map((g) => `${g.matches[0]?.id ?? '-'}/${g.amount_paise}/${g.kind}`).join(' | ')}`);
    for (const g of got) if (g.confidence === 'high') { row.high++; row.wrongHigh.push(`entry split wrong but 'high': ${g.name_text}/${g.amount_paise}/${g.kind}`); }
    return row;
  }
  want.forEach((w, i) => {
    const g = got[i];
    const top = g.matches[0];
    const clear = !!top && (g.matches.length < 2 || g.matches[1].score < top.score);
    const nameOk = w.name === null ? (g.matches[0]?.score ?? 0) < NEW_NAME_BELOW : !!top && top.id === w.name && clear;
    const wantPaise = w.amount === null ? null : Math.round(w.amount * 100);
    const amountOk = g.amount_paise === wantPaise;
    const kindOk = g.kind === w.kind;
    if (!nameOk) { row.nameOk = false; row.problems.push(`#${i} name: want ${w.name}, got ${JSON.stringify(g.matches)} (name_text=${JSON.stringify(g.name_text)})`); }
    if (!amountOk) { row.amountOk = false; row.problems.push(`#${i} amount: want ${w.amount}, got ${g.amount_paise === null ? null : g.amount_paise / 100} (${g.amount_text ?? '-'}${g.amount_candidates ? ` cands=${g.amount_candidates}` : ''})`); }
    if (!kindOk) {
      row.kindOk = false;
      row.problems.push(`#${i} kind: want ${w.kind}, got ${g.kind} (${g.kind_reason}, ${g.confidence})`);
      if (g.kind && w.kind && g.kind !== w.kind) row.wrongDir.push(`${label} -> ${g.kind} (${g.kind_reason}, ${g.confidence}) but meant ${w.kind}`);
      else if (!g.kind && w.kind) row.unsure.push(`${label} -> null (${g.kind_reason}) meant ${w.kind}`);
    }
    if (g.confidence === 'high') {
      row.high++;
      if (!nameOk || !amountOk || !kindOk) row.wrongHigh.push(`${label}: 'high' but ${[!nameOk && 'name', !amountOk && 'amount', !kindOk && 'kind'].filter(Boolean).join('+')} wrong (${g.kind_reason})`);
    }
  });
  return row;
}

const rows: Row[] = [];

describe('voice NLU review: 120 new shop utterances', () => {
  it('has exactly 120 cases', () => {
    expect(CASES.length).toBe(120);
  });
  it('every case is new (not an alternative in the fixtures) and distinct', () => {
    const fixtureAlts = new Set((fixtures as { alts: string[] }[]).flatMap((f) => f.alts.map((a) => a.normalize('NFC').trim().toLowerCase())));
    const seen = new Set<string>();
    for (const cs of CASES) {
      for (const a of cs.alts) {
        const k = a.normalize('NFC').trim().toLowerCase();
        expect(fixtureAlts.has(k), `copied from fixtures: ${a}`).toBe(false);
        expect(seen.has(k), `duplicate case: ${a}`).toBe(false);
        seen.add(k);
      }
    }
  });
  for (const cs of CASES) {
    const name = `[${cs.cat}] ${cs.alts.join(' || ')}${cs.unsafe ? ' (known gap, UNSAFE: wrong at high)' : cs.known ? ' (known gap)' : ''}`;
    // an `unsafe` case documents a 'high' intent with a wrong field: it.fails until voice-core fixes it
    (cs.unsafe ? it.fails : it)(name, () => {
      const r = run(cs);
      rows.push(r);
      // money safety, always: a 'high' intent must never carry a wrong name, direction or amount
      expect(r.wrongHigh, r.label).toEqual([]);
      // a case without a documented gap must match exactly
      if (!cs.known) expect(r.problems, r.label).toEqual([]);
    });
  }
  it('an unsafe marker is only used together with a known gap', () => {
    for (const cs of CASES) if (cs.unsafe) expect(cs.known, cs.alts[0]).toBeTruthy();
  });
  afterAll(() => {
    const cats = new Map<string, { n: number; name: number; amount: number; kind: number; all: number; high: number }>();
    for (const r of rows) {
      const s = cats.get(r.cat) ?? { n: 0, name: 0, amount: 0, kind: 0, all: 0, high: 0 };
      s.n++;
      if (r.nameOk) s.name++;
      if (r.amountOk) s.amount++;
      if (r.kindOk) s.kind++;
      if (!r.problems.length) s.all++;
      s.high += r.high;
      cats.set(r.cat, s);
    }
    const pct = (a: number, n: number) => `${((100 * a) / n).toFixed(1)}%`.padStart(7);
    const out: string[] = ['', 'VOICE NLU REVIEW (120 new utterances, confusable-name shop list):'];
    let T = { n: 0, name: 0, amount: 0, kind: 0, all: 0, high: 0 };
    for (const [cat, s] of [...cats.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(`  ${cat.padEnd(14)} n=${String(s.n).padStart(3)}  name${pct(s.name, s.n)}  amount${pct(s.amount, s.n)}  kind${pct(s.kind, s.n)}  all${pct(s.all, s.n)}  high=${s.high}`);
      T = { n: T.n + s.n, name: T.name + s.name, amount: T.amount + s.amount, kind: T.kind + s.kind, all: T.all + s.all, high: T.high + s.high };
    }
    out.push(`  ${'TOTAL'.padEnd(14)} n=${String(T.n).padStart(3)}  name${pct(T.name, T.n)}  amount${pct(T.amount, T.n)}  kind${pct(T.kind, T.n)}  all${pct(T.all, T.n)}  high=${T.high}`);
    const wrongDir = rows.flatMap((r) => r.wrongDir);
    const unsure = rows.flatMap((r) => r.unsure);
    const wrongHigh = rows.flatMap((r) => r.wrongHigh);
    out.push(`  WRONG DIRECTION (opposite): ${wrongDir.length}`, ...wrongDir.map((w) => `    - ${w}`));
    out.push(`  UNSURE (null, direction meant): ${unsure.length}`, ...unsure.map((w) => `    - ${w}`));
    out.push(`  WRONG 'high': ${wrongHigh.length}`, ...wrongHigh.map((w) => `    - ${w}`));
    const known = rows.filter((r) => r.known);
    out.push(`  KNOWN GAPS (documented, do not fail the suite): ${known.length}`);
    for (const r of known) {
      out.push(`    - ${r.label}${r.problems.length ? '' : '  [now passes: drop the known marker]'}`, `        gap: ${r.known}`, ...r.problems.map((p) => `        ${p}`));
    }
    const undocumented = rows.filter((r) => !r.known && r.problems.length);
    out.push(`  UNDOCUMENTED MISMATCHES (fail the suite): ${undocumented.length}`);
    for (const r of undocumented) out.push(`    - ${r.label}`, ...r.problems.map((p) => `        ${p}`));
    process.stdout.write(`${out.join('\n')}\n\n`);
  });
});
