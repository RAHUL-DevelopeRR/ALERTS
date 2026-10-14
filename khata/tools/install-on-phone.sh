#!/usr/bin/env bash
# Install (or update) Kadan Kanakku on an Android phone connected by USB.
# Usage: ./install-on-phone.sh path/to/kadan-kanakku-1.0.0.apk
# Needs adb (Android platform-tools): https://developer.android.com/tools/releases/platform-tools
set -euo pipefail
APK="${1:-kadan-kanakku-1.0.0.apk}"
command -v adb >/dev/null || { echo "adb not found. Install Android platform-tools and add it to PATH."; exit 1; }
[ -f "$APK" ] || { echo "APK not found: $APK"; exit 1; }
adb start-server >/dev/null
echo "Connected devices:"; adb devices -l
COUNT=$(adb devices | awk 'NR>1 && $2=="device"' | wc -l)
if [ "$COUNT" -eq 0 ]; then
  echo
  echo "No authorised device. On the Redmi: Settings > About phone > tap 'OS version' 7 times,"
  echo "then Settings > Additional settings > Developer options > enable 'USB debugging' AND 'Install via USB'."
  echo "Reconnect the cable and tap 'Allow' on the phone's USB debugging prompt."
  exit 1
fi
echo "Installing $APK ..."
adb install -r "$APK"
adb shell monkey -p live.zerox.kadankanakku -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
echo "Done. The app should now be open on the phone."
