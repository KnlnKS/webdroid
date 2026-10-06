// Actual platform bytecode: Java static graph and NativeAllocationRegistry own a RenderNode.
import "../../tests/platform";
import "../../src/natives";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellIn, dexAndroid } from "./tools";
import { world } from "./lib";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { Natives } from "../../src/wasm/host/natives";
import { nativeSource } from "../../src/wasm/host/nativesource";
import { deref } from "../../src/android/handles";
import { hostThrowable, wasmEntry, fieldNamesOf } from "../../src/wasm/host/entry";
import { rt, fieldNames } from "../../src/jvm/runtime";
import { useEntry } from "../../src/jvm/natives/jentry";

const dir = mkdtempSync(join(tmpdir(), "nar-static-"));
writeFileSync(join(dir, "NARGC.java"), `import android.graphics.RenderNode;
public class NARGC {
  static class Holder { RenderNode node; }
  static Holder owner;
  static Object pin;
  public static void setup() {
    owner = new Holder(); owner.node = new RenderNode("gc-owner");
    owner.node.setPosition(0, 0, 10, 10);
  }
  public static int check() { return owner.node.hasIdentityMatrix() ? 1 : 0; }
  public static void clear() { owner = null; }
  public static void pin(long h) throws Exception {
    Class<?> c = Class.forName("com.android.internal.util.VirtualRefBasePtr");
    pin = c.getDeclaredConstructor(long.class).newInstance(h);
  }
  public static void unpin() throws Exception {
    pin.getClass().getDeclaredMethod("release").invoke(pin); pin = null;
  }
}`);
dexAndroid(shellIn(dir), dir, [join(dir, "NARGC.java")]);
let ptr = 0n, hostRegistrations = 0;
const releases: bigint[] = [];
const source = { ...nativeSource, find: (cls: string, key: string, s: boolean, b: boolean) => {
  const fn = nativeSource.find(cls, key, s, b);
  if (!fn) return fn;
  if (cls === "android/graphics/RenderNode" && key === "nCreate(Ljava/lang/String;)J")
    return function(this: unknown, ...args: unknown[]) { ptr = fn.apply(this, args) as bigint; return ptr; };
  if (cls === "libcore/util/NativeAllocationRegistry") {
    if (key === "registerNativeAllocation(Ljava/lang/Object;J)Ljava/lang/Runnable;")
      return function(this: unknown, ...args: unknown[]) { hostRegistrations++; return fn.apply(this, args); };
    if (key === "applyFreeFunction(JJ)V")
      return function(this: unknown, ...args: unknown[]) { if (args[1] === ptr) releases.push(ptr); return fn.apply(this, args); };
  }
  return fn;
}};
const w = world([join(dir, "classes.dex"), ...PLATFORM_JARS.map(j => join(process.cwd(), "vendor/aosp", j))], {
  cold: process.env.WEBDROID_COLD === "1", natives: new Natives(source), claim: (owner, h) => rt.claimHandle?.(owner, h),
});
for (const spec of source.hostSpecs!()) w.addHostClass(spec);
useEntry(wasmEntry(w)); fieldNames.find = fieldNamesOf(w); rt.mkThrowable = hostThrowable;
const register = w.prog.resolve("libcore/util/NativeAllocationRegistry", "registerNativeAllocation", "(Ljava/lang/Object;J)Ljava/lang/Runnable;")!;
if (!register.codeOff || w.intrinsic(register)) throw new Error("fixture bypasses actual NAR body");
const gcTurn = async () => {
  (globalThis as typeof globalThis & {gc: () => void}).gc();
  await new Promise(r => setTimeout(r, 5));
};
const setup = w.entryAsync("NARGC", "setup", "()V"), check = w.entryAsync("NARGC", "check", "()I");
const clear = w.entryAsync("NARGC", "clear", "()V"), pin = w.entryAsync("NARGC", "pin", "(J)V");
const unpin = w.entryAsync("NARGC", "unpin", "()V");
await setup();
if (!ptr) throw new Error("no actual RenderNode handle");
for (let i = 0; i < 30; i++) {
  await gcTurn();
  if (await check() !== 1 || !deref(ptr) || releases.length) throw new Error(`premature release turn ${i}`);
}
if (hostRegistrations) throw new Error("fixture used host-facade NAR registration");
console.log("Java static owner survives 30 GC turns; real NAR bytecode, no host facade registrations");
await pin(ptr); await unpin();
if (!deref(ptr) || await check() !== 1) throw new Error("VirtualRefBasePtr release freed Java-owned RenderNode");
await clear();
for (let i = 0; i < 100 && deref(ptr); i++) await gcTurn();
if (deref(ptr) || releases.length !== 1) throw new Error("drop owner did not release exactly once");

// The native reference must also outlive the Java RenderNode when a wrapper remains.
await setup();
const retained = ptr, releasedBefore = releases.length;
await pin(retained); await clear();
for (let i = 0; i < 100 && releases.length === releasedBefore; i++) await gcTurn();
if (releases.length !== releasedBefore + 1 || !deref(retained)) throw new Error("NAR must drop only its own reference");
await unpin();
if (deref(retained)) throw new Error("last VirtualRefBasePtr reference did not release");
console.log("RenderNode ownership: static-only GC, explicit acquire/release, NAR before last strong reference pass");

if (w.opts.cold && !w.stats.coldCalls) throw new Error("fixture bypassed cold execution");
