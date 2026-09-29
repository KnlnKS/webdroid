// An APK's own ART baseline profile (assets/dexopt/baseline.prof, docs/bytecode-first-plan.md §4.4):
// the methods its developers measured as hot or run at startup. A compile worker emits their fast
// bodies, so their first calls skip the cold tier and no tap waits on their compile.
import { unzlibSync } from "fflate";
import { codeStats, offerCode } from "./codecache";
import type { CompileRequest } from "./compileworker";
import { jvmCoverage } from "./coverage";
import { jvmProfiler } from "./profile";
import type { Runtime } from "./runtime";

/** the profile's hot and startup methods, as method indices per dex name; null when unreadable */
export function parseBaselineProfile(bytes: Uint8Array): Map<string, number[]> | null {
  // "pro\0" "010\0", a dex count, then zlib data: per dex a line (key, class count, hot-region
  // size, checksum, method count), then per dex its hot methods, classes and flag bitmap
  if (new TextDecoder().decode(bytes.subarray(0, 8)) !== "pro\u0000010\u0000") return null;
  const head = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data = unzlibSync(bytes.subarray(17, 17 + head.getUint32(13, true)));
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const lines: { key: string; classes: number; hotSize: number; methods: number }[] = [];
  let p = 0;
  for (let i = 0; i < bytes[8]; i++) {
    const keySize = v.getUint16(p, true);
    lines.push({ key: new TextDecoder().decode(data.subarray(p + 16, p + 16 + keySize)), classes: v.getUint16(p + 2, true),
      hotSize: v.getUint32(p + 4, true), methods: v.getUint32(p + 12, true) });
    p += 16 + keySize;
  }
  const out = new Map<string, number[]>();
  for (const line of lines) {
    const methods = new Set<number>();
    for (let end = p + line.hotSize, m = 0; p < end;) {
      methods.add(m += v.getUint16(p, true));
      const caches = v.getUint16(p + 2, true);
      p += 4;
      for (let k = 0; k < caches; k++) p += 3 + data[p + 2] * 3;
    }
    p += line.classes * 2;
    // the flag bitmap: a startup bit per method, then a post-startup bit per method
    for (let m = 0; m < line.methods; m++) if (data[p + (m >> 3)] >> (m & 7) & 1) methods.add(m);
    p += Math.ceil(2 * line.methods / 8);
    out.set(line.key.slice(line.key.lastIndexOf("!") + 1), [...methods]);
  }
  return out;
}

/** On a launch without persisted code, emit the profiled methods' hot bodies in a compile worker
 *  (compileworker.ts); each chunk installs as it arrives. Once a launch has persisted what it ran,
 *  that is the app's own profile. `dexes` are the app's dex entries. */
export function compileProfile(R: Runtime, dexes: [name: string, bytes: Uint8Array][], profile: Map<string, number[]>): void {
  if (typeof Worker === "undefined" || typeof document === "undefined" || jvmProfiler.enabled || jvmCoverage.enabled ||
    jvmProfiler.tier === "cold" || codeStats().loaded) return;
  const work: CompileRequest["work"] = [];
  for (const [name, methods] of profile) if (R.dexes.some((d) => d.name === name)) for (const m of methods) work.push([name, m]);
  const worker = new Worker(`/compile-worker.js${location.search}`, { type: "module" });
  worker.onmessage = ({ data }: MessageEvent<[string, string][]>) => void offerCode(data);
  const copies = dexes.map(([name, bytes]) => [name, bytes.slice()] as [string, Uint8Array]);
  worker.postMessage({ dexes: copies, work } satisfies CompileRequest, copies.map(([, bytes]) => bytes.buffer));
}
