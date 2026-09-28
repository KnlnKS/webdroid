import { readClipData, type JClipData } from "./clipdata";
import { JObj, type NativeSpec, rt, fieldGetters, fieldSetters, driven, type Gen } from "../jvm/runtime";
import { JBundle, bundleBox, bundleGet, bundleTyped, INTENT_TYPED, INTENT_TYPES, reportUncaught, PROCESS_NAME } from "./os";
import { appHost, type AppHost } from "./apphost";
import { mkUri, readUri, writeUri } from "./net";
import { JRect } from "./graphics";
import { type JParcel, parcelCreator, readInt, readString, readString8, writeInt, writeString, writeString8 } from "./parcel";
import { newLinkedHashSet } from "../jvm/natives/jutil";
import type { JContext } from "./context";
import type { JActivity } from "./app";
import { onMain } from "./mainloop";
import { vcall, defineException, stringHash, JBool, JByte, JChar, JDouble, JFloat, JShort } from "../jvm/natives/jlang";
import { TV, type XmlAttr, type XmlNode } from "./axml";
import { normRV } from "./res";

export class JIntent extends JObj {
  action: string | null = null;
  component: string | null = null; // class name dots
  componentPkg: string | null = null;
  dataUri: string | null = null;
  typeStr: string | null = null;
  pkg: string | null = null;
  extras = new JBundle();
  flags = 0;
  categories = new Set<string>();
  identifier: string | null = null;
  sourceBounds: JRect | null = null;
  selector: JIntent | null = null;
  clipData: JClipData | null = null;
  contentUserHint = -2;
  originalIntent: JIntent | null = null;
  copyFrom(o: JIntent) {
    if (o) {
      this.action = o.action; this.component = o.component; this.componentPkg = o.componentPkg; this.dataUri = o.dataUri;
      this.extras = new JBundle();
      this.extras.map = new Map(o.extras.map);
      this.flags = o.flags; this.pkg = o.pkg; this.typeStr = o.typeStr; this.categories = new Set(o.categories);
      this.identifier = o.identifier; this.sourceBounds = o.sourceBounds ? copyBounds(o.sourceBounds) : null;
      this.selector = o.selector ? new JIntent() : null; this.selector?.copyFrom(o.selector!);
      this.clipData = o.clipData; this.contentUserHint = o.contentUserHint;
      this.originalIntent = o.originalIntent ? new JIntent() : null; this.originalIntent?.copyFrom(o.originalIntent!);
    }
  }
}
const componentPkg = (it: JIntent) => it.componentPkg ?? appHost?.pkg ?? "";
/** what Intent.filterEquals compares: action, data, type, identifier, package, component, categories */
export const filterKey = (it: JIntent) => JSON.stringify([it.action, it.dataUri, it.typeStr, it.identifier, it.pkg,
  it.component && componentPkg(it), it.component, [...it.categories].sort()]);
function copyBounds(rect: JRect): JRect {
  rt.link("android/graphics/Rect");
  return Object.assign(new JRect(), { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
}
/** a java.lang.Class's dotted name, as an explicit intent names its component */
const dottedClassName = (cls: { ci?: { name?: string } } | null) => cls?.ci?.name?.replace(/\//g, ".") ?? null;
function setClassFrom(this: JIntent, c: JContext, cls: { ci?: { name?: string } } | null) {
  this.component = dottedClassName(cls);
  this.componentPkg = c?.$host?.pkg ?? null;
  return this;
}
function putExtras(this: JIntent, source: JBundle | JIntent) {
  const extras = source instanceof JIntent ? source.extras : source;
  if (extras) for (const [key, value] of extras.map) this.extras.map.set(key, value);
  return this;
}
/** replaceExtras: the source's extras, copied, in place of every current one */
function replaceExtras(this: JIntent, source: JBundle | JIntent | null) {
  this.extras.map.clear();
  return source ? putExtras.call(this, source) : this;
}
function createChooser(target: JIntent, title: unknown, sender?: unknown): JIntent {
  if (!target) rt.npe();
  const chooser = new JIntent();
  chooser.action = "android.intent.action.CHOOSER";
  chooser.extras.map.set("android.intent.extra.INTENT", target);
  if (title !== null) chooser.extras.map.set("android.intent.extra.TITLE", title);
  if (sender) chooser.extras.map.set("android.intent.extra.CHOSEN_COMPONENT_INTENT_SENDER", sender);
  chooser.flags = target.flags & 3;
  chooser.clipData = target.clipData;
  return chooser;
}
async function readIntent(p: JParcel, intent = new JIntent()): Promise<JIntent> {
  rt.link("android/content/Intent");
  intent.action = readString8(p); intent.dataUri = (await readUri(p))?.uri ?? null;
  intent.typeStr = readString8(p); intent.identifier = readString8(p); intent.flags = readInt(p); intent.pkg = readString8(p);
  const component = readComponent(p); intent.component = component?.cls ?? null; intent.componentPkg = component?.pkg ?? null;
  intent.sourceBounds = null;
  if (readInt(p)) {
    rt.link("android/graphics/Rect");
    intent.sourceBounds = Object.assign(new JRect(), { left: readInt(p), top: readInt(p), right: readInt(p), bottom: readInt(p) });
  }
  intent.categories.clear();
  const count = readInt(p);
  if (count > (p.size - p.pos) / 4) throw rt.mkThrowable("android/os/BadParcelableException", "Invalid category count");
  for (let i = 0; i < count; i++) { const category = readString8(p); if (category !== null) intent.categories.add(category); }
  intent.selector = readInt(p) ? await readIntent(p) : null;
  intent.clipData = readInt(p) ? await readClipData(p) : null; intent.contentUserHint = readInt(p);
  intent.extras = await vcall(p, "readBundle", "()Landroid/os/Bundle;") ?? new JBundle();
  intent.originalIntent = readInt(p) ? await readIntent(p) : null;
  return intent;
}
async function writeIntent(this: JIntent, p: JParcel, flags: number): Promise<void> {
  writeString8(p, this.action); await writeUri(p, this.dataUri === null ? null : mkUri(this.dataUri));
  writeString8(p, this.typeStr); writeString8(p, this.identifier); writeInt(p, this.flags); writeString8(p, this.pkg);
  writeComponent(this.component === null ? null : mkComponentName(this.componentPkg ?? appHost?.pkg ?? "", this.component), p);
  const bounds = this.sourceBounds; writeInt(p, +!!bounds);
  if (bounds) for (const value of [bounds.left, bounds.top, bounds.right, bounds.bottom]) writeInt(p, value);
  writeInt(p, this.categories.size); for (const category of this.categories) writeString8(p, category);
  writeInt(p, +!!this.selector); if (this.selector) await vcall(this.selector, "writeToParcel", "(Landroid/os/Parcel;I)V", p, flags);
  writeInt(p, +!!this.clipData); if (this.clipData) await vcall(this.clipData, "writeToParcel", "(Landroid/os/Parcel;I)V", p, flags);
  writeInt(p, this.contentUserHint); await vcall(p, "writeBundle", "(Landroid/os/Bundle;)V", this.extras.map.size ? this.extras : null);
  writeInt(p, +!!this.originalIntent); if (this.originalIntent) await vcall(this.originalIntent, "writeToParcel", "(Landroid/os/Parcel;I)V", p, flags);
}
async function parseIntentXml(resources: unknown, parser: unknown, attrs: unknown): Promise<JIntent> {
  if (!parser || !attrs) rt.npe();
  const attribute = (name: string): Promise<string | null> => {
    const value = (attrs as { node?: XmlNode | null }).node?.attrs.find((a: XmlAttr) => a.name === name);
    return value?.type === TV.REFERENCE
      ? vcall(resources, "getString", "(I)Ljava/lang/String;", value.data) as Promise<string>
      : vcall(attrs, "getAttributeValue", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", "http://schemas.android.com/apk/res/android", name) as Promise<string | null>;
  };
  const intent = new JIntent();
  intent.action = await attribute("action");
  intent.dataUri = await attribute("data");
  intent.typeStr = await attribute("mimeType");
  intent.identifier = await attribute("identifier");
  const targetPackage = await attribute("targetPackage"), targetClass = await attribute("targetClass");
  if (targetPackage && targetClass) { intent.componentPkg = targetPackage; intent.component = targetClass; }
  const outerDepth = await vcall(parser, "getDepth", "()I") as number;
  for (;;) {
    const type = await vcall(parser, "next", "()I") as number;
    if (type === 1 || type === 3 && (await vcall(parser, "getDepth", "()I")) <= outerDepth) break;
    if (type !== 2) continue;
    const tag = await vcall(parser, "getName", "()Ljava/lang/String;") as string;
    if (tag === "category") {
      const category = await attribute("name");
      if (category) intent.categories.add(category);
    } else if (tag === "extra") {
      const name = await attribute("name");
      if (!name) continue;
      const raw = await attribute("value");
      const node = (attrs as { node?: XmlNode | null }).node;
      const value = node?.attrs.find((a: XmlAttr) => a.name === "value");
      intent.extras.map.set(name, value?.type === TV.BOOLEAN ? (value.data ? 1 : 0)
        : value?.type === TV.FLOAT ? normRV({ t: value.type, d: value.data }).d
          : value && value.type >= TV.INT_DEC && value.type <= TV.COLOR_RGB4 ? value.data : raw);
    }
  }
  return intent;
}
const intentMethods: NativeSpec["methods"] = {
  "static parseIntent(Landroid/content/res/Resources;Lorg/xmlpull/v1/XmlPullParser;Landroid/util/AttributeSet;)Landroid/content/Intent;": parseIntentXml,
  "<init>()V": function () {},
  "<init>(Landroid/os/Parcel;)V": driven(function* (this: JIntent, p: JParcel): Gen { yield readIntent(p, this); }),
  "readFromParcel(Landroid/os/Parcel;)V": driven(function* (this: JIntent, p: JParcel): Gen { yield readIntent(p, this); }),
  "writeToParcel(Landroid/os/Parcel;I)V": writeIntent,
  "describeContents()I": () => 0,
  "<init>(Ljava/lang/String;Landroid/net/Uri;)V": function (this: JIntent, a: string, u: any) {
    this.action = a;
    this.dataUri = u?.uri ?? null;
  },
  "<init>(Landroid/content/Context;Ljava/lang/Class;)V": function (this: JIntent, c: JContext, cls: any) { setClassFrom.call(this, c, cls); },
  "<init>(Ljava/lang/String;Landroid/net/Uri;Landroid/content/Context;Ljava/lang/Class;)V": function (this: JIntent, action: string, uri: { uri: string } | null, context: JContext, cls: { ci: { name: string } }) {
    this.action = action; this.dataUri = uri?.uri ?? null;
    this.component = cls.ci.name.replace(/\//g, ".");
    this.componentPkg = context.$host?.pkg ?? null;
  },
  "<init>(Landroid/content/Intent;)V": function (this: JIntent, o: JIntent) {
    this.copyFrom(o);
  },
  "setClass(Landroid/content/Context;Ljava/lang/Class;)Landroid/content/Intent;": setClassFrom,
  "setClassName(Landroid/content/Context;Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, c: JContext, n: string) {
    this.component = n;
    this.componentPkg = c?.$host?.pkg ?? null;
    return this;
  },
  "setClassName(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, p: string, n: string) {
    this.component = n; this.componentPkg = p;
    return this;
  },
  "setComponent(Landroid/content/ComponentName;)Landroid/content/Intent;": function (this: JIntent, cn: any) {
    this.component = cn?.cls ?? null; this.componentPkg = cn?.pkg ?? null;
    return this;
  },
  "getComponent()Landroid/content/ComponentName;": function (this: JIntent) {
    return this.component ? mkComponentName(this.componentPkg ?? appHost?.pkg ?? "", this.component) : null;
  },
  "setAction(Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, a: string) { this.action = a; return this; },
  "setPackage(Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, p: string | null) {
    if (p !== null && this.selector) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Package and selector are mutually exclusive");
    this.pkg = p; return this;
  },
  "setData(Landroid/net/Uri;)Landroid/content/Intent;": function (this: JIntent, u: any) { this.dataUri = u?.uri ?? null; return this; },
  "getData()Landroid/net/Uri;": function (this: JIntent) { return this.dataUri ? mkUri(this.dataUri) : null; },
  "setType(Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, t: string) { this.typeStr = t; return this; },
  "setDataAndType(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, u: any, t: string) {
    this.dataUri = u?.uri ?? null;
    this.typeStr = t;
    return this;
  },
  "addFlags(I)Landroid/content/Intent;": function (this: JIntent, f: number) { this.flags |= f; return this; },
  "setFlags(I)Landroid/content/Intent;": function (this: JIntent, f: number) { this.flags = f; return this; },
  "addCategory(Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, c: string) { this.categories.add(c); return this; },
  "hasCategory(Ljava/lang/String;)Z": function (this: JIntent, c: string) { return this.categories.has(c) ? 1 : 0; },
  "fillIn(Landroid/content/Intent;I)I": function (this: JIntent, other: JIntent, flags: number) {
    let changed = 0;
    if (other.action !== null && (this.action === null || flags & 1)) { this.action = other.action; changed |= 1; }
    if ((other.dataUri !== null || other.typeStr !== null) && (this.dataUri === null && this.typeStr === null || flags & 2)) {
      this.dataUri = other.dataUri; this.typeStr = other.typeStr; changed |= 2;
    }
    if (other.categories.size && (!this.categories.size || flags & 4)) { this.categories = new Set(other.categories); changed |= 4; }
    if (other.component !== null && flags & 8) { this.component = other.component; this.componentPkg = other.componentPkg; changed |= 8; }
    if (other.pkg !== null && !this.selector && (this.pkg === null || flags & 16)) { this.pkg = other.pkg; changed |= 16; }
    if (other.identifier !== null && (this.identifier === null || flags & 256)) { this.identifier = other.identifier; changed |= 256; }
    if (other.sourceBounds && (!this.sourceBounds || flags & 32)) { this.sourceBounds = copyBounds(other.sourceBounds); changed |= 32; }
    if (other.selector && !this.pkg && flags & 64) { this.selector = new JIntent(); this.selector.copyFrom(other.selector); changed |= 64; }
    if (other.clipData && (!this.clipData || flags & 128)) { this.clipData = other.clipData; changed |= 128; }
    this.flags |= other.flags;
    if (other.extras.map.size) this.extras.map = new Map([...other.extras.map, ...this.extras.map]);
    if ((changed & 130 || other.extras.map.size) && this.contentUserHint === -2) this.contentUserHint = other.contentUserHint;
    return changed;
  },
  "filterEquals(Landroid/content/Intent;)Z": function (this: JIntent, other: JIntent | null) {
    return +(!!other && filterKey(this) === filterKey(other));
  },
  // the fields' hashCodes summed; a ComponentName's is its package's plus its class's
  "filterHashCode()I": function (this: JIntent) {
    let h = 0;
    for (const s of [this.action, this.dataUri, this.typeStr, this.identifier, this.pkg, this.component && componentPkg(this), this.component, ...this.categories])
      if (s !== null) h = (h + stringHash(s)) | 0;
    return h;
  },
  "getExtras()Landroid/os/Bundle;": function (this: JIntent) { return this.extras.map.size ? this.extras : null; },
  "putExtras(Landroid/os/Bundle;)Landroid/content/Intent;": putExtras,
  "putExtras(Landroid/content/Intent;)Landroid/content/Intent;": putExtras,
  "replaceExtras(Landroid/os/Bundle;)Landroid/content/Intent;": replaceExtras,
  "replaceExtras(Landroid/content/Intent;)Landroid/content/Intent;": replaceExtras,
  "hasExtra(Ljava/lang/String;)Z": function (this: JIntent, k: string) { return this.extras.map.has(k) ? 1 : 0; },
  "removeExtra(Ljava/lang/String;)V": function (this: JIntent, k: string) { this.extras.map.delete(k); },
  // Extras are live objects here, never a parcel, so there is nothing for a class loader to do.
  "setExtrasClassLoader(Ljava/lang/ClassLoader;)V": () => {},
  "getCategories()Ljava/util/Set;": driven(function* (this: JIntent): Gen {
    return this.categories.size ? yield newLinkedHashSet([...this.categories]) : null;
  }),
  "getScheme()Ljava/lang/String;": function (this: JIntent) {
    const i = this.dataUri?.indexOf(":") ?? -1;
    return i > 0 ? this.dataUri!.slice(0, i) : null;
  },
  "static createChooser(Landroid/content/Intent;Ljava/lang/CharSequence;)Landroid/content/Intent;": createChooser,
  "static createChooser(Landroid/content/Intent;Ljava/lang/CharSequence;Landroid/content/IntentSender;)Landroid/content/Intent;": createChooser,
  "static makeMainActivity(Landroid/content/ComponentName;)Landroid/content/Intent;": (c: JComponentName) => {
    const i = new JIntent();
    i.action = "android.intent.action.MAIN";
    i.categories.add("android.intent.category.LAUNCHER");
    i.component = c?.cls ?? null; i.componentPkg = c?.pkg ?? null;
    return i;
  },
  "setSourceBounds(Landroid/graphics/Rect;)V": function (this: JIntent, bounds: JRect | null) { this.sourceBounds = bounds ? copyBounds(bounds) : null; },
  "toUri(I)Ljava/lang/String;": function (this: JIntent, flags: number) { return intentUri(this, flags); },
  "toURI()Ljava/lang/String;": function (this: JIntent) { return intentUri(this, 0); },
  "setSelector(Landroid/content/Intent;)V": function (this: JIntent, selector: JIntent | null) {
    if (selector === this || selector && this.pkg) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid selector");
    this.selector = selector;
  },
  ...fieldSetters({ "<init>(Ljava/lang/String;)V": "action", "setClipData(Landroid/content/ClipData;)V": "clipData" }),
  ...fieldGetters({ "getPackage()Ljava/lang/String;": "pkg", "getAction()Ljava/lang/String;": "action",
    "getDataString()Ljava/lang/String;": "dataUri", "getType()Ljava/lang/String;": "typeStr", "getFlags()I": "flags",
    "resolveType(Landroid/content/ContentResolver;)Ljava/lang/String;": "typeStr",
    "resolveTypeIfNeeded(Landroid/content/ContentResolver;)Ljava/lang/String;": "typeStr",
    "getClipData()Landroid/content/ClipData;": "clipData", "getSourceBounds()Landroid/graphics/Rect;": "sourceBounds",
    "getSelector()Landroid/content/Intent;": "selector", "getIdentifier()Ljava/lang/String;": "identifier" }),
  "setIdentifier(Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, identifier: string | null) { this.identifier = identifier; return this; },
  "resolveActivity(Landroid/content/pm/PackageManager;)Landroid/content/ComponentName;": driven(function* (this: JIntent, pm: unknown): Gen {
    if (this.component) return mkComponentName(this.componentPkg ?? appHost?.pkg ?? "", this.component);
    const resolved = yield vcall(pm, "resolveActivity", "(Landroid/content/Intent;I)Landroid/content/pm/ResolveInfo;", this, 0x10000);
    return resolved?.activityInfo ? mkComponentName(resolved.activityInfo.packageName, resolved.activityInfo.name) : null;
  }),
  "resolveActivityInfo(Landroid/content/pm/PackageManager;I)Landroid/content/pm/ActivityInfo;": driven(function* (this: JIntent, pm: unknown, flags: number): Gen {
    const resolved = yield vcall(pm, "resolveActivity", "(Landroid/content/Intent;I)Landroid/content/pm/ResolveInfo;", this, flags | 0x10000);
    return resolved?.activityInfo ?? null;
  }),
  "toString()Ljava/lang/String;": function (this: JIntent) {
    return `Intent{act=${this.action} cmp=${this.component}}`;
  },
};
// Intent's extras are a Bundle: the same table, with Intent's names and its primitive getters
// only in their defaulted form
for (const [t, d] of INTENT_TYPES) {
  const put = d === "Ljava/util/ArrayList;" ? `put${t}Extra` : "putExtra";
  intentMethods[`${put}(Ljava/lang/String;${d})Landroid/content/Intent;`] = function (this: JIntent, k: string, v: unknown) {
    this.extras.map.set(k, bundleBox(v, d));
    return this;
  };
  intentMethods[d.length === 1 ? `get${t}Extra(Ljava/lang/String;${d})${d}` : `get${t}Extra(Ljava/lang/String;)${d}`] =
    function (this: JIntent, k: string, dv: unknown = null) { return bundleGet(this.extras, k, d, dv); };
}
for (const [t, d] of INTENT_TYPED) {
  intentMethods[`get${t}Extra(Ljava/lang/String;Ljava/lang/Class;)${d}`] = function (this: JIntent, k: string, cls: unknown) { return bundleTyped(this.extras, k, cls, d); };
}
class JShortcutIconResource extends JObj { packageName = ""; resourceName = ""; }
rt.register({
  name: "android/content/Intent$ShortcutIconResource", ctor: JShortcutIconResource, ifaces: ["android/os/Parcelable"],
  fields: ["packageName", "resourceName"],
  methods: {
    "<init>()V": function () {},
    "static fromContext(Landroid/content/Context;I)Landroid/content/Intent$ShortcutIconResource;": driven(function* (ctx: unknown, id: number): Gen {
      const r = new JShortcutIconResource();
      r.packageName = yield vcall(ctx, "getPackageName", "()Ljava/lang/String;");
      const res = yield vcall(ctx, "getResources", "()Landroid/content/res/Resources;");
      r.resourceName = yield vcall(res, "getResourceName", "(I)Ljava/lang/String;", id);
      return r;
    }),
    "toString()Ljava/lang/String;": function (this: JShortcutIconResource) { return this.resourceName; },
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": function (this: JShortcutIconResource, p: JParcel) { writeString(p, this.packageName); writeString(p, this.resourceName); },
  },
  statics: { get CREATOR() { return parcelCreator("android/content/Intent$ShortcutIconResource", async (p) => {
    const r = new JShortcutIconResource(); r.packageName = readString(p) ?? ""; r.resourceName = readString(p) ?? ""; return r;
  }); } },
});
rt.register({
  name: "android/content/Intent", ctor: JIntent, ifaces: ["android/os/Parcelable", "java/lang/Cloneable"],
  statics: {
    get CREATOR() { return parcelCreator("android/content/Intent", readIntent); },
    ACTION_MAIN: "android.intent.action.MAIN", ACTION_VIEW: "android.intent.action.VIEW",
    ACTION_SEND: "android.intent.action.SEND", ACTION_EDIT: "android.intent.action.EDIT",
    ACTION_SEND_MULTIPLE: "android.intent.action.SEND_MULTIPLE", ACTION_CHOOSER: "android.intent.action.CHOOSER",
    ACTION_PICK: "android.intent.action.PICK", ACTION_GET_CONTENT: "android.intent.action.GET_CONTENT",
    ACTION_CREATE_DOCUMENT: "android.intent.action.CREATE_DOCUMENT", ACTION_OPEN_DOCUMENT: "android.intent.action.OPEN_DOCUMENT",
    ACTION_OPEN_DOCUMENT_TREE: "android.intent.action.OPEN_DOCUMENT_TREE",
    ACTION_BOOT_COMPLETED: "android.intent.action.BOOT_COMPLETED",
    ACTION_BATTERY_CHANGED: "android.intent.action.BATTERY_CHANGED",
    CATEGORY_LAUNCHER: "android.intent.category.LAUNCHER", CATEGORY_DEFAULT: "android.intent.category.DEFAULT",
    FLAG_ACTIVITY_NEW_TASK: 0x10000000, FLAG_ACTIVITY_CLEAR_TOP: 0x04000000, FLAG_ACTIVITY_CLEAR_TASK: 0x00008000,
    FLAG_ACTIVITY_SINGLE_TOP: 0x20000000, FLAG_GRANT_READ_URI_PERMISSION: 1, FLAG_GRANT_WRITE_URI_PERMISSION: 2,
    FLAG_GRANT_PERSISTABLE_URI_PERMISSION: 64, FLAG_GRANT_PREFIX_URI_PERMISSION: 128,
    EXTRA_TEXT: "android.intent.extra.TEXT", EXTRA_STREAM: "android.intent.extra.STREAM",
    EXTRA_SUBJECT: "android.intent.extra.SUBJECT", EXTRA_TITLE: "android.intent.extra.TITLE",
  },
  methods: intentMethods,
});
export class JComponentName extends JObj { pkg = ""; cls = ""; }
function writeComponent(component: JComponentName | null, p: JParcel): void {
  writeString(p, component?.pkg ?? null); if (component) writeString(p, component.cls);
}
function readComponent(p: JParcel): JComponentName | null {
  const pkg = readString(p); if (pkg === null) return null;
  const cls = readString(p); if (cls === null) throw rt.mkThrowable("java/lang/NullPointerException", "class name");
  return mkComponentName(pkg, cls);
}
/** PackageManager component enabled states an app set (DEFAULT until then); part of the
 *  install like firstInstallTime, so they survive a reboot and go with wd.reset */
export const componentState = {
  key: (c: JComponentName) => "wd:install:" + c.pkg + ":component:" + c.cls,
  get(c: JComponentName): number { return Number(globalThis.localStorage?.getItem(this.key(c)) ?? 0); },
  set(c: JComponentName, st: number) { try { globalThis.localStorage?.setItem(this.key(c), String(st)); } catch { /* private mode */ } },
};
export function mkComponentName(pkg: string, cls: string): JComponentName {
  rt.link("android/content/ComponentName");
  const c = new JComponentName();
  c.pkg = pkg; c.cls = cls;
  return c;
}
/** AOSP Intent.toUri: the data (without its scheme under URI_INTENT_SCHEME), then "#Intent;"
 *  key=value pairs for everything else and the extras a URI can carry, then "end". */
const encUri = (s: string, slash = false) => { const e = encodeURIComponent(s); return slash ? e.replace(/%2F/g, "/") : e; };
/** an extra's URI type tag and text, for the types toUri writes */
function extraUri(v: unknown): [string, string] | null {
  if (typeof v === "string") return ["S", v];
  if (typeof v === "number") return ["i", String(v)];
  if (typeof v === "bigint") return ["l", String(v)];
  const n = (v as { v: number }).v;
  if (v instanceof JBool) return ["B", String(!!n)];
  if (v instanceof JChar) return ["c", String.fromCharCode(n)];
  if (v instanceof JDouble || v instanceof JFloat) return [v instanceof JDouble ? "d" : "f", Number.isInteger(n) ? n.toFixed(1) : String(n)];
  return v instanceof JByte ? ["b", String(n)] : v instanceof JShort ? ["s", String(n)] : null;
}
function intentUri(it: JIntent, flags: number): string {
  const intentScheme = (flags & 1) !== 0, match = it.dataUri ? /^([^:/?#]+):/.exec(it.dataUri) : null;
  const scheme = intentScheme ? match?.[1] ?? null : null;
  let s = (intentScheme ? "intent:" + (scheme ? it.dataUri!.slice(scheme.length + 1) : it.dataUri ?? "") : it.dataUri ?? "") + "#Intent;";
  if (scheme) s += `scheme=${encUri(scheme)};`;
  if (it.action && !(scheme && it.action === "android.intent.action.VIEW")) s += `action=${encUri(it.action)};`;
  for (const c of it.categories) s += `category=${encUri(c)};`;
  if (it.typeStr) s += `type=${encUri(it.typeStr, true)};`;
  if (it.identifier) s += `identifier=${encUri(it.identifier, true)};`;
  if (it.flags) s += `launchFlags=0x${(it.flags >>> 0).toString(16)};`;
  if (it.pkg) s += `package=${encUri(it.pkg)};`;
  if (it.component && it.componentPkg) {
    s += `component=${encUri(it.componentPkg + "/" + shortClassName(it.componentPkg, it.component), true)};`;
  }
  for (const [key, value] of it.extras.map) {
    const extra = extraUri(value);
    if (extra) s += `${extra[0]}.${encUri(key)}=${encUri(extra[1])};`;
  }
  return s + "end";
}
/** a class name within its package, as ".Main" */
const shortClassName = (pkg: string, cls: string) => cls.startsWith(pkg + ".") ? cls.slice(pkg.length) : cls;
const compareComponents = (a: JComponentName, b: JComponentName) =>
  a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : a.cls < b.cls ? -1 : a.cls > b.cls ? 1 : 0;
rt.register({
  name: "android/content/ComponentName", ctor: JComponentName, ifaces: ["android/os/Parcelable", "java/lang/Comparable"],
  statics: { get CREATOR() { return parcelCreator("android/content/ComponentName", async p => readComponent(p)); } },
  methods: {
    "writeToParcel(Landroid/os/Parcel;I)V": function (this: JComponentName, p: JParcel) { writeComponent(this, p); },
    "static writeToParcel(Landroid/content/ComponentName;Landroid/os/Parcel;)V": writeComponent,
    "static readFromParcel(Landroid/os/Parcel;)Landroid/content/ComponentName;": readComponent,
    "describeContents()I": () => 0,
    "<init>(Ljava/lang/String;Ljava/lang/String;)V": function (this: JComponentName, p: string, c: string) { this.pkg = p; this.cls = c; },
    "<init>(Landroid/content/Context;Ljava/lang/String;)V": function (this: JComponentName, ctx: JContext, cls: string) {
      this.pkg = ctx?.$host?.pkg ?? "";
      this.cls = cls ?? "";
    },
    "<init>(Landroid/content/Context;Ljava/lang/Class;)V": function (this: JComponentName, ctx: JContext, cls: any) {
      this.pkg = ctx?.$host?.pkg ?? "";
      this.cls = dottedClassName(cls) ?? "";
    },
    "getClassName()Ljava/lang/String;": function (this: JComponentName) { return this.cls; },
    "getShortClassName()Ljava/lang/String;": function (this: JComponentName) { return shortClassName(this.pkg, this.cls); },
    "getPackageName()Ljava/lang/String;": function (this: JComponentName) { return this.pkg; },
    "flattenToString()Ljava/lang/String;": function (this: JComponentName) { return this.pkg + "/" + this.cls; },
    "flattenToShortString()Ljava/lang/String;": function (this: JComponentName) { return this.pkg + "/" + shortClassName(this.pkg, this.cls); },
    "compareTo(Landroid/content/ComponentName;)I": function (this: JComponentName, other: JComponentName) { return compareComponents(this, other); },
    "compareTo(Ljava/lang/Object;)I": function (this: JComponentName, other: JComponentName) {
      if (!(other instanceof JComponentName)) throw rt.mkThrowable("java/lang/ClassCastException", "ComponentName required");
      return compareComponents(this, other);
    },
    "equals(Ljava/lang/Object;)Z": function (this: JComponentName, other: unknown) {
      return +(other instanceof JComponentName && this.pkg === other.pkg && this.cls === other.cls);
    },
    "hashCode()I": function (this: JComponentName) { return (stringHash(this.pkg) + stringHash(this.cls)) | 0; },
  },
});

defineException("android/content/ActivityNotFoundException", "java/lang/RuntimeException");
export type ActivityResultTarget = { act: JActivity; code: number };
export const activityTransport: {
  launch?: (pkg: string, process: string, component: string, intent: JIntent, result?: ActivityResultTarget) => Promise<void>;
  finish?: (act: JActivity) => boolean;
  attach?: (act: JActivity, task: number, affinity: string) => void;
  finishAffinity?: (act: JActivity) => void;
  isTaskRoot?: (act: JActivity) => boolean;
  removeTask?: (act: JActivity) => void;
  presentation?: (translucent: boolean) => void;
} = {};
/** `sender` is the package whose identity the start carries (a PendingIntent's creator) */
export async function launchIntent(host: AppHost, intent: JIntent, result?: ActivityResultTarget, sender = host.pkg) {
  const runSystem = (system: SystemHandler) => {
    // the system activity covered its caller, which resumes after its result, unless the
    // system activity went on to start another one in front of it
    const caller = result?.act ?? host.currentActivity();
    void system(intent).then((data) => {
      if (result) deliverActivityResult(result.act, result.code, data ? RESULT_OK : RESULT_CANCELED, data);
      if (caller) setTimeout(() => void onMain(async () => { if (host.currentActivity() === caller) await host.roundTrip(caller); }).catch(reportUncaught), 0);
    }, (error) => { reportUncaught(error); if (result) deliverActivityResult(result.act, result.code, RESULT_CANCELED, null); });
  };
  const system = systemActivity(intent, false);
  if (system) return runSystem(system);
  const { getPM } = await import("./pm");
  const resolved = await vcall(getPM(), "resolveActivity", "(Landroid/content/Intent;I)Landroid/content/pm/ResolveInfo;", intent, 0x10000);
  if (!resolved?.activityInfo) throw rt.mkThrowable("android/content/ActivityNotFoundException", "No activity found for " + intent.action);
  const info = resolved.activityInfo;
  // a data-scoped system activity (the browser) answers only where no installed activity does
  if (info.packageName === "android" && info.name === SYSTEM_ACTIVITY) return runSystem(systemActivity(intent)!);
  if (info.packageName !== sender && (!info.exported || info.permission && await vcall(getPM(), "checkPermission", "(Ljava/lang/String;Ljava/lang/String;)I", info.permission, sender) !== 0))
    throw rt.mkThrowable("java/lang/SecurityException", "Activity permission denied: " + info.name);
  const component = info.name.replace(/\./g, "/");
  if (info.packageName !== host.pkg || info.processName !== (PROCESS_NAME || host.pkg)) {
    if (!activityTransport.launch) throw rt.mkThrowable("android/content/ActivityNotFoundException", "Activity process unavailable: " + info.processName);
    return activityTransport.launch(info.packageName, info.processName, component, intent, result);
  }
  const caller = result && result.code >= 0 ? await vcall(result.act, "getComponentName", "()Landroid/content/ComponentName;") as JComponentName : null;
  // ActivityThread delivers the launch after the caller's current lifecycle callback returns.
  void onMain(() => host.launch(component, intent, { caller, result })).catch(reportUncaught);
}

const RESULT_OK = -1, RESULT_CANCELED = 0;

/**
 * The activities the *system* provides, keyed by the action an app sends. On a device these are
 * DocumentsUI; here they are the browser's own pickers. Each answers with the result Intent, or
 * null for "the user backed out" — which is RESULT_CANCELED, not an error.
 */
type SystemHandler = (intent: JIntent) => Promise<JIntent | null>;
const systemActivities = new Map<string, { run: SystemHandler; schemes?: string[] }[]>();
/** `schemes` scopes a handler to intents whose data has one of them; such a handler yields to
 *  any installed activity that matches, as a default browser does to an app's own links. */
export function registerSystemActivity(action: string, run: SystemHandler, schemes?: string[]) {
  const handlers = systemActivities.get(action) ?? [];
  systemActivities.set(action, [...handlers, { run, schemes }]);
}
/** The platform package answers for them, as ResolverActivity and DocumentsUI do on a device, so
 *  an intent resolved to that component and started explicitly reaches the same handler. */
export const SYSTEM_ACTIVITY = "com.android.internal.app.ResolverActivity";
export function systemActivity(intent: JIntent | null, scoped = true): SystemHandler | null {
  if (!intent || intent.component && (intent.componentPkg !== "android" || intent.component !== SYSTEM_ACTIVITY)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(intent.dataUri ?? "")?.[1].toLowerCase() ?? "";
  return systemActivities.get(intent.action ?? "")?.find((h) => h.schemes ? scoped && h.schemes.includes(scheme) : true)?.run ?? null;
}
export function mkResultIntent(uri: string | null, flags = 3 | 0x40): JIntent {
  const i = new JIntent();
  i.dataUri = uri;
  i.flags = flags;
  return i;
}

/** Post a result to the activity that asked for it. Scheduled, never inline: the caller is
 *  usually mid-click-handler, and androidx dispatches straight into app code from here. */
export function deliverActivityResult(act: JActivity, code: number, resultCode: number, data: JIntent | null) {
  setTimeout(() => void onMain(async () => {
    // the grant flags cover the result's data and every ClipData item URI, as ActivityManager's
    if (resultCode === RESULT_OK && data && (data.flags & 3)) {
      const { grantUriPermission } = await import("./contentresolver");
      const items = data.clipData?.items ?? [];
      for (const uri of [data.dataUri, ...items.map((item) => item.uri?.uri)]) if (uri) grantUriPermission(act.$host.pkg, mkUri(uri), data.flags);
    }
    const target = act.fragmentResults.get(code);
    if (target) {
      act.fragmentResults.delete(code);
      await vcall(target.fragment, "onActivityResult", "(IILandroid/content/Intent;)V", target.requestCode, resultCode, data);
    } else await vcall(act, "onActivityResult", "(IILandroid/content/Intent;)V", code, resultCode, data);
  }).catch(reportUncaught), 0);
}
