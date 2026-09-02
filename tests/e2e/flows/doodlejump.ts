// Doodle Jump Christmas (Marmalade, 2013): the game is ARM32 native code (libdoodlejumpcs.so
// running assets/DoodleJump.s3e), so until the native layer (src/native) lands this is an
// HONEST-BOOT target — LoaderActivity.onCreate → System.loadLibrary → UnsatisfiedLinkError
// with the shell's #native line, nothing wedges. Accepted newMissing until then: the
// `[native]` entries for com/ideaworks3d/marmalade/LoaderThread (initNative, runNative, …).
// Fullscreen theme (Theme.Black.NoTitleBar.Fullscreen): crop top 0. The game never settles,
// so every step is `animated`; minFps 30 is the M3 (playable) gate.
import type { Flow } from "../types";

const N = (x: number, y: number) => ({ x: x / 720, y: y / 1280 });
const CENTER = N(360, 640);

export const doodlejump: Flow = {
  app: "doodlejump",
  pkg: "com.lima.doodlejumpcs",
  activity: "com.lima.doodlejumpcs.Main",
  apk: "DoodleJumpChrismas.apk",
  crop: { top: 0, bottom: 48, left: 0, right: 0 },
  minFps: 30,
  steps: [
    { id: "launch", label: "Launch — loader", action: { type: "launch" }, settleDelayMs: 3000, animated: true },
    { id: "title", label: "Title screen", action: { type: "settle" }, settleDelayMs: 3000, animated: true },
    { id: "play", label: "Title → play", action: { type: "tapAt", ...CENTER }, settleDelayMs: 1500, animated: true },
    // ~3s of gameplay taps with no capture inside it: the perf window
    { id: "taps", label: "5 taps in play", action: { type: "tapAt", ...CENTER, repeat: 5, everyMs: 600 }, animated: true },
    { id: "playing", label: "Gameplay frame", action: { type: "settle" }, settleDelayMs: 3000, animated: true },
    { id: "back", label: "Back", action: { type: "back" } },
  ],
};
