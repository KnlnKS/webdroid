// Compiled app code persisted across launches: the files of an app build (link/apps.ts) in OPFS, or in Cache Storage where
// OPFS is not available, under a key made of the app's dex files and the platform build. Loaded before the launch; a key whose platform build or dex files changed finds nothing and
// the old entry is evicted when space is needed. The store is bounded: an entry larger than `entry` is not kept, and the least recently used entries go when the total passes `total`.
import { APP_VERSION, VERSION, type AotStore, type AppIndex, type Numbering, type UnitHeader } from "../link/aot.ts";
import { compileBytes } from "../link/module.ts";
import type { DexFile } from "../../jvm/dex.ts";
import { COMPILED_CODE_DIR } from "../../shell/hostfs.ts";

/** where the files live; paths are "<key>/<file>" and "meta.json" */
export interface FileBackend {
  read(path: string): Promise<Uint8Array | undefined>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}
const LIMITS = { entry: 256 << 20, total: 1024 << 20 };
/** `clock` counts uses, so that the order of use does not depend on the time resolution */
interface Meta { clock: number; entries: Record<string, { files: Record<string, number>; used: number }> }

export class Persist {
  private fs: FileBackend; private limits;
  constructor(fs: FileBackend, limits = LIMITS) { this.fs = fs; this.limits = limits; }
  private async meta(): Promise<Meta> {
    const raw = await this.fs.read("meta.json");
    try { return raw ? JSON.parse(new TextDecoder().decode(raw)) as Meta : { clock: 0, entries: {} }; } catch { return { clock: 0, entries: {} }; }
  }
  private saveMeta(meta: Meta): Promise<void> { return this.fs.write("meta.json", new TextEncoder().encode(JSON.stringify(meta))); }

  /** the files saved under `key`, or undefined: not saved, evicted, or damaged (which removes it) */
  async load(key: string): Promise<Map<string, Uint8Array> | undefined> {
    const meta = await this.meta(), entry = meta.entries[key];
    if (!entry) return undefined;
    const read = await Promise.all(Object.entries(entry.files).map(async ([name, size]) => [name, size, await this.fs.read(`${key}/${name}`).catch(() => undefined)] as const));
    const files = new Map<string, Uint8Array>();
    for (const [name, size, bytes] of read) {
      if (bytes?.length !== size) { await this.evict(meta, key); return undefined; }
      files.set(name, bytes);
    }
    entry.used = ++meta.clock;
    await this.saveMeta(meta);
    return files;
  }
  /** keeps `files` under `key`, making room by evicting the entries used least recently; false if they are too large to keep */
  async save(key: string, files: [string, Uint8Array][]): Promise<boolean> {
    const size = files.reduce((n, [, b]) => n + b.length, 0);
    if (size > this.limits.entry) return false;
    const meta = await this.meta();
    if (meta.entries[key]) await this.evict(meta, key);
    const total = () => Object.values(meta.entries).reduce((n, e) => n + Object.values(e.files).reduce((a, b) => a + b, 0), 0);
    while (total() + size > this.limits.total) {
      const oldest = Object.entries(meta.entries).sort((a, b) => a[1].used - b[1].used)[0];
      if (!oldest) break;
      await this.evict(meta, oldest[0]);
    }
    // the entry is listed once its files are all written, so a launch that ends in between leaves files nothing reads
    for (const [name, bytes] of files) await this.fs.write(`${key}/${name}`, bytes);
    meta.entries[key] = { files: Object.fromEntries(files.map(([name, b]) => [name, b.length])), used: ++meta.clock };
    await this.saveMeta(meta);
    return true;
  }
  /** what a process numbered before its app's code arrived, under platform build `platform` (boot.ts): a small file outside the bounded entries */
  async prefix(platform: string): Promise<Numbering | undefined> {
    const raw = await this.fs.read(`prefix-${platform}.json`).catch(() => undefined);
    try { return raw && JSON.parse(new TextDecoder().decode(raw)) as Numbering; } catch { return undefined; }
  }
  savePrefix(platform: string, n: Numbering): Promise<void> { return this.fs.write(`prefix-${platform}.json`, new TextEncoder().encode(JSON.stringify(n))); }
  private async evict(meta: Meta, key: string): Promise<void> {
    const entry = meta.entries[key];
    delete meta.entries[key];
    await this.saveMeta(meta);
    if (entry) for (const name of Object.keys(entry.files)) await this.fs.remove(`${key}/${name}`).catch(() => {});
  }
}

/** the key of the app build for dex files and a platform build: a different dex, platform build or build format finds no entry */
export async function appKey(dexes: Iterable<DexFile>, platform: string): Promise<string> {
  const text = [APP_VERSION, platform, ...[...dexes].map((d) => d.id)].join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest).toHex().slice(0, 32);
}

/** a saved app build ready to attach: its index and its code modules compiled (off the main thread) */
export class SavedBuild implements AotStore {
  readonly index: AppIndex;
  private modules = new Map<string, WebAssembly.Module>();
  private constructor(index: AppIndex) { this.index = index; }
  static async open(files: Map<string, Uint8Array>): Promise<SavedBuild | undefined> {
    const raw = files.get("index.json");
    if (!raw) return undefined;
    let build: SavedBuild;
    try {
      const index = JSON.parse(new TextDecoder().decode(raw)) as AppIndex;
      if (index.version !== APP_VERSION) return undefined;
      build = new SavedBuild(index);
      await Promise.all([...files].filter(([name]) => name.endsWith(".wasm")).map(async ([name, bytes]) => {
        const mod = await compileBytes(bytes);
        const section = WebAssembly.Module.customSections(mod, "aot")[0];
        if (!section) throw new Error("saved module header missing");
        const header = JSON.parse(new TextDecoder().decode(section)) as UnitHeader;
        if (header.version !== VERSION) throw new Error("saved module format mismatch");
        build.modules.set(name, mod);
      }));
    } catch { return undefined; }
    return build;
  }
  get(file: string): WebAssembly.Module | undefined { return this.modules.get(file); }
}

/** the files to keep of a build: its index and its modules */
export const buildFiles = (build: { index: AppIndex; files: [string, Uint8Array][] }): [string, Uint8Array][] => [["index.json", new TextEncoder().encode(JSON.stringify(build.index))], ...build.files];

export const memoryBackend = (): FileBackend & { files: Map<string, Uint8Array> } => {
  const files = new Map<string, Uint8Array>();
  return { files, read: async (p) => files.get(p), write: async (p, b) => { files.set(p, b.slice()); }, remove: async (p) => { files.delete(p); } };
};

async function opfsBackend(): Promise<FileBackend | undefined> {
  const root = await navigator.storage?.getDirectory?.();
  if (!root) return undefined;
  const dir = await root.getDirectoryHandle(COMPILED_CODE_DIR, { create: true });
  const split = (path: string) => { const i = path.indexOf("/"); return i < 0 ? [undefined, path] as const : [path.slice(0, i), path.slice(i + 1)] as const; };
  const parent = async (path: string, create: boolean) => { const [d, f] = split(path); return [d ? await dir.getDirectoryHandle(d, { create }) : dir, f] as const; };
  return {
    read: async (path) => {
      try { const [d, f] = await parent(path, false); return new Uint8Array(await (await (await d.getFileHandle(f)).getFile()).arrayBuffer()); } catch { return undefined; }
    },
    write: async (path, bytes) => {
      const [d, f] = await parent(path, true), w = await (await d.getFileHandle(f, { create: true })).createWritable();
      await w.write(bytes as BufferSource); await w.close();
    },
    remove: async (path) => { const [d, f] = await parent(path, false); await d.removeEntry(f); },
  };
}
async function cacheBackend(): Promise<FileBackend | undefined> {
  if (typeof caches === "undefined") return undefined;
  const cache = await caches.open("wd-wasm-apps"), url = (path: string) => `https://wd-wasm-apps.invalid/${path}`;
  return {
    read: async (path) => { const r = await cache.match(url(path)); return r ? new Uint8Array(await r.arrayBuffer()) : undefined; },
    write: async (path, bytes) => { await cache.put(url(path), new Response(bytes as BodyInit)); },
    remove: async (path) => { await cache.delete(url(path)); },
  };
}
/** the browser's store for compiled app code: OPFS, else Cache Storage; undefined where neither works (a private window, a worker without them) */
export async function openPersist(): Promise<Persist | undefined> {
  try { const fs = await opfsBackend() ?? await cacheBackend(); return fs && new Persist(fs); } catch { return undefined; }
}
