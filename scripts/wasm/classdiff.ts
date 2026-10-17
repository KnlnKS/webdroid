// Class-model differential test: the static int(int) methods of java/C.java, compiled lazily over the AOSP boot dex, against the
// JDK. Each method runs once in a fresh World (class initialization state persists).
// Needs javac, d8 and java on PATH. Run: pnpm wasm classdiff [method-name-filter]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { program, world } from "./lib.ts";
import { intrinsics } from "../../src/wasm/link/intrinsics.ts";
import { mountPlatform, natives } from "./harness.ts";
import { JAVA, PLATFORM_PATHS, ROOT } from "./paths.ts";
import { filesIn, onJdk, shellIn } from "./tools.ts";
import { ACC, declaredMethod } from "../../src/wasm/compiler/program.ts";
import { Cha } from "../../src/wasm/compiler/cha.ts";
import { fieldCookie, hostUnsafe, UInfo } from "../../src/wasm/link/unsafe.ts";
import { OP } from "../../src/wasm/compiler/code.ts";
import { T } from "../../src/wasm/compiler/wasmbin.ts";

const out = mkdtempSync(join(tmpdir(), "j2w-c-"));
const sh = shellIn(out);
sh(["javac", "--release", "11", "-Xlint:-options", "-d", out, join(JAVA, "C.java"), join(JAVA, "Ref.java")]);
sh(["d8", "--release", "--min-api", "34", "--output", out, ...filesIn(out, /^C.*\.class$/)]);

await mountPlatform(ROOT);
// System.<clinit> needs strings and the whole properties machinery, which System.arraycopy does not
intrinsics.set("java/lang/System.<clinit>()V", () => {});

// AbstractMethodError: Sub inherits m() from a Base that was recompiled abstract
sh(["mkdir", "-p", "am"]);
sh(["javac", "--release", "8", "-Xlint:-options", "-d", "am", join(JAVA, "am1/Am.java"), join(JAVA, "am1/AmBase.java")]);
sh(["javac", "--release", "8", "-Xlint:-options", "-d", "am", join(JAVA, "am2/AmBase.java")]);
sh(["d8", "--release", "--output", join(out, "am"), ...filesIn(join(out, "am"), /^Am.*\.class$/)]);
const amExpected = sh(["java", "-cp", join(out, "am"), "Am"]).trim();
const dex = join(out, "classes.dex"), jars = PLATFORM_PATHS.slice(0, 2);
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
const cases = methods.map((m) => ({ m, args: [0n] }));
const jdk = onJdk(sh, out, cases.map((c) => `C.${c.m.name} 0`));
let bad = 0;
const hit: number[] = [];
for (const [i, c] of cases.entries()) {
  const w = world(prog, { natives }); w.onGap = (id) => hit.push(id);
  const exp = jdk[i], name = `C.${c.m.name}`;
  const got = async (f: () => unknown) => { try { return String(await f()); } catch (e) { if (process.env.J2W_V) console.log(name, e); return "throw"; } };
  const wasm = await got(() => w.entry(c.m.cls, c.m.name, c.m.desc)(0));
  if (wasm !== exp) { bad++; console.log(`MISMATCH ${name}: jdk=${exp} wasm=${wasm}`); }
  if (hit.length) { console.log(`${name}: gaps hit: ${[...new Set(hit)].map((g) => w.gapList[g]).join("; ")}`); hit.length = 0; }
}
{
  const w = world([join(out, "am/classes.dex"), ...jars]);
  let r: string;
  try { r = String(w.entry("Am", "run", "(I)I")(0)); } catch (e) { const t = w.throwable(e); r = t ? "java " + w.classNameOf(t) : String(e); }
  if (r !== amExpected) { bad++; console.log(`MISMATCH Am.run: jvm=${amExpected} wasm=${r}`); }
}
console.log(`${cases.length - bad}/${cases.length} cases match the JDK`);
process.exit(bad ? 1 : 0);
