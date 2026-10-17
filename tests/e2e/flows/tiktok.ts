// TikTok's guest For You feed. There are no goldens and no stable text anchors on a video feed,
// so every step is positional at the pinned screen, the launch settles for as long as the app
// takes to reach the feed, and the video steps are captured once after their dwell (a playing
// video never holds still).
import { wait, type Flow, type Screen } from "../types.ts";

const SCREEN: Screen = { width: 1080, height: 2160, densityDpi: 480 };
const at = (x: number, y: number): [number, number] => [x / SCREEN.width, y / SCREEN.height];
const xy = (x: number, y: number) => ({ x: x / SCREEN.width, y: y / SCREEN.height });
const swipeUp = { type: "swipe" as const, from: at(540, 1600), to: at(540, 500), ms: 300 };

export const tiktok: Flow = {
  app: "tiktok",
  pkg: "com.zhiliaoapp.musically",
  activity: "com.ss.android.ugc.aweme.splash.SplashActivity",
  apk: "TikTok.apk",
  screen: SCREEN,
  crop: { top: 0, bottom: 0, left: 0, right: 0 },
  clock: "live",
  steps: [
    { id: "launch", label: "Launch — splash to first-run gates", action: { type: "launch" }, wait: wait.liveSample(90000), fastWait: wait.state({ kind: "text", text: "Agree and continue" }, 0, 20_000) },
    { id: "fullscreen", label: "Dismiss Android's full-screen notice", action: { type: "tapText", text: "Got it", optional: true }, wait: wait.liveSample(1500) },
    { id: "signup", label: "Skip guest sign-up", action: { type: "tapText", text: "Skip", optional: true }, wait: wait.liveSample(1500) },
    // the birthdate wheel starts at today: three flings of the year column reach an adult's year
    { id: "birthdate", label: "Pick an adult birthdate", action: { type: "swipe", from: at(840, 1150), to: at(840, 1900), ms: 120, maxSwipes: 3, whileText: "When’s your birthdate", appearMs: 3000 }, wait: wait.liveSample(1500) },
    { id: "birthdate-continue", label: "Continue past the birthdate", action: { type: "tapAt", ...xy(540, 1869), whileText: "When’s your birthdate" }, wait: wait.liveSample(1500) },
    { id: "age", label: "Confirm guest age", action: { type: "tapText", text: "At least 18", optional: true }, wait: wait.liveSample(1500) },
    { id: "consent", label: "Agree and continue", action: { type: "tapText", text: "Agree and continue", optional: true }, wait: wait.liveSample(3000) },
    { id: "notifications", label: "Decline notifications", action: { type: "tapText", text: "Don’t allow", optional: true }, wait: wait.liveSample(1500) },
    { id: "interests", label: "Skip interest selection", action: { type: "tapText", text: "Skip", optional: true }, wait: wait.liveSample(20000) },
    { id: "feed", label: "For You feed playing", action: { type: "settle" }, wait: wait.liveSample(10000) },
    { id: "resume", label: "Video resumes after backgrounding", action: { type: "background", ms: 1000 }, wait: wait.liveSample(10000) },
    { id: "swipe", label: "Swipe up to the next video", action: swipeUp, wait: wait.liveSample(10000) },
    { id: "video", label: "Second video playing", action: { type: "settle" }, wait: wait.liveSample(5000) },
    { id: "swipe-again", label: "Swipe up to a third video", action: swipeUp, wait: wait.liveSample(10000) },
    { id: "video-after-second-swipe", label: "Third video playing", action: { type: "settle" }, wait: wait.liveSample(5000) },
  ],
};
