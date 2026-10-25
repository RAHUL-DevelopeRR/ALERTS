#!/usr/bin/env bash
# Build a signed, shareable release APK of Kadan Kanakku.
# Usage: KEYSTORE_PROPERTIES=/path/to/keystore.properties [SHOP_SERVER_URL=https://….workers.dev] ./build-release-apk.sh [output-dir]
# SHOP_SERVER_URL (optional): the shop server this APK is for (printed by deploy-server.sh). Built in, staff sign in
# with only their user id and password; without it the sign-in screen asks for the address once.
# keystore.properties format (never commit it):
#   storeFile=/absolute/path/kadan-kanakku-release.jks
#   storePassword=...
#   keyAlias=kadankanakku
#   keyPassword=...
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/../app"
OUT="${1:-$HERE/../release}"
: "${KEYSTORE_PROPERTIES:?Set KEYSTORE_PROPERTIES to your keystore.properties path}"
: "${ANDROID_HOME:=/opt/android-sdk}"; export ANDROID_HOME
BT="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
VERSION="$(node -p "require('$APP/package.json').version")"

cd "$APP"
npx tsc --noEmit -p .
npx vitest run
if [ -n "${SHOP_SERVER_URL:-}" ]; then echo "Shop server built in: $SHOP_SERVER_URL"; fi
VITE_SHOP_SERVER_URL="${SHOP_SERVER_URL:-}" npx vite build --mode android
npx cap sync android
cp "$KEYSTORE_PROPERTIES" android/keystore.properties
trap 'rm -f "$APP/android/keystore.properties"' EXIT
(cd android && ./gradlew --no-daemon --max-workers=2 clean assembleRelease)

APK="$(ls android/app/build/outputs/apk/release/*.apk | grep -v unsigned | head -1)"
"$BT/apksigner" verify --print-certs "$APK" | head -3
"$BT/zipalign" -c -P 16 4 "$APK"
mkdir -p "$OUT"
NAME="kadan-kanakku-$VERSION${APK_SUFFIX:+-$APK_SUFFIX}.apk"
cp "$APK" "$OUT/$NAME"
( cd "$OUT" && sha256sum "$NAME" > "$NAME.sha256" )
ls -la "$OUT"
