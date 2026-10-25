# Kadan Kanakku (கடன் கணக்கு) app

An offline-first credit ledger (udhaar/khata) Android app for one grocery shop. It is built with Capacitor 8, TypeScript and Vite 8.
Other sections of this README cover the data, UI and sync layers.

<!-- ===================== Platform / Android (owner: platform) ===================== -->

## Android build

### Prerequisites

- Node 20+ and `npm ci` in this folder.
- JDK 21. Capacitor 8 and AGP 8.13 compile with Java 21.
- The Android SDK with platform 36 and build-tools 36. Point Gradle at it with `export ANDROID_HOME=/path/to/android-sdk`, or put `sdk.dir=...` in `android/local.properties`.

### Debug build (any machine, no keys needed)

```bash
cd app
npx tsc --noEmit -p .                 # typecheck
npx vite build --mode android         # web bundle into dist/ (__NATIVE_BUILD__ = true)
npx cap sync android                  # copy dist/ + plugin list into android/
cd android
./gradlew --no-daemon --max-workers=2 assembleDebug
```

The APK lands in `android/app/build/outputs/apk/debug/app-debug.apk`. It is about 13 MB because it includes all four ABIs, so it also runs on x86 emulators.

Debug builds install as **`live.zerox.kadankanakku.debug`**, labelled "Kadan Kanakku DEBUG", next to (never over) the real app. They are signed with the build machine's throwaway debug key, so a debug build is for testing only: it can never become the shop's ledger app, and a debug build from another machine will not install over it. The shop phone runs the release-signed `live.zerox.kadankanakku` only.

`npm run build:android` runs the first three steps in one go.

### What the Android project is set up to do

| Setting | Where | Why |
|---|---|---|
| `allowBackup="false"` + `dataExtractionRules` | `AndroidManifest.xml`, `res/xml/data_extraction_rules.xml` | Android Auto Backup would copy the live WAL-mode SQLite files as an inconsistent set. On Android 12+ `allowBackup="false"` no longer stops device-to-device transfer ("copy from old phone"), which would clone the ledger together with this phone's `device_id` and customer-code block; the rules exclude everything from both. A new phone gets its data by pairing (pull) or "Restore from file". Backups are the app's own snapshots plus sync. |
| Debug ID `….debug` | `app/build.gradle` (`applicationIdSuffix`) | A debug-key APK can never occupy the production ID on the shop phone. |
| Old WebView page | `capacitor.config.ts` (`server.errorPath`), `public/webview-old.html` | Below System WebView 80 Capacitor shows this Tamil/English "update Android System WebView" page instead of a blank screen. |
| Tamil + English only | `app/build.gradle` (`androidResources.localeFilters`) | Drops the ~90 other locales AndroidX would bundle. |
| No `captureInput` | `capacitor.config.ts` | It would replace the WebView's input connection with a dummy one, which breaks Tamil keyboards (no `input` events, no composing) and the dial pad for `type=tel`. |
| Permissions are INTERNET, ACCESS_NETWORK_STATE, VIBRATE and RECORD_AUDIO only | `AndroidManifest.xml` | RECORD_AUDIO is for voice entry (v2); it is a runtime permission asked on the first mic tap, and the audio goes to Google's speech service (never stored by the app). Storage, media, camera, MODIFY_AUDIO_SETTINGS, biometric, contacts and location permissions are stripped with `tools:node="remove"` even when a plugin merges them in. The merged manifest also has `live.zerox.kadankanakku.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. AndroidX defines it as a signature-level permission for the app's own broadcast receivers (the Share plugin uses it). Users never see it. |
| Speech service visibility | `AndroidManifest.xml` (`<queries>` for `android.speech.RecognitionService`) | Android 11+ package visibility: without it `SpeechRecognizer.isRecognitionAvailable()` cannot see Google's recogniser and voice reports "unavailable". |
| HTTPS only in release | `res/xml/network_security_config.xml` | Release builds trust only system CAs and refuse cleartext. |
| Cleartext allowed in debug | `src/debug/res/xml/network_security_config.xml` | This lets you test against `wrangler dev --ip 0.0.0.0` at `http://<LAN-IP>:8787`. Only debug builds get it. |
| Portrait, `adjustResize` | `MainActivity` in the manifest | The keypad screens are designed for portrait. The WebView shrinks above the soft keyboard. |
| Edge-to-edge | `capacitor.config.ts` (`SystemBars`, `StatusBar`) and `res/values/styles.xml` | targetSdk 36 makes edge-to-edge mandatory. Capacitor's SystemBars plugin (`insetsHandling: 'css'`) pads the WebView away from the system bars. On WebView 140+ with `viewport-fit=cover`, the page draws under the bars instead, and `env(safe-area-inset-*)` and the injected `--safe-area-inset-*` variables give the real insets. The bars sit on brand green `#0f5132` with light icons. |
| FileProvider | `res/xml/file_paths.xml` | Only `cache/share/` is exposed. `platform().shareFile()` writes files there before opening the share sheet. |
| Icon | `resources/icon-shapes.mjs` → `node resources/render-icons.mjs` | There is an adaptive icon (vector foreground, green background, monochrome layer for Android 13 themed icons) and legacy PNGs for mdpi to xxxhdpi, in square and round versions. `resources/icon.svg` is the 512 px master. Re-run the script after changing the shapes. It needs Playwright's Chromium. |
| Splash | `styles.xml` (`AppTheme.NoActionBarLaunch`) and `drawable/splash.xml` | A plain green screen with the ledger icon. Android 12+ uses the system splash attributes. Android 7-11 shows the window background. |
| App name | `res/values/strings.xml` and `res/values-ta/strings.xml` | "Kadan Kanakku", or "கடன் கணக்கு" on phones set to Tamil. |
| Release ABIs | `app/build.gradle` | Release builds keep only `arm64-v8a` and `armeabi-v7a` (phones). Debug builds keep every ABI. |

### Checks before shipping an APK

```bash
BT=$ANDROID_HOME/build-tools/36.0.0
$BT/zipalign -c -P 16 -v 4 app/build/outputs/apk/release/app-release.apk   # "Verification successful"
unzip -o -q app/build/outputs/apk/release/app-release.apk 'lib/*' -d /tmp/kk-lib
readelf -lW /tmp/kk-lib/lib/arm64-v8a/*.so | grep LOAD                     # every LOAD alignment is 0x4000 (16 KB)
$BT/aapt2 dump permissions app/build/outputs/apk/release/app-release.apk  # INTERNET, ACCESS_NETWORK_STATE, VIBRATE, RECORD_AUDIO (+ the signature-only receiver permission)
```

The only native library is `libsqlcipher.so`, which comes from `@capacitor-community/sqlite`. It ships 16 KB-aligned (`0x4000`) for every ABI, so the APK meets the Android 15+ 16 KB page-size requirement.

### Speech-to-text (voice entry, v2)

`platform().speech` (`src/platform/types.ts` → `Speech`) hides the recogniser:

| Where | Engine | Notes |
|---|---|---|
| Android | Google `SpeechRecognizer` via `@capgo/capacitor-speech-recognition` **8.3.2** (pinned exactly: newest release at least two weeks old at install time; review the Capgo diff before bumping) | `src/platform/speech-native.ts`. Inline recognition (`popup:false`), `partialResults:true`, up to 5 alternatives requested (how many Google returns for `ta-IN` is unverified, often one). Customer-name biasing: the stock plugin ignores `contextualStrings` on Android, so `patches/@capgo+capacitor-speech-recognition+8.3.2.patch` (applied by `patch-package` on `npm install`) makes `start()` put it into `RecognizerIntent.EXTRA_BIASING_STRINGS` on Android 13+ (see "Hold to talk and name biasing" below). Needs Google's speech service (missing on non-GMS ROMs → `available()` false) and internet unless an offline pack is installed. |
| Browser / web app | Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`) | `src/platform/speech-web.ts`. Chrome is the tested target (audio goes to Google); Firefox has no API (`available()` false). Bias phrases are sent only where `SpeechRecognitionPhrase` exists. |
| Tests / e2e | `createFakeSpeech(script)` | `src/platform/fake-speech.ts`. In the web build, `window.__KK_FAKE_SPEECH__ = [["ராமு 100 குடுத்தாச்சு", ...], ...]` (set before the first mic tap, e.g. with Playwright `addInitScript`) replaces the recogniser; `[]` = silence, `["!SPEECH_ERROR:NETWORK"]` = failure; `window.__KK_FAKE_SPEECH_OPTIONS__ = {delayMs, available, permission}`. |

`listen()` rejects with `SPEECH_UNAVAILABLE`, `SPEECH_PERMISSION` or `SPEECH_ERROR:<code>`; silence resolves `[]`. After our own `stop()` (mic tap, the `maxMs` cap, or the app going to the background: `native.ts` / `web.ts` stop the session on `appStateChange` / `visibilitychange`) the session always resolves with what was heard, because Google often answers `stopListening()` with `ERROR_CLIENT` instead of a result. Errors that happened before the stop are still reported. Because the plugin starts Google's recogniser in `DICTATION_MODE` (Gboard voice typing), which may keep a session open across pauses instead of ending it after ~1 s of silence, the Android adapter also ends the session itself `PARTIAL_SETTLE_MS` (2.5 s) after the partial transcript last changed; pure silence is still ended only by `maxMs`. A `start()` rejection that never produced `startingListening` (unavailable, no permission, a bridge-level error) leaves the adapter idle at once; only `already running` keeps it waiting for the live native session's `stopped`.

Privacy: `SPEECH_PRIVACY_NOTE` (`src/platform/speech-common.ts`, re-exported from `src/platform/index.ts`) holds the Tamil and English notice that voice audio is sent to Google (Android's speech service, Chrome's backend), that internet is needed, that the app keeps no audio and that nothing is saved before Save is tapped. `localRecognitionAvailable(lang)` in `speech-web.ts` feature-detects Chrome 139+'s on-device mode (`SpeechRecognition.available({langs, processLocally:true})`) inside try/catch; it is informational only and `listen()` never sets `processLocally` (no Tamil pack is known).

Plugin facts the Android adapter relies on (read from `node_modules/@capgo/capacitor-speech-recognition/android/.../SpeechRecognitionPlugin.java`, JS version 8.3.2, native `PLUGIN_VERSION` string "8.1.11"): `available()` = `SpeechRecognizer.isRecognitionAvailable`; `checkPermissions()`/`requestPermissions()` map the `speechRecognition` alias to `RECORD_AUDIO` (`granted`/`denied`/`prompt`); `start()` rejects with code `UNAVAILABLE`, message `Missing permission` or `Speech recognition is already running.`, otherwise resolves as soon as `startListening()` ran (`partialResults:true`) and reports through `listeningState` (`startingListening` → `started` → `stoppingListening` → `stopped`, with `sessionId`, `reason`, `errorCode`), `partialResults` (`matches`; also carries the final `onResults` list, `EXTRA_MAX_RESULTS` = `maxResults`) and `error` (`getErrorCode()` names). `stop()` posts `stopListening()` and forces `finishSession('userStop')` after 500 ms. `buildRecognizerIntent()` sets `EXTRA_LANGUAGE`, `EXTRA_MAX_RESULTS`, `EXTRA_PARTIAL_RESULTS`, `DICTATION_MODE` and (with the patch, Android 13+) `EXTRA_BIASING_STRINGS`; `prompt` only matters with `popup:true`. The plugin ships no native library and its manifest adds only `RECORD_AUDIO`.

## Signing a release

A release APK has to be signed with **the same key every time**. Android refuses to update an installed app that was signed with a different key, and the only way out is to uninstall it, which **deletes the shop's local ledger**. Create the key once, keep it with its passwords in two safe places (for example a password manager and an offline USB stick), and never commit it.

### 1. Create the keystore (once)

```bash
cd app/android
keytool -genkeypair -v \
  -keystore kadan-kanakku-release.jks \
  -storetype PKCS12 \
  -alias kadankanakku \
  -keyalg RSA -keysize 4096 \
  -validity 10000 \
  -dname "CN=Kadan Kanakku, O=Zero X, C=IN"
```

`keytool` asks for a store password. With PKCS12, the key password is the same as the store password.

### 2. `android/keystore.properties`

Create `app/android/keystore.properties` next to `settings.gradle`:

```properties
# Paths are relative to the android/ folder, or absolute.
storeFile=kadan-kanakku-release.jks
storePassword=the-store-password
keyAlias=kadankanakku
keyPassword=the-store-password
```

`keystore.properties`, `*.jks` and `*.keystore` are listed in `android/.gitignore`. `app/build.gradle` only reads the file if it exists. Without it, `assembleRelease` still works and produces `app-release-unsigned.apk`, which is useful in CI.

### 3. Build the release APK

```bash
cd app
npx tsc --noEmit -p . && npx vitest run
npx vite build --mode android && npx cap sync android
cd android
./gradlew --no-daemon --max-workers=2 assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk` (signed). Check it with:

```bash
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
```

Bump `versionCode` (by +1, always) and `versionName` in `android/app/build.gradle` for every build you hand out. A phone will not install an APK whose `versionCode` is lower than the installed one.

### 4. Install on the shop's phone over USB (`adb`)

```bash
adb devices                       # the phone must show as "device", not "unauthorized"
adb install -r app/build/outputs/apk/release/app-release.apk   # -r keeps the app's data (the ledger)
# debug build instead:
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`-r` replaces the app and keeps its data. **Never** `adb uninstall` the shop's phone or run `pm clear` on it, because both wipe the local ledger. Debug builds have their own ID (`live.zerox.kadankanakku.debug`) and install as a separate "DEBUG" app, so they never block the release app; do not keep real shop data in a debug copy, because it lives under a key that only exists on the machine that built it. Every release APK must be signed with the same release keystore (keep two copies off the build machine, see step 1); an APK signed with any other key cannot update the installed app.

If `adb install` fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, the installed copy was signed with a different key. Stop there and do not uninstall a phone that holds real data. Back up first (Settings → Backup → "Save a backup copy"), then install.

To debug the WebView on a connected phone with a debug build, open `chrome://inspect` in desktop Chrome.

### Enabling USB debugging on a Redmi / Xiaomi phone (MIUI or HyperOS)

1. **Settings → About phone**. Tap **MIUI version** (on HyperOS: **OS version**) **7 times** until it says "You are now a developer". Enter the phone's PIN if asked.
2. **Settings → Additional settings → Developer options**. On some HyperOS builds this is under **Settings → System → Developer options**.
3. Turn on **USB debugging**.
4. Turn on **Install via USB**. MIUI requires this before `adb install` is allowed. Without it, installs fail with `INSTALL_FAILED_USER_RESTRICTED`.
   - This toggle needs a **Mi account signed in** and usually a **SIM card with mobile data on**, because Xiaomi checks online. If it says "temporarily restricted", sign in to the Mi account, enable mobile data, wait a few minutes, and try again.
5. Optional: turn on **USB debugging (Security settings)**. Some MIUI versions need it so that `adb` can grant permissions or simulate input. Plain `adb install` does not need it.
6. Connect the cable. If the phone asks for the USB mode, pick **File transfer**. Then accept the **"Allow USB debugging?"** RSA fingerprint prompt (tick "Always allow from this computer").
7. On the computer, run `adb devices`. It should list the phone as `device`.
8. During install, MIUI may show an **"Install via USB"** confirmation on the phone with a countdown. Tap **Install** within the time limit, or the install fails with `INSTALL_FAILED_USER_RESTRICTED`.
9. Xiaomi phones can block the app from starting in the background. That does not affect v1, because sync runs while the app is open. If the shopkeeper complains about missed syncs later, set **Settings → Apps → Manage apps → Kadan Kanakku → Battery saver → No restrictions** and turn **Autostart** on.

When setup is finished, you can turn **USB debugging** off again on the shop's phone. The app keeps working.

<!-- =================== end Platform / Android section =================== -->

<!-- =================== Accounts & web app (v2) =================== -->
## Accounts and the web app (v2)

Besides pairing with a code, a phone can **sign in with a user id and password** (on first launch: "Sign in to my
shop"; later: Settings → Shop server → "Sign in with user id & password"), and the owner can use the **web app**
that the Worker serves at the server address (`https://<name>.workers.dev/`). Protocol: `shared/protocol.ts`
("v2: accounts"); server side: `khata/api/README.md`.

| Piece | Where | Notes |
|---|---|---|
| Password stretching | `src/sync/password.ts` | `deriveClientKey(password, salt, iterations)` = PBKDF2-HMAC-SHA256 (WebCrypto, NFC-normalised password, 600,000 iterations, 32 bytes, base64url). The password never leaves the device; the server stores only `HMAC(PEPPER, client_key)`. ~0.1 s on a laptop, up to a few seconds on a budget phone: the button shows "Securing the password…". |
| API client | `src/sync/api.ts` | `mode: 'bearer'` (Android, paired phones: `Authorization: Bearer`) or `mode: 'cookie'` (web app: same-origin relative URLs, `credentials: 'same-origin'`, `X-KK-Client: web` on every request, no Authorization header, no token in storage). New routes: config, prelogin, login, nonce, google, logout, users (list/create/update/password), auth events. Owner-power calls take a `StepUpProof` (`X-KK-Stepup` = current client_key, or `X-KK-Recovery` = printed code). |
| Engine | `src/sync/engine.ts` | `login()` = prelogin → derive → `/auth/login` → the same `completePairing` path as a code pairing → first sync. Android stores the token and the `known_device` value in secure storage (sent as `X-KK-Known` on later logins: exempt from the per-network lockout). `logout({removeData})` revokes the session (`force` when offline). `stepped()` retries an owner call with a proof from the step-up provider (`src/ui/screens/login.ts` `stepUpDialog`: password or recovery code; the server keeps the device stepped up for 5 minutes). `listUsers / createUser / updateUser / resetPassword / changeOwnPassword / authEvents`. The signed-in account is kept in the private file `account.json` (names only, never credentials). |
| Android UI | `src/ui/screens/settings.ts`, `src/ui/screens/login.ts` | "Account" block (signed in as…, Change my password, Sign out: keep or remove the ledger), "Create a login for me" for a code-paired owner phone (`link_me`, no step-up while the shop has no users), owner "Users" (add with user id / name / role / password twice / optional Gmail; reset password; disable/enable) and "Activity" (`GET /auth/events`). |
| Web app | `src/ui/web/**`, `vite build --mode web` → `dist-web/` (`__WEB_APP__`) | Login gate (`login-gate.ts`): owner's user id + password, Google button only when `/v1/config` returns a `google_client_id` (nonce from `/auth/nonce`), "This is a shared computer" (in-memory sql.js database, in-memory private files, `shared_computer: true` → 12 h session, cookie without Max-Age), language toggle. The text under the box states what happens in the state it is in (unticked: a copy stays in this browser, 30-day session, Sign out removes it; ticked: nothing kept, 12 h). Boot order (`boot.ts`): a persisted copy is opened only when one already exists; otherwise the app starts on an in-memory database, asks `GET /me` whether the cookie still names a session and, only when the server says it is **not** a shared one (`device.shared`), switches to the persisted database. A reload on a shared computer therefore rebuilds the ledger in memory again and never writes IndexedDB; an unknown answer counts as shared. Staff get the `web_owner_only` refusal in Tamil and English. After login: full pull, then the normal UI with the "Online copy" pill. A 401 (expired/revoked session) shows the unsynced count, wipes IndexedDB + localStorage and returns to the login page; Sign out does the same. "+ Customer" works only online and in sync: the browser gets no code block at login and asks for one on demand (`requestCodes()`). Phone-only controls (PIN, pairing form, Call, user management) are hidden. |
| Tests | `test/sync.password.test.ts`, `test/sync.accounts.test.ts` | PBKDF2 vector against Node's `pbkdf2`, NFC, bounds, timing; logins, lockout + known device, cookie mode, step-up, user management, Google (fake), web restrictions against the fake server (`test/helpers/fake-server.ts`, which now has users, logins, a cookie jar, step-up and audit events). |
| End to end | `node e2e/web-login.mjs` | Builds `dist-web`, starts `wrangler dev --local` on a fresh D1 (`api/.wrangler/e2e-web-state`, migrations applied), bootstraps shop + owner phone + logins through the API, drives Chromium through login (ta/en), wrong password, staff refusal, sign-in, synced customers, an entry and a customer, Settings, session revoked from the phone, sign out (storage wiped), shared-computer mode including a reload (still no IndexedDB, same session). Screenshots `e2e/screenshots/web-*.png`. |

Deploy: `tools/deploy-server.sh` builds the web app (`npm ci && vite build --mode web` in this folder) before
`wrangler deploy` and prints the web app URL. The web app's security headers (CSP with `'wasm-unsafe-eval'` for sql.js
and the Google Identity Services origins) come from `khata/api/web/_headers`.
<!-- =================== end Accounts & web app =================== -->

<!-- =================== Fast sync (2.3.0) =================== -->
## Fast sync: several counters, one ledger (2.3.0)

One shop with several phones: an entry saved at one counter shows on the others within about 20 s, and a customer's
page is fetched fresh when it opens. Polling, no server change and no push service: a phone asks the server for
other phones' rows (the change log, `since=<cursor>`), which costs one small request when nothing is new.

| Piece | Where | Notes |
|---|---|---|
| Timers | `src/sync/engine.ts` | `DEBOUNCE_MS` 2 s after a save (a burst goes out in one push), `INTERVAL_MS` 20 s while the app is open and in use, `IDLE_INTERVAL_MS` 1 min after `IDLE_AFTER_MS` (5 min) with no touch (`notifyActivity()`), no save and nothing new from other phones; coming back to the app, a save or other phones' rows count as use. Backoff on errors as before (5 s … 1 h). |
| Sync button (2.3.1) | `src/ui/components/sync-button.ts`, `home.ts` | Top right of Home's green bar, only while the phone is connected (hidden when unpaired or removed). Tap → `syncNow()` (manual: no backoff, tried even when Android reports offline) with a spinning icon, then a toast from `syncResultText()`: "Synced. N updates from the other phones." (rows pulled, counted with `onRemoteChange`), "Synced. Everything is up to date.", "N to send to server", "No internet…", the server error, or "Removed from shop". It cannot make another phone pull. Also on the web app. |
| No double send | `src/sync/engine.ts` | The 2-s timer after a save is skipped when a cycle began after that save (a screen's `refreshIfStale()` or Sync now already pushed it), so a save costs one push + one pull, not an extra empty cycle. |
| Quiet polls | `src/sync/engine.ts` | The 20-s poll and `refreshIfStale()` do not set the "Syncing" phase, so the pill does not flash; a save, network regained and Sync now still show it. |
| Fresh on open | `refreshIfStale()` in `home.ts`, `customer.ts`, `daybook.ts`, voice mode's card | Syncs at once when the last cycle ended more than `FRESH_MS` (5 s) ago; respects the backoff; no-op when unpaired. The balance told to a customer includes the other counters' entries. The first touch after an idle spell does the same (`notifyActivity()`). |
| Live redraw | `src/ui/live.ts` | `onRemoteChange(n)` after a cycle that pulled other phones' rows → re-render Home, a customer's page, the day book, a statement or quick entry, but only when safe: no focused input / textarea / select, no dialog or sheet (`hasLayers()`), not behind the PIN gate; otherwise retried every 1.5 s until safe or the person moved on. The keypad, the customer form and Settings never redraw under the person's fingers. Voice mode refreshes its customer list and the open card (`voice/mode.ts`). A touch or key press anywhere calls `notifyActivity()`. |
| Sign in on first launch | `src/ui/screens/onboarding.ts` | After the language: **Sign in to my shop** (user id, password, phone name; the server address only when the APK has none built in) or **Start a new shop** (the v1 flow). Then the PIN step. |
| Built-in server address | `src/ui/shop-server.ts`, `tools/build-release-apk.sh` | `SHOP_SERVER_URL=https://… ./tools/build-release-apk.sh` → Vite `VITE_SHOP_SERVER_URL` → `BUILT_IN_SERVER`: sign-in shows "Shop server: <host>" with a Change link instead of an address box, and Settings → Shop server is prefilled. Empty in a generic build. |
| Owner login at setup | `src/ui/screens/settings.ts` | Settings → Shop server opens on "Sign in"; First-time setup asks for the owner's user id and password (twice) and creates the login right after pairing (`createUser({ role: 'owner', link_me: true })`, allowed without step-up while the shop has no users). If that fails the phone stays paired and "Create a login for me" remains. |
| Language per phone | `src/data/repo.ts` (`applyPullPage`, `completePairing`), `settings.ts` | The language is no longer copied from the shop on every pull (with 20-s polls that would undo a choice within seconds): each phone and browser keeps the one picked on it. |
| Server load | `khata/api` | An empty pull = three indexed reads in one batch + the device-row update in the auth middleware. A busy counter phone left open day and night makes about 4,000 requests a day; `DAILY_REQUEST_CAP` is now 10,000 per device; Workers Free allows 100,000 requests and 100,000 D1 row writes per day for the shop. |
| Tests | `test/sync.triggers.test.ts`, `test/repo.sync.test.ts`, `test/ui.sync-button.test.ts` | the Sync button's sentences (en/ta), no double send, 2-s debounce, 20-s poll only in the foreground, quiet polls, `refreshIfStale` (fresh / stale / unpaired / backoff), `onRemoteChange` after another phone's entries only, idle slow-down and what counts as use; the language stays per phone. |
| End to end | `node e2e/multi-device.mjs` | `wrangler dev --local` on a fresh D1 + a build with the server built in + two Chromium contexts (owner phone, counter phone, `--disable-web-security` for the cross-origin API). Owner: new shop, First-time setup with a login, a staff user (step-up). Counter: Sign in to my shop (built-in server line, wrong password refused), phone name "Counter 2". Owner → counter entry on the counter's open Home, a customer page fresh on open, counter → owner entry with the "Counter 2" badge, the Sync button (hidden before connecting, top right after; the owner's entry on the counter 0.1 s after the tap; "No internet…" when offline), counter offline ("1 to send to server") then caught up, a focused search box not redrawn until it loses the focus, no console errors. Screenshots `e2e/screenshots/md-*.png`. Measured: 19–20 s between counters (the 2-s push plus up to one 20-s poll), a customer page fresh in 0.1 s, an offline phone's entry on the other phone 16 s after it is back online. |
<!-- =================== end Fast sync =================== -->

<!-- =================== Voice entry (v2) =================== -->
## Voice entry (v2)

The shopkeeper can speak an entry instead of typing it: a round mic button beside the Home search, a mic icon in the
customer page's top bar and one beside the quick-entry search (all hidden when Settings → Voice entry is Off, or
while the ledger is still empty). Everything is free: Android uses Google's speech service on the phone, the web app
uses Chrome's Web Speech API, and the parser is a small rule-based lexicon inside the app (`src/core/voice.ts`,
no cloud NLU, no paid API).

**Rule that never bends: money is never saved from voice.** Listening ends on the normal entry keypad, prefilled,
with a "Heard: “…”" banner, and only the shopkeeper's tap on **Save** writes the entry (the same Save path, with the
same large-amount / advance / duplicate confirmations and the Undo toast).

| Piece | Where | Notes |
|---|---|---|
| Parser | `src/core/voice.ts` | `parseUtterance(alternatives, customers, settings, {contextCustomerId})` → one `VoiceIntent` per spoken entry: customer matches (fuzzy, transliteration-tolerant, Tamil script or Tanglish), amount (digits, Tamil or English number words, "ஐநூறு", "two fifty", lakh), direction, note, confidence. Direction: `-kku` (dative) + gave = **DEBIT** (பற்று, goods given on udhaar); "Ramu 100 kattinaan / kuduthaachu" (no `-kku`) = **CREDIT** (வரவு, payment received); a bare "kuduthaachu" without `-kku` follows the shop's setting; "paaru / parru / paru" are never read as பற்று. When Google returns several alternatives and they disagree on the amount or on the dative, the parser caps confidence or leaves the direction unset. Lexicon: `LEXICON_SIZE` surface forms + 12 regex conjugation fallbacks. |
| Flow | `src/ui/voice/listen.ts`, `plan.ts`, `prefill.ts` | First tap: the privacy notice (`SPEECH_PRIVACY_NOTE`, remembered). Then recogniser check → internet check → mic permission → listening bottom sheet (pulsing mic, live partial transcript, hint, Cancel / Done, 12 s cap). One strong match (score ≥ 0.85 and 0.10 ahead) or the page's own customer → the keypad; several candidates → a picker (name, code, balance); nobody → "Add new customer “Suresh”?" → customer form → keypad; "Ramu baaki evvalavu" → balance dialog; no name on Home → "say the name too". Two entries in one sentence run as a queue ("1 of 2"). |
| Entry screen | `src/ui/screens/entry.ts`, `src/ui/voice/banner.ts` | Banner with the heard words, the amount source in large type ("five hundred → ₹500"), balance before → after, "check before saving" for medium/low confidence, other heard amounts as chips ("Or did you say: ₹100 ₹1,000"). Direction unclear → neither Debit nor Credit preselected, title "Debit or Credit?", Save disabled until one is tapped. |
| Settings | `src/ui/voice/settings-section.ts` | On/Off, spoken language (தமிழ் / English), what a bare "Ramu 100 kuduthaachu" means in this shop (Credit — paid, default; or Debit — took goods), **Try voice** (speak or type a sentence, see customer / amount / direction / confidence; saves nothing), local counters (heard, saved, amount changed, Debit/Credit changed, cancelled; `voice_stats` in meta, never synced) and the privacy line. Prefs in meta key `voice_prefs`. |
| Speech engines | `src/platform/speech-*.ts` | See "Speech-to-text (voice entry, v2)" above: Google `SpeechRecognizer` on Android (`@capgo/capacitor-speech-recognition`), Web Speech in Chrome, `window.__KK_FAKE_SPEECH__` in tests and e2e. |
| i18n | `voice.*` block at the end of `src/i18n/en.ts` / `ta.ts` | Shop Tamil, not textbook Tamil ("கேட்கிறேன்…", "பற்றா, வரவா?"). |
| Tests | `test/voice.test.ts` (fixture cases in `test/fixtures/voice-utterances.json` + `voice-customers.json`, per-category accuracy printed), `test/review-voice.test.ts` (120 reviewer utterances with a confusable-name shop list: 0 wrong directions, 0 wrong 'high'), `test/ui.voice.test.ts`, `test/platform.speech.test.ts`, `test/review-speech-platform.test.ts` | Every fixture enforces the safety invariants: 'high' only with an undisputed amount, an explicit verb or label and one clearly best customer. |
| End to end | `node e2e/voice.mjs` | Chromium with the fake recogniser: Credit, Debit with a note, two Ramus → picker, page customer kept, new customer, unclear direction (Save disabled), two entries in one sentence, disagreeing alternatives → chips, balance question, silence, NETWORK error, unavailable, counters, bare-meaning flip, English UI, Voice Off hides the mics. Screenshots `e2e/screenshots/voice-*.png`. |

Known weak spots (in-distribution fixtures, not field data): a second number next to the rupee word can win
("Senthil 300 pathu rooba" → ₹10, the keypad shows it and the shopkeeper corrects it); the amount/dative cross-check
only helps when Google returns more than one alternative (ta-IN often returns one); honorifics and fillers are
handled from a fixed list.

### Hold to talk and name biasing (2.0.1)

**Hold to talk** (Settings → Voice entry → "How the mic works", default on): press and hold a mic button, speak with
the phone near the mouth, release to finish. The release ends the recogniser session at once (`releaseVoice()` in
`src/ui/voice/listen.ts` → `speech.stop()`; the adapters resolve with what was heard so far) and the sheet shows
"Finishing…" without a Stop button, so the session is over before a bystander speaks: in a noisy shop this replaces
endpointing by silence. A press shorter than `HOLD_MIN_MS` (350 ms, `src/ui/voice/press.ts`) is a tap and listening
goes on until Stop, the adapter's settle time or the 12 s cap; "Tap to talk" in Settings keeps the old behaviour for
every press. The buttons use Pointer Events with pointer capture (`bindPress()`), suppress the long-press context menu
and have `touch-action: none` / `user-select: none` (`voice.css`). The big mic in the sheet works the same way: a tap
while listening is Stop, after a failure a press is "Try again" (hold and release, or tap). The scripted fake takes
`stopDelayMs` (`window.__KK_FAKE_SPEECH_OPTIONS__`) so e2e can see the "Finishing…" state (`e2e/voice.mjs` flows
13-16, screenshots `voice-*-hold-*.png`); the press logic is unit-tested in `test/ui.press.test.ts`.

**Name biasing**: `speech-native.ts` now sends the customer names (`biasPhrases`, trimmed, de-duplicated, at most 200
of at most 100 characters: `biasList()`) as `contextualStrings`. The plugin's Java `start()` is patched
(`patches/@capgo+capacitor-speech-recognition+8.3.2.patch`, `patch-package`, regenerate with `npm run patch:speech`
after editing the plugin in `node_modules`) to read the array (strings only, trimmed, capped at 100 chars / 500
entries) and put it into `RecognizerIntent.EXTRA_BIASING_STRINGS` (API 33+) in `buildRecognizerIntent()`, including
the continuous-PTT restart path; below Android 13 nothing is sent. The patch adds no permission (check the merged
manifest after `assembleDebug`). **Whether Google's recogniser honours the biasing for `ta-IN` is unverified: it has to
be checked on the phone** (say a customer name that Google used to mis-hear, with and without the names in the list).
### Speak button and auto-save (2.1.0)

**Speak button.** Home always shows a big red "Speak / பேசு" button at the bottom left (`micFab()` in
`src/ui/voice/mic-button.ts`), even on an empty ledger and even when voice entry is switched off: pressing it turns
voice entry back on (`saveVoicePrefs({on:true})`) and starts listening, hold or tap as configured. The customer page
keeps its small header mic, which is still hidden when voice is off.

**Auto-save** (Settings → Voice entry → "Clear voice entries" → "Save automatically", default on; `src/ui/voice/quick-save.ts`).
When one utterance names a known customer, an undisputed amount and an entry word ("Ramu 100 kattinaan", "Ramukku 250
kuduthen", "Ramu debit 300") the app shows a card with what it heard, the customer, Debit/Credit, the amount in figures
and words and the balance before → after, counts down `AUTO_SAVE_SECONDS` (3 s) and saves the entry. Cancel discards
it, Edit opens the usual prefilled keypad, Save now skips the wait, and the toast after saving offers Undo (a
reversal). `autoSaveEligible()` only allows the safe case: parser confidence `high`, today's date, no alternative
amount, below the "confirm above" amount, not a repeat of the same customer/kind/amount saved on this phone in the
last minute, and not a payment larger than the due. Anything else (several entries in one breath, two Ramus, a new
name, a missing direction, back-dated) goes to the keypad as before. Unit tests: `test/ui.quick-save.test.ts`; e2e:
`e2e/voice.mjs` flow 20 (screenshots `voice-*-auto-save-card.png`, `voice-*-auto-saved.png`).
### Shop slang for entries (2.1.1)

Phrases where the direction comes from கடன் plus a common verb are now explicit (`nounverb` cues in
`src/core/voice.ts`, resolved as `idiom:kadan-<verb>` in `resolveKind()`, confidence `high`, so they can auto-save):

| Said | Means | Entry |
|---|---|---|
| கடன் சொல்லிருக்கான் / kadan sollirukkan, kadan sonnaan | asked to put it on credit | Debit |
| கடன் வச்சிருக்கான் / kadan vachurikkan, kadan vachaan | has run up a debt | Debit |
| கடன் கேட்டான் / kadan kettaan | asked for credit | Debit |
| கடனை கட்டிட்டான் / kadanai kattitaan | paid the debt (the kattu verb decides) | Credit |
| கடனை அடைச்சிட்டான் / kadanai adaichitaan | cleared the debt | Credit |
| வரவு வச்சிருக்கான் / varavu vachirukkan | put it as varavu (the வரவு label decides) | Credit |

The vai/sol/kel/adai verbs alone ("Ramu 100 vachirukkan") decide nothing and open the keypad without a direction;
before 2.1.1 "vachirukkan" was fuzzy-matched to vaangirukkaan (Debit). These phrases are also sent to the recogniser
as biasing strings after the customer names (`ENTRY_BIAS_PHRASES`, Tamil script for ta-IN). Fixtures: category
`slang` in `test/fixtures/voice-utterances.json`; e2e: flow 20.
### Registered vs new customers (2.1.2)

`matchCustomers()` scores a spoken name against each customer's folded name (`nameKey`: Tamil and Latin spellings
meet, and an h between vowels is a k, so Rahul = Raghul = ராகுல், Mohan = மோகன்). The distance (`nameDist`) is a
Levenshtein where e/i and o/u swaps cost half and the short u/i Tamil puts between consonants costs a quarter
(பிரியா = Priya, லட்சுமி = Lakshmi); any consonant change costs a full edit, and a final -a/-i (Kumar / Kumari,
Vasanth / Vasantha) is capped at 0.75. `src/ui/voice/plan.ts` then decides:

| Best score | What happens |
|---|---|
| ≥ 0.95 (`EXACT_SCORE`): same name, other spelling/script, or learned | keypad, or auto-save when everything else is clear |
| ≥ 0.85 and 0.1 ahead (`STRONG_SCORE`) | keypad for that customer (never auto-save) |
| 0.8 – 0.85, or a tie | picker, with "Add <name>" whenever the name is not exact |
| < 0.8 (`NEW_NAME_BELOW`), or nobody | "Add a new customer?" sheet: **Add <name>** first, similar names under "Or did you mean" |

So "ramu gives me 500rs credit" with only Rahul in the book (0.6) offers to add Ramu, with Rahul below. Over the 6,642
ordered pairs of 82 common shop names in `test/voice.names.test.ts` no two different names reach 0.85.

**Learned names**: picking a customer for a name that was not exact ("Raghu" -> Rahul) stores the spoken form on this
phone (`src/ui/voice/aliases.ts`, meta `voice_aliases`, at most 300, never synced); next time it matches that customer
at 1.0. A learned form that later becomes a real customer's name is ignored. Settings → Voice entry → "Learned names"
lists them and can forget them all. The "Try voice" tester shows "heard “…”, NN% match" for non-exact names.
### Voice mode: keeps listening, every entry approved (2.2.0)

Home → **Voice mode** (bottom bar) opens a screen that keeps listening until **Stop**, so an employee can say entries
one after another with the phone lying on the counter:

```
listening ──"Ramu 500 kudukkanum"──> card: Ramu · ₹500 · Debit · Due ₹300 → ₹800
             [Skip] [Edit] [Approve Debit ₹500] ──Approve──> saved, "This session" list (Undo) ──> listening …
```

- **One session after another** (`src/ui/voice/mode.ts`): each recogniser session ends on silence, on Google's own
  end of speech, at `MODE_LISTEN_MS` (20 s) or early: a complete entry (name, amount, entry word) that stays the same
  for `EARLY_STOP_MS` (0.9 s) in the live transcript stops the session even if the shop keeps talking after it
  (`StableSignature`, `entrySignature()` in `mode-logic.ts`). The next session starts 0.25 s after the last one; a
  session that ends at once with nothing backs off (0.5 s … 5 s) instead of spinning.
- **Counter talk is ignored** (`modeAction()`): a card only for an amount plus a customer in the book (direction may be
  missing: the card asks Debit or Credit), or an amount plus an entry word for a name nobody has (a new-customer card:
  "Add “Seenu” & approve"). "arisi 50 rupa", greetings and prices only show on the status line ("Not an entry: …",
  "say the amount too"); "Ramu baaki evvalavu" answers "Ramu: Due ₹800" there.
- **The microphone is off while a card waits**: nothing queues up behind it and nothing is streamed. Approve runs the
  keypad's checks (large amount, more than the due, the same entry within a minute) as dialogs, adds a new customer if
  needed, saves, logs it with Undo, and listening starts again. Edit opens the usual keypad (a new name: the customer
  form first) and returns here (`VoicePrefill.onDone`); Back from it brings the card back. Two entries in one sentence
  become two cards in a row. Two customers with one name: the card lists both and Approve waits for a tap.
- **Pausing**: Pause / Resume (also the big mic), Stop (summary toast: "Voice mode off. 6 saved: Debit ₹865, Credit
  ₹250."). It pauses by itself when the app goes to the background (and resumes when it is back, after the PIN if it
  locked), while the keypad is open, after **15 minutes without an entry** (Settings → Voice entry → 15 min / 1 hour /
  never; saves battery and data), and after repeated recogniser errors or a refused microphone. No internet: "Trying
  again…" with 3 s … 30 s back-off. Saying "pause" is deliberately not a command: in a noisy shop it would misfire.
- **Screen and beep**: the screen stays on while listening (`KeepAwakePlugin.java`, this app's own Capacitor plugin,
  `FLAG_KEEP_SCREEN_ON`; Screen Wake Lock in the browser). Each session asks the plugin for `muteRecognizerBeep`
  (Settings → "Silence it", default): `EXTRA_DICTATE_BEEP=false` plus notification/system volume at 0 for the first
  750 ms. Whether the Redmi's Google app honours it is not verified; "Keep the beep" turns it off if notification
  sounds go missing.
- **Parser**: obligation forms now mean Debit: "kudukkanum / kodukkanum / tharanum / kudukka vendiyathu" (has to give:
  he owes it); "kattanum" (has to pay) is a weak Debit (it may only state the balance). Fixtures: category
  `obligation`.
- **Not possible with this plugin**: one session that stays open across silence. Google's segmented sessions
  (`EXTRA_SEGMENTED_SESSION`) deliver results through `onSegmentResults`, which the plugin does not implement, so the
  loop restarts; a word said in the fraction of a second while the recogniser restarts can be lost (the status line
  then asks for the name or amount again).

Tests: `test/ui.voice-mode.test.ts` (what is ignored, cards, early stop, back-off, idle, totals) and
`e2e/voice-mode.mjs` (25 flows with the fake recogniser: the two sentences of the brief, noise, balance, new
customer, Edit both ways, unclear direction, Skip, Undo, two entries in one sentence, two Ramus, Pause through Edit,
background, no internet, idle, early stop, Tamil, settings, refused microphone; screenshots `vm-*.png`).
<!-- =================== end Voice entry =================== -->

<!-- =================== Verification status (v2) =================== -->
## What was and was not tested on a real phone

No physical phone or emulator was available for v2. Everything below the line "on a phone" is verified from source
code, the Workers runtime and headless Chromium only.

Verified here:

- `npx tsc --noEmit -p .` clean; `npx vitest run` green (unit + reviewer suites, no skipped-as-failing tests);
  `vite build`, `vite build --mode web`, `vite build --mode android` + `cap sync android` + `gradlew assembleDebug`.
- `node e2e/flows.mjs` (v1 flows, Tamil + English), `node e2e/voice.mjs` (voice flows with the fake recogniser),
  `node e2e/voice-mode.mjs` (voice mode, the always-listening counter screen, with the fake recogniser),
  `node e2e/web-login.mjs` (web app against `wrangler dev --local`), `node e2e/multi-device.mjs` (fast sync: an
  owner phone and a counter phone against `wrangler dev --local`), and `test/sync.integration.test.ts` (two
  engines against `wrangler dev`).
- Merged manifest permissions: INTERNET, ACCESS_NETWORK_STATE, VIBRATE, RECORD_AUDIO (+ the signature-only
  `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`); `<queries>` for the speech service; 16 KB page alignment.

Not verified on a phone (check these first on the real device, and keep the paper book for the first weeks):

- Google's speech service for `ta-IN`: how many alternatives it returns, partial-result timing, how it behaves with
  the plugin's `DICTATION_MODE`, the RECORD_AUDIO prompt, and recognition quality for the shop's names.
- Voice mode on the phone: how long Google keeps each session open in the shop, the gap while it restarts, whether
  the start beep is really silenced on MIUI / HyperOS, battery and data use over a day, and the screen staying on.
- The Android SQLite plugin, Tamil keyboards, WhatsApp sharing and the self-test (unchanged from v1, still unverified
  on hardware).
- Password login from the Android app against a deployed Worker (verified against `wrangler dev` from Node and
  Chromium only), secure-storage of the token and `known_device`, and the step-up dialog on a phone.
- Fast sync between real phones over mobile data and shop Wi-Fi (request latency to Cloudflare's APAC D1 from the
  shop, battery and data use of the 20-s poll over a day, the timers pausing when the screen turns off).
- Google sign-in on the web against real Google Identity Services (no OAuth client id here; the nonce flow is
  exercised against the fake server only). Android Google sign-in is not built.
<!-- =================== end Verification status =================== -->
