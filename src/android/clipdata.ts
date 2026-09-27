import { JObj, rt, driven, fieldGetters, fieldSetters, type Gen } from "../jvm/runtime";
import { jarray } from "../jvm/abi";
import type { JIntent } from "./intent";
import { vcall } from "../jvm/natives/jlang";
import { type JParcel, writeInt, readInt, writeString8, readString8, parcelCreator } from "./parcel";
import { writeText, readText } from "./text";
import { JBundle } from "./os";
import type { JUri } from "./net";

class JClipDescription extends JObj { label: unknown = null; types: string[] = []; extras: JBundle | null = null; time = 0n; styled = 0; classification = 1; confidence = new JBundle(); }
const matches = (type: string, desired: string) => desired === "*/*" || type === desired || desired.endsWith("/*") && type.startsWith(desired.slice(0, -1));
async function readDescription(parcel: JParcel): Promise<JClipDescription> {
  rt.link("android/content/ClipDescription"); const desc = new JClipDescription();
  desc.label = await readText(parcel); desc.types = await vcall(parcel, "createStringArray", "()[Ljava/lang/String;");
  desc.extras = await vcall(parcel, "readPersistableBundle", "()Landroid/os/PersistableBundle;");
  desc.time = await vcall(parcel, "readLong", "()J"); desc.styled = readInt(parcel); desc.classification = readInt(parcel);
  desc.confidence = await vcall(parcel, "readBundle", "()Landroid/os/Bundle;"); return desc;
}
rt.register({ name: "android/content/ClipDescription", ctor: JClipDescription, ifaces: ["android/os/Parcelable"],
statics: { get CREATOR() { return parcelCreator("android/content/ClipDescription", readDescription); } }, methods: {
  "describeContents()I": () => 0,
  "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JClipDescription, parcel: JParcel): Gen {
    yield writeText(this.label, parcel); yield vcall(parcel, "writeStringArray", "([Ljava/lang/String;)V", this.types);
    yield vcall(parcel, "writePersistableBundle", "(Landroid/os/PersistableBundle;)V", this.extras);
    yield vcall(parcel, "writeLong", "(J)V", this.time); writeInt(parcel, this.styled); writeInt(parcel, this.classification);
    yield vcall(parcel, "writeBundle", "(Landroid/os/Bundle;)V", this.confidence);
  }),
  "<init>(Ljava/lang/CharSequence;[Ljava/lang/String;)V": function (this: JClipDescription, label: unknown, types: string[]) {
    if (!types) throw rt.mkThrowable("java/lang/NullPointerException", "mimeTypes");
    this.label = label; this.types = [...types];
  },
  ...fieldGetters({ "getLabel()Ljava/lang/CharSequence;": "label", "getExtras()Landroid/os/PersistableBundle;": "extras", "getTimestamp()J": "time" }),
  ...fieldSetters({ "setExtras(Landroid/os/PersistableBundle;)V": "extras" }),
  "getMimeTypeCount()I": function (this: JClipDescription) { return this.types.length; },
  "getMimeType(I)Ljava/lang/String;": function (this: JClipDescription, index: number) { if (index < 0 || index >= this.types.length) rt.aio(index, this.types.length); return this.types[index]; },
  "hasMimeType(Ljava/lang/String;)Z": function (this: JClipDescription, type: string) { return +this.types.some(t => matches(t, type)); },
  "filterMimeTypes(Ljava/lang/String;)[Ljava/lang/String;": function (this: JClipDescription, type: string) {
    const types = this.types.filter(t => matches(t, type)); return types.length ? jarray(types, "Ljava/lang/String;") : null;
  },
  "static compareMimeTypes(Ljava/lang/String;Ljava/lang/String;)Z": (type: string, desired: string) => +matches(type, desired),
} });
class JClipItem extends JObj { text: unknown = null; html: string | null = null; intent: JIntent | null = null; uri: JUri | null = null; sender: unknown = null; activity: unknown = null; links: unknown = null; }
rt.register({ name: "android/content/ClipData$Item", ctor: JClipItem, methods: {
  "<init>(Ljava/lang/CharSequence;)V": function (this: JClipItem, text: unknown) { this.text = text; },
  "<init>(Landroid/content/Intent;)V": function (this: JClipItem, intent: JIntent) { this.intent = intent; },
  "<init>(Landroid/net/Uri;)V": function (this: JClipItem, uri: JUri) { this.uri = uri; },
  "<init>(Ljava/lang/CharSequence;Ljava/lang/String;)V": function (this: JClipItem, text: unknown, html: string) { this.text = text; this.html = html; },
  "<init>(Ljava/lang/CharSequence;Landroid/content/Intent;Landroid/net/Uri;)V": function (this: JClipItem, text: unknown, intent: JIntent, uri: JUri) {
    Object.assign(this, { text, intent, uri });
  },
  "<init>(Ljava/lang/CharSequence;Ljava/lang/String;Landroid/content/Intent;Landroid/net/Uri;)V": function (this: JClipItem, text: unknown, html: string, intent: JIntent, uri: JUri) {
    Object.assign(this, { text, html, intent, uri });
  },
  // AOSP's order, less its attempt to read a content: URI as a text stream first
  "coerceToText(Landroid/content/Context;)Ljava/lang/CharSequence;": function (this: JClipItem) {
    return this.text ?? this.html ?? (this.uri ? this.uri.uri : this.intent ? vcall(this.intent, "toUri", "(I)Ljava/lang/String;", 1) : "");
  },
  ...fieldGetters({ "getText()Ljava/lang/CharSequence;": "text", "getHtmlText()Ljava/lang/String;": "html",
    "getIntent()Landroid/content/Intent;": "intent", "getUri()Landroid/net/Uri;": "uri" }),
} });
export class JClipData extends JObj { description = new JClipDescription(); items: JClipItem[] = []; icon: unknown = null; }
function clip(label: unknown, type: string, item: JClipItem): JClipData {
  rt.link("android/content/ClipData$Item"); rt.link("android/content/ClipDescription");
  const data = new JClipData(); data.description.label = label; data.description.types = [type]; data.items.push(item); return data;
}
export function plainTextClip(label: unknown, text: unknown): JClipData { return clip(label, "text/plain", Object.assign(new JClipItem(), { text })); }
const itemObjects = [["intent", "android/content/Intent"], ["sender", "android/content/IntentSender"], ["uri", "android/net/Uri"],
  ["activity", "android/content/pm/ActivityInfo"], ["links", "android/view/textclassifier/TextLinks"]] as const;
async function readTyped(parcel: JParcel, type: string): Promise<unknown> {
  if (!readInt(parcel)) return null;
  return vcall(rt.link(type).ctor.s$CREATOR, "createFromParcel", "(Landroid/os/Parcel;)Ljava/lang/Object;", parcel);
}
export async function readClipData(parcel: JParcel): Promise<JClipData> {
  rt.link("android/content/ClipData"); rt.link("android/content/ClipData$Item");
  const clip = new JClipData(); clip.description = await readDescription(parcel); clip.icon = await readTyped(parcel, "android/graphics/Bitmap");
  const count = readInt(parcel);
  if (count < 0 || count > (parcel.size - parcel.pos) / 4) throw rt.mkThrowable("android/os/BadParcelableException", "Invalid ClipData item count");
  for (let i = 0; i < count; i++) {
    const item = new JClipItem(); item.text = await readText(parcel); item.html = readString8(parcel);
    for (const [field, type] of itemObjects) Object.assign(item, { [field]: await readTyped(parcel, type) });
    clip.items.push(item);
  }
  return clip;
}
rt.register({ name: "android/content/ClipData", ctor: JClipData, ifaces: ["android/os/Parcelable"],
statics: { get CREATOR() { return parcelCreator("android/content/ClipData", readClipData); } }, methods: {
  "describeContents()I": () => 0,
  "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JClipData, parcel: JParcel, flags: number): Gen {
    yield vcall(this.description, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, flags);
    yield vcall(parcel, "writeTypedObject", "(Landroid/os/Parcelable;I)V", this.icon, flags);
    writeInt(parcel, this.items.length);
    for (const item of this.items) {
      yield writeText(item.text, parcel); writeString8(parcel, item.html);
      for (const [field] of itemObjects) yield vcall(parcel, "writeTypedObject", "(Landroid/os/Parcelable;I)V", item[field], flags);
    }
  }),
  "<init>(Ljava/lang/CharSequence;[Ljava/lang/String;Landroid/content/ClipData$Item;)V": function (this: JClipData, label: unknown, types: string[], item: JClipItem) {
    if (!types || !item) throw rt.mkThrowable("java/lang/NullPointerException", null);
    this.description.label = label; this.description.types = [...types]; this.items = [item];
  },
  "static newIntent(Ljava/lang/CharSequence;Landroid/content/Intent;)Landroid/content/ClipData;": (label: unknown, intent: JIntent) => clip(label, "text/vnd.android.intent", Object.assign(new JClipItem(), { intent })),
  "static newPlainText(Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Landroid/content/ClipData;": plainTextClip,
  "static newHtmlText(Ljava/lang/CharSequence;Ljava/lang/CharSequence;Ljava/lang/String;)Landroid/content/ClipData;": (label: unknown, text: unknown, html: string | null) =>
    clip(label, "text/html", Object.assign(new JClipItem(), { text, html })),
  "static newRawUri(Ljava/lang/CharSequence;Landroid/net/Uri;)Landroid/content/ClipData;": (label: unknown, uri: JUri) => clip(label, "text/uri-list", Object.assign(new JClipItem(), { uri })),
  "getDescription()Landroid/content/ClipDescription;": function (this: JClipData) { return this.description; },
  "getItemCount()I": function (this: JClipData) { return this.items.length; },
  "getItemAt(I)Landroid/content/ClipData$Item;": function (this: JClipData, index: number) { if (index < 0 || index >= this.items.length) rt.aio(index, this.items.length); return this.items[index]; },
  "addItem(Landroid/content/ClipData$Item;)V": function (this: JClipData, item: JClipItem) {
    if (!item) throw rt.mkThrowable("java/lang/NullPointerException", "item"); this.items.push(item);
  },
} });
