import { describe, expect, test } from "bun:test";
import { PNG } from "pngjs";
import { serveCases } from "../scripts/fuzz/case-server";
import { compareResult, graphicsPrecisionDeltas } from "../scripts/fuzz/compare";
import { generateApiCases, generateGraphicsCases } from "../scripts/fuzz/generate";
import { injectedProbeFailure } from "../scripts/fuzz/injected";
import { minimizeCaseBatched, reproducesTwice } from "../scripts/fuzz/minimize";
import { GRAPHICS_OPERATIONS, SCHEMA_VERSION, validateProbeCase, validateProbeResult, type GraphicsCase, type ProbeResult } from "../scripts/fuzz/model";

describe("fuzz campaign core", () => {
  test("fixed seeds generate identical typed cases", () => {
    expect(generateApiCases(1234, 20)).toEqual(generateApiCases(1234, 20));
    expect(generateGraphicsCases(1234, 20)).toEqual(generateGraphicsCases(1234, 20));
    for (const input of [...generateApiCases(1234, 20), ...generateGraphicsCases(1234, 20)])
      expect(validateProbeCase(JSON.parse(JSON.stringify(input)))).toEqual(input);
    expect(() => validateProbeCase({ schemaVersion: 1, id: "bad-op", kind: "graphics", width: 1, height: 1,
      commands: [{ op: "typo", args: [1] }] })).toThrow("unsupported graphics operation");
    expect(() => validateProbeCase({ schemaVersion: 1, id: "bad-args", kind: "graphics", width: 1, height: 1,
      commands: [{ op: "drawRect", args: [1, 2] }] })).toThrow("must contain 4 items");
  });

  test("probe and TypeScript graphics operations stay in lockstep", async () => {
    const source = await Bun.file("tests/fuzz-probe/src/org/webdroid/fuzz/ProbeActivity.java").text();
    const graphicsSwitch = source.slice(source.indexOf('switch (command.getString("op"))'), source.indexOf("default -> throw", source.indexOf('switch (command.getString("op"))')));
    const javaOperations = [...graphicsSwitch.matchAll(/case "([^"]+)"/g)].map((match) => match[1]).sort();
    expect(javaOperations).toEqual([...GRAPHICS_OPERATIONS].sort());
  });

  test("case protocol orders and validates results", async () => {
    const cases = generateApiCases(2, 2);
    const server = serveCases(cases, 0, 1_000);
    const concurrent = serveCases([], 0, 1_000);
    try {
      expect(server.url).not.toBe(concurrent.url);
      for (const input of cases) {
        expect(await (await fetch(`${server.url}case`)).json()).toEqual(input);
        const result = { schemaVersion: SCHEMA_VERSION, id: input.id, kind: input.kind, outcome: "value", value: null };
        expect((await fetch(`${server.url}result`, { method: "POST", body: JSON.stringify(result) })).status).toBe(204);
      }
      expect((await fetch(`${server.url}case`)).status).toBe(204);
      expect(await server.results).toEqual(cases.map((input) => ({ schemaVersion: 1, id: input.id, kind: "api", outcome: "value", value: null })));
      expect(() => validateProbeResult({ schemaVersion: 2 })).toThrow();
    } finally {
      server.stop();
      concurrent.stop();
    }
  });

  test("minimization deletes commands then shrinks arguments", async () => {
    const input: GraphicsCase = {
      schemaVersion: 1, id: "injected", kind: "graphics", width: 128, height: 128,
      commands: [{ op: "drawColor", args: [0] }, { op: "drawRect", args: [100, 50, 9, -8] }],
    };
    const reproduces = async (candidate: typeof input) => candidate.commands.some((command) => command.op === "drawRect" && command.args?.[0] !== 0);
    const minimized = await minimizeCaseBatched(input, async (candidates) => Promise.all(candidates.map(reproduces)));
    expect(minimized.commands).toHaveLength(1);
    expect(minimized.commands[0]!.op).toBe("drawRect");
    expect(await reproducesTwice(minimized, reproduces)).toBe(true);
  });

  test("graphics failures cluster by minimized operation shape", () => {
    const first: GraphicsCase = { schemaVersion: 1, id: "injected-first", kind: "graphics", width: 1, height: 1,
      commands: [{ op: "drawRect", args: [0, 0, 1, 1] }] };
    const second: GraphicsCase = { ...first, id: "injected-second", commands: [{ op: "drawCircle", args: [0, 0, 1] }] };
    const a = injectedProbeFailure(first).failure!, b = injectedProbeFailure(second).failure!;
    expect(a.matchKey).toBe(b.matchKey);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  test("graphics state reports tolerated float32 differences", () => {
    const input: GraphicsCase = { schemaVersion: 1, id: "float-state", kind: "graphics", width: 1, height: 1, commands: [] };
    const png = PNG.sync.write(new PNG({ width: 1, height: 1 })).toString("base64");
    const state = { width: 1, height: 1, saveCount: 1, center: 0, png,
      matrix: [1, 0.7867724], renderNode: [1, 1, 0.7023938], clip: [0, 0, 1, 1] };
    const result = (value: typeof state): ProbeResult => ({ schemaVersion: 1, id: input.id, kind: "graphics", outcome: "value", value });
    const near = { ...state, matrix: [1, 0.7867723703384399], renderNode: [1, 1, 0.7023937702178955] };
    expect(compareResult(input, result(state), result(near))).toBeNull();
    expect(graphicsPrecisionDeltas(result(state), result(near))).toEqual({});
    const rounded = { ...state, matrix: [1, Math.fround(0.7867724) + 5.960464477539063e-8] };
    expect(compareResult(input, result(state), result(rounded))).toBeNull();
    expect(graphicsPrecisionDeltas(result(state), result(rounded)).matrix).toBeGreaterThan(0);
    expect(compareResult(input, result(state), result({ ...state,
      renderNode: [1, 1, Math.fround(0.7023938) + 5.960464477539063e-8] }))?.matchKey)
      .toBe("graphics:state:renderNode");
    expect(compareResult(input, result(state), result({ ...near, center: 1 }))?.matchKey).toBe("graphics:state:center");
  });
});
