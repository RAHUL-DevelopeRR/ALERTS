#!/usr/bin/env bash
# Installs the Android SDK pieces the release build needs: command-line tools, platform-tools, the Android 36
# platform and build-tools 35 + 36 (a fresh cloud container has none). Does nothing when they are already there.
# Linux or macOS (Windows: use WSL). Needs Java 21 and network access to dl.google.com.
#
# Usage:  ./khata/tools/setup-android-sdk.sh
#         (ANDROID_HOME defaults to ~/Library/Android/sdk on macOS, ~/Android/Sdk elsewhere)
set -euo pipefail

if [ "$(uname)" = Darwin ]; then OS=mac; DEFAULT_SDK="$HOME/Library/Android/sdk"; else OS=linux; DEFAULT_SDK="$HOME/Android/Sdk"; fi
SDK="${ANDROID_HOME:-$DEFAULT_SDK}"
CLT_ZIP="https://dl.google.com/android/repository/commandlinetools-$OS-16111833_latest.zip"
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

if [ -d "$SDK/platforms/android-36" ] && [ -d "$SDK/build-tools/36.0.0" ] && [ -d "$SDK/platform-tools" ]; then
  echo "Android SDK already installed in $SDK"
  exit 0
fi
command -v java >/dev/null || die "Java 21 is required (apt install openjdk-21-jdk-headless)."
command -v unzip >/dev/null || die "unzip is required."

echo "Installing the Android SDK into $SDK (a few hundred MB)..."
mkdir -p "$SDK/cmdline-tools"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  curl -fsSL -o "$TMP/clt.zip" "$CLT_ZIP"
  unzip -q -o "$TMP/clt.zip" -d "$TMP"
  rm -rf "$SDK/cmdline-tools/latest"
  mv "$TMP/cmdline-tools" "$SDK/cmdline-tools/latest"
fi
SDKM="$SDK/cmdline-tools/latest/bin/sdkmanager"
yes | "$SDKM" --sdk_root="$SDK" --licenses >/dev/null 2>&1 || true
"$SDKM" --sdk_root="$SDK" "platform-tools" "platforms;android-36" "build-tools;36.0.0" "build-tools;35.0.0" >/dev/null
[ -d "$SDK/build-tools/36.0.0" ] || die "sdkmanager did not install build-tools 36.0.0."
echo "Android SDK ready in $SDK"
