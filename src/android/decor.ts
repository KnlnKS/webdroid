import { AID } from "./res";
import type { AppHost } from "./apphost";
import { JTheme, rvInt, themeOf, themeByName, rvDimen, rvColor } from "./res";
import { type JDrawable, loadDrawableRV, JColorDrawable } from "./drawable";
import { JView, JMarginLP, addUnattachedView, requestLayout } from "./view";
import { manifestActivityTheme } from "./pm";
import { device } from "../shell/config";
import type { JActivity } from "./app";
import { JFrameLayout, JLinearLayout } from "./layouts";
import { rt } from "../jvm/runtime";
import { JActionBarView } from "./menu";
import { TV } from "./axml";
import { darken } from "./window";
import { sysIns, type JWindowInsets } from "./windowinsets";
import { vcall } from "../jvm/natives/jlang";

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

/** what a window paints behind its content, from its own theme */
async function windowBackground(host: AppHost, theme: JTheme): Promise<JDrawable> {
  const winBg = theme.lookup(AID("windowBackground"));
  if (winBg) return loadDrawableRV(host.res, winBg, theme);
  const d = new JColorDrawable();
  d.color = -328966;
  return d;
}
/** AOSP's starting window: the system resolves the launch theme out of the manifest — before
 *  the activity class is linked, let alone run — and paints its background. Same body as the
 *  decor's, because it is the same attribute of the same theme. */
export async function startingWindow(host: AppHost, cls: string): Promise<{ view: JView; fullscreen: boolean }> {
  let theme = host.theme;
  const id = manifestActivityTheme(cls);
  if (id) {
    theme = new JTheme();
    theme.res = host.res;
    theme.styles = host.theme.styles.slice();
    theme.apply(id);
  }
  const v = new JView();
  v.jres = host.res;
  v.theme = theme;
  v.background = await windowBackground(host, theme);
  v.left = v.top = 0;
  v.right = device.width;
  v.bottom = device.height;
  // a *.Fullscreen launch theme takes the status bar's rows too, exactly as ensureDecor reads it
  return { view: v, fullscreen: !!rvInt(host.res, theme.lookup(AID("windowFullscreen")), 0) };
}
export async function ensureDecor(act: JActivity) {
  if (act.window.decor) return;
  const host = act.$host;
  const theme: JTheme = themeOf(act) ?? host.theme;
  act.window.translucent = !!rvInt(host.res, theme.lookup(AID("windowIsTranslucent")), 0);
  const decor = new JDecorView();
  decor.ctx = act;
  decor.jres = host.res;
  decor.theme = theme;
  decor.background = await windowBackground(host, theme);
  const noTitle = rvInt(host.res, themeByName(host.res, theme, "windowNoTitle"), 0);
  const actionBar = rvInt(host.res, themeByName(host.res, theme, "windowActionBar"), noTitle ? 0 : 1);
  // a *.Fullscreen theme is the same request as Window.addFlags(FLAG_FULLSCREEN): no status bar
  if (rvInt(host.res, theme.lookup(AID("windowFullscreen")), 0)) act.window.flags |= 1024;
  const root = new JLinearLayout();
  root.orientation = 1;
  root.ctx = act;
  root.jres = host.res;
  root.theme = theme;
  {
    const lp = rt.make("android/widget/LinearLayout$LayoutParams");
    lp.width = -1; lp.height = -1;
    root.lp = lp;
  }
  if (actionBar && !noTitle) {
    const bar = new JActionBarView();
    bar.ctx = act;
    bar.jres = host.res;
    bar.theme = theme;
    bar.titleStr = act.titleStr || host.appLabel;
    bar.barH = rvDimen(host.res, theme.lookup(AID("actionBarSize")), 112) || 112;
    const abStyle = theme.lookup(AID("actionBarStyle"));
    let bg: RVLike | null = null;
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
    let bgD = bg ? await loadDrawableRV(host.res, bg as any, theme) : null;
    if (!bgD || (bgD instanceof JColorDrawable && !bgD.color)) {
      const c = new JColorDrawable();
      c.color = primary ? rvColor(host.res, primary, -12303292) : -12303292;
      bgD = c;
    }
    bar.background = bgD;
    if (host.iconRes) bar.icon = await loadDrawableRV(host.res, { t: TV.REFERENCE, d: host.iconRes }, theme);
    const upv = theme.lookup(AID("homeAsUpIndicator"));
    if (upv) bar.upDrawable = await loadDrawableRV(host.res, upv as any, theme);
    if (bgD instanceof JColorDrawable) host.statusBarColor = darken(bgD.color);
    const sbc = theme.lookup(AID("statusBarColor"));
    if (sbc) host.statusBarColor = rvColor(host.res, sbc, host.statusBarColor);
    const lp = rt.make("android/widget/LinearLayout$LayoutParams");
    lp.width = -1; lp.height = -2;
    bar.lp = lp;
    addUnattachedView(root, bar);
    act.window.actionBarView = bar;
  } else {
    const sbc = theme.lookup(AID("statusBarColor"));
    host.statusBarColor = sbc ? rvColor(host.res, sbc, -16777216) : -16777216;
  }
  const content = new JFrameLayout();
  content.ctx = act;
  content.jres = host.res;
  content.theme = theme;
  content.idNum = 0x01020002; // android.R.id.content
  {
    const lp = rt.make("android/widget/LinearLayout$LayoutParams");
    lp.width = -1; lp.height = 0;
    (lp as any).weight = 1;
    content.lp = lp;
  }
  addUnattachedView(root, content);
  {
    const lp2 = rt.make("android/widget/FrameLayout$LayoutParams");
    lp2.width = -1; lp2.height = -1;
    root.lp = lp2;
  }
  addUnattachedView(decor, root);
  act.window.decor = decor;
  decor.windowOwner = act.window;
  act.window.contentParent = content;
}
type RVLike = { t: number; d: number };
