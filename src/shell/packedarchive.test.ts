import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packArchive } from "../../scripts/system-packages";
import { PackedArchive, sha256 } from "./packedarchive";
import { centralDir, entryBytes } from "../jvm/natives/jzip";
import { readFully } from "./lazyfile";

test("prepared packages defer DEX, share decoded bytes and reconstruct the signed APK exactly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webdroid-packed-"));
  const bytes = new Uint8Array(await Bun.file(new URL("../../apks/FitNotes.apk", import.meta.url)).arrayBuffer());
  const requested: string[] = [];
  let corrupt = "";
  const server = Bun.serve({ port: 0, fetch(req) {
    const url = new URL(req.url), name = url.pathname.slice(1); requested.push(name + url.search);
    if (name === corrupt) return new Response(new Uint8Array([1, 2, 3]));
    return new Response(Bun.file(join(directory, name)), { headers: name.endsWith(".gz") && !url.search ? { "content-encoding": "gzip" } : {} });
  } });
  try {
    const index = await packArchive(bytes, directory), packed = new PackedArchive(index, server.url.href);
    await packed.prepare();
    expect(requested).toEqual([index.bootstrap.file]);
    expect(Object.keys(packed.zip)).not.toContain("classes.dex");
    const code = await Promise.all([packed.entry("classes.dex"), packed.entry("classes.dex")]);
    expect(code[0]).toBe(code[1]);
    expect(requested.filter((n) => n === index.entries["classes.dex"].file)).toHaveLength(1);
    const child = new PackedArchive(index, server.url.href, packed);
    await child.prepare(true);
    expect((await child.entry("classes.dex"))?.buffer).toBe(code[0]?.buffer);
    const zip = centralDir(bytes);
    expect(packed.zip["AndroidManifest.xml"]).toEqual(entryBytes(bytes, zip.get("AndroidManifest.xml")!));
    expect(code[0]).toEqual(entryBytes(bytes, zip.get("classes.dex")!));
    const reconstructed = await readFully(packed);
    expect(await sha256(reconstructed)).toBe(index.sha256);
    expect(reconstructed).toEqual(bytes);
    for (const [start, length] of [[0, 31], [97, 401], [bytes.length - 100, 101]])
      expect(await packed.read(start, length)).toEqual(bytes.subarray(start, start + length));
    corrupt = index.entries["classes.dex"].file;
    await expect(new PackedArchive(index, server.url.href).entry("classes.dex")).rejects.toThrow("digest mismatch");
  } finally { await server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 30000);
