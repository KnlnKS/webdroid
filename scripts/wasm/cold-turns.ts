// Slow operations split numeric fuel slices; ready async native imports must
// still service the canonical host turn deadline. The native adapter implements
// the fixture tick body exactly, with an immediately resolved async result.
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { world } from "./lib";
import { AOSP } from "./paths";
import { shellIn } from "./tools";
import { Natives } from "../../src/wasm/host/natives";
import { nativeSource } from "../../src/wasm/host/nativesource";
import "../../src/natives";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
const dir = mkdtempSync(join(tmpdir(), "cold-turns-")), sh = shellIn(dir);
writeFileSync(join(dir, "ColdTurns.java"), `public class ColdTurns {
 static class Box { int value; }
 static int tick(int n){return n;}
 static native int nativeTick(int n);
 public static int asyncLoop(int n) { Box b=new Box(); for(int i=0;i<n;i++)b.value+=nativeTick(i); return b.value; }
 public static int loop(int n) { Box b=new Box(); for(int i=0;i<n;i++)b.value+=tick(i); return b.value; }
 public static void main(String[] args){System.out.println(loop(1000));}
}`);
sh(["javac", "--release", "11", "-d", dir, join(dir, "ColdTurns.java")]);
sh(["d8", "--release", "--min-api", "34", "--output", dir, ...readdirSync(dir).filter(n => n.endsWith(".class")).map(n => join(dir, n))]);
const expected = sh(["java", "-cp", dir, "ColdTurns"]).trim();
for (const cold of [false, true]) {
  let turns = 0, nativeCalls = 0;
  const nativeTick = async (n: number) => { nativeCalls++; return n; };
  const w = world([join(dir, "classes.dex"), ...PLATFORM_JARS.slice(0, 2).map(j => join(AOSP, j))], {
    cold, natives: new Natives({ ...nativeSource, find: (cls, key, isStatic, hasBody) => cls === "ColdTurns" && key === "nativeTick(I)I" ? nativeTick : nativeSource.find(cls, key, isStatic, hasBody) }), holdUpgrades: () => true,
    loop: { due: () => true, yield: async () => { turns++; }, after: (ms, f) => { const id = setTimeout(f, ms); return () => clearTimeout(id); } },
  });
  const value = await w.entryAsync("ColdTurns", "asyncLoop", "(I)I")(1000);
  if (String(value) !== expected) throw new Error(`loop ${value} != JDK ${expected}`);
  if (nativeCalls !== 1000) throw new Error(`async native fixture bypassed: ${nativeCalls}`);
  const before = turns, plain = w.entry("ColdTurns", "loop", "(I)I")(100);
  if (plain instanceof Promise || plain !== 4950 || turns !== before) throw new Error("plain Java entry unexpectedly yielded");
  if (cold && (!w.stats.coldSlowCalls || !turns)) throw new Error(`cold slow-operation loop starved turns: slow ${w.stats.coldSlowCalls}, turns ${turns}`);
  console.log(cold ? "cold" : "compiled", value, "turns", turns, "slow operations", w.stats.coldSlowCalls);
}
console.log("cold turns: compiled/cold async native loop matches JDK arithmetic; slow operations preserve canonical turn requests");
