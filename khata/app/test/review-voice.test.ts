/**
 * NLU review: 120 NEW shop utterances (not in the fixtures) written the way a Tamil Nadu kirana owner and helpers
 * actually talk, run through parseUtterance. Reports name / amount / kind accuracy separately, every WRONG
 * direction (opposite of what was meant), every 'high' confidence that was wrong, and unsure (null) directions.
 *
 * The test is a report: it only fails on the money-safety invariant (a 'high' intent must never carry a wrong
 * direction or amount), so a lexicon gap shows up in the printed report without breaking other agents' runs.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { parseUtterance, type VoiceCustomer, type VoiceIntent, type VoiceSettings } from '../src/core/voice';

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
  // ---------------------------------------------------------------- Tamil script, as Google writes it
  { cat: 'ta_script', alts: ['ராமு இருநூறு ரூபா கட்டிட்டான்'], expect: { name: 'ramu', amount: 200, kind: R } },
  { cat: 'ta_script', alts: ['ராமனுக்கு ஐநூறு குடுத்தேன்'], expect: { name: 'raman', amount: 500, kind: G } },
  { cat: 'ta_script', alts: ['ராம் 300 வாங்கிட்டு போனான்'], expect: { name: 'ram', amount: 300, kind: G } },
  { cat: 'ta_script', alts: ['முருகேசன் ஆயிரம் ரூபாய் கட்டினாரு'], expect: { name: 'murugesan', amount: 1000, kind: R } },
  { cat: 'ta_script', alts: ['முருகன் கணக்குல 150 போடு'], expect: { name: 'murugan', amount: 150, kind: G } },
  { cat: 'ta_script', alts: ['முருகேசனுக்கு 2 கிலோ அரிசி 120 குடுத்தாச்சு'], expect: { name: 'murugesan', amount: 120, kind: G }, why: 'dative -க்கு: goods given to him' },
  { cat: 'ta_script', alts: ['சீதா அக்கா 450 குடுத்துட்டாங்க'], expect: { name: 'sita', amount: 450, kind: R } },
  { cat: 'ta_script', alts: ['செல்வி நேத்து ஐநூத்தி அம்பது கட்டினாங்க'], expect: { name: 'selvi', amount: 550, kind: R } },
  { cat: 'ta_script', alts: ['குமாரு 80 ரூபா பீடி வாங்கினான்'], expect: { name: 'kumar', amount: 80, kind: G } },
  { cat: 'ta_script', alts: ['லட்சுமி அம்மா பால் 2 லிட்டர் 110 எடுத்தாங்க'], expect: { name: 'lakshmi', amount: 110, kind: G } },
  { cat: 'ta_script', alts: ['ரவி 1200 ஜிபே பண்ணிட்டான்'], expect: { name: 'ravi', amount: 1200, kind: R } },
  { cat: 'ta_script', alts: ['மீனா பாக்கி 300 கட்டிட்டா'], expect: { name: 'meena', amount: 300, kind: R }, why: 'paid the balance' },
  { cat: 'ta_script', alts: ['கார்த்திக் 650 ரூபாய் கடன் வாங்கினான்'], expect: { name: 'karthik', amount: 650, kind: G } },
  { cat: 'ta_script', alts: ['கணேஷ் கிட்ட 400 வாங்கினேன்'], expect: { name: 'ganesh', amount: 400, kind: R }, why: 'I took 400 from Ganesh = he paid' },
  { cat: 'ta_script', alts: ['பாண்டி 90 ரூபா சிகரெட் எடுத்துட்டு போயிட்டான்'], expect: { name: 'pandi', amount: 90, kind: G } },
  { cat: 'ta_script', alts: ['சரவணன் 2500 செட்டில் பண்ணிட்டாரு'], expect: { name: 'saravanan', amount: 2500, kind: R } },
  { cat: 'ta_script', alts: ['பிரியா 35 ரூபாய்க்கு முட்டை வாங்கினா'], expect: { name: 'priya', amount: 35, kind: G } },
  { cat: 'ta_script', alts: ['முத்து அண்ணன் 700 தந்தாரு'], expect: { name: 'muthu', amount: 700, kind: R } },
  { cat: 'ta_script', alts: ['செந்தில் 1000 ரூபாய் கொடுத்துட்டு போனான்'], expect: { name: 'senthil', amount: 1000, kind: R }, why: 'he handed over money and left' },
  { cat: 'ta_script', alts: ['பாத்திமா 220 கணக்குல எழுதிக்கோ'], expect: { name: 'fathima', amount: 220, kind: G } },
  { cat: 'ta_script', alts: ['தேவி 500 பணம் வந்துச்சு'], expect: { name: 'devi', amount: 500, kind: R } },
  { cat: 'ta_script', alts: ['மணி 1,500 உதார் வாங்கினான்'], expect: { name: 'mani', amount: 1500, kind: G } },
  { cat: 'ta_script', alts: ['வேலு பழைய பாக்கி 800 கட்டிட்டாரு'], expect: { name: 'velu', amount: 800, kind: R } },
  { cat: 'ta_script', alts: ['பாபு 60 ரூபா டீ பொடி வாங்கிட்டான்'], expect: { name: 'babu', amount: 60, kind: G } },
  { cat: 'ta_script', alts: ['ராஜா 150 திருப்பி குடுத்தான்'], expect: { name: 'raja', amount: 150, kind: R } },
  { cat: 'ta_script', alts: ['அன்பு 2000 போன்பே ல அனுப்பிட்டான்'], expect: { name: 'anbu', amount: 2000, kind: R } },
  { cat: 'ta_script', alts: ['கலை 40 சோப்பு வாங்கினா'], expect: { name: 'kalai', amount: 40, kind: G } },
  { cat: 'ta_script', alts: ['ராமு நூறு ரூபாய் கொடுத்தார்'], expect: { name: 'ramu', amount: 100, kind: R } },
  { cat: 'ta_script', alts: ['குமார் 500 கட்டி இருக்காரு'], expect: { name: 'kumar', amount: 500, kind: R } },
  { cat: 'ta_script', alts: ['ரவி கணக்குல 250 ஏத்து'], expect: { name: 'ravi', amount: 250, kind: G }, why: 'ஏத்து = add to his account' },
  // ---------------------------------------------------------------- Tamil numbers in words
  { cat: 'ta_numbers', alts: ['சுரேஷ் நூத்தி எழுபத்தஞ்சு கட்டினான்'], expect: { name: 'suresh', amount: 175, kind: R } },
  { cat: 'ta_numbers', alts: ['மோகன் ரெண்டாயிரத்து ஐநூறு கட்டிட்டாரு'], expect: { name: 'mohan', amount: 2500, kind: R } },
  { cat: 'ta_numbers', alts: ['கோபால் முன்னூத்தி அம்பது ரூபாய்க்கு சாமான் வாங்கினான்'], expect: { name: 'gopal', amount: 350, kind: G } },
  { cat: 'ta_numbers', alts: ['ராஜேஷ் அஞ்சாயிரம் கொடுத்தாரு'], expect: { name: 'rajesh', amount: 5000, kind: R } },
  { cat: 'ta_numbers', alts: ['நாகராஜ் நாலாயிரம் கடன் கேட்டான் குடுத்தேன்'], expect: { name: 'nagaraj', amount: 4000, kind: G } },
  { cat: 'ta_numbers', alts: ['ஜோதி எண்பது ரூபா எடுத்தா'], expect: { name: 'jothi', amount: 80, kind: G } },
  { cat: 'ta_numbers', alts: ['பழனி பதினஞ்சு ரூபா பிஸ்கட் வாங்கினான்'], expect: { name: 'palani', amount: 15, kind: G } },
  { cat: 'ta_numbers', alts: ['கண்ணன் ஆயிரத்து இருநூத்தி அம்பது கட்டினான்'], expect: { name: 'kannan', amount: 1250, kind: R } },
  { cat: 'ta_numbers', alts: ['பாலு அறுநூத்தி பத்து ரூபாய் குடுத்தாரு'], expect: { name: 'balu', amount: 610, kind: R } },
  { cat: 'ta_numbers', alts: ['Ramu nooru rooba kuduthaan'], expect: { name: 'ramu', amount: 100, kind: R } },
  { cat: 'ta_numbers', alts: ['சீதா நூத்தி அம்பது வாங்கினா'], expect: { name: 'sita', amount: 150, kind: G } },
  { cat: 'ta_numbers', alts: ['Kumar aayirathi irunooru kattinaan'], expect: { name: 'kumar', amount: 1200, kind: R } },
  { cat: 'ta_numbers', alts: ['முருகன் ரெண்டரை ஆயிரம் கட்டினான்'], expect: { name: 'murugan', amount: 2500, kind: R } },
  { cat: 'ta_numbers', alts: ['Selvi ambathu rooba paal vaanginaanga'], expect: { name: 'selvi', amount: 50, kind: G } },
  { cat: 'ta_numbers', alts: ['Ravi thollayiram kuduthaan'], expect: { name: 'ravi', amount: 900, kind: R } },
  { cat: 'ta_numbers', alts: ['லட்சுமி மூவாயிரம் கட்டினாங்க'], expect: { name: 'lakshmi', amount: 3000, kind: R } },
  { cat: 'ta_numbers', alts: ['Karthik oru aayirathu nooru kattinaan'], expect: { name: 'karthik', amount: 1100, kind: R } },
  { cat: 'ta_numbers', alts: ['Senthil patthu rooba eduthaan'], expect: { name: 'senthil', amount: 10, kind: G } },
  { cat: 'ta_numbers', alts: ['ராஜா எழுநூறு ரூபாய் ஜிபே'], expect: { name: 'raja', amount: 700, kind: R } },
  { cat: 'ta_numbers', alts: ['Anbu nootthi irupathu rupees took'], expect: { name: 'anbu', amount: 120, kind: G } },
  { cat: 'ta_numbers', alts: ['பாபு ஆறாயிரம் செட்டில்'], expect: { name: 'babu', amount: 6000, kind: R } },
  { cat: 'ta_numbers', alts: ['Devi one twenty rupees took milk'], expect: { name: 'devi', amount: 120, kind: G } },
  { cat: 'ta_numbers', alts: ['மணி நாப்பத்தஞ்சு ரூபா வாங்கினான்'], expect: { name: 'mani', amount: 45, kind: G } },
  // ---------------------------------------------------------------- Tanglish
  { cat: 'tanglish', alts: ['Ramu ku 250 kuduthaachu'], expect: { name: 'ramu', amount: 250, kind: G }, why: 'separate -ku particle' },
  { cat: 'tanglish', alts: ['Raman 250 kuduthaachu'], expect: { name: 'raman', amount: 250, kind: R } },
  { cat: 'tanglish', alts: ['Ram anna 500 kattitaaru'], expect: { name: 'ram', amount: 500, kind: R } },
  { cat: 'tanglish', alts: ['Murugesan 300 rooba vaangitaan'], expect: { name: 'murugesan', amount: 300, kind: G } },
  { cat: 'tanglish', alts: ['Murugan kitta 1000 vaangiten'], expect: { name: 'murugan', amount: 1000, kind: R } },
  { cat: 'tanglish', alts: ['Seetha akka 120 paal vaangunaanga'], expect: { name: 'sita', amount: 120, kind: G } },
  { cat: 'tanglish', alts: ['Selvi 2 kilo sakkarai 90 rupees eduthaa'], expect: { name: 'selvi', amount: 90, kind: G } },
  { cat: 'tanglish', alts: ['Kumar anna 1500 settle aachu'], expect: { name: 'kumar', amount: 1500, kind: R } },
  { cat: 'tanglish', alts: ['Lakshmi 450 phonepe la pottaanga'], expect: { name: 'lakshmi', amount: 450, kind: R } },
  { cat: 'tanglish', alts: ['Ravi 75 kanakkula ezhuthiko'], expect: { name: 'ravi', amount: 75, kind: G } },
  { cat: 'tanglish', alts: ['Meena 200 kuduthutaanga'], expect: { name: 'meena', amount: 200, kind: R } },
  { cat: 'tanglish', alts: ['Karthik 600 udhaar la vaanginaan'], expect: { name: 'karthik', amount: 600, kind: G } },
  { cat: 'tanglish', alts: ['Ganeshukku 350 saaman kuduthen'], expect: { name: 'ganesh', amount: 350, kind: G } },
  { cat: 'tanglish', alts: ['Pandi 1000 baaki kattitaan'], expect: { name: 'pandi', amount: 1000, kind: R } },
  { cat: 'tanglish', alts: ['Saravanan 40 rupees beedi eduthutu ponaan'], expect: { name: 'saravanan', amount: 40, kind: G } },
  { cat: 'tanglish', alts: ['Priya 5000 gpay panniruchu'], expect: { name: 'priya', amount: 5000, kind: R } },
  { cat: 'tanglish', alts: ['Muthu nethu 300 kuduthaan'], expect: { name: 'muthu', amount: 300, kind: R } },
  { cat: 'tanglish', alts: ['Senthil 95 rupees soap paste vaangittan'], expect: { name: 'senthil', amount: 95, kind: G } },
  { cat: 'tanglish', alts: ['Fathima 2 thousand kattiruchu'], expect: { name: 'fathima', amount: 2000, kind: R } },
  { cat: 'tanglish', alts: ['Mani 800 cash la kuduthaaru'], expect: { name: 'mani', amount: 800, kind: R } },
  { cat: 'tanglish', alts: ['Velu-kku 150 kuduthom'], expect: { name: 'velu', amount: 150, kind: G } },
  { cat: 'tanglish', alts: ['Babu 100 ku arisi vaanginaan'], expect: { name: 'babu', amount: 100, kind: G } },
  { cat: 'tanglish', alts: ['Raja 2 packet milk 60 ezhuthu'], expect: { name: 'raja', amount: 60, kind: G } },
  { cat: 'tanglish', alts: ['Selvam 320 vangi poitan'], expect: { name: 'selvam', amount: 320, kind: G } },
  { cat: 'tanglish', alts: ['Balu 1000 katnan'], expect: { name: 'balu', amount: 1000, kind: R }, why: 'recogniser drops the vowel: kattinaan' },
  // ---------------------------------------------------------------- mixed script
  { cat: 'mixed', alts: ['Anbu 500 rupees கட்டிட்டான்'], expect: { name: 'anbu', amount: 500, kind: R } },
  { cat: 'mixed', alts: ['கலை two hundred vaanginaa'], expect: { name: 'kalai', amount: 200, kind: G } },
  { cat: 'mixed', alts: ['Suresh ஐநூத்தி அம்பது paid'], expect: { name: 'suresh', amount: 550, kind: R } },
  { cat: 'mixed', alts: ['மோகன் 1200 credit podu'], expect: { name: 'mohan', amount: 1200, kind: R } },
  { cat: 'mixed', alts: ['Gopal 300 பற்று போடு'], expect: { name: 'gopal', amount: 300, kind: G } },
  { cat: 'mixed', alts: ['ராஜேஷ் gpay la 700 anuppinaan'], expect: { name: 'rajesh', amount: 700, kind: R } },
  { cat: 'mixed', alts: ['Nagaraj அரிசி 10 கிலோ 520 vaanginaan'], expect: { name: 'nagaraj', amount: 520, kind: G } },
  { cat: 'mixed', alts: ['ஜோதி 45 rupees eduthaanga'], expect: { name: 'jothi', amount: 45, kind: G } },
  { cat: 'mixed', alts: ['Palani ரெண்டாயிரம் settle pannittaaru'], expect: { name: 'palani', amount: 2000, kind: R } },
  { cat: 'mixed', alts: ['கண்ணன் 150 took'], expect: { name: 'kannan', amount: 150, kind: G } },
  // ---------------------------------------------------------------- dative vs subject, confusable names
  { cat: 'dative_names', alts: ['ராமுக்கு 100 குடுத்தேன்'], expect: { name: 'ramu', amount: 100, kind: G } },
  { cat: 'dative_names', alts: ['ராமன் 100 குடுத்தான்'], expect: { name: 'raman', amount: 100, kind: R } },
  { cat: 'dative_names', alts: ['ராமுக்கு 100 கொடுத்தான்'], expect: { name: 'ramu', amount: 100, kind: G }, why: 'someone gave Ramu 100 on our behalf' },
  { cat: 'dative_names', alts: ['ராம் 100 குடுத்தாச்சு'], expect: { name: 'ram', amount: 100, kind: R } },
  { cat: 'dative_names', alts: ['முருகேசனுக்கு 500 குடுத்தாச்சு'], expect: { name: 'murugesan', amount: 500, kind: G } },
  { cat: 'dative_names', alts: ['முருகன் 500 குடுத்தாச்சு'], expect: { name: 'murugan', amount: 500, kind: R } },
  { cat: 'dative_names', alts: ['Muruganukku 200 saaman kuduthaachu'], expect: { name: 'murugan', amount: 200, kind: G } },
  { cat: 'dative_names', alts: ['Murugesan 200 enakku kuduthaan'], expect: { name: 'murugesan', amount: 200, kind: R } },
  { cat: 'dative_names', alts: ['naan Ramanukku 300 kuduthen'], expect: { name: 'raman', amount: 300, kind: G } },
  { cat: 'dative_names', alts: ['Ramu enakku 300 kuduthaan'], expect: { name: 'ramu', amount: 300, kind: R } },
  { cat: 'dative_names', alts: ['Ram-ku 50 kuduthaachu'], expect: { name: 'ram', amount: 50, kind: G } },
  { cat: 'dative_names', alts: ['Raman anna 50 kuduthaachu'], expect: { name: 'raman', amount: 50, kind: R } },
  { cat: 'dative_names', alts: ['Selvam 400 kattinaan'], expect: { name: 'selvam', amount: 400, kind: R } },
  { cat: 'dative_names', alts: ['Selvi-kku 400 kuduthaachu'], expect: { name: 'selvi', amount: 400, kind: G } },
  { cat: 'dative_names', alts: ['ராமு 100 குடுத்தாச்சு'], settings: { bareKuduthaachu: 'GIVE' }, expect: { name: 'ramu', amount: 100, kind: G }, why: 'shop setting flipped' },
  // ---------------------------------------------------------------- honorifics
  { cat: 'honorifics', alts: ['ராமு அண்ணாச்சி 250 குடுத்தாரு'], expect: { name: 'ramu', amount: 250, kind: R } },
  { cat: 'honorifics', alts: ['சீதா அக்காவுக்கு பால் 60 குடுத்தாச்சு'], expect: { name: 'sita', amount: 60, kind: G } },
  { cat: 'honorifics', alts: ['Kumar sir 1200 kattiyirukkaaru'], expect: { name: 'kumar', amount: 1200, kind: R } },
  { cat: 'honorifics', alts: ['லட்சுமி அம்மாவுக்கு 300 குடுத்தேன்'], expect: { name: 'lakshmi', amount: 300, kind: G } },
  { cat: 'honorifics', alts: ['Pandi thambi 80 vaangittaan'], expect: { name: 'pandi', amount: 80, kind: G } },
  { cat: 'honorifics', alts: ['Velu ayya 1000 kuduthaaru'], expect: { name: 'velu', amount: 1000, kind: R } },
  { cat: 'honorifics', alts: ['செல்வி மேடம் 450 ரூபா கட்டினாங்க'], expect: { name: 'selvi', amount: 450, kind: R } },
  { cat: 'honorifics', alts: ['Devi akka ku 200 kuduthen'], expect: { name: 'devi', amount: 200, kind: G } },
  // ---------------------------------------------------------------- fillers / noise (பாரு, சரி, அது வந்து ...)
  { cat: 'fillers', alts: ['பாரு ராமு 100 கட்டிட்டான்'], expect: { name: 'ramu', amount: 100, kind: R } },
  { cat: 'fillers', alts: ['Ramu 100 paaru, vaangitaan'], expect: { name: 'ramu', amount: 100, kind: G } },
  { cat: 'fillers', alts: ['அது வந்து செல்வி 250 ரூபா வாங்கினாங்க'], expect: { name: 'selvi', amount: 250, kind: G } },
  { cat: 'fillers', alts: ['Ravi anna paaru 500 kuduthaan'], expect: { name: 'ravi', amount: 500, kind: R } },
  { cat: 'fillers', alts: ['சரி சரி முருகன் 300 கட்டினான் ஓகே'], expect: { name: 'murugan', amount: 300, kind: R } },
  { cat: 'fillers', alts: ['enna Ganesh 150 vaanginaan ah'], expect: { name: 'ganesh', amount: 150, kind: G } },
  { cat: 'fillers', alts: ['Kumar 200 kuduthaan la'], expect: { name: 'kumar', amount: 200, kind: R } },
  { cat: 'fillers', alts: ['ஆமா ராமன் 1000 கட்டிட்டாரு பாரு'], expect: { name: 'raman', amount: 1000, kind: R } },
  { cat: 'fillers', alts: ['Meena ponnu 70 rupees vaangunaa'], expect: { name: 'meena', amount: 70, kind: G } },
  { cat: 'fillers', alts: ['இன்னைக்கு மணி 500 ரூபா கட்டினாரு'], expect: { name: 'mani', amount: 500, kind: R } },
  { cat: 'fillers', alts: ['Ramu 100 kuduthaachu paaru'], expect: { name: 'ramu', amount: 100, kind: R }, why: 'paaru is a filler, not பற்று' },
  // ---------------------------------------------------------------- multi-entry, corrections, negation
  { cat: 'multi', alts: ['ராமு 100 கட்டினான், ராமன் 200 வாங்கினான்'], expect: [{ name: 'ramu', amount: 100, kind: R }, { name: 'raman', amount: 200, kind: G }] },
  { cat: 'multi', alts: ['Murugan 500 kuduthaan appuram Murugesan 300 vaanginaan'], expect: [{ name: 'murugan', amount: 500, kind: R }, { name: 'murugesan', amount: 300, kind: G }] },
  { cat: 'multi', alts: ['Sita 100 illa 150 kattinaa'], expect: { name: 'sita', amount: 150, kind: R } },
  { cat: 'multi', alts: ['Kumar 300 vaanginaan illa kattinaan'], expect: { name: 'kumar', amount: 300, kind: R }, why: 'self-correction: the last verb counts; null is acceptable' },
  { cat: 'multi', alts: ['Ravi 200 Ganesh 300 kattinaanga'], expect: [{ name: 'ravi', amount: 200, kind: R }, { name: 'ganesh', amount: 300, kind: R }] },
  { cat: 'multi', alts: ['ராமு 100 ராம் 200 ராமன் 300 குடுத்தாங்க'], expect: [{ name: 'ramu', amount: 100, kind: R }, { name: 'ram', amount: 200, kind: R }, { name: 'raman', amount: 300, kind: R }] },
  { cat: 'multi', alts: ['Selvi 500 innum kudukkala'], expect: { name: 'selvi', amount: 500, kind: null }, why: 'has not paid yet: no entry' },
  { cat: 'multi', alts: ['Priya 2 kilo arisi, 1 litre oil 300 vaanginaa'], expect: { name: 'priya', amount: 300, kind: G } },
  // ---------------------------------------------------------------- recogniser misspellings (as Google really outputs)
  { cat: 'misspelt', alts: ['ராமு 100 குடுத்தாச்சி'], expect: { name: 'ramu', amount: 100, kind: R } },
  { cat: 'misspelt', alts: ['சீதா 250 வாங்குனா'], expect: { name: 'sita', amount: 250, kind: G } },
  { cat: 'misspelt', alts: ['முருகேசன் 500 கொடுத்துட்டாரு'], expect: { name: 'murugesan', amount: 500, kind: R } },
  { cat: 'misspelt', alts: ['Ravi 100 kuduthachchu'], expect: { name: 'ravi', amount: 100, kind: R } },
  { cat: 'misspelt', alts: ['Karthik 450 vangitan'], expect: { name: 'karthik', amount: 450, kind: G } },
  { cat: 'misspelt', alts: ['Lakshmi 600 pannam kattiyirukkanga'], expect: { name: 'lakshmi', amount: 600, kind: R } },
  { cat: 'misspelt', alts: ['Saravanan 150 eduthukitan'], expect: { name: 'saravanan', amount: 150, kind: G } },
  { cat: 'misspelt', alts: ['Mohan 2000 settl pannitaan'], expect: { name: 'mohan', amount: 2000, kind: R } },
  { cat: 'misspelt', alts: ['Gopal 300 kudthaachu'], expect: { name: 'gopal', amount: 300, kind: R } },
  { cat: 'misspelt', alts: ['பாண்டி 75 எடுத்துகிட்டான்'], expect: { name: 'pandi', amount: 75, kind: G } },
];

// ------------------------------------------------------------------ harness

interface Row {
  label: string;
  cat: string;
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
  const row: Row = { label, cat: cs.cat, nameOk: true, amountOk: true, kindOk: true, wrongDir: [], unsure: [], wrongHigh: [], high: 0, problems: [], got };
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
    const nameOk = w.name === null ? g.matches.length === 0 : !!top && top.id === w.name && clear;
    const wantPaise = w.amount === null ? null : Math.round(w.amount * 100);
    const amountOk = g.amount_paise === wantPaise;
    const kindOk = g.kind === w.kind;
    if (!nameOk) { row.nameOk = false; row.problems.push(`#${i} name: want ${w.name}, got ${JSON.stringify(g.matches)} (name_text=${JSON.stringify(g.name_text)})`); }
    if (!amountOk) { row.amountOk = false; row.problems.push(`#${i} amount: want ${w.amount}, got ${g.amount_paise === null ? null : g.amount_paise / 100} (${g.amount_text ?? '-'}${g.amount_candidates ? ` cands=${g.amount_candidates}` : ''})`); }
    if (!kindOk) {
      row.kindOk = false;
      row.problems.push(`#${i} kind: want ${w.kind}, got ${g.kind} (${g.kind_reason})`);
      if (g.kind && w.kind && g.kind !== w.kind) row.wrongDir.push(`${label} -> ${g.kind} (${g.kind_reason}) but meant ${w.kind}`);
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
  it('has 120 new cases', () => {
    expect(CASES.length).toBe(120);
  });
  for (const cs of CASES) {
    it(`[${cs.cat}] ${cs.alts.join(' || ')}`, () => {
      const r = run(cs);
      rows.push(r);
      // money safety: a 'high' intent must never carry a wrong direction or amount
      expect(r.wrongHigh, r.label).toEqual([]);
    });
  }
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
    out.push('  ALL MISMATCHES:');
    for (const r of rows) if (r.problems.length) out.push(`    - ${r.label}`, ...r.problems.map((p) => `        ${p}`));
    process.stdout.write(`${out.join('\n')}\n\n`);
  });
});
