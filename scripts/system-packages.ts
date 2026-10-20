import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { gzipSync, zipSync } from "fflate";
import { centralDir, entryBytes, localStart } from "../src/zip.ts";
import { parsePackageArchive } from "../src/android/packagearchive.ts";
import { verifyApkSignature } from "../src/android/apksignature.ts";
import { SYSTEM_PACKAGES, SYSTEM_PACKAGE_RELEASE } from "../src/shell/system-packages.ts";
import type { PackedArchiveIndex } from "../src/shell/packedarchive.ts";
import { isDexEntry } from "../src/jvm/dex.ts";
import { writeWhole } from "./generated.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function packArchive(bytes: Uint8Array, directory: string): Promise<PackedArchiveIndex> {
  await verifyApkSignature(bytes);
  const archive = await parsePackageArchive(bytes), entries = centralDir(bytes);
  await mkdir(directory, { recursive: true });
  const write = async (data: Uint8Array, extension: string): Promise<string> => {
    const file = hash(data) + extension;
    if (!existsSync(join(directory, file))) writeWhole(join(directory, file), data);
    return file;
  };
  const index: PackedArchiveIndex = { version: 1, pkg: archive.pkg, sha256: hash(bytes), size: bytes.length,
    certificates: archive.certificates.map((c) => Buffer.from(c).toString("hex")),
    bootstrap: { file: "", size: 0, sha256: "" }, entries: {}, spans: [] };
  const bootstrap: Record<string, Uint8Array> = {}, headers: Uint8Array[] = [];
  let position = 0, headerOffset = 0;
  const gap = (end: number) => {
    if (end <= position) return;
    const data = bytes.subarray(position, end); headers.push(data);
    index.spans.push([position, data.length, "", headerOffset]); headerOffset += data.length;
  };
  for (const entry of [...entries.values()].sort((a, b) => a.off - b.off)) {
    const start = localStart(bytes, entry);
    if (start < position || start + entry.csize > bytes.length) throw new Error("Overlapping ZIP entry: " + entry.name);
    gap(start);
    const raw = bytes.subarray(start, start + entry.csize), decoded = entryBytes(bytes, entry);
    let payload = raw, skip = 0, extension = ".bin";
    if (entry.method === 8) {
      payload = new Uint8Array(raw.length + 18); payload.set([31, 139, 8, 0, 0, 0, 0, 0, 0, 255]); payload.set(raw, 10);
      payload.set(gzipSync(decoded, { level: 0, mtime: 0 }).subarray(-8), payload.length - 8);
      skip = 10; extension = ".gz";
    } else if (entry.method !== 0) throw new Error("Unsupported ZIP compression");
    const file = await write(payload, extension);
    index.spans.push([start, raw.length, file, skip]); position = start + raw.length;
    index.entries[entry.name] = { file, size: decoded.length, sha256: hash(decoded) };
    if (!isDexEntry(entry.name) && !entry.name.startsWith("lib/")) bootstrap[entry.name] = decoded;
  }
  gap(bytes.length);
  const metadata = await write(new Uint8Array(Buffer.concat(headers)), ".bin");
  for (const span of index.spans) if (!span[2]) span[2] = metadata;
  const boot = zipSync(bootstrap, { level: 0, mtime: new Date(1980, 0, 1) });
  index.bootstrap = { file: await write(gzipSync(boot, { level: 9, mtime: 0 }), ".gz"), size: boot.length, sha256: hash(boot) };
  return index;
}
export async function prepareSystemPackages(
  source = process.env.WEBDROID_PACKAGE_CACHE ?? join(homedir(), ".cache/webdroid/packages"),
  directory = new URL("../vendor/microg/", import.meta.url).pathname,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const files = new Set(await readdir(directory));
  for (const spec of SYSTEM_PACKAGES) {
    const file = spec.file.replace(/\.apk$/, ".json"), target = join(directory, file);
    if (files.has(file)) {
      const bytes = new Uint8Array(await readFile(target));
      if (hash(bytes) === spec.indexSha256) {
        const index: PackedArchiveIndex = JSON.parse(new TextDecoder().decode(bytes));
        if (files.has(index.bootstrap.file) && Object.values(index.entries).every((e) => files.has(e.file)) && index.spans.every((s) => files.has(s[2]))) continue;
      }
    }
    const cached = join(source, spec.file);
    let bytes = existsSync(cached) ? new Uint8Array(await readFile(cached)) : null;
    if (!bytes || hash(bytes) !== spec.sha256) {
      const response = await fetch(SYSTEM_PACKAGE_RELEASE + spec.file);
      if (!response.ok) throw new Error(`System package download failed: ${spec.file}: ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
      if (hash(bytes) !== spec.sha256) throw new Error("System package digest mismatch: " + spec.file);
      await mkdir(source, { recursive: true });
      writeWhole(cached, bytes);
    }
    const index = await packArchive(bytes, directory), json = JSON.stringify(index), digest = hash(new TextEncoder().encode(json));
    if (digest !== spec.indexSha256) throw new Error(`Generated system package index differs from pinned output: ${spec.file} (${digest})`);
    writeWhole(target, json);
    console.log("[system packages] prepared", spec.pkg);
  }
}
if (import.meta.main) await prepareSystemPackages(process.argv[2]);
