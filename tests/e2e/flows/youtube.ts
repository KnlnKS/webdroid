import type { Flow, Screen } from "../types";

const screen: Screen = { width: 1080, height: 2160, densityDpi: 480 };
const point = (x: number, y: number) => ({ x: x / screen.width, y: y / screen.height });
const pair = (x: number, y: number): [number, number] => [x / screen.width, y / screen.height];

export const youtube: Flow = {
  app: "youtube",
  pkg: "com.google.android.youtube",
  activity: "com.google.android.youtube.app.application.Shell$HomeActivity",
  apk: "YouTube.xapk",
  screen,
  crop: { top: 72, bottom: 72, left: 0, right: 0 },
  liveClock: true,
  steps: [
    { id: "launch", label: "Launch YouTube", action: { type: "launch" }, settleDelayMs: 30000 },
    { id: "notifications", label: "Continue without notifications", action: { type: "tapText", text: "Don’t allow", optional: true }, settleDelayMs: 10000 },
    { id: "home", label: "Guest Home", action: { type: "settle" }, settleDelayMs: 10000 },
    { id: "search-open", label: "Open search", action: { type: "tapText", text: "Search" }, settleDelayMs: 3000 },
    { id: "search-type", label: "Type Big Buck Bunny", action: { type: "typeInto", ...point(576, 144), text: "Big Buck Bunny" }, settleDelayMs: 1000 },
    { id: "search-go", label: "Search results", action: { type: "tapAt", ...point(576, 288) }, settleDelayMs: 15000 },
    { id: "results-swipe", label: "Reveal the first film result", action: { type: "swipe", from: pair(540, 1600), to: pair(540, 600), ms: 400, untilText: "Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film", maxSwipes: 4 }, settleDelayMs: 3000 },
    { id: "video-open", label: "Open Big Buck Bunny", action: { type: "tapText", text: "Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film" }, settleDelayMs: 15000, animated: true },
    { id: "show-controls", label: "Show player controls", action: { type: "tapAt", ...point(540, 360) }, settleDelayMs: 1000 },
    { id: "pause", label: "Pause playback", action: { type: "tapText", text: "Pause video" }, settleDelayMs: 2000 },
    { id: "resume", label: "Resume playback", action: { type: "tapText", text: "Play video" }, settleDelayMs: 3000, animated: true },
    { id: "fullscreen", label: "Enter fullscreen", action: { type: "tapText", text: "Enter fullscreen" }, settleDelayMs: 3000, animated: true },
    { id: "fullscreen-back", label: "Exit fullscreen", action: { type: "back" }, settleDelayMs: 3000 },
    { id: "video-back", label: "Return home", action: { type: "back" }, settleDelayMs: 5000 },
    { id: "shorts", label: "Open Shorts", action: { type: "tapText", text: "Shorts" }, settleDelayMs: 10000, animated: true },
    { id: "shorts-swipe", label: "Swipe to the next Short", action: { type: "swipe", from: pair(540, 1600), to: pair(540, 600), ms: 300 }, settleDelayMs: 5000, animated: true },
  ],
};
