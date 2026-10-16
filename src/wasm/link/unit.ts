// The second tier compiled for another World: a compile worker holds a World over the same Program and the same numbering, built from a copy of the dex files, and compiles what
// the World it works for asks (World.upgradeJob). The code it makes names classes, selectors, slots and gaps by number, so it is the other World's only while that World has
// numbered the same things in the same order: the worker follows the numbering of the World it compiles for (`sync`), numbers what its unit needs beyond that as that World
// would (`numbering`), and the World takes the unit only if it has not numbered anything meanwhile (World.adoptUnit); otherwise the worker forgets what it numbered.
import { Compiler } from "../compiler/j2w.ts";
import { methodOf, mid } from "../compiler/ids.ts";
import { unitHeader, type Marks, type Numbering, type UnitHeader } from "./aot.ts";
import type { World } from "./world.ts";

/** the second-tier compile of a method, as World.upgradeJob describes it */
export interface UpgradeJob {
  /** the number its unit's function names carry */
  unit: number;
  /** A refresh may replace only this live hot-unit generation in the source World. */
  refresh?: number;
  /** first-tier code of methods already linked, merged into one module (World.mergeJob) */
  merge?: boolean;
  /** the methods it installs, and the small ones it copies in for its own calls (method ids), first the method asked for */
  installed: string[]; copies: string[];
  /** per virtual call (declaring class, name, descriptor), the implementations worth a guarded direct call (method ids) */
  plan: [string, string[]][];
  /** Successful, prepared initiating identities needed by these methods. */
  resolved?: [referrer: string, name: string, key: string][];
  /** Declaration hierarchies prepared by Java loading in the source World. */
  prepared?: [key: string, sup: string | null, ifaces: string[]][];
  /** the methods of the unit that ran a long loop (World.longLoops) */
  long: string[];
}
export interface UnitResult {
  header: UnitHeader;
  /** what the unit numbered beyond the World it was asked by: that World takes it, or does not take the unit */
  numbering: Numbering;
  /** the unit's module: its bytes as the worker sends them, since a compiled module does not cross to another agent cluster (as from the compile host's
   *  frame), then compiled where they arrive (CompileClient) */
  module: Uint8Array | WebAssembly.Module;
  /** the stack traces of its functions: name, method id, Wasm offsets and the dex pcs they belong to */
  traces: { name: string; m: string; offsets: Int32Array; pcs: Int32Array }[];
}

export class UnitCompiler {
  /** the numbering the World compiled for had when the last job arrived */
  private w: World;
  private known: Marks;
  constructor(w: World) { this.w = w; this.known = w.numbering(); }
  /** follows the World compiled for: `keep` says it took the numbering of the previous unit (otherwise that is forgotten first), and `sync` is what it numbered since; false if the two do not line up */
  sync(sync: Numbering, keep: boolean): boolean {
    if (!keep) this.w.rollback(this.known);
    if (!this.w.adopt(sync)) return false;
    this.known = this.w.numbering();
    return true;
  }
  /** the unit for `job`: an error message if the job does not follow this World */
  upgrade(job: UpgradeJob): UnitResult | string {
    const w = this.w, method = (id: string) => methodOf(w.prog, id)!;
    for (const [referrer, name, key] of job.resolved ?? []) {
      if (!w.prog.has(referrer) || !w.prog.has(key)) return `missing resolved worker identity ${referrer}: ${name} -> ${key}`;
      const prior = w.prog.initiatedBy(w.prog.loaderOf(referrer), name);
      if (prior && prior !== key) return `conflicting resolved worker identity ${referrer}: ${name} -> ${key}, already ${prior}`;
    }
    if (job.resolved?.length && !job.prepared?.length) return "missing prepared worker hierarchies";
    const prepared = new Set((job.prepared ?? []).map(([key]) => key));
    for (const [, , key] of job.resolved ?? []) if (!prepared.has(key)) return `missing prepared worker hierarchy ${key}`;
    for (const [key, sup, ifaces] of job.prepared ?? []) {
      const cls = w.prog.get(key);
      if (!cls || cls.sup !== sup || cls.ifaces.length !== ifaces.length || cls.ifaces.some((name, i) => name !== ifaces[i])) return `mismatched prepared worker hierarchy ${key}`;
    }
    for (const [referrer, name, key] of job.resolved ?? []) w.initiateClass(w.prog.loaderOf(referrer), name, key);
    w.plan = new Map(job.plan.map(([key, ids]) => [key, ids.map(method)]));
    w.longLoops = new Set(job.long);
    w.stats.units = job.unit;
    const cx = new Compiler(w);
    w.beginTouch();
    const { bytes, traces } = cx.buildUnit(job.installed.map(method), job.copies.map(method), !job.merge, job.merge && "merge");
    const touch = w.endTouch();
    return { header: unitHeader(w, cx, touch), numbering: w.since(this.known), module: bytes,
      traces: traces.map((t) => ({ name: t.name, m: t.m ? mid(t.m) : "", offsets: t.offsets, pcs: t.pcs })) };
  }
}
