# Kadan Kanakku — Tamil Voice Entry, Accounts & Cross-Platform Sync Plan

**Date:** 2026-10-18 · **Status:** Plan v2 — implemented in the all-free configuration (see `khata/`).

This document describes **what was built**. The v2 code is in `khata/` (WIP commits up to `5e6ed62`, later edits uncommitted): the Tamil parser (`app/src/core/voice.ts`), the speech adapters (`app/src/platform/speech-*.ts`), the voice UI (`app/src/ui/voice/`), the accounts server (`api/src/`, migrations `0002` and `0003`), the login client (`app/src/sync/`, `app/src/ui/screens/login.ts`) and the web app (`app/src/ui/web/`). Verified at the time of writing: `npx tsc --noEmit -p .` clean in `app` and `api`; `app` 788 tests pass (1 skipped); `api` 191 tests pass; `node e2e/flows.mjs`, `e2e/voice.mjs` and `e2e/web-login.mjs` pass (the last against `wrangler dev --local`). Nothing is deployed and nothing ran on a real phone: this environment has no device, no emulator and no Cloudflare credentials. Section 7 lists what is still open.

It builds on the v1 plan ([`docs/GROCERY_DEBT_APP_PLAN.md`](GROCERY_DEBT_APP_PLAN.md)): a Capacitor 8 + TypeScript app with the ledger in SQLite on the phone, a Cloudflare Worker (Hono + D1) sync hub with device pairing, and `shared/protocol.ts` as the one contract. Tags: **[verified]** = checked on an official page or in the code; **[likely]** = a secondary source or a local measurement; **(unverified)** = not confirmed. ₹88 to $1.

**Labels.** The two buttons read **Debit / பற்று** (= `GIVE`, goods given on udhaar, customer owes more, red) and **Credit / வரவு** (= `RECEIVE`, payment received, customer owes less, green). Statement lines read "Debit ₹250" / "Credited ₹100" (பற்று / வரவு) **[verified: `i18n/en.ts`, `ta.ts`, commit `30add2f`]**. Shop slang uses English "credit" for udhaar (the app's Debit), so the parser treats bare "credit"/"debit" as undecided (2.2).

---

## Answers to your questions

**1. Can we add voice mode, and which free speech and AI backend handles Tamil?**

Yes, built. The engine is Google's own recogniser set to Tamil (`ta-IN`): on Android the phone's `SpeechRecognizer` through `@capgo/capacitor-speech-recognition` 8.3.2 **[verified]**, in the browser the Web Speech API (Chrome tested). Both cost ₹0, need no key, need internet, and send the audio to Google. A Tamil/Tanglish/English **parser written by us** (`core/voice.ts`, pure, no network) turns the transcript into *customer + amount + Debit/Credit* against the shop's real customer list. On its 385 fixture sentences it scores name 100%, amount 99.7%, direction 100% **[verified]**, but those were written by the builders, not recorded at a counter; the honest expectation is 75–90% of short commands fully right in a quiet shop (unverified) until the field test (section 8). Voice therefore **never saves money on its own**: every sentence ends on the normal entry screen with Save still to be tapped. No paid speech or AI service is used (phase-D boosters: 2.6).

**2. What happens when the shopkeeper says "Ramu 100 kuduthaachu"?**

She taps the mic (Home, a customer's page or Quick entry; the first tap shows a privacy notice) and speaks. The recogniser returns one or more guesses (up to 5 asked for; how many Google returns for Tamil is unverified, often one). The parser reads "100" as ₹100, "ராமு" as the customer Ramu, and "குடுத்தாச்சு" (impersonal "has been given", no "-க்கு" on the name) as **Credit / வரவு** through the shop's setting (default *Ramu paid*). Ramu's entry screen opens with **₹100**, Credit selected, "Heard: …", the amount source in large type ("நூறு → ₹100"), the amount in words and "பாக்கி ₹250 → ₹150". Because a bare *kuduthaachu* depends on a setting and on a "-க்கு" the recogniser can swallow, its confidence is at most *medium*, so the banner adds "சேமிக்கும் முன் பெயர், தொகை, பற்று/வரவு சரிபார்க்கவும்" (check the name, amount and Debit/Credit before saving). She taps **Save**; the usual confirmations still fire; the app lands on **Ramu's page** with the new balance and Undo.

"Ramu**kku** 100 kuduthen" (*I gave to Ramu*) → **Debit**; "Ramu 100 vaanginaan" (*took goods*) → Debit. When the parser cannot be sure, **neither side is selected and Save stays disabled** until she taps one (2.2). Two Ramus → a picker with C-code and phone digits.

**3. Login with user id/password and/or Google, on the server?**

Both, built inside the existing Worker, and **both run on Workers Free (₹0)**. The phone or browser stretches the password itself (PBKDF2-HMAC-SHA256, 600,000 iterations, WebCrypto) and sends only the result; the server stores and checks one keyed HMAC of it, microseconds of CPU **[verified: `test/cpu.test.ts`]**. argon2id on the server, which would have needed Workers Paid, is **not** required. Google sign-in verifies ID tokens with a single-use nonce. Every login creates a device row exactly as pairing does, so sync is unchanged. Owner-power actions need a fresh **step-up** proof (password or printed recovery code); lockout is keyed on (user, network) with a known-device exemption. Workers Paid (₹440/month) is **optional**: no daily caps, 30-day D1 Time Travel (3.8).

**4. Cross-device and web app?**

Any phone signs in and syncs as before. The **web app** is the same UI served by the same Worker as static assets (free): user id + password or Google login, an HttpOnly cookie session, a synced copy in the browser, and a **"shared computer"** mode that keeps the ledger in memory only. **v2 web is owner-only, enforced by the server**: a staff login from the web gets `403 web_owner_only` and "இணைய உள்நுழைவு உரிமையாளருக்கு மட்டும். கைபேசி செயலியைப் பயன்படுத்தவும்." (web login is for the owner only; use the phone app). The phone stays the ledger of record.

**5. Where does the data live, and what about "their Google cloud account / own credits"?**

Live data stays in the phone's SQLite plus Cloudflare D1 as the sync hub; Google login moves no data into Google. The honest way to put the data in the owner's Google account is a **daily encrypted backup into a visible Drive folder** plus an optional monthly CSV (phase C, not built). It needs only the non-sensitive `drive.file` scope, so publishing the consent screen "In production" should need **no app verification**; brand verification is optional and only decides whether the consent screen shows the app name and logo or just the domain **[likely: Google Cloud help 15549049; to be confirmed on `workers.dev` in the phase-C spike]**, so a custom domain is optional. Until phase C, Settings → Backup shares the export file to Drive by hand. There are no ongoing Google Cloud credits.

**6. Supabase pausing: use it or not?**

Do not use it. Free projects pause after one week of low activity, which stops login and sync on every device until someone restores it by hand, and the free plan has no backups **[verified]**; Pro is $25/month.

---

## Recommendation in one page

| Layer | As built |
|---|---|
| Speech-to-text | Android: Google `SpeechRecognizer` via `@capgo/capacitor-speech-recognition` 8.3.2; web: Web Speech API, Chrome tested; a fake engine (`window.__KK_FAKE_SPEECH__`) drives the e2e |
| Understanding | Deterministic parser on the phone, `core/voice.ts`, reusing the ledger's transliteration, folding and matching |
| Confirmation | The existing entry screen pre-filled, with a voice banner; the unchanged Save path. **Never auto-save** |
| Accounts | Inside the existing Worker: client-side PBKDF2 600k + server HMAC verifier; Google ID tokens with nonce; sessions = `devices` rows; step-up; audit; Workers Free |
| Web app | Same Vite UI as Workers static assets, cookie session, owner-only, shared-computer mode |
| Data · boosters | Phone SQLite (record) → D1 (hub) → browser copy; Drive backup and R2 export are phase C · Sarvam STT and a Workers AI interpreter only if field data calls for them (phase D) |

**Order of work:** A. voice on Android (built) → B. accounts and web (built) → field test on the shop's phones (open) → C. Drive backup (open) → D. boosters (conditional).

**Rejected (one line each)**
- **Supabase free:** pauses after 7 idle days; no backups; Pro $25. **Firestore as the live store:** a rewrite; transactions fail offline. **Google Drive as the sync engine:** no transactions, no ordering.
- **Whisper (Workers AI):** whisper-large-v3 ≈ 48.6% WER on FLEURS-Tamil (vendor figure) **[likely]**.
- **Deepgram Nova-3, OpenAI, AssemblyAI:** 52–68% OI-WER (orthography-insensitive word error rate) on real Indian Tamil: GPT-4o-mini-transcribe 51.9%, AssemblyAI Universal 57.4%, GPT-4o-transcribe 64.2%, Deepgram Nova-3 67.8% **[likely: Voice of India benchmark]**; paid Gemini 3 Pro scores 15.7% and Sarvam's 14–15% figures are OI-WER too.
- **Gemini free tier:** its terms forbid personal information; customer names are personal information **[verified]**. **Bhashini** (proof of concept only), **Gemini Nano** (no Redmi, no Tamil), **Vosk / on-device Whisper** (no Tamil model, or 250–470 MB).
- **argon2id on the server:** 190–250 ms per hash, needs Workers Paid; replaced by client-side stretching (3.3). **Better Auth / Lucia, Cloudflare Access, Appwrite, Neon:** do not fit the device/sync model, or pause / cold-start.

---

## 1. Voice mode

### 1.1 What the shopkeeper sees (built: `ui/voice/`, screens `home.ts`, `customer.ts`, `quick.ts`, `entry.ts`)

| Screen | Mic | Behaviour |
|---|---|---|
| **Customer page** | top-bar icon | The page's customer is the default; "100 kuduthaan" needs no name. If a name is spoken, the **page's customer is kept whenever it scores within 0.10 of the best other customer**, so "Ramu 100 kattinaan" on Ramu-1's page stays on Ramu-1 although Ramu-2 also scores 1.0; the picker (with C-code and phone last 4) appears only when another customer beats it by ≥ 0.10 or the name does not match the page's customer at all. The most accurate mode; teach it first |
| **Home** / **Quick entry** | beside the search row | full sentence, "Ramu 100 kuduthaachu" |

Mics are hidden when Settings → Voice is Off. **Listening:** tap to start, tap again to stop; the recogniser's own endpoint ends the session, the Android adapter also ends it 2.5 s after the partial text last changed (Google's dictation mode can keep a session open across pauses), and a hard cap of 12 s applies. The sheet shows a pulsing mic, "கேட்கிறேன்…", the live transcript, a hint sentence, Cancel and Done; going to the background stops it. Before listening the app checks the privacy notice (accepted once), `available()`, online and the microphone permission, each with a plain message; silence → "nothing heard" + Try again. The keypad is always one tap away.

**The confirmation is the existing entry screen**, opened through the customer page so that Save lands there. In voice mode it shows a banner: **Heard:** the transcript; the **amount source in large type** ("ஐநூறு → ₹500") beside the usual amount in words, so a misheard "ainooru" for "aayirathu ainooru" is visible; **due before → after**, live; for medium or low confidence the "check before saving" line; and, when the alternatives disagreed on the amount, chips "Or did you say: ₹100 ₹1,000" that fill the keypad on tap. **When the direction is unknown** the title reads "பற்றா, வரவா?", neither side is selected and **Save is disabled** until one is tapped (the Enter key goes through the same `save()`). Saving is the unchanged path: the large-amount, advance and duplicate dialogs, the Undo toast, the outbox and sync.

**Other outcomes:** one strong match (score ≥ 0.85, next best ≥ 0.10 lower) → keypad pre-filled; customers close together → a picker sheet (name, C-code, phone last 4, balance, "Add '…'"); no match → "Add new customer 'Suresh'?" → customer form → keypad, pre-filled; a balance question → a dialog, nothing created; several entries → a queue of keypads ("1 of 2", "2 of 2"; at most 5); no name on Home → "say the name too"; no amount → the keypad empty.

**Settings → Voice**: On/Off, spoken language (தமிழ் / English), the kuduthaachu question (Credit — paid [default] / Debit — took goods), **"Try voice"** (type or speak a sentence; shows what the parser made of it; saves nothing), the counters `voice_stats` {heard, saved, amount_edited, kind_changed, cancelled} with Reset, and the privacy line. Preferences and counters live in the `meta` table per phone, never synced.

Not built: hold-to-talk, a spoken read-back, learned aliases, a `voice_log` table, syncing the kuduthaachu answer, and Android name biasing (the plugin ignores `contextualStrings` **[verified]**).

### 1.2 Pipeline (built)

```
mic tap → platform().speech.listen({lang, onPartial, maxAlternatives:5, biasPhrases: customer names, maxMs:12000})
  → string[] (best first, deduplicated; [] = silence)
  → parseUtterance(alts, customers, {bareKuduthaachu}, {contextCustomerId}) → VoiceIntent[]   // no network
  → plan.ts: keep page customer | strong match | picker | add new | balance dialog
  → customer page → entry screen with state.voice (VoicePrefill)
  → shopkeeper taps Save → the unchanged Save path → outbox → existing sync
```

`platform/types.ts` `Speech`: `available()`, `ensurePermission()`, `listen(opts)`, `stop()`; `listen` rejects `SPEECH_UNAVAILABLE | SPEECH_PERMISSION | SPEECH_ERROR:<code>`. Errors Google emits after our own `stop()` (it often answers `stopListening()` with `ERROR_CLIENT`) do not reject: the session resolves with what was heard. `fake-speech.ts` (`createFakeSpeech(script)`, `window.__KK_FAKE_SPEECH__`) replaces the recogniser in Vitest and Playwright.

### 1.3 Android specifics (built)

- Manifest: `RECORD_AUDIO` declared; `<queries>` for `android.speech.RecognitionService` present (required from API 30) **[verified: merged manifest, `aapt2`]**.
- Plugin facts the adapter relies on **[verified: `SpeechRecognitionPlugin.java` of 8.3.2]**: inline recognition, `partialResults:true`, `EXTRA_MAX_RESULTS = maxResults`, `DICTATION_MODE`; no biasing strings; no background handling. Capgo releases almost daily, so the version is pinned exactly to a release at least two weeks old, and the diff is reviewed before each bump. The debug APK builds **[verified]**.
- Unverified until the shop's Redmi phones are in hand: how many alternatives Google returns for `ta-IN`, whether it swallows "-க்கு" after vowel-final names, offline Tamil packs. Onboarding asks the owner to turn off Google's Voice & Audio Activity on shop phones.

### 1.4 Web specifics (built)

- Chrome (desktop and Android) is the tested target; audio goes to Google. Edge and Safari expose the API with unverified Tamil quality (MDN: limited availability **[verified]**); Firefox has none, so `available()` is false and the mic is hidden.
- Chrome 139 stable shipped unprefixed `SpeechRecognition` and the on-device mode (`processLocally`, `SpeechRecognition.available()`, `install()`); it is marked experimental, not hidden behind a flag **[verified: developer.chrome.com/blog/new-in-chrome-139; MDN browser-compat-data]**. `speech-web.ts` feature-detects `available({langs:['ta-IN'], processLocally:true})` in try/catch, informational only; `listen()` never sets `processLocally`. A Tamil on-device pack is unlikely (unverified); if one appears it would give the web a no-cloud option.
- `phrases` (contextual biasing) is listed in MDN's browser-compat data as Chrome 142+ (experimental) while Chrome Platform Status still shows "Proposed" **[likely]**; MDN's example pairs it with `processLocally`, so it may apply only on-device. The adapter feature-detects it, wraps it in try/catch and retries once without phrases on `phrases-not-supported`.
- A hidden tab stops the session; inside the Capacitor WebView the native plugin is always used.

### 1.5 Offline behaviour

The parser, the confirmation and saving work offline, as today. Recognition needs internet (no offline Tamil pack is known): with no network the mic says "voice needs internet" and the keypad stays available.

### 1.6 Privacy (DPDP Act)

Audio goes to Google's speech service (Android) or Chrome's backend; the bias phrases sent with it are customer names (ignored on Android). No audio is stored anywhere; balances, phone numbers and the ledger never leave the phone through voice. The notice is shown on the first mic tap in Tamil and English and repeated in Settings → Voice. `voice_prefs` and `voice_stats` stay on the phone; nothing spoken is stored, so erasure needs no voice clean-up. Phase D would add the transcript plus up to 8 candidate names to Workers AI, or audio plus up to 50 names to Sarvam (India; retention 0 days), both off by default. The Gemini free tier is never used with real names.

---

## 2. Understanding Tamil (built: `core/voice.ts`; fixtures `test/fixtures/voice-utterances.json`, 385 cases in 20 categories)

### 2.1 Normalising and tokenising

1. NFC, Tamil digits → ASCII, "1,500" kept whole, "100ரூபாய்" split, a dative suffix split off a name (`-kku`, `-ukku`, `-vukku`, `-ku`, `க்கு`, `வுக்கு`, a hyphen, or a separate "ku" token), longest suffix first. Honorifics carrying the dative ("Sita akkavukku") mark the name dative instead of leaking into the note.
2. Fold: **digit tokens are never folded** (`phoneticFold` collapses repeats: "100" would become "10"); **English lexicon words are looked up raw** ("fifty" would fold to "pipty"); everything else becomes `phoneticFold(transliterateTamil(tok))`, so குடுத்தாச்சு and kuduthaachu share the key `kututasu`.
3. **Raw-matched labels (finding 21).** பற்று folds to `paru`, which is also the fold of பாரு / "paaru" ("look"), a common filler at the counter **[verified: ran `ledger.ts`]**. The app's labels பற்று, வரவு and Latin `patru`, `pattru`, `varavu` are therefore matched on the raw NFC lower-cased string, never fuzzily, and a `FORBIDDEN_FOLD_KEYS` guard keeps `paru` out of the folded lexicon. "Ramu 100 paaru", "ராமு 100 பாரு", "paru" and "parru" preselect nothing.
4. Tag tokens (number, cue, dative name, item, quantity, stop word, date, negation, name), merge number words into runs, and split into entries: a new name after an entry that already has a name and an amount starts the next entry.

### 2.2 Direction lexicon

`CUES` holds 388 surface forms (165 folded keys plus raw English and label forms) and 12 regex conjugation fallbacks. Tamil marks the person on the verb, and that decides the direction: *kudu* (give) **about the customer** = he paid = Credit, **said by the shop** = Debit; *vaangu/edu* (take) the other way round.

| Family | Examples | Direction |
|---|---|---|
| customer gave (3rd person) · shop gave (1st person) | kuduthaan, koduthaaru, kuduthaanga · kuduthen, koduthom | Credit · Debit |
| customer paid | kattinaan, kattittaanga, kattiyaachu, settle, varavu, jama, vandhuchu, gpay/phonepe/UPI (sets mode UPI) | Credit |
| customer took · shop received | vaanginaan, vaangittaan, eduthaan · vaanginen, vaangittom, kitta irundhu | Debit · Credit |
| impersonal **kuduthaachu** | kuduthaachu, koduthaachu, kuduthaa | **shop setting** (default Credit); with a dative on the name → Debit |
| nouns, items, light verbs | kadan, baaki, udhaar; arisi, paal…; ezhuthu, podu | weak Debit (+ note for items) |
| English agents | NAME gave/paid → Credit; I/we paid NAME, gave to NAME → Debit; NAME took/bought → Debit | by subject |
| labels · bare "credit"/"debit" | பற்று / patru / pattru → Debit; வரவு / varavu → Credit (raw match) · ambiguous | explicit · no preselect |

**Composition rules as built**
1. **Dative on the name means the customer received**: "Ramukku 100 kuduthaachu", "Ramu kitta 100 kuduthaachu" → Debit; "Ramu-kku 250 arisi kuduthen" → Debit, note "arisi".
2. **Conflicts:** when the direction rests only on a dative that another alternative did not hear (`["Ramukku 100", "Ramu 100"]`), or alternatives give opposite directions, `kind` is null. This net needs several alternatives, unverified for `ta-IN`.
3. **Verbs outrank nouns:** "kadan kattinaan" is Credit; a noun or item alone is a weak Debit guess (never *high*). An entry without its own cue inherits the sentence's cue at reduced confidence. "illa/no" corrects: "Ramu 100 illa 150 kuduthaan" → ₹150; "evvalavu" asks the balance; "nethu" dates yesterday.
4. **Confidence is categorical**, `high | medium | low`. `high` requires an amount undisputed by every alternative; an explicit verb or label (not bare kuduthaachu, a dative alone, a fuzzy match, mixed, item-only, inherited or conflicting); and one customer ≥ 0.85 that is clearly best (gap ≥ 0.10), or the page's customer kept with score ≥ 0.85. Test invariants enforce this on every fixture. A bare kuduthaachu is at most `medium`, so the UI adds the "check before saving" line. `medium` and `low` still preselect the parsed direction; only `kind: null` disables Save.
5. **Shop setting:** what a bare "Ramu 100 kuduthaachu" means is a per-phone preference (`voice_prefs.bare`, default Credit).

**Honest limit.** If "-க்கு" is dropped from every alternative, "Ramukku 100 kuduthaachu" reads as Credit at medium confidence; the guards are the check line, the due before → after line and Undo. Whether Google swallows the dative after vowel-final names is the first thing to measure on the shop's phones.

### 2.3 Number grammar (`parseAmount`)

Digits (with Tamil digits and "1,250"); units, teens, tens (fused irubathanju = 25), hundreds, "N nooru" for thousands as shops count (pathinanju nooru = 1,500), combining forms (aayirathu ainooru = 1,500), unit × aayiram, lakh, digit × multiplier word ("2 ஆயிரம் 500" = 2,500, the hybrid `amountInWords` prints), fractions (rendarai aayiram 2,500, kaal/mukkaal), Indian English ("two fifty" = 250), rupee words as an end marker. Among several numbers: drop quantities (kilo/litre/packet), phone numbers and a number after "C"/"code"; prefer the one next to ₹/rupay. Output goes through the integer-safe `toPaise`, capped at `MAX_AMOUNT_PAISE`. `amount_text` records the words the amount came from.

**Across alternatives (finding 8):** when alternatives disagree on the amount ("சீதா ஆயிரத்து ஐநூறு" 1,500 vs "சீதா ஐநூறு" 500; ainooru 500 vs aimbadhu 50), the other values come back as `amount_alternatives`, confidence is capped at `medium`, and the UI shows chips. **Honest limit, single alternative:** with one alternative a dropped "aayirathu" fills ₹500 silently, below `confirm_above_paise`. The cross-alternative check is **not counted as a safety net** until field logs show that several alternatives come back. Until then the guards are the amount source in large type beside the heard words, the amount in words, the due before → after line, and the `amount_edited` counter, a gate metric. Known weak case: a second number next to a rupee word wins ("Senthil 300 pathu rooba" → ₹10).

### 2.4 Customer resolution (`matchCustomers`)

Name span = the tokens left after numbers, cues, items, dates and stop words. Each customer is matched on `name` and `search_name`, folded word by word: score = max of `1 − levenshtein / maxLen` on the whole form, 0.95 × the same on the first word ("Ramu" vs "Ramu Tea Kadai"), 0.85 for a `matchesQuery` prefix hit; a spoken C-code is exact. Archived customers match only while they owe or are owed money; erased ones never. Up to 3 matches come back; namesakes come back with equal scores, so the UI shows the picker. **Context (finding 9):** with `contextCustomerId`, the page's customer is kept (`context_kept: true`) when no name is spoken or when the spoken name scores within 0.10 of the best match; otherwise `context_kept: false` with the candidates (possibly empty, for an unknown name). Names that collide with lexicon words (Kaasi vs kaasu) win in the name position.

### 2.5 Parser interface and worked examples

`parseUtterance(alternatives, customers, settings?, {contextCustomerId?})` returns one `VoiceIntent` per spoken entry: `heard`, `name_text`, `matches` (up to 3, best first), `amount_paise`, `kind` (`GIVE | RECEIVE | null`), `kind_reason`, `note`, `confidence` (`high | medium | low`), plus `amount_text`, `amount_alternatives`, `date_offset`, `mode`, `balance_query`, `context_kept`. Also exported: `parseAmount`, `detectKind`, `matchCustomers`, `needsHelp` (the phase-D LLM seam; the UI decides).

| Transcript (alternatives) | Customer | Amount | Kind (confidence) | Screen |
|---|---|---|---|---|
| ராமு 100 குடுத்தாச்சு (default setting) | Ramu | ₹100 | Credit (medium) | Credit selected + check line |
| Ramukku 100 kuduthaachu / Ramu kitta 100 kuduthaachu | Ramu | ₹100 | Debit | Debit selected |
| `["ராமுக்கு 100 குடுத்தாச்சு", "ராமு 100 குடுத்தாச்சு"]` · `["Ramu 100 kuduthaan", "Ramu 100 kuduthen"]` | Ramu | ₹100 | null (conflict) | nothing selected, Save disabled |
| Ramu-kku 250 arisi kuduthen | Ramu | ₹250 | Debit (high), note "arisi" | Debit |
| `["சீதா ஆயிரத்து ஐநூறு கட்டியாச்சு", "சீதா ஐநூறு கட்டியாச்சு"]` | Sita | ₹1,500 + alt ₹500 | Credit (medium) | chip "Or did you say: ₹500" |
| Kumar gpay one fifty · நேத்து செல்வி ரெண்டாயிரம் கட்டிட்டாங்க | Kumar · Selvi | ₹150 · ₹2,000 | Credit (high), mode UPI · Credit, date −1 | Credit |
| Ramu 100 credit · Ramu 100 பற்று · Ramu 100 paaru | Ramu | ₹100 | null · Debit · **null** | ask · Debit · ask |
| Kumar 200 kattinaan Ravi 300 vaanginaan | Kumar, Ravi | 200, 300 | Credit, Debit | queue "1 of 2", "2 of 2" |
| (on Ramu-1's page, Ramu-2 exists) Ramu 100 kattinaan | Ramu-1 (`context_kept`) | ₹100 | Credit (high) | Credit on Ramu-1, no prompt |
| (on Ramu's page) Sita 100 kattiyaachu | Sita beats Ramu | ₹100 | Credit | picker with C-code and phone |

Fixture accuracy: every category 100% except `misspellings` (amount 95.8%, one `known_weak` case); total n = 385, name 100%, amount 99.7%, kind 100%.

### 2.6 LLM fallback (phase D, conditional, not built)

Built only if a few weeks of `voice_stats` show more than about 15% of voice entries needing a direction or amount edit that lexicon changes cannot fix. Called only online, with "AI help" switched on by the owner, for unsure parses (`needsHelp()`). Endpoint `POST /v1/voice/interpret`: device auth, a per-shop daily cap of 300, 4 s timeout, transcripts not stored. Model `@cf/google/gemma-4-26b-a4b-it` on Workers AI: 9,091 neurons per M input tokens and 27,273 per M output **[verified]**; 1,200–2,000 input and ~150 output tokens cost **about 15–22 neurons per call** (1,200 × 9,091/M + 150 × 27,273/M ≈ 15.0; 2,000 + 150 ≈ 22.3), so roughly **450–670 free calls a day** within the 10,000 free neurons **[likely: arithmetic from the verified rates]**, above the cap. Cloudflare does not train on customer content **[verified]**; Gemma's Tamil quality and JSON-schema support are unverified; the parser stays fully usable without it. The request carries the transcript, alternatives and candidate names as refs, never balances, phone numbers or the ledger; the answer is a JSON schema `{intent, entries[{customer_ref, spoken_name, amount_rupees, kind GIVE|RECEIVE|UNSURE, item, date, evidence}]}`. **The answer is a hint, never the authority:** a schema error keeps the parser's result; `customer_ref` must be one sent; `amount_rupees` must equal a number the parser found; a kind contradicting a strong parser cue is a conflict; UNSURE means no preselect. Paid alternative: `gemini-3.5-flash-lite` ($0.30 / $2.50 per M tokens **[verified]**) ≈ ₹145–195 a month (likely).

### 2.7 Never automated

Saving any money entry (no hands-free save, ever); choosing between similar names; preselecting a direction on a conflict or a disputed dative; filling an amount that was not spoken or picking one of two heard amounts; creating a customer; reversals and WRITEOFF (Undo stays a button); amounts above `confirm_above_paise` still get the dialog.

---

## 3. Accounts & authentication (built: `api/src`, migrations `0002`, `0003`; `app/src/sync`, `ui/screens/login.ts`, `settings.ts`)

### 3.1 Why accounts, and what is the minimum

Pairing already links phones. Accounts add a browser login and a way back in after losing every phone without the printed recovery code. The built minimum: an owner login (user id + password, or Google), staff logins the owner creates, sessions as device rows; no email, no SMS, no self sign-up. Existing paired phones keep working unchanged (`user_id NULL`).

### 3.2 Model (`0002_accounts.sql` + `0003_accounts_hardening.sql`)

- **users** (one shop): `username` (lower case, 3–32 of `a-z 0-9 . _ -`, so a mobile number works), `display_name`, `role` owner|staff, `pw_salt`/`pw_iterations`/`pw_verifier`, `google_email`/`google_sub`/`google_email_set_at`, `disabled_at`. The server is single-shop; a `memberships` table is deferred to a multi-shop v3.
- **devices** gain `user_id`, `client` ('android'|'web'), `expires_at`, `stepup_until`.
- **Every login creates a `devices` row** exactly like `/pair` (own token, code block, authorship, pull skipping its own rows, revoke-with-wipe) and returns a `PairResponse`-compatible `LoginResponse` plus `user`, `known_device`, `expires_at`, `shared` **[verified: `shared/protocol.ts`]**. **Push and pull bodies are unchanged.** Web logins get **`code_block: null`** and `token: null`: the browser never creates customers offline; it syncs first and asks `POST /devices/code-block` when it needs codes, so a daily shared-computer login does not burn 50 codes.
- Rules: the last enabled owner cannot be demoted or disabled; nobody changes their own role or disables themselves; disabling revokes the user's devices and their unused codes in one transaction; demoting an owner ends their web sessions.

### 3.3 Passwords: stretched on the client, verified with one HMAC

```
client:  POST /auth/prelogin {username}                       -> {salt, iterations: 600000}
         client_key = PBKDF2-HMAC-SHA256(NFC(password), salt, 600,000, 32 bytes)      // WebCrypto, on the device
         POST /auth/login {username, client_key (base64url), device_name, client, ...}
server:  verifier = HMAC-SHA256(PEPPER, "kk-pw-verifier-v1:" || client_key)            // ~18 µs
         constant-time compare with users.pw_verifier
```

**Why.** A server-side hash at OWASP strength costs 90–250 ms of CPU in workerd (PBKDF2 600k ≈ 90 ms, argon2id ≈ 200 ms), far over the Free plan's 10 ms; and workerd caps WebCrypto PBKDF2 at 100,000 iterations by design **[verified: `limit-enforcer.h`]**. Moving the stretching to the client (as Bitwarden does) leaves the server one HMAC, so **passwords cost ₹0 on Workers Free** **[verified: `test/cpu.test.ts`]**.

**Properties.** A leaked D1 copy without `PEPPER` is useless for guessing; with the pepper each guess still costs a full 600k PBKDF2. `prelogin` answers unknown, disabled and password-less users with a deterministic fake salt and the same count, status and work; `login` answers unknown user and wrong password with the same `403 invalid_login` against a dummy verifier, so users cannot be enumerated.

**Caveats (deliberate):**
- (a) **`client_key` is password-equivalent on the wire** (pass-the-hash) and is also the step-up proof. It travels only over TLS, is never stored or logged, and an XSS on the web login page would capture it exactly as it would a typed password. Hence the strict CSP (3.5), the rule that the client kind is not a boundary, and the audit of every login. 3.9 names the one mitigation not yet built.
- (b) **Iterations are pinned to 600,000**: any other count is refused (`400 'iterations'`), so a hostile client cannot register a cheap verifier, and `prelogin` returns 600k for everyone, so the count never reveals that a user exists.
- (c) **Phone speed is unmeasured on the Redmi.** PBKDF2 600k takes ≈ 90–100 ms on a Xeon; a budget phone's WebView may take a few seconds (unverified). The button shows "Securing the password…"; never lower the count to make it faster.
- (d) The server never sees the password, so the policy is client-side: at least 8 characters, typed twice.

**Login id:** a 10-digit mobile number works; the login screens are Tamil first. The owner's own login id should still not be the shop's public number.

### 3.4 Google Sign-In (web built; Android server-ready, client not built)

- **Worker (`lib/google.ts`):** RS256 verified with WebCrypto against Google's cached JWKS, no `jose`. Checks: signature, `iss`, `aud` **in the list for the declared client kind** (`GOOGLE_CLIENT_IDS` for web, `GOOGLE_ANDROID_CLIENT_IDS` for android; an empty list answers 404, so a web token can never mint an Android bearer token), `exp`/`iat` with 5 min skew, `email_verified`, the **`nonce`** claim, and for a `GOOGLE_HD` address the `hd` claim **[verified: code]**. About 60–85 µs with a cached key.
- **Nonce:** `POST /auth/nonce` mints an HMAC-signed value valid 10 minutes; the client passes it to `google.accounts.id.initialize({nonce})`; `/auth/google` requires it in the token and consumes it in `used_nonces`, so a leaked ID token cannot be replayed; the login page re-mounts the button with a fresh nonce after a failed attempt.
- **Linking: the owner pre-registers the email, hardened.** The owner sets `google_email` on a user from an owner phone (step-up, audited). The first Google sign-in with that verified address links its `sub`; from then on only that `sub` signs in. Only `@gmail.com` / `@googlemail.com` (or the configured `GOOGLE_HD`) are accepted, because an address at Yahoo, Rediffmail or a lapsed domain can be registered as a Google account by someone else **[likely]**. An unlinked address **expires 48 h** after it was set. Never creates users.
- **Web:** a Google Identity Services button, shown only when `GET /config` returns a `google_client_id`. Setup is free in the shop's Google account: consent screen with `openid email profile` published "In production" (no app verification for these scopes), one Web application client id with the Worker's origin, the id in `GOOGLE_CLIENT_IDS` **[verified: `api/README.md` steps]**. Wired but untested against real GIS here (no client id).
- **Android:** not in this build; needs Android OAuth client ids in `GOOGLE_ANDROID_CLIENT_IDS` plus a Credential Manager plugin (`@capgo/capacitor-social-login`).

### 3.5 Sessions = device rows; step-up; web restrictions; CSP

**Tokens** are opaque, stored as `sha256(token‖PEPPER)` as before, not JWTs. **No rotation**: on Android, push and pull overlap and MIUI can kill the app between the server rotating and the Keystore write, which would revoke the ledger-of-record phone. Web sessions rely on absolute expiry and remote revoke (no idle timeout).

`android` (and v1 paired phones): `Authorization: Bearer`, token in the Keystore, no expiry, remote revoke. `web`: cookie `kk_session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/v1; Max-Age=2592000`, 30 days (`devices.expires_at`, enforced server side); with "shared computer" the cookie has **no Max-Age** (dies with the browser), no `kk_known` cookie is set, and the session ends after 12 h.

**Transport binding:** a web token is never accepted as a Bearer and an app token never as a cookie. **CSRF:** every cookie-authenticated request, any method, must carry `X-KK-Client: web`, else `403 csrf`; a cross-site page cannot add the header without a CORS preflight this Worker never grants with credentials, and `SameSite=Strict` is the first layer **[verified: `lib/auth.ts`]**. `workers.dev` is on the Public Suffix List, so sibling tenants cannot plant the cookie **[verified]**; **before any custom domain** it must be renamed `__Host-kk_session` with `Path=/` (3.9).

**The client kind is not a security boundary.** `client` is whatever the login body says, so owner-power routes gate on **step-up**, not on kind; refusing web there is defence in depth.

**Step-up** (`lib/stepup.ts`). Owner-power routes: `POST /users`, `PUT /users/:id` (when `role`, `google_email` or `disabled` is present), `PUT /users/:id/password` for another user, `POST /devices/pair-code`, `POST /devices/recovery-codes`, `POST /devices/:id/revoke`; and, from any owner session including the web, `PUT /shop` when `upi_id` changes and `POST /customers/:id/erase`. The caller proves the owner is present now with `X-KK-Stepup: <client_key>` (the current password, re-derived, verified like a login with the same backoff) or `X-KK-Recovery: <printed code>` (consumed; works for a legacy paired phone and a Google-only owner). A proof opens a **5-minute window** on that device row (`devices.stepup_until`). Without a proof: `403 stepup_required` (with the `stepup` list); wrong: `403 stepup_invalid`, `429 locked` after 5. **Bootstrap:** while the shop has no users at all, a legacy owner phone keeps its v1 powers so it can create the first owner login (`link_me`). **The app PIN is a client-side guard only**; the server cannot see it, which is why the app requires a PIN before "Create a login for me".

**Web sessions** get `403 web_forbidden` on the credential routes (users, another user's password, pair-code, recovery-codes, revoke); reads, sync and their own password change are allowed. Staff web logins are refused outright (`403 web_owner_only`).

**Audit.** Every login (ok, failed, locked, refused), step-up, logout and owner-power action writes `auth_events` (actor, action, target, a small JSON detail, never credentials; 90-day retention). `GET /auth/events` (owner, newest 200) is Settings → Activity, so the owner can see "login created from a phone at 02:00" and revoke it.

**CSP** (`api/web/_headers`, copied into `dist-web/` by `scripts/prepare-assets.mjs`; asserted by `test/assets.test.ts`) **[verified]**:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client;
style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; connect-src 'self' https://accounts.google.com;
frame-src https://accounts.google.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```
`'wasm-unsafe-eval'` is needed because the web ledger runs on sql.js (WebAssembly). The built `dist-web` has no inline script or eval **[verified: review]**.

### 3.6 Lockout, reset, recovery

**Lockout, as built** (`lib/lockout.ts`, `login_locks`) **[verified]**:
1. `AUTH_LIMITER` (Workers Rate Limiting, best effort): 20 requests / 60 s per client IP for each of prelogin, nonce, login, google.
2. **Per (username, source)**: source = the client's IPv4 **/24** or IPv6 **/48**, else `unknown`. From the 5th consecutive failure the pair is locked 30 s, doubling to 15 min (`429 locked`, `retry_after`), never permanently; a successful login or an owner reset clears it. One attacker locks only (owner, that network); a locked attempt is answered before the verifier and before the budget below.
3. **Known-device exemption.** Every successful login returns `known_device` = `<device id>.<HMAC(PEPPER,'kk-known-v1:'+id)>` (Android keeps it in secure storage and sends `X-KK-Known`; the web gets the cookie `kk_known`, one year, not on a shared computer). A later login carrying it for the **same user** skips the per-source lock and the shop-wide budget and has its own 5-failure backoff, so the owner's phone gets in while an attacker hammers the owner's username from the same CGNAT range.
4. Shop-wide: wrong-password logins from unknown sources per UTC day (`auth_failures`); after `AUTH_THROTTLE_AFTER` (100) one per 30 s (`429 throttled`). Known devices and attempts the per-source lock refused are never charged. Step-up attempts share the backoff.

**Reset without email:** **staff** → the owner resets the password from a phone (step-up; that user's devices are revoked). **Owner still signed in** → Change my password needs the current password; the PIN alone never changes a password. **Owner signed out everywhere** → pair a phone with a printed **recovery code** (the existing `/pair` path), reset the owner password from Settings → Users with a second code as the step-up proof, print a new sheet; a linked Google account also signs in. **Break-glass** (phones, codes and Google all lost) → the developer verifies the owner offline and mints a 24 h owner pairing code with `POST /setup` (`SETUP_KEY`). Email reset is v3.

### 3.7 Endpoints (`/v1`) and schema, as in `shared/protocol.ts`

| Method & path | Auth | Purpose |
|---|---|---|
| GET `/health` · POST `/setup` · POST `/pair` · `/sync/*` · GET `/export` · POST `/devices/code-block` | as in v1 | unchanged (pair takes an 8-digit code or a recovery code; the web asks for code blocks on demand) |
| GET `/config` · POST `/auth/prelogin` | none (+ limiter) | `{google_client_id, auth:{password:true}, version}` · `{username}` → `{salt, iterations: 600000}` (fake salt for unknown users) |
| POST `/auth/login` | none + limiter | `{username, client_key, device_name, client, previous_device_id?, previous_device_token?, shared_computer?, …}` → `LoginResponse` (web: cookie, `token: null`, `code_block: null`) |
| POST `/auth/nonce` · POST `/auth/google` | none + limiter | `{nonce}` single use, 10 min · `{id_token, …}` → `LoginResponse` (links a pre-registered Gmail within 48 h); both 404 when Google is off |
| POST `/auth/logout` · GET `/me` · GET `/auth/events` | session · session · owner | revoke + clear cookie · device/shop/`user` (`device.shared`, `expires_at`) · newest 200 `AuthEvent` rows |
| GET `/users` · POST `/users` · PUT `/users/:id` | owner (web ok) · owner device, step-up, not web · same, step-up for role / `google_email` / `disabled` | list · create (password material and/or `google_email`; `link_me` attaches a v1 owner phone) · update |
| PUT `/users/:id/password` | self with `current_client_key` (web ok) · owner device with step-up for others | set a password; other devices revoked |
| GET `/devices` · POST `/devices/:id/revoke` · `/devices/pair-code` · `/devices/recovery-codes` | owner; the three writes need step-up, not web | v1 routes, hardened |
| PUT `/shop` · POST `/customers/:id/erase` | owner; step-up for `upi_id` and for erase | audited `shop.update` / `customer.erase` |

**Device takeover on login** (`lib/session.ts`): `previous_device_id` is revoked, and its unused codes moved, **only** when that row belongs to the same user, or it is a legacy row and `previous_device_token` is its still-valid bearer token; anything else revokes nothing (device ids are visible to every phone through pulled entries). Recovery codes never move onto a web device. `/pair` keeps its v1 rule.

**Migration from pairing (no re-pairing):** the owner phone sets a PIN, then Settings → "Create a login for me" (`link_me`), prints recovery codes, creates staff users; each staff phone signs in with user id + password (its old paired row is taken over with its token). Pair codes stay available.

**D1 schema** **[verified: files]**. `0002_accounts.sql` (applied; never edited): `users` (`id`, `shop_id`, `username` with the CHECK of `USERNAME_RE`, `display_name`, `role` CHECK owner|staff, `pw_salt`, `pw_iterations`, `pw_verifier`, `google_email`, `google_sub`, `created_at`, `updated_at`, `disabled_at`, `failed_count`, `locked_until`; UNIQUE `username`, `google_sub`, partial unique index on `google_email`); `devices` + `user_id` (NULL = v1 phone), `client` CHECK android|web, `expires_at`; `login_throttle(username)`; `auth_failures(day)`. The per-user lock columns and `login_throttle` are superseded by 0003 and no longer written. `0003_accounts_hardening.sql` (delta):

```sql
ALTER TABLE devices ADD COLUMN stepup_until TEXT;
ALTER TABLE users ADD COLUMN google_email_set_at TEXT;   -- backfilled to now for unlinked addresses
CREATE TABLE login_locks (username TEXT NOT NULL, source TEXT NOT NULL, failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (username, source));
CREATE TABLE used_nonces (nonce_hash TEXT PRIMARY KEY, used_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE auth_events (id TEXT PRIMARY KEY, shop_id TEXT, at TEXT NOT NULL, actor_device_id TEXT,
  actor_user_id TEXT, action TEXT NOT NULL, target_user_id TEXT, target_device_id TEXT, detail TEXT);
-- plus indexes login_locks(updated_at), used_nonces(expires_at), auth_events(shop_id, at)
```

There is no `0004`. The v2 blocks of `shared/protocol.ts` are additive. Vars: `AUTH_THROTTLE_AFTER`, `GOOGLE_CLIENT_IDS`, `GOOGLE_ANDROID_CLIENT_IDS`, `GOOGLE_HD`; secrets `PEPPER` (required), `SETUP_KEY`.

### 3.8 The ₹0 path, and why Paid stays optional

Password login, Google verification and pairing all run on Workers Free: measured in workerd, password/step-up check ~18 µs, nonce 13/17 µs, known-device MAC 7 µs, RS256 verify ~65 µs; a prelogin + login round trip including local D1 I/O ~14 ms wall **[likely: local; production may differ by ~2×; `test/cpu.test.ts` fails if the CPU grows]**. **Workers Paid ($5 ≈ ₹440/month) is optional.** It removes the Free plan's daily caps (100k requests, 100k D1 row writes a day **[verified]**: hitting them stops auth and sync until 00:00 UTC) and extends D1 Time Travel from 7 to 30 days; the Worker's own `DAILY_REQUEST_CAP` (5,000) keeps the shop well inside Free.

### 3.9 Open follow-ups (not built)

- **New owner-role Android login approval.** A `client_key` captured on the web page (XSS, a malicious extension) can log in as `android`, step up with the same key, revoke the owner's phones and change the UPI id; the web-only restrictions do not apply to that lane. In place: strict CSP, nonce, and `auth_events` (`login.ok` with `client: 'android'` from an unknown source is visible on other owner devices). Not built: requiring an existing owner device's approval or a recovery code for a **new** owner android login (a client flow; it also slows the "lost every phone" recovery). Until then, script on the login page equals the password.
- Android Google sign-in; invite-code/QR linking by `sub`; `/pair` still uses the v1 takeover rule; web idle timeout; the `__Host-` cookie rename before any custom domain; PBKDF2 timing on the Redmi WebView; deployment and the CPU check on a real Free Worker.

---

## 4. Cross-platform web app (built: `app/src/ui/web/`, `vite build --mode web` → `dist-web/`, flag `__WEB_APP__`)

**Hosting:** the Worker serves `../app/dist-web` as static assets (free and unlimited **[verified]**) with `run_worker_first: ["/v1/*"]`; `scripts/prepare-assets.mjs` writes `_headers` before every `wrangler dev` / `deploy`. One origin: no CORS, a first-party cookie. `tools/deploy-server.sh` builds the web app before `wrangler deploy`.

**Reuse:** every screen, `core/*`, `data/repo.ts` and the sync engine already ran in the browser preview on sql.js + IndexedDB. The web build adds the login gate, cookie mode in `sync/api.ts` (`credentials:'same-origin'`, `X-KK-Client: web`, no Authorization header, no token in storage), GIS, desktop width, and hides phone-only controls. Not built: a service worker / installable PWA; the web app is an online client.

**Shared computer:** ticked at login → `openRepo({memory:true})`, in-memory private files and secrets, `shared_computer: true` → 12 h session, cookie without Max-Age, no `kk_known` cookie; the gate says "nothing is kept on this computer". Unticked: a copy stays in this browser, 30-day session, "Sign out removes it". **Boot order (`boot.ts`):** a persisted copy is opened only when one already exists; otherwise the app starts in memory, asks `GET /me` whether the cookie still names a session, and switches to the persisted database only when the server says the session is **not** shared (`device.shared`; unknown counts as shared). So a reload on a shared computer rebuilds the ledger in memory and never writes IndexedDB **[verified: e2e reload step]**.

**Sessions ending:** a 401 (expired or revoked from a phone) shows the unsynced count, wipes IndexedDB, localStorage and sessionStorage, and returns to the login page; **Sign out** does the same after revoking the server device. "+ Customer" works only online and in sync: the browser gets no code block at login and asks for one on demand.

**Owner-only, enforced by the server (3.5).** Staff get the bilingual `web_owner_only` message and no ledger download; when staff web arrives, the server will force shared mode for them.

---

## 5. Data storage & sync

| Copy | Role | Notes |
|---|---|---|
| Phone SQLite | ledger of record | unchanged |
| Cloudflare D1 (`apac`) | sync hub | Free: 5M row reads, 100k writes/day, the shop uses ~10%; Time Travel 7 days (30 on Paid) |
| Browser (sql.js / IndexedDB) | web client | memory only on shared computers |
| Owner's Google Drive · R2 (phase C) | daily encrypted backup + monthly CSV · nightly export cron | `drive.file`, visible folder (today: Settings → Backup share sheet → "Save to Drive") · 10 GB free (likely) |

**Phase C design (not built):** once a day on the owner phone, when online and 20 h since the last backup: build the export JSON, encrypt it with AES-GCM under a key derived once from an owner passphrase (kept in the Keystore), upload `kadan-YYYY-MM-DD.kkbak` to the folder "Kadan Kanakku Backups"; the readable copy is the monthly CSV; the owner may choose unencrypted. Rotation 30 dailies + 12 monthlies, so erased customers age out within 12 months. No Google refresh token is stored on the server; the consent screen must be "In production" (refresh tokens expire after 7 days in Testing **[verified]**). Spikes first: publish the consent screen on `workers.dev`; confirm the Credential Manager plugin returns a `drive.file` access token on the Redmi phones (its README says it may be null **[verified]**).

**Firestore for live data: not now**: a 4–6 week rewrite, transactions fail offline **[verified]**; its one advantage is India regions, which matter only if residency becomes a requirement (DPDP has no localisation mandate **[likely]**).

**Cost table ($1 ≈ ₹88)**

| Item | Built configuration | Optional |
|---|---|---|
| Speech-to-text, parser, password login (client PBKDF2 + HMAC), Google Sign-In, Drive backup, R2 export | ₹0 | — |
| Workers + D1 + web hosting | **₹0** (Free: 10 ms CPU, 100k req/day, 100k D1 writes/day) | Workers Paid $5 ≈ ₹440/month: no daily caps, 30-day Time Travel |
| Custom domain | not needed (`workers.dev`) | ≈ $10/year ≈ ₹70/month for a branded consent screen (unverified) |
| Sarvam STT (phase D, only if the gate fails) | — | ₹30/hour billed per second ≈ ₹50–300/month **[verified rate]** |
| LLM (phase D, only if needed) | Workers AI 10k neurons/day ≈ 450–670 calls at 15–22 neurons each (cap 300) **[likely]** | `gemini-3.5-flash-lite` ≈ ₹145–195/month |
| **Total** | **₹0 / month** | ≈ ₹440 with Paid; + ₹0–300 only if Sarvam is needed; + ≈ ₹70 only if a domain is wanted (Supabase Pro, rejected: ₹2,200) |

---

## 6. Changes to the codebase (from the real tree; ✔ = done, ○ = open)

**`khata/app`** (all ✔ unless marked)
- `src/core/voice.ts`: the parser (2.5).
- `src/platform/`: `types.ts` (`Speech`), `speech-common.ts` (`SPEECH_PRIVACY_NOTE`), `speech-native.ts`, `speech-web.ts`, `fake-speech.ts`; `native.ts` / `web.ts` stop a session on background / hidden tab.
- `src/ui/voice/`: `listen.ts`, `plan.ts`, `prefill.ts`, `prefs.ts`, `banner.ts`, `mic-button.ts`, `settings-section.ts`, `icons.ts`, `voice.css`; screens `home.ts`, `customer.ts`, `quick.ts`, `entry.ts` (voice mode), `customer-edit.ts` (prefill pass-through); `data/types.ts` (`voice_prefs`, `voice_stats` meta keys).
- `src/sync/`: `password.ts`, `api.ts` (cookie mode, v2 routes, `StepUpProof`), `engine.ts` (`login`, `googleLogin`, `resumeWebSession`, `logout`, `requestCodes`, `stepped`, users, events), `types.ts`; `ui/screens/login.ts` (password widgets, `stepUpDialog`, `signOutFlow`), `settings.ts` (user-id connect mode, Account, Create a login for me with PIN first, Users, Activity).
- `src/ui/web/`: `boot.ts`, `login-gate.ts`, `google.ts`, `session.ts`, `storage.ts`, `styles.ts`, `flag.ts`; `main.ts` calls `webPrelude()`; `data/index.ts` `openRepo({memory})`; `vite.config.ts` (`--mode web` → `dist-web`).
- `i18n/en.ts`, `ta.ts`: marked `voice.*`, `auth.*`, `web.*`, `serr.*` blocks. `package.json`: pinned Capgo plugin. `AndroidManifest.xml`: `RECORD_AUDIO` + queries. `.gitignore`: `dist-web/`.
- Tests: `voice`, `review-voice`, `platform.speech`, `ui.voice`, `sync.password`, `sync.accounts`, `review-auth-web`, `helpers/fake-server.ts`; e2e `voice.mjs`, `web-login.mjs`; `README.md`.
- ○ `src/backup/drive.ts`, PWA, LLM client, Android Google sign-in (phases C/D, 3.9).

**`khata/api`** (all ✔ unless marked)
- `migrations/0002_accounts.sql`, `0003_accounts_hardening.sql` (3.7).
- `src/lib/`: `password.ts`, `google.ts`, `nonce.ts`, `stepup.ts` (`requireStepUp`, `noWeb`), `lockout.ts` (`login_locks`, known device), `audit.ts`, `session.ts` (`newDeviceTail`, cookies), `throttle.ts`, `auth.ts` (transport binding, CSRF).
- `src/routes/`: `auth.ts`, `users.ts`, `devices.ts`, `shop.ts`, `public.ts` (`/config`); `src/env.ts`, `wrangler.jsonc` (`AUTH_LIMITER` 20/60 s, `AUTH_THROTTLE_AFTER`, `GOOGLE_*`, assets); `web/_headers`, `scripts/prepare-assets.mjs`.
- Tests: `accounts`, `hardening`, `google`, `cpu`, `config`, `assets`, `review-auth-v2` (191 in 13 files); `README.md`; no new dependencies.
- ○ `src/routes/voice.ts`, R2 export cron, `/privacy` and `/terms` pages (phases C/D).

`shared/protocol.ts`: ✔ v2 blocks. `tools/deploy-server.sh`: ✔ web build step.

---

## 7. Milestones

**Done (phases A and B):** parser + fixtures; speech adapters and the Android build; mics with the prefilled entry screen; server accounts; login client; web app with shared mode; e2e harnesses. Two review rounds (plan findings 5–9, 12–17, 21 and the auth review's 10 findings) were applied in code; the former `it.fails` proof tests now pass as regressions.

**Open, in order:**
1. **Field test on the shop's Redmi phones (section 8):** permission, pauses, the number of alternatives, whether "-க்கு" survives after vowel-final names, PBKDF2 timing. Voice can stay on because nothing saves without a tap, but the owner should be told it is beta.
2. **Deploy** (`tools/deploy-server.sh`, migrations 0002 + 0003, `PEPPER`), measure CPU on the real Free Worker, create the first owner login with PIN + recovery codes, then staff logins. Decide Free vs Paid.
3. Google sign-in on the web (client id), Android Google sign-in, and the 3.9 follow-ups as needed.
4. **Phase C:** Drive backup, monthly CSV, R2 cron, consent-screen spike on `workers.dev`.
5. **Phase D (conditional):** Sarvam `/v1/stt` if Google STT fails the gate; the LLM if `voice_stats` show > ~15% edits that lexicon changes cannot fix.

Keep the paper book until the field gate passes.

---

## 8. Testing & accuracy evaluation

**Automated (passing):**
- `test/voice.test.ts`: 385 fixture cases scored on customer, amount and direction, plus invariants on every case (`high` only under the 2.2 rule; no amount that was not spoken; `paru` never a cue); unit tests for numbers, dative splitting, context mode, settings flips, namesakes. `platform.speech.test.ts` (26) and `ui.voice.test.ts` (12) cover the adapters and the flow decisions.
- `sync.password.test.ts` (9, bit-exact against Node `pbkdf2Sync`) and `sync.accounts.test.ts` (22): logins, takeover, known device, lockout, cookie mode, `code_block` null → `requestCodes`, `web_owner_only`, csrf, 401 → unsynced count, step-up, users; `review-auth-web.test.ts`: a shared-mode resume stays in memory.
- API (191): identical answers for unknown user and wrong password; 600k only; (username, /24) lockout with the known-device exemption; staff web → 403; cookie flags, transport binding, CSRF; takeover only by same user or token proof; step-up and the bootstrap exemption; web refused on owner-power routes; UPI id and erase need step-up; demotion ends web sessions; shared login leaves no persistent cookie; Google claims, nonce replay, audiences, Gmail-only, 48 h expiry; CPU bounds; CSP; v1 routes unchanged.
- e2e: `flows.mjs` (v1), `voice.mjs` (85 checks across the outcomes in 1.1), `web-login.mjs` (login, staff refused, sync, cookies, entry and customer from the web, revoke from the phone, sign-out wipe, shared mode incl. reload).

**Field gate (to run in the shop):** 60 prompts generated from the real customer list, shown in Tamil script, read by the owner and each staff member at a quiet and a busy hour; record the alternatives (how many), the parse and the latency. Then 200–300 real counter sentences over the following weeks, stratified: ~50/50 Debit/Credit; ≥ 30 dative pairs; ≥ 20 person pairs; ≥ 40 Tamil number words; ≥ 30 Tanglish; ≥ 15 multi-entry; ≥ 10 each of corrections, same-name, unknown names, balance questions, items.

| Metric | Target to keep voice on by default |
|---|---|
| **Wrong direction preselected and saved** · wrong customer saved | **≤ 0.5%** · 0 |
| End-to-end correct with no edit | ≥ 85% |
| **`amount_edited` after a voice prefill**, single- vs multi-alternative | ≤ 3% |
| Customer top-1 / in picker | ≥ 90% / ≥ 98% |
| Latency, stop → entry screen · no-result rate | median ≤ 1.5 s, p90 ≤ 3 s · ≤ 5% |

The developer reviews the five counters weekly for the first month. Fail → voice "beta, customer page only" and phase D starts.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Google's Tamil recognition on Redmi phones is weaker than hoped (unverified) | field gate; customer-page mode; Sarvam in phase D |
| A dropped "-க்கு" or a misheard verb ending (kuduthen/kuduthaan) flips the direction | dative → Debit; disputed dative or opposite directions across alternatives → ask; bare kuduthaachu never `high` + check line; due before → after; Undo. The cross-alternative net counts only once field logs show several alternatives |
| **A misheard amount with one alternative** ("aayirathu ainooru" heard as "ainooru") fills ₹500 silently, below `confirm_above_paise` | amount source in large type beside the heard words; amount in words; due before → after; `amount_edited` gate metric; chips whenever alternatives disagree |
| Folded keys collide with fillers (பற்று and "paaru" → `paru`) | labels matched raw; `FORBIDDEN_FOLD_KEYS`; "Ramu 100 paaru" fixtures |
| The recogniser cuts the sentence at a pause, keeps dictation open, is missing, or is offline | 2.5 s partial settle + 12 s cap; Try again; clear messages; keypad always there |
| `client_key` is password-equivalent on the wire; XSS on the login page | TLS only; strict CSP; bodies never logged; audit of android logins from unknown sources; approval for new owner android logins is open (3.9) |
| 600k PBKDF2 slow on a low-end WebView (unverified) | "securing…" state; measure in the field; never lower the count |
| A stolen unlocked phone or open web session mints lasting credentials | step-up on every owner-power route whatever the client kind; credential routes refused for web; PIN before Create login; `auth_events`; disable + revoke |
| Staff downloads the ledger at home; browser data left on a shared PC | server refuses staff web logins; memory-only mode, no persistent cookies, 12 h, reload stays in memory, remote revoke + wipe |
| Consent screen cannot be published on `workers.dev` (unverified); a Capgo release regresses a money app | phase-C spike, optional domain, share-sheet backup meanwhile; exact pin ≥ 2 weeks old, diffs reviewed |
| DPDP (most duties from ~May 2027 **[verified]**); D1 has no India region | Google named as processor; no audio stored; residency to confirm |

---

## 10. Open questions for the client

1. In your shop, does "Ramu 100 kuduthaachu" always mean **Ramu paid you**? (It is the default; Settings → Voice flips it.) Please record 20 real counter sentences.
2. Which phones? Who speaks to the app: owner only, or staff too?
3. Passwords and Google login both work at **₹0**. Do you want **Workers Paid (₹440/month)** anyway, for no daily caps and 30-day restore?
4. Do staff have **Gmail** addresses (only Gmail can be pre-registered)? Or will the owner create user-id logins (a mobile number works)? Can every staff member type a password?
5. Who needs the web app, on whose computer (own laptop or a shared counter PC)? Owner-only web: enough for now?
6. Is a daily encrypted backup plus a monthly CSV in the owner's Drive what "data in our Google account" means?
7. Do you accept that voice audio goes to Google? Will you turn off Voice & Audio Activity on the shop phones?
8. If Google's recogniser misses the gate, is ₹50–300/month for Sarvam acceptable? Must the data stay in India (D1 offers only `apac`)?
9. Should a new owner login on a new phone need approval from an existing owner phone or a recovery code (safer, slower when every phone is lost)?
10. Would you like an optional custom domain (≈ $10/year) so the consent screen shows the app's name?

---

## Sources

- Capgo plugin: https://github.com/Cap-go/capacitor-speech-recognition · Web Speech API: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition · browser-compat data: https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json · New in Chrome 139: https://developer.chrome.com/blog/new-in-chrome-139
- Voice of India benchmark: https://voiceofindiablogs.ai.joshtalks.com/ · Sarvam pricing: https://docs.sarvam.ai/api/pricing.md · Workers AI pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/ · Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing
- Workers limits/pricing: https://developers.cloudflare.com/workers/platform/limits/ · D1: https://developers.cloudflare.com/d1/platform/pricing/ · workerd PBKDF2 cap: https://github.com/cloudflare/workerd/blob/main/src/workerd/io/limit-enforcer.h · OWASP: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- Google ID tokens: https://developers.google.com/identity/gsi/web/guides/verify-google-id-token · brand verification: https://support.google.com/cloud/answer/15549049 · OAuth: https://developers.google.com/identity/protocols/oauth2
- Public Suffix List: https://publicsuffix.org/list/public_suffix_list.dat · Supabase: https://supabase.com/docs/guides/platform/free-project-pausing
