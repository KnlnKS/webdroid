// calculatorm (Compose + Material3; history kept in SharedPreferences/SavedStateHandle, not Room).
// Keypad taps are positional: Compose draws through canvas ops and exposes no View.text, so
// nothing here can resolve by text. Observed layout at a 1080x2424 screen (status bar
// included): a 4x5 grid of round buttons, columns centred at x = 142/404/668/931, rows at
// y = 1145 (⌫ AC % ÷), 1408 (7 8 9 ×), 1671 (4 5 6 −), 1934 (1 2 3 +), 2198 (+/− 0 . =); a row of
// √ π ^ ! text buttons at y = 935 (x = 165/415/665/915) and the history clock icon at (960, 182).
// The display shows the expression (auto-shrinking to fit) with a live "= result" preview once an
// operator is entered. Compose does not lay the keypad out proportionally, so these fractions
// are only right at that aspect ratio, and the flow pins it.
// The app also bundles an arm64 on-device LLM (liblitertlm_jni.so) behind its camera/AI screen —
// off this flow; when reached it must surface as nativeRequired (the app's own unavailable state).
import { pixelsOn, wait, type Flow, type Screen } from "../types.ts";

const SCREEN: Screen = { width: 1080, height: 2424, densityDpi: 480 };
const { point: N } = pixelsOn(SCREEN);
const KEY_7 = N(142, 1408);
const KEY_PLUS = N(931, 1934);
const KEY_EQ = N(931, 2198);

export const calculatorm: Flow = {
  app: "calculatorm",
  pkg: "com.vagujhelyigergely.calculatorm3",
  activity: "com.vagujhelyigergely.calculatorm3.MainActivity",
  apk: "calculatorm.apk",
  screen: SCREEN,
  crop: { top: 48, bottom: 48, left: 0, right: 0 },
  clock: "controlled",
  steps: [
    { id: "launch", label: "Launch — keypad", action: { type: "launch" }, wait: wait.quiescent(5000) },
    { id: "keypad", label: "Keypad settled", action: { type: "settle" }, wait: wait.quiescent() },
    { id: "7", label: "Tap 7", action: { type: "tapAt", ...KEY_7 }, wait: wait.quiescent(400) },
    { id: "plus", label: "Tap +", action: { type: "tapAt", ...KEY_PLUS }, wait: wait.quiescent(400) },
    { id: "7b", label: "Tap 7 again", action: { type: "tapAt", ...KEY_7 }, wait: wait.quiescent(400) },
    { id: "eq", label: "Tap = (expect 14)", action: { type: "tapAt", ...KEY_EQ }, wait: wait.quiescent(400) },
    { id: "result", label: "Result shown", action: { type: "settle" }, wait: wait.quiescent(),
      evidence: { kind: "visual", maxContentDiffPct: 10 } },
  ],
};
