#!/usr/bin/env bash
# Deploy (or update) the Kadan Kanakku sync server to YOUR Cloudflare account. Safe to re-run.
#
# Sign-in, either:
#   a) on your own computer:  cd khata/api && npx wrangler login        (opens the browser once), or
#   b) non-interactive:       export CLOUDFLARE_API_TOKEN=...  CLOUDFLARE_ACCOUNT_ID=...
#      Token permissions: Account > Workers Scripts: Edit, Account > D1: Edit, Account > Account Settings: Read.
#
# Usage:  ./khata/tools/deploy-server.sh [--rotate-setup-key]
#
# What it does: creates the D1 database "khata" (APAC) if missing, writes its id into wrangler.jsonc, applies
# migrations, generates PEPPER and SETUP_KEY once (kept in khata/api/.deploy-secrets, never committed), builds the
# web app (khata/app -> dist-web, served by the Worker as static assets), deploys the Worker with those secrets, and
# checks it answers. It never changes an existing PEPPER (that would log out every phone). Set SKIP_WEB_BUILD=1 to
# deploy without rebuilding the web app (the previous build in khata/app/dist-web is used if present).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
API="$(cd "$HERE/../api" && pwd)"
APP="$(cd "$HERE/../app" && pwd)"
SECRETS="$API/.deploy-secrets"
DB_NAME="khata"
ROTATE_SETUP=0
[ "${1:-}" = "--rotate-setup-key" ] && ROTATE_SETUP=1

cd "$API"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
command -v node >/dev/null || die "Node.js 20+ is required (https://nodejs.org)."
command -v curl >/dev/null || die "curl is required."
[ -d node_modules ] || { say "Installing server dependencies (npm ci)..."; npm ci --no-audit --no-fund; }
W() { npx --no-install wrangler "$@"; }
export WRANGLER_SEND_METRICS=false

say "1/7  Checking Cloudflare sign-in"
if ! WHO="$(W whoami 2>&1)" || grep -qi "not authenticated\|You are not" <<<"$WHO"; then
  die "Not signed in to Cloudflare. Run 'cd khata/api && npx wrangler login', or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID."
fi
grep -E "associated with the email|Account Name|Account ID|│" <<<"$WHO" | head -6 || true

say "2/7  D1 database '$DB_NAME'"
find_db_id() {
  W d1 list --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const i = s.indexOf("["); if (i < 0) process.exit(0);
      const db = JSON.parse(s.slice(i)).find(d => d.name === process.argv[1]);
      if (db) process.stdout.write(db.uuid);
    });' "$DB_NAME"
}
DB_ID="$(find_db_id || true)"
if [ -z "$DB_ID" ]; then
  echo "Creating it in the Asia-Pacific region..."
  W d1 create "$DB_NAME" --location=apac >/dev/null
  DB_ID="$(find_db_id || true)"
fi
[ -n "$DB_ID" ] || die "Could not create or find the D1 database '$DB_NAME'."
echo "database_id = $DB_ID"
node -e '
  const fs = require("fs"); const f = "wrangler.jsonc"; const id = process.argv[1];
  const t = fs.readFileSync(f, "utf8");
  const u = t.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${id}$2`);
  if (u !== t) { fs.writeFileSync(f, u); console.log("wrangler.jsonc updated"); } else console.log("wrangler.jsonc already up to date");
' "$DB_ID"

say "3/7  Applying database migrations"
CI=true W d1 migrations apply "$DB_NAME" --remote

say "4/7  Secrets"
umask 077
touch "$SECRETS"
get_secret() { grep -E "^$1=" "$SECRETS" | head -1 | cut -d= -f2- || true; }
REMOTE_NAMES="$(W secret list --format json 2>/dev/null | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{ const i=s.indexOf("["); if(i<0) return;
  try { process.stdout.write(JSON.parse(s.slice(i)).map(x=>x.name).join(" ")); } catch {} });' || true)"
PEPPER="$(get_secret PEPPER)"
SETUP_KEY="$(get_secret SETUP_KEY)"
gen() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('base64url'))"; }
UPLOAD_PEPPER=0
if [ -z "$PEPPER" ]; then
  if grep -qw PEPPER <<<"$REMOTE_NAMES"; then
    echo "PEPPER already set on the server (kept unchanged; its value is not stored on this computer)."
  else
    PEPPER="$(gen 32)"; UPLOAD_PEPPER=1; echo "Generated a new PEPPER."
  fi
else
  grep -qw PEPPER <<<"$REMOTE_NAMES" || UPLOAD_PEPPER=1
fi
UPLOAD_SETUP=0
if [ "$ROTATE_SETUP" = 1 ] || { [ -z "$SETUP_KEY" ] && ! grep -qw SETUP_KEY <<<"$REMOTE_NAMES"; }; then
  SETUP_KEY="$(gen 18)"; UPLOAD_SETUP=1; echo "Generated a new SETUP_KEY."
elif [ -n "$SETUP_KEY" ] && ! grep -qw SETUP_KEY <<<"$REMOTE_NAMES"; then
  UPLOAD_SETUP=1
fi
{
  echo "# Kadan Kanakku server secrets. NEVER commit. Back this file up with the release signing key."
  [ -n "$PEPPER" ] && echo "PEPPER=$PEPPER"
  [ -n "$SETUP_KEY" ] && echo "SETUP_KEY=$SETUP_KEY"
} > "$SECRETS.tmp" && mv "$SECRETS.tmp" "$SECRETS"
SECRETS_JSON="$(mktemp)"; trap 'rm -f "$SECRETS_JSON"' EXIT
OUT="$SECRETS_JSON" node -e '
  const [p, s, up, us] = process.argv.slice(1); const o = {};
  if (up === "1") o.PEPPER = p;
  if (us === "1") o.SETUP_KEY = s;
  require("fs").writeFileSync(process.env.OUT, JSON.stringify(o));
' "$PEPPER" "$SETUP_KEY" "$UPLOAD_PEPPER" "$UPLOAD_SETUP"

say "5/7  Building the web app"
if [ "${SKIP_WEB_BUILD:-0}" = 1 ] && [ -f "$APP/dist-web/index.html" ]; then
  echo "SKIP_WEB_BUILD=1: using the existing build in $APP/dist-web"
else
  ( cd "$APP" \
    && { [ -d node_modules ] && [ node_modules/.package-lock.json -nt package-lock.json ] || npm ci --no-audit --no-fund --legacy-peer-deps; } \
    && npx --no-install vite build --mode web ) || die "The web app build failed (see the output above)."
fi
[ -f "$APP/dist-web/index.html" ] || die "No web app build in $APP/dist-web."
# wrangler's build step (api/scripts/prepare-assets.mjs) adds dist-web/_headers (CSP etc.) before deploying.

say "6/7  Deploying the Worker"
DEPLOY_LOG="$(mktemp)"
if ! W deploy --secrets-file "$SECRETS_JSON" 2>&1 | tee "$DEPLOY_LOG"; then
  if grep -qi "workers.dev subdomain" "$DEPLOY_LOG"; then
    die "This Cloudflare account has no workers.dev subdomain yet. Open https://dash.cloudflare.com → Workers & Pages once, pick a subdomain, then re-run this script."
  fi
  die "Deploy failed (see the output above)."
fi
URL="$(grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' "$DEPLOY_LOG" | head -1 || true)"
rm -f "$DEPLOY_LOG"
[ -n "$URL" ] || die "Deployed, but could not read the workers.dev address from the output. Find it in the Cloudflare dashboard."
grep -q '^URL=' "$SECRETS" || echo "URL=$URL" >> "$SECRETS"

say "7/7  Checking the live server"
ok=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 10 "$URL/v1/health" | grep -q '"ok":true'; then ok=1; break; fi
  sleep 3
done
[ "$ok" = 1 ] || die "$URL/v1/health did not answer {\"ok\":true} yet. Wait a minute and open it in a browser."
ME="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$URL/v1/me")"
[ "$ME" = 401 ] || die "Expected 401 from /v1/me without a token, got $ME (500 means PEPPER is missing)."
echo "Health OK, authentication OK."

cat <<EOF

$(printf '\033[32mServer is live.\033[0m')

  Server address : $URL
  Web app        : $URL/          (owner sign-in with user id & password; staff use the phone app)
  Setup key      : ${SETUP_KEY:-<already set on the server; run with --rotate-setup-key to issue a new one>}

On the OWNER's phone:  Settings → Shop server → Connect to shop server → "First-time setup"
  enter the server address, the setup key, the shop name and your own user id + password, then tap Connect.
Then:  Settings → Phones → "Recovery codes" → write them down and keep them in the cash box.
Staff:  Settings → Users → "Add user" gives each person a user id and password.
An APK with this server built in (staff then type only their user id and password):
  SHOP_SERVER_URL=$URL KEYSTORE_PROPERTIES=... ./khata/tools/build-release-apk.sh
Every other phone:  install that APK → "Sign in to my shop" → user id + password.
The owner's web app:  $URL/  (owner sign-in; staff use the phone app).

Keep $SECRETS (PEPPER, SETUP_KEY) backed up with the APK signing key. Never commit it.
After handover you can disable first-time setup:  cd khata/api && npx wrangler secret delete SETUP_KEY
EOF
