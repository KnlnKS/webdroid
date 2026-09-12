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
    { id: "launch", label: "Launch — splash to the consent notice", action: { type: "launch" }, settleDelayMs: 90000, animated: true },
    // a first launch asks for consent before the feed; a profile that already agreed has no such text
    { id: "consent", label: "Agree and continue", action: { type: "tapText", text: "Agree and continue" }, settleDelayMs: 90000, animated: true },
    { id: "feed", label: "For You feed playing", action: { type: "settle" }, settleDelayMs: 20000, animated: true },
    { id: "swipe", label: "Swipe up to the next video", action: swipeUp, settleDelayMs: 15000, animated: true },
    { id: "video", label: "Next video playing", action: { type: "settle" }, settleDelayMs: 10000, animated: true },
  ],
};
