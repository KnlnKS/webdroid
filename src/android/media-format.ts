// A format as the media natives keep one (stagefright's AMessage), and its crossing to and from
// the Map<String, Object> Java's MediaFormat wraps: values tagged MediaFormat.TYPE_INTEGER (1),
// _LONG (2), _FLOAT (3), _STRING (4) and _BYTE_BUFFER (5).
import { driven, type Gen, type JObj } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { boxDesc, boxFloat, boxInt, boxLong, unbox } from "../jvm/natives/jbox";
import { isBuffer, type JBuffer } from "../jvm/natives/jnio";

export type FormatValue = number | bigint | string | JBuffer;
export class NativeFormat {
  values = new Map<string, { type: number; value: FormatValue }>();
  constructor(from?: NativeFormat) { if (from) this.values = new Map(from.values); }
  set(key: string, type: number, value: FormatValue): this { this.values.set(key, { type, value }); return this; }
  number(key: string, fallback: number): number { const v = this.values.get(key)?.value; return typeof v === "number" ? v : fallback; }
  string(key: string): string { const v = this.values.get(key)?.value; return typeof v === "string" ? v : ""; }
  buffer(key: string): JBuffer | undefined { const v = this.values.get(key)?.value; return isBuffer(v) ? v as JBuffer : undefined; }
}
const TYPE_OF_BOX: Record<string, number> = { I: 1, J: 2, F: 3 };
/** the keys and values MediaCodec.configure passes down; others are dropped, as the JNI's ConvertKeyValueArraysToMessage does */
export function formatFromJava(keys: string[] | null, values: unknown[] | null): NativeFormat {
  const format = new NativeFormat();
  for (let i = 0; i < (keys?.length ?? 0); i++) {
    const v = values![i], box = boxDesc(v);
    if (typeof v === "string") format.set(keys![i], 4, v);
    else if (box && TYPE_OF_BOX[box]) format.set(keys![i], TYPE_OF_BOX[box], unbox(v)!);
    else if (isBuffer(v)) format.set(keys![i], 5, v as JBuffer);
  }
  return format;
}
/** a HashMap<String, Object>, as the JNI's ConvertMessageToMap makes one */
export const formatToJava = driven(function* formatToJava$(format: NativeFormat): Gen<JObj> {
  const map: JObj = yield newObj("java/util/HashMap");
  for (const [key, { type, value }] of format.values) {
    const boxed = type === 1 ? boxInt(value as number) : type === 2 ? boxLong(value as bigint) : type === 3 ? boxFloat(value as number) : value;
    yield vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", key, boxed);
  }
  return map;
});
