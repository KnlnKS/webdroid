// Reddit smoke flow, logged out. This build requires an account for any content (deep links and
// the welcome screen both end in the sign-up sheet), so the flow covers what a guest can reach:
// the welcome screen, its sign-up and login sheets, and the One Tap sheet microG shows first.
// Compose draws through canvas ops with no host-view text, so every tap is positional and the
// flow pins the screen it was measured at. No goldens: it runs as smoke.
import { wait, type Flow, Screen } from "../types";

const SCREEN: Screen = { width: 1080, height: 2160, densityDpi: 480 };
const tap = (x: number, y: number) => ({ type: "tapAt" as const, x: x / SCREEN.width, y: y / SCREEN.height });

export const reddit: Flow = {
  app: "reddit",
  pkg: "com.reddit.frontpage",
  activity: "com.reddit.launch.main.MainActivity",
  apk: "Reddit.xapk",
  screen: SCREEN,
  crop: { top: 0, bottom: 0, left: 0, right: 0 },
  clock: "live",
  quickWait: wait.state({ kind: "text", text: "Get Started" }, 0, 18_000),
  steps: [
    // the launch ends under microG's "Add Google account" sheet in its own process; the main
    // realm's welcome activity is stopped beneath it
    { id: "launch", label: "Launch — welcome behind the One Tap sheet", action: { type: "launch" }, wait: wait.live(25000),
      fastEvidence: { kind: "visual", maxContentDiffPct: 4 } },
    { id: "dismiss-one-tap", label: "Back dismisses the One Tap sheet — welcome screen", action: { type: "back" }, wait: wait.live(5000) },
    { id: "get-started", label: "Get Started — sign-up sheet", action: tap(540, 1837), wait: wait.live(4000) },
    { id: "sign-up-back", label: "Back closes the sign-up sheet", action: { type: "back" }, wait: wait.live(3000) },
    { id: "have-account", label: "I already have an account — login sheet", action: tap(540, 1983), wait: wait.live(4000) },
    { id: "login-back", label: "Back closes the login sheet — welcome screen", action: { type: "back" }, wait: wait.live(3000) },
  ],
};
