// A hosted Binder created through the real DEX constructor is a shared value,
// not the suspension stack of whichever native first asked for it.
import { join } from "node:path";
import { program, world } from "./lib";
import { AOSP } from "./paths";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { driven, type Gen, type JObj } from "../../src/jvm/runtime";
import { vcall } from "../../src/jvm/natives/jentry";
import { hostStub, hostedService } from "../../src/android/binder";
import { nativeSource, natives } from "../../src/wasm/host/nativesource";
import "../../src/natives";

const prog = program(PLATFORM_JARS.slice(0, 8).map(j => join(AOSP, j)));
let checks = 0;
for (const cold of [false, true]) {
  const w = world(prog, { cold, natives });
  for (const spec of nativeSource.hostSpecs!()) w.addHostClass(spec);
  const name = `binder-continuation-${cold}`;
  hostStub(name, "android/os/Binder");
  const ask = driven(function* (): Gen<JObj> {
    const first = yield hostedService(name);
    // An independent Java wait separates asks, as the attach path does.
    yield vcall(first, "getInterfaceDescriptor", "()Ljava/lang/String;");
    const again = yield hostedService(name);
    if (first !== again) throw new Error("service identity changed");
    return again;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const values = await Promise.race([
      Promise.all([ask(), ask()]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("shared Binder construction joined a caller's suspended continuation")), 3000); }),
    ]);
    if (values[0] !== values[1] || values[0] !== hostedService(name)) throw new Error("concurrent service identity changed");
    if (cold && !w.stats.coldCalls) throw new Error("fixture bypassed cold construction");
    checks += 3;
    console.log(cold ? "cold" : "compiled", "shared Binder identity and repeated/concurrent asks", "cold calls", w.stats.coldCalls);
  } finally { clearTimeout(timer); }
}
console.log(`cold Binder: ${checks} checks`);
