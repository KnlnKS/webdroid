import { device } from "../../src/shell/config";
// Shared vocabulary for the visual E2E harness.
//
// A flow declares steps once, semantically. Two drivers interpret them: the emulator driver
// (adb + uiautomator) produces the goldens and RESOLVES every tap to a normalized coordinate;
// the webdroid driver (Playwright + the in-page `wd` helpers) replays the same steps and falls
// back to the recorded coordinate when it cannot find the target itself.

/** Normalized rect, 0..1 in screen space. */
export type Rect = { x: number; y: number; w: number; h: number };

type Action =
  | { type: "launch" }
  | { type: "tapText"; text: string }
  /** Normalized 0..1 tap. Used directly when no stable text anchor exists. `repeat` taps the
   *  same point N times, `everyMs` apart, as ONE step — a burst with no capture in between. */
  | { type: "tapAt"; x: number; y: number; repeat?: number; everyMs?: number }
  /**
   * Focus a field and type into it as ONE step. Kept atomic on purpose: dismissing the soft
   * keyboard between focus and typing clears editor focus on the emulator, so the text would
   * land nowhere.
   */
  | { type: "typeInto"; x: number; y: number; text: string }
  | { type: "back" }
  /** The keyboard's action key on the focused field — Search/Go/Done on the soft keyboard, a
   *  hardware ENTER on the emulator; both reach TextView.onEditorAction. */
  | { type: "enter" }
  | { type: "swipe"; from: [number, number]; to: [number, number]; ms?: number }
  /** No input — just settle and capture (e.g. after an async screen load). */
  | { type: "settle" };

export type Step = {
  /** Stable slug; names the PNG. Never renumber — the index is the file prefix. */
  id: string;
  label: string;
  action: Action;
  /** Regions excluded from the diff (normalized). Escape hatch for non-deterministic pixels. */
  maskRects?: Rect[];
  /**
   * The step's horizon, ms. The emulator recorder sleeps it before settling. webdroid does not
   * sleep: it waits for work the app scheduled inside the horizon (plus the stability window)
   * and refuses to trust pixel stability before it, so a splash that holds still for a second
   * is not mistaken for the screen behind it. Set it to how long the screen may legitimately
   * keep changing after the action.
   */
  settleDelayMs?: number;
  /** The screen keeps changing by design (a game loop): capture once after the dwell instead
   *  of waiting for stability, which would never come. */
  animated?: boolean;
};

export type Flow = {
  app: string;
  pkg: string;
  activity: string;
  apk: string;
  /** Crop applied to BOTH images before diffing, in device pixels. */
  crop: { top: number; bottom: number; left: number; right: number };
  /**
   * An Android shared_prefs XML written before the flow starts, so a flow can begin past a
   * gate it does not exist to exercise. Both drivers honour it -- the emulator writes the
   * file, webdroid parses it into its own prefs store -- or the two passes would be walking
   * different screens and the diff would be meaningless.
   */
  seedPrefs?: string;
  /** Frame-rate gate for animated steps; a step below it is flagged SLOW. */
  minFps?: number;
  /**
   * Run this flow on the wall clock instead of PINNED_CLOCK_MS. The pin is in the past, so a
   * device held there rejects every current TLS certificate: an app that fetches over HTTPS
   * records a golden of its own error state. Both drivers honour it, or the two passes would
   * disagree about what "now" is. Anything the flow renders from the clock must be masked.
   */
  liveClock?: boolean;
  /** The geometry positional taps were measured at. A flow with no goldens runs at it, since a
   *  normalized coordinate only lands on the same view at the same size. */
  screen?: Screen;
  steps: Step[];
};

/**
 * One node of a view hierarchy, as `uiautomator dump` reports it and as webdroid emits it.
 * Bounds are absolute device px, status bar included -- the space a tap is expressed in.
 */
export type UiNode = {
  text: string;
  desc: string;
  cls: string;
  resId: string;
  bounds: [number, number, number, number];
  clickable: boolean;
};

/** The hierarchy dump that sits beside a step's png, on both sides. */
export const uiFileFor = (png: string): string => png.replace(/\.png$/, ".ui.json");

/** What the emulator pass learned and the webdroid pass replays. */
export type RecordedStep = {
  id: string;
  label: string;
  index: number;
  file: string;
  /** Resolved tap point in normalized coords, when the action was a tap. */
  resolved?: { x: number; y: number };
  /** Node bounds the text matched, device px — diagnostics only. */
  bounds?: [number, number, number, number];
  /** Hierarchy dump beside the png, when the recorder captured one. */
  uiFile?: string;
  settleTimedOut?: boolean;
  note?: string;
};

export type Manifest = {
  app: string;
  pkg: string;
  activity: string;
  recordedAt: string;
  /** Instant both sides pin their clock to, ms since epoch. */
  pinnedClockMs: number;
  device: { width: number; height: number; densityDpi: number; fingerprint: string; sdk: string };
  crop: Flow["crop"];
  steps: RecordedStep[];
};

/**
 * The geometry a comparison happens at. It is NOT the device profile: the goldens are pixels
 * captured at one size, lib/diff.ts refuses any other, and the normalized taps a flow carries
 * denormalize into that same space. So the manifest a run is scored against is what says how
 * big the screen is, and `screenOf` reads it from there. Without goldens a flow's own `screen`
 * answers, then the profile — as it does for the recorder, which is *defining* the geometry.
 */
export type Screen = { width: number; height: number; densityDpi: number };

export const screenOf = (m: Manifest | undefined, fallback?: Screen): Screen =>
  m ? { width: m.device.width, height: m.device.height, densityDpi: m.device.densityDpi } : fallback ?? deviceScreen();

export const deviceScreen = (): Screen =>
  ({ width: device.width, height: device.height, densityDpi: device.densityDpi });

/** the `?screen=` the shell parses, and what setup-avd.sh prints */
export const screenParam = (s: Screen): string => `${s.width}x${s.height}@${s.densityDpi}`;

export const sameScreen = (a: Screen, b: Screen): boolean =>
  a.width === b.width && a.height === b.height && a.densityDpi === b.densityDpi;

/**
 * Fixed instant both sides pin to: 2026-01-02T12:00:00Z.
 * FitNotes renders the current date on its workout log, so an unpinned clock would make
 * every golden go stale the next day.
 */
export const PINNED_CLOCK_MS = Date.UTC(2026, 0, 2, 12, 0, 0);
