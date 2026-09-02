// Harmonic for Hacker News (Java/Kotlin, no native code). The front page is live data — the
// HN API arrives over the dev server's /tcp relay — so this flow needs the server's network
// and is a smoke target (rendered / alive / missing), never a pixel one.
// Accepted newMissing: `class androidx/window/extensions/WindowExtensionsProvider` — an
// optional system <uses-library> absent on most real devices too; the app catches the NCDFE.
import type { Flow } from "../types";

const N = (x: number, y: number) => ({ x: x / 720, y: y / 1280 });
const P = (x: number, y: number): [number, number] => [x / 720, y / 1280];

export const harmonic: Flow = {
  app: "harmonic",
  pkg: "com.simon.harmonichackernews",
  activity: "com.simon.harmonichackernews.MainActivity",
  apk: "harmonic.apk",
  // status bar [0,48) and gesture bar [1232,1280) — the split fitnotes verified on-device
  crop: { top: 48, bottom: 48, left: 0, right: 0 },
  steps: [
    { id: "launch", label: "Launch — front page loads", action: { type: "launch" }, settleDelayMs: 6000 },
    { id: "front", label: "Front page — story rows", action: { type: "settle" } },
    { id: "story", label: "First story row → comments", action: { type: "tapAt", ...N(360, 300) }, settleDelayMs: 4000 },
    { id: "back", label: "Back to the front page", action: { type: "back" } },
    { id: "scroll", label: "Scroll the front page", action: { type: "swipe", from: P(360, 1000), to: P(360, 400) } },
    { id: "scrolled", label: "Scrolled front page", action: { type: "settle" } },
  ],
};
