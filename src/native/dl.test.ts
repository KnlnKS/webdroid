import { expect, test } from "vite-plus/test";
import { mainThread } from "../jvm/natives/jentry.ts";
import { vfs } from "../shell/vfs.ts";
import { Cpu, setA64 } from "./cpu.ts";
import { libdl, linkerHooks, modules } from "./dl.ts";
import { defineHost } from "./host.ts";
import { mem } from "./mem.ts";

/** an AArch64 image whose DT_INIT_ARRAY and DT_FINI_ARRAY call the host functions given, with a
 *  16-byte PT_TLS segment */
function image(init: number, fini: number): Uint8Array {
  const bytes = new Uint8Array(4096), d = new DataView(bytes.buffer), put = (off: number, value: number) => d.setUint32(off, value, true);
  put(0, 0x464c457f); bytes[4] = 2; bytes[5] = 1; d.setUint16(18, 0xb7, true);
  put(32, 64); d.setUint16(54, 56, true); d.setUint16(56, 3, true);
  const ph = (p: number, type: number, at: number, size: number) => { put(p, type); put(p + 8, at); put(p + 16, at); put(p + 32, size); put(p + 40, size); };
  ph(64, 1, 0, 4096); ph(120, 2, 0x100, 5 * 16); ph(176, 7, 0x500, 16);
  [[25, 0x400], [27, 8], [26, 0x410], [28, 8]].forEach(([tag, value], i) => { put(0x100 + i * 16, tag); put(0x108 + i * 16, value); });
  put(0x400, init); put(0x410, fini);
  return bytes;
}

test("dlclose unloads an image at its last reference, running its destructors and freeing its TLS, and dlopen loads it fresh", async () => {
  setA64(true);
  const calls: string[] = [], cpu = new Cpu(mainThread, "dlclose-test"), name = mem.strdup("libfini.so");
  vfs.write("/system/lib64/libfini.so", image(defineHost("test.init", () => { calls.push("init"); return 0; }), defineHost("test.fini", () => { calls.push("fini"); return 0; })));
  const deviceLib = linkerHooks.deviceLib;
  linkerHooks.deviceLib = (n) => n === "libfini.so" ? "/system/lib64/libfini.so" : deviceLib(n);
  const slots = new Map<string, number>();
  const call = (fn: keyof typeof libdl, ...args: number[]) => { let at = slots.get(fn); if (at === undefined) slots.set(fn, (at = defineHost("test." + fn, libdl[fn]))); return cpu.call(at, args); };
  const loaded = () => modules.some((m) => m.name === "libfini.so");
  try {
    const handle = await call("dlopen", name, 2);
    const mod = modules.find((m) => m.name === "libfini.so")!, tls = mod.tls!;
    expect(mod.phdr).toBe(mod.base + 64);                                         // the headers as mapped
    const block = cpu.staticTls(mod, tls);
    expect(await call("dlopen", name, 2)).toBe(handle);
    expect(await call("dlclose", handle)).toBe(0);
    expect([calls, loaded()]).toEqual([["init"], true]);
    expect(await call("dlclose", handle)).toBe(0);
    expect([calls, loaded()]).toEqual([["init", "fini"], false]);
    const reused = mem.malloc(tls.size);
    expect(reused).toBe(block);                                                  // its TLS block went back to the heap
    mem.free(reused);
    expect(await call("dlclose", handle)).toBe(-1);                               // the handle went with it
    expect(await call("dlopen", name, 4 /* RTLD_NOLOAD */)).toBe(0);
    const again = await call("dlopen", name, 2 | 0x1000 /* RTLD_NODELETE */);
    expect(await call("dlclose", again)).toBe(0);
    expect([calls, loaded()]).toEqual([["init", "fini", "init"], true]);
  } finally { linkerHooks.deviceLib = deviceLib; vfs.delete("/system/lib64/libfini.so"); cpu.dispose(); setA64(false); }
});
