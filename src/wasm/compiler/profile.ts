import { PROFILE_BASE, PROFILE_ROWS, PROFILE_WORDS } from "./consts.ts";
import { OP, type Code } from "./code.ts";
import { T } from "./wasmbin.ts";
import { siteKey } from "./sites.ts";
import type { Compiler } from "./j2w.ts";
import type { MethodInfo } from "./program.ts";

// The words of a row of the process-local sketch of first-tier call targets: the site's fingerprint, two (dispatch slot + 1, count) pairs and the site's
// observations, which stop at SATURATED. The first site and targets to claim a row keep it: collisions and broad sites lose optimization only, since every
// planned target still tests the live slot.
const TAG = 0, PAIRS = [1, 3], TOTAL = 5, SATURATED = 1024;
/** what the planner needs before it trusts a row: enough observations, most of them of the recorded targets */
const MIN_OBSERVED = 4, MIN_SHARE = 0.75;

function fingerprint(m: MethodInfo, ins: { pc: number }): number {
  const key = siteKey(m, ins);
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0 || 1;
}

/** the dispatch slots a call reached, busiest first; "broad" when they spread beyond the two recorded */
export type SiteProfile = "unseen" | "broad" | number[];
export function siteProfile(buffer: ArrayBuffer, m: MethodInfo, ins: { pc: number }): SiteProfile {
  const key = fingerprint(m, ins), row = new Uint32Array(buffer, PROFILE_BASE + (key & (PROFILE_ROWS - 1)) * PROFILE_WORDS * 4, PROFILE_WORDS);
  if (row[TAG] !== key || row[TOTAL] < MIN_OBSERVED) return "unseen";
  const pairs = PAIRS.map((p) => [row[p] - 1, row[p + 1]]).filter(([, n]) => n > 0);
  if (pairs.reduce((sum, [, n]) => sum + n, 0) < row[TOTAL] * MIN_SHARE) return "broad";
  return pairs.sort((a, b) => b[1] - a[1]).map(([slot]) => slot);
}

/** records the dispatch slot on the stack, leaving it there, when the activation samples (Compiler.emitCount) */
export function emitProfile(cx: Compiler, c: Code, m: MethodInfo, ins: { pc: number }, sampled: number): void {
  cx.scratch();
  c.lget(sampled).ifType(cx.mb.addFuncType([T.i32], [T.i32]));
  c.i32(fingerprint(m, ins)).call(cx.defineFn("profile", [T.i32, T.i32], [T.i32], (b) => {
    const at = b.newLocal(T.i32), word = b.newLocal(T.i32), load = (w: number) => b.lget(at).mem(OP.i32_load, 2, 4 * w);
    const store = (w: number, value: () => void) => { b.lget(at); value(); b.mem(OP.i32_store, 2, 4 * w); };
    const inc = (w: number) => store(w, () => load(w).i32(1).raw(OP.i32_add));
    b.lget(1).i32(PROFILE_ROWS - 1).raw(OP.i32_and).i32(PROFILE_WORDS * 4).raw(OP.i32_mul).i32(PROFILE_BASE).raw(OP.i32_add).lset(at);
    b.block();
    load(TAG).ltee(word).lget(1).raw(OP.i32_ne).if_();
    b.lget(word).brIf(1);
    store(TAG, () => b.lget(1));
    b.end();
    load(TOTAL).i32(SATURATED).raw(OP.i32_ge_u).brIf(0);
    inc(TOTAL);
    // the pair that holds the slot, else the first free one
    for (const p of PAIRS) {
      load(p).ltee(word).raw(OP.i32_eqz).lget(word).lget(0).i32(1).raw(OP.i32_add, OP.i32_eq, OP.i32_or).if_();
      store(p, () => b.lget(0).i32(1).raw(OP.i32_add));
      inc(p + 1);
      b.br(1).end();
    }
    b.end().lget(0);
  }, true)).end();
}
