// invoke-custom and MethodHandle call sites: records (ObjectMethods.bootstrap) compiled by javac 17+ and kept as invoke-custom by d8 --no-desugaring, and
// MethodHandle.invoke/invokeExact over each kind of direct handle, run as Wasm, on the production JS tier and on the JDK; the results must match. Needs javac (17+), d8 and java. Run: bun customdiff.ts
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../../src/jvm/provenance";
import { world } from "./build";
import { jsTier, natives, processState } from "./oracle";
import { loadDexes } from "./build";
import { ACC } from "./program";
import { compare, genCases } from "./cases";
import { underNode } from "./undernode";

await underNode(import.meta.path);
const here = import.meta.dir, out = mkdtempSync(join(tmpdir(), "j2w-cu-"));
const sh = (cmd: string[], input?: string) => {
  const r = Bun.spawnSync(cmd, { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), cwd: out });
  if (r.exitCode) throw new Error(`${cmd[0]} failed: ${r.stderr}`);
  return r.stdout.toString();
};
sh(["javac", "--release", "17", "-d", out, join(here, "java/Rec.java"), join(here, "java/Mh.java"), join(here, "java/Ind.java"), join(here, "java/Ref.java")]);
sh(["d8", "--release", "--no-desugaring", "--min-api", "34", "--output", out, ...readdirSync(out).filter((f) => /^(Rec|Mh|Ind)(\$.*)?\.class$/.test(f)).map((f) => join(out, f))]);
const dex = join(out, "classes.dex"), jars = [...PLATFORM_JARS.slice(0, 2), "boot/core-icu4j.jar"].map((j) => join(here, "../../../vendor/aosp", j));
await jsTier(loadDexes(dex));
const w = world([dex, ...jars], { natives }), hit: string[] = [];
processState(w);
w.onGap = (id) => hit.push(w.gapList[id]);
const methods = ["Rec", "Mh"].flatMap((c) => w.prog.require(c).methods.filter((m) => m.isStatic && m.codeOff && m.flags & ACC.PUBLIC && m.name !== "tBind"));
const mh = [0, 1, 2, 3, 7, 12], small: Record<string, number[]> = {
  ...Object.fromEntries(methods.filter((m) => m.cls === "Mh").map((m) => [m.name, mh])), empty: [0], eqNaN: [0, 1, 2], eqOther: [0, 1, 2, 3, 4], nullRecv: [0, 1, 7], ts: [0, 1, 2, 3, 4, 5, 6, 7, 30], hc: [0, 1, 2, 3, 7, 12, 40], nested: [0, 3, 4] };
const cases = [...genCases(methods.filter((m) => m.name !== "eq"), small), ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap((d) => [0, 1, 2, 3, 4, 9].map((a) => ({ m: methods.find((m) => m.name === "eq")!, args: [BigInt(a), BigInt(d)] })))];
const entries = new Map(methods.map((m) => [m, w.entry(m.cls, m.name, m.desc)]));
const jdk = sh(["java", "-cp", out, "Ref"], cases.map((c) => `${c.m.cls}.${c.m.name} ${c.args.join(" ")}`).join("\n") + "\n").trim().split("\n");
const tier = await jsTier(loadDexes(dex));
// the production tier has its own MethodHandle model (jinvoke.ts) and no Class.isRecord: the JDK alone decides those cases
const asJdk = (cls: string, name: string, _d: string, args: unknown[]) => {
  const i = cases.findIndex((c) => c.m.cls === cls && c.m.name === name && c.args.every((a, j) => a === args[j] || Number(a) === Number(args[j])));
  return jdk[i] === "throw" ? Promise.reject(new Error("throw")) : Promise.resolve(entries.get(cases[i].m)!.length === 0 || cases[i].m.ret === "J" ? BigInt(jdk[i]) : Number(jdk[i]));
};
const { bad, blocked, threw } = await compare(cases, (m) => entries.get(m)!, (cls, name, desc, args, inst) => (cls === "Mh" || name === "recordInfo" ? asJdk(cls, name, desc, args) : tier(cls, name, desc, args, inst)), jdk, hit);
console.log(`${cases.length - blocked - bad}/${cases.length - blocked} cases match (wasm, js tier, jdk); ${threw} threw`);
if (blocked) console.log(`${blocked} cases blocked by a compiler gap: ${[...new Set(hit)].join("; ")}`);
// a bootstrap class libcore lacks is ART's NoClassDefFoundError at the site; LambdaMetafactory exists but returns null, which is a gap
const outcome = (name: string) => { try { w.entry("Ind", name, "(I)I")(3); return "returned"; } catch (e) { const t = w.throwable(e); return t ? `${w.classNameOf(t)}: ${w.lastMessage}` : String(e); } };
const concat = outcome("concat"), lambda = outcome("lambda");
if (concat !== "java/lang/NoClassDefFoundError: Failed resolution of: Ljava/lang/invoke/StringConcatFactory;") { console.log(`FAIL concat: ${concat}`); process.exit(1); }
if (!lambda.startsWith("java/lang/UnsatisfiedLinkError")) { console.log(`FAIL lambda: ${lambda}`); process.exit(1); }
// a transformer handle is a recorded gap, not a result
hit.length = 0;
let transformer = true;
try { w.entry("Mh", "tBind", "(I)I")(3); transformer = false; } catch { /* the gap throws */ }
if (!transformer || !hit.some((g) => /transformer handle/.test(g))) { console.log(`FAIL tBind: gap ${hit.join("; ")}`); process.exit(1); }
process.exit(bad || blocked ? 1 : 0);
