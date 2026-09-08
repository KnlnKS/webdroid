import { afterAll, beforeAll, expect, test } from "bun:test";
import { setGL } from "../android/gl";
import { mainThread } from "../jvm/natives/jlang";
import { Cpu, setA64 } from "./cpu";
import { gles3Init } from "./gles3";
import { lookupHost } from "./host";
import { mem } from "./mem";

const ARRAY = 0x8892, ELEM = 0x8893, COPY = 0x8f37;
class Buffer {
  elem: boolean | null = null;
  data = new Uint8Array();
  usage = 0;
}
const bindings = new Map<number, Buffer | null>();
let depthWrite = true, colorWrite: boolean[] = [], normalized = true;
const gl = {
  depthMask: (value: boolean) => { depthWrite = value; },
  colorMask: (...values: boolean[]) => { colorWrite = values; },
  vertexAttribPointer: (_i: number, _size: number, _type: number, value: boolean) => { normalized = value; },
  createBuffer: () => new Buffer(),
  readPixels: () => bindings.get(0x88eb)!.data.set([5, 6, 7, 8]),
  bindBuffer(t: number, b: Buffer | null) {
    if (b) {
      if (b.elem !== null && b.elem !== (t === ELEM)) throw new Error("WebGL forbids changing buffer kind");
      b.elem = t === ELEM;
    }
    bindings.set(t, b);
  },
  getParameter: (pn: number) => bindings.get(pn === 0x88ed ? 0x88eb : pn === 0x8895 ? ELEM : ARRAY) ?? null,
  getBufferParameter: (t: number, pn: number) => pn === 0x8764 ? bindings.get(t)!.data.length : bindings.get(t)!.usage,
  getBufferSubData: (t: number, off: number, dst: Uint8Array) => dst.set(bindings.get(t)!.data.subarray(off, off + dst.length)),
  bufferData(t: number, data: number | Uint8Array, usage: number) { const b = bindings.get(t)!; b.data = typeof data === "number" ? new Uint8Array(data) : new Uint8Array(data); b.usage = usage; },
  bufferSubData: (t: number, off: number, data: Uint8Array) => bindings.get(t)!.data.set(data, off),
};
let cpu: Cpu;
const call = (name: string, ...args: number[]) => cpu.call(lookupHost(name, "libGLESv2.so")!, args);
beforeAll(() => { setA64(true); gles3Init(); cpu = new Cpu(mainThread, "GLES buffer test"); setGL(gl as unknown as WebGL2RenderingContext); });
afterAll(() => { setGL(null); setA64(false); });

test("mixed index and vertex buffers preserve uploads, mapped writes and copy writes", async () => {
  const p = mem.malloc(32);
  try {
    for (const first of [ARRAY, ELEM]) {
      const second = first === ARRAY ? ELEM : ARRAY;
      await call("glGenBuffers", 1, p);
      const handle = mem.ld32(p);
      await call("glBindBuffer", COPY, handle);
      mem.u8.set([1, 2, 3, 4], p + 8);
      await call("glBufferData", COPY, 4, p + 8, 0x88e8);
      await call("glBindBuffer", first, handle);
      const original = bindings.get(first)!;
      await call("glBindBuffer", second, handle);
      const mirror = bindings.get(second)!;
      expect(mirror).not.toBe(original);
      expect([...mirror.data]).toEqual([1, 2, 3, 4]);
      expect(mirror.usage).toBe(0x88e8);
      mem.u8.set([9, 8], p + 8);
      await call("glBufferSubData", second, 1, 2, p + 8);
      expect([...original.data]).toEqual([1, 9, 8, 4]);
      expect([...mirror.data]).toEqual([...original.data]);
      const mapped = await call("glMapBufferRange", COPY, 0, 4, 3);
      expect([...mem.u8.subarray(mapped, mapped + 4)]).toEqual([1, 9, 8, 4]);
      mem.u8[mapped + 3] = 7;
      await call("glUnmapBuffer", COPY);
      expect([...original.data]).toEqual([1, 9, 8, 7]);
      expect([...mirror.data]).toEqual([...original.data]);
      await call("glBindBuffer", 0x88eb, handle);
      await call("glReadPixels", 0, 0, 1, 1, 0x1908, 0x1401, 0);
      expect([...original.data]).toEqual([5, 6, 7, 8]);
      expect([...mirror.data]).toEqual([...original.data]);
      await call("glBufferData", first, 4, 0, 0x88e4);
      expect([...original.data]).toEqual([0, 0, 0, 0]);
      expect([...mirror.data]).toEqual([...original.data]);
      await call("glGenBuffers", 1, p);
      await call("glBindBuffer", COPY, mem.ld32(p));
      await call("glBufferData", COPY, 2, p + 8, 0x88e4);
      await call("glCopyBufferSubData", COPY, second, 0, 1, 2);
      expect([...original.data]).toEqual([0, 9, 8, 0]);
      expect([...mirror.data]).toEqual([...original.data]);
    }
  } finally { mem.free(p); }
});


test("GLboolean arguments ignore unspecified upper register bits", async () => {
  await call("glDepthMask", 0x100);
  expect(depthWrite).toBe(false);
  await call("glDepthMask", 0x101);
  expect(depthWrite).toBe(true);
  await call("glColorMask", 0x100, 0x101, 0xffffff00, 0xffffff80);
  expect(colorWrite).toEqual([false, true, false, true]);
  await call("glVertexAttribPointer", 0, 2, 0x1406, 0x100, 0, 0);
  expect(normalized).toBe(false);
});
