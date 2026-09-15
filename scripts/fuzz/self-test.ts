import { mkdirSync } from "node:fs";
import { injectedProbeFailure, injectedUiFailure } from "./injected";
import { minimizeCaseBatched, reproducesTwice } from "./minimize";
import { SCHEMA_VERSION, type ApiCase, type GraphicsCase, type ProbeCase } from "./model";
import { minimizeUiActions, type UiFailureBundle } from "./ui";
import type { UiAction } from "./ui-model";

const OUT = "fuzz-results/smoke";

async function probeLayer(input: ProbeCase): Promise<string> {
  const failure = injectedProbeFailure(input).failure;
  if (!failure) throw new Error(`injected ${input.kind} mismatch was not detected`);
  const minimized = await minimizeCaseBatched(input, async (candidates) =>
    candidates.map((candidate) => injectedProbeFailure(candidate).failure?.fingerprint === failure.fingerprint));
  const reproduces = async (candidate: ProbeCase) => injectedProbeFailure(candidate).failure?.fingerprint === failure.fingerprint;
  if (!(await reproducesTwice(minimized, reproduces))) throw new Error(`injected ${input.kind} mismatch did not replay twice`);
  const { oracle, webdroid } = injectedProbeFailure(input);
  const path = `${OUT}/${input.kind}.failure.json`;
  await Bun.write(path, JSON.stringify({ schemaVersion: 1, kind: input.kind, injected: true, seed: 0x5eed1234,
    input, minimized, failure, oracle, webdroid, environment: { oracle: { injected: true }, webdroid: { injected: true } } }, null, 2) + "\n");
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
  const bundle: Omit<UiFailureBundle, "app" | "environment"> & { injected: true } = {
    schemaVersion: 1, kind: "ui", injected: true, seed: 0x5eed1234, input, minimized, failure,
  };
  const uiPath = `${OUT}/ui.failure.json`;
  await Bun.write(uiPath, JSON.stringify(bundle, null, 2) + "\n");
  paths.push(uiPath);
  return paths;
}
