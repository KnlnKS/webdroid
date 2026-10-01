// IAppWidgetService, under AOSP's AppWidgetManager, AppWidgetProvider and AppWidgetProviderInfo,
// as AppWidgetServiceImpl answers on a device whose launcher hosts no widgets: the providers are
// the installed receivers of APPWIDGET_UPDATE with android.appwidget.provider meta-data, parsed as
// parseAppWidgetProviderInfo does (decoded from the reference AVD's services.jar); no host has
// bound a widget id, so every id is unknown, updates to one reach nothing, and pinning is
// unsupported.
import { JObj, declaredField, rt, noops } from "../jvm/runtime";
import { newArrayList } from "../jvm/natives/jcoll";
import { newObj, scall, staticField, vcall } from "../jvm/natives/jlang";
import { callingIdentity, hostStub } from "./binder";
import { packages } from "./packages";
import { serviceContext } from "./context";

const S = "Ljava/lang/String;", CN = "Landroid/content/ComponentName;", RV = "Landroid/widget/RemoteViews;";
const INFO = "android/appwidget/AppWidgetProviderInfo";
const GET_META_DATA = 0x80, MATCH_DIRECT_BOOT_AWARE = 0x40000, MATCH_DIRECT_BOOT_UNAWARE = 0x80000;
const set = (o: JObj, name: string, value: unknown) => { (o as unknown as Record<string, unknown>)[declaredField(INFO, name)] = value; };
const get = <T>(o: unknown, cls: string, name: string) => (o as Record<string, T>)[declaredField(cls, name)];

/** R.styleable.AppWidgetProviderInfo: [index, field, kind, default] in parseAppWidgetProviderInfo's order */
const ATTRIBUTES: [number, string, "dimension" | "int" | "resource", number | string][] = [
  [1, "minWidth", "dimension", 0], [2, "minHeight", "dimension", 0], [9, "minResizeWidth", "dimension", "minWidth"],
  [10, "minResizeHeight", "dimension", "minHeight"], [15, "maxResizeWidth", "dimension", 0], [16, "maxResizeHeight", "dimension", 0],
  [17, "targetCellWidth", "int", 0], [18, "targetCellHeight", "int", 0], [3, "updatePeriodMillis", "int", 0],
  [4, "initialLayout", "resource", 0], [11, "initialKeyguardLayout", "resource", 0],
];
const LATE_ATTRIBUTES: [number, string, "int" | "resource", number][] = [
  [6, "previewImage", "resource", 0], [14, "previewLayout", "resource", 0], [7, "autoAdvanceViewId", "resource", -1],
  [8, "resizeMode", "int", 0], [12, "widgetCategory", "int", 1], [13, "widgetFeatures", "int", 0], [0, "descriptionRes", "resource", 0],
];
const TA = "android/content/res/TypedArray";
const read = (a: JObj, kind: "int" | "resource", index: number, fallback: number): Promise<number> =>
  vcall(a, kind === "int" ? "getInt" : "getResourceId", "(II)I", index, fallback);

async function parseProvider(pm: JObj, activity: JObj): Promise<JObj | null> {
  const parser = await vcall(activity, "loadXmlMetaData", `(Landroid/content/pm/PackageManager;${S})Landroid/content/res/XmlResourceParser;`,
    pm, "android.appwidget.provider");
  if (!parser) return null;
  try {
    const attrs = await scall("android/util/Xml", "asAttributeSet", "(Lorg/xmlpull/v1/XmlPullParser;)Landroid/util/AttributeSet;", parser);
    let type: number;
    while ((type = await vcall(parser, "next", "()I")) !== 1 && type !== 2);
    if (await vcall(parser, "getName", `()${S}`) !== "appwidget-provider") return null;
    const pkg = get<string>(activity, "android/content/pm/PackageItemInfo", "packageName");
    const info = await newObj(INFO);
    set(info, "provider", await newObj("android/content/ComponentName", `(${S}${S})V`, pkg, get<string>(activity, "android/content/pm/PackageItemInfo", "name")));
    set(info, "providerInfo", activity);
    const app = get<JObj>(activity, "android/content/pm/ComponentInfo", "applicationInfo");
    const res = await vcall(pm, "getResourcesForApplication", "(Landroid/content/pm/ApplicationInfo;)Landroid/content/res/Resources;", app);
    const a: JObj = await vcall(res, "obtainAttributes", `(Landroid/util/AttributeSet;[I)L${TA};`, attrs,
      await staticField("com/android/internal/R$styleable", "AppWidgetProviderInfo"));
    const values: Record<string, number> = {};
    for (const [index, name, kind, fallback] of ATTRIBUTES) {
      const fallbackValue = typeof fallback === "string" ? values[fallback] : fallback;
      if (kind === "dimension") {
        const value = await vcall(a, "peekValue", "(I)Landroid/util/TypedValue;", index);
        values[name] = value ? get<number>(value, "android/util/TypedValue", "data") : fallbackValue;
      } else values[name] = await read(a, kind, index, fallbackValue);
      set(info, name, values[name]);
    }
    const configure: string | null = await vcall(a, "getString", `(I)${S}`, 5);
    if (configure) set(info, "configure", await newObj("android/content/ComponentName", `(${S}${S})V`, pkg, configure));
    set(info, "label", String(await vcall(await vcall(activity, "loadLabel", "(Landroid/content/pm/PackageManager;)Ljava/lang/CharSequence;", pm), "toString", `()${S}`)));
    set(info, "icon", await vcall(activity, "getIconResource", "()I"));
    for (const [index, name, kind, fallback] of LATE_ATTRIBUTES) set(info, name, await read(a, kind, index, fallback));
    await vcall(a, "recycle", "()V");
    return info;
  } finally {
    await vcall(parser, "close", "()V");
  }
}
async function installedProviders(): Promise<JObj[]> {
  const pm = await vcall(await serviceContext(), "getPackageManager", "()Landroid/content/pm/PackageManager;");
  const receivers = await vcall(pm, "queryBroadcastReceivers", "(Landroid/content/Intent;I)Ljava/util/List;",
    await newObj("android/content/Intent", `(${S})V`, "android.appwidget.action.APPWIDGET_UPDATE"), GET_META_DATA | MATCH_DIRECT_BOOT_AWARE | MATCH_DIRECT_BOOT_UNAWARE);
  const providers: JObj[] = [];
  for (const ri of await vcall(receivers, "toArray", "()[Ljava/lang/Object;") as JObj[]) {
    const info = await parseProvider(pm, get<JObj>(ri, "android/content/pm/ResolveInfo", "activityInfo"));
    if (info) providers.push(info);
  }
  return providers;
}
/** AppWidgetServiceImpl.enforceCallFromPackage */
function enforceCallFromPackage(pkg: string): void {
  if (packages.get(pkg)?.uid !== callingIdentity().uid) throw rt.mkThrowable("java/lang/SecurityException", `Package ${pkg} does not belong to ${callingIdentity().uid}`);
}

rt.register({ name: "webdroid/AppWidgetService", ctor: class extends JObj {}, sup: "com/android/internal/appwidget/IAppWidgetService$Stub", methods: {
  [`getInstalledProvidersForProfile(II${S})Landroid/content/pm/ParceledListSlice;`]: async (categories: number, _profile: number, pkg: string | null) => {
    const matching: JObj[] = [];
    for (const info of await installedProviders()) {
      const provider = get<JObj>(info, INFO, "provider");
      if ((get<number>(info, INFO, "widgetCategory") & categories) && (pkg === null || await vcall(provider, "getPackageName", `()${S}`) === pkg)) matching.push(info);
    }
    return newObj("android/content/pm/ParceledListSlice", "(Ljava/util/List;)V", newArrayList(matching));
  },
  [`getAppWidgetIds(${CN})[I`]: () => new Int32Array(0),
  [`getAppWidgetInfo(${S}I)L${INFO};`]: (pkg: string) => { enforceCallFromPackage(pkg); return null; },
  [`getAppWidgetViews(${S}I)${RV}`]: (pkg: string) => { enforceCallFromPackage(pkg); return null; },
  [`getAppWidgetOptions(${S}I)Landroid/os/Bundle;`]: (pkg: string) => { enforceCallFromPackage(pkg); return staticField("android/os/Bundle", "EMPTY"); },
  [`updateAppWidgetIds(${S}[I${RV})V`]: enforceCallFromPackage,
  [`partiallyUpdateAppWidgetIds(${S}[I${RV})V`]: enforceCallFromPackage,
  [`notifyAppWidgetViewDataChanged(${S}[II)V`]: enforceCallFromPackage,
  [`updateAppWidgetOptions(${S}ILandroid/os/Bundle;)V`]: enforceCallFromPackage,
  [`updateAppWidgetProvider(${CN}${RV})V`]: async (provider: JObj) => enforceCallFromPackage(await vcall(provider, "getPackageName", `()${S}`)),
  [`updateAppWidgetProviderInfo(${CN}${S})V`]: async (provider: JObj) => enforceCallFromPackage(await vcall(provider, "getPackageName", `()${S}`)),
  // no launcher here accepts pinned widgets
  "isRequestPinAppWidgetSupported()Z": () => 0,
  [`requestPinAppWidget(${S}${CN}Landroid/os/Bundle;Landroid/content/IntentSender;)Z`]: () => 0,
  ...noops(`notifyProviderInheritance([${CN})V`),
} });
hostStub("appwidget", "webdroid/AppWidgetService");
