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
});

test("coverage indexes are validated at the JSON boundary", () => {
  expect(() => parseCoverageIndex({ mode: "v8-precise-sourcemap" })).toThrow();
});
