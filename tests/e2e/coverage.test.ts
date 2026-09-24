import { expect, test } from "bun:test";
import { flowSchemaHash, parseCoverageIndex } from "./coverage";
import { wait, type Flow } from "./types";

const flow = (text: string, timeoutMs: number): Flow => ({
  app: "fixture",
  pkg: "fixture",
  activity: "fixture.Main",
  apk: "fixture.apk",
  clock: "controlled",
  crop: { top: 0, bottom: 0, left: 0, right: 0 },
  steps: [{ id: "tap", label: "Tap", action: { type: "tapText", text }, wait: wait.quiescent(0, timeoutMs) }],
});

test("coverage fingerprints include action payloads and wait policy", () => {
  expect(flowSchemaHash([flow("A", 100)])).not.toBe(flowSchemaHash([flow("B", 100)]));
  expect(flowSchemaHash([flow("A", 100)])).not.toBe(flowSchemaHash([flow("A", 200)]));
  const reference: Flow = {
    app: "fixture", pkg: "fixture", activity: "fixture.Main", apk: "fixture.apk",
    clock: "live", crop: { top: 0, bottom: 0, left: 0, right: 0 },
    steps: [{ id: "launch", label: "Launch", action: { type: "launch" }, wait: wait.live(),
      fastWait: wait.state({ kind: "text", text: "Ready" }) }],
  };
  const revised: Flow = { ...reference, steps: [{ ...reference.steps[0]!, fastWait: wait.state({ kind: "text", text: "Done" }) }] };
  expect(flowSchemaHash([reference])).not.toBe(flowSchemaHash([revised]));
  expect(flowSchemaHash([reference], "reference")).toBe(flowSchemaHash([revised], "reference"));
  const alternate: Flow = { ...reference, steps: [{ ...reference.steps[0]!, fastAction: { type: "settle" } }] };
  expect(flowSchemaHash([reference], "reference")).toBe(flowSchemaHash([alternate], "reference"));
  const repositioned: Flow = { ...reference, steps: [{ ...reference.steps[0]!, webdroidAction: { type: "tapAt", x: 0.5, y: 0.1 } }] };
  expect(flowSchemaHash([reference])).not.toBe(flowSchemaHash([repositioned]));
  expect(flowSchemaHash([reference], "reference")).toBe(flowSchemaHash([repositioned], "reference"));
});

test("coverage indexes are validated at the JSON boundary", () => {
  expect(() => parseCoverageIndex({ mode: "v8-precise-sourcemap" })).toThrow();
});
