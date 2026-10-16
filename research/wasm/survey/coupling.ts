// Per-file Java-object coupling ranking + boundary (zero-coupling) files. Run after ast-survey.ts.
import { readFileSync } from "fs";
const j = JSON.parse(readFileSync(import.meta.dirname + "/out/ast.json", "utf8"));
const E = j.entries as any[];
const g = (c: any, ...ks: string[]) => ks.reduce((a, k) => a + (c[k] ?? 0), 0);
const rows = Object.entries<any>(j.perFile).map(([f, v]) => {
  const c = v.c;
  const fields = g(c, "fieldSelfR", "fieldSelfW", "fieldOtherR", "fieldOtherW", "dollarProp", "dynNameAccessR", "dynNameAccessW", "declaredFieldHelper", "anyAccessR", "anyAccessW");
  const calls = g(c, "call_vcall", "call_vcallOn", "call_scall", "call_newObj", "call_callOn", "call_staticField", "call_linkInit");
  const ident = g(c, "instanceofJava", "identityJavaTyped", "dotI", "dotConstructor", "protoOps");
  const retain = g(c, "retainerJavaTyped_Map", "retainerJavaTyped_WeakMap", "retainerJavaTyped_Set", "retainerJavaTyped_WeakSet", "retainerJavaTyped_WeakRef", "new_FinalizationRegistry");
  const arrs = g(c, "jarray", "dotT", "csText");
  const handles = g(c, "handleOp", "deref");
  const gens = g(c, "yieldStar", "driven");
  const reg = E.filter((e) => e.file === f).length;
  const score = fields + calls + ident + retain + arrs;
  return { f, loc: v.loc, scope: v.scope, fields, calls, ident, retain, arrs, handles, gens, reg, score };
});
rows.sort((a, b) => b.score - a.score);
console.log("TOP 25 by coupling score = fieldish+calls+identity+javaRetain+arrays");
for (const r of rows.slice(0, 25)) console.log(r.score.toString().padStart(5), r.f.padEnd(40), `loc=${r.loc} fld=${r.fields} call=${r.calls} id=${r.ident} ret=${r.retain} arr=${r.arrs} hnd=${r.handles} gen=${r.gens} reg=${r.reg}`);
const top15 = rows.slice(0, 15), totScore = rows.reduce((a, r) => a + r.score, 0);
console.log("top15 share of total score", top15.reduce((a, r) => a + r.score, 0), "/", totScore);
console.log("files", rows.length, "with score 0:", rows.filter((r) => r.score === 0).length, "loc", rows.filter((r) => r.score === 0).reduce((a, r) => a + r.loc, 0));
const low = rows.filter((r) => r.score <= 3);
console.log("files score<=3:", low.length, "loc", low.reduce((a, r) => a + r.loc, 0), "of total loc", rows.reduce((a, r) => a + r.loc, 0));
const sc: Record<string, { n: number; loc: number; zero: number; zloc: number; low: number; lowloc: number }> = {};
for (const r of rows) { const s = (sc[r.scope] ??= { n: 0, loc: 0, zero: 0, zloc: 0, low: 0, lowloc: 0 }); s.n++; s.loc += r.loc; if (r.score === 0) { s.zero++; s.zloc += r.loc; } if (r.score <= 3) { s.low++; s.lowloc += r.loc; } }
console.log(sc);
console.log("ZERO-score files >=300 loc:", rows.filter((r) => r.score === 0 && r.loc >= 300).map((r) => `${r.f}(${r.loc})`).join(" "));
console.log("score<=3 files with registered natives but >=300 loc:", low.filter((r) => r.reg > 0 && r.loc >= 300).map((r) => `${r.f}(${r.loc},reg=${r.reg})`).join(" "));
