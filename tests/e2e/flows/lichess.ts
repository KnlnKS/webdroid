// Flutter's native framebuffer has no host view text anchors, so every tap is positional and the
// flow pins the screen they were measured at.
import { pixelsOn, wait, type Flow, type Screen } from "../types.ts";

const SCREEN: Screen = { width: 1080, height: 2424, densityDpi: 480 };
const { pair: at } = pixelsOn(SCREEN);
const tap = (x: number, y: number) => { const [nx, ny] = at(x, y); return { type: "tapAt" as const, x: nx, y: ny }; };
const swipe = (from: [number, number], to: [number, number]) => ({ type: "swipe" as const, from: at(...from), to: at(...to), ms: 300 });
const dp = (n: number) => n * SCREEN.densityDpi / 160;
const navY = SCREEN.height - dp(64);
const boardY = (ranks: number) => 0.5 + ranks * SCREEN.width / (8 * SCREEN.height);

export const lichess: Flow = {
  app: "lichess",
  pkg: "org.lichess.mobileV2",
  activity: "org.lichess.mobileV2.MainActivity",
  apk: "lichess.apk",
  screen: SCREEN,
  crop: { top: 0, bottom: 48, left: 0, right: 0 },
  clock: "live",
  steps: [
    { id: "launch", label: "Launch — Flutter home", action: { type: "launch" }, wait: wait.live(40000), liveWait: wait.state({ kind: "perf", counter: "glFrames", atLeast: 15 }, 0, 20_000),
      evidence: { kind: "visual", maxContentDiffPct: 76 } },
    { id: "tools", label: "More — tools", action: tap(972, navY), wait: wait.live(2000) },
    { id: "editor", label: "Board editor", action: tap(540, dp(324)), wait: wait.live(2000) },
    { id: "pawn", label: "Drag e2 pawn to e4", action: { type: "swipe", from: [0.5625, boardY(2.5)], to: [0.5625, boardY(0.5)], ms: 300 }, wait: wait.live(2000) },
    { id: "back", label: "Back to tools", action: { type: "back" }, wait: wait.live(2000) },
    { id: "home", label: "Home", action: tap(108, navY), wait: wait.live(2000) },
    { id: "play", label: "Play options", action: tap(900, 1980), wait: wait.live(2000) },
    { id: "computer", label: "Computer game setup", action: tap(540, 2000), wait: wait.live(2000) },
    { id: "level", label: "Stockfish level 1", action: tap(195, 1245), wait: wait.live(2000) },
    { id: "side", label: "Choose side", action: tap(750, 1595), wait: wait.live(2000) },
    { id: "white", label: "Play as White", action: tap(400, 925), wait: wait.live(2000) },
    { id: "game", label: "Start native Stockfish game", action: tap(540, 2230), wait: wait.live(5000), liveWait: wait.live(4000, 5000) },
    { id: "e4", label: "e4 and engine reply", action: swipe([608, 1615], [608, 1345]), wait: wait.live(4000), liveWait: wait.live(2000, 5000) },
    { id: "nf3", label: "Nf3 and engine reply", action: swipe([878, 1750], [742, 1480]), wait: wait.live(4000), liveWait: wait.live(2000, 5000) },
    { id: "ne5", label: "Ne5 and engine reply", action: swipe([742, 1480], [608, 1210]), wait: wait.live(4000), liveWait: wait.live(2000, 5000) },
  ],
};
