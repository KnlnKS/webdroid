// Class-model differential test: the static int(int) methods of java/C.java, compiled lazily over the AOSP boot dex, against the
// production JS tier and the JDK. Each method runs once (class initialization state persists in every tier).
// Needs javac, d8 and java on PATH. Run: bun run wasm classdiff [method-name-filter]
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { loadDexes, program, world } from "./lib";
import { intrinsics } from "../../src/wasm/link/intrinsics";
import { jsTier, natives } from "./oracle";
import { AOSP, JAVA } from "./paths";
import { shellIn } from "./tools";
import { ACC, declaredMethod } from "../../src/wasm/compiler/program";
import { Cha } from "../../src/wasm/compiler/cha";
import { fieldCookie, hostUnsafe, UInfo } from "../../src/wasm/link/unsafe";
import { OP } from "../../src/wasm/compiler/code";
import { T } from "../../src/wasm/compiler/wasmbin";

const out = mkdtempSync(join(tmpdir(), "j2w-c-"));
const sh = shellIn(out);
sh(["javac", "--release", "11", "-Xlint:-options", "-d", out, join(JAVA, "C.java"), join(JAVA, "Ref.java")]);
sh(["d8", "--release", "--min-api", "34", "--output", out, ...readdirSync(out).filter((f) => /^C.*\.class$/.test(f)).map((f) => join(out, f))]);

// System.<clinit> needs strings and the whole properties machinery, which System.arraycopy does not
intrinsics.set("java/lang/System.<clinit>()V", () => {});

// AbstractMethodError: Sub inherits m() from a Base that was recompiled abstract
sh(["mkdir", "-p", "am"]);
sh(["javac", "--release", "8", "-Xlint:-options", "-d", "am", join(JAVA, "am1/Am.java"), join(JAVA, "am1/AmBase.java")]);
sh(["javac", "--release", "8", "-Xlint:-options", "-d", "am", join(JAVA, "am2/AmBase.java")]);
sh(["d8", "--release", "--output", join(out, "am"), ...readdirSync(join(out, "am")).filter((f) => /^Am.*\.class$/.test(f)).map((f) => join(out, "am", f))]);
const amExpected = sh(["java", "-cp", join(out, "am"), "Am"]).trim();
const dex = join(out, "classes.dex"), jars = PLATFORM_JARS.slice(0, 2).map((j) => join(AOSP, j));
const prog = program([dex, ...jars]), only = process.argv[2];
const resolved = prog.resolve("C", "classIdent", "(I)I")!;
if (resolved !== prog.resolve("C", "classIdent", "(I)I") || resolved !== prog.require("C").methods[resolved.index]) throw new Error("method identity changed when class members were materialized");
const registered = { ...resolved, cls: "RegisteredMethod", name: "registered", key: "registered(I)I", flags: ACC.PUBLIC | ACC.NATIVE, isStatic: false, dex: null!, codeOff: 0 };
const synthetic = { name: registered.cls, dex: null, def: null, sup: "C", flags: ACC.PUBLIC, isInterface: false, ifaces: [], methods: [registered], fields: [], byKey: new Map([[resolved.key, resolved]]) };
const cha = new Cha(prog);
if (cha.targets("java/lang/Object", registered.name, registered.desc).length) throw new Error("runtime declaration exists before registration");
prog.addClass(synthetic); cha.index([synthetic.name]);
if (declaredMethod(synthetic, registered.key) !== registered || synthetic.byKey.get(resolved.key) !== resolved) throw new Error("runtime class lost declared methods or inherited aliases");
if (cha.targets("java/lang/Object", registered.name, registered.desc)[0] !== registered) throw new Error("large hierarchy lost runtime declaration");
{
  const w = world(prog, { natives }), cls = "C$K", fields = prog.require(cls).fields, id = w.idOf(cls);
  fieldCookie(w, id << 12 | fields.findIndex(f => f.name === "b"));
  const offset = fieldCookie(w, id << 12 | fields.findIndex(f => f.name === "a"));
  if (offset % 8 || hostUnsafe(w, UInfo.ObjGet, offset + 1, 0)) throw new Error("Unsafe field cookies overlap aligned words");
  const slot = w.synthSlot("aligned-field-byte", { params: [], ret: "I", body: (cx, c) => {
    const st = cx.structFor(cls), object = c.newLocal(T.anyref);
    cx.emitEnsure(c, cls); cx.emitNew(c, cls); c.lset(object);
    c.lget(object).refCast(st).i32(0x1083).structSet(st, cx.fieldIndex(cls, fields.find(f => f.name === "a")!));
    c.anyNull().lget(object).i64(BigInt(offset)).i64(-4n).raw(OP.i64_and);
    cx.callMethod(c, prog.resolve("sun/misc/Unsafe", "getInt", "(Ljava/lang/Object;J)I")!);
    c.i32((offset & 3) * 8).raw(OP.i32_shr_u).i32(255).raw(OP.i32_and);
  } });
  if (w.table.get(slot)!() !== 0x83) throw new Error("Unsafe aligned byte read selected another field");
}
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
