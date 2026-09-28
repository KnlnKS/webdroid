import { PLATFORM_DATA } from "../jvm/bootclasspath";
import { vfs } from "./vfs";
import { RangeFile, type FileSource } from "./lazyfile";

/** the reference build's ICU and time zone files at their device paths, read on first use */
export function mountPlatformData(source = (path: string, size: number): FileSource => new RangeFile(`/vendor/aosp${path}`, size, 1 << 20, 4)): void {
  for (const [path, size] of Object.entries(PLATFORM_DATA)) vfs.mount(path, source(path, size));
}
