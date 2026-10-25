# Grocery Shop Credit Ledger (Udhaar Khata) — Android App Plan

**Date:** 2026-10-12
**Status:** Plan v1 — not yet implemented
**For:** the developer building this for one grocery shop in Tamil Nadu (the "client" below is the shopkeeper; a "customer" is a person who buys on credit).

Numbers in this document come from the research notes gathered on 2026-10-12 and are cited as `[n]`; the full URL list is in the Sources section. Anything the research could not confirm against a primary source is marked "(unverified)" or "(likely)".

**How to read this:** the first two sections (about two pages) answer the three questions and give the recommendation. Everything after "Scope & users" is the engineering detail you need only when you start building.

**Contents**

1. [Answers to your three questions](#answers-to-your-three-questions)
2. [Recommendation in one page](#recommendation-in-one-page)
3. [Scope & users](#scope--users)
4. [Architecture](#architecture)
5. [Data model](#data-model)
6. [API & sync protocol](#api--sync-protocol)
7. [Android app](#android-app)
8. [Auth & security](#auth--security)
9. [Backups & disaster recovery](#backups--disaster-recovery)
10. [Build, signing & distribution](#build-signing--distribution)
11. [Milestones](#milestones)
12. [Cost](#cost)
13. [Risks & mitigations](#risks--mitigations)
14. [Out of scope for v1](#out-of-scope-for-v1)
15. [Assumptions](#assumptions)
16. [Open questions for the shopkeeper](#open-questions-for-the-shopkeeper)
17. [Sources](#sources)

---

## Answers to your three questions

**1. Where does the backend run?**
On Cloudflare Workers. The backend is one small serverless program (a "Worker", written in TypeScript with the Hono router) that you deploy with `wrangler deploy`. There is no server, VM or Docker container to install, patch or keep awake. Cloudflare runs the code in its edge data centres, which include Chennai, Coimbatore, Bangalore, Hyderabad, Mumbai and Kochi [23], so the HTTP hop from the shop is short. The Worker does very little: it checks a device token, accepts new ledger rows, hands back rows the other phone wrote, and (optionally) writes a nightly backup. All business logic lives in the app on the phone.

**2. Where is the data stored?**
In this order of importance:

1. **On the shopkeeper's phone**, in a SQLite database file inside the app's private storage. This is the ledger of record. Every screen reads and writes this file, so the app works with no internet at all.
2. **In Cloudflare D1** (Cloudflare's managed SQLite database), as a mirror that receives every row from every paired phone. The database is created with `--location=apac`; Cloudflare offers no India-specific location, only `wnam`, `enam`, `weur`, `eeur`, `apac` and `oc` hints, and the city behind `apac` is not published [6]. D1 keeps automatic point-in-time history ("Time Travel") for 7 days on the free plan and 30 days on the paid plan [5].
3. **Backup copies:** a daily snapshot file written by the app on the phone; a weekly one-tap export the shopkeeper saves to Google Drive or WhatsApp; a monthly `wrangler d1 export` file the developer keeps off Cloudflare; and, if you choose to enable it, a nightly dump to Cloudflare R2 object storage.

If Cloudflare is unreachable, the shop keeps working and syncs later. If the phone is lost, a new phone is paired and pulls everything from D1.

**3. Can we use Cloudflare?**
Yes. At this shop's size (1-3 phones, a few hundred customers, 50-300 entries a day, a few thousand API calls a day) it costs **$0/month** on the Workers Free plan: 100,000 requests per day and 10 ms of CPU per request [1][2]; D1 allows 5 million row reads and 100,000 row writes per day, 5 GB of storage and a 500 MB database [3][4]; since 1 September 2026 the free-plan daily read/write caps are hard-enforced: queries error until 00:00 UTC and the account owner is emailed [75]. The app will use at most about 10% of the request cap (2,000-10,000 calls a day) and roughly 3-12% of the D1 write cap (every authenticated request updates the device row; see "Volumes assumed"). Cloudflare documents no inactivity pausing or deletion for free Workers or D1 (likely; the absence of a policy, not a written promise) [7], unlike Supabase, whose free projects pause after 7 idle days [27]. You would pay **$5/month** (Workers Paid, about ₹430) [1] for 30-day Time Travel, no midnight-UTC daily caps, a 10 GB database and 30 s of CPU [3][5]; this plan recommends Paid from the day the shop relies on the app. Two honest caveats: no India data residency on D1 [6], and a Cloudflare storage incident on 12 June 2025 pushed D1 error rates to about 22% for a window [24]. Both are why the phone, not D1, is the primary copy.

---

## Recommendation in one page

**Build:** a **Capacitor 8 + TypeScript** Android app (your existing HTML/CSS/JS skills transfer directly) whose on-phone SQLite file is the ledger of record, plus a **Cloudflare Worker (Hono) + D1** mirror used only for backup and 1-3 device sync. Login is "pair this phone once" with a code, not passwords, OTP or Google accounts. Statements go out as WhatsApp or SMS text from the shopkeeper's own apps, then as an image, then as a PDF.

**The ledger rules that make everything else simple:**

- Money is stored as **integer paise**, never floating point.
- The `entries` table is **append-only**: no UPDATE, no DELETE. A mistake is fixed with a REVERSAL row plus a corrected row, both visible, so there is always an audit trail.
- A customer's balance is **always `SUM(delta_paise)`** over their entries, never a stored number that can drift.
- Every row has a **client-generated UUID** that doubles as the idempotency key (the Stripe model: the server stores the first result and replays it on retry [44]), so a dropped connection can never post a payment twice, which is the "entry appears twice" bug in Khatabook's current Play reviews [54].
- Two phones working offline can never conflict on money: entries are commutative sums. Only customer name/phone edits use last-write-wins.

**Why this stack:** the app is five screens and a correct ledger; the hard part (append-only log, idempotent sync) is plain TypeScript in any stack. Capacitor 8 already meets the 2026 Play bar (targetSdk 36, minSdk 24) and ships no native code of its own, so the 16 KB page-size rule is automatically satisfied [39][36]. Native Kotlin + Compose + Room [51] is the upgrade path if this ever becomes a product for many shops; it is the strongest technical answer but costs weeks of ramp-up for one shop that will not notice the difference.

**What was rejected and why (one line each):**

- **Firebase/Firestore:** free offline sync out of the box [28], but per-document billing and a query model that fights an append-only ledger, high lock-in, and the developer would learn Firestore security rules instead of SQL.
- **Supabase / Appwrite free tiers:** projects pause after 7 days of inactivity and the free tier has no backups [27][68]; the honest price for a money ledger is $25/month.
- **PocketBase on a VPS:** fine software, but it makes the developer the on-call server administrator for about the same monthly cost [68].
- **AWS Amplify stack:** 6-month free-credit cliff and the heaviest stack to learn [68].
- **No backend at all:** a legitimate week-1 state (and milestone 1 below is exactly that), but a lost phone with a stale manual export loses the month's udhaar, so the mirror earns its ~300 lines.
- **Flutter:** a new language (Dart) and an 8-15 MB APK (unverified) for the same result. **React Native/Expo:** heaviest APK, and a new Expo SDK three times a year [65]. **PWA/TWA:** browser storage can be evicted [41]; this is money.
- **SMS OTP login:** Firebase phone-auth SMS is Blaze-only (no free SMS on Spark) [28], at about US$0.07 (≈ ₹6) per SMS to India according to third-party price guides (likely; confirm on the Identity Platform pricing page, which also states that the first 10 SMS per day are not billed [59]), or TRAI DLT paperwork with MSG91/Twilio [57][58], to log in three people. Pairing codes do the job for free.
- **Cloudflare Access for the phone app:** a browser cookie flow with no mobile SDK [26]; it is not used by the phone app. Access (one-time PIN to email) guards only two tiny browser pages, the optional owner pair-code page and a developer admin page, each on its own small Worker (see Auth & security).
- **Durable Objects [25], KV, Queues, Workflows, Browser Rendering [63], Email Service [62]:** none earns its complexity at this scale; KV is eventually consistent and allows only 1,000 writes/day free, so it must never hold the ledger.

---

## Scope & users

**Users:** one shop owner (role `owner`) and up to two helpers (role `staff`). Staff can add customers and post credit/payment entries. Only the owner can write off debt, archive customers, export data, add or revoke phones and change shop settings. Be honest about what that buys: a staff phone can still post a RECEIVE for any amount or a REVERSAL of any GIVE, both of which reduce debt exactly like a write-off, so blocking WRITEOFF alone is not a money control. The control is review, not sync rules: the day book has an "entries by staff" filter, and a configurable cap (default ₹2,000) above which a staff RECEIVE or REVERSAL asks for the shop's **approval PIN** on the staff phone before saving. The approval PIN is separate from each phone's unlock PIN: the owner sets it in Settings, `PUT /shop` stores its PBKDF2 hash and salt in the `shops` row, every `/pair` and `/sync/pull` response carries them in the `shop` object, and the staff phone verifies the typed PIN locally with the same PBKDF2, so the check works offline and the plaintext never leaves the owner's head.

**Customers:** a few hundred regulars, identified by name plus (optionally) a mobile number plus a short code such as `C-0042`. Some have no phone; some families share one; two customers can share a name.

**Daily workflow:** at the counter the shopkeeper opens a customer, taps "Gave" (goods on credit) or "Got" (payment received), types the amount, saves. Entries can be back-dated. In the evening, when the day's paper slips are entered in one sitting, a **Quick-entry mode** (search customer → amount → Gave/Got → "Save & next", with the date chip sticky and a running count and total for the sitting) avoids opening each customer screen. Any customer can ask "how much do I owe?" and get a text statement on WhatsApp or SMS, or a PDF.

**Volumes assumed:** 1-3 devices, 200-500 customers, 50-300 entries a day, which is roughly 2,000-10,000 API requests a day and 3,000-12,000 D1 row writes a day (each authenticated request is one `devices` row update; each accepted entry writes its row, its index entries and a change-log row), about 3-12% of the free 100,000/day write cap. If that ever matters, bump `last_seen_at` only when the UTC minute changes and count requests in one-minute buckets, which turns most auth hits into a pure read.

**Not in scope for v1:** billing, stock, suppliers, interest, automated reminders, loans, UPI reconciliation, customer-facing login. See "Out of scope for v1".

---

## Architecture

```
  Shop phone A (owner)                    Shop phone B (staff, optional)
  +-----------------------------+         +-----------------------------+
  | Capacitor 8 WebView         |         | same app                    |
  |  TypeScript UI (5 screens)  |         |                             |
  |  ledger.ts (pure functions) |         |                             |
  |  khata.db (SQLite)          |         |  khata.db                   |
  |   customers, entries,       |         |   + outbox, meta(cursor)    |
  |   outbox, meta(cursor)      |         +---------------+-------------+
  |  device token in Keystore   |                         |
  +--------------+--------------+                         |
                 | HTTPS, Authorization: Bearer <device token>
                 | push outbox / pull since cursor
                 v                                        v
         +------------------------------------------------------------+
         | Cloudflare Worker  khata-api  (Hono)  Smart Placement on   |
         |   (free experiment; D1-aware placement unverified [69])    |
         |  /v1/pair  /v1/sync/push  /v1/sync/pull  /v1/devices/*     |
         |  /v1/export  /v1/health   + optional khata-owner Worker    |
         +----------------+---------------------------+---------------+
                          | D1 binding                | R2 binding (optional)
                          v                           v
                 +------------------+        +--------------------+
                 | D1 "khata" apac  |        | R2 khata-backups   |
                 | shops, devices,  |        | YYYY-MM-DD/*.json  |
                 | customers,       |        | (optional, nightly |
                 | entries,changelog|        |  cron 30 20 * * *) |
                 +------------------+        +--------------------+
                   + Time Travel 7 d free / 30 d paid
                   + monthly: wrangler d1 export -> developer laptop + shop's Google Drive

  Phone -> share sheet / wa.me / smsto:  -> WhatsApp / SMS app on the same phone
```

**Where each component runs**

| Component | Runs where | Holds |
|---|---|---|
| App UI + `ledger.ts` | WebView on the phone | All screens; pure functions for balance, reversal, day book, IST date |
| `khata.db` (SQLite) | App-private storage on the phone | Ledger of record: customers, entries, outbox, meta |
| Sync engine | In the app, foreground | Pushes outbox, pulls since cursor; never on the critical path of a screen |
| `khata-api` Worker | Cloudflare, with Smart Placement on (`placement.mode = "smart"`, available on all plans [69]). Smart Placement decides from observed request-forwarding latency; that it moves a Worker next to its D1 primary is **unverified** (the Smart Placement page never mentions D1), so treat it as a free experiment. The real levers for a push under 1 s are the batched pre-checks and the week-3 measurement; if latency is poor, the documented lever is the D1 location hint plus keeping every statement inside `batch()` | Stateless; token check, validation, idempotent insert |
| `khata-owner` Worker (optional) | Cloudflare, a second Worker bound to the same D1 database, with Cloudflare Access enabled on its own `workers.dev` URL (Access is per Worker, not per path [18]) | One-button page that mints a pair code for the owner (see Auth & security) |
| D1 `khata` | Single primary in APAC [6] | Mirror of all devices, authoritative only for ordering (the append-only `changelog`), the device registry and the `sync_epoch` |
| R2 bucket (optional) | Cloudflare | Nightly JSON dumps |
| Developer laptop | wrangler, Android Studio | Monthly export, deploys, APK builds |

**Flow: add credit ("Gave").** Shopkeeper opens Kamala, taps "கொடுத்தது / Gave", types 250, taps Save. The app validates (amount > 0, at most two decimals, confirm above ₹10,000, not the same customer+amount within 60 s), builds `{id: uuid, kind:'GIVE', amount_paise:25000, delta_paise:+25000, biz_date: today in Asia/Kolkata, created_at: UTC now}`, and inserts the entry and an `outbox` row in one local transaction. It re-queries `SUM(delta_paise)` and repaints the balance in under 50 ms with no network. A toast says "₹250 added · Balance ₹1,450" with a 10-second Undo (a REVERSAL, never a delete). If online, the sync engine pushes the outbox at once; otherwise the pill reads "Saved on phone · 1 to back up".

**Flow: add payment ("Got").** Identical screen with the sign flipped: `kind:'RECEIVE'`, `delta_paise:-amount_paise`. A "Full ₹1,250" chip prefills the current balance so settling a due is one tap, and an optional mode chip (Cash / UPI / Other) is stored in a nullable `mode` column so the day book's "received" total can be reconciled against the cash drawer and the UPI app at closing. A payment larger than the balance is allowed and shows as "advance ₹X" (negative balance). Partial payments need no special case. When the balance reaches 0 the detail screen shows a green "Settled" state with a "Send receipt" button.

**Flow: statement.** Shopkeeper opens the customer, taps Statement. Default period is "since the last time the balance was zero", with "last 30 days" and "all" as alternatives. If the current balance is 0 (the customer has just settled and wants a receipt), the default is instead the period from the previous zero through the settling payment, titled "Settled · ₹0 due", so the receipt is never empty. The statement SQL runs locally (opening balance, rows with running balance, closing balance); a reversed entry and its reversal are collapsed into one struck-through line by default (a "show corrections" toggle expands them). A per-statement language toggle (Tamil / English) defaults to the shop setting. "WhatsApp" opens `https://wa.me/91XXXXXXXXXX?text=<url-encoded>` with the text prefilled; WhatsApp's own help page documents the format: full international number with the `+`, zeros, brackets and dashes omitted, plus `?text=` [47]. If the customer has no phone, or a family shares one number, the button opens `https://wa.me/?text=<url-encoded>` with no number, which WhatsApp documents as opening the sender's contact list to pick a recipient, and a "Send to another number" option lets the shopkeeper type one [47]. "SMS" fires `ACTION_SENDTO smsto:` with `sms_body`, which needs no SMS permission [46], but SMS sends a **one-line balance message** ("Balance due ₹1,250 as of 12 Oct · <shop> · <UPI id>"), not the full statement: a Tamil statement is UCS-2 encoded at 70 characters per segment and months of rows could cost 10-20 segments per tap, so the app shows the estimated segment count before sending and keeps the full statement for WhatsApp and the share sheet. "Share image/PDF" uses the Android share sheet. When the shop has more than one paired phone, the statement ends with "includes entries up to last sync <time>" so a balance quoted two days offline is honestly labelled. The shopkeeper presses Send; the app never sends anything by itself. Nothing in this flow touches the Worker.

**Flow: sync.** Triggered on app foreground, on network regained, 30 s after a local write (debounced), on pull-to-refresh, and every 15 minutes while the app is open. *(v2.3 fast sync for several counters: 2 s after a write, every 20 s while the app is open and in use, every minute after 5 idle minutes, and when a balance screen opens if the last sync is over 5 s old; see `khata/app/README.md` → "Fast sync".)* Push first (outbox in insertion order, 20 rows per request), then pull (`since=cursor`), then repaint. Full detail in "API & sync protocol".

---

## Data model

Rules: money is `INTEGER` paise (SQLite integers are 64-bit); `created_at` is ISO-8601 UTC from the phone and immutable; `received_at` is the server clock, set when the mirror accepts the row; `biz_date` is `YYYY-MM-DD` computed in `Asia/Kolkata` (a sale at 19:00 UTC on 12 Oct is 00:30 IST on 13 Oct, so the day book must use the IST date) and editable when back-dating; every id is a client-generated UUID v4.

`delta_paise` is the signed effect on what the customer owes: `+amount` for GIVE, `-amount` for RECEIVE and WRITEOFF, and exactly the negation of the original's delta for REVERSAL. Balance is therefore a plain `SUM`.

### Server DDL (D1), `migrations/0001_init.sql`

Applied with `npx wrangler d1 migrations apply khata --remote` (migrations are numbered `.sql` files, forward-only, tracked in a `d1_migrations` table) [10].

```sql
CREATE TABLE shops (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, upi_id TEXT,
  lang TEXT NOT NULL DEFAULT 'ta', created_at TEXT NOT NULL,
  approval_pin_hash TEXT, approval_pin_salt TEXT,   -- staff review-cap PIN (PBKDF2); set by PUT /shop, delivered to every phone
  sync_epoch TEXT NOT NULL                -- random UUID; changed after any restore/re-import (see "Backups")
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY,                    -- generated by the server at /pair, never chosen by the client
  shop_id TEXT NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','staff')),
  token_hash TEXT UNIQUE,                 -- sha256(token || PEPPER), hex
  created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT, wipe_on_revoke INTEGER NOT NULL DEFAULT 0,
  requests_day TEXT, requests_today INTEGER NOT NULL DEFAULT 0   -- daily cap guard
);
CREATE TABLE pair_codes (
  code_hash TEXT PRIMARY KEY, shop_id TEXT NOT NULL, role TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pair','recovery')),   -- 'recovery' = owner recovery code (16 random chars), no expiry
  issue_id TEXT NOT NULL,                 -- one pairing = two rows (typed 8-digit code + 128-bit QR secret) sharing an issue_id;
                                          -- using either marks both used_at
  expires_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, used_at TEXT
);
CREATE TABLE pair_failures (              -- wrong-code guesses per UTC day: a throttle, never a lockout (see "Rate limiting")
  shop_id TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, next_allowed_at TEXT,
  PRIMARY KEY (shop_id, day)              -- this Worker serves one shop, so every wrong guess is charged to that shop
);
CREATE TABLE code_blocks (                -- customer-code blocks handed to devices
  block_start INTEGER PRIMARY KEY, block_end INTEGER NOT NULL,
  device_id TEXT NOT NULL, issued_at TEXT NOT NULL
);
CREATE TABLE seq (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO seq (name, value) VALUES ('customer_code', 0);

CREATE TABLE customers (
  id TEXT PRIMARY KEY, shop_id TEXT NOT NULL REFERENCES shops(id),
  code INTEGER NOT NULL, name TEXT NOT NULL, search_name TEXT, phone TEXT, note TEXT,
  archived_at TEXT, erased_at TEXT,       -- erased_at is terminal: later name/phone/note writes are refused
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,   -- phone clock + device id, informational only
  received_at TEXT NOT NULL,              -- server clock of the last accepted write; this is what "last write" means
  UNIQUE (shop_id, code)
);
CREATE INDEX customers_phone ON customers(shop_id, phone);

CREATE TABLE entries (
  id TEXT PRIMARY KEY, shop_id TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  kind TEXT NOT NULL CHECK (kind IN ('GIVE','RECEIVE','WRITEOFF','REVERSAL')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  delta_paise  INTEGER NOT NULL,
  biz_date TEXT NOT NULL, note TEXT,
  mode TEXT CHECK (mode IN ('CASH','UPI','OTHER')),      -- optional: RECEIVE, or a REVERSAL inheriting its original's mode
  reverses_entry_id TEXT REFERENCES entries(id),
  device_id TEXT NOT NULL, created_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  CHECK ((kind = 'GIVE' AND delta_paise = amount_paise)
      OR (kind IN ('RECEIVE','WRITEOFF') AND delta_paise = -amount_paise)
      OR (kind = 'REVERSAL' AND reverses_entry_id IS NOT NULL))
);
CREATE INDEX entries_cust ON entries(customer_id, biz_date, created_at, id);
CREATE INDEX entries_day  ON entries(shop_id, biz_date);
CREATE UNIQUE INDEX entries_once ON entries(reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

-- Append-only change log: the ONLY ordering the sync protocol uses. One row per accepted insert or update,
-- appended in the same batch as the row itself (no triggers; each multi-row INSERT's meta.last_row_id is the last
-- seq it assigned, and its rows received consecutive seqs in VALUES order, so no post-select is needed).
CREATE TABLE changelog (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT NOT NULL, tbl TEXT NOT NULL CHECK (tbl IN ('customers','entries')),
  row_id TEXT NOT NULL, device_id TEXT NOT NULL,   -- device_id = the author, so /pull can skip a phone's own rows
  received_at TEXT NOT NULL
);
CREATE INDEX changelog_shop ON changelog(shop_id, seq);
CREATE INDEX changelog_row  ON changelog(shop_id, row_id, seq);   -- the "already" seq lookup must never scan the whole log (D1 bills rows scanned [4])
```

Why a change log instead of a `server_seq` column on each row: a per-row sequence number moves forward every time a customer is edited, so the pull stream is not a stable log. Kamala created at seq 10, her first GIVE at seq 11, her phone number edited at seq 900: a new phone pulling `since=0, limit=500` would receive entry 11 but not Kamala (her row now sits at 900), the page's INSERT would fail the foreign key, the transaction would roll back, the cursor would never advance, and sync would be wedged forever. With the change log, Kamala's creation stays at seq 10 and her edit is a second log row at 900, so no page can reference a customer the client has not already seen. Rows do not carry `server_seq`; the client learns a row's seq from the push response and the pull stream. Because D1 enforces foreign keys by default and `db.batch()` is one transaction that aborts on the first failed statement [9][70], the push route emits customer statements **before** entry statements and makes `PRAGMA defer_foreign_keys = on` the first statement of every batch (D1 documents the pragma for transactions; confirm it inside `batch()` with `wrangler dev` in week 3, and if it does not hold, the customer-first ordering alone is sufficient) [70]. The DDL `CHECK` cannot express a REVERSAL's relationship to its original; the Worker and the client enforce those invariants (see "What the server rejects").

### On-device schema (SQLite via `@capacitor-community/sqlite`)

Same `customers` and `entries` tables without `shop_id`, with `received_at` nullable (NULL = not yet accepted by the server), plus a `sync_state` column on both (`'pending'` | `'accepted'` | `'rejected'`), a `server_seq` column on both (NULL until the push response or pull stream supplies the change-log seq), and:

```sql
CREATE TABLE outbox (
  n INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, row_id TEXT NOT NULL,
  queued_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, revoked_at TEXT); -- mirrored on each sync
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
-- keys: device_id (provisional 'local-<uuid>' until paired), role, cursor, sync_epoch, code_next, code_end, spare_start, spare_end,
--       shop_name, upi_id, lang, pin_hash, pin_salt (this phone's unlock PIN), approval_pin_hash, approval_pin_salt (the shop's,
--       from the server), lock_timeout_min, last_snapshot_at, clock_offset_ms, staff_review_cap_paise, recovery_codes_left
CREATE INDEX entries_outbox_hint ON entries(sync_state) WHERE sync_state <> 'accepted';
```

Rules that every local query obeys: **rows with `sync_state = 'rejected'` are excluded from every balance, statement and day-book query** (they are still stored, still listed under Needs attention, and the affected customer carries a badge), so a permanently rejected row can never make one phone quote a different balance from the server and the other phone. Schema versions are managed by the plugin's own mechanism, `createConnection(dbName, encrypted, mode, version, readonly)` plus one `addUpgradeStatement(dbName, [{ toVersion, statements }])` per release, which is the **single** migration counter; do not also hand-roll `PRAGMA user_version` scripts, or the two counters disagree after the first migration. The plugin does not promise a backup before an upgrade, so the app copies the database file to app-private storage before each `toVersion` step and deletes the copy once the new version opens cleanly.

### TypeScript entity and repository (the "entity + DAO" for this stack)

```ts
// src/ledger.ts  (pure, unit-tested with Vitest; no I/O)
export type Kind = 'GIVE' | 'RECEIVE' | 'WRITEOFF' | 'REVERSAL';
export interface Entry {
  id: string; customer_id: string; kind: Kind;
  amount_paise: number;            // integer > 0
  delta_paise: number;             // +GIVE, -RECEIVE/-WRITEOFF, -(original delta) for REVERSAL
  biz_date: string;                // 'YYYY-MM-DD' in Asia/Kolkata
  note?: string | null; mode?: 'CASH' | 'UPI' | 'OTHER' | null; reverses_entry_id?: string | null;
  device_id: string; created_at: string;          // ISO-8601 UTC
  received_at?: string | null; server_seq?: number | null;
  sync_state?: 'pending' | 'accepted' | 'rejected';
}
// biz_date from formatToParts, never from a locale's string shape (en-CA happened to print YYYY-MM-DD; do not rely on it)
export const bizDateIST = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
// UUID v4 over getRandomValues: crypto.randomUUID() needs Chrome 92+ and throws on an un-updated API 24-26 WebView
export const uuid = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : uuidV4Polyfill();
// '12.29' -> 1229: parse the string, never parseFloat(s) * 100 (which gives 1228.9999 and fails Number.isInteger)
export function toPaise(s: string): number {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s.trim().replace(/[\u0BE6-\u0BEF]/g, d => String(d.charCodeAt(0) - 0x0BE6)));
  if (!m) throw new Error('BAD_AMOUNT');                      // rejects a third decimal, blanks and signs
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}

export function makeEntry(p: { customer_id: string; kind: Exclude<Kind,'REVERSAL'>;
    amount_paise: number; biz_date?: string; note?: string; mode?: 'CASH'|'UPI'|'OTHER'; device_id: string }): Entry {
  if (!Number.isInteger(p.amount_paise) || p.amount_paise <= 0) throw new Error('BAD_AMOUNT');
  const today = bizDateIST(); const biz = p.biz_date ?? today;
  if (biz > today) throw new Error('FUTURE_DATE');
  return { id: uuid(), customer_id: p.customer_id, kind: p.kind,
    amount_paise: p.amount_paise,
    delta_paise: p.kind === 'GIVE' ? p.amount_paise : -p.amount_paise,
    biz_date: biz, note: p.note ?? null, mode: p.kind === 'RECEIVE' ? (p.mode ?? null) : null,
    reverses_entry_id: null, device_id: p.device_id, created_at: new Date().toISOString() };
}
// A reversal inherits the original's biz_date and mode so both halves land in the same day book, statement period
// and Cash/UPI column; created_at stays "now" so the audit order is preserved.
export function makeReversal(orig: Entry, device_id: string, note?: string): Entry {
  if (orig.kind === 'REVERSAL') throw new Error('CANNOT_REVERSE_REVERSAL');
  return { ...makeEntry({ customer_id: orig.customer_id, kind: 'GIVE',
      amount_paise: orig.amount_paise, biz_date: orig.biz_date, device_id, note }),
    kind: 'REVERSAL', delta_paise: -orig.delta_paise, reverses_entry_id: orig.id, mode: orig.mode ?? null };
}

// src/repo.ts  (the only module that talks to SQLite)
export async function addEntry(db: SQLiteDBConnection, e: Entry): Promise<number> {
  await db.beginTransaction();
  try {
    await db.run(`INSERT INTO entries (id, customer_id, kind, amount_paise, delta_paise, biz_date,
        note, mode, reverses_entry_id, device_id, created_at, sync_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending')`,
      [e.id, e.customer_id, e.kind, e.amount_paise, e.delta_paise, e.biz_date,
       e.note ?? null, e.mode ?? null, e.reverses_entry_id ?? null, e.device_id, e.created_at]);
    await db.run(`INSERT INTO outbox (tbl, row_id, queued_at) VALUES ('entries', ?, ?)`,
      [e.id, new Date().toISOString()]);
    await db.commitTransaction();
  } catch (err) { await db.rollbackTransaction(); throw err; }
  const r = await db.query(`SELECT COALESCE(SUM(delta_paise),0) AS bal FROM entries WHERE customer_id = ? AND sync_state <> 'rejected'`,
    [e.customer_id]);
  return r.values?.[0]?.bal ?? 0;
}
```

### Customer identity rules

- **The key is the UUID**, generated on the phone, so a customer can be created offline.
- **`code`** is the human handle (`C-0042`). Each device receives a block of **50** codes at pairing (`POST /devices/code-block` hands out the next block from `seq.customer_code`) and allocates sequentially from `meta.code_next`, persisted in the same local transaction as the customer insert. Blocks are small so that codes written in the paper book stay nearly contiguous across phones (a 1,000-code block would jump from C-0042 on the owner's phone to C-1001 on the helper's and look like a mistake); the app keeps one spare block, requests a refill on **every** sync, and a re-paired or wiped device always gets a fresh block. Only 100 new customers without a single sync could exhaust both. If a restored snapshot ever makes two phones allocate the same code, the server answers `CODE_TAKEN` (a validation, never a batch failure) and the client reallocates from its block and resends; the UUID, which entries reference, never changes, so `UNIQUE(shop_id, code)` always holds. **Before the first pairing** (weeks 1-2, or any phone used offline from day one) there is no server block: the app allocates codes from a provisional local range starting at 1 and stamps rows with a provisional `device_id` (`local-<uuid>`, kept in `meta`). The first `/pair` sends `{max_local_code}`; the server sets `seq.customer_code = MAX(seq.customer_code, max_local_code)` in the same batch before issuing the phone's first block, so the server never hands out a code already in use, and the phone then rewrites its provisional `device_id` to the server-issued one (the one pre-pairing UPDATE on `entries`, on server-filled metadata, never on money). A phone holding pre-pairing data is paired before any other phone (the developer pairs the owner's phone in week 3); if that order is ever broken, `CODE_TAKEN` on the first push reallocates the clashing codes. When both blocks are exhausted offline, the Add-customer screen says "Cannot add customers until this phone has synced" instead of allocating a duplicate.
- **`phone`** is optional (some regulars have none; family members share one), normalised to E.164 (`+91XXXXXXXXXX`) with `libphonenumber-js`, indexed but **not unique**: the app shows an inline warning under the field, "Kamala already has this number (C-0017, 3rd street). Open her instead?", never a blocking dialog, and lets the shopkeeper proceed. OkCredit's "cannot re-add a deleted customer with the same number" complaint [53] comes from a uniqueness rule; we do not have one.
- **Same name twice is allowed**, but not silently: on save, if an active customer with the same normalised name exists, the app asks "There is already a Murugan (C-0017, 3rd street, no phone). Open him or add another?". `note` ("3rd street, blue house") disambiguates; **every list and search row shows the code and the note (or the last four digits of the phone)** so two Murugans can be told apart at a glance, and a search such as "murugan 3rd" matches name and note together. Search covers name, `search_name`, code, phone and note.
- **`search_name`** is an optional Latin spelling stored beside a Tamil name, auto-filled from a small transliteration table and editable, so a customer saved as "முருகன்" is found when the helper types "Murugan" and vice versa; code and phone remain script-independent keys.
- **Customers are archived, never deleted.** Archiving is refused on both the phone and the server while the balance is non-zero (settle, or the owner posts a WRITEOFF with a reason). Because that check is enforced at one instant, not maintained, the server also **un-archives a customer in the same batch whenever it accepts an entry for them** (`UPDATE customers SET archived_at = NULL ... WHERE id = ? AND archived_at IS NOT NULL`, plus a change-log row), the `ARCHIVE_NONZERO` check includes entries in the same push chunk, and the home screen and total show any archived customer whose balance is not zero with an "archived" badge. Otherwise device A could archive Kamala at zero, device B could post ₹800 to her offline, and ₹800 would vanish from the home screen after both synced.
- **Erasure on request (DPDP):** name, phone, note and `search_name` are replaced with `Erased on <date>` and `erased_at` is set; entries stay for the shop's accounts. Erasure is a **terminal state enforced by the server**: the owner's phone calls `POST /customers/:id/erase` directly (it needs the network, like revoke; it is not an outbox row), which in one batch overwrites name, `search_name`, phone and note, sets `erased_at` and `received_at` to the server clock and appends a change-log row. The push upsert never writes `erased_at` and refuses any later name/phone/note change for an erased row (`ERASED`), so an offline phone's stale edit cannot resurrect the data, and the pull applies a server row carrying `erased_at` unconditionally, discarding any local pending edit. The privacy notice states the retention that remains outside the live row: D1 Time Travel history (7 or 30 days), the 7 local snapshots (purged on erasure), and any Drive exports, R2 dumps or monthly `.sql` files the shop keeps.

### The exact SQL

```sql
-- Outstanding balance of one customer (positive = customer owes the shop); rejected rows never count
SELECT COALESCE(SUM(delta_paise), 0) AS balance_paise
FROM entries WHERE customer_id = ?1 AND sync_state <> 'rejected';

-- Home screen: every active customer, plus archived customers with a non-zero balance, one query.
-- last_payment ignores a RECEIVE that was later reversed; days_since is NULL only for a customer with no debt.
WITH live AS (SELECT * FROM entries WHERE sync_state <> 'rejected')
SELECT c.id, c.code, c.name, c.phone, c.note, c.archived_at,
       COALESCE(SUM(e.delta_paise), 0) AS balance_paise,
       MAX(e.biz_date) AS last_activity,
       MAX(CASE WHEN e.kind = 'RECEIVE'
                 AND NOT EXISTS (SELECT 1 FROM live r WHERE r.reverses_entry_id = e.id)
                THEN e.biz_date END) AS last_payment,
       MIN(CASE WHEN e.kind = 'GIVE' THEN e.biz_date END) AS first_give,
       CAST(julianday(?1) - julianday(COALESCE(
            MAX(CASE WHEN e.kind = 'RECEIVE'
                      AND NOT EXISTS (SELECT 1 FROM live r WHERE r.reverses_entry_id = e.id) THEN e.biz_date END),
            MIN(CASE WHEN e.kind = 'GIVE' THEN e.biz_date END))) AS INTEGER) AS days_since   -- ?1 = today IST
FROM customers c LEFT JOIN live e ON e.customer_id = c.id
GROUP BY c.id
HAVING c.archived_at IS NULL OR balance_paise <> 0
ORDER BY last_activity DESC NULLS LAST, c.name;     -- sort chips reorder this in memory

-- Statement between two dates: opening balance, then rows with running balance
SELECT COALESCE(SUM(delta_paise), 0) AS opening_paise
FROM entries WHERE customer_id = ?1 AND biz_date < ?2 AND sync_state <> 'rejected';
SELECT id, biz_date, kind, amount_paise, delta_paise, note, mode, reverses_entry_id, device_id,
       ?3 + SUM(delta_paise) OVER (ORDER BY biz_date, created_at, id
                                   ROWS UNBOUNDED PRECEDING) AS running_paise
FROM entries
WHERE customer_id = ?1 AND biz_date BETWEEN ?2 AND ?4 AND sync_state <> 'rejected'
ORDER BY biz_date, created_at, id;                    -- ?3 = opening_paise from the first query

-- Day book, "Business day" tab: one IST biz_date, one query; received is split by mode.
-- A reversed entry and its reversal are excluded from every column (a reversal inherits its original's biz_date,
-- so the pair always sits on the same day and cancels in net_paise), otherwise correcting yesterday's 1,500 to 150
-- would read "Given 1,650", and a reversed cash receipt would inflate the drawer total reconciled at closing.
WITH live AS (SELECT * FROM entries WHERE biz_date = ?1 AND sync_state <> 'rejected'),
     reversed AS (SELECT reverses_entry_id AS id FROM entries
                  WHERE reverses_entry_id IS NOT NULL AND sync_state <> 'rejected')
SELECT ?1 AS biz_date,
  SUM(CASE WHEN kind = 'GIVE'     AND id NOT IN reversed THEN amount_paise ELSE 0 END) AS given_paise,
  SUM(CASE WHEN kind = 'RECEIVE'  AND id NOT IN reversed THEN amount_paise ELSE 0 END) AS received_paise,
  SUM(CASE WHEN kind = 'RECEIVE'  AND id NOT IN reversed AND mode = 'CASH' THEN amount_paise ELSE 0 END) AS received_cash_paise,
  SUM(CASE WHEN kind = 'RECEIVE'  AND id NOT IN reversed AND mode = 'UPI'  THEN amount_paise ELSE 0 END) AS received_upi_paise,
  SUM(CASE WHEN kind = 'WRITEOFF' AND id NOT IN reversed THEN delta_paise ELSE 0 END) AS adjustments_paise,
  SUM(delta_paise) AS net_paise,                                    -- reversed pairs cancel here
  SUM(CASE WHEN kind = 'REVERSAL' THEN 1 ELSE 0 END) AS corrections_count,
  COUNT(*) AS entry_count
FROM live;
SELECT e.id, e.created_at, e.biz_date, c.code, c.name, e.kind, e.amount_paise, e.mode, e.note,
       e.device_id, d.name AS device_name, e.sync_state
FROM entries e JOIN customers c ON c.id = e.customer_id LEFT JOIN devices d ON d.id = e.device_id
WHERE e.biz_date = ?1 AND e.sync_state <> 'rejected' ORDER BY e.created_at, e.id;

-- Day book, "Entered today" tab: what was typed on this calendar day in IST, whatever biz_date it carries,
-- so a back-dated slip entered tonight still appears in tonight's end-of-day check against the paper book.
-- ?1 / ?2 = UTC instants of 00:00 and 24:00 IST for the chosen day, computed in ledger.ts
SELECT e.id, e.created_at, e.biz_date, c.code, c.name, e.kind, e.amount_paise, e.mode, e.note, d.name AS device_name
FROM entries e JOIN customers c ON c.id = e.customer_id LEFT JOIN devices d ON d.id = e.device_id
WHERE e.created_at >= ?1 AND e.created_at < ?2 AND e.sync_state <> 'rejected' ORDER BY e.created_at, e.id;
```

The default statement period ("since the last zero balance") is computed in `ledger.ts`: walk the customer's rows in the same order, remember the last row where the running balance was 0, and start the statement at the row after it (or at the first row if the balance was never zero); if the balance is 0 right now, start instead at the row after the *previous* zero and end at the settling row, so a just-settled customer gets a receipt rather than an empty statement. The "oldest unpaid" sort chip orders by `days_since` descending (a never-paid customer already gets `days_since` from `first_give`, so no NULL ordering is involved; never-paid customers come first only within the same age band, so someone given ₹200 yesterday never outranks someone 90 days overdue), and the "Not paid 30+ days" chip filters on `balance_paise > 0 AND days_since >= 30`, so a customer who settled in full two months ago is not shown as overdue. Every ORDER BY ends with `id` so two devices producing identical `biz_date` + `created_at` still sort deterministically. The client SQL uses UPSERT with `DO UPDATE ... WHERE` (SQLite 3.24), window functions (3.25), `NULLS LAST` (3.30) and `RETURNING` (3.35); Android 7's system SQLite is 3.9, so **a bundled SQLite of 3.35 or newer is a hard requirement of whichever plugin is pinned**: `@capacitor-community/sqlite` bundles its own [40], the app asserts `SELECT sqlite_version()` at startup and refuses to run below 3.35, and the week-1 tests run on an API 24 emulator. D1 is current. Back-dated entries sort by `biz_date` first, so statements stay chronological (a complaint in Khatabook's iOS reviews).

---

## API & sync protocol

Base URL `https://khata-api.<subdomain>.workers.dev/v1` (every account gets a free `workers.dev` subdomain; Cloudflare recommends a custom domain for production, which is a config change later) [18]. JSON in and out. Every request except `/pair` and `/health` sends `Authorization: Bearer <device token>`; the Worker computes `sha256(token || PEPPER)` with WebCrypto [22], looks up `devices.token_hash` with `revoked_at IS NULL`, bumps `last_seen_at` and the daily counter in one `UPDATE ... RETURNING`, and reads the `shops` row with one SELECT (`sync_epoch` and the approval-PIN hash come from it). Every response carries `server_time` (ISO UTC) so the app can detect a wrong phone clock, and `sync_epoch` so the app can detect a restored database (see step 4 below).

| Method / path | Who | Request | Response |
|---|---|---|---|
| `GET /health` | anyone | - | `{ok:true}` after `SELECT 1` (UptimeRobot pings this) |
| `POST /pair` | new phone, rate-limited | `{code, device_name, max_local_code?, previous_device_id?}` (`code` = the 8-digit typed code, the 128-bit secret from the QR, or an owner recovery code; `max_local_code` = the highest code allocated before pairing, which bumps `seq.customer_code` before the first block is issued; `previous_device_id`, from local `meta`, is revoked in the same batch when it belongs to this shop, so a re-pair after a lost Keystore key leaves no ghost phone) | `{token, device_id, role, shop:{name,upi_id,lang,approval_pin_hash,approval_pin_salt}, code_block:{start,end}, sync_epoch}` (`device_id` is generated by the server, never chosen by the phone) |
| `POST /devices/pair-code` | owner | `{role}` | `{code, qr_secret, expires_at}` (8 digits, 10 min, single use; the QR carries the 128-bit secret; stored as two hashed `pair_codes` rows sharing one `issue_id`, so using either burns both) |
| `POST /devices/recovery-codes` | owner | `{count}` | `[code, ...]` (3-5 long-lived single-use owner recovery codes, 16 random base32 characters shown as `XXXX-XXXX-XXXX-XXXX`, shown once; replaces any unused ones) |
| `POST /devices/code-block` | any | `{max_local_code?}` | `{start, end}` next 50 customer codes (the server first raises `seq.customer_code` to `max_local_code` if that is higher) |
| `GET /devices` | owner | - | `[{id, name, role, last_seen_at, revoked_at}]` |
| `POST /devices/:id/revoke` | owner | `{wipe: boolean}` | `{ok:true}` (`wipe` tells that phone to erase its local copy on its next 401) |
| `POST /sync/push` | any | `{customers:[...], entries:[...]}`, at most 20 rows | `{results:[{tbl,id,status,seq?,reason?}], server_time, sync_epoch}` |
| `GET /sync/pull?since=N&limit=500` | any | - | `{changes:[{seq, tbl, row}], devices:[...], shop:{...}, next_since, has_more, server_time, sync_epoch}` (rows this device authored are skipped via `changelog.device_id`, halving a one-phone shop's pull traffic) |
| `GET /export` | owner | - | full JSON of shop, customers, entries, devices, **streamed** through a `TransformStream` in pages of 5,000 rows (never one `JSON.stringify` of everything, which would exceed the 10 ms free CPU budget in year two) |
| `PUT /shop` | owner | `{name, upi_id, lang, approval_pin_hash?, approval_pin_salt?}` | shop row |
| `POST /customers/:id/erase` | owner | - | `{ok:true}`; one batch: name/`search_name`/phone/note overwritten with `Erased on <date>`, `erased_at` and `received_at` set to the server clock, change-log row appended (needs the network; not an outbox row) |
| `GET /owner` (web page, **optional**) | owner's email, behind Cloudflare Access one-time PIN [26] | - | a one-button page that mints a pair code, so the shop can pair a replacement phone with **no developer and no surviving phone**. It lives on a **second Worker, `khata-owner`** (same D1 binding) with Access enabled on that Worker's own `workers.dev` URL, because Access on `workers.dev` is per Worker, not per path [18]; a route on `khata-api` would put Access in front of `/v1/sync/*` and hand the phones an HTML login page. The page verifies the `Cf-Access-Jwt-Assertion` header itself. Prerequisite: Zero Trust onboarding asks for a payment method even on the free plan (not charged) [61] |

`status` is one of `stored` (new row or accepted customer update, change-log `seq` assigned), `already` (identical row already on the server; its latest `seq` returned), or `rejected` (with `reason`). There is no "your edit lost" status: a customer update the server accepts always becomes the current row (see Conflict rules), and the other phone learns of it from the pull stream.

### Idempotency

The row's UUID is the idempotency key. Before validating anything, the Worker fetches every pushed id that already exists on the server. An existing entry whose canonical fields match is answered `already` with its original `seq`; one whose fields differ is `rejected` with reason `mismatch` (this should never happen and the client surfaces it). Canonical fields for the comparison are the client-owned ones only: `id, customer_id, kind, amount_paise, delta_paise, biz_date, note, mode, reverses_entry_id, created_at` for entries and `id, code, name, search_name, phone, note, archived_at, updated_at, updated_by, created_at` for customers; server-filled `shop_id, device_id, received_at` are excluded. Because the "already exists" check happens first, a REVERSAL whose first push committed but whose response was lost is correctly answered `already`, not "already reversed".

Inserts use `INSERT ... ON CONFLICT(id) DO NOTHING` for entries. Note that this clause covers only the primary key; a conflict on the `entries_once` partial unique index (two reversals of one original), on `UNIQUE(shop_id, code)` or on a foreign key would make the whole `db.batch()` throw and roll back [9]. Validation catches every known case before the batch (`ALREADY_REVERSED` from the pre-check on `reverses_entry_id`, `CODE_TAKEN` from the pre-check on `code`, `UNKNOWN_CUSTOMER`); the pre-checks look up by id **and** by the unique keys the batch could trip on, because a lookup by id alone cannot see another customer holding the same code or another device's reversal of the same original; if the batch still throws, the Worker returns `500 batch_failed` and the client halves its chunk and retries. **Halving has a terminal state:** at chunk size 1 a `batch_failed` marks that one row `rejected: batch_failed`, moves it to Needs attention and the engine moves on; rows that depend on it (its entries or its reversal) are answered `UNKNOWN_CUSTOMER` / `UNKNOWN_ORIGINAL` and wait beside it, so one bad row can never block the whole outbox for a day with the pill reading "N to back up" and no diagnosis.

### Query budget (Workers Free allows 50 D1 queries per invocation [3])

One push of 20 rows costs: auth `UPDATE ... RETURNING` on `devices` (1) + `SELECT ... FROM shops` (1) + one `batch()` of five pre-check SELECTs run in a single round trip (existing entries by id, including the reversal targets; existing reversals *of* the pushed targets, by `reverses_entry_id`; existing customers by id for pushed customer ids and entries' `customer_id`s, including `archived_at` and `erased_at`; existing customers by `code` for the pushed codes; balances of customers being archived in this chunk) (5) + the write batch: `PRAGMA defer_foreign_keys = on` (1), at most 20 row statements (20), one `UPDATE customers ... WHERE id IN (...)` that un-archives every archived customer touched in the chunk (0 normally, 1 at most, never one per entry), the multi-row `INSERT INTO changelog ... VALUES (...),(...)` in statements of at most 20 rows each (1, or 2 when un-archived customers are added) + one `SELECT row_id, MAX(seq)` over the `changelog_row` index for `already` rows (0 normally, 1 at most) = **29 queries** normally, 32 in the worst case, both well under the 50-query free cap. Accepted rows need no post-select for their seqs: each change-log INSERT is one statement, its `meta.last_row_id` is the last seq it assigned, and its *n* rows received `last_row_id − n + 1 … last_row_id` in VALUES order. Two D1 limits shape this: 50 queries per invocation and **100 bound parameters per statement** [3], which is why the change-log insert (5 parameters per row) is split at 20 rows and every pre-check `IN (...)` list stays under 100 ids. The Worker enforces the 20-row limit with HTTP 413 so a future client change cannot silently break the cap. Row *reads* matter as much as query count, because D1 bills rows scanned, not rows returned [4]: every pre-check and the `already` lookup is an index lookup of a few dozen rows, so one push reads on the order of 100 rows rather than the whole change log (an un-indexed `row_id` lookup on `changelog` would scan about 100,000 rows per push within a year, roughly 30 M rows a day against the 5 M/day free cap, and sync would fail every afternoon). A pull costs 4 queries (change-log page, the joined rows, the device list, the shop row). Latency, not query count, is the thing to measure: every statement outside a `batch()` is a round trip from the Worker to the single D1 primary, which is why the pre-checks are folded into one batch (Smart Placement is on as a free experiment; whether it moves the Worker next to the D1 primary is unverified [69]); the realistic target is **under 1 s per push** measured from the shop in week 3.

### Hono route: `POST /v1/sync/push` (abridged)

```ts
// src/routes/sync.ts
import { Hono } from 'hono';
type Env = { Bindings: { DB: D1Database; PEPPER: string }; Variables: { device: Device; shop: Shop } };
export const sync = new Hono<Env>();

sync.post('/push', async (c) => {
  const body = await c.req.json<{ customers?: Customer[]; entries?: Entry[] }>();
  const customers = body.customers ?? [], entries = body.entries ?? [];
  if (customers.length + entries.length > 20) return c.json({ error: 'too_many_rows' }, 413);
  const dev = c.get('device'); const now = new Date().toISOString(); const todayIST = bizDateIST();

  // 1. What already exists? Five set queries in ONE round trip (D1 batch of SELECTs), never per-row lookups.
  //    Look up by id AND by the unique keys the write batch could trip on (customer code, reversal target).
  const targets  = entries.map(e => e.reverses_entry_id).filter(Boolean) as string[];
  const entryIds = [...new Set([...entries.map(e => e.id), ...targets])];
  const custIds  = [...new Set([...customers.map(x => x.id), ...entries.map(e => e.customer_id)])];
  const codes    = customers.map(x => x.code);
  const archiving = customers.filter(x => x.archived_at).map(x => x.id);
  const { existingEntries, existingReversals, existingCusts, custsByCode, balances } =
    await preChecks(c.env.DB, dev.shop_id, { entryIds, targets, custIds, codes, archiving });
  const reversedIds = new Set(existingReversals.map(r => r.reverses_entry_id));   // originals that already have a reversal
  const codesTaken  = new Map(custsByCode.map(x => [x.code, x.id]));              // code -> owning customer id

  // 2. Classify every row before touching the database. CUSTOMERS FIRST: their statements must precede entries' (FK).
  const results: Result[] = []; const stmts: D1PreparedStatement[] = [c.env.DB.prepare('PRAGMA defer_foreign_keys = on')];
  const accepted: { tbl: string; id: string }[] = []; const knownCust = new Set(existingCusts.map(x => x.id));
  for (const x of customers) {
    const prev = existingCusts.find(p => p.id === x.id);
    if (prev && sameCanonical(prev, x)) { results.push({ tbl:'customers', id:x.id, status:'already' }); continue; }
    const bal = (balances.get(x.id) ?? 0) + sumSameChunk(entries, x.id);       // ARCHIVE_NONZERO sees this chunk too
    // CODE_TAKEN only when codesTaken.get(code) is a DIFFERENT id; also ARCHIVE_NONZERO, FORBIDDEN_ROLE, ERASED
    const reason = validateCustomer(x, { prev, dev, bal, codesTaken, todayIST });
    if (reason) { results.push({ tbl:'customers', id:x.id, status:'rejected', reason }); knownCust.delete(x.id); continue; }
    knownCust.add(x.id); codesTaken.set(x.code, x.id);
    // Server-order last-write-wins: an accepted update always becomes the current row (received_at = server clock).
    // erased_at is never written here; only POST /customers/:id/erase sets it, and the WHERE below honours it.
    stmts.push(c.env.DB.prepare(`INSERT INTO customers (id, shop_id, code, name, search_name, phone, note, archived_at, erased_at,
        created_at, updated_at, updated_by, received_at) VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, search_name=excluded.search_name, phone=excluded.phone,
          note=excluded.note, archived_at=excluded.archived_at, updated_at=excluded.updated_at,
          updated_by=excluded.updated_by, received_at=excluded.received_at
        WHERE customers.erased_at IS NULL`)
      .bind(x.id, dev.shop_id, x.code, x.name, x.search_name ?? null, x.phone ?? null, x.note ?? null,
            x.archived_at ?? null, x.created_at, x.updated_at, dev.id, now));
    accepted.push({ tbl:'customers', id:x.id });
  }
  const unarchive = new Set<string>();
  for (const e of entries) {
    const prev = existingEntries.find(x => x.id === e.id);
    if (prev) { results.push(sameCanonical(prev, e) ? { tbl:'entries', id:e.id, status:'already' }
                                                    : { tbl:'entries', id:e.id, status:'rejected', reason:'mismatch' }); continue; }
    const orig = e.reverses_entry_id ? (existingEntries.find(x => x.id === e.reverses_entry_id)
                                       ?? entries.find(x => x.id === e.reverses_entry_id)) : null;
    const reason = validateEntry(e, { knownCust, orig, reversedIds, todayIST });  // see "What the server rejects"
    if (reason) { results.push({ tbl:'entries', id:e.id, status:'rejected', reason }); continue; }
    if (e.reverses_entry_id) reversedIds.add(e.reverses_entry_id);               // second reversal in same chunk
    const cust = existingCusts.find(x => x.id === e.customer_id);
    if (cust?.archived_at && !customers.some(x => x.id === cust.id)) unarchive.add(cust.id);  // money on an archived customer
    stmts.push(c.env.DB.prepare(`INSERT INTO entries (id, shop_id, customer_id, kind, amount_paise, delta_paise,
        biz_date, note, mode, reverses_entry_id, device_id, created_at, received_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(e.id, dev.shop_id, e.customer_id, e.kind, e.amount_paise, e.delta_paise, e.biz_date,
            e.note ?? null, e.mode ?? null, e.reverses_entry_id ?? null, dev.id, e.created_at, now));
    accepted.push({ tbl:'entries', id:e.id });
  }
  if (unarchive.size) {                                                          // ONE statement for all of them, same batch
    const ids = [...unarchive];
    stmts.push(c.env.DB.prepare(`UPDATE customers SET archived_at = NULL, updated_at = ?, updated_by = ?, received_at = ?
        WHERE shop_id = ? AND archived_at IS NOT NULL AND id IN (${ids.map(() => '?').join(',')})`)
      .bind(now, dev.id, now, dev.shop_id, ...ids));
    ids.forEach(id => accepted.push({ tbl:'customers', id }));
  }
  // Change-log append for everything accepted: 5 bound parameters per row, D1 allows 100 per statement, so 20 rows per statement
  const logPages = chunk(accepted, 20);
  for (const rows of logPages)
    stmts.push(c.env.DB.prepare(`INSERT INTO changelog (shop_id, tbl, row_id, device_id, received_at) VALUES ` +
        rows.map(() => '(?,?,?,?,?)').join(',')).bind(...rows.flatMap(a => [dev.shop_id, a.tbl, a.id, dev.id, now])));

  // 3. One transaction. Seqs come from each change-log statement's meta.last_row_id (consecutive in VALUES order); no post-select.
  let out: D1Result[] = [];
  try { if (stmts.length > 1) out = await c.env.DB.batch(stmts); }
  catch (err) { return c.json({ error: 'batch_failed', message: String(err) }, 500); }
  const logResults = out.slice(out.length - logPages.length);
  logPages.forEach((rows, i) => {
    const last = logResults[i].meta.last_row_id as number;
    rows.forEach((a, j) => results.push({ tbl:a.tbl, id:a.id, status:'stored', seq: last - rows.length + 1 + j }));
  });
  // 'already' rows carry their latest seq too (the retry-after-timeout story depends on it): one indexed query, only when needed
  const alreadyIds = results.filter(r => r.status === 'already').map(r => r.id);
  if (alreadyIds.length) {
    const seqs = await latestSeqs(c.env.DB, dev.shop_id, alreadyIds);
    for (const r of results) if (r.status === 'already') r.seq = seqs.get(r.id);
  }
  return c.json({ results, server_time: now, sync_epoch: c.get('shop').sync_epoch });
});
```

Helpers referenced above: `preChecks(db, shop_id, {entryIds, targets, custIds, codes, archiving})` runs one `db.batch()` of five SELECTs, all `WHERE shop_id = ?` and all served by an index: `entries WHERE id IN (...)`, `entries WHERE reverses_entry_id IN (targets)` (the existing reversal of a pushed target is a *different* row, so a lookup by id alone cannot see it), `customers WHERE id IN (...)`, `customers WHERE code IN (...)` (a code held by a *different* customer id is the real two-phones-same-code case), and the balance sums for `archiving` (the D1 limit is 100 bound parameters per statement [3], far above 40 ids); it returns the rows plus a `Map<customer_id, balance_paise>`. `chunk(arr, n)` splits an array into pages; `sumSameChunk` adds the deltas of this chunk's entries for a customer; `latestSeqs` runs `SELECT row_id, MAX(seq) AS seq FROM changelog WHERE shop_id = ? AND row_id IN (...) GROUP BY row_id`, served by the `changelog_row` index so it reads a few dozen rows, never the whole log; `sameCanonical(a, b)` compares the canonical client fields listed under Idempotency; `validateEntry` / `validateCustomer` return the first failing reason from the table below, or `null` (`CODE_TAKEN` fires only when `codesTaken.get(code)` is a different id). A rejected customer is removed from `knownCust` before its entries are validated, so those entries are answered `UNKNOWN_CUSTOMER` (retriable) instead of hitting the foreign key inside the batch and failing the whole chunk on every retry. Raw SQL through the D1 binding is all this route needs; Drizzle ORM supports D1 if the developer later prefers typed queries [64]. Vitest/miniflare tests cover: a new customer and her first GIVE in one chunk; a rejected customer and her entry in one chunk; the same code with two different customer ids pushed from two devices (`CODE_TAKEN`, never `batch_failed`); the same original reversed on two devices (`ALREADY_REVERSED`, never `batch_failed`); 20 entries on one archived customer in one chunk (one un-archive statement, one change-log statement, under 100 parameters); a resent chunk returning the same seqs as the first, for `stored` and `already` alike; and the archive-then-offline-GIVE interleaving described under Customer identity rules.

### What the server rejects (and the client checks the same before enqueueing)

| Reason | Rule | Permanent? |
|---|---|---|
| `BAD_AMOUNT` | `amount_paise` not a positive integer, or `delta_paise` sign wrong for `kind` | yes |
| `FUTURE_DATE` | `biz_date` later than the server's IST date + 1 day | yes (see note) |
| `UNKNOWN_CUSTOMER` | `customer_id` not on the server and not accepted in the same push | retried, **never permanent on its own**: listed in Needs attention under its parent customer's reason; resends automatically once the parent is accepted |
| `UNKNOWN_ORIGINAL` | REVERSAL target not on the server and not accepted in the same push | retried, same rule as above (the original is earlier in the outbox) |
| `ALREADY_REVERSED` | target already has a reversal (seen by the pre-check on `reverses_entry_id`) | yes, but **auto-resolved**: the client marks its duplicate reversal `rejected` (hidden, excluded from every sum) and shows a one-line notice; the other phone's reversal arrives on the next pull with the same effect |
| `REVERSAL_OF_REVERSAL` | target's `kind` is REVERSAL (correct a wrong reversal with a new entry instead) | yes |
| `REVERSAL_MISMATCH` | `customer_id`, `amount_paise` or `mode` not equal to the original's, or `delta_paise ≠ -original.delta_paise` | yes |
| `ARCHIVE_NONZERO` | customer archive requested while server-side `SUM(delta_paise)` plus this chunk's entries `≠ 0` | yes |
| `CODE_TAKEN` | `(shop_id, code)` already belongs to another customer id | retried after the client reallocates a code from its block (the UUID is unchanged) |
| `ERASED` | name/phone/note change for a customer whose `erased_at` is set | yes |
| `FORBIDDEN_ROLE` | staff device pushing WRITEOFF, archive, or calling owner endpoints (`/devices/*` management, `/export`, `PUT /shop`, `/customers/:id/erase`) | yes |
| `mismatch` | same id, different canonical content | yes |
| `batch_failed` | a single-row chunk still threw inside `db.batch()` (unknown constraint) | yes; the row and its reason go to Needs attention for a developer to look at |

The date picker refuses future dates, so `FUTURE_DATE` can only come from a badly wrong clock. Permanently rejected rows get `sync_state = 'rejected'`, **drop out of every balance, statement and day-book query**, badge the customer, and appear in a visible "Needs attention" list in Settings with two actions: "discard" (for a genuine duplicate) or "fix date and resend" (the row is re-queued with `sync_state = 'pending'`). Rows are never silently dropped, and no phone ever quotes a balance that includes a row the server refused.

### Sync protocol, step by step (client)

1. **Mutex and triggers.** One sync at a time. Triggers: app foreground, network regained, 30 s after a local write (debounced), pull-to-refresh, every 15 minutes while the app is open. *(v2.3: 2 s, 20 s in use / 1 min idle, and on opening a balance screen.)*
2. **Push.** Read `outbox ORDER BY n` in chunks of at most 20 rows, customers before entries (a new customer precedes its entries; originals precede reversals because insertion order is preserved). `POST /sync/push`.
3. **Apply the push response in one local transaction.** `stored`/`already`: set `sync_state = 'accepted'`, `server_seq` and `received_at` on the row, delete its outbox row. `rejected`: increment `attempts`, store `reason`; retriable reasons stay in the outbox (`CODE_TAKEN` first reallocates the code; `UNKNOWN_*` rows are shown under their parent); `ALREADY_REVERSED` sets `sync_state = 'rejected'` on the local duplicate (which drops it from every sum; it is hidden rather than listed under Needs attention) and shows a notice, so even this case needs no DELETE; permanent reasons set `sync_state = 'rejected'` and go to Needs attention. Rows that depend on a rejected row are skipped, never blocked behind it.
4. **Pull.** `GET /sync/pull?since=<meta.cursor>`. The Worker runs `SELECT seq, tbl, row_id FROM changelog WHERE shop_id = ? AND seq > ? AND device_id <> ? ORDER BY seq LIMIT ?` (the third parameter is the calling device, so a phone never downloads its own rows), joins each row to its current content, and returns the page with `next_since` (the last seq in the page), `has_more`, the device list, the `shop` object (name, UPI id, language, approval-PIN hash and salt, stored into `meta`) and `sync_epoch`. **Epoch check first:** if the response's `sync_epoch` differs from `meta.sync_epoch`, the server database was restored or re-imported and its `seq` counter may have gone backwards; the client stores the new epoch, resets `meta.cursor = 0`, **and runs the same routine as "Re-upload everything"** (every local row back to `pending` with `server_seq = NULL`, all enqueued) before applying anything. The re-push is not optional: every row this phone pushed after the restore point is still `accepted` locally with no outbox row, so without it those entries would be missing from the mirror and from every other phone forever; the server answers `already` for everything it still holds, so the re-push is idempotent and costs only requests. Then the page is applied in one local transaction: customers are upserted with the server's row **unless the local row still has a pending outbox edit** (in which case the local edit is kept; it will be pushed and, being accepted later, will become the server's current row), except that a server row carrying `erased_at` is applied unconditionally and the local pending edit is dropped, so stale personal data never stays on screen; entries `INSERT OR IGNORE` then `sync_state = 'accepted'`, `server_seq`, `received_at` set; the `devices` mirror replaced; `meta.cursor = next_since` in the same transaction. Repeat while `has_more`. Because the change log is append-only, a page can never reference a customer the client has not already received, so `PRAGMA foreign_keys = ON` is set explicitly on the phone (the plugin docs do not say what the default is) and the page transaction cannot fail on an orphan.
5. **Clock check.** If `|server_time − now| > 10 minutes`, store the offset in `meta.clock_offset_ms`, show a banner, and default new entries' `biz_date` to the server's IST date (computed from the corrected clock) until the phone clock is fixed.
6. **Repaint.** Balances are sums, so nothing needs reconciling.

**Conflict rules.** Entries cannot conflict: same id means the same row; different ids both stand and the sum is still right. Customer edits are last-write-wins **in server order**: the row the single-primary D1 accepted last is the current row, which is what "last write" means and does not depend on any phone's clock (a phone a day ahead can no longer win every edit forever, nor resurrect a corrected phone number or a DPDP erasure). `updated_at`/`updated_by` are kept as information for the "details were changed by <device>" notice only. Last-write-wins is whole-row: if phone A changes Kamala's number while phone B, offline, changes her note, the row that syncs last silently wins both fields, and the notice says so ("replaced the details saved on <other device>"); field-level merging is not worth its complexity for a few hundred customers edited a handful of times a year. Money never depends on customer fields. Two devices creating the same person offline produce two UUIDs; after a pull the app flags duplicate phones and offers "merge" in v1.2 (archive one, move the balance with a WRITEOFF/GIVE pair, keep both histories).

**Retry after a timeout.** If the push times out after the server committed, the outbox rows are still pending; the next push resends the same ids and gets `already` with the original `seq`. A crash between receiving the response and committing step 3 behaves the same way. Pull is likewise safe: the cursor advances only in the transaction that commits the rows it covers. No path loses or double-counts an entry.

**Backoff and errors.** 401 → "This phone was removed; pair again" state. If the owner chose "wipe their copy" at revoke (`wipe_on_revoke`), the phone erases its local database once it has shown the still-unsynced outbox rows for re-entry on another phone; otherwise the ledger stays readable and the outbox is preserved, and the privacy notice says which. If the token cannot be decrypted (Keystore key gone after a restore), show the Pair screen, never a crash; the re-pair sends `previous_device_id` from local `meta` so the server revokes the old row in the same batch and the device list shows no ghost phone. 413 or `batch_failed` → halve the chunk down to 1, then mark that row (see Idempotency). 429, 5xx, network error, or Cloudflare's free-plan daily-cap error 1027 [1] → exponential backoff with jitter (5 s, 30 s, 2 min, up to 1 h); the pill reads "Last backed up 09:41 · retrying". A per-device `requests_today` counter in D1 refuses sync for the rest of the UTC day past 5,000 requests (10,000 from v2.3, whose 20-s polls make about 4,000 a day on a busy phone left open) so a sync-loop bug on one phone cannot burn the shared 100,000/day free cap before 05:30 IST.

### `wrangler.jsonc`

```jsonc
{
  "name": "khata-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "observability": { "enabled": true },                      // Workers Logs, free tier [16]
  "placement": { "mode": "smart" },                           // free experiment; D1-aware placement is unverified [69]
  "d1_databases": [{ "binding": "DB", "database_name": "khata",
                     "database_id": "<from: npx wrangler d1 create khata --location=apac>",
                     "migrations_dir": "migrations" }],
  // Optional upgrade once R2 is enabled (may require a card on file, likely [14]):
  // "r2_buckets": [{ "binding": "BACKUPS", "bucket_name": "khata-backups" }],
  // "triggers": { "crons": ["30 20 * * *"] },               // 02:00 IST; crons run on UTC [12]
  "vars": { "PAIR_CODE_TTL_MIN": "10", "DAILY_REQUEST_CAP": "5000", "PAIR_THROTTLE_AFTER": "20" }
  // secrets, never in this file:  npx wrangler secret put PEPPER   [20]
}
```

Local development: `wrangler dev` runs the Worker on a local D1 that persists between runs; `wrangler d1 migrations apply khata --local` targets it [11].

---

## Android app

### Stack and versions

- **Capacitor 8.x** (`@capacitor/core`, `@capacitor/cli`, `@capacitor/android`): targetSdk 36, minSdk 24, AGP 8.13, Gradle 8.14.3, Java 21 [39]. API 24+ covers roughly 99% of Android devices (data 2025-12-01) [38]. Capacitor ships no native `.so` of its own, so the 16 KB page-size requirement is met automatically [36].
- **TypeScript** (6.x or 7.x; 5.x also works. TypeScript 7.0, the Go-native compiler, went GA on 8 July 2026 [73], and 6.0 (23 March 2026) is intended as the last release on the JavaScript codebase [76]; pick 7 if you want faster builds), bundled by **Vite 8** (Vite 8 shipped 12 March 2026 on the Rolldown bundler in place of esbuild/Rollup, 8.1 on 23 June 2026; a project created today gets it by default [72]), plain DOM with small render functions (no UI framework). **Vitest** for `ledger.ts`.
- **Plugins:** `@capacitor-community/sqlite` (bundles its own SQLite; SQLCipher optional; `exportToJson`/`importFromJson`) [40]; `@capacitor/app`, `@capacitor/network`, `@capacitor/share`, `@capacitor/filesystem`, `@capacitor/preferences`; a Keystore-backed secure-storage plugin for the device token (pin the version at setup); `libphonenumber-js`; a tiny UUID v4 polyfill over `crypto.getRandomValues` (`crypto.randomUUID()` needs Chrome 92+ and throws on an un-updated API 24-26 system WebView); the app asserts UUID, `Intl.DateTimeFormat.formatToParts` and `sqlite_version() >= 3.35` at start and refuses to run on a WebView below the version tested. `@capacitor-community/sqlite` 8.1.1 (6 Aug 2026) declares peer `@capacitor/core >= 8.0.0`, so the Capacitor 8 pairing is confirmed; verify that the pinned release ships 16 KB-aligned native libraries at build (unverified) [36]. The fallback is `@microbit/capacitor-sqlite-vanilla` [74] (scoped package; androidx `sqlite-bundled` driver, so SQLite ≥ 3.35 holds; **young, single-app track record, one npm release (0.1.0, Feb 2026, peer `@capacitor/core >= 8.0.0`, README still says "Capacitor 7"), no SQLCipher, no web support**; note that the unscoped, deprecated `capacitor-sqlite` on npm is an unrelated trap). Set `plugins.CapacitorHttp.enabled = true` in `capacitor.config.ts` so `fetch` goes through the native HTTP stack and CORS never applies (see Transport).
- **Kotlin, two tiny plugins in v1.2 only:** print-to-PDF via `WebView.createPrintDocumentAdapter`/`PdfDocument` [45], and a WorkManager periodic sync job [52].
- **Permissions:** `INTERNET` only. Google's India fraud-protection pilot blocks sideloaded installs that declare `RECEIVE_SMS`, `READ_SMS`, the notification-listener service or an Accessibility service [35]. We also avoid Contacts and Location because Khatabook/OkCredit reviews link them to loan spam [53][54]. Use the contact *picker* intent and `smsto:` instead. The manifest sets `android:allowBackup="false"` (see Backups).

### Screens

1. **Lock.** 4-6 digit PIN (PBKDF2 hash via WebCrypto, stored locally) or fingerprint (on by default when the phone has one), on every cold start and after a background timeout that is a setting (2 / 10 / 30 minutes; default 10, because a 2-minute lock at a busy counter costs a PIN entry per sale). Five wrong PINs → 30 s lockout, doubling. "Forgot PIN" re-pairs the device and keeps local data, using a pair code from another owner phone **or one of the owner recovery codes printed at handover** (the one-phone shop has no other phone to mint a code; without recovery codes this path silently needed the developer to run `INSERT INTO pair_codes ...`).
2. **Pair** (first run). Scan the QR (128-bit secret) or type the 8-digit code (or an owner recovery code), name the phone. Stores the token, the server-issued `device_id`, `sync_epoch`, the `shop` object and the first customer-code block. A phone that already holds pre-pairing data sends `max_local_code` and swaps its provisional `device_id` for the server-issued one (see Customer identity rules).
3. **Home / Customers.** Search (name, `search_name`, code, phone, note; "murugan 3rd" matches name and note together), total outstanding at the top, list from the single home query with balance in red (owes) or green (advance), **each row showing code and note (or the last four digits of the phone)** so namesakes are distinguishable, `days_since` on each row, sort chips (recent, highest due, oldest unpaid with never-paid customers first), filter chip "Not paid 30+ days" (balance above zero *and* 30+ days since the last unreversed payment or first credit) and a due list "over N days / over ₹X" for the morning round (v1, week 2), archived customers with a non-zero balance shown with an "archived" badge, big "+ Customer", sync pill ("Saved on phone · backed up 09:41" / "3 to back up" / "Offline"). **A search with no match shows an "Add \"Murugan\" as new customer" row** so a brand-new customer buying rice is: type name → tap row → Save & add credit → amount → Save, well inside ten seconds. 500 customers must render in under 100 ms: one query, virtualised list.
4. **Add / edit customer.** Name (required; `search_name` auto-filled for Tamil names), phone (optional, contact picker, formatted to +91), note; the duplicate-phone warning is inline under the field and the same-name prompt ("Open him or add another?") appears on save; assigned code shown immediately. The primary button is **"Save & add credit"**, which lands straight on the Gave keypad; phone and note can be filled in later from the detail screen.
5. **Customer detail.** Big balance (green "Settled" state with "Send receipt" when it is 0; a stale-sync pill when the shop has more than one phone and the last pull is old), tap-to-call via `tel:`, two full-width buttons "கொடுத்தது / Gave" (red) and "பெற்றது / Got" (green), chronological entries with running balance and a small device-name chip on each row, a reversed entry and its reversal **collapsed into one struck-through line** by default ("show corrections" toggle expands them), "Correct" on each row: it posts the REVERSAL (dated like the original) and opens the keypad **prefilled with the original's amount, date, note and kind**, so fixing yesterday's ₹1,500 to ₹150 is one edit and one Save, and the statement shows one corrected line rather than three confusing rows. Menu: Statement, Remind, Edit, Write off (owner only, reason required), Archive (owner only, zero balance only), Erase (owner only).
6. **Add credit / Add payment.** Same screen with the sign preselected. Full-screen keypad (`<input inputmode="decimal">`, parsed by `toPaise()`, never `parseFloat * 100`), amount in 40 px type with lakh grouping as you type (`Intl.NumberFormat('en-IN', {style:'currency', currency:'INR'})` gives `₹1,23,456.50` [50]), the amount in words beside the digits (en-IN and ta-IN lakh-system number-to-words helpers in `ledger.ts`, with tests), date chip (today in IST; tap to back-date; no future dates), optional note; on Got: a "Full ₹1,250" chip that prefills the balance and a Cash / UPI / Other mode chip; Save. **Quick-entry mode** (from the day book) chains search → amount → Gave/Got → "Save & next" with the date chip sticky and a running count and total for the sitting.
7. **Day book.** Two tabs. **Business day:** one IST `biz_date` at a time from the single day-book query: given, received (split Cash / UPI / other), write-offs, net, count, with a reversed entry and its reversal **excluded from every column** (so correcting yesterday's ₹1,500 to ₹150 never reads "Given ₹1,650", and a reversed cash receipt never inflates the drawer total checked at closing) and a small "corrections today" count; the day's entries across customers with a device-name chip, a reversed pair collapsed into one struck-through "corrected" line exactly as on the statement; swipe for previous days; month total. **Entered today:** everything typed on this calendar day by `created_at` in IST, whatever `biz_date` it carries, so a back-dated slip entered tonight is in tonight's check against the paper book. Filters by device ("entries by staff"). Footer shows the unsynced count. Entry points for Quick-entry mode.
8. **Statement / share.** Period selector (since last zero balance, or "Settled · ₹0 due" when the balance is 0; last 30 days; all; custom), Tamil / English toggle, on-screen preview with opening and closing balance and the "includes entries up to last sync" line, buttons: WhatsApp (to the customer's number, or with no number / "Send to another number" when there is none), SMS (one-line balance, with the segment count shown), Copy text, Share image (v1.1), Share PDF (v1.2).
9. **Settings.** Shop name, UPI ID, language, PIN change, lock timeout, staff review cap and the shop's approval PIN (owner; synced to staff phones as a hash), Devices (list, "Add a phone", Revoke with a "wipe their copy" choice, **Recovery codes: N unused, re-issue**), Backup (last backed-up time, "Save a backup copy", **"Download server copy"** (owner; calls `GET /export` and shares the JSON to Drive so the monthly off-platform copy needs no developer), "Restore from file", "Re-upload everything"), Needs attention list, privacy notice, erase-customer action, version.

### Offline behaviour

Every screen reads and writes the local database only; the Worker is never on a screen's critical path. Only pairing, pulling the other phone's entries and the server export need the network, each with a clear "needs internet" message rather than a spinner. There is never an "update required" wall.

### Background sync

v1: foreground triggers only (app active, network regained, after writes, 15-minute timer while open). This is enough for a counter app that is open all day; Capacitor has no first-party WorkManager plugin. v1.2: a 50-line Kotlin `PeriodicWorkRequest` (15-minute minimum, network constraint) [52] calling the same engine; budget Xiaomi/Realme ROMs may suppress it, so the foreground triggers remain the ones that matter.

### Statement sharing

- **Text first** (what Indian khata apps actually send): "Kamala (C-0042) · Balance due ₹1,250 as of 12 Oct 2026 · 10/10 Gave ₹500 (rice, dal) · 11/10 Got ₹300 ...". WhatsApp: `ACTION_VIEW https://wa.me/91XXXXXXXXXX?text=<url-encoded>`, number in full international format without `+`, zeros, brackets or dashes, as WhatsApp's own help page documents [47]; `https://wa.me/?text=...` with no number when the customer has none. SMS: `ACTION_SENDTO smsto:+91...` with `sms_body` [46], carrying the one-line balance only (Tamil SMS is UCS-2, 70 characters per segment; the app shows the estimated segment count before handing over to the SMS app). If the shop's UPI ID is set, append `upi://pay?pa=<vpa>&pn=<shop>&am=1250&cu=INR&tn=Khata%20C-0042` (`pa` and `pn` mandatory, `cu` must be INR) [56] plus the UPI ID in plain text, because `upi://` links are not clickable in every client.
- **Image second (v1.1):** the WebView shapes Tamil correctly; capture the rendered statement with `html-to-image` and share the PNG through `@capacitor/share`.
- **PDF third (v1.2):** a small Kotlin plugin renders the statement HTML through Android's print framework or `PdfDocument` (API 19+, Tamil shaped by the platform text layout) [45] and shares `application/pdf` via `FileProvider` with `FLAG_GRANT_READ_URI_PERMISSION` [46]. Do not use a JavaScript PDF library for Tamil; Indic shaping is weak there.
- **Policy:** every send is a tap by the shopkeeper; the app never sends automatically, which keeps it inside WhatsApp's opt-in policy [48] and avoids DLT registration [57].

### Tamil + English

`strings.ta.json` / `strings.en.json` with a `t(key)` helper and an in-app toggle in `meta.lang` (the shopkeeper will not find the system per-app language setting [49]). Tamil strings run 30-50% longer, so buttons use `min-width`, never fixed widths. Dates via `Intl.DateTimeFormat` with `timeZone: 'Asia/Kolkata'`. Accept ASCII and Tamil digits. Amount-in-words uses a small en-IN / ta-IN lakh-system number-to-words helper in `ledger.ts` with tests. Search matches both the Tamil `name` and the Latin `search_name`. Test Tamil glyphs on the shopkeeper's actual phone in week 1. Android 16 (targetSdk 36) removes the edge-to-edge opt-out and enables predictive back by default [37] (platform text-layout changes such as Android 15's `elegantTextHeight` do not apply to text the WebView shapes); design for insets (`env(safe-area-inset-*)`) and route the back button to the in-app navigation stack from day one.

### Fat-finger safeguards

Amounts are parsed from the typed string by `toPaise()` (rupees × 100 + two-digit paise; `parseFloat('12.29') * 100` gives 1228.9999 and would fail `Number.isInteger`), with Vitest cases for 0.29, 1.1, 12.29 and 99999999.99; reject zero, negative and more-than-two-decimal amounts; confirm above ₹10,000 (configurable); confirm if the same customer got the same amount and kind within 60 s on this device; disable Save while the write is in flight; amount in words; 10-second Undo after every save (a REVERSAL, never a delete); the toast repeats the amount and new balance; "Correct this entry" instead of edit/delete, and different colours for Gave and Got (both explicit requests in OkCredit reviews) [53].

---

## Auth & security

**Login is device pairing, not accounts.** The developer seeds the shop and a first owner pairing code with `wrangler d1 execute khata --remote --command "INSERT INTO pair_codes ..."` (storing the code's hash). On first launch the owner types the code → `POST /pair` → the Worker checks the code is unused, unexpired (10 minutes) and the shop is not locked out, generates a 256-bit random token and a server-side `device_id`, stores `sha256(token || PEPPER)` in `devices` and returns the plaintext token once with the device's first customer-code block. Additional phones: Settings → Devices → "Add a phone" calls `POST /devices/pair-code` and shows a QR carrying a 128-bit random secret, with an 8-digit single-use code as the typed fallback. Tokens do not expire; they are revoked.

**Owner recovery codes (the developer-free way back in).** At setup the app mints 3-5 long-lived, single-use owner recovery codes (`pair_codes` rows with `kind = 'recovery'`, no expiry, role owner, 16 random base32 characters so they stay unguessable for years, stored hashed), prints them on the handover page, and the shopkeeper keeps the page in the shop's cash box. Settings → Devices shows how many are unused and re-issues them from any owner phone. This is the primary, no-card, no-developer path. A second, **optional** path needs neither a surviving phone nor the printed codes: a tiny owner page on a second Worker, `khata-owner` (same D1 binding, about 40 lines), behind Cloudflare Access one-time PIN sent to the shop's own email [26], mints a pair code. Access on `workers.dev` is enabled per Worker, not per path [18], which is why the page is not a route on `khata-api` (Access in front of `/v1/sync/*` would answer the phones' bearer-token requests with an HTML login page) and why no custom domain is needed; the page also verifies the `Cf-Access-Jwt-Assertion` header itself, so a misconfigured policy cannot expose the minting route. Its one real prerequisite is that Zero Trust onboarding asks for a subscription plan and payment details even on the Free plan ("you will not be charged") [61], so it is offered to the shop as an option (open question 9) rather than assumed. Without the recovery codes, a one-phone shop that loses, breaks or wipes its only phone has its data safe in D1 and no way to reach it. No passwords to write on the wall, no SMS cost, no DLT, works on phones without a Google account.

Google Sign-In via Credential Manager is the v2 option if named accounts become useful (legacy `play-services-auth` sign-in is deprecated [60]); Cloudflare Access (one-time PIN to email) is used only for two tiny browser pages, the optional owner pair-code page above and a developer admin page, never by the phone app (Zero Trust Free covers up to 50 users, likely [61]; onboarding asks for a payment method even on Free).

**Token storage.** The device token is encrypted with an AES-GCM key generated in `AndroidKeyStore` by the secure-storage plugin, ciphertext in app preferences. Not `localStorage`, not plain preferences, and not `EncryptedSharedPreferences`, which is deprecated with no further releases [42].

**Database encryption (decision).** SQLCipher is **off in v1**; the database lives in app-private storage behind the PIN. The SQLCipher key would live in the Keystore, and if that key is lost (factory reset, "Clear data", some OEM OS updates) the local file is unrecoverable, which is only acceptable once D1 sync is live and proven. SQLCipher becomes a Settings option in v1.2, after sync has run for a month.

**Device PIN.** App-layer lock on cold start and after the configurable background timeout (2 / 10 / 30 minutes, default 10), independent of the server, with a PBKDF2 hash stored locally. Biometric unlock is optional sugar over the PIN.

**Lost phone.** The owner opens Devices on another phone, or the optional `khata-owner` Access page, or the developer runs one `UPDATE devices SET revoked_at = ...`, and that token gets 401 on its next request. The lost phone's local copy stays behind the PIN, but be plain about what that means with SQLCipher off in v1: anyone with root or a debug backup of that phone can read the ledger; the PIN guards the UI, not the file. The privacy notice, the DR table and the shopkeeper briefing say so. Its pending outbox rows are lost, which the pill's "N to back up" count makes visible every day. The owner pairs a new phone (recovery code, another phone's pair code, or the optional Access page) and pulls from `since=0`.

**Rate limiting.** A per-code `attempts` counter cannot guard `/pair`, because a wrong guess matches no `pair_codes` row and increments nothing; while a code is live an attacker who knows the `workers.dev` URL could try every possible 8-digit code (100 million guesses) at Workers speed, and merely trying would burn the shop's shared 100,000 requests/day cap. So failures are counted **per UTC day** in `pair_failures`; since this Worker serves one shop, every failed `/pair` is charged to that shop (a multi-shop version would prefix codes with a short shop id so a wrong guess can be attributed). The response is a **throttle, never a lockout and never burning codes**: past 20 wrong guesses in a day, `/pair` accepts one attempt per 30 s (`next_allowed_at`) and answers the rest with 429, and the Workers Rate Limiting binding (GA 2025-09-19; per-location, 10 s or 60 s periods only, "not an accounting system") [15] blocks the offending client IP for 60 s as a cheap first layer. Burning live codes on failures, the obvious alternative, would hand anyone with the URL a denial-of-service lever (20 junk requests every 15 minutes and the shop could never pair a phone) and could destroy the owner's recovery codes; a 10-minute, 8-digit code at a couple of guesses a minute is unguessable without it, and the QR secret is 128 bits. Recovery codes never expire, so they are 16 random base32 characters (about 80 bits) and are excluded from every throttle side effect. All other routes are protected by the 256-bit token and the per-device daily request cap.

**Transport.** HTTPS only (`workers.dev` is TLS-terminated by Cloudflare). A Capacitor Android app runs in a WebView at origin `https://localhost` and the WebView enforces CORS like a browser: every sync call carries `Authorization` and `application/json`, so without help Chrome issues an `OPTIONS` preflight and a Worker with no CORS headers fails every fetch [71]. The plan takes option (a): `plugins.CapacitorHttp.enabled = true` in `capacitor.config.ts`, so `fetch` is routed through the native HTTP stack and CORS never applies, with no server change. Option (b), if CapacitorHttp ever misbehaves, is Hono's `cors({ origin: ['https://localhost', 'http://localhost', 'capacitor://localhost'], allowHeaders: ['Authorization', 'Content-Type'] })` answering `OPTIONS` on every `/v1` route. No other browser origins are allowed. The week-3 chaos tests run from a real phone against the deployed Worker, not against `wrangler dev`, so this is caught early.

**Personal data (DPDP Act 2023; core obligations from 13 May 2027 [55]).** Customer name, phone, note and debt history are personal data. The shopkeeper is the data fiduciary and the developer a processor under a one-paragraph written agreement. Shipped in v1: TLS in transit; D1 and R2 encrypted at rest by Cloudflare; app-private storage behind a PIN; hashed tokens; no ad or analytics SDKs; logs without request bodies; a Tamil/English privacy notice; an "Erase this customer" action that anonymises personal fields, sets the terminal `erased_at` on the server through `POST /customers/:id/erase` and purges the local snapshots, while keeping accounting rows; the notice lists what still holds the old values for how long (Time Travel 7/30 days, R2 dumps and Drive exports if the shop keeps them); a statement that the on-phone database is readable by anyone with root or a debug backup of the phone (SQLCipher is a v1.2 option); a statement that a revoked phone keeps or wipes its copy as the owner chose; `/export` owner-only. DPDP does not currently mandate localisation for an ordinary fiduciary (likely) [55], and the notice says the mirror is stored outside India [6].

---

## Backups & disaster recovery

**The $0, no-card baseline (always present):**

1. D1 Time Travel, automatic, 7 days free / 30 days paid [5].
2. A local JSON snapshot (`exportToJson`) written to app-private storage on the first launch or foreground of each day when the last one is older than 24 hours (a Capacitor app has no background execution, so "nightly" is not possible); keep the last 7. On a few-MB database this takes under a second (estimate, unverified).
3. A weekly in-app nudge: "Save a backup copy to Google Drive?" shares the JSON (plus a CSV of entries) through the share sheet. The shopkeeper can run this any time from Settings with no server involved, so they are never locked in.
4. Monthly: the developer runs `npx wrangler d1 export khata --remote --output=khata-YYYY-MM.sql` [8] and keeps the file off Cloudflare (laptop + the shop's Google Drive).
5. Quarterly drill: **actually execute the `.sql`-to-production runbook below against a scratch database and a test phone**, check `SELECT * FROM sqlite_sequence; SELECT * FROM d1_migrations;` on the restored database before switching `database_id` (an export that did not carry those rows makes the sequence bump a silent no-op), and compare the total outstanding (not five customers) with the owner's phone. If the import fails with "cannot start a transaction within a transaction", strip `BEGIN TRANSACTION`/`COMMIT` from the file [8]. Never test a Time Travel restore on production: it is in-place and destructive [5].
6. The owner can do item 4 alone: Settings → Backup → "Download server copy" calls the streamed `GET /export` and shares the JSON to Drive, and the handover page lists it beside the recovery codes.

**Restore, defined precisely (a backup that has never been restored is not a backup).** *Phone from JSON snapshot:* wipe the local database → import only `customers` and `entries` → **discard `meta`** (restoring another phone's `device_id`, cursor and code block is how two phones end up allocating the same customer codes and reporting the wrong device) → `cursor = 0`, `sync_epoch` cleared → request a fresh code block → run "Re-upload everything", which sets `sync_state = 'pending'` and `server_seq = NULL` on every row and enqueues it (idempotent on the server). *Server from a `.sql` export:* export the current database first → `wrangler d1 create khata2` → `wrangler d1 execute khata2 --remote --file=khata-YYYY-MM.sql` → check `SELECT * FROM sqlite_sequence; SELECT * FROM d1_migrations;` → bump the sequence with `DELETE FROM sqlite_sequence WHERE name = 'changelog'; INSERT INTO sqlite_sequence (name, seq) SELECT 'changelog', COALESCE(MAX(seq), 0) + 1000000 FROM changelog;` (a plain `UPDATE sqlite_sequence` silently affects zero rows when the export did not carry that row, and `sqlite_sequence` has no unique constraint, so delete-then-insert rather than `INSERT OR REPLACE`) → `UPDATE shops SET sync_epoch = '<new uuid>'` → put the new `database_id` in `wrangler.jsonc` → `wrangler deploy` → phones see the new epoch, reset their cursor, **re-push everything they hold and re-pull** (automatic, see sync step 4; nobody has to remember to tap "Re-upload everything" on each phone). *Server by Time Travel:* export first, `wrangler d1 time-travel restore khata --timestamp=...` [5], then the same sequence bump and epoch change. The sequence bump and the epoch change are what stop a restored server from rewinding `seq` below the phones' cursors, which would otherwise make the second phone silently stop seeing new entries with no error anywhere; the automatic re-push on epoch change is what puts back the rows pushed after the restore point.

**Optional upgrade: nightly R2 dump.** Enabling R2 requires a checkout flow [13] that likely asks for a payment method even for free-tier use [14]. If the shop agrees, add the R2 binding and the `30 20 * * *` Cron Trigger (02:00 IST; crons run on UTC [12]): the Worker SELECTs each table in pages of 5,000 rows (D1 documents no rows-per-query cap, only 2 MB per row [3]; 500-row pages would hit the 50-queries-per-invocation free cap at about 25,000 rows, which one year of entries exceeds) and writes one object per table per day (under 10 MB for years against R2's 10 GB-month free tier [13]). On Workers Free the cron has 10 ms of CPU and 50 queries [2][3]; the dump logs its row counts so a silently truncated dump is noticed, and if it ever hits those limits, Paid (1,000 queries, 30 s CPU) fixes it. If R2 is never enabled, items 2-4 above still guarantee an off-device copy.

**Account ownership (setup step, week 3):** the Cloudflare account and the GitHub repository are created with the **shop's own email**; the developer is added as a member. 2FA recovery codes stay with the owner, so the shop is never locked out by a developer's personal account.

| Scenario | What happens | Recovery |
|---|---|---|
| Phone lost or dead | Local copy inaccessible (and, with SQLCipher off in v1, readable by anyone who roots the phone); D1 has every synced row | Re-install the APK from the copy kept on the shop's Google Drive (the GitHub Release is the secondary copy); revoke the device from another phone, the optional Access owner page or by the developer; pair with **an owner recovery code from the cash box**, a pair code from another phone, or a code minted on the optional Access owner page; full pull restores everything up to the last sync. Only unsynced entries (the pill's count) are gone. |
| Local DB corrupted | `PRAGMA integrity_check` fails at launch | Rename the bad file, recreate, pull from `since=0`; salvage outbox rows from the latest local snapshot. |
| Wrong entry made days ago | Nothing to restore; ledger is append-only | "Correct": REVERSAL (dated like the original) plus corrected entry prefilled from it, both synced, collapsed into one corrected line on the statement. This is the common case and it is a feature, not DR. |
| D1 data damaged by a bug or bad migration | Phones still hold complete copies | **First:** export → `wrangler d1 time-travel restore khata --timestamp=...` (in-place; the output includes an undo bookmark) [5] → the `sqlite_sequence` delete-and-insert bump from the runbook → `UPDATE shops SET sync_epoch = '<new uuid>'`. **Second:** nothing manual on the phones: the epoch change makes every phone reset its cursor and re-push everything it holds (Settings → "Re-upload everything" does the same by hand). Re-uploading *before* the restore would be wiped by it, so the order matters. Without the sequence bump and epoch change the phones' cursors sit above the restored `seq` and never pull again; this is written here so it is not forgotten at 2 a.m. |
| Cloudflare outage (12 Jun 2025 precedent [24]) | Sync fails and backs off | Nothing visible at the counter; the outbox drains when Cloudflare returns. |
| Cloudflare account locked, billing problem, lost login | Server unreachable indefinitely | Phones are primary; the Drive exports and monthly `.sql` exist off-platform. The Worker is plain fetch-handler code and D1 is plain SQLite, so redeploying elsewhere is a day's work; re-pair. |
| Developer disappears | No one to run wrangler | Nothing expires (no documented inactivity deletion, likely [7]). The shopkeeper can export at any time with no server, download the server copy from Settings, re-install the app from the signed APK kept on the shop's Google Drive, pair a replacement phone with a recovery code or the optional Access owner page, and re-issue recovery codes from any owner phone. Repo, keystore, accounts, the APK copy on Drive and a one-page handover document ("the three commands that matter", the recovery codes, the monthly "Download server copy" step) belong to the shop. |
| Schema migration goes wrong | Worker rollback never reverts D1 data [19] | Migrations are additive only (add tables/columns, never drop in the same release); `wrangler rollback` to any of the last 100 versions [19]. |

Android Auto Backup is switched off with `android:allowBackup="false"`: `data_extraction_rules` is only read on Android 12+ (API 31), so with minSdk 24 every Android 7-11 phone would fall back to `fullBackupContent` and back up the live WAL-mode SQLite files (three files, inconsistent as a file-level copy, 25 MB cap) by default [43]; worse, the backup would carry the token ciphertext but not the AndroidKeyStore key, leaving a restored phone with an undecryptable token and a PIN hash with no database. If backup is ever wanted, ship both `fullBackupContent` and `dataExtractionRules` XML excluding the database directory and the token/PIN preferences. Either way, on token-decrypt failure the app shows the Pair screen. The sync and the explicit exports are the real backup.

---

## Build, signing & distribution

- **Repository layout:** a new repository owned by the shop's GitHub account, with `api/` (Worker, `migrations/`, `wrangler.jsonc`) and `app/` (Vite + Capacitor). The unrelated demo files in `/home/user/ALERTS` are not touched.
- **Application id:** `in.<shopname>.khata`, chosen once, never changed.
- **Keystore:** `keytool -genkeypair -v -keystore khata-release.jks -alias khata -keyalg RSA -keysize 2048 -validity 10000`. Two backups: the developer's password manager and an encrypted copy the shop owner holds. Losing it means the shopkeeper must uninstall and re-pair (data survives in D1), and updates stop installing until then.
- **Release build:** `npm run build && npx cap sync android && cd android && ./gradlew assembleRelease`, with `signingConfigs.release` reading the keystore path and passwords from `~/.gradle/gradle.properties` (never committed). Output is a **universal APK**, because a single file is what WhatsApp or a Drive link can deliver and what the "Install unknown apps" flow accepts (split APKs do install through `adb install-multiple` or any PackageInstaller-session installer; they are just not what a shopkeeper can tap). Bump `versionCode` every release; updates must carry the same signature. If the app ever goes to Play, enrol in Play App Signing so the upload key can be rotated if it is lost [33].
- **Where the APK lives:** at every release the current signed universal APK is copied to the shop's Google Drive, in the same folder as the recovery codes and the exports, so a replacement phone can be set up a year after the developer is gone; the GitHub Release attachment (CI, week 6) is the secondary copy. This is a week-4 handover item.
- **Delivery today (sideload):** send the APK by Drive link or WhatsApp. The shopkeeper allows "Install unknown apps" once for that source [66]. Play Protect may scan it and warn about an unknown developer [67]; tell them to expect it. Because the app declares none of the four permissions the pilot checks (`RECEIVE_SMS`, `READ_SMS`, notification listener, Accessibility), India's sideload fraud filter does not trigger [35]. Developer verification enforcement started 2026-09-30 only in Brazil, Indonesia, Singapore and Thailand and only for participating stores; India is not in the first wave and global rollout is "2027 and beyond" [34].
- **Before 2027:** register the package name under either the free "limited distribution" developer account (no government ID; up to 20 user-authorised devices; framed as non-commercial but with no stated commercial prohibition; it still requires a Google Account with 2-Step Verification and a linked Google payments profile, which matters because the account is created under the shop's email) or the full $25 one-time account [34][30], so sideloaded updates keep installing without the user "advanced flow".
- **Play Store path (v1.3, optional):** the full developer account costs US$25 one-time and may require government ID [30]. Publish to the **Internal testing** track with the shopkeeper's Gmail as a tester: up to 100 testers, releases within minutes, auto-updates from Play, and the 12-tester/14-day closed test that gates *production* for personal accounts created after 13 Nov 2023 applies only before applying for production access; Google's help page states that internal testing has no access requirements [31][32]. Build an AAB (`bundleRelease`) for Play [33]. New apps and updates must target API 36 since 2026-08-31 [29]; Capacitor 8 already does.
- **CI (week 6):** the Worker deploys through Workers Builds connected to the GitHub repo (free: 3,000 build minutes/month) [17], or `cloudflare/wrangler-action@v3` with `CLOUDFLARE_API_TOKEN` [21]. A second job runs `vitest` and `assembleRelease` with the keystore as a base64 secret and attaches the APK to a GitHub Release.
- **Operations:** UptimeRobot (free) on `GET /health` every 5 minutes, because Cloudflare Free sends no alert when a Worker starts returning 500s (unverified). Workers Logs free tier is 200,000 events/day with 3-day retention, moving to Observability pricing on 1 Dec 2026 (free 0.5 GB/day), far above this app's volume [16]. Monthly 30-minute checklist: confirm Drive exports, run the `.sql` export, glance at error rate and D1 usage, `npm update` and redeploy.

---

## Milestones

Thin vertical slice first; every week ends with something installable on the shopkeeper's real phone.

**Week 1 — It works on one phone, no backend.** Capacitor shell with `CapacitorHttp` enabled and `allowBackup="false"`, local SQLite with the on-device DDL and the plugin's `addUpgradeStatement` migrations, startup assertions (`sqlite_version() >= 3.35`, UUID, `formatToParts`), tests run on an API 24 emulator as well as the real phone, `ledger.ts` pure functions with Vitest tests (balance, `toPaise` on 0.29 / 1.1 / 12.29 / 99999999.99, reversal invariants and the reversal inheriting the original's `biz_date`, day book, `bizDateIST` rollover at 00:30 IST, a reversal arriving before its original, a duplicate resend, number-to-words en-IN/ta-IN). Screens: Home, Add customer, Customer detail, Gave/Got keypad, PIN lock stub. *Demo:* add Kamala, give ₹250, get ₹100, balance shows ₹150; kill the app; reopen; still there. Tamil glyphs checked on the real phone.

**Week 2 — Counter-ready ledger, still no backend.** Undo via REVERSAL, "Correct this entry" (prefilled keypad; collapsed pairs on statements, with tests), duplicate-tap and large-amount confirmations, amount in words, editable date, "Save & add credit" and the add-from-search row, same-name prompt, Day book with both tabs, the Cash/UPI split and reversed pairs excluded from the columns, Quick-entry mode, search and sort chips including `days_since`, the due list (over N days / over ₹X) and the "Not paid 30+ days" chip, Tamil/English toggle, text statement with WhatsApp (with and without number) / one-line SMS buttons and the UPI line, settled-receipt default, Export/Restore JSON (restore defined as in Backups), daily local snapshot. *Demo:* a full day of real entries at the shop in parallel with the paper book; totals match at closing.

**Week 3 — Cloudflare mirror.** Create the Cloudflare account under the shop's email; `npm create hono@latest` [21]; `wrangler d1 create khata --location=apac`; migration 0001 with the change log (confirm `PRAGMA defer_foreign_keys` inside `db.batch()` locally); Smart Placement on; the routes in the API table; Workers Builds; UptimeRobot. Sync engine with outbox, cursor, `sync_epoch` reset, `sync_state`, backoff with the chunk-size-1 terminal state, status pill, Needs-attention list with discard / fix-and-resend. Miniflare tests: new customer + entry in one chunk; rejected customer + entry in one chunk; same code with two customer ids from two devices (`CODE_TAKEN`); same original reversed on two devices (`ALREADY_REVERSED`); 20 entries on one archived customer in one chunk; a resent chunk returning the same seqs; archive on A then offline GIVE on B; a Time Travel-style `seq` rewind with and without the epoch change (the epoch change must trigger the automatic re-push). Chaos tests **from a real phone against the deployed Worker, not `wrangler dev`** (this is where a CORS mistake would show): airplane mode mid-push, kill the app after the response, resend the same batch; measure real push latency from the shop with a target of under 1 s per push (each D1 statement outside a batch is a round trip to the single APAC primary, so expect hundreds of milliseconds, not tens). *Demo:* wipe the app, re-pair, everything comes back; add an entry offline, go online, see it with `wrangler d1 execute --remote`.

**Week 4 — Second device, hardening, handover.** Pair codes (QR secret + 8 digits, two hashed rows per issue) and Devices screen, `pair_failures` throttle, revoke with wipe choice (and `previous_device_id` on re-pair), staff role enforced server-side plus the staff review cap with the synced approval PIN and the day-book filter, Forgot-PIN, **owner recovery codes printed on the handover page**, the optional `khata-owner` Access page (only if the shop accepts the Zero Trust card-on-file step), privacy notice (with the retention and lost-phone statements) and the erase action with `POST /customers/:id/erase`, edge-to-edge and back handling, weekly Drive nudge, "Download server copy", "Re-upload everything", signed universal APK **copied to the shop's Google Drive beside the recovery codes**, keystore backups, README and handover page, repo owned by the shop. *Demo:* staff and owner phones post entries offline, including a reversal crossing devices; both converge; the owner revokes the staff phone and it falls back to Pair.

**Week 5 — Pilot at the shop.** Install on the real phone(s). Migrate from the paper register with one `GIVE` entry per customer, note "Opening balance", dated the go-live day. Sit at the counter two evenings; fix what hurts. **Decide Free vs Paid now:** switch to Workers Paid ($5) on pilot day unless the shopkeeper commits to keeping the paper book alongside for the first month, because the 7-day Time Travel window is the real money risk on Free.

**Week 6 — v1.1 / v1.2.** PNG statement share, duplicate-customer merge, print-to-PDF Kotlin plugin, WorkManager sync plugin, optional R2 nightly dump, optional SQLCipher setting, CI, written monthly ops checklist. Decide on the Play internal-testing track.

---

## Cost

Assumed exchange rate 1 USD ≈ ₹86 (assumption; prices are vendor list prices read on 2026-10-12).

| Item | Free path | Paid path | Source |
|---|---|---|---|
| Workers (about 3-10k requests/day of 100k/day free; 10M/month on Paid) | $0 | $5/month (≈ ₹430) flat; no overage at this scale | [1][2] |
| D1 (3-12k row writes/day of 100k, hard-enforced on Free since 1 Sept 2026; tens of MB/year of 500 MB; 10 GB on Paid) | $0 | included | [3][4][75] |
| Time Travel restore window | 7 days | 30 days | [5] |
| R2 nightly dumps (optional; under 100 MB over years of 10 GB-month free) | $0, may require a card on file (likely) | included | [13][14] |
| Cron Trigger, Workers Logs, Workers Builds | $0 | included | [12][16][17] |
| Zero Trust Access for the optional owner pair-code page and a developer admin page | $0 up to 50 users (likely); onboarding asks for a payment method even on Free (not charged) | - | [61] |
| Domain (optional `.in`; `workers.dev` is fine to start) | - | ≈ ₹800-1,000/year (estimate) | [18] |
| Google Play developer account (optional, one-time) | $0 (limited-distribution account; needs 2-Step Verification and a Google payments profile on the shop's account) | US$25 ≈ ₹2,150 once | [30][34] |
| UptimeRobot, GitHub | $0 | $0 | - |
| SMS / WhatsApp sends | ₹0 (shopkeeper's own SIM and app) | ₹0 | [46][48] |
| **Monthly total** | **₹0 / $0** | **≈ ₹430 / $5 + GST** | |

What the $5 buys: 30-day instead of 7-day point-in-time restore, no daily caps that reset at 00:00 UTC (05:30 IST), 10 GB per database, 30 s CPU per request, 7-day log retention, and outbound email if ever wanted [1][3][5][62]. Nothing in this design needs more than $5/month before it serves many shops. Developer time (about 5-6 weeks part-time, then 30 minutes a month) is the real cost.

---

## Risks & mitigations

- **A sync bug duplicates or loses a money entry** (the incumbents' most-hated bug [54]). Append-only rows with client UUIDs, existence pre-check, `ON CONFLICT(id) DO NOTHING`, cursor pulls, mark-synced in the same transaction as the cursor, Vitest replays of a timeout mid-batch, paper book kept for the first month.
- **Entries lost between syncs if the only phone dies.** The pill shows "N to back up" all day; a second cheap phone pulling daily shrinks the window.
- **D1 write latency from Tamil Nadu is unmeasured** (single APAC primary, city not published [6]). Every statement outside a `batch()` is a Worker-to-primary round trip, so a push with a handful of sequential queries is realistically 0.4-0.6 s, not tens of milliseconds; batched pre-checks keep it there, and Smart Placement [69] is on as a free experiment (that it places the Worker near the D1 primary is unverified). No screen waits on the server; measure once in week 3 against a target of under 1 s per push, and if it is poor the documented lever is the D1 location hint.
- **Free-plan daily caps hit by a runaway loop** (error 1027 until 00:00 UTC [1]). Backoff, 20-row chunks, per-device daily cap, a `sync_paused` switch in Settings, and Paid at go-live.
- **Wrong phone clock.** `received_at` from the server, the 10-minute skew banner, server-date default for `biz_date`, ordering by `biz_date, created_at, id`.
- **Capacitor plugin goes stale or ships non-16 KB-aligned libraries.** Pin versions, check alignment at build, fall back to `@microbit/capacitor-sqlite-vanilla` [74] (young, single-app track record; bundled SQLite ≥ 3.35 so the client SQL still runs); the schema and TypeScript are plugin-agnostic and the migrations use whichever plugin's upgrade mechanism is pinned.
- **Sideload friction / 2027 developer verification** [34]. Register the package name in 2026; Play internal-testing track as plan B.
- **WhatsApp restricting the number** [48]. Every send is a manual tap; no automated blasts.
- **Shared phone, nosy helper.** PIN lock, staff role without write-off/export/revoke, staff review cap and "entries by staff" view, revoke-with-wipe, device list visible to the owner. With SQLCipher off in v1 the file itself is readable on a rooted phone; stated in the notice and the briefing.
- **Developer bus factor, lost keystore or login.** Shop owns the accounts; two keystore copies; export works without the server; owner recovery codes (and the optional Access owner page) plus the APK copy on Drive mean a replacement phone never needs the developer; handover page in the repo.
- **DPDP from May 2027** [55]. Notice, erasure action and processor agreement ship in v1.
- **Scope creep toward a Khatabook clone.** The out-of-scope list lives in the README.

---

## Out of scope for v1

Billing/invoices and item-level sales; stock; supplier ("I owe") ledger; interest or late fees; automated reminders (WhatsApp Business API templates [48], DLT-registered SMS [57]); UPI reconciliation or SIM binding (only a `upi://pay` link in the statement); customer-facing portal or login (Firebase phone auth would be the route [28]); Google Sign-In and passkeys; multiple shops; iOS; a web dashboard beyond the two tiny pages behind Cloudflare Access (the optional owner pair-code page and a developer admin page); bill photos; importing Khatabook/OkCredit exports; D1 read replication, Durable Objects, Queues, Workflows, KV, Browser Rendering, Email Service; loans; ads; analytics SDKs. All of these fit on top of the append-only entry model without schema rewrites.

---

## Assumptions

1. One shop, one Cloudflare account, 1-3 Android phones, a few hundred customers, 50-300 entries a day.
2. The shopkeeper's phones run Android 7 (API 24) or newer, have WhatsApp (Business) and an SMS app, and have at least intermittent mobile data.
3. Currency is INR; the business day is the IST calendar day; amounts are whole rupees or two-decimal paise.
4. The developer is comfortable with HTML/CSS/JS and will learn TypeScript basics, `wrangler`, and enough Android Studio to build a signed APK.
5. 1 USD ≈ ₹86; vendor prices as read on 2026-10-12 and may change.
6. Cloudflare free-plan resources are not paused or deleted for inactivity (likely: no inactivity policy is documented anywhere in the D1 docs, and the D1 FAQ describes only the single-Durable-Object architecture [7]).
7. The shop accepts that the mirror copy is stored in an APAC data centre outside India [6].
8. `PRAGMA defer_foreign_keys = on` holds inside D1 `db.batch()` (documented for transactions [70]; to confirm in week 3; the customer-before-entry statement order is sufficient on its own if it does not).
9. The `@capacitor-community/sqlite` release pinned at setup ships 16 KB-aligned libraries (to verify at build) and bundles SQLite ≥ 3.35 (asserted at startup).
10. The shopkeeper will keep the paper register alongside the app for the first month.

---

## Open questions for the shopkeeper

1. How many phones, and who holds them? Should helpers be able to post payments, or only credit?
2. Do you want a short customer code printed on the paper book (`C-0042`), or is name + phone enough day to day?
3. Tamil or English as the default screen language, and which should statements default to? (Both are per-statement toggles; this only sets the default.)
4. What is your UPI ID for the statement's "pay here" line, and do you want a QR image too?
5. Above what amount should the app ask "are you sure?" (we assume ₹10,000)?
6. Do you ever charge interest or a late fee? (Not planned; it changes the ledger if yes.)
7. How many customers roughly, and how far back should opening balances go when we migrate from the paper book?
8. Will you keep the paper book alongside the app for the first month? (This decides Free vs the $5/month Paid plan at go-live.)
9. Is a payment method acceptable on the Cloudflare account to enable R2 nightly dumps and the optional email-OTP owner page (Zero Trust Free also asks for one; it is not charged), or should backups stay as Drive exports and recovery rely on the printed codes alone?
10. Do you want to publish on Google Play (US$25 once, your Gmail as tester) or keep installing the APK by hand?
11. Which Google account will own the Cloudflare account and the code repository? (It needs 2-Step Verification and a Google payments profile if the free limited-distribution Play account is used.)
12. Do any customers share one phone number, and should their accounts be linked or kept separate?
13. Above what amount should a helper's payment or correction need the shop's approval PIN, a PIN you set that is separate from each phone's unlock PIN (we assume ₹2,000)? How long may the app stay unlocked in the background (2, 10 or 30 minutes)?
14. Where will you keep the printed recovery codes (we suggest the cash box), and who else may know?

---

## Sources

1. Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
2. Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
3. Cloudflare D1 limits: https://developers.cloudflare.com/d1/platform/limits/
4. Cloudflare D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
5. D1 Time Travel: https://developers.cloudflare.com/d1/reference/time-travel/
6. D1 data location / location hints: https://developers.cloudflare.com/d1/configuration/data-location/
7. D1 FAQ: each database is backed by a single Durable Object; no inactivity policy is documented anywhere in the D1 docs: https://developers.cloudflare.com/d1/reference/faq/
8. D1 import/export: https://developers.cloudflare.com/d1/best-practices/import-export-data/
9. D1 Worker API (`batch()` transactions): https://developers.cloudflare.com/d1/worker-api/d1-database/
10. D1 migrations: https://developers.cloudflare.com/d1/reference/migrations/
11. D1 local development: https://developers.cloudflare.com/d1/best-practices/local-development/
12. Workers Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
13. R2 pricing: https://developers.cloudflare.com/r2/pricing/
14. R2 checkout prompts for a payment method (third-party, likely): https://eastondev.com/blog/en/posts/dev/20251130-r2-picgo-setup/
15. Workers Rate Limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ and GA note https://developers.cloudflare.com/changelog/2025-09-19-ratelimit-workers-ga/
16. Workers Logs: https://developers.cloudflare.com/workers/observability/logs/workers-logs/ and Observability pricing https://developers.cloudflare.com/observability/pricing/
17. Workers Builds limits and pricing: https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/
18. workers.dev subdomains: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
19. Workers rollbacks: https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/
20. Workers secrets: https://developers.cloudflare.com/workers/configuration/secrets/
21. Hono on Cloudflare Workers: https://hono.dev/docs/getting-started/cloudflare-workers
22. Workers WebCrypto: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
23. Cloudflare network (Indian cities): https://www.cloudflare.com/network/
24. Cloudflare service outage, 12 June 2025: https://blog.cloudflare.com/cloudflare-service-outage-june-12-2025/
25. Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
26. Cloudflare Access One-time PIN: https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/
27. Supabase free-project pausing and pricing: https://supabase.com/docs/guides/platform/free-project-pausing and https://supabase.com/pricing
28. Firebase pricing, Firestore offline, phone-auth limits: https://firebase.google.com/pricing , https://firebase.google.com/docs/firestore/manage-data/enable-offline , https://firebase.google.com/docs/auth/limits
29. Google Play target API level requirements: https://developer.android.com/google/play/requirements/target-sdk
30. Play Console registration: https://support.google.com/googleplay/android-developer/answer/6112435
31. Play 12-tester closed-test requirement: https://support.google.com/googleplay/android-developer/answer/14151465
32. Play internal testing track: https://support.google.com/googleplay/android-developer/answer/9845334
33. Android App Bundles: https://developer.android.com/guide/app-bundle
34. Android developer verification FAQ and limited distribution: https://developer.android.com/developer-verification/guides/faq , https://developer.android.com/developer-verification/guides/limited-distribution
35. Google India enhanced fraud protection pilot: https://blog.google/intl/en-in/products/launching-enhanced-fraud-protection-pilot-in-india/
36. Android 16 KB page sizes: https://developer.android.com/guide/practices/page-sizes
37. Android 16 behaviour changes: https://developer.android.com/about/versions/16/behavior-changes-16
38. Android version distribution (Jan 2026): https://9to5google.com/2026/01/30/android-16-is-on-7-5-of-devices-in-latest-distribution-numbers-update/
39. Capacitor 8: https://capacitorjs.com/docs/updating/plugins/8-0 and https://capacitorjs.com/docs/android/setting-target-sdk
40. @capacitor-community/sqlite: https://github.com/capacitor-community/sqlite
41. Browser storage eviction: https://web.dev/articles/storage-for-the-web
42. Android Keystore and deprecated security-crypto: https://developer.android.com/privacy-and-security/keystore , https://developer.android.com/reference/kotlin/androidx/security/crypto/package-summary.html
43. Android Auto Backup: https://developer.android.com/identity/data/autobackup
44. Stripe idempotent requests: https://docs.stripe.com/api/idempotent_requests
45. android.graphics.pdf.PdfDocument: https://developer.android.com/reference/android/graphics/pdf/PdfDocument
46. Android common intents (share, SMS): https://developer.android.com/guide/components/intents-common
47. WhatsApp click-to-chat links (official help centre: `https://wa.me/<number>?text=<url-encoded>`, full international number without `+`, zeros, brackets or dashes; `wa.me/?text=` with no number opens the contact picker): https://faq.whatsapp.com/5913398998672934
48. WhatsApp Business messaging policy: https://whatsappbusiness.com/policy/
49. Android per-app language preferences: https://developer.android.com/guide/topics/resources/app-languages
50. `Intl.NumberFormat` (MDN; `en-IN` lakh grouping in the WebView's V8/ICU): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat
51. Room 3 releases: https://developer.android.com/jetpack/androidx/releases/room3
52. WorkManager periodic work: https://developer.android.com/guide/background/persistent/getting-started/define-work
53. OkCredit pricing and Play listing: https://okcredit.in/pricing , https://play.google.com/store/apps/details?id=in.okcredit.merchant&hl=en_IN
54. Khatabook Play listing: https://play.google.com/store/apps/details?id=com.vaibhavkalpe.android.khatabook&hl=en_IN
55. DPDP Rules 2025 notification summary: https://ssrana.in/articles/meity-notifies-final-digital-personal-data-protection-rules-2025/
56. NPCI UPI linking specification (mirror): https://www.labnol.org/files/linking.pdf
57. TRAI DLT registration (Plivo guide): https://support.plivo.com/hc/en-us/articles/360046769131
58. MSG91 and Twilio India SMS pricing: https://msg91.com/in/pricing/sms , https://www.twilio.com/en-us/sms/pricing/in
59. Google Identity Platform phone-auth SMS pricing: https://cloud.google.com/identity-platform/pricing
60. Google ID token verification and legacy sign-in migration: https://developers.google.com/identity/gsi/web/guides/verify-google-id-token , https://developer.android.com/identity/sign-in/legacy-gsi-migration
61. Cloudflare Zero Trust free plan (50 users, 2020 announcement) and Zero Trust onboarding (a subscription plan and payment details are required even on Free; "you will not be charged"): https://blog.cloudflare.com/teams-plans and https://developers.cloudflare.com/cloudflare-one/setup/
62. Cloudflare Email Service pricing: https://developers.cloudflare.com/email-service/platform/pricing/
63. Cloudflare Browser Rendering limits: https://developers.cloudflare.com/browser-rendering/platform/limits/
64. Drizzle ORM with D1: https://orm.drizzle.team/docs/connect-cloudflare-d1
65. Flutter minSdk note and Expo SDK versions: https://flutter.googlesource.com/mirrors/flutter/+/HEAD/docs/platforms/android/Update-Android-MinSdk-Version.md , https://docs.expo.dev/versions/latest/
66. Android 8 "Install unknown apps" per-source permission: https://android-developers.googleblog.com/2017/08/making-it-safer-to-get-apps-on-android-o.html
67. Google Play Protect: https://support.google.com/googleplay/answer/2812853
68. Appwrite, AWS free plan, PocketBase: https://appwrite.io/pricing , https://aws.amazon.com/free/ , https://pocketbase.io/docs/going-to-production/
69. Workers Smart Placement (available on all Workers plans): https://developers.cloudflare.com/workers/configuration/smart-placement/
70. D1 foreign keys (enforced by default; `PRAGMA defer_foreign_keys`): https://developers.cloudflare.com/d1/sql-api/foreign-keys/
71. Ionic/Capacitor CORS troubleshooting (WebView origin, CapacitorHttp): https://ionicframework.com/docs/troubleshooting/cors
72. Vite blog (Vite 7 on 24 Jun 2025, Vite 8 on 12 Mar 2026, 8.1 on 23 Jun 2026): https://vite.dev/blog
73. TypeScript 7.0 (native compiler) announcement: https://devblogs.microsoft.com/typescript/?p=5246
74. `@microbit/capacitor-sqlite-vanilla` (microbit-foundation; androidx sqlite-bundled; no encryption, no web, single-app track record; a single npm release, 0.1.0 of 18 Feb 2026, peer `@capacitor/core >= 8.0.0`; the README still calls it a "Capacitor 7 plugin"): https://github.com/microbit-foundation/capacitor-sqlite-vanilla and https://www.npmjs.com/package/@microbit/capacitor-sqlite-vanilla
75. D1 free-tier daily read/write limit enforcement from 1 September 2026 (queries error until 00:00 UTC; account emailed): https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/
76. TypeScript 6.0 announcement (23 March 2026; "we intend for it to be the last release based on the current JavaScript codebase"): https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/
