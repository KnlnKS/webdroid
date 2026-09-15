import { describe, expect, test } from "bun:test";
import { generateUiAction, matchIdentity, validateUiAction } from "../scripts/fuzz/ui-model";
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
});
