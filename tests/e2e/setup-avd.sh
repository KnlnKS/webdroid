#!/usr/bin/env bash
# Create the API 35 reference AVD at webdroid's default framebuffer geometry.
# The size is NOT written here: it is read from the one device profile (src/shell/config.ts),
# so a profile change cannot leave the reference AVD behind. WEBDROID_SCREEN=WxH@dpi overrides.
# Idempotent: re-running rewrites config.ini but keeps the existing userdata.
set -euo pipefail

export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk}"
export PATH="$JAVA_HOME/bin:$PATH"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
AVD_NAME="${AVD_NAME:-webdroid_api35_ref}"
ANDROID_API="${ANDROID_API:-35}"
IMAGE="system-images;android-${ANDROID_API};google_apis;arm64-v8a"
AVD_HOME="${ANDROID_AVD_HOME:-$HOME/.android/avd}"

# The profile is the only place the geometry is written down; ask it rather than restate it.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
read -r LCD_W LCD_H LCD_DPI <<<"$(cd "$HERE" && node --input-type=module -e \
  'import {device as d} from "./src/shell/config.ts"; console.log(d.width, d.height, d.densityDpi)' | tail -n 1)"

command -v avdmanager >/dev/null || { echo "avdmanager not on PATH"; exit 1; }

if [ ! -d "$SDK/system-images/android-${ANDROID_API}/google_apis/arm64-v8a" ]; then
  echo "missing $IMAGE — install with: sdkmanager '$IMAGE'"; exit 1
fi

if ! avdmanager list avd -c 2>/dev/null | grep -qx "$AVD_NAME"; then
  echo "creating AVD $AVD_NAME"
  echo "no" | avdmanager create avd -n "$AVD_NAME" -k "$IMAGE" --force >/dev/null
else
  echo "AVD $AVD_NAME already exists — rewriting config"
fi

CFG="$AVD_HOME/$AVD_NAME.avd/config.ini"
[ -f "$CFG" ] || { echo "no config.ini at $CFG"; exit 1; }

# Strip every key we own, then append our values. Keeps unrelated keys intact.
python3 - "$CFG" "$LCD_W" "$LCD_H" "$LCD_DPI" <<'PY'
import sys
cfg, w, h, dpi = sys.argv[1:5]
ours = {
    "hw.lcd.width": w,
    "hw.lcd.height": h,
    "hw.lcd.density": dpi,
    "hw.lcd.depth": "32",
    "hw.keyboard": "yes",
    "hw.mainKeys": "no",
    "hw.gpu.enabled": "yes",
    "hw.gpu.mode": "auto",
    "hw.ramSize": "3072",
    "vm.heapSize": "384",
    "disk.dataPartition.size": "6G",
    "showDeviceFrame": "no",
    "skin.dynamic": "no",
    "skin.name": f"{w}x{h}",
    "skin.path": "_no_skin",
    "hw.initialOrientation": "Portrait",
    "runtime.network.speed": "full",
}
lines = [l for l in open(cfg).read().splitlines()
         if l.split("=", 1)[0].strip() not in ours]
lines += [f"{k}={v}" for k, v in ours.items()]
open(cfg, "w").write("\n".join(lines) + "\n")
print(f"wrote {cfg}")
PY

echo "AVD $AVD_NAME ready: ${LCD_W}x${LCD_H} @ ${LCD_DPI}dpi"
