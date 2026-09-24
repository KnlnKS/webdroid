import { device } from "../../src/shell/config";
import type { perf } from "../../src/perf";
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
  /** An optional anchor is a no-op when absent and never replays a recorded coordinate. */
  | { type: "tapText"; text: string; optional?: boolean }
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
  /** Send the foreground task through pause/stop, leave it backgrounded briefly, then resume it. */
  | { type: "background"; ms?: number }
  | { type: "swipe"; from: [number, number]; to: [number, number]; ms?: number; untilText?: string; maxSwipes?: number }
  /** No input — just settle and capture (e.g. after an async screen load). */
  | { type: "settle" };

export type StateCondition =
  | { kind: "activity"; component: string }
  | { kind: "text"; text: string }
  | { kind: "text-absent"; text: string }
  | { kind: "perf"; counter: keyof typeof perf; atLeast: number };

export type WaitPolicy =
  | { kind: "state"; condition: StateCondition; maxVirtualMs: number; maxRealMs: number }
  | { kind: "quiescent"; maxVirtualMs: number; maxRealMs: number }
  | { kind: "sample"; atVirtualMs: number; maxRealMs: number; minRealMs: number }
  | { kind: "live"; horizonMs: number; timeoutMs: number }
  | { kind: "live-sample"; atRealMs: number; timeoutMs: number };
type StateWait = Extract<WaitPolicy, { kind: "state" }>;
type LiveWait = Extract<WaitPolicy, { kind: "live" }>;

export type EvidencePolicy =
  | { kind: "semantic" }
  | { kind: "visual"; maxContentDiffPct: number }
  | { kind: "motion"; minFps: number };

const REAL_WAIT_MS = 20_000;
export const wait = {
  state: (condition: StateCondition, maxVirtualMs = 20_000, maxRealMs = REAL_WAIT_MS): StateWait =>
    ({ kind: "state", condition, maxVirtualMs, maxRealMs }),
  quiescent: (maxVirtualMs = 0, maxRealMs = REAL_WAIT_MS): WaitPolicy =>
    ({ kind: "quiescent", maxVirtualMs, maxRealMs }),
  sample: (atVirtualMs = 0, maxRealMs = REAL_WAIT_MS, minRealMs = 0): WaitPolicy =>
    ({ kind: "sample", atVirtualMs, maxRealMs, minRealMs }),
  live: (horizonMs = 0, timeoutMs = REAL_WAIT_MS): LiveWait =>
    ({ kind: "live", horizonMs, timeoutMs }),
  liveSample: (atRealMs = 0, timeoutMs = REAL_WAIT_MS): WaitPolicy =>
    ({ kind: "live-sample", atRealMs, timeoutMs }),
};

export type Step = {
  /** Stable slug; names the PNG. Never renumber — the index is the file prefix. */
  id: string;
  label: string;
  action: Action;
  /** Equivalent quick action when platform UI or a live text anchor differs from the reference. */
  fastAction?: Action;
  /** Regions excluded from the diff (normalized). Escape hatch for non-deterministic pixels. */
  maskRects?: Rect[];
  wait: WaitPolicy;
  /** Runtime readiness for the all-action quick run; recording keeps the reference wait. */
  fastWait?: WaitPolicy;
  /** Fast-lane assertion. Absence means semantic evidence only. */
  fastEvidence?: Exclude<EvidencePolicy, { kind: "semantic" }>;
};

type FlowBase = {
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
  /** Frame-rate gate for motion checkpoints; a step below it is flagged SLOW. */
  minFps?: number;
  /** The geometry positional taps were measured at. A flow with no goldens runs at it, since a
   *  normalized coordinate only lands on the same view at the same size. */
  screen?: Screen;
  steps: Step[];
};

export type Flow = FlowBase & (
  | {
      clock: "live";
      sourceCoverage?: never;
      expectedBrowserErrors?: never;
    }
  | {
      /** Controlled flows advance Android-visible time in fast mode; pinned flows retain real scheduling. */
      clock: "controlled" | "pinned";
      /** V8 instrumentation can distort long-running native loops; absent means source coverage is safe. */
      sourceCoverage?: "unsupported";
      /** Existing browser errors accepted by exact substring; every unmatched error fails the fast lane. */
      expectedBrowserErrors?: readonly string[];
    }
);

export const evidenceOf = (step: Step): EvidencePolicy => step.fastEvidence ?? { kind: "semantic" };

export const waitHorizonMs = (policy: WaitPolicy): number => {
  switch (policy.kind) {
    case "state":
    case "quiescent": return policy.maxVirtualMs;
    case "sample": return policy.atVirtualMs;
    case "live": return policy.horizonMs;
    case "live-sample": return policy.atRealMs;
  }
};

export const waitTimeoutMs = (policy: WaitPolicy): number =>
  policy.kind === "live" || policy.kind === "live-sample" ? policy.timeoutMs : policy.maxRealMs;

export const isMotionWait = (policy: WaitPolicy): boolean =>
  policy.kind === "sample" || policy.kind === "live-sample";

export function validateFlow(flow: Flow): void {
  if (flow.clock === "live" && flow.steps[0]?.action.type !== "launch")
    throw new Error(`${flow.app}: live quick check must start with launch`);
  const ids = new Set<string>();
  for (const step of flow.steps) {
    if (!step.id || ids.has(step.id)) throw new Error(`${flow.app}: duplicate or empty step id "${step.id}"`);
    ids.add(step.id);
    if (flow.clock === "controlled" && (step.wait.kind === "live" || step.wait.kind === "live-sample"))
      throw new Error(`${flow.app}/${step.id}: controlled flow cannot use a live wait`);
    if (flow.clock === "live" && step.wait.kind !== "live" && step.wait.kind !== "live-sample")
      throw new Error(`${flow.app}/${step.id}: live flow requires a live wait`);
    if (step.fastWait && flow.clock !== "live")
      throw new Error(`${flow.app}/${step.id}: fast wait is only for live flows`);
    if (step.fastAction && flow.clock !== "live")
      throw new Error(`${flow.app}/${step.id}: fast action is only for live flows`);
    const evidence = step.fastEvidence;
    if (flow.clock === "live" && evidence && (step !== flow.steps[0] || evidence.kind !== "visual"))
      throw new Error(`${flow.app}/${step.id}: live fast evidence must compare the launch screen`);
    if (evidence?.kind === "visual" && !(evidence.maxContentDiffPct >= 0 && evidence.maxContentDiffPct <= 100))
      throw new Error(`${flow.app}/${step.id}: invalid visual difference limit`);
    const measuresMotion = isMotionWait(step.wait) || (step.wait.kind === "state" && step.wait.condition.kind === "perf");
    if (evidence?.kind === "motion" && (!(evidence.minFps > 0) || !measuresMotion))
      throw new Error(`${flow.app}/${step.id}: motion evidence requires a positive fps and a frame-producing wait`);
  }
}

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
  enabled: boolean;
  editable: boolean;
  scrollable: boolean;
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
  /** A launch-only Android reference; full flow steps remain smoke evidence. */
  depth?: "startup";
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
