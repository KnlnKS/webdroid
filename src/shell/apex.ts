import { PLATFORM_DATA } from "../jvm/bootclasspath.ts";
import { vfs } from "./vfs.ts";
import { RangeFile, type FileSource } from "./lazyfile.ts";

const sources = new Map<string, FileSource>();
/** the reference build's ICU and time zone files at their device paths, read on first use. A large
 *  one (the ICU data) is mapped and read by page, so it is fetched in pages; a small one whole. */
export function mountPlatformData(source = (path: string, size: number): FileSource =>
  new RangeFile(`/vendor/aosp${path}`, size, size > 1 << 20 ? 1 << 16 : 1 << 20, 4)): void {
  for (const [path, size] of Object.entries(PLATFORM_DATA)) {
    let file = sources.get(path);
    if (!file) sources.set(path, file = source(path, size));
    vfs.mount(path, file);
  }
}
