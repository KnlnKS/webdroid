import { jclsNameOf, type AppHost } from "./apphost";
import { AID, JTheme, rvInt, themeOf, themeByName, rvDimen, rvColor, type RV } from "./res";
import { type JDrawable, loadDrawableRV } from "./drawable";
import { JView, JMarginLP, addUnattachedView, requestLayout, setViewBackground } from "./view";
import { manifestActivityTheme } from "./pm";
import { device } from "../shell/config";
import type { JActivity } from "./app";
import { JFrameLayout, JLinearLayout } from "./layouts";
import { rt } from "../jvm/runtime";
import { JActionBarView } from "./menu";
import { TV } from "./axml";
import { darken, applyWindowTheme, JWindow } from "./window";
import { sysIns, type JWindowInsets } from "./windowinsets";
import { vcall, newObj, curThread, callOn, after } from "../jvm/natives/jlang";
import { newTheme } from "./resources";

class JDecorView extends JFrameLayout {}
rt.register({
  name: "webdroid/DecorView", ctor: JDecorView, sup: "android/widget/FrameLayout",
  methods: {
    "onApplyWindowInsets(Landroid/view/WindowInsets;)Landroid/view/WindowInsets;": function (this: JDecorView, ins: JWindowInsets) {
      const root = this.children[0], lp = root?.lp;
      if (!(lp instanceof JMarginLP)) return ins;
      const bars = sysIns(ins), fits = this.windowOwner?.decorFitsSystemWindows;
      const top = fits && !(this.systemUiVisibility & 0x400) ? bars.top : 0;
      const bottom = fits && !(this.systemUiVisibility & 0x200) ? bars.bottom : 0;
      if (lp.marginT !== top || lp.marginB !== bottom) {
        lp.marginT = top; lp.marginB = bottom;
        requestLayout(root);
      }
      return vcall(ins, "inset", "(IIII)Landroid/view/WindowInsets;", 0, top, 0, bottom);
    },
  },
});

/** Java calls made on the thread that began a window's setup: AOSP's resource loads keep
 *  per-thread state, and an await resumes on whichever thread is current */
function pinned(): <T>(f: () => T) => T {
  const thread = curThread;
  return (f) => callOn(thread, f);
}
/** what a window paints behind its content, from its own theme */
function windowBackground(host: AppHost, theme: JTheme): JDrawable | null | Promise<JDrawable | null> {
  const winBg = theme.lookup(AID("windowBackground"));
  return winBg ? loadDrawableRV(host.res, winBg, theme) : newObj("android/graphics/drawable/ColorDrawable", "(I)V", -328966);
}
/** AOSP's starting window: the system resolves the launch theme out of the manifest — before
 *  the activity class is linked, let alone run — and paints its background. Same body as the
 *  decor's, because it is the same attribute of the same theme. */
export async function startingWindow(host: AppHost, cls: string): Promise<{ view: JView; fullscreen: boolean }> {
  const on = pinned();
  const theme = await on(() => manifestTheme(host, cls));
  const v = new JView();
  v.jres = host.res;
  v.theme = theme;
  v.windowOwner = new JWindow();
  applyWindowTheme(v.windowOwner, theme);
  await on(() => after(windowBackground(host, theme), (d) => setViewBackground(v, d)));
  v.left = v.top = 0;
  v.right = device.width;
  v.bottom = device.height;
  // a *.Fullscreen launch theme takes the status bar's rows too, exactly as ensureDecor reads it
  return { view: v, fullscreen: !!rvInt(host.res, theme.lookup(AID("windowFullscreen")), 0) };
}
/** the theme the system resolves from the manifest: the activity's own over the application's */
function manifestTheme(host: AppHost, cls: string): JTheme | Promise<JTheme> {
  const id = manifestActivityTheme(cls);
  return id ? newTheme(host.jresources, host.theme, id) : host.theme;
}
export async function ensureDecor(act: JActivity) {
  if (act.window.decor) return;
  const on = pinned();
  const host = act.$host;
  const theme: JTheme = themeOf(act) ?? host.theme;
  const decor = new JDecorView();
  decor.ctx = act;
  decor.jres = host.res;
  decor.theme = theme;
  // PhoneWindow keeps a background set before its decor exists
  await on(() => after(act.window.bgSet ? act.window.bg : windowBackground(host, theme), (d) => setViewBackground(decor, d)));
  const noTitle = rvInt(host.res, themeByName(host.res, theme, "windowNoTitle"), 0);
  const actionBar = rvInt(host.res, themeByName(host.res, theme, "windowActionBar"), noTitle ? 0 : 1);
  let statusDefault = -16777216;
  const inherit = <T extends JView>(v: T): T => { v.ctx = act; v.jres = host.res; v.theme = theme; return v; };
  const layoutParams = (cls: string, width: number, height: number) => Object.assign(rt.make(cls), { width, height });
  const root = inherit(new JLinearLayout());
  root.orientation = 1;
  if (actionBar && !noTitle) {
    const bar = inherit(new JActionBarView());
    bar.titleStr = act.titleStr || host.appLabel;
    bar.barH = rvDimen(host.res, theme.lookup(AID("actionBarSize")), 112) || 112;
    const abStyle = theme.lookup(AID("actionBarStyle"));
    let bg: RV | null = null;
    if (abStyle && (abStyle.t === TV.REFERENCE)) {
      let bgv = host.res.styleLookup(abStyle.d, AID("background"));
      // Widget.Material.ActionBar.Solid#background is ?attr/colorPrimary — an ATTRIBUTE
      // reference, which only the theme can resolve; Holo's is a nine-patch we synthesise.
      if (bgv && bgv.t === TV.ATTRIBUTE) bgv = theme.lookup(bgv.d);
      if (bgv) bg = bgv;
    }
    const primary = theme.lookup(AID("colorPrimary"));
    // The bar paints whatever the style names -- Holo's is a nine-patch, Material's resolves
    // through ?attr/colorPrimary to a colour. Only a flat colour can tint the status bar.
    const COLOR = "android/graphics/drawable/ColorDrawable";
    let bgD = bg ? await on(() => loadDrawableRV(host.res, bg, theme)) : null;
    let flat = bgD && rt.iof(bgD, COLOR) ? await on(() => vcall(bgD, "getColor", "()I")) as number : null;
    if (!bgD || flat === 0) {
      flat = primary ? rvColor(host.res, primary, -12303292) : -12303292;
      bgD = await on(() => newObj(COLOR, "(I)V", flat));
    }
    await on(() => setViewBackground(bar, bgD));
    if (host.iconRes) bar.icon = await on(() => loadDrawableRV(host.res, { t: TV.REFERENCE, d: host.iconRes }, theme));
    const upv = theme.lookup(AID("homeAsUpIndicator"));
    if (upv) bar.upDrawable = await on(() => loadDrawableRV(host.res, upv, theme));
    if (flat !== null) statusDefault = darken(flat);
    bar.lp = layoutParams("android/widget/LinearLayout$LayoutParams", -1, -2);
    addUnattachedView(root, bar);
    act.window.actionBarView = bar;
  }
  applyWindowTheme(act.window, theme, statusDefault);
  // ActivityInfo.isTranslucentOrFloating, of the manifest theme: a theme set in onCreate leaves it
  const declared = await on(() => manifestTheme(host, jclsNameOf(act))), flag = (name: string) => rvInt(host.res, declared.lookup(AID(name)), 0);
  act.window.translucent = !!(flag("windowIsTranslucent") || flag("windowIsFloating"));
  const content = inherit(new JFrameLayout());
  content.idNum = 0x01020002; // android.R.id.content
  content.lp = Object.assign(layoutParams("android/widget/LinearLayout$LayoutParams", -1, 0), { weight: 1 });
  addUnattachedView(root, content);
  root.lp = layoutParams("android/widget/FrameLayout$LayoutParams", -1, -1);
  addUnattachedView(decor, root);
  act.window.decor = decor;
  decor.windowOwner = act.window;
  act.window.contentParent = content;
}
