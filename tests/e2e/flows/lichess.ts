// Flutter's native framebuffer has no host view text anchors.
import type { Flow } from "../types";
import { device } from "../../../src/shell/config";

const boardY = (ranks: number) => 0.5 + ranks * device.width / (8 * device.height);

export const lichess: Flow = {
  app: "lichess",
  pkg: "org.lichess.mobileV2",
  activity: "org.lichess.mobileV2.MainActivity",
  apk: "lichess.apk",
  crop: { top: 0, bottom: 48, left: 0, right: 0 },
  liveClock: true,
  steps: [
    { id: "launch", label: "Launch — Flutter home", action: { type: "launch" }, settleDelayMs: 40000 },
    { id: "tools", label: "More — tools", action: { type: "tapAt", x: 0.9, y: 1 - device.dp(64) / device.height }, settleDelayMs: 2000 },
    { id: "editor", label: "Board editor", action: { type: "tapAt", x: 0.5, y: device.dp(324) / device.height }, settleDelayMs: 2000 },
    { id: "pawn", label: "Drag e2 pawn to e4", action: { type: "swipe", from: [0.5625, boardY(2.5)], to: [0.5625, boardY(0.5)], ms: 300 }, settleDelayMs: 2000 },
    { id: "back", label: "Back to tools", action: { type: "back" }, settleDelayMs: 2000 },
    { id: "home", label: "Home", action: { type: "tapAt", x: 0.1, y: 1 - device.dp(64) / device.height }, settleDelayMs: 2000 },
    { id: "play", label: "Play options", action: { type: "tapAt", x: 900 / 1080, y: 1980 / 2424 }, settleDelayMs: 2000 },
    { id: "computer", label: "Computer game setup", action: { type: "tapAt", x: 0.5, y: 2000 / 2424 }, settleDelayMs: 2000 },
    { id: "level", label: "Stockfish level 1", action: { type: "tapAt", x: 195 / 1080, y: 1245 / 2424 }, settleDelayMs: 2000 },
    { id: "side", label: "Choose side", action: { type: "tapAt", x: 750 / 1080, y: 1595 / 2424 }, settleDelayMs: 2000 },
    { id: "white", label: "Play as White", action: { type: "tapAt", x: 400 / 1080, y: 925 / 2424 }, settleDelayMs: 2000 },
    { id: "game", label: "Start native Stockfish game", action: { type: "tapAt", x: 0.5, y: 2230 / 2424 }, settleDelayMs: 5000 },
    { id: "e4", label: "e4 and engine reply", action: { type: "swipe", from: [608 / 1080, 1615 / 2424], to: [608 / 1080, 1345 / 2424], ms: 300 }, settleDelayMs: 4000 },
    { id: "nf3", label: "Nf3 and engine reply", action: { type: "swipe", from: [878 / 1080, 1750 / 2424], to: [742 / 1080, 1480 / 2424], ms: 300 }, settleDelayMs: 4000 },
    { id: "ne5", label: "Ne5 and engine reply", action: { type: "swipe", from: [742 / 1080, 1480 / 2424], to: [608 / 1080, 1210 / 2424], ms: 300 }, settleDelayMs: 4000 },
  ],
};
