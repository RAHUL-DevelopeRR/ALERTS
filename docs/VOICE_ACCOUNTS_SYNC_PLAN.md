# Kadan Kanakku — Tamil Voice Entry, Accounts & Cross-Platform Sync Plan

**Date:** 2026-10-18 · **Status:** Plan v2 — not yet implemented

This builds on the v1 plan in [`docs/GROCERY_DEBT_APP_PLAN.md`](GROCERY_DEBT_APP_PLAN.md) and on what already exists in [`khata/`](../khata/): the app (Capacitor 8 + TypeScript, with the ledger in SQLite on the phone), the API (Cloudflare Worker + Hono + D1, sign-in by device pairing) and `shared/protocol.ts`.

Each fact carries a tag. **[verified]** means checked on an official page or in the code. **[likely]** means a strong secondary source or a local measurement. **(unverified)** means not confirmed; anything this plan relies on that is unverified also appears as a risk in section 9. Prices are converted at about ₹88 to $1.

---

## Answers to your questions

**1. Can we add voice mode, and which free speech and AI backend handles Tamil?**

Yes. The free primary engine is Google's own speech recogniser set to Tamil (`ta-IN`).
- **Android:** it is built into the phone, and the app reaches it through the plugin `@capgo/capacitor-speech-recognition` 8.x, which is the only maintained speech plugin for Capacitor 8 **[verified]**.
- **Web app:** Chrome's Web Speech API, which works in Chrome and Edge only **[verified]**.
- Both cost ₹0 and need no API key. Both need internet and send the audio to Google.

Speech-to-text alone is not enough. A transcript like "ராமு 100 குடுத்தாச்சு" still has to become *customer + amount + Gave/Got*. That part is done by a Tamil/Tanglish parser that we write ourselves. It runs on the phone, costs nothing, and checks every guess against the shop's real customer list. A prototype got 25 of 26 test sentences right **[verified, prototype]**.

**Fallbacks**, added only if measurements show they are needed:
- **Sarvam `saaras:v4`** called through our Worker. It costs about ₹0.49 per minute, roughly ₹50–300 a month at this shop's volume **[likely]**, and it topped the only independent Tamil benchmark we found **[likely]**.
- **A free AI model on Cloudflare** (Workers AI, Gemma 4) for sentences the parser cannot decide.

**Honest accuracy statement:** nobody publishes Tamil accuracy for Google's phone recogniser. My estimate is that 75–90% of short commands will come out fully right (customer, amount and direction) in a quiet shop (unverified). Voice therefore **never saves money on its own**. Every entry stops on a confirmation screen with a Save button, and voice is switched on by default only after it passes a test with the shopkeeper's own voice (section 8).

**2. What happens when the shopkeeper says "Ramu 100 kuduthaachu"?**

1. She holds the mic button and speaks, and the words appear live on screen.
2. The recogniser returns up to 5 guesses, and the parser reads them:
   - "100" is the amount: ₹100.
   - "குடுத்தாச்சு" is a "give" verb. Ramu is the subject and there is no "-க்கு" ("to") on his name, so it means *Ramu has paid the shop*. That is **Got / பெற்றது (RECEIVE)**, which lowers his due.
   - "ராமு" matches the customer Ramu in her list.
3. The app opens Ramu's Gave/Got screen already filled in: green **Got ₹100**, the amount in Tamil words, what it heard, and "பாக்கி ₹450 → ₹350".
4. She taps **Save**. The app lands on **Ramu's account page** with the new balance and an Undo button.

Because Tamil phrasing can point either way, the app asks whenever it cannot be sure:
- "Ramu**க்கு** 100 குடுத்தாச்சு" means *gave to* Ramu: credit, GIVE.
- "vaanginaan" means *Ramu took goods*: GIVE.
- "kanakkula ezhuthu" means *write it in his account*: GIVE.
- If there are two Ramus, it shows a picker.
- If the direction is unclear, Gave and Got are both left unselected and Save stays disabled.

The app also asks once, at setup, what "Ramu 100 kuduthaachu" means in *this* shop, so the meaning is not a guess hard-coded by the developer.

**3. Login with user id/password and/or Google, on the server?**

Both, built **inside the Cloudflare Worker we already have**. Each login creates a "device" session, just as pairing does today, so sync does not change.
- **Google sign-in** is free.
- **User id + password** needs Cloudflare **Workers Paid ($5 ≈ ₹440 a month)**. A safe password hash takes about 200 ms of server CPU, and the free plan allows 10 ms per request **[likely, measured locally]**. The v1 plan already recommended Paid at go-live.
- **If the client wants ₹0**, either use Google sign-in plus today's pairing codes, or let Firebase Authentication (Google's free login service) handle passwords (section 3.8).

**4. Cross-device and web app?**

- **Phones:** any phone signs in and syncs through the existing sync protocol.
- **Web app:** the same app screens are served from the same Worker at no cost. It can be installed as a PWA and has a "shared computer" mode that leaves nothing behind on logout.
- **Voice on the web:** works in Chrome and Edge.
- **Ledger of record:** the phone stays the master copy, because browsers can delete stored data.

**5. Where does the data live, and what about "their Google cloud account / own credits"?**

- **Live data:** stays where it is today, in the phone's SQLite plus Cloudflare D1 as the sync hub.
- **Google login does not move any data into Google.** The honest way to put the client's data in their Google account is a **daily encrypted backup into a visible folder in the owner's own Google Drive**, plus an optional monthly CSV statement. It uses the `drive.file` permission, which Google classes as non-sensitive **[verified]**.
- **Ownership:** the shop's own Gmail owns the Google project, the Drive folder and the Cloudflare account.
- **"Credits":** there are no ongoing Google Cloud credits. The $300 trial lasts 90 days **[verified]**, and the always-free VM and storage tiers are US-only **[verified]**.
- **Moving live data into Google Firestore** would mean a 4–6 week rewrite of working money code. That is not recommended for now.

**6. Supabase pausing: use it or not?**

**Do not use it.**
- Free projects pause after one week of low activity **[verified]**, and a pause stops login *and* sync on every device until someone restores the project by hand. A 10-day festival closure would be enough to trigger it.
- The free plan has no backups **[verified]**.
- Pro costs $25 a month, five times Workers Paid.
- Supabase's Google login would put the data in Supabase's Postgres, not in Google.
- Cloudflare and Firebase document no idle pause **[likely]**.

---

## Recommendation in one page

**Chosen architecture**

| Layer | Choice |
|---|---|
| Speech-to-text (Android) | Google `SpeechRecognizer`, `ta-IN`, 5 alternatives, via `@capgo/capacitor-speech-recognition` 8.4.4 |
| Speech-to-text (web) | Chrome/Edge Web Speech API, `lang='ta-IN'` |
| Understanding | Deterministic parser on the phone, `app/src/core/voice.ts`, reusing `transliterateTamil` / `phoneticFold` / `matchesQuery` / `toPaise` / `asciiDigits` |
| Confirmation | Existing entry screen (`ui/screens/entry.ts`) pre-filled, with a voice banner. **Never auto-save.** |
| Conditional boosters (phase D) | Sarvam `saaras:v4` STT proxy; Workers AI LLM `/v1/voice/interpret`. Both off by default, built only if measured data calls for them |
| Accounts | Inside the existing Worker: argon2id passwords (Workers Paid) + Google ID-token check with `jose`; every login = a `devices` row returning `PairResponse` |
| Web app | Same Vite UI as Workers static assets, PWA, HttpOnly cookie session, shared-computer mode; owner-only at first |
| Data | Phone SQLite (record) → D1 (sync hub) → daily encrypted Drive backup (owner) + nightly R2 export |
| ₹0 fallback | Google sign-in + pairing on Workers Free, or Firebase Auth as identity provider (hardened, no admin key) |

**Order of work:**
- **A.** Android voice with no new server code, ending in a measured gate (weeks 1–4).
- **B.** Accounts and the web app (weeks 5–7). This starts only after the client confirms they will actually use a browser or recover by login.
- **C.** Automated Drive backup (week 8).
- **D.** The LLM and Sarvam, only if the data justifies them.

**Rejected (one line each)**
- **Supabase free:** pauses after 7 idle days, which stops auth on every device; no backups; Pro costs $25.
- **Firestore as the live store:** a 4–6 week rewrite; transactions fail offline; one full-history login can use up the 50k reads/day free quota.
- **Google Drive as the sync engine:** no transactions, no ordering, every device would need the owner's Google login.
- **Whisper (Workers AI):** free, but about 48% word error on Tamil.
- **Deepgram Nova-3, OpenAI, AssemblyAI:** 57–68% error on real Indian Tamil.
- **Gemini free tier:** its terms forbid personal information, and customer names are personal information.
- **Bhashini:** licensed for proof of concept only.
- **Gemini Nano / Chrome Prompt API:** no Redmi support, and no Tamil.
- **Vosk / on-device Whisper:** no Tamil model, or 250–470 MB per model.
- **Better Auth / Lucia:** do not fit the device/sync model (Lucia is deprecated).
- **Cloudflare Access:** browser-redirect login, unsuitable for app users.
- **Appwrite free:** pauses, and deletes projects after 90 days paused.
- **Neon:** cold starts after 5 idle minutes.

---

## 1. Voice mode

### 1.1 What the shopkeeper sees

| Screen | Mic | What she says |
|---|---|---|
| **Customer page** (`customer.ts`) | header, large | "100 kuduthaan", "ஐநூறு வாங்கினான்". The customer is fixed, so only amount and direction are parsed. **This is the most accurate mode and the one to teach first.** |
| **Home** (`home.ts`) | round 64 dp button, bottom right | full sentence, "Ramu 100 kuduthaachu" |
| **Quick entry** (`quick.ts`) | header | full sentence; sticky date and running totals are kept |
| **Entry screen** (open) | small | corrections: "illa 150", "Sita illa, Seetha" change only that field |

**How listening works:**
- **Hold to talk** is the default. A counter is noisy, and a clear start and stop beats silence detection.
- A setting switches to tap-to-start with auto-stop after about 1.5 s of silence (`allowForSilence`).
- Hard limit: 10 s.
- While listening, the app shows a pulsing ring, "கேட்கிறேன்… / Listening…", the **live partial text** (`partialResults:true`) and Cancel.
- The mic appears only after the microphone permission is granted. The first tap explains why in Tamil first ("பேசி கணக்கு போட மைக் அனுமதி தேவை").

**The confirmation is the existing entry screen** with new route params `amount` (paise), `note`, `date`, `voice='1'` and `from`. A voice banner sits above the keypad:
1. **Heard:** the transcript in grey. Tap it to see the other alternatives.
2. **Plain sentence in the direction colour:** "ராமு உங்களுக்கு ₹100 கொடுத்தார் → **பெற்றது**" / "Ramu paid you ₹100 → **Got**".
3. **Due before → after:** "பாக்கி ₹450 → ₹350". If the due goes *up* when she expected it to go down, the direction is wrong, and she can see that at a glance.
4. A **Change customer** chip; a large **Gave | Got** toggle; a date chip, highlighted when the date is not today; a note chip such as "அரிசி".
5. **When `kind` is absent** (direction confidence below 0.6, or a conflict), neither side is selected, **Save stays disabled** and the toggle pulses. Today `entry.ts` defaults to GIVE (`route.params.kind === 'RECEIVE' ? … : 'GIVE'`). Under `voice='1'` that default must become "none".

**After Save:**
- `entry.ts` calls `router.back({force:true})` today (line 224) **[verified]**.
- If voice was started on **Home**, it calls `router.replace('customer', {id})` instead (`replace` exists in `ui/router.ts` **[verified]**). She lands on **Ramu's page**, and Back then goes to Home. This is the "navigate to Ramu's account" behaviour the client asked for.
- From the customer page, the normal `back` is used. From quick entry, today's behaviour is kept.

**Safety nets that already exist and apply unchanged:**
- the big-amount dialog (`confirm_above_paise`, line 167);
- the "got more than due → advance" dialog;
- `recentDuplicate` within 2 minutes (line 192);
- the **Undo** toast (`reverseEntry`, line 238).

**Other outcomes**

| Parser outcome | Screen |
|---|---|
| Two or more customers within 0.10 ("Ramu" and "ராமு tea kadai") | Picker: name, C-code, phone last 4, note, balance. It never picks silently. |
| Best match between 0.6 and 0.85 | Picker with the top 3, plus "Add 'Ramu' as new" |
| No match | `customer-edit` with `{name}` pre-filled (the route already accepts `name`), then back to the entry screen with kind and amount kept |
| Balance question ("Ramu baaki evvalavu?") | Opens Ramu's page. No entry is created. |
| Several entries ("Ramu 100, Sita 50 vaanginaanga") | List card (`voice-pick.ts`): one row per entry with its own Gave/Got toggle **and its own due before → after**, then "Save all (2)". Each row goes through `repo.addEntry`; Undo reverses all of them. At most 5 per sentence. |
| No amount heard, or two candidate amounts | Entry screen with the customer and kind filled in, the keypad focused, and the candidate amounts as chips |

### 1.2 Pipeline

```
mic (hold) → SttEngine.recognize('ta-IN', hints) → { alts[≤5], engine, ms }
  → parseVoice(alts, customerIndex, overrides)        // on the phone, < 50 ms, no network
  → [phase D only] unsure + "AI help" on + online → POST /v1/voice/interpret → validate → merge
  → resolve customer: prefill | picker | add new
  → router.go('entry', { id, kind?, amount, note?, date?, voice:'1', from })
  → shopkeeper taps Save → repo.addEntry (unchanged, append-only) → outbox → existing sync
  → voice_log row (local only)
```

```ts
// app/src/platform/stt.ts
export interface SttResult { alts: string[]; engine: 'android' | 'web' | 'sarvam'; ms: number }
export interface SttEngine {
  available(): Promise<{ ok: boolean; onDevice: boolean;
    reason?: 'no_permission' | 'no_service' | 'offline' | 'unsupported_browser' }>;
  recognize(lang: 'ta-IN' | 'en-IN', opts: { hints: string[]; maxMs: number;
    onPartial?: (t: string) => void; signal?: AbortSignal }): Promise<SttResult>;
  stop(): Promise<void>;
}
```

| Engine | Implementation |
|---|---|
| `stt-native.ts` | Capgo `{language:'ta-IN', maxResults:5, partialResults:true, popup:false}`; `isRecognitionAvailable()` first |
| `stt-web.ts` | `SpeechRecognition ?? webkitSpeechRecognition`, `lang='ta-IN'`, `maxAlternatives=5`, `interimResults=true`; `phrases` (customer names) only where present (Chrome desktop 142+, experimental **[verified]**) |
| `stt-server.ts` (phase D) | MediaRecorder webm/opus ≤ 8 s → `POST /v1/stt` → Worker calls `saaras:v4` with `language_code:'ta-IN'` and up to 50 keyterms (top customer names) **[verified feature]**; audio never stored |

Settings → Voice → Engine: **Auto** (Google; Sarvam on failure, if enabled), Google only, or Sarvam only.

### 1.3 Android specifics

- **Manifest** (`app/android/app/src/main/AndroidManifest.xml`) **[verified]**:
  - Line 69 removes `RECORD_AUDIO` with `tools:node="remove"`. Replace it with `<uses-permission android:name="android.permission.RECORD_AUDIO"/>`.
  - Line 70 removes `MODIFY_AUDIO_SETTINGS`. **Leave it removed** unless the merged manifest shows the plugin needs it; the Capgo manifest adds only `RECORD_AUDIO` **[verified]**.
  - Add `<queries><intent><action android:name="android.speech.RecognitionService"/></intent></queries>`, which Android requires for apps targeting API 30+ **[verified]**.
  - Update the permission table in `app/README.md` and the privacy text **in the same change**.
- **Runtime permission:** ask on the first mic tap. If she refuses, hide the mic and offer "ask again" in Settings.
- **Plugin:** `@capgo/capacitor-speech-recognition@8.4.4` (peer `@capacitor/core >=8`) **[verified]**. Not `@capacitor-community/speech-recognition`, which is stuck at 7.0.1 **[verified]**.
- **Biasing toward customer names (optional):** Android 13+ has `EXTRA_BIASING_STRINGS` **[verified]**, but Capgo ignores `contextualStrings` on Android **[verified]**. A roughly 10-line `patch-package` change to `buildRecognizerIntent` passes the 50–100 most active names. Whether Google honours it for Tamil is unverified, so keep it only if the A/B in section 8 shows a gain.
- **Offline:** on API 33+, call `checkRecognitionSupport('ta-IN')`. Use `useOnDeviceRecognition` only if an offline Tamil pack is reported; whether one exists is unverified.
- **No Google speech service** (`isRecognitionAvailable()` false, for example a non-GMS ROM): hide the mic, or use Sarvam if phase D enabled it. The keypad is always one tap away.
- **Redmi/HyperOS:** Indian ROMs normally ship Google speech services **[likely]**. Test on the client's actual phones in week 2.

### 1.4 Web specifics

- Chrome and Edge work. Firefox does not. Safari's Tamil support is unverified. Where speech is missing, hide the mic and show "Voice works in Chrome".
- Chrome sends audio to a Google server, and there is no offline recognition **[verified]**.
- Inside the Capacitor Android WebView, always use the native plugin, never Web Speech **[likely]**.

### 1.5 Offline behaviour

- The parser, the confirmation and saving all work offline. Entries go to SQLite and the outbox as today.
- Speech recognition needs internet unless an offline Tamil pack is installed (unverified). With no network, the mic sheet says "குரல் பதிவுக்கு இணையம் தேவை — தட்டச்சு செய்யவும் / Voice needs internet; type instead" and opens the keypad.

### 1.6 Privacy (DPDP Act)

**What leaves the phone:**
- Audio goes to Google, or to Sarvam only if that engine is enabled. If Sarvam is enabled, **up to 50 customer names go to it as keyterms**.
- If "AI help" is on (phase D), **the transcript plus up to 8 candidate customer names** go to Cloudflare Workers AI.
- Balances, phone numbers and the ledger are never sent.
- **No audio is stored anywhere**, except in the opt-in Voice test, and then only on the phone.

**Defaults and consent:**
- Voice, Sarvam and AI help are each **off by default**.
- The owner turns them on in Settings, on a screen that names these processors (Google, Cloudflare, Sarvam). The same text goes in the README privacy section.
- `voice_log`, `voice_alias` and `voice_cue_override` stay on the phone and are never synced. The evaluation export replaces names with C1, C2….
- **Never** use the Gemini free tier with real names. Its terms say "Do not submit sensitive, confidential, or personal information to the Unpaid Services" **[verified]**.

---

## 2. Understanding Tamil

### 2.1 Normalising and tokenising

1. Apply NFC, then `asciiDigits` (Tamil ௦–௯ → 0–9, already in `ledger.ts`). Strip ₹, turn "1,250" into "1250", and split digit|letter boundaries ("100ரூபாய்" → "100 ரூபாய்").
2. Fold each token:
   - **Digit tokens are never folded.** `phoneticFold` collapses repeated characters, so "100" would become "10" and "500" would become "50" **[verified]**.
   - **English lexicon words are looked up raw, before folding.** "fifty" would fold to "pipty".
   - Everything else becomes `phoneticFold(transliterateTamil(tok))`.
3. The existing transliteration already unifies the two scripts **[verified]**: குடுத்தாச்சு and kuduthaachu both become `kututasu`; ராமு and Ramu both become `ramu`; ஐநூறு and ainooru both become `ainuru`. **One folded lexicon therefore covers Tamil script and Tanglish spellings.**
4. Tag each token as NUMBER, CUE, DATIVE-NAME, ITEM, DATE, NEG, STOP or NAME. A NAME after an entry that already has a name and an amount starts a new entry.

### 2.2 Direction lexicon

Keys are folded. Match `^stem(suffix)?$`. **w** is the weight of evidence.

Tamil marks the person on the verb, and that decides the direction:
- **kudu** (give) *about the customer* means he paid: RECEIVE. *Said by the shop* ("I/we gave") it means GIVE.
- **vaangu/edu** (take/buy) works the other way round.
- **kattu** (pay) is RECEIVE.

| # | Tamil | Latin forms | Folded | Dir | w |
|---|---|---|---|---|---|
| 1 | குடுத்தான் / கொடுத்தான் | kuduthaan, koduthaan | kututan, kotutan | R | 3 |
| 2 | கொடுத்தாரு / கொடுத்தார் | koduthaaru, kuduthaar | kotutaru, kututar | R | 3 |
| 3 | குடுத்தாங்க | kuduthaanga | kututanka | R | 3 |
| 4 | குடுத்தா / குடுத்தாள் | kuduthaa, kuduthaal | kututa, kututal | R | 2 |
| 5 | **குடுத்தாச்சு** | **kuduthaachu**, koduthaachu | kututasu | **shop setting** (see rule 8) | 1 → 3 |
| 6 | குடுத்துட்டான் | kuduthuttaan | kutututan | R | 3 |
| 7 | கொடுத்துட்டாங்க | koduthuttaanga | kotututanka | R | 3 |
| 8 | கட்டினான் | kattinaan | katinan | R | 4 |
| 9 | கட்டுனான் | kattunaan | katunan | R | 4 |
| 10 | கட்டிட்டாரு / கட்டிட்டாங்க | kattittaaru, kattittaanga | katitaru, katitanka | R | 4 |
| 11 | கட்டியாச்சு | kattiyaachu | katiyasu | R | 4 |
| 12 | செட்டில் பண்ணிட்டான் | settle pannitaan | setil / setle | R | 4 |
| 13 | வரவு (வை / போடு) | varavu (vai/podu) | varavu | R | 3 |
| 14 | ஜமா | jama | sama | R | 3 |
| 15 | வந்துச்சு / வந்தாச்சு | vandhuchu, vandhaachu | vantusu, vantasu | R | 3 |
| 16 | திருப்பி (குடுத்தான்) | thiruppi | tirupi | R | +2 |
| 17 | வாங்கினேன் ("I received") | vaanginen | vankinen | R | 3 |
| 18 | வாங்கிட்டோம் | vaangittom | vankitom | R | 3 |
| 19 | கிட்டருந்து ("from") | kitta irundhu, kittarundhu | kitaruntu | R | 2 |
| 20 | — | paid, payment, received, got | raw | R | 3 |
| 21 | ஜிபே / போன்பே | gpay, phonepe, paytm, UPI (also sets mode UPI) | raw | R | 3 |
| 22 | பணம் கட்டினான் | panam kattinaan | panam = STOP + #8 | R | 4 |
| 23 | வாங்கினான் | vaanginaan | vankinan | G | 4 |
| 24 | வாங்குனான் | vaangunaan | vankunan | G | 4 |
| 25 | வாங்கினா / வாங்கினாள் | vaanginaa, vaanginaal | vankina, vankinal | G | 4 |
| 26 | வாங்கிட்டான் | vaangittaan | vankitan | G | 4 |
| 27 | வாங்கிட்டு போனான் | vaangittu ponaan | vankitu | G | 4 |
| 28 | வாங்கிக்கிட்டாங்க | vaangikittaanga | vankikitanka | G | 4 |
| 29 | வாங்கினாரு / வாங்கினாங்க | vaanginaaru, vaanginaanga | vankinaru, vankinanka | G | 4 |
| 30 | எடுத்தான் / எடுத்தாங்க | eduthaan, eduthaanga | etutan, etutanka | G | 3 |
| 31 | எடுத்துட்டு போனான் | eduthuttu ponaan | etututu | G | 3 |
| 32 | குடுத்தேன் ("I gave") | kuduthen | kututen | G | 4 |
| 33 | கொடுத்தோம் | koduthom | kotutom | G | 4 |
| 34 | குடுத்திருக்கேன் | kuduthirukken | kututiruken | G | 4 |
| 35 | கடன் | kadan | katan | G (noun) | 2 |
| 36 | பாக்கி | baaki, paakki | paki | G (noun) | 2 |
| 37 | உதாரி / உதார் | udhaari, udhaar | utari, utar | G (noun) | 2 |
| 38 | கணக்குல எழுது / எழுதுங்க | kanakkula ezhuthu, ezhuthunga | elutu, elutunka | light verb | 1 |
| 39 | போடு / போட்டுரு | podu, potturu | potu, poturu | light verb | 1 |
| 40 | — | credit, "credit-la podu" | raw | G | 2 |
| 41 | — | gave, given, took, bought | raw | G | 3 |
| 42 | அரிசி, பருப்பு, எண்ணெய், சக்கரை, பால், முட்டை, சோப்பு, சாமான் | arisi, paruppu, ennai, sakkarai, paal, muttai, soap, saamaan | arisi, parupu, enai, sakarai, pal… | G + note | 1 |
| 43 | எவ்வளவு / எத்தனை | evvalavu, ethana, how much | evalavu, etana | BALANCE_QUERY | — |
| 44 | இல்ல / இல்லை / தப்பு | illa, illai, no, sorry, thappu | ila, tapu | NEG (correction) | — |
| 45 | கிட்ட | kitta | kita | neutral | 0 |
| 46 | இன்னைக்கு / நேத்து / முந்தாநேத்து | inniku, nethu, munthaanethu, yesterday | iniku, netu, muntanetu | DATE 0 / −1 / −2 | — |

**Composition rules, applied in order**

1. **Light verbs** (ezhuthu, podu, add, note) take their direction from a nearby noun: "varavu podu" is R; "kadan/baaki podu" is G. With no such noun they mean G at w1.
2. **Dative on the name means the customer received.** The forms are `-vukku`, `-kku`, `-ukku`, `-ku`, `வுக்கு`, `க்கு`, or a separate "ku" token. **Strip the longest suffix first**; a leftmost regex alternation turned "Ramukku" into "Ram" in the prototype **[verified]**.
   - The dative alone counts as G w2.
   - With a third-person *kudu* verb, the verb is re-read as GIVE.
   - **Any direction that depends on a dative is capped at confidence 0.55**, below the 0.6 preselect threshold. "Ramu 100 kuduthaachu" and "Ramukku 100 kuduthaachu" differ by one syllable that the recogniser can drop, so this pair is never preselected.
3. **Dative disagreement across alternatives:** if one STT alternative has the dative and another does not, the entry is marked **conflict**, and nothing is preselected.
4. **kitta** is neutral; the person on the verb decides. "Ramu kitta 100 vaanginen" is R; "Ramu kitta 100 kuduthen" is G.
5. **Verbs outrank nouns.** When a verb cue of w ≥ 3 is present, noun cues (kadan, baaki, udhaar) count 0. So "kadan kattinaan" is R at 1.0, not an opposing mix. "baaki 100" with no verb may just be stating the balance, so baaki alone is capped at 0.55 (no preselect); "250 kadan" alone stays G at 0.67.
6. **Inheritance in multi-entry sentences:** an entry with no cue of its own takes the sentence's cue at confidence 0.5 (no preselect). An entry with a dative never inherits.
7. **Confidence** = `|G − R| / (G + R) × min(1, (G + R) / 3)`, then apply the caps in rules 2 and 3. A direction is **preselected only at ≥ 0.6 with no conflict.** For example, a single w3 cue gives 1.0, a single w1 cue gives 0.33, and w2 alone gives 0.67.
8. **"kuduthaachu" is a per-shop setting.**
   - Grammatically it is impersonal ("has been given").
   - Until the shop answers a one-time onboarding question ("நீங்கள் 'ராமு 100 குடுத்தாச்சு' என்றால், ராமு உங்களுக்குப் பணம் கொடுத்தாரா? / When you say 'Ramu 100 kuduthaachu', did Ramu pay you?"), the bare word is R at **w1**, which gives confidence 0.33, so nothing is preselected.
   - "Yes" stores a cue override of R w3; "No" stores G w3.
   - So a bare kuduthaachu never reaches 1.0 from a developer assumption.
9. **Shop learning:** each Gave/Got flip on the confirmation screen updates `voice_cue_override(cue → kind, flips)`. After 3 consistent flips, the shop's meaning wins.

### 2.3 Number grammar

Read left to right. `cur` holds the part below 1,000; `total` holds thousands and above.

- **Digits:** with `.dd`, Tamil digits and "1,250".
- **Units:** onnu/oru/ondru 1, rendu/irandu 2, moonu 3, naalu/naangu 4, anju/aindhu 5, aaru 6, ezhu 7, ettu 8, ombodhu/onbadhu 9, pathu 10.
- **Tens:** irubadhu 20, muppadhu 30, naarpadhu/naappadhu 40, aimbadhu/ambadhu 50, arubadhu 60, ezhubadhu 70, embadhu/enbadhu 80, thonnooru 90. Fused forms add up: irubathanju = 25, muppathanju = 35.
- **Hundreds:** nooru 100, irunooru 200, munnooru 300, naanooru 400, ainooru 500, arunooru 600, ezhunooru 700, ennooru 800, thollaayiram 900.
- **Combining forms** add and continue: nooththi/noothi, irunoothi, ainoothi. "irunoothi ambadhu" = 250; "nooththi irubadhu" = 120.
- **Thousands and up:** aayiram 1000. The combining forms aayirathu/aayirathi continue the number: "ஆயிரத்து ஐநூறு" = 1500. Also rendaayiram 2000, anjaayiram 5000, pathaayiram 10000, latcham/laksham/lakh 100000, and English hundred/thousand.
- **Halves:** "-arai" means +½ of the unit (onnarai 1.5; "rendarai aayiram" = 2500). "arai/half" on its own adds 0.5.
- **Indian English:** "one fifty" = 150, "two fifty" = 250. The rule: a unit word directly followed by a tens word, with no "hundred" between.
- **End of number:** ரூபாய் / rupees / rs / rubaa. "paisa" counts only after a rupee value.
- **Choosing among several numbers:**
  - drop a number followed by kilo/kg/litre/packet/dozen;
  - drop a 10-digit number (a phone number);
  - drop a number after "C"/"code" (a customer code);
  - prefer the number next to ₹ or rupay.
  - If more than one candidate is still left, the amount is **empty** and the candidates show as chips.
- **Corrections:** illa/no/sorry/thappu means the next value replaces the previous one. "Ramu 100 illa 150 kuduthaan" gives 150.
- **Output:** the existing integer-safe `toPaise(String(v))`, capped at `MAX_AMOUNT_PAISE`. **Never** `parseFloat × 100`.

### 2.4 Customer resolution

- **Name span:** the tokens left after numbers, cues, items, dates and stop words. Stop words: kitta, kanakkula, panam, kaasu, pannitaan, ponaan, trailing anna/akka/amma/ayya/sir, um/appuram.
- **Index:** built once per screen from `listHome()`. Each customer is indexed by `name` and `search_name` (already filled with the transliteration in `repo.createCustomer`), folded word by word, plus `searchKey()` for `matchesQuery`. A few hundred customers takes microseconds.
- **Score** = the maximum of:
  - `1 − lev(q, form) / maxLen` on the whole form;
  - 0.95 × the same on the first word only ("Ramu" matches "Ramu Tea Kadai");
  - 0.85 for a `matchesQuery` prefix hit;
  - 1.0 for an exact `voice_alias` hit.

  Bonuses: +0.05 if the customer had an entry in the last 7 days; +0.03 for an outstanding due when the direction is RECEIVE. She can also narrow the match by voice: periya/chinna, "tea kadai", "C 42", the last 4 phone digits.
- **Decision:**
  - prefill only if top1 ≥ 0.85 **and** top1 − top2 ≥ 0.10;
  - otherwise use the picker or "add new" (table in 1.1).
- **Alternatives:** parse all 5 STT alternatives and keep the best combined score.
- **Aliases:** when she picks a customer for a spoken form, store it in the **local** `voice_alias(folded, customer_id, hits)` table. Next time the match is exact. Aliases are **not** appended to `search_name`, so mishearings do not leak into synced customer records or other devices' search.
- **A name that collides with a lexicon word** (Kaasi vs kaasu, Selvi, Pandi): in the name position, before the amount, an exact customer match wins.

### 2.5 Parser interface and worked examples

```ts
// app/src/core/voice.ts — pure, no DOM, vitest-covered
export type Kind = 'GIVE' | 'RECEIVE';
export interface VoiceEntry {
  customer: { id: string; score: number } | null;
  candidates: { id: string; score: number }[];   // top 3 for the picker
  spokenName: string;
  amountPaise: number | null;
  amountCandidates: number[];                     // >1 means ambiguous
  kind: Kind | null;                              // null = ask; Save disabled
  kindConfidence: number; conflict: boolean;
  cues: string[]; note: string | null; bizDateOffset: 0 | -1 | -2; mode: 'UPI' | null;
}
export interface VoiceParse { intent: 'ENTRY' | 'BALANCE_QUERY' | 'UNKNOWN';
  entries: VoiceEntry[]; altIndex: number; transcript: string; needsHelp: boolean }
export function parseVoice(alts: string[], ctx: { customers: CustomerIndex;
  currentCustomerId?: string; overrides: CueOverrides }): VoiceParse;
```

The confidence values below are computed with the formula in rule 7 and the caps in rules 2, 3 and 8.

| Transcript | Customer | Amount | Kind (confidence) | UI |
|---|---|---|---|---|
| ராமு 100 குடுத்தாச்சு (shop answered "yes") | Ramu | ₹100 | RECEIVE (1.0) | Got preselected |
| ராமு 100 குடுத்தாச்சு (not yet answered) | Ramu | ₹100 | RECEIVE (0.33) | nothing preselected |
| Ramukku 100 kuduthaachu | Ramu | ₹100 | GIVE (capped 0.55) | **nothing preselected**; Save disabled until tapped |
| Ramu 100 kuduthaan | Ramu | ₹100 | RECEIVE (1.0) | Got |
| முருகன் ஆயிரத்து ஐநூறு கட்டினான் | Murugan | ₹1,500 | RECEIVE (1.0) | Got |
| Sita arisi rendarai aayiram vaanginaa | Sita | ₹2,500 | GIVE (1.0), note "arisi" | Gave |
| Ramu kanakkula 250 ezhuthu | Ramu | ₹250 | GIVE (0.33) | nothing preselected |
| Ramu arisi 250 | Ramu | ₹250 | GIVE (0.33) | nothing preselected |
| Kumar gpay one fifty | Kumar | ₹150 | RECEIVE (1.0), mode UPI | Got |
| Ramu 100, Sita 50 kuduthaanga | Ramu, Sita | 100, 50 | Ramu RECEIVE (0.5, inherited) · Sita RECEIVE (1.0) | list card; Ramu's row not preselected |
| Ramu 100 illa 150 kuduthaan | Ramu | ₹150 | RECEIVE (1.0) | Got |
| நேத்து செல்வி ரெண்டாயிரம் கட்டினாங்க | Selvi | ₹2,000 | RECEIVE (1.0), date −1 | Got, date chip highlighted |
| Ravi 2 kilo sakkarai 120 | Ravi | ₹120 | GIVE (0.33), note "sakkarai 2 kilo" | nothing preselected |
| Kumar 500 | Kumar | ₹500 | null | nothing preselected |
| Ramu baaki evvalavu | Ramu | — | BALANCE_QUERY | opens Ramu's page |
| (on Ramu's page) 250 kadan | Ramu (context) | ₹250 | GIVE (0.67) | Gave |

### 2.6 LLM fallback (phase D, conditional)

**When it gets built:** only if 2–4 weeks of `voice_log` show more than about 15% of voice entries needing a direction or amount edit that lexicon changes cannot fix.

**When it is called:**
- online, **and**
- the owner has turned on "AI help" (off by default), **and**
- the parse is unsure: direction confidence < 0.6, a missing or ambiguous amount, best name score < 0.75, more than 25% unknown tokens, or unclear intent.

Expect 10–25% of sentences.

**Endpoint** `POST /v1/voice/interpret` on the existing Worker:
- existing device/session auth;
- per-shop daily cap of 300 in the D1 table `voice_usage`;
- 4 s timeout, after which the parser's own answer stands;
- transcripts are not stored.

**Model:** `@cf/google/gemma-4-26b-a4b-it` on Workers AI.
- About 11 neurons per call, so about 900 free calls a day within the 10,000 free neurons **[likely: my calculation]**.
- Cloudflare does not train on customer content **[verified]**.
- **Its Tamil quality, and whether it supports `json_schema` on Workers AI, are unverified.**
- The model ID lives in a variable, `AI_MODEL`. If the model is renamed or fails, the app falls back to parser-only, which must be fully usable.
- Bake-off candidates: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (JSON mode officially listed **[verified]**, weaker Tamil), `gpt-oss-120b`, `qwen3-30b-a3b-fp8`, and paid Gemini 2.5 Flash-Lite ($0.10/$0.40 per M tokens, about ₹20–50/month; paid tier not used for training **[verified]**).

**Request** (never balances, the ledger or phone numbers):

```json
{"transcript":"ராமு நூறு குடுத்தாச்சு","alternatives":["ராமுக்கு நூறு குடுத்தாச்சு"],
 "candidates":[{"ref":"c1","name":"ராமு"},{"ref":"c2","name":"ராமு டீ கடை"}],
 "hints":{"numbers":[100],"cues":["kudu-3p"],"dative_in_alts":true}}
```

**System prompt:**

```
You convert a shopkeeper's spoken Tamil/Tanglish note into ledger entries for a credit (kadan) book.
GIVE = shop gave goods/money on credit to the customer (customer owes MORE). RECEIVE = customer paid the shop (owes LESS).
Customer as subject + kudu/kodu/kattu/settle/varavu/gpay (kuduthaan, kuduthaaru, kuduthaanga, kattinaan) = RECEIVE.
Customer as subject + vaangu/edu (vaanginaan, eduthaan, vaangittu ponaan) = GIVE. Speaker "I/we" + kudu (kuduthen, kuduthom) = GIVE;
speaker + vaangu (vaanginen) = RECEIVE. Name with -ku/-kku/-ukku (Ramukku) = customer receives = GIVE.
"kanakkula ezhuthu/podu", kadan, baaki = GIVE unless a payment verb is present. "illa/no/sorry" = the next value replaces the previous one.
Amount must be a number actually spoken. Never guess an amount. If direction is not clear, use UNSURE.
customer_ref must be one of the given refs or null. evvalavu/how much = BALANCE_QUERY.
```

Six few-shot pairs follow: the dative pair, kitta + vaanginen, varavu podu, illa 150, a multi-entry sentence and a balance question.

**Response schema** (Workers AI `response_format: {type:"json_schema"}`, or Gemini `responseJsonSchema`):

```json
{"type":"object","required":["intent","entries"],"properties":{
 "intent":{"type":"string","enum":["ENTRY","BALANCE_QUERY","OTHER"]},
 "entries":{"type":"array","maxItems":5,"items":{"type":"object",
  "required":["customer_ref","spoken_name","amount_rupees","kind","evidence"],
  "properties":{
   "customer_ref":{"type":["string","null"]},
   "spoken_name":{"type":"string"},
   "amount_rupees":{"type":["number","null"],"minimum":0},
   "kind":{"type":"string","enum":["GIVE","RECEIVE","UNSURE"]},
   "item":{"type":["string","null"]},
   "date":{"type":["string","null"],"enum":["today","yesterday","day_before",null]},
   "evidence":{"type":"string"}}}}}}
```

**Validation: the LLM's answer is a hint, never the authority.**
1. On a schema error (including "JSON Mode couldn't be met"), keep the parser's result.
2. `customer_ref` must be one of the refs sent; otherwise show the picker.
3. `amount_rupees` must equal a number **our parser found** in some alternative. Invented amounts are rejected.
4. Range check with `toPaise`.
5. If the LLM's kind contradicts a parser cue of w ≥ 3, mark it a conflict: no preselection. UNSURE also means no preselection. All dative caps still apply.
6. Log both results and the final choice in `voice_log`.

### 2.7 Never automated

- **Saving any money entry.** There is no hands-free save, ever.
- Choosing between customers with similar names.
- Preselecting a direction under 0.6, on a conflict, or from a dative.
- Filling in an amount that was not spoken, or picking one of two candidates.
- Creating a customer.
- Reversals, corrections and WRITEOFF. Undo stays a button.
- Amounts above `confirm_above_paise`: the existing dialog still fires.

---

## 3. Accounts & authentication

### 3.1 Why accounts, and what is the minimum

Pairing already links several phones. Accounts add two things pairing cannot do:
- **(a)** a browser login;
- **(b)** getting back in after losing every phone without the printed recovery code.

**Phase B starts only after the client confirms they will use one of these.**

The minimum secure version:
- an owner login (Google, or user id + password);
- staff the owner creates;
- sessions as device rows;
- no email, no SMS, no self sign-up.

### 3.2 Model

- **users** are people. **memberships** link a user to the shop with role `owner` or `staff`. **devices** already exist.
- **Every login creates a `devices` row**, exactly as `/pair` does, and returns the **same `PairResponse` shape** (`token, device_id, role, shop, code_block, server_time, sync_epoch`). That keeps four things intact:
  - authorship through `entries.device_id`;
  - pull skipping the caller's own rows;
  - per-device code blocks;
  - revoke-with-wipe.
- `app/src/sync/engine.ts` does not change.
- The server stays single-shop for now: `/setup` only creates the first shop, and `pair_failures` is a global throttle **[verified]**. `memberships` is ready for more shops later.

### 3.3 Passwords: hashing cost

Measured on local workerd (wrangler 4.150, Xeon 2.1 GHz). Production can differ by about 2× **[likely]**.

| Scheme (OWASP parameters) | CPU per hash | Workers Free (10 ms) |
|---|---|---|
| PBKDF2-SHA256 100k (WebCrypto) | 17–24 ms | no |
| PBKDF2-SHA256 600k | 90–110 ms | no |
| **argon2id m=19456 KiB, t=2, p=1 (`@noble/hashes` 2.4.0)** | **190–250 ms** | no |
| scrypt N=2^17, r=8 | 520–600 ms (128 MiB memory risk) | no |
| hash-wasm argon2id | fails: Workers block runtime WASM compilation **[verified]** | — |

**Decision: argon2id through `@noble/hashes` on Workers Paid.**
- Store a PHC string: `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`.
- Rehash at the next login if the parameters are raised.
- Apply HMAC with a **separate** secret `PW_PEPPER`; never reuse `PEPPER`.
- **Bound memory:** each hash uses 19 MiB, against a 128 MB isolate limit. Allow at most 2 concurrent hashes per isolate (a semaphore); beyond that, return `503 busy, retry`.
- **Measure** CPU and memory on the deployed Paid Worker in week 5 before committing.
- **Cost:** about 200 ms × 100 logins a day is about 0.6 M CPU-ms a month, against 30 M included **[verified allowance]**.
- **Fallback:** PBKDF2-SHA256 at the highest iteration count production accepts. A production cap is claimed only by a community post (unverified), so test it.
- **Password policy:** at least 10 characters, a bundled blocklist of the ~1,000 most common passwords, no forced complexity. Passwords the owner issues are temporary (`must_change_pw=1`).

### 3.4 Google Sign-In (works on the Free plan; under 1 ms CPU [likely])

- **Android:** `@capgo/capacitor-social-login` 8.7.0, which uses Credential Manager. Use the **web** client ID as the server client ID, plus a server nonce **[verified]**. Avoid `@codetrix-studio/capacitor-google-auth`: it peers on Capacitor 6 and is abandoned **[verified]**.
- **Web:** a Google Identity Services button with FedCM, using the JS callback. The ID token is POSTed to the same origin.
- **Worker:** `jose` 6.2.12 with `createRemoteJWKSet('https://www.googleapis.com/oauth2/v3/certs')` checks **[verified]**:
  - the signature against the JWKS;
  - `aud` = the web client ID;
  - `iss` ∈ {`accounts.google.com`, `https://accounts.google.com`};
  - `exp` not passed;
  - `email_verified` true;
  - the nonce matches one from `/auth/nonce` (stored hashed, 5-minute TTL, single use).
- **Linking:** by `sub`, never by email. **No auto sign-up.** A Google account works only after the owner links it from a signed-in device, or accepts a staff invite.
- **Google Cloud setup ($0, in the shop's Google account):**
  - consent screen with `openid email profile` (plus `drive.file` in phase C);
  - a web client ID;
  - Android client IDs for the debug, upload **and Play App Signing** SHA-1s.

### 3.5 Sessions = device rows

**Tokens:** opaque, stored as `sha256(token‖PEPPER)` as today, not JWTs. Every request already does one D1 round trip for the daily cap and `last_seen`, so a JWT saves nothing and delays revocation.

| Client | Absolute expiry | Idle timeout | Rotation |
|---|---|---|---|
| Android (`kind='app'`) | none (as today) | 90 days | `/auth/refresh` every 30 days |
| Web, "my computer" | 30 days | 7 days | every 24 h |
| Web, "shared computer" | 12 h | 30 min | none (the session ends first) |

**Rotation with reuse detection** (RFC 9700 §2.2.2, §4.14.2 **[verified]**):
- The new hash goes in `token_hash`; the old one moves to `prev_token_hash` with `rotated_at`.
- The old token is accepted **once** within 2 minutes, because responses get lost on flaky 4G.
- After that, presenting it revokes the device and writes an `auth_events` row.

**Transport binding:** app tokens are accepted only as `Authorization: Bearer`; web tokens only from the `__Host-kk_s` cookie (`HttpOnly; Secure; SameSite=Strict; Path=/`).

**Middleware** (`auth.ts`):
- Look the token up **by hash first**, then compare `kind` with the transport.
- A mismatch is not "not found". It returns `401 wrong_transport` and writes an audit event.
- A **web cookie token seen as a Bearer also revokes that device**, because an HttpOnly cookie should never be readable by script.
- Expiry and idle checks join the existing `UPDATE … RETURNING`, so it stays one D1 round trip.

**Storage:**
- Android: the existing Keystore storage (`@aparajita/capacitor-secure-storage` 8.0.1).
- Web: the cookie only, never localStorage. `platform/web.ts` `secretSet` must not hold the session.

**CSRF:** Hono `csrf()` (an Origin check) on every non-GET request; require `Content-Type: application/json`; never send `Access-Control-Allow-Credentials`.

### 3.6 Throttling, reset, recovery

**Throttling:**
- `LOGIN_LIMITER`: a Workers Rate Limiting binding, 10 per 60 s per IP, on `/auth/login`, `/auth/google` **and `/auth/recover`**. It is best effort, per location **[verified]**.
- `login_throttle` per login id: after 5 failures, a 30 s wait that doubles up to 15 min, reset on success. **No permanent lockout**, because an attacker could use one to lock the owner out.
- A global cap of 3,000 password verifications a day (about 10 CPU-minutes), which bounds the bill under attack.
- Malformed requests are rejected before any hashing. An unknown user and a wrong password get the same `invalid_credentials` error.

**Reset without email:**
- **Staff:** the owner sets a temporary password; `must_change_pw=1`; all of that user's devices are revoked in the same batch.
- **Owner:** `POST /auth/recover {recovery_code, login_id, new_password}` uses a printed recovery code, which is consumed. A linked Google account also works.
- **Email reset is v3.** Cloudflare Email Sending is beta **[verified]**, Resend's free tier needs a domain, and staff often have no email.

### 3.7 Endpoints (`/v1`) and migration from pairing

| Method & path | Auth | Purpose |
|---|---|---|
| POST `/auth/nonce` | none | `{nonce}` for Google |
| POST `/auth/login` | none + limiter | `{login_id,password,device_name,kind,persist?,previous_device_id?,max_local_code?}` → `PairResponse` (web: token in Set-Cookie) |
| POST `/auth/google` | none + limiter | `{id_token,nonce,…}` → `PairResponse` |
| POST `/auth/recover` | recovery code + limiter | owner resets own password → `PairResponse` |
| POST `/auth/refresh` · `/auth/logout` | session | rotate · revoke this device (web also gets `Clear-Site-Data: "cache","storage"`) |
| GET `/me` | session | now includes `user` |
| POST `/account/claim` · `/account/password` · POST/DELETE `/account/google` | session | self-service |
| GET/POST `/users` · PUT `/users/:id/role` · POST `/users/:id/reset-password` · POST `/users/:id/disable` | owner | staff management; role change, reset and disable update or revoke that user's devices in the same batch |
| GET `/devices`, POST `/devices/:id/revoke` | owner | existing; now also lists web sessions with the user's name |
| POST `/voice/interpret`, POST `/stt` | session | phase D only |
| `/pair`, `/devices/pair-code`, `/sync/*`, `/export` | existing | unchanged |

**Migration from pairing (no re-pairing):**
1. Existing devices keep `user_id NULL` and keep working.
2. On the owner phone, Settings → **Create login** → `POST /account/claim`, authenticated with the existing bearer token. This creates the user and the owner membership, and sets `devices.user_id`.
3. The owner creates staff. Each staff phone either claims or logs in with `previous_device_id`, which revokes the old row and moves its codes across, as `/pair` does.
4. Later, a shop setting `pairing_enabled=0` can switch off 8-digit codes. Recovery codes stay.

**D1 migration `api/migrations/0002_accounts.sql`:**

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  login_id TEXT UNIQUE COLLATE NOCASE,          -- [a-z0-9._]{4,32}; NULL if Google-only
  display_name TEXT NOT NULL,
  pw_hash TEXT, pw_changed_at TEXT,             -- PHC argon2id
  must_change_pw INTEGER NOT NULL DEFAULT 0,
  google_sub TEXT UNIQUE, google_email TEXT,
  created_at TEXT NOT NULL, disabled_at TEXT
);
CREATE TABLE memberships (
  user_id TEXT NOT NULL REFERENCES users(id),
  shop_id TEXT NOT NULL REFERENCES shops(id),
  role TEXT NOT NULL CHECK (role IN ('owner','staff')),
  created_at TEXT NOT NULL, created_by TEXT, removed_at TEXT,
  PRIMARY KEY (user_id, shop_id)
);
ALTER TABLE devices ADD COLUMN user_id TEXT REFERENCES users(id);  -- NULL = legacy paired device
ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'app';   -- 'app' | 'web'
ALTER TABLE devices ADD COLUMN expires_at TEXT;
ALTER TABLE devices ADD COLUMN idle_timeout_min INTEGER;
ALTER TABLE devices ADD COLUMN prev_token_hash TEXT;
ALTER TABLE devices ADD COLUMN rotated_at TEXT;
CREATE INDEX devices_user ON devices(user_id);
CREATE UNIQUE INDEX devices_prev_token ON devices(prev_token_hash) WHERE prev_token_hash IS NOT NULL;
CREATE TABLE login_throttle (login_key TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, next_allowed_at TEXT);
CREATE TABLE auth_nonces (nonce_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
CREATE TABLE auth_events (id TEXT PRIMARY KEY, shop_id TEXT, user_id TEXT, device_id TEXT,
  type TEXT NOT NULL, at TEXT NOT NULL);       -- login, claim, refresh_reuse, wrong_transport, revoke, reset
CREATE TABLE voice_usage (shop_id TEXT NOT NULL, day TEXT NOT NULL, stt_ms INTEGER NOT NULL DEFAULT 0,
  llm_calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (shop_id, day));
```

**`shared/protocol.ts` additions:** `LoginRequest`, `GoogleLoginRequest`, `LoginResponse = PairResponse`, `MeResponse.user`, `DeviceInfo.kind` and `user_name`, and (phase D) `VoiceInterpretRequest/Response`. **Sync push and pull bodies are unchanged.**

### 3.8 The ₹0 fallback (if the client refuses $5/month)

**(a) Google sign-in plus pairing and recovery codes, no passwords, on Workers Free.** `jose` RS256 verification plus the D1 batch should fit in 10 ms CPU **[likely]**. **Measure it on a deployed Free Worker before promising ₹0.** Even then, Workers Paid is recommended at go-live to remove the daily request caps (100k requests/day; D1 100k row writes/day **[verified]**).

**(b) Firebase Authentication as the identity provider**, in a Spark project owned by the shop's Gmail. It is free: 3,000 DAU, 100 sign-ups per IP per hour, 150 reset emails a day **[verified]**, and no idle pause is documented **[likely]**. Google does the password hashing.

Design:
- `POST /v1/auth/firebase {id_token, nonce, device_name, kind, …}` → `PairResponse`.
- Verify with `jose` against `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`: RS256, `aud` = project ID, `iss` = `https://securetoken.google.com/<projectId>`, `sub` non-empty **[verified]**.
- Hardening:
  - require `auth_time` and `iat` within 5 minutes;
  - `AUTH_LIMITER` plus a per-uid throttle;
  - **single-use exchange:** store `sha256(id_token)` until the token expires, and reject repeats;
  - check the member's status in the same batch.
- After the exchange, the client signs out of Firebase. The device token is then the only session.
- **No service-account admin key in the Worker.** The owner creates staff logins from the owner phone with a *secondary* Firebase app instance (`createUserWithEmailAndPassword` there does not sign the owner out). A staff "reset" is the owner removing the old login and creating a new one.
- **Every remove, reset or disable revokes that member's D1 devices with `wipe`** in the same batch, and `/auth/refresh` re-checks member status. This matters because Firebase changes do not reach device tokens.
- In the Firebase console, set a password policy (at least 10 characters) and email-enumeration protection.
- Synthetic staff emails go on a domain the developer or shop owns (`kumar@<shop>.users.<owned-domain>`), not `.invalid`. Firebase reset emails do not reach staff; the owner resets them.
- Cost: a second vendor and console, plus `@capacitor-firebase/authentication` 8.5.2 with `firebase@12` pinned (its peer is `^12.6`, while npm latest is 13.0.0 **[verified]**).

---

## 4. Cross-platform web app

**Hosting:** the same Worker serves the Vite build as static assets. Static asset requests are free and unlimited **[verified]**.

```jsonc
"assets": { "directory": "../app/dist-web", "not_found_handling": "single-page-application", "run_worker_first": ["/v1/*"] }
```

- `run_worker_first` needs wrangler 4.20+; the repo has 4.150.
- One origin means no CORS for the web app and a first-party cookie.
- `workers.dev` is on the Public Suffix List, so the cookie is not shared with other tenants' Workers **[verified]**.
- A custom domain is optional (about $10/year, unverified).

**Reuse:** every screen, `core/*`, `data/repo.ts` and the sync engine already run in the browser preview on `db/sqljs.ts` (sql.js + IndexedDB) **[verified]**. The web build adds:
- a login screen;
- cookie-mode API calls (`credentials:'same-origin'`, no Bearer);
- Web Speech for the mic;
- GIS for Google sign-in;
- browser downloads for exports.

**PWA:** `vite-plugin-pwa` 2.0.0 (supports Vite 8 **[verified]**).
- Precache the app shell only.
- Call `navigator.storage.persist()`.
- Offline entries queue in the existing outbox and push through the same idempotent sync.
- The phone stays the ledger of record, because browser storage can be evicted.

**Shared computer:** at login she chooses "This is my computer" or "Shared computer". Shared mode means:
- sql.js runs **in memory only**;
- the 12 h / 30 min session;
- no CSV export.

On logout:
- the device is revoked and the server sends `Clear-Site-Data`;
- the client also deletes IndexedDB and Cache Storage;
- the owner can revoke a forgotten browser from the phone, and the existing `{revoked, wipe:true}` 401 wipes it on its next request.

**First release is owner-only on the web.** Staff web logins come later, which keeps the attack surface small.

| Feature | Android | Web |
|---|---|---|
| Ledger of record | yes | no: a synced client |
| Speech | native Google recogniser | Chrome/Edge Web Speech |
| Secret storage | Keystore | HttpOnly cookie |
| Local data | permanent | evictable; in memory in shared mode |
| Lock | existing app PIN | short idle timeout |
| Drive backup | owner phone | not in v2 |
| Phone/SMS intents | yes | `wa.me` links only |

---

## 5. Data storage & sync

**Where the data lives:**

| Copy | Role | Notes |
|---|---|---|
| Phone SQLite | ledger of record | unchanged |
| Cloudflare D1 (`apac` location hint) | sync hub; ordering via `changelog.seq` | protocol unchanged. Free tier: 5M row reads, 100k row writes/day; the shop uses about 10% **[verified limits]**. Time Travel 7 days (Free) / 30 days (Paid) |
| Browser (sql.js/IndexedDB) | web client | memory only on shared computers |
| **Owner's Google Drive** | daily encrypted backup + optional monthly CSV | `drive.file`, visible folder |
| Cloudflare R2 | nightly server export (cron `30 20 * * *` UTC = 02:00 IST) | 10 GB free **[likely]** |

Any one copy can rebuild the others.

**Getting data into the client's Google account:**

1. **Day one, zero code:** the existing Settings → Backup already shares the `exportBackup` JSON through the Android share sheet (`ui/backup.ts`) **[verified]**. Show the owner how to pick "Save to Drive".
2. **Phase C, automated:**
   - The owner's Google sign-in adds the `drive.file` scope. It is non-sensitive and needs only basic verification; `drive` is restricted and needs a security assessment **[verified]**.
   - Once a day, on app open, on the owner phone only, when online and more than 20 h since the last backup:
     1. build the export JSON;
     2. encrypt it with AES-GCM, using a key derived on the phone from an owner backup passphrase (PBKDF2 600k; the phone has no CPU limit);
     3. upload `kadan-YYYY-MM-DD.kkbak` to the visible folder "Kadan Kanakku Backups".
   - Optionally, a readable monthly CSV statement.
   - **Rotation:** 30 dailies plus 12 monthlies, so customers erased under DPDP disappear from old backups.
   - **No Google refresh token is ever stored on the server.** Refresh tokens expire after 7 days while the consent screen is in "Testing" **[verified]**, so publish the consent screen "In production".
   - **Restore:** Settings → Restore from Drive: list, decrypt, import through `ui/backup.ts`.
   - **Open technical point (unverified):** Credential Manager returns only an ID token. Getting a `drive.file` access token on Android needs the plugin's scopes support or Google's Authorization API through a small native bridge. **Spike this in week 6.** Until it works, the share-sheet path is the guaranteed one.
3. **Ownership:** the shop's Gmail (2-step verification on, recovery phone = owner) owns the Google Cloud project and OAuth client, the Drive folder, the Cloudflare account and its billing. The developer is added as a member.

**Live data in Google (Firestore): not now.**
- It would be a 4–6 week rewrite of `app/src/sync/*` and all of `khata/api` **[likely]**.
- Transactions fail offline **[verified]**, so server-side customer-code allocation and the reversal-race checks would be lost.
- Cloud Functions need Blaze **[verified]**.
- One full-history login can use up 50k reads/day **[verified quota]**.
- Its one real advantage is the `asia-south1` (Mumbai) region **[verified]**. DPDP has no localisation mandate **[likely; confirm with counsel]**, so that advantage matters only if India residency becomes a requirement. Offer it as v3.

**Supabase pause analysis:**
- "Free projects are paused after 1 week of inactivity" **[verified]**. Inactive means insufficient *user database* activity; a few requests a day usually counts as activity.
- A shop that syncs daily usually stays active. A festival or family closure pauses it, and then **auth and sync stop on every device** until someone restores it from the dashboard. The restore window is stated inconsistently (90 days vs 1 year) **[verified]**.
- Keep-alive pings are neither allowed nor forbidden (unverified). Do not build a money ledger on a workaround.
- No free backups; Pro is $25/month.

**Cost table ($1 ≈ ₹88)**

| Item | Free path | Recommended | Source |
|---|---|---|---|
| Android/Chrome speech-to-text | ₹0 | ₹0 | — |
| Parser | ₹0 (on phone) | ₹0 | — |
| Workers + D1 + web hosting | $0 (Free: 10 ms CPU, 100k req/day) | **$5 ≈ ₹440/month** (Paid: 10M req, 30M CPU-ms, no daily caps) | Workers pricing |
| Google Sign-In, OAuth project | ₹0 | ₹0 | — |
| Drive backup (owner's 15 GB, shared with Gmail) | ₹0 | ₹0 | — |
| R2 nightly export | ₹0 (< 10 GB) | ₹0 | R2 pricing (likely) |
| Sarvam STT (phase D, if needed) | signup credits: ₹100 or ₹1,000, pages conflict | ₹0.49/min ≈ ₹50–300/month as primary; ₹5–30 as fallback | Sarvam pricing (likely) |
| LLM (phase D, if needed) | Workers AI 10k neurons/day ≈ 900 calls | ₹0, or paid Gemini Flash-Lite ≈ ₹20–50/month | Workers AI / Gemini pricing |
| Google Cloud STT (alternative) | 60 min/month free | ≈ $0.016/min ≈ $9–10/month at 300/day | GCP STT (likely) |
| Custom domain | optional | ≈ $10/year (unverified) | — |
| **Total** | **₹0** (Google login + pairing only) | **≈ ₹440/month**, + ₹0–300 only if Sarvam is needed | |
| Supabase Pro (rejected) | pauses | $25 ≈ ₹2,200/month | Supabase pricing |

---

## 6. Changes to the existing codebase

**`khata/app`**

| File | Change |
|---|---|
| `src/core/voice.ts` (new) | `normalize`, `tokenize` (no folding of digits), `parseAmount`, `segment`, `scoreDirection`, `buildCustomerIndex`, `matchCustomer`, `parseVoice` |
| `src/core/voice-lexicon.ts` (new) | the folded lexicon (2.2), number words, stop and item words |
| `src/core/ledger.ts` | export a `levenshtein` helper; add a comment on `phoneticFold` warning that it mangles digits (no behaviour change) |
| `src/platform/stt.ts`, `stt-native.ts`, `stt-web.ts`, `stt-server.ts` (new) | engine interface (1.2); `stt-server` in phase D |
| `src/platform/types.ts`, `index.ts`, `native.ts`, `web.ts` | `stt` and mic permission; web: cookie session, in-memory DB for shared computers, wipe on logout |
| `src/ui/components/mic.ts` (new) | hold-to-talk button, listening sheet, partial text, permission flow |
| `src/ui/voice-flow.ts` (new) | STT → parse → (LLM) → picker / add new / list → navigation |
| `src/ui/screens/voice-pick.ts` (new) | customer picker and multi-entry list card (with due before → after per row) |
| `src/ui/screens/voice-test.ts` (new) | 60-prompt accuracy test (section 8) |
| `src/ui/screens/entry.ts` | read `amount`, `note`, `date`, `voice`, `from`; voice banner; `kind` may be null (Save disabled); after save from Home voice, `router.replace('customer',{id})`; write `voice_log` |
| `src/ui/screens/home.ts`, `customer.ts`, `quick.ts` | mount the mic; the customer page passes `currentCustomerId` |
| `src/ui/screens/login.ts` (new) | user id/password, Google, "Pair with code", my/shared computer choice |
| `src/ui/screens/settings.ts` | Voice (on/off, engine, AI help, onboarding "kuduthaachu" question, Voice test, stats, privacy text), Create login, Users, Linked Google, Drive backup and restore |
| `src/backup/drive.ts` (new, phase C) | encrypt, upload, rotate, list, restore |
| `src/db/schema.ts` | local-only tables (below), never synced |
| `src/sync/api.ts` | `login`, `loginGoogle`, `refresh`, `logout`, `claim`; same token storage as `pair` |
| `src/i18n/ta.ts`, `en.ts` | voice, login and backup strings |
| `android/app/src/main/AndroidManifest.xml` | `RECORD_AUDIO` permission; `RecognitionService` `<queries>` |
| `patches/@capgo+capacitor-speech-recognition+8.4.4.patch` | `EXTRA_BIASING_STRINGS` (kept only if the A/B test shows a gain) |
| `package.json` | `@capgo/capacitor-speech-recognition@8.4.4`, `@capgo/capacitor-social-login@8.7.0`, `vite-plugin-pwa@2.0.0`, `patch-package` |
| `vite.config.ts` | `web` target → `dist-web` with PWA |
| `test/voice.test.ts`, `test/voice.fixtures.json`, `test/voice.numbers.property.test.ts` (new) | section 8 |
| `README.md` | permission table and privacy text |

```sql
-- app SQLite, local only
CREATE TABLE voice_log (id TEXT PRIMARY KEY, at TEXT NOT NULL, engine TEXT, ms INTEGER, alts TEXT,
  parse TEXT, llm TEXT, final_entry_id TEXT, cancelled INTEGER NOT NULL DEFAULT 0, edited TEXT);
CREATE TABLE voice_alias (folded TEXT PRIMARY KEY, customer_id TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 1);
CREATE TABLE voice_cue_override (cue TEXT PRIMARY KEY, kind TEXT NOT NULL, flips INTEGER NOT NULL);
```

**`khata/api`**

| File | Change |
|---|---|
| `migrations/0002_accounts.sql` (new) | DDL in 3.7 |
| `src/lib/password.ts` (new) | argon2id hash/verify/`needsRehash`, pepper, per-isolate semaphore |
| `src/lib/google.ts` (new) | `jose` JWKS verification, nonce issue/consume |
| `src/lib/devices.ts` (new) | the device-insert + code-block batch moved out of `/pair`, shared by `/pair` and logins |
| `src/lib/auth.ts` | lookup by hash, then transport check; expiry/idle; rotation and reuse |
| `src/routes/auth.ts`, `account.ts`, `users.ts` (new) | endpoints in 3.7 |
| `src/routes/voice.ts` (new, phase D) | `/voice/interpret` (Workers AI binding `AI`, schema, cap), `/stt` (Sarvam) |
| `src/routes/public.ts` | `/pair` uses `lib/devices.ts` |
| `src/index.ts` | `csrf()`, assets, new routers, scheduled handler (R2 export) |
| `src/env.ts`, `wrangler.jsonc` | `assets`; `LOGIN_LIMITER` (namespace 1002); `r2_buckets`; `triggers.crons`; vars `GOOGLE_WEB_CLIENT_ID`, `AI_MODEL`, `VOICE_DAILY_CAP`; secrets `PW_PEPPER` (+ `SARVAM_KEY` and the `ai` binding in phase D) |
| `package.json` | `jose@^6.2`, `@noble/hashes@^2.4` |
| `test/auth.test.ts`, `google.test.ts`, `users.test.ts`, `voice.test.ts` (new) | section 8 |

---

## 7. Milestones (each one ends in a demo)

**Phase A: voice on Android, no new server code**

| Week | Work | Demo |
|---|---|---|
| 1 | `core/voice.ts` ported from the prototype: lexicon, numbers, segmentation, matcher, dative caps; 150+ fixtures; digit-fold guard; number property test | `vitest` passes every row of 2.5 |
| 2 | Manifest fix, Capgo plugin, mic on the **customer page**, entry params, voice banner, null-kind state; test on the client's Redmi phones (permission, offline, `checkRecognitionSupport`) | On Ramu's page: "100 kuduthaan" → Got ₹100 pre-filled → Save → Undo |
| 3 | Mic on Home and Quick; picker, add new, multi-entry card, `voice_log`, aliases, onboarding question, cue overrides, biasing patch (A/B ready); Web Speech in the browser preview | "Ramu 100 kuduthaachu" from Home → confirm → lands on Ramu's page |
| 4 | **Voice test + gate run in the shop** (quiet and busy hours, owner and staff) | Accuracy report against section 8. Pass: voice on by default. Fail: "beta, customer page only", and phase D starts |

**Go/no-go before phase B:** the client confirms that browser access or login-based recovery will actually be used, and accepts Workers Paid or the ₹0 path.

**Phase B: accounts and web**

| Week | Work | Demo |
|---|---|---|
| 5 | Migration 0002, `lib/devices.ts`, password + throttle, login/claim/users routes, tests; Workers Paid on; argon2id CPU and memory measured on the deployed Worker | Owner phone claims an account; a staff login works on a second phone; sync unchanged |
| 6 | Google sign-in (Android + web), rotation, logout/wipe, Settings → Users; **Drive access-token spike** | Owner signs in on a new phone with Google; remotely revokes a staff phone |
| 7 | Web build on Worker assets, PWA, cookie session, shared-computer mode, web voice; owner-only | Same ledger on a laptop in Chrome; shared-mode logout leaves nothing behind |

**Phase C: backup**

| Week | Work | Demo |
|---|---|---|
| 8 | Encrypted daily Drive upload, rotation, restore, R2 cron, final privacy text | Backup visible in the owner's Drive; a wiped phone restores from it |

**Phase D (conditional, about 1 week each, bake-off on the same recorded set):**
- Sarvam `/v1/stt`, if Google STT fails the gate.
- The LLM `/v1/voice/interpret`, if `voice_log` shows more than about 15% lexicon misses.

Keep the paper book alongside through phases A and B.

---

## 8. Testing & accuracy evaluation

**Automated (CI)**
- **`test/voice.fixtures.json`:** at least 300 rows of `{transcript, alts, customers, expected:{customer, amount_paise, kind|null, note, date}}`. It must include **both halves of the dative pair** (each asserting that nothing is preselected for the dative half), the kuduthaachu onboarding states, Tamil number words, corrections, multi-entry, items with quantities, balance questions, same-name customers and lexicon-collision names. A lexicon change must not lower any metric.
- **Property tests:**
  - for every amount from 1 to 99,999 rupees, `parseAmount` reading `amountInWords(paise,'ta')` back gives exactly that amount (`amountInWords` already exists **[verified]**);
  - digit tokens are never folded;
  - any amount the parser outputs appears in the transcript.
- **UI:**
  - voice params pre-fill the entry screen;
  - Save is disabled while kind is null;
  - Home voice lands on the customer page after Save;
  - Undo after "Save all" reverses every row.
  - A Playwright E2E on the web preview injects transcripts through a fake `SttEngine` and asserts that **nothing is saved without a click**.
- **API:**
  - unknown user and wrong password give the same response;
  - throttle back-off;
  - Google tokens with a wrong `aud`/`iss`, an expired token, nonce reuse;
  - rotation reuse revokes the device;
  - a cookie token used as a Bearer gives `wrong_transport` and a revoke;
  - CSRF;
  - a role change or disable revokes devices;
  - `/auth/recover` is rate-limited;
  - phase D: schema failure falls back, refs that were never sent are rejected, an invented amount is rejected, the daily cap holds.
- The existing sync and integration suites must pass unchanged.

**Field gate (Settings → Voice test, week 4)**
- 60 prompts generated from the **real** customer list: a random customer, an amount (digits, round Tamil numbers and compound numbers) and a phrasing style.
- Read by the owner and each staff member, at a quiet hour and a busy one.
- For each engine, record the alternatives, the parse and the latency.
- Then collect 200–300 real counter sentences over the following weeks. The confirmation step labels each one for free, and names are pseudonymised before export. Stratify:
  - about 50/50 GIVE/RECEIVE;
  - at least 30 dative pairs;
  - at least 40 Tamil number words;
  - at least 30 Tanglish;
  - at least 15 multi-entry;
  - at least 10 each of corrections, same-name, unknown names, balance questions, and items with quantities.

| Metric | Target to turn voice on by default |
|---|---|
| **Wrong direction preselected** | **≤ 0.5%** (key safety metric) |
| Wrong customer saved | 0 (tracked through undo/reverse within 10 min) |
| End-to-end correct with no edit | ≥ 85% |
| Amount exact: correct transcript (CI) / end to end | ≥ 99.5% / ≥ 97% |
| Customer top-1 / top-3 | ≥ 90% / ≥ 98% |
| Direction accuracy end to end; coverage (preselected) | ≥ 95%; ≥ 80% |
| Same-name cases sent to the picker | 100% |
| Latency, release → confirmation screen | median ≤ 1.5 s, p90 ≤ 3 s |
| No-result rate | ≤ 5% |
| Phase D LLM: call rate; p95 | ≤ 25%; < 2.5 s (parser < 50 ms) |

**In production:** Settings → Voice stats (local) shows:
- edits after voice pre-fill, by field;
- cancels and keypad fallbacks;
- engine latency;
- reversals within 10 minutes of a voice entry compared with keypad entries, which must be no higher.

The developer reviews these weekly for the first month.

**Honest expectation:** 75–90% of sentences fully right before any edit in a quiet shop (unverified estimate). That is why the confirmation step exists.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Google's Tamil recognition on Redmi phones is weaker than hoped; no published figure (unverified) | Week-4 gate; customer-page mode; Sarvam in phase D; aliases; biasing A/B |
| A dropped or added "-க்கு" flips the direction | Dative cap 0.55; alternatives conflict check; due before → after; big toggle; Undo; cue overrides |
| "kuduthaachu" means the opposite in this shop | Onboarding question; bare form starts at w1; flips learned |
| Two Ramus / rare names | Mandatory picker on ties; spoken disambiguators; local aliases |
| No Google speech service, or offline | Mic hidden or a clear message; keypad always there |
| Biasing patch does nothing for Tamil (unverified) | A/B; drop it |
| Workers AI model renamed; Gemma's Tamil weak (unverified) | `AI_MODEL` variable; parser-only works on its own; bake-off list |
| argon2id CPU/memory differs in production [likely ±2×] | Week-5 measurement; semaphore; daily cap; PBKDF2 fallback |
| Production PBKDF2 iteration cap (unverified) | argon2id is primary |
| ₹0 path exceeds Free CPU | Measure on a deployed Free Worker; Paid recommended anyway |
| Firebase fallback: leaked ID token, orphaned staff logins | 5-min `auth_time`, single-use exchange, limiter, D1 revoke on every member change |
| Drive token unavailable on Android (unverified) | Week-6 spike; share-sheet backup; R2 copy |
| Owner forgets the backup passphrase | Printed with the recovery codes; R2 copy; optional monthly CSV |
| Browser data left on a shared PC | Memory-only shared mode, 30-min idle, remote revoke + wipe |
| Free tiers change (Workers AI, Firebase, Sarvam credits ₹100 vs ₹1,000) | Per-shop caps; parser works without AI; budget ₹300/month if Sarvam is enabled |
| DPDP obligations (most from about May 2027 [likely]); D1 has no India region | Processors named; no audio stored; backup rotation honours erasure; confirm residency with counsel |

---

## 10. Open questions for the client

1. In your shop, does "Ramu 100 kuduthaachu" always mean **Ramu paid you**? How do you say it when you gave Ramu goods on credit ("Ramu-ku…", "vaanginaan", "kanakkula podu")? Please record 20 real sentences from the counter.
2. Which phones (model, Android version, Google app enabled)? Who will speak to the app: the owner only, or staff too?
3. Is **₹440/month (Workers Paid)** acceptable, on the shop's own card, for user id/password login and no daily caps? If not: Google sign-in plus pairing (₹0), or Firebase Auth for passwords (₹0, second vendor).
4. Do staff have Gmail? Or should the owner create user id/password logins for them?
5. Who needs the web app, and on whose computer: the owner's own laptop or a shared counter PC? Is owner-only enough at first?
6. Is a daily encrypted backup (plus an optional readable monthly CSV) in the owner's Drive what "data in our Google account" means? Or must Google host the live data (Firestore v3: 4–6 weeks, Blaze billing in the shop's name)?
7. Do you accept that voice audio goes to Google for recognition? With "AI help" or Sarvam on, the sentence text and some customer names also go to Cloudflare or Sarvam.
8. If the free Google recogniser misses the accuracy gate, is about **₹50–300/month for Sarvam** acceptable?
9. Must the data be stored in India? (D1 offers only "apac".)
10. Custom domain (for example `kanakku.<shop>.in`), or the free `workers.dev` address? And would you like an optional spoken read-back ("ராமு, நூறு ரூபாய், பெற்றது") before Save?

---

## Sources

Speech and AI
- Android RecognizerIntent: https://developer.android.com/reference/android/speech/RecognizerIntent
- Android SpeechRecognizer: https://developer.android.com/reference/android/speech/SpeechRecognizer
- Capgo speech plugin: https://registry.npmjs.org/@capgo/capacitor-speech-recognition · https://github.com/Cap-go/capacitor-speech-recognition · https://capgo.app/docs/plugins/speech-recognition/
- Web Speech API (MDN): https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
- Sarvam saaras: https://docs.sarvam.ai/api-reference-docs/getting-started/models/saaras · rate limits: https://docs.sarvam.ai/api/ratelimits · pricing: https://docs.sarvam.ai/api/pricing.md · changelog: https://docs.sarvam.ai/api/changelog
- Voice of India benchmark: https://voiceofindiablogs.ai.joshtalks.com/
- Whisper vs IndicConformer FLEURS-ta: https://friendli.ai/models/lemuralabs/tamil-asr-qwen3
- AI4Bharat: https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual · https://github.com/AI4Bharat/vistaar
- Whisper Tamil small: https://huggingface.co/vasista22/whisper-tamil-small
- Vosk models: https://alphacephei.com/vosk/models
- Deepgram languages: https://developers.deepgram.com/docs/models-languages-overview
- Bhashini: https://bhashini.gitbook.io/bhashini-apis
- Google Cloud STT languages: https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages
- Workers AI: pricing https://developers.cloudflare.com/workers-ai/platform/pricing/ · JSON mode https://developers.cloudflare.com/workers-ai/features/json-mode/ · Gemma 4 https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/ · models https://developers.cloudflare.com/workers-ai/models/ · privacy https://developers.cloudflare.com/workers-ai/privacy/
- Gemini: terms https://ai.google.dev/gemini-api/terms · pricing https://ai.google.dev/gemini-api/docs/pricing · rate limits https://ai.google.dev/gemini-api/docs/rate-limits · structured output https://ai.google.dev/gemini-api/docs/structured-output · gemini-3.5-transcribe https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe
- ML Kit GenAI devices: https://developers.google.com/ml-kit/genai · Chrome Prompt API: https://developer.chrome.com/docs/ai/prompt-api
- Prior art: https://okcredit.in/blog/how-to-use-okcredit-application-for-grocery-store

Auth, hosting and storage
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/ · pricing: https://developers.cloudflare.com/workers/platform/pricing/ · D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Static assets: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ · Rate limiting: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ · Email: https://developers.cloudflare.com/email-service/
- workerd PBKDF2 limits: https://github.com/cloudflare/workerd/blob/main/src/workerd/api/crypto/impl.c%2B%2B
- OWASP password storage: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- RFC 9700: https://www.rfc-editor.org/rfc/rfc9700.html
- Google ID token verification: https://developers.google.com/identity/gsi/web/guides/verify-google-id-token · Credential Manager: https://developer.android.com/identity/sign-in/credential-manager-siwg-implementation · OAuth (refresh-token expiry): https://developers.google.com/identity/protocols/oauth2
- Capgo social login: https://github.com/Cap-go/capacitor-social-login
- Firebase: ID token verification https://firebase.google.com/docs/auth/admin/verify-id-tokens · auth limits https://firebase.google.com/docs/auth/limits · pricing https://firebase.google.com/pricing · plans https://firebase.google.com/docs/projects/billing/firebase-pricing-plans · Firestore quotas https://firebase.google.com/docs/firestore/quotas · transactions https://firebase.google.com/docs/firestore/manage-data/transactions · locations https://docs.cloud.google.com/firestore/docs/locations · capacitor plugin https://capawesome.io/plugins/firebase/authentication/
- Google Cloud free features: https://docs.cloud.google.com/free/docs/free-cloud-features
- Drive scopes: https://developers.google.com/workspace/drive/api/guides/api-specific-auth · appdata: https://developers.google.com/workspace/drive/api/guides/appdata
- Set-Cookie (MDN): https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie · Public Suffix List: https://publicsuffix.org/list/public_suffix_list.dat
- Supabase pausing: https://supabase.com/docs/guides/platform/free-project-pausing · keep-alive example: https://github.com/travisvn/supabase-pause-prevention
- Lucia: https://lucia-auth.com/ · Better Auth: https://www.better-auth.com/docs/authentication/email-password
- Turso: https://turso.tech/pricing · Neon: https://neon.com/pricing · Appwrite: https://appwrite.io/changelog/entry/2026-06-29
- DPDP: https://www.hoganlovells.com/en/publications/indias-digital-personal-data-protection-act-2023-brought-into-force-
