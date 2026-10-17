#!/usr/bin/env bash
set -euo pipefail

export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"
export PATH="$JAVA_HOME/bin:/opt/homebrew/bin:$PATH"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
ADB="$SDK/platform-tools/adb"
AVD_NAME="webdroid_api35_ref"
CACHE="fuzz-cache/android-35"

ANDROID_API=35 AVD_NAME="$AVD_NAME" bash tests/e2e/setup-avd.sh

if "$ADB" shell true >/dev/null 2>&1; then
  ATTACHED="$($ADB emu avd name 2>/dev/null | head -n 1 | tr -d '\r')"
  if [ "$ATTACHED" != "$AVD_NAME" ]; then
    echo "attached emulator is ${ATTACHED:-unknown}, expected $AVD_NAME" >&2
    exit 1
  fi
else
  AVD_NAME="$AVD_NAME" bash tests/e2e/boot-emulator.sh
fi

SDK_LEVEL="$($ADB shell getprop ro.build.version.sdk | tr -d '\r')"
[ "$SDK_LEVEL" = 35 ] || { echo "oracle reports API $SDK_LEVEL, expected 35" >&2; exit 1; }
read -r LCD_W LCD_H LCD_DPI <<<"$(node --input-type=module -e 'import { device as d } from "./src/shell/config.ts"; console.log(d.width, d.height, d.densityDpi)' | tail -n 1)"
"$ADB" shell wm size "${LCD_W}x${LCD_H}"
"$ADB" shell wm density "$LCD_DPI"
mkdir -p "$CACHE"
"$ADB" pull /system/framework/framework.jar "$CACHE/framework.jar" >/dev/null
"$ADB" pull /system/framework/framework-res.apk "$CACHE/framework-res.apk" >/dev/null
"$ADB" shell getprop ro.build.fingerprint | tr -d '\r' > "$CACHE/fingerprint.txt"
cp "$SDK/platforms/android-35/data/api-versions.xml" "$CACHE/api-versions.xml"
echo "API 35 oracle ready: $(cat "$CACHE/fingerprint.txt")"
