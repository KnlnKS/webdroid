import { PNG } from "pngjs";
import { diffImages } from "../../tests/e2e/lib/diff.ts";
import { stableJson, type Failure, type JsonValue, type ProbeCase, type ProbeResult } from "./model.ts";

type GraphicsValue = { width: number; height: number; saveCount: number; center: number; png: string; [key: string]: JsonValue };

function graphicsValue(value: unknown): GraphicsValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  return typeof input.width === "number" && typeof input.height === "number" && typeof input.saveCount === "number" &&
    typeof input.center === "number" && typeof input.png === "string" ? input as GraphicsValue : null;
}

function stateValueEqual(key: string, expected: JsonValue, actual: JsonValue): boolean {
  if ((key === "matrix" || key === "pathBounds" || key === "renderNode") && Array.isArray(expected) && Array.isArray(actual)) {
    return expected.length === actual.length && expected.every((value, index) => {
      const other = actual[index];
      return typeof value === "number" && typeof other === "number" &&
        (key === "matrix"
          ? Math.abs(value - other) <= 2e-6 * Math.max(1, Math.abs(value), Math.abs(other))
          : Math.fround(value) === Math.fround(other));
    });
  }
  return stableJson(expected) === stableJson(actual);
}

export function graphicsPrecisionDeltas(oracle: ProbeResult, actual: ProbeResult): Record<string, number> {
  if (oracle.outcome !== "value" || actual.outcome !== "value") return {};
  const expected = graphicsValue(oracle.value), got = graphicsValue(actual.value);
  if (!expected || !got) return {};
  const deltas: Record<string, number> = {};
  for (const key of ["matrix", "pathBounds", "renderNode"]) {
    const left = expected[key], right = got[key];
    if (!Array.isArray(left) || !Array.isArray(right) || !stateValueEqual(key, left, right)) continue;
    let difference = 0;
    for (let index = 0; index < left.length; index++) {
      const value = left[index], other = right[index];
      if (typeof value === "number" && typeof other === "number" && Math.fround(value) !== Math.fround(other))
        difference = Math.max(difference, Math.abs(value - other));
    }
    if (difference) deltas[key] = difference;
  }
  return deltas;
}

function stateDifferenceKeys(expected: Record<string, JsonValue>, actual: Record<string, JsonValue>): string[] {
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    .filter((key) => !(key in expected) || !(key in actual) || !stateValueEqual(key, expected[key]!, actual[key]!))
    .sort();
}

function graphicsFingerprint(input: ProbeCase, matchKey: string): string {
  if (input.kind !== "graphics") return matchKey;
  return `${matchKey}:ops:${input.commands.map((command) => command.op).join(">")}`;
}

export function compareResult(input: ProbeCase, oracle: ProbeResult, actual: ProbeResult): Failure | null {
  const site = input.kind === "api"
    ? `${input.owner}.${input.calls.at(-1)?.name ?? "<init>"}${input.calls.at(-1)?.descriptor ?? input.constructorDescriptor ?? ""}`
    : "graphics";
  if (oracle.outcome !== actual.outcome) return {
    kind: "exception-mismatch", fingerprint: `${site}:outcome:${oracle.outcome}:${actual.outcome}`,
    detail: `oracle returned ${oracle.outcome}; webdroid returned ${actual.outcome}`,
  };
  if (oracle.outcome === "exception" && actual.outcome === "exception") {
    if (oracle.exception === actual.exception) return null;
    return { kind: "exception-mismatch", fingerprint: `${site}:exception:${oracle.exception}:${actual.exception}`, detail: `${oracle.exception} != ${actual.exception}` };
  }
  if (oracle.outcome !== "value" || actual.outcome !== "value") return null;
  if (input.kind !== "graphics") {
    const expected = stableJson(oracle.value), got = stableJson(actual.value);
    return expected === got ? null : { kind: "value-mismatch", fingerprint: `${site}:value`, detail: `${expected} != ${got}` };
  }
  const expected = graphicsValue(oracle.value), got = graphicsValue(actual.value);
  if (!expected || !got) return { kind: "harness-error", fingerprint: "graphics:bad-result", detail: "graphics result has an invalid shape" };
  const { png: expectedPng, ...expectedState } = expected;
  const { png: gotPng, ...gotState } = got;
  const differing = stateDifferenceKeys(expectedState, gotState);
  if (differing.length) {
    const matchKey = `graphics:state:${differing.join(",")}`;
    return {
    kind: "value-mismatch", fingerprint: graphicsFingerprint(input, matchKey), matchKey,
    detail: `${stableJson(expectedState)} != ${stableJson(gotState)}`,
    };
  }
  const left = PNG.sync.read(Buffer.from(expectedPng, "base64"));
  const right = PNG.sync.read(Buffer.from(gotPng, "base64"));
  const score = diffImages(left, right, { top: 0, bottom: 0, left: 0, right: 0 });
  if (score.contentDiffPct <= 1 && score.tolerantPct <= 0.1) return null;
  const matchKey = "graphics:pixels";
  return {
    kind: "pixel-mismatch",
    fingerprint: graphicsFingerprint(input, matchKey), matchKey,
    detail: `content ${score.contentDiffPct.toFixed(3)}%, tolerant ${score.tolerantPct.toFixed(3)}%`,
    pixel: { strictPct: score.strictPct, tolerantPct: score.tolerantPct, contentDiffPct: score.contentDiffPct },
  };
}
