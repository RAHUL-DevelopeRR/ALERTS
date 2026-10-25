#!/usr/bin/env bash
# From nothing to a working shop in one command: deploys the server to the shop's Cloudflare account, creates the
# owner's login on it, and builds the shop's APK with the server address inside. Afterwards every phone only signs in
# with a user id and password: nobody types a server address, a setup key or a code.
#
# Needs these environment variables (in a cloud session: the environment's settings; never commit them):
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID  Cloudflare access (token permissions: see deploy-server.sh)
#   KK_OWNER_USER, KK_OWNER_PASSWORD             the owner's user id and password (used on the first run only)
#   KK_SHOP_NAME                                 optional, the shop's name on the server (first run only)
#   KK_SIGNING                                   the app's release signing key (tools/signing-bundle.mjs), or
#                                                KEYSTORE_PROPERTIES pointing at a keystore.properties file
#
# Usage:  ./khata/tools/go-live.sh [output-dir]      Safe to re-run: updates the server and rebuilds the APK.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
API="$(cd "$HERE/../api" && pwd)"
APP="$(cd "$HERE/../app" && pwd)"
OUT="${1:-$HERE/../release}"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "CLOUDFLARE_API_TOKEN is not set (Cloudflare → My Profile → API Tokens)."
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || die "CLOUDFLARE_ACCOUNT_ID is not set (Cloudflare → Workers & Pages → Account ID)."

# The signing key first: a build that cannot be signed should fail before anything is deployed.
if [ -z "${KEYSTORE_PROPERTIES:-}" ]; then
  [ -n "${KK_SIGNING:-}" ] || die "Set KK_SIGNING (the app's signing key) or KEYSTORE_PROPERTIES. Without the same key, the APK cannot update the app already on the phones."
  SIGN_DIR="$(mktemp -d)"
  trap 'rm -rf "$SIGN_DIR"' EXIT
  KEYSTORE_PROPERTIES="$(node "$HERE/signing-bundle.mjs" unpack "$SIGN_DIR/signing")"
  export KEYSTORE_PROPERTIES
fi

say "1/3  Server"
# Creating the owner needs the setup key; a fresh computer has none, so ask deploy-server.sh for a new one.
if grep -qs '^SETUP_KEY=' "$API/.deploy-secrets"; then
  "$HERE/deploy-server.sh"
else
  "$HERE/deploy-server.sh" --rotate-setup-key
fi
URL="$(grep -s '^URL=' "$API/.deploy-secrets" | head -1 | cut -d= -f2-)"
[ -n "$URL" ] || die "Deployed, but the server address is not in $API/.deploy-secrets."

say "2/3  Owner login"
# Ask the database first: once the shop has logins, a re-run must not pair a temporary device (that would take a
# block of 50 customer numbers for nothing).
d1() { ( cd "$API" && CI=true npx --no-install wrangler d1 execute khata --remote "$@" ); }
USERS="$(d1 --json --command "SELECT COUNT(*) AS n FROM users" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const i = s.indexOf("["); const r = JSON.parse(s.slice(i));
    process.stdout.write(String(r[0]?.results?.[0]?.n ?? ""));
  });')"
[ -n "$USERS" ] || die "Could not read the users table."
if [ "$USERS" -gt 0 ]; then
  echo "The shop already has $USERS login(s): nothing to create. (Settings → Users on the owner's phone manages them.)"
else
  node "$HERE/create-owner.mjs" "$URL"
  echo "Handing back the customer numbers the temporary setup device took..."
  d1 --command "$(grep -v '^--' "$HERE/reset-unused-codes.sql")" >/dev/null
  echo "Done: the first real phone starts at C-0001."
fi

say "3/3  The shop's APK, server built in"
"$HERE/setup-android-sdk.sh"
[ -d "$APP/node_modules" ] || ( cd "$APP" && npm ci --no-audit --no-fund --legacy-peer-deps )
SHOP_SERVER_URL="$URL" "$HERE/build-release-apk.sh" "$OUT"
APK="$(ls -t "$OUT"/kadan-kanakku-*.apk | head -1)"

cat <<SUMMARY

$(printf '\033[32mThe shop is live.\033[0m')

  Server      : $URL   (built into the APK: nobody types it)
  Web app     : $URL/   (owner only: user id + password)
  Owner login : ${KK_OWNER_USER:-<the existing owner>}
  APK         : $APK

Every phone: install the APK. A new phone: language → "Sign in to my shop" → user id + password.
A phone that already has the app: tap Sync (top right of Home) → Sign in → user id + password.
  Trial entries on a phone? Settings → Backup → "Erase all entries and start fresh" BEFORE signing in:
  signing in uploads everything already on the phone.
Owner, once signed in: Settings → Users → "Add user" for each employee (user id, name, password, Staff);
  Settings → Phones → "Recovery codes": write them down, keep them in the cash box.
SUMMARY
