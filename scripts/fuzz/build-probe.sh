#!/usr/bin/env bash
set -euo pipefail

export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk}"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
PLATFORM="$SDK/platforms/android-35/android.jar"
BUILD="fuzz-cache/probe-build"
OUT="fuzz-cache/WebdroidFuzzProbe.apk"
TOOLS="$(find "$SDK/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)"

[ -f "$PLATFORM" ] || { echo "missing $PLATFORM" >&2; exit 1; }
mkdir -p "$BUILD/classes" "$BUILD/dex" "$(dirname "$OUT")"
find "$BUILD/classes" -type f -delete
rm -f "$BUILD/classes.jar" "$BUILD/dex/classes.dex" "$BUILD/unsigned.apk" "$OUT"

"$JAVA_HOME/bin/javac" --release 17 -classpath "$PLATFORM" -d "$BUILD/classes" \
  tests/fuzz-probe/src/org/webdroid/fuzz/ProbeActivity.java
"$JAVA_HOME/bin/jar" --create --file "$BUILD/classes.jar" -C "$BUILD/classes" .
"$TOOLS/d8" --lib "$PLATFORM" --min-api 23 --output "$BUILD/dex" "$BUILD/classes.jar"
"$TOOLS/aapt2" link -o "$BUILD/unsigned.apk" -I "$PLATFORM" \
  --manifest tests/fuzz-probe/AndroidManifest.xml --min-sdk-version 23 --target-sdk-version 35
"$JAVA_HOME/bin/jar" --update --file "$BUILD/unsigned.apk" -C "$BUILD/dex" classes.dex

KEYSTORE="${ANDROID_DEBUG_KEYSTORE:-$HOME/.android/debug.keystore}"
if [ ! -f "$KEYSTORE" ]; then
  "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$KEYSTORE" -storepass android -alias androiddebugkey \
    -keypass android -dname "CN=Android Debug,O=Android,C=US" -keyalg RSA -validity 10000 >/dev/null
fi
"$TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
  --out "$OUT" "$BUILD/unsigned.apk"
echo "$OUT"
