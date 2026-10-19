// Ahead-of-time compilation of the platform classes: the code Compiler.buildUnit and World.classModule would produce on demand is
// produced once, at build time, and stored as static assets; at run time the World loads them instead of compiling.
//
// What makes precompiled code link into a World that also compiles app code on demand is that nothing in it depends on what ran first:
//  - Numbering. Class ids, the table slots of every method, selectors, runtime-function slots and gap ids are numbered by the build; the
//    runtime numbers the platform classes the same way (World.seedPlatform: definition order) and takes the rest from the index.
//  - Class modules ("D") hold the globals of a group of classes (vtable, init word, statics), their lazy-link stubs and `ensure` functions;
//    they import nothing from other modules, so they instantiate in any order. Code modules ("C") hold the methods of a group of classes,
//    install them in the table when instantiated, and import the globals of the D modules they name. A C module that is loaded makes sure
//    that every class it touches has its D module, so no slot it can call is empty.
//  - Soundness. Precompiled code relies on no class-hierarchy decision a later class could falsify (Compiler.devirt), so loading an app's
//    classes never undoes it; only sites that fail on a class missing at the build are undone, once the class is there.
import type { ClassRt, World } from "./world.ts";
import { sameMarks, type Marks, type Numbering, type Tail } from "./numbers.ts";
import type { SymbolicSite } from "../compiler/sites.ts";
import type { InfoRecord } from "./classes.ts";

import type { DexFile } from "../../jvm/dex.ts";
import { methodCount, type Loader, type MethodInfo } from "../compiler/program.ts";
import type { Compiler, FnTrace } from "../compiler/j2w.ts";
import { methodOf } from "../compiler/ids.ts";
import { uleb } from "../compiler/wasmbin.ts";

/** the files of a build, read synchronously: a page fetches them (and may compile them) before the code that needs them runs */
export interface AotStore {
  /** a module file: its bytes, or the module itself where the host has compiled it ahead of use; "index.json" is always bytes. A file the host does not
   *  have is a miss: the code it holds is compiled on demand instead. */
  get(file: string): Uint8Array | WebAssembly.Module | undefined;
  /** Optional asynchronous delivery; failure leaves files absent for the ordinary fallback linker. */
  prefetch?(files: string[]): Promise<void>;
}
/** how a build groups the platform classes: classes with the same key share a D (data) or C (code) module; no C key leaves a class to the on-demand compiler */
export interface AotBuild { dGroup(cls: string): string; cGroup(cls: string): string | null; /** the dexes whose classes are numbered and compiled */ dexes: Set<DexFile>; /** application dexes included by an optional combined image */ appDexes?: Set<DexFile> }

const PREPARATION_MS = 50;
export interface AotIndex {
  version: number;
  /** ids of the dexes of the build's Program, in class path order, and how many classes with bytecode they define: the Program of a World must start the same way */
  dexes: string[];
  programClasses: number;
  /** the dexes whose classes the build numbers (from 1, in definition order) and compiles, and how many classes that is */
  aotDexes: string[];
  classes: number;
  /** the other ids, in order: array classes, classes without bytecode */
  extraNames: string[];
  /** slots reserved after the platform classes, in order: [class, size] or a runtime function's name */
  tail: Tail[];
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
  /** the runtime functions of each y<module>.wasm */
  synths: string[][];
}
/** what a module says about itself, in its custom section "aot" */
export interface DHeader { version?: number; classes: number[]; touch: number[]; synth: string[] }
/** what compiled code relies on and needs before it runs: the same for a precompiled module and for a unit a worker compiled */
export interface UnitHeader {
  version?: number;
  classImports: [module: string, name: string][];
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
}
export interface CHeader extends UnitHeader {
  classes: number[];
  /** the D modules of the platform build it imports class globals from, "g<D module>"; a module of an app build imports them from the classes' own modules, by class id */
  mods: string[];
  /** the slots of methods of its classes the module lacks: abstract ones, natives without an implementation, and those the compiler produced invalid code for */
  absent: number[];
}
// Emitted class import names replace type reflection, which can reject valid GC references.
export const VERSION = 16;

/** where numbering `a` first departs from `b`: the part, its sizes and the first entries that differ */
function numberingDiff(a: Numbering, b: Numbering): string {
  if (!sameMarks(a.from, b.from)) return `from ${JSON.stringify(a.from)} vs ${JSON.stringify(b.from)}`;
  for (const k of ["names", "tail", "selectors", "gaps", "links"] as const) {
    const x = a[k], y = b[k], i = x.findIndex((v, j) => JSON.stringify(v) !== JSON.stringify(y[j]));
    if (i >= 0 || x.length !== y.length) return x.length + y.length <= 32 ? `${k} ${JSON.stringify(x)} vs ${JSON.stringify(y)}`
      : `${k} ${x.length} vs ${y.length}, at ${i < 0 ? Math.min(x.length, y.length) : i}: ${JSON.stringify(x[i])} vs ${JSON.stringify(y[i < 0 ? x.length : i])}`;
  }
  return "same";
}

/** an app compiled ahead on top of the platform build (the build `apps.ts` makes): the numbering of what its code names that the platform does not, and code modules a1.. for the app's classes */
export const APP_VERSION = 19;
/** what launches built on demand because no saved code had it: method ids and class names, in order of first use, and the questions the host was asked that made synthetic functions */
export interface Demand { methods: string[]; classes: string[]; infos: InfoRecord[] }
export interface AppIndex {
  version: number;
  /** what the World had numbered after the platform build when the app's numbering began (the zygote's): a World that has numbered exactly that since, or nothing, can use it */
  prefix: Numbering;
  /** where the app's numbering begins */
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
  /** the root namespace's library graph its code was compiled under (rootLibraries) */
  libraries?: string;
  /** tells a build from the others made under its key (apps.ts mergeApp): what a launch ran of it is recorded under it (host/persist.ts LaunchRecord) */
  id: number;
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
  return { version: VERSION, touch: [...touch].filter((n) => n[0] !== "!").map((n) => w.idOf(n)), synth: [...touch].filter((n) => n[0] === "!").map((n) => n.slice(1)),
    classImports: cx.classImports(), natives: [...cx.nativeImports.keys()], symbols: [...cx.symbolicImports.values()].map(v => v.site), assumptions, allocs: [...cx.allocs],
    missing: cx.absent.map(([name, owner]) => [name, w.slotOf(owner!)] as [string, number]) };
}
/** what identifies a dex of the platform: DexFile.id is its SHA-1, but only where the engine has Uint8Array.toHex for views into a larger buffer */
const dexSig = (d: DexFile): string => [d.fileSize, d.classDefCount, d.stringCount, d.typeCount, d.version].join(":");

const rle = (a: number[]): number[] => { const o: number[] = []; for (const v of a) { if (o.length && o[o.length - 2] === v) o[o.length - 1]++; else o.push(v, 1); } return o; };
const unrle = (a: number[]): Int32Array<ArrayBuffer> => { let n = 0; for (let i = 1; i < a.length; i += 2) n += a[i]; const o = new Int32Array(n); let k = 0; for (let i = 0; i < a.length; i += 2) o.fill(a[i], k, k += a[i + 1]); return o; };
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
  const parts = [wasm, ...section("aot", new TextEncoder().encode(JSON.stringify({ version: VERSION, ...header }))), ...(traces ? section("aottrace", Uint8Array.from(t)) : [])];
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of parts) { out.set(x, at); at += x.length; }
  return out;
}
const customSection = (m: WebAssembly.Module, name: string): Uint8Array => new Uint8Array(WebAssembly.Module.customSections(m, name)[0]);
/** a module's header, parsed once: linking asks a code module's on every lazy link until the module loads */
const headers = new WeakMap<WebAssembly.Module, unknown>();
const header = <H>(m: WebAssembly.Module): H => {
  let h = headers.get(m);
  if (h === undefined) headers.set(m, h = JSON.parse(new TextDecoder().decode(customSection(m, "aot"))));
  return h as H;
};
function unleb(b: Uint8Array, at: number[]): number { let n = 0, s = 1; for (;;) { const x = b[at[0]++]; n += (x & 127) * s; if (x < 128) return n; s *= 128; } }

const LIVE = 1, DEAD = 2, LOADING = 3;

export class AotRuntime {
  private w: World;
  readonly building: boolean;
  /** the platform classes; the on-demand compiler numbers everything after them */
  nSeeded = 0;
  private index!: AotIndex;
  private store?: AotStore;
  private dOf = new Int32Array(0);
  private cOf = new Int32Array(0);
  private dExports: (WebAssembly.Exports | undefined)[] = [];
  private fallbackD = new Set<number>();
  private rejectedData = new Set<string>();
  private cState: number[] = [];
  private cAbsent: (Set<number> | undefined)[] = [];
  private overridden = new Set<number>();
  /** the overridden slots by the code module that holds them, made from `overridden` when it has grown */
  private overriddenBy = new Map<number, number[]>();
  private overriddenSeen = 0;
  private cModule: (WebAssembly.Module | undefined)[] = [];
  private cClasses: number[][] = [];
  /** where each function's trace starts in the section of a loaded code module, by slot */
  private cTraces = new Map<number, { bytes: Uint8Array; starts: Map<number, number> }>();
  /** slots reserved by the build after the platform classes, by class */
  private reservedBases = new Map<string, number>();
  /** how many classes with bytecode the platform build's dexes define */
  private programClasses = 0;
  /** what the World had numbered once the platform build was attached */
  platformMarks!: Marks;
  /** code modules from this one on belong to the app build; the classes it defines */
  private appFrom = Infinity;
  /** the app build's data modules, and the one that holds each class block */
  private appD: (WebAssembly.Exports | undefined)[] = [];
  /** the code modules (absolute) that patch each platform code module */
  private patchesOver = new Map<number, number[]>();
  /** the file of each synthetic function a build holds (the app build's over the platform's), and whether each file is loaded (LIVE), being loaded or unusable (DEAD) */
  private synthIn = new Map<string, string>();
  private synthState = new Map<string, number>();
  private appDOf = new Map<number, number>();
  // ---- build
  private dexSigs = new Set<string>();
  dGroupOf: number[] = [];
  /** the name of the D module the build gives the classes it reserves slots for after the platform's */
  get extraMod(): string { return "g" + this.dKeys.length; }
  cGroupOf: number[] = [];
  dKeys: string[] = [];
  cKeys: string[] = [];

  constructor(w: World, build?: AotBuild) {
    this.w = w;
    this.building = !!build;
    if (!build) return;
    this.nSeeded = w.seedPlatform((d) => build.dexes.has(d) && !!this.dexSigs.add(dexSig(d)));
    const dIds = new Map<string, number>(), cIds = new Map<string, number>(), id = (m: Map<string, number>, keys: string[], k: string | null) => {
      if (k === null) return -1;
      let i = m.get(k); if (i === undefined) { m.set(k, i = keys.length); keys.push(k); }
      return i;
    };
    for (let i = 1; i <= this.nSeeded; i++) {
      const name = w.nameOf(i);
      this.dGroupOf.push(id(dIds, this.dKeys, build.dGroup(name)));
      this.cGroupOf.push(id(cIds, this.cKeys, build.cGroup(name)));
    }
  }

  /** attaches the build in `store` to `w`, whose Program holds the platform dexes it was made from (and possibly more after them); undefined if it was made from other ones */
  static attach(w: World, store: AotStore): AotRuntime | undefined {
    const raw = store.get("index.json") as Uint8Array | undefined;
    if (!raw) return undefined;
    const index = JSON.parse(new TextDecoder().decode(raw)) as AotIndex;
    if (index.version !== VERSION) return undefined;
    // the first `index.classes` classes with bytecode must come from exactly the dexes of the build
    const seen: string[] = [];
    let n = 0;
    for (const c of w.prog.all()) {
      if (!c.dex || n++ >= index.programClasses) continue;
      if (seen[seen.length - 1] !== dexSig(c.dex)) seen.push(dexSig(c.dex));
    }
    if (n < index.programClasses || seen.length !== index.dexes.length || seen.some((d, i) => d !== index.dexes[i])) return undefined;
    const a = new AotRuntime(w);
    a.index = index; a.store = store; a.nSeeded = index.classes; a.programClasses = index.programClasses;
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
    index.gaps.forEach((g) => w.gapId(g));
    for (const l of index.linkMessages) w.linkId(l);
    a.dOf = unrle(index.dOf); a.cOf = unrle(index.cOf);
    index.synths.forEach((names, module) => names.forEach((n) => a.synthIn.set(n, `y${module}.wasm`)));
    a.dExports.length = a.dOf.reduce((m, v) => Math.max(m, v + 1), 0);
    a.cState.length = a.cOf.reduce((m, v) => Math.max(m, v + 1), 0);
    // a method this World replaces by an intrinsic that the build did not, or the reverse, is not the build's
    const built = new Set(index.intrinsics), now = new Set(w.opts.intrinsics.keys());
    for (const id of [...now].filter((k) => !built.has(k)).concat(index.intrinsics.filter((k) => !now.has(k)))) {
      const dot = id.indexOf("."), cls = w.numbers.ids.get(id.slice(0, dot)), m = w.prog.get(id.slice(0, dot))?.byKey.get(id.slice(dot + 1));
      if (m && cls !== undefined && cls <= a.nSeeded) a.overridden.add(w.blockBase[cls - 1] + m.index);
    }
    a.platformMarks = w.numbers.marks();
    return a;
  }

  /** the classes of the app's dexes (the default namespace's after the platform's), which an app build (`extend`) takes the first of */
  private get rest(): string[] {
    const prog = this.w.prog, out: string[] = [];
    let n = 0;
    for (const c of prog.all()) if (c.dex && n++ >= this.programClasses && prog.loaderOfDex(c.dex) === prog.root) out.push(c.name);
    return out;
  }
  /** the dexes of the classes with bytecode after the platform's (`count` of them, all by default), in order: what an app build is made from and must find again */
  appDexes(count?: number): string[] {
    const sigs: string[] = [];
    for (const name of this.rest.slice(0, count)) { const sig = dexSig(this.w.prog.get(name)!.dex!); if (sigs[sigs.length - 1] !== sig) sigs.push(sig); }
    return sigs;
  }
  get appClassCount(): number { return this.rest.length; }
  /** the root namespace's libraries by loader number and dexes, and theirs */
  rootLibraries(): string {
    const prog = this.w.prog, dexes = new Map<Loader, string[]>(), seen = new Set<Loader>();
    for (const [dex, owner] of prog.loadedDexes()) (dexes.get(owner) ?? dexes.set(owner, []).get(owner)!).push(dexSig(dex));
    const graph = (l: Loader): string => {
      if (seen.has(l)) return `${l.id}`;
      seen.add(l);
      return `${l.id}[${(dexes.get(l) ?? []).join(",")}](${(l.before ?? []).map(graph).join(" ")}|${(l.after ?? []).map(graph).join(" ")})`;
    };
    return `${(prog.root.before ?? []).map(graph).join(" ")}|${(prog.root.after ?? []).map(graph).join(" ")}`;
  }
  private appLibraries?: string;
  /** why `extend` refused the app build it was given, which a harness reports */
  appRejected?: string;
  /** whether the root's libraries are now those the attached app build was compiled under */
  boundAsBuilt(): boolean { return this.appLibraries !== undefined && this.appLibraries === this.rootLibraries(); }
  /** adds the app build in `store` to the platform build: its numbering continues the World's, which must have numbered exactly the build's prefix since the platform build was
   *  attached, or nothing (a compile worker's World, which takes the prefix), and its Program must have the dexes it was made from after the platform's; false (and nothing changed)
   *  otherwise */
  extend(app: AppIndex, store: AotStore): boolean {
    const w = this.w, sigs = this.appDexes(app.classes), since = w.numbers.since(this.platformMarks);
    const fresh = sameMarks(since.from, w.numbers.marks());
    const rejected = app.version !== APP_VERSION ? "version" : this.rest.length < app.classes ? "classes" : sigs.length !== app.dexes.length || sigs.some((d, i) => d !== app.dexes[i]) ? "dexes"
      : !(fresh || JSON.stringify(since) === JSON.stringify(app.prefix)) ? `prefix: ${numberingDiff(since, app.prefix)}` : undefined;
    if (rejected) { this.appRejected = rejected; return false; }
    if (fresh && !w.adopt(app.prefix)) { this.appRejected = "prefix not adopted"; return false; }
    if (!sameMarks(w.numbers.marks(), app.base) || !w.adopt(app.numbering)) { this.appRejected = "numbering"; return false; }
    this.appLibraries = app.libraries;
    const platform = this.store!, cOf = new Int32Array(w.blockBase.length).fill(-1);
    cOf.set(this.cOf);
    this.appFrom = this.cState.length;
    for (const [block, module] of app.cOf) cOf[block] = this.appFrom + module;
    this.cOf = cOf;
    this.cState.length = this.appFrom + app.modules;
    for (const [module, over] of app.patches) (this.patchesOver.get(over) ?? this.patchesOver.set(over, []).get(over)!).push(this.appFrom + module);
    app.synths.forEach((names, module) => names.forEach((n) => this.synthIn.set(n, `s${module}.wasm`)));
    for (const [block, module] of app.dOf) this.appDOf.set(block, module);
    this.appD.length = app.dModules;
    // the app build's files are a<module>.wasm, e<module>.wasm and s<module>.wasm, which no platform file is named like
    this.store = { get: (file) => ("aes".includes(file[0]) ? store : platform).get(file),
      ...(platform.prefetch && { prefetch: (files: string[]) => platform.prefetch!(files) }) };
    return true;
  }

  // ---- numbering
  /** the platform build's code module of the class block `b`, -1 if it has none (a class of the app, or one the build does not number) */
  platformModule(b: number): number { return b >= 0 && b < this.nSeeded ? this.cOf[b] : -1; }
  /** the slots of a class compiled on demand although the build numbered it: those the build gave it */
  reservedBase(name: string): number | undefined {
    const id = this.w.numbers.ids.get(name);
    return this.reservedBases.get(name) ?? (id !== undefined && id <= this.nSeeded ? this.w.blockBase[id - 1] : undefined);
  }

  // ---- loading
  /** the class module of platform class `name`, if the build has one: its D module is loaded, with those of the classes its vtable needs */
  linkClass(name: string): ClassRt | undefined {
    const w = this.w, id = w.numbers.ids.get(name);
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
    if (head.version !== VERSION) { this.rejectedData.add(file); return undefined; }
    ex = memo[g] = w.instantiate(mod, { rt: w.rtImports(), host: w.host, stub: w.stubImports(mod) }).exports;
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
    w.link(w.nameOf(id));
  }
  /** puts a build's code of synthetic function `name` in its slot, with the others of its module; false if the builds have none */
  installSynth(name: string): boolean {
    const file = this.synthIn.get(name);
    if (file === undefined || this.synthState.has(file)) return false;
    const w = this.w, mod = this.module(file), dead = () => { this.synthState.set(file, DEAD); return false; };
    this.synthState.set(file, LOADING);
    if (!mod) return dead();
    const head = header<SHeader>(mod);
    if (head.version !== VERSION || !head.natives.every((id) => w.nativeBound(id))) return dead();
    for (const id of head.touch) this.touch(id);
    // the functions of this module are not made twice: they are in it
    for (const s of head.synth) if (this.synthIn.get(s) !== file) w.ensureSynth(s);
    const imports: Record<string, any> = { rt: w.rtImports(), host: w.host, n: w.nativeImports(head.natives), symbolic: w.symbolicImports(head.symbols ?? []) };
    w.classImports(head.classImports, imports);
    // a class whose module is being built, naming this function, has no globals yet: a stub stands in for the function, and the module serves the next one asked for
    if (head.classImports.some(([m, n]) => imports[m][n] === undefined)) { this.synthState.delete(file); return false; }
    w.instantiate(mod, imports);
    for (const n of head.names) { const slot = w.synthSlotOf(n); if (slot !== undefined && !w.isStubbed(slot)) w.holdsSynth(n, slot); }
    for (const cls of head.allocs) w.allocated.add(cls);
    this.synthState.set(file, LIVE);
    return true;
  }
  /** whether the platform build numbers class `name`: the classes of its jars; those of the other jars of the class path are numbered, like the app's, as they are used */
  seeded(name: string): boolean {
    const id = this.w.numbers.ids.get(name);
    return id !== undefined && id <= this.nSeeded;
  }
  /** whether the module that holds platform class `name` is loaded */
  hasLoaded(name: string): boolean {
    const id = this.w.numbers.ids.get(name);
    return id !== undefined && id <= this.nSeeded && !!this.dExports[this.dOf[id - 1]];
  }
  /** the module files loaded so far, in order: what a page fetches ahead for a start like this one (scripts/wasm/aot-startup.ts) */
  loaded: string[] = [];
  /** Files absent on first use. A preflight data miss can retry until World.link begins publishing fallback globals for its group. */
  missed = new Set<string>();
  private ready(file: string): boolean {
    const missed = this.missed.has(file), data = /^d(\d+)\.wasm$/.exec(file);
    if (this.rejectedData.has(file) || data && this.fallbackD.has(+data[1])) return false;
    if (missed && !/^c\d+\.wasm$/.test(file) && !data) return false;
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
    if (!ArrayBuffer.isView(f)) return f;
    w.stats.aot.bytes += f.byteLength;
    return w.compile(f as Uint8Array);
  }

  /** the host implements `m`: the build's code for it is not to be used */
  override(m: MethodInfo): void {
    const base = this.reservedBase(m.cls) ?? this.w.preassigned.get(m.cls);
    if (base !== undefined) this.overridden.add(base + m.index);
  }
  /** whether a loaded code module or app patch installed the method of `slot` */
  installed(slot: number): boolean {
    const b = this.w.blockOf(slot), c = b < 0 ? -1 : this.cOf[b];
    if (c >= 0 && this.cState[c] === LIVE && this.has(c, slot)) return true;
    for (const p of this.patchesOver.get(c) ?? []) if (this.cState[p] === LIVE && this.cClasses[p].includes(b) && this.has(p, slot)) return true;
    return false;
  }
  private has(c: number, slot: number): boolean { return !this.cAbsent[c]!.has(slot); }
  /** whether a code module of the build holds `slot`'s class, which its first call loads */
  holds(slot: number): boolean {
    const b = this.w.blockOf(slot), c = b < 0 ? -1 : this.cOf[b];
    return c >= 0 && this.cState[c] !== DEAD;
  }
  /** the loaded code module that holds `slot`'s code, or -1 */
  loadedFrom(slot: number): number {
    const b = this.w.blockOf(slot), c = b < 0 ? -1 : this.cOf[b];
    return c >= 0 && this.cState[c] === LIVE && this.has(c, slot) ? c : -1;
  }
  /** whether the attached app build has `slot`'s code loaded */
  fromAppBuild(slot: number): boolean { return this.loadedFrom(slot) >= this.appFrom; }
  private preparation = new Map<number, Promise<void>>();
  private prepared = new Set<number>();
  private preparationModule(slot: number): number {
    const b = this.w.blockOf(slot), c = b < 0 ? -1 : this.cOf[b] ?? -1;
    return !this.store?.prefetch || this.building || this.w.opts.compileOnly || c < 0 || c >= this.appFrom || this.cState[c] ? -1 : c;
  }
  private preparationFiles(c: number): string[] {
    const file = `c${c}.wasm`, mod = this.store!.get(file);
    if (!mod) return [file];
    // Byte stores are already local. Only asynchronously compiled modules need a delivery wait.
    if (ArrayBuffer.isView(mod)) return [];
    const head = header<CHeader>(mod);
    if (head.version !== VERSION || !head.natives.every(id => this.w.nativeBound(id))) return [];
    const files: string[] = [];
    for (const m of head.mods) if (!this.fallbackD.has(+m.slice(1))) {
      const file = `d${m.slice(1)}.wasm`;
      if (!this.store!.get(file)) files.push(file);
    }
    return files;
  }
  needsPreparation(slot: number): boolean {
    const c = this.preparationModule(slot);
    return c >= 0 && (this.preparation.has(c) || !this.prepared.has(c) && this.preparationFiles(c).length > 0);
  }
  /** One bounded delivery attempt per demanded code group, before the ordinary linker publishes any globals. */
  prepare(slot: number): Promise<void> | undefined {
    const c = this.preparationModule(slot);
    if (c < 0) return;
    const pending = this.preparation.get(c);
    if (pending) return pending;
    if (this.prepared.has(c)) return;
    const files = this.preparationFiles(c);
    if (!files.length) return;
    const store = this.store!;
    this.prepared.add(c);
    const deadline = performance.now() + PREPARATION_MS;
    let timer: ReturnType<typeof setTimeout>;
    const bound = new Promise<void>(done => { timer = setTimeout(done, PREPARATION_MS); });
    const delivery = (async () => {
      await store.prefetch!(files);
      if (performance.now() >= deadline || this.store !== store || this.preparationModule(slot) !== c) return;
      const data = this.preparationFiles(c).filter(f => f.startsWith("d"));
      if (data.length) await store.prefetch!(data);
    })();
    const result = Promise.race([delivery.catch(() => {}), bound]).finally(() => {
      clearTimeout(timer); this.preparation.delete(c);
    });
    this.preparation.set(c, result);
    const note = this.w.opts.note;
    if (note) { note(18, c); void result.then(() => note(19, this.preparationFiles(c).length ? -c : c)); }
    return result;
  }
  /** the first call of a method the build compiled: loads its code module. Whether the method is installed afterwards is in its slot. */
  install(slot: number): boolean {
    const b = this.w.blockOf(slot), c = b < 0 ? -1 : this.cOf[b];
    if (!(c >= 0)) return false;
    let loaded = this.loadC(c);
    // App patches can remain valid when their platform unit is rejected.
    if (!loaded && this.cState[c] === DEAD) for (const p of this.patchesOver.get(c) ?? []) loaded = this.loadC(p) || loaded;
    return loaded;
  }
  private loadC(c: number): boolean {
    if (this.cState[c]) return this.cState[c] === LIVE;
    const w = this.w, app = c >= this.appFrom, file = app ? `a${c - this.appFrom}.wasm` : `c${c}.wasm`, mod = this.module(file);
    if (!mod) { if (app) this.cState[c] = DEAD; return false; }
    const head = header<CHeader>(mod);
    if (head.version !== VERSION || !head.natives.every((id) => w.nativeBound(id))) { this.cState[c] = DEAD; w.stats.aot.dead++; return false; }
    // Request the whole dependency set now: stopping at the first miss delays delivery of the remaining original globals.
    let dataReady = true;
    for (const m of head.mods) if (!this.fallbackD.has(+m.slice(1)) && !this.ready(`d${m.slice(1)}.wasm`)) dataReady = false;
    if (!dataReady) return false;
    if (!head.mods.every(m => this.fallbackD.has(+m.slice(1)) || !!this.loadD(+m.slice(1)))) { this.cState[c] = DEAD; w.stats.aot.dead++; return false; }
    const absent = new Set(head.absent);
    if (this.overriddenSeen !== this.overridden.size) {
      this.overriddenBy.clear();
      for (const slot of this.overridden) { const m = this.cOf[w.blockOf(slot)]; if (m >= 0) (this.overriddenBy.get(m) ?? this.overriddenBy.set(m, []).get(m)!).push(slot); }
      this.overriddenSeen = this.overridden.size;
    }
    this.cState[c] = LIVE; this.cModule[c] = mod; this.cAbsent[c] = absent;
    if (app) this.cClasses[c] = head.classes;
    for (const id of head.touch) this.touch(id);
    for (const s of head.synth) w.ensureSynth(s);
    const imports: Record<string, any> = { rt: w.rtImports(), host: w.host, n: w.nativeImports(head.natives), symbolic: w.symbolicImports(head.symbols ?? []) };
    // Retired data groups bind each class's published globals instead of creating another owner.
    let bindClasses = app;
    for (const m of head.mods) { const ex = this.dExports[+m.slice(1)]; if (ex) imports[m] = ex; else bindClasses = true; }
    if (bindClasses) w.classImports(head.classImports, imports);
    w.instantiate(mod, imports);
    w.stats.aot.c++;
    const t2 = performance.now();
    // slots made before the module was loaded say it is not there; the rest are made from the module's state
    for (const b of head.classes) {
      const base = w.blockBase[b], n = w.methodsIn(b);
      for (let i = 0; i < n; i++) { const s = w.peek(base + i); if (s?.k === "method" && this.has(c, base + i)) s.done = true; }
    }
    for (const cls of head.allocs) w.allocated.add(cls);
    // a site that fails because a class was not there is undone if it is now
    for (const [name, owner] of head.missing) {
      if (w.prog.get(name)) { w.invalidate(owner); continue; }
      const slots = w.absent.get(name) ?? w.absent.set(name, new Set()).get(name)!;
      slots.add(owner);
    }
    for (const slot of this.overriddenBy.get(c) ?? []) if (!this.cAbsent[c]!.has(slot)) { w.invalidate(slot); this.cAbsent[c]!.add(slot); }
    w.stats.aot.ms += performance.now() - t2;
    // the app build's patches of this module's methods: after its own code, which they replace where they have some
    for (const p of this.patchesOver.get(c) ?? []) this.loadC(p);
    return true;
  }

  // ---- invalidation
  /** App units were compiled before the runtime loader's library graph was known. Keep platform modules and stable numbering, but discard the app's old resolution. */
  unbindApp(): void {
    for (let c = this.appFrom; c < this.cState.length; c++) this.cState[c] = DEAD;
    this.appDOf.clear();
    this.patchesOver.clear();
    this.synthIn.clear();
  }
  // ---- stack traces
  /** the trace of function `name` of a loaded code module, whose section is indexed the first time a stack needs one of its functions and read function by function */
  trace(name: string): FnTrace | undefined {
    const w = this.w, m = methodOf(w.prog, name);
    if (!m) return undefined;
    const base = this.reservedBase(m.cls) ?? w.preassigned.get(m.cls);
    if (base === undefined) return undefined;
    const c = this.cOf[w.blockOf(base)];
    if (c < 0) return undefined;
    // a patch of the module has the code of the methods it replaced
    for (const module of [...this.patchesOver.get(c) ?? [], c]) {
      const t = this.cState[module] === LIVE ? this.traceIn(module, base + m.index, m, name) : undefined;
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
  /** the index of a finished build whose runtime functions are in `synths` */
  finish(synths: string[][]): AotIndex {
    const w = this.w;
    const withCode = [...w.prog.all()].filter((c) => c.dex);
    return { version: VERSION, dexes: [...new Set(withCode.map((c) => dexSig(c.dex!)))], programClasses: withCode.length, aotDexes: [...this.dexSigs], classes: this.nSeeded,
      extraNames: w.numbers.names.slice(this.nSeeded + 1), tail: w.numbers.tail, selectors: w.numbers.selKeys.slice(1), gaps: w.numbers.gapList, linkMessages: w.numbers.links.messages, dOf: rle(this.dGroupOf), cOf: rle(this.cGroupOf), extraGroup: this.dKeys.length, intrinsics: [...w.opts.intrinsics.keys()], synths };
  }
}
