# Kadan Kanakku — Tamil Voice Entry, Accounts & Cross-Platform Sync Plan

**Date:** 2026-10-18 · **Status:** Plan v2 — not yet implemented

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
- **Sarvam `saaras:v4`** called through our Worker. It costs ₹30 per hour billed per second (₹0.50/min) **[verified]**, roughly ₹50–300 a month at this shop's volume **[likely]**. Sarvam's models ("Sarvam Audio" 14.2% and Saarika 2.5 14.9% Tamil WER) led the only independent Indian benchmark we found **[likely]**, but `saaras:v4` itself has no independent Tamil score.
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
5. **Direction, by default:** "Ramu 100 kuduthaachu" (paid) and "Ramu**க்கு** 100 kuduthaachu" (*gave to* Ramu) differ by one syllable that the recogniser easily swallows after a vowel-final name. So for this verb family the app shows Credit as **suggested** (outlined, pulsing) but does **not select it**; she taps **Credit** once. If the week-4 field test on her phones shows the recogniser keeps "-க்கு" reliably, the owner can switch on Settings → Voice → "Preselect Credit for kuduthaachu". Credit is then preselected, and the only guards against a swallowed "-க்கு" are the due before → after line, the optional spoken read-back and Undo (section 2.2, rule 2).
6. She taps **Save**. The app lands on **Ramu's account page** with the new balance and an Undo button.

Clearer verbs preselect directly: "Ramu 100 kattinaan" or "Ramu gpay 100" → Credit; "Ramu 100 vaanginaan" (*Ramu took goods*) → Debit, as long as the recogniser's guesses agree (it is one vowel away from "vaanginen", *I received*). Because Tamil phrasing can point either way, the app asks (nothing preselected, Save disabled until she taps a side) whenever it cannot be sure:
- "Ramu**க்கு** 100 குடுத்தாச்சு" or "Ramu kitta 100 kuduthaachu" means *gave to* Ramu: Debit (GIVE), but it is never preselected.
- "kanakkula ezhuthu" means *write it in his account*: Debit, but weak, so it is not preselected. Bare English "credit"/"debit" is not preselected either, because shop slang and the app's buttons use "credit" in opposite senses.
- The recogniser's guesses disagree on the direction or on the amount: nothing is preselected, and the amounts show as chips.
- If there are two Ramus, it shows a picker with code and phone digits.

**3. Login with user id/password and/or Google, on the server?**

Both, built **inside the Cloudflare Worker we already have**. Each login creates a "device" session, just as pairing does today, so the sync protocol does not change (the app's sync engine only gains a cookie mode for the web).
- **Google sign-in** is free.
- **User id + password** needs Cloudflare **Workers Paid ($5 ≈ ₹440 a month)**. A safe password hash takes about 200 ms of server CPU, and the free plan allows 10 ms per request **[likely, measured locally]**. The v1 plan already recommended Paid at go-live.
- **The login id can be a mobile number** typed on the number pad, and login screens are Tamil first, so staff who cannot type English can sign in; the owner issues staff credentials, or staff use Google or a pair code / QR from the owner's phone.
- **If the client wants ₹0**, either use Google sign-in plus today's pairing codes, or let Firebase Authentication (Google's free login service) handle passwords (section 3.8).

**4. Cross-device and web app?**

- **Phones:** any phone (owner or staff) signs in and syncs through the existing sync protocol.
- **Web app:** the same app screens are served from the same Worker at no cost. It can be installed as a PWA and has a "shared computer" mode that keeps the ledger in memory only and refuses to log out while entries are unsynced.
- **v2 web = owner only.** Staff use the phone app. Staff web login is a later phase, and then defaults to shared-computer (memory-only) mode so a staff member's home PC never keeps the whole ledger.
- **Voice on the web:** Chrome is the tested target; Edge and Safari show the mic only if a Tamil smoke test passes.
- **Ledger of record:** the phone stays the master copy, because browsers can delete stored data.

**5. Where does the data live, and what about "their Google cloud account / own credits"?**

- **Live data:** stays where it is today, in the phone's SQLite plus Cloudflare D1 as the sync hub.
- **Google login does not move any data into Google.** The honest way to put the client's data in their Google account is a **daily encrypted backup into a visible folder in the owner's own Google Drive**, plus an optional monthly CSV statement. It uses the `drive.file` permission, which Google classes as non-sensitive **[verified]**. When the owner opens Drive, the **monthly CSV is the copy a person can read**; the encrypted `.kkbak` files are only for restoring through the app (the owner may choose unencrypted backups instead, since the folder is in their own account). Automating this needs a published, brand-verified Google consent screen, which in practice needs a custom domain (section 5).
- **Ownership:** the shop's own Gmail owns the Google project, the Drive folder and the Cloudflare account.
- **"Credits":** there are no ongoing Google Cloud credits. The $300 trial lasts 90 days **[verified]**, and the always-free VM and storage tiers are US-only **[verified]**.
- **Moving live data into Google Firestore** would mean a 4–6 week rewrite of working money code. That is not recommended for now.

**6. Supabase pausing: use it or not?**

**Do not use it.**
- Free projects pause after one week of low activity **[verified]**, and a pause stops login *and* sync on every device until someone restores the project by hand (possible for up to 1 year **[verified]**). A 10-day festival closure would be enough to trigger it. Supabase says API calls count as activity, so a scheduled ping is possible, but it does not fix the next point.
- The free plan has no backups **[verified]**.
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
- **Whisper (Workers AI):** it would fit the free neurons at this volume, but whisper-large-v3 scores ≈48.6% WER on FLEURS-Tamil (vendor-computed on its own clips, not a Workers AI measurement) **[likely]**, so it is rejected on accuracy.
- **Deepgram Nova-3, OpenAI, AssemblyAI:** 57–68% error on real Indian Tamil. (The same benchmark puts paid Gemini 3 Pro at 15.7% and Amazon Transcribe at 19.3%; Gemini audio is a phase-D bake-off candidate.)
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
| **Customer page** (`customer.ts`) | header, large | "100 kuduthaan", "ஐநூறு வாங்கினான்". The page's customer is the default, but name-span detection still runs: if the words strongly match a **different** customer (score ≥ 0.75) or contain unknown name tokens, the app asks "நீங்கள் சொன்னது சீதா — சீதா கணக்கைத் திறக்கவா? / You said Sita: open Sita?" (or shows the picker) instead of pre-filling the page's customer. **This is the most accurate mode and the one to teach first.** |
| **Home** (`home.ts`) | **primary 64 dp button, bottom centre**; the existing add-customer FAB (`.fab`, bottom right, line 276) stays where it is, and the list gets extra bottom padding so neither covers a row | full sentence, "Ramu 100 kuduthaachu" |
| **Quick entry** (`quick.ts`) | header | full sentence; sticky date and running totals are kept |
| **Entry screen** (open) | small | corrections: "illa 150", "Sita illa, Seetha" change only that field |

**How listening works:**
- **Hold to talk** is the default, but **the recogniser, not the button, decides when speech ends.** Google's `SpeechRecognizer` ends the session by itself after a pause even while the button is held, and it often ignores the silence-length extras that `allowForSilence` sets (`EXTRA_SPEECH_INPUT_(POSSIBLY_)COMPLETE_SILENCE_LENGTH_MILLIS`) **[verified: plugin source; Google behaviour likely]**. So "Ramu… [pause] …100 kuduthaachu" can be cut off after "Ramu". Two options, chosen in week 2 on the client's Redmi phones:
  - the plugin's **experimental** `continuousPTT` option, which restarts recognition while the button is held; the app joins the segments before parsing; or
  - accept auto-endpointing and treat release as `stopListening()`; if a session ends with only a name, the sheet stays open with "தொகை சொல்லுங்கள் / say the amount".
- A setting switches to tap-to-start with auto-stop on the recogniser's own endpoint.
- Hard limit: 10 s.
- While listening, the app shows a pulsing ring, "கேட்கிறேன்… / Listening…", the **live partial text** (`partialResults:true`) and Cancel.
- The mic appears only after the microphone permission is granted. The first tap explains why in Tamil first ("பேசி கணக்கு போட மைக் அனுமதி தேவை").
- **Each voice session is tied to the route** that started it (router depth plus a session token). Navigating away, a leave guard, Cancel or the app going to the background aborts it (`AbortSignal` in 1.2), and a late result is dropped instead of navigating.

**The confirmation is the existing entry screen** with new route params `amount` (paise), `note`, `date`, `voice='1'` and `from`. A voice banner sits above the keypad:
1. **Heard:** the transcript in grey. Tap it to see the other alternatives.
2. **Plain sentence in the direction colour:** "ராமு உங்களுக்கு ₹100 கொடுத்தார் → **வரவு**" / "Ramu paid you ₹100 → **Credit**".
3. **Due before → after:** "பாக்கி ₹450 → ₹350". If the due goes *up* when she expected it to go down, the direction is wrong, and she can see that at a glance.
4. **Which customer:** the name, and, **whenever another customer has a similar name**, the C-code, phone last 4 and note too, so she can tell the two Ramus apart on this screen and not only in the picker.
5. A **Change customer** chip; a large **பற்று Debit | வரவு Credit** toggle (the existing `det.gave`/`det.got` labels); a date chip, highlighted when the date is not today; a note chip such as "அரிசி".
6. **When `kind` is absent** (direction confidence below 0.6, or a conflict), neither side is selected, **Save stays disabled** and the toggle pulses; a side the parser leans towards is outlined as "suggested" but not selected. Today `entry.ts` defaults to GIVE (`route.params.kind === 'RECEIVE' ? … : 'GIVE'`). Under `voice='1'` that default must become "none". `save()` itself also returns early when `kind` is null, because the hardware Enter key calls `save()` directly (line 277) and bypasses the disabled button.
7. Optional (Settings → Voice, **on by default for staff who asked for Tamil-only screens**): a spoken Tamil read-back before Save, "ராமு, நூறு ரூபாய், வரவு", using Android text-to-speech.

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
| `stt-web.ts` | `SpeechRecognition ?? webkitSpeechRecognition`, `lang='ta-IN'`, `maxAlternatives=5`, `interimResults=true`; `phrases` (customer names) is **proposed, not shipped** in Chrome (Chrome Platform Status "Web Speech API contextual biasing") **[verified]**, so feature-detect only |
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
- **Redmi/HyperOS:** Indian ROMs normally ship Google speech services **[likely]**. Test on the client's actual phones in week 2: permission, offline, mid-sentence pauses, and **the number of alternatives and confidence scores returned for `ta-IN`** (logged in `voice_log`).
- **Voice & Audio Activity:** when it is on in the shop's Google account, Google can save recordings and transcripts (with customer names) to that account. Onboarding asks the owner to turn it off on shop phones.

### 1.4 Web specifics

- **Chrome (desktop and Android) is the tested target.** Edge (Microsoft's cloud recogniser) and Safari 14.1+ / iOS 14.5+ (Apple, prefixed `webkitSpeechRecognition`) expose the API, but their Tamil (`ta-IN`) support is unverified **[verified: MDN "limited availability"]**. Firefox does not. Feature-detect, run a short `ta-IN` smoke test on first use, and show the mic only where it passes; elsewhere show "Voice works in Chrome".
- Chrome is server-based by default: audio goes to Google. An on-device mode (`processLocally`, `available()`, `install()`) exists behind a flag as a developer trial from Chrome 139 **[verified: MDN / Chrome Platform Status]**; Tamil on-device is unlikely (unverified).
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
3. The existing transliteration already unifies the two scripts **[verified]**: குடுத்தாச்சு and kuduthaachu both become `kututasu`; ராமு and Ramu both become `ramu`; ஐநூறு and ainooru both become `ainuru`. So one folded lexicon **mostly** covers both scripts, but not every word: எண்ணெய் folds to `eney` while "ennai" folds to `enai` **[verified: ran `ledger.ts`]**. Lexicon keys are therefore generated from **both** the Tamil and the Latin form of every entry, and a CI check asserts that each Tamil/Latin pair folds to the same key or is listed twice.
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
| 13 | வரவு (வை / போடு) — the app's **Credit** label | varavu (vai/podu) | varavu | R | 3 | — |
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
| 40 | பற்று — the app's **Debit** label | pattru, patru | patru | G | 3 | — |
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
   - **Missing-marker guard (C1).** The dative is often swallowed after a vowel. So a C1 form (kuduthaachu, kuduthaa/kuduthaal) with **no** marker, when the matched name ends in a vowel (Ramu, Sita, Selvi), is also capped at 0.55, **even after the onboarding answer**. Credit is shown as "suggested", not selected. The cap lifts only if (a) a marker-free strong cue is also present (kattinaan, gpay/UPI, varavu, vaanginaan), or (b) the owner switches on Settings → Voice → "Preselect Credit for kuduthaachu", offered only after the week-4 gate has tested at least 30 dative pairs on the shop's phones. Learning from flips never lifts it (rule 11).
   - **Honest limit:** with that switch on, if "-க்கு" is dropped from every alternative, "Ramukku 100 kuduthaachu" **will** be preselected as Credit. The guards are then the due before → after line, the optional spoken read-back and Undo.
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
  - on the customer page, the page's customer is used unless another customer scores ≥ 0.75 or the name span has unknown name tokens (1.1);
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
| (on Ramu's page) Sita 100 kattiyaachu | Sita (≥ 0.75) | ₹100 | RECEIVE (1.0) | "You said Sita: open Sita?", never pre-filled for Ramu |

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
- Workers AI lists it at 9,091 neurons per M input tokens and 27,273 per M output tokens ($0.10/$0.30) **[verified]**. A system prompt, the schema and six few-shot pairs in Tamil script (several tokens per word) come to roughly 1,200–2,000 input and ~150 output tokens, i.e. about 13–22 neurons per call, so roughly **450–750 free calls a day** within the 10,000 free neurons (about 650 at 1,200 input tokens) **[likely: my calculation]**. That is still above the 300/day cap. Measure the real token count on the first prototype call.
- Cloudflare does not train on customer content **[verified]**.
- **Its Tamil quality, and whether it supports `json_schema` on Workers AI, are unverified** (the model page lists `response_format`; JSON mode is not officially listed for Gemma).
- The model ID lives in a variable, `AI_MODEL`. If the model is renamed or fails, the app falls back to parser-only, which must be fully usable.
- Bake-off candidates: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (JSON mode officially listed **[verified]**, weaker Tamil), `gpt-oss-120b`, `qwen3-30b-a3b-fp8`, and paid **`gemini-3.5-flash-lite`** ($0.30 input / $2.50 output per M tokens **[verified: Gemini pricing page]**; paid tier not used for training **[verified]**) or the cheaper `gemini-3.1-flash-lite` ($0.25 / $1.50). Gemini 2.5 models are served only to users who used them before, and Google points new projects to 3.5 Flash-Lite or 3.8 Flash **[verified: deprecations page]**, so a new client project should not plan on 2.5 Flash-Lite. Cost at about 75 calls a day (25% of 300 entries) × 30 days, with 1,200–2,000 input and 150 output tokens per call: about $1.65–2.20, **≈ ₹145–195 a month** for 3.5 Flash-Lite **[likely: my calculation]**.

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
- Choosing between customers with similar names.
- Preselecting a direction under 0.6, on a conflict, from a recipient marker, or for a C1 form on a vowel-final name (unless the owner switched it on).
- Filling in an amount that was not spoken, or picking one of two candidates, within one transcript or across alternatives.
- Inverting a cue's meaning from learned flips.
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
- **Every login creates a `devices` row**, as `/pair` does, and returns the **same `PairResponse` shape** (`token, device_id, role, shop, code_block, server_time, sync_epoch`). That keeps four things intact:
  - authorship through `entries.device_id`;
  - pull skipping the caller's own rows;
  - per-device code blocks;
  - revoke-with-wipe.
- **Web logins get no code block at login** (`code_block` is null). `/pair` reserves `CODE_BLOCK_SIZE` = 50 customer codes per device, and daily shared-computer logins would burn about 18k codes a year and make the visible C-codes jump. The web client calls the existing `/devices/code-block` lazily on its first `createCustomer`. A cron job purges expired web device rows (entries keep `device_id` as text, with no foreign key).
- **The sync engine needs a session mode, not a rewrite.** Today `ApiClient` throws `unpaired` with no token (`api.ts` 184–186), `engine.api()` returns null without a token (`engine.ts` 223–234), every request sets a Bearer header, and every 401 maps to revoked or unauthorized (`api.ts` 133) **[verified]**. Changes: a session-mode flag (cookie mode skips the token check and sends `credentials:'same-origin'` with no Bearer); the new 401 codes `expired`, `idle` and `wrong_transport` go to the login screen and **keep the outbox**, and only `{revoked, wipe:true}` runs the wipe path; a final push before logout; single-flight refresh for web. **Push and pull bodies are unchanged.**
- The server stays single-shop for now: `/setup` only creates the first shop, and `pair_failures` is a global throttle **[verified]**. `memberships` is ready for more shops later.

### 3.3 Passwords: hashing cost

Measured on local workerd (wrangler 4.150, Xeon 2.1 GHz). Production can differ by about 2× **[likely]**.

| Scheme | CPU per hash | Workers Free (10 ms) |
|---|---|---|
| PBKDF2-SHA256 100k (WebCrypto; **below** OWASP's 600k for SHA-256) | 17–24 ms | no |
| PBKDF2-SHA256 600k (WebCrypto, local workerd only; production rejects > 100k, see below) | 90–110 ms | — |
| **argon2id m=19456 KiB, t=2, p=1 (OWASP; `@noble/hashes` 2.4.0, pure JS)** | **190–250 ms** | no |
| argon2id m=7168 KiB, t=5 or m=12288 KiB, t=3 (OWASP rates these equal) | to measure in week 5 | no |
| argon2id WASM build imported statically (bundled by wrangler as a compiled module) | to measure in week 5; likely several times faster than pure JS **[likely]** | unknown |
| scrypt N=2^17, r=8 | 520–600 ms (128 MiB memory risk) | no |
| hash-wasm argon2id | fails: it compiles WASM at runtime, which Workers block; only statically imported, precompiled modules may be instantiated **[verified]** | — |

**PBKDF2 is capped at 100,000 iterations in Workers by design** **[verified, workerd source]**: `src/workerd/io/limit-enforcer.h` sets `DEFAULT_MAX_PBKDF2_ITERATIONS = 100'000`, the check rejects larger counts ("iteration counts above … are not supported"), and the source comment calls this "*WAY* below the recommended minimum" (https://github.com/cloudflare/workerd/blob/main/src/workerd/io/limit-enforcer.h). A 600k run succeeded in the repo's local workerd, so local dev does not enforce the default; production should be assumed to enforce it.

**Decision: argon2id on Workers Paid**, either a statically imported WASM build or `@noble/hashes`, whichever the week-5 bake-off on the deployed Worker shows is faster, at the OWASP setting the CPU budget allows.
- Store a PHC string: `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>` (or the lower-memory equivalent).
- Rehash at the next login if the parameters are raised.
- Apply HMAC with a **separate** secret `PW_PEPPER`; never reuse `PEPPER`.
- **Bound memory:** each hash uses 19 MiB (7–12 MiB at the lower-memory OWASP settings), against a 128 MB isolate limit. Allow at most 2 concurrent hashes per isolate (a semaphore); beyond that, return `503 busy, retry`.
- **Measure** CPU and memory on the deployed Paid Worker in week 5 before committing.
- **Cost:** about 200 ms × 100 logins a day is about 0.6 M CPU-ms a month, against 30 M included **[verified allowance]**.
- **Fallback:** WebCrypto PBKDF2 is at most 100k iterations, one sixth of OWASP's 600,000, so it is **not** an acceptable fallback. The real fallbacks are argon2id at the lower-memory OWASP setting (m=7168 KiB, t=5, or m=12288 KiB, t=3), or Firebase Authentication doing the hashing (3.8b).
- **Password policy:** at least 10 characters, a bundled blocklist of the ~1,000 most common passwords, no forced complexity. Passwords the owner issues are temporary (`must_change_pw=1`).
- **Login id for people who do not type English:** either a 10-digit **mobile number** (typed on the number pad) or `[a-z0-9._]{4,32}`. The owner issues staff credentials. Login screens are Tamil first. Staff who cannot type Latin letters at all use Google sign-in, or a pair code / QR shown on the owner's phone (the existing pairing, kept for this).

### 3.4 Google Sign-In (works on the Free plan; under 1 ms CPU [likely])

- **Android:** `@capgo/capacitor-social-login` 8.x, which uses Credential Manager. 8.7.0 came out 2026-10-17; pin the newest release at least 2 weeks old (today 8.5.12 of 2026-09-30 **[verified: npm]**) after confirming it has the Google `scopes` option and Android `accessToken`. Use the **web** client ID as the server client ID, plus a server nonce **[verified]**. Avoid `@codetrix-studio/capacitor-google-auth`: it peers on Capacitor 6 and is abandoned **[verified]**.
- **Web:** a Google Identity Services button with FedCM, using the JS callback. The ID token is POSTed to the same origin.
- **Worker:** `jose` 6.2.12 with `createRemoteJWKSet('https://www.googleapis.com/oauth2/v3/certs')` checks **[verified]**:
  - the signature against the JWKS;
  - `aud` = the web client ID;
  - `iss` ∈ {`accounts.google.com`, `https://accounts.google.com`};
  - `exp` not passed;
  - `email_verified` true;
  - the nonce is a valid, unexpired HMAC from `/auth/nonce` (stateless, 5-minute expiry) that is not yet in `used_nonces`; it is recorded there only after the token verifies.
- **Linking:** by `sub`, never by email. **No auto sign-up.** A Google account works only after the owner links it from a signed-in device (with step-up, 3.7), or a staff member redeems an **invite code or QR** the owner created (single use, stored hashed, 48 h TTL) while signed in with Google. The link is made by `sub`; the Google email is never matched against an invited address.
- **Google Cloud setup ($0, in the shop's Google account):**
  - consent screen with `openid email profile` (plus `drive.file` in phase C);
  - a web client ID;
  - Android client IDs for the debug, upload **and Play App Signing** SHA-1s.
  - **Publishing "In production" (phase B task, needed before phase C):** an external production app needs homepage, privacy-policy and terms links on **authorized domains verified in Google Search Console**, and brand verification for the app name and logo to appear on the consent screen **[verified: Google Cloud help 15549049]**. The Worker serves `/privacy`, `/terms` and a homepage. Whether a `*.workers.dev` subdomain can be verified for this is unverified (it is on the Public Suffix List, so it may work, but forum threads report a missing "Verify branding" button), so **budget a custom domain as likely required**. Until verification passes, the share-sheet backup stays the backup path.

### 3.5 Sessions = device rows

**Tokens:** opaque, stored as `sha256(token‖PEPPER)` as today, not JWTs. Every request already does one D1 round trip for the daily cap and `last_seen`, so a JWT saves nothing and delays revocation.

| Client | Absolute expiry | Idle timeout | Rotation |
|---|---|---|---|
| Android (`kind='app'`) | none (as today) | 90 days | **none**: a 256-bit token in the Keystore, with idle expiry and remote revoke |
| Web, "my computer" | 30 days | 7 days | every 24 h, with a grace window |
| Web, "shared computer" | 12 h | 30 min of **user activity** | none (the session ends first) |

**No rotation for app tokens.** RFC 9700's rotation with reuse detection (§2.2.2, §4.14.2 **[verified]**) targets OAuth refresh tokens, not this design. On Android it would do harm: push and pull requests overlap, and if MIUI kills the app between the server rotating and `secretSet(TOKEN_KEY)` running (`engine.ts` line 604), the new token is lost and the next use of the old one would revoke the shop's ledger-of-record phone.

**Web rotation with a grace window:**
- The new hash goes in `token_hash`; the old one moves to `prev_token_hash` with `rotated_at`.
- The old token is accepted **any number of times** for 120 s, because the sync engine's push and pull, a refresh still in flight and two tabs refreshing at once all present it more than once.
- Refresh is single-flight across tabs (`navigator.locks`, or `BroadcastChannel` where locks are missing).
- Only a use of the old token **after** the grace window counts as theft: it revokes the device and writes an `auth_events` row.
- `auth.ts` lookup: `WHERE token_hash = ?1 OR (prev_token_hash = ?1 AND rotated_at > now − 120 s)`. Today it is only `WHERE token_hash = ?` **[verified]**.

**Idle = user activity, not polling.** Every authenticated request bumps `last_seen_at` today (`auth.ts` UPDATE), so background sync would keep an abandoned shared-PC session alive until the 12 h expiry. A new `last_active_at` is updated only by writes and by requests carrying an `X-User-Activity: 1` header that the UI sets on user-initiated actions; background sync never extends it. The web client also runs its own idle timer that logs out (after the final push) and wipes.

**Transport binding:** app tokens are accepted only as `Authorization: Bearer`; web tokens only from the `__Host-kk_s` cookie (`HttpOnly; Secure; SameSite=Strict; Path=/`).

**Middleware** (`auth.ts`):
- Look the token up **by hash first**, then compare `kind` with the transport.
- A mismatch is not "not found". It returns `401 wrong_transport` and writes an audit event.
- A **web cookie token seen as a Bearer also revokes that device**, because an HttpOnly cookie should never be readable by script.
- Expiry and idle checks join the existing `UPDATE … RETURNING`, so it stays one D1 round trip.

**What a web session may not do.** Owner web sessions are the most powerful sessions there are, and a passer-by or an XSS bug could otherwise mint an owner pair code or read plaintext recovery codes (which never expire) and pair a phone with permanent owner access. So `kind='web'` sessions are **refused** on `/devices/pair-code`, `/devices/recovery-codes`, `/account/claim`, `/account/google*`, `/users/*` and `/devices/:id/revoke`. These run only from an app device, or, for "my computer" only, after a fresh-password step-up within the last 5 minutes. The static assets ship a strict CSP through Workers `_headers`: `script-src 'self' https://accounts.google.com/gsi/client; frame-ancestors 'none'` (plus the matching `connect-src`/`frame-src` for GIS).

**Storage:**
- Android: the existing Keystore storage (`@aparajita/capacitor-secure-storage` 8.0.1).
- Web: the cookie only, never localStorage. `platform/web.ts` `secretSet` must not hold the session.

**CSRF, as it actually works:** Hono's `csrf()` (4.13.13) checks Origin and `Sec-Fetch-Site` only for form-type, `text/plain` or missing content types; it does nothing for `application/json` **[verified: hono source]**. The real defence is layered: `SameSite=Strict`; for cookie-authenticated requests the server rejects any non-GET whose `Content-Type` is not `application/json` **and** checks `Origin` against the Worker's own origin explicitly; and `Access-Control-Allow-Credentials` is never sent.

### 3.6 Throttling, reset, recovery

**Throttling:**
- `LOGIN_LIMITER`: a Workers Rate Limiting binding, 10 per 60 s per IP, on `/auth/login`, `/auth/google`, `/auth/recover` **and `/auth/nonce`**. It is best effort, per location **[verified]**.
- `login_throttle` keyed on **(login id, IP /24 or ASN)**: after 5 failures, a 30 s wait that doubles up to 15 min, reset on success. Keying on the login id alone would let one guess every 15 minutes from rotating IPs hold the owner out forever. **Requests that carry a valid "known device" token** (a signed cookie or app value set after a previous successful login on that device, the OWASP device-cookie pattern) **are exempt** from this backoff. **No permanent lockout.**
- A global cap of 3,000 password verifications a day (about 10 CPU-minutes) bounds the bill under attack, but it applies **only to unknown or failing sources**, never to logins from known devices, so an attacker cannot deny the owner's own login until 05:30 IST.
- **No unauthenticated row writes for strangers:** `login_throttle` rows are written only for login ids that exist; `/auth/nonce` is stateless (below). On the Free plan (the ₹0 path) D1 allows 100k row writes a day, and a script that used them up would stop device auth and sync for the whole shop until 00:00 UTC.
- Malformed requests are rejected before any hashing. An unknown user and a wrong password get the same `invalid_credentials` error, and an unknown user runs a **dummy verify** against a fixed hash so timing does not reveal which ids exist. (Login ids are still not treated as secret.)

**Reset without email:**
- **Staff:** the owner sets a temporary password; `must_change_pw=1`; all of that user's devices are revoked in the same batch.
- **Owner, forgot password, still signed in on a phone:** `/account/password` requires the current password **or** a fresh app-PIN/biometric check on that phone (the existing app PIN). So an unlocked phone alone cannot take over the account, and the ordinary forgot-password case still has a simple path.
- **Owner, signed out everywhere:** `POST /auth/recover {recovery_code, login_id, new_password}` uses a printed recovery code, which is consumed. A linked Google account also works.
- **Owner lost the phones, the printed codes and has no linked Google (break-glass):** the developer verifies the owner's identity offline (in person or a video call, with shop documents), then issues a one-time setup/recovery code with a documented `wrangler d1 execute` script that inserts a hashed, 24 h, single-use code and writes an `auth_events` row (`type='break_glass'`). The data is still in D1, so nothing is lost. The script lives in `khata/api/scripts/` and is described in the API README.
- **Email reset is v3.** Cloudflare Email Sending is beta **[verified]**, Resend's free tier needs a domain, and staff often have no email.

### 3.7 Endpoints (`/v1`) and migration from pairing

| Method & path | Auth | Purpose |
|---|---|---|
| POST `/auth/nonce` | none + limiter | stateless `{nonce}` for Google: `HMAC(NONCE_SECRET, random‖expiry)`, nothing written; single use is enforced by inserting into `used_nonces` **only after** a Google token verifies |
| POST `/auth/login` | none + limiter | `{login_id,password,device_name,kind,persist?,previous_device_token?,max_local_code?}` → `PairResponse` (web: token in Set-Cookie, no code block) |
| POST `/auth/google` | none + limiter | `{id_token,nonce,…}` → `PairResponse` |
| POST `/auth/recover` | recovery code + limiter | owner resets own password → `PairResponse` |
| POST `/auth/refresh` | web session | rotate (web only; app tokens do not rotate) |
| POST `/auth/logout` | session | **pushes first**: refused with `409 outbox_not_empty` (and the count) while the client reports unsynced entries; then revokes this device. Web gets `Clear-Site-Data: "cache","storage"` only after that successful final push |
| GET `/me` | session | now includes `user` |
| POST `/account/claim` | app session + **step-up** | create a login from a paired device. Owner: requires a printed recovery code or approval from another owner device. Staff: creates a **pending** membership that the owner approves in Settings → Users |
| POST `/account/password` | session + **step-up** | current password, or a fresh app-PIN/biometric check on an app device (3.6) |
| POST `/account/google`, POST `/account/google/unlink` | app session + **step-up** | link / unlink Google (POST, not DELETE: the CORS `allowMethods` in `index.ts` lack DELETE **[verified]**, and the Android app's origin `https://localhost` would fail preflight) |
| GET/POST `/users` · PUT `/users/:id/role` · POST `/users/:id/reset-password` · POST `/users/:id/disable` · POST `/users/:id/approve` · POST `/invites` | owner, app session | staff management and invite codes; role change, reset and disable update or revoke that user's devices in the same batch |
| GET `/devices`, POST `/devices/:id/revoke` | owner, app session | existing; now also lists web sessions with the user's name. **Revoking a device that has a `user_id` offers "also disable this login / unlink Google"**, on by default when the reason is "lost phone", so a thief who claimed or linked first cannot log back in |
| POST `/voice/interpret`, POST `/stt` | session | phase D only |
| `/pair`, `/devices/pair-code`, `/devices/recovery-codes`, `/sync/*`, `/export` | existing | unchanged, except that pair-code and recovery-codes refuse `kind='web'` (3.5) |

**New credentials are visible:** every claim, password set, Google link or unlink, approval and break-glass writes `auth_events`, and owner devices show them in Settings → Users ("Kumar linked a Google account on Redmi 12, 18 Oct 14:02").

**Migration from pairing (no re-pairing):**
1. Existing devices keep `user_id NULL` and keep working.
2. On the owner phone, Settings → **Create login** → `POST /account/claim`, authenticated with the existing bearer token **plus a printed recovery code** (step-up). This creates the user and the owner membership, and sets `devices.user_id`.
3. The owner creates staff. Each staff phone either claims (pending until the owner approves) or logs in. **Revoking the old row on login needs proof, not an id:** device ids are visible to every phone through pull, and today's `/pair` predicate (`api/src/routes/public.ts`) revokes any same-or-lower-role device whose id is passed and moves its unused codes. So a login revokes and takes over a previous device only if (a) that device's `user_id` equals the logging-in user, or (b) for a legacy device (`user_id NULL`), the request carries that device's **old bearer token** (`previous_device_token`, hashed and compared server-side).
4. Later, a shop setting `pairing_enabled=0` can switch off 8-digit codes. Recovery codes stay.

**D1 migration `api/migrations/0002_accounts.sql`:**

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  login_id TEXT UNIQUE COLLATE NOCASE,          -- 10-digit mobile or [a-z0-9._]{4,32}; NULL if Google-only
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
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active')),
  created_at TEXT NOT NULL, created_by TEXT, removed_at TEXT,
  PRIMARY KEY (user_id, shop_id)
);
ALTER TABLE devices ADD COLUMN user_id TEXT REFERENCES users(id);  -- NULL = legacy paired device
ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'app';   -- 'app' | 'web'
ALTER TABLE devices ADD COLUMN expires_at TEXT;
ALTER TABLE devices ADD COLUMN idle_timeout_min INTEGER;
ALTER TABLE devices ADD COLUMN prev_token_hash TEXT;
ALTER TABLE devices ADD COLUMN rotated_at TEXT;
ALTER TABLE devices ADD COLUMN last_active_at TEXT;                -- user activity only (3.5)
CREATE INDEX devices_user ON devices(user_id);
CREATE UNIQUE INDEX devices_prev_token ON devices(prev_token_hash) WHERE prev_token_hash IS NOT NULL;
CREATE TABLE login_throttle (login_key TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, next_allowed_at TEXT);
CREATE TABLE used_nonces (nonce_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);  -- written only after a verified Google token
CREATE TABLE invites (code_hash TEXT PRIMARY KEY, shop_id TEXT NOT NULL, role TEXT NOT NULL,
  created_by TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, used_by TEXT);
CREATE TABLE auth_events (id TEXT PRIMARY KEY, shop_id TEXT, user_id TEXT, device_id TEXT,
  type TEXT NOT NULL, at TEXT NOT NULL);       -- login, claim, approve, password, google_link, google_unlink,
                                               -- refresh_reuse, wrong_transport, revoke, reset, break_glass
CREATE TABLE voice_usage (shop_id TEXT NOT NULL, day TEXT NOT NULL, stt_ms INTEGER NOT NULL DEFAULT 0,
  llm_calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (shop_id, day));
```

**`shared/protocol.ts` additions:** `LoginRequest`, `GoogleLoginRequest`, `LoginResponse = PairResponse` (with `code_block` nullable for web), `MeResponse.user`, `DeviceInfo.kind` and `user_name`, `ShopInfo.voice_meanings` / `ShopUpdateRequest.voice_meanings` (2.2 rule 10), the new 401 codes `expired`, `idle`, `wrong_transport`, and (phase D) `VoiceInterpretRequest/Response`. **Sync push and pull bodies are unchanged.**

### 3.8 The ₹0 fallback (if the client refuses $5/month)

**(a) Google sign-in plus pairing and recovery codes, no passwords, on Workers Free.** `jose` RS256 verification plus the D1 batch should fit in 10 ms CPU **[likely]**. **Measure it on a deployed Free Worker before promising ₹0.** Even then, Workers Paid is recommended at go-live to remove the daily request caps (100k requests/day; D1 100k row writes/day **[verified]**).

**(b) Firebase Authentication as the identity provider**, in a Spark project owned by the shop's Gmail. It is free: 100 sign-ups per IP per hour and 150 reset emails a day on Spark **[verified]**; the 3,000 DAU limit is stated for "Firebase Authentication with Identity Platform" **[verified]**, and no idle pause is documented **[likely]**. Google does the password hashing.

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
- **Every remove, reset or disable revokes that member's D1 devices with `wipe`** in the same batch, and the auth middleware's existing lookup also checks membership status (app tokens do not refresh, 3.5). This matters because Firebase changes do not reach device tokens.
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
- A custom domain (about $10/year, unverified) is **likely required** in practice: Google's production consent screen needs verified authorized domains and brand verification (3.4), which may not work on `workers.dev`.

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

**Never lose unsynced entries on the web:** every web write is pushed immediately; a `beforeunload` warning appears while the outbox is not empty; and logout is **blocked** while it is not empty ("3 entries not synced: stay online"), because in shared mode closing the tab before the push loses money.

On logout (after the final push succeeds):
- the device is revoked and the server sends `Clear-Site-Data`;
- the client also deletes IndexedDB, Cache Storage and any private files;
- the owner can revoke a forgotten browser from the phone, and the existing `{revoked, wipe:true}` 401 wipes it on its next request.

**v2 web is owner-only.** Staff use the phone app; staff web logins come later, which keeps the attack surface small. When they come, staff sessions **default to shared-computer (memory-only) mode**, or use a staff-scoped pull, so a staff member's home PC never stores the whole ledger (names, phone numbers, balances) in IndexedDB.

| Feature | Android | Web |
|---|---|---|
| Ledger of record | yes | no: a synced client |
| Speech | native Google recogniser | Web Speech: Chrome tested; Edge/Safari after a Tamil smoke test |
| Secret storage | Keystore | HttpOnly cookie |
| Local data | permanent | evictable; in memory in shared mode |
| Lock | existing app PIN | short idle timeout (user activity) |
| Owner-only actions (pair codes, recovery codes, users, revoke) | yes | refused for web sessions (3.5) |
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
   - **No Google refresh token is ever stored on the server.** Refresh tokens expire after 7 days while the consent screen is in "Testing" **[verified]**, so publish the consent screen "In production", which needs the privacy-policy, terms and homepage pages, Search Console domain verification and brand verification from 3.4 (in practice a custom domain).
   - **Restore:** Settings → Restore from Drive: list, decrypt, import through `ui/backup.ts`.
   - **Open technical point (partly answered):** Credential Manager returns only an ID token, but the Capgo social-login README documents a Google `scopes` option and an Android `accessToken` obtained through `AuthorizationClient`, which "may be null on Android when Credential Manager authentication succeeds but AuthorizationClient does not return an access token" **[verified: README]**. **Week-6 spike:** confirm the pinned `@capgo/capacitor-social-login` returns a `drive.file` access token on the client's Redmi phones. Until it works, the share-sheet path is the guaranteed one.
3. **Ownership:** the shop's Gmail (2-step verification on, recovery phone = owner) owns the Google Cloud project and OAuth client, the Drive folder, the Cloudflare account and its billing. The developer is added as a member.

**Live data in Google (Firestore): not now.**
- It would be a 4–6 week rewrite of `app/src/sync/*` and all of `khata/api` **[likely]**.
- Transactions fail offline **[verified]**, so server-side customer-code allocation and the reversal-race checks would be lost.
- Cloud Functions need Blaze **[verified]**.
- One full-history login can use up 50k reads/day **[verified quota]**.
- Its one real advantage is the `asia-south1` (Mumbai) region **[verified]**. DPDP has no localisation mandate **[likely; confirm with counsel]**, so that advantage matters only if India residency becomes a requirement. Offer it as v3.

**Supabase pause analysis:**
- "Free projects are paused after 1 week of inactivity" **[verified]**. Inactive means insufficient activity; the page says dashboard visits or API calls can count.
- A shop that syncs daily usually stays active. A festival or family closure pauses it, and then **auth and sync stop on every device** until someone restores it from the dashboard; a paused project can be restored for up to 1 year **[verified]**.
- A scheduled ping (an external cron calling the API) is therefore close to sanctioned, but the free plan would still have no backups, and a money ledger should not depend on a keep-alive job.
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
| Sarvam STT (phase D, if needed) | ₹100 signup credits **[verified: docs pricing page]** (the website has said ₹1,000) | ₹30/hour billed per second = ₹0.50/min **[verified]** ≈ ₹50–300/month as primary; ₹5–30 as fallback | Sarvam pricing |
| LLM (phase D, if needed) | Workers AI 10k neurons/day ≈ 450–750 calls (cap 300) **[likely]** | ₹0, or paid `gemini-3.5-flash-lite` ≈ ₹145–195/month **[verified prices, likely total]** | Workers AI / Gemini pricing |
| Google Cloud STT (alternative) | 60 free min/month, **V1 API only** **[verified]** | V2 about $0.016/min **[likely]** ≈ $9–10/month at 300/day; Tamil `chirp_2`/`chirp_3` only in some locations (`asia-southeast1`, `eu`, `europe-west4`) **[likely: languages page]** | GCP free features / STT languages |
| Custom domain | likely required for a verified Google consent screen (3.4) | ≈ $10/year (unverified) | — |
| **Total** | **₹0** (Google login + pairing only; share-sheet backup) | **≈ ₹440/month + ≈ ₹70/month domain**, + ₹0–300 only if Sarvam is needed | |
| Supabase Pro (rejected) | pauses | $25 ≈ ₹2,200/month | Supabase pricing |

---

## 6. Changes to the existing codebase

**`khata/app`**

| File | Change |
|---|---|
| `src/core/voice.ts` (new) | `normalize`, `tokenize` (no folding of digits), `parseAmount`, `segment`, `scoreDirection`, `buildCustomerIndex`, `matchCustomer`, `parseVoice` |
| `src/core/voice-lexicon.ts` (new) | the lexicon (2.2) with explicit forms and per-row suffix lists, keys generated from both scripts, C1/C2 classes; number words; stop and item words |
| `src/core/ledger.ts` | export a `levenshtein` helper; add a comment on `phoneticFold` warning that it mangles digits (no behaviour change) |
| `src/platform/stt.ts`, `stt-native.ts`, `stt-web.ts`, `stt-server.ts` (new) | engine interface (1.2); `stt-server` in phase D |
| `src/platform/types.ts`, `index.ts`, `native.ts`, `web.ts` | `stt` and mic permission; web: cookie session, in-memory DB and **memory-only `writePrivateFile`** for shared computers, wipe on logout |
| `src/main.ts`, `src/ui/backup.ts` | skip `snapshotIfDue` and backup copies in shared-computer mode |
| `src/ui/components/mic.ts` (new) | hold-to-talk button, listening sheet, partial text, permission flow, session tied to the route (abort on leave/pause) |
| `src/ui/voice-flow.ts` (new) | STT → parse → (LLM) → picker overlay / "open Sita?" / add new / list → navigation; drops late results |
| `src/ui/save-checks.ts` (new) | `preSaveChecks` (big amount, advance, `recentDuplicate` with a window), shared by `entry.ts` and `voice-pick.ts` |
| `src/ui/screens/voice-pick.ts` (new) | multi-entry list card (due before → after per row; ids generated at build; one-transaction Save all; button disabled while saving) |
| `src/ui/screens/voice-test.ts` (new) | 60-prompt accuracy test (section 8) |
| `src/ui/screens/entry.ts` | read `amount`, `note`, `date`, `voice`, `from`; voice banner (code/phone shown when names are similar); `kind` may be null (Save disabled, and `save()` returns early so Enter cannot save); use `preSaveChecks`; after save from Home voice, `backTo('home')` + `go('customer',{id})`; write `voice_log` |
| `src/ui/screens/customer-edit.ts` | pass-through params (`amount`, `kind` or none, `note`, `date`, `voice`, `from`); create and same-name branches forward them to `entry` with no hard-coded GIVE; spoken name highlighted for checking, "Did you mean …?" |
| `src/ui/router.ts`, `src/ui/app.ts` | add `voice-pick`, `voice-test`, `login` to `RouteName` and register the screens |
| `src/ui/screens/home.ts`, `customer.ts`, `quick.ts` | mount the mic (Home: bottom centre, FAB unchanged); the customer page passes `currentCustomerId` |
| `src/ui/screens/login.ts` (new) | Tamil first; mobile number or user id + password, Google, "Pair with code" / QR, my/shared computer choice |
| `src/ui/screens/settings.ts` | Voice (on/off, engine, AI help, onboarding questions, "Preselect Credit for kuduthaachu", cue meanings, Reset voice learning, spoken read-back, Voice test, stats, privacy text), Create login, Users (approvals, credential events), Linked Google, Drive backup and restore |
| `src/data/repo.ts`, `types.ts` | `addEntries` (one transaction, caller-supplied ids); multi-row reversal in one `db.transaction`; erase also deletes `voice_log` / `voice_alias` rows for the customer |
| `src/backup/drive.ts` (new, phase C) | encrypt, upload, rotate, list, restore |
| `src/db/schema.ts` | local-only tables (below), never synced |
| `src/sync/api.ts`, `src/sync/engine.ts` | `login`, `loginGoogle`, `refresh`, `logout`, `claim`; same token storage as `pair`; cookie session mode (no token check, `credentials:'same-origin'`); new 401 codes go to login and keep the outbox; final push before logout; single-flight web refresh |
| `src/i18n/ta.ts`, `en.ts` | voice, login and backup strings |
| `android/app/src/main/AndroidManifest.xml` | `RECORD_AUDIO` permission; `RecognitionService` `<queries>` |
| `patches/@capgo+capacitor-speech-recognition+<pinned>.patch` | `EXTRA_BIASING_STRINGS` (kept only if the A/B test shows a gain), confidence scores and installed-language reporting if the plugin lacks them; regenerated on every reviewed bump |
| `package.json` | `@capgo/capacitor-speech-recognition` and `@capgo/capacitor-social-login` pinned exactly to releases at least 2 weeks old (today 8.3.2 and 8.5.12), `vite-plugin-pwa@2.0.0`, `patch-package` |
| `vite.config.ts`, `public/_headers` | `web` target → `dist-web` with PWA; strict CSP |
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

**`khata/api`**

| File | Change |
|---|---|
| `migrations/0002_accounts.sql` (new) | DDL in 3.7 |
| `src/lib/password.ts` (new) | argon2id hash/verify/`needsRehash`, pepper, per-isolate semaphore |
| `src/lib/google.ts` (new) | `jose` JWKS verification, nonce issue/consume |
| `src/lib/devices.ts` (new) | the device-insert + code-block batch moved out of `/pair`, shared by `/pair` and logins |
| `src/lib/auth.ts` | lookup by hash (or `prev_token_hash` within the grace window), then transport check; expiry, idle on `last_active_at`; web-only rotation and reuse; refuse owner-power routes for `kind='web'` |
| `src/routes/auth.ts`, `account.ts`, `users.ts` (new) | endpoints in 3.7, step-up checks, pending memberships, invites, proof-of-possession for `previous_device_token` |
| `src/routes/shop.ts` | `voice_meanings` in `PUT /shop` |
| `scripts/break-glass.sh` (new) | developer-run one-time owner recovery code (3.6), documented in the API README |
| `src/routes/voice.ts` (new, phase D) | `/voice/interpret` (Workers AI binding `AI`, schema, cap), `/stt` (Sarvam) |
| `src/routes/public.ts` | `/pair` uses `lib/devices.ts` |
| `src/index.ts` | JSON-only + explicit Origin check for cookie requests (3.5), assets, new routers, scheduled handler (R2 export, expired web device purge), `/privacy`, `/terms` |
| `src/env.ts`, `wrangler.jsonc` | `assets`; `LOGIN_LIMITER` (namespace 1002); `r2_buckets`; `triggers.crons`; vars `GOOGLE_WEB_CLIENT_ID`, `AI_MODEL`, `VOICE_DAILY_CAP`; secrets `PW_PEPPER`, `NONCE_SECRET` (+ `SARVAM_KEY` and the `ai` binding in phase D) |
| `package.json` | `jose@^6.2`, `@noble/hashes@^2.4` (or a statically imported argon2id WASM build, per the week-5 bake-off) |
| `test/auth.test.ts` (existing: health, setup, pairing; extended), `accounts.test.ts`, `google.test.ts`, `users.test.ts`, `voice.test.ts` (new) | section 8 |

---

## 7. Milestones (each one ends in a demo)

**Phase A: voice on Android, no new server code**

| Week | Work | Demo |
|---|---|---|
| 1 | Commit the scratch prototype and its fixtures; `core/voice.ts` built from it: lexicon with exact forms, numbers (teens, N nooru, digit × multiplier, kaal/mukkaal), segmentation, matcher, marker/C1/C2 caps, cross-alternative conflicts; 150+ fixtures; digit-fold guard; both number property tests; `preSaveChecks` extracted | `vitest` passes every row of 2.5, scoring customer as well as kind and amount |
| 2 | Manifest fix, Capgo plugin (pinned), mic on the **customer page** with name-span check, entry params, voice banner, null-kind state; test on the client's Redmi phones: permission, offline (`isOnDeviceRecognitionAvailable`), **mid-sentence pauses** (`continuousPTT` vs auto-endpoint), **number of alternatives and confidence scores for `ta-IN`** | On Ramu's page: "100 kuduthaan" → Credit ₹100 pre-filled → Save → Undo; a report of alternatives per utterance |
| 3 | Mic on Home and Quick; picker overlay, add new via `customer-edit` pass-through, multi-entry card (`addEntries`), `voice_log`, aliases, onboarding questions (synced via `PUT /shop`), demote-only learning, biasing patch (A/B ready); Web Speech in the browser preview | "Ramu 100 kuduthaachu" from Home → confirm (one tap on the suggested Credit) → lands on Ramu's page |
| 4 | **Voice test + gate run in the shop** (quiet and busy hours, owner and staff) | Accuracy report against section 8, including the dative-drop rate that decides whether "Preselect Credit for kuduthaachu" may be offered. Pass: voice on by default. Fail: "beta, customer page only", and phase D starts |

**Go/no-go before phase B:** the client confirms that browser access or login-based recovery will actually be used, and accepts Workers Paid or the ₹0 path.

**Phase B: accounts and web**

| Week | Work | Demo |
|---|---|---|
| 5 | Migration 0002, `lib/devices.ts`, password + throttle, login/claim (step-up)/users/invites routes, proof-of-possession on device takeover, tests; Workers Paid on; argon2id bake-off (static WASM vs `@noble/hashes`, OWASP settings) measured on the deployed Worker; privacy, terms and home pages served from the Worker; custom domain and Search Console verification started | Owner phone claims an account with a recovery code; a staff login is approved and works on a second phone; sync unchanged |
| 6 | Google sign-in (Android + web), web rotation with grace window, logout (push first) and wipe, Settings → Users with credential events, revoke-also-disables-login; brand verification submitted; **spike: does the pinned social-login plugin return a `drive.file` access token on the Redmi phones?** | Owner signs in on a new phone with Google; remotely revokes a lost staff phone and its login |
| 7 | Web build on Worker assets, PWA, cookie session, CSP, owner-power routes refused for web, shared-computer mode (no local copies), web voice with smoke test; owner-only | Same ledger on a laptop in Chrome; logout is refused while unsynced; shared-mode logout leaves nothing behind |

**Phase C: backup**

| Week | Work | Demo |
|---|---|---|
| 8 | Encrypted daily Drive upload (key in Keystore, or unencrypted by owner choice), monthly CSV, rotation, restore, R2 cron, final privacy text; consent screen "In production" once verification passes | Backup visible in the owner's Drive; a wiped phone restores from it |

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
  - the customer page with a different spoken name ("Sita 100 kattiyaachu" on Ramu's page);
  - bare kuduthaachu before onboarding is never preselected, and a test that **every lexicon form resolves to its own row** (no `kututa`+"su" match);
  - a flip-sequence fixture proving learning never yields an inverted preselect;
  - Tamil number words (teens, N nooru, unit × aayiram, kaal/mukkaal, "2 ஆயிரம்", இலட்சம்/லட்சம்), corrections, multi-entry, items with quantities, balance questions, same-name customers (no alias stored), and lexicon-collision names.
  A lexicon change must not lower any metric.
- **Property tests:**
  - **spoken Tamil words:** a separate generator spells every amount from 1 to 99,999 rupees in pure Tamil number words (spoken and literary variants, fused forms such as irubathanju, teens, combining forms -thi/-thu, -arai, colloquial "N nooru"), in Tamil script and Tanglish; `parseAmount` must read each back exactly;
  - **hybrid format (weaker, kept as a second test):** `parseAmount` reading `amountInWords(paise,'ta')` back. That function prints digits with multiplier words ("1 ஆயிரம் 500 ரூபாய்", "2 இலட்சம் 50 ஆயிரம் ரூபாய்") **[verified: ran `ledger.ts`]**, so it does not exercise nooru, ainooru or aayirathu;
  - lexicon keys: each Tamil/Latin pair folds to the same key or is listed twice;
  - digit tokens are never folded;
  - any amount the parser outputs appears in the transcript.
- **UI:**
  - voice params pre-fill the entry screen;
  - Save is disabled while kind is null, **and the Enter key does nothing**;
  - Home voice lands on the customer page after Save, with Back going to Home (stack [home, customer]);
  - a late recognition result after navigating away does nothing;
  - "Save all" runs `preSaveChecks` per row, writes all rows in one transaction, and a retry after a failure creates no duplicates; Undo after "Save all" reverses every row in one transaction;
  - no match → `customer-edit` → entry keeps amount and kind (or none);
  - a web logout with a non-empty outbox is refused.
  - A Playwright E2E on the web preview injects transcripts through a fake `SttEngine` and asserts that **nothing is saved without a click**.
- **API:**
  - unknown user and wrong password give the same response and similar timing;
  - throttle back-off keyed on (login id, network); a known device is exempt; no rows written for unknown login ids; `/auth/nonce` writes nothing;
  - Google tokens with a wrong `aud`/`iss`, an expired token, nonce reuse;
  - web refresh: the old token works within 120 s (concurrent use), reuse after it revokes; app tokens never rotate;
  - a cookie token used as a Bearer gives `wrong_transport` and a revoke;
  - web sessions are refused on pair-code, recovery-codes, claim, account/google, users and revoke;
  - claim, password change and Google link need step-up; a staff claim stays pending until approved;
  - login with another user's `previous_device_id` revokes nothing; a legacy device is taken over only with its old token;
  - CSRF: a cookie request with a non-JSON content type or a foreign Origin is rejected;
  - a role change or disable revokes devices; revoking a lost device can also disable its login;
  - `/auth/recover` is rate-limited; the break-glass code is single use;
  - phase D: schema failure falls back, refs that were never sent are rejected, an invented amount is rejected, the daily cap holds.
- The existing sync and integration suites must pass unchanged.

**Field gate (Settings → Voice test, week 4)**
- 60 prompts generated from the **real** customer list: a random customer, an amount (digits, round Tamil numbers and compound numbers) and a phrasing style. Some prompts ask her to **pause in the middle** ("Ramu… 100 kuduthaachu").
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
| Customer top-1 / top-3 | ≥ 90% / ≥ 98% |
| Direction accuracy end to end; coverage (preselected) | ≥ 95%; ≥ 80% |
| Same-name cases sent to the picker | 100% |
| Latency, release → confirmation screen | median ≤ 1.5 s, p90 ≤ 3 s |
| No-result rate | ≤ 5% |
| Phase D LLM: call rate; p95 | ≤ 25%; < 2.5 s (parser < 50 ms) |

**In production:** Settings → Voice stats (local) shows:
- edits after voice pre-fill, by field, and "amount differs across alternatives" / "direction conflict" counts;
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
| A dropped or added "-க்கு" flips the direction | Marker cap 0.55; C1 guard on vowel-final names (Credit only suggested); due before → after; optional spoken read-back; big toggle; Undo. The cross-alternative conflict check counts as a net only once week-2 logs show `ta-IN` returns several alternatives (unverified; often one) |
| A misheard verb ending (kuduthen/kuduthaan, vaanginen/vaanginaan) flips the direction | C2 rule: preselect only when all alternatives agree and the recogniser score is high; stratified field test |
| Recognition errors teach the wrong meaning | Learning only demotes to "ask"; inversion only by an explicit owner setting; Reset voice learning |
| "kuduthaachu" or English "credit" means the opposite in this shop | Onboarding questions synced as a shop setting; bare forms start capped |
| The recogniser cuts the sentence at a pause | Week-2 test of `continuousPTT` vs auto-endpoint; sheet asks for the missing amount |
| Two Ramus / rare names | Mandatory picker on ties; spoken disambiguators; local aliases |
| No Google speech service, or offline | Mic hidden or a clear message; keypad always there |
| Biasing patch does nothing for Tamil (unverified) | A/B; drop it |
| Workers AI model renamed; Gemma's Tamil weak (unverified) | `AI_MODEL` variable; parser-only works on its own; bake-off list |
| argon2id CPU/memory differs in production [likely ±2×] | Week-5 bake-off (static WASM vs pure JS); semaphore; daily cap; lower-memory OWASP setting; Firebase Auth fallback |
| WebCrypto PBKDF2 capped at 100k iterations in Workers **[verified, workerd source]**, below OWASP's 600k | Not used for passwords; argon2id primary, Firebase Auth as fallback |
| Unauthenticated requests exhaust the Free plan's 100k D1 row writes/day, stopping auth and sync | Stateless nonce; throttle rows only for real login ids; limiter on `/auth/nonce`; Workers Paid recommended |
| Login lockout or global-cap denial of service against the owner | Backoff keyed on (login id, network); known-device exemption; global cap only for unknown/failing sources |
| A stolen phone or a web session mints lasting credentials | Step-up on claim, password and Google link; owner approval for staff claims; owner-power routes refused for web; revoke also disables the login; credential events shown to owners |
| Google consent screen cannot be verified on `workers.dev` (unverified) | Budget a custom domain; share-sheet backup until verification passes |
| A Capgo release regresses a money app | Pin releases at least 2 weeks old; review diffs before bumps; patch regenerated per version |
| ₹0 path exceeds Free CPU | Measure on a deployed Free Worker; Paid recommended anyway |
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
3. Is **₹440/month (Workers Paid)** acceptable, on the shop's own card, for user id/password login and no daily caps? If not: Google sign-in plus pairing (₹0), or Firebase Auth for passwords (₹0, second vendor).
4. Do staff have Gmail? Or should the owner create logins for them (a mobile number as the login id)? Can every staff member type a password, or do some need Google, a QR/pair code and the spoken read-back?
5. Who needs the web app, and on whose computer: the owner's own laptop or a shared counter PC? v2 web is owner-only; is that enough at first?
6. Is a daily encrypted backup (plus an optional readable monthly CSV) in the owner's Drive what "data in our Google account" means? Or must Google host the live data (Firestore v3: 4–6 weeks, Blaze billing in the shop's name)?
7. Do you accept that voice audio goes to Google for recognition (Microsoft or Apple if you use Edge or Safari)? With "AI help" or Sarvam on, the sentence text and some customer names also go to Cloudflare or Sarvam. Will you turn off Voice & Audio Activity on the shop phones' Google accounts?
8. If the free Google recogniser misses the accuracy gate, is about **₹50–300/month for Sarvam** acceptable?
9. Must the data be stored in India? (D1 offers only "apac". Sarvam, if enabled, processes in India.)
10. A custom domain (for example `kanakku.<shop>.in`, about $10/year) is likely needed for Google's consent-screen verification; is that acceptable? And would you like the spoken read-back ("ராமு, நூறு ரூபாய், வரவு") before Save?
11. When you say "credit" in English at the counter, do you mean goods given on udhaar or money received? (The app's Credit/வரவு button means money received.)

---

## Sources

Speech and AI
- Android RecognizerIntent: https://developer.android.com/reference/android/speech/RecognizerIntent
- Android SpeechRecognizer: https://developer.android.com/reference/android/speech/SpeechRecognizer
- Capgo speech plugin: https://registry.npmjs.org/@capgo/capacitor-speech-recognition · https://github.com/Cap-go/capacitor-speech-recognition · https://capgo.app/docs/plugins/speech-recognition/
- Web Speech API (MDN): https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition · Chrome contextual biasing status: https://chromestatus.com/feature/5225615177023488
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
- ML Kit GenAI devices: https://developers.google.com/ml-kit/genai · Chrome Prompt API: https://developer.chrome.com/docs/ai/prompt-api
- Prior art: https://okcredit.in/blog/how-to-use-okcredit-application-for-grocery-store

Auth, hosting and storage
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/ · pricing: https://developers.cloudflare.com/workers/platform/pricing/ · D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Static assets: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ · Rate limiting: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ · Email: https://developers.cloudflare.com/email-service/
- workerd PBKDF2 limits: https://github.com/cloudflare/workerd/blob/main/src/workerd/io/limit-enforcer.h · https://github.com/cloudflare/workerd/blob/main/src/workerd/api/crypto/impl.c%2B%2B
- OWASP password storage: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- RFC 9700: https://www.rfc-editor.org/rfc/rfc9700.html
- Google OAuth app verification / brand verification: https://support.google.com/cloud/answer/15549049
- Google ID token verification: https://developers.google.com/identity/gsi/web/guides/verify-google-id-token · Credential Manager: https://developer.android.com/identity/sign-in/credential-manager-siwg-implementation · OAuth (refresh-token expiry): https://developers.google.com/identity/protocols/oauth2
- Capgo social login: https://github.com/Cap-go/capacitor-social-login
- Firebase: ID token verification https://firebase.google.com/docs/auth/admin/verify-id-tokens · auth limits https://firebase.google.com/docs/auth/limits · pricing https://firebase.google.com/pricing · plans https://firebase.google.com/docs/projects/billing/firebase-pricing-plans · Firestore quotas https://firebase.google.com/docs/firestore/quotas · transactions https://firebase.google.com/docs/firestore/manage-data/transactions · locations https://docs.cloud.google.com/firestore/docs/locations · capacitor plugin https://capawesome.io/plugins/firebase/authentication/
- Google Cloud free features: https://docs.cloud.google.com/free/docs/free-cloud-features
- Drive scopes: https://developers.google.com/workspace/drive/api/guides/api-specific-auth · appdata: https://developers.google.com/workspace/drive/api/guides/appdata
- Set-Cookie (MDN): https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie · Public Suffix List: https://publicsuffix.org/list/public_suffix_list.dat
- Supabase pausing: https://supabase.com/docs/guides/platform/free-project-pausing · keep-alive example: https://github.com/travisvn/supabase-pause-prevention
- Lucia: https://lucia-auth.com/ · Better Auth: https://www.better-auth.com/docs/authentication/email-password
- Turso: https://turso.tech/pricing · Neon: https://neon.com/pricing · Appwrite: https://appwrite.io/changelog/entry/2026-06-29
- DPDP: https://www.hoganlovells.com/en/publications/indias-digital-personal-data-protection-act-2023-brought-into-force- · DPDP Rules 2025: https://www.barandbench.com/view-point/meity-notifies-final-digital-personal-data-protection-rules-2025
- Hono CSRF middleware: https://hono.dev/docs/middleware/builtin/csrf
