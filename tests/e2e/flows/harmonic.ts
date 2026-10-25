// Harmonic for Hacker News (Java/Kotlin, no native code) — appcompat + Material 3 Expressive,
// RecyclerView, androidx preference. The front page is live data (the HN API arrives over the
// dev server's /proxy), so those steps carry `maskRects` and the flow's real pixel signal comes
// from the screens the app draws entirely from its own resources: the first-run welcome dialog
// and Settings.
// Observed boot: MainActivity's story list loads behind a first-run AlertDialog ("Welcome to
// Harmonic for Hacker News") built by MaterialAlertDialogBuilder.setView(ScrollView) — no title,
// no message, no dialog buttons; the whole dialog is that one custom view, which is taller than
// the card, so "Get started" only comes into reach after scrolling it. Its UI-preset toggle
// (Expressive / Simple) picks the app's fonts and card style. Once dismissed, the front page is
// a Material search bar over a RecyclerView of story rows (title / points • domain • age /
// comment count); the overflow reaches Settings, which is offline and deterministic.
// Accepted newMissing: `class androidx/window/extensions/WindowExtensionsProvider` — the
// optional <uses-library> the foldable split layout wants, absent on most real devices too.
import { PHONE_720, pixelsOn, wait, type Flow } from "../types.ts";

const { point: N, pair: P, rect: R } = pixelsOn(PHONE_720);

// The story list is live HN, so it is masked away and these steps score the chrome around it.
const LIST = [R(0, 282, 720, 998)];
// Everything outside the welcome dialog's card — the same live list, dimmed by the scrim.
const AROUND_CARD = [R(0, 0, 720, 212), R(0, 1072, 720, 208), R(0, 212, 68, 860), R(652, 212, 68, 860)];
// The comments screen is one live story: its preview image, title, meta line and replies all
// change under the golden. What does not is the action row (profile / save / share / refresh /
// overflow), so that strip is the only part left compared.
const COMMENTS = [R(0, 90, 720, 610), R(0, 780, 720, 500)];

export const harmonic: Flow = {
  app: "harmonic",
  pkg: "com.simon.harmonichackernews",
  activity: "com.simon.harmonichackernews.MainActivity",
  apk: "harmonic.apk",
  // the HN API is HTTPS: a device pinned to a past instant rejects every current certificate
  // and the app records its "Loading failed" state instead of its real UI
  clock: "live",
  // status bar [0,48) and gesture bar [1232,1280) — the split fitnotes verified on-device
  screen: PHONE_720,
  crop: { top: 48, bottom: 48, left: 0, right: 0 },
  steps: [
    { id: "launch", label: "Launch — welcome dialog over the loading front page", action: { type: "launch" }, wait: wait.live(6000), liveWait: wait.state({ kind: "text", text: "Get started" }, 0, 18_000), maskRects: AROUND_CARD,
      evidence: { kind: "visual", maxContentDiffPct: 19 } },
    { id: "welcome-scroll", label: "Scroll the welcome dialog to its button", action: { type: "swipe", from: P(360, 1000), to: P(360, 300) }, maskRects: AROUND_CARD, wait: wait.live() },
    { id: "preset-simple", label: "Pick the Simple UI preset", action: { type: "tapText", text: "Simple" }, maskRects: AROUND_CARD, wait: wait.live() },
    { id: "preset-expressive", label: "Back to the Expressive preset", action: { type: "tapText", text: "Expressive" }, maskRects: AROUND_CARD, wait: wait.live() },
    { id: "welcome-dismiss", label: "Get started → dismiss the welcome dialog", action: { type: "tapText", text: "Get started" }, wait: wait.live(2000), maskRects: LIST },
    { id: "front", label: "Front page — story rows", action: { type: "settle" }, wait: wait.live(2000), maskRects: LIST },
    { id: "overflow", label: "Open the overflow menu", action: { type: "tapText", text: "More options" }, wait: wait.live() },
    { id: "settings", label: "Settings", action: { type: "tapText", text: "Settings" }, wait: wait.live(2000) },
    { id: "settings-scroll", label: "Scroll the settings list", action: { type: "swipe", from: P(360, 1000), to: P(360, 500) }, wait: wait.live() },
    { id: "settings-back", label: "Back to the front page", action: { type: "back" }, wait: wait.live(2000), maskRects: LIST },
    // the comment count, not the title: tapping the title opens the article in a WebView, whose
    // pixels the canvas capture cannot see at all
    { id: "comments", label: "Comment count → the comments screen", action: { type: "tapAt", ...N(645, 395) }, wait: wait.live(5000), maskRects: COMMENTS },
    { id: "back", label: "Back to the front page", action: { type: "back" }, wait: wait.live(2000), maskRects: LIST },
    { id: "scroll", label: "Scroll the front page", action: { type: "swipe", from: P(360, 1000), to: P(360, 400) }, maskRects: LIST, wait: wait.live() },
    { id: "scrolled", label: "Scrolled front page", action: { type: "settle" }, maskRects: LIST, wait: wait.live() },
  ],
};
