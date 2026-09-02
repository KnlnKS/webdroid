#!/usr/bin/env bash
# Create the webdroid_ref AVD: 720x1280 @ 320dpi — byte-identical geometry to webdroid's
# framebuffer (src/shell/config.ts: width 720, height 1280, density 2.0 / 320dpi).
# Idempotent: re-running rewrites config.ini but keeps the existing userdata.
set -euo pipefail

export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"
export PATH="$JAVA_HOME/bin:$PATH"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
AVD_NAME="${AVD_NAME:-webdroid_ref}"
IMAGE="system-images;android-35;google_apis;arm64-v8a"
AVD_HOME="${ANDROID_AVD_HOME:-$HOME/.android/avd}"

command -v avdmanager >/dev/null || { echo "avdmanager not on PATH"; exit 1; }

if [ ! -d "$SDK/system-images/android-35/google_apis/arm64-v8a" ]; then
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
python3 - "$CFG" <<'PY'
import sys
cfg = sys.argv[1]
ours = {
    "hw.lcd.width": "720",
    "hw.lcd.height": "1280",
    "hw.lcd.density": "320",
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
    "skin.name": "720x1280",
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

echo "AVD $AVD_NAME ready: 720x1280 @ 320dpi (360x640dp)"
