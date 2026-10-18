# Kadan Kanakku (கடன் கணக்கு)

Offline-first udhaar / khata ledger for one grocery shop: customers buy on credit (**Debit** / பற்று, goods given),
repay (**Credit** / வரவு, payment received), and the shopkeeper can show or WhatsApp the outstanding balance at any
time. Tamil and English. The phone is the ledger of record; an optional Cloudflare Worker keeps a server copy, joins
several phones, and (v2) serves a web app for the owner. v2 adds **voice entry** ("Ramu 100 kattinaan" → a prefilled
entry the shopkeeper checks and saves) and **user id + password logins**.

Everything runs on free tiers: Workers Free (Worker + D1 + static assets), Google's speech service on the phone and
Chrome's Web Speech API in the browser, Google Identity Services for the optional Google sign-in. No paid API anywhere.

| Folder | What it is |
|---|---|
| `app/` | Android app: Capacitor 8 + TypeScript + Vite, SQLite on the phone; also builds as the web app (`vite build --mode web`). See `app/README.md`. |
| `api/` | Optional sync server + accounts + web hosting: Cloudflare Worker (Hono) + D1, Workers Free. See `api/README.md`. |
| `shared/protocol.ts` | The sync and accounts contract both sides compile against. |
| `tools/` | `install-on-phone.sh` / `.bat` (adb install over USB), `build-release-apk.sh` (signed APK), `deploy-server.sh` (Worker + web app). |
| `../docs/GROCERY_DEBT_APP_PLAN.md` | The product and architecture plan this implements. |

## Install on a phone

- **Share the APK file** (WhatsApp, Drive, Bluetooth). On the phone, tap it and allow "Install unknown apps" for the
  app you opened it from. Play Protect may warn about an unknown developer: choose "Install anyway".
- **Or over USB** from a computer with `adb`: `./tools/install-on-phone.sh kadan-kanakku-1.0.0.apk`
  (Redmi/Xiaomi: enable Developer options → "USB debugging" and "Install via USB").

First launch asks for the language, the shop name (and optional UPI ID) and an optional PIN. No server, account or
internet is needed. Then Settings → About → **Run self-test** should show every line as `ok`.

## Voice entry (v2)

Tap the mic on the Home or customer screen and say the name, the amount and what happened: "ராமு 100 கட்டினான்" /
"Ramu 100 kattinaan" (Ramu paid → Credit, green), "ராமுக்கு 250 அரிசி குடுத்தேன்" (gave Ramu rice for 250 → Debit,
red). The app opens the usual entry keypad prefilled, shows what it heard and the balance before and after, and
**nothing is saved until Save is tapped**. Unclear direction → neither Debit nor Credit is preselected. Two Ramus →
a picker. Unknown name → "Add new customer?". Settings → Voice entry has On/Off, the spoken language, what a bare
"Ramu 100 kuduthaachu" means in this shop (Credit by default; "Ramukku … kuduthen", with -kku, is always Debit), a
"Try voice" tester and local accuracy counters. Audio goes to Google's speech service (first tap shows the notice);
the parser itself runs in the app. Details: `app/README.md` → "Voice entry (v2)".

## Optional: shop server (backup, several phones, logins, web app)

Deploy `api/` to the shop's own Cloudflare account (free plan is enough) with `./khata/tools/deploy-server.sh`
after `cd khata/api && npm ci && npx wrangler login`; it applies the D1 migrations, builds and uploads the web app
with the Worker, and prints the server address, the setup key and the web app URL; details in `api/README.md`.
Then on the owner's phone: Settings → Server copy → First-time setup (server address + setup key). Add more phones
from Settings → Devices → Add a phone. Print the recovery codes and keep them in the cash box.

**Logins (v2).** From a paired owner phone, Settings → Account → "Create a login for me" makes the owner's user id
and password; owner "Users" adds staff and other owners (user id, password, role; optional Gmail). A phone can then
sign in with user id + password instead of a pairing code, and the owner can open the **web app** at the server
address (`https://<name>.workers.dev/`) in Chrome: the same ledger, synced, with Online copy / shared-computer modes.
Staff cannot use the web app. Owner-power actions (new users, pairing codes, recovery codes, revoking a phone, the
UPI id, erasing a customer) ask for the password again (step-up). Passwords are stretched on the device
(PBKDF2 600k); the server never sees them.

**Google sign-in (optional, off by default, free).** Create an OAuth *Web application* client in the shop's Google
Cloud project with the Worker's address as an authorised JavaScript origin, put the client id in
`api/wrangler.jsonc` → `GOOGLE_CLIENT_IDS`, deploy, then set each person's Gmail address on their user from the
owner phone; they sign in with Google within 48 h to link it. Step by step: `api/README.md` → "Google sign-in".

## Updates

Every update must be signed with the same release key (`app/README.md` → "Signing a release") and keep the same
application id `live.zerox.kadankanakku`; bump `versionCode` and `versionName` in `app/android/app/build.gradle`.
Installing an update keeps all data on the phone.

## Verification status (v2.0.0)

- App: `tsc` clean; vitest green (unit, voice-parser fixtures with per-category accuracy, reviewer suites for the
  ledger, sync, native, speech platform, voice and the web/accounts client); three Chromium e2e harnesses
  (`e2e/flows.mjs`, `e2e/voice.mjs`, `e2e/web-login.mjs`) pass; debug APK builds with the expected permission list.
- Server: vitest green in the Workers runtime (sync, accounts, hardening, Google, CPU budget, the second-pass security
  review's regression tests); `wrangler deploy --dry-run` succeeds; the two-engine sync integration test passes
  against `wrangler dev --local`.
- Security review of the accounts code done (10 findings, all fixed: demoted owners lose their web sessions, locked
  attempts do not burn the daily budget, UPI id / erase need step-up, no persistent cookie on a shared computer,
  shared sessions never rebuild the ledger into the browser's IndexedDB, Google nonce refresh after a failed sign-in,
  `hd` claim for Workspace addresses, PIN before "Create a login for me").
- **Not yet run on a physical phone.** Google's Tamil speech results, the Android SQLite plugin, Tamil keyboards,
  WhatsApp sharing, Android password login and the step-up dialog were verified from source, Node and headless
  Chromium only. Google sign-in was exercised against a fake, not against real Google Identity Services. Check
  Settings → About → **Run self-test** and a few spoken entries on the real device before relying on it, and keep the
  paper book for the first weeks.
