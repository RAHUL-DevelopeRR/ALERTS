# Kadan Kanakku (கடன் கணக்கு)

Offline-first udhaar / khata ledger for one grocery shop: customers buy on credit ("Gave"), repay ("Got"), and the
shopkeeper can show or WhatsApp the outstanding balance at any time. Tamil and English. The phone is the ledger of
record; an optional Cloudflare Worker keeps a server copy and joins several phones.

| Folder | What it is |
|---|---|
| `app/` | Android app: Capacitor 8 + TypeScript + Vite, SQLite on the phone. See `app/README.md`. |
| `api/` | Optional sync server: Cloudflare Worker (Hono) + D1. See `api/README.md`. |
| `shared/protocol.ts` | The sync contract both sides compile against. |
| `tools/` | `install-on-phone.sh` / `.bat` (adb install over USB) and `build-release-apk.sh` (signed APK). |
| `../docs/GROCERY_DEBT_APP_PLAN.md` | The product and architecture plan this implements. |

## Install on a phone

- **Share the APK file** (WhatsApp, Drive, Bluetooth). On the phone, tap it and allow "Install unknown apps" for the
  app you opened it from. Play Protect may warn about an unknown developer: choose "Install anyway".
- **Or over USB** from a computer with `adb`: `./tools/install-on-phone.sh kadan-kanakku-1.0.0.apk`
  (Redmi/Xiaomi: enable Developer options → "USB debugging" and "Install via USB").

First launch asks for the language, the shop name (and optional UPI ID) and an optional PIN. No server, account or
internet is needed. Then Settings → About → **Run self-test** should show every line as `ok`.

## Optional: shop server (backup + several phones)

Deploy `api/` to the shop's own Cloudflare account (free plan is enough) with `./khata/tools/deploy-server.sh`
after `cd khata/api && npm ci && npx wrangler login`; details in `api/README.md`. Then on the
owner's phone: Settings → Server copy → First-time setup (server address + setup key). Add more phones from
Settings → Devices → Add a phone. Print the recovery codes and keep them in the cash box.

## Updates

Every update must be signed with the same release key (`app/README.md` → "Signing a release") and keep the same
application id `live.zerox.kadankanakku`; bump `versionCode` and `versionName` in `app/android/app/build.gradle`.
Installing an update keeps all data on the phone.

## Verification status (v1.0.0)

- App: 155 unit tests, 115 end-to-end UI checks in Chromium (Tamil + English), typecheck clean.
- Server: 104 tests in the Workers runtime; a two-phone sync test passes against the real Worker (`wrangler dev`).
- Reviewed by independent passes for counter UX, Tamil wording, ledger correctness, Android, security and protocol.
- **Not yet run on a physical phone.** The Android SQLite adapter was verified against the plugin's source code only,
  so check Tamil typing, sharing to WhatsApp and the self-test on the real device before relying on it, and keep
  the paper book for the first weeks.
