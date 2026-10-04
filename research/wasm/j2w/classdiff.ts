// Class-model differential test: the static int(int) methods of java/C.java, compiled lazily over the AOSP boot dex, against the
// production JS tier and the JDK. Each method runs once (class initialization state persists in every tier).
// Needs javac, d8 and java on PATH. Run: bun classdiff.ts [method-name-filter]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../../src/jvm/provenance";
import { OP } from "./code";
import { loadDexes, program, world } from "./build";
import { intrinsics } from "./intrinsics";
import { jsTier, natives } from "./oracle";

const here = import.meta.dir, out = mkdtempSync(join(tmpdir(), "j2w-c-"));
const sh = (cmd: string[], input?: string) => {
  const r = Bun.spawnSync(cmd, { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), cwd: out });
  if (r.exitCode) throw new Error(`${cmd[0]} failed: ${r.stderr}`);
  return r.stdout.toString();
};
sh(["javac", "--release", "11", "-Xlint:-options", "-d", out, join(here, "java/C.java"), join(here, "java/Ref.java")]);
sh(["d8", "--release", "--min-api", "34", "--output", out, ...new Bun.Glob("C*.class").scanSync(out).toArray().map((f) => join(out, f))]);

// Handles the way Lookup.findVarHandle makes them (which needs strings): a FieldVarHandle whose artField is the id of one of
// C$S's fields, chosen by ordinal in the order of C.fh's name list, and an ArrayElementVarHandle
intrinsics.set("C.fh(I)Ljava/lang/invoke/VarHandle;", (cx, m, c) => {
  const FV = "java/lang/invoke/FieldVarHandle", st = cx.structFor(FV), o = c.newLocal(cx.vtOf("L"));
  const S = cx.prog.get("C$S")!, ids = ["i", "l", "o", "j"].map((n) => cx.idOf("C$S") << 12 | S.fields.findIndex((f) => f.name === n));
  cx.emitNew(c, FV); c.lset(o);
  c.lget(o).refCast(st).i32(ids[0]);
  ids.forEach((id, k) => { if (k) c.i32(id).lget(0).i32(k).raw(OP.i32_ne).select(); });
  c.raw(OP.i64_extend_i32_u).structSet(st, cx.fieldIndex(FV, { owner: FV, name: "artField", desc: "J" })).lget(o);
});
intrinsics.set("C.av(I)Ljava/lang/invoke/VarHandle;", (cx, m, c) => { cx.emitNew(c, "java/lang/invoke/ArrayElementVarHandle"); });
// System.<clinit> needs strings and the whole properties machinery, which System.arraycopy does not
intrinsics.set("java/lang/System.<clinit>()V", () => {});

// AbstractMethodError: Sub inherits m() from a Base that was recompiled abstract
sh(["mkdir", "-p", "am"]);
sh(["javac", "--release", "8", "-Xlint:-options", "-d", "am", join(here, "java/am1/Am.java"), join(here, "java/am1/AmBase.java")]);
sh(["javac", "--release", "8", "-Xlint:-options", "-d", "am", join(here, "java/am2/AmBase.java")]);
sh(["d8", "--release", "--output", join(out, "am"), ...new Bun.Glob("Am*.class").scanSync(join(out, "am")).toArray().map((f) => join(out, "am", f))]);
const amExpected = sh(["java", "-cp", join(out, "am"), "Am"]).trim();
const dex = join(out, "classes.dex"), jars = PLATFORM_JARS.slice(0, 2).map((j) => join(here, "../../../vendor/aosp", j));
const prog = program([dex, ...jars]), only = process.argv[2];
const methods = prog.require("C").methods.filter((m) => m.isStatic && /^\(I\)[IJ]$/.test(m.desc) && (!only || m.name.includes(only)));
const js = await jsTier(loadDexes(dex));
const cases = methods.map((m) => ({ m, args: [0n] }));
const jdk = sh(["java", "-cp", out, "Ref"], cases.map((c) => `C.${c.m.name} 0`).join("\n") + "\n").trim().split("\n");
// Methods named jsWrong_* pin behaviour the JS tier gets wrong: Wasm must match the JDK there, and the JS tier is expected to differ.
let bad = 0, pinned = 0;
const hit: number[] = [];
for (const [i, c] of cases.entries()) {
  const w = world(prog, { natives }); w.onGap = (id) => hit.push(id);
  const exp = jdk[i], name = `C.${c.m.name}`, wrong = c.m.name.startsWith("jsWrong_");
  const got = async (f: () => unknown) => { try { return String(await f()); } catch (e) { if (process.env.J2W_V) console.log(name, e); return "throw"; } };
  const wasm = await got(() => w.entry(c.m.cls, c.m.name, c.m.desc)(0)), tier = await got(() => js(c.m.cls, c.m.name, c.m.desc, [0]));
  if (wasm !== exp) { bad++; console.log(`MISMATCH wasm/jdk ${name}: jdk=${exp} wasm=${wasm}`); }
  if (wrong) { pinned++; if (tier === exp) console.log(`${name}: the JS tier now agrees; drop the jsWrong_ prefix`); }
  else if (tier !== wasm) { bad++; console.log(`MISMATCH wasm/js ${name}: js=${tier} wasm=${wasm}`); }
  if (hit.length) { console.log(`${name}: gaps hit: ${[...new Set(hit)].map((g) => w.gapList[g]).join("; ")}`); hit.length = 0; }
}
{
  const w = world([join(out, "am/classes.dex"), ...jars]);
  let r: string;
  try { r = String(w.entry("Am", "run", "(I)I")(0)); } catch (e) { const t = w.throwable(e); r = t ? "java " + w.classNameOf(t) : String(e); }
  if (r !== amExpected) { bad++; console.log(`MISMATCH Am.run: jvm=${amExpected} wasm=${r}`); }
}
console.log(`${cases.length - bad}/${cases.length} cases ok (wasm = jdk everywhere, wasm = js tier except ${pinned} pinned js-tier divergences)`);
process.exit(bad ? 1 : 0);
