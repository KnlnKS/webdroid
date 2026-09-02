// A GL game: the screen never settles (bobbing bird, scrolling ground), so every step is
// `animated` — one capture after a fixed dwell. Pipes are random and the score differs per run,
// so this is a smoke target (rendered / alive / fps / missing), not a pixel target.
import type { Flow } from "../types";

const N = (x: number, y: number) => ({ x: x / 720, y: y / 1280 });
// The activity is fullscreen and the engine's 288x512 camera fills the 720x1280 screen (x2.5).
const G = (gx: number, gy: number) => N(gx * 2.5, gy * 2.5);
const CENTER = N(360, 660);
const PLAY_BTN = G(78, 370);

export const flappybird: Flow = {
  app: "flappybird",
  pkg: "com.dotgears.flappybird",
  activity: "com.dotgears.flappy.SplashScreen",
  apk: "flappybird.apk",
  crop: { top: 0, bottom: 48, left: 0, right: 0 },
  minFps: 55,
  steps: [
    { id: "splash", label: "Launch — splash", action: { type: "launch" }, settleDelayMs: 1200, animated: true },
    { id: "title", label: "Title — bobbing bird", action: { type: "settle" }, settleDelayMs: 3000, animated: true },
    { id: "play", label: "Play → Get Ready", action: { type: "tapAt", ...PLAY_BTN }, settleDelayMs: 800, animated: true },
    // ~2.7s of live gameplay with no capture inside it: the perf window.
    { id: "flaps", label: "Start + 5 flaps", action: { type: "tapAt", ...CENTER, repeat: 6, everyMs: 600 }, animated: true },
    { id: "dead", label: "Game over — score/medal", action: { type: "settle" }, settleDelayMs: 3500, animated: true },
    { id: "restart", label: "Play again → Get Ready", action: { type: "tapAt", ...PLAY_BTN }, settleDelayMs: 800, animated: true },
    { id: "flaps2", label: "Second game — 3 flaps", action: { type: "tapAt", ...CENTER, repeat: 4, everyMs: 600 }, animated: true },
  ],
};
