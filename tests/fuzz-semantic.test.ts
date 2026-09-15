import { describe, expect, test } from "bun:test";
import { generateUiAction, matchIdentity } from "../scripts/fuzz/ui-model";
import { Random } from "../scripts/fuzz/random";
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
});
