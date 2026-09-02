#!/usr/bin/env bash
# Boot webdroid_ref and make it deterministic. Record-path only — `bun run e2e` never calls this.
set -euo pipefail

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
EMU="$SDK/emulator/emulator"
AVD_NAME="${AVD_NAME:-webdroid_ref}"
# Must match PINNED_CLOCK_MS in tests/e2e/types.ts (2026-01-02T12:00:00Z).
PIN_UTC="${PIN_UTC:-2026-01-02 12:00:00}"

if adb shell true >/dev/null 2>&1; then
  echo "device already connected — reusing"
else
  echo "booting $AVD_NAME..."
  "$EMU" -avd "$AVD_NAME" -no-snapshot -no-boot-anim -no-audio -netdelay none -netspeed full \
    >/tmp/webdroid-emulator.log 2>&1 &
  adb wait-for-device
fi

echo -n "waiting for boot_completed"
for _ in $(seq 1 180); do
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  echo -n "."; sleep 2
done
echo " ok"
adb shell input keyevent 82 >/dev/null 2>&1 || true   # dismiss keyguard

# --- determinism ---------------------------------------------------------------
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
adb shell settings put system font_scale 1.0
adb shell settings put global auto_time 0
adb shell settings put global auto_time_zone 0
adb shell cmd uimode night no >/dev/null 2>&1 || true
adb shell settings put secure show_ime_with_hard_keyboard 0 >/dev/null 2>&1 || true

# Fixed status bar: clock 12:00, full battery, full signal, no notification icons.
adb shell settings put global sysui_demo_allowed 1
for cmd in \
  "command enter" \
  "command clock -e hhmm 1200" \
  "command battery -e level 100 -e plugged false" \
  "command network -e wifi show -e level 4" \
  "command network -e mobile show -e datatype none -e level 4" \
  "command notifications -e visible false"; do
  # shellcheck disable=SC2086
  adb shell am broadcast -a com.android.systemui.demo -e $cmd >/dev/null 2>&1 || true
done

# Pin the clock. Needs root, which the google_apis image allows (playstore images do not).
if adb root >/dev/null 2>&1; then
  adb wait-for-device
  sleep 2
  adb shell "setprop persist.sys.timezone UTC" >/dev/null 2>&1 || true
  adb shell "date -u $(date -u -j -f '%Y-%m-%d %H:%M:%S' "$PIN_UTC" '+%m%d%H%M%Y.%S')" || true
  echo "clock pinned to $PIN_UTC UTC"
else
  echo "WARN: adb root unavailable — clock not pinned; date-bearing regions need maskRects"
fi

adb shell wm size; adb shell wm density; adb shell date
