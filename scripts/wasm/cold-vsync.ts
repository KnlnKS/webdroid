// Real AOSP weak references and VsyncEventData constructors cross the production
// native initializer. A due host turn makes cold Reference.get genuinely wait.
import { join } from "node:path";
import { program, world } from "./lib";
import { jsTier } from "./oracle";
import { AOSP } from "./paths";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { rt, type JObj } from "../../src/jvm/runtime";
import { useEntry, newObj, vcall } from "../../src/jvm/natives/jentry";
import { hostThrowable, wasmEntry } from "../../src/wasm/host/entry";
import { nativeSource, natives } from "../../src/wasm/host/nativesource";
import { deref, release } from "../../src/android/handles";
import "../../src/natives";
const DATA = "android/view/DisplayEventReceiver$VsyncEventData";
await jsTier([]);
const prog = program(PLATFORM_JARS.slice(0, 8).map(j => join(AOSP, j)));
let checks = 0;
for (const cold of [false, true]) {
  let turns = 0;
  const w = world(prog, {cold, natives, loop: {due: () => true, yield: async () => {turns++;}, after: (ms, f) => {const id=setTimeout(f,ms);return () => clearTimeout(id);}}});
  for (const spec of nativeSource.hostSpecs!()) w.addHostClass(spec);
  useEntry(wasmEntry(w)); rt.mkThrowable = hostThrowable;
  const receiver = await newObj("java/lang/Object", "()V"), data = await newObj(DATA, "()V");
  const weak = async (o: JObj) => await newObj("java/lang/ref/WeakReference", "(Ljava/lang/Object;)V", o);
  const receiverRef = await weak(receiver), dataRef = await weak(data), queue = await newObj("android/os/MessageQueue", "(Z)V", true);
  const read = vcall(dataRef, "get", "()Ljava/lang/Object;"), waited = read instanceof Promise;
  if (await read !== data) throw new Error("real weak reference lost its referent");
  if (cold && !waited) throw new Error("cold weak-reference probe did not suspend");
  const init = rt.jniFn("android/view/DisplayEventReceiver", "nativeInit(Ljava/lang/ref/WeakReference;Ljava/lang/ref/WeakReference;Landroid/os/MessageQueue;IIJ)J")! as (...args: unknown[]) => unknown;
  const nativeDesc = "(Ljava/lang/ref/WeakReference;Ljava/lang/ref/WeakReference;Landroid/os/MessageQueue;IIJ)J";
  for (const productionAbi of [false, true]) {
    const ptr = productionAbi
      ? await w.entryAsync("android/view/DisplayEventReceiver", "nativeInit", nativeDesc)(w.bridge.toJava(receiverRef, "Ljava/lang/ref/WeakReference;"), w.bridge.toJava(dataRef, "Ljava/lang/ref/WeakReference;"), w.bridge.toJava(queue, "Landroid/os/MessageQueue;"), 0, 0, 0n) as bigint
      : await init(receiverRef, dataRef, queue, 0, 0, 0n) as bigint;
    try {
      const held = deref<{receiver: JObj; data: JObj}>(ptr);
      if (held.receiver !== receiver || held.data !== data) throw new Error("vsync initializer retained unresolved Java callbacks instead of referents");
      checks += 3;
      console.log(cold ? "cold" : "compiled", "weak referents preserved", productionAbi ? "native ABI" : "JS JNI", "waited", waited, "calls", w.stats.coldCalls, "turns", turns);
    } finally { release(ptr); }
  }
}
console.log(`cold vsync: ${checks} real weak-reference/native initialization checks`);
