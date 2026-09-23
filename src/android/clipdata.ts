import { JObj, rt } from "../jvm/runtime";
import { jarray } from "../jvm/abi";
import type { JIntent } from "./intent";
import { vcall } from "../jvm/natives/jlang";
import { type JParcel, writeInt, readInt, writeString8, readString8, parcelCreator } from "./parcel";
import { writeText, readText } from "./text";
import { JBundle } from "./os";
import type { JUri } from "./net";

export class JClipDescription extends JObj { label: unknown = null; types: string[] = []; extras: JBundle | null = null; time = 0n; styled = 0; classification = 1; confidence = new JBundle(); }
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
  "writeToParcel(Landroid/os/Parcel;I)V": async function (this: JClipDescription, parcel: JParcel) {
    await writeText(this.label, parcel); await vcall(parcel, "writeStringArray", "([Ljava/lang/String;)V", this.types);
    await vcall(parcel, "writePersistableBundle", "(Landroid/os/PersistableBundle;)V", this.extras);
    await vcall(parcel, "writeLong", "(J)V", this.time); writeInt(parcel, this.styled); writeInt(parcel, this.classification);
    await vcall(parcel, "writeBundle", "(Landroid/os/Bundle;)V", this.confidence);
  },
  "<init>(Ljava/lang/CharSequence;[Ljava/lang/String;)V": function (this: JClipDescription, label: unknown, types: string[]) {
    if (!types) throw rt.mkThrowable("java/lang/NullPointerException", "mimeTypes");
    this.label = label; this.types = [...types];
  },
  "getLabel()Ljava/lang/CharSequence;": function (this: JClipDescription) { return this.label; },
  "getTimestamp()J": function (this: JClipDescription) { return this.time; },
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
  "getText()Ljava/lang/CharSequence;": function (this: JClipItem) { return this.text; },
  "getHtmlText()Ljava/lang/String;": function (this: JClipItem) { return this.html; },
  "getIntent()Landroid/content/Intent;": function (this: JClipItem) { return this.intent; },
  "getUri()Landroid/net/Uri;": function (this: JClipItem) { return this.uri; },
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
  "writeToParcel(Landroid/os/Parcel;I)V": async function (this: JClipData, parcel: JParcel, flags: number) {
    await vcall(this.description, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, flags);
    await vcall(parcel, "writeTypedObject", "(Landroid/os/Parcelable;I)V", this.icon, flags);
    writeInt(parcel, this.items.length);
    for (const item of this.items) {
      await writeText(item.text, parcel); writeString8(parcel, item.html);
      for (const [field] of itemObjects) await vcall(parcel, "writeTypedObject", "(Landroid/os/Parcelable;I)V", item[field], flags);
    }
  },
  "<init>(Ljava/lang/CharSequence;[Ljava/lang/String;Landroid/content/ClipData$Item;)V": function (this: JClipData, label: unknown, types: string[], item: JClipItem) {
    if (!types || !item) throw rt.mkThrowable("java/lang/NullPointerException", null);
    this.description.label = label; this.description.types = [...types]; this.items = [item];
  },
  "static newIntent(Ljava/lang/CharSequence;Landroid/content/Intent;)Landroid/content/ClipData;": (label: unknown, intent: JIntent) => clip(label, "text/vnd.android.intent", Object.assign(new JClipItem(), { intent })),
  "static newPlainText(Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Landroid/content/ClipData;": plainTextClip,
  "static newRawUri(Ljava/lang/CharSequence;Landroid/net/Uri;)Landroid/content/ClipData;": (label: unknown, uri: JUri) => clip(label, "text/uri-list", Object.assign(new JClipItem(), { uri })),
  "getDescription()Landroid/content/ClipDescription;": function (this: JClipData) { return this.description; },
  "getItemCount()I": function (this: JClipData) { return this.items.length; },
  "getItemAt(I)Landroid/content/ClipData$Item;": function (this: JClipData, index: number) { if (index < 0 || index >= this.items.length) rt.aio(index, this.items.length); return this.items[index]; },
  "addItem(Landroid/content/ClipData$Item;)V": function (this: JClipData, item: JClipItem) {
    if (!item) throw rt.mkThrowable("java/lang/NullPointerException", "item"); this.items.push(item);
  },
} });
