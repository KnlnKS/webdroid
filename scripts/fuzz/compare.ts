import { PNG } from "pngjs";
import { diffImages } from "../../tests/e2e/lib/diff";
import { stableJson, type Failure, type JsonValue, type ProbeCase, type ProbeResult } from "./model";

type GraphicsValue = { width: number; height: number; saveCount: number; center: number; png: string; [key: string]: JsonValue };

function graphicsValue(value: unknown): GraphicsValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  return typeof input.width === "number" && typeof input.height === "number" && typeof input.saveCount === "number" &&
    typeof input.center === "number" && typeof input.png === "string" ? input as GraphicsValue : null;
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
  if (stableJson(expectedState) !== stableJson(gotState)) return {
    kind: "value-mismatch", fingerprint: `graphics-state:${stableJson(expectedState)}:${stableJson(gotState)}`,
    detail: `${stableJson(expectedState)} != ${stableJson(gotState)}`,
  };
  const left = PNG.sync.read(Buffer.from(expectedPng, "base64"));
  const right = PNG.sync.read(Buffer.from(gotPng, "base64"));
  const score = diffImages(left, right, { top: 0, bottom: 0, left: 0, right: 0 });
  if (score.contentDiffPct <= 1 && score.tolerantPct <= 0.1) return null;
  return {
    kind: "pixel-mismatch",
    fingerprint: "graphics:pixels",
    detail: `content ${score.contentDiffPct.toFixed(3)}%, tolerant ${score.tolerantPct.toFixed(3)}%`,
    pixel: { strictPct: score.strictPct, tolerantPct: score.tolerantPct, contentDiffPct: score.contentDiffPct },
  };
}
