// Harmonic for Hacker News (Java/Kotlin, no native code). The front page is live data — the
// HN API arrives over the dev server's /proxy (Volley's HttpURLConnection) — so this flow needs
// the server's network and is a smoke target (rendered / alive / missing), never a pixel one.
// Observed boot: MainActivity's story list starts loading behind a first-run AlertDialog
// ("Welcome to Harmonic for Hacker News") whose custom view is a ScrollView taller than the
// card; its "Get started" button only comes into reach after scrolling that dialog. Once
// dismissed, the front page is a Material toolbar ("Top Stories" spinner, search, overflow)
// over a RecyclerView of story rows (title / points • domain • age / comment count); the
// first row's title sits at y≈300 in the 720x1280 frame.
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
    { id: "launch", label: "Launch — welcome dialog over the loading front page", action: { type: "launch" }, settleDelayMs: 6000 },
    { id: "welcome-scroll", label: "Scroll the welcome dialog to its button", action: { type: "swipe", from: P(360, 1000), to: P(360, 300) } },
    { id: "welcome-dismiss", label: "Get started → dismiss the welcome dialog", action: { type: "tapText", text: "Get started" }, settleDelayMs: 2000 },
    { id: "front", label: "Front page — story rows", action: { type: "settle" } },
    { id: "story", label: "First story row → comments", action: { type: "tapAt", ...N(360, 300) }, settleDelayMs: 4000 },
    { id: "back", label: "Back to the front page", action: { type: "back" } },
    { id: "scroll", label: "Scroll the front page", action: { type: "swipe", from: P(360, 1000), to: P(360, 400) } },
    { id: "scrolled", label: "Scrolled front page", action: { type: "settle" } },
  ],
};
