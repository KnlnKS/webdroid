import { afterAll, beforeAll, expect, test } from "bun:test";
import { deflateSync, gzipSync, zlibSync } from "fflate";
import { mainThread } from "../jvm/natives/jlang";
import { libcInit } from "./libc";
import { Cpu, setA64 } from "./cpu";
import { ldp, lookupHost, stp } from "./host";
import { mem } from "./mem";

const Z_OK = 0, Z_STREAM_END = 1, Z_DATA_ERROR = -3, Z_BUF_ERROR = -5;
const IN = 0, AVAIL_IN = 8, OUT = 24, AVAIL_OUT = 32;
const STREAM_SIZE = 112;

let cpu: Cpu;
let init2: number;
let inflate: number;
let reset: number;
let end: number;

beforeAll(() => {
  setA64(true);
  libcInit();
  cpu = new Cpu(mainThread, "zlib test");
  init2 = lookupHost("inflateInit2_", "libz.so")!;
  inflate = lookupHost("inflate", "libz.so")!;
  reset = lookupHost("inflateReset", "libz.so")!;
  end = lookupHost("inflateEnd", "libz.so")!;
});

afterAll(() => setA64(false));

function bytes(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { result.set(part, at); at += part.length; }
  return result;
}

interface InflateResult { status: number; output: Uint8Array; remaining: Uint8Array }

async function decode(strm: number, input: Uint8Array, chunkSize: number): Promise<InflateResult> {
  const output: Uint8Array[] = [];
  let status = Z_OK;
  for (let offset = 0; offset < input.length && status !== Z_STREAM_END; offset += chunkSize) {
    const chunk = input.subarray(offset, Math.min(input.length, offset + chunkSize));
    const source = mem.hostAlloc(chunk.length);
    mem.u8.set(chunk, source);
    stp(strm + IN, source);
    mem.st32(strm + AVAIL_IN, chunk.length);

    for (let calls = 0; calls < 10000; calls++) {
      const before = mem.ld32(strm + AVAIL_IN) >>> 0;
      const destination = mem.hostAlloc(7);
      stp(strm + OUT, destination);
      mem.st32(strm + AVAIL_OUT, 7);
      status = await cpu.call(inflate, [strm, 0]);
      const produced = 7 - (mem.ld32(strm + AVAIL_OUT) >>> 0);
      if (produced) output.push(mem.u8.slice(destination, destination + produced));
      const remaining = mem.ld32(strm + AVAIL_IN) >>> 0;

      if (status === Z_STREAM_END || status < Z_OK && status !== Z_BUF_ERROR) {
        const next = ldp(strm + IN);
        return { status, output: bytes(output), remaining: mem.u8.slice(next, next + remaining) };
      }
      if (!remaining && produced < 7) break;
      if (remaining === before && !produced) throw new Error("inflate made no progress");
    }
  }
  const remaining = mem.ld32(strm + AVAIL_IN) >>> 0;
  const next = ldp(strm + IN);
  return { status, output: bytes(output), remaining: mem.u8.slice(next, next + remaining) };
}

async function initialized(windowBits: number): Promise<number> {
  const strm = mem.hostAlloc(STREAM_SIZE);
  mem.u8.fill(0, strm, strm + STREAM_SIZE);
  expect(await cpu.call(init2, [strm, windowBits, mem.hostStr("1.2.8"), STREAM_SIZE])).toBe(Z_OK);
  return strm;
}

const payload = new TextEncoder().encode("Among Us native gzip response ".repeat(17));

test("inflateInit2 decodes chunked gzip and leaves bytes after its checked trailer", async () => {
  const compressed = gzipSync(payload);
  const chunked = await initialized(31);
  const chunkedResult = await decode(chunked, compressed, 1);
  expect(chunkedResult.status).toBe(Z_STREAM_END);
  expect(chunkedResult.output).toEqual(payload);
  expect(await cpu.call(end, [chunked])).toBe(Z_OK);

  const input = bytes([compressed, Uint8Array.of(0xaa, 0xbb)]);
  const strm = await initialized(31);
  const result = await decode(strm, input, input.length);
  expect(result.status).toBe(Z_STREAM_END);
  expect(result.output).toEqual(payload);
  expect(result.remaining).toEqual(Uint8Array.of(0xaa, 0xbb));
  expect(await cpu.call(end, [strm])).toBe(Z_OK);

  const corrupt = compressed.slice();
  corrupt[corrupt.length - 8] ^= 1;
  const bad = await initialized(31);
  expect((await decode(bad, corrupt, 1)).status).toBe(Z_DATA_ERROR);
  expect(await cpu.call(end, [bad])).toBe(Z_OK);
});

test("auto-detect survives reset and decodes chunked zlib then gzip streams", async () => {
  const wrapped = zlibSync(payload);
  const strm = await initialized(47);
  const first = await decode(strm, wrapped, 1);
  expect(first.status).toBe(Z_STREAM_END);
  expect(first.output).toEqual(payload);

  expect(await cpu.call(reset, [strm])).toBe(Z_OK);
  const second = await decode(strm, gzipSync(payload), 2);
  expect(second.status).toBe(Z_STREAM_END);
  expect(second.output).toEqual(payload);
  expect(await cpu.call(end, [strm])).toBe(Z_OK);

  const corrupt = wrapped.slice();
  corrupt[corrupt.length - 1] ^= 1;
  const bad = await initialized(47);
  expect((await decode(bad, corrupt, 3)).status).toBe(Z_DATA_ERROR);
  expect(await cpu.call(end, [bad])).toBe(Z_OK);
});

test("negative windowBits decodes a chunked raw DEFLATE stream", async () => {
  const strm = await initialized(-15);
  const result = await decode(strm, deflateSync(payload), 1);
  expect(result.status).toBe(Z_STREAM_END);
  expect(result.output).toEqual(payload);
  expect(await cpu.call(end, [strm])).toBe(Z_OK);
});

test("crc32 returns an unsigned z_ulong on both ABIs", async () => {
  const crc = lookupHost("crc32", "libz.so")!;
  const source = mem.hostStr("123456789");
  expect((await cpu.call(crc, [0, source, 9])) >>> 0).toBe(0xcbf43926);
  expect(cpu.ret1).toBe(0);

  setA64(false);
  const cpu32 = new Cpu(mainThread, "zlib 32 test");
  expect((await cpu32.call(crc, [0, source, 9])) >>> 0).toBe(0xcbf43926);
});
