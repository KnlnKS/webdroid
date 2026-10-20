// IAppWidgetService, under AOSP's AppWidgetManager, AppWidgetProvider and AppWidgetProviderInfo,
// as AppWidgetServiceImpl answers on a device whose launcher hosts no widgets: the providers are
// the installed receivers of APPWIDGET_UPDATE with android.appwidget.provider meta-data, parsed as
// parseAppWidgetProviderInfo does (decoded from the reference AVD's services.jar); no host has
// bound a widget id, so every id is unknown, updates to one reach nothing, and pinning is
// unsupported.
import { awaited, JObj, getDeclared, setDeclared, rt, noops, driven, type Gen } from "../jvm/runtime.ts";
import { newObj, scall, staticField, vcall } from "../jvm/natives/jentry.ts";
import { callingIdentity, parceledList, hostStub, serviceContext } from "./binder.ts";
import { packages, GET_META_DATA, MATCH_DIRECT_BOOT_AWARE, MATCH_DIRECT_BOOT_UNAWARE } from "./packages.ts";

const S = "Ljava/lang/String;", CN = "Landroid/content/ComponentName;", RV = "Landroid/widget/RemoteViews;";
const INFO = "android/appwidget/AppWidgetProviderInfo";

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

function* parseProvider(pm: JObj, activity: JObj): Gen<JObj | null> {
  const parser = yield vcall(activity, "loadXmlMetaData", `(Landroid/content/pm/PackageManager;${S})Landroid/content/res/XmlResourceParser;`,
    pm, "android.appwidget.provider");
  if (!parser) return null;
  try {
    const attrs = yield scall("android/util/Xml", "asAttributeSet", "(Lorg/xmlpull/v1/XmlPullParser;)Landroid/util/AttributeSet;", parser);
    let type: number;
    while ((type = yield vcall(parser, "next", "()I")) !== 1 && type !== 2);
    if ((yield vcall(parser, "getName", `()${S}`)) !== "appwidget-provider") return null;
    const pkg = getDeclared<string>(activity, "android/content/pm/PackageItemInfo", "packageName");
    const info = yield newObj(INFO);
    setDeclared(info, INFO, {
      provider: yield newObj("android/content/ComponentName", `(${S}${S})V`, pkg, getDeclared<string>(activity, "android/content/pm/PackageItemInfo", "name")),
      providerInfo: activity,
    });
    const app = getDeclared<JObj>(activity, "android/content/pm/ComponentInfo", "applicationInfo");
    const res = yield vcall(pm, "getResourcesForApplication", "(Landroid/content/pm/ApplicationInfo;)Landroid/content/res/Resources;", app);
    const a: JObj = yield vcall(res, "obtainAttributes", `(Landroid/util/AttributeSet;[I)L${TA};`, attrs,
      yield staticField("com/android/internal/R$styleable", "AppWidgetProviderInfo"));
    const values: Record<string, number> = {};
    for (const [index, name, kind, fallback] of ATTRIBUTES) {
      const fallbackValue = typeof fallback === "string" ? values[fallback] : fallback;
      if (kind === "dimension") {
        const value = yield vcall(a, "peekValue", "(I)Landroid/util/TypedValue;", index);
        values[name] = value ? getDeclared<number>(value, "android/util/TypedValue", "data") : fallbackValue;
      } else values[name] = yield* awaited(read(a, kind, index, fallbackValue));
    }
    const configure: string | null = yield vcall(a, "getString", `(I)${S}`, 5);
    if (configure) setDeclared(info, INFO, { configure: yield newObj("android/content/ComponentName", `(${S}${S})V`, pkg, configure) });
    setDeclared(info, INFO, { label: String(yield vcall(yield vcall(activity, "loadLabel", "(Landroid/content/pm/PackageManager;)Ljava/lang/CharSequence;", pm), "toString", `()${S}`)) });
    setDeclared(info, INFO, { icon: yield vcall(activity, "getIconResource", "()I") });
    for (const [index, name, kind, fallback] of LATE_ATTRIBUTES) values[name] = yield* awaited(read(a, kind, index, fallback));
    setDeclared(info, INFO, values);
    yield vcall(a, "recycle", "()V");
    return info;
  } finally {
    yield vcall(parser, "close", "()V");
  }
}
function* installedProviders(): Gen<JObj[]> {
  const pm = yield vcall(yield* awaited(serviceContext()), "getPackageManager", "()Landroid/content/pm/PackageManager;");
  const receivers = yield vcall(pm, "queryBroadcastReceivers", "(Landroid/content/Intent;I)Ljava/util/List;",
    yield newObj("android/content/Intent", `(${S})V`, "android.appwidget.action.APPWIDGET_UPDATE"), GET_META_DATA | MATCH_DIRECT_BOOT_AWARE | MATCH_DIRECT_BOOT_UNAWARE);
  const providers: JObj[] = [];
  for (const ri of (yield vcall(receivers, "toArray", "()[Ljava/lang/Object;")) as JObj[]) {
    const info = yield* parseProvider(pm, getDeclared<JObj>(ri, "android/content/pm/ResolveInfo", "activityInfo"));
    if (info) providers.push(info);
  }
  return providers;
}
/** AppWidgetServiceImpl.enforceCallFromPackage */
function enforceCallFromPackage(pkg: string): void {
  if (packages.get(pkg)?.uid !== callingIdentity().uid) throw rt.mkThrowable("java/lang/SecurityException", `Package ${pkg} does not belong to ${callingIdentity().uid}`);
}

const enforceProviderPackage = driven(function* (provider: JObj): Gen<void> {
  enforceCallFromPackage(yield vcall(provider, "getPackageName", `()${S}`));
});

rt.register({ name: "webdroid/AppWidgetService", ctor: class extends JObj {}, sup: "com/android/internal/appwidget/IAppWidgetService$Stub", methods: {
  [`getInstalledProvidersForProfile(II${S})Landroid/content/pm/ParceledListSlice;`]: driven(function* (categories: number, _profile: number, pkg: string | null) {
    const matching: JObj[] = [];
    for (const info of yield* installedProviders()) {
      const provider = getDeclared<JObj>(info, INFO, "provider");
      if ((getDeclared<number>(info, INFO, "widgetCategory") & categories) && (pkg === null || (yield vcall(provider, "getPackageName", `()${S}`)) === pkg)) matching.push(info);
    }
    return parceledList(matching);
  }),
  [`getAppWidgetIds(${CN})[I`]: () => new Int32Array(0),
  [`getAppWidgetInfo(${S}I)L${INFO};`]: (pkg: string) => { enforceCallFromPackage(pkg); return null; },
  [`getAppWidgetViews(${S}I)${RV}`]: (pkg: string) => { enforceCallFromPackage(pkg); return null; },
  [`getAppWidgetOptions(${S}I)Landroid/os/Bundle;`]: (pkg: string) => { enforceCallFromPackage(pkg); return staticField("android/os/Bundle", "EMPTY"); },
  [`updateAppWidgetIds(${S}[I${RV})V`]: enforceCallFromPackage,
  [`partiallyUpdateAppWidgetIds(${S}[I${RV})V`]: enforceCallFromPackage,
  [`notifyAppWidgetViewDataChanged(${S}[II)V`]: enforceCallFromPackage,
  [`updateAppWidgetOptions(${S}ILandroid/os/Bundle;)V`]: enforceCallFromPackage,
  [`updateAppWidgetProvider(${CN}${RV})V`]: enforceProviderPackage,
  [`updateAppWidgetProviderInfo(${CN}${S})V`]: enforceProviderPackage,
  // no launcher here accepts pinned widgets
  "isRequestPinAppWidgetSupported()Z": () => 0,
  [`requestPinAppWidget(${S}${CN}Landroid/os/Bundle;Landroid/content/IntentSender;)Z`]: () => 0,
  ...noops(`notifyProviderInheritance([${CN})V`),
} });
hostStub("appwidget", "webdroid/AppWidgetService");
