# Kadan Kanakku API (Cloudflare Worker + D1)

Backup and multi-device sync mirror for the Kadan Kanakku khata app. The phone's SQLite is the ledger of record;
this Worker stores a mirror of it in D1 and is the single ordering authority (the append-only `changelog.seq`).

- Contract: [`../shared/protocol.ts`](../shared/protocol.ts) (routes, bodies, rejection reasons, constants).
- Schema: [`migrations/0001_init.sql`](migrations/0001_init.sql).
- Design background: `docs/GROCERY_DEBT_APP_PLAN.md` ("API & sync protocol", "Auth & security", "Backups & DR").

Stack: Hono 4, D1, TypeScript. Tests run in the real Workers runtime through `@cloudflare/vitest-plugin`.

## Layout

```
src/index.ts            app: CORS, PEPPER guard, body limit, JSON 404, onError
src/env.ts              bindings and context types
src/lib/auth.ts         bearer-token middleware (+ ownerOnly)
src/lib/codes.ts        pairing-code minting, customer-code blocks
src/lib/crypto.ts       sha256, constant-time compare, tokens, 8-digit and recovery codes
src/lib/validate.ts     push row validation (BAD_ROW / BAD_AMOUNT / FUTURE_DATE)
src/lib/rows.ts         row mappers and canonical comparison
src/lib/time.ts         ISO / UTC-day / IST business date helpers
src/routes/public.ts    /health, /setup, /pair (+ pair throttle)
src/routes/devices.ts   /me, /devices/*
src/routes/shop.ts      PUT /shop, POST /customers/:id/erase
src/routes/sync.ts      /sync/push, /sync/pull
src/routes/export.ts    /export (streamed)
test/*.test.ts          integration tests (SELF.fetch against the Worker)
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
- Vars in `wrangler.jsonc`: `DAILY_REQUEST_CAP` (per device per UTC day, default 5000) and `PAIR_THROTTLE_AFTER`
  (wrong `/pair` guesses per UTC day before throttling, default 20).

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
