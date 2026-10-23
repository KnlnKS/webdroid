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
import { sameMarks, type Marks, type Numbering } from "./numbers.ts";
import type { SymbolicSite } from "../compiler/sites.ts";

import type { DexFile } from "../../jvm/dex.ts";
import type { Loader, MethodInfo } from "../compiler/program.ts";
import type { FnTrace } from "../compiler/j2w.ts";
import { methodOf } from "../compiler/program.ts";
import { COUNT_SLOTS } from "../compiler/consts.ts";
import { LebReader } from "./module.ts";

/** the files of a build, read synchronously: a page fetches them (and may compile them) before the code that needs them runs */
export interface AotStore {
  /** a module file: its bytes, or the module itself where the host has compiled it ahead of use; "index.json" is always bytes. A file the host does not
   *  have is a miss: the code it holds is compiled on demand instead. */
  get(file: string): Uint8Array | WebAssembly.Module | undefined;
  /** Optional asynchronous delivery; failure leaves files absent for the ordinary fallback linker. */
  prefetch?(files: string[]): Promise<void>;
}
/** how a build groups the platform classes: classes with the same key share a D (data) or C (code) module; no C key leaves a class to the on-demand compiler */
export interface AotBuild { dGroup(cls: string): string; cGroup(cls: string): string | null; /** the dexes whose classes are numbered and compiled */ dexes: Set<DexFile> }

const PREPARATION_MS = 50;
export interface AotIndex {
  version: number;
  /** ids of the dexes of the build's Program, in class path order, and how many classes with bytecode they define: the Program of a World must start the same way */
  dexes: string[];
  programClasses: number;
  /** the dexes whose classes the build numbers (from 1, in definition order) and compiles, and how many classes that is */
  aotDexes: string[];
  classes: number;
  /** what the build numbered after its classes: the other ids (array classes, classes without bytecode), the slots reserved after the platform classes, selectors,
   *  gaps and the link errors compiled code throws */
  numbering: Numbering;
  /** the methods the build replaced by intrinsics, "class.name+descriptor" */
  intrinsics: string[];
  /** the D module of the classes the build reserved slots for after the platform's (array classes, ...), which are all in one */
  extraGroup: number;
  /** the D and C module of each platform class, run-length coded as (value, count) pairs; -1: none */
  dOf: number[];
  cOf: number[];
  /** the runtime functions of each y<module>.wasm */
  synths: string[][];
  /** the instance methods each host spec's class implements (hostclass.ts hostTakeover): a call that may reach one is not bound statically */
  hostKeys: [string, string[]][];
  /** the slots of the methods the host takes over (hostTakeover), those of specs a split bundle registers late included */
  overridden: number[];
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
  /** the methods whose code holds another method's: its slot, then theirs (Compiler.held) */
  held?: number[][];
}
export interface CHeader extends UnitHeader {
  classes: number[];
  /** the D modules of the platform build it imports class globals from, whole (import module "g<D module>"); a module of an app build imports them from the
   *  classes' own modules, by class id */
  mods: number[];
  /** the slots of methods of its classes the module lacks: abstract ones, natives without an implementation, and those the compiler produced invalid code for */
  absent: number[];
}
export const VERSION = 23;

/** the module files of a build: the platform build's code (c), data (d) and runtime-function (y) modules, and an app build's code (a), data (e) and runtime-function (s) ones */
export type AotKind = "c" | "d" | "y" | "a" | "e" | "s";
/** the loaders the root namespace's libraries reach, theirs too, in the order a walk of its graph first meets them */
export function libraryLoaders(prog: World["prog"]): Set<Loader> {
  const seen = new Set<Loader>(), walk = (l: Loader) => { if (seen.has(l)) return; seen.add(l); l.before?.forEach(walk); l.after?.forEach(walk); };
  prog.root.before?.forEach(walk); prog.root.after?.forEach(walk);
  return seen;
}
/** the file of module `n` of kind `kind` */
export const aotFile = (kind: AotKind, n: number): string => kind + n + ".wasm";
/** the kind and number of the module in file `name`; undefined for another file of the build */
export function parseAotFile(name: string): { kind: AotKind; n: number } | undefined {
  const m = /^([cdyaes])(\d+)\.wasm$/.exec(name);
  return m ? { kind: m[1] as AotKind, n: +m[2] } : undefined;
}

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
export const APP_VERSION = 23;
/** what launches built on demand because no saved code had it: method ids, class names and the names of the synthetic functions the host made when asked, in order of first use */
export interface Demand { methods: string[]; classes: string[]; synths: string[] }
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
/** what identifies a dex of the platform: DexFile.id is its SHA-1, but only where the engine has Uint8Array.toHex for views into a larger buffer */
export const dexSig = (d: DexFile): string => [d.fileSize, d.classDefCount, d.stringCount, d.typeCount, d.version].join(":");

const unrle = (a: number[]): Int32Array<ArrayBuffer> => { let n = 0; for (let i = 1; i < a.length; i += 2) n += a[i]; const o = new Int32Array(n); let k = 0; for (let i = 0; i < a.length; i += 2) o.fill(a[i], k, k += a[i + 1]); return o; };
const customSection = (m: WebAssembly.Module, name: string): Uint8Array => new Uint8Array(WebAssembly.Module.customSections(m, name)[0]);
/** a module's header, parsed once: linking asks a code module's on every lazy link until the module loads */
const headers = new WeakMap<WebAssembly.Module, unknown>();
export const header = <H>(m: WebAssembly.Module): H => {
  let h = headers.get(m);
  if (h === undefined) headers.set(m, h = JSON.parse(new TextDecoder().decode(customSection(m, "aot"))));
  return h as H;
};

const LIVE = 1, DEAD = 2, LOADING = 3;

/** where a build puts the platform classes: the D and C module of each (by id - 1; -1 for none) and the D module of the classes it reserved slots for after them */
export interface AotLayout { dOf: Int32Array; cOf: Int32Array; extraGroup: number }

export class AotRuntime {
  private w: World;
  /** the platform classes; the on-demand compiler numbers everything after them */
  readonly nSeeded: number;
  /** the D module of the classes the build reserved slots for after the platform's, and the class blocks it numbered: those after are the app's */
  readonly extraGroup: number;
  private readonly platformBlocks: number;
  private store?: AotStore;
  private dOf: Int32Array;
  private cOf: Int32Array;
  private dExports: (WebAssembly.Exports | undefined)[] = [];
  private fallbackD = new Set<number>();
  private rejectedData = new Set<string>();
  private cState: number[] = [];
  private cAbsent: (Set<number> | undefined)[] = [];
  /** the slots the host took over by the code module that holds them, made again when the host has taken more (HostClasses.takes) */
  private overriddenBy = new Map<number, number[]>();
  private overriddenSeen = 0;
  private cModule: (WebAssembly.Module | undefined)[] = [];
  private cClasses: number[][] = [];
  /** where each function's trace starts in the section of a loaded code module, by slot */
  private cTraces = new Map<number, { bytes: Uint8Array; starts: Map<number, number> }>();
  /** how many classes with bytecode the platform build's dexes define */
  private readonly programClasses: number;
  /** what the World had numbered once the platform build was attached */
  readonly platformMarks: Marks;
  /** code modules from this one on belong to the app build, once one is attached */
  private appFrom = Infinity;
  /** what of the attached app build can still be loaded, until unbindApp drops it: its data modules and the one that holds each class block, and the code modules
   *  (absolute) that patch each platform code module */
  private app?: { d: (WebAssembly.Exports | undefined)[]; dOf: Map<number, number>; patchesOver: Map<number, number[]> };
  /** the file of each synthetic function a build holds (the app build's over the platform's), and whether each file is loaded (LIVE), being loaded or unusable (DEAD) */
  private synthIn = new Map<string, string>();
  private synthState = new Map<string, number>();

  /** the build laid out as `layout` over `w`, which has numbered its platform classes and what the build numbered after them */
  constructor(w: World, layout: AotLayout, store?: AotStore, programClasses = 0) {
    this.w = w; this.store = store; this.programClasses = programClasses;
    this.nSeeded = w.slots.seeded; this.platformBlocks = w.slots.blockBase.length; this.platformMarks = w.numbers.marks();
    this.dOf = layout.dOf; this.cOf = layout.cOf; this.extraGroup = layout.extraGroup;
    this.dExports.length = this.dOf.reduce((m, v) => Math.max(m, v + 1), 0);
    this.cState.length = this.cOf.reduce((m, v) => Math.max(m, v + 1), 0);
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
    const mine = new Set(index.aotDexes);
    if (w.seedPlatform((d) => mine.has(dexSig(d))) !== index.classes) return undefined;
    // a class the build reserved slots for has as many methods here
    if (index.numbering.tail.some((t) => typeof t !== "string" && (w.prog.get(t[0])?.methods.length ?? 0) + 1 !== t[1]) || !w.adopt(index.numbering)) return undefined;
    const a = new AotRuntime(w, { dOf: unrle(index.dOf), cOf: unrle(index.cOf), extraGroup: index.extraGroup }, store, index.programClasses);
    index.synths.forEach((names, module) => names.forEach((n) => a.synthIn.set(n, aotFile("y", module))));
    w.hosts.adoptTakeover(index.hostKeys, index.overridden);
    // a method this World replaces by an intrinsic that the build did not, or the reverse, is not the build's
    const built = new Set(index.intrinsics), now = new Set(w.opts.intrinsics.keys());
    for (const id of [...now].filter((k) => !built.has(k)).concat(index.intrinsics.filter((k) => !now.has(k)))) {
      const dot = id.indexOf("."), cls = w.numbers.ids.get(id.slice(0, dot)), m = w.prog.get(id.slice(0, dot))?.byKey.get(id.slice(dot + 1));
      if (m && cls !== undefined && cls <= a.nSeeded) w.hosts.take(m);
    }
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
  /** the root namespace's library graph: its libraries and theirs by loader number, with their dexes */
  rootLibraries(): string {
    const prog = this.w.prog, loaders = libraryLoaders(prog), dexes = new Map<Loader, string[]>(), ids = (ls: Loader[] = []) => ls.map((l) => l.id).join(" ");
    for (const [dex, owner] of prog.loadedDexes()) if (loaders.has(owner)) (dexes.get(owner) ?? dexes.set(owner, []).get(owner)!).push(dexSig(dex));
    return [`${ids(prog.root.before)}|${ids(prog.root.after)}`, ...[...loaders].map((l) => `${l.id}[${(dexes.get(l) ?? []).join(",")}](${ids(l.before)}|${ids(l.after)})`)].join(" ");
  }
  /** the root's libraries the attached app build was compiled under, which the classes its data modules laid out keep */
  private appLibraries?: string;
  /** whether the World took an app build's numbering, which it keeps once unbindApp drops the build */
  get appAttached(): boolean { return this.appLibraries !== undefined; }
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
    if (!sameMarks(w.numbers.marks(), app.base) || !w.adopt(app.numbering)) {
      // a fresh World took the prefix just now
      if (fresh) w.rollback(since.from);
      this.appRejected = "numbering"; return false; }
    this.appLibraries = app.libraries;
    const platform = this.store!, cOf = new Int32Array(w.slots.blockBase.length).fill(-1), from = this.appFrom = this.cState.length;
    cOf.set(this.cOf);
    for (const [block, module] of app.cOf) cOf[block] = from + module;
    this.cOf = cOf;
    this.cState.length = from + app.modules;
    const patchesOver = new Map<number, number[]>();
    for (const [module, over] of app.patches) (patchesOver.get(over) ?? patchesOver.set(over, []).get(over)!).push(from + module);
    this.app = { d: new Array(app.dModules), dOf: new Map(app.dOf), patchesOver };
    app.synths.forEach((names, module) => names.forEach((n) => this.synthIn.set(n, aotFile("s", module))));
    // the app build's files are a<module>.wasm, e<module>.wasm and s<module>.wasm, which no platform file is named like
    this.store = { get: (file) => ("aes".includes(file[0]) ? store : platform).get(file),
      ...(platform.prefetch && { prefetch: (files: string[]) => platform.prefetch!(files) }) };
    return true;
  }

  // ---- numbering
  /** the platform build's code module of the class block `b`, -1 if it has none (a class of the app, or one the build does not number) */
  platformModule(b: number): number { return b >= 0 && b < this.nSeeded ? this.cOf[b] : -1; }
  /** whether the platform build lays out the data of class `name`: one of its classes, or one it reserved slots for after them */
  platformData(name: string): boolean { const base = this.w.slots.baseOf(name); return base !== undefined && this.w.slots.blockOf(base) < this.platformBlocks; }

  // ---- loading
  /** the class module of platform class `name`, if the build has one: its D module is loaded, with those of the classes its vtable needs */
  linkClass(name: string): ClassRt | undefined {
    const w = this.w, id = w.numbers.ids.get(name);
    if (id === undefined) return undefined;
    let base: number | undefined, g = this.extraGroup, app: number | undefined;
    if (id <= this.nSeeded) { base = w.slots.blockBase[id - 1]; g = this.dOf[id - 1]; }
    else {
      // a class the platform build reserved slots for after its own, or one the app build gave a data module to
      base = w.slots.preassigned.get(name);
      if (base === undefined) return undefined;
      const b = w.slots.blockOf(base);
      if (b >= this.platformBlocks && (app = this.app?.dOf.get(b)) === undefined) return undefined;
    }
    const exports = !w.instantiates ? {} : app === undefined ? this.loadD(g) : this.data(aotFile("e", app), this.app!.d, app);
    // Returning without data hands publication to World.link. Block the group before class building can re-enter it.
    if (!exports && app === undefined) this.fallbackD.add(g);
    const jc = w.prog.get(name);
    return exports && { name, id, ...app === undefined ? { mod: "g" + g, from: "platform" as const } : { mod: "e" + app, from: "app" as const }, slotBase: base, nMethods: jc ? jc.methodCount : 0, exports };
  }
  private loadD(g: number): WebAssembly.Exports | undefined { return this.data(aotFile("d", g), this.dExports, g); }
  private data(file: string, memo: (WebAssembly.Exports | undefined)[], g: number): WebAssembly.Exports | undefined {
    let ex = memo[g];
    if (ex) return ex;
    const w = this.w, mod = this.module(file);
    if (!mod) return undefined;
    const head = header<DHeader>(mod);
    if (!w.units.admits(head)) { this.rejectedData.add(file); return undefined; }
    ex = memo[g] = w.instantiate(mod, { rt: w.rtImports(), host: w.host, stub: w.stubs.stubImports(mod) }).exports;
    w.stats.aot.d++;
    // the classes the vtables and `ensure` functions of the group name must have stubs before anything runs
    w.units.linkHeader(head);
    return ex;
  }
  /** loads the module that holds platform class `id`, which gives it its stubs; whether it did. The class's own record is made when something asks for the class,
   *  not for every class a module names */
  touch(id: number): boolean { return id <= this.nSeeded && this.w.instantiates && !!this.loadD(this.dOf[id - 1]); }
  /** puts a build's code of synthetic function `name` in its slot, with the others of its module; false if the builds have none */
  installSynth(name: string): boolean {
    const file = this.synthIn.get(name);
    if (file === undefined || this.synthState.has(file)) return false;
    const w = this.w, mod = this.module(file), dead = () => { this.synthState.set(file, DEAD); return false; };
    this.synthState.set(file, LOADING);
    if (!mod) return dead();
    const head = header<SHeader>(mod);
    if (!w.units.admits(head)) return dead();
    // the functions of this module are not made twice: they are in it
    const placed = w.units.link({ head, module: mod, defines: (s) => this.synthIn.get(s) === file }, () => {
      for (const n of head.names) { const slot = w.slots.synthSlotOf(n); if (slot !== undefined && !w.slots.isStubbed(slot)) w.slots.holdsSynth(n, slot); }
      return true;
    });
    // a class whose module is being built, naming this function, has no globals yet: a stub stands in for the function, and the module serves the next one asked for
    if (!placed) { this.synthState.delete(file); return false; }
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
  /** whether `file` is here to load; `note` records one that is not as missed */
  private ready(file: string, note = true): boolean {
    const missed = this.missed.has(file), f = parseAotFile(file);
    if (this.rejectedData.has(file) || f?.kind === "d" && this.fallbackD.has(f.n)) return false;
    if (missed && f?.kind !== "c" && f?.kind !== "d") return false;
    if (this.store!.get(file)) return true;
    if (note && !missed) { this.missed.add(file); this.w.stats.aot.missed++; }
    return false;
  }
  /** whether the data modules code module `head` imports are here or stood in for. Noting misses looks at every one: stopping at the first would delay the
   *  delivery of the rest */
  private dataReady(head: CHeader, note = true): boolean {
    let ready = true;
    for (const g of head.mods) if (!this.fallbackD.has(g) && !this.ready(aotFile("d", g), note)) { ready = false; if (!note) break; }
    return ready;
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

  /** whether a loaded code module or app patch installed the method of `slot` */
  installed(slot: number): boolean {
    const b = this.w.slots.blockOf(slot), c = b < 0 ? -1 : this.cOf[b];
    if (c >= 0 && this.cState[c] === LIVE && this.has(c, slot)) return true;
    for (const p of this.app?.patchesOver.get(c) ?? []) if (this.cState[p] === LIVE && this.cClasses[p].includes(b) && this.has(p, slot)) return true;
    return false;
  }
  private has(c: number, slot: number): boolean { return !this.cAbsent[c]!.has(slot); }
  /** whether a code module of the build holds `slot`'s class, which its first call loads */
  holds(slot: number): boolean {
    const b = this.w.slots.blockOf(slot), c = b < 0 ? -1 : this.cOf[b];
    return c >= 0 && this.cState[c] !== DEAD;
  }
  /** the loaded code module that holds `slot`'s code, or -1 */
  loadedFrom(slot: number): number {
    const b = this.w.slots.blockOf(slot), c = b < 0 ? -1 : this.cOf[b];
    return c >= 0 && this.cState[c] === LIVE && this.has(c, slot) ? c : -1;
  }
  /** whether the attached app build has `slot`'s code loaded */
  fromAppBuild(slot: number): boolean { return this.loadedFrom(slot) >= this.appFrom; }
  /** the slots whose code from a loaded module has run here (a method's count restarts once a unit replaces its code), the platform build's and the app build's
   *  apart: what a later launch has the engine compile ahead (host/warm-worker.ts) */
  ranSlots(): { platform: number[]; app: number[] } {
    const tiers = this.w.tiers, counts = tiers.counts(), ran = { platform: [] as number[], app: [] as number[] };
    const add = (slot: number) => { const c = this.loadedFrom(slot); if (c >= 0) (c >= this.appFrom ? ran.app : ran.platform).push(slot); };
    for (let slot = 0; slot < COUNT_SLOTS; slot++) if (counts[slot]) add(slot);
    for (const slot of tiers.unitSlots()) if (slot < COUNT_SLOTS && !counts[slot]) add(slot);
    return ran;
  }
  private preparation = new Map<number, Promise<void>>();
  private prepared = new Set<number>();
  private preparationModule(slot: number): number {
    const b = this.w.slots.blockOf(slot), c = b < 0 ? -1 : this.cOf[b] ?? -1;
    return !this.store?.prefetch || !this.w.instantiates || c < 0 || c >= this.appFrom || this.cState[c] ? -1 : c;
  }
  private preparationFiles(c: number): string[] {
    const file = aotFile("c", c), mod = this.store!.get(file);
    if (!mod) return [file];
    // Byte stores are already local. Only asynchronously compiled modules need a delivery wait.
    if (ArrayBuffer.isView(mod)) return [];
    const head = header<CHeader>(mod);
    if (!this.w.units.admits(head)) return [];
    const files: string[] = [];
    for (const g of head.mods) if (!this.fallbackD.has(g)) {
      const file = aotFile("d", g);
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
  /** whether the build's code of `slot` is in place, its code module loaded first if need be (the method's first call): not once something undid it */
  provide(slot: number): boolean {
    const b = this.w.slots.blockOf(slot), c = b < 0 ? -1 : this.cOf[b];
    if (!(c >= 0)) return false;
    let loaded = this.loadC(c);
    // App patches can remain valid when their platform unit is rejected.
    if (!loaded && this.cState[c] === DEAD) for (const p of this.app?.patchesOver.get(c) ?? []) loaded = this.loadC(p) || loaded;
    return loaded && !!this.w.slots.at(slot)?.done;
  }
  /** the code modules linkAhead links, the next last */
  private linkQueue: number[] = [];
  /** has linkAhead link the code modules that earlier launches of the app loaded (`files`, the platform's in the order a launch wanted them) and ran build code of (`slots`) */
  planLinks(files: readonly string[], slots: Int32Array = new Int32Array()): void {
    const order = new Set<number>();
    for (const file of files) { const f = parseAotFile(file); if (f?.kind === "c") order.add(f.n); }
    for (const slot of slots) { const b = this.w.slots.blockOf(slot), c = b < 0 ? -1 : this.cOf[b] ?? -1; if (c >= 0) order.add(c); }
    this.linkQueue = [...order].reverse();
  }
  /** Idle time: links the planned code modules until `until`, as the first call of one of their methods would, so that an interaction's first calls find their
   *  code in place rather than link it on the way (the training run of ahead-of-time class loading and linking, JEP 483). Whether any is left. */
  linkAhead(until: number): boolean {
    if (!this.w.instantiates) return false;
    while (this.linkQueue.length && performance.now() < until) {
      const c = this.linkQueue.pop()!;
      if (!this.cState[c] && this.linkable(c) && this.loadC(c)) this.w.stats.aot.linkedAhead++;
    }
    return this.linkQueue.length > 0;
  }
  /** whether code module `c` links now with nothing to fetch, compile or wait for: compiled, its natives bound, its data here and, for the app build's, the root's
   *  libraries those it was compiled under. One that does not is left to the first call of one of its methods, which links or gives it up as before. */
  private linkable(c: number): boolean {
    const app = c >= this.appFrom;
    if (app && !this.boundAsBuilt()) return false;
    const mod = this.store?.get(app ? aotFile("a", c - this.appFrom) : aotFile("c", c));
    if (!mod || ArrayBuffer.isView(mod)) return false;
    const head = header<CHeader>(mod);
    return this.w.units.admits(head) && this.dataReady(head, false);
  }
  private loadC(c: number): boolean {
    if (this.cState[c]) return this.cState[c] === LIVE;
    const w = this.w, app = c >= this.appFrom, file = app ? aotFile("a", c - this.appFrom) : aotFile("c", c), mod = this.module(file);
    if (!mod) { if (app) this.cState[c] = DEAD; return false; }
    const head = header<CHeader>(mod);
    if (!w.units.admits(head)) { this.cState[c] = DEAD; w.stats.aot.dead++; return false; }
    if (!this.dataReady(head)) return false;
    if (!head.mods.every(g => this.fallbackD.has(g) || !!this.loadD(g))) { this.cState[c] = DEAD; w.stats.aot.dead++; return false; }
    const absent = new Set(head.absent), taken = w.hosts.taken();
    if (this.overriddenSeen !== taken.size) {
      this.overriddenBy.clear();
      for (const slot of taken) { const m = this.cOf[w.slots.blockOf(slot)]; if (m >= 0) (this.overriddenBy.get(m) ?? this.overriddenBy.set(m, []).get(m)!).push(slot); }
      this.overriddenSeen = taken.size;
    }
    this.cState[c] = LIVE; this.cModule[c] = mod; this.cAbsent[c] = absent;
    if (app) this.cClasses[c] = head.classes;
    // Retired data groups bind each class's published globals instead of creating another owner.
    const modules: Record<string, WebAssembly.Exports> = {};
    for (const g of head.mods) { const ex = this.dExports[g]; if (ex) modules["g" + g] = ex; }
    let t2 = 0;
    const placed = w.units.link({ head, module: mod, modules }, () => {
      w.stats.aot.c++;
      t2 = performance.now();
      // slots made before the module was loaded say it is not there; the rest are made from the module's state
      for (const b of head.classes) {
        const base = w.slots.blockBase[b], n = w.slots.methodsIn(b);
        for (let i = 0; i < n; i++) { const s = w.slots.peek(base + i); if (s?.k === "method" && this.has(c, base + i)) s.done = true; }
      }
      return true;
    });
    if (!placed) { this.cState[c] = 0; return false; }
    for (const slot of this.overriddenBy.get(c) ?? []) if (!this.cAbsent[c]!.has(slot)) { w.assumptions.undoCode(slot); this.cAbsent[c]!.add(slot); }
    // code that holds a method of another module the host took since the build: that module may have undone the method before this one was loaded
    for (const [callee, ...by] of head.held ?? []) if (taken.has(callee)) for (const x of by) w.assumptions.undoCode(x);
    w.stats.aot.ms += performance.now() - t2;
    // the app build's patches of this module's methods: after its own code, which they replace where they have some
    for (const p of this.app?.patchesOver.get(c) ?? []) this.loadC(p);
    return true;
  }

  // ---- invalidation
  /** App units were compiled before the runtime loader's library graph was known. Keep platform modules and stable numbering, but discard the app's old resolution. */
  unbindApp(): void {
    for (let c = this.appFrom; c < this.cState.length; c++) this.cState[c] = DEAD;
    this.app = undefined;
    this.synthIn.clear();
  }
  // ---- stack traces
  /** the trace of function `name` of a loaded code module, whose section is indexed the first time a stack needs one of its functions and read function by function */
  trace(name: string): FnTrace | undefined {
    const w = this.w, m = methodOf(w.prog, name);
    if (!m) return undefined;
    const base = w.slots.baseOf(m.cls);
    if (base === undefined) return undefined;
    const c = this.cOf[w.slots.blockOf(base)];
    if (c < 0) return undefined;
    // a patch of the module has the code of the methods it replaced
    for (const module of [...this.app?.patchesOver.get(c) ?? [], c]) {
      const t = this.cState[module] === LIVE ? this.traceIn(module, base + m.index, m, name) : undefined;
      if (t) return t;
    }
    return undefined;
  }
  private traceIn(c: number, slot: number, m: MethodInfo, name: string): FnTrace | undefined {
    let section = this.cTraces.get(c);
    if (!section) {
      const bytes = customSection(this.cModule[c]!, "aottrace"), r = new LebReader(bytes), starts = new Map<number, number>();
      while (r.i < bytes.length) { const s = r.u32(), len = r.u32(); starts.set(s, r.i); r.i += len; }
      this.cTraces.set(c, section = { bytes, starts });
    }
    const from = section.starts.get(slot);
    if (from === undefined) return undefined;
    const r = new LebReader(section.bytes, from), n = r.u32(), offsets = new Int32Array(n), pcs = new Int32Array(n);
    for (let i = 0, o = 0, p = 0; i < n; i++) {
      offsets[i] = o += r.u32();
      const z = r.u32(); pcs[i] = p += (z >>> 1) ^ -(z & 1);
    }
    const t: FnTrace = { name, m, offsets, pcs }, k = r.u32();
    if (k) t.inline = Array.from({ length: k }, () => [this.w.slots.method(r.u32())!.m, r.u32(), r.u32()]);
    this.w.stacks.traces.set(name, t);
    return t;
  }
}
