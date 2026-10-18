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
| Android | Google `SpeechRecognizer` via `@capgo/capacitor-speech-recognition` **8.3.2** (pinned exactly: newest release at least two weeks old at install time; review the Capgo diff before bumping) | `src/platform/speech-native.ts`. Inline recognition (`popup:false`), `partialResults:true`, up to 5 alternatives requested (how many Google returns for `ta-IN` is unverified, often one). Customer-name biasing is not possible: the plugin ignores `contextualStrings` on Android. Needs Google's speech service (missing on non-GMS ROMs → `available()` false) and internet unless an offline pack is installed. |
| Browser / web app | Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`) | `src/platform/speech-web.ts`. Chrome is the tested target (audio goes to Google); Firefox has no API (`available()` false). Bias phrases are sent only where `SpeechRecognitionPhrase` exists. |
| Tests / e2e | `createFakeSpeech(script)` | `src/platform/fake-speech.ts`. In the web build, `window.__KK_FAKE_SPEECH__ = [["ராமு 100 குடுத்தாச்சு", ...], ...]` (set before the first mic tap, e.g. with Playwright `addInitScript`) replaces the recogniser; `[]` = silence, `["!SPEECH_ERROR:NETWORK"]` = failure; `window.__KK_FAKE_SPEECH_OPTIONS__ = {delayMs, available, permission}`. |

`listen()` rejects with `SPEECH_UNAVAILABLE`, `SPEECH_PERMISSION` or `SPEECH_ERROR:<code>`; silence resolves `[]`. After our own `stop()` (mic tap, the `maxMs` cap, or the app going to the background: `native.ts` / `web.ts` stop the session on `appStateChange` / `visibilitychange`) the session always resolves with what was heard, because Google often answers `stopListening()` with `ERROR_CLIENT` instead of a result. Errors that happened before the stop are still reported.

Privacy: `SPEECH_PRIVACY_NOTE` (`src/platform/speech-common.ts`, re-exported from `src/platform/index.ts`) holds the Tamil and English notice that voice audio is sent to Google (Android's speech service, Chrome's backend), that internet is needed, that the app keeps no audio and that nothing is saved before Save is tapped. `localRecognitionAvailable(lang)` in `speech-web.ts` feature-detects Chrome 139+'s on-device mode (`SpeechRecognition.available({langs, processLocally:true})`) inside try/catch; it is informational only and `listen()` never sets `processLocally` (no Tamil pack is known).

Plugin facts the Android adapter relies on (read from `node_modules/@capgo/capacitor-speech-recognition/android/.../SpeechRecognitionPlugin.java`, JS version 8.3.2, native `PLUGIN_VERSION` string "8.1.11"): `available()` = `SpeechRecognizer.isRecognitionAvailable`; `checkPermissions()`/`requestPermissions()` map the `speechRecognition` alias to `RECORD_AUDIO` (`granted`/`denied`/`prompt`); `start()` rejects with code `UNAVAILABLE`, message `Missing permission` or `Speech recognition is already running.`, otherwise resolves as soon as `startListening()` ran (`partialResults:true`) and reports through `listeningState` (`startingListening` → `started` → `stoppingListening` → `stopped`, with `sessionId`, `reason`, `errorCode`), `partialResults` (`matches`; also carries the final `onResults` list, `EXTRA_MAX_RESULTS` = `maxResults`) and `error` (`getErrorCode()` names). `stop()` posts `stopListening()` and forces `finishSession('userStop')` after 500 ms. `buildRecognizerIntent()` sets `EXTRA_LANGUAGE`, `EXTRA_MAX_RESULTS`, `EXTRA_PARTIAL_RESULTS`, `DICTATION_MODE` and no biasing strings; `prompt` only matters with `popup:true`. The plugin ships no native library and its manifest adds only `RECORD_AUDIO`.

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

Besides pairing with a code, a phone can **sign in with a user id and password** (Settings → Shop server → "Sign in
with user id & password"), and the owner can use the **web app** that the Worker serves at the server address
(`https://<name>.workers.dev/`). Protocol: `shared/protocol.ts` ("v2: accounts"); server side: `khata/api/README.md`.

| Piece | Where | Notes |
|---|---|---|
| Password stretching | `src/sync/password.ts` | `deriveClientKey(password, salt, iterations)` = PBKDF2-HMAC-SHA256 (WebCrypto, NFC-normalised password, 600,000 iterations, 32 bytes, base64url). The password never leaves the device; the server stores only `HMAC(PEPPER, client_key)`. ~0.1 s on a laptop, up to a few seconds on a budget phone: the button shows "Securing the password…". |
| API client | `src/sync/api.ts` | `mode: 'bearer'` (Android, paired phones: `Authorization: Bearer`) or `mode: 'cookie'` (web app: same-origin relative URLs, `credentials: 'same-origin'`, `X-KK-Client: web` on every request, no Authorization header, no token in storage). New routes: config, prelogin, login, nonce, google, logout, users (list/create/update/password), auth events. Owner-power calls take a `StepUpProof` (`X-KK-Stepup` = current client_key, or `X-KK-Recovery` = printed code). |
| Engine | `src/sync/engine.ts` | `login()` = prelogin → derive → `/auth/login` → the same `completePairing` path as a code pairing → first sync. Android stores the token and the `known_device` value in secure storage (sent as `X-KK-Known` on later logins: exempt from the per-network lockout). `logout({removeData})` revokes the session (`force` when offline). `stepped()` retries an owner call with a proof from the step-up provider (`src/ui/screens/login.ts` `stepUpDialog`: password or recovery code; the server keeps the device stepped up for 5 minutes). `listUsers / createUser / updateUser / resetPassword / changeOwnPassword / authEvents`. The signed-in account is kept in the private file `account.json` (names only, never credentials). |
| Android UI | `src/ui/screens/settings.ts`, `src/ui/screens/login.ts` | "Account" block (signed in as…, Change my password, Sign out: keep or remove the ledger), "Create a login for me" for a code-paired owner phone (`link_me`, no step-up while the shop has no users), owner "Users" (add with user id / name / role / password twice / optional Gmail; reset password; disable/enable) and "Activity" (`GET /auth/events`). |
| Web app | `src/ui/web/**`, `vite build --mode web` → `dist-web/` (`__WEB_APP__`) | Login gate (`login-gate.ts`): owner's user id + password, Google button only when `/v1/config` returns a `google_client_id` (nonce from `/auth/nonce`), "This is a shared computer" (in-memory sql.js database, in-memory private files, `shared_computer: true` → 12 h session, cookie without Max-Age), language toggle. Staff get the `web_owner_only` refusal in Tamil and English. After login: full pull, then the normal UI with the "Online copy" pill. A 401 (expired/revoked session) shows the unsynced count, wipes IndexedDB + localStorage and returns to the login page; Sign out does the same. "+ Customer" works only online and in sync: the browser gets no code block at login and asks for one on demand (`requestCodes()`). Phone-only controls (PIN, pairing form, Call, user management) are hidden. |
| Tests | `test/sync.password.test.ts`, `test/sync.accounts.test.ts` | PBKDF2 vector against Node's `pbkdf2`, NFC, bounds, timing; logins, lockout + known device, cookie mode, step-up, user management, Google (fake), web restrictions against the fake server (`test/helpers/fake-server.ts`, which now has users, logins, a cookie jar, step-up and audit events). |
| End to end | `node e2e/web-login.mjs` | Builds `dist-web`, starts `wrangler dev --local` on a fresh D1 (`api/.wrangler/e2e-web-state`, migrations applied), bootstraps shop + owner phone + logins through the API, drives Chromium through login (ta/en), wrong password, staff refusal, sign-in, synced customers, an entry and a customer, Settings, session revoked from the phone, sign out (storage wiped), shared-computer mode. Screenshots `e2e/screenshots/web-*.png`. |

Deploy: `tools/deploy-server.sh` builds the web app (`npm ci && vite build --mode web` in this folder) before
`wrangler deploy` and prints the web app URL. The web app's security headers (CSP with `'wasm-unsafe-eval'` for sql.js
and the Google Identity Services origins) come from `khata/api/web/_headers`.
<!-- =================== end Accounts & web app =================== -->
