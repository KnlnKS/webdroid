// Reddit smoke flow, logged out. This build requires an account for any content (deep links and
// the welcome screen both end in the sign-up sheet), so the flow covers what a guest can reach:
// the welcome screen, its sign-up and login sheets, and the One Tap sheet microG shows first.
// Compose draws through canvas ops with no host-view text, so every tap is positional and the
// flow pins the screen it was measured at. Its reference is launch-only: a run compares the
// launch step and is otherwise smoke.
import { pixelsOn, wait, type Flow, type Screen, type StateCondition } from "../types.ts";

const SCREEN: Screen = { width: 1080, height: 2160, densityDpi: 480 };
const ONE_TAP = "Add Google account";
const live = (horizonMs: number, condition: StateCondition) => ({ ...wait.live(horizonMs), condition });
const { point } = pixelsOn(SCREEN);
const tap = (x: number, y: number) => ({ type: "tapAt" as const, ...point(x, y) });

export const reddit: Flow = {
  app: "reddit",
  pkg: "com.reddit.frontpage",
  activity: "com.reddit.launch.main.MainActivity",
  apk: "Reddit.xapk",
  screen: SCREEN,
  crop: { top: 0, bottom: 0, left: 0, right: 0 },
  clock: "live",
  steps: [
    // the welcome screen asks for One Tap sign-in, and microG answers with its "Add Google
    // account" sheet from its own process, seconds later here: until it shows, taps still reach
    // the paused welcome screen, so the sheet is awaited and dismissed before any tap
    { id: "launch", label: "Launch — welcome behind the One Tap sheet", action: { type: "launch" }, wait: live(25_000, { kind: "text", text: ONE_TAP }), liveWait: wait.state({ kind: "text", text: "Get Started" }, 0, 18_000),
      evidence: { kind: "visual", maxContentDiffPct: 4 } },
    { id: "dismiss-one-tap", label: "Back dismisses the One Tap sheet — welcome screen", action: { type: "back", whileText: ONE_TAP, appearMs: 15_000 }, wait: live(5000, { kind: "all", conditions: [{ kind: "text", text: "Get Started" }, { kind: "text-absent", text: ONE_TAP }] }),
      liveWait: wait.state({ kind: "all", conditions: [{ kind: "text", text: "Get Started" }, { kind: "text-absent", text: ONE_TAP }] }, 0, 4_000) },
    { id: "get-started", label: "Get Started — sign-up sheet", action: tap(540, 1837), wait: live(4000, { kind: "text", text: "Continue with phone number" }), liveWait: wait.state({ kind: "text", text: "Continue with phone number" }, 0, 6_000) },
    // the sheet slides out bottom row first, and still takes taps until its top row is gone
    { id: "sign-up-back", label: "Back closes the sign-up sheet", action: { type: "back" }, wait: live(3000, { kind: "text-absent", text: "Continue with Google" }),
      liveWait: wait.state({ kind: "text-absent", text: "Continue with Google" }, 0, 4_000) },
    { id: "have-account", label: "I already have an account — login sheet", action: tap(540, 1983), wait: live(4000, { kind: "text", text: "Use email or username" }), liveWait: wait.state({ kind: "text", text: "Use email or username" }, 0, 6_000) },
    { id: "login-back", label: "Back closes the login sheet — welcome screen", action: { type: "back" }, wait: live(3000, { kind: "text-absent", text: "Use email or username" }), liveWait: wait.state({ kind: "text-absent", text: "Use email or username" }, 0, 4_000) },
  ],
};
