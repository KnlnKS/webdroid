// An app compiled ahead on top of the platform build (aot.ts `extend`): the code of the methods it is likely to run, in code modules a<k>.wasm of the classes' groups, and the
// numbering that code relies on. A World at the platform build's state that has the app's dexes takes it as it takes the platform's own modules, and compiles the rest on demand.
// The build may be made by shards, Worlds that each number the same seed (seedApp) and then compile their share of the modules with their numbering frozen.
import { mid } from "../compiler/ids.ts";
import { codeBytes, codeModule, dataBytes, dataModule, invalidFunction, packModule, synthModules } from "./aotbuild.ts";
import { synthOf } from "./synths.ts";
import { APP_VERSION, type AotRuntime, type AppIndex, type CHeader, type Demand } from "./aot.ts";
import type { MethodInfo } from "../compiler/program.ts";
import type { World } from "./world.ts";
import { LinkIds, type Marks, type Numbering } from "./numbers.ts";
import { walkRefs } from "../../jvm/opcodes.ts";
import { descToName } from "../../jvm/abi.ts";
import type { DexFile } from "../../jvm/dex.ts";

/** the estimated size of a code module where the next class starts another */
const MODULE_BYTES = 1 << 20;
/** the same for a data module: a module is loaded whole when any of its classes is first used, so these are small */
const D_MODULE_BYTES = 128 << 10;
/** the code bytes whose compile takes as long as building a class's data (measured over a whole app) */
const D_COST_PER_CLASS = 350;
export interface AppBuild { index: AppIndex; files: [name: string, bytes: Uint8Array][] }
/** what a shard made: its modules, where they put classes, and the link errors it numbered after the prefix, with their ids */
export interface ShardPart { files: AppBuild["files"]; cOf: AppIndex["cOf"]; patches: AppIndex["patches"]; links: [message: string, id: number][] }
/** the first shard's part, which also has the build's index but for what `mergeApp` adds */
export interface LeadPart extends ShardPart { index: Omit<AppIndex, "id" | "cOf" | "patches"> }
export type AppPart = ShardPart | LeadPart;

/** Numbers what the code of `methods` names, in the same order in every World at the same state: their classes first (so that the likely ones have the low slots, which count
 *  calls), then the classes, array classes and interface selectors their instructions name. A World that has numbered this seed compiles the methods without numbering more,
 *  but for link errors, whose ids are their messages' (Numbers.linkId), and rare names the instructions do not show. */
function seedApp(w: World, methods: MethodInfo[]): void {
  for (const m of methods) w.link(m.cls);
  const prog = w.prog, object = prog.get("java/lang/Object")!, seen = new Map<DexFile, Set<number>>();
  const link = (name: string) => { if (name[0] === "[" || prog.get(name)) w.link(name); };
  const type = (desc: string) => { if (desc[0] === "[" || desc[0] === "L") link(desc[0] === "[" ? desc : descToName(desc)); };
  /** a reference is looked at once: by its kind (an interface call, another call, a type, a field) and its index in the dex */
  const REF = { call: 0, iface: 1 << 16, type: 2 << 16, field: 3 << 16 };
  for (const m of methods) {
    if (!m.codeOff) continue;
    const dex = m.dex;
    let done = seen.get(dex);
    if (!done) seen.set(dex, done = new Set());
    const first = (ref: number) => !done.has(ref) && !!done.add(ref);
    walkRefs(dex.code(m.codeOff), {
      invoke(op, idx) {
        const iface = op === 0x72 || op === 0x78;
        if (!first((iface ? REF.iface : REF.call) | idx)) return;
        const ref = dex.method(idx), cls = descToName(dex.type(ref.cls)), desc = dex.methodDesc(idx), key = ref.name + desc;
        link(cls);
        const target = cls[0] === "[" ? undefined : prog.resolve(cls, ref.name, desc);
        if (target) w.link(target.cls);
        if ((iface || prog.get(cls)?.isInterface) && !object.byKey.has(key)) w.selectorId(key);
      },
      type(_, idx) { if (first(REF.type | idx)) type(dex.type(idx)); },
      field(_, idx) { if (first(REF.field | idx)) link(descToName(dex.type(dex.field(idx).cls))); },
    });
  }
  // the classes the host implements, which a call can be devirtualized to
  for (const name of w.hostClassNames()) w.link(name);
}

/** a code module's methods, all of a class's together, the platform code module they patch (-1 for none), and its estimated size */
interface Group { methods: MethodInfo[]; over: number; bytes: number }
/** what every shard of a build makes alike of the World it seeded: where the numbering stood, the code modules' groups and the shard each goes to, and the classes of
 *  the data modules */
interface AppPlan { aot: AotRuntime; prefix: Numbering; base: Marks; groups: Group[]; shardOf: number[]; dNames: string[] }

function planApp(w: World, methods: MethodInfo[], demand: Demand, shards: number): AppPlan {
  const aot = w.aot;
  if (!aot) throw new Error("an app build needs the platform build");
  const prefix = w.numbers.since(aot.platformMarks), base = w.numbers.marks(), byClass = new Map<string, MethodInfo[]>();
  seedApp(w, methods);
  const seeded = w.numbers.since(base).names;
  for (const m of methods) { const list = byClass.get(m.cls); if (list) list.push(m); else byClass.set(m.cls, [m]); }
  // the methods of platform classes that a platform code module holds are a patch to that module: loaded after it, they replace what a class of the app made it undo or lack. The other
  // classes' methods are in modules of their own.
  const own: MethodInfo[][] = [], patches = new Map<number, MethodInfo[][]>();
  for (const [cls, list] of byClass) {
    const over = aot.platformModule(w.slots.blockOf(w.link(cls).slotBase));
    if (over < 0) own.push(list); else (patches.get(over) ?? patches.set(over, []).get(over)!).push(list);
  }
  const grouped = (lists: MethodInfo[][], over: number): Group[] => {
    const groups: Group[] = [{ methods: [], over, bytes: 0 }];
    for (const list of lists) {
      const size = list.reduce((n, m) => n + codeBytes(m), 0);
      let last = groups[groups.length - 1];
      if (last.bytes && last.bytes + size > MODULE_BYTES) groups.push(last = { methods: [], over, bytes: 0 });
      last.methods.push(...list); last.bytes += size;
    }
    return groups.filter((g) => g.methods.length);
  };
  const groups = [...grouped(own, -1), ...[...patches].flatMap(([over, lists]) => grouped(lists, over))];
  // the data modules are those of the classes the seed numbered, which the code names, and of those launches asked for
  const dNames = [...new Set([...demand.classes, ...seeded])].filter((name) => {
    const jc = w.prog.get(name);
    // The platform also owns data for uncompiled classes reserved in its tail; an array class the app's code names is the app's
    return (jc?.dex || name[0] === "[") && aot.reservedBase(name) === undefined;
  });
  // each group goes to the shard with the least work so far, the first starting with the data modules
  const load = Array.from({ length: shards }, (_, i) => (i ? 0 : dNames.length * D_COST_PER_CLASS)), shardOf: number[] = [];
  for (const k of groups.map((_, k) => k).sort((a, b) => groups[b].bytes - groups[a].bytes || a - b)) {
    const to = load.indexOf(Math.min(...load));
    load[to] += groups[k].bytes;
    shardOf[k] = to;
  }
  return { aot, prefix, base, groups, shardOf, dNames };
}

/** the code modules of `shard`, compiled with the numbering `frozen` when other shards compile against the same one */
function compileShard(w: World, plan: AppPlan, shard: number, frozen: boolean): ShardPart {
  const files: AppBuild["files"] = [], cOf: AppIndex["cOf"] = [], patches: AppIndex["patches"] = [];
  const compile = () => plan.groups.forEach(({ methods: group, over }, module) => {
    if (plan.shardOf[module] !== shard) return;
    const { built, header: unit, skipped } = codeModule(w, group);
    const classes = [...new Set(group.map((m) => m.cls))].map((c) => w.slots.blockOf(w.link(c).slotBase));
    const wanted = new Set(group);
    const absent = classes.flatMap((b) => w.prog.get(w.slots.blockClass[b])!.methods.filter((m) => !wanted.has(m) || skipped.has(mid(m))).map((m) => w.slots.blockBase[b] + m.index));
    const header: CHeader = { ...unit, classes, mods: [], absent };
    files.push([`a${module}.wasm`, packModule(header, built.bytes, { w, traces: built.traces })]);
    if (over < 0) for (const b of classes) cOf.push([b, module]); else patches.push([module, over]);
  });
  if (frozen) w.numbers.frozen(compile); else compile();
  return { files, cOf, patches, links: w.numbers.links.since(plan.base.links) };
}

/** the first shard's part: its code modules `part`, then, with its numbering free again, the data modules, those of the synthetic functions, and the index */
function buildLead(w: World, plan: AppPlan, demand: Demand, part: ShardPart): LeadPart {
  const { files } = part, dOf: AppIndex["dOf"] = [];
  let group: string[] = [], size = 0, dModules = 0;
  const flush = () => {
    if (!group.length) return;
    const { bytes, header } = dataModule(w, group);
    group = []; size = 0;
    // a module V8 rejects leaves its classes to the on-demand builder
    if (invalidFunction(bytes)) return;
    for (const b of header.classes) dOf.push([b, dModules]);
    files.push([`e${dModules++}.wasm`, packModule(header, bytes)]);
  };
  // the classes a code module names are all linked when it is loaded, so their modules are wanted as soon as it is
  for (const name of plan.dNames) {
    const bytes = dataBytes(w.prog.get(name));
    if (size && size + bytes > D_MODULE_BYTES) flush();
    group.push(name); size += bytes;
  }
  flush();
  // the synthetic functions the code names and those the host asked for: modules of a few dozen, which load together
  for (const name of demand.synths) { const d = synthOf(w, name); if (d) w.synthSlot(name, d); }
  const synths = synthModules(w, (k, bytes) => files.push([`s${k}.wasm`, bytes]));
  const { aot, prefix, base } = plan;
  return { ...part, links: w.numbers.links.since(base.links), index: { version: APP_VERSION, prefix, base, dexes: aot.appDexes(), classes: aot.appClassCount,
    numbering: w.numbers.since(base), modules: plan.groups.length, synths, dOf, dModules, demand, libraries: aot.rootLibraries() } };
}

/** Shard `shard` of `shards` of the build of `methods` (of the Program's classes after the platform's, in the order the app will want them) and the data modules of
 *  `demand.classes` and the classes the code names, by a World that has just attached the platform build and numbered the app's prefix. The shards deal the code modules
 *  among them alike; the first also builds the data and synthetic modules and the index. */
export function buildPart(w: World, methods: MethodInfo[], demand: Demand, shard: number, shards: number): AppPart {
  const plan = planApp(w, methods, demand, shards), part = compileShard(w, plan, shard, shards > 1);
  return shard ? part : buildLead(w, plan, demand, part);
}

/** the build of `methods` by one World */
export function buildApp(w: World, methods: MethodInfo[], demand: Demand): AppBuild {
  const plan = planApp(w, methods, demand, 1);
  return mergeApp(buildLead(w, plan, demand, compileShard(w, plan, 0, false)), []);
}

/** the build the shards' parts make: the lead's index, with every shard's modules and the link errors they numbered. Replayed after the lead's, another shard's link
 *  error takes its hash as its id (Numbers.linkId), as the shard's frozen numbering did, unless a message the shards did not share has it; a random id tells the build
 *  from the other builds made under its key */
export function mergeApp(lead: LeadPart, rest: AppPart[]): AppBuild {
  const parts = [lead, ...rest], links = new LinkIds();
  for (const [m, id] of parts.flatMap((p) => p.links)) if (!links.put(m, id)) throw new Error(`link errors share an id: ${links.message(id)} and ${m}`);
  const index: AppIndex = { ...lead.index, id: 1 + Math.floor(Math.random() * 0x7ffffffe), numbering: { ...lead.index.numbering, links: links.messages }, cOf: parts.flatMap((p) => p.cOf), patches: parts.flatMap((p) => p.patches) };
  return { index, files: parts.flatMap((p) => p.files) };
}
