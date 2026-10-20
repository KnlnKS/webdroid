// A format as the media natives keep one (stagefright's AMessage), and its crossing to and from
// the Map<String, Object> Java's MediaFormat wraps, its values tagged with MediaFormat's types.
import { driven, type Gen, type JObj } from "../jvm/runtime.ts";
import { newObj, vcall, after } from "../jvm/natives/jentry.ts";
import { boxDesc, boxFloat, boxInt, boxLong, unbox } from "../jvm/natives/jbox.ts";
import { isBuffer, remainingBytes, readRemainingBytes, directCopy, type JBuffer } from "../jvm/natives/jnio.ts";

export const TYPE_INTEGER = 1, TYPE_LONG = 2, TYPE_FLOAT = 3, TYPE_STRING = 4, TYPE_BYTE_BUFFER = 5;
type FormatValue = number | bigint | string | JBuffer;
export class NativeFormat {
  readonly values: Map<string, { type: number; value: FormatValue }>;
  constructor(from?: NativeFormat) { this.values = new Map(from?.values); }
  set(key: string, type: number, value: FormatValue): this { this.values.set(key, { type, value }); return this; }
  /** the value under `key` if it has `type` */
  get(key: string, type: number): FormatValue | undefined { const e = this.values.get(key); return e?.type === type ? e.value : undefined; }
  number(key: string, fallback: number): number { const v = this.values.get(key)?.value; return typeof v === "number" ? v : fallback; }
  string(key: string): string { const v = this.values.get(key)?.value; return typeof v === "string" ? v : ""; }
  buffer(key: string): JBuffer | undefined { const v = this.values.get(key)?.value; return isBuffer(v) ? v as JBuffer : undefined; }
}
/** An access unit in the MP4 framing (ISO/IEC 14496-15: each NAL unit after its `nalLength`-byte length) as
 *  Annex B, or null when such lengths do not frame NAL units exactly. An empty unit is dropped, as
 *  MPEG4Extractor drops one. */
export function annexB(data: Uint8Array, nalLength = 4): Uint8Array | null {
  const length = (at: number) => { let n = 0; for (let i = 0; i < nalLength; i++) n = n * 256 + data[at + i]; return n; };
  let size = 0;
  for (let at = 0, n = 0; at < data.length; at += nalLength + n) {
    if (at + nalLength > data.length) return null;
    if ((n = length(at)) && (at + nalLength + n > data.length || data[at + nalLength] & 0x80)) return null;
    if (n) size += 4 + n;
  }
  const out = new Uint8Array(size);
  for (let at = 0, to = 0, n = 0; at < data.length; at += nalLength + n) {
    if (!(n = length(at))) continue;
    out[to + 3] = 1;
    out.set(data.subarray(at + nalLength, at + nalLength + n), to + 4);
    to += 4 + n;
  }
  return out;
}
/** codec-specific data's bytes, as a decoder takes them */
export const csdBytes = (format: NativeFormat, key: string): Uint8Array | undefined => { const b = format.buffer(key); return b && remainingBytes(b); };
const TYPE_OF_BOX: Record<string, number> = { I: TYPE_INTEGER, J: TYPE_LONG, F: TYPE_FLOAT };
/** the keys and values MediaCodec.configure passes down; others are dropped, as the JNI's ConvertKeyValueArraysToMessage does */
function formatFromJava(keys: string[] | null, values: unknown[] | null): NativeFormat {
  const format = new NativeFormat();
  for (let i = 0; i < (keys?.length ?? 0); i++) {
    const v = values![i], box = boxDesc(v);
    if (typeof v === "string") format.set(keys![i], TYPE_STRING, v);
    else if (box && TYPE_OF_BOX[box]) format.set(keys![i], TYPE_OF_BOX[box], unbox(v)!);
    else if (isBuffer(v)) format.set(keys![i], TYPE_BYTE_BUFFER, v as JBuffer);
  }
  return format;
}
/** ConvertKeyValueArraysToMessage owns a copy of each ByteBuffer's remaining bytes. */
export function copiedFormatFromJava(keys: string[] | null, values: unknown[] | null): NativeFormat | Promise<NativeFormat> {
  const format = formatFromJava(keys,values);
  let pending: Promise<unknown>[] | undefined;
  for (const [key,{type,value}] of format.values) if (type === TYPE_BYTE_BUFFER) {
    const copy = after(readRemainingBytes(value as JBuffer),bytes => after(directCopy(bytes.slice()),buffer => format.set(key,type,buffer)));
    if (copy instanceof Promise) (pending ??= []).push(copy);
  }
  return pending ? Promise.all(pending).then(() => format) : format;
}
/** a HashMap<String, Object>, as the JNI's ConvertMessageToMap makes one */
export const formatToJava = driven(function* formatToJava$(format: NativeFormat): Gen<JObj> {
  const map: JObj = yield newObj("java/util/HashMap");
  for (const [key, { type, value }] of format.values) {
    const boxed = type === TYPE_INTEGER ? boxInt(value as number) : type === TYPE_LONG ? boxLong(value as bigint) : type === TYPE_FLOAT ? boxFloat(value as number) : value;
    yield vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", key, boxed);
  }
  return map;
});
