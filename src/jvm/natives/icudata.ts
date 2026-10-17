// The ICU data as ICU4C reads it: items of the common data file, for natives that answer from the
// data without ICU4J's loaders.
import { PLATFORM_DATA } from "../bootclasspath.ts";
import { vfs } from "../../shell/vfs.ts";
import { readFully } from "../../shell/lazyfile.ts";

const ICU_DATA = Object.keys(PLATFORM_DATA).find((path) => path.endsWith(".dat"))!;
export const icuRead = async (at: number, length: number) => {
  const bytes = await readFully(vfs.source(ICU_DATA)!, at, length);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};
export const cString = (view: DataView, at: number) => { let s = ""; for (let c; (c = view.getUint8(at)); at++) s += String.fromCharCode(c); return s; };
/** udata_open: an item of the common data, found in its table of contents, as its header's offset */
export async function icuItem(name: string): Promise<number> {
  const header = (await icuRead(0, 2)).getUint16(0, true), first = await icuRead(header, 12), count = first.getUint32(0, true);
  const toc = await icuRead(0, header + first.getUint32(8, true)), path = `${ICU_DATA.slice(ICU_DATA.lastIndexOf("/") + 1, -4)}/${name}`;
  for (let i = 0; i < count; i++)
    if (cString(toc, header + toc.getUint32(header + 4 + 8 * i, true)) === path) return header + toc.getUint32(header + 8 + 8 * i, true);
  throw new Error(`no ${path} in ${ICU_DATA}`);
}
