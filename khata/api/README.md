# Kadan Kanakku API (Cloudflare Worker + D1)

Backup and multi-device sync mirror for the Kadan Kanakku khata app. The phone's SQLite is the ledger of record;
this Worker stores a mirror of it in D1 and is the single ordering authority (the append-only `changelog.seq`).

- Contract: [`../shared/protocol.ts`](../shared/protocol.ts) (routes, bodies, rejection reasons, constants).
- Schema: [`migrations/0001_init.sql`](migrations/0001_init.sql), v2 accounts: [`migrations/0002_accounts.sql`](migrations/0002_accounts.sql).
- Design background: `docs/GROCERY_DEBT_APP_PLAN.md` ("API & sync protocol", "Auth & security", "Backups & DR").

Stack: Hono 4, D1, TypeScript. Tests run in the real Workers runtime through `@cloudflare/vitest-plugin`.
Everything runs on the **Workers Free plan** (10 ms CPU per request, D1, static assets): see "Accounts (v2)" below
for how password login fits in that budget.

## Layout

```
src/index.ts            app: CORS, PEPPER guard, body limit, JSON 404, onError
src/env.ts              bindings and context types
src/lib/auth.ts         session middleware: Bearer token or web cookie + X-KK-Client (+ ownerOnly)
src/lib/password.ts     client_key verifier (HMAC with PEPPER), fake salts, input parsing
src/lib/google.ts       Google ID token verification (RS256 via WebCrypto, cached JWKS)
src/lib/session.ts      new-device batch tail shared by /pair and logins, session cookie
src/lib/throttle.ts     global per-UTC-day failure counters (pair_failures, auth_failures)
src/lib/codes.ts        pairing-code minting, customer-code blocks
src/lib/crypto.ts       sha256, constant-time compare, tokens, 8-digit and recovery codes
src/lib/validate.ts     push row validation (BAD_ROW / BAD_AMOUNT / FUTURE_DATE)
src/lib/rows.ts         row mappers and canonical comparison
src/lib/time.ts         ISO / UTC-day / IST business date helpers
src/routes/public.ts    /health, /setup, /pair (+ pair throttle)
src/routes/auth.ts      /config, /auth/prelogin, /auth/login, /auth/google, /auth/logout
src/routes/users.ts     /users (owner user management), /users/:id/password
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

Notes:

- `PEPPER` is mixed into every stored token and code hash. Without it every route except `/v1/health` answers
  `500 {"error":"misconfigured"}`. Changing it logs out every phone and invalidates every unused code.
- `SETUP_KEY` enables `POST /v1/setup` (bootstrap and last-resort recovery: it reuses the existing shop and mints
  a new owner code). Without the secret the route answers 404. To disable it after handover:
  `npx wrangler secret delete SETUP_KEY`.
- Vars in `wrangler.jsonc`: `DAILY_REQUEST_CAP` (per device per UTC day, default 5000), `PAIR_THROTTLE_AFTER`
  (wrong `/pair` guesses per UTC day before throttling, default 20), `AUTH_THROTTLE_AFTER` (wrong password logins per
  UTC day, default 100) and `GOOGLE_CLIENT_IDS` (empty = Google sign-in off; see "Accounts (v2)").
- Migrations: `0002_accounts.sql` is additive (new tables, nullable columns on `devices`); apply it before deploying
  the v2 Worker (`deploy-server.sh` applies all pending migrations).

## Behaviour summary

| Route (`/v1`) | Who | Notes |
|---|---|---|
| `GET /health` | anyone | `SELECT 1`, `{ok:true}` |
| `POST /setup` | `X-Setup-Key` | constant-time key check; creates the shop if none, else reuses the oldest; owner code, kind `setup`, 24 h |
| `POST /pair` | anyone, throttled | claims the code atomically and, in the same transaction, creates the device, revokes `previous_device_id` (same shop, role not above the claimed code's; its unused codes move to the new device), raises the customer-code sequence to `max_local_code` (at most 1,000,000) and issues a 50-code block |
| `GET /me` | any device | |
| `POST /devices/pair-code` | owner | 8 uniformly random digits, kind `pair`, 10 min |
| `POST /devices/recovery-codes` | owner | 3-5 codes `XXXX-XXXX-XXXX-XXXX` (base32 without I/L/O/U), no expiry, replaces unused ones |
| `POST /devices/code-block` | any device | next 50 customer codes (raised to `max_local_code` first, at most 1,000,000) |
| `GET /devices`, `POST /devices/:id/revoke` | owner | `{wipe}` makes the revoked phone's next request answer `401 {error:'revoked', wipe:true}`; the unused pair and recovery codes it issued are deleted in the same transaction (re-issue recovery codes if it minted the printed ones) |
| `PUT /shop` | owner | name 1-80, UPI id or null, lang ta/en |
| `POST /customers/:id/erase` | owner | DPDP erasure, terminal, one change-log row |
| `POST /sync/push` | any device | at most 20 rows, see protocol.ts |
| `GET /sync/pull?since&limit` | any device | at most 500 changes per page, own rows skipped except on `since=0` |
| `GET /export` | owner | streamed `ExportFile` JSON attachment |
| `GET /config` | anyone | `{google_client_id, auth:{password:true}, version}`: what the login screen offers |
| `POST /auth/prelogin` | anyone, limited | `{salt, iterations}`; a deterministic fake salt for unknown/disabled users |
| `POST /auth/login` | anyone, limited + throttled | `{username, client_key, device_name, client, ...}` → `LoginResponse` (a `PairResponse` + `user`); web: cookie, `token: null` |
| `POST /auth/google` | anyone, limited | Google ID token → `LoginResponse`; 404 when `GOOGLE_CLIENT_IDS` is empty |
| `POST /auth/logout` | any session | revokes the calling device, clears the cookie |
| `GET /users`, `POST /users`, `PUT /users/:id` | owner | user management; `link_me` attaches the calling (paired) owner phone to the new owner user |
| `PUT /users/:id/password` | owner (anyone) / user (self, with `current_client_key`) | revokes that user's (other) devices |

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
recovery code. **Every login creates a `devices` row like `/pair` does** (own token, own customer-code block,
authorship, pull skipping its own rows, revoke-with-wipe), so `/sync/*` and the phones' sync engine are unchanged.
Existing paired phones keep `user_id = NULL` and work unchanged. Types and doc comments: `shared/protocol.ts`
("v2: accounts").

**Users.** `users` (one shop): `username` (lower case, 3-32 of `a-z 0-9 . _ -`), `display_name`, `role`
owner/staff, password material, optional pre-registered `google_email` / linked `google_sub`, `disabled_at`.
No self sign-up, no email, no SMS. The owner creates users from an owner device. A v1 paired owner phone creates its
own login with `POST /users {role:'owner', link_me:true, ...}` (no re-pairing). Rules: the last enabled owner user
cannot be demoted or disabled (checked inside the `UPDATE`, so two concurrent demotions cannot both win), nobody
changes their own role or disables themselves, disabling revokes all of that user's devices (and the unused codes
they minted) in the same transaction, a role change is applied to the user's live devices, a new `google_email`
unlinks the old Google account.

### Passwords: client-side key stretching (why it fits Workers Free)

A server-side password hash at OWASP strength costs 90-250 ms of CPU (PBKDF2 600k ≈ 90 ms, argon2id ≈ 200 ms), far
over the Free plan's 10 ms. So the cost moves to the client, as Bitwarden does:

```
client:  GET salt+iterations   POST /auth/prelogin {username}            -> {salt, iterations}
         client_key = PBKDF2-HMAC-SHA256(NFC(password), salt, iterations (600,000), 32 bytes)   // WebCrypto
         POST /auth/login {username, client_key (base64url), device_name, client}
server:  verifier = HMAC-SHA256(PEPPER, "kk-pw-verifier-v1:" || client_key)   // ~20 µs
         constant-time compare with users.pw_verifier
```

- The password never leaves the device; the server never runs PBKDF2. Salts are 16 random bytes chosen by the client
  when a password is set (`POST /users`, `PUT /users/:id/password`); iterations 300,000-2,000,000 (default 600,000).
- A stolen D1 copy alone is useless (the verifier is keyed with the `PEPPER` secret). With the PEPPER too, each guess
  still costs a full 600k PBKDF2, as with a server-side hash. `client_key` is password-equivalent on the wire, so
  logins only travel over TLS and the value is never stored.
- **No user enumeration.** `prelogin` answers unknown, disabled and password-less users with
  `HMAC(PEPPER, 'salt:' + username)[0..16]` and 600,000: same status, shape and work (one SELECT + one HMAC on both
  paths). `login` answers an unknown user and a wrong password with the same `403 {error:'invalid_login'}`, and
  lockouts apply to unknown usernames too (`login_throttle`). (A user whose iteration count differs from the default
  is distinguishable by it; clients should use the default.)

**Lockout and throttles** (all three layers, cheapest first):

1. `AUTH_LIMITER` (Workers Rate Limiting): 20 requests / 60 s per client IP for each of prelogin, login, google.
2. Shop-wide: wrong password logins per UTC day in `auth_failures`, like `pair_failures`. After
   `AUTH_THROTTLE_AFTER` (default 100) only one attempt per 30 s is allowed (`429 {error:'throttled'}`); a successful
   login gives its attempt back. Malformed requests are rejected before any counter moves.
3. Per username: each attempt is recorded as a failure atomically before the check (so a burst cannot slip past);
   from the 5th consecutive failure the username is locked for 30 s, doubling to at most 15 min
   (`429 {error:'locked', retry_after}` + `Retry-After`). Never permanent; a successful login resets it.

### Sessions, cookies, CSRF

- `client: 'android'` (and v1 paired phones): the token comes back in the body and is sent as `Authorization: Bearer`.
- `client: 'web'`: the body has `token: null`; the server sets
  `kk_session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/v1; Max-Age=2592000`, and the device row expires after
  30 days (`devices.expires_at`). Every cookie-authenticated request must carry `X-KK-Client: web` (any method),
  else `403 {error:'csrf'}`. SameSite=Strict is the first layer; a cross-site page cannot add the header without a
  CORS preflight this Worker never grants with credentials. The web app is same-origin, so no CORS is involved.
- Transport binding: a web session token is never accepted as a Bearer token and an app token never as a cookie.
- `POST /auth/logout` revokes the calling device (and unused 8-digit codes it minted) and clears the cookie. It does
  not send `Clear-Site-Data` (that would delete an unsynced browser outbox); the web client clears its own storage.
- Login sessions show up in `GET /devices` with `client` and `user_id`; the owner revokes them as any phone.

### Google sign-in (optional, off by default)

The Worker verifies Google ID tokens itself (RS256 with WebCrypto against
`https://www.googleapis.com/oauth2/v3/certs`, cached in memory and in the Cache API for the response's `max-age`, one
forced refetch per minute at most when an unknown `kid` appears), checks `iss` (`accounts.google.com` or
`https://accounts.google.com`), `aud` ∈ `GOOGLE_CLIENT_IDS`, `exp`/`iat` with 5 min skew and `email_verified`. It signs
in only a non-disabled user whose `google_sub` is already linked, or whose `google_email` (case-insensitive) the owner
pre-registered and who is not linked yet (then it links the `sub`). It never creates users; a second Google account
with the same address is refused once one is linked. Errors: `403 invalid_token` (with the failed check in `message`),
`403 not_linked`, `503 unavailable` (Google keys unreachable). No nonce is used in this build: GIS tokens are bound
to our client id (`aud`) and only sent same-origin over TLS.

To switch it on (all free, in the **shop's** Google account):

1. <https://console.cloud.google.com> → create a project (e.g. "Kadan Kanakku") → *APIs & Services* →
   *OAuth consent screen*: External, app name, support email, scopes `openid email profile`; publish it
   ("In production"; no verification is needed for these scopes).
2. *Credentials* → *Create credentials* → *OAuth client ID* → **Web application**. Authorised JavaScript origins:
   the Worker's address, e.g. `https://kadan-kanakku-api.<subdomain>.workers.dev` (and a custom domain if you add one;
   `http://localhost:8787` for local testing). No redirect URI is needed (the GIS button uses a JS callback).
3. Put the client id in `wrangler.jsonc` → `vars.GOOGLE_CLIENT_IDS` (comma-separated; the **first** must be the web
   client id, later ones e.g. a future Android client id) and deploy. `GET /v1/config` then returns it and the web
   login shows the Google button.
4. For each person, the owner sets their Google address on the user (`google_email`); their first Google sign-in links
   the account.

Android Google sign-in is not in this build (it needs the shop's Android OAuth client with the signing SHA-1s and a
native Credential Manager plugin); the server side already accepts any audience listed in `GOOGLE_CLIENT_IDS`.

### Free-plan CPU (measured)

`test/cpu.test.ts` measures the new CPU work inside workerd (local, Xeon 2.1 GHz; production may differ by ~2×) and
fails if it grows:

| Work | CPU |
|---|---|
| Password check: HMAC-SHA256 verifier + constant-time compare | ~20 µs |
| Fake salt for an unknown username (prelogin) | ~6 µs |
| Google ID token: RS256 verify + claim checks, key cached | ~60-85 µs |
| JWKS refresh: importing Google's 2 RSA keys (fetch/Cache API are I/O, not CPU) | < 0.1 ms |
| *For comparison:* PBKDF2-SHA256 600k (what the client now pays) | ~90 ms |

A whole prelogin + login round trip, including the local D1 batch I/O, took ~18 ms wall time; the CPU part is a
small fraction of a millisecond plus JSON and D1 bindings, so every route stays far below 10 ms. Each login costs one
D1 batch of at most 9 statements (Free allows 50 per request).

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
