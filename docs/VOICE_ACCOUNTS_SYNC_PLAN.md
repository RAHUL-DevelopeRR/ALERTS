# Kadan Kanakku — Tamil Voice Entry, Accounts & Cross-Platform Sync Plan

**Date:** 2026-10-18 · **Status:** Plan v2. The server accounts build is partly done and still in progress.

**What already exists in the repo** (the WIP commits `ddaa70a`, `ebed2df` and `4f020f4`):
- `khata/api/migrations/0002_accounts.sql`, `src/lib/password.ts`, `google.ts`, `session.ts`, `throttle.ts`, and `src/routes/auth.ts` / `users.ts`.
- The v2 block in `shared/protocol.ts`, and `api/web/_headers` (the web CSP).
- An uncommitted `app/src/core/voice.ts`.

Section 3 now describes the design that was built: the password is stretched on the client, and the server stores an HMAC verifier. Section 3 also lists the security changes the WIP code **still needs before phase B ships** (3.9), and section 6 marks every server file as done, WIP or to do.

This builds on the v1 plan in [`docs/GROCERY_DEBT_APP_PLAN.md`](GROCERY_DEBT_APP_PLAN.md) and on what already exists in [`khata/`](../khata/): the app (Capacitor 8 + TypeScript, with the ledger in SQLite on the phone), the API (Cloudflare Worker + Hono + D1, sign-in by device pairing) and `shared/protocol.ts`.

Each fact carries a tag. **[verified]** means checked on an official page or in the code. **[likely]** means a strong secondary source or a local measurement. **(unverified)** means not confirmed; anything this plan relies on that is unverified also appears as a risk in section 9. Prices are converted at about ₹88 to $1.

**Labels used in this plan.** Since v1.0.1 (commit `eb60ddd`) the app's two buttons read **Debit / பற்று** (= `GIVE`, goods given on credit, the customer owes more, red) and **Credit / வரவு** (= `RECEIVE`, payment received, the customer owes less, green) (`i18n/en.ts`, `ta.ts`, keys `det.gave` / `det.got`) **[verified]**. This plan uses those labels. Note that shop slang often uses English "credit" to mean *udhaar* (goods on credit, i.e. Debit in the app), so the parser treats bare "credit"/"debit" as ambiguous (section 2.2).

---

## Answers to your questions

**1. Can we add voice mode, and which free speech and AI backend handles Tamil?**

Yes. The free primary engine is Google's own speech recogniser set to Tamil (`ta-IN`).
- **Android:** it is built into the phone, and the app reaches it through the plugin `@capgo/capacitor-speech-recognition` 8.x, the best-maintained Capacitor 8 native speech plugin **[verified: npm, peer `@capacitor/core >=8`]**.
- **Web app:** the browser's Web Speech API. **Chrome (desktop and Android) is the tested target** and sends audio to Google. Edge (Microsoft's cloud recogniser) and Safari 14.1+ / iOS 14.5+ (Apple, prefixed `webkitSpeechRecognition`) also expose the API, but their Tamil quality is unverified; MDN lists the API as "limited availability" **[verified]**. The app feature-detects and shows the mic only in browsers that pass a `ta-IN` smoke test.
- Both cost ₹0 and need no API key. Both need internet by default, and the audio goes to the browser's or phone's speech provider (Google on Android and Chrome; Microsoft on Edge; Apple on Safari).

Speech-to-text alone is not enough. A transcript like "ராமு 100 குடுத்தாச்சு" still has to become *customer + amount + Debit/Credit*. That part is done by a Tamil/Tanglish parser that we write ourselves. It runs on the phone, costs nothing, and checks every guess against the shop's real customer list. A scratch prototype got 25 of 26 sentences right on kind and amount **[likely: 26 developer-written sentences, an earlier rule set, customer resolution not scored, no real recogniser output]**. It is committed with its fixtures under `khata/app/test/` in week 1 and re-scored under this plan's rules, including customer resolution.

**Fallbacks**, added only if measurements show they are needed:
- **Sarvam `saaras:v4`** called through our Worker. It costs ₹30 per hour billed per second (₹0.50/min) **[verified: this is the Speech-to-Text rate on the pricing page; that it applies to `saaras:v4` comes from the docs, which name it the default model, so confirm in the console]**, roughly ₹50–300 a month at this shop's volume **[likely]**. Sarvam's models ("Sarvam Audio" 14.2% and Saarika 2.5 14.9% Tamil OI-WER, an orthography-insensitive word error rate) led the only independent Indian benchmark we found **[likely]**, but `saaras:v4` itself has no independent Tamil score.
- **A free AI model on Cloudflare** (Workers AI, Gemma 4) for sentences the parser cannot decide.

**Honest accuracy statement:** nobody publishes Tamil accuracy for Google's phone recogniser. My estimate is that 75–90% of short commands will come out fully right (customer, amount and direction) in a quiet shop (unverified). Voice therefore **never saves money on its own**. Every entry stops on a confirmation screen with a Save button, and voice is switched on by default only after it passes a test with the shopkeeper's own voice (section 8).

**2. What happens when the shopkeeper says "Ramu 100 kuduthaachu"?**

1. **Once, at setup**, the app asks what this sentence means in *this* shop: "நீங்கள் 'ராமு 100 குடுத்தாச்சு' என்றால், ராமு உங்களுக்குப் பணம் கொடுத்தாரா? / Does it mean Ramu paid you?" She answers **yes**. (Until she answers, the app treats the verb as unknown: Debit and Credit both stay unselected.)
2. She holds the mic button and speaks, and the words appear live on screen.
3. The recogniser returns one or more guesses (how many Google returns for Tamil is unverified; often only one), and the parser reads them:
   - "100" is the amount: ₹100.
   - "குடுத்தாச்சு" is an impersonal "has been given". With the setup answer and no "-க்கு" ("to") on the name, it means *Ramu has paid the shop*: **Credit / வரவு (RECEIVE)**, which lowers his due.
   - "ராமு" matches the customer Ramu in her list.
4. The app opens Ramu's Debit/Credit screen with **₹100** filled in, the amount in words, what it heard, and "பாக்கி ₹450 → ₹350".
5. **Direction, by default:** "Ramu 100 kuduthaachu" (paid) and "Ramu**க்கு** 100 kuduthaachu" (*gave to* Ramu) differ by one syllable that the recogniser easily swallows after a vowel-final name. So for this verb family the app shows Credit as **suggested** (outlined, pulsing) but does **not select it**; she taps **Credit** once. If the week-4 field test on her phones shows the recogniser keeps "-க்கு" reliably, the owner can switch on Settings → Voice → "Preselect Credit for kuduthaachu". Credit is then preselected, and the only guards against a swallowed "-க்கு" are the due before → after line, the spoken read-back (on by default while voice is in beta) and Undo (section 2.2, rule 2).
6. She taps **Save**. The app lands on **Ramu's account page** with the new balance and an Undo button.

Clearer verbs preselect directly: "Ramu 100 kattinaan" or "Ramu gpay 100" → Credit; "Ramu 100 vaanginaan" (*Ramu took goods*) → Debit, as long as the recogniser's guesses agree (it is one vowel away from "vaanginen", *I received*). Because Tamil phrasing can point either way, the app asks (nothing preselected, Save disabled until she taps a side) whenever it cannot be sure:
- "Ramu**க்கு** 100 குடுத்தாச்சு" or "Ramu kitta 100 kuduthaachu" means *gave to* Ramu: Debit (GIVE), but it is never preselected.
- "kanakkula ezhuthu" means *write it in his account*: Debit, but weak, so it is not preselected. Bare English "credit"/"debit" is not preselected either, because shop slang and the app's buttons use "credit" in opposite senses.
- The recogniser's guesses disagree on the direction or on the amount: nothing is preselected, and the amounts show as chips.
- If there are two Ramus, it shows a picker with code and phone digits.

**3. Login with user id/password and/or Google, on the server?**

Both, built **inside the Cloudflare Worker we already have**. The server side is partly built already (status line above). Each login creates a "device" session, just as pairing does today, so the sync protocol does not change. The app's sync engine only gains a cookie mode for the web.
- **Google sign-in** is free.
- **User id + password also costs ₹0, on Workers Free.** The phone or browser does the slow, safe password stretching itself (PBKDF2-SHA256, 600,000 rounds, about 0.5–1.5 s on a Redmi phone (unverified, measured in week 5)). The server stores and checks only a keyed HMAC of the result, which takes microseconds of CPU **[verified: `api/src/lib/password.ts`]**. This is the design already in the code (3.3).
- **Workers Paid ($5 ≈ ₹440 a month) is still recommended at go-live**, as the v1 plan said, but it is no longer needed for passwords. It removes the Free plan's daily caps of 100k requests and 100k D1 row writes.
- **The login id can be a mobile number** typed on the number pad, and login screens are Tamil first, so staff who cannot type English can sign in. The owner issues staff credentials, or staff use Google or a pair code / QR from the owner's phone. The **owner's** login id should not be the shop's public mobile number (3.6).

**4. Cross-device and web app?**

- **Phones:** any phone (owner or staff) signs in and syncs through the existing sync protocol.
- **Web app:** the same app screens are served from the same Worker at no cost. It can be installed as a PWA and has a "shared computer" mode that keeps the ledger in memory only and refuses to log out while entries are unsynced.
- **v2 web = owner only, enforced by the server.** A staff login from the web gets `403 web_owner_only` and a Tamil-first message: "இணைய உள்நுழைவு உரிமையாளருக்கு மட்டும் — கைபேசி செயலியைப் பயன்படுத்தவும்" (web login is for the owner only; use the phone app). Staff web login is a later phase. When it comes, the server forces shared-computer (memory-only) mode for staff, so a staff member's home PC never keeps the whole ledger.
- **Voice on the web:** Chrome is the tested target; Edge and Safari show the mic only if a Tamil smoke test passes.
- **Ledger of record:** the phone stays the master copy, because browsers can delete stored data.

**5. Where does the data live, and what about "their Google cloud account / own credits"?**

- **Live data:** stays where it is today, in the phone's SQLite plus Cloudflare D1 as the sync hub.
- **Google login does not move any data into Google.** The honest way to put the client's data in their Google account is a **daily encrypted backup into a visible folder in the owner's own Google Drive**, plus an optional monthly CSV statement. It uses the `drive.file` permission, which Google classes as non-sensitive **[verified]**. When the owner opens Drive, the **monthly CSV is the copy a person can read**; the encrypted `.kkbak` files are only for restoring through the app (the owner may choose unencrypted backups instead, since the folder is in their own account). Automating this needs the Google consent screen published "In production". With only non-sensitive scopes (`openid email profile drive.file`) that should need no app verification, and brand verification is optional: without it, the consent screen shows the app's domain instead of its name and logo **[likely: Google Cloud help 15549049; tested on `workers.dev` in the week-6 spike]**. A custom domain is therefore optional, for nicer branding (section 3.4).
- **Ownership:** the shop's own Gmail owns the Google project, the Drive folder and the Cloudflare account.
- **"Credits":** there are no ongoing Google Cloud credits. The $300 trial lasts 90 days **[verified]**, and the always-free VM and storage tiers are US-only **[verified]**.
- **Moving live data into Google Firestore** would mean a 4–6 week rewrite of working money code. That is not recommended for now.

**6. Supabase pausing: use it or not?**

**Do not use it.**
- Free projects pause after one week of low activity **[verified]**, and a pause stops login *and* sync on every device until someone restores the project by hand. That is possible for up to 1 year **[verified]**; the page's heading still says 90 days, but its body says 1 year. A 10-day festival closure would be enough to trigger it. Supabase says API calls count as activity, so a scheduled ping is possible, but it does not fix the next point.
- The free plan has no backups. Daily backups are for Pro/Team/Enterprise only, and free projects are told to use `db dump` **[verified: supabase.com/docs/guides/platform/backups]**.
- Pro costs $25 a month, five times Workers Paid.
- Supabase's Google login would put the data in Supabase's Postgres, not in Google.
- Cloudflare and Firebase document no idle pause **[likely]**.

---

## Recommendation in one page

**Chosen architecture**

| Layer | Choice |
|---|---|
| Speech-to-text (Android) | Google `SpeechRecognizer`, `ta-IN`, up to 5 alternatives requested (how many come back is unverified), via `@capgo/capacitor-speech-recognition` 8.x pinned to a release at least 2 weeks old |
| Speech-to-text (web) | Web Speech API, `lang='ta-IN'`; Chrome tested, Edge/Safari only after a Tamil smoke test |
| Understanding | Deterministic parser on the phone, `app/src/core/voice.ts`, reusing `transliterateTamil` / `phoneticFold` / `matchesQuery` / `toPaise` / `asciiDigits` |
| Confirmation | Existing entry screen (`ui/screens/entry.ts`) pre-filled, with a voice banner; shared `preSaveChecks` for every save path. **Never auto-save.** |
| Conditional boosters (phase D) | Sarvam `saaras:v4` STT proxy; Workers AI LLM `/v1/voice/interpret`. Both off by default, built only if measured data calls for them |
| Accounts | Inside the existing Worker (**partly built**): the password is stretched on the client (PBKDF2-SHA256 600k), and the server stores `HMAC(PEPPER, client_key)`, which runs on Workers Free. Google ID tokens are checked with WebCrypto RS256 against Google's JWKS. Every login = a `devices` row returning a `PairResponse`-compatible `LoginResponse`. The security deltas in 3.9 are still to do |
| Web app | Same Vite UI as Workers static assets, PWA, HttpOnly cookie session, shared-computer mode; owner-only at first |
| Data | Phone SQLite (record) → D1 (sync hub) → daily encrypted Drive backup (owner) + nightly R2 export |
| ₹0 path | The same design on Workers Free: passwords, Google and pairing all fit within 10 ms of CPU. Paid is recommended only to remove the daily caps (3.8) |

**Order of work:**
- **A.** Android voice with no new server code, ending in a measured gate (weeks 1–4).
- **B.** Accounts and the web app (weeks 5–7). The server part has already started as WIP code. It ships only after the client confirms they will actually use a browser or recover by login, and after the 3.9 fixes pass their tests.
- **C.** Automated Drive backup (week 8).
- **D.** The LLM and Sarvam, only if the data justifies them.

**Rejected (one line each)**
- **Supabase free:** pauses after 7 idle days, which stops auth on every device; no backups; Pro costs $25.
- **Firestore as the live store:** a 4–6 week rewrite; transactions fail offline; one full-history login can use up the 50k reads/day free quota.
- **Google Drive as the sync engine:** no transactions, no ordering, every device would need the owner's Google login.
- **Whisper (Workers AI):** it would fit the free neurons at this volume, but whisper-large-v3 scores ≈48.6% WER on FLEURS-Tamil (vendor-computed on its own clips, not a Workers AI measurement) **[likely]**, so it is rejected on accuracy.
- **Deepgram Nova-3, OpenAI, AssemblyAI:** 52–68% OI-WER (orthography-insensitive word error rate) on real Indian Tamil: GPT-4o-mini-transcribe 51.9%, AssemblyAI Universal 57.4%, GPT-4o-transcribe 64.2%, Deepgram Nova-3 67.8% **[likely: Voice of India benchmark]**. On the same benchmark and the same OI-WER metric, paid Gemini 3 Pro scores 15.7% and Amazon Transcribe 19.3%, and the Sarvam figures quoted in answer 1 are OI-WER too. Gemini audio is a phase-D bake-off candidate.
- **Gemini free tier:** its terms forbid personal information, and customer names are personal information.
- **Bhashini:** the free tier is for proof of concept only; production needs a paid agreement (pricing not public).
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
| **Customer page** (`customer.ts`) | header, large | "100 kuduthaan", "ஐநூறு வாங்கினான்". The page's customer is the default, but name-span detection still runs. **The page's customer is kept whenever it scores at least as well as any other customer, within 0.10.** So "Ramu 100 kattinaan" on Ramu-1's page stays with Ramu-1, even though a second Ramu also scores 1.0. The app asks "நீங்கள் சொன்னது சீதா — சீதா கணக்கைத் திறக்கவா? / You said Sita: open Sita?" (or shows the picker) only in two cases: another customer beats the page's customer by ≥ 0.10, or the spoken name does not match the page's customer at all (score < 0.6, or unknown name tokens). Whenever that prompt appears, it shows the C-code and the last 4 phone digits of both customers. **This is the most accurate mode and the one to teach first.** |
| **Home** (`home.ts`) | **primary 64 dp button, bottom centre**; the existing add-customer FAB (`.fab`, bottom right, line 276) stays where it is, and the list gets extra bottom padding so neither covers a row | full sentence, "Ramu 100 kuduthaachu" |
| **Quick entry** (`quick.ts`) | header | full sentence; sticky date and running totals are kept |
| **Entry screen** (open) | small | corrections: "illa 150", "Sita illa, Seetha" change only that field |

**How listening works:**
- **Hold to talk** is the default, but **the recogniser, not the button, decides when speech ends.** Google's `SpeechRecognizer` ends the session by itself after a pause even while the button is held, and it often ignores the silence-length extras that `allowForSilence` sets (`EXTRA_SPEECH_INPUT_(POSSIBLY_)COMPLETE_SILENCE_LENGTH_MILLIS`) **[verified: plugin source; Google behaviour likely]**. Android's `RecognizerIntent` docs say these extras should be set only in "extremely rare" cases, and only when the same value is also passed as `EXTRA_SEGMENTED_SESSION` (API 33) **[verified]**. So "Ramu… [pause] …100 kuduthaachu" can be cut off after "Ramu". Three options, chosen in week 2 on the client's Redmi phones:
  - the plugin's **experimental** `continuousPTT` option, which restarts recognition while the button is held; the app joins the segments before parsing;
  - `EXTRA_SEGMENTED_SESSION` (API 33+), which needs a plugin patch; or
  - accept auto-endpointing and treat release as `stopListening()`; if a session ends with only a name, the sheet stays open with "தொகை சொல்லுங்கள் / say the amount".
- A setting switches to tap-to-start with auto-stop on the recogniser's own endpoint.
- Hard limit: 10 s.
- While listening, the app shows a pulsing ring, "கேட்கிறேன்… / Listening…", the **live partial text** (`partialResults:true`) and Cancel.
- The mic appears only after the microphone permission is granted. The first tap explains why in Tamil first ("பேசி கணக்கு போட மைக் அனுமதி தேவை").
- **Each voice session is tied to the route** that started it (router depth plus a session token). Navigating away, a leave guard, Cancel or the app going to the background aborts it (`AbortSignal` in 1.2), and a late result is dropped instead of navigating.

**The confirmation is the existing entry screen** with new route params `amount` (paise), `note`, `date`, `voice='1'` and `from`. A voice banner sits above the keypad:
1. **Heard:** the transcript in grey. Tap it to see the other alternatives. The number words the parser used are underlined, and **next to them the amount is written out in words in large type** ("₹500 — ஐநூறு ரூபாய்", via `amountInWords`). A misheard "ainooru" for "aayirathu ainooru" then shows as ஐநூறு next to what she remembers saying.
2. **Plain sentence in the direction colour:** "ராமு உங்களுக்கு ₹100 கொடுத்தார் → **வரவு**" / "Ramu paid you ₹100 → **Credit**".
3. **Due before → after:** "பாக்கி ₹450 → ₹350". If the due goes *up* when she expected it to go down, the direction is wrong, and she can see that at a glance.
4. **Which customer:** the name, and, **whenever another customer has a similar name**, the C-code, phone last 4 and note too, so she can tell the two Ramus apart on this screen and not only in the picker.
5. A **Change customer** chip; a large **பற்று Debit | வரவு Credit** toggle (the existing `det.gave`/`det.got` labels); a date chip, highlighted when the date is not today; a note chip such as "அரிசி".
6. **When `kind` is absent** (direction confidence below 0.6, or a conflict), neither side is selected, **Save stays disabled** and the toggle pulses; a side the parser leans towards is outlined as "suggested" but not selected. Today `entry.ts` defaults to GIVE (`route.params.kind === 'RECEIVE' ? … : 'GIVE'`). Under `voice='1'` that default must become "none". `save()` itself also returns early when `kind` is null, because the hardware Enter key calls `save()` directly (line 277) and bypasses the disabled button.
7. A spoken Tamil read-back before Save, "ராமு, நூறு ரூபாய், வரவு", using Android text-to-speech. It is **on by default while voice is in beta** (until the week-4 gate passes and the amount metrics hold for 4 weeks), and also on by default for staff who asked for Tamil-only screens. After that it is an option in Settings → Voice. It is the main guard against a misheard amount when the recogniser returns only one alternative (2.3).

**After Save:**
- `entry.ts` calls `router.back({force:true})` today (line 224) **[verified]**.
- If voice was started on **Home**, the stack is rebuilt instead: `router.backTo('home')` followed by `router.go('customer', {id})` (both exist in `ui/router.ts` **[verified]**), so it ends as [home, customer] with no stale picker or entry screen in between. She lands on **Ramu's page**, and Back then goes to Home. This is the "navigate to Ramu's account" behaviour the client asked for.
- From the customer page, the normal `back` is used. From quick entry, today's behaviour is kept.

**Safety nets — moved into one shared function so every save path gets them:** today the big-amount dialog (`confirm_above_paise`, line 167), the "got more than due → advance" dialog and `recentDuplicate` (line 192) live inside `entry.ts` `save()`, not in `repo.addEntry` **[verified]**. They are extracted into `preSaveChecks(customer, kind, paise, date, {window})` in a new `ui/save-checks.ts`, used by both `entry.ts` and the multi-entry card.
- `recentDuplicate` defaults to **60 seconds** (`repo.ts` line 823) and `entry.ts` calls it with no window **[verified]**; voice entries pass 120 s.
- The **Undo** toast (`reverseEntry`, line 238) is unchanged for single entries.

**Other outcomes**

| Parser outcome | Screen |
|---|---|
| Two or more customers within 0.10 **on the raw name score** ("Ramu" and "ராமு tea kadai") | Picker: name, C-code, phone last 4, note, balance. It never picks silently. The 0.10 margin is applied **before** the recency and due bonuses, which only order the picker (with bonuses, "Ramu" 1.08 vs "Ramu Tea Kadai" 0.95 would have pre-filled silently). |
| Best match between 0.6 and 0.85 | Picker with the top 3, plus "Add 'Ramu' as new" |
| No match | `customer-edit` with the best transcript of the name pre-filled **and highlighted for checking**, plus the nearest existing customer ("Did you mean Raamu?") so a mishearing does not create a duplicate. Today `customer-edit.ts` accepts `name` but its save path (lines 115–144) only replaces to `customer`, or goes to `entry` with `kind:'GIVE'` hard-coded **[verified]**; it gains pass-through params (`amount`, `kind` or none, `note`, `date`, `voice`, `from`) and, in both its create and same-name branches, forwards them to `entry` with no hard-coded GIVE. |
| Balance question ("Ramu baaki evvalavu?") | Opens Ramu's page. No entry is created. |
| Several entries ("Ramu 100, Sita 50 vaanginaanga") | List card (`voice-pick.ts`): one row per entry with its own Debit/Credit toggle **and its own due before → after**, then "Save all (2)". Entry ids are generated when the card is built; Save all runs `preSaveChecks` per row, then a new `repo.addEntries` writes every row in **one transaction**, so a retry cannot duplicate a row; the button is disabled while saving. Undo reverses all rows in one `db.transaction`. At most 5 per sentence. |
| No amount heard, two candidate amounts, **or the STT alternatives give different amounts** | Entry screen with the customer and kind filled in, the amount **empty**, the keypad focused, and the candidate amounts as chips |

The customer picker and the "open Sita?" prompt are **overlays** (`ui/components/overlay.ts` already has `actionSheet` and `dialog`), not routes, so they never leave a stale screen on the back stack. Only the multi-entry card is a screen.

### 1.2 Pipeline

```
mic (hold) → SttEngine.recognize('ta-IN', hints, signal) → { alts[1..5], scores?, engine, ms }
  → (aborted or route changed? drop the result)
  → parseVoice(alts, customerIndex, overrides)        // on the phone, < 50 ms, no network
  → [phase D only] unsure + "AI help" on + online → POST /v1/voice/interpret → validate → merge
  → resolve customer: prefill | picker overlay | add new
  → router.go('entry', { id, kind?, amount?, note?, date?, voice:'1', from })
  → shopkeeper taps Save → preSaveChecks → repo.addEntry (unchanged, append-only) → outbox → existing sync
  → voice_log row (local only; includes the number of alternatives and any confidence scores)
```

```ts
// app/src/platform/stt.ts
export interface SttResult { alts: string[]; scores?: number[]; engine: 'android' | 'web' | 'sarvam'; ms: number }
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
| `stt-native.ts` | Capgo `{language:'ta-IN', maxResults:5, partialResults:true, popup:false}` (plus `continuousPTT` if chosen in week 2); `isRecognitionAvailable()` first. `maxResults:5` is a request: **how many alternatives Google returns for `ta-IN` is unverified, and it is often one.** Read Android's `CONFIDENCE_SCORES` where the plugin exposes them (patch if not) and lower preselection when the top score is low (2.2, rules 4 and 9). |
| `stt-web.ts` | `SpeechRecognition ?? webkitSpeechRecognition`, `lang='ta-IN'`, `maxAlternatives=5`, `interimResults=true`. `phrases` (customer names, contextual biasing) is listed as supported from Chrome 142 in MDN's browser-compat data (marked experimental), while Chrome Platform Status still shows "Proposed" **[likely]**. MDN's only example uses it with `processLocally=true`, so it may work only for on-device recognition, which Tamil probably lacks. Feature-detect it, wrap it in try/catch, and A/B it like the Android biasing patch |
| `stt-server.ts` (phase D) | MediaRecorder webm/opus ≤ 8 s → `POST /v1/stt` → Worker calls `saaras:v4` with `language_code:'ta-IN'` and up to 50 keyterms (top customer names) **[verified feature]**; audio never stored |

Settings → Voice → Engine: **Auto** (Google; Sarvam on failure, if enabled), Google only, or Sarvam only.

### 1.3 Android specifics

- **Manifest** (`app/android/app/src/main/AndroidManifest.xml`) **[verified]**:
  - Line 69 removes `RECORD_AUDIO` with `tools:node="remove"`. Replace it with `<uses-permission android:name="android.permission.RECORD_AUDIO"/>`.
  - Line 70 removes `MODIFY_AUDIO_SETTINGS`. **Leave it removed** unless the merged manifest shows the plugin needs it; the Capgo manifest adds only `RECORD_AUDIO` **[verified]**.
  - Add `<queries><intent><action android:name="android.speech.RecognitionService"/></intent></queries>`, which Android requires for apps targeting API 30+ **[verified]**.
  - Update the permission table in `app/README.md` and the privacy text **in the same change**.
- **Runtime permission:** ask on the first mic tap. If she refuses, hide the mic and offer "ask again" in Settings.
- **Plugin:** `@capgo/capacitor-speech-recognition` 8.x (peer `@capacitor/core >=8`) **[verified]**. Capgo releases almost daily (8.4.4 came out 2026-10-16), so **pin the newest release that is at least 2 weeks old** at install time (today that is 8.3.2 of 2026-09-15 **[verified: npm]**), after checking that it has what this plan uses (`continuousPTT`, `isOnDeviceRecognitionAvailable`), record it in the lockfile, and review the Capgo diff and changelog before each bump. `@capacitor-community/speech-recognition` is unmaintained since June 2025 at 7.0.1, though its peer range (`>=7`) still allows Capacitor 8 **[verified]**; `capacitor-offline-speech-recognition` 3.0.0 and the Cordova wrapper `@awesome-cordova-plugins/speech-recognition` also exist but are not preferred.
- **Biasing toward customer names (optional):** Android 13+ has `EXTRA_BIASING_STRINGS` **[verified]**, but Capgo ignores `contextualStrings` on Android **[verified]**. A roughly 10-line `patch-package` change to `buildRecognizerIntent` passes the 50–100 most active names. Whether Google honours it for Tamil is unverified, so keep it only if the A/B in section 8 shows a gain.
- **Offline:** the plugin wraps Android's `checkRecognitionSupport` as `isOnDeviceRecognitionAvailable({language})`, which returns true when the language is installed, supported **or pending** (plugin source) **[verified]**. So "available" means "may need a download", not "installed". Either patch it to report installed languages separately or treat it that way. Whether an offline Tamil pack exists at all is unverified.
- **No Google speech service** (`isRecognitionAvailable()` false, for example a non-GMS ROM): hide the mic, or use Sarvam if phase D enabled it. The keypad is always one tap away.
- **On-device option to watch:** ML Kit's GenAI Speech Recognition API (alpha; its Basic mode runs on most API 31+ devices) **[likely]**. Tamil support is not stated (unverified), so it is not planned.
- **Redmi/HyperOS:** Indian ROMs normally ship Google speech services **[likely]**. Test on the client's actual phones in week 2: permission, offline, mid-sentence pauses (`continuousPTT` vs `EXTRA_SEGMENTED_SESSION` vs auto-endpointing), and **the number of alternatives and confidence scores returned for `ta-IN`** (logged in `voice_log`).
- **Voice & Audio Activity:** when it is on in the shop's Google account, Google can save recordings and transcripts (with customer names) to that account. Onboarding asks the owner to turn it off on shop phones.

### 1.4 Web specifics

- **Chrome (desktop and Android) is the tested target.** Edge (Microsoft's cloud recogniser) and Safari 14.1+ / iOS 14.5+ (Apple, prefixed `webkitSpeechRecognition`) expose the API, but their Tamil (`ta-IN`) support is unverified **[verified: MDN "limited availability"]**. Firefox does not. Feature-detect, run a short `ta-IN` smoke test on first use, and show the mic only where it passes; elsewhere show "Voice works in Chrome".
- Chrome is server-based by default: audio goes to Google. On-device recognition (`processLocally`, `SpeechRecognition.available()`, `install()`) and unprefixed `SpeechRecognition` shipped in **Chrome 139 stable**. The on-device API is marked experimental, not hidden behind a flag **[verified: developer.chrome.com/blog/new-in-chrome-139; MDN browser-compat-data]**. Feature-detect `SpeechRecognition.available({langs:['ta-IN'], processLocally:true})`. Tamil on-device is unlikely (unverified), but if a `ta-IN` pack ever appears, it would also give the web a no-cloud privacy option.
- Inside the Capacitor Android WebView, always use the native plugin, never Web Speech **[likely]**.

### 1.5 Offline behaviour

- The parser, the confirmation and saving all work offline. Entries go to SQLite and the outbox as today.
- Speech recognition needs internet unless an offline Tamil pack is installed (unverified). With no network, the mic sheet says "குரல் பதிவுக்கு இணையம் தேவை — தட்டச்சு செய்யவும் / Voice needs internet; type instead" and opens the keypad.

### 1.6 Privacy (DPDP Act)

**What leaves the phone:**
- Audio goes to Google (Android, Chrome), Microsoft (Edge) or Apple (Safari), or to Sarvam only if that engine is enabled. If Sarvam is enabled, **up to 50 customer names go to it as keyterms**. Sarvam processes data in India; its retention depends on a workspace setting (Sarvam changelog, September 2026) (unverified detail), so **set retention to 0 days in the Sarvam console and record it**.
- If "AI help" is on (phase D), **the transcript plus up to 8 candidate customer names** go to Cloudflare Workers AI.
- Balances, phone numbers and the ledger are never sent.
- **No audio is stored anywhere**, except in the opt-in Voice test, and then only on the phone.

**Defaults and consent:**
- Voice, Sarvam and AI help are each **off by default**.
- The owner turns them on in Settings, on a screen that names these processors (Google; Microsoft and Apple for web users on Edge or Safari; Cloudflare; Sarvam). The same text goes in the README privacy section.
- `voice_log`, `voice_alias` and `voice_cue_override` stay on the phone and are never synced; only the onboarding answers (`voice_meanings`, no names) sync as a shop setting. The evaluation export replaces names with C1, C2….
- **Erasure:** the customer erase flow (`app.sync.eraseCustomer`, and the repo path that applies `erased_at` on every phone) also deletes that customer's `voice_log` rows and `voice_alias` entries, which hold spoken names.
- **Never** use the Gemini free tier with real names. Its terms say "Do not submit sensitive, confidential, or personal information to the Unpaid Services" **[verified]**.

---

## 2. Understanding Tamil

### 2.1 Normalising and tokenising

1. Apply NFC, then `asciiDigits` (Tamil ௦–௯ → 0–9, already in `ledger.ts`). Strip ₹, turn "1,250" into "1250", split digit|letter boundaries ("100ரூபாய்" → "100 ரூபாய்"), and split a hyphenated case suffix off a name ("Ramu-kku" → "Ramu" + dative; a separate "ku"/"kku" token is treated the same way).
2. Fold each token:
   - **Digit tokens are never folded.** `phoneticFold` collapses repeated characters, so "100" would become "10" and "500" would become "50" **[verified]**.
   - **English lexicon words are looked up raw, before folding.** "fifty" would fold to "pipty".
   - Everything else becomes `phoneticFold(transliterateTamil(tok))`.
3. The existing transliteration already unifies the two scripts **[verified]**: குடுத்தாச்சு and kuduthaachu both become `kututasu`; ராமு and Ramu both become `ramu`; ஐநூறு and ainooru both become `ainuru`. So one folded lexicon **mostly** covers both scripts, but not every word: எண்ணெய் folds to `eney` while "ennai" folds to `enai` **[verified: ran `ledger.ts`]**. Lexicon keys are therefore generated from **both** the Tamil and the Latin form of every entry, and a CI check asserts that each Tamil/Latin pair folds to the same key or is listed twice. **There is one exception: raw-matched rows.** A form whose folded key collides with a common filler word is matched **before folding**, on the raw NFC Tamil string and on the raw lower-case Latin string, and its folded key is never registered. The app's own button labels are the case in point: பற்று folds to `paru`, which is also the fold of பாரு / "paaru" ("look"), a common filler at the counter **[verified: ran `ledger.ts`]**. The CI check skips raw-matched rows, and asserts instead that no lexicon key equals the fold of a filler on a short list (paaru, sari, seri, appo, enna).
4. Tag each token as NUMBER, CUE, DATIVE-NAME, ITEM, DATE, NEG, STOP or NAME. A NAME after an entry that already has a name and an amount starts a new entry.

### 2.2 Direction lexicon

Keys are folded. **Matching is by exact folded form**: each row lists its forms, and where a row uses a stem it carries an explicit per-row suffix list and stems are tried longest first. A generic `^stem(suffix)?$` would let row 4 `kututa` + "su" swallow `kututasu` (kuduthaachu) and preselect Credit before the onboarding answer. A CI test asserts that every lexicon form resolves to its own row. **w** is the weight of evidence. **Class** marks forms that one misheard syllable can flip: **C1** = impersonal or person-less *kudu* forms whose meaning hangs on a "-க்கு" the recogniser can swallow (rule 2); **C2** = first-person/third-person pairs that differ only in the verb ending (rule 4).

Tamil marks the person on the verb, and that decides the direction:
- **kudu** (give) *about the customer* means he paid: RECEIVE (Credit). *Said by the shop* ("I/we gave") it means GIVE (Debit).
- **vaangu/edu** (take/buy) works the other way round.
- **kattu** (pay) is RECEIVE.

| # | Tamil | Latin forms | Folded | Dir | w | Class |
|---|---|---|---|---|---|---|
| 1 | குடுத்தான் / கொடுத்தான் | kuduthaan, koduthaan | kututan, kotutan | R | 3 | C2 (↔ 32) |
| 2 | கொடுத்தாரு / கொடுத்தார் | koduthaaru, kuduthaar | kotutaru, kututar | R | 3 | — |
| 3 | குடுத்தாங்க | kuduthaanga | kututanka | R | 3 | C2 (↔ 33) |
| 4 | குடுத்தா / குடுத்தாள் | kuduthaa, kuduthaal | kututa, kututal | R | 2 | C1 |
| 5 | **குடுத்தாச்சு** | **kuduthaachu**, koduthaachu | kututasu | **shop setting** (rule 10) | 1 → 3 | C1 |
| 6 | குடுத்துட்டான் | kuduthuttaan | kutututan | R | 3 | — |
| 7 | கொடுத்துட்டாங்க | koduthuttaanga | kotututanka | R | 3 | — |
| 8 | கட்டினான் | kattinaan | katinan | R | 4 | — |
| 9 | கட்டுனான் | kattunaan | katunan | R | 4 | — |
| 10 | கட்டிட்டாரு / கட்டிட்டாங்க | kattittaaru, kattittaanga | katitaru, katitanka | R | 4 | — |
| 11 | கட்டியாச்சு | kattiyaachu | katiyasu | R | 4 | — |
| 12 | செட்டில் பண்ணிட்டான் | settle pannitaan | setil / setle | R | 4 | — |
| 13 | வரவு (வை / போடு) — the app's **Credit** label | varavu (vai/podu) | **raw match** (வரவு, varavu), before folding | R | 3 | — |
| 14 | ஜமா | jama | sama | R | 3 | — |
| 15 | வந்துச்சு / வந்தாச்சு | vandhuchu, vandhaachu | vantusu, vantasu | R | 3 | — |
| 16 | திருப்பி (குடுத்தான்) | thiruppi | tirupi | R | +2 | — |
| 17 | வாங்கினேன் ("I received") | vaanginen | vankinen | R | 3 | C2 (↔ 23) |
| 18 | வாங்கிட்டோம் | vaangittom | vankitom | R | 3 | C2 (↔ 26) |
| 19 | கிட்டருந்து ("from") | kitta irundhu, kittarundhu | kitaruntu | R | 2 | — |
| 20 | — | paid, payment, received, got | raw | **agent rule 6** (NAME paid → R; I/we paid NAME → G) | 3 | — |
| 21 | ஜிபே / போன்பே | gpay, phonepe, paytm, UPI (also sets mode UPI) | raw | R | 3 | — |
| 22 | பணம் கட்டினான் | panam kattinaan | panam = STOP + #8 | R | 4 | — |
| 23 | வாங்கினான் | vaanginaan | vankinan | G | 4 | C2 (↔ 17) |
| 24 | வாங்குனான் | vaangunaan | vankunan | G | 4 | — |
| 25 | வாங்கினா / வாங்கினாள் | vaanginaa, vaanginaal | vankina, vankinal | G | 4 | — |
| 26 | வாங்கிட்டான் | vaangittaan | vankitan | G | 4 | C2 (↔ 18) |
| 27 | வாங்கிட்டு போனான் | vaangittu ponaan | vankitu | G | 4 | — |
| 28 | வாங்கிக்கிட்டாங்க | vaangikittaanga | vankikitanka | G | 4 | — |
| 29 | வாங்கினாரு / வாங்கினாங்க | vaanginaaru, vaanginaanga | vankinaru, vankinanka | G | 4 | — |
| 30 | எடுத்தான் / எடுத்தாங்க | eduthaan, eduthaanga | etutan, etutanka | G | 3 | — |
| 31 | எடுத்துட்டு போனான் | eduthuttu ponaan | etututu | G | 3 | — |
| 32 | குடுத்தேன் ("I gave") | kuduthen | kututen | G | 4 | C2 (↔ 1) |
| 33 | கொடுத்தோம் | koduthom | kotutom | G | 4 | C2 (↔ 3) |
| 34 | குடுத்திருக்கேன் | kuduthirukken | kututiruken | G | 4 | — |
| 35 | கடன் | kadan | katan | G (noun) | 2 | — |
| 36 | பாக்கி | baaki, paakki | paki | G (noun) | 2 | — |
| 37 | உதாரி / உதார் | udhaari, udhaar | utari, utar | G (noun) | 2 | — |
| 38 | கணக்குல எழுது / எழுதுங்க | kanakkula ezhuthu, ezhuthunga | elutu, elutunka | light verb | 1 | — |
| 39 | போடு / போட்டுரு | podu, potturu | potu, poturu | light verb | 1 | — |
| 40 | பற்று — the app's **Debit** label | pattru, patru | **raw match** (பற்று, pattru, patru), before folding; the folded `paru` is **never** a cue (it is also பாரு / "paaru", "look") | G | 3 | — |
| 41 | — | credit, debit, "credit-la podu", "debit pannu" | raw | **ambiguous**: shop slang "credit" = udhaar (G), the app's Credit = R; capped 0.55 unless onboarding question 2 settles it (rule 10) | 2 | — |
| 42 | — | gave, given, took, bought | raw | **agent rule 6** (NAME gave → R; NAME took/bought → G; I/we gave → G) | 3 | — |
| 43 | அரிசி, பருப்பு, எண்ணெய், சக்கரை, பால், முட்டை, சோப்பு, சாமான் | arisi, paruppu, ennai, sakkarai, paal, muttai, soap, saamaan | arisi, parupu, enai + eney, sakarai, pal… (keys from both scripts) | G + note | 1 | — |
| 44 | எவ்வளவு / எத்தனை | evvalavu, ethana, how much | evalavu, etana | BALANCE_QUERY | — | — |
| 45 | இல்ல / இல்லை / தப்பு | illa, illai, no, sorry, thappu | ila, tapu | NEG (correction) | — | — |
| 46 | கிட்ட | kitta | kita | recipient marker with *kudu*; "from" marker with *vaangu* (rule 5) | 0 | — |
| 47 | இன்னைக்கு / நேத்து / முந்தாநேத்து | inniku, nethu, munthaanethu, yesterday | iniku, netu, muntanetu | DATE 0 / −1 / −2 | — | — |

**Composition rules, applied in order**

1. **Light verbs** (ezhuthu, podu, add, note) take their direction from a nearby noun: "varavu podu" is R; "kadan/baaki podu" is G. With no such noun they mean G at w1.
2. **Recipient marker on the name means the customer received.** The dative forms are `-vukku`, `-kku`, `-ukku`, `-ku`, `வுக்கு`, `க்கு`, a hyphenated "-kku", or a separate "ku" token; *kitta* with a *kudu* verb counts the same (rule 5). **Strip the longest suffix first**; a leftmost regex alternation turned "Ramukku" into "Ram" in the prototype **[verified]**.
   - The marker alone counts as G w2.
   - With a third-person or impersonal *kudu* verb, the verb is re-read as GIVE.
   - **Cap 0.55 when the direction depends on the marker**, i.e. when removing the marker would remove or flip the direction. "Ramukku 100 kuduthaachu" is capped (without "-க்கு" it reads as paid). "Ramu-kku 250 arisi kuduthen" is **not** capped: kuduthen is G w4 on its own, so it is GIVE 1.0 with note "arisi".
   - **Missing-marker guard (C1).** The dative is often swallowed after a vowel. So a C1 form (kuduthaachu, kuduthaa/kuduthaal) with **no** marker, when the matched name ends in a vowel (Ramu, Sita, Selvi), is also capped at 0.55, **even after the onboarding answer**. Credit is shown as "suggested", not selected. The cap lifts only if (a) a marker-free strong cue **pointing the same way (Credit)** is also present (kattinaan, gpay/UPI, varavu); a Debit cue such as vaanginaan cannot lift it and instead produces a mixed, low-confidence result; or (b) the owner switches on Settings → Voice → "Preselect Credit for kuduthaachu", offered only after the week-4 gate has tested at least 30 dative pairs on the shop's phones. Learning from flips never lifts it (rule 11).
   - **Honest limit:** with that switch on, if "-க்கு" is dropped from every alternative, "Ramukku 100 kuduthaachu" **will** be preselected as Credit. The guards are then the due before → after line, the spoken read-back (on by default in beta) and Undo.
3. **Disagreement across alternatives:** if any two STT alternatives give **opposite directions for any reason** (verb person, marker, kitta, English agent), the entry is a **conflict** and nothing is preselected. If they give **different amounts**, the amount is left empty and the distinct values show as chips (1.1). Both are counted in `voice_log`. This net only works when the recogniser returns more than one alternative, which is unverified for `ta-IN` (often one). **It is not counted as a safety net until the week-2 logs show multiple alternatives.**
4. **Confusable person pairs (C2):** kuduthen/kuduthaan, koduthom/kuduthaanga, vaanginen/vaanginaan, vaangittom/vaangittaan differ only in -ேன்/-ோம் vs -ான்/-ாங்க. A C2 cue is preselected only if every returned alternative agrees **and**, where the recogniser gives a confidence score, the top score is at least 0.7 (tuned in week 4). Otherwise it is capped at 0.55. These pairs are in the fixtures and in the week-4 stratified set.
5. **kitta** depends on the verb. With *kudu* it marks who **received** (a recipient marker, rule 2): "Ramu kitta 100 kuduthaachu" is G, capped at 0.55; "Ramu kitta 100 kuduthen" is G (kuduthen alone decides, no cap). With *vaangu* it marks who it came **from**, and the person on the verb decides: "Ramu kitta 100 vaanginen" is R (subject to rule 4).
6. **English agent rules** mirror the Tamil ones. NAME + gave/paid ("Ramu gave 100", "Ramu paid 100") = RECEIVE. NAME + took/bought = GIVE. I/we + gave/paid ("I paid Ramu 100", the shop paid out) = GIVE. "gave to NAME" or "NAME-ku gave" = GIVE through the recipient marker (rule 2). "got/received from NAME" = RECEIVE. When no subject can be found, the English cue counts only w1 (no preselect). Bare "credit"/"debit" stay capped at 0.55 (row 41); the Tamil labels பற்று (Debit) and வரவு (Credit) follow the app's own buttons.
7. **Verbs outrank nouns.** When a verb cue of w ≥ 3 is present, noun cues (kadan, baaki, udhaar) count 0. So "kadan kattinaan" is R at 1.0, not an opposing mix. "baaki 100" with no verb may just be stating the balance, so baaki alone is capped at 0.55 (no preselect); "250 kadan" alone stays G at 0.67.
8. **Inheritance in multi-entry sentences:** an entry with no cue of its own takes the sentence's cue at confidence 0.5 (no preselect). An entry with a marker never inherits.
9. **Confidence** = `|G − R| / (G + R) × min(1, (G + R) / 3)`, then apply the caps in rules 2–5 and 10, and cap at 0.55 when an Android confidence score is available and below the week-4 threshold. A direction is **preselected only at ≥ 0.6 with no conflict.** For example, a single w3 cue gives 1.0, a single w1 cue gives 0.33, and w2 alone gives 0.67.
10. **Onboarding meanings are a shop setting.** Answers are stored in the shop record and synced to every phone through the existing owner-only `PUT /shop` (new field `voice_meanings` in `ShopUpdateRequest`/`ShopInfo`), so each phone does not ask again.
    - **Question 1, kuduthaachu.** Grammatically it is impersonal ("has been given"). Until the shop answers ("நீங்கள் 'ராமு 100 குடுத்தாச்சு' என்றால், ராமு உங்களுக்குப் பணம் கொடுத்தாரா? / When you say 'Ramu 100 kuduthaachu', did Ramu pay you?"), the bare word is R at **w1**, confidence 0.33, so nothing is preselected or suggested. "Yes" makes it R w3 and "No" makes it G w3, still subject to the C1 guard in rule 2.
    - **Question 2, English "credit".** "When you say 'Ramu 100 credit', is that goods given (பற்று/Debit) or money received (வரவு/Credit)?" The answer sets row 41 to w3 in that direction; unanswered, it stays capped.
    - So a bare kuduthaachu never reaches 1.0 from a developer assumption.
    - **The questions are shown in Tamil script first**, never only in Tanglish, with a large **கேட்க** (listen) button that reads the question aloud through Android text-to-speech. The answers are big buttons, **ஆம் / இல்லை** (yes / no) for question 1 and **பற்று / வரவு** with their colours for question 2, so a shopkeeper who reads little Tamil and no English can still answer.
11. **Shop learning can only demote, never invert.** Each Debit/Credit flip on the confirmation screen is counted in `voice_cue_override(cue, has_marker, flips)`, but **only** for entries that had confidence 1.0, no recipient marker and no conflict; flips are a symptom of recognition errors as often as of meaning. After 3 consistent flips, that cue drops to weight 0 on that phone: "ask", no preselect. Learning never switches a cue to the opposite direction. **Changing what a cue means** needs the explicit owner setting in Settings → Voice, which shows a worked example ("Ramu 100 kuduthaachu → Debit: Ramu owes ₹100 more") and asks for confirmation. Settings → Voice also has **Reset voice learning**. A fixture proves that no sequence of flips ever produces an inverted preselect.

### 2.3 Number grammar

Read left to right. `cur` holds the part below 1,000; `total` holds thousands and above.

- **Digits:** with `.dd`, Tamil digits and "1,250".
- **Units:** onnu/oru/ondru 1, rendu/irandu 2, moonu 3, naalu/naangu 4, anju/aindhu 5, aaru 6, ezhu 7, ettu 8, ombodhu/onbadhu 9, pathu 10.
- **Teens:** pathinonnu 11, pannendu 12, pathimoonu 13, pathinaalu 14, pathinanju 15, pathinaaru 16, pathinezhu 17, pathinettu 18, pathonbadhu 19 (Tamil script and spoken variants of each).
- **Tens:** irubadhu 20, muppadhu 30, naarpadhu/naappadhu 40, aimbadhu/ambadhu 50, arubadhu 60, ezhubadhu 70, embadhu/enbadhu 80, thonnooru 90. Fused forms add up: irubathanju = 25, muppathanju = 35.
- **Hundreds:** nooru 100, irunooru 200, munnooru 300, naanooru 400, ainooru 500, arunooru 600, ezhunooru 700, ennooru 800, thollaayiram 900. Split forms multiply: "anju nooru" = 500, "rendu nooru" = 200.
- **"N hundred" for thousands**, as Tamil Nadu shops count: a unit, teen or fused number below 100 followed by nooru multiplies, "pathinanju nooru" = 1,500, "irupathanju nooru" = 2,500.
- **Combining forms** add and continue: nooththi/noothi, irunoothi, ainoothi. "irunoothi ambadhu" = 250; "nooththi irubadhu" = 120.
- **Thousands and up:** aayiram 1000. The combining forms aayirathu/aayirathi continue the number: "ஆயிரத்து ஐநூறு" = 1500. Every unit × aayiram: rendaayiram 2000, moovaayiram 3000, naalaayiram 4000, anjaayiram 5000, aaraayiram 6000, ezhaayiram 7000, ettaayiram 8000, onbadhaayiram 9000, pathaayiram 10000; also split "anju aayiram". Lakh: latcham/laksham/lakh/லட்சம்/**இலட்சம்** (the spelling `amountInWords` prints) = 100000; and English hundred/thousand.
- **Digit × multiplier word:** "2 ஆயிரம்" = 2000, "1 ஆயிரம் 500" = 1500, "2 இலட்சம் 50 ஆயிரம்" = 250000. This is exactly the hybrid that the app's own `amountInWords(paise,'ta')` prints **[verified]**, so a shopkeeper reading the banner aloud is understood.
- **Fractions:** "-arai" means +½ of the unit (onnarai 1.5; "rendarai aayiram" = 2500); arai/half alone adds 0.5; kaal = ¼, mukkaal = ¾ ("kaal kilo" is a quantity and is dropped; "mukkaal aayiram" = 750).
- **Indian English:** "one fifty" = 150, "two fifty" = 250. The rule: a unit word directly followed by a tens word, with no "hundred" between.
- **End of number:** ரூபாய் / rupees / rs / rubaa. "paisa" counts only after a rupee value.
- **Choosing among several numbers:**
  - drop a number followed by kilo/kg/litre/packet/dozen;
  - drop a 10-digit number (a phone number);
  - drop a number after "C"/"code" (a customer code);
  - prefer the number next to ₹ or rupay.
  - If more than one candidate is still left, the amount is **empty** and the candidates show as chips.
  - **Across alternatives:** if the STT alternatives parse to different amounts ("சீதா ஆயிரத்து ஐநூறு" 1,500 vs "சீதா ஐநூறு" 500; ainooru 500 vs aimbadhu 50; 250 vs 200; rendarai aayiram 2,500 vs ainooru 500), the amount is **empty** and the distinct values show as chips. The app never takes the "best combined score" amount silently, because ₹500 would slip under `confirm_above_paise` and the amount is the field most likely to be skimmed.
  - **Honest limit, single alternative.** For `ta-IN` the recogniser often returns only one alternative (unverified). Then a dropped "aayirathu" (spoken "Sita aayirathu ainooru", heard "Sita ainooru") fills in **₹500 with no chips**, below `confirm_above_paise`. Like the direction check in rule 3, **the cross-alternative amount check is not counted as a safety net until the week-2 logs show that multiple alternatives come back.** Until then the guards are:
    - the amount in words in large type next to the heard number words (1.1, item 1);
    - the due before → after line;
    - the spoken read-back, on by default while voice is in beta (1.1, item 7);
    - the "amount edited after voice" rate in `voice_log`, which is a gate metric (section 8).
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

  Bonuses (used **only to order the picker**, never in the prefill margin): +0.05 if the customer had an entry in the last 7 days; +0.03 for an outstanding due when the direction is RECEIVE. She can also narrow the match by voice: periya/chinna, "tea kadai", "C 42", the last 4 phone digits.
- **Decision:**
  - prefill only if top1 ≥ 0.85 **and** top1 − top2 ≥ 0.10, both on the raw score before bonuses;
  - on the customer page, the page's customer is kept when its raw score is within 0.10 of the best other customer, so namesakes never pull the entry away. The app prompts ("open Sita?" or the picker, always with C-code and phone last 4) only when another customer beats it by ≥ 0.10, or the spoken name does not match the page's customer at all (score < 0.6, or unknown name tokens) (1.1). With no spoken name, the page's customer is used;
  - otherwise use the picker or "add new" (table in 1.1).
- **Alternatives:** parse every STT alternative returned (up to 5). For the **customer**, keep the best combined score. **Direction and amount are not chosen this way:** any disagreement across alternatives is a conflict (rule 3 in 2.2; amount chips in 2.3).
- **Aliases:** when she picks a customer for a spoken form, store it in the **local** `voice_alias(folded, customer_id, hits)` table. Next time the match is exact. **No alias is stored when two or more customers share the same folded name**, because after one pick it would make later prefills between them silent. Aliases are **not** appended to `search_name`, so mishearings do not leak into synced customer records or other devices' search.
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

The confidence values below are computed with the formula in rule 9 and the caps in rules 2–5 and 10. "Agree" means every returned alternative gives the same direction (trivially true with one alternative), and any recogniser score is above the threshold.

| Transcript (alternatives) | Customer | Amount | Kind (confidence) | UI |
|---|---|---|---|---|
| ராமு 100 குடுத்தாச்சு (not yet answered) | Ramu | ₹100 | RECEIVE (0.33) | nothing preselected or suggested |
| ராமு 100 குடுத்தாச்சு (shop answered "yes") | Ramu | ₹100 | RECEIVE (capped 0.55: C1, vowel-final name) | Credit **suggested**, not selected; one tap |
| ராமு 100 குடுத்தாச்சு ("yes" + owner switched on "Preselect Credit for kuduthaachu") | Ramu | ₹100 | RECEIVE (1.0) | Credit preselected |
| Murugan 100 kuduthaachu (shop answered "yes") | Murugan | ₹100 | RECEIVE (1.0): consonant-final name | Credit |
| Ramukku 100 kuduthaachu | Ramu | ₹100 | GIVE (capped 0.55) | **nothing preselected**; Save disabled until tapped |
| spoken "Ramukku 100 kuduthaachu", **every** alternative lost "-க்கு" (`["ராமு 100 குடுத்தாச்சு"]`) | Ramu | ₹100 | RECEIVE (capped 0.55) | Credit suggested, not selected (with the switch on: preselected: the honest limit in rule 2) |
| Ramu kitta 100 kuduthaachu | Ramu | ₹100 | GIVE (capped 0.55) | nothing preselected |
| Ramu-kku 250 arisi kuduthen (also "Ramu kku …", "Ramu ku …") | Ramu | ₹250 | GIVE (1.0), note "arisi" | Debit |
| Ramu 100 kuduthaan (alternatives agree) | Ramu | ₹100 | RECEIVE (1.0) | Credit |
| `["Ramu 100 kuduthaan", "Ramu 100 kuduthen"]` | Ramu | ₹100 | conflict | nothing preselected |
| `["Ramu kitta 100 vaanginen", "Ramu kitta 100 vaanginaan"]` | Ramu | ₹100 | conflict | nothing preselected |
| முருகன் ஆயிரத்து ஐநூறு கட்டினான் | Murugan | ₹1,500 | RECEIVE (1.0) | Credit |
| `["சீதா ஆயிரத்து ஐநூறு கட்டியாச்சு", "சீதா ஐநூறு கட்டியாச்சு"]` | Sita | **empty**, chips ₹1,500 / ₹500 | RECEIVE (1.0) | keypad focused, amount chips |
| Selvi pathinanju nooru kattittaanga | Selvi | ₹1,500 | RECEIVE (1.0) | Credit |
| Sita arisi rendarai aayiram vaanginaa | Sita | ₹2,500 | GIVE (1.0), note "arisi" | Debit |
| Ramu kanakkula 250 ezhuthu | Ramu | ₹250 | GIVE (0.33) | nothing preselected |
| Ramu arisi 250 | Ramu | ₹250 | GIVE (0.33) | nothing preselected |
| Kumar gpay one fifty | Kumar | ₹150 | RECEIVE (1.0), mode UPI | Credit |
| Ramu gave 100 | Ramu | ₹100 | RECEIVE (1.0) | Credit |
| I paid Ramu 100 | Ramu | ₹100 | GIVE (1.0) | Debit |
| Ramu 100 credit / Ramu 100 debit / credit-la podu (question 2 unanswered) | Ramu | ₹100 | capped 0.55 | nothing preselected |
| Ramu 100 பற்று | Ramu | ₹100 | GIVE (1.0) | Debit |
| Ramu 100, Sita 50 kuduthaanga | Ramu, Sita | 100, 50 | Ramu RECEIVE (0.5, inherited) · Sita RECEIVE (1.0 if alternatives agree) | list card; Ramu's row not preselected |
| Ramu 100 illa 150 kuduthaan | Ramu | ₹150 | RECEIVE (1.0) | Credit |
| நேத்து செல்வி ரெண்டாயிரம் கட்டிட்டாங்க | Selvi | ₹2,000 | RECEIVE (1.0), date −1 | Credit, date chip highlighted |
| Ravi 2 kilo sakkarai 120 | Ravi | ₹120 | GIVE (0.33), note "sakkarai 2 kilo" | nothing preselected |
| Kumar 500 | Kumar | ₹500 | null | nothing preselected |
| Ramu baaki evvalavu | Ramu | — | BALANCE_QUERY | opens Ramu's page |
| (on Ramu's page) 250 kadan | Ramu (context) | ₹250 | GIVE (0.67) | Debit |
| (on Ramu's page) Sita 100 kattiyaachu | Sita (beats Ramu by ≥ 0.10) | ₹100 | RECEIVE (1.0) | "You said Sita: open Sita?" with C-code and phone last 4, never pre-filled for Ramu |
| (on Ramu-1's page; Ramu-2 also exists) Ramu 100 kattinaan | Ramu-1 (page's customer, tie with Ramu-2 within 0.10) | ₹100 | RECEIVE (1.0) | Credit on Ramu-1; **no** "open Ramu?" prompt; the banner shows C-code and phone last 4 |
| Ramu 100 paaru / Ramu 100 பாரு | Ramu | ₹100 | null ("paaru" is a filler, not பற்று) | nothing preselected |

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
- Workers AI lists it at 9,091 neurons per M input tokens and 27,273 per M output tokens ($0.10/$0.30) **[verified]**. A system prompt, the schema and six few-shot pairs in Tamil script (several tokens per word) come to roughly 1,200–2,000 input and ~150 output tokens. That is about 15–22 neurons per call (1,200 × 9,091/M + 150 × 27,273/M ≈ 15.0; 2,000 + 150 ≈ 22.3), so roughly **450–670 free calls a day** within the 10,000 free neurons **[likely: my calculation from the verified rates]**. That is still above the 300/day cap. Measure the real token count on the first prototype call.
- Cloudflare does not train on customer content **[verified]**.
- **Its Tamil quality, and whether it supports `json_schema` on Workers AI, are unverified** (the model page lists `response_format`; JSON mode is not officially listed for Gemma).
- The model ID lives in a variable, `AI_MODEL`. If the model is renamed or fails, the app falls back to parser-only, which must be fully usable.
- Bake-off candidates: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (JSON mode officially listed **[verified]**, weaker Tamil), `gpt-oss-120b`, `qwen3-30b-a3b-fp8`, and paid **`gemini-3.5-flash-lite`** ($0.30 input / $2.50 output per M tokens **[verified: Gemini pricing page]**; paid tier not used for training **[verified]**) or the cheaper `gemini-3.1-flash-lite` ($0.25 / $1.50). Gemini 2.5 models are served only to users who used them before, and Google points new projects to 3.5 Flash-Lite or 3.8 Flash **[verified: deprecations page]**, so a new client project should not plan on 2.5 Flash-Lite. Cost at about 75 calls a day (25% of 300 entries) × 30 days, with 1,200–2,000 input and 150 output tokens per call: about $1.65–2.20, **≈ ₹145–195 a month** for 3.5 Flash-Lite **[likely: my calculation]**.
- For the phase-D **speech** bake-off (Sarvam vs Google), `gemini-3.5-transcribe` is a dedicated STT model with custom-vocabulary biasing (up to 1,000 terms), but **Tamil is not in its supported-languages table as of October 2026** **[verified: model page]**, and real customer names would need the paid tier. Include it only if Tamil is added.

**Request** (never balances, the ledger or phone numbers):

```json
{"transcript":"ராமு நூறு குடுத்தாச்சு","alternatives":["ராமுக்கு நூறு குடுத்தாச்சு"],
 "candidates":[{"ref":"c1","name":"ராமு"},{"ref":"c2","name":"ராமு டீ கடை"}],
 "hints":{"numbers":[100],"cues":["kudu-3p"],"dative_in_alts":true}}
```

**System prompt:**

```
You convert a shopkeeper's spoken Tamil/Tanglish note into entries for the shop's customer ledger.
The app has two buttons: DEBIT (பற்று) = kind GIVE = the shop gave goods or money to the customer on udhaar (customer owes MORE);
CREDIT (வரவு) = kind RECEIVE = the customer paid the shop (customer owes LESS).
Spoken English "credit"/"debit" is ambiguous (shop slang "credit" often means udhaar = GIVE): use UNSURE for it unless another cue decides.
Customer as subject + kudu/kodu/kattu/settle/varavu/gpay (kuduthaan, kuduthaaru, kuduthaanga, kattinaan) = RECEIVE.
Customer as subject + vaangu/edu (vaanginaan, eduthaan, vaangittu ponaan) = GIVE. Speaker "I/we" + kudu (kuduthen, kuduthom) = GIVE;
speaker + vaangu (vaanginen) = RECEIVE. Name with -ku/-kku/-ukku (Ramukku), or "kitta" with a kudu verb = customer receives = GIVE.
English: "Ramu gave/paid" = RECEIVE; "I paid Ramu", "gave to Ramu" = GIVE; no clear subject = UNSURE.
"kanakkula ezhuthu/podu", kadan, baaki = GIVE unless a payment verb is present. "illa/no/sorry" = the next value replaces the previous one.
Amount must be a number actually spoken. Never guess an amount. If direction is not clear, use UNSURE.
customer_ref must be one of the given refs or null. evvalavu/how much = BALANCE_QUERY.
```

Six few-shot pairs follow: the dative pair, kitta + vaanginen, varavu podu, illa 150, a multi-entry sentence and a balance question. The shop's onboarding answers (2.2 rule 10) are added as one line each.

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
5. If the LLM's kind contradicts a parser cue of w ≥ 3, mark it a conflict: no preselection. UNSURE also means no preselection. All caps in 2.2 (marker, C1, C2, cross-alternative conflict) still apply; the LLM can never lift one.
6. Log both results and the final choice in `voice_log`.

### 2.7 Never automated

- **Saving any money entry.** There is no hands-free save, ever.
- Choosing between customers with similar names (on a customer page, the page itself is the shopkeeper's choice, 2.4).
- Preselecting a direction under 0.6, on a conflict, from a recipient marker, or for a C1 form on a vowel-final name (unless the owner switched it on).
- Filling in an amount that was not spoken, or picking one of two candidates, within one transcript or across alternatives.
- Inverting a cue's meaning from learned flips.
- Creating a customer.
- Reversals, corrections and WRITEOFF. Undo stays a button.
- Amounts above `confirm_above_paise`: the existing dialog still fires.

---

## 3. Accounts & authentication

**Status:** the server part is **partly built** (WIP commits `ddaa70a` and `ebed2df`): `migrations/0002_accounts.sql`, `lib/password.ts`, `lib/google.ts`, `lib/session.ts`, `lib/throttle.ts`, `routes/auth.ts`, `routes/users.ts`, the v2 block of `shared/protocol.ts`, and `api/web/_headers`. This section describes **that** design and states where the plan requires changes to it. Every change is listed once in **3.9** and has to land **before phase B ships**. The app side (login screen, cookie mode) is not built yet.

### 3.1 Why accounts, and what is the minimum

Pairing already links several phones. Accounts add two things pairing cannot do:
- **(a)** a browser login;
- **(b)** getting back in after losing every phone without the printed recovery code.

**Phase B ships only after the client confirms they will use one of these.**

The minimum secure version:
- an owner login (Google, or user id + password);
- staff the owner creates;
- sessions as device rows;
- no email, no SMS, no self sign-up.

### 3.2 Model (as built in `0002_accounts.sql`)

- **users** are people. Each belongs to the one shop through `users.shop_id` and has `users.role` = `owner` | `staff`. The server is single-shop: `/setup` creates only the first shop, and `pair_failures` is a global throttle **[verified]**. A separate `memberships` table is **deferred to v3 (multi-shop)**. Then `shop_id`/`role` move into it in a later migration.
- **devices** already exist. 0002 adds `user_id` (NULL = v1 paired device), `client` (`'android'` | `'web'`, NULL for v1 phones) and `expires_at` (web).
- **Every login creates a `devices` row**, as `/pair` does, and returns `LoginResponse`. That is `PairResponse` with `token` set to `string | null` (null for web, where the token is in the cookie), plus `user` **[verified: `shared/protocol.ts`]**. That keeps four things intact:
  - authorship through `entries.device_id`;
  - pull skipping the caller's own rows;
  - per-device code blocks;
  - revoke-with-wipe.
- **Web logins must get no code block at login** (`code_block` null). **Change needed:** `issueLogin` currently reserves a 50-code block for every login, web included. `/pair` reserves `CODE_BLOCK_SIZE` = 50 customer codes per device, and daily shared-computer logins would burn about 18k codes a year and make the visible C-codes jump. The web client calls the existing `/devices/code-block` lazily on its first `createCustomer`. A cron job purges expired web device rows (entries keep `device_id` as text, with no foreign key).
- **The sync engine needs a session mode, not a rewrite.** Today `ApiClient` throws `unpaired` with no token (`api.ts` 184–186), `engine.api()` returns null without a token (`engine.ts` 223–234), every request sets a Bearer header, and every 401 maps to revoked or unauthorized (`api.ts` 133) **[verified]**. The changes:
  - A session-mode flag. Cookie mode skips the token check, sends `credentials:'same-origin'` with no Bearer, and adds the header `X-KK-Client: web` to **every** request (the server's CSRF guard, 3.5).
  - The new 401 codes `expired`, `idle` and `wrong_transport` go to the login screen and **keep the outbox**. Only `{revoked, wipe:true}` runs the wipe path. The server today answers `unauthorized` for all three (3.9).
  - A final push before logout, and single-flight refresh for the web.
  - **Push and pull bodies are unchanged.**

### 3.3 Passwords: stretched on the client, verified with one HMAC (built)

**How it works** **[verified: `lib/password.ts`, `routes/auth.ts`, `shared/protocol.ts`]**:
1. `POST /v1/auth/prelogin {username}` → `{salt, iterations}`. Unknown, disabled and password-less users get a deterministic fake salt (`HMAC(PEPPER, 'salt:'+username)`, first 16 bytes) and the default count, with the same status, the same shape and the same work.
2. The phone or browser computes `client_key = PBKDF2-HMAC-SHA256(NFC(password), salt, iterations, 32 bytes)` with WebCrypto. The Capacitor app runs in the Android WebView, so the same code serves both.
3. `POST /v1/auth/login {username, client_key, device_name, client, …}`. The server computes `HMAC-SHA256(PEPPER, 'kk-pw-verifier-v1:' ‖ client_key)` and compares it with `users.pw_verifier` in constant time. Unknown users are compared against a dummy verifier, so the timing is the same.
4. Setting a password: the client picks a fresh random 16-byte salt and sends `{salt, iterations, client_key}`.

**Why this design.** It moves the 600,000-iteration cost to the phone, and leaves the server with one HMAC (microseconds of CPU). **Passwords therefore work on Workers Free, at ₹0.** Server-side hashing does not fit Free, as the local workerd measurements show (wrangler 4.150, Xeon 2.1 GHz; production can differ by about 2× **[likely]**):

| Scheme on the server | CPU per hash | Workers Free (10 ms) |
|---|---|---|
| PBKDF2-SHA256 100k (WebCrypto; **below** OWASP's 600k for SHA-256) | 17–24 ms | no |
| PBKDF2-SHA256 600k (local workerd only; production rejects > 100k, see below) | 90–110 ms | — |
| argon2id m=19456 KiB, t=2, p=1 (OWASP; `@noble/hashes` 2.4.0, pure JS) | 190–250 ms | no |
| scrypt N=2^17, r=8 | 520–600 ms (128 MiB memory risk) | no |
| hash-wasm argon2id | fails: it compiles WASM at runtime, which Workers block **[verified]** | — |

**PBKDF2 is capped at 100,000 iterations in Workers by design** **[verified, workerd source]**:
- `src/workerd/io/limit-enforcer.h` sets `DEFAULT_MAX_PBKDF2_ITERATIONS = 100'000`, and the source comment calls this "*WAY* below the recommended minimum".
- The check itself (`checkPbkdfLimits`, commented as an "intentional non-conformity") is in `src/workerd/api/crypto/pbkdf2.c++`.

So server-side PBKDF2 is never acceptable here. Client-side PBKDF2 has no such cap.

**Security properties**
- A leaked D1 copy **without** the `PEPPER` secret is useless for guessing, because the verifier is keyed.
- A leak of D1 **and** the pepper still costs a full 600k PBKDF2 per guess. That is OWASP's PBKDF2 storage strength.

**Trade-offs that must be handled:**
- **(a) `client_key` is password-equivalent on the wire** ("pass-the-hash"). Whoever captures it can log in until the password changes. The defences:
  - HTTPS only (Workers serve HTTPS; refuse plain-HTTP origins in the app);
  - request bodies are never logged;
  - the strict CSP (3.5), because an XSS on the login page would capture `client_key`, exactly as it would capture a password.
- **(b) Iteration floor.** `PBKDF2_MIN_ITERATIONS` is 300,000 today, so a modified client could register a cheap verifier. **Raise it to OWASP's 600,000** (3.9).
- **(c) Prelogin must not reveal users.** If a stored count differs from the 600k default, `/auth/prelogin` shows that the user exists, because unknown users always get 600k. So **pin the accepted count to the default** (`MIN = MAX = DEFAULT = 600,000` for now). When the default is raised later, the client re-stretches after its next successful login and sets the password again. The short transition leak is accepted.
- **(d) Phone speed.** Measure WebCrypto PBKDF2 at 600k on the client's Redmi WebView and in desktop Chrome in week 5 (estimate: 0.5–1.5 s on the phone (unverified)). Show "சரிபார்க்கிறது… / checking…" while it runs. **Never lower the count below 600k** to make it faster.
- **(e) The server never sees the password**, so the password policy is checked **on the client**: at least 10 characters, a bundled blocklist of the ~1,000 most common passwords, and no forced complexity. Passwords the owner issues are temporary. `must_change_pw` is not in 0002, so it is added in 0003 (3.7).

**Rejected alternative:** argon2id on the server, which needs Workers Paid (₹440/month) and a semaphore for its 19 MiB per hash. It is kept only as a fallback if a future audit rejects client-side stretching. In that case the WIP `password.ts` / prelogin code must be replaced, not extended.

**Login id:** `USERNAME_RE` = `[a-z0-9._-]{3,32}` **[verified]**, so a 10-digit **mobile number** typed on the number pad works. The owner issues staff credentials, and the login screens are Tamil first. Staff who cannot type Latin letters at all use Google sign-in, or a pair code / QR shown on the owner's phone (the existing pairing, kept for this). **The owner's own login id should not be the shop's public mobile number**: anyone can type a public number, and the backoff in 3.6 then has more to absorb.

### 3.4 Google Sign-In (works on the Free plan; about 0.1–0.3 ms CPU with a cached key [likely])

- **Android:** `@capgo/capacitor-social-login` 8.x, which uses Credential Manager. 8.7.0 came out 2026-10-17. Pin the newest release at least 2 weeks old (today 8.5.12 of 2026-09-30 **[verified: npm]**), after confirming it has the Google `scopes` option and the Android `accessToken`. Use the **web** client ID as the server client ID, plus a server nonce **[verified]**. Avoid `@codetrix-studio/capacitor-google-auth`: it peers on Capacitor 6 and is abandoned **[verified]**.
- **Web:** a Google Identity Services button with FedCM, using the JS callback. The ID token is POSTed to the same origin.
- **Worker (built, `lib/google.ts`):** RS256 is verified **by hand with WebCrypto** against Google's JWKS (no `jose` dependency). It checks **[verified: code]**:
  - the signature;
  - `aud` ∈ `GOOGLE_CLIENT_IDS`;
  - `iss` ∈ {`accounts.google.com`, `https://accounts.google.com`};
  - `exp` and `iat` (5-minute skew);
  - `email_verified`.
- **Still to add (3.9):**
  - **Nonce.** `POST /auth/nonce` returns a stateless `HMAC(NONCE_SECRET, random‖expiry)` with a 5-minute expiry, and nothing is written. The token's `nonce` claim must equal it. The nonce goes into `used_nonces` only after the token verifies, and a nonce already there is refused. Without this, an ID token that leaks within its ~1 h life can be replayed.
  - **`azp` bound to the client kind.** Credential Manager tokens carry `aud` = the web client ID and `azp` = the **Android** client ID; GIS tokens carry the web client ID in both **[likely]**. `client:'android'` is accepted only with an Android `azp`, and `client:'web'` only with the web `azp`. So a token captured on the web page cannot mint a non-expiring Bearer token.
- **Linking. Decision: owner pre-registers the email (as built), hardened.** The owner types the person's Gmail address in Settings → Users. The first Google sign-in whose verified `email` matches binds `google_sub`, and after that matching is by `sub` only **[verified: `routes/auth.ts`]**. There is no auto sign-up. Hardening (3.9):
  - **Only `@gmail.com` / `@googlemail.com` addresses** (or one configured Workspace `hd`). Google does not recycle Gmail addresses for other people **[likely]**. A Google account can, however, be created on any non-Gmail address (Yahoo, Rediffmail, a mistyped domain) by whoever controls that mailbox, and that person would then claim the login.
  - **An unlinked `google_email` expires after 48 h** (`google_email_set_at`). The owner re-enters it if the person did not sign in in time.
  - The nonce is required (above).
  - **Setting or changing `google_email` needs step-up** (3.5) and writes an `auth_events` row that owner devices show.
  - Invite-code / QR linking by `sub` stays a v3 option if the hardening proves insufficient.
- **Google Cloud setup ($0, in the shop's Google account):**
  - a consent screen with `openid email profile` (plus `drive.file` in phase C);
  - a web client ID;
  - Android client IDs for the debug, upload **and Play App Signing** SHA-1s; their IDs go into the `azp` allow-list.
  - **Publishing "In production" (phase-B task, needed before phase C).** An app that uses only non-sensitive scopes (`openid email profile drive.file`) should need **no app verification** to publish **[likely: Google OAuth verification docs]**. **Brand verification is optional**: "Without verification, only your application domain will be visible to users" **[verified: Google Cloud help 15549049]**. The Worker serves `/privacy`, `/terms` and a homepage for the consent-screen links. **Week-6 spike:** publish on the `*.workers.dev` hostname. A custom domain is optional (it shows a nicer name and logo) and is bought only if the spike shows that `workers.dev` cannot be used as an authorized domain. Until publishing works, the share-sheet backup stays the backup path.

### 3.5 Sessions = device rows

**Tokens:** opaque, stored as `sha256(token‖PEPPER)` as today, not JWTs **[verified]**. Every request already does one D1 round trip for the daily cap and `last_seen`, so a JWT saves nothing and delays revocation.

| Client | Absolute expiry | Idle timeout | Rotation |
|---|---|---|---|
| Android (`client='android'`, and v1 phones) | none (as today) | 90 days (3.9) | **none**: a 256-bit token in the Keystore, with idle expiry and remote revoke |
| Web, "my computer" | 30 days (**built**) | 7 days (3.9) | every 24 h, with a grace window (3.9) |
| Web, "shared computer" (always for staff, when staff web arrives) | 12 h (3.9) | 30 min of **user activity** (3.9) | none (the session ends first) |

**No rotation for app tokens.** RFC 9700's rotation with reuse detection (§2.2.2, §4.14.2 **[verified]**) targets OAuth refresh tokens, not this design. On Android it would do harm. Push and pull requests overlap, and MIUI can kill the app between the server rotating and `secretSet(TOKEN_KEY)` running (`engine.ts` line 604). The new token would then be lost, and the next use of the old one would revoke the shop's ledger-of-record phone.

**Web rotation with a grace window (to do):**
- The new hash goes in `token_hash`; the old one moves to `prev_token_hash` with `rotated_at`.
- The old token is accepted **any number of times** for 120 s, because the sync engine's push and pull, a refresh still in flight and two tabs refreshing at once all present it more than once.
- Refresh is single-flight across tabs (`navigator.locks`, or `BroadcastChannel` where locks are missing).
- Only a use of the old token **after** the grace window counts as theft. It revokes the device and writes an `auth_events` row.
- `auth.ts` lookup: `WHERE token_hash = ?1 OR (prev_token_hash = ?1 AND rotated_at > now − 120 s)`.

**Idle = user activity, not polling (to do).** Every authenticated request bumps `last_seen_at` (`auth.ts` UPDATE), so background sync would keep an abandoned shared-PC session alive until the 12 h expiry. A new `last_active_at` is updated only by writes and by requests carrying an `X-User-Activity: 1` header, which the UI sets on user-initiated actions; background sync never extends it. The web client also runs its own idle timer that logs out (after the final push) and wipes.

**Transport binding (built).** App and v1 tokens are accepted only as `Authorization: Bearer`, and web tokens only from the cookie. The lookup puts the transport in its `WHERE` clause, so a mismatch is simply `401 unauthorized` **[verified: `lib/auth.ts`]**. To do: look up by hash first, answer `401 wrong_transport` with an `auth_events` row, and **revoke a web device whose cookie token arrives as a Bearer token**, because an HttpOnly cookie should never be readable by script.

**Cookie.** Decision: `__Host-kk_session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`. **Change needed:** the code sets `kk_session` with `Path=/v1` and no prefix. A `__Host-` cookie must have `Path=/`. Because the cookie is HttpOnly, the static assets never read it; `Path=/` only means it is also sent with asset requests. The unprefixed `/v1` cookie is acceptable **only on `workers.dev`**, where the Public Suffix List stops sibling subdomains from setting it. On a custom domain, a sibling subdomain could plant a domain-wide `kk_session` (session fixation), so the rename must land before any custom domain.

**CSRF (built).** Every cookie-authenticated request, of any method, must carry `X-KK-Client: web`, or it gets `403 csrf` **[verified: `lib/auth.ts`]**. This works for three reasons:
- a cross-site page cannot add a custom header without a CORS preflight;
- this Worker never grants credentialed CORS (`Access-Control-Allow-Credentials` is never sent);
- `SameSite=Strict` is a first layer.

Hono's `csrf()` (4.13.13) would not be enough on its own: it checks Origin and `Sec-Fetch-Site` only for form-type, `text/plain` or missing content types **[verified: hono source]**.

**The client kind is not a security boundary.** `client` is whatever the login body says. Anyone holding the credentials can call `/auth/login` with `client:'android'` and receive a non-expiring Bearer token in JSON, bypassing every web-only defence. So can an XSS that captured a `client_key` or a GIS `id_token`. Therefore:
- **Owner-power routes are gated by step-up, not by kind** (below). Refusing `client='web'` there is defence in depth and keeps the web UI simple.
- Google logins with `client:'android'` need an Android `azp` (3.4).
- Every new **owner-role** device, from pairing or login, writes an `auth_events` row and shows an alert on the other owner devices ("New owner login: Redmi 12, 18 Oct 14:02"), with a one-tap revoke.
- Open question for the client (section 10, Q3): should a new owner-role Android login also need approval from an existing owner device, or a printed recovery code, before it may sync? It is safer, but it slows down the "lost every phone" recovery that accounts exist for. The default is alert + step-up only.

**Step-up.** A device proves the person is present again by sending one of the following:
- the **current password**, freshly stretched (`step_up.client_key`);
- for Google-only users, a **fresh Google ID token** with a server nonce and `auth_time` within 5 minutes;
- a printed **recovery code** (consumed; the app then offers to print a new sheet);
- **approval from another owner device**.

A successful step-up sets `devices.step_up_at`, which is valid for 5 minutes. Step-up is **required** on:
- `POST /users` (create a user, including the owner's own "Create login");
- `PUT /users/:id` (role, `google_email`, disable/enable);
- `PUT /users/:id/password` for **another** user;
- `POST /devices/pair-code`;
- `POST /devices/recovery-codes`;
- `POST /devices/:id/revoke` when the target is an **owner** device. Revoking a staff device stays one tap, because it is the emergency action.

**Today these routes are guarded only by `ownerOnly`** **[verified: `routes/users.ts`, `routes/devices.ts`]**. So a phone stolen for a few minutes, an owner web session left open on a shared PC, or an XSS could create an owner login that the attacker controls. That login would survive revoking the phone. This must be fixed before the users routes ship (3.9).

**What a web session may not do (v2).**
- `client='web'` sessions are refused (`403 web_session`) on: `POST /users`; `PUT /users/:id`; another user's password; `/devices/pair-code`; `/devices/recovery-codes`; and revoking owner devices.
- Owner web sessions may still view users, devices and `auth_events`.
- Staff web logins are refused outright (`403 web_owner_only`, section 4).

**CSP.** Copied from the committed `khata/api/web/_headers` **[verified]**. `'wasm-unsafe-eval'` is required because the web ledger runs on sql.js (WebAssembly). The Google entries are the full GIS set:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client;
style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; connect-src 'self' https://accounts.google.com;
frame-src https://accounts.google.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

Later hardening: narrow `connect-src`/`frame-src` to `https://accounts.google.com/gsi/`, as Google's GIS CSP guide gives them, and drop `'unsafe-inline'` from `style-src` once the UI stops using inline styles.

**Storage:**
- Android: the existing Keystore storage (`@aparajita/capacitor-secure-storage` 8.0.1).
- Web: the cookie only, never localStorage. `platform/web.ts` `secretSet` must not hold the session.

### 3.6 Throttling, reset, recovery

**Throttling, as built** **[verified: `routes/auth.ts`, `lib/throttle.ts`, `wrangler.jsonc`]**:
- `AUTH_LIMITER`: a Workers Rate Limiting binding, 20 per 60 s per IP **per route**, on `/auth/prelogin`, `/auth/login` and `/auth/google`. It is best effort, per location **[verified]**.
- Per-username backoff: after 5 failures, a 30 s wait that doubles up to 15 min, reset on success. It is stored in `users.failed_count`/`locked_until`, and in `login_throttle(username)` for unknown usernames, so a lockout looks the same for both. There is no permanent lockout.
- A shop-wide budget, `auth_failures`: `AUTH_THROTTLE_AFTER` = 100 failures per UTC day, then one attempt per 30 s for everyone. One attempt is **reserved before any verification**.
- Unknown user and wrong password get the same `invalid_login`, with the same verifier work.

**The problem with that.** The backoff is keyed on the **username alone**, and the shop-wide budget is charged to everyone. Anyone who knows the owner's username can keep the owner out of password login with one bad attempt every ≤ 15 minutes, and the owner's username may well be the shop's public mobile number. Alternatively, 100 junk failures stop **all** password logins until 05:30 IST. Web sessions expire every 30 days, so the owner will need password login.

**Decision (3.9):**
- **Key the backoff on (username, network).** The network is IPv4 /24, IPv6 /48, or `request.cf.asn` when present. It is stored in a new `login_backoff(username, net)` table. One attacker's failures then lock only the attacker's network.
- **Known-device exemption** (OWASP's device-cookie pattern). After a successful login the server issues a signed known-device value, `HMAC(PEPPER, 'kd:'‖user_id‖issued_at)`, valid for 1 year and only while the user is enabled. The web keeps it in an HttpOnly `__Host-kk_kd` cookie; the app keeps it in the Keystore and sends `known_device`. A request carrying a valid value for that username skips both the per-network backoff and the shop-wide budget.
- **Charge the shop-wide budget only to failing requests from unknown sources.** Do not reserve it in advance for known devices. Ghost rows for unknown usernames are written only after the budget accepts the attempt, so D1 writes from strangers stay bounded (about 100 + 2,880 a day), well inside the Free plan's 100k.
- **Advise** that the owner's login id not be the public shop number (3.3).
- Test: an attacker's failures from one network do not block the owner's known device or a login from another network.

**Reset without email:**
- **Staff:** the owner sets a temporary password (with step-up). `must_change_pw=1` is added in 0003. All of that user's devices are revoked in the same batch **[verified: built]**.
- **Owner who forgot the password but is still signed in on a phone.** The app PIN is optional (Settings has Set PIN / Remove PIN), and it is **checked only on the phone**. The server cannot tell whether a PIN check happened, so the PIN is a **UI guard, not server step-up**. Therefore:
  - the app **requires a PIN to be set** before "Create login" and before any password change started from the phone;
  - **when the current password is unknown, the server requires a printed recovery code or approval from another owner device**; an unlocked phone plus PIN is never enough;
  - every password change writes `auth_events` and alerts the other owner devices.
- **Owner signed out everywhere:** `POST /auth/recover {recovery_code, username, salt, iterations, client_key}` (to do) uses a printed recovery code, which is consumed. A linked Google account also works.
- **Owner lost the phones, the printed codes and has no linked Google (break-glass).**
  - The developer verifies the owner's identity offline (in person or on a video call, with shop documents).
  - The developer then runs a documented `wrangler d1 execute` script that inserts a hashed, 24 h, single-use setup/recovery code and writes an `auth_events` row (`type='break_glass'`).
  - The data is still in D1, so nothing is lost. The script lives in `khata/api/scripts/` and is described in the API README.
- **Email reset is v3.** Cloudflare Email Sending is beta **[verified]**, Resend's free tier needs a domain, and staff often have no email.

### 3.7 Endpoints (`/v1`) and migration from pairing

Status: **done** = in the WIP code; **change** = built but needs a 3.9 change; **to do** = not built.

| Method & path | Auth | Purpose | Status |
|---|---|---|---|
| GET `/config` | none | `{google_client_id, auth:{password:true}, version, server_time}` for the login screen | done |
| POST `/auth/prelogin` | none + limiter | `{username}` → `{salt, iterations}`; fake salt for unknown users | change: pin iterations to the default |
| POST `/auth/login` | none + limiter | `{username, client_key, device_name, client, max_local_code?, previous_device_id?}` → `LoginResponse` (web: token in Set-Cookie) | change: network-keyed backoff + known device; staff web → `403 web_owner_only`; web `code_block` null; takeover by proof (`previous_device_token`); owner-device alert |
| POST `/auth/google` | none + limiter | `{id_token, …}` → `LoginResponse`; links a pre-registered `google_email` on first sign-in | change: nonce, `azp` vs client, Gmail-only, 48 h expiry of unlinked emails, staff web refusal, same takeover rule |
| POST `/auth/nonce` | none + limiter | stateless `{nonce}`; nothing written until a token verifies | to do |
| POST `/auth/recover` | recovery code + limiter | owner sets a new password → `LoginResponse` | to do |
| POST `/auth/refresh` | web session | rotation (web only; app tokens do not rotate) | to do |
| POST `/auth/logout` | session | revokes this device and deletes its unused pair codes, and clears the cookie. **The client** blocks logout while its outbox is non-empty and pushes first; the server cannot see the outbox, so it simply revokes | done (to do: `Clear-Site-Data: "cache","storage"` for web) |
| GET `/me` | session | includes `user` | done |
| GET `/users` | owner | list users | done |
| POST `/users` | owner | create a user (password material and/or `google_email`). `link_me:true` attaches the calling v1 owner phone: the "Create login" path | change: step-up, refuse web, `auth_events`, Gmail-only |
| PUT `/users/:id` | owner | display name, role, `google_email` (a change unlinks the old account), disable (revokes that user's devices); last-owner guard | change: step-up, refuse web, `auth_events` |
| PUT `/users/:id/password` | self (with `current_client_key`) or owner | set a password; revokes the user's other devices | change: step-up for another user; recovery code / other-owner approval when the current password is unknown; `must_change_pw`; `auth_events` |
| GET `/auth-events` | owner | credential events for Settings → Users | to do |
| GET `/devices`, POST `/devices/:id/revoke` | owner | existing; also lists web sessions with the user's name. **Revoking a device that has a `user_id` offers "also disable this login / unlink Google"**, on by default when the reason is "lost phone". It also lists users that this device created and offers to disable them | change |
| POST `/voice/interpret`, POST `/stt` | session | phase D only | to do |
| `/pair`, `/devices/pair-code`, `/devices/recovery-codes`, `/sync/*`, `/export` | existing | unchanged, except that pair-code and recovery-codes need step-up and refuse `client='web'` | change |

**New credentials are visible.** Every user creation, password set, `google_email` change, Google link, new owner device, recovery and break-glass writes `auth_events`. Owner devices show them in Settings → Users ("Kumar linked a Google account on Redmi 12, 18 Oct 14:02").

**Migration from pairing (no re-pairing):**
1. Existing devices keep `user_id NULL` and keep working **[verified: built]**.
2. On the owner phone: Settings → **Create login**. This requires an app PIN to be set, then calls `POST /users {role:'owner', link_me:true, …}` with the existing bearer token **plus a printed recovery code** (step-up; to do). It creates the owner user and sets `devices.user_id`.
3. The owner creates staff users, and each staff phone logs in. **Revoking the old row on login needs proof, not an id.** Device ids are visible to every phone through pulled `entries.device_id`. Today, logins reuse the `/pair` predicate with a bare `previous_device_id` (`lib/session.ts` `newDeviceTail`). That revokes any same-or-lower-role device of the shop and moves its unused pair **and recovery** codes to the new row. So today a staff login can revoke a colleague's phone, and an owner-role login, even a web one, can revoke the ledger-of-record owner phone and take over its printed recovery codes. If the owner later revoked that "forgotten browser", the revoke would delete those codes. **Change (3.9):** for logins, revoke the previous device only when
   - (a) its `devices.user_id` equals the logging-in user, or
   - (b) it is a legacy row (`user_id NULL`) and the request carries `previous_device_token`, whose `pepperHash` matches that row's `token_hash`.

   In addition, **recovery-kind codes are never moved onto a `client='web'` device**. `/pair` keeps its current predicate.
4. Later, a shop setting `pairing_enabled=0` can switch off 8-digit codes. Recovery codes stay.

**D1 schema.** `api/migrations/0002_accounts.sql` is **committed and must not be edited**: D1 applies migrations by file name, so an edited 0002 never re-runs where it was already applied. It created:
- `users`: `shop_id`, `username`, `display_name`, `role`, `pw_salt`/`pw_iterations`/`pw_verifier`, `google_email`/`google_sub`, `failed_count`/`locked_until`, `disabled_at`;
- on `devices`: `user_id`, `client` CHECK (`android`|`web`), `expires_at`;
- `login_throttle(username)`;
- `auth_failures(day)`.

The changes go in a new **`0003_accounts_hardening.sql`**:

```sql
-- 0003: deltas against the committed 0002 (never edit 0002)
ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN google_email_set_at TEXT;           -- an unlinked google_email expires after 48 h
ALTER TABLE devices ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;  -- web "shared computer"; set by the server for staff
ALTER TABLE devices ADD COLUMN idle_timeout_min INTEGER;
ALTER TABLE devices ADD COLUMN prev_token_hash TEXT;
ALTER TABLE devices ADD COLUMN rotated_at TEXT;
ALTER TABLE devices ADD COLUMN last_active_at TEXT;               -- user activity only (3.5)
ALTER TABLE devices ADD COLUMN step_up_at TEXT;                   -- step-up valid for 5 minutes
CREATE UNIQUE INDEX devices_prev_token ON devices(prev_token_hash) WHERE prev_token_hash IS NOT NULL;
-- Backoff keyed on (username, network); replaces users.failed_count/locked_until and login_throttle(username),
-- which stay in place unused and are dropped in a later migration.
CREATE TABLE login_backoff (username TEXT NOT NULL, net TEXT NOT NULL, failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (username, net));
CREATE TABLE used_nonces (nonce_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);  -- written only after a verified Google token
CREATE TABLE auth_events (id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, actor_device_id TEXT, target_user_id TEXT,
  type TEXT NOT NULL, at TEXT NOT NULL);  -- user_create, role_change, google_email_set, google_link, password_set,
                                          -- owner_device_new, recover, step_up_fail, refresh_reuse, wrong_transport,
                                          -- revoke, break_glass
CREATE INDEX auth_events_shop_at ON auth_events(shop_id, at);
CREATE TABLE voice_usage (shop_id TEXT NOT NULL, day TEXT NOT NULL, stt_ms INTEGER NOT NULL DEFAULT 0,
  llm_calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (shop_id, day));  -- phase D
```

The known-device value (3.6) is stateless, so it needs no table.

**`shared/protocol.ts`.** These are already there **[verified]**:
- `PBKDF2_*` constants, `PW_SALT_BYTES`, `CLIENT_KEY_BYTES`, `USERNAME_RE`;
- `SESSION_COOKIE`, `WEB_CLIENT_HEADER`, `WEB_SESSION_DAYS`, `ClientKind`;
- `UserSummary`, `UserInfo`, `ConfigResponse`, `PreloginRequest`/`PreloginResponse`;
- `LoginExtras` (`client`, `previous_device_id`), `LoginRequest`, `LoginResponse` (`token: string | null`, `user`), `GoogleLoginRequest`;
- `UsersResponse`, `PasswordSet`, `CreateUserRequest` (`link_me`), `UpdateUserRequest`, `SetPasswordRequest`, `UserResponse`;
- `MeResponse.user`, `DeviceInfo.client`, `ApiError.retry_after`.

Still to change or add:
- `PBKDF2_MIN_ITERATIONS = PBKDF2_MAX_ITERATIONS = 600_000`;
- `SESSION_COOKIE = '__Host-kk_session'`;
- `LoginExtras.previous_device_token` and `known_device`; `GoogleLoginRequest.nonce`; `NonceResponse`; a `step_up` field on owner-power requests;
- `LoginResponse.code_block` nullable (null for web);
- `DeviceInfo.user_name` and `shared`; `AuthEvent`/`AuthEventsResponse`;
- `ShopInfo.voice_meanings` / `ShopUpdateRequest.voice_meanings` (2.2 rule 10);
- the 401 codes `expired`, `idle` and `wrong_transport`, and the 403 codes `web_owner_only`, `web_session` and `step_up_required`;
- (phase D) `VoiceInterpretRequest/Response`.

**Sync push and pull bodies are unchanged.**

### 3.8 The ₹0 path, and why Paid is still recommended

**Passwords, Google sign-in and pairing all run on Workers Free.** Password login costs one HMAC; Google verification costs about 0.1–0.3 ms with a cached key (`lib/google.ts` comment, **[likely]**); both stay far below the 10 ms CPU limit. **Measure on a deployed Free Worker before promising ₹0.** Workers Paid ($5 ≈ ₹440/month) is still **recommended** at go-live, because it removes the Free plan's daily caps (100k requests/day; D1 100k row writes/day **[verified]**). A script that hits those caps stops device auth and sync for the whole shop until 00:00 UTC.

**Firebase Authentication is no longer needed for passwords.** It stays a documented alternative, if the client ever wants Google to hold the password database. In that case:
- Use a Spark project owned by the shop's Gmail. It is free: 100 sign-ups per IP per hour and 150 reset emails a day on Spark **[verified]**. The 3,000 DAU limit is stated for "Firebase Authentication with Identity Platform" **[verified]**. No idle pause is documented **[likely]**.
- `POST /v1/auth/firebase {id_token, nonce, device_name, client, …}` returns a `LoginResponse`. The Worker verifies RS256 against `securetoken@system.gserviceaccount.com`'s JWKS, with `aud` = project ID, `iss` = `https://securetoken.google.com/<projectId>` and `sub` non-empty **[verified]**.
- Hardening: `auth_time`/`iat` within 5 minutes; a single-use exchange (store `sha256(id_token)` until it expires); no service-account admin key in the Worker; every member removal revokes that member's D1 devices with `wipe`.
- Cost: a second vendor and console, plus `@capacitor-firebase/authentication` 8.5.2 with `firebase@12` pinned (its peer is `^12.6`, while npm latest is 13.0.0 **[verified]**).

### 3.9 Changes the WIP accounts code needs before phase B ships

The plan and the code must agree before anyone uses accounts. Each item has an API test in section 8.

1. **Iterations:** `PBKDF2_MIN_ITERATIONS` 300k → 600k, pinned to the default; prelogin always returns 600k (3.3 b, c).
2. **Backoff** keyed on (username, network), the known-device exemption, and the shop-wide budget charged only to failing unknown sources (3.6).
3. **Device takeover by proof:** `previous_device_token` or the same `user_id`; never move recovery codes onto web devices (3.7, step 3).
4. **Step-up + `auth_events`** on user create, role, `google_email`, another user's password, pair-code, recovery-codes and owner-device revoke; refuse `client='web'` there; alert owner devices about new owner-role devices (3.5).
5. **Google:** nonce + `used_nonces`, `azp` bound to the client kind, Gmail-only (or a configured `hd`), 48 h expiry of unlinked `google_email` (3.4).
6. **Staff web refused** (`403 web_owner_only`), with the Tamil-first message (section 4).
7. **Web login gets no code block** (3.2).
8. **Cookie** renamed to `__Host-kk_session` with `Path=/` (3.5).
9. **Sessions:** idle timeouts, `last_active_at`, web rotation with grace, the `expired`/`idle`/`wrong_transport` codes (3.5).
10. **Password reset when the current password is unknown:** a recovery code or approval from another owner device; `must_change_pw`; `/auth/recover` (3.6).
11. Migration **`0003_accounts_hardening.sql`** and the protocol additions above (3.7).

---

## 4. Cross-platform web app

**Hosting:** the same Worker serves the Vite build as static assets. Static asset requests are free and unlimited **[verified]**.

```jsonc
"assets": { "directory": "../app/dist-web", "not_found_handling": "single-page-application", "run_worker_first": ["/v1/*"] }
```

- `run_worker_first` needs wrangler 4.20+; the repo has 4.150.
- One origin means no CORS for the web app and a first-party cookie.
- `workers.dev` is on the Public Suffix List, so the cookie is not shared with other tenants' Workers **[verified]**.
- A custom domain (about $10/year, unverified) is **optional**. Brand verification only adds the app name and logo to the consent screen, and the week-6 spike tests publishing on `workers.dev` (3.4). If a custom domain is added, the `__Host-` cookie rename (3.5) must land first.

**Reuse:** every screen, `core/*`, `data/repo.ts` and the sync engine already run in the browser preview on `db/sqljs.ts` (sql.js + IndexedDB) **[verified]**. The web build adds:
- a login screen;
- cookie-mode API calls (`credentials:'same-origin'`, no Bearer);
- Web Speech for the mic (Chrome tested; Edge/Safari only after a Tamil smoke test);
- GIS for Google sign-in;
- browser downloads for exports.

**PWA:** `vite-plugin-pwa` 2.0.0 (supports Vite 8 **[verified]**).
- Precache the app shell only.
- Call `navigator.storage.persist()`.
- Offline entries queue in the existing outbox and push through the same idempotent sync.
- The phone stays the ledger of record, because browser storage can be evicted.

**Shared computer:** at login she chooses "This is my computer" or "Shared computer". Shared mode means:
- sql.js runs **in memory only**;
- the 12 h / 30 min (user activity) session;
- no CSV export;
- **no other local copies**: today `main.ts` (lines 134 and 161) calls `snapshotIfDue()`, which writes full-ledger snapshots through `web.ts` `writePrivateFile` into localStorage, and `engine.ts` `handleRevoked` saves "unsynced-before-wipe" rows the same way **[verified]**. In shared mode the web platform gets a memory-only `writePrivateFile`/`readPrivateFile`, and `snapshotIfDue` and backup copies are disabled.

**Never lose unsynced entries on the web:** every web write is pushed immediately; a `beforeunload` warning appears while the outbox is not empty; and the **client** blocks logout while it is not empty (the server cannot see the outbox; `/auth/logout` simply revokes) ("3 entries not synced: stay online"), because in shared mode closing the tab before the push loses money.

On logout (after the final push succeeds):
- the device is revoked and the server sends `Clear-Site-Data`;
- the client also deletes IndexedDB, Cache Storage and any private files;
- the owner can revoke a forgotten browser from the phone, and the existing `{revoked, wipe:true}` 401 wipes it on its next request.

**v2 web is owner-only, and the server enforces it.** In v2, `/auth/login` and `/auth/google` with `client:'web'` for a user whose role is `staff` return `403 web_owner_only` before any device row is created. The login screen then shows "இணைய உள்நுழைவு உரிமையாளருக்கு மட்டும் — கைபேசி செயலியைப் பயன்படுத்தவும்" (web login is for the owner only; use the phone app), with no ledger download. An API test covers it (section 8). Without this rule, a staff member who opens the web URL at home would get a full-ledger IndexedDB copy on a home PC.

Staff web logins come later, which keeps the attack surface small. When they come, **the server** sets `devices.shared=1` (shared-computer, memory-only mode) for staff web sessions instead of trusting the client's choice, or serves a staff-scoped pull. Either way, a staff member's home PC never stores the whole ledger (names, phone numbers, balances) in IndexedDB.

| Feature | Android | Web |
|---|---|---|
| Ledger of record | yes | no: a synced client |
| Speech | native Google recogniser | Web Speech: Chrome tested; Edge/Safari after a Tamil smoke test |
| Secret storage | Keystore | HttpOnly cookie |
| Local data | permanent | evictable; in memory in shared mode |
| Lock | existing app PIN | short idle timeout (user activity) |
| Owner-only actions (pair codes, recovery codes, users, revoke) | yes, with step-up (3.5) | refused for web sessions (3.5) |
| Staff login | yes | refused in v2 (`403 web_owner_only`) |
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
     2. encrypt it with AES-GCM, using a key derived on the phone from an owner backup passphrase (PBKDF2 600k; the phone has no CPU limit). The passphrase is asked **once**; the derived key is then kept in the Android Keystore (the existing secure storage), so the daily backup runs without asking again;
     3. upload `kadan-YYYY-MM-DD.kkbak` to the visible folder "Kadan Kanakku Backups".
   - **The readable copy is the monthly CSV statement**; the encrypted `.kkbak` is for restoring through the app. Because the folder is in the owner's own account, the owner may choose **unencrypted** backups instead (no passphrase to lose); encrypted is the default.
   - **Rotation:** 30 dailies plus 12 monthlies, so customers erased under DPDP **age out of old backups within 12 months**. To shorten that, an erasure can re-encrypt and prune the monthlies.
   - **No Google refresh token is ever stored on the server.** Refresh tokens expire after 7 days while the consent screen is in "Testing" **[verified]**, so publish the consent screen "In production". With only non-sensitive scopes, that should need no app verification, only the privacy-policy, terms and homepage pages; brand verification is optional (3.4) **[likely; tested in the week-6 spike]**.
   - **Restore:** Settings → Restore from Drive: list, decrypt, import through `ui/backup.ts`.
   - **Open technical point (partly answered):** Credential Manager returns only an ID token, but the Capgo social-login README documents a Google `scopes` option and an Android `accessToken` obtained through `AuthorizationClient`, which "may be null on Android when Credential Manager authentication succeeds but AuthorizationClient does not return an access token" **[verified: README]**. **Week-6 spike:** confirm the pinned `@capgo/capacitor-social-login` returns a `drive.file` access token on the client's Redmi phones. Until it works, the share-sheet path is the guaranteed one.
3. **Ownership:** the shop's Gmail (2-step verification on, recovery phone = owner) owns the Google Cloud project and OAuth client, the Drive folder, the Cloudflare account and its billing. The developer is added as a member.

**Live data in Google (Firestore): not now.**
- It would be a 4–6 week rewrite of `app/src/sync/*` and all of `khata/api` **[likely]**.
- Transactions fail offline **[verified]**, so server-side customer-code allocation and the reversal-race checks would be lost.
- Cloud Functions need Blaze **[verified]**.
- One full-history login can use up 50k reads/day **[verified quota]**.
- Its one real advantage is India regions: `asia-south1` (Mumbai) and `asia-south2` (Delhi) **[verified: Firestore locations]**. DPDP has no localisation mandate **[likely; confirm with counsel]**, so that advantage matters only if India residency becomes a requirement. Offer it as v3.

**Supabase pause analysis:**
- "Free projects are paused after 1 week of inactivity" **[verified]**. Inactive means insufficient activity; the page says dashboard visits or API calls can count.
- A shop that syncs daily usually stays active. A festival or family closure pauses it, and then **auth and sync stop on every device** until someone restores it from the dashboard; a paused project can be restored for up to 1 year **[verified]** (the page's heading still says 90 days; the body says 1 year).
- A scheduled ping (an external cron calling the API) is therefore close to sanctioned, but the free plan would still have no backups, and a money ledger should not depend on a keep-alive job.
- No free backups: daily backups are for Pro/Team/Enterprise only **[verified: supabase.com/docs/guides/platform/backups]**. Pro is $25/month.

**Cost table ($1 ≈ ₹88)**

| Item | Free path | Recommended | Source |
|---|---|---|---|
| Android/Chrome speech-to-text | ₹0 | ₹0 | — |
| Parser | ₹0 (on phone) | ₹0 | — |
| Workers + D1 + web hosting | $0 (Free: 10 ms CPU, 100k req/day) | **$5 ≈ ₹440/month** (Paid: 10M req, 30M CPU-ms, no daily caps) | Workers pricing |
| Password login (client-side stretching, 3.3) | ₹0 (one HMAC per login, runs on Free) | ₹0 | `api/src/lib/password.ts` |
| Google Sign-In, OAuth project | ₹0 | ₹0 | — |
| Drive backup (owner's 15 GB, shared with Gmail) | ₹0 | ₹0 | — |
| R2 nightly export | ₹0 (< 10 GB) | ₹0 | R2 pricing (likely) |
| Sarvam STT (phase D, if needed) | ₹100 signup credits **[verified: docs pricing page]** (the website has said ₹1,000) | ₹30/hour billed per second = ₹0.50/min **[verified: Speech-to-Text rate; applies to `saaras:v4` per the docs' default model, confirm in console]** ≈ ₹50–300/month as primary; ₹5–30 as fallback | Sarvam pricing |
| LLM (phase D, if needed) | Workers AI 10k neurons/day ≈ 450–670 calls at 15–22 neurons each (cap 300) **[likely]** | ₹0, or paid `gemini-3.5-flash-lite` ≈ ₹145–195/month **[verified prices, likely total]** | Workers AI / Gemini pricing |
| Google Cloud STT (alternative) | 60 free min/month, **V1 API only** **[verified]** | V2 about $0.016/min **[likely]** ≈ $9–10/month at 300/day; Tamil `chirp_2`/`chirp_3` only in some locations (`asia-southeast1`, `eu`, `europe-west4`) **[likely: languages page]** | GCP free features / STT languages |
| Custom domain (optional, branding only; 3.4) | not needed | optional, ≈ $10/year ≈ ₹70/month (unverified) | — |
| **Total** | **₹0** (passwords + Google login + pairing on Workers Free; daily caps apply) | **≈ ₹440/month**, + ₹0–300 only if Sarvam is needed, + ≈ ₹70/month if a custom domain is wanted | |
| Supabase Pro (rejected) | pauses | $25 ≈ ₹2,200/month | Supabase pricing |

---

## 6. Changes to the existing codebase

**`khata/app`**

| File | Change |
|---|---|
| `src/core/voice.ts` (**started**: 1,369 lines, uncommitted; reconcile it with the 2.2–2.4 rules in week 1, especially rule 3, under which **any** cross-alternative disagreement is a conflict) | `normalize`, `tokenize` (no folding of digits), `parseAmount`, `segment`, `scoreDirection`, `buildCustomerIndex`, `matchCustomer`, `parseVoice` |
| `src/core/voice-lexicon.ts` (new) | the lexicon (2.2) with explicit forms and per-row suffix lists, keys generated from both scripts, C1/C2 classes; number words; stop and item words |
| `src/core/ledger.ts` | export a `levenshtein` helper; add a comment on `phoneticFold` warning that it mangles digits (no behaviour change) |
| `src/platform/stt.ts`, `stt-native.ts`, `stt-web.ts`, `stt-server.ts` (new) | engine interface (1.2); `stt-server` in phase D |
| `src/platform/types.ts`, `index.ts`, `native.ts`, `web.ts` | `stt` and mic permission; web: cookie session, in-memory DB and **memory-only `writePrivateFile`** for shared computers, wipe on logout |
| `src/main.ts`, `src/ui/backup.ts` | skip `snapshotIfDue` and backup copies in shared-computer mode |
| `src/ui/components/mic.ts` (new) | hold-to-talk button, listening sheet, partial text, permission flow, session tied to the route (abort on leave/pause) |
| `src/ui/voice-flow.ts` (new) | STT → parse → (LLM) → picker overlay / "open Sita?" / add new / list → navigation; drops late results |
| `src/ui/save-checks.ts` (new) | `preSaveChecks` (big amount, advance, `recentDuplicate` with a window), shared by `entry.ts` and `voice-pick.ts` |
| `src/ui/screens/voice-pick.ts` (new) | multi-entry list card (due before → after per row; ids generated at build; one-transaction Save all; button disabled while saving) |
| `src/ui/screens/voice-test.ts` (new) | 60-prompt accuracy test (section 8); prompts in Tamil script with a **கேட்க** (listen) TTS button |
| `src/ui/screens/entry.ts` | read `amount`, `note`, `date`, `voice`, `from`; voice banner (code/phone shown when names are similar); `kind` may be null (Save disabled, and `save()` returns early so Enter cannot save); use `preSaveChecks`; after save from Home voice, `backTo('home')` + `go('customer',{id})`; write `voice_log` |
| `src/ui/screens/customer-edit.ts` | pass-through params (`amount`, `kind` or none, `note`, `date`, `voice`, `from`); create and same-name branches forward them to `entry` with no hard-coded GIVE; spoken name highlighted for checking, "Did you mean …?" |
| `src/ui/router.ts`, `src/ui/app.ts` | add `voice-pick`, `voice-test`, `login` to `RouteName` and register the screens |
| `src/ui/screens/home.ts`, `customer.ts`, `quick.ts` | mount the mic (Home: bottom centre, FAB unchanged); the customer page passes `currentCustomerId` |
| `src/ui/screens/login.ts` (new) | Tamil first; mobile number or user id + password (prelogin → WebCrypto PBKDF2 600k with a "checking…" state → login; client-side password policy), Google (with server nonce), "Pair with code" / QR, my/shared computer choice; the `web_owner_only` message for staff |
| `src/ui/screens/settings.ts` | Voice (on/off, engine, AI help, onboarding questions, "Preselect Credit for kuduthaachu", cue meanings, Reset voice learning, spoken read-back (on by default in beta), Voice test, stats, privacy text), Create login (requires an app PIN, plus a printed recovery code for step-up), Users (step-up, credential events, new-owner-device alerts), Linked Google, Drive backup and restore |
| `src/data/repo.ts`, `types.ts` | `addEntries` (one transaction, caller-supplied ids); multi-row reversal in one `db.transaction`; erase also deletes `voice_log` / `voice_alias` rows for the customer |
| `src/backup/drive.ts` (new, phase C) | encrypt, upload, rotate, list, restore |
| `src/db/schema.ts` | local-only tables (below), never synced |
| `src/sync/api.ts`, `src/sync/engine.ts` | `prelogin`, `login`, `loginGoogle`, `refresh`, `logout`, `createLogin` (`POST /users` with `link_me`); same token storage as `pair`, plus `known_device`; cookie session mode (no token check, `credentials:'same-origin'`, `X-KK-Client: web` header); new 401 codes go to login and keep the outbox; logout blocked while the outbox is non-empty, with a final push first; single-flight web refresh |
| `src/i18n/ta.ts`, `en.ts` | voice, login and backup strings |
| `android/app/src/main/AndroidManifest.xml` | `RECORD_AUDIO` permission; `RecognitionService` `<queries>` |
| `patches/@capgo+capacitor-speech-recognition+<pinned>.patch` | `EXTRA_BIASING_STRINGS` (kept only if the A/B test shows a gain), confidence scores and installed-language reporting if the plugin lacks them; regenerated on every reviewed bump |
| `package.json` | `@capgo/capacitor-speech-recognition` and `@capgo/capacitor-social-login` pinned exactly to releases at least 2 weeks old (today 8.3.2 and 8.5.12), `vite-plugin-pwa@2.0.0`, `patch-package` |
| `vite.config.ts` | `web` target → `dist-web` with PWA; the CSP comes from `khata/api/web/_headers` (already committed) |
| `test/voice.test.ts`, `test/voice.fixtures.json`, `test/voice.numbers.property.test.ts`, `test/voice.prototype.test.ts` (new) | section 8; the scratch prototype and its 26 sentences are committed and re-scored here |
| `README.md` | permission table and privacy text |

```sql
-- app SQLite, local only
CREATE TABLE voice_log (id TEXT PRIMARY KEY, at TEXT NOT NULL, engine TEXT, ms INTEGER, alts TEXT,
  parse TEXT, llm TEXT, final_entry_id TEXT, cancelled INTEGER NOT NULL DEFAULT 0, edited TEXT);
CREATE TABLE voice_alias (folded TEXT PRIMARY KEY, customer_id TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 1);
CREATE TABLE voice_cue_override (cue TEXT NOT NULL, has_marker INTEGER NOT NULL, flips INTEGER NOT NULL,
  demoted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (cue, has_marker));   -- can only demote (2.2 rule 11)
-- explicit owner meanings and onboarding answers live in the synced shop record (voice_meanings), not here
```

**`khata/api`.** These rows were regenerated from the current `src` tree. **Done** = in the WIP commits; **change** = built but needs a 3.9 item; **to do** = not built.

| File | Status | Change |
|---|---|---|
| `migrations/0002_accounts.sql` | done (committed; never edit) | users (`username`, `role`, `shop_id`, client-key verifier, `google_email`/`google_sub`, backoff columns), `devices.user_id`/`client`/`expires_at`, `login_throttle`, `auth_failures` |
| `migrations/0003_accounts_hardening.sql` | to do | the DDL in 3.7 |
| `src/lib/password.ts` | change | client-key HMAC verifier, fake salt, `parsePasswordSet`, `parseEmail`; iteration bounds pinned to 600k (via `shared/protocol.ts`); `parseEmail` restricted to Gmail / a configured `hd` for Google linking |
| `src/lib/google.ts` | change | RS256 verified by hand with WebCrypto against the cached JWKS (no `jose`); add the nonce check and `azp` vs client kind |
| `src/lib/session.ts` | change | `newDeviceTail` (the shared device-insert tail of `/pair` and logins), `parseLoginExtras`, the cookie. For logins: revoke the previous device only by `user_id` or `previous_device_token` proof, and never move recovery codes to a web device; rename the cookie to `__Host-kk_session`, `Path=/` |
| `src/lib/throttle.ts` | change | `reserveDailyAttempt` / `giveBackDailyAttempt`; for `auth_failures`, charge only failing unknown sources |
| `src/lib/auth.ts` | change | transport binding and the `X-KK-Client` CSRF guard are built. To do: lookup by hash, then `wrong_transport` + audit; `expired`/`idle` codes; `last_active_at`; the `prev_token_hash` grace window; `step_up_at` helper |
| `src/lib/stepup.ts` (new) | to do | verify `step_up` (current client key, fresh Google token, recovery code, owner-device approval); set `devices.step_up_at` |
| `src/lib/known-device.ts` (new) | to do | issue/verify the stateless known-device value (3.6) |
| `src/routes/auth.ts` | change | `/config`, `/auth/prelogin`, `/auth/login`, `/auth/google` and `/auth/logout` are built. To do: network-keyed `login_backoff`, staff web → `403 web_owner_only`, web `code_block` null, owner-device alert, `/auth/nonce`, `/auth/recover`, `/auth/refresh`, `Clear-Site-Data` on web logout |
| `src/routes/users.ts` | change | `GET/POST /users`, `PUT /users/:id`, `PUT /users/:id/password` are built (guarded only by `ownerOnly`). Add step-up, refuse web, `auth_events`, `must_change_pw`, the 48 h `google_email` expiry, and the recovery-code / other-owner path for an unknown current password |
| `src/routes/auth-events.ts` (new) | to do | `GET /auth-events` (owner) |
| `src/routes/devices.ts` | change | step-up + refuse web on pair-code, recovery-codes and owner-device revoke; list web sessions with the user's name; revoke offers to disable the login and the users that device created |
| `src/routes/shop.ts` | to do | `voice_meanings` in `PUT /shop` |
| `scripts/break-glass.sh` (new) | to do | developer-run one-time owner recovery code (3.6), documented in the API README |
| `scripts/prepare-assets.mjs`, `web/_headers` | done | copies the web build's `_headers` (CSP in 3.5) into `../app/dist-web` |
| `src/routes/voice.ts` (new, phase D) | to do | `/voice/interpret` (Workers AI binding `AI`, schema, cap), `/stt` (Sarvam) |
| `src/index.ts` | change | assets and the new routers are wired. To do: scheduled handler (R2 export, expired web device purge), `/privacy`, `/terms`, homepage |
| `src/env.ts`, `wrangler.jsonc` | change | built: `assets`, `AUTH_LIMITER` (namespace 1002, 20/60 s), `AUTH_THROTTLE_AFTER`, `GOOGLE_CLIENT_IDS` (a list), `PEPPER` (reused with domain-separation prefixes). To do: `NONCE_SECRET`, the Android client IDs for `azp`, `r2_buckets`, `triggers.crons`, `AI_MODEL`, `VOICE_DAILY_CAP` (+ `SARVAM_KEY` and the `ai` binding in phase D) |
| `package.json` | done | no new auth dependencies (no `jose`, no argon2id) |
| `test/accounts.test.ts`, `google.test.ts`, `cpu.test.ts`, `assets.test.ts`, `review-security.test.ts` | change | exist; add the section 8 API cases for every 3.9 item, including the ones the WIP code fails today (another user's device id revokes nothing; staff web refused; an attacker's failures do not block the owner's known device) |

---

## 7. Milestones (each one ends in a demo)

**Phase A: voice on Android, no new server code**

| Week | Work | Demo |
|---|---|---|
| 1 | Commit the scratch prototype and its fixtures; `core/voice.ts` built from it: lexicon with exact forms, numbers (teens, N nooru, digit × multiplier, kaal/mukkaal), segmentation, matcher, marker/C1/C2 caps, cross-alternative conflicts; 150+ fixtures; digit-fold guard; both number property tests; `preSaveChecks` extracted | `vitest` passes every row of 2.5, scoring customer as well as kind and amount |
| 2 | Manifest fix, Capgo plugin (pinned), mic on the **customer page** with name-span check, entry params, voice banner, null-kind state; test on the client's Redmi phones: permission, offline (`isOnDeviceRecognitionAvailable`), **mid-sentence pauses** (`continuousPTT` vs auto-endpoint), **number of alternatives and confidence scores for `ta-IN`** | On Ramu's page: "100 kuduthaan" → Credit ₹100 pre-filled → Save → Undo; a report of alternatives per utterance |
| 3 | Mic on Home and Quick; picker overlay, add new via `customer-edit` pass-through, multi-entry card (`addEntries`), `voice_log`, aliases, onboarding questions (synced via `PUT /shop`), demote-only learning, biasing patch (A/B ready); Web Speech in the browser preview | "Ramu 100 kuduthaachu" from Home → confirm (one tap on the suggested Credit) → lands on Ramu's page |
| 4 | **Voice test + gate run in the shop** (quiet and busy hours, owner and staff) | Accuracy report against section 8, including the dative-drop rate that decides whether "Preselect Credit for kuduthaachu" may be offered. Pass: voice on by default. Fail: "beta, customer page only", and phase D starts |

**Go/no-go before phase B ships:** the client confirms that browser access or login-based recovery will actually be used, and chooses Workers Paid (recommended) or Free. Passwords work on both. The server accounts code already started as WIP. It must not be deployed to the shop until the 3.9 changes pass their tests.

**Phase B: accounts and web**

| Week | Work | Demo |
|---|---|---|
| 5 | **Finish the WIP server (3.9 items 1–4, 6, 7, 10, 11):** migration 0003, iterations pinned to 600k, network-keyed backoff + known device, takeover by proof, step-up + `auth_events`, staff web refusal, web `code_block` null, `/auth/recover`, tests. App: login screen, prelogin + WebCrypto PBKDF2, Create login. **Measure 600k PBKDF2 on the client's Redmi WebView and in desktop Chrome**, and measure CPU on a deployed Free Worker. Privacy, terms and home pages served from the Worker | Owner phone creates its login with PIN + recovery code; a staff login works on a second phone; another user's device id revokes nothing; sync unchanged |
| 6 | Google sign-in (Android + web) with nonce, `azp` binding and Gmail-only linking; web rotation with grace window, idle timeouts, cookie renamed to `__Host-kk_session`; logout (client pushes first) and wipe; Settings → Users with credential events and new-owner-device alerts; revoke-also-disables-login. **Spikes:** publish the consent screen "In production" on `workers.dev` (no custom domain); does the pinned social-login plugin return a `drive.file` access token on the Redmi phones? | Owner signs in on a new phone with Google; remotely revokes a lost staff phone and its login |
| 7 | Web build on Worker assets (`_headers` CSP already committed), PWA, cookie session, owner-power routes refused for web, staff web refused with the Tamil message, shared-computer mode (no local copies), web voice with smoke test; owner-only | Same ledger on a laptop in Chrome; logout is refused while unsynced; shared-mode logout leaves nothing behind; a staff login on the web gets `web_owner_only` |

**Phase C: backup**

| Week | Work | Demo |
|---|---|---|
| 8 | Encrypted daily Drive upload (key in Keystore, or unencrypted by owner choice), monthly CSV, rotation, restore, R2 cron, final privacy text; consent screen "In production" (no app verification expected for non-sensitive scopes; brand verification optional) | Backup visible in the owner's Drive; a wiped phone restores from it |

**Phase D (conditional, about 1 week each, bake-off on the same recorded set):**
- Sarvam `/v1/stt`, if Google STT fails the gate.
- The LLM `/v1/voice/interpret`, if `voice_log` shows more than about 15% lexicon misses.

Keep the paper book alongside through phases A and B.

---

## 8. Testing & accuracy evaluation

**Automated (CI)**
- **`test/voice.fixtures.json`:** at least 300 rows of `{transcript, alts, scores?, customers, overrides, expected:{customer, amount_paise|null, amount_chips, kind|null, suggested, note, date}}`. **Customer resolution is scored**, not only kind and amount (a Ramu/ராமு tie must open the picker). It must include:
  - **both halves of the dative pair**, including a row where **every alternative has lost "-க்கு"**, and the hyphenated and space-separated forms ("Ramu-kku", "Ramu kku", "Ramu ku"); "Ramu-kku 250 arisi kuduthen" → GIVE 1.0, note arisi;
  - the C1 guard (vowel-final vs consonant-final names, before and after the onboarding answer, with and without the owner switch);
  - the C2 pairs (kuduthen/kuduthaan, koduthom/kuduthaanga, vaanginen/vaanginaan, vaangittom/vaangittaan), alone and as disagreeing alternatives, and with low recogniser scores;
  - "X kitta N kuduthaachu", "X kitta N kuduthen", "X kitta N vaanginen";
  - English: "Ramu gave 100", "Ramu paid 100", "I paid Ramu 100", "gave to Ramu 100", "Ramu 100 credit", "Ramu 100 debit", "credit-la podu", and பற்று / வரவு;
  - amount disagreement across alternatives: 1500/500, 500/50 (ainooru/aimbadhu), 250/200, 2500/500 (rendarai aayiram/ainooru);
  - the customer page with a different spoken name ("Sita 100 kattiyaachu" on Ramu's page), and **with a namesake** ("Ramu 100 kattinaan" on Ramu-1's page while Ramu-2 exists keeps Ramu-1 and shows no prompt);
  - the app labels matched raw: "Ramu 100 பற்று" → Debit, "Ramu 100 வரவு" → Credit, while **"Ramu 100 paaru" and "Ramu 100 பாரு" preselect nothing**;
  - bare kuduthaachu before onboarding is never preselected, and a test that **every lexicon form resolves to its own row** (no `kututa`+"su" match);
  - a flip-sequence fixture proving learning never yields an inverted preselect;
  - Tamil number words (teens, N nooru, unit × aayiram, kaal/mukkaal, "2 ஆயிரம்", இலட்சம்/லட்சம்), corrections, multi-entry, items with quantities, balance questions, same-name customers (no alias stored), and lexicon-collision names.
  A lexicon change must not lower any metric.
- **Property tests:**
  - **spoken Tamil words:** a separate generator spells every amount from 1 to 99,999 rupees in pure Tamil number words (spoken and literary variants, fused forms such as irubathanju, teens, combining forms -thi/-thu, -arai, colloquial "N nooru"), in Tamil script and Tanglish; `parseAmount` must read each back exactly;
  - **hybrid format (weaker, kept as a second test):** `parseAmount` reading `amountInWords(paise,'ta')` back. That function prints digits with multiplier words ("1 ஆயிரம் 500 ரூபாய்", "2 இலட்சம் 50 ஆயிரம் ரூபாய்") **[verified: ran `ledger.ts`]**, so it does not exercise nooru, ainooru or aayirathu;
  - lexicon keys: each Tamil/Latin pair folds to the same key or is listed twice (raw-matched rows excepted), and no lexicon key equals the fold of a listed filler word (paaru → `paru`);
  - digit tokens are never folded;
  - any amount the parser outputs appears in the transcript.
- **UI:**
  - voice params pre-fill the entry screen;
  - Save is disabled while kind is null, **and the Enter key does nothing**;
  - Home voice lands on the customer page after Save, with Back going to Home (stack [home, customer]);
  - a late recognition result after navigating away does nothing;
  - "Save all" runs `preSaveChecks` per row, writes all rows in one transaction, and a retry after a failure creates no duplicates; Undo after "Save all" reverses every row in one transaction;
  - no match → `customer-edit` → entry keeps amount and kind (or none);
  - a web logout with a non-empty outbox is refused **by the client** (it pushes first);
  - while voice is in beta, the spoken read-back plays before Save, and the banner shows the amount in words.
  - A Playwright E2E on the web preview injects transcripts through a fake `SttEngine` and asserts that **nothing is saved without a click**.
- **API** (cases marked † fail on the WIP code today and gate phase B, 3.9):
  - unknown user and wrong password give the same `invalid_login` and similar timing; prelogin for unknown and real users returns the same shape and **always 600k iterations**; a password set with fewer than 600k iterations is rejected †;
  - backoff is keyed on (username, network): **an attacker's failures from one network do not block the owner's known device or another network** †; the shop-wide budget is not charged to known devices †; `/auth/nonce` writes nothing;
  - Google: tokens with a wrong `aud`/`iss`, an expired token, a missing or reused nonce †, a web-`azp` token with `client:'android'` †, a non-Gmail `google_email` refused †, an unlinked `google_email` older than 48 h does not link †;
  - **staff `client:'web'` login (password and Google) → `403 web_owner_only`, and no device row is created** †;
  - web login returns `code_block: null` †; the cookie is `__Host-kk_session; Path=/` †;
  - web refresh: the old token works within 120 s (concurrent use), and reuse after that revokes; app tokens never rotate;
  - a cookie token used as a Bearer gives `wrong_transport` and a revoke;
  - web sessions are refused on pair-code, recovery-codes, `POST /users`, `PUT /users/:id`, another user's password and owner-device revoke †;
  - step-up is required on those routes from app devices too †; each writes `auth_events` †; a new owner-role device writes `owner_device_new` †;
  - a password reset without the current password needs a recovery code or owner-device approval †;
  - **login with another user's `previous_device_id` revokes nothing** †; a legacy device is taken over only with its old token †; recovery codes are never moved to a web device †;
  - CSRF: a cookie request without `X-KK-Client: web` gets `403 csrf`;
  - a role change or disable revokes devices; revoking a lost device can also disable its login;
  - `/auth/recover` is rate-limited; the break-glass code is single use;
  - phase D: schema failure falls back, refs that were never sent are rejected, an invented amount is rejected, the daily cap holds.
- The existing sync and integration suites must pass unchanged.

**Field gate (Settings → Voice test, week 4)**
- 60 prompts generated from the **real** customer list: a random customer, an amount (digits, round Tamil numbers and compound numbers) and a phrasing style. Some prompts ask her to **pause in the middle** ("Ramu… 100 kuduthaachu").
- **Each prompt is shown in Tamil script** (ராமு 100 குடுத்தாச்சு, numbers as digits and also in Tamil words), never only in Tanglish. A large **கேட்க** (listen) button plays the prompt through Android text-to-speech, so a speaker who reads little can hear it and repeat it. English-only prompts are offered only to staff who chose English screens.
- Read by the owner and each staff member, at a quiet hour and a busy one.
- For each engine, record the alternatives (and how many came back), any confidence scores, the parse and the latency.
- Then collect 200–300 real counter sentences over the following weeks. The confirmation step labels each one for free, and names are pseudonymised before export. Stratify:
  - about 50/50 GIVE/RECEIVE;
  - at least 30 dative pairs (this count gates the "Preselect Credit for kuduthaachu" switch);
  - at least 20 C2 person pairs (kuduthen/kuduthaan, vaanginen/vaanginaan …);
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
| **Amount edited after a voice pre-fill** (`voice_log`), counting both single-alternative and multi-alternative utterances | ≤ 3%; above that, the spoken read-back stays on by default |
| Customer top-1 / top-3 | ≥ 90% / ≥ 98% |
| Direction accuracy end to end; coverage (preselected) | ≥ 95%; ≥ 80% |
| Same-name cases sent to the picker | 100% |
| Latency, release → confirmation screen | median ≤ 1.5 s, p90 ≤ 3 s |
| No-result rate | ≤ 5% |
| Phase D LLM: call rate; p95 | ≤ 25%; < 2.5 s (parser < 50 ms) |

**In production:** Settings → Voice stats (local) shows:
- edits after voice pre-fill, by field (**"amount edited after voice" split by single vs multiple alternatives**), and "amount differs across alternatives" / "direction conflict" counts;
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
| A dropped or added "-க்கு" flips the direction | Marker cap 0.55; C1 guard on vowel-final names (Credit only suggested); due before → after; spoken read-back (on by default in beta); big toggle; Undo. The cross-alternative conflict check counts as a net only once week-2 logs show `ta-IN` returns several alternatives (unverified; often one) |
| A misheard verb ending (kuduthen/kuduthaan, vaanginen/vaanginaan) flips the direction | C2 rule: preselect only when all alternatives agree and the recogniser score is high; stratified field test |
| Recognition errors teach the wrong meaning | Learning only demotes to "ask"; inversion only by an explicit owner setting; Reset voice learning |
| "kuduthaachu" or English "credit" means the opposite in this shop | Onboarding questions synced as a shop setting; bare forms start capped |
| The recogniser cuts the sentence at a pause | Week-2 test of `continuousPTT` vs auto-endpoint; sheet asks for the missing amount |
| Two Ramus / rare names | Mandatory picker on ties; on a customer page the page's customer is kept unless another beats it by ≥ 0.10; C-code and phone last 4 on every prompt; spoken disambiguators; local aliases |
| A misheard amount ("aayirathu ainooru" heard as "ainooru") with only one alternative fills a wrong amount silently, below `confirm_above_paise` | Amount in words in large type beside the heard words; spoken read-back on by default during beta; "amount edited after voice" as a gate metric; the cross-alternative check counts only once week-2 logs show multiple alternatives |
| Folded keys collide with fillers (பற்று and "paaru" both fold to `paru`) | App labels matched raw before folding; CI forbids keys equal to filler folds; "Ramu 100 paaru" fixture |
| No Google speech service, or offline | Mic hidden or a clear message; keypad always there |
| Biasing patch does nothing for Tamil (unverified) | A/B; drop it |
| Workers AI model renamed; Gemma's Tamil weak (unverified) | `AI_MODEL` variable; parser-only works on its own; bake-off list |
| Client-side stretching: `client_key` is password-equivalent on the wire; XSS on the login page captures it | HTTPS only; bodies never logged; strict CSP (3.5); password change revokes other devices |
| A modified client registers a cheap verifier, or prelogin reveals users through a non-default iteration count | Iterations pinned to 600k on the server (3.3, 3.9 item 1) |
| 600k PBKDF2 is slow on a low-end Redmi WebView (unverified) | Measure in week 5; "checking…" state; never lower below 600k |
| WebCrypto PBKDF2 capped at 100k iterations in Workers **[verified, workerd source]**, below OWASP's 600k | Never run on the server: the stretching happens on the client (3.3) |
| WIP accounts code ships before its fixes (takeover by device id, no step-up, username-only backoff, email linking without nonce) | Phase B gate: every 3.9 item has a † test in section 8 that must pass before deploy |
| Unauthenticated requests exhaust the Free plan's 100k D1 row writes/day, stopping auth and sync | Stateless nonce; throttle rows only for real login ids; limiter on `/auth/nonce`; Workers Paid recommended |
| Login lockout or global-cap denial of service against the owner | Backoff keyed on (username, network); known-device exemption; shop-wide budget only for failing unknown sources; owner's login id not the public shop number |
| A stolen phone, an open web session or an XSS mints lasting credentials (an owner login, a `google_email`, pair/recovery codes) | Step-up on every owner-power route, whatever the client kind; owner-power routes also refused for web; the app PIN is required for Create login but is only a UI guard; revoke also disables the login and offers to disable users that device created; credential events and new-owner-device alerts on owner devices |
| Google account takeover through a pre-registered non-Gmail or mistyped address, or a replayed ID token | Gmail-only (or configured `hd`); unlinked email expires after 48 h; nonce + `used_nonces`; `azp` bound to client kind |
| Staff opens the web app at home and downloads the whole ledger | Server refuses staff web logins in v2 (`403 web_owner_only`); later forced shared mode |
| Consent screen cannot be published on `workers.dev` (unverified) | Week-6 spike; buy an optional custom domain only if needed (and rename the cookie first); share-sheet backup until publishing works |
| A Capgo release regresses a money app | Pin releases at least 2 weeks old; review diffs before bumps; patch regenerated per version |
| ₹0 path exceeds Free CPU or hits the daily caps | One HMAC per login; measure on a deployed Free Worker; Paid recommended anyway |
| Firebase fallback: leaked ID token, orphaned staff logins | 5-min `auth_time`, single-use exchange, limiter, D1 revoke on every member change |
| Drive token unavailable on Android (unverified) | Week-6 spike; share-sheet backup; R2 copy |
| Owner forgets the backup passphrase | Printed with the recovery codes; R2 copy; optional monthly CSV |
| Browser data left on a shared PC | Memory-only shared mode with no snapshots or private files, 30-min user-activity idle, remote revoke + wipe |
| Unsynced web entries lost on logout or tab close | Immediate push; `beforeunload` warning; logout blocked while the outbox is non-empty; `Clear-Site-Data` only after the final push |
| Free tiers change (Workers AI, Firebase, Sarvam credits now ₹100 **[verified]**) | Per-shop caps; parser works without AI; budget ₹300/month if Sarvam is enabled |
| DPDP obligations: Rules notified 13/14 Nov 2025, most duties from about 13–14 May 2027 **[verified]**, Rule 8(3) one-year retention for some processing logs; D1 has no India region | Processors named (Sarvam retention 0 days, India processing); no audio stored; Voice & Audio Activity off; erasure also clears voice tables; erased customers age out of backups within 12 months; confirm residency with counsel |

---

## 10. Open questions for the client

1. In your shop, does "Ramu 100 kuduthaachu" always mean **Ramu paid you**? How do you say it when you gave Ramu goods on credit ("Ramu-ku…", "vaanginaan", "kanakkula podu")? Please record 20 real sentences from the counter.
2. Which phones (model, Android version, Google app enabled)? Who will speak to the app: the owner only, or staff too?
3. User id/password and Google login both work at **₹0** on Workers Free. Is **₹440/month (Workers Paid)** acceptable anyway, on the shop's own card, to remove the daily request and write caps (recommended)? And should a new owner login on a new phone need approval from an existing owner phone or a printed recovery code before it may sync (safer, but slower when every phone is lost)?
4. Do staff have **Gmail** addresses (only @gmail.com can be pre-registered for Google sign-in)? Or should the owner create logins for them (a mobile number as the login id)? Can every staff member type a password, or do some need Google, a QR/pair code and the spoken read-back?
5. Who needs the web app, and on whose computer: the owner's own laptop or a shared counter PC? v2 web is owner-only; is that enough at first?
6. Is a daily encrypted backup (plus an optional readable monthly CSV) in the owner's Drive what "data in our Google account" means? Or must Google host the live data (Firestore v3: 4–6 weeks, Blaze billing in the shop's name)?
7. Do you accept that voice audio goes to Google for recognition (Microsoft or Apple if you use Edge or Safari)? With "AI help" or Sarvam on, the sentence text and some customer names also go to Cloudflare or Sarvam. Will you turn off Voice & Audio Activity on the shop phones' Google accounts?
8. If the free Google recogniser misses the accuracy gate, is about **₹50–300/month for Sarvam** acceptable?
9. Must the data be stored in India? (D1 offers only "apac". Sarvam, if enabled, processes in India.)
10. Would you like an optional custom domain (for example `kanakku.<shop>.in`, about $10/year) so that Google's consent screen shows the app's name and logo instead of a `workers.dev` address? It is not required. And the spoken read-back ("ராமு, நூறு ரூபாய், வரவு") is on by default while voice is in beta: keep it on afterwards?
11. When you say "credit" in English at the counter, do you mean goods given on udhaar or money received? (The app's Credit/வரவு button means money received.)

---

## Sources

Speech and AI
- Android RecognizerIntent: https://developer.android.com/reference/android/speech/RecognizerIntent
- Android SpeechRecognizer: https://developer.android.com/reference/android/speech/SpeechRecognizer
- Capgo speech plugin: https://registry.npmjs.org/@capgo/capacitor-speech-recognition · https://github.com/Cap-go/capacitor-speech-recognition · https://capgo.app/docs/plugins/speech-recognition/
- Web Speech API (MDN): https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition · MDN browser-compat data: https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json · New in Chrome 139: https://developer.chrome.com/blog/new-in-chrome-139 · Chrome contextual biasing status: https://chromestatus.com/feature/5225615177023488
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
- Gemini: terms https://ai.google.dev/gemini-api/terms · pricing https://ai.google.dev/gemini-api/docs/pricing · deprecations https://ai.google.dev/gemini-api/docs/deprecations · rate limits https://ai.google.dev/gemini-api/docs/rate-limits · structured output https://ai.google.dev/gemini-api/docs/structured-output · gemini-3.5-transcribe https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe
- ML Kit GenAI (devices, Speech Recognition alpha): https://developers.google.com/ml-kit/genai · Chrome Prompt API: https://developer.chrome.com/docs/ai/prompt-api
- Prior art: https://okcredit.in/blog/how-to-use-okcredit-application-for-grocery-store

Auth, hosting and storage
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/ · pricing: https://developers.cloudflare.com/workers/platform/pricing/ · D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Static assets: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ · Rate limiting: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ · Email: https://developers.cloudflare.com/email-service/
- workerd PBKDF2 limits: https://github.com/cloudflare/workerd/blob/main/src/workerd/io/limit-enforcer.h · https://github.com/cloudflare/workerd/blob/main/src/workerd/api/crypto/pbkdf2.c%2B%2B
- OWASP password storage: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- RFC 9700: https://www.rfc-editor.org/rfc/rfc9700.html
- Google OAuth app verification / brand verification: https://support.google.com/cloud/answer/15549049 · GIS CSP: https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid#content_security_policy
- Google ID token verification: https://developers.google.com/identity/gsi/web/guides/verify-google-id-token · Credential Manager: https://developer.android.com/identity/sign-in/credential-manager-siwg-implementation · OAuth (refresh-token expiry): https://developers.google.com/identity/protocols/oauth2
- Capgo social login: https://github.com/Cap-go/capacitor-social-login
- Firebase: ID token verification https://firebase.google.com/docs/auth/admin/verify-id-tokens · auth limits https://firebase.google.com/docs/auth/limits · pricing https://firebase.google.com/pricing · plans https://firebase.google.com/docs/projects/billing/firebase-pricing-plans · Firestore quotas https://firebase.google.com/docs/firestore/quotas · transactions https://firebase.google.com/docs/firestore/manage-data/transactions · locations https://docs.cloud.google.com/firestore/docs/locations · capacitor plugin https://capawesome.io/plugins/firebase/authentication/
- Google Cloud free features: https://docs.cloud.google.com/free/docs/free-cloud-features
- Drive scopes: https://developers.google.com/workspace/drive/api/guides/api-specific-auth · appdata: https://developers.google.com/workspace/drive/api/guides/appdata
- Set-Cookie (MDN): https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie · Public Suffix List: https://publicsuffix.org/list/public_suffix_list.dat
- Supabase pausing: https://supabase.com/docs/guides/platform/free-project-pausing · backups: https://supabase.com/docs/guides/platform/backups · keep-alive example: https://github.com/travisvn/supabase-pause-prevention
- Lucia: https://lucia-auth.com/ · Better Auth: https://www.better-auth.com/docs/authentication/email-password
- Turso: https://turso.tech/pricing · Neon: https://neon.com/pricing · Appwrite: https://appwrite.io/changelog/entry/2026-06-29
- DPDP: https://www.hoganlovells.com/en/publications/indias-digital-personal-data-protection-act-2023-brought-into-force- · DPDP Rules 2025: https://www.barandbench.com/view-point/meity-notifies-final-digital-personal-data-protection-rules-2025
- Hono CSRF middleware: https://hono.dev/docs/middleware/builtin/csrf
