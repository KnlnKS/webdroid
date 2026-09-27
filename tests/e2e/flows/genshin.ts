// Genshin Impact (Unity 2017 IL2CPP, ARM64) exercises a large native game: its bundled Play Games
// client asks microG for a Google sign-in first, and the HoYoverse login panel then opens over the
// animated Celestia scene. Signing in needs a real account and a captcha, so the flow stops there.
import { wait, type Flow, type Screen } from "../types";

const screen: Screen = { width: 2160, height: 1080, densityDpi: 480 };

export const genshin: Flow = {
  app: "genshin",
  pkg: "com.miHoYo.GenshinImpact",
  activity: "com.miHoYo.GetMobileInfo.MainActivity",
  apk: "Genshin Impact.xapk",
  screen,
  crop: { top: 0, bottom: 0, left: 0, right: 0 },
  minFps: 30,
  clock: "live",
  steps: [
    // the prompt belongs to microG's process, whose text the harness's main-process probe cannot see
    { id: "launch", label: "Play Games sign-in prompt", action: { type: "launch" }, wait: wait.live(30_000), fastWait: wait.liveSample(30_000) },
    { id: "cancel", label: "Decline the Google sign-in", action: { type: "tapAt", x: 0.09, y: 0.86 },
      wait: wait.live(60_000), fastWait: wait.state({ kind: "text", text: "Forgot password?" }, 0, 180_000) },
    { id: "login", label: "HoYoverse login over the Celestia scene", action: { type: "settle" }, wait: wait.liveSample(5_000) },
  ],
};
