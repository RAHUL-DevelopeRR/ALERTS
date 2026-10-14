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

`npm run build:android` runs the first three steps in one go.

### What the Android project is set up to do

| Setting | Where | Why |
|---|---|---|
| `allowBackup="false"` | `AndroidManifest.xml` | Android Auto Backup would copy the live WAL-mode SQLite files as an inconsistent set. Backups are the app's own snapshots plus sync. |
| Permissions are INTERNET, ACCESS_NETWORK_STATE and VIBRATE only | `AndroidManifest.xml` | Storage, media, camera, biometric, contacts and location permissions are stripped with `tools:node="remove"` even when a plugin merges them in. The merged manifest also has `live.zerox.kadankanakku.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. AndroidX defines it as a signature-level permission for the app's own broadcast receivers (the Share plugin uses it). Users never see it. |
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
$BT/aapt2 dump permissions app/build/outputs/apk/release/app-release.apk  # INTERNET, ACCESS_NETWORK_STATE, VIBRATE (+ the signature-only receiver permission)
```

The only native library is `libsqlcipher.so`, which comes from `@capacitor-community/sqlite`. It ships 16 KB-aligned (`0x4000`) for every ABI, so the APK meets the Android 15+ 16 KB page-size requirement.

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

`-r` replaces the app and keeps its data. **Never** `adb uninstall` the shop's phone or run `pm clear` on it, because both wipe the local ledger. A debug build and a release build of this app have the same application ID but different signatures. To switch a phone from one to the other you must uninstall first, which wipes the data. So decide early which build a shop phone runs, and stay on it.

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
