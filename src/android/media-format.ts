import { JObj, rt, type NativeSpec } from "../jvm/runtime";
import type { JBuffer } from "../jvm/natives/jnio";

type Value = number | bigint | string | JBuffer | null;
export class JMediaFormat extends JObj {
  values = new Map<string, { type: number; value: Value }>();
  get(name: string, type: number, fallback?: Value): Value {
    const entry = this.values.get(name);
    if (!entry || entry.value === null) {
      if (fallback !== undefined) return fallback;
      if (type >= 4) return null;
      return rt.npe();
    }
    if (entry.type !== type) throw rt.mkThrowable("java/lang/ClassCastException", name);
    return entry.value;
  }
}
function format(mime: string, entries: [string, number, Value][]): JMediaFormat {
  const result = new JMediaFormat();
  result.values.set("mime", { type: 4, value: mime });
  for (const [key, type, value] of entries) result.values.set(key, { type, value });
  return result;
}
const methods: NonNullable<NativeSpec["methods"]> = {
  "<init>()V": function () {},
  "<init>(Landroid/media/MediaFormat;)V": function (this: JMediaFormat, source: JMediaFormat) { this.values = new Map(source.values); },
  "containsKey(Ljava/lang/String;)Z": function (this: JMediaFormat, key: string) { return +this.values.has(key); },
  "removeKey(Ljava/lang/String;)V": function (this: JMediaFormat, key: string) { if (!key.startsWith("feature-")) this.values.delete(key); },
  "removeFeature(Ljava/lang/String;)V": function (this: JMediaFormat, key: string) { this.values.delete("feature-" + key); },
  "getValueTypeForKey(Ljava/lang/String;)I": function (this: JMediaFormat, key: string) {
    const entry = this.values.get(key); return entry?.value == null ? 0 : entry.type;
  },
  "setFeatureEnabled(Ljava/lang/String;Z)V": function (this: JMediaFormat, key: string, enabled: number) { this.values.set("feature-" + key, { type: 1, value: +!!enabled }); },
  "containsFeature(Ljava/lang/String;)Z": function (this: JMediaFormat, key: string) { return +this.values.has("feature-" + key); },
  "getFeatureEnabled(Ljava/lang/String;)Z": function (this: JMediaFormat, key: string) {
    if (this.values.get("feature-" + key)?.value == null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "feature is not specified");
    return +!!this.get("feature-" + key, 1);
  },
  "static createVideoFormat(Ljava/lang/String;II)Landroid/media/MediaFormat;": (mime: string, width: number, height: number) => format(mime, [["width", 1, width], ["height", 1, height]]),
  "static createAudioFormat(Ljava/lang/String;II)Landroid/media/MediaFormat;": (mime: string, rate: number, channels: number) => format(mime, [["sample-rate", 1, rate], ["channel-count", 1, channels]]),
  "static createSubtitleFormat(Ljava/lang/String;Ljava/lang/String;)Landroid/media/MediaFormat;": (mime: string, language: string | null) => format(mime, [["language", 4, language]]),
};
for (const [name, desc, type] of [["Integer", "I", 1], ["Long", "J", 2], ["Float", "F", 3], ["String", "Ljava/lang/String;", 4], ["ByteBuffer", "Ljava/nio/ByteBuffer;", 5]] as const) {
  methods[`set${name}(Ljava/lang/String;${desc})V`] = function (this: JMediaFormat, key: string, value: Value) { this.values.set(key, { type, value }); };
  methods[`get${name}(Ljava/lang/String;)${desc}`] = function (this: JMediaFormat, key: string) { return this.get(key, type); };
  methods[`get${name}(Ljava/lang/String;${desc})${desc}`] = function (this: JMediaFormat, key: string, fallback: Value) { return this.get(key, type, fallback); };
}
rt.register({ name: "android/media/MediaFormat", ctor: JMediaFormat, methods });
