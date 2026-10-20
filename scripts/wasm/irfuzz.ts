// Generator of methods whose control flow javac never produces: random graphs of basic blocks (so cycles with several entries), written as a class file
// of version 50 (the type-inferring verifier takes any flow) that d8 converts like any other class. A fuel local ends every cycle. Handler blocks cover
// random runs of the layout, so exception edges meet the same graph. The signature is the one of fuzz.ts' methods.
import { Pool, classFile, method, u2 } from "./classfile.ts";

type T = "I" | "J" | "F" | "D";
type Rnd = (n: number) => number;

const LOCAL: Record<T, number[]> = { I: [6, 7], J: [8, 10], F: [12, 13], D: [14, 16] };
const PARAM: Record<T, number> = { I: 0, J: 1, F: 3, D: 4 };
const FUEL = 18, MAX_LOCALS = 19;
const LOAD: Record<T, number> = { I: 0x15, J: 0x16, F: 0x17, D: 0x18 }, STORE: Record<T, number> = { I: 0x36, J: 0x37, F: 0x38, D: 0x39 };
const ARITH: Record<T, number[]> = { I: [0x60, 0x64, 0x68, 0x7e, 0x80, 0x82], J: [0x61, 0x65, 0x69, 0x7f, 0x81, 0x83], F: [0x62, 0x66, 0x6a], D: [0x63, 0x67, 0x6b] };
const DIV: Record<T, number[]> = { I: [0x6c, 0x70], J: [0x6d, 0x71], F: [0x6e, 0x72], D: [0x6f, 0x73] };
const CONV: Record<string, number> = { IJ: 0x85, IF: 0x86, ID: 0x87, JI: 0x88, JF: 0x89, JD: 0x8a, FI: 0x8b, FJ: 0x8c, FD: 0x8d, DI: 0x8e, DJ: 0x8f, DF: 0x90 };
const CONSTS = [0, 1, -1, 2, 7, 31, 100, 255, 32767, -32768, 0x7fffffff, -0x80000000, 0x5bd1e995];

class Asm {
  b: number[] = []; fix: { at: number; from: number; label: number }[] = []; at: number[] = [];
  op(...x: number[]) { this.b.push(...x); }
  u2(v: number) { this.b.push((v >> 8) & 255, v & 255); }
  label(l: number) { this.at[l] = this.b.length; }
  jump(op: number, l: number) { this.fix.push({ at: this.b.length + 1, from: this.b.length, label: l }); this.op(op, 0, 0); }
  tableswitch(labels: number[], dflt: number) {
    const from = this.b.length, word = (v: number) => this.op(v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255), target = (l: number) => { this.fix.push({ at: this.b.length, from, label: l }); word(0); };
    this.op(0xaa);
    while (this.b.length % 4) this.op(0);
    target(dflt); word(0); word(labels.length - 1);
    for (const l of labels) target(l);
  }
  finish() {
    for (const f of this.fix) {
      const d = this.at[f.label] - f.from, wide = this.b[f.from] === 0xaa;
      if (wide) { this.b[f.at] = d >>> 24; this.b[f.at + 1] = (d >> 16) & 255; this.b[f.at + 2] = (d >> 8) & 255; this.b[f.at + 3] = d & 255; } else { this.b[f.at] = (d >> 8) & 255; this.b[f.at + 1] = d & 255; }
    }
    return this.b;
  }
}

export function irreducibleClass(name: string, count: number, rnd: Rnd): Uint8Array {
  const pool = new Pool(), methods: number[][] = [];
  const pick = <X>(a: X[]) => a[rnd(a.length)];
  const types: T[] = ["I", "J", "F", "D"];
  for (let n = 0; n < count; n++) {
    const a = new Asm();
    const push = (t: T, d: number) => {
      if (d <= 0 || !rnd(3)) {
        if (rnd(3)) { a.op(LOAD[t], pick(rnd(3) ? LOCAL[t] : [PARAM[t]])); return; }
        const v = pick(CONSTS);
        if (v === (v << 16 >> 16)) { a.op(0x11); a.u2(v & 0xffff); } else { a.op(0x13); a.u2(pool.int(v)); }
        if (t !== "I") a.op(CONV["I" + t]);
        return;
      }
      switch (rnd(5)) {
        case 0: case 1: push(t, d - 1); push(t, d - 1); a.op(pick(ARITH[t])); return;
        case 2: {
          push(t, d - 1); push(t, d - 1);
          if (t === "I" || t === "J") { if (rnd(8)) { a.op(t === "I" ? 0x04 : 0x0a, t === "I" ? 0x80 : 0x81); } }
          a.op(pick(DIV[t])); return;
        }
        case 3: { const u = pick(types.filter((x) => x !== t)); push(u, d - 1); a.op(CONV[u + t]); return; }
        default:
          if (t === "J") { push("J", d - 1); push("I", d - 1); a.op(pick([0x79, 0x7b, 0x7d])); return; }
          push("I", d - 1); push("I", d - 1); a.op(pick([0x78, 0x7a, 0x7c])); if (t !== "I") a.op(CONV["I" + t]);
      }
    };
    const stmt = () => { const t = pick(types); push(t, 2); a.op(STORE[t], pick(LOCAL[t])); };
    const cond = (target: number) => {
      const t = pick<T>(["I", "I", "J", "F", "D"]);
      push(t, 1); if (t === "I") { push("I", 1); a.jump(pick([0x9f, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4]), target); return; }
      push(t, 1);
      a.op({ J: 0x94, F: rnd(2) ? 0x95 : 0x96, D: rnd(2) ? 0x97 : 0x98 }[t]);
      a.jump(pick([0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e]), target);
    };
    // labels: 0..nb-1 blocks, nb.. handlers, then exit
    const nb = 4 + rnd(9), nh = rnd(3), exit = nb + nh;
    const layout = [0, ...Array.from({ length: nb + nh - 1 }, (_, i) => i + 1).sort(() => rnd(3) - 1)];
    const ret = pick(types), retOp = { I: 0xac, J: 0xad, F: 0xae, D: 0xaf }[ret];
    // prologue: initialize every local the blocks use, and the fuel
    for (const t of types) for (const l of LOCAL[t]) { a.op(LOAD[t], PARAM[t], STORE[t], l); }
    a.op(0x10, 18 + rnd(30), 0x36, FUEL);
    a.jump(0xa7, 0);
    const start = new Map<number, number>(), end = new Map<number, number>();
    for (const l of layout) {
      a.label(l);
      start.set(l, a.b.length);
      if (l >= nb) a.op(0x57);
      a.op(0x84, FUEL, 0xff, 0x15, FUEL); a.jump(0x9e, exit);
      for (let s = rnd(4); s >= 0; s--) stmt();
      const block = () => rnd(nb);
      switch (rnd(4)) {
        case 0: a.jump(0xa7, block()); break;
        case 1: cond(block()); a.jump(0xa7, block()); break;
        default: push("I", 1); a.op(0x06, 0x7e); a.tableswitch([block(), block(), block(), block()], exit);
      }
      end.set(l, a.b.length);
    }
    a.label(exit);
    const fold: Record<T, () => void> = {
      I: () => { a.op(0x15, 6, 0x15, 7, 0x10, 31, 0x68, 0x82, 0x16, 8, 0x88, 0x82, 0x17, 12, 0x8b, 0x82, 0x18, 14, 0x8e, 0x82); },
      J: () => { a.op(0x16, 8, 0x16, 10, 0x8a, 0x8f, 0x83, 0x15, 6, 0x85, 0x83, 0x17, 12, 0x8c, 0x83); },
      F: () => { a.op(0x17, 12, 0x15, 7, 0x86, 0x62, 0x18, 14, 0x90, 0x62, 0x16, 8, 0x89, 0x62); },
      D: () => { a.op(0x18, 14, 0x17, 12, 0x8d, 0x63, 0x15, 6, 0x87, 0x63, 0x16, 10, 0x8a, 0x63); },
    };
    fold[ret](); a.op(retOp);
    const code = a.finish();
    // a handler covers a run of consecutive normal blocks of the layout, never itself
    const table = Array.from({ length: nh }, (_, i) => {
      const normal = layout.map((l, p) => (l < nb ? p : -1)).filter((p) => p >= 0), lo = pick(normal);
      let hi = lo;
      while (layout[hi + 1] < nb && rnd(2)) hi++;
      const type = pick([null, "java/lang/ArithmeticException", "java/lang/RuntimeException"]);
      return [...u2(start.get(layout[lo])!), ...u2(end.get(layout[hi])!), ...u2(start.get(nb + i)!), ...u2(type ? pool.cls(type) : 0)];
    });
    methods.push(method(pool, 8, `m${n}`, "(IJFD)" + ret, code, { stack: 24, locals: MAX_LOCALS, handlers: table }));
  }
  return classFile(pool, { name, methods, major: 50 });
}
