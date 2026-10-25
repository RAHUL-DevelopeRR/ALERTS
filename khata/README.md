# Kadan Kanakku (கடன் கணக்கு)

Offline-first udhaar / khata ledger for one grocery shop: customers buy on credit (**Debit** / பற்று, goods given),
repay (**Credit** / வரவு, payment received), and the shopkeeper can show or WhatsApp the outstanding balance at any
time. Tamil and English. The phone is the ledger of record; an optional Cloudflare Worker keeps a server copy, joins
several phones, and (v2) serves a web app for the owner. v2 adds **voice entry** ("Ramu 100 kattinaan" → a prefilled
entry the shopkeeper checks and saves) and **user id + password logins**; 2.3 adds **fast sync** for several counter
phones on one ledger (an entry saved at one counter shows on the others within about 20 seconds).

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

First launch asks for the language, then **Start a new shop** (the shop name, optional UPI ID and an optional PIN; no
server, account or internet needed) or **Sign in to my shop** (a phone joining a shop that already has a server: the
user id and password the owner made for this person). Then Settings → About → **Run self-test** should show every
line as `ok`.

## Voice entry (v2)

Tap the mic on the Home or customer screen and say the name, the amount and what happened: "ராமு 100 கட்டினான்" /
"Ramu 100 kattinaan" (Ramu paid → Credit, green), "ராமுக்கு 250 அரிசி குடுத்தேன்" (gave Ramu rice for 250 → Debit,
red). The app opens the usual entry keypad prefilled, shows what it heard and the balance before and after, and
**nothing is saved until Save is tapped**. Unclear direction → neither Debit nor Credit is preselected. Two Ramus →
a picker. Unknown name → "Add new customer?". Settings → Voice entry has On/Off, the spoken language, what a bare
"Ramu 100 kuduthaachu" means in this shop (Credit by default; "Ramukku … kuduthen", with -kku, is always Debit), a
"Try voice" tester and local accuracy counters. Audio goes to Google's speech service (first tap shows the notice);
the parser itself runs in the app. Details: `app/README.md` → "Voice entry (v2)".

**Hold to talk and name biasing (2.0.1).** By default the mic is now press-and-hold: hold it, speak with the phone
near your mouth, release to finish; the release ends listening at once, before the next customer at the counter
speaks (Settings → Voice entry → "How the mic works" switches back to tap-to-talk). On Android 13+ the app also hands
Google's recogniser the customer names as biasing strings (a small `patch-package` patch of the speech plugin,
`app/patches/`), so "Ramu" is more likely to come back as Ramu than as a common word. Whether Google honours that
biasing for Tamil is not verified: check it on the phone with a name it used to mis-hear.

**Speak button and auto-save (2.1.0).** Home has a big red **Speak / பேசு** button that works even if voice was
switched off (it switches it back on). A clear sentence with a known customer, an amount and an entry word ("Ramu 100
kattinaan") is shown on a card and **saved by itself after 3 seconds** (Cancel, Edit or Save now on the card; Undo on
the message after saving). Large amounts, repeats, back-dated entries, payments above the due and anything unclear
still open the keypad for checking. Settings → Voice entry can switch auto-save off.

**Shop slang (2.1.1).** Voice also understands "கடன் சொல்லிருக்கான்" / "kadan sollirukkan" and "கடன்
வச்சிருக்கான்" (Debit), "கடனை கட்டிட்டான்", "கடனை அடைச்சிட்டான்" and "வரவு வச்சிருக்கான்" (Credit); the list is in
`app/README.md` → "Shop slang for entries".

**Registered vs new customers (2.1.2).** A spoken name that is a *different* name from everyone in the book
("Ramu" when only Rahul, Raju or Ramesh exist) now opens "Add a new customer?" with **Add Ramu** first and the
similar names below ("Or did you mean"); the same name in another spelling or script (Rahul / Raghul / ராகுல்)
still finds the customer. When you pick a customer for a name the app was unsure of, the phone learns it (Settings →
Voice entry → Learned names). Auto-save only happens when the name matches exactly or was learned.

**Voice mode (2.2.0).** Home → **Voice mode** keeps listening at the counter until you tap Stop. Each sentence that
sounds like an entry ("Ramu 500 kudukkanum", "Seenu 200 kuduthaaru") shows a card with the customer, Debit/Credit,
the amount and the balance before → after; **nothing is saved until Approve** (or Edit on the keypad, or Skip), and
then it listens for the next one. Talk at the counter that is not an entry is ignored. Approved entries collect in
"This session" with Undo. It pauses by itself in the background, after 15 minutes without an entry (Settings), and
on Pause; the screen stays on while it listens, so keep the phone on the charger. Details: `app/README.md` → "Voice
mode".

## Optional: shop server (backup, several phones, logins, web app)

Deploy `api/` to the shop's own Cloudflare account (free plan is enough) with `./khata/tools/deploy-server.sh`
after `cd khata/api && npm ci && npx wrangler login`; it applies the D1 migrations, builds and uploads the web app
with the Worker, and prints the server address, the setup key and the web app URL; details in `api/README.md`.
Then on the owner's phone: Settings → Server copy → First-time setup (server address, setup key, and the owner's own
user id and password, which this step creates). Print the recovery codes (Settings → Phones) and keep them in the
cash box. Other phones: see "Several counters, one ledger" below.

**Logins (v2).** First-time setup makes the owner's user id and password (a phone paired with a code instead uses
Settings → Account → "Create a login for me"); owner "Users" adds staff and other owners (user id, password, role;
optional Gmail). A phone can then
sign in with user id + password instead of a pairing code, and the owner can open the **web app** at the server
address (`https://<name>.workers.dev/`) in Chrome: the same ledger, synced, with Online copy / shared-computer modes.
Staff cannot use the web app. Owner-power actions (new users, pairing codes, recovery codes, revoking a phone, the
UPI id, erasing a customer) ask for the password again (step-up). Passwords are stretched on the device
(PBKDF2 600k); the server never sees them.

**Google sign-in (optional, off by default, free).** Create an OAuth *Web application* client in the shop's Google
Cloud project with the Worker's address as an authorised JavaScript origin, put the client id in
`api/wrangler.jsonc` → `GOOGLE_CLIENT_IDS`, deploy, then set each person's Gmail address on their user from the
owner phone; they sign in with Google within 48 h to link it. Step by step: `api/README.md` → "Google sign-in".

## Several counters, one ledger (fast sync, 2.3.0)

One shop, two or more phones (different SIMs, Wi-Fi or mobile data: it does not matter), one ledger on the shop's
server. Every phone keeps the full ledger and works offline; the server puts everyone's entries in one order.

1. Owner: deploy the server and do First-time setup (above). Settings → **Users** → add each employee (user id,
   name, password; role Staff).
2. Build the APK with the server address inside, so nobody types it:
   `SHOP_SERVER_URL=https://<name>.workers.dev KEYSTORE_PROPERTIES=… ./khata/tools/build-release-apk.sh`.
3. Each counter phone: install, pick the language, **Sign in to my shop**, type the user id and password, give the
   phone a name ("Counter 2"). The shop's customers and balances come down; done.

How fast: a save goes to the server 2 seconds later. While the app is open and in use, each phone asks for the
other phones' entries every 20 seconds, so an entry saved at counter 1 shows on counter 2 within about 20 seconds
without touching it (19–20 s measured in the two-phone test). Opening a customer's page fetches at once, so the
balance told to a customer includes what the other counter just saved. A phone nobody has touched for 5 minutes
checks once a minute instead, and the first touch fetches at once. The screen redraws by itself only when that is
safe: never while someone is typing or a dialog is open. No network: entries are saved on the phone, the pill says
"Offline · 1 waiting", and they go out when the network is back. The language is each phone's own choice. Cost:
still ₹0 (a busy phone makes about 4,000 small requests a day; Workers Free allows 100,000 for the shop).

**Sync button (2.3.1, on every phone from 2.3.2).** Home has a **Sync / ஒத்திசை** button in the top-right
corner. On a signed-in phone one tap does both directions at once: it sends this phone's waiting entries to the
server (push) and brings the other phones' entries from the server (pull), without waiting for the 20-second check
(0.1 s against the local test server; on mobile data expect about a second). It then says what happened: "Synced.
2 updates from the other phones.", "Synced. Everything is up to date." or "No internet. The entries are safe on
this phone…". It cannot make *another* phone fetch: that phone gets the entry by itself within 20 seconds, when a
customer's page is opened there, or when someone taps Sync on it. On a phone that is not signed in yet, the tap
says so and **Sign in** opens the user id + password form. Signing in stays the same: user id and password.

**No server address to type (2.3.2).** In an APK built with `SHOP_SERVER_URL`, neither the first-launch sign-in
nor Settings → Shop server shows an address field: one line says "Shop server: <name>.workers.dev" (with a small
Change link for whoever installs the phones). Only a generic test build, made before the server exists, asks for
the address.

**Start fresh (2.3.2).** After trying the app out, Settings → Backup → **Erase all entries and start fresh**
removes every customer and entry from a phone that is *not* connected to a shop server: it asks for the PIN (if
one is set), keeps a "Before erasing" copy (Restore a daily copy brings everything back), and customer numbers
start again at C-0001. The shop name, PIN and settings stay. Do it **before** connecting a phone to the shop's
real server: connecting uploads everything already on the phone. A connected phone is cleared by signing out
(Settings → Account → remove the ledger); the shop's server copy stays. (The voice "Reset counters" button, now
"Clear the voice accuracy log", only ever cleared the voice accuracy numbers, never entries.)

**Cloudflare free plan, in total (for the whole shop, all phones together, per day):**

| Limit | Free plan | This shop with fast sync |
|---|---|---|
| Requests to the server (Workers) | 100,000 a day for the account | about 4,000 per busy phone left open day and night; 3 phones ≈ 12,000 |
| Database rows written (D1) | 100,000 a day | about one per request plus ~8 per entry; 3 phones + 300 entries ≈ 15,000 |
| Database rows read (D1) | 5,000,000 a day | a few per request; far below |
| Database size | 500 MB per database, 5 GB per account | a few MB a year |
| CPU time | 10 ms per request | measured inside it (see `api/README.md`) |
| Web app files | free and unlimited (not counted) | – |

The daily counts reset at 05:30 IST (midnight UTC). If the shop ever went over, the server would refuse requests
until the reset: every phone keeps working on its own ledger and catches up after 05:30 – nothing is lost. The app
also stops any single phone at 10,000 requests a day, so one broken phone cannot use up the shop's 100,000.

If someone does not know what to do: after the language, a new install asks only "Sign in to my shop" or "Start a
new shop", and a counter phone always takes the first; the owner gives each person their user id and password. A
phone that was set up wrong can be signed out (Settings → Account) and signed in again; nothing on the server is
lost.

## Updates

Every update must be signed with the same release key (`app/README.md` → "Signing a release") and keep the same
application id `live.zerox.kadankanakku`; bump `versionCode` and `versionName` in `app/android/app/build.gradle`.
Installing an update keeps all data on the phone.

## Verification status (v2.3.2)

- App: `tsc` clean; vitest green (unit, voice-parser fixtures with per-category accuracy, reviewer suites for the
  ledger, sync, native, speech platform, voice and the web/accounts client); five Chromium e2e harnesses
  (`e2e/flows.mjs`, `e2e/voice.mjs`, `e2e/voice-mode.mjs`, `e2e/web-login.mjs`, and `e2e/multi-device.mjs`: an owner
  phone and a counter phone against a local Cloudflare server, signing in, entries both ways, offline catch-up)
  pass; debug APK builds with the expected permission list.
- Server: vitest green in the Workers runtime (sync, accounts, hardening, Google, CPU budget, the second-pass security
  review's regression tests); `wrangler deploy --dry-run` succeeds; the two-engine sync integration test passes
  against `wrangler dev --local`.
- Security review of the accounts code done (10 findings, all fixed: demoted owners lose their web sessions, locked
  attempts do not burn the daily budget, UPI id / erase need step-up, no persistent cookie on a shared computer,
  shared sessions never rebuild the ledger into the browser's IndexedDB, Google nonce refresh after a failed sign-in,
  `hd` claim for Workspace addresses, PIN before "Create a login for me").
- **Not yet run on a physical phone.** Google's Tamil speech results, the Android SQLite plugin, Tamil keyboards,
  WhatsApp sharing, Android password login, the step-up dialog and fast sync over mobile data were verified from
  source, Node and headless Chromium only. Google sign-in was exercised against a fake, not against real Google Identity Services. Check
  Settings → About → **Run self-test** and a few spoken entries on the real device before relying on it, and keep the
  paper book for the first weeks.
