// Flutter's native framebuffer has no host view text anchors. Exercise stable offline tools.
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
  ],
};
