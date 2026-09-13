// TikTok's guest For You feed. There are no goldens and no stable text anchors on a video feed,
// so every step is positional at the pinned screen, the launch settles for as long as the app
// takes to reach the feed, and the video steps are captured once after their dwell (a playing
// video never holds still).
import type { Flow, Screen } from "../types";

const SCREEN: Screen = { width: 1080, height: 2160, densityDpi: 480 };
const at = (x: number, y: number): [number, number] => [x / SCREEN.width, y / SCREEN.height];
const swipeUp = { type: "swipe" as const, from: at(540, 1600), to: at(540, 500), ms: 300 };

export const tiktok: Flow = {
  app: "tiktok",
  pkg: "com.zhiliaoapp.musically",
  activity: "com.ss.android.ugc.aweme.splash.SplashActivity",
  apk: "TikTok.apk",
  screen: SCREEN,
  crop: { top: 0, bottom: 0, left: 0, right: 0 },
  liveClock: true,
  steps: [
    { id: "launch", label: "Launch — splash to first-run gates", action: { type: "launch" }, settleDelayMs: 90000, animated: true },
    { id: "fullscreen", label: "Dismiss Android's full-screen notice", action: { type: "tapText", text: "Got it", optional: true }, settleDelayMs: 1500, animated: true },
    { id: "signup", label: "Skip guest sign-up", action: { type: "tapText", text: "Skip", optional: true }, settleDelayMs: 1500, animated: true },
    { id: "age", label: "Confirm guest age", action: { type: "tapText", text: "At least 18", optional: true }, settleDelayMs: 1500, animated: true },
    { id: "consent", label: "Agree and continue", action: { type: "tapText", text: "Agree and continue", optional: true }, settleDelayMs: 3000, animated: true },
    { id: "notifications", label: "Decline notifications", action: { type: "tapText", text: "Don’t allow", optional: true }, settleDelayMs: 1500, animated: true },
    { id: "interests", label: "Skip interest selection", action: { type: "tapText", text: "Skip", optional: true }, settleDelayMs: 20000, animated: true },
    { id: "feed", label: "For You feed playing", action: { type: "settle" }, settleDelayMs: 10000, animated: true },
    { id: "resume", label: "Video resumes after backgrounding", action: { type: "background", ms: 1000 }, settleDelayMs: 10000, animated: true },
    { id: "swipe", label: "Swipe up to the next video", action: swipeUp, settleDelayMs: 10000, animated: true },
    { id: "video", label: "Second video playing", action: { type: "settle" }, settleDelayMs: 5000, animated: true },
    { id: "swipe-again", label: "Swipe up to a third video", action: swipeUp, settleDelayMs: 10000, animated: true },
    { id: "video-after-second-swipe", label: "Third video playing", action: { type: "settle" }, settleDelayMs: 5000, animated: true },
  ],
};
