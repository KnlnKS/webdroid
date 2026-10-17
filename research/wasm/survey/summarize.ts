// Aggregates out/ast.json. Run: node research/wasm/survey/summarize.ts
import { readFileSync } from "fs";
const j = JSON.parse(readFileSync(import.meta.dirname + "/out/ast.json", "utf8"));
const E = j.entries as any[];
const by = (f: (e: any) => string) => { const m: Record<string, number> = {}; for (const e of E) m[f(e)] = (m[f(e)] ?? 0) + 1; return m; };
console.log("entries by kind", by((e) => e.kind));
console.log("entries by scope", by((e) => e.file.split("/").slice(0, e.file.includes("jvm/natives") ? 3 : 2).join("/")));
console.log("alias/unresolved", by((e) => e.flags.includes("alias") ? "alias" : e.flags.includes("unresolved") ? "unresolved" : "fn"));
console.log("static", E.filter((e) => e.key.startsWith("static ")).length, "<init>", E.filter((e) => /<init>/.test(e.key)).length);
console.log("with Java-typed this", E.filter((e) => e.thisJava).length, "uses this", E.filter((e) => e.usesThis).length);
const fn = E.filter((e) => !e.flags.includes("alias") && !e.flags.includes("unresolved"));
console.log("fn entries", fn.length);
const fl: Record<string, number> = {};
for (const e of fn) for (const f of e.flags) fl[f] = (fl[f] ?? 0) + 1;
console.log("flag counts", fl);
const noFlag = (e: any, ex: string[]) => !e.flags.some((f: string) => ex.includes(f));
console.log("A strict (no F C R I X S A O U)", fn.filter((e) => noFlag(e, ["F","C","R","I","X","S","A","O","U"])).length);
console.log("A possible (no F C R I X S A O; U allowed)", fn.filter((e) => noFlag(e, ["F","C","R","I","X","S","A","O"])).length);
console.log("any of F/X (field-ish)", fn.filter((e) => e.flags.includes("F") || e.flags.includes("X")).length);
console.log("param cat totals", (() => { const m: any = {}; for (const e of fn) for (const p of e.paramCats) m[p] = (m[p] ?? 0) + 1; return m; })());
console.log("unannotated-any params: fns with a U param", fn.filter((e) => e.paramCats.includes("U")).length);
// exclusive primary category by precedence
const prec = ["C", "R", "F", "I", "X", "O", "A", "S", "L"];
const prim = by((e) => e.flags.includes("alias") ? "alias" : e.flags.includes("unresolved") ? "unresolved" : prec.find((p) => e.flags.includes(p)) ?? (e.flags.includes("U") ? "U-only" : "pure-prims"));
console.log("primary category (first hit of C>R>F>I>X>O>A>S>L)", prim);
const reg = j.regCalls as any[];
console.log("regCalls by kind", reg.reduce((m, r) => (m[r.kind] = (m[r.kind] ?? 0) + 1, m), {}), "spreads", reg.reduce((a, r) => a + r.spreads, 0));
// totals of site counters
const tot: Record<string, number> = {}; const ts: Record<string, Record<string, number>> = {};
for (const [f, v] of Object.entries<any>(j.perFile)) for (const [k, n] of Object.entries<number>(v.c)) { tot[k] = (tot[k] ?? 0) + n; (ts[v.scope] ??= {})[k] = (ts[v.scope][k] ?? 0) + n; }
console.log("TOTAL sites", tot);
for (const [s, v] of Object.entries(ts)) console.log("SCOPE", s, JSON.stringify(v));
const locBy: Record<string, number> = {}; for (const v of Object.values<any>(j.perFile)) locBy[v.scope] = (locBy[v.scope] ?? 0) + v.loc;
console.log("LOC by scope", locBy);

// ---- descriptor-driven classification (exact Java types from the registered signature)
console.log("\n== descriptor x body ==");
const D = E.filter((e) => e.kind !== "intrinsic" && e.shape !== "?");
console.log("entries with descriptor", D.length, "of", E.length);
const has = (e: any, c: string) => e.shape.includes(c) || e.dret === c;
const resolved = (e: any) => !e.flags.includes("alias") && !e.flags.includes("unresolved");
const R = D.filter(resolved);
const cnt = (pred: (e: any) => boolean, set = R) => set.filter(pred).length;
console.log("resolved fn w/ descriptor", R.length, "alias/unresolved", D.length - R.length);
console.log("static vs instance", cnt((e) => e.isStatic), cnt((e) => !e.isStatic));
console.log("value kinds in descriptor (any occurrence): long J", cnt((e) => has(e, "J")), "String/CharSeq S", cnt((e) => has(e, "S")), "prim-array T", cnt((e) => has(e, "T")), "object-array A", cnt((e) => has(e, "A")), "other object O", cnt((e) => has(e, "O")));
const noRef = (e: any) => !["S", "T", "A", "O"].some((c) => has(e, c));
console.log("descriptor has NO reference-typed param/ret (prims+long only)", cnt(noRef));
const bodyFlag = (e: any) => ["F", "C", "R", "I", "X"].filter((f) => e.flags.includes(f));
console.log("  ...of which instance (receiver is a Java object)", cnt((e) => noRef(e) && !e.isStatic), "static", cnt((e) => noRef(e) && e.isStatic));
console.log("  ...of which body touches nothing: pure(a)", cnt((e) => noRef(e) && bodyFlag(e).length === 0));
console.log("  ...pure(a) and static", cnt((e) => noRef(e) && bodyFlag(e).length === 0 && e.isStatic), " pure(a) instance", cnt((e) => noRef(e) && bodyFlag(e).length === 0 && !e.isStatic));
console.log("  ...prim-only but body F", cnt((e) => noRef(e) && e.flags.includes("F")), "C", cnt((e) => noRef(e) && e.flags.includes("C")), "R", cnt((e) => noRef(e) && e.flags.includes("R")), "I", cnt((e) => noRef(e) && e.flags.includes("I")));
console.log("has reference value in descriptor", cnt((e) => !noRef(e)));
console.log("  of those body-pure (only marshals value)", cnt((e) => !noRef(e) && bodyFlag(e).length === 0));
console.log("  string-only refs (S, no T/A/O)", cnt((e) => has(e, "S") && !has(e, "T") && !has(e, "A") && !has(e, "O")));
console.log("  with prim array T (no A/O)", cnt((e) => has(e, "T") && !has(e, "A") && !has(e, "O")));
console.log("  with object array A", cnt((e) => has(e, "A")), " with other object O", cnt((e) => has(e, "O")));
console.log("body flags among resolved: F", cnt((e) => e.flags.includes("F")), "C", cnt((e) => e.flags.includes("C")), "R", cnt((e) => e.flags.includes("R")), "I", cnt((e) => e.flags.includes("I")), "X", cnt((e) => e.flags.includes("X")));
console.log("F∩C", cnt((e) => e.flags.includes("F") && e.flags.includes("C")), "any of F,C,R,I,X", cnt((e) => bodyFlag(e).length > 0));
const kindOf = (k: string) => R.filter((e) => e.kind === k);
for (const k of ["spec", "jni"]) { const s = kindOf(k); console.log(k, "resolved", s.length, "pure(a)", cnt((e) => noRef(e) && bodyFlag(e).length === 0, s), "F", cnt((e) => e.flags.includes("F"), s), "C", cnt((e) => e.flags.includes("C"), s), "R", cnt((e) => e.flags.includes("R"), s), "I", cnt((e) => e.flags.includes("I"), s)); }
// per-file entry counts
const perF: Record<string, number> = {}; for (const e of E) perF[e.file] = (perF[e.file] ?? 0) + 1;
console.log("top files by registered entries", Object.entries(perF).sort((a, b) => b[1] - a[1]).slice(0, 12));
