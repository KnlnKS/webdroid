import type { SymbolicSite } from "../compiler/sites";
// Ahead-of-time compilation of the platform classes (plan S4): the code Compiler.buildUnit and World.classModule would produce on demand is
// produced once, at build time, and stored as static assets; at run time the World loads them instead of compiling.
//
// What makes precompiled code link into a World that also compiles app code on demand is that nothing in it depends on what ran first:
//  - Numbering. Class ids, the table slots of every method, selectors, runtime-function slots and gap ids are numbered by the build; the
//    runtime numbers the platform classes the same way (World.seedPlatform: definition order) and takes the rest from the index.
//  - Class modules ("D") hold the globals of a group of classes (vtable, init word, statics), their lazy-link stubs and `ensure` functions;
//    they import nothing from other modules, so they instantiate in any order. Code modules ("C") hold the methods of a group of classes,
//    install them in the table when instantiated, and import the globals of the D modules they name. A C module that is loaded makes sure
//    that every class it touches has its D module, so no slot it can call is empty.
//  - Soundness. A C module records the class-hierarchy decisions it relies on. They are checked when it is loaded, against the classes
//    added since the build, and kept with the other assumptions of the World afterwards, so a dex added later undoes them like the rest;
//    a method whose decisions do not hold is put back to its lazy-link stub, and compiled on demand.
import type { ClassRt, World } from "./world";
import type { InfoRecord } from "./classes";
import type { DexFile } from "../../jvm/dex";
import { methodCount, type MethodInfo } from "../compiler/program";
import type { Compiler, FnTrace } from "../compiler/j2w";
import { methodOf } from "../compiler/ids";

/** the files of a build, read synchronously: a page fetches them (and may compile them) before the code that needs them runs */
export interface AotStore {
  /** a module file: its bytes, or the module itself where the host has compiled it ahead of use; "index.json" is always bytes. A file the host does not
   *  have is a miss: the code it holds is compiled on demand instead. */
  get(file: string): Uint8Array | WebAssembly.Module | undefined;
}
/** how a build groups the platform classes: classes with the same key share a D (data) or C (code) module; no C key leaves a class to the on-demand compiler */
export interface AotBuild { dGroup(cls: string): string; cGroup(cls: string): string | null; /** the dexes whose classes are numbered and compiled */ dexes: Set<DexFile>; /** application dexes included by an optional combined image */ appDexes?: Set<DexFile> }

export const DEOPT_ABI = 3;
export interface AotIndex {
  version: number;
  /** 0: no handoff support; DEOPT_ABI: runtime-guarded compiled activation contract. */
  deopt?: number;
  /** ids of the dexes of the build's Program, in class path order, and how many classes with bytecode they define: the Program of a World must start the same way */
  dexes: string[];
  programClasses: number;
  /** the dexes whose classes the build numbers (from 1, in definition order) and compiles, and how many classes that is */
  aotDexes: string[];
  classes: number;
  /** the other ids, in order: array classes, classes without bytecode */
  extraNames: string[];
  /** slots reserved after the platform classes, in order: [class, size] or a runtime function's name */
  tail: (string | [string, number])[];
  selectors: string[];
  gaps: string[];
  /** the link errors compiled code throws, by index */
  linkMessages: string[];
  /** the methods the build replaced by intrinsics, "class.name+descriptor" */
  intrinsics: string[];
  /** the D module of the classes the build reserved slots for after the platform's (array classes, ...), which are all in one */
  extraGroup: number;
  /** the D and C module of each platform class, run-length coded as (value, count) pairs; -1: none */
  dOf: number[];
  cOf: number[];
}
/** what a module says about itself, in its custom section "aot" */
export interface DHeader { classes: number[]; touch: number[]; synth: string[] }
/** what compiled code relies on and needs before it runs: the same for a precompiled module and for a unit a worker compiled */
export interface UnitHeader {
  deopt?: number;
  /** the classes (ids) and runtime functions its code names a table slot of, which need their stubs */
  touch: number[]; synth: string[];
  /** native imports by method id */
  natives: string[];
  symbols?: SymbolicSite[];
  /** class-hierarchy decisions: declaring class, name, descriptor, the one target's class and key ("" without one), and the slot of the method that relies on it */
  assumptions: [string, string, string, string, string, number][];
  allocs: string[];
  /** classes missing at the build that sites of the module fail on, with the slot of the method they are in */
  missing: [string, number][];
  /** the gaps its code runs into, by id */
  gaps: number[];
}
export interface CHeader extends UnitHeader {
  classes: number[];
  /** the D modules of the platform build it imports class globals from, "g<D module>"; a module of an app build imports them from the classes' own modules, by class id */
  mods: string[];
  /** the slots of methods of its classes the module lacks: abstract ones, natives without an implementation, and those the compiler produced invalid code for */
  absent: number[];
}
export const VERSION = 5;

/** the sizes of what a World numbers, which only grow */
export interface Marks { names: number; tail: number; selectors: number; gaps: number; links: number }
/** a slot reservation after the platform classes: a block for a class (name, size) or a runtime function's slot (its name) */
export type Tail = string | [string, number];
/** what was numbered after `from`, in order: replaying it in a World at `from` numbers everything the same way */
export interface Numbering { from: Marks; names: string[]; tail: Tail[]; selectors: string[]; gaps: string[]; links: string[] }
export const sameMarks = (a: Marks, b: Marks): boolean => a.names === b.names && a.tail === b.tail && a.selectors === b.selectors && a.gaps === b.gaps && a.links === b.links;

/** an app compiled ahead on top of the platform build (the build `apps.ts` makes): the numbering of what its code names that the platform does not, and code modules a1.. for the app's classes */
export const APP_VERSION = 5;
/** what launches built on demand because no saved code had it: method ids and class names, in order of first use, and the questions the host was asked that made synthetic functions */
export interface Demand { methods: string[]; classes: string[]; infos: InfoRecord[]; verdicts?: Verdict[] }
/** whether a decision of the platform build (`decl.name+desc` resolves to `tc`'s `tk`) stands over the app's classes, as a launch found it */
export type Verdict = [key: string, tc: string, tk: string, stands: boolean];
export interface AppIndex {
  version: number;
  deopt?: number;
  /** the numbering it continues: only a World that has attached the platform build and numbered nothing since can use it */
  base: Marks;
  /** the dexes of the app that follow the platform's in the Program, and how many classes with bytecode they define */
  dexes: string[];
  classes: number;
  numbering: Numbering;
  /** the code module of each class block, as (block, module) pairs; modules are files a<module>.wasm */
  cOf: [number, number][];
  /** the modules that are patches of platform code modules, as (module, platform module) pairs: their methods are installed after the platform module is, over its own */
  patches: [number, number][];
  modules: number;
  /** the synthetic functions (names) the modules s<module>.wasm put in their slots */
  synths: string[][];
  /** the data module of each class block it holds the globals of, as (block, module) pairs; modules are files e<module>.wasm */
  dOf: [number, number][];
  dModules: number;
  /** what the build was asked to include beyond the app's likely methods: a build made later includes it too */
  demand: Demand;
}
/** the module of synthetic functions: what it relies on, and the functions it holds */
export interface SHeader extends UnitHeader { names: string[] }
/** what compiled code (built by `cx`, whose classes were touched while it was made) relies on, by the numbers of `w` */
export function unitHeader(w: World, cx: Compiler, touch: Set<string>): UnitHeader {
  const seen = new Set<string>(), assumptions: UnitHeader["assumptions"] = [];
  for (const [decl, name, desc, target, owner] of cx.assumptions) {
    const slot = w.slotOf(owner!), key = `${decl}.${name}${desc}@${slot}`;
    if (!seen.has(key)) { seen.add(key); assumptions.push([decl, name, desc, target?.cls ?? "", target?.key ?? "", slot]); }
  }
  return { deopt: cx.deopt ? DEOPT_ABI : 0, touch: [...touch].filter((n) => n[0] !== "!").map((n) => w.idOf(n)), synth: [...touch].filter((n) => n[0] === "!").map((n) => n.slice(1)),
    natives: [...cx.nativeImports.keys()], symbols: [...cx.symbolicImports.values()].map(v => v.site), assumptions, allocs: [...cx.allocs],
    missing: cx.absent.map(([name, owner]) => [name, w.slotOf(owner!)] as [string, number]), gaps: [...new Set(cx.gaps)].map((g) => w.gapId(g)) };
}
/** what identifies a dex of the platform: DexFile.id is its SHA-1, but only where the engine has Uint8Array.toHex for views into a larger buffer */
const dexSig = (d: DexFile): string => [d.fileSize, d.classDefCount, d.stringCount, d.typeCount, d.version].join(":");

const rle = (a: number[]): number[] => { const o: number[] = []; for (const v of a) { if (o.length && o[o.length - 2] === v) o[o.length - 1]++; else o.push(v, 1); } return o; };
const unrle = (a: number[]): Int32Array<ArrayBuffer> => { let n = 0; for (let i = 1; i < a.length; i += 2) n += a[i]; const o = new Int32Array(n); let k = 0; for (let i = 0; i < a.length; i += 2) o.fill(a[i], k, k += a[i + 1]); return o; };
const uleb = (n: number, o: number[]) => { for (; n >= 0x80; n = Math.floor(n / 128)) o.push((n % 128) | 0x80); o.push(n); };
/** `wasm` with the custom sections the runtime reads: the header, and the traces of its functions */
export function packModule(header: object, wasm: Uint8Array, traces?: { slot: number; offsets: Int32Array; pcs: Int32Array }[]): Uint8Array {
  const section = (name: string, body: Uint8Array) => {
    const n = new TextEncoder().encode(name), pre: number[] = [0], inner: number[] = [];
    uleb(n.length, inner);
    uleb(n.length + inner.length + body.length, pre);
    return [Uint8Array.from(pre), Uint8Array.from(inner), n, body];
  };
  // a function's trace is its slot, its length in bytes and then the count, ascending offsets and the pcs they belong to (both as differences): a reader skips the functions it does not want
  const t: number[] = [];
  for (const { slot, offsets, pcs } of traces ?? []) {
    const body: number[] = [];
    uleb(offsets.length, body);
    let o = 0, p = 0;
    for (let i = 0; i < offsets.length; i++) { uleb(offsets[i] - o, body); o = offsets[i]; uleb((((pcs[i] - p) << 1) ^ ((pcs[i] - p) >> 31)) >>> 0, body); p = pcs[i]; }
    uleb(slot, t); uleb(body.length, t);
    for (const x of body) t.push(x);
  }
  const parts = [wasm, ...section("aot", new TextEncoder().encode(JSON.stringify(header))), ...(traces ? section("aottrace", Uint8Array.from(t)) : [])];
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of parts) { out.set(x, at); at += x.length; }
  return out;
}
const customSection = (m: WebAssembly.Module, name: string): Uint8Array => new Uint8Array(WebAssembly.Module.customSections(m, name)[0]);
const header = <H>(m: WebAssembly.Module): H => JSON.parse(new TextDecoder().decode(customSection(m, "aot"))) as H;
function unleb(b: Uint8Array, at: number[]): number { let n = 0, s = 1; for (;;) { const x = b[at[0]++]; n += (x & 127) * s; if (x < 128) return n; s *= 128; } }

const LIVE = 1, DEAD = 2, LOADING = 3;

export class AotRuntime {
  readonly building: boolean;
  /** the platform classes; the on-demand compiler numbers everything after them */
  nSeeded = 0;
  private index!: AotIndex;
  get deopt(): number { return this.index?.deopt ?? (this.w.opts.deopt ? DEOPT_ABI : 0); }
  private store?: AotStore;
  private dOf = new Int32Array(0);
  private cOf = new Int32Array(0);
  private dExports: (WebAssembly.Exports | undefined)[] = [];
  private fallbackD = new Set<number>();
  private cState: number[] = [];
  private cAbsent: (Set<number> | undefined)[] = [];
  private overridden = new Set<number>();
  /** the overridden slots by the code module that holds them, made from `overridden` when it has grown */
  private overriddenBy = new Map<number, number[]>();
  private overriddenSeen = 0;
  private cHeader: (CHeader | undefined)[] = [];
  private cModule: (WebAssembly.Module | undefined)[] = [];
  /** where each function's trace starts in the section of a loaded code module, by slot */
  private cTraces = new Map<number, { bytes: Uint8Array; starts: Map<number, number> }>();
  /** slots reserved by the build after the platform classes, by class */
  private reservedBases = new Map<string, number>();
  /** the classes with bytecode after the platform's, which an app build (`extend`) takes the first of */
  private rest: string[] = [];
  /** code modules from this one on belong to the app build; the classes it defines */
  private appFrom = Infinity;
  /** the app build's data modules, and the one that holds each class block */
  private appD: (WebAssembly.Exports | undefined)[] = [];
  /** the code modules (absolute) that patch each platform code module */
  private patchesOver = new Map<number, number[]>();
  /** the app build's module of each synthetic function it holds, and whether each module is loaded (LIVE), being loaded or unusable (DEAD) */
  private synthIn = new Map<string, number>();
  private synthState: number[] = [];
  private appDOf = new Map<number, number>();
  private appClasses = new Set<string>();
  /** per supertype, its concrete classes added since the build (World.late), split by whether `within` holds them; extended as that list grows */
  private parts = new Map<Set<string>, Map<string, { of: string[]; seen: number; within: string[]; beyond: string[] }>>();
  private split(within: Set<string>, decl: string): { within: string[]; beyond: string[] } | undefined {
    const all = this.w.late.get(decl);
    if (!all?.length) return undefined;
    const parts = this.parts.get(within) ?? this.parts.set(within, new Map()).get(within)!;
    let e = parts.get(decl);
    if (e?.of !== all) parts.set(decl, e = { of: all, seen: 0, within: [], beyond: [] });
    for (; e.seen < all.length; e.seen++) (within.has(all[e.seen]) ? e.within : e.beyond).push(all[e.seen]);
    return e;
  }
  /** the classes `rest` names, and whether each platform decision stands over those of them that are concrete subtypes of its class: known from a launch before (the app build carries
   *  the verdicts) or found now. Not kept once the Program's view of the app's classes has changed (`unbindApp`). */
  private restSet?: Set<string>;
  private verdicts = new Map<string, [tc: string, tk: string, stands: boolean]>();
  private verdictsHold = true;
  /** the verdicts this launch knows, which the next app build carries */
  verdictList(): Verdict[] { return [...this.verdicts].map(([key, [tc, tk, stands]]) => [key, tc, tk, stands]); }
  // ---- build
  private dexSigs = new Set<string>();
  dGroupOf: number[] = [];
  /** the name of the D module the build gives the classes it reserves slots for after the platform's */
  get extraMod(): string { return "g" + this.dKeys.length; }
  cGroupOf: number[] = [];
  dKeys: string[] = [];
  cKeys: string[] = [];

  constructor(private w: World, build?: AotBuild) {
    this.building = !!build;
    if (!build) return;
    this.nSeeded = w.seedPlatform((d) => build.dexes.has(d) && !!this.dexSigs.add(dexSig(d)));
    const dIds = new Map<string, number>(), cIds = new Map<string, number>(), id = (m: Map<string, number>, keys: string[], k: string | null) => {
      if (k === null) return -1;
      let i = m.get(k); if (i === undefined) { m.set(k, i = keys.length); keys.push(k); }
      return i;
    };
    for (let i = 1; i <= this.nSeeded; i++) {
      const name = w.names[i];
      this.dGroupOf.push(id(dIds, this.dKeys, build.dGroup(name)));
      this.cGroupOf.push(id(cIds, this.cKeys, build.cGroup(name)));
    }
  }

  /** attaches the build in `store` to `w`, whose Program holds the platform dexes it was made from (and possibly more after them); undefined if it was made from other ones */
  static attach(w: World, store: AotStore): AotRuntime | undefined {
    const raw = store.get("index.json") as Uint8Array | undefined;
    if (!raw) return undefined;
    const index = JSON.parse(new TextDecoder().decode(raw)) as AotIndex;
    if (index.version !== VERSION || ![0, DEOPT_ABI].includes(index.deopt ?? 0) || w.opts.cold && index.deopt !== DEOPT_ABI) return undefined;
    // the first `index.classes` classes with bytecode must come from exactly the dexes of the build
    const seen: string[] = [], rest: string[] = [];
    let n = 0;
    for (const c of w.prog.all()) {
      if (!c.dex) continue;
      if (n++ >= index.programClasses) { rest.push(c.name); continue; }
      if (seen[seen.length - 1] !== dexSig(c.dex)) seen.push(dexSig(c.dex));
    }
    if (n < index.programClasses || seen.length !== index.dexes.length || seen.some((d, i) => d !== index.dexes[i])) {  return undefined; }
    const a = new AotRuntime(w);
    a.index = index; a.store = store; a.nSeeded = index.classes;
    const mine = new Set(index.aotDexes);
    if (w.seedPlatform((d) => mine.has(dexSig(d))) !== index.classes) return undefined;
    for (const name of index.extraNames) w.idOf(name);
    for (const t of index.tail) {
      if (typeof t === "string") w.reserveSynth(t);
      else {
        if ((w.prog.get(t[0])?.methods.length ?? 0) + 1 !== t[1]) return undefined;
        a.reservedBases.set(t[0], w.addBlock(t[0], t[1]));
      }
    }
    index.selectors.forEach((k) => w.selectorId(k));
    index.gaps.forEach((g, i) => w.gaps.set(g, i));
    for (const l of index.linkMessages) w.linkMessages.push(l);
    a.dOf = unrle(index.dOf); a.cOf = unrle(index.cOf);
    a.dExports.length = a.dOf.reduce((m, v) => Math.max(m, v + 1), 0);
    a.cState.length = a.cHeader.length = a.cOf.reduce((m, v) => Math.max(m, v + 1), 0);
    a.rest = rest;
    if (rest.length) w.noteLate(rest);
    // a method this World replaces by an intrinsic that the build did not, or the reverse, is not the build's
    const built = new Set(index.intrinsics), now = new Set(w.opts.intrinsics.keys());
    for (const id of [...now].filter((k) => !built.has(k)).concat(index.intrinsics.filter((k) => !now.has(k)))) {
      const dot = id.indexOf("."), cls = w.ids.get(id.slice(0, dot)), m = w.prog.get(id.slice(0, dot))?.byKey.get(id.slice(dot + 1));
      if (m && cls !== undefined && cls <= a.nSeeded) a.overridden.add(w.blockBase[cls - 1] + m.index);
    }
    return a;
  }

  /** the dexes of the classes with bytecode after the platform's (`count` of them, all by default), in order: what an app build is made from and must find again */
  appDexes(count = this.rest.length): string[] {
    const sigs: string[] = [];
    for (const name of this.rest.slice(0, count)) { const sig = dexSig(this.w.prog.get(name)!.dex!); if (sigs[sigs.length - 1] !== sig) sigs.push(sig); }
    return sigs;
  }
  get appClassCount(): number { return this.rest.length; }
  /** adds the app build in `store` to the platform build: its numbering continues the World's, which must not have numbered anything since the platform build was attached, and its
   *  Program must start with the dexes it was made from; false (and nothing changed) otherwise */
  extend(app: AppIndex, store: AotStore): boolean {
    const w = this.w, sigs = this.appDexes(app.classes);
    if ((app.deopt ?? 0) !== this.deopt || w.opts.cold && app.deopt !== DEOPT_ABI || app.version !== APP_VERSION || this.rest.length < app.classes || !sameMarks(w.numbering(), app.base) || sigs.length !== app.dexes.length || sigs.some((d, i) => d !== app.dexes[i]) || !w.adopt(app.numbering)) return false;
    this.appClasses = new Set(this.rest.slice(0, app.classes));
    // Verdicts cover the build's whole app, not an arbitrary prefix of this World's app.
    if (app.classes === this.rest.length) for (const [key, tc, tk, stands] of app.demand.verdicts ?? []) this.verdicts.set(key, [tc, tk, stands]);
    const platform = this.store!, cOf = new Int32Array(w.blockBase.length).fill(-1);
    cOf.set(this.cOf);
    this.appFrom = this.cState.length;
    for (const [block, module] of app.cOf) cOf[block] = this.appFrom + module;
    this.cOf = cOf;
    this.cState.length = this.cHeader.length = this.appFrom + app.modules;
    for (const [module, over] of app.patches) (this.patchesOver.get(over) ?? this.patchesOver.set(over, []).get(over)!).push(this.appFrom + module);
    app.synths.forEach((names, module) => names.forEach((n) => this.synthIn.set(n, module)));
    for (const [block, module] of app.dOf) this.appDOf.set(block, module);
    this.appD.length = app.dModules;
    // the app build's files are a<module>.wasm, e<module>.wasm and s<module>.wasm, which no platform file is named like
    this.store = { get: (file) => ("aes".includes(file[0]) ? store : platform).get(file) };
    return true;
  }

  // ---- numbering
  /** the platform build's code module of the class block `b`, -1 if it has none (a class of the app, or one the build does not number) */
  platformModule(b: number): number { return b >= 0 && b < this.nSeeded ? this.cOf[b] : -1; }
  /** the slots of a class compiled on demand although the build numbered it: those the build gave it */
  reservedBase(name: string): number | undefined {
    const id = this.w.ids.get(name);
    return this.reservedBases.get(name) ?? (id !== undefined && id <= this.nSeeded ? this.w.blockBase[id - 1] : undefined);
  }

  // ---- loading
  /** the class module of platform class `name`, if the build has one: its D module is loaded, with those of the classes its vtable needs */
  linkClass(name: string): ClassRt | undefined {
    const w = this.w, id = w.ids.get(name);
    if (id === undefined || this.building && id > this.nSeeded) return undefined;
    let base: number, g = 0, app: number | undefined;
    const reserved = this.reservedBases.get(name);
    if (id <= this.nSeeded) { base = w.blockBase[id - 1]; g = (this.building ? this.dGroupOf : this.dOf)[id - 1]; }
    else if (reserved !== undefined) { base = reserved; g = this.building ? this.dKeys.length : this.index.extraGroup; }
    else {
      // a class the app build gave a data module to
      const slots = w.preassigned.get(name);
      app = slots === undefined ? undefined : this.appDOf.get(w.blockOf(slots));
      if (slots === undefined || app === undefined) return undefined;
      base = slots;
    }
    const exports = this.building || w.opts.compileOnly ? {} : app === undefined ? this.loadD(g) : this.data(`e${app}.wasm`, this.appD, app);
    // Returning without data hands publication to World.link. Block the group before class building can re-enter it.
    if (!exports && app === undefined) this.fallbackD.add(g);
    const jc = w.prog.get(name);
    return exports && { name, id, mod: (app === undefined ? "g" + g : "e" + app), slotBase: base, nMethods: jc ? methodCount(jc) : 0, exports };
  }
  private loadD(g: number): WebAssembly.Exports | undefined { return this.data(`d${g}.wasm`, this.dExports, g); }
  private data(file: string, memo: (WebAssembly.Exports | undefined)[], g: number): WebAssembly.Exports | undefined {
    let ex = memo[g];
    if (ex) return ex;
    const w = this.w, mod = this.module(file);
    if (!mod) return undefined;
    const head = header<DHeader>(mod);
    ex = memo[g] = w.instantiate(mod, { rt: w.rtImports(), host: w.host }).exports;
    w.stats.aot.d++;
    // the classes the vtables and `ensure` functions of the group name must have stubs before anything runs
    for (const id of head.touch) this.touch(id);
    for (const s of head.synth) w.ensureSynth(s);
    return ex;
  }
  /** makes sure the module that holds class `id` is loaded: the class's own record is made when something asks for the class, not for every class a module names */
  private touch(id: number): void {
    const w = this.w;
    if (id <= this.nSeeded && !this.building && !w.opts.compileOnly && this.loadD(this.dOf[id - 1])) return;
    w.link(w.names[id]);
  }
  /** puts the app build's code of synthetic function `name` in its slot, with the others of its module; false if the build has none */
  installSynth(name: string): boolean {
    const k = this.synthIn.get(name);
    if (k === undefined || this.synthState[k]) return false;
    const w = this.w, mod = this.module(`s${k}.wasm`);
    this.synthState[k] = LOADING;
    if (!mod) { this.synthState[k] = DEAD; return false; }
    const head = header<SHeader>(mod);
    if ((head.deopt ?? 0) !== this.deopt) { this.synthState[k] = DEAD; return false; }
    if (!head.natives.every((id) => w.nativeBound(id))) { this.synthState[k] = DEAD; return false; }
    for (const id of head.touch) this.touch(id);
    // the functions of this module are not made twice: they are in it
    for (const s of head.synth) if (this.synthIn.get(s) !== k) w.ensureSynth(s);
    const imports: Record<string, any> = { rt: w.rtImports(), host: w.host, n: w.nativeImports(head.natives), symbolic: w.symbolicImports(head.symbols ?? []), deopt: w.deoptImports };
    w.classImports(mod, imports);
    w.instantiate(mod, imports);
    for (const n of head.names) { const slot = w.synthSlotOf(n); if (slot !== undefined && !w.isStubbed(slot)) w.holdsSynth(n, slot); }
    for (const cls of head.allocs) w.allocated.add(cls);
    for (const id of head.gaps) w.gapList[id] ??= this.index.gaps[id];
    this.synthState[k] = LIVE;
    return true;
  }
  /** whether the platform build numbers class `name`: the classes of its jars; those of the other jars of the class path are numbered, like the app's, as they are used */
  seeded(name: string): boolean {
    const id = this.w.ids.get(name);
    return id !== undefined && id <= this.nSeeded;
  }
  /** whether the module that holds platform class `name` is loaded */
  hasLoaded(name: string): boolean {
    const id = this.w.ids.get(name);
    return id !== undefined && id <= this.nSeeded && !!this.dExports[this.dOf[id - 1]];
  }
  /** the module files loaded so far, in order: what a page fetches ahead for a start like this one (scripts/wasm/aot-startup.ts) */
  loaded: string[] = [];
  /** Files absent on first use. A preflight data miss can retry until World.link begins publishing fallback globals for its group. */
  missed = new Set<string>();
  private ready(file: string): boolean {
    const missed = this.missed.has(file);
    if (missed && !/^c\d+\.wasm$/.test(file)) {
      const data = /^d(\d+)\.wasm$/.exec(file);
      if (!data || this.fallbackD.has(+data[1])) return false;
    }
    if (this.store!.get(file)) return true;
    if (!missed) { this.missed.add(file); this.w.stats.aot.missed++; }
    return false;
  }
  /** a file of the build as a compiled module, or undefined for a miss */
  private module(file: string): WebAssembly.Module | undefined {
    if (!this.ready(file)) return undefined;
    const w = this.w, t0 = performance.now(), f = this.store!.get(file)!;
    this.loaded.push(file);
    w.stats.aot.readMs += performance.now() - t0;
    // not `instanceof WebAssembly.Module`: a module compiled by the page belongs to the page's realm, not a process frame's
    if (!ArrayBuffer.isView(f)) return f;
    w.stats.aot.bytes += f.byteLength;
    return w.compile(f as Uint8Array);
  }

  /** the host implements `m`: the build's code for it is not to be used */
  override(m: MethodInfo): void {
    const base = this.reservedBase(m.cls) ?? this.w.preassigned.get(m.cls);
    if (base !== undefined) this.overridden.add(base + m.index);
  }
  /** whether platform method `m` of block `b` was installed by a loaded code module */
  installed(b: number, m: MethodInfo): boolean { const c = this.cOf[b]; return c >= 0 && this.cState[c] === LIVE && this.has(c, this.w.blockBase[b] + m.index); }
  private has(c: number, slot: number): boolean { return !this.cAbsent[c]!.has(slot); }
  /** the first call of a method the build compiled: loads its code module. Whether the method is installed afterwards is in its slot. */
  install(slot: number): boolean {
    const b = this.w.blockOf(slot), c = b < 0 ? -1 : this.cOf[b];
    return c >= 0 && this.loadC(c);
  }
  private loadC(c: number): boolean {
    if (this.cState[c]) return this.cState[c] === LIVE;
    const w = this.w, app = c >= this.appFrom, file = app ? `a${c - this.appFrom}.wasm` : `c${c}.wasm`, retry = this.missed.has(file), mod = this.module(file);
    if (!mod) { if (app) this.cState[c] = DEAD; return false; }
    const head = header<CHeader>(mod);
    if ((head.deopt ?? 0) !== this.deopt) { this.cState[c] = DEAD; w.stats.aot.dead++; return false; }
    // a module imports the natives it calls, and the globals of the D modules it was made against: without them (a World with other natives than the build's, or
    // a store that lacks a D module) its methods are compiled on demand
    if (!head.natives.every((id) => w.nativeBound(id))) { this.cState[c] = DEAD; w.stats.aot.dead++; return false; }
    if (head.mods.some(m => this.fallbackD.has(+m.slice(1)))) { this.cState[c] = DEAD; w.stats.aot.dead++; return false; }
    // Request the whole dependency set now: stopping at the first miss delays delivery of the remaining original globals.
    let dataReady = true;
    for (const m of head.mods) if (!this.ready(`d${m.slice(1)}.wasm`)) dataReady = false;
    if (!dataReady) return false;
    if (retry && !head.mods.every(m => !!this.loadD(+m.slice(1)))) return false;
    this.cState[c] = LIVE; this.cHeader[c] = head; this.cModule[c] = mod; this.cAbsent[c] = new Set(head.absent);
    for (const id of head.touch) this.touch(id);
    for (const s of head.synth) w.ensureSynth(s);
    const imports: Record<string, any> = { rt: w.rtImports(), host: w.host, n: w.nativeImports(head.natives), symbolic: w.symbolicImports(head.symbols ?? []), deopt: w.deoptImports };
    for (const m of head.mods) imports[m] = this.dExports[+m.slice(1)];
    if (app) w.classImports(mod, imports);
    w.instantiate(mod, imports);
    w.stats.aot.c++;
    const t2 = performance.now();
    // slots made before the module was loaded say it is not there; the rest are made from the module's state
    for (const b of head.classes) {
      const base = w.blockBase[b], n = w.methodsIn(b);
      for (let i = 0; i < n; i++) { const s = w.peek(base + i); if (s?.k === "method" && this.has(c, base + i)) s.done = true; }
    }
    // the decisions are kept with the World's others; those about a class that has gained subtypes since the build are checked now, the rest cannot have changed
    for (const [decl, name, desc, tc, tk, owner] of head.assumptions) {
      const key = `${decl}.${name}${desc}`;
      let e = w.assumptions.get(key);
      if (!e) w.assumptions.set(key, e = { decl, name, desc, tc, tk, slots: new Set() });
      e.slots.add(owner);
      // the classes of an app build are the ones its code was made with
      const same = e.tc === tc && e.tk === tk, a = { name, desc, tc, tk };
      let stands: boolean;
      if (app) { const by = this.split(this.appClasses, decl)?.beyond; stands = !by?.length || w.holds(a, by); }
      // the answer for the classes added so far is the same for every module that relies on the decision (later classes are checked as they arrive, World.addDexes)
      else if (same && e.stands !== undefined) stands = e.stands;
      else {
        const by = this.split(this.restSet ??= new Set(this.rest), decl);
        stands = !by || this.overRest(key, a, by.within) && (!by.beyond.length || w.holds(a, by.beyond));
        if (same) e.stands = stands;
      }
      if (!stands) { w.invalidate(owner); w.stats.aot.dead++; }
    }
    for (const cls of head.allocs) w.allocated.add(cls);
    // a site that fails because a class was not there is undone if it is now
    for (const [name, owner] of head.missing) {
      if (w.prog.get(name)) { w.invalidate(owner); continue; }
      const slots = w.absent.get(name) ?? w.absent.set(name, new Set()).get(name)!;
      slots.add(owner);
    }
    for (const id of head.gaps) w.gapList[id] ??= this.index.gaps[id];
    if (this.overriddenSeen !== this.overridden.size) {
      this.overriddenBy.clear();
      for (const slot of this.overridden) { const m = this.cOf[w.blockOf(slot)]; if (m >= 0) (this.overriddenBy.get(m) ?? this.overriddenBy.set(m, []).get(m)!).push(slot); }
      this.overriddenSeen = this.overridden.size;
    }
    for (const slot of this.overriddenBy.get(c) ?? []) if (!this.cAbsent[c]!.has(slot)) { w.invalidate(slot); this.cAbsent[c]!.add(slot); }
    w.stats.aot.ms += performance.now() - t2;
    // the app build's patches of this module's methods: after its own code, which they replace where they have some
    for (const p of this.patchesOver.get(c) ?? []) this.loadC(p);
    return true;
  }

  /** whether decision `a` stands over the app's classes `classes`: what a launch before found, or found now (deciding means building the members of every one of them) */
  private overRest(key: string, a: { name: string; desc: string; tc: string; tk: string }, classes: string[]): boolean {
    if (!classes.length) return true;
    const v = this.verdicts.get(key);
    if (this.verdictsHold && v && v[0] === a.tc && v[1] === a.tk) return v[2];
    const stands = this.w.holds(a, classes);
    if (this.verdictsHold) this.verdicts.set(key, [a.tc, a.tk, stands]);
    return stands;
  }

  // ---- invalidation
  /** App units were compiled before the runtime loader's library graph was known. Keep platform modules and stable numbering, but discard the app's old resolution. */
  unbindApp(): void {
    this.verdictsHold = false;
    this.verdicts.clear(); this.parts.clear(); this.restSet = undefined;
    for (let c = this.appFrom; c < this.cState.length; c++) this.cState[c] = DEAD;
    this.appDOf.clear();
    this.patchesOver.clear();
    this.synthIn.clear();
  }
  /** the lazy-link stub for a slot whose precompiled code was undone */
  stub(slot: number): Function | undefined {
    const w = this.w, s = w.peek(slot);
    return s?.k === "method" ? w.restoreStub(slot, s.m) : undefined;
  }
  // ---- stack traces
  /** the trace of function `name` of a loaded code module, whose section is indexed the first time a stack needs one of its functions and read function by function */
  trace(name: string): FnTrace | undefined {
    const w = this.w, m = methodOf(w.prog, name);
    if (!m) return undefined;
    const base = this.reservedBase(m.cls) ?? w.preassigned.get(m.cls), c = base === undefined ? -1 : this.cOf[w.blockOf(base)];
    if (c < 0) return undefined;
    // a patch of the module has the code of the methods it replaced
    for (const module of [...this.patchesOver.get(c) ?? [], c]) {
      const t = this.cState[module] === LIVE ? this.traceIn(module, (base as number) + m.index, m, name) : undefined;
      if (t) return t;
    }
    return undefined;
  }
  private traceIn(c: number, slot: number, m: MethodInfo, name: string): FnTrace | undefined {
    let section = this.cTraces.get(c);
    if (!section) {
      const bytes = customSection(this.cModule[c]!, "aottrace"), at = [0], starts = new Map<number, number>();
      while (at[0] < bytes.length) { const s = unleb(bytes, at), len = unleb(bytes, at); starts.set(s, at[0]); at[0] += len; }
      this.cTraces.set(c, section = { bytes, starts });
    }
    const from = section.starts.get(slot);
    if (from === undefined) return undefined;
    const b = section.bytes, at = [from], n = unleb(b, at), offsets = new Int32Array(n), pcs = new Int32Array(n);
    for (let i = 0, o = 0, p = 0; i < n; i++) {
      offsets[i] = o += unleb(b, at);
      const z = unleb(b, at); pcs[i] = p += (z >>> 1) ^ -(z & 1);
    }
    const t = { name, m, offsets, pcs };
    this.w.traces.set(name, t);
    return t;
  }

  // ---- build output
  /** the index of a finished build */
  finish(): AotIndex {
    const w = this.w;
    const withCode = [...w.prog.all()].filter((c) => c.dex);
    return { version: VERSION, deopt: this.deopt, dexes: [...new Set(withCode.map((c) => dexSig(c.dex!)))], programClasses: withCode.length, aotDexes: [...this.dexSigs], classes: this.nSeeded,
      extraNames: w.names.slice(this.nSeeded + 1), tail: w.tail, selectors: w.selKeys.slice(1), gaps: w.gapList, linkMessages: w.linkMessages, dOf: rle(this.dGroupOf), cOf: rle(this.cGroupOf), extraGroup: this.dKeys.length, intrinsics: [...w.opts.intrinsics.keys()] };
  }
}
