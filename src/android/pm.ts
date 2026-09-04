// android.content.pm: the package-metadata records. The half that answers from the running
// app's manifest (PackageManager, ApplicationInfo, PackageInfo) stays in app.ts, which owns
// the host and manifest state those read.

import { rt, JObj } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { jarray } from "../jvm/abi";
import { JBundle } from "./os";

class JFeatureInfo extends JObj {
  name: string | null = null;   // null on the glEsVersion entry, as AOSP leaves it
  version = 0;
  reqGlEsVersion = 0;           // GL_ES_VERSION_UNDEFINED
  flags = 0;
}
rt.register({
  name: "android/content/pm/FeatureInfo", ctor: JFeatureInfo, ifaces: ["android/os/Parcelable"],
  statics: { FLAG_REQUIRED: 1, GL_ES_VERSION_UNDEFINED: 0 },
  fields: { name: "name", version: "version", reqGlEsVersion: "reqGlEsVersion", flags: "flags" },
  methods: {
    "<init>()V": function () {},
    "getGlEsVersion()Ljava/lang/String;": function (this: JFeatureInfo) {
      return (this.reqGlEsVersion >> 16) + "." + (this.reqGlEsVersion & 0xffff);
    },
    "toString()Ljava/lang/String;": function (this: JFeatureInfo) {
      return this.name ? "FeatureInfo{" + this.name + "}" : "FeatureInfo{glEsVers=" + (this.reqGlEsVersion >> 16) + "}";
    },
  },
});
export const signatures = () => jarray([new (rt.link("android/content/pm/Signature").ctor)()], "Landroid/content/pm/Signature;");
rt.register({
  name: "android/content/pm/PackageManager$NameNotFoundException",
  ctor: (() => { const p = rt.link("java/lang/Exception").ctor; return class extends p {}; })(),
  sup: "java/lang/Exception",
});
export class JActivityInfo extends JObj {
  theme = 0; name = ""; packageName = ""; configChanges = 0; exported = 0;
  permission: string | null = null;
  parentActivityName: string | null = null; metaData: JBundle | null = null;
}
rt.register({
  name: "android/content/pm/ActivityInfo", ctor: JActivityInfo, ifaces: ["android/os/Parcelable"],
  fields: {
    theme: "theme", name: "name", packageName: "packageName", configChanges: "configChanges",
    exported: "exported", permission: "permission",
    parentActivityName: "parentActivityName", metaData: "metaData",
  },
  statics: { SCREEN_ORIENTATION_PORTRAIT: 1, SCREEN_ORIENTATION_UNSPECIFIED: -1,
    CONFIG_MCC: 0x0001, CONFIG_MNC: 0x0002, CONFIG_LOCALE: 0x0004, CONFIG_TOUCHSCREEN: 0x0008,
    CONFIG_KEYBOARD: 0x0010, CONFIG_KEYBOARD_HIDDEN: 0x0020, CONFIG_NAVIGATION: 0x0040,
    CONFIG_ORIENTATION: 0x0080, CONFIG_SCREEN_LAYOUT: 0x0100, CONFIG_UI_MODE: 0x0200,
    CONFIG_SCREEN_SIZE: 0x0400, CONFIG_SMALLEST_SCREEN_SIZE: 0x0800, CONFIG_DENSITY: 0x1000,
    CONFIG_LAYOUT_DIRECTION: 0x2000, CONFIG_FONT_SCALE: 0x40000000 },
  methods: { "<init>()V": function () {} },
});
rt.register({
  name: "android/content/pm/ResolveInfo", ctor: class extends JObj {
    activityInfo = null; serviceInfo = null; providerInfo = null; filter = null; priority = 0; preferredOrder = 0;
    match = 0; specificIndex = -1; isDefault = 0; labelRes = 0; nonLocalizedLabel = null; icon = 0; resolvePackageName = null;
  },
  fields: { activityInfo: "activityInfo", serviceInfo: "serviceInfo", providerInfo: "providerInfo", filter: "filter",
    priority: "priority", preferredOrder: "preferredOrder", match: "match", specificIndex: "specificIndex", isDefault: "isDefault",
    labelRes: "labelRes", nonLocalizedLabel: "nonLocalizedLabel", icon: "icon", resolvePackageName: "resolvePackageName" },
  methods: {
    "<init>()V": function () {},
    "loadLabel(Landroid/content/pm/PackageManager;)Ljava/lang/CharSequence;": async function (this: any, pm: unknown) {
      if (this.nonLocalizedLabel !== null) return this.nonLocalizedLabel;
      const ci = this.activityInfo ?? this.serviceInfo ?? this.providerInfo;
      return ci ? vcall(ci, "loadLabel", "(Landroid/content/pm/PackageManager;)Ljava/lang/CharSequence;", pm) : "";
    },
    "loadIcon(Landroid/content/pm/PackageManager;)Landroid/graphics/drawable/Drawable;": async function (this: any, pm: unknown) {
      const ci = this.activityInfo ?? this.serviceInfo ?? this.providerInfo;
      return ci ? vcall(ci, "loadIcon", "(Landroid/content/pm/PackageManager;)Landroid/graphics/drawable/Drawable;", pm) : null;
    },
  },
});
rt.register({
  name: "android/content/pm/ProviderInfo", ctor: class extends JObj { applicationInfo = null; authority = ""; packageName = ""; metaData = null; name = ""; exported = 0; grantUriPermissions = 0; multiprocess = 0; },
  fields: { applicationInfo: "applicationInfo", authority: "authority", packageName: "packageName", metaData: "metaData", name: "name", exported: "exported", grantUriPermissions: "grantUriPermissions", multiprocess: "multiprocess" },
  methods: { "<init>()V": function () {} },
});
rt.register({
  name: "android/content/pm/ServiceInfo", ctor: class extends JObj { metaData = null; name = ""; packageName = ""; },
  fields: { metaData: "metaData", name: "name", packageName: "packageName" },
  methods: { "<init>()V": function () {} },
});
const FAKE_SIG = new Int8Array(64).fill(-0x55);
rt.register({
  name: "android/content/pm/Signature", ctor: class extends JObj {},
  methods: {
    "<init>()V": function () {},
    "toByteArray()[B": () => FAKE_SIG.slice(),
    "toCharsString()Ljava/lang/String;": () => "ab".repeat(64),
    "hashCode()I": () => 0xabab,
    "equals(Ljava/lang/Object;)Z": function (o: unknown) { return o === this ? 1 : 0; },
  },
});
rt.register({
  name: "android/content/pm/SigningInfo", ctor: class extends JObj {},
  methods: {
    "<init>()V": function () {},
    "hasMultipleSigners()Z": () => 0,
    "hasPastSigningCertificates()Z": () => 0,
    "getApkContentsSigners()[Landroid/content/pm/Signature;": signatures,
    "getSigningCertificateHistory()[Landroid/content/pm/Signature;": () => {
      const a = [new (rt.link("android/content/pm/Signature").ctor)()]; (a as any).$t = "Landroid/content/pm/Signature;"; return a;
    },
  },
});
/** API 33 replaced every int flags parameter with a boxed long, one class per getter family.
 *  Registered from a loop, so the janitor's `name: "..."` grep cannot see these four. */
export class JInfoFlags extends JObj { value = 0n; }
for (const n of ["ApplicationInfoFlags", "ComponentInfoFlags", "PackageInfoFlags", "ResolveInfoFlags"]) {
  const name = "android/content/pm/PackageManager$" + n;
  rt.register({
    name, ctor: class extends JInfoFlags {},
    methods: {
      [`static of(J)L${name};`]: (v: bigint) => {
        const f = new (rt.link(name).ctor)() as JInfoFlags;
        f.value = v;
        return f;
      },
      "getValue()J": function (this: JInfoFlags) { return this.value; },
    },
  });
}
