import { PNG } from "pngjs";
import { compareResult } from "./compare.ts";
import type { Failure, ProbeCase, ProbeResult } from "./model.ts";
import type { UiAction } from "./ui-model.ts";

const transparentPixel = PNG.sync.write(new PNG({ width: 1, height: 1 })).toString("base64");

export function injectedProbeFailure(input: ProbeCase): { oracle: ProbeResult; webdroid: ProbeResult; failure: Failure | null } {
  const marker = input.id.startsWith("injected-");
  const oracle: ProbeResult = input.kind === "api"
    ? { schemaVersion: 1, id: input.id, kind: input.kind, outcome: "value", value: 0 }
    : { schemaVersion: 1, id: input.id, kind: input.kind, outcome: "value",
      value: { width: 1, height: 1, saveCount: 0, center: 0, png: transparentPixel } };
  const webdroid: ProbeResult = marker
    ? input.kind === "api"
      ? { ...oracle, outcome: "value", value: 1 }
      : { ...oracle, outcome: "value", value: { width: 1, height: 1, saveCount: 0, center: 1, png: transparentPixel } }
    : oracle;
  return { oracle, webdroid, failure: compareResult(input, oracle, webdroid) };
}

export function injectedUiFailure(actions: readonly UiAction[]): Failure | null {
  return actions.some((action) => action.type === "configuration" && action.orientation === "landscape")
    ? { kind: "harness-error", fingerprint: "ui:injected", detail: "intentional semantic-state mismatch" }
    : null;
}
