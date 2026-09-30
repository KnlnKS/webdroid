import { rt } from "../jvm/runtime";
import { NativeBitmap, bitmapOf, HARDWARE, ALPHA_8, RGB_565, ARGB_4444, RGBA_F16, RGBA_1010102, memoryOf, setMemory } from "../android/bitmap";
import type { Cpu } from "./cpu";
import { deref } from "./jni";
import { hostLib, stp, type ArgReader } from "./host";
import { mem } from "./mem";

// libjnigraphics' AndroidBitmap_*: the pixels as the bitmap's memory holds them, locked into guest memory
const locks = new Map<NativeBitmap, { pointer: number; count: number }>();
/** AndroidBitmapInfo.flags: ANDROID_BITMAP_FLAGS_ALPHA_PREMUL 0, _OPAQUE 1, _UNPREMUL 2 */
const alphaOf = (b: NativeBitmap) => !b.hasAlpha ? 1 : b.premultiplied ? 0 : 2;
/** AndroidBitmapFormat for a legacy config */
const FORMATS: Record<number, number> = { [ALPHA_8]: 8, [RGB_565]: 4, [ARGB_4444]: 7, [RGBA_F16]: 9, [RGBA_1010102]: 10 };
function bitmap(cpu: Cpu, a: ArgReader): NativeBitmap | null {
  const env = a.p(), o = deref(a.p(), cpu);
  return env && env === cpu.env && rt.iof(o, "android/graphics/Bitmap") ? bitmapOf(o as object) : null;
}

export function bitmapInit(): void {
  hostLib("libjnigraphics.so", {
    AndroidBitmap_getInfo: (cpu, a) => {
      const b = bitmap(cpu, a), out = a.p();
      if (!b) return -1;
      if (b.recycled) return -2;
      if (out) {
        mem.st32(out, b.w); mem.st32(out + 4, b.h); mem.st32(out + 8, b.rowBytes);
        mem.st32(out + 12, FORMATS[b.config] ?? 1); mem.st32(out + 16, alphaOf(b) | (b.config === HARDWARE ? 0x80000000 : 0));
      }
      return 0;
    },
    AndroidBitmap_lockPixels: (cpu, a) => {
      const b = bitmap(cpu, a), out = a.p();
      if (!b) return -1;
      if (b.recycled || b.config === HARDWARE) return -2;
      let lock = locks.get(b);
      if (!lock) {
        const size = b.rowBytes * b.h, pointer = mem.malloc(size);
        if (!pointer) return -3;
        lock = { pointer, count: 0 };
        memoryOf(b, mem.bytes(pointer, size));
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
        setMemory(b, mem.bytes(lock.pointer, b.rowBytes * b.h));
        return 0;
      } finally {
        if (--lock.count === 0) { locks.delete(b); mem.free(lock.pointer); }
      }
    },
  }, { closed: true });
}
