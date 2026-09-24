import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UiExplorer } from "../scripts/fuzz/ui-explorer";
import { generateUiAction, matchIdentity, uiStateKey, validateUiAction } from "../scripts/fuzz/ui-model";
import { Random } from "../scripts/fuzz/random";
import { parseUiAutomator } from "./e2e/lib/uiautomator";
import type { UiNode } from "./e2e/types";

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

  test("blind coordinates are only a recorded fallback", () => {
    const action = generateUiAction(new Random(1), [], 100, 100);
    if (action.type === "fallback-tap") {
      expect(action.at.x).toBeGreaterThanOrEqual(0);
      expect(action.at.x).toBeLessThan(1);
    } else {
      expect(["back", "enter", "background", "configuration"]).toContain(action.type);
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
      explorer.observeAction(initial, first, ["sample:method"], []);
      const next = explorer.observeState([node({ text: "Next", clickable: true })], 100, 100,
        { actions: [first], states: [initial], target: null });
      await explorer.save();

      const resumed = await UiExplorer.open(directory, "sample", apk);
      expect(resumed.choose(initial, new Random(12))).not.toEqual(first);
      expect(resumed.summary()).toEqual({ states: 2, actions: 1, coverage: 1, signals: 0 });
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
        explorer.observeAction(initial, action, [], []);
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
        resumed.observeAction(state, action, [], []);
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
