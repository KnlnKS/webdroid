import { mkdirSync, writeFileSync } from "node:fs";
import { injectedProbeFailure, injectedUiFailure } from "./injected.ts";
import { minimizeCaseBatched, reproducesTwice } from "./minimize.ts";
import { sameFailure, SCHEMA_VERSION, type ApiCase, type GraphicsCase, type ProbeCase } from "./model.ts";
import { minimizeUiActions, type UiFailureBundle } from "./ui.ts";
import type { UiAction } from "./ui-model.ts";

const OUT = "fuzz-results/smoke";

async function probeLayer(input: ProbeCase): Promise<string> {
  const failure = injectedProbeFailure(input).failure;
  if (!failure) throw new Error(`injected ${input.kind} mismatch was not detected`);
  const minimized = await minimizeCaseBatched(input, async (candidates) =>
    candidates.map((candidate) => sameFailure(failure, injectedProbeFailure(candidate).failure)));
  const reproduces = async (candidate: ProbeCase) => sameFailure(failure, injectedProbeFailure(candidate).failure);
  if (!(await reproducesTwice(minimized, reproduces))) throw new Error(`injected ${input.kind} mismatch did not replay twice`);
  const observed = (candidate: ProbeCase) => {
    const result = injectedProbeFailure(candidate);
    if (!result.failure) throw new Error("injected mismatch disappeared");
    return { input: candidate, failure: result.failure, oracle: result.oracle, webdroid: result.webdroid };
  };
  const original = observed(input), minimizedObservation = observed(minimized);
  const path = `${OUT}/${input.kind}.failure.json`;
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, kind: input.kind, injected: true, seed: 0x5eed1234,
    original, minimized: minimizedObservation, reproductions: [minimizedObservation, minimizedObservation],
    environment: { oracle: { injected: true }, webdroid: { injected: true } } }, null, 2) + "\n");
  return path;
}

export async function runInjectedSmoke(): Promise<string[]> {
  mkdirSync(OUT, { recursive: true });
  const api: ApiCase = { schemaVersion: SCHEMA_VERSION, id: "injected-api", kind: "api", owner: "android/graphics/Color", calls: [
    { name: "alpha", descriptor: "(I)I", static: true, args: [{ kind: "int", value: 255 }] },
    { name: "red", descriptor: "(I)I", static: true, args: [{ kind: "int", value: 255 }] },
  ] };
  const graphics: GraphicsCase = { schemaVersion: SCHEMA_VERSION, id: "injected-graphics", kind: "graphics", width: 8, height: 8,
    commands: [{ op: "drawColor", args: [0] }, { op: "drawRect", args: [0, 0, 4, 4] }, { op: "save" }] };
  const paths = [await probeLayer(api), await probeLayer(graphics)];

  const input: UiAction[] = [{ type: "back" }, { type: "configuration", orientation: "landscape" },
    { type: "fallback-tap", at: { x: 0.75, y: 0.25 } }];
  const failure = injectedUiFailure(input)!;
  const minimized = await minimizeUiActions(input, async (candidate) => injectedUiFailure(candidate)?.fingerprint === failure.fingerprint);
  const reproduces = async (candidate: UiAction[]) => injectedUiFailure(candidate)?.fingerprint === failure.fingerprint;
  if (!(await reproduces(minimized)) || !(await reproduces(minimized))) throw new Error("injected UI mismatch did not replay twice");
  const observation = (actions: UiAction[]) => ({ actions, failure: injectedUiFailure(actions)!, run: { steps: [], environment: { injected: true } } });
  const minimizedObservation = observation(minimized);
  const bundle: UiFailureBundle = {
    schemaVersion: 1, kind: "ui", injected: true, seed: 0x5eed1234,
    app: { apk: "injected.apk", pkg: "injected", activity: "injected.Activity" },
    original: observation(input), minimized: minimizedObservation, reproductions: [minimizedObservation, minimizedObservation],
  };
  const uiPath = `${OUT}/ui.failure.json`;
  writeFileSync(uiPath, JSON.stringify(bundle, null, 2) + "\n");
  paths.push(uiPath);
  return paths;
}
