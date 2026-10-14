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
| `POST /pair` | anyone, throttled | claims the code atomically and, in the same transaction, creates the device, revokes `previous_device_id` (same shop), raises the customer-code sequence to `max_local_code` and issues a 50-code block |
| `GET /me` | any device | |
| `POST /devices/pair-code` | owner | 8 uniformly random digits, kind `pair`, 10 min |
| `POST /devices/recovery-codes` | owner | 3-5 codes `XXXX-XXXX-XXXX-XXXX` (base32 without I/L/O/U), no expiry, replaces unused ones |
| `POST /devices/code-block` | any device | next 50 customer codes (raised to `max_local_code` first) |
| `GET /devices`, `POST /devices/:id/revoke` | owner | `{wipe}` makes the revoked phone's next request answer `401 {error:'revoked', wipe:true}` |
| `PUT /shop` | owner | name 1-80, UPI id or null, lang ta/en |
| `POST /customers/:id/erase` | owner | DPDP erasure, terminal, one change-log row |
| `POST /sync/push` | any device | at most 20 rows, see protocol.ts |
| `GET /sync/pull?since&limit` | any device | at most 500 changes per page, own rows skipped |
| `GET /export` | owner | streamed `ExportFile` JSON attachment |

**Pair throttle.** Failed `/pair` attempts are counted per UTC day in `pair_failures` (this Worker serves one shop).
Once the count reaches `PAIR_THROTTLE_AFTER`, one attempt per 30 s is let through (claimed atomically through
`next_allowed_at`) and the rest get `429 {error:'throttled'}`. Codes are never burned or locked by failures.

**Push budget.** Auth (1 round trip: `UPDATE devices ... RETURNING` + shop `SELECT`), pre-checks (1 batch of at most 5
indexed `SELECT`s), the write batch (1 transaction: `PRAGMA defer_foreign_keys`, row upserts, at most one un-archive
`UPDATE`, change-log inserts of at most 20 rows with 3 + 2 bound parameters per row), and at most one indexed seq
lookup for `already` rows. A 20-row push stays at or below 32 statements (Workers Free allows 50) and under 50 bound parameters per statement
(`test/config.test.ts` measures it). A failing write batch answers `500 batch_failed` (the client halves its chunk);
a single-row chunk answers 200 with that row `rejected: BATCH_FAILED`.

**Pull.** The page and `MAX(seq)` come from one batch (same snapshot). Row content is fetched with seq-range joins
(`changelog JOIN customers/entries ON seq IN (since, last]`), never with large `IN` lists. Every change carries the
row's current content, in seq order, so a customer always arrives before its entries.

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
