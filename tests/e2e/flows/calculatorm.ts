// calculatorm (Compose + Material3; history kept in SharedPreferences/SavedStateHandle, not Room).
// Keypad taps are positional: Compose draws through canvas ops and exposes no View.text, so
// nothing here can resolve by text. Observed layout (720x1280 px, status bar included): a
// 4x5 grid of 163px round buttons, columns centred at x = 97/272/447/622, rows at
// y = 475 (⌫ AC % ÷), 650 (7 8 9 ×), 825 (4 5 6 −), 1000 (1 2 3 +), 1175 (+/− 0 . =); a row of
// √ π ^ ! text buttons at y = 340 and the history clock icon at (640, 96). The display shows the
// expression (auto-shrinking to fit) with a live "= result" preview once an operator is entered.
// The app also bundles an arm64 on-device LLM (liblitertlm_jni.so) behind its camera/AI screen —
// off this flow; when reached it must surface as nativeRequired (the app's own unavailable state).
import type { Flow } from "../types";

const N = (x: number, y: number) => ({ x: x / 720, y: y / 1280 });
const KEY_7 = N(97, 650);
const KEY_PLUS = N(622, 1000);
const KEY_EQ = N(622, 1175);

export const calculatorm: Flow = {
  app: "calculatorm",
  pkg: "com.vagujhelyigergely.calculatorm3",
  activity: "com.vagujhelyigergely.calculatorm3.MainActivity",
  apk: "calculatorm.apk",
  crop: { top: 48, bottom: 48, left: 0, right: 0 },
  steps: [
    { id: "launch", label: "Launch — keypad", action: { type: "launch" }, settleDelayMs: 5000 },
    { id: "keypad", label: "Keypad settled", action: { type: "settle" } },
    { id: "7", label: "Tap 7", action: { type: "tapAt", ...KEY_7 }, settleDelayMs: 400 },
    { id: "plus", label: "Tap +", action: { type: "tapAt", ...KEY_PLUS }, settleDelayMs: 400 },
    { id: "7b", label: "Tap 7 again", action: { type: "tapAt", ...KEY_7 }, settleDelayMs: 400 },
    { id: "eq", label: "Tap = (expect 14)", action: { type: "tapAt", ...KEY_EQ }, settleDelayMs: 400 },
    { id: "result", label: "Result shown", action: { type: "settle" } },
    { id: "back", label: "Back", action: { type: "back" } },
  ],
};
