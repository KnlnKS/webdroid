// Mihon flows — authored against live uiautomator dumps on webdroid_ref.
//
// Split in two because Mihon's onboarding hard-gates on a system file picker (DocumentsUI),
// which is not Mihon UI and which webdroid could never render. Capturing those screens would
// pollute the metric with a diff against a different app entirely.
//
//   mihon-onboarding : fresh install, the Compose onboarding screens webdroid actually reaches.
//   mihon-app        : the real app. The recorder seeds Mihon's four onboarding preferences
//                      (see seedPrefs) so the emulator starts at the Library with a pinned
//                      Light/Default theme — no picker, no wallpaper-derived Material You
//                      colours, fully deterministic.
//
// Every screen here is offline-reachable: the reproducible gate runs without a network, so
// Browse/Extensions would be an unreachable target rather than a fair one.
import { wait, type Flow } from "../types.ts";

const N = (x: number, y: number) => ({ x: x / 720, y: y / 1280 });

const PKG = "app.mihon";
const ACTIVITY = "eu.kanade.tachiyomi.ui.main.MainActivity";

/**
 * Preferences that mark onboarding complete. Written by the recorder with root before the
 * mihon-app flow launches. The storage URI need not resolve — it only gates onboarding;
 * downloads and backups are never exercised by this flow.
 */
const SEED_PREFS = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="__APP_STATE_storage_dir">content://com.android.externalstorage.documents/tree/primary%3ADocuments/document/primary%3ADocuments</string>
    <string name="pref_theme_mode_key">LIGHT</string>
    <string name="pref_app_theme">DEFAULT</string>
    <boolean name="__APP_STATE_onboarding_complete" value="true" />
</map>`;

const CROP = { top: 48, bottom: 48, left: 0, right: 0 };

export const mihonOnboarding: Flow = {
  app: "mihon-onboarding",
  pkg: PKG,
  activity: ACTIVITY,
  apk: "mihon-v0.20.4.apk",
  crop: CROP,
  clock: "pinned",
  steps: [
    // Mihon shows a static splash for several seconds; without a floor here the settle
    // heuristic locks onto the splash and records THAT as the golden.
    { id: "launch", label: "Launch — Welcome / theme picker", action: { type: "launch" },
      wait: wait.state({ kind: "perf", counter: "presentations", atLeast: 2 }, 0) },
    // Pin the theme explicitly: the default "Dynamic" derives Material You colours from the
    // wallpaper, which is not a thing webdroid can or should reproduce.
    { id: "theme-light", label: "Choose Light mode", action: { type: "tapText", text: "Light" }, wait: wait.quiescent(900) },
    { id: "theme-default", label: "Choose Default theme", action: { type: "tapAt", ...N(177, 870) }, wait: wait.quiescent(900) },
    { id: "onboarding-next", label: "Next — storage step", action: { type: "tapText", text: "Next" }, wait: wait.quiescent(1200) },
    { id: "storage-step", label: "Storage step (picker not entered)", action: { type: "settle" }, wait: wait.quiescent(),
      fastEvidence: { kind: "visual", maxContentDiffPct: 29 } },
  ],
};

export const mihonApp: Flow = {
  app: "mihon-app",
  pkg: PKG,
  activity: ACTIVITY,
  apk: "mihon-v0.20.4.apk",
  crop: CROP,
  seedPrefs: SEED_PREFS,
  clock: "pinned",
  steps: [
    { id: "library", label: "Library — empty state", action: { type: "launch" },
      wait: wait.state({ kind: "perf", counter: "presentations", atLeast: 3 }, 0) },
    { id: "nav-more", label: "More tab", action: { type: "tapText", text: "More" }, wait: wait.quiescent(1500) },
    // Settings sits below the fold on the More list — the scroll is load-bearing, not decorative.
    { id: "more-scroll", label: "Scroll the More list",
      action: { type: "swipe", from: [0.5, 0.703], to: [0.5, 0.39], ms: 400 }, wait: wait.quiescent(2500) },
    { id: "settings", label: "Settings", action: { type: "tapText", text: "Settings" }, wait: wait.quiescent(1800) },
    { id: "settings-scroll", label: "Scroll the settings list",
      action: { type: "swipe", from: [0.5, 0.78], to: [0.5, 0.35], ms: 400 }, wait: wait.quiescent(2500) },
    { id: "settings-scroll-back", label: "Scroll back to the top",
      action: { type: "swipe", from: [0.5, 0.35], to: [0.5, 0.78], ms: 400 }, wait: wait.quiescent(2500) },

    { id: "reader", label: "Reader settings (long list)", action: { type: "tapText", text: "Reader" }, wait: wait.quiescent(1800) },
    { id: "reader-scroll", label: "Scroll Reader settings",
      action: { type: "swipe", from: [0.5, 0.82], to: [0.5, 0.35], ms: 400 }, wait: wait.quiescent(2500) },
    { id: "reader-rotation", label: "Open Default rotation dialog",
      action: { type: "tapText", text: "Default rotation" }, wait: wait.quiescent(2000) },
    { id: "dialog-dismiss", label: "Dismiss dialog", action: { type: "back" }, wait: wait.quiescent(1800) },

    // Sub-screens (Reader, Appearance) hide the bottom nav, so `back` is the only way out.
    // Empirically: Reader -> Settings -> More.
    { id: "back-to-settings", label: "Back to Settings", action: { type: "back" }, wait: wait.quiescent(1800) },
    { id: "appearance", label: "Appearance settings", action: { type: "tapText", text: "Appearance" }, wait: wait.quiescent(1800) },
    { id: "appearance-dark", label: "Switch to Dark theme (recomposition)",
      action: { type: "tapText", text: "Dark" }, wait: wait.quiescent(2500) },
    { id: "appearance-light", label: "Switch back to Light",
      action: { type: "tapText", text: "Light" }, wait: wait.quiescent(2500),
      fastEvidence: { kind: "visual", maxContentDiffPct: 14 } },
    { id: "appearance-scroll", label: "Scroll Appearance",
      action: { type: "swipe", from: [0.5, 0.82], to: [0.5, 0.4], ms: 400 }, wait: wait.quiescent(2500) },
    { id: "back-out", label: "Back out of Appearance", action: { type: "back" }, wait: wait.quiescent(2000) },
    { id: "back-out-2", label: "Back again", action: { type: "back" }, wait: wait.quiescent(2000) },
  ],
};
