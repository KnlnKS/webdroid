import { afterAll, beforeAll, expect, test } from "bun:test";
import { JBitmap } from "../android/graphics";
import "../android/os";
import { mainThread, vcall } from "../jvm/natives/jlang";
import { rt } from "../jvm/runtime";
import { bitmapInit } from "./bitmap";
import { Cpu, setA64 } from "./cpu";
import { ldp, lookupHost, PTR } from "./host";
import { deref, jniInit, javaVM } from "./jni";
import { mem } from "./mem";

let cpu: Cpu, env: number, cls: number, create: number;
const jni = (index: number) => ldp(ldp(env) + index * PTR);
const host = (name: string) => lookupHost("AndroidBitmap_" + name, "libjnigraphics.so")!;
async function createBitmap() {
  const ref = await cpu.call(jni(114), [env, cls, create, 2, 1, 0]);
  const b = deref(ref, cpu);
  if (!(b instanceof JBitmap)) throw new Error("JNI did not create a bitmap");
  return { ref, b };
}

beforeAll(async () => {
  setA64(true);
  rt.link("android/graphics/Bitmap");
  jniInit(); bitmapInit();
  cpu = new Cpu(mainThread, "native bitmap test");
  const out = mem.hostAlloc(PTR);
  await cpu.call(ldp(ldp(javaVM.addr) + 6 * PTR), [javaVM.addr, out, 0x10006]);
  env = ldp(out);
  cls = await cpu.call(jni(6), [env, mem.hostStr("android/graphics/Bitmap")]);
  create = await cpu.call(jni(113), [env, cls, mem.hostStr("createBitmap"), mem.hostStr("(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;")]);
});
afterAll(() => setA64(false));

test("native bitmap locks exchange premultiplied pixels and balance nested allocations", async () => {
  const { ref, b } = await createBitmap(), out = mem.hostAlloc(PTR);
  const lock = host("lockPixels"), unlock = host("unlockPixels");
  await vcall(b, "setPixel", "(III)V", 0, 0, 0x80402010 | 0);
  const generation = b.genId, allocated = mem.stats().used;
  expect(await cpu.call(lock, [env, ref, out])).toBe(0);
  const p = ldp(out);
  expect([...mem.bytes(p, 4)]).toEqual([32, 16, 8, 128]);
  expect(await cpu.call(lock, [env, ref, out])).toBe(0);
  expect(ldp(out)).toBe(p);
  mem.bytes(p, 8).set([64, 32, 16, 128, 50, 60, 70, 0]);
  expect(await cpu.call(unlock, [env, ref])).toBe(0);
  expect(await vcall(b, "getPixel", "(II)I", 0, 0)).toBe(0x80804020 | 0);
  expect(await vcall(b, "getPixel", "(II)I", 1, 0)).toBe(0);
  expect(mem.stats().used).toBeGreaterThan(allocated);
  mem.bytes(p, 4).set([1, 2, 3, 255]);
  expect(await cpu.call(unlock, [env, ref])).toBe(0);
  expect(await vcall(b, "getPixel", "(II)I", 0, 0)).toBe(0xff010203 | 0);
  expect(mem.stats().used).toBe(allocated);
  expect(b.genId).toBe(generation + 2);
  expect(await cpu.call(unlock, [env, ref])).toBe(-1);
});

test("bitmap info and lock bytes agree for opaque and straight alpha", async () => {
  const { ref, b } = await createBitmap(), info = mem.hostAlloc(20), out = mem.hostAlloc(PTR);
  for (const opaque of [false, true]) {
    b.hasAlpha = !opaque; b.premultiplied = false;
    b.pixels().set([120, 60, 30, 128, 0, 0, 0, 0]);
    expect(await cpu.call(host("getInfo"), [env, ref, info])).toBe(0);
    expect([0, 4, 8, 12, 16].map((offset) => mem.ld32(info + offset))).toEqual([2, 1, 8, 1, opaque ? 1 : 2]);
    expect(await cpu.call(host("lockPixels"), [env, ref, out])).toBe(0);
    expect([...mem.bytes(ldp(out), 4)]).toEqual([120, 60, 30, opaque ? 255 : 128]);
    mem.bytes(ldp(out), 4).set([2, 4, 6, 64]);
    expect(await cpu.call(host("unlockPixels"), [env, ref])).toBe(0);
    expect([...b.pixels().slice(0, 4)]).toEqual([2, 4, 6, opaque ? 255 : 64]);
  }
});

test("invalid JNI handles and hardware pixels fail without overwriting outputs", async () => {
  const { ref, b } = await createBitmap(), out = mem.hostAlloc(20);
  mem.bytes(out, 20).fill(0x5a);
  expect(await cpu.call(host("getInfo"), [0, ref, out])).toBe(-1);
  expect(await cpu.call(host("getInfo"), [env, cls, out])).toBe(-1);
  expect(await cpu.call(host("lockPixels"), [env, 0x12345678, out])).toBe(-1);
  b.config = 7;
  expect(await cpu.call(host("lockPixels"), [env, ref, out])).toBe(-2);
  expect([...mem.bytes(out, 20)]).toEqual(Array(20).fill(0x5a));
  expect(await cpu.call(host("getInfo"), [env, ref, out])).toBe(0);
  expect(mem.ld32(out + 16) >>> 0).toBe(0x80000000);
  b.config = 5;
  const allocated = mem.stats().used;
  expect(await cpu.call(host("getInfo"), [env, ref, 0])).toBe(0);
  expect(await cpu.call(host("lockPixels"), [env, ref, 0])).toBe(0);
  b.recycled = true;
  expect(await cpu.call(host("getInfo"), [env, ref, out])).toBe(-2);
  expect(await cpu.call(host("unlockPixels"), [env, ref])).toBe(-2);
  expect(mem.stats().used).toBe(allocated);
});


test("bitmap buffers share native pixel representation and advance typed slice positions", async () => {
  const { b } = await createBitmap();
  b.pixels().set([120, 60, 30, 128, 9, 8, 7, 255]);
  const byteClass = rt.link("java/nio/ByteBuffer").ctor;
  for (const direct of [false, true]) {
    const buffer = await vcall(byteClass, direct ? "allocateDirect" : "allocate", "(I)Ljava/nio/ByteBuffer;", 20);
    await vcall(buffer, "position", "(I)Ljava/nio/Buffer;", 4);
    const slice = await vcall(buffer, "slice", "()Ljava/nio/ByteBuffer;");
    await vcall(slice, "position", "(I)Ljava/nio/Buffer;", 2);
    await vcall(b, "copyPixelsToBuffer", "(Ljava/nio/Buffer;)V", slice);
    expect(slice.pos).toBe(10); expect(buffer.pos).toBe(4);
    expect([...new Uint8Array(slice.dv.buffer, slice.dv.byteOffset + 2, 8)]).toEqual([60, 30, 15, 128, 9, 8, 7, 255]);
    const typed = await vcall(buffer, "asIntBuffer", "()Ljava/nio/IntBuffer;");
    await vcall(b, "copyPixelsToBuffer", "(Ljava/nio/Buffer;)V", typed);
    expect(typed.pos).toBe(2);
    typed.pos = 0;
    const generation = b.genId;
    await vcall(b, "copyPixelsFromBuffer", "(Ljava/nio/Buffer;)V", typed);
    expect(typed.pos).toBe(2); expect(b.genId).toBe(generation + 1);
    expect([...b.pixels()]).toEqual([120, 60, 30, 128, 9, 8, 7, 255]);
    typed.pos = typed.lim;
    await expect(vcall(b, "copyPixelsToBuffer", "(Ljava/nio/Buffer;)V", typed)).rejects.toMatchObject({ msg: "Buffer not large enough for pixels" });
    expect(typed.pos).toBe(typed.lim);
  }
});
