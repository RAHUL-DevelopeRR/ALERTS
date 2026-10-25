# Kadan Kanakku API (Cloudflare Worker + D1)

Backup and multi-device sync mirror for the Kadan Kanakku khata app. The phone's SQLite is the ledger of record;
this Worker stores a mirror of it in D1 and is the single ordering authority (the append-only `changelog.seq`).

- Contract: [`../shared/protocol.ts`](../shared/protocol.ts) (routes, bodies, rejection reasons, constants).
- Schema: [`migrations/0001_init.sql`](migrations/0001_init.sql), v2 accounts: [`migrations/0002_accounts.sql`](migrations/0002_accounts.sql),
  hardening (step-up, audit, source-keyed lockout, nonces): [`migrations/0003_accounts_hardening.sql`](migrations/0003_accounts_hardening.sql).
- Design background: `docs/GROCERY_DEBT_APP_PLAN.md` ("API & sync protocol", "Auth & security", "Backups & DR").

Stack: Hono 4, D1, TypeScript. Tests run in the real Workers runtime through `@cloudflare/vitest-plugin`.
Everything runs on the **Workers Free plan** (10 ms CPU per request, D1, static assets): see "Accounts (v2)" below
for how password login fits in that budget.

## Layout

```
src/index.ts            app: CORS, PEPPER guard, body limit, JSON 404, onError
src/env.ts              bindings and context types
src/lib/auth.ts         session middleware: Bearer token or web cookie + X-KK-Client (+ ownerOnly, noWeb)
src/lib/stepup.ts       step-up for owner-power routes: X-KK-Stepup (client_key) / X-KK-Recovery, 5-minute window
src/lib/lockout.ts      login backoff keyed on (username, source /24 or /48), known-device values
src/lib/audit.ts        auth_events: audit rows batched with the action, GET /auth/events
src/lib/nonce.ts        single-use HMAC nonces for Google sign-in (POST /auth/nonce, used_nonces)
src/lib/password.ts     client_key verifier (HMAC with PEPPER), fake salts, input parsing (600k only, Google domains)
src/lib/google.ts       Google ID token verification (RS256 via WebCrypto, cached JWKS, nonce claim)
src/lib/session.ts      new-device batch tail shared by /pair and logins (takeover rules), session + known cookies
src/lib/throttle.ts     global per-UTC-day failure counters (pair_failures, auth_failures)
src/lib/codes.ts        pairing-code minting, customer-code blocks
src/lib/crypto.ts       sha256, constant-time compare, tokens, 8-digit and recovery codes
src/lib/validate.ts     push row validation (BAD_ROW / BAD_AMOUNT / FUTURE_DATE)
src/lib/rows.ts         row mappers and canonical comparison
src/lib/time.ts         ISO / UTC-day / IST business date helpers
src/routes/public.ts    /health, /setup, /pair (+ pair throttle)
src/routes/auth.ts      /config, /auth/prelogin, /auth/nonce, /auth/login, /auth/google, /auth/logout, /auth/events
src/routes/users.ts     /users (owner user management, step-up), /users/:id/password
src/routes/devices.ts   /me, /devices/*
src/routes/shop.ts      PUT /shop, POST /customers/:id/erase
src/routes/sync.ts      /sync/push, /sync/pull
src/routes/export.ts    /export (streamed)
test/*.test.ts          integration tests (SELF.fetch against the Worker)
web/_headers            security headers of the web app (copied into ../app/dist-web by scripts/prepare-assets.mjs)
scripts/prepare-assets.mjs  wrangler "build" step: writes dist-web/_headers (+ placeholder index.html if unbuilt)
```

## Local development

```bash
npm install                      # .npmrc sets legacy-peer-deps
npm test                         # vitest in workerd; every test starts from an empty D1
npm run typecheck                # tsc --noEmit -p .

# run the Worker locally against a local D1
printf 'PEPPER=dev-pepper\nSETUP_KEY=dev-setup-key\n' > .dev.vars     # gitignored
npx wrangler d1 migrations apply khata --local
npx wrangler dev --local --port 8787

curl -s localhost:8787/v1/health
curl -s -X POST localhost:8787/v1/setup -H 'X-Setup-Key: dev-setup-key' \
     -H 'Content-Type: application/json' -d '{"shop_name":"Murugan Stores"}'
curl -s -X POST localhost:8787/v1/pair -H 'Content-Type: application/json' \
     -d '{"code":"<8 digits from setup>","device_name":"Owner phone"}'
```

`wrangler dev` also serves the web app at <http://localhost:8787/> from `../app/dist-web` (a placeholder page until
`cd ../app && npx vite build --mode web` has run; the wrangler build step writes `_headers` and the placeholder).
Browsers accept the `Secure` session cookie on `http://localhost`.

## Deploying to the shop's own Cloudflare account

Use the shop's Cloudflare account (created with the shop's email; the developer is a member).

**Everything at once:** `khata/GO-LIVE.md` (`./khata/tools/go-live.sh`: this deploy, the owner's login through
`tools/create-owner.mjs`, and the APK with the server built in).

**One command (recommended).** From the repository root, after signing in once with `cd khata/api && npm ci && npx wrangler login`
(or with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set; token permissions: Workers Scripts Edit, D1 Edit,
Account Settings Read):

```bash
./khata/tools/deploy-server.sh            # safe to re-run; add --rotate-setup-key to issue a new setup key
```

It creates the `khata` D1 database in APAC if missing, writes its id into `wrangler.jsonc`, applies migrations,
generates `PEPPER` and `SETUP_KEY` once (saved to `khata/api/.deploy-secrets`, git-ignored, mode 600), deploys with
those secrets, checks `/v1/health` and that `/v1/me` answers 401, and prints the server address and setup key to
type into the owner's phone (Settings → Server copy → First-time setup). It never replaces an existing `PEPPER`.
The account needs a workers.dev subdomain: open the dashboard's Workers & Pages page once to pick one.

**Manual steps** (what the script does):

```bash
npx wrangler login
npx wrangler d1 create khata --location=apac        # copy database_id into wrangler.jsonc
npx wrangler d1 migrations apply khata --remote
openssl rand -base64 32 | npx wrangler secret put PEPPER       # required; never change it later
openssl rand -base64 24 | tee /dev/stderr | npx wrangler secret put SETUP_KEY   # optional; keep it offline
npx wrangler deploy

# mint the first owner pairing code (valid 24 h), relay it to the owner by phone/WhatsApp
curl -s -X POST https://kadan-kanakku-api.<subdomain>.workers.dev/v1/setup \
     -H 'X-Setup-Key: <SETUP_KEY>' -H 'Content-Type: application/json' -d '{"shop_name":"Murugan Stores"}'
```

Then, from the owner's phone: Settings, Devices, "Recovery codes" (print them and keep them in the cash box).

**Several counters (2.3.0).** First-time setup on the owner's phone (server address + setup key) now also asks for
the owner's user id and password and creates that login in the same step. The owner adds a user for each employee
(Settings → Users). Build the APK with the server address inside
(`SHOP_SERVER_URL=https://… ./khata/tools/build-release-apk.sh`): the other phones then choose **Sign in to my shop**
on first launch and type only their user id and password. Pairing codes still work as a fallback.

**Fast sync load.** A phone pushes a save 2 s after it is made and, while the app is open and in use, asks
`GET /v1/sync/pull` for other phones' rows every 20 s (every minute after 5 minutes with no touch, no save and
nothing new). An empty pull is three indexed reads in one batch plus the auth middleware's device-row update. A busy
counter phone left open day and night makes about 4,000 requests (4,000 D1 row writes for the device row), so three
phones stay around 12,000 of the 100,000 requests and 100,000 row writes Workers Free gives per day. The Home "Sync"
button (2.3.1) is one push (if anything waits) plus one pull per tap.

Workers Free, per account and UTC day (checked against Cloudflare's docs, October 2026): 100,000 Worker requests
(error 1027 past it), 10 ms CPU per request, 50 subrequests / D1 queries per request (a `db.batch()` counts once);
D1: 5 million rows read and 100,000 rows written per day (an index on a written column adds a written row),
500 MB per database, 5 GB per account. Requests for static assets (the web app) are free and not counted; only
`/v1/*` runs the Worker (`run_worker_first`). The daily counts reset at 00:00 UTC (05:30 IST).

Notes:

- `PEPPER` is mixed into every stored token and code hash. Without it every route except `/v1/health` answers
  `500 {"error":"misconfigured"}`. Changing it logs out every phone and invalidates every unused code.
- `SETUP_KEY` enables `POST /v1/setup` (bootstrap and last-resort recovery: it reuses the existing shop and mints
  a new owner code). Without the secret the route answers 404. To disable it after handover:
  `npx wrangler secret delete SETUP_KEY`.
- Vars in `wrangler.jsonc`: `DAILY_REQUEST_CAP` (per device per UTC day, default 10000; with fast sync a busy
  counter phone left open day and night makes about 4,000 at most), `PAIR_THROTTLE_AFTER`
  (wrong `/pair` guesses per UTC day before throttling, default 20), `AUTH_THROTTLE_AFTER` (wrong password logins
  from unknown sources per UTC day, default 100), `GOOGLE_CLIENT_IDS` (web OAuth client ids; empty = Google sign-in
  off on the web), `GOOGLE_ANDROID_CLIENT_IDS` (Android client ids; empty = Android Google logins answer 404) and
  `GOOGLE_HD` (optional Workspace domain allowed for `google_email` besides gmail.com). See "Accounts (v2)".
- Migrations: `0002_accounts.sql` and `0003_accounts_hardening.sql` are additive (new tables, nullable columns);
  apply them before deploying the v2 Worker (`deploy-server.sh` applies all pending migrations). Never edit an
  applied migration: D1 applies by file name and will not re-run it.

## Behaviour summary

| Route (`/v1`) | Who | Notes |
|---|---|---|
| `GET /health` | anyone | `SELECT 1`, `{ok:true}` |
| `POST /setup` | `X-Setup-Key` | constant-time key check; creates the shop if none, else reuses the oldest; owner code, kind `setup`, 24 h |
| `POST /pair` | anyone, throttled | claims the code atomically and, in the same transaction, creates the device, revokes `previous_device_id` (same shop, role not above the claimed code's; its unused codes move to the new device), raises the customer-code sequence to `max_local_code` (at most 1,000,000) and issues a 50-code block |
| `GET /me` | any device | |
| `POST /devices/pair-code` | owner, step-up, not web | 8 uniformly random digits, kind `pair`, 10 min |
| `POST /devices/recovery-codes` | owner, step-up, not web | 3-5 codes `XXXX-XXXX-XXXX-XXXX` (base32 without I/L/O/U), no expiry, replaces unused ones |
| `POST /devices/code-block` | any device | next 50 customer codes (raised to `max_local_code` first, at most 1,000,000) |
| `GET /devices` | owner | |
| `POST /devices/:id/revoke` | owner, step-up, not web | `{wipe}` makes the revoked phone's next request answer `401 {error:'revoked', wipe:true}`; the unused pair and recovery codes it issued are deleted in the same transaction (re-issue recovery codes if it minted the printed ones) |
| `PUT /shop` | owner; step-up when `upi_id` changes | name 1-80, UPI id or null, lang ta/en; a UPI change is audited (`shop.update`) |
| `POST /customers/:id/erase` | owner, step-up | DPDP erasure, terminal, one change-log row, audited (`customer.erase`) |
| `POST /sync/push` | any device | at most 20 rows, see protocol.ts |
| `GET /sync/pull?since&limit` | any device | at most 500 changes per page, own rows skipped except on `since=0` |
| `GET /export` | owner | streamed `ExportFile` JSON attachment |
| `GET /config` | anyone | `{google_client_id, auth:{password:true}, version}`: what the login screen offers |
| `POST /auth/prelogin` | anyone, limited | `{salt, iterations: 600000}`; a deterministic fake salt for unknown/disabled users, the same count for everyone |
| `POST /auth/nonce` | anyone, limited | `{nonce}` for Google sign-in (10 min, single use); 404 while Google is off |
| `POST /auth/login` | anyone, limited + throttled | `{username, client_key, device_name, client, ...}` → `LoginResponse`; lockout per (username, source); web: cookie, `token: null`, `code_block: null`; staff on the web: `403 web_owner_only` |
| `POST /auth/google` | anyone, limited | Google ID token (with nonce) → `LoginResponse`; audience list by client kind; 404 when that list is empty |
| `POST /auth/logout` | any session | revokes the calling device, clears the cookie |
| `GET /auth/events` | owner (web allowed) | the newest 200 audit rows |
| `GET /users` | owner (web allowed) | |
| `POST /users`, `PUT /users/:id` | owner, step-up, not web | user management; `link_me` attaches the calling (paired) owner phone to the new owner user; `PUT` needs step-up only for `role` / `google_email` / `disabled`; demoting an owner ends their web sessions |
| `PUT /users/:id/password` | self (any session, with `current_client_key`) / owner for others (step-up, not web) | revokes that user's (other) devices and clears their login locks |

**Pair throttle.** Two layers. First, the `PAIR_LIMITER` Workers Rate Limiting binding allows 10 `/pair` requests
per minute per client IP (`CF-Connecting-IP`). Second, 8-digit attempts are counted per UTC day in `pair_failures`
(this Worker serves one shop): the body is validated first (a malformed request never touches the counter), then one
atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING` reserves the attempt. Below `PAIR_THROTTLE_AFTER` every
attempt is allowed; past it one attempt per 30 s (`next_allowed_at`) is, the rest get `429 {error:'throttled'}`. A
successful pairing gives its attempt back, so the count is the day's failures. 16-character recovery codes (80 bits)
are never throttled or counted, so the owner's way back in cannot be blocked. Codes are never burned by failures.
Recovery codes are read the Crockford way (O as 0, I/L as 1).

**Setup.** Each `POST /setup` deletes the shop's earlier unused setup codes and logs a warning; only the newest code
works. Delete the `SETUP_KEY` secret after handover.

**Push.** Auth (1 round trip: `UPDATE devices ... RETURNING` + shop `SELECT`), pre-checks (1 batch of at most 5
indexed `SELECT`s, rows looked up by primary key so another shop's ids are refused), classification in memory, the
write batch (1 transaction: `PRAGMA defer_foreign_keys`, one guarded upsert/insert per row with `RETURNING id`, one
change-log `INSERT ... SELECT ... RETURNING seq` for customers and one for entries, one un-archive `UPDATE` and its
change-log insert), a follow-up batch of at most 3 `SELECT`s only when a write-time guard skipped a row, and at most
one indexed seq lookup for `already` rows: at most 36 statements for a 20-row push (Workers Free allows 50), under 50
bound parameters per statement (`test/review-ledger.test.ts` measures it).

- `ARCHIVE_NONZERO` counts only the entries the chunk actually accepts, each id once.
- Every write re-checks in SQL what the pre-check decided, so concurrent pushes from two phones are classified, never
  failed: a code taken meanwhile answers `CODE_TAKEN`, a reversal that lost the race `ALREADY_REVERSED`, an edit that
  raced an erase `ERASED`, an entry stored meanwhile by a retry `already` (one change-log row per entry, ever).
- Un-archiving is decided at write time: any archived customer that received an accepted entry is un-archived (unless
  this chunk archives it at a zero balance), and an archive whose customer has a non-zero balance once the batch
  commits (another phone's entry landed in between) is undone. These changes are logged with `device_id = 'server'`,
  so every phone pulls them, including the one whose push caused them.
- A write batch that fails on a constraint answers `500 batch_failed` (the client halves its chunk); a single-row chunk
  answers 200 with that row `rejected: BATCH_FAILED`. Any other database error answers `503 unavailable` (retriable).
- Ids must be lower-case UUIDs (`BAD_ROW` otherwise), so a re-cased copy can never be stored twice.

**Pull.** The page and `MAX(seq)` come from one batch (same snapshot). Row content is fetched with seq-range joins
(`changelog JOIN customers/entries ON seq IN (since, last]`, same shop), never with large `IN` lists. Every change
carries the row's current content, in seq order, so a customer always arrives before its entries. The caller's own
rows are skipped, except on `since=0`: a phone that rebuilt its local database with the same token must get its own
customers back before other phones' entries on them.

## Accounts (v2)

Pairing codes keep working exactly as before; accounts add a browser login and a way back in without the printed
recovery code. **Every login creates a `devices` row like `/pair` does** (own token, authorship, pull skipping its
own rows, revoke-with-wipe), so `/sync/*` and the phones' sync engine are unchanged. Existing paired phones keep
`user_id = NULL` and work unchanged. Types and doc comments: `shared/protocol.ts` ("v2: accounts" and
"v2: step-up, web restrictions, audit").

**Users.** `users` (one shop): `username` (lower case, 3-32 of `a-z 0-9 . _ -`), `display_name`, `role`
owner/staff, password material, optional pre-registered `google_email` / linked `google_sub`, `disabled_at`.
No self sign-up, no email, no SMS. The owner creates users from an owner **phone** (never from the web) after a
step-up. A v1 paired owner phone creates its own login with `POST /users {role:'owner', link_me:true, ...}` (no
re-pairing; no step-up while the shop has no users). Rules: the last enabled owner user cannot be demoted or disabled
(checked inside the `UPDATE`, so two concurrent demotions cannot both win), nobody changes their own role or disables
themselves, disabling revokes all of that user's devices (and the unused codes they minted) in the same transaction,
a role change is applied to the user's live devices, a new `google_email` unlinks the old Google account.

### Passwords: client-side key stretching (why it fits Workers Free)

A server-side password hash at OWASP strength costs 90-250 ms of CPU (PBKDF2 600k ≈ 90 ms, argon2id ≈ 200 ms), far
over the Free plan's 10 ms. So the cost moves to the client, as Bitwarden does:

```
client:  POST /auth/prelogin {username}                                  -> {salt, iterations: 600000}
         client_key = PBKDF2-HMAC-SHA256(NFC(password), salt, 600,000, 32 bytes)   // WebCrypto, ~0.1-0.5 s
         POST /auth/login {username, client_key (base64url), device_name, client}
server:  verifier = HMAC-SHA256(PEPPER, "kk-pw-verifier-v1:" || client_key)   // ~20 µs
         constant-time compare with users.pw_verifier
```

- The password never leaves the device; the server never runs PBKDF2. Salts are 16 random bytes chosen by the client
  when a password is set (`POST /users`, `PUT /users/:id/password`).
- **The iteration count is pinned to 600,000** (OWASP's PBKDF2-SHA256 figure). A password set with any other count is
  refused (`400 {message:'iterations'}`), so a weak or hostile client cannot register a cheap verifier, and
  `prelogin` answers 600,000 for everyone, so the count never reveals that a user exists.
- A stolen D1 copy alone is useless (the verifier is keyed with the `PEPPER` secret). With the PEPPER too, each guess
  still costs a full 600k PBKDF2, as with a server-side hash.
- Trade-off to know: `client_key` is **password-equivalent on the wire**. It only travels over TLS, is never stored,
  and an XSS on the login page could capture it, which is why the web app has a strict CSP (below), why web sessions
  cannot do owner-power actions, and why the client kind a login declares is not trusted as a boundary.
- **No user enumeration.** `prelogin` answers unknown, disabled and password-less users with
  `HMAC(PEPPER, 'salt:' + username)[0..16]` and 600,000: same status, shape and work (one SELECT + one HMAC on both
  paths). `login` answers an unknown user and a wrong password with the same `403 {error:'invalid_login'}`, and
  lockouts apply to unknown usernames exactly like real ones (`login_locks`).

### Lockout and throttles

Keyed so that an attacker cannot lock the owner out (the owner's login id may be a public mobile number):

1. `AUTH_LIMITER` (Workers Rate Limiting): 20 requests / 60 s per client IP for each of prelogin, nonce, login, google.
2. **Per (username, source)** in `login_locks`: source = the client's **/24** (IPv4) or **/48** (IPv6) from
   `CF-Connecting-IP`, else `unknown`. Each attempt is recorded as a failure atomically before the check (so a burst
   cannot slip past); from the 5th consecutive failure the pair is locked for 30 s, doubling to at most 15 min
   (`429 {error:'locked', retry_after}` + `Retry-After`). Never permanent; a successful login or an owner password
   reset clears it. An attacker from one network locks only (owner, that network). A locked attempt is answered
   before the verifier and before the shop-wide budget below, so it costs the shop nothing.
3. **Known-device exemption.** Every successful login returns `known_device` =
   `<device id>.<HMAC(PEPPER, 'kk-known-v1:' + device id)>` (the web also gets it as the cookie `kk_known`, one year;
   **not** on a `shared_computer` login, which leaves no persistent cookie at all).
   A later login that carries it (header `X-KK-Known` or the cookie) for the **same user** is exempt from the
   per-source lock and from the shop-wide throttle; it has its own 5-failure backoff keyed on
   (username, `known:<device id>`), so a stolen phone guessing passwords is still throttled. A value for another user
   or with a wrong MAC is simply ignored (the request is an unknown source). So the owner's own phone gets in even
   when an attacker is hammering the owner's username from the owner's own carrier's CGNAT range.
4. Shop-wide: wrong password logins from **unknown sources** per UTC day in `auth_failures`, like `pair_failures`.
   After `AUTH_THROTTLE_AFTER` (default 100) only one such attempt per 30 s is allowed (`429 {error:'throttled'}`);
   a successful login gives its attempt back; known devices are never charged, and neither are attempts the
   per-source lock refused (they never reach the verifier). Malformed requests are rejected before any counter
   moves. So one network can cost the shop at most 5 of the day's 100 per lock period, and a new device elsewhere
   (the owner's new laptop) still gets in.
5. Step-up attempts (`X-KK-Stepup`) use the same backoff, keyed on (username, `stepup:<device id>`).

### Sessions, cookies, CSRF

- `client: 'android'` (and v1 paired phones): the token comes back in the body and is sent as `Authorization: Bearer`.
- `client: 'web'`: the body has `token: null` and **`code_block: null`** (the web never creates customers offline; it
  syncs first and asks `POST /devices/code-block` when it needs codes, so a browser does not burn 50 codes per login).
  The server sets `kk_session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/v1; Max-Age=2592000` and the device
  row expires after 30 days (`devices.expires_at`, enforced server side). With `shared_computer: true` in the login
  body the row expires after **12 h**, the cookie has **no Max-Age** (it dies with the browser) and no `kk_known`
  cookie is set (nothing persistent is left on that PC). Every
  cookie-authenticated request must carry `X-KK-Client: web` (any method), else `403 {error:'csrf'}`.
  SameSite=Strict is the first layer; a cross-site page cannot add the header without a CORS preflight this Worker
  never grants with credentials. The web app is same-origin, so no CORS is involved.
- Transport binding: a web session token is never accepted as a Bearer token and an app token never as a cookie.
- **Web = owner only** in this build: a staff user's web login (password or Google) answers `403 web_owner_only`
  after the credentials were checked (the client shows "web login is for the owner; use the phone app"). Demoting
  an owner to staff (`PUT /users/:id {role:'staff'}`) revokes that user's live web sessions in the same transaction
  (their phone sessions continue as staff); the `user.update` audit row says `web_sessions_ended: true`.
- **What a web session may not do**, whatever its role: `POST /users`, `PUT /users/:id`, resetting another user's
  password, minting pair or recovery codes, revoking devices: all answer `403 web_forbidden`. It may read
  (`GET /users`, `GET /devices`, `GET /auth/events`), sync, and change its own password with the current key.
- The client kind is self-declared (`client` in the body), so it is **not a security boundary**: anyone holding the
  credentials can say `android`. The real gates are step-up (next section) and, for Google, the audience list.
- `POST /auth/logout` revokes the calling device (and unused 8-digit codes it minted) and clears the cookie. It does
  not send `Clear-Site-Data` (that would delete an unsynced browser outbox); the web client clears its own storage.
- Login sessions show up in `GET /devices` with `client` and `user_id`; the owner revokes them as any phone.

### Step-up for owner-power actions

Creating or changing logins and minting or revoking access are **owner-power** actions: `POST /users`,
`PUT /users/:id` (when `role`, `google_email` or `disabled` is present), `PUT /users/:id/password` for another user,
`POST /devices/pair-code`, `POST /devices/recovery-codes`, `POST /devices/:id/revoke`. So are the two money-relevant
shop actions, from any owner session including the web: `PUT /shop` when it changes `upi_id` (where customers are
told to pay) and `POST /customers/:id/erase` (irreversible). Being an owner device is not enough; the caller must
prove, right now, that it is the owner and not someone holding an unlocked phone (or a browser left open):

- `X-KK-Stepup: <client_key>`: the caller's user's **current** password, derived exactly as for login (prelogin +
  PBKDF2) and verified the same way (constant time, 5-failure backoff). The app asks for the password again.
- `X-KK-Recovery: <printed recovery code>`: consumed (it will not pair any more). Works for any device, including a
  legacy paired phone with no user and a Google-only owner (who has no password).
- A proof opens a **5-minute window** (`devices.stepup_until`), so one password prompt covers a batch of actions.
- Without a proof: `403 {error:'stepup_required', stepup:['password','recovery']}` (the list says what this device
  can give); a wrong one: `403 stepup_invalid`, `429 locked` after 5 wrong keys.
- **Bootstrap**: while the shop has **no users at all**, a legacy paired owner phone keeps its v1 powers without
  step-up. That is how the first owner login is created (`link_me`) and the recovery codes get printed before
  accounts exist, and it adds nothing an unlocked v1 phone could not already do. From the first user on, every
  owner-power call needs a proof, on every device.
- The **app PIN is a client-side guard only**: the server cannot see whether it was checked. It protects the phone's
  screen, not the account; step-up is the server's check.

Every owner-power action, every login (success, failure, lockout, refusal), step-up and logout writes a row to
`auth_events` (actor device/user, action, target user/device, a small JSON detail; never credentials; 90-day
retention). `GET /auth/events` (owner, newest 200) lets the owner see, for example, that a login was created from a
phone at 02:00, and then revoke that phone and disable that login.

### Google sign-in (optional, off by default)

The Worker verifies Google ID tokens itself (RS256 with WebCrypto against
`https://www.googleapis.com/oauth2/v3/certs`, cached in memory and in the Cache API for the response's `max-age`, one
forced refetch per minute at most when an unknown `kid` appears), checks `iss` (`accounts.google.com` or
`https://accounts.google.com`), `aud`, `exp`/`iat` with 5 min skew, `email_verified`, the **`nonce`** claim and,
for an address at the `GOOGLE_HD` domain, the **`hd`** claim (Google sets it for Workspace accounts; a consumer
account carrying such an address answers `403 {error:'invalid_token', message:'hd'}`). Hardening:

- **Audience by client kind**: `client:'web'` accepts only `GOOGLE_CLIENT_IDS`, `client:'android'` only
  `GOOGLE_ANDROID_CLIENT_IDS` (empty list = `404`). A web token can never mint an Android bearer token.
- **Nonce**: the client first calls `POST /auth/nonce` and passes the value to Google Identity Services
  (`google.accounts.id.initialize({nonce})`). The ID token then carries it; the server checks its HMAC and 10-minute
  expiry and consumes it in `used_nonces` (`403 {error:'invalid_token', message:'nonce'}` otherwise). A leaked ID
  token cannot be replayed, with any client kind.
- **Linking** is by pre-registered email, then by `sub`: the owner sets `google_email` on the user (step-up, audited
  as `user.update`); the first Google sign-in with that verified address links the account's `sub`, and from then on
  only that `sub` signs in (a second Google account with the same address is refused). The address must be
  **@gmail.com / @googlemail.com** (or the domain in `GOOGLE_HD`): an address at Yahoo, Rediffmail or a lapsed
  domain can be registered as a Google account by someone else, so other domains are refused
  (`400 {message:'google_email_domain'}`). An unlinked address **expires 48 h** after the owner set it
  (`google_email_expires_at` in `GET /users`); setting it again restarts the window. It never creates users.
- Errors: `403 invalid_token` (with the failed check in `message`), `403 not_linked` (no user has that account, or
  the pre-registration expired), `403 web_owner_only` (staff on the web), `503 unavailable` (Google keys unreachable).

To switch it on for the web (all free, in the **shop's** Google account):

1. <https://console.cloud.google.com> → create a project (e.g. "Kadan Kanakku") → *APIs & Services* →
   *OAuth consent screen*: External, app name, support email, scopes `openid email profile`; publish it
   ("In production"; these non-sensitive scopes need no app verification; brand verification is optional and only
   affects whether the consent screen shows the app name and logo or the domain).
2. *Credentials* → *Create credentials* → *OAuth client ID* → **Web application**. Authorised JavaScript origins:
   the Worker's address, e.g. `https://kadan-kanakku-api.<subdomain>.workers.dev` (and a custom domain if you add one;
   `http://localhost:8787` for local testing). No redirect URI is needed (the GIS button uses a JS callback).
3. Put the client id in `wrangler.jsonc` → `vars.GOOGLE_CLIENT_IDS` (comma-separated; the **first** is shown to the
   browser) and deploy. `GET /v1/config` then returns it and the web login shows the Google button.
4. For each person, the owner sets their Gmail address on the user (`google_email`, from the phone, with step-up);
   they sign in with Google within 48 h, which links the account.

Android Google sign-in is **not in this build**: it needs the shop's Android OAuth client (package name + signing
SHA-1s) or a server client id used by Credential Manager, put into `GOOGLE_ANDROID_CLIENT_IDS`, plus a native plugin
in the app. The server side is ready: `client:'android'` logins are accepted only with those audiences.

### What a stolen, unlocked phone can do

Honest limits of this design. Someone holding the owner's **unlocked** phone (no PIN, or the PIN known) can:

- read and edit the ledger and sync those edits (the phone is the ledger of record; every entry is attributable to
  that device and reversible, never deletable);
- keep using that phone's session until the owner revokes it from another owner device (`POST /devices/:id/revoke`,
  with `wipe` to erase the phone's copy on its next request) or, for a phone linked to the owner's own login, logs in
  elsewhere naming it as `previous_device_id` (a legacy paired phone needs its token, `previous_device_token`).

They can **not**, without the owner's password or a printed recovery code: create or change logins, change a Google
address, reset anyone's password, mint pair or recovery codes, revoke other phones, change the shop's UPI id or
erase a customer (`403 stepup_required`), nor read the password (only the stretched `client_key` of a *typed*
password ever exists, in memory). If the thief also has the password, or a recovery code from the cash box, they
are the owner as far as the server can tell; the
`auth_events` list on the other owner devices is then the way to notice (`user.create`, `recovery_codes.mint`, a
`login.ok` from a new device) and undo it (revoke, disable, re-issue recovery codes). The bootstrap exception above
applies only to a shop that has never created a login.

**The password is the credential (pass-the-hash).** The `client_key` sent at login is the stretched password and the
same value is the step-up proof, so whatever captures it on the web login page (an XSS, a malicious browser
extension, a tampered build) holds the owner's password as far as the server can tell: it can log in with
`client:'android'` for a bearer session that never expires, step up with the captured key, mint codes, revoke the
owner's phones (`POST /devices/:id/revoke`, or `previous_device_id` at login for a row of the same user) and change
the UPI id. The web restrictions (`web_forbidden`, owner-only, 30-day expiry) do not apply to that lane. Mitigations
in this build: the strict CSP on the web app (`_headers`: no inline script, no eval, `frame-ancestors 'none'`), the
single-use Google nonce, and the audit trail: every such login is a `login.ok` row with `client: 'android'` and an
unknown `source` (a known device's source reads `known:<device id>`), so the owner's other devices can see it and
revoke it. Not in this build: requiring an existing owner device's approval (or a recovery code) for a NEW owner
android login; that needs a client flow on the login screen and is tracked as a follow-up. Until then: keep the CSP
strict, and treat "someone could run script on the login page" as "someone has the password".

### Free-plan CPU (measured)

`test/cpu.test.ts` measures the new CPU work inside workerd (local, Xeon 2.1 GHz; production may differ by ~2×) and
fails if it grows:

| Work | CPU |
|---|---|
| Password check (login or step-up): HMAC-SHA256 verifier + constant-time compare | ~18-20 µs |
| Fake salt for an unknown username (prelogin) | ~6 µs |
| Nonce: mint / check (HMAC + compare) | ~13 µs / ~17 µs |
| Known-device MAC (plus one indexed D1 SELECT, which is I/O) | ~7 µs |
| Google ID token: RS256 verify + claim checks, key cached | ~60-85 µs |
| JWKS refresh: importing Google's 2 RSA keys (fetch/Cache API are I/O, not CPU) | < 0.1 ms |
| *For comparison:* PBKDF2-SHA256 600k (what the client now pays; 96 ms in Node on the same box) | ~90 ms |

A whole prelogin + login round trip, including the local D1 batch I/O, took ~14-18 ms wall time; the CPU part is a
small fraction of a millisecond plus JSON and D1 bindings, so every route stays far below 10 ms. A login is two D1
batches (5 statements to record the attempt, at most 10 to create the session; plus one indexed SELECT when a
known-device value is sent; Free allows 50 statements per request); a step-up with `X-KK-Stepup` adds two small
batches to the action's own request.

## Web app hosting (Workers static assets)

The same Worker serves the web build of the app (`cd ../app && npx vite build --mode web` → `../app/dist-web`):

```jsonc
"assets": { "directory": "../app/dist-web", "binding": "ASSETS",
            "not_found_handling": "single-page-application", "run_worker_first": ["/v1/*"] }
```

Static asset requests are free and unlimited and do not invoke the Worker; only `/v1/*` runs it. One origin means a
first-party cookie and no CORS. `workers.dev` is on the Public Suffix List, so the cookie is not shared with other
Workers.

**Security headers** come from the documented `_headers` file of Workers static assets (no Worker CPU per page):
`web/_headers` is the source; `scripts/prepare-assets.mjs` copies it into `../app/dist-web/_headers` and runs as the
wrangler `build` command before every `wrangler dev` / `wrangler deploy` (and from `vitest.config.ts`). It also writes
a placeholder `index.html` when the web app has not been built, so the Worker always deploys; it never touches a real
build. Headers on every asset: `Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'
https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style;
connect-src 'self' https://accounts.google.com; frame-src https://accounts.google.com; img-src 'self' data:;
object-src 'none'; base-uri 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `Permissions-Policy: microphone=(self), camera=(), geolocation=(), payment=()`,
`X-Frame-Options: DENY`; hashed `/assets/*` files are cached for a year. If the web build needs more (e.g. a
`worker-src blob:`), edit `web/_headers`. API answers (`/v1/*`) carry `nosniff`, `Referrer-Policy: no-referrer` and
`Cache-Control: no-store` from the Worker.

## Backups and restore runbook

Baseline (no card needed): D1 Time Travel (7 days on Free), the owner's "Download server copy" (`GET /export`),
the phones' own snapshots, and a monthly `npx wrangler d1 export khata --remote --output=khata-YYYY-MM.sql` kept off
Cloudflare (laptop + the shop's Google Drive).

### Restore the server from a `.sql` export

1. Export the current database first: `npx wrangler d1 export khata --remote --output=khata-before-restore.sql`.
2. `npx wrangler d1 create khata2 --location=apac`
3. `npx wrangler d1 execute khata2 --remote --file=khata-YYYY-MM.sql`
   (if it fails with "cannot start a transaction within a transaction", strip `BEGIN TRANSACTION`/`COMMIT`).
4. Check: `npx wrangler d1 execute khata2 --remote --command "SELECT * FROM sqlite_sequence; SELECT * FROM d1_migrations;"`
5. Bump the change-log sequence (delete-then-insert; a plain UPDATE silently does nothing if the row is missing):

   ```sql
   DELETE FROM sqlite_sequence WHERE name = 'changelog';
   INSERT INTO sqlite_sequence (name, seq) SELECT 'changelog', COALESCE(MAX(seq), 0) + 1000000 FROM changelog;
   ```

6. Change the epoch so every phone resets its cursor and re-pushes everything it holds:
   `UPDATE shops SET sync_epoch = '<new uuid>';` (generate one with `node -e "console.log(crypto.randomUUID())"`).
7. Put the new `database_id` (and `database_name`) in `wrangler.jsonc`, then `npx wrangler deploy`.
8. Nothing manual on the phones: the new `sync_epoch` triggers the automatic re-upload; the server answers `already`
   for rows it still has and stores the rest.

### Restore the server by Time Travel

1. Export first (as above).
2. `npx wrangler d1 time-travel restore khata --timestamp=<RFC3339 time before the damage>` (in place; note the undo
   bookmark it prints).
3. Run steps 5 and 6 above against `khata`.

Never test a Time Travel restore on production. The quarterly drill runs the `.sql` runbook against a scratch
database and a test phone, then compares the total outstanding with the owner's phone.

### Other operations

- Revoke a lost phone without another phone: `npx wrangler d1 execute khata --remote --command "UPDATE devices SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = '<device id>'"`.
- Re-admit an owner with no phone and no recovery code: `POST /v1/setup` with the `SETUP_KEY` (mints a new owner code
  for the existing shop).
- Migrations are forward-only and additive; never drop in the same release.
