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
  /** Extra dwell after the action before settling, ms. For slow screens. */
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
  steps: Step[];
};

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

// one source of truth with the emulator itself
export const SCREEN_W = device.width;
export const SCREEN_H = device.height;

/**
 * Fixed instant both sides pin to: 2026-01-02T12:00:00Z.
 * FitNotes renders the current date on its workout log, so an unpinned clock would make
 * every golden go stale the next day.
 */
export const PINNED_CLOCK_MS = Date.UTC(2026, 0, 2, 12, 0, 0);
