import { rt, JObj, type NativeSpec, stubs, type Gen } from "../jvm/runtime.ts";
import { staticField } from "../jvm/natives/jentry.ts";
import { defaultUserAgent } from "./webuseragent.ts";

// ── WebSettings: the app reads back what it wrote, so every setter has its value and getter
const settingsMethods: NonNullable<NativeSpec["methods"]> = {
  // AOSP: null or empty restores the default string
  "setUserAgentString(Ljava/lang/String;)V": function (this: WebSettingsAdapter, s: string | null) { this.v.userAgentString = s || defaultUserAgent(); },
  ...stubs(undefined, "setDatabasePath(Ljava/lang/String;)V", "setGeolocationDatabasePath(Ljava/lang/String;)V", "setEnableSmoothTransition(Z)V"),
};
export class WebSettingsAdapter extends JObj {
  get userAgent(): string { return String(this.v.userAgentString); }
  v: Record<string, unknown> = {
    userAgentString: defaultUserAgent(), cacheMode: -1, textZoom: 100, minimumFontSize: 8, minimumLogicalFontSize: 8, defaultFontSize: 16,
    defaultFixedFontSize: 13, mixedContentMode: 1, forceDark: 1, supportZoom: 1, displayZoomControls: 1, allowContentAccess: 1,
    mediaPlaybackRequiresUserGesture: 1, safeBrowsingEnabled: 1, loadsImagesAutomatically: 1, standardFontFamily: "sans-serif",
    fixedFontFamily: "monospace", sansSerifFontFamily: "sans-serif", serifFontFamily: "serif", cursiveFontFamily: "cursive",
    fantasyFontFamily: "fantasy", defaultTextEncodingName: "UTF-8", acceptThirdPartyCookies: 0,
  };
}
function prop(name: string, d: string, get: string | null = "get" + name) {
  const k = name[0].toLowerCase() + name.slice(1);
  settingsMethods[`set${name}(${d})V`] ??= function (this: WebSettingsAdapter, x: unknown) { this.v[k] = x; };
  if (get) settingsMethods[`${get}()${d}`] = function (this: WebSettingsAdapter) { return this.v[k] ?? (d.length === 1 ? 0 : null); };
}
for (const n of ["JavaScriptEnabled", "DomStorageEnabled", "DatabaseEnabled", "UseWideViewPort", "LoadWithOverviewMode", "BuiltInZoomControls",
  "DisplayZoomControls", "MediaPlaybackRequiresUserGesture", "AllowFileAccess", "AllowContentAccess", "AllowFileAccessFromFileURLs",
  "AllowUniversalAccessFromFileURLs", "JavaScriptCanOpenWindowsAutomatically", "SaveFormData", "SavePassword", "OffscreenPreRaster",
  "SafeBrowsingEnabled", "LoadsImagesAutomatically", "BlockNetworkImage", "BlockNetworkLoads", "AcceptThirdPartyCookies"]) prop(n, "Z");
for (const n of ["CacheMode", "MixedContentMode", "TextZoom", "MinimumFontSize", "MinimumLogicalFontSize", "DefaultFontSize",
  "DefaultFixedFontSize", "ForceDark", "DisabledActionModeMenuItems"]) prop(n, "I");
for (const n of ["UserAgentString", "StandardFontFamily", "FixedFontFamily", "SansSerifFontFamily", "SerifFontFamily", "CursiveFontFamily",
  "FantasyFontFamily", "DefaultTextEncodingName"]) prop(n, "Ljava/lang/String;");
prop("SupportZoom", "Z", "supportZoom"); prop("SupportMultipleWindows", "Z", "supportMultipleWindows");
prop("AlgorithmicDarkeningAllowed", "Z", "isAlgorithmicDarkeningAllowed");
prop("GeolocationEnabled", "Z", null); prop("NeedInitialFocus", "Z", null);
prop("LayoutAlgorithm", "Landroid/webkit/WebSettings$LayoutAlgorithm;"); prop("PluginState", "Landroid/webkit/WebSettings$PluginState;");
prop("RenderPriority", "Landroid/webkit/WebSettings$RenderPriority;", null);
rt.register({ name: "webdroid/WebSettings", ctor: WebSettingsAdapter, sup: "android/webkit/WebSettings", methods: settingsMethods });
export function* newSettings(): Gen<WebSettingsAdapter> {
  const s = rt.make("webdroid/WebSettings") as WebSettingsAdapter;
  s.v.layoutAlgorithm = yield staticField("android/webkit/WebSettings$LayoutAlgorithm", "NARROW_COLUMNS");
  s.v.pluginState = yield staticField("android/webkit/WebSettings$PluginState", "OFF");
  return s;
}
