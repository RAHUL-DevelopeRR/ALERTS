# Kadan Kanakku — Voice Command Engine: noise, alternatives and proposed architecture

*Date: 2026-10-19. Builds on `docs/VOICE_ACCOUNTS_SYNC_PLAN.md` (§1, §2.6, §2.7, §9, "Recommendation in one page") and on the shipped parser `khata/app/src/core/voice.ts`. Facts established there (Gemini free terms, Workers AI 10,000 neurons/day, Sarvam ≈ ₹30/h, whisper ≈ 48% Tamil WER, Voice of India OI-WER table, Chrome 139/142 Web Speech) are reused, not re-researched.*

*Fact-checked against the live pages on 2026-10-19; corrections are marked ✎ where the earlier text was wrong.*

Tags: **[verified]** read on an official page or in the code today · **[likely]** secondary source or arithmetic from verified rates · **(unverified)** not confirmed. ₹88 = $1. Workload used for every cost: **300 utterances/day × 4 s ≈ 20 min/day ≈ 10 h/month ≈ 9,000 calls/month.**

---

## 1. Answers first

### 1a. Why "quiet" was advised, and what noise really does

**The "quiet moment" line was a test instruction, not a product requirement.** The self-test isolates *parser* bugs from *recogniser* bugs on the first run of a new build. The shop is loud; the design has to assume that, and this document does.

What noise actually does to a 3-word Tamil ledger command:

1. **Signal-to-noise ratio.** The microphone hears your voice plus the fan, the traffic and the TV. Speech attenuates with distance, so a phone lying on the counter gets a weaker voice and a worse ratio than one near the mouth **[likely: arXiv 2009.09395 is a far-field ASR tutorial that states distant speech "is affected by various acoustic distortions" without a distance-vs-SNR figure]**. The Treble/Hugging Face far-field benchmark (June 2026) finds far-field word error at low SNR (< 6 dB) "consistently several times higher" than near-field on the same speech, and the gap grows as SNR falls **[verified: huggingface.co/blog/ffasr-leaderboard]**.
2. **Other people talking is the part nothing fixes.** Fans and traffic are steady, broadband noise; suppressors handle them. A customer talking beside you is *speech in the same band* as the command, and the acoustic model has no way to know which voice is yours. Google's own Chirp 3 denoiser documentation says it reduces "background music and noises like rain and street traffic" but "can't remove background human voices" **[verified: Chirp 3 doc]**. Android's `NoiseSuppressor` reference says only "more advanced implementations" touch non-stationary noise such as "other peoples conversations" **[verified: Android reference]**.
3. **Short commands have no context to recover from.** "ராமு நூறு கட்டினான்" is three words. In dictation a lost syllable is inferred from the sentence; here there is nothing to infer from. Names are the worst case: Google's general Tamil model has never seen "Senthil Tea Kadai", so under noise it substitutes a common word. Entity errors hurt downstream tasks even when overall WER looks fine **[likely: Interspeech 2015 ATENE; ACL 2023 "Why aren't we NER yet"]**. In a ledger a wrong name is the costliest error.
4. **A dropped suffix flips the money direction.** "-க்கு" on the name is what separates *I gave to Ramu* (Debit) from *Ramu paid* (Credit); noise makes exactly that kind of drop more frequent. The plan already lists it as the first thing to measure (§9).
5. **Endpointing.** Google's recogniser waits for silence to end the session. With a TV on there is none, so the session runs on, collects a bystander's words, and the adapter's 2.5 s partial-settle / 12 s cap ends it **[verified: `platform/speech-native.ts`, plan §1.3]**. That is why `plan.ts` sometimes receives long transcripts with two names.

**Honest accuracy expectation.** The 100% direction figure is on 385 typed fixtures plus 120 native-speaker sentences, not on counter audio. The plan's own estimate is 75–90% of short commands fully right in a *quiet* shop (unverified); in a loud shop nobody has a number yet, and the first job is to get one (section 4). The field data (`voice_stats`) does not exist yet.

**What the app already does about it** (all built): never auto-saves; shows "Heard: …" and the amount source in large type; shows "Or did you say" chips when alternatives disagree; disables Save when the direction is disputed; customer-page mode removes the name from the problem; a 12 s hard cap stops runaway sessions; the keypad is always one tap away.

**What else helps for free, ordered by effect:**

| Lever | Why it works | Status / cost |
|---|---|---|
| **Hold-to-talk, release = stop, phone 10–20 cm from the mouth** | Near-field alone moves SNR by roughly 10–20 dB versus arm's length **[likely: far-field literature]**; releasing the button ends the session before the customer replies, which removes the endpointing problem entirely | UI change only; listed "not built" in plan §1.1. Smallest high-value change |
| **Wired headset mic at the counter** | Close-talk microphone; the single biggest acoustic win, no code | ₹150–300 hardware. Bluetooth is weaker: SCO input streams "must be mono" and "the sampling must be 8kHz" **[verified: `AudioManager.startBluetoothSco()` reference; the method is deprecated in API 34 in favour of `setCommunicationDevice()`]** and whether Google's recogniser follows the headset without `EXTRA_AUDIO_SOURCE` is **(unverified)** |
| **Customer-page mode as the taught path** | No name to recognise; only amount + verb remain | built |
| **One fixed phrase shape per intent** (laminated card at the counter) | Fewer words, explicit verb → the `high` path; less for a bystander to leak into | onboarding card |
| **Repeat-back and confirm** | Turns a misrecognition into a tap, not a wrong row | built; add "retry keeps what was right" (amount parsed, name not → keep ₹, ask only for the name) |
| **Name biasing: `RecognizerIntent.EXTRA_BIASING_STRINGS`** (API 33+) | "Optional list of strings, towards which the recognizer should bias the recognition results. These are separate from the device context." (API 33) **[verified: Android reference]**. The capgo plugin 8.3.2 does not set it (and neither does the latest 8.4.4 of 2026-10-16; 8.4.0 only added `contextualStrings` for the iOS `SpeechAnalyzer`) **[verified: release notes]**; `buildRecognizerIntent()` sets only LANGUAGE_MODEL, LANGUAGE, MAX_RESULTS, PARTIAL_RESULTS, DICTATION_MODE, optional PREFER_OFFLINE, segmented session and PROMPT; `contextualStrings` is iOS-only **[verified: plugin source in node_modules]** | ~10-line `patch-package` change plus plumbing `contextualStrings` through `start()`. Whether Google honours it for `ta-IN` is **(unverified)**; ✎ the sentence "depending on the recognizer implementation, this value may have no effect" is on `EXTRA_ENABLE_BIASING_DEVICE_CONTEXT`, `EXTRA_SEGMENTED_SESSION` and `EXTRA_PREFER_OFFLINE`, not on `EXTRA_BIASING_STRINGS` itself **[verified]**, but nothing promises the Google recogniser uses it. One day on a Redmi settles it |
| **`VOICE_RECOGNITION` audio source + `NoiseSuppressor`** | `MediaRecorder.AudioSource.VOICE_RECOGNITION` is "tuned for voice recognition"; `NoiseSuppressor` is a WebRTC-class suppressor for stationary noise **[verified]**. But both attach only to an `AudioRecord` the *app* opens; `SpeechRecognizer` captures audio itself. The only route is `EXTRA_AUDIO_SOURCE` (API 33), where the app hands the recogniser a `ParcelFileDescriptor` of its own capture **[verified]** | Fork-level change, not a patch; the doc warns "`EXTRA_ENABLE_BIASING_DEVICE_CONTEXT` may have no effect when this extra is set" (it says nothing about `EXTRA_BIASING_STRINGS`) **[verified]**. Test last |
| **Instrumentation** | Per-utterance log of heard text, confidence, which fields were edited, session length, cap fired | phone-only, opt-in; this is the gate data |

On the **web** build nothing can be done about noise: `SpeechRecognition.start(audioTrack)` and `phrases` are Chrome desktop only (135 / 142), `chrome_android: false` **[verified: mdn/browser-compat-data]**.

### 1b. Gemini: free? what it costs paid?

**Free: no, not for this app.** The Gemini API Additional Terms (effective 2026-03-23, last updated 2026-04-28) say for Unpaid Services Google uses content "to provide, improve, and develop Google products and services and machine learning technologies", that "human reviewers may read, annotate, and process your API input and output", and **"Do not submit sensitive, confidential, or personal information to the Unpaid Services."** **[verified: ai.google.dev/gemini-api/terms]**. Every utterance contains a customer's name and often a phone number. Sending the *text* "ராமு 100 கட்டினான்" instead of the audio changes nothing: the name is the personal datum either way. The pricing page marks every free-tier row "Used to improve our products: Yes" **[verified]**, and the rate-limits page (updated 2026-10-15) no longer publishes a free-tier RPM/RPD table; limits are per project and visible only in AI Studio **[verified]**. Third-party figures disagree **(unverified)**; a production feature cannot sit on a quota Google can change per project without notice.

**Paid: possible, ₹90–550/month.** Audio is 32 tokens/s (1 min = 1,920 tokens) **[verified: audio doc]**. Per 1M tokens: 2.5 Flash-Lite text $0.10 / audio $0.30 / out $0.40; 3.1 Flash-Lite text $0.25 / audio $0.50 / out $1.50; 3.5 Flash-Lite $0.30 all modalities / out $2.50; 2.5 Flash text $0.30 / audio $1.00 / out $2.50; 3 Flash Preview text $0.50 / audio $1.00 / out $3.00; 3.6 and 3.8 Flash $0.75 in / $3.75 out through 2026-12-31, doubling from 2027-01-01 **[verified: pricing page]**. At 9,000 calls/month with ~128 audio + ~400 prompt + ~80 output tokens per call: 2.5 Flash-Lite ≈ **$1.0 ≈ ₹90**, 3.1 Flash-Lite ≈ ₹225, 3.5 Flash-Lite ≈ ₹285, 2.5 Flash ≈ ₹355, 3 Flash ≈ ₹420, 3.6/3.8 Flash ≈ ₹550 **[likely: arithmetic]**. Paid Services are not used to improve products and fall under the Data Processing Addendum **[verified]**. Tamil evidence: Gemini 3 Flash 19.9% OI-WER on Voice of India (real noisy telephonic speech; Sarvam 14.2–14.9%, Gemini 3 Pro 15.7%) and 35.2% mean WER on the SraVaani Tamil evaluation (six sets, 30.8 h; the paper marks the Gemini figure † = mean over fewer than the full six sets, so it is not strictly comparable to SraVaani-1.0 26.2%, IndicConformer 30.1%, Sarvam saaras:v3 32.1%) **[verified: arXiv 2608.08235 Table 3]**; **no Tamil figure exists for any Flash-Lite model (unverified)**, and one forum thread (2026-08-29) measured 3.5 Flash-Lite at 21.97% WER against 6.19% for 3.1 Flash-Lite (3.55×) on 50 French radiology dictations, so Lite regressions are real **[likely: discuss.ai.google.dev, one user's test set]**. Latency 1–3 s plus network for a 4 s clip **[likely: forum measurements of 12 s clips]**.

Verdict: Gemini is a *paid, optional* STT or interpreter provider behind the same interface as Sarvam, never the free tier, and never the place where the money decision is made (plan §2.7).

### 1c. The other no-cost or near-free alternatives

| Option | ₹/month at 10 h | Tamil accuracy evidence | Noise help | Privacy / terms | Latency | Verdict |
|---|---|---|---|---|---|---|
| Google on-phone (built) | 0 | none published; 75–90% quiet estimate | Google's own front-end; names unbiased until the patch | audio to Google; no key | ~1 s | **default** |
| + biasing patch (1a) | 0 | measurable in a day | names biased (if honoured) | same | same | **do first** |
| Gemini free | 0 | none for Lite | unknown | forbidden for personal data; human review; training | 1–3 s | reject |
| Gemini paid | 90–550 | 3 Flash 19.9% VoI | fair | DPA, no training; outside India | 1–3 s | optional paid provider |
| Workers AI `whisper-large-v3-turbo` | 0 (46.63 neurons/min → ≈ 930/day) | ≈ 48% WER | weak | Cloudflare does not train or retain | 1–2 s | second opinion only; `initial_prompt` can carry names **[verified: model page]** |
| Workers AI `@cf/deepgram/nova-3` | 0 (472.73 neurons/min → ≈ 9,455/day, i.e. the whole free budget) | 67.8% VoI (Tamil is listed for Nova-3 **[verified: Deepgram]**) | — | — | — | reject |
| Google STT v2 `chirp_3` | ≈ 845 (V2 standard $0.016/min from minute 0; dynamic batch $0.003/min ≈ ₹160 but not real-time) **[verified: pricing page]** | no Tamil benchmark; `ta-IN` Preview | denoiser (not voices); 1,000 adaptation phrases | GCP DPA | < 1 s stream | ✎ the free 60 min/month is on the V1 API only (V1 without data logging is $0.024/min ≈ ₹1,270) **[verified: pricing + free-tier pages]**; no |
| Azure AI Speech F0 | 0 up to 5 h/month (shared between standard and custom; no batch on F0) **[verified]**, then ≈ $1/h ≈ ₹88/h **[likely: third-party; Microsoft's page renders the figure blank]** | 28.0% VoI | phrase list ≤ 2,000 phrases, "for locales where the feature is enabled"; `ta-IN` not named **[verified]** | Microsoft terms; card needed (unverified) | < 1 s | **the ₹0-forever fallback**: 5 h ≈ 150 fallback utterances/day |
| AWS Transcribe | ✎ ≈ 1,270 at $0.024/min **[likely: third-party; the page renders prices via tokens]**; standard transcription is "billed in one-second increments, with no minimum applied" (the 15 s minimum is Call Analytics only) **[verified]**; 60 min/month free for the first 12 months **[verified]** | ✎ **19.3% VoI**, better than Gemini 3 Flash **[verified: VoI]** | custom vocabulary for `ta-IN` streaming only **[verified]** | AWS DPA; outside India unless `ap-south-1` | — | credible paid #3; not free after year one |
| ElevenLabs Scribe v2 | ✎ ≈ 530: Starter plan $6/month includes 27 h (10 h fits inside); $0.22/h beyond; the free plan's 4.5 h/month exist but a commercial licence on Free is not stated **(unverified)** **[verified: pricing page]** | 20.4% VoI | keyterms ≤ 1,000 batch / ≤ 50 realtime **[verified]** | outside India; self-serve training terms unconfirmed | 1–2 s | credible paid #2 |
| Sarvam `saaras:v4` | ₹100 credit (≈ 3.3 h), then 300 full / ≈ 90 as a fallback **[verified: ₹30/h]** | 14.2–14.9% VoI (entries "Sarvam Audio" and "Saarika 2.5", not saaras:v4 itself); v3 32.1% SraVaani | vendor "robust to noisy audios" (blog 2026-09-25); keyterms ≤ 50 × 64 chars, v4 only **[verified]** | managed production on Azure Central India **[verified: trust center]**, but the privacy policy says personal data "may be transferred to and processed in countries outside India"; ✎ **the policy labels training "Default Policy: Opt-In" yet says content is used unless you opt out in account settings, i.e. used by default; retention default 30 days, user-configurable** **[verified: privacy policy 2026-07-29]** | < 1 s stream | **first paid fallback** |
| Self-host IndicConformer-600M / SraVaani-1.0 (MIT, gated, ≈ 430 M params, ≈ 900 MB FP16) | 0 on Cloud Run free tier (2 M requests, 180,000 vCPU-s, 360,000 GiB-s per month **[verified]**) or Oracle Always Free A1 (2 OCPU / 12 GB, "out of host capacity" is common and idle instances are reclaimed **[verified]**) | 19.9% VoI / 26.2% SraVaani (IndicConformer 30.1% on the same SraVaani sets) **[verified]** | model-dependent | your server | 2–30 s cold start | best accuracy per rupee, worst operational fit; phase-E experiment. HF Gradio/Docker Spaces now need a paid plan (Static Spaces and up to 2 ZeroGPU Spaces stay free) **[verified]** |
| On-device sherpa-onnx Omnilingual 300M int8 | 0 | unverified (the related OmniASR LLM 1B scores 49.0% VoI, 7B 43.1%, so expect worse) **[verified: VoI]** | unverified | best | unverified | 365 MB `model.int8.onnx` **[verified]**; not for v2 |
| Bhashini | — | — | — | site returned 503; proof-of-concept only per secondary sources **[likely]** | — | unchanged from the plan |

**For the text → action step** (the NLP engine, section 2), the comparison is simpler. Workers AI `@cf/google/gemma-4-26b-a4b-it` lists function calling: yes, 256k context, 9,091 / 27,273 neurons per M in/out **[verified: model and pricing pages]**; a 1,200–2,000 + 150 token call ≈ 15–22 neurons ≈ 450–670 free calls/day **[likely: arithmetic]**; "Cloudflare does not use Customer Content processed by Workers AI to train AI models" and does not retain inputs/outputs **[verified: privacy page]**. Alternatives all fail on at least one axis: Gemini free (terms), Mistral free (the free tier "requires opting into data training" **[likely: secondary]**), OpenRouter `:free` (50 requests/day, 1,000 after buying ≥ $10 of credits **[verified]**; several providers may train **[likely]**), Groq free ("All customers may enable Zero Data Retention" **[verified]** but a second vendor, data stored in US GCP buckets **[verified]**, Llama Tamil weak), Gemini Nano on-device (ML Kit GenAI lists Xiaomi 14T Pro/15/17 flagships but no Redmi **[verified]**), Chrome Prompt API (en/ja/es/de/fr only; "Chrome for Android … not yet supported" **[verified]**), a model inside the APK (Gemma 4 E2B is 2.58 GB as the LiteRT-LM file, 10.2 GB as safetensors **[verified]**; 10–30 s per answer on a budget Redmi **[likely]**; and Gemma E4B used as a transcriber scores 40.4% OI-WER on VoI Tamil **[verified]**).

### 1d. Is there a proposed architecture?

Yes: section 2. The deterministic grammar on the phone stays the engine; it is extended from money entries to a typed set of commands (new customer, update, open, balance, undo, statement, reminder); an LLM is an optional, constrained arbiter that can only choose among candidates the grammar already found; every write ends on a tap. The STT and the LLM sit behind provider interfaces so that Google, Sarvam, paid Gemini or Workers AI can be swapped by a setting, and the ₹0 configuration is the left-hand column alone.

---

## 2. Proposed architecture

```
 ┌──────────────────────────── PHONE (Capacitor, offline-capable) ────────────────────────────┐
 │                                                                                            │
 │  Counter: hold-to-talk · phone at the mouth · wired headset optional · phrase card         │
 │        │                                                                                   │
 │        ▼                                                                                   │
 │  [1] MIC / STT PROVIDER INTERFACE   platform/speech-*.ts                                   │
 │      default  : Google SpeechRecognizer (ta-IN, en-IN), ₹0, needs network, audio → Google  │
 │                 + EXTRA_BIASING_STRINGS = customer names (patched plugin, API 33+)         │
 │                 [later] EXTRA_AUDIO_SOURCE: AudioRecord VOICE_RECOGNITION + NoiseSuppressor│
 │      fallback : "AI help" on AND online AND (no result | parser low)                       │
 │                 → Worker POST /v1/voice/transcribe → Sarvam saaras:v4 (keyterms ≤ 50)      │
 │                   or Gemini paid / Azure F0 / Workers AI whisper, by Worker setting        │
 │        │ alternatives: string[] (≤ 5)                                                      │
 │        ▼                                                                                   │
 │  [2] TAMIL NORMALISER   core/voice.ts (built: fold, transliterate, TA_MORPHS, tokenise)    │
 │        ▼                                                                                   │
 │  [3] COMMAND GRAMMAR    core/voice.ts + COMMANDS table (deterministic, < 5 ms, offline)    │
 │      heads: puthu customer · number maathu · note · page/kaattu · baaki · kadaisi cancel   │
 │             · statement anuppu · reminder   +   money verbs (today's CUES)                 │
 │        ▼                                                                                   │
 │  [4] INTENT RESOLVER    core/commands.ts → CommandParse                                    │
 │      customer candidates (matchCustomers, ≤ 3, scores) · amount (parseAmount) · phone      │
 │      (parsePhone) · action · confidence · unsure[] · evidence[]                            │
 │        │                                                                                   │
 │        ├── sure ──────────────────────────────────────────────────────┐                    │
 │        │                                                              │                    │
 │        └── unsure AND online AND "AI help" on AND cap not hit         │                    │
 │                │  alts + ≤ 8 names as refs c1..c8 + numbers/digits found + grammar guess   │
 │                ▼                                                      │                    │
 │  ┌────────── WORKER (Cloudflare, free tier) ──────────┐               │                    │
 │  │ [5] LLM ARBITER  POST /v1/voice/interpret          │               │                    │
 │  │     device auth · 300/shop/day · 4 s timeout ·     │               │                    │
 │  │     nothing stored · one tool `interpret_command`  │               │                    │
 │  │     default Workers AI gemma-4-26b-a4b-it (free,   │               │                    │
 │  │     no training) · optional Gemini PAID · never    │               │                    │
 │  │     Gemini free with names                         │               │                    │
 │  │     ajv schema check → tool args or 422            │               │                    │
 │  └────────────────────────────────────────────────────┘               │                    │
 │                │ hint (≤ 2.5 s, else dropped)                         │                    │
 │                ▼                                                      ▼                    │
 │  [6] VALIDATION (phone)  ref ∈ sent · amount ∈ numbers_found · digits ∈ digit_runs ·       │
 │      kind vs strong cue · LLM-origin kind ≤ medium · no UNDO from LLM alone                │
 │        ▼                                                                                   │
 │  [7] CONFIRMATION SCREENS (existing UI)                                                    │
 │      entry screen · customer form · old → new dialog · undo dialog · balance dialog ·      │
 │      statement share sheet · chips row on UNKNOWN                                          │
 │        ▼ tap (open / balance need none)                                                    │
 │  [8] REPO ACTIONS  addEntry · createCustomer · updateCustomer · open · balance ·           │
 │      reverse(last) · statement → outbox → sync (unchanged)                                 │
 │        ▼                                                                                   │
 │  [9] METRICS  voice_stats (synced counters) · voice_log (phone-only, opt-in, 30 days)      │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Where each piece runs, what it costs, what needs network**

| Piece | Runs on | Free? | Network? |
|---|---|---|---|
| [1] Google STT | phone + Google | yes | yes (offline Tamil pack on Redmi **(unverified)**; check `SpeechRecognizer.checkRecognitionSupport()`, API 33, `isOnDeviceRecognitionAvailable()` API 31 **[verified]**) |
| [1] STT fallback | Worker proxy → vendor | Sarvam ₹100 credit then ₹90–300; Azure F0 free to 5 h; Gemini paid ₹90–550 | yes |
| [2]–[4] normaliser, grammar, resolver | phone, pure TypeScript | yes | **no** |
| [5] LLM arbiter | Worker → Workers AI | yes within 10,000 neurons/day (≈ 450+ calls) | yes |
| [6]–[8] validation, screens, repo | phone | yes | no (sync later) |
| [9] metrics | phone (log), D1 (counters) | yes | counters only |

Everything right of [4] is optional and off by default. With network down, [1] is unavailable anyway (Google needs it), and everything from the keypad onward works as today.

---

## 3. Action schema, decision table, confirmation rules

### 3.1 TypeScript types (`core/commands.ts`)

`ADD_ENTRY` is today's `VoiceIntent` relabelled; `planIntent()` keeps working for it. New `VoiceStep` variants: `'customer-form' | 'customer-update' | 'open' | 'undo-confirm' | 'share'`.

```ts
export type CustomerRef = {
  name_text: string | null;     // as heard, dative stripped
  matches: CustomerMatch[];     // ≤ 3, best first (existing matcher, scores 0..1)
  context_kept?: boolean;       // page customer kept (existing rule: within 0.10 of best)
};

export type Action =
  | { type: 'ADD_ENTRY'; customer: CustomerRef; kind: 'GIVE' | 'RECEIVE' | null; kind_reason: string | null;
      amount_paise: number | null; amount_text?: string; amount_alternatives?: number[];
      note?: string | null; date_offset?: 0 | -1 | -2; mode?: 'UPI' }
  | { type: 'MULTI_ENTRY'; entries: Extract<Action, { type: 'ADD_ENTRY' }>[] }        // ≤ 5
  | { type: 'ADD_CUSTOMER'; name_text: string; name_script: 'ta' | 'latin'; name_alternatives: string[];
      phone_digits: string | null; phone_complete: boolean; note?: string | null }
  | { type: 'UPDATE_CUSTOMER'; customer: CustomerRef; field: 'phone' | 'note' | 'name';
      value_text: string; phone_digits?: string | null; phone_complete?: boolean }
  | { type: 'OPEN_CUSTOMER'; customer: CustomerRef }
  | { type: 'ASK_BALANCE'; customer: CustomerRef }               // existing balance_query
  | { type: 'UNDO_LAST'; customer?: CustomerRef }
  | { type: 'CORRECT_LAST'; customer?: CustomerRef; amount_paise?: number | null; kind?: 'GIVE' | 'RECEIVE' | null }
  | { type: 'SEND_STATEMENT'; customer: CustomerRef; channel: 'whatsapp' | 'sms' | null }
  | { type: 'REMIND'; customer: CustomerRef; channel: 'whatsapp' | 'sms' | null }
  | { type: 'UNKNOWN'; reason: string };

export interface CommandParse {
  heard: string; alt_index: number;
  action: Action;
  confidence: 'high' | 'medium' | 'low';
  source: 'grammar' | 'grammar+llm';
  unsure: Array<'no_action_cue' | 'kind_null' | 'amount_null' | 'name_unmatched' | 'close_candidates'
               | 'phone_incomplete' | 'split_uncertain' | 'conflict_alts'>;
  evidence: string[];           // e.g. ['cmd:pudhu customer', 'verb:kattinaan']
}
```

### 3.2 JSON schema for the LLM tool (`interpret_command`, validated with `ajv` on the Worker and a hand-written guard on the phone)

```json
{
  "name": "interpret_command",
  "description": "Classify ONE Tamil/Tanglish/English shop-ledger command. Choose only from the given refs and numbers.",
  "parameters": {
    "type": "object", "additionalProperties": false,
    "required": ["action", "confidence", "evidence"],
    "properties": {
      "action": {"type": "string", "enum": ["ADD_ENTRY","MULTI_ENTRY","ADD_CUSTOMER","UPDATE_CUSTOMER","OPEN_CUSTOMER",
                                             "ASK_BALANCE","UNDO_LAST","CORRECT_LAST","SEND_STATEMENT","REMIND","UNKNOWN"]},
      "customer_ref": {"type": "string", "enum": ["c1","c2","c3","c4","c5","c6","c7","c8","NEW","NONE"]},
      "entries": {"type": "array", "maxItems": 5, "items": {"type": "object", "additionalProperties": false,
        "required": ["customer_ref","kind"],
        "properties": {
          "customer_ref": {"type": "string", "enum": ["c1","c2","c3","c4","c5","c6","c7","c8","NEW","NONE"]},
          "amount_rupees": {"type": ["integer","null"]},
          "kind": {"type": "string", "enum": ["GIVE","RECEIVE","UNSURE"]},
          "item": {"type": ["string","null"]},
          "date_offset": {"type": "integer", "enum": [0,-1,-2]}}}},
      "field": {"type": "string", "enum": ["phone","note","name"]},
      "phone_digits": {"type": ["string","null"], "pattern": "^[0-9]{7,13}$"},
      "new_name_text": {"type": ["string","null"]},
      "note_text": {"type": ["string","null"]},
      "channel": {"type": "string", "enum": ["whatsapp","sms","unknown"]},
      "confidence": {"type": "string", "enum": ["high","medium","low"]},
      "evidence": {"type": "array", "items": {"type": "string"}, "maxItems": 4}
    }
  }
}
```

Request body from the phone: `alts[]`, `page_customer` ref, `candidates[{ref,name}]` (≤ 8, names only), `numbers_found[]`, `digit_runs[]`, `items_found[]`, `grammar_guess`, `unsure[]`, `allowed_actions[]`. Never phone numbers, balances, notes or C-codes. The names are already in Google's hands via the audio, so this adds no recipient beyond Cloudflare. gemma-4 is **not** on the JSON-mode supported list (that list names llama-3.3-70b-instruct-fp8-fast, llama-3-8b-instruct, llama-3.1-8b-instruct, hermes-2-pro-mistral-7b, deepseek-coder-6.7b-instruct-awq, deepseek-r1-distill-qwen-32b) and "Workers AI can't guarantee that the model responds according to the requested JSON Schema" **[verified]**; its model page does list function calling: yes and a `response_format` parameter without saying which formats **[verified]**, so the Worker uses *tool calling* and validates; if the spike shows > 5% invalid calls, switch to `llama-3.3-70b-instruct-fp8-fast` with `response_format: json_schema` (26,668 / 204,805 neurons per M → ✎ ≈ 63–84 neurons/call ≈ 120–160 free/day) or `qwen3-30b-a3b-fp8` (4,625 / 30,475 → ≈ 10–14 neurons/call) **[verified rates; likely arithmetic]**.

### 3.3 Decision table

| Grammar outcome | What happens | LLM called? |
|---|---|---|
| `high` (explicit head or money verb, strong customer ≥ 0.85 with gap ≥ 0.10, undisputed amount) | prefill the confirmation screen | **no** |
| `kind: null` because alternatives conflict (`conflict:alternatives`, `conflict:dative`) | ask, Save disabled (today) | **no** (the LLM cannot hear better) |
| `kind: null`, no cue at all, amount + customer present ("Ramu 100 ஏதோ") | prefill, "check before saving" line | **yes**, if online + AI on + cap not hit; may fill `kind` at ≤ medium |
| amount `null` with number-like words the grammar could not read | keypad with the heard words | **yes**; may pick one of `numbers_found` only |
| no customer match, name present, money entry | "Add new customer 'Suresh'?" (existing) | **no** |
| 2–3 candidates within 0.10 | picker (existing) | **no** (one tap; notes are not sent so the LLM cannot do better) |
| no money verb, no command head, ≥ 4 tokens (`no_action_cue`) | chips row: Entry · New customer · Open · Balance · Statement | **yes**; result opens a preview, never executes |
| command head + money verb (`split_uncertain`) | `ADD_ENTRY` ≤ medium; follow-up chip after Save | **yes**; may propose the second action as the chip |
| phone digits incomplete | customer form with digits typed so far | **no** |
| undo / correct words without a grammar head | ignored (chips row) | **no**, ever |
| offline · AI help off · daily cap · timeout in the last 60 s · < 2 tokens | grammar only | **no** |

Expected LLM call rate with the fixture distribution: well under 10% of utterances, i.e. 20–40 calls/day for one shop against the 300 cap and the ≈ 450 free-neuron budget **[likely]**. The LLM never blocks: the grammar preview opens in ~1–1.5 s; the hint is merged only if it arrives within 2.5 s and before any tap, with a visible marker ("AI suggests: Debit"); after a tap or the timeout it is dropped and counted (`llm_timeout`).

### 3.4 Confirmation rules per action

| Action | Shopkeeper sees | Executes on |
|---|---|---|
| ADD_ENTRY / MULTI_ENTRY | existing entry screen / queue with voice banner | **Save tap**; large-amount, advance and duplicate dialogs still fire |
| ADD_CUSTOMER | prefilled customer form: name (script per the recogniser language, `search_name` = `transliterateTamil()`), spelling chips from other alternatives, phone in 5-5 groups, "looks like existing: Ramu (C-0012)" row when a folded name ≥ 0.75 or the same phone exists | **Save tap**; duplicate phone offers "Open existing" first |
| UPDATE_CUSTOMER phone / note | dialog "ராமு · 98765 43210 → **99887 76655**" in large type; phone must pass `normalizePhone()` | **Change tap** |
| UPDATE_CUSTOMER name | form old → new; always ≤ medium; never from the LLM alone | **Save tap** |
| OPEN_CUSTOMER | navigates directly when `high`; else chip "Open Ramu?" | no confirmation (read-only) |
| ASK_BALANCE | existing balance dialog | no confirmation (read-only) |
| UNDO_LAST | last entry saved *from this device* within the existing Undo window, with amount, direction and customer: "Cancel this entry?" | **Yes tap**; outside the window → the entry's normal reversal path; WRITEOFF never by voice |
| CORRECT_LAST | last entry's edit screen with the new amount/kind prefilled, old crossed out | **Save tap** |
| SEND_STATEMENT / REMIND | existing statement screen → `whatsappLink()` / `smsLink()` | the OS share-sheet tap; no phone on file → "add number?" chip |
| UNKNOWN / low | transcript + chips row | tap |

Money-safety invariants, test-enforced: no write without a tap; an amount only from spoken numbers; LLM-origin direction ≤ medium; a conflict disables Save; undo/correct only with a grammar head; phone digits only from the transcript; cap, offline and "AI off" never change the grammar path.

---

## 4. Noise plan

**Capture settings (Android, in order of risk).**
1. Hold-to-talk: `start()` on press, `stop()` on release, use the partials; keep the 12 s cap as a safety net. Reduce the 2.5 s settle to 1.2 s when the partial already contains a money verb or command head plus an amount or phone.
2. `EXTRA_MAX_RESULTS` stays 5; log how many alternatives Google actually returns for `ta-IN` (unverified today).
3. `EXTRA_BIASING_STRINGS` = the shop's customer names (≤ 200, both scripts) via a `patch-package` patch to `SpeechRecognitionPlugin.java`; `EXTRA_ENABLE_BIASING_DEVICE_CONTEXT` is not used (contacts-style, "may have no effect").
4. Do **not** use `allowForSilence` / segmented sessions in noise: the doc says it is "extremely rare you'd want to specify this" and in a loud shop the session may never end **[verified]**.
5. `EXTRA_PREFER_OFFLINE` only after `checkRecognitionSupport()` says a Tamil pack is installed; log the answer.
6. Last: `EXTRA_AUDIO_SOURCE` with an app-owned `AudioRecord(VOICE_RECOGNITION)` + `NoiseSuppressor` when `isAvailable()`; a wired headset is tried before this.

**What to measure.** Extend `voice_stats` (synced counters): `heard`, `saved`, `amount_edited`, `kind_changed`, `cancelled` (existing) plus `name_edited`, `no_result`, `cap_fired`, `alts_returned_total`, `cmd_heard`, `cmd_executed`, `llm_called`, `llm_accepted`, `llm_invalid`, `llm_timeout`, `name_picked_other`, `new_customer_from_voice`, `phone_dictated_ok`, `phone_dictated_fixed`, `stt_fallback_called`. Add `voice_log` (phone-only, never synced, never in backups, 30-day rolling, Settings → Voice → Clear): one row per listen with `ts`, `alts_json`, `action_type`, `confidence`, `source`, `unsure_json`, `evidence_json`, `outcome` (`saved | edited:amount | edited:kind | edited:customer | cancelled | executed`), `latency_ms {stt, grammar, llm}`, `page_context`, `noise_hint` (the owner's one-tap "loud / normal" after a failure, optional). Erasing a customer also purges log rows whose folded text contains the erased name's fold, so the DPDP erasure statement stays true. Export only by the owner's tap, with every customer name replaced by its C-code before the share sheet opens.

**Field gate.** Record 100 real counter utterances during normal shop hours (not a quiet moment), half in customer-page mode, half from Home, spread over at least five days. Score each as *right after at most one tap* (name, amount and direction all correct on the confirmation screen, or correct after exactly one chip/picker tap). **Pass = ≥ 85% right after one tap**, with first-try-correct (no tap) and no-result rates reported alongside. Keep the ₹0 configuration while it passes. If it fails, read the dominant edit: a *name* edit means biasing (then headset) before any paid service; an *amount or verb* edit under noise is the STT fallback's job; a *no-result* above 15% means endpointing, so hold-to-talk first.

**Fallback ladder (each step only if the gate still fails after the previous one).**
1. Hold-to-talk + phone at the mouth + phrase card (₹0, UI only).
2. Biasing strings patch (₹0, one day; re-measure).
3. Wired headset at the counter (₹150–300 hardware; re-measure).
4. STT fallback behind `POST /v1/voice/transcribe`, called only on no-result or parser `low`: **Sarvam saaras:v4** (keyterms ≤ 50 names, training opted out and retention set to 0 *before* the first real utterance, written confirmation kept) at ₹100 credit then ≈ ₹90–300/month; or **Azure F0** if the owner insists on ₹0 (5 h/month ≈ 150 fallback utterances/day, 28% OI-WER); **Gemini paid** or **AWS Transcribe** (19.3% OI-WER, ≈ ₹1,270/month, free only for 12 months) only as configured alternative providers.
5. `EXTRA_AUDIO_SOURCE` with app-side noise suppression (fork-level; last because the reference says device-context biasing "may have no effect" with it, and nothing is said either way about `EXTRA_BIASING_STRINGS`).

---

## 5. Example utterances → actions

Confidence shown is the grammar's; "→ LLM" marks rows where the decision table would consult the arbiter when it is on.

| # | Utterance | Action | Slots | Confidence / screen |
|---|---|---|---|---|
| 1 | ராமு நூறு கட்டினான் | ADD_ENTRY | Ramu, ₹100, RECEIVE (`verb:kattinaan`) | high → entry screen |
| 2 | Ramukku 250 kuduthen | ADD_ENTRY | Ramu, ₹250, GIVE (`dative` + `verb:kuduthen`) | high → entry screen |
| 3 | Ramu 100 kuduthaachu | ADD_ENTRY | Ramu, ₹100, RECEIVE by setting (`bare-kuduthaachu`) | medium + check line |
| 4 | ராமு ரெண்டு கிலோ அரிசி வாங்கினான் | ADD_ENTRY | Ramu, amount null, GIVE, note "2 kilo arisi" | keypad with note prefilled |
| 5 | Ramu 100, Kumar 50 kattinaanga | MULTI_ENTRY | two RECEIVE entries | medium → queue |
| 6 | புது வாடிக்கையாளர் சுரேஷ் 98765 43210 | ADD_CUSTOMER | name சுரேஷ் (search_name "Suresh"), phone 9876543210 complete | high → customer form |
| 7 | new customer Lakshmi | ADD_CUSTOMER | name Lakshmi, phone null | high → form, cursor on phone |
| 8 | Ramu add pannu (Ramu exists) | ADD_CUSTOMER with "looks like existing: Ramu" row | — | medium → form with Open-existing chip |
| 9 | Ramu number maathu 98765 43210 | UPDATE_CUSTOMER phone | Ramu, 9876543210 | high → old → new dialog |
| 10 | ராமு போன் நம்பர் ஒம்பது எட்டு ஏழு ஆறு அஞ்சு நாலு மூணு ரெண்டு ஒன்னு பூஜ்யம் | UPDATE_CUSTOMER phone | digits from Tamil digit words → 9876543210 | high → dialog |
| 11 | Ramu number 98765 432 | UPDATE_CUSTOMER phone, `phone_incomplete` | 8 digits | low → form with digits typed so far |
| 12 | Ramu 9876543210 (no head) | UPDATE_CUSTOMER phone (rule 4: ≥ 7 digits is never an amount) | — | medium → dialog |
| 13 | Ramu note koyil theru | UPDATE_CUSTOMER note | "koyil theru" | medium → form |
| 14 | Ramu peru Ramasamy-nu maathu | UPDATE_CUSTOMER name | Ramu → Ramasamy | medium → form old → new |
| 15 | ராமு கணக்கு காட்டு | OPEN_CUSTOMER | Ramu | high → navigates |
| 16 | Ramu page | OPEN_CUSTOMER | Ramu | high → navigates |
| 17 | Ramu (name only, Home) | OPEN_CUSTOMER | Ramu | low → chip "Open Ramu?" |
| 18 | ராமு பாக்கி எவ்வளவு | ASK_BALANCE | Ramu | high → balance dialog |
| 19 | last entry cancel pannu | UNDO_LAST | last entry from this device | high → "Cancel this entry?" |
| 20 | ராமு கடைசி entry அழி | UNDO_LAST | Ramu's last entry | high → confirm |
| 21 | illa 150 (on the saved-entry toast) | CORRECT_LAST | amount ₹150 | medium → edit screen |
| 22 | Ramu statement anuppu | SEND_STATEMENT | Ramu, channel null | high → statement screen → share sheet |
| 23 | ராமுக்கு கணக்கு WhatsApp பண்ணு | SEND_STATEMENT | Ramu, whatsapp | high |
| 24 | Ramu-kku reminder anuppu | REMIND | Ramu | high → reminder flow |
| 25 | (customer page) number maathu 99887 76655 | UPDATE_CUSTOMER phone, `context_kept` | page customer | high |
| 26 | Ramu 100 kattinaan statement anuppu | ADD_ENTRY, `split_uncertain` | Ramu, ₹100, RECEIVE | medium → entry; follow-up chip "Send statement?" → LLM |
| 27 | **noisy partial:** "ரா… நூறு கட்டினான்" | ADD_ENTRY, `name_unmatched` | ₹100, RECEIVE, name null | medium → "which customer?" picker; amount kept |
| 28 | **noisy partial:** "ராமு நூறு … பண்ணு" | ADD_ENTRY, `kind_null` (no cue) | Ramu, ₹100 | → LLM may fill kind at ≤ medium; else ask with Save disabled |
| 29 | **noisy two alternatives:** ["ராமு 500", "ராஜு 500"] | ADD_ENTRY, `close_candidates` | ₹500 | picker Ramu / Raju; no LLM |
| 30 | **noisy leak:** "ராமு நூறு கட்டினான் அக்கா இன்னும் ரெண்டு பால்" | ADD_ENTRY | Ramu, ₹100, RECEIVE, note "2 paal" (trailing bystander words become a note, visible and deletable) | medium |
| 31 | Bill 200 kattinaan (customer named Bill) | ADD_ENTRY | Bill, ₹200, RECEIVE (name-position rule beats the `bill` head) | high |
| 32 | "ஏதோ ஒரு சத்தம்" (nothing useful, ≥ 4 tokens) | UNKNOWN, `no_action_cue` | — | chips row → LLM |

---

## 6. Implementation plan

### 6.1 Changes to the existing code

| Area | Change | Days |
|---|---|---|
| `core/voice.ts` | `COMMANDS` table beside `CUES` with the same `wordSet` raw/fold machinery and `FORBIDDEN_FOLD_KEYS` guard; precedence rules (head without verb → command; verb without head → ADD_ENTRY; both → `split_uncertain`; ≥ 7-digit run → phone; name only → OPEN low; heads matched only outside the name span); `parsePhone()` reusing `TA_MORPHS` units 0–9, Tamil/English digit words, "double/triple/rendu thadava", "o" = 0, grouping-agnostic, `phone_complete = /^[6-9]\d{9}$/` after `normalizePhone()` | 3 |
| `core/commands.ts` (new) | `Action`, `CommandParse`, `parseCommand(alts, customers, settings, opts)` wrapping `parseUtterance` | 1 |
| `test/fixtures/voice-utterances.json` | ~200 new cases in `cmd_add_customer`, `cmd_update_phone`, `cmd_update_note`, `cmd_update_name`, `cmd_open`, `cmd_balance`, `cmd_undo`, `cmd_statement`, `cmd_remind`, `cmd_vs_money`, `phone_dictation`, `noisy_partial`; invariants: `high` only with an explicit head + strong customer; no digits that were not spoken; money verbs never classify as commands; undo never without a head | 2 |
| `ui/voice/plan.ts`, `listen.ts`, `prefill.ts`, `banner.ts` | new `VoiceStep` variants; hold-to-talk on `mic-button.ts`; previews: customer form prefill, old → new dialog, undo confirm, chips row, follow-up chip; non-blocking AI pill | 4 |
| `ui/voice/prefs.ts` + `meta` | new `voice_stats` counters; `voice_log` table (phone-only, 30-day purge, erase-aware); Settings → Voice: "AI help" toggle (off), "STT fallback" toggle (off), "Keep voice log" (off), Clear, Share voice log (names → C-codes) | 2 |
| `platform/speech-native.ts` + `patches/@capgo+capacitor-speech-recognition+8.3.2.patch` | `contextualStrings` → `EXTRA_BIASING_STRINGS` on API ≥ 33; log `checkRecognitionSupport()`; settle 1.2 s when the partial is complete | 1 |
| Worker `api/src/routes/voice.ts` (new) | `POST /v1/voice/interpret`: device auth, per-shop daily cap 300 in D1 (`voice_quota(shop_id, day, n)`), 4 s `AbortController`, `env.AI.run('@cf/google/gemma-4-26b-a4b-it', {messages, tools})`, `ajv` validation, 422 on invalid, no body logging, no storage; `POST /v1/voice/transcribe`: multipart ≤ 500 KB, provider switch (`sarvam | azure | gemini_paid | workers_whisper`) by env secret, keyterms from the request, 4 s timeout, response discarded after reply | 2 |
| Spike (before the UI work) | run the 120 native sentences + the new command fixtures through the Worker; measure invalid-call rate, latency p50/p95, Tamil agreement with the grammar; decide gemma-4 vs llama-3.3-70b `json_schema` vs qwen3 | 1 |
| Field test | 100 counter utterances scored per section 4; then a **200-utterance noisy test set recorded in the shop** (with the owner's consent, names replaced by C-codes in the stored transcript, audio deleted after transcription) replayed through `window.__KK_FAKE_SPEECH__` in the e2e so noise regressions are caught in CI | 2 + 2 weeks elapsed |
| **Total** | | **≈ 18 developer-days** plus the two-week field window |

Order: (a) spike on the Worker → (b) grammar + fixtures + `voice_log` + counters → (c) hold-to-talk + biasing patch → field test → (d) UI previews and forms → (e) enable the LLM path only after the gate shows the grammar's unsure rate and the spike shows < 5% invalid calls → (f) STT fallback only if the gate fails after steps 1–3 of the ladder.

### 6.2 Cost table (per month, one shop, 10 h of speech)

| Configuration | ₹/month | Notes |
|---|---|---|
| **Default: Google on-phone + grammar + biasing + hold-to-talk** | **0** | the shipped path, plus patches |
| + Workers AI arbiter (gemma-4) | 0 | ≈ 20–40 calls/day ≈ 300–900 neurons of the free 10,000 **[likely]** |
| + Workers AI whisper second opinion | 0 | ≈ 930 neurons/day at full volume; 48% WER limits its value |
| + Azure F0 STT fallback | 0 to 5 h, then ≈ ₹88/h | card on the account (unverified) |
| + Sarvam saaras:v4 fallback on ~30% of utterances | ≈ 90 (₹100 credit first) | full volume ≈ 300 |
| + Gemini paid (2.5 Flash-Lite … 3.8 Flash) as STT or interpreter | 90–550 | billing account; no Tamil evidence for Lite |
| + ElevenLabs Scribe v2 | ✎ ≈ 530 (Starter $6/month, 27 h included) | outside India |
| Google STT v2 chirp_3 | ≈ 845 ($0.016/min; dynamic batch ≈ ₹160 but not real-time) | V2 has no free minutes; the 60 min/month is V1 only |
| AWS Transcribe | ≈ 1,270 ($0.024/min, per-second billing) **[likely]** | 60 min/month free for 12 months; 19.3% VoI |
| Wired headset | one-off ₹150–300 | often the best rupee spent |

### 6.3 Privacy (DPDP) — what leaves the phone in each mode

| Mode | Leaves the phone | Recipient | Stored? |
|---|---|---|---|
| Default | audio of the utterance | Google (as today; named as processor in the notice) | by Google per its terms; nothing by us |
| + biasing | customer names inside the recogniser intent | Google | same |
| + Workers AI arbiter | transcript alternatives + ≤ 8 names as refs; never phone, balance, note, code | Cloudflare (no training, no retention **[verified]**) | no; the Worker stores only the daily counter |
| + Sarvam fallback | audio + ≤ 50 names as keyterms | Sarvam, Azure Central India (trust center); **training opt-out and retention 0 set in the account first** **[verified: the policy says content is used for training unless you opt out, 30-day default retention, personal data may be processed outside India]** | per the setting |
| + Azure / Gemini paid / ElevenLabs / AWS | audio (+ phrase list) | vendor, outside India (AWS `ap-south-1` Mumbai is an option **(unverified for Tamil streaming)**) | per vendor DPA |
| `voice_log` | nothing; phone-only, never synced or backed up | — | 30 days, erase-aware, owner-clearable |
| Owner's log export | transcripts with names replaced by C-codes | whoever the owner shares it with | by the owner's choice |

The privacy notice shown on the first mic tap gains one line per toggle the owner switches on. Gemini free is excluded from every mode because its terms forbid personal information and allow training and human review **[verified]**.

### 6.4 Risks

| Risk | Mitigation |
|---|---|
| Google's `ta-IN` recogniser ignores `EXTRA_BIASING_STRINGS` (unverified) | one-day device test: 50 names × 3 noise levels; the patch is removable |
| gemma-4 tool-call reliability and Tamil competence unverified | spike first; thresholds (< 5% invalid); llama-3.3-70b `json_schema` or qwen3 as swaps; the grammar never depends on it |
| Command heads collide with names (Bill, Note, Page) | name-position rule, `FORBIDDEN_FOLD_KEYS`, fixtures |
| Noise makes commands longer and worse than money entries | chips row on UNKNOWN, hold-to-talk, page context; not more AI |
| Phone digit rendering by Google (digits vs words, grouping) unverified | grammar accepts all three; partial → keypad; alternative "contacts-la irundhu" → Android contact picker |
| Scope creep into hands-free execution | only read-only actions (open, balance) execute without a tap; invariants in tests |
| Sarvam account left on default (content used for training unless opted out, 30-day retention) | checklist item with a stored screenshot before the toggle can be enabled in the Worker |
| Free quotas change (Workers AI neurons, Azure F0, Gemini) | every external call is behind a toggle, a cap and a timeout; the grammar path is unaffected |
| A wrong name on a ledger row | name shown with C-code and phone last-4 on every confirmation; `name_edited` tracked; learned aliases (`fold(spoken) → customer.id` after two identical picks, score 0.9) stay per phone |

---

## 7. Sources

**Android / web platform.** https://developer.android.com/reference/android/speech/RecognizerIntent · https://developer.android.com/sdk/api_diff/33/changes/android.speech.RecognizerIntent · https://developer.android.com/reference/android/media/MediaRecorder.AudioSource · https://developer.android.com/reference/android/media/audiofx/NoiseSuppressor · https://developer.android.com/reference/android/bluetooth/BluetoothHeadset · https://developer.android.com/reference/kotlin/android/speech/RecognitionSupport.Builder · https://source.android.com/docs/core/audio/implement-pre-processing · https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json · https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/start · https://developer.chrome.com/blog/new-in-chrome-139 · https://github.com/Cap-go/capacitor-speech-recognition · https://github.com/Cap-go/capacitor-speech-recognition/releases · https://developer.android.com/reference/android/media/AudioManager#startBluetoothSco()

**Noise and named entities.** https://arxiv.org/pdf/2009.09395 · https://huggingface.co/blog/ffasr-leaderboard · https://www.isca-archive.org/interspeech_2015/jannet15_interspeech.html · https://preview.aclanthology.org/setup/2023.acl-long.98

**Gemini.** https://ai.google.dev/gemini-api/terms · https://ai.google.dev/gemini-api/docs/pricing · https://ai.google.dev/gemini-api/docs/rate-limits · https://ai.google.dev/gemini-api/docs/audio · https://ai.google.dev/gemini-api/docs/available-regions · https://discuss.ai.google.dev/t/3-5-flash-lite-is-slower-than-3-1-flash-lite-on-audio-input/177456 · https://discuss.ai.google.dev/t/audio-transcription-regression-gemini-3-5-flash-lite-has-3-55x-higher-wer-than-3-1-flash-lite-on-a-french-radiology-test-dataset/180033 · https://developers.google.com/ml-kit/genai · https://developer.chrome.com/docs/ai/prompt-api · https://ai.google.dev/gemma/docs/core/model_card_4 · https://developers.google.com/edge/litert-lm/overview · https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/tree/main · https://huggingface.co/google/gemma-4-E2B-it/tree/main

**Benchmarks and open models.** https://voiceofindiablogs.ai.joshtalks.com/ · https://arxiv.org/pdf/2608.08235 · https://arxiv.org/pdf/2602.03868 · https://huggingface.co/ARTPARK-IISc/SraVaani-1.0 · https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual · https://huggingface.co/csukuangfj/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12/tree/main · https://k2-fsa.github.io/sherpa/onnx/omnilingual-asr/index.html · https://huggingface.co/google/gemma-3-1b-it/discussions/45

**Cloudflare.** https://developers.cloudflare.com/workers-ai/platform/pricing/ · https://developers.cloudflare.com/workers-ai/platform/privacy/ · https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/ · https://developers.cloudflare.com/workers-ai/models/nova-3/ · https://developers.cloudflare.com/ai/models/@cf/google/gemma-4-26b-a4b-it/ · https://developers.cloudflare.com/workers-ai/features/json-mode/ · https://developers.cloudflare.com/workers-ai/features/function-calling/

**Other STT and LLM vendors.** https://docs.cloud.google.com/speech-to-text/v2/docs/chirp_3-model · https://cloud.google.com/speech-to-text/pricing · https://docs.cloud.google.com/free/docs/free-cloud-features · https://cloud.google.com/run/pricing · https://azure.microsoft.com/pricing/details/cognitive-services/speech-services · https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=stt · https://learn.microsoft.com/en-us/azure/ai-services/speech-service/improve-accuracy-phrase-list · https://aws.amazon.com/transcribe/pricing/ · https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html · https://deepgram.com/pricing · https://developers.deepgram.com/docs/models-languages-overview · https://www.assemblyai.com/pricing · https://www.assemblyai.com/docs/speech-to-text/pre-recorded-audio/supported-languages · https://elevenlabs.io/pricing/api · https://elevenlabs.io/docs/capabilities/speech-to-text · https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe · https://docs.sarvam.ai/api/getting-started/pricing.md · https://docs.sarvam.ai/api/changelog · https://www.sarvam.ai/blogs/introducing-saaras-v4 · https://www.sarvam.ai/trust-center · https://sarvam.ai/privacy-policy · https://sarvam.ai/terms-of-service · https://console.groq.com/docs/your-data · https://console.groq.com/docs/rate-limits · https://openrouter.ai/docs/api-reference/limits · https://www.truefoundry.com/blog/openrouter-free-models-whats-actually-free-and-what-it-costs-you · https://mintlify.wiki/cheahjs/free-llm-api-resources/providers/free/mistral-plateforme · https://developers.cloudflare.com/ai/models/@cf/meta/llama-3.3-70b-instruct-fp8-fast/ · https://developers.cloudflare.com/ai/models/@cf/qwen/qwen3-30b-a3b-fp8/

**Hosting.** https://huggingface.co/docs/hub/spaces-overview · https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm · https://support.google.com/googleplay/android-developer/answer/9859372 · https://ecorpit.com/ecorpit-indic-language-app-localization-service-india-2026/ (Bhashini, secondary)

**Local code.** `khata/app/src/core/voice.ts` · `khata/app/src/ui/voice/plan.ts` · `khata/app/src/ui/voice/prefs.ts` · `khata/app/src/platform/speech-native.ts` · `khata/app/node_modules/@capgo/capacitor-speech-recognition/android/src/main/java/app/capgo/speechrecognition/SpeechRecognitionPlugin.java` · `docs/VOICE_ACCOUNTS_SYNC_PLAN.md`
