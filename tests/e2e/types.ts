import { createHash } from "node:crypto";
import { device, type Screen } from "../../src/shell/config.ts";
export type { Screen } from "../../src/shell/config.ts";
import type { perf } from "../../src/perf.ts";
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
   *  same point N times, `everyMs` apart, as ONE step — a burst with no capture in between.
   *  `whileText` taps only while that text shows, first waiting up to `appearMs` for it, until it
   *  has stayed away `quietMs` (default 400): an app that re-shows a sheet keeps getting taps. */
  | { type: "tapAt"; x: number; y: number; repeat?: number; everyMs?: number; whileText?: string; appearMs?: number; quietMs?: number; unlessResource?: string }
  /**
   * Focus a field and type into it as ONE step. Kept atomic on purpose: dismissing the soft
   * keyboard between focus and typing clears editor focus on the emulator, so the text would
   * land nowhere.
   */
  | { type: "typeInto"; x: number; y: number; text: string }
  /** `whileText`/`appearMs` as for tapAt: back only while that text shows */
  | { type: "back"; whileText?: string; appearMs?: number }
  /** The keyboard's action key on the focused field — Search/Go/Done on the soft keyboard, a
   *  hardware ENTER on the emulator; both reach TextView.onEditorAction. */
  | { type: "enter" }
  /** Send the foreground task through pause/stop, leave it backgrounded briefly, then resume it. */
  | { type: "background"; ms?: number }
  /** `whileText`/`appearMs` as for tapAt: up to `maxSwipes` swipes, only while that text shows */
  | { type: "swipe"; from: [number, number]; to: [number, number]; ms?: number; untilText?: string; maxSwipes?: number; whileText?: string; appearMs?: number }
  /** No input — just settle and capture (e.g. after an async screen load). */
  | { type: "settle" };

export type StateCondition =
  | { kind: "text" | "text-absent"; text: string; resId?: string; visible?: boolean }
  | { kind: "resource"; resId: string }
  | { kind: "resource-absent"; resId: string }
  | { kind: "perf"; counter: keyof typeof perf; atLeast: number }
  | { kind: "all"; conditions: StateCondition[] }
  | { kind: "any"; conditions: StateCondition[] };

export type WaitPolicy =
  | { kind: "state"; condition: StateCondition; maxVirtualMs: number; maxRealMs: number; stableMs: number }
  | { kind: "quiescent"; maxVirtualMs: number; maxRealMs: number }
  | { kind: "sample"; atVirtualMs: number; maxRealMs: number; minRealMs: number }
  | { kind: "live"; horizonMs: number; timeoutMs: number; condition?: StateCondition }
  | { kind: "live-sample"; atRealMs: number; timeoutMs: number };
type StateWait = Extract<WaitPolicy, { kind: "state" }>;
type LiveWait = Extract<WaitPolicy, { kind: "live" }>;

export type EvidencePolicy =
  | { kind: "semantic" }
  | { kind: "visual"; maxContentDiffPct: number }
  | { kind: "motion" };

const REAL_WAIT_MS = 20_000;
export const wait = {
  state: (condition: StateCondition, maxVirtualMs = 20_000, maxRealMs = REAL_WAIT_MS, stableMs = 0): StateWait =>
    ({ kind: "state", condition, maxVirtualMs, maxRealMs, stableMs }),
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
  /** Equivalent action when Webdroid geometry differs from the Android reference. */
  webdroidAction?: Action;
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

export type ExecutionStep = Step & { fastAction?: never; fastWait?: never; webdroidAction?: never };
export type ExecutionFlow = Flow<ExecutionStep>;

export function executionFlow(flow: Flow, mode: "reference" | "full" | "fast"): ExecutionFlow {
  const quick = mode === "fast" && flow.clock === "live";
  return { ...flow, steps: flow.steps.map(({ fastAction, fastWait, webdroidAction, ...step }) => ({
    ...step,
    action: mode === "reference" ? step.action : (quick ? fastAction : undefined) ?? webdroidAction ?? step.action,
    wait: quick ? fastWait ?? wait.liveSample(500) : step.wait,
  })) };
}

type FlowBase<TStep extends Step> = {
  app: string;
  pkg: string;
  activity: string;
  apk: string;
  /** Crop applied to BOTH images before diffing, in device pixels. */
  crop: { top: number; bottom: number; left: number; right: number };
  /**
   * An Android shared_prefs XML written before the flow starts, so a flow can begin past a
   * gate it does not exist to exercise. Both drivers write the file before the app starts, or
   * the two passes would be walking different screens and the diff would be meaningless.
   */
  seedPrefs?: string;
  /** Browser fallback for directory picking, with files staged before launch. */
  privateStorage?: {
    files: { path: string; fixture: string }[];
    expectedFiles?: { pathPrefix: string; suffix: string; minBytes: number }[];
  };
  /** Informational frame rate: a motion step below it under --jobs 1 is flagged SLOW. */
  minFps?: number;
  /** The geometry positional taps were measured at. A flow with no goldens runs at it, since a
   *  normalized coordinate only lands on the same view at the same size. */
  screen?: ScreenOptions;
  steps: TStep[];
};

export type Flow<TStep extends Step = Step> = FlowBase<TStep> & (
  | {
      clock: "live";
      expectedErrors?: never;
    }
  | {
      /** Controlled flows advance Android-visible time in fast mode; pinned flows retain real scheduling. */
      clock: "controlled" | "pinned";
      /** Errors accepted by exact substring wherever they surface (browser console, app log, process
       *  diagnostics): ones a device shows too, such as a bundled library's own error-level log lines.
       *  Every unmatched error fails the fast lane. */
      expectedErrors?: readonly string[];
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
    if (evidence?.kind === "motion" && !measuresMotion)
      throw new Error(`${flow.app}/${step.id}: motion evidence requires a frame-producing wait`);
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

/** What the emulator pass learned, for scoring the webdroid pass. */
export type RecordedStep = {
  id: string;
  label: string;
  index: number;
  file: string;
  /** Where the device tapped, in normalized coords; webdroid locates text targets itself. */
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
  device: ScreenOptions & { fingerprint: string; sdk: string };
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
type ScreenOptions = Screen & { statusBarDp?: number };
export type CaptureScreen = Screen & { statusBarDp: number };

/** Existing Android references predate inset metadata and used a 24dp status bar. */
export function screenOf(m: { device: ScreenOptions } | undefined, fallback?: ScreenOptions): CaptureScreen {
  const source = m?.device ?? fallback ?? deviceScreen();
  const statusBarDp = source.statusBarDp ?? (m ? 24 : 0);
  if (!Number.isFinite(statusBarDp) || statusBarDp < 0) throw new Error("Invalid status-bar inset");
  return { width: source.width, height: source.height, densityDpi: source.densityDpi, statusBarDp };
}

export const deviceScreen = (): CaptureScreen =>
  ({ width: device.width, height: device.height, densityDpi: device.densityDpi, statusBarDp: device.statusBarDp });

/** the `?screen=` the shell parses, and what setup-avd.sh prints */
export { formatScreen as screenParam } from "../../src/shell/config.ts";

export const sameDimensions = (a: Screen, b: Screen): boolean =>
  a.width === b.width && a.height === b.height && a.densityDpi === b.densityDpi;

export const sameScreen = (a: CaptureScreen, b: CaptureScreen): boolean =>
  sameDimensions(a, b) && a.statusBarDp === b.statusBarDp;

/**
 * Fixed instant both sides pin to: 2026-01-02T12:00:00Z.
 * FitNotes renders the current date on its workout log, so an unpinned clock would make
 * every golden go stale the next day.
 */
export const PINNED_CLOCK_MS = Date.UTC(2026, 0, 2, 12, 0, 0);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Identifies the steps a capture ran, so rescoring rejects captures from since-edited flows. */
export function flowSchemaHash(flows: Flow[], mode: "all" | "reference" | "full" | "fast" = "all"): string {
  const resolved = mode === "all" ? flows : flows.map((flow) => executionFlow(flow, mode));
  return createHash("sha256").update(canonical(resolved)).digest("hex");
}
