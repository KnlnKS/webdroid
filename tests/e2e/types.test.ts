import { expect, test } from "vite-plus/test";
import { deviceScreen, executionFlow, flowSchemaHash, sameDimensions, sameScreen, screenOf, wait, type Flow, type Manifest } from "./types.ts";

import { DEFAULT_QUIESCENCE, stepDeadlineMs, waitBudget, type StepSpec } from "./lib/probe.ts";

const flow = (text: string, timeoutMs: number): Flow => ({
  app: "fixture",
  pkg: "fixture",
  activity: "fixture.Main",
  apk: "fixture.apk",
  clock: "controlled",
  crop: { top: 0, bottom: 0, left: 0, right: 0 },
  steps: [{ id: "tap", label: "Tap", action: { type: "tapText", text }, wait: wait.quiescent(0, timeoutMs) }],
});

test("flow fingerprints include action payloads and wait policy", () => {
  expect(flowSchemaHash([flow("A", 100)])).not.toBe(flowSchemaHash([flow("B", 100)]));
  expect(flowSchemaHash([flow("A", 100)])).not.toBe(flowSchemaHash([flow("A", 200)]));
  const reference: Flow = {
    app: "fixture", pkg: "fixture", activity: "fixture.Main", apk: "fixture.apk",
    clock: "live", crop: { top: 0, bottom: 0, left: 0, right: 0 },
    steps: [{ id: "launch", label: "Launch", action: { type: "launch" }, wait: wait.live(),
      liveWait: wait.state({ kind: "text", text: "Ready" }) }],
  };
  const revised: Flow = { ...reference, steps: [{ ...reference.steps[0]!, liveWait: wait.state({ kind: "text", text: "Done" }) }] };
  expect(flowSchemaHash([reference])).not.toBe(flowSchemaHash([revised]));
  expect(flowSchemaHash([reference], "reference")).toBe(flowSchemaHash([revised], "reference"));
  const alternate: Flow = { ...reference, steps: [{ ...reference.steps[0]!, liveAction: { type: "settle" } }] };
  expect(flowSchemaHash([reference], "reference")).toBe(flowSchemaHash([alternate], "reference"));
  const repositioned: Flow = { ...reference, steps: [{ ...reference.steps[0]!, webdroidAction: { type: "tapAt", x: 0.5, y: 0.1 } }] };
  expect(flowSchemaHash([reference])).not.toBe(flowSchemaHash([repositioned]));
  expect(flowSchemaHash([reference], "reference")).toBe(flowSchemaHash([repositioned], "reference"));
  expect(flowSchemaHash([reference], "webdroid")).not.toBe(flowSchemaHash([alternate], "webdroid"));
  const overridden: Flow = { ...repositioned, steps: [{ ...repositioned.steps[0]!, liveAction: { type: "settle" } }] };
  const webdroid = executionFlow(overridden, "webdroid"), pinned = executionFlow({ ...overridden, clock: "pinned", steps: [{ ...overridden.steps[0]!, liveWait: undefined, wait: wait.quiescent() }] }, "webdroid");
  expect(webdroid.steps[0]!.action).toEqual({ type: "settle" });
  expect(webdroid.steps[0]!.wait).toEqual(reference.steps[0]!.liveWait!);
  expect(pinned.steps[0]!.action).toEqual({ type: "tapAt", x: 0.5, y: 0.1 });
  expect(flowSchemaHash([webdroid])).toBe(flowSchemaHash([overridden], "webdroid"));
});

test("reference geometry distinguishes status insets from the normal browser profile", () => {
  const browser = { width: 720, height: 1280, densityDpi: 320 };
  const manifest: Manifest = {
    app: "fixture", pkg: "fixture", activity: "fixture.Main", recordedAt: "", pinnedClockMs: 0,
    device: { ...browser, fingerprint: "fixture", sdk: "33" },
    crop: { top: 48, bottom: 48, left: 0, right: 0 }, steps: [],
  };
  const normal = screenOf(undefined, browser);
  expect(normal).toEqual({ ...browser, statusBarDp: 0 });
  expect(screenOf(manifest).statusBarDp).toBe(24);
  expect(sameScreen(normal, screenOf(manifest))).toBe(false);
  expect(sameDimensions(normal, screenOf(manifest))).toBe(true);
  expect(sameScreen({ ...browser, statusBarDp: 24 }, screenOf(manifest))).toBe(true);
  manifest.device.statusBarDp = 0;
  expect(sameScreen(normal, screenOf(manifest))).toBe(true);
  manifest.device.statusBarDp = 28;
  expect(screenOf(manifest).statusBarDp).toBe(28);
  expect(screenOf(undefined, { ...browser, statusBarDp: 28 })).toEqual(screenOf(manifest));
  manifest.device.statusBarDp = -1;
  expect(() => screenOf(manifest)).toThrow("Invalid status-bar inset");
});

test("host step envelope preserves requested live dwell and action repetitions", () => {
  const spec: StepSpec = { act: { type: "none" }, screen: deviceScreen(),
    wait: wait.liveSample(90_000), quiescence: DEFAULT_QUIESCENCE, aliveMs: 3000, capture: true, timing: "controlled", dwellMs: 0 };
  expect(waitBudget(spec.wait)).toEqual({ actionMs: 20_000, settleMs: 140_000 });
  expect(stepDeadlineMs(spec)).toBe(343_000);
  expect(waitBudget(wait.live(90_000))).toEqual({ actionMs: 20_000, settleMs: 140_000 });
  const repeated = { ...spec, act: { type: "tap" as const, x: 0.5, y: 0.5, repeat: 3, everyMs: 60_000 } };
  expect(stepDeadlineMs(repeated)).toBe(stepDeadlineMs(spec) + 40_000 + 120_000);
});
