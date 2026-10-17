// A GL game: the screen never settles (bobbing bird, scrolling ground), so every step is
// `animated` — one capture after a fixed dwell. Pipes are random and the score differs per run,
// so this is a smoke target (rendered / alive / fps / missing), not a pixel target.
import { wait, type Flow } from "../types.ts";

const N = (x: number, y: number) => ({ x: x / 720, y: y / 1280 });
// Camera-space anchors measured on the fullscreen title screen.
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
  clock: "pinned",
  steps: [
    { id: "splash", label: "Launch — splash", action: { type: "launch" }, wait: wait.sample(1200) },
    { id: "title", label: "Title — bobbing bird", action: { type: "settle" },
      wait: wait.state({ kind: "perf", counter: "glFrames", atLeast: 30 }, 3000),
      fastEvidence: { kind: "motion" } },
    // The title buttons remain active through the fade; wait before sending gameplay taps.
    { id: "play", label: "Play → Get Ready", action: { type: "tapAt", ...PLAY_BTN }, wait: wait.sample(1500) },
    // ~2.7s of live gameplay with no capture inside it: the perf window.
    { id: "flaps", label: "Start + 5 flaps", action: { type: "tapAt", ...CENTER, repeat: 6, everyMs: 600 }, wait: wait.sample() },
    { id: "dead", label: "Game over — score/medal", action: { type: "settle" }, wait: wait.sample(3500),
      fastEvidence: { kind: "motion" } },
    { id: "restart", label: "Play again → Get Ready", action: { type: "tapAt", ...PLAY_BTN }, wait: wait.sample(1500) },
    { id: "flaps2", label: "Second game — 3 flaps", action: { type: "tapAt", ...CENTER, repeat: 4, everyMs: 600 }, wait: wait.sample() },
  ],
};
