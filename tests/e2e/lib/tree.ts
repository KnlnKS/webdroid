// Structural diff of two view hierarchies: what the device laid out against what webdroid did.

import type { UiNode } from "../types.ts";

interface NodeDelta {
  key: string;
  /** device bounds, then ours */
  golden: [number, number, number, number];
  actual: [number, number, number, number];
  /** largest single-edge difference, px */
  off: number;
}

export interface TreeDiff {
  /** golden nodes carrying an identity both sides can express */
  comparable: number;
  matched: number;
  /** matched and within tolerance on all four edges */
  placed: number;
  /** share of comparable nodes that are missing or misplaced — lower is better */
  diffPct: number;
  meanOff: number;
  worst: NodeDelta[];
  missing: string[];
}

/** System UI is not the app's hierarchy and webdroid has no counterpart for it. */
const SYSTEM = /^com\.android\.systemui:|^android:id\/(statusBarBackground|navigationBarBackground)/;

/**
 * What both sides can name the same way. A resource id is exact; text and content-description
 * are what the tap resolver already matches on, so they are as stable here as they are there.
 * A node with none of the three is an anonymous container — there is nothing to compare it to.
 */
function keyOf(n: UiNode): string | null {
  if (n.resId && !SYSTEM.test(n.resId)) return "#" + n.resId;
  if (n.text) return "t:" + n.text;
  if (n.desc) return "d:" + n.desc;
  return null;
}

const bucket = (nodes: UiNode[]): Map<string, UiNode[]> => {
  const m = new Map<string, UiNode[]>();
  for (const n of nodes) {
    const k = keyOf(n);
    if (!k) continue;
    const list = m.get(k);
    if (list) list.push(n); else m.set(k, [n]);
  }
  return m;
};

export function diffTrees(golden: UiNode[], actual: UiNode[], tol = 2): TreeDiff {
  const g = bucket(golden), a = bucket(actual);
  let comparable = 0, matched = 0, placed = 0, sumOff = 0;
  const worst: NodeDelta[] = [];
  const missing: string[] = [];
  for (const [key, gs] of g) {
    comparable += gs.length;
    const as = a.get(key) ?? [];
    // several rows can share a key (a list of identical ids); pair them in document order
    for (let i = 0; i < gs.length; i++) {
      const av = as[i];
      if (!av) { missing.push(key + (gs.length > 1 ? ` [${i}]` : "")); continue; }
      matched++;
      const off = Math.max(...gs[i].bounds.map((v, j) => Math.abs(v - av.bounds[j])));
      sumOff += off;
      if (off <= tol) placed++;
      else worst.push({ key, golden: gs[i].bounds, actual: av.bounds, off });
    }
  }
  worst.sort((x, y) => y.off - x.off);
  return {
    comparable, matched, placed,
    diffPct: comparable ? (comparable - placed) / comparable * 100 : 0,
    meanOff: matched ? sumOff / matched : 0,
    worst: worst.slice(0, 5),
    missing: missing.slice(0, 8),
  };
}
