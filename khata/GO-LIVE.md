# Going live: the shop's server and APK

One command deploys the server to the shop's own Cloudflare account, creates the owner's login, and builds the APK
with the server address inside: `./khata/tools/go-live.sh`. Afterwards every phone only signs in with a **user id and
password**. Nobody types a server address, a setup key or a code. Cost: ₹0 (Cloudflare's free plan).

## 1. Once, in Cloudflare (the shop owner's account, about 10 minutes)

1. Sign in or sign up at <https://dash.cloudflare.com> (Free plan).
2. Open **Workers & Pages** once and pick the **workers.dev** name (the server's address becomes
   `https://kadan-kanakku-api.<that name>.workers.dev`; nobody has to remember it).
3. **My Profile → API Tokens → Create Token** → template **Edit Cloudflare Workers** → also add
   **Account → D1 → Edit** → Continue → Create. Copy the token (shown once).
   (Custom token instead: Account › Workers Scripts › Edit, Account › D1 › Edit, Account › Account Settings › Read.)
4. Copy the **Account ID** (Workers & Pages overview, right-hand side).

## 2. Once, in the Claude Code cloud environment's settings (never in a chat message)

The cloud environment menu in the session's title bar → **Edit** → environment variables / secrets:

| Variable | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 1.3 |
| `CLOUDFLARE_ACCOUNT_ID` | the Account ID from step 1.4 |
| `KK_OWNER_USER` | the owner's user id, e.g. `rahul` (3–32 lower-case letters, digits, `.` `-` `_`) |
| `KK_OWNER_PASSWORD` | the owner's password, at least 8 characters (only used on the first run) |
| `KK_SHOP_NAME` | the shop's name, e.g. `Rahul Stores` (first run) |
| `KK_SIGNING` | the app's release signing key as one value (`node khata/tools/signing-bundle.mjs pack <keystore.properties>`) |

`KK_SIGNING` is also the backup of the signing key: APKs signed with another key cannot update the app already on
the phones. Keep a copy in a password manager too. New settings reach **new** sessions.

## 3. In a new session

Say: *"Go live: follow khata/GO-LIVE.md."* The session runs

```bash
./khata/tools/go-live.sh "<scratchpad>/release"
```

which (safe to re-run):

1. **Server**: `deploy-server.sh` creates the D1 database (APAC) if missing, applies the migrations, keeps or
   creates the server secrets, builds the web app and deploys the Worker; checks `/v1/health`.
2. **Owner login**: when the shop has no logins yet, `create-owner.mjs` creates the shop and the owner's login
   (`KK_OWNER_USER` / `KK_OWNER_PASSWORD`) through the API, with a temporary device that is signed out again, and
   `reset-unused-codes.sql` gives back the customer numbers that device took (the first real customer is C-0001).
   Once the shop has logins this step creates nothing.
3. **APK**: installs the Android SDK if the container has none (`setup-android-sdk.sh`), restores the signing key
   from `KK_SIGNING`, and builds `kadan-kanakku-<version>.apk` with `SHOP_SERVER_URL` built in.

Then the session checks the APK (version, 16 KB alignment, signing certificate SHA-256
`39c264b3c0ddc78a4795b8741609a0de96ed668347fb5e4387d87d2bd1c91625`), sends it, commits the D1 `database_id` that
`deploy-server.sh` wrote into `khata/api/wrangler.jsonc` (not a secret), and never pastes the token, the setup key or
a password into the chat. `khata/api/.deploy-secrets` (server secrets) stays out of git.

## 4. On the phones

- **Every phone**: install the APK (it updates an installed copy and keeps its data).
- **Trial entries on a phone?** Settings → Backup → **Erase all entries and start fresh** *before* signing in:
  signing in uploads everything already on the phone.
- **The owner's phone**: tap **Sync** (top right of Home) → **Sign in** → `KK_OWNER_USER` + `KK_OWNER_PASSWORD`.
  (A new install: language → **Sign in to my shop**.)
- **Staff**: the owner opens **Settings → Users → Add user** for each employee (user id, name, password, Staff).
  On the employee's phone: language → **Sign in to my shop** → that user id and password.
- **Owner**: Settings → Phones → **Recovery codes**: write them down, keep them in the cash box.
- **Web app** (owner only): the server address in Chrome on any computer, same user id and password.

Change a password: Settings → Account → Change my password (owner: Settings → Users → Reset password for staff).

Tested end to end against `wrangler dev --local`: `node khata/app/e2e/go-live.mjs` (owner login by
`create-owner.mjs`, numbers handed back, a phone build with the server built in signs in with no address field,
Sync, first customer C-0001, the owner adds a staff login, a second run creates nothing).
