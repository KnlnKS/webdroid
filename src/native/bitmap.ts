import { JBitmap, copyBitmapPixels } from "../android/graphics";
import type { Cpu } from "./cpu";
import { deref } from "./jni";
import { hostLib, stp, type ArgReader } from "./host";
import { mem } from "./mem";

const locks = new Map<JBitmap, { pointer: number; count: number; alpha: number }>();
const alphaOf = (b: JBitmap) => !b.hasAlpha ? 1 : b.premultiplied ? 0 : 2;
function bitmap(cpu: Cpu, a: ArgReader): JBitmap | null {
  const env = a.p(), b = deref(a.p(), cpu);
  return env && env === cpu.env && b instanceof JBitmap ? b : null;
}

export function bitmapInit(): void {
  hostLib("libjnigraphics.so", {
    AndroidBitmap_getInfo: (cpu, a) => {
      const b = bitmap(cpu, a), out = a.p();
      if (!b) return -1;
      if (b.recycled) return -2;
      if (out) {
        mem.st32(out, b.w); mem.st32(out + 4, b.h); mem.st32(out + 8, b.w * 4);
        mem.st32(out + 12, 1); mem.st32(out + 16, alphaOf(b) | (b.config === 7 ? 0x80000000 : 0));
      }
      return 0;
    },
    AndroidBitmap_lockPixels: (cpu, a) => {
      const b = bitmap(cpu, a), out = a.p();
      if (!b) return -1;
      if (b.recycled || b.config === 7) return -2;
      let lock = locks.get(b);
      if (!lock) {
        const pixels = b.pixels(), pointer = mem.malloc(pixels.length);
        if (!pointer) return -3;
        lock = { pointer, count: 0, alpha: alphaOf(b) };
        copyBitmapPixels(pixels, mem.bytes(pointer, pixels.length), lock.alpha, false);
        locks.set(b, lock);
      }
      lock.count++;
      if (out) stp(out, lock.pointer);
      return 0;
    },
    AndroidBitmap_unlockPixels: (cpu, a) => {
      const b = bitmap(cpu, a);
      if (!b) return -1;
      const lock = locks.get(b);
      if (!lock) return -1;
      try {
        if (b.recycled) return -2;
        const pixels = b.pixels();
        copyBitmapPixels(mem.bytes(lock.pointer, pixels.length), pixels, lock.alpha, true);
        b.commit(0, 0, b.w, b.h);
        return 0;
      } finally {
        if (--lock.count === 0) { locks.delete(b); mem.free(lock.pointer); }
      }
    },
  }, { closed: true });
}
