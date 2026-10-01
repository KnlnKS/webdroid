// Stage E1's libc micro-benchmark: ns and guest instructions per call of each b_* loop in
// libbench.so (bench.c), called from guest code through its PLT into the process's libc.
//   NDK=<ndk>/toolchains/llvm/prebuilt/darwin-x86_64/bin
//   $NDK/aarch64-linux-android30-clang -O2 -shared -fPIC -o scripts/libc-ab/libbench.so scripts/libc-ab/bench.c -lm
//   bun scripts/libc-ab/bench.ts                        # HLE libc
//   WEBDROID_LIBC=bionic bun scripts/libc-ab/bench.ts   # the reference build's bionic

const { mountLocalPlatformData } = await import("../../scripts/lib");
const { rt } = await import("../../src/jvm/runtime");
await import("../../src/jvm/natives/jlang");
const { loadNativeLib } = await import("../../src/native/loader");
const { modules } = await import("../../src/native/dl");
const { cpuFor } = await import("../../src/native/cpu");
const { curThread } = await import("../../src/jvm/natives/jlang");
const { perf } = await import("../../src/perf");
rt.classpath = {};
await mountLocalPlatformData();
const bytes = new Uint8Array(await Bun.file(import.meta.dir + "/libbench.so").arrayBuffer());
await loadNativeLib("libbench.so", bytes, "arm64-v8a");
const mod = modules.find((m) => m.name === "libbench.so")!;
const cpu = cpuFor(curThread);
const out: Record<string, number> = {}, instr: Record<string, number> = {};
for (const name of ["b_malloc", "b_malloc_hold", "b_snprintf", "b_strtod", "b_memcpy", "b_strlen", "b_mutex", "b_clock", "b_sin", "b_tls", "b_qsort", "b_ctype"]) {
  const fn = mod.exports.get(name)!;
  await cpu.call(fn, [2000]);                         // warm: JIT the loop and its callees
  let n = 2000, ms = 0;
  for (;;) { const i0 = perf.nativeInstr, t0 = performance.now(); await cpu.call(fn, [n]); ms = performance.now() - t0; instr[name] = Math.round((perf.nativeInstr - i0) / n); if (ms > 300 || n > 5e7) break; n *= 4; }
  out[name] = Math.round(ms * 1e6 / n);
}
console.log(JSON.stringify({ libc: process.env.WEBDROID_LIBC ?? "hle", nsPerOp: out, instrPerOp: instr }));
process.exit(0);
