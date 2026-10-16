import { expect, test, describe } from "bun:test";
import { PNG } from "pngjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addReachedMembers, buildCatalog, parseApiVersions } from "../scripts/fuzz/catalog.ts";
import { JObj, Runtime, stubs } from "../src/jvm/runtime.ts";
import { serveCases } from "../scripts/fuzz/case-server.ts";
import { compareResult, graphicsPrecisionDeltas } from "../scripts/fuzz/compare.ts";
import { generateApiCases, generateGraphicsCases } from "../scripts/fuzz/generate.ts";
import { injectedProbeFailure } from "../scripts/fuzz/injected.ts";
import { minimizeCaseBatched, reproducesTwice } from "../scripts/fuzz/minimize.ts";
import { GRAPHICS_OPERATIONS, SCHEMA_VERSION, validateProbeCase, validateProbeResult, type GraphicsCase, type ProbeResult } from "../scripts/fuzz/model.ts";
import { UiExplorer } from "../scripts/fuzz/ui-explorer.ts";
import { generateUiAction, matchIdentity, uiStateKey, validateUiAction } from "../scripts/fuzz/ui-model.ts";
import { Random } from "../scripts/fuzz/random.ts";
import { parseUiAutomator } from "./e2e/lib/uiautomator.ts";
import type { UiNode } from "./e2e/types.ts";

describe("fuzz-catalog", () => {
  const XML = `<?xml version="1.0"?>
  <api version="3">
    <class name="android/example/Value" since="2">
      <extends name="java/lang/Object"/>
      <method name="&lt;init>()V"/>
      <method name="answer()I" since="3"/>
      <method name="future()V" since="34"/>
      <field name="VALUE"/>
    </class>
    <class name="android/example/Removed" removed="30">
      <method name="gone()V"/>
    </class>
  </api>`;

  test("API catalog filters future members and distinguishes placeholders", () => {
    expect(parseApiVersions(XML, 33).map((member) => member.signature)).toEqual([
      "android/example/Value", "<init>()V", "answer()I", "VALUE", "android/example/Removed", "gone()V",
    ]);

    class Value extends JObj {}
    const runtime = new Runtime();
    runtime.register({ name: "java/lang/Object", ctor: class extends JObj {} });
    runtime.register({
      name: "android/example/Value", ctor: Value,
      methods: { "<init>()V": function () {}, ...stubs(0, "answer()I") },
      statics: { VALUE: 42 },
    });
    const catalog = buildCatalog({ sdk: 33, xml: XML, runtime, frameworkDexes: [] });
    const status = new Map(catalog.members.map((member) => [`${member.owner}.${member.signature}`, member.support]));
    expect(status.get("android/example/Value.<init>()V")).toBe("delegate");
    expect(status.get("android/example/Value.answer()I")).toBe("placeholder");
    expect(status.get("android/example/Value.VALUE")).toBe("delegate");
    expect(status.get("android/example/Removed.gone()V")).toBe("platform-absent");
    expect(catalog.members.every((member) => !member.exercised)).toBe(true);

    const reached = {
      classes: new Map<string, number>(),
      methods: new Map([["android/example/Value.answer()I", 2], ["android/example/Hidden.call()V", 3]]),
      fields: new Map<string, number>(),
    };
    addReachedMembers(catalog, reached, runtime, []);
    expect(catalog.members.find((member) => member.signature === "answer()I")?.sites).toBe(2);
    expect(catalog.members.find((member) => member.owner === "android/example/Hidden")).toMatchObject({
      source: "reached-hidden", support: "missing", sites: 3,
    });
  });
});

describe("fuzz-core", () => {
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
});

describe("fuzz-semantic", () => {
  const node = (overrides: Partial<UiNode> = {}): UiNode => ({
    text: "", desc: "", cls: "android.widget.Button", resId: "", bounds: [0, 0, 100, 100],
    clickable: false, enabled: true, editable: false, scrollable: false, ...overrides,
  });

  describe("semantic UI fuzzing", () => {
    test("selection is deterministic and never targets disabled nodes", () => {
      const nodes = [
        node({ text: "Disabled", clickable: true, enabled: false }),
        node({ resId: "app:id/name", editable: true }),
        node({ text: "Save", clickable: true }),
      ];
      const left = generateUiAction(new Random(42), nodes, 100, 100);
      const right = generateUiAction(new Random(42), nodes, 100, 100);
      expect(left).toEqual(right);
      if ("target" in left) {
        expect(left.target.text).not.toBe("Disabled");
        expect(matchIdentity(nodes, left.target)).not.toBeNull();
      }
    });

    test("uiautomator parsing and action validation share strict boundaries", () => {
      const nodes = parseUiAutomator('<?xml version="1.0"?><hierarchy><node text="Save &amp; close" content-desc="" class="android.widget.Button" resource-id="app:id/save" clickable="true" enabled="true" bounds="[1,2][31,42]" /></hierarchy>');
      expect(nodes).toEqual([node({ text: "Save & close", resId: "app:id/save", clickable: true, bounds: [1, 2, 31, 42] })]);
      expect(validateUiAction({ type: "tap", target: { className: "android.widget.Button", ordinal: 0 }, at: { x: 0.5, y: 0.5 } })).toEqual({
        type: "tap", target: { className: "android.widget.Button", ordinal: 0 }, at: { x: 0.5, y: 0.5 },
      });
      expect(() => validateUiAction({ type: "configuration", orientation: "diagonal" })).toThrow();
    });

    test("Compose screens with the same controls retain distinct content identities", () => {
      const controls = [node({ resId: "app:id/continue", text: "Continue", clickable: true })];
      const screen = (message: string) => [node({ cls: "androidx.compose.ui.platform.AndroidComposeView", text: message, enabled: false }), ...controls];
      const initial = screen("Sign in");
      expect(uiStateKey(initial)).not.toBe(uiStateKey(screen("Account deleted")));
      expect(uiStateKey(initial)).not.toBe(uiStateKey([initial[0]!, { ...initial[1]!, bounds: [50, 50, 100, 100] }]));
    });

    test("exploration resumes at an untried action after a saved restart", async () => {
      const directory = mkdtempSync(join(tmpdir(), "wd-ui-explorer-"));
      try {
        const apk = join(directory, "sample.apk");
        await Bun.write(apk, "test apk bytes");
        const nodes = [node({ text: "Open", clickable: true })];
        const explorer = await UiExplorer.open(directory, "sample", apk);
        const initial = explorer.observeState(nodes, 100, 100, { actions: [], states: [], target: null });
        const first = explorer.choose(initial, new Random(12));
        if (!first) throw new Error("expected a UI action");
        explorer.observeAction(initial, first, []);
        const next = explorer.observeState([node({ text: "Next", clickable: true })], 100, 100,
          { actions: [first], states: [initial], target: null });
        await explorer.save();

        const resumed = await UiExplorer.open(directory, "sample", apk);
        expect(resumed.choose(initial, new Random(12))).not.toEqual(first);
        expect(resumed.summary()).toEqual({ states: 2, actions: 1, signals: 0 });
        expect(resumed.nextPrefix(new Set())).toEqual({ actions: [], states: [], target: initial });
        expect(next).not.toBe(initial);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    test("a stable list can be scrolled repeatedly with a bounded saved budget", async () => {
      const directory = mkdtempSync(join(tmpdir(), "wd-ui-scroll-"));
      try {
        const apk = join(directory, "sample.apk");
        await Bun.write(apk, "test apk bytes");
        const firstPage = [node({ text: "First page", scrollable: true })];
        const explorer = await UiExplorer.open(directory, "sample", apk);
        const initial = explorer.observeState(firstPage, 100, 100, { actions: [], states: [], target: null });
        for (let index = 0; index < 2; index++) {
          const action = explorer.choose(initial, new Random(1));
          if (!action) throw new Error("expected scroll action");
          expect(action.type).toBe("scroll");
          explorer.observeAction(initial, action, []);
        }
        await explorer.save();

        const resumed = await UiExplorer.open(directory, "sample", apk);
        const nextPage = [node({ text: "Second page", scrollable: true })];
        const state = resumed.observeState(nextPage, 100, 100, { actions: [], states: [], target: null });
        expect(state).not.toBe(initial);
        for (let index = 0; index < 2; index++) {
          const action = resumed.choose(state, new Random(1));
          if (!action) throw new Error("expected scroll action");
          expect(action.type).toBe("scroll");
          resumed.observeAction(state, action, []);
        }
        expect(resumed.choose(state, new Random(1))?.type).not.toBe("scroll");
        resumed.observeState(firstPage, 100, 100, { actions: [], states: [], target: null });
        expect(resumed.choose(initial, new Random(1))?.type).not.toBe("scroll");
        expect(resumed.summary().actions).toBe(4);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});
