import { PLATFORM_DATA } from "../jvm/bootclasspath";
import { vfs } from "./vfs";
import { RangeFile, type FileSource } from "./lazyfile";

/** the reference build's ICU data and tzdata at their device paths, read on first use */
export function mountPlatformData(source = (file: string, size: number): FileSource => new RangeFile(`/vendor/aosp/${file}`, size, 1 << 20, 4)): void {
  for (const [path, [file, size]] of Object.entries(PLATFORM_DATA)) vfs.mount(path, source(file, size));
}
