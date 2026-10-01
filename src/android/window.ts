import { AID, rvInt, rvColor, rvFloat, themeOf, type JTheme } from "./res";
import { rt, JObj, callSelf, stubs, noops, driven, flagGetters, flagSetters, type Gen } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import type { JFrameLayout } from "./layouts";
import type { JActionBarView } from "./menu";
import { type JDrawable, loadDrawable } from "./drawable";
import { requestLayout, findById, invalidate, dispatchAttached, dispatchDetached, uiState, JLayoutParams, type JView, setViewBackground } from "./view";
import { JActivity, activityMethods } from "./app";
import { ensureDecor } from "./decor";
import { newObj, vcall } from "../jvm/natives/jlang";
import { appHost } from "./apphost";
import { systemService } from "./context";
import { defaultDisplay } from "./display";
import { device } from "../shell/config";
import { rootWindowInsets } from "./windowinsets";
import { addOverlay, removeOverlay, overlays } from "./popup";

// ── Window + decor + ActionBar-lite
/** PhoneWindow's own content handling, not the Dialog subclass's override: appcompat's
 *  setContentView override installs its sub-decor THROUGH Window.setContentView, so dispatching
 *  back to the override would recurse. */
const dialogNative = (name: string, desc: string) => rt.link("android/app/Dialog").ctor.prototype[mangleMethod(name, desc)] as (...a: unknown[]) => unknown;
export class JWindow extends JObj {
  activity: any = null;
  decor: JFrameLayout | null = null;
  contentParent: JFrameLayout | null = null;
  actionBarView: JActionBarView | null = null;
  callbackObj: unknown = null;
  /** a Dialog's window: content goes to the dialog, the context is the dialog's */
  dialog: unknown = null;
  features = new Set<number>();
  /** the window's OnBackInvokedDispatcher (AOSP: one per ViewRootImpl) */
  backD: JObj | null = null;
  backDispatcher(): JObj { return this.backD ??= rt.make("android/window/OnBackInvokedDispatcher"); }
  /** WindowManager.LayoutParams flags; FLAG_FULLSCREEN hides the status bar inset (windowinsets.ts) */
  flags = 0;
  translucent = false;
  decorFitsSystemWindows = true;
  fitInsetsSides = 15;
  fitInsetsTypes = 7;
  fitInsetsIgnoringVisibility = false;
  hiddenInsets = 0;
  screenBrightness = -1;
  colorMode = 0;
  /** WindowManager.LayoutParams width/height/gravity/dimAmount, which size and place a dialog
   *  window; `bg` is an explicit setBackgroundDrawable (a dialog window draws it as its frame). */
  layoutW = -2; layoutH = -2; gravity = 0; dimAmount = Number.NaN;
  bg: JDrawable | null = null; bgSet = false;
  /** WindowInsetsController appearance bits */
  appearance = 0;
  barsBehavior = 1;
  statusBarColor: number | null = null;
  navBarColor: number | null = null;
  navBarDividerColor = 0;
  insetsController: JInsetsController | null = null;
  /** activity transitions by name; an absent entry is PhoneWindow's USE_DEFAULT_TRANSITION */
  transitions: Record<string, unknown> = {};
  allowEnterOverlap = true; allowReturnOverlap = true; sharedElementsUseOverlay = true;
}
const T = "Landroid/transition/Transition;";
/** PhoneWindow: a return or reenter transition left at its default is the enter or exit one */
const transitionMethods = Object.fromEntries(([["Enter"], ["Exit"], ["Return", "Enter"], ["Reenter", "Exit"],
  ["SharedElementEnter"], ["SharedElementExit"], ["SharedElementReturn", "SharedElementEnter"], ["SharedElementReenter", "SharedElementExit"]] as const)
  .flatMap(([name, fallback]: readonly [string, string?]) => [
    [`set${name}Transition(${T})V`, function (this: JWindow, t: unknown) { this.transitions[name] = t; }],
    [`get${name}Transition()${T}`, function (this: JWindow) {
      const t = this.transitions;
      return name in t ? t[name] : fallback ? t[fallback] ?? null : null;
    }],
  ]));
export function applyWindowTheme(window: JWindow, theme: JTheme, statusDefault = -16777216) {
  window.statusBarColor ??= rvColor(theme.res, theme.lookup(AID("statusBarColor")), statusDefault);
  window.navBarColor ??= rvColor(theme.res, theme.lookup(AID("navigationBarColor")), -16777216);
  if (rvInt(theme.res, theme.lookup(AID("windowFullscreen")), 0)) window.flags |= 1024;
  // PhoneWindow: backgroundDimEnabled defaults to windowIsFloating, and an amount the app set stays
  const floating = rvInt(theme.res, theme.lookup(AID("windowIsFloating")), 0);
  if (rvInt(theme.res, theme.lookup(AID("backgroundDimEnabled")), floating)) {
    window.flags |= FLAG_DIM_BEHIND;
    if (Number.isNaN(window.dimAmount)) window.dimAmount = rvFloat(theme.res, theme.lookup(AID("backgroundDimAmount")), 0.5);
  }
}
const FLAG_DIM_BEHIND = 2;
/** how much a window darkens what lies behind it */
export const windowDim = (w: JWindow): number => (w.flags & FLAG_DIM_BEHIND ? w.dimAmount : 0);
class JInsetsController extends JObj { w: JWindow = null!; }
/** A change to how a window is sized or placed relays out its tree: an activity's decor or a
 *  dialog's frame. A window not built yet lays out fresh when it is. */
function relayoutWindow(w: JWindow) {
  uiState.needsInsets = true;
  const root = w.decor ?? (w.dialog as { root?: JView | null } | null)?.root;
  if (!root) return;
  requestLayout(root);
  // a shown dialog's window: WindowManager.updateViewLayout takes its new flags
  const o = overlays.find((o) => o.view === root);
  if (o) o.flags = w.flags;
}
/** FLAG_FULLSCREEN moves the window's top edge, so a flag change is a relayout of the decor. */
function setWindowFlags(w: JWindow, flags: number) {
  if (w.flags === flags) return;
  w.flags = flags;
  relayoutWindow(w);
}

export function darken(c: number): number {
  const r = Math.max(0, ((c >> 16) & 0xff) * 0.8) | 0;
  const g = Math.max(0, ((c >> 8) & 0xff) * 0.8) | 0;
  const b = Math.max(0, (c & 0xff) * 0.8) | 0;
  return (0xff000000 | (r << 16) | (g << 8) | b) | 0;
}

rt.register({
  name: "android/view/Window", ctor: JWindow,
  methods: {
    ...transitionMethods,
    ...flagSetters({ "setAllowEnterTransitionOverlap(Z)V": "allowEnterOverlap", "setAllowReturnTransitionOverlap(Z)V": "allowReturnOverlap",
      "setSharedElementsUseOverlay(Z)V": "sharedElementsUseOverlay" }),
    ...flagGetters({ "getAllowEnterTransitionOverlap()Z": "allowEnterOverlap", "getAllowReturnTransitionOverlap()Z": "allowReturnOverlap",
      "getSharedElementsUseOverlay()Z": "sharedElementsUseOverlay" }),
    "getDecorView()Landroid/view/View;": driven(function* (this: JWindow): Gen {
      // AOSP installs the real decor on first access (appcompat asks for it before
      // setContentView); dialog windows materialize a bare one so insets helpers can operate
      if (!this.decor && this.activity instanceof JActivity) yield ensureDecor(this.activity);
      return this.decor ??= yield newObj("android/widget/FrameLayout", "(Landroid/content/Context;)V", this.activity);
    }),
    "isFloating()Z": function (this: JWindow) {
      const theme = this.decor?.theme ?? themeOf(this.activity);
      return theme ? +!!rvInt(theme.res, theme.lookup(AID("windowIsFloating")), 0) : 0;
    },
    "peekDecorView()Landroid/view/View;": function (this: JWindow) { return this.decor; },
    "superDispatchTouchEvent(Landroid/view/MotionEvent;)Z": function (this: JWindow, event: unknown) {
      return this.decor ? vcall(this.decor, "dispatchTouchEvent", "(Landroid/view/MotionEvent;)Z", event) : 0;
    },
    "findViewById(I)Landroid/view/View;": driven(function* (this: JWindow, id: number): Gen {
      return findById(yield vcall(this, "getDecorView", "()Landroid/view/View;"), id);
    }),
    "setContentView(I)V": function (this: JWindow, id: number) {
      if (this.dialog) return dialogNative("setContentView", "(I)V").call(this.dialog, id);
      return callSelf(activityMethods, "setContentView(I)V", this.activity, id);
    },
    "setContentView(Landroid/view/View;)V": function (this: JWindow, v: unknown) {
      if (this.dialog) return dialogNative("setContentView", "(Landroid/view/View;)V").call(this.dialog, v);
      return callSelf(activityMethods, "setContentView(Landroid/view/View;)V", this.activity, v);
    },
    "setContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": function (this: JWindow, v: unknown, lp: unknown) {
      if (this.dialog) return dialogNative("setContentView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V").call(this.dialog, v, lp);
      return callSelf(activityMethods, "setContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V", this.activity, v, lp);
    },
    "addContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": function (this: JWindow, v: unknown, lp: unknown) {
      if (this.dialog) return dialogNative("addContentView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V").call(this.dialog, v, lp);
      return callSelf(activityMethods, "addContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V", this.activity, v, lp);
    },
    "setFlags(II)V": function (this: JWindow, flags: number, mask: number) { setWindowFlags(this, (this.flags & ~mask) | (flags & mask)); },
    "addFlags(I)V": function (this: JWindow, f: number) { setWindowFlags(this, this.flags | f); },
    "clearFlags(I)V": function (this: JWindow, f: number) { setWindowFlags(this, this.flags & ~f); },
    "setDecorFitsSystemWindows(Z)V": function (this: JWindow, fits: number) {
      if (this.decorFitsSystemWindows === !!fits) return;
      this.decorFitsSystemWindows = !!fits;
      relayoutWindow(this);
    },
    "requestFeature(I)Z": function (this: JWindow, f: number) { this.features.add(f); return 1; },
    "setStatusBarColor(I)V": function (this: JWindow, c: number) {
      this.statusBarColor = c; invalidate();
    },
    "getStatusBarColor()I": function (this: JWindow) { return this.statusBarColor ?? -16777216; },
    "getNavigationBarColor()I": function (this: JWindow) { return this.navBarColor ?? -16777216; },
    "setNavigationBarColor(I)V": function (this: JWindow, c: number) { this.navBarColor = c; invalidate(); },
    "setNavigationBarDividerColor(I)V": function (this: JWindow, c: number) { this.navBarDividerColor = c; invalidate(); },
    "getNavigationBarDividerColor()I": function (this: JWindow) { return this.navBarDividerColor; },
    "setBackgroundDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JWindow, d: JDrawable | null) {
      this.bg = d; this.bgSet = true;
      invalidate();
      if (this.activity && this.decor) return setViewBackground(this.decor, d);
    },
    "setBackgroundDrawableResource(I)V": driven(function* (this: JWindow, id: number): Gen {
      if (!appHost) return;
      yield vcall(this, "setBackgroundDrawable", "(Landroid/graphics/drawable/Drawable;)V", yield loadDrawable(appHost.res, id, appHost.theme));
    }),
    "getAttributes()Landroid/view/WindowManager$LayoutParams;": function (this: JWindow) {
      const lp = rt.make("android/view/WindowManager$LayoutParams");
      lp.flags = this.flags;
      lp.screenBrightness = this.screenBrightness;
      lp.colorMode = this.colorMode;
      lp.fitInsetsSides = this.fitInsetsSides;
      lp.fitInsetsTypes = this.fitInsetsTypes;
      lp.fitInsetsIgnoringVisibility = this.fitInsetsIgnoringVisibility;
      return lp;
    },
    "setAttributes(Landroid/view/WindowManager$LayoutParams;)V": function (this: JWindow, lp: JWindowLayoutParams | null) {
      if (!lp) return;
      if (this.screenBrightness === lp.screenBrightness && this.flags === lp.flags &&
          this.colorMode === lp.colorMode &&
          this.fitInsetsSides === lp.fitInsetsSides && this.fitInsetsTypes === lp.fitInsetsTypes &&
          this.fitInsetsIgnoringVisibility === lp.fitInsetsIgnoringVisibility) return;
      this.screenBrightness = lp.screenBrightness;
      this.colorMode = lp.colorMode;
      this.flags = lp.flags;
      this.fitInsetsSides = lp.fitInsetsSides;
      this.fitInsetsTypes = lp.fitInsetsTypes;
      this.fitInsetsIgnoringVisibility = lp.fitInsetsIgnoringVisibility;
      relayoutWindow(this);
    },
    "setColorMode(I)V": function (this: JWindow, mode: number) { this.colorMode = mode; },
    "getColorMode()I": function (this: JWindow) { return this.colorMode; },
    "isWideColorGamut()Z": () => 0,
    "getCallback()Landroid/view/Window$Callback;": function (this: JWindow) { return this.callbackObj ?? this.activity; },
    "getOnBackInvokedDispatcher()Landroid/window/OnBackInvokedDispatcher;": function (this: JWindow) { return this.backDispatcher(); },
    "setCallback(Landroid/view/Window$Callback;)V": function (this: JWindow, cb: unknown) { this.callbackObj = cb; },
    "setTitle(Ljava/lang/CharSequence;)V": function (this: JWindow, t: unknown) {
      if (this.activity) callSelf(activityMethods, "setTitle(Ljava/lang/CharSequence;)V", this.activity, t);
    },
    "getContext()Landroid/content/Context;": function (this: JWindow) { return this.activity ?? (this.dialog as { jctx?: unknown } | null)?.jctx ?? null; },
    "setLayout(II)V": function (this: JWindow, w: number, h: number) { this.layoutW = w; this.layoutH = h; relayoutWindow(this); },
    "setGravity(I)V": function (this: JWindow, g: number) { this.gravity = g; relayoutWindow(this); },
    "setDimAmount(F)V": function (this: JWindow, a: number) { this.dimAmount = a; invalidate(); },
    "getWindowManager()Landroid/view/WindowManager;": function (this: JWindow) { return systemService(this.activity, "window"); },
    "hasFeature(I)Z": function (this: JWindow, f: number) { return this.features.has(f) ? 1 : 0; },
    "getInsetsController()Landroid/view/WindowInsetsController;": function (this: JWindow) {
      if (!this.insetsController) { rt.link("webdroid/InsetsController"); this.insetsController = new JInsetsController(); this.insetsController.w = this; }
      return this.insetsController;
    },
    ...noops("addOnFrameMetricsAvailableListener(Landroid/view/Window$OnFrameMetricsAvailableListener;Landroid/os/Handler;)V",
      "removeOnFrameMetricsAvailableListener(Landroid/view/Window$OnFrameMetricsAvailableListener;)V",
      "setSoftInputMode(I)V", "setWindowAnimations(I)V", "setFeatureInt(II)V"),
  },
});
// API-30 window state, shared by decor's inset consumption and the shell's bar rendering.
rt.register({
  name: "android/view/WindowInsetsController", ctor: class extends JObj {},
  statics: { APPEARANCE_LOW_PROFILE_BARS: 4, APPEARANCE_LIGHT_STATUS_BARS: 8, APPEARANCE_LIGHT_NAVIGATION_BARS: 16,
    BEHAVIOR_DEFAULT: 1, BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE: 2 },
});
rt.markers("android/view/WindowInsetsController$OnControllableInsetsChangedListener");
rt.register({
  name: "webdroid/InsetsController", ctor: JInsetsController, ifaces: ["android/view/WindowInsetsController"],
  methods: {
    "setSystemBarsAppearance(II)V": function (this: JInsetsController, v: number, mask: number) {
      const w = this.w;
      w.appearance = (w.appearance & ~mask) | (v & mask);
      invalidate();
    },
    "getSystemBarsAppearance()I": function (this: JInsetsController) { return this.w.appearance; },
    "setSystemBarsBehavior(I)V": function (this: JInsetsController, b: number) { this.w.barsBehavior = b; },
    "getSystemBarsBehavior()I": function (this: JInsetsController) { return this.w.barsBehavior; },
    "addOnControllableInsetsChangedListener(Landroid/view/WindowInsetsController$OnControllableInsetsChangedListener;)V": function (this: JInsetsController, listener: unknown) {
      return vcall(listener, "onControllableInsetsChanged", "(Landroid/view/WindowInsetsController;I)V", this, 0);
    },
    "show(I)V": function (this: JInsetsController, mask: number) { this.w.hiddenInsets &= ~mask; relayoutWindow(this.w); },
    "hide(I)V": function (this: JInsetsController, mask: number) { this.w.hiddenInsets |= mask; relayoutWindow(this.w); },
    ...noops(
      "removeOnControllableInsetsChangedListener(Landroid/view/WindowInsetsController$OnControllableInsetsChangedListener;)V",
      "controlWindowInsetsAnimation(IJLandroid/view/animation/Interpolator;Landroid/os/CancellationSignal;Landroid/view/WindowInsetsAnimationControlListener;)V"),
  },
});
export class JWindowLayoutParams extends JLayoutParams {
  width = -1; height = -1; gravity = 0; flags = 0; format = 1; type = 2; softInputMode = 0;
  x = 0; y = 0; windowAnimations = 0; dimAmount = 0.6; alpha = 1; layoutInDisplayCutoutMode = 0;
  token: JObj | null = null;
  title: unknown = "";
  preferredDisplayModeId = 0;
  preferredRefreshRate = 0;
  screenBrightness = -1;
  colorMode = 0;
  fitInsetsSides = 15;
  fitInsetsTypes = 7;
  fitInsetsIgnoringVisibility = false;
}
rt.register({
  name: "android/view/WindowManager$LayoutParams", sup: "android/view/ViewGroup$LayoutParams", ctor: JWindowLayoutParams,
  fields: ["width", "height", "gravity", "flags", "x", "y", "softInputMode", "windowAnimations", "dimAmount", "alpha",
    "format", "type", "layoutInDisplayCutoutMode", "token", "preferredDisplayModeId", "preferredRefreshRate", "screenBrightness"],
  statics: { MATCH_PARENT: -1, WRAP_CONTENT: -2, FLAG_FULLSCREEN: 1024, FLAG_KEEP_SCREEN_ON: 128, TYPE_APPLICATION: 2, SOFT_INPUT_ADJUST_RESIZE: 16, SOFT_INPUT_STATE_HIDDEN: 3,
    // no real display cutout in a fixed-viewport screen — the field just stores/reports whatever the app sets.
    LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT: 0, LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES: 1,
    LAYOUT_IN_DISPLAY_CUTOUT_MODE_NEVER: 2, LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS: 3, LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS_ALLOWED: 4 },
  methods: {
    ...noops("<init>()V"),
    "<init>(IIIII)V": function (this: JWindowLayoutParams, w: number, h: number, type: number, flags: number, format: number) {
      Object.assign(this, { width: w, height: h, type, flags, format });
    },
    ...stubs(0, "copyFrom(Landroid/view/WindowManager$LayoutParams;)I"),
    "setTitle(Ljava/lang/CharSequence;)V": function (this: { title: unknown }, title: unknown) { this.title = title ?? ""; },
    "setColorMode(I)V": function (this: JWindowLayoutParams, mode: number) { this.colorMode = mode; },
    "getColorMode()I": function (this: JWindowLayoutParams) { return this.colorMode; },
    "getTitle()Ljava/lang/CharSequence;": function (this: { title: unknown }) { return this.title; },
    "setFitInsetsSides(I)V": function (this: JWindowLayoutParams, value: number) { this.fitInsetsSides = value; },
    "getFitInsetsSides()I": function (this: JWindowLayoutParams) { return this.fitInsetsSides; },
    "setFitInsetsTypes(I)V": function (this: JWindowLayoutParams, value: number) { this.fitInsetsTypes = value; },
    "getFitInsetsTypes()I": function (this: JWindowLayoutParams) { return this.fitInsetsTypes; },
    "setFitInsetsIgnoringVisibility(Z)V": function (this: JWindowLayoutParams, value: number) { this.fitInsetsIgnoringVisibility = !!value; },
    "isFitInsetsIgnoringVisibility()Z": function (this: JWindowLayoutParams) { return +this.fitInsetsIgnoringVisibility; },
  },
});
/** the WindowManager parameters of a window's root view, when it was added with them */
export const windowParams = (v: JView) => v.lp instanceof JWindowLayoutParams ? v.lp : null;
export const addWindow = driven(function* addWindow(v: JView, lp: JLayoutParams & { x?: number; y?: number }): Gen {
  v.lp = lp;
  v.windowOwner ??= rt.make("android/view/Window");
  addOverlay(v, lp.x ?? 0, lp.y ?? 0, windowParams(v)?.flags ?? 0);
  yield dispatchAttached(v);
});
export const removeWindow = driven(function* removeWindow(v: JView): Gen {
  removeOverlay(v);
  yield dispatchDetached(v);
});
rt.markers("android/view/WindowManager");
class JWindowMetrics extends JObj {}
rt.register({
  name: "android/view/WindowMetrics", ctor: JWindowMetrics,
  methods: {
    "getBounds()Landroid/graphics/Rect;": function () { return newObj("android/graphics/Rect", "(IIII)V", 0, 0, device.width, device.height); },
    "getDensity()F": () => device.density,
    "getWindowInsets()Landroid/view/WindowInsets;": () => rootWindowInsets(),
  },
});
rt.register({
  name: "android/view/WindowManagerImpl", ctor: class extends JObj {}, ifaces: ["android/view/WindowManager"],
  methods: {
    "getDefaultDisplay()Landroid/view/Display;": defaultDisplay,
    "getCurrentWindowMetrics()Landroid/view/WindowMetrics;": () => new JWindowMetrics(),
    "getMaximumWindowMetrics()Landroid/view/WindowMetrics;": () => new JWindowMetrics(),
    "isCrossWindowBlurEnabled()Z": () => 0,
    "addView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": addWindow,
    "removeView(Landroid/view/View;)V": removeWindow,
    "removeViewImmediate(Landroid/view/View;)V": removeWindow,
    "updateViewLayout(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": (v: JView, lp: JLayoutParams & { x?: number; y?: number }) => {
      v.lp = lp;
      const o = overlays.find((o) => o.view === v);
      if (o) Object.assign(o, { x: lp.x ?? 0, y: lp.y ?? 0, flags: windowParams(v)?.flags ?? 0 });
      requestLayout(v);
    },
  },
});
