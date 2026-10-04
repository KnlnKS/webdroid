// Renders out/*.json into markdown tables: bun tables.ts > out/tables.md
import { readFileSync } from "node:fs";
const L = ["framework", "core-oj", "core-libart", "boot-other", "mihon", "fitnotes", "harmonic", "newpipe", "komikku"];
const D: Record<string, any> = Object.fromEntries(L.map((l) => [l, JSON.parse(readFileSync(`out/${l}.json`, "utf8"))]));
const f = (x: number, d = 1) => x.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const n = (x: number) => Math.round(x).toLocaleString("en-US");
const pct = (a: number, b: number, d = 1) => (b ? f((100 * a) / b, d) + "%" : "-");
const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(" | ")} |`, `|${head.map((_, i) => (i ? "---:" : "---")).join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const cols = (fn: (d: any) => string | number) => L.map((l) => fn(D[l]));
const row = (name: string, fn: (d: any) => string | number) => [name, ...cols(fn)];
const H = ["", ...L];
const out: string[] = [];
const sec = (t: string, body: string) => out.push(`### ${t}\n\n${body}\n`);

sec("T1. Corpus size", table(H, [
  row("dex bytes (MiB)", (d) => f(d.dexBytes / 1048576)),
  row("dex files", (d) => n(d.dexFiles)),
  row("classes", (d) => n(d.classes)),
  row("methods with code", (d) => n(d.methodsWithCode)),
  row("instructions", (d) => n(d.instructions)),
  row("code-unit bytes (2 x units)", (d) => n(d.codeUnits * 2)),
  row("mean instr / method", (d) => f(d.instructions / d.methodsWithCode)),
  row("methods with <=4 instructions", (d) => pct(d.shape["tiny (<=4 instructions)"], d.methodsWithCode)),
]));

const GROUPS: Record<string, (k: string) => boolean> = {
  "move / move-wide / move-object": (k) => k === "move" || k === "move-wide" || k === "move-object",
  "move-result / move-exception": (k) => k === "move-result" || k === "move-exception",
  "const (32-bit)": (k) => k === "const32",
  "const-wide": (k) => k === "const-wide",
  "const-string / const-class": (k) => k === "const-string" || k === "const-class",
  "arith int (incl. lit, neg/not)": (k) => k === "arith-int" || k === "divrem-int",
  "  of which div/rem int": (k) => k === "divrem-int",
  "arith long": (k) => k === "arith-long" || k === "divrem-long",
  "  of which div/rem long": (k) => k === "divrem-long",
  "arith float (+rem)": (k) => k === "arith-float" || k === "rem-float",
  "arith double (+rem)": (k) => k === "arith-double" || k === "rem-double",
  "conversions": (k) => k.startsWith("conv"),
  "cmp-long/float/double": (k) => k.startsWith("cmp"),
  "iget (all widths)": (k) => k.startsWith("iget"), "  iget-obj": (k) => k === "iget-obj", "  iget-wide": (k) => k === "iget-wide", "  iget 8/16/32": (k) => /^iget-(8|16|32)$/.test(k),
  "iput (all widths)": (k) => k.startsWith("iput"), "  iput-obj": (k) => k === "iput-obj", "  iput-wide": (k) => k === "iput-wide", "  iput 8/16/32": (k) => /^iput-(8|16|32)$/.test(k),
  "sget (all)": (k) => k.startsWith("sget"), "sput (all)": (k) => k.startsWith("sput"),
  "aget (all)": (k) => k.startsWith("aget"), "  aget-obj": (k) => k === "aget-obj", "  aget-wide": (k) => k === "aget-wide", "  aget 8/16/32": (k) => /^aget-(8|16|32)$/.test(k),
  "aput (all)": (k) => k.startsWith("aput"), "  aput-obj": (k) => k === "aput-obj", "  aput-wide": (k) => k === "aput-wide", "  aput 8/16/32": (k) => /^aput-(8|16|32)$/.test(k),
  "array-length": (k) => k === "array-length",
  "invoke-virtual": (k) => k === "invoke-virtual", "invoke-interface": (k) => k === "invoke-interface", "invoke-direct": (k) => k === "invoke-direct",
  "invoke-static": (k) => k === "invoke-static", "invoke-super": (k) => k === "invoke-super", "invoke-polymorphic": (k) => k === "invoke-polymorphic", "invoke-custom": (k) => k === "invoke-custom",
  "new-instance": (k) => k === "new-instance", "new-array": (k) => k === "new-array", "filled-new-array": (k) => k === "filled-new-array", "fill-array-data": (k) => k === "fill-array-data",
  "monitor-enter/exit": (k) => k === "monitor", "check-cast": (k) => k === "check-cast", "instance-of": (k) => k === "instance-of",
  "packed-switch": (k) => k === "packed-switch", "sparse-switch": (k) => k === "sparse-switch", "throw": (k) => k === "throw",
  "if-test (2 regs)": (k) => k === "if", "if-testz": (k) => k === "if-z", "goto": (k) => k === "goto", "return": (k) => k === "return", "nop": (k) => k === "nop",
};
const sumFam = (d: any, g: (k: string) => boolean) => Object.entries(d.family).reduce((s, [k, v]) => s + (g(k) ? (v as number) : 0), 0);
sec("T2. Opcode-family histogram (% of all instructions)", table(H, Object.entries(GROUPS).map(([name, g]) => row(name, (d) => pct(sumFam(d, g), d.instructions, 2)))));
const sumFamM = (d: any, g: (k: string) => boolean) => Object.entries(d.familyMethods).reduce((s, [k, v]) => s + (g(k) ? 1 : 0) * 0 + (g(k) ? (v as number) : 0), 0);
void sumFamM;
sec("T2b. Raw instruction counts for the families the spec names", table(H, [
  "cmp-long", "cmp-float/double", "conv-f2i/l (sat)", "conv-d2i/l (sat)", "divrem-int", "divrem-long", "rem-float", "rem-double", "monitor", "filled-new-array", "fill-array-data", "invoke-polymorphic", "invoke-custom", "quickened",
].map((k) => row(k, (d) => n(d.family[k] ?? 0)))));

const SH = (k: string) => row(k, (d) => pct(d.shape[k] ?? 0, d.methodsWithCode));
sec("T3. Method shape (% of methods with code)", table(H, [
  "leaf(no invoke)", "leaf, no alloc/throw/monitor", "leaf, no alloc/throw/monitor, no object ops (numeric+prim fields/arrays)", "register-only leaf (no invoke/alloc/field/array/object)",
  "tiny (<=4 instructions)", "small leaf (<=8 instructions)", "no try", "has monitor-enter/exit", "ACC_SYNCHRONIZED",
  "uses long/double (op or signature)", "has long/double values (inferred)", "has float/double values (inferred)", "uses float/double ops", "has float constants (inferred const->F)", "int/ref only (no J/F/D values)",
].map(SH)));

sec("T3b. Share of code-unit bytes living in leaf / numeric-only methods", table(H, [
  row("leaf (no invoke)", (d) => pct(d.shape["units:leaf"] ?? 0, d.shape["units:all"])),
  row("numeric-only leaf", (d) => pct(d.shape["units:numeric-leaf"] ?? 0, d.shape["units:all"])),
]));

sec("T4. Try / catch", table(H, [
  row("methods with try", (d) => `${n(d.tries.methodsWithTry)} (${pct(d.tries.methodsWithTry, d.methodsWithCode)})`),
  row("try items", (d) => n(d.tries.tryItems)),
  row("typed catch clauses", (d) => n(d.tries.handlerClauses)),
  row("catch-all handlers", (d) => `${n(d.tries.catchAll)} (${pct(d.tries.catchAll, d.tries.tryItems)} of items)`),
  row("items with typed + catch-all", (d) => n(d.tries.itemsWithBoth)),
  row("max try items / method", (d) => n(d.tries.maxTryItems)),
  row("max typed clauses / item", (d) => n(d.tries.maxHandlersInItem)),
]));
const typedAll: Record<string, number> = {};
for (const l of L) for (const [k, v] of Object.entries(D[l].tries.typed)) typedAll[k] = (typedAll[k] ?? 0) + (v as number);
const totTyped = Object.values(typedAll).reduce((a, b) => a + b, 0);
sec("T4b. Catch-type distribution (all 9 corpora pooled, top 15)", table(["type", "clauses", "share"], Object.entries(typedAll).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => [k, n(v), pct(v, totTyped)])));

sec("T5. Switches", table(H, [
  row("packed-switch count / median / p99 / max size", (d) => `${n(d.switches.packed.n)} / ${d.switches.packed.p50} / ${d.switches.packed.p99} / ${d.switches.packed.max}`),
  row("sparse-switch count / median / p99 / max size", (d) => `${n(d.switches.sparse.n)} / ${d.switches.sparse.p50} / ${d.switches.sparse.p99} / ${d.switches.sparse.max}`),
]));

const I = (fn: (i: any, d: any) => string | number) => (d: any) => fn(d.infer, d);
sec("T6. Type inference outcome", table(H, [
  row("methods analyzed", I((i) => n(i.methods))),
  row("skipped (quickened / too large / no fixpoint)", I((i) => n(Object.values(i.skipped).reduce((a: number, b: any) => a + b, 0)))),
  row("methods with NO merge conflict", I((i) => `${n(i.noConflict)} (${pct(i.noConflict, i.methods, 3)})`)),
  row("methods fully determined (no conflict, no unconstrained web)", I((i) => `${n(i.full)} (${pct(i.full, i.methods, 2)})`)),
  row("true merge conflicts (components)", I((i) => n(i.conflicts))),
  row("live-range webs (used)", I((i) => n(i.webs))),
  row("webs left underdetermined", I((i) => `${n(i.undetermined)} (${pct(i.undetermined, i.webs, 3)})`)),
  row("  of which contain a const-0 def", I((i) => n(i.undetZero))),
  row("vregs (with live webs)", I((i) => n(i.vregs))),
  row("vregs holding >=2 kinds at different points", I((i) => `${n(i.multiKindVregs)} (${pct(i.multiKindVregs, i.vregs)})`)),
  row("  ... only because of const-0 (webs w/ const-0 def ignored => <=1 kind)", I((i) => `${n(i.multiKindOnlyZero)} (${pct(i.multiKindOnlyZero, i.multiKindVregs)} of multi-kind)`)),
  row("methods with >=1 multi-kind vreg", I((i, d) => `${pct(i.withMultiKind, i.methods)}`)),
  row("web kind mix I / F / R / J / D / ?", I((i) => ["I", "F", "R", "J", "D", "?"].map((k) => pct(i.kindWebs[k] ?? 0, i.webs, 1)).join(" / "))),
  row("const-0 webs", I((i) => n(i.zeroConstWebs))),
  row("dead defs (never read)", I((i) => n(i.deadDefs))),
]));
sec("T7. Wasm local counts per method (min = best case, see text)", table(H, [
  row("DEX frame registers: median / p90 / p99 / max", I((i) => `${i.regs.p50} / ${i.regs.p90} / ${i.regs.p99} / ${i.regs.max}`)),
  row("(A) untyped i32 per vreg, wide = 2 slots (= regs): mean", I((i) => f(i.sumRegs / i.methods, 2))),
  row("(B) untyped i32 + one i64 per wide pair: median / p99 / max", I((i) => `${i.untypedWide.p50} / ${i.untypedWide.p99} / ${i.untypedWide.max}`)),
  row("(C) split by kind: one local per (vreg, kind): mean", I((i) => f(i.sumSplit / i.methods, 2))),
  row("(C) median / p90 / p99 / max", I((i) => `${i.split.p50} / ${i.split.p90} / ${i.split.p99} / ${i.split.max}`)),
  row("(D) one local per live-range web: mean", I((i) => f(i.sumWebs / i.methods, 2))),
  row("(D) median / p90 / p99 / max", I((i) => `${i.websPer.p50} / ${i.websPer.p90} / ${i.websPer.p99} / ${i.websPer.max}`)),
  row("C / A ratio (total)", I((i) => f(i.sumSplit / i.sumRegs, 3))),
  row("methods where (C) > frame regs", I((i) => pct(i.splitOverRegs, i.methods))),
]));
sec("T8. Inference cost (single process, indicative only)", table(H, [
  row("inference ms total", I((i) => f(i.ms, 0))),
  row("us / method (mean)", I((i) => f((i.ms * 1000) / i.methods, 1))),
  row("method p50 / p99 / max (us)", I((i) => `${f(i.msDist.p50 * 1000, 1)} / ${f(i.msDist.p99 * 1000, 0)} / ${f(i.msDist.max * 1000, 0)}`)),
  row("ms per MiB of dex", I((i) => f(i.msPerMB, 0))),
]));
const hard: string[] = [];
for (const l of L) { for (const h of D[l].infer.hardest.slice(0, 2)) hard.push(`| ${l} | \`${h.name}\` | ${h.units} | ${h.regs} | ${h.webs} | ${h.split} | ${h.multi} |`); }
sec("T9. Hardest methods (most multi-kind vregs, then most webs), 2 per corpus", ["| corpus | method | code units | regs | webs | split locals | multi-kind vregs |", "|---|---|---:|---:|---:|---:|---:|", ...hard].join("\n"));
const biggest: string[] = [];
for (const l of L) { const h = D[l].infer.biggestLocals[0]; biggest.push(`| ${l} | \`${h.name}\` | ${h.units} | ${h.regs} | ${h.webs} | ${h.split} |`); }
sec("T9b. Method with the most webs per corpus", ["| corpus | method | code units | regs | webs | split locals |", "|---|---|---:|---:|---:|---:|", ...biggest].join("\n"));

sec("T10. Method size (bytes of code units)", table(H, [
  row("median / p90 / p99 / max bytes", (d) => `${d.sizeBytes.p50} / ${d.sizeBytes.p90} / ${d.sizeBytes.p99} / ${n(d.sizeBytes.max)}`),
  row("methods > 1 KiB", (d) => `${n(d.big.gt1k)} (${pct(d.big.gt1k, d.methodsWithCode, 2)})`),
  row("methods > 8 KiB", (d) => `${n(d.big.gt8k)} (${pct(d.big.gt8k, d.methodsWithCode, 3)})`),
  row("methods > 64 KiB", (d) => n(d.big.gt64k)),
  row("blocks / method: median / p99 / max", (d) => `${d.blocks.p50} / ${d.blocks.p99} / ${d.blocks.max}`),
  row("largest method", (d) => `${n(d.big.maxBytes)} B`),
]));
const hist = (key: string) => {
  const keys = Object.keys(D.framework[key]);
  return table(["bytes", ...L], keys.map((k) => [k, ...L.map((l) => pct(D[l][key][k], D[l].methodsWithCode, 2))]));
};
sec("T10b. Method-size histogram (% of methods)", hist("sizeHist"));
sec("T10c. Largest methods", ["| corpus | method | bytes |", "|---|---|---:|", ...L.map((l) => `| ${l} | \`${D[l].big.maxMethod}\` | ${n(D[l].big.maxBytes)} |`)].join("\n"));

sec("T11. Control flow: reducibility and the repo's structurer (src/jvm/structure.ts) over ALL methods", table(H, [
  row("methods with a CFG", (d) => n(d.cfg.methods)),
  row("irreducible, handlers as extra roots (mode A)", (d) => `${n(d.cfg.irreducibleA)} (${pct(d.cfg.irreducibleA, d.cfg.methods, 3)})`),
  row("irreducible, precise exception edges (mode B)", (d) => `${n(d.cfg.irreducibleB)} (${pct(d.cfg.irreducibleB, d.cfg.methods, 3)})`),
  row("Flow tried (methods with >1 block or a try)", (d) => n(d.cfg.flowOk + Object.values(d.cfg.flowFail).reduce((a: number, b: any) => a + b, 0))),
  row("Flow structured OK", (d) => n(d.cfg.flowOk)),
  row("Flow fell back: irreducible", (d) => n(d.cfg.flowFail["irreducible"] ?? 0)),
  row("Flow fell back: too deep", (d) => n(d.cfg.flowFail["too deep"] ?? 0)),
  row("Flow fell back: other", (d) => n(Object.entries(d.cfg.flowFail).filter(([k]) => k !== "irreducible" && k !== "too deep").reduce((a, [, v]) => a + (v as number), 0))),
  row("fallback rate among Flow-tried", (d) => { const t = d.cfg.flowOk + Object.values(d.cfg.flowFail).reduce((a: number, b: any) => a + b, 0); return pct(t - d.cfg.flowOk, t, 3); }),
  row("Flow OK with >1 region (needs pc dispatch between regions)", (d) => `${n(d.cfg.flowMultiRegion)} (${pct(d.cfg.flowMultiRegion, d.cfg.flowOk)})`),
]));
sec("T11b. Irreducible examples (mode B)", L.map((l) => `- ${l}: ${D[l].cfg.irreducibleBNames.slice(0, 3).map((x: string) => "`" + x + "`").join(", ") || "(none)"}`).join("\n"));

const C = (fn: (c: any, d: any) => string | number) => (d: any) => fn(d.calls, d);
sec("T12. Invoke sites", table(H, [
  row("invoke sites", C((c) => n(c.sites))),
  row("sites / method with code (mean)", C((c, d) => f(c.sites / d.methodsWithCode, 2))),
  row("distinct method refs per invoking method: median / p90 / max", C((c) => `${c.distinctRefsPerMethod.p50} / ${c.distinctRefsPerMethod.p90} / ${c.distinctRefsPerMethod.max}`)),
  ...["invoke-static", "invoke-direct", "invoke-virtual", "invoke-interface", "invoke-super"].map((k) => row(k, C((c) => pct(c.byKind[k] ?? 0, c.sites)))),
  row("polymorphic + custom", C((c) => pct((c.byKind["invoke-polymorphic"] ?? 0) + (c.byKind["invoke-custom"] ?? 0), c.sites, 3))),
  row("callee class == caller class", C((c) => pct(c.sameClass, c.sites))),
  row("callee in same package", C((c) => pct(c.samePackage, c.sites))),
  row("callee defined in this corpus", C((c) => pct(c.calleeInCorpus, c.sites))),
  row("callee in platform (framework/boot) but not this corpus", C((c) => pct(c.calleeInPlatform, c.sites))),
  row("callee class not in any loaded set", C((c) => pct(c.calleeOther, c.sites))),
  row("callee: java/javax", C((c) => pct(c.calleeNamespaces["java/javax"] ?? 0, c.sites))),
  row("callee: android", C((c) => pct(c.calleeNamespaces["android"] ?? 0, c.sites))),
  row("callee: kotlin", C((c) => pct(c.calleeNamespaces["kotlin"] ?? 0, c.sites))),
  row("callee: androidx", C((c) => pct(c.calleeNamespaces["androidx"] ?? 0, c.sites))),
  row("direct/static callee known with code in corpus", C((c) => n(c.directTargetKnown))),
  row("  ... that is a leaf (no invoke)", C((c) => pct(c.directTargetLeaf, c.directTargetKnown))),
  row("  ... <= 16 code units (32 B)", C((c) => pct(c.directTargetSmall, c.directTargetKnown))),
]));
const cats = ["final class", "final method", "CHA: 1 impl (class has no loaded subclass)", "CHA: exactly 1 impl", "CHA: 2 impls", "CHA: 3+ impls", "no concrete impl loaded", "array receiver (clone/Object methods)", "unresolved class (not in loaded set)"];
const tot = (d: any, k: string) => cats.reduce((s, c) => s + (d.calls[k][c] ?? 0), 0);
sec("T13. invoke-virtual receivers: static type from the method ref + CHA (% of invoke-virtual sites)", table(H, [...cats.map((c) => row(c, (d) => pct(d.calls.chaVirtual[c] ?? 0, tot(d, "chaVirtual")))), row("monomorphic-by-CHA total (final class + final method + 1 impl)", (d) => pct((d.calls.chaVirtual["final class"] ?? 0) + (d.calls.chaVirtual["final method"] ?? 0) + (d.calls.chaVirtual["CHA: 1 impl (class has no loaded subclass)"] ?? 0) + (d.calls.chaVirtual["CHA: exactly 1 impl"] ?? 0), tot(d, "chaVirtual")))]));
sec("T14. invoke-interface receivers + CHA (% of invoke-interface sites)", table(H, [...cats.slice(3).map((c) => row(c, (d) => pct(d.calls.chaInterface[c] ?? 0, tot(d, "chaInterface")))), row("sites", (d) => n(tot(d, "chaInterface")))]));

// Appendix: all families
const fams = [...new Set(L.flatMap((l) => Object.keys(D[l].family)))].sort((a, b) => D.framework.family[b] - D.framework.family[a]);
out.push("### A1. All opcode families (% of instructions)\n\n" + table(H, fams.map((k) => row(k, (d) => pct(d.family[k] ?? 0, d.instructions, 3)))) + "\n");
console.log(out.join("\n"));
