import { describe, expect, test } from "bun:test";
import { serveCases } from "../scripts/fuzz/case-server";
import { generateApiCases, generateGraphicsCases } from "../scripts/fuzz/generate";
import { minimizeCaseBatched, reproducesTwice } from "../scripts/fuzz/minimize";
import { SCHEMA_VERSION, validateProbeCase, validateProbeResult, type GraphicsCase } from "../scripts/fuzz/model";

describe("fuzz campaign core", () => {
  test("fixed seeds generate identical typed cases", () => {
    expect(generateApiCases(1234, 20)).toEqual(generateApiCases(1234, 20));
    expect(generateGraphicsCases(1234, 20)).toEqual(generateGraphicsCases(1234, 20));
    for (const input of [...generateApiCases(1234, 20), ...generateGraphicsCases(1234, 20)])
      expect(validateProbeCase(JSON.parse(JSON.stringify(input)))).toEqual(input);
  });

  test("case protocol orders and validates results", async () => {
    const cases = generateApiCases(2, 2);
    const server = serveCases(cases, 4877, 1_000);
    try {
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
});
