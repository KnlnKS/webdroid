import { pixelsOn, wait, type Flow, type Screen } from "../types.ts";

const screen: Screen = { width: 1080, height: 2160, densityDpi: 480 };
const { point, pair } = pixelsOn(screen);
const film = "Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film Blender";
const fastFilm = "Big Buck Bunny 60fps 4K - Official Blender Foundation";

export const youtube: Flow = {
  app: "youtube",
  pkg: "com.google.android.youtube",
  activity: "com.google.android.youtube.app.application.Shell$HomeActivity",
  apk: "YouTube.xapk",
  screen,
  crop: { top: 72, bottom: 72, left: 0, right: 0 },
  clock: "live",
  steps: [
    { id: "launch", label: "Launch YouTube", action: { type: "launch" }, wait: wait.live(30000), liveWait: wait.state({ kind: "text", text: "Search YouTube" }, 0, 18_000),
      evidence: { kind: "visual", maxContentDiffPct: 82 } },
    { id: "notifications", label: "Continue without notifications", action: { type: "tapText", text: "Don’t allow", optional: true }, wait: wait.live(10000) },
    { id: "home", label: "Guest Home", action: { type: "settle" }, wait: wait.live(10000) },
    { id: "search-open", label: "Open search", action: { type: "tapText", text: "Search" }, wait: wait.live(3000) },
    { id: "search-type", label: "Type Big Buck Bunny", action: { type: "typeInto", ...point(576, 144), text: "Big Buck Bunny 60fps 4K" }, wait: wait.live(1000) },
    { id: "search-go", label: "Search results", action: { type: "tapAt", ...point(576, 288) }, wait: wait.live(15000), liveWait: wait.state({ kind: "text", text: "Go to channel" }, 0, 15_000) },
    { id: "results-swipe", label: "Reveal the first film result", action: { type: "swipe", from: pair(540, 1500), to: pair(540, 900), ms: 400, untilText: film, maxSwipes: 8 }, liveAction: { type: "swipe", from: pair(540, 1500), to: pair(540, 900), ms: 400, untilText: fastFilm, maxSwipes: 8 }, wait: wait.live(3000) },
    // the film's card, wherever a sponsored card above it (up to 1600 px tall) leaves it
    { id: "video-open", label: "Open Big Buck Bunny", action: { type: "tapAt", ...point(540, 1350) }, liveAction: { type: "tapText", text: fastFilm }, wait: wait.liveSample(15000), liveWait: wait.state({ kind: "text", text: "Subscribe" }, 0, 15_000) },
    { id: "show-controls", label: "Show player controls", action: { type: "tapAt", ...point(540, 360) }, wait: wait.live(12000), liveWait: wait.state({ kind: "text", text: "Pause video" }, 0, 6_000) },
    { id: "pause", label: "Pause playback", action: { type: "tapText", text: "Pause video" }, wait: wait.live(2000), liveWait: wait.state({ kind: "text", text: "Play video" }, 0, 6_000) },
    { id: "resume", label: "Resume playback", action: { type: "tapText", text: "Play video" }, wait: wait.liveSample(1000), liveWait: wait.state({ kind: "text", text: "Pause video" }, 0, 6_000) },
    { id: "fullscreen", label: "Enter fullscreen", action: { type: "tapText", text: "Enter fullscreen" }, wait: wait.liveSample(3000) },
    { id: "fullscreen-back", label: "Exit fullscreen", action: { type: "back" }, wait: wait.live(3000) },
    { id: "video-back", label: "Return home", action: { type: "back" }, wait: wait.live(5000) },
    { id: "shorts", label: "Open Shorts", action: { type: "tapText", text: "Shorts" }, wait: wait.liveSample(10000) },
    { id: "shorts-swipe", label: "Swipe to the next Short", action: { type: "swipe", from: pair(540, 1600), to: pair(540, 600), ms: 300 }, wait: wait.liveSample(5000) },
  ],
};
