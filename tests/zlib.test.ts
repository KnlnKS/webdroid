import { expect, test } from "vite-plus/test";
import { deflateSync, inflateSync } from "node:zlib";
import { ZStream, Z_FINISH, Z_NO_FLUSH, Z_OK, Z_STREAM_END, Z_BUF_ERROR } from "../src/zlib.ts";

// half-compressible, so both sides of a stream span several of ZStream's 128K windows
let seed = 1;
const data = Uint8Array.from({ length: 600_000 }, () => (seed = Math.imul(seed, 1103515245) + 12345 | 0) >>> 27);
const open = (s: ZStream | number) => s as ZStream;

test("a windowed call consumes and produces what one zlib call would", () => {
  const zipped = deflateSync(data), trailed = new Uint8Array([...zipped, 1, 2, 3]);
  const s = open(ZStream.inflater(15)), out = new Uint8Array(data.length + 10);
  expect(s.run(trailed, out, Z_NO_FLUSH)).toEqual([Z_STREAM_END, zipped.length, data.length]);
  expect(out.subarray(0, data.length)).toEqual(data);
  s.end();

  const t = open(ZStream.inflater(15));
  const [code, read, written] = t.run(zipped.subarray(0, zipped.length >> 1), out, Z_FINISH);
  expect([code, read]).toEqual([Z_BUF_ERROR, zipped.length >> 1]);
  expect(out.subarray(0, written)).toEqual(data.subarray(0, written));
  t.end();
});

test("small output buffers over the whole remaining input, as java.util.zip's callers pass them", () => {
  const d = open(ZStream.deflater(6, 8, 15, 8, 0)), chunk = new Uint8Array(8192), zipped: number[] = [];
  for (let read = 0, code = Z_OK; code !== Z_STREAM_END;) {
    const [c, r, w] = d.run(data.subarray(read), chunk, Z_FINISH);
    code = c; read += r; zipped.push(...chunk.subarray(0, w));
  }
  d.end();
  expect(new Uint8Array(inflateSync(Uint8Array.from(zipped)))).toEqual(data);

  const i = open(ZStream.inflater(15)), packed = Uint8Array.from(zipped), inflated: number[] = [];
  for (let read = 0, code = Z_OK; code !== Z_STREAM_END;) {
    const [c, r, w] = i.run(packed.subarray(read), chunk, Z_NO_FLUSH);
    expect(c === Z_OK || c === Z_STREAM_END).toBe(true);
    code = c; read += r; inflated.push(...chunk.subarray(0, w));
  }
  i.end();
  expect(Uint8Array.from(inflated)).toEqual(data);
});
