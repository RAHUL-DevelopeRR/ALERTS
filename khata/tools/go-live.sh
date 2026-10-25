#!/usr/bin/env bash
# From nothing to a working shop in one command: deploys the server to the shop's Cloudflare account, creates the
# owner's login on it, and builds the shop's APK with the server address inside. Afterwards every phone only signs in
# with a user id and password: nobody types a server address, a setup key or a code.
#
# Cloudflare access, either:  cd khata/api && npm ci && npx wrangler login   (your own computer, opens the browser)
#                        or:  CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID    (a cloud session; see deploy-server.sh)
# The app's signing key, one of:  KK_SIGNING_FILE=/path/KK_SIGNING-value.txt, KK_SIGNING=<that value>, or
#                                 KEYSTORE_PROPERTIES=/path/keystore.properties   (asked for when none is set)
# The owner's login (first run only): KK_OWNER_USER, KK_OWNER_PASSWORD, KK_SHOP_NAME, or typed when asked.
#
# Usage:  ./khata/tools/go-live.sh [output-dir]      Safe to re-run: updates the server and rebuilds the APK.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
API="$(cd "$HERE/../api" && pwd)"
APP="$(cd "$HERE/../app" && pwd)"
OUT="${1:-$HERE/../release}"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

ask() { [ -t 0 ] || die "$1"; }

# The signing key first: a build that cannot be signed should fail before anything is deployed.
if [ -z "${KEYSTORE_PROPERTIES:-}" ]; then
  if [ -z "${KK_SIGNING:-}" ]; then
    if [ -z "${KK_SIGNING_FILE:-}" ]; then
      ask "Set KK_SIGNING_FILE (the app's signing key file), KK_SIGNING or KEYSTORE_PROPERTIES. Without the same key, the APK cannot update the app already on the phones."
      read -r -p "Path to the signing key file (KK_SIGNING-value.txt): " KK_SIGNING_FILE
    fi
    [ -f "$KK_SIGNING_FILE" ] || die "No such file: $KK_SIGNING_FILE"
    KK_SIGNING="$(cat "$KK_SIGNING_FILE")"
  fi
  SIGN_DIR="$(mktemp -d)"
  trap 'rm -rf "$SIGN_DIR"' EXIT
  KEYSTORE_PROPERTIES="$(KK_SIGNING="$KK_SIGNING" node "$HERE/signing-bundle.mjs" unpack "$SIGN_DIR/signing")"
  export KEYSTORE_PROPERTIES
fi

# The Android SDK: the one given, else a usual place, else install into the usual place for this computer.
if [ -z "${ANDROID_HOME:-}" ]; then
  for d in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk" /opt/android-sdk; do
    [ -d "$d/platforms" ] && { ANDROID_HOME="$d"; break; }
  done
  if [ -z "${ANDROID_HOME:-}" ]; then
    if [ "$(uname)" = Darwin ]; then ANDROID_HOME="$HOME/Library/Android/sdk"; else ANDROID_HOME="$HOME/Android/Sdk"; fi
  fi
fi
export ANDROID_HOME

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
  if [ -z "${KK_OWNER_USER:-}" ] || [ -z "${KK_OWNER_PASSWORD:-}" ]; then
    ask "The shop has no logins yet: set KK_OWNER_USER and KK_OWNER_PASSWORD (and KK_SHOP_NAME)."
    echo "The shop has no logins yet. Choose the owner's login (used to sign in on the phones and the web app)."
    [ -n "${KK_SHOP_NAME:-}" ] || read -r -p "Shop name (e.g. Rahul Stores): " KK_SHOP_NAME
    [ -n "${KK_OWNER_USER:-}" ] || read -r -p "Owner's user id (e.g. rahul): " KK_OWNER_USER
    while :; do
      read -r -s -p "Owner's password (at least 8 characters): " KK_OWNER_PASSWORD; echo
      read -r -s -p "The same password again: " PW2; echo
      [ "$KK_OWNER_PASSWORD" = "$PW2" ] && [ "${#KK_OWNER_PASSWORD}" -ge 8 ] && break
      echo "They did not match, or it is shorter than 8 characters. Try again."
    done
    export KK_SHOP_NAME KK_OWNER_USER KK_OWNER_PASSWORD
  fi
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
