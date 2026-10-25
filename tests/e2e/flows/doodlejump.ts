// Doodle Jump Christmas (Marmalade, 2013) exercises ARM32 native execution.
// The fullscreen game loop never settles, so gameplay steps use animated captures.
import { PHONE_720, pixelsOn, wait, type Flow } from "../types.ts";

const { point: N } = pixelsOn(PHONE_720);
const PLAY = N(360, 560);      // the title screen's "play" button
const CENTER = N(360, 640);

export const doodlejump: Flow = {
  app: "doodlejump",
  pkg: "com.lima.doodlejumpcs",
  activity: "com.lima.doodlejumpcs.Main",
  apk: "DoodleJumpChrismas.apk",
  crop: { top: 0, bottom: 48, left: 0, right: 0 },
  minFps: 30,
  clock: "pinned",
  steps: [
    { id: "launch", label: "Launch — loader", action: { type: "launch" }, wait: wait.sample(3000) },
    // the game decodes every texture at startup (~11G guest instructions) before its GL loop starts
    { id: "title", label: "Title screen", action: { type: "settle" }, wait: wait.state({ kind: "perf", counter: "glFrames", atLeast: 60 }, 0, 60_000),
      evidence: { kind: "motion" } },
    { id: "play", label: "Title → play", action: { type: "tapAt", ...PLAY }, wait: wait.sample(1500) },
    // ~3s of gameplay taps with no capture inside it: the perf window
    { id: "taps", label: "5 taps in play", action: { type: "tapAt", ...CENTER, repeat: 5, everyMs: 600 }, wait: wait.sample() },
    { id: "playing", label: "Gameplay frame", action: { type: "settle" }, wait: wait.sample(3000),
      evidence: { kind: "motion" } },
    { id: "back", label: "Back", action: { type: "back" }, wait: wait.quiescent() },
  ],
};
