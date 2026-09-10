import { JObj, type NativeSpec, rt, maySuspend } from "../jvm/runtime";
import { JBundle, reportUncaught } from "./os";
import { appHost, type AppHost } from "./apphost";
import { mkUri } from "./net";
import { newLinkedHashSet } from "../jvm/natives/jutil";
import type { JContext } from "./context";
import type { JActivity } from "./app";
import { onMain } from "./mainloop";
import { vcall, defineException } from "../jvm/natives/jlang";

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
}
const intentMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "<init>(Ljava/lang/String;)V": function (this: JIntent, a: string) { this.action = a; },
  "<init>(Ljava/lang/String;Landroid/net/Uri;)V": function (this: JIntent, a: string, u: any) {
    this.action = a;
    this.dataUri = u?.uri ?? null;
  },
  "<init>(Landroid/content/Context;Ljava/lang/Class;)V": maySuspend(function (this: JIntent, c: JContext, cls: any) {
    this.component = cls?.ci?.name?.replace(/\//g, ".") ?? null;
    this.componentPkg = c?.$host?.pkg ?? null;
  }),
  "<init>(Landroid/content/Intent;)V": function (this: JIntent, o: JIntent) {
    if (o) {
      this.action = o.action; this.component = o.component; this.componentPkg = o.componentPkg; this.dataUri = o.dataUri;
      this.extras = new JBundle();
      this.extras.map = new Map(o.extras.map);
      this.flags = o.flags; this.pkg = o.pkg; this.typeStr = o.typeStr; this.categories = new Set(o.categories);
    }
  },
  "setClass(Landroid/content/Context;Ljava/lang/Class;)Landroid/content/Intent;": function (this: JIntent, c: JContext, cls: any) {
    this.component = cls?.ci?.name?.replace(/\//g, ".") ?? null;
    this.componentPkg = c?.$host?.pkg ?? null;
    return this;
  },
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
  "getComponent()Landroid/content/ComponentName;": async function (this: JIntent, pm: unknown) {
    if (this.component) return mkComponentName(this.componentPkg ?? appHost?.pkg ?? "", this.component);
    const resolved = await vcall(pm, "resolveActivity", "(Landroid/content/Intent;I)Landroid/content/pm/ResolveInfo;", this, 0x10000);
    return resolved?.activityInfo ? mkComponentName(resolved.activityInfo.packageName, resolved.activityInfo.name) : null;
  },
  "setAction(Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, a: string) { this.action = a; return this; },
  "setPackage(Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, p: string) { this.pkg = p; return this; },
  "getPackage()Ljava/lang/String;": function (this: JIntent) { return this.pkg; },
  "getAction()Ljava/lang/String;": function (this: JIntent) { return this.action; },
  "setData(Landroid/net/Uri;)Landroid/content/Intent;": function (this: JIntent, u: any) { this.dataUri = u?.uri ?? null; return this; },
  "getData()Landroid/net/Uri;": function (this: JIntent) { return this.dataUri ? mkUri(this.dataUri) : null; },
  "getDataString()Ljava/lang/String;": function (this: JIntent) { return this.dataUri; },
  "setType(Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, t: string) { this.typeStr = t; return this; },
  "setDataAndType(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, u: any, t: string) {
    this.dataUri = u?.uri ?? null;
    this.typeStr = t;
    return this;
  },
  "getType()Ljava/lang/String;": function (this: JIntent) { return this.typeStr; },
  "addFlags(I)Landroid/content/Intent;": function (this: JIntent, f: number) { this.flags |= f; return this; },
  "setFlags(I)Landroid/content/Intent;": function (this: JIntent, f: number) { this.flags = f; return this; },
  "getFlags()I": function (this: JIntent) { return this.flags; },
  "addCategory(Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, c: string) { this.categories.add(c); return this; },
  "hasCategory(Ljava/lang/String;)Z": function (this: JIntent, c: string) { return this.categories.has(c) ? 1 : 0; },
  "getExtras()Landroid/os/Bundle;": function (this: JIntent) { return this.extras.map.size ? this.extras : null; },
  "putExtras(Landroid/os/Bundle;)Landroid/content/Intent;": function (this: JIntent, b: JBundle) {
    if (b) for (const [k, v] of b.map) this.extras.map.set(k, v);
    return this;
  },
  "hasExtra(Ljava/lang/String;)Z": function (this: JIntent, k: string) { return this.extras.map.has(k) ? 1 : 0; },
  "removeExtra(Ljava/lang/String;)V": function (this: JIntent, k: string) { this.extras.map.delete(k); },
  // Extras are live objects here, never a parcel, so there is nothing for a class loader to do.
  "setExtrasClassLoader(Ljava/lang/ClassLoader;)V": () => {},
  // API 33 type-checked getters: the extras are already the objects the caller asked for.
  "getParcelableExtra(Ljava/lang/String;Ljava/lang/Class;)Ljava/lang/Object;": function (this: JIntent, k: string) { return this.extras.map.get(k) ?? null; },
  "getSerializableExtra(Ljava/lang/String;Ljava/lang/Class;)Ljava/io/Serializable;": function (this: JIntent, k: string) { return this.extras.map.get(k) ?? null; },
  "getCategories()Ljava/util/Set;": async function (this: JIntent) {
    return this.categories.size ? await newLinkedHashSet([...this.categories]) : null;
  },
  "getScheme()Ljava/lang/String;": function (this: JIntent) {
    const i = this.dataUri?.indexOf(":") ?? -1;
    return i > 0 ? this.dataUri!.slice(0, i) : null;
  },
  "resolveType(Landroid/content/ContentResolver;)Ljava/lang/String;": function (this: JIntent) { return this.typeStr; },
  "resolveTypeIfNeeded(Landroid/content/ContentResolver;)Ljava/lang/String;": function (this: JIntent) { return this.typeStr; },
  // A chooser needs a chooser activity; with none installed the target intent is what launches,
  // which is what AOSP falls back to when nothing can handle ACTION_CHOOSER.
  "static createChooser(Landroid/content/Intent;Ljava/lang/CharSequence;)Landroid/content/Intent;": (t: JIntent) => t,
  "static createChooser(Landroid/content/Intent;Ljava/lang/CharSequence;Landroid/content/IntentSender;)Landroid/content/Intent;": (t: JIntent) => t,
  "static makeMainActivity(Landroid/content/ComponentName;)Landroid/content/Intent;": (c: JComponentName) => {
    const i = new JIntent();
    i.action = "android.intent.action.MAIN";
    i.categories.add("android.intent.category.LAUNCHER");
    i.component = c?.cls ?? null; i.componentPkg = c?.pkg ?? null;
    return i;
  },
  // Nothing here builds a ClipData or a launch rectangle, and AOSP answers null when it has none.
  "getClipData()Landroid/content/ClipData;": () => null,
  "setClipData(Landroid/content/ClipData;)V": () => {},
  "getSourceBounds()Landroid/graphics/Rect;": () => null,
  "getSelector()Landroid/content/Intent;": () => null,
  "getIdentifier()Ljava/lang/String;": () => null,
  "resolveActivity(Landroid/content/pm/PackageManager;)Landroid/content/ComponentName;": async function (this: JIntent, pm: unknown) {
    if (this.component) return mkComponentName(this.componentPkg ?? appHost?.pkg ?? "", this.component);
    const resolved = await vcall(pm, "resolveActivity", "(Landroid/content/Intent;I)Landroid/content/pm/ResolveInfo;", this, 0x10000);
    return resolved?.activityInfo ? mkComponentName(resolved.activityInfo.packageName, resolved.activityInfo.name) : null;
  },
  "toString()Ljava/lang/String;": function (this: JIntent) {
    return `Intent{act=${this.action} cmp=${this.component}}`;
  },
};
for (const [t, d, dflt] of [["String", "Ljava/lang/String;", null], ["Int", "I", 0], ["Long", "J", 0n],
  ["Boolean", "Z", 0], ["Float", "F", 0], ["Double", "D", 0], ["CharSequence", "Ljava/lang/CharSequence;", null],
  ["Parcelable", "Landroid/os/Parcelable;", null], ["Serializable", "Ljava/io/Serializable;", null],
  ["Bundle", "Landroid/os/Bundle;", null], ["StringArrayList", "Ljava/util/ArrayList;", null],
  ["IntArray", "[I", null], ["ByteArray", "[B", null], ["StringArray", "[Ljava/lang/String;", null]] as const) {
  intentMethods[`putExtra(Ljava/lang/String;${d})Landroid/content/Intent;`] = function (this: JIntent, k: string, v: unknown) {
    this.extras.map.set(k, v);
    return this;
  };
  intentMethods[`get${t}Extra(Ljava/lang/String;)${d}`] = function (this: JIntent, k: string) {
    return this.extras.map.get(k) ?? dflt;
  };
  if (d === "I" || d === "J" || d === "Z" || d === "F" || d === "D") {
    intentMethods[`get${t}Extra(Ljava/lang/String;${d})${d}`] = function (this: JIntent, k: string, dv: unknown) {
      const v = this.extras.map.get(k);
      return v === undefined ? dv : v;
    };
  }
  if (t === "Bundle") {
    intentMethods[`getBundleExtra(Ljava/lang/String;)Landroid/os/Bundle;`] = function (this: JIntent, k: string) {
      return this.extras.map.get(k) ?? null;
    };
  }
}
rt.register({
  name: "android/content/Intent", ctor: JIntent, ifaces: ["android/os/Parcelable", "java/lang/Cloneable"],
  statics: {
    ACTION_MAIN: "android.intent.action.MAIN", ACTION_VIEW: "android.intent.action.VIEW",
    ACTION_SEND: "android.intent.action.SEND", ACTION_EDIT: "android.intent.action.EDIT",
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
/** PackageManager component enabled states an app set (DEFAULT until then); part of the
 *  install like firstInstallTime, so they survive a reboot and go with wd.reset */
export const componentState = {
  key: (c: JComponentName) => "wd:install:" + c.pkg + ":component:" + c.cls,
  get(c: JComponentName): number { return Number(globalThis.localStorage?.getItem(this.key(c)) ?? 0); },
  set(c: JComponentName, st: number) { try { globalThis.localStorage?.setItem(this.key(c), String(st)); } catch { /* private mode */ } },
};
export function mkComponentName(pkg: string, cls: string): JComponentName {
  const c = new JComponentName();
  c.pkg = pkg; c.cls = cls;
  return c;
}
rt.register({
  name: "android/content/ComponentName", ctor: JComponentName, ifaces: ["android/os/Parcelable"],
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;)V": function (this: JComponentName, p: string, c: string) { this.pkg = p; this.cls = c; },
    "<init>(Landroid/content/Context;Ljava/lang/String;)V": function (this: JComponentName, ctx: JContext, cls: string) {
      this.pkg = ctx?.$host?.pkg ?? "";
      this.cls = cls ?? "";
    },
    "<init>(Landroid/content/Context;Ljava/lang/Class;)V": function (this: JComponentName, ctx: JContext, cls: any) {
      this.pkg = ctx?.$host?.pkg ?? "";
      this.cls = cls?.ci?.name?.replace(/\//g, ".") ?? "";
    },
    "getClassName()Ljava/lang/String;": function (this: JComponentName) { return this.cls; },
    "getPackageName()Ljava/lang/String;": function (this: JComponentName) { return this.pkg; },
    "flattenToString()Ljava/lang/String;": function (this: JComponentName) { return this.pkg + "/" + this.cls; },
  },
});

defineException("android/content/ActivityNotFoundException", "java/lang/RuntimeException");
export async function launchIntent(host: AppHost, intent: JIntent) {
  const { getPM } = await import("./pm");
  const resolved = await vcall(getPM(), "resolveActivity", "(Landroid/content/Intent;I)Landroid/content/pm/ResolveInfo;", intent, 0x10000);
  if (!resolved?.activityInfo) throw rt.mkThrowable("android/content/ActivityNotFoundException", "No activity found for " + intent.action);
  await host.launch(resolved.activityInfo.name.replace(/\./g, "/"), intent);
}

export const RESULT_OK = -1, RESULT_CANCELED = 0;

/**
 * The activities the *system* provides, keyed by the action an app sends. On a device these are
 * DocumentsUI; here they are the browser's own pickers. Each answers with the result Intent, or
 * null for "the user backed out" — which is RESULT_CANCELED, not an error.
 */
export const systemActivities: Record<string, (intent: JIntent) => Promise<JIntent | null>> = {};
export function registerSystemActivity(action: string, run: (intent: JIntent) => Promise<JIntent | null>) {
  systemActivities[action] = run;
}
export function mkResultIntent(uri: string): JIntent {
  const i = new JIntent();
  i.dataUri = uri;
  return i;
}

/** Post a result to the activity that asked for it. Scheduled, never inline: the caller is
 *  usually mid-click-handler, and androidx dispatches straight into app code from here. */
export function deliverActivityResult(act: JActivity, code: number, resultCode: number, data: JIntent | null) {
  setTimeout(() => void onMain(() =>
    vcall(act, "onActivityResult", "(IILandroid/content/Intent;)V", code, resultCode, data)
      .catch(reportUncaught)), 0);
}
