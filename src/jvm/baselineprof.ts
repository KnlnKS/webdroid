// An APK's own ART baseline profile (assets/dexopt/baseline.prof, docs/bytecode-first-plan.md §4.4):
// the methods its developers measured as hot or run at startup. Idle time after launch compiles
// their fast bodies, so their first calls skip the cold tier and no tap waits on their compile.
import { unzlibSync } from "fflate";
import { descToName } from "./abi";
import { precompile } from "./compiler";
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

/** compile the profiled methods of `R`'s dex files in idle time, a few milliseconds at a time */
export function precompileProfile(R: Runtime, profile: Map<string, number[]>): void {
  if (typeof requestIdleCallback === "undefined") return;
  const work: [dexName: string, methodIdx: number][] = [...profile].flatMap(([dex, methods]) => methods.map((m) => [dex, m] as [string, number]));
  let next = 0;
  // 5 ms slices: input arriving during a slice waits for it
  requestIdleCallback(function step(deadline) {
    const until = performance.now() + Math.min(5, deadline.timeRemaining());
    while (next < work.length && performance.now() < until) {
      const [dexName, methodIdx] = work[next++];
      const dex = R.dexes.find((d) => d.name === dexName);
      if (!dex || methodIdx >= dex.methodCount) continue;
      const cls = descToName(dex.type(dex.method(methodIdx).cls));
      if (R.classDefOf(cls)?.dex !== dex) continue;
      try {
        const info = R.link(cls);
        R.ensureCompiled(info);
        precompile(R, info, methodIdx);
      } catch { /* it compiles on its first call instead */ }
    }
    if (next < work.length) requestIdleCallback(step);
  });
}
