// calculatorm (Compose + Material3, Room history). Keypad taps are positional: Compose draws
// through canvas ops and exposes no View.text, so nothing here can resolve by text.
// KEY COORDINATES ARE PLACEHOLDERS: a plausible 4x5 keypad grid in the lower half
// (columns x = 90/270/450/630, rows y = 700/840/980/1120 in 720x1280 px) — read the real
// centres off the first rendered frame (or wd.rnodes()) once the keypad draws, then fix them.
// The app also loads an arm64 on-device LLM (liblitertlm_jni.so): expected in nativeRequired,
// off the usable path (the app's own unavailable state).
import type { Flow } from "../types";

const N = (x: number, y: number) => ({ x: x / 720, y: y / 1280 });
// placeholders (see header): 7 8 9 × / 4 5 6 − / 1 2 3 + / 0 . = row order
const KEY_7 = N(90, 700);
const KEY_PLUS = N(630, 980);
const KEY_EQ = N(630, 1120);

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
