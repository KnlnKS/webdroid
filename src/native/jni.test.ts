import { expect, test } from "bun:test";
import "../natives";
import { rt, JObj } from "../jvm/runtime";
import { type ClassDef, type DexFile } from "../jvm/dex";
import { JThread, mainThread, setCurThread } from "../jvm/natives/jlang";
import { cpuFor, setA64 } from "./cpu";
import { defineHost, retD } from "./host";
import { jniInit, resolveByExport } from "./jni";

rt.linkNatives();
for (const a64 of [false, true]) test(`${a64 ? "A64" : "ARM32"} critical natives omit JNI handles while fast natives retain them`, async () => {
  setA64(a64); jniInit();
  const previousResolver = rt.jniResolver;
  const thread = new JThread(), cpu = cpuFor(thread);
  try {
    for (const critical of [false, true]) {
      const cls = `test/NativeAbi${+a64}${+critical}`, sig = "(IJFD)D";
      rt.register({ name: cls, ctor: class extends JObj {} });
      const info = rt.link(cls);
      const dex = {
        method: () => ({ name: "call" }), methodDesc: () => sig,
        classAnnotations: () => ({ cls: [], fields: new Map(), params: new Map(), methods: new Map([[0, [{
          visibility: 0, type: "dalvik/annotation/optimization/" + (critical ? "CriticalNative" : "FastNative"), elements: {}, dex,
        }]]]) }),
      } as unknown as DexFile;
      info.dex = dex;
      info.def = { dex, directMethods: [{ methodIdx: 0, flags: 0x109, codeOff: 0 }], virtualMethods: [], staticFields: [], instanceFields: [] } as unknown as ClassDef;
      const seen: unknown[][] = [];
      const address = defineHost(cls, (cpu, args) => {
        if (!critical) { expect(args.p()).toBeGreaterThan(0); expect(args.p()).toBeGreaterThan(0); }
        const values = [args.i(), args.l(), args.f(), args.d()];
        seen.push(values);
        return retD(cpu, Number(values[0]) + Number(values[1]) + Number(values[2]) + Number(values[3]));
      });
      resolveByExport(() => address);
      const fn = rt.jniResolver!.call(rt, cls, "call" + sig)!;
      setCurThread(thread);
      expect(await fn.apply(info.ctor, [123, 40n, 1.25, 2.5] as never[])).toBe(166.75);
      expect(seen).toEqual([[123, 40n, 1.25, 2.5]]);
    }
  } finally { rt.jniResolver = previousResolver; cpu.dispose(); setCurThread(mainThread); }
});
