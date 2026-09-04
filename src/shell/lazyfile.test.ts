import { describe, expect, test } from "bun:test";
import { BytesFile, RangeFile, SliceFile, readFully, type FileSource } from "./lazyfile";

describe("file sources", () => {
  test("a slice maps reads without copying its parent", async () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => i);
    const slice = new SliceFile(new BytesFile(bytes), 4, 8);
    expect(slice.size).toBe(8);
    expect([...await slice.read(2, 3)]).toEqual([6, 7, 8]);
    expect([...await slice.read(7, 9)]).toEqual([11]);
  });

  test("readFully joins partial source reads", async () => {
    const bytes = Uint8Array.from({ length: 12 }, (_, i) => i + 1);
    const source: FileSource = {
      size: bytes.length,
      read(offset, length) { return Promise.resolve(bytes.subarray(offset, offset + Math.min(length, 3))); },
    };
    expect([...await readFully(source, 2, 8)]).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("a remote source requires a Content-Length", async () => {
    const fetcher = async () => new Response(null, { status: 200 });
    expect(RangeFile.open("https://example.invalid/file", fetcher)).rejects.toThrow("no valid Content-Length");
  });

  test("a remote source rejects a mismatched Content-Range", async () => {
    const fetcher = async () => new Response(Uint8Array.of(1, 2, 3, 4), {
      status: 206,
      headers: { "Content-Range": "bytes 4-7/8" },
    });
    const source = new RangeFile("https://example.invalid/file", 8, 4, 1, fetcher);
    expect(source.read(0, 4)).rejects.toThrow("invalid Content-Range");
  });
});
