// Usage (from this directory, so the repo's bunfig preload is not applied):
//   bun run.ts [--only label,label] [--limit N]
// Writes out/<label>.json per corpus. Platform universe (framework.jar + boot jars) is the CHA base.
import { readdirSync, writeFileSync } from "node:fs";
import { ROOT, openDexes } from "./load.ts";
import type { DexFile } from "../../../src/jvm/dex.ts";
import { decodeInstructions, prepareMethod, switchCases } from "../../../src/jvm/prepared.ts";
import { Flow } from "../../../src/jvm/structure.ts";
import { isInvoke, isInstanceInvoke } from "../../../src/wasm/compiler/opinfo.ts";
import { buildCfg } from "../../../src/wasm/compiler/cfg.ts";
import { FAMILY } from "./families.ts";
import { isReducible } from "./reducible.ts";
import { parseMethodDesc } from "../../../src/jvm/abi.ts";
import { inferMethod, retOf, KIND_NAMES } from "./infer.ts";
import { Universe, ACC_FINAL, ACC_INTERFACE } from "./cha.ts";

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const limit = args.includes("--limit") ? +args[args.indexOf("--limit") + 1] : Infinity;

const bootDir = ROOT + "vendor/aosp/boot/";
const bootJars = readdirSync(bootDir).filter((f) => f.endsWith(".jar")).sort();
const APPS: Record<string, string> = {
  mihon: "apks/mihon-v0.20.4.apk", fitnotes: "apks/FitNotes.apk", harmonic: "apks/harmonic.apk",
  newpipe: "apks/org.schabi.newpipe_1015.apk", komikku: "apks/Komikku-arm64-v8a-v1.14.1.apk",
};
const CORPORA: Record<string, string[]> = {
  framework: ["vendor/aosp/framework.jar"],
  "core-oj": ["vendor/aosp/boot/core-oj.jar"],
  "core-libart": ["vendor/aosp/boot/core-libart.jar"],
  "boot-other": bootJars.filter((f) => f !== "core-oj.jar" && f !== "core-libart.jar").map((f) => "vendor/aosp/boot/" + f),
  ...Object.fromEntries(Object.entries(APPS).map(([k, v]) => [k, [v]])),
};

const platform = new Universe();
const platformDexes: Record<string, DexFile[]> = {};
{
  const t0 = performance.now();
  for (const label of ["framework", "core-oj", "core-libart", "boot-other"]) {
    platformDexes[label] = (await Promise.all(CORPORA[label].map(openDexes))).flat();
    platform.add(platformDexes[label]);
  }
  console.log(`universe: ${platform.classes.size} platform classes in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

const PCT = (a: number[], q: number) => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const dist = (a: number[]) => ({ n: a.length, mean: a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0, p50: PCT(a, 0.5), p90: PCT(a, 0.9), p99: PCT(a, 0.99), max: a.length ? PCT(a, 1) : 0 });
const bump = (o: Record<string, number>, k: string, v = 1) => { o[k] = (o[k] ?? 0) + v; };
const top = <T>(arr: T[], key: (t: T) => number, k = 6) => [...arr].sort((a, b) => key(b) - key(a)).slice(0, k);

interface M { dex: DexFile; cls: string; name: string; desc: string; isStatic: boolean; flags: number; code: ReturnType<DexFile["code"]>; key: string; }
function* methodsOf(dexes: DexFile[]): Generator<M> {
  for (const dex of dexes) for (let i = 0; i < dex.classDefCount; i++) {
    const def = dex.classDef(i), cls = dex.type(def.typeIdx);
    for (const em of [...def.directMethods, ...def.virtualMethods]) {
      if (!em.codeOff) continue;
      const mr = dex.method(em.methodIdx), desc = dex.methodDesc(em.methodIdx);
      yield { dex, cls, name: mr.name, desc, isStatic: !!(em.flags & 8), flags: em.flags, code: dex.code(em.codeOff), key: cls + "." + mr.name + desc };
    }
  }
}

async function analyze(label: string): Promise<void> {
  const dexes = platformDexes[label] ?? (await Promise.all(CORPORA[label].map(openDexes))).flat();
  const uni = platformDexes[label] ? platform : new Universe(platform);
  if (!platformDexes[label]) uni.add(dexes);
  const dexBytes = new Set(dexes.map((d) => d.bytes)).size ? [...new Set(dexes.map((d) => d.bytes))].reduce((s, b) => s + b.length, 0) : 0;
  const corpusClasses = new Set<string>();
  const S = {
    label, dexFiles: dexes.length, dexBytes, classes: 0, methodsWithCode: 0, instructions: 0, codeUnits: 0,
    family: {} as Record<string, number>, familyMethods: {} as Record<string, number>,
    sizeBytes: [] as number[], blocks: [] as number[], instrsPer: [] as number[],
    big: { gt1k: 0, gt8k: 0, gt64k: 0, gt256k: 0, maxBytes: 0, maxMethod: "" },
    shape: {} as Record<string, number>,
    tries: { methodsWithTry: 0, tryItems: 0, handlerClauses: 0, catchAll: 0, maxTryItems: 0, maxHandlersInItem: 0, typed: {} as Record<string, number>, itemsWithBoth: 0 },
    switches: { packed: [] as number[], sparse: [] as number[] },
    cfg: { methods: 0, irreducibleA: 0, irreducibleB: 0, irreducibleNames: [] as string[], flowOk: 0, flowMultiRegion: 0, regionsHist: {} as Record<string, number>, irreducibleBNames: [] as string[], flowFail: {} as Record<string, number>, flowSkipped: 0, flowPrepFail: 0, flowFailNames: [] as string[] },
    infer: { methods: 0, skipped: {} as Record<string, number>, noConflict: 0, full: 0, withMultiKind: 0, withMultiKindOnlyZero: 0, conflicts: 0, conflictsZero: 0, undetermined: 0, undetZero: 0, multiKindVregs: 0, multiKindOnlyZero: 0, vregs: 0, webs: 0, deadDefs: 0, kindWebs: {} as Record<string, number>, floatConstWebs: 0, zeroConstWebs: 0,
      methodsWithConflictZero: 0, methodsConflictNonZero: 0, ms: 0, msDist: [] as number[], regs: [] as number[], split: [] as number[], websPer: [] as number[], untypedWide: [] as number[], splitOverRegs: 0, sumRegs: 0, sumSplit: 0, sumWebs: 0, sumUntypedWide: 0, hardest: [] as any[], nonZeroConflictNames: [] as string[] },
    calls: {} as Record<string, any>,
  };
  const hard: { name: string; conflicts: number; multi: number; webs: number; regs: number; units: number; ms: number; split: number }[] = [];
  const info = new Map<string, { units: number; leaf: boolean }>();
  let nth = 0;
  const t0 = performance.now();
  for (const dex of dexes) S.classes += dex.classDefCount;
  for (const dex of dexes) for (let i = 0; i < dex.classDefCount; i++) corpusClasses.add(dex.type(dex.classDef(i).typeIdx));

  for (const m of methodsOf(dexes)) {
    if (nth++ >= limit) break;
    const { dex, code } = m;
    let ins;
    try { ins = decodeInstructions(code.insns); } catch { bump(S.shape, "decode-fail"); continue; }
    S.methodsWithCode++; S.instructions += ins.length; S.codeUnits += code.insns.length;
    const bytes = code.insns.length * 2;
    S.sizeBytes.push(bytes); S.instrsPer.push(ins.length);
    if (bytes > 1024) S.big.gt1k++; if (bytes > 8192) S.big.gt8k++; if (bytes > 65536) S.big.gt64k++; if (bytes > 262144) S.big.gt256k++;
    if (bytes > S.big.maxBytes) { S.big.maxBytes = bytes; S.big.maxMethod = m.key; }

    // opcode families + shape predicates
    const seenFam = new Set<string>();
    let invokes = 0, monitors = 0, objectish = 0, allocs = 0, throws = 0, fieldOrArray = 0, anyWideOp = 0, fpOp = 0;
    for (const x of ins) {
      const f = FAMILY[x.op];
      bump(S.family, f); seenFam.add(f);
      if (isInvoke(x.op)) invokes++;
      if (x.op === 0x1d || x.op === 0x1e) monitors++;
      if (f === "new-instance" || f === "new-array" || f === "filled-new-array" || f === "const-string" || f === "const-class") allocs++;
      if (f === "throw") throws++;
      if (f === "move-object" || f === "move-exception" || f.endsWith("-obj") || f === "check-cast" || f === "instance-of" || x.op === 0x11) objectish++;
      if (/^(aget|aput|iget|iput|sget|sput)/.test(f) || f === "array-length" || f === "fill-array-data") fieldOrArray++;
      if (f.includes("wide") || f.includes("long") || f.includes("double") || f.includes("cmp-long") || (x.op >= 0x7d && x.op <= 0x7e) || (x.op >= 0x81 && x.op <= 0x8f && [0x81, 0x83, 0x84, 0x85, 0x86, 0x88, 0x89, 0x8a, 0x8b].includes(x.op))) anyWideOp++;
      if (f.includes("float") || f.includes("double") || f.startsWith("conv") || f.startsWith("cmp-float")) fpOp++;
      if (x.op === 0x2b) S.switches.packed.push(code.insns[x.pc + x.b + 1]);
      if (x.op === 0x2c) S.switches.sparse.push(code.insns[x.pc + x.b + 1]);
    }
    for (const f of seenFam) bump(S.familyMethods, f);
    const sig = parseMethodDesc(m.desc);
    const wideSig = sig.params.some((p) => p === "J" || p === "D") || sig.ret === "J" || sig.ret === "D";
    const leaf = invokes === 0;
    info.set(m.key, { units: code.insns.length, leaf });
    bump(S.shape, "methods");
    if (leaf) bump(S.shape, "leaf(no invoke)");
    if (!code.tries.length) bump(S.shape, "no try");
    if (monitors) bump(S.shape, "has monitor-enter/exit");
    bump(S.shape, "units:all", code.insns.length);
    if (leaf) bump(S.shape, "units:leaf", code.insns.length);
    if (leaf && !allocs && !throws && !monitors && !objectish) bump(S.shape, "units:numeric-leaf", code.insns.length);
    if (m.flags & 0x20) bump(S.shape, "ACC_SYNCHRONIZED");
    if (anyWideOp || wideSig) bump(S.shape, "uses long/double (op or signature)");
    if (fpOp) bump(S.shape, "uses float/double ops");
    if (leaf && !allocs && !throws && !monitors) bump(S.shape, "leaf, no alloc/throw/monitor");
    if (leaf && !allocs && !throws && !monitors && !objectish) bump(S.shape, "leaf, no alloc/throw/monitor, no object ops (numeric+prim fields/arrays)");
    if (leaf && !allocs && !throws && !monitors && !objectish && !fieldOrArray) bump(S.shape, "register-only leaf (no invoke/alloc/field/array/object)");
    if (ins.length <= 4) bump(S.shape, "tiny (<=4 instructions)");
    if (ins.length <= 8 && leaf) bump(S.shape, "small leaf (<=8 instructions)");

    // tries
    if (code.tries.length) {
      S.tries.methodsWithTry++; S.tries.tryItems += code.tries.length;
      S.tries.maxTryItems = Math.max(S.tries.maxTryItems, code.tries.length);
      for (const t of code.tries) {
        S.tries.handlerClauses += t.handlers.length;
        S.tries.maxHandlersInItem = Math.max(S.tries.maxHandlersInItem, t.handlers.length);
        if (t.catchAllAddr >= 0) S.tries.catchAll++;
        if (t.catchAllAddr >= 0 && t.handlers.length) S.tries.itemsWithBoth++;
        for (const [ty] of t.handlers) bump(S.tries.typed, dex.type(ty));
      }
    }

    // cfg shape / reducibility / the repo's structurer
    let cfg;
    try { cfg = buildCfg(code, ins); } catch { bump(S.shape, "cfg-fail"); }
    if (cfg) {
      S.cfg.methods++; S.blocks.push(cfg.n);
      const rootsA = [0, ...cfg.handlers];
      const redA = isReducible(cfg.n, (b) => cfg!.succ[b], rootsA);
      const redB = isReducible(cfg.n, (b) => [...cfg!.succ[b], ...cfg!.hsucc[b]], [0]);
      if (!redA) { S.cfg.irreducibleA++; if (S.cfg.irreducibleNames.length < 10) S.cfg.irreducibleNames.push(m.key); }
      if (!redB) { S.cfg.irreducibleB++; if (S.cfg.irreducibleBNames.length < 10) S.cfg.irreducibleBNames.push(m.key); }
      if (cfg.n > 1 || code.tries.length) {
        try {
          const prep = prepareMethod(dex, code, m.desc, m.isStatic);
          try { const fl = new Flow(prep, code); S.cfg.flowOk++; bump(S.cfg.regionsHist, fl.regions.length > 8 ? "9+" : String(fl.regions.length)); if (fl.regions.length > 1) S.cfg.flowMultiRegion++; }
          catch (e) { const msg = String((e as Error).message ?? e); bump(S.cfg.flowFail, msg); if (S.cfg.flowFailNames.length < 10) S.cfg.flowFailNames.push(msg + " " + m.key); }
        } catch { S.cfg.flowPrepFail++; }
      } else S.cfg.flowSkipped++;
    }

    // type inference
    const ti = performance.now();
    let r;
    try { r = inferMethod(dex, code, m.desc, m.isStatic, ins); } catch (e) { r = null; bump(S.infer.skipped, "throw: " + String((e as Error).message).slice(0, 60)); }
    const dt = performance.now() - ti;
    if (r) {
      if (r.skipped) bump(S.infer.skipped, r.skipped);
      else {
        const I_ = S.infer;
        I_.methods++; I_.ms += dt; I_.msDist.push(dt);
        if (!r.conflicts) { I_.noConflict++; if (!r.underdetermined) I_.full++; }
        if (r.multiKindVregs) I_.withMultiKind++;
        if (r.multiKindVregs && r.multiKindVregs === r.multiKindOnlyZero) I_.withMultiKindOnlyZero++;
        if (r.conflicts) { if (r.conflicts === r.conflictsWithZero) I_.methodsWithConflictZero++; else I_.methodsConflictNonZero++; }
        if (r.conflicts > r.conflictsWithZero && I_.nonZeroConflictNames.length < 40) I_.nonZeroConflictNames.push(m.key);
        I_.conflicts += r.conflicts; I_.conflictsZero += r.conflictsWithZero; I_.undetermined += r.underdetermined; I_.undetZero += r.underdeterminedZero;
        I_.multiKindVregs += r.multiKindVregs; I_.multiKindOnlyZero += r.multiKindOnlyZero; I_.vregs += r.vregs; I_.webs += r.webs; I_.deadDefs += r.deadDefs;
        for (const [k, v] of Object.entries(r.kindWebs)) bump(I_.kindWebs, k, v);
        I_.floatConstWebs += r.floatConsts; I_.zeroConstWebs += r.zeroConstWebs;
        I_.regs.push(r.regs); I_.split.push(r.localsSplit); I_.websPer.push(r.localsWebs); I_.untypedWide.push(r.localsUntypedWide);
        I_.sumRegs += r.regs; I_.sumSplit += r.localsSplit; I_.sumWebs += r.localsWebs; I_.sumUntypedWide += r.localsUntypedWide;
        if (r.localsSplit > r.regs) I_.splitOverRegs++;
        hard.push({ name: m.key, conflicts: r.conflicts, multi: r.multiKindVregs, webs: r.localsWebs, regs: r.regs, units: code.insns.length, ms: dt, split: r.localsSplit });
        if (hard.length > 4000) { hard.sort((a, b) => b.conflicts * 1e6 + b.multi * 1e3 + b.webs - (a.conflicts * 1e6 + a.multi * 1e3 + a.webs)); hard.length = 400; }
        // float/wide usage by inferred kinds
        if (r.kindWebs.J || r.kindWebs.D) bump(S.shape, "has long/double values (inferred)");
        if (r.kindWebs.F || r.kindWebs.D) bump(S.shape, "has float/double values (inferred)");
        if (r.floatConsts) bump(S.shape, "has float constants (inferred const->F)");
        if (r.kindWebs.F === undefined) void 0;
        if (!r.kindWebs.J && !r.kindWebs.D && !r.kindWebs.F) bump(S.shape, "int/ref only (no J/F/D values)");
        if (leaf && !r.kindWebs.R && !r.kindWebs["?"]) bump(S.shape, "leaf with zero ref-kind webs (incl. no `this`? this counted only if read)");
      }
    }
  }
  const wall = performance.now() - t0;

  // ---------------- pass 2: invoke targets
  const C = {
    sites: 0, byKind: {} as Record<string, number>, distinctRefsPerMethod: [] as number[], sitesPerMethod: [] as number[],
    sameClass: 0, samePackage: 0, calleeInCorpus: 0, calleeInPlatform: 0, calleeOther: 0, arrayReceiver: 0,
    chaVirtual: {} as Record<string, number>, chaInterface: {} as Record<string, number>,
    directTargetLeaf: 0, directTargetKnown: 0, directTargetSmall: 0,
    virtualFinalClassOrMethodShare: 0, hasZeroSubclassClassShare: 0,
    calleeNamespaces: {} as Record<string, number>,
  };
  const pkg = (d: string) => d.slice(0, d.lastIndexOf("/") + 1);
  nth = 0;
  for (const m of methodsOf(dexes)) {
    if (nth++ >= limit) break;
    const ins = decodeInstructions(m.code.insns);
    const refs = new Set<number>(); let sites = 0;
    for (const x of ins) {
      if (!isInvoke(x.op)) continue;
      sites++; C.sites++;
      const kind = FAMILY[x.op];
      bump(C.byKind, kind);
      if (x.op >= 0xfa) { bump(C.calleeNamespaces, "(polymorphic/custom)"); continue; }
      refs.add(x.b);
      const mr = m.dex.method(x.b), callee = m.dex.type(mr.cls), key = mr.name + m.dex.methodDesc(x.b);
      if (callee === m.cls) C.sameClass++;
      if (pkg(callee) === pkg(m.cls)) C.samePackage++;
      if (callee[0] === "[") C.arrayReceiver++;
      else if (corpusClasses.has(callee)) C.calleeInCorpus++;
      else if (platform.get(callee)) C.calleeInPlatform++;
      else C.calleeOther++;
      const ns = callee[0] === "[" ? "[array]" : callee.startsWith("Ljava/") || callee.startsWith("Ljavax/") ? "java/javax" : callee.startsWith("Landroid/") ? "android" : callee.startsWith("Lkotlin/") ? "kotlin" : callee.startsWith("Landroidx/") ? "androidx" : platform.get(callee) ? "other platform" : "app/3rd-party";
      bump(C.calleeNamespaces, ns);
      if (x.op === 0x71 || x.op === 0x77 || x.op === 0x70 || x.op === 0x76) {
        const inf = info.get(callee + "." + mr.name + m.dex.methodDesc(x.b));
        if (inf) { C.directTargetKnown++; if (inf.leaf) C.directTargetLeaf++; if (inf.units <= 16) C.directTargetSmall++; }
      }
      if (x.op === 0x6e || x.op === 0x74 || x.op === 0x72 || x.op === 0x78) {
        const tbl = x.op === 0x72 || x.op === 0x78 ? C.chaInterface : C.chaVirtual;
        const ci = callee[0] === "[" ? null : uni.get(callee);
        let cat: string;
        if (callee[0] === "[") cat = "array receiver (clone/Object methods)";
        else if (!ci) cat = "unresolved class (not in loaded set)";
        else if (ci.flags & ACC_FINAL) cat = "final class";
        else if (uni.isFinalMethod(callee, key)) cat = "final method";
        else {
          const n = uni.impls(callee, key);
          cat = n === 0 ? "no concrete impl loaded" : n === 1 ? "CHA: exactly 1 impl" : n === 2 ? "CHA: 2 impls" : "CHA: 3+ impls";
          if (n === 1 && !(ci.flags & ACC_INTERFACE) && uni.children(callee).length === 0) cat = "CHA: 1 impl (class has no loaded subclass)";
        }
        bump(tbl, cat);
      }
    }
    if (sites) { C.distinctRefsPerMethod.push(refs.size); C.sitesPerMethod.push(sites); }
  }

  const out: any = JSON.parse(JSON.stringify(S, (k, v) => (k === "sizeBytes" || k === "blocks" || k === "instrsPer" || k === "msDist" || k === "regs" || k === "split" || k === "websPer" || k === "untypedWide" || k === "packed" || k === "sparse" ? undefined : v)));
  out.sizeBytes = dist(S.sizeBytes); out.blocks = dist(S.blocks); out.instrsPer = dist(S.instrsPer);
  out.sizeHist = histogram(S.sizeBytes, [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]);
  out.blocksHist = histogram(S.blocks, [1, 2, 4, 8, 16, 32, 64, 128, 256, 1024]);
  out.switches = { packed: { ...dist(S.switches.packed), hist: histogram(S.switches.packed, [2, 4, 8, 16, 64, 256, 1024]) }, sparse: { ...dist(S.switches.sparse), hist: histogram(S.switches.sparse, [2, 4, 8, 16, 64, 256, 1024]) } };
  out.infer.msDist = dist(S.infer.msDist); out.infer.regs = dist(S.infer.regs); out.infer.split = dist(S.infer.split); out.infer.websPer = dist(S.infer.websPer); out.infer.untypedWide = dist(S.infer.untypedWide);
  out.infer.msPerMB = dexBytes ? S.infer.ms / (dexBytes / 1048576) : 0;
  out.infer.hardest = top(hard, (h) => h.conflicts * 1e6 + h.multi * 1e3 + h.webs, 8);
  out.infer.biggestLocals = top(hard, (h) => h.webs, 5);
  out.infer.slowest = top(hard, (h) => h.ms, 3);
  out.timing = { wallPass1Ms: wall, note: "single process, includes decode+Flow+reducibility+inference; indicative only" };
  out.calls = { ...C, distinctRefsPerMethod: dist(C.distinctRefsPerMethod), sitesPerMethod: dist(C.sitesPerMethod) };
  writeFileSync(`out/${label}.json`, JSON.stringify(out, null, 1));
  console.log(`${label}: ${S.methodsWithCode} methods, ${S.instructions} insns, infer ${S.infer.ms.toFixed(0)}ms, pass1 ${(wall / 1000).toFixed(1)}s`);
}

function histogram(a: number[], edges: number[]): Record<string, number> {
  const h: Record<string, number> = {};
  const names = edges.map((e, i) => `<=${e}`); names.push(`>${edges[edges.length - 1]}`);
  for (const n of names) h[n] = 0;
  for (const v of a) { let k = edges.findIndex((e) => v <= e); if (k < 0) k = edges.length; h[names[k]]++; }
  return h;
}

for (const label of Object.keys(CORPORA)) if (!only || only.includes(label)) await analyze(label);
