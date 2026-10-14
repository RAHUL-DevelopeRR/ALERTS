#!/usr/bin/env bash
# Build a signed, shareable release APK of Kadan Kanakku.
# Usage: KEYSTORE_PROPERTIES=/path/to/keystore.properties ./build-release-apk.sh [output-dir]
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
npx vite build --mode android
npx cap sync android
cp "$KEYSTORE_PROPERTIES" android/keystore.properties
trap 'rm -f "$APP/android/keystore.properties"' EXIT
(cd android && ./gradlew --no-daemon --max-workers=2 clean assembleRelease)

APK="$(ls android/app/build/outputs/apk/release/*.apk | grep -v unsigned | head -1)"
"$BT/apksigner" verify --print-certs "$APK" | head -3
"$BT/zipalign" -c -P 16 4 "$APK"
mkdir -p "$OUT"
cp "$APK" "$OUT/kadan-kanakku-$VERSION.apk"
( cd "$OUT" && sha256sum "kadan-kanakku-$VERSION.apk" > "kadan-kanakku-$VERSION.apk.sha256" )
ls -la "$OUT"
