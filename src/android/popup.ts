// Overlay layer: toasts, popup menus, dialogs-lite. Drawn above the decor by the shell.

import { rt, JObj, type NativeSpec, callSelf, stubs, noops, fieldGetters, flagGetters, fieldSetters, flagSetters, driven, type Gen } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { vcall, vcallUncaught } from "../jvm/natives/jlang";
import { reportUncaught, uptimeMillis } from "./os";
import { JView, JFrameLP, uiState, invalidate, requestLayout, locationOnScreen, attachView, detachView, dispatchAttached, dispatchDetached, measureView, makeSpec, specSize, MS_EXACTLY, MS_AT_MOST } from "./view";
import { JMotionEvent } from "./motionevent";
import { JFrameLayout } from "./layouts";
import { JDrawable, loadDrawableRV } from "./drawable";
import { AID, obtainStyled, rvDimen, rvInt, themeOf, type Resources, type JTheme, type JAttrSet } from "./res";
import { TV } from "./axml";
import { device } from "../shell/config";
import { JContextWrapper, type JContext } from "./context";
import { JCanvas, JRect, measureCtx } from "./graphics";

export interface Overlay {
  view: JView;
  x: number; y: number;
  dismissOnOutside: boolean;
  dim?: () => number;
  modal?: boolean;
  /** the window's own back handling (a Dialog cancels itself); absent means dismiss iff dismissOnOutside */
  onBack?: () => unknown;
  /** how the shell dismisses this window (outside touch / back): a PopupWindow must run its own
   *  dismiss() so its OnDismissListener fires; absent means plain removeOverlay */
  onDismiss?: () => unknown;
}
export const overlays: Overlay[] = [];
export function addOverlay(v: JView, x = 0, y = 0, dismissOnOutside = false, onBack?: () => unknown, onDismiss?: () => unknown) {
  const overlay: Overlay = { view: v, x, y, dismissOnOutside, onBack, onDismiss };
  overlays.push(overlay);
  uiState.needsInsets = true;
  requestLayout(v);
  return overlay;
}
export function dismissOverlay(o: Overlay) { return o.onDismiss ? o.onDismiss() : removeOverlay(o.view); }
/** the windows under it keep their layout; the screen only has to be drawn without it */
export function removeOverlay(v: JView) {
  const i = overlays.findIndex((o) => o.view === v);
  if (i >= 0) overlays.splice(i, 1);
  invalidate();
}

/** ActivityThread closes leaked windows after destruction, without dismissing their dialogs. */
export const detachContextOverlays = driven(function* detachContextOverlays(owner: JContext): Gen<void> {
  for (const o of [...overlays]) {
    let context: unknown = o.view.ctx;
    const visited = new Set<unknown>();
    while (context && !visited.has(context)) {
      if (context === owner) {
        removeOverlay(o.view);
        yield dispatchDetached(o.view);
        break;
      }
      visited.add(context);
      context = context instanceof JContextWrapper ? context.base : null;
    }
  }
});

// toast: plain shell-drawn banner (not a View)
const toasts: { text: string; until: number }[] = [];
export function showToast(text: string) {
  toasts.push({ text, until: uptimeMillis() + 2500 });
  invalidate();
}
export function drawToasts(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number) {
  const now = uptimeMillis();
  for (let i = toasts.length - 1; i >= 0; i--) {
    if (toasts[i].until < now) toasts.splice(i, 1);
  }
  const t = toasts[toasts.length - 1];
  if (!t) return;
  ctx.save();
  ctx.font = `${device.dp(14)}px Roboto, sans-serif`;
  const tw = Math.min(w - device.dp(40), ctx.measureText(t.text).width + device.dp(32));
  const x = (w - tw) / 2, y = h - device.dp(88);
  const alpha = Math.min(1, (t.until - now) / 300);
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.roundRect(x, y, tw, device.dp(44), device.dp(22));
  ctx.fillStyle = "rgba(50,50,50,0.92)";
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(t.text, w / 2, y + device.dp(22), tw - device.dp(24));
  ctx.restore();
  if (toasts.length) invalidate();
}

// simple native popup menu (used by ActionBar overflow, Spinner)
class PopupMenuView extends JView {
  items: { id: number; title: string }[] = [];
  onPick: ((id: number) => void) | null = null;
  itemH = device.dp(48);
  padV = device.dp(8);
}

// android.widget.PopupMenu.OnMenuItemClickListener — pure interface. PopupMenu below already
// vcalls onMenuItemClick(MenuItem)Z from the pick handler; this only lets app classes declare
// `implements` on it.
rt.markers("android/widget/PopupMenu$OnMenuItemClickListener");

rt.register({
  name: "webdroid/PopupMenuView", ctor: PopupMenuView, sup: "android/view/View",
  methods: {
    "onMeasure(II)V": function (this: PopupMenuView) {
      const ctx = measureCtx(`${device.dp(15)}px Roboto, sans-serif`);
      let w = device.dp(120);
      for (const it of this.items) w = Math.max(w, ctx.measureText(it.title).width + device.dp(48));
      this.measuredW = Math.min(device.dp(280), Math.ceil(w));
      this.measuredH = this.items.length * this.itemH + this.padV * 2;
    },
    "onDraw(Landroid/graphics/Canvas;)V": function (this: PopupMenuView, cv: JCanvas) {
      const ctx = cv.ctx;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = device.dp(12);
      ctx.shadowOffsetY = device.dp(3);
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.roundRect(0, 0, this.width(), this.height(), device.dp(4));
      ctx.fill();
      ctx.restore();
      ctx.font = `${device.dp(15)}px Roboto, sans-serif`;
      ctx.fillStyle = "rgba(0,0,0,0.87)";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (let i = 0; i < this.items.length; i++) {
        ctx.fillText(this.items[i].title, device.dp(20), this.padV + i * this.itemH + this.itemH / 2);
      }
    },
    "onTouchEvent(Landroid/view/MotionEvent;)Z": function (this: PopupMenuView, ev: any) {
      if ((ev.action & 0xff) === 1) {
        const i = Math.floor((ev.y - this.padV) / this.itemH);
        removeOverlay(this);
        if (i >= 0 && i < this.items.length) this.onPick?.(this.items[i].id);
      }
      return 1;
    },
  },
});

export function showPopupMenu(anchor: JView, items: { id: number; title: string }[], onPick: (id: number) => void) {
  const v = new PopupMenuView();
  v.items = items;
  v.onPick = onPick;
  v.jres = anchor.jres;
  v.theme = anchor.theme;
  const [x, y] = locationOnScreen(anchor);
  addOverlay(v, Math.max(device.dp(4), Math.min(device.width - device.dp(200), x + anchor.width() - device.dp(200))), y + device.dp(10), true);
}

// ── android.widget.PopupMenu over the overlay popup
class JPopupMenu extends JObj {
  jctx: any = null;
  anchor: JView | null = null;
  menu: any = null;
  clickL: unknown = null;
}
rt.register({
  name: "android/widget/PopupMenu", ctor: JPopupMenu,
  methods: {
    "<init>(Landroid/content/Context;Landroid/view/View;)V": driven(function* (this: JPopupMenu, c: unknown, anchor: JView): Gen {
      this.jctx = c;
      this.anchor = anchor;
      const { JMenu } = yield import("./menu");
      this.menu = new JMenu();
    }),
    "getMenu()Landroid/view/Menu;": function (this: JPopupMenu) { return this.menu; },
    "getMenuInflater()Landroid/view/MenuInflater;": function (this: JPopupMenu) {
      const info = rt.link("android/view/MenuInflater");
      const m = new info.ctor();
      m.jctx = this.jctx;
      return m;
    },
    "inflate(I)V": driven(function* (this: JPopupMenu, id: number): Gen {
      const info = rt.link("android/view/MenuInflater");
      const m = new info.ctor();
      m.jctx = this.jctx;
      yield vcall(m, "inflate", "(ILandroid/view/Menu;)V", id, this.menu);
    }),
    "setOnMenuItemClickListener(Landroid/widget/PopupMenu$OnMenuItemClickListener;)V": function (this: JPopupMenu, l: unknown) {
      this.clickL = l;
    },
    "show()V": function (this: JPopupMenu) {
      const items = (this.menu?.items ?? []).filter((i: any) => i.visible).map((i: any) => ({ id: i.id, title: i.title }));
      showPopupMenu(this.anchor!, items, (id) => {
        const item = (this.menu?.items ?? []).find((i: any) => i.id === id);
        if (this.clickL && item) {
          void vcallUncaught(this.clickL, "onMenuItemClick", "(Landroid/view/MenuItem;)Z", item);
        }
      });
    },
    "dismiss()V": () => {},
  },
});

// ── android.widget.PopupWindow: content wrapped in a decor FrameLayout (AOSP's PopupDecorView +
// PopupBackgroundView collapsed into one) that carries the popup background and turns the
// window's mWidth/mHeight into the content's measure specs.
rt.markers("android/widget/PopupWindow$OnDismissListener");

const M_dispatchTouch = mangleMethod("dispatchTouchEvent", "(Landroid/view/MotionEvent;)Z");
const M_drawableDraw = mangleMethod("draw", "(Landroid/graphics/Canvas;)V");
const WRAP = -2, MATCH = -1;

class PopupDecorView extends JFrameLayout {
  popup: JPopupWindow | null = null;
}
function windowSpec(dim: number, avail: number): number {
  return dim >= 0 ? makeSpec(dim, MS_EXACTLY) : dim === MATCH ? makeSpec(avail, MS_EXACTLY) : makeSpec(avail, MS_AT_MOST | 0);
}
rt.register({
  name: "webdroid/PopupDecorView", ctor: PopupDecorView, sup: "android/widget/FrameLayout",
  methods: {
    "onMeasure(II)V": driven(function* (this: PopupDecorView, wSpec: number, hSpec: number): Gen {
      const p = this.popup!;
      const sup = rt.link("android/widget/FrameLayout").ctor.prototype[mangleMethod("onMeasure", "(II)V")];
      yield sup.call(this, windowSpec(p.w, specSize(wSpec)), windowSpec(p.h, specSize(hSpec)));
    }),
    "dispatchTouchEvent(Landroid/view/MotionEvent;)Z": driven(function* (this: PopupDecorView, ev: JMotionEvent): Gen {
      const p = this.popup!;
      if (p.touchInterceptor && (yield vcall(p.touchInterceptor, "onTouch", "(Landroid/view/View;Landroid/view/MotionEvent;)Z", this, ev))) return 1;
      return rt.link("android/widget/FrameLayout").ctor.prototype[M_dispatchTouch].call(this, ev);
    }),
    "draw(Landroid/graphics/Canvas;)V": driven(function* (this: PopupDecorView, cv: JCanvas): Gen {
      const p = this.popup!;
      // the window's elevation shadow: cast from the background's shape (a filled rect is close
      // enough for the shadow itself; the real background paints over it)
      if (p.elevation > 0 && this.background) {
        const ctx = cv.ctx;
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.3)";
        ctx.shadowBlur = p.elevation * 1.5;
        ctx.shadowOffsetY = p.elevation / 2;
        ctx.globalAlpha = 0.01;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, this.width(), this.height());
        ctx.globalAlpha = 1;
        ctx.restore();
      }
      const sup = rt.link("android/widget/FrameLayout").ctor.prototype[M_drawableDraw];
      yield sup.call(this, cv);
    }),
  },
});

class JPopupWindow extends JObj {
  jctx: any = null;
  content: JView | null = null;
  decor: PopupDecorView | null = null;
  bg: JDrawable | null = null;
  w = WRAP; h = WRAP;
  showing = false;
  focusable = false; outsideTouchable = false; touchable = true; clipping = true;
  overlapAnchor = false; aboveAnchor = false;
  elevation = 0;
  animStyle = -1;
  imMode = 0; softInput = 0; layoutType = 1000;
  dismissL: unknown = null;
  touchInterceptor: unknown = null;
  anchor: JView | null = null;
  xoff = 0; yoff = 0; gravity = 0;
  epicenter: JRect | null = null;
  /** background padding (AOSP mTempRect after getPadding) */
  bgPad(): [number, number, number, number] {
    const p = (this.bg as any)?.padding as JRect | undefined;
    return p ? [p.left, p.top, p.right, p.bottom] : [0, 0, 0, 0];
  }
}
function rootOf(v: JView): JView { let r = v; while (r.parent) r = r.parent; return r; }

const PW_ATTRS = ["popupBackground", "popupElevation", "popupAnimationStyle", "overlapAnchor"] as const;
const pwInit = driven(function* pwInit(this: JPopupWindow, c: any, set: JAttrSet | null, defStyleAttr: number, defStyleRes: number): Gen {
  this.jctx = c;
  const host = c?.$host;
  if (!host) return;
  const res: Resources = host.res, theme: JTheme = themeOf(c) ?? host.theme;
  const ids = PW_ATTRS.map(AID);
  const ta = obtainStyled(res, theme, set, ids, defStyleAttr || AID("popupWindowStyle"), defStyleRes);
  if (ta.vals[0]) this.bg = yield loadDrawableRV(res, ta.vals[0], theme);
  if (ta.vals[1]) this.elevation = rvDimen(res, ta.vals[1], 0);
  if (ta.vals[2]) { const v = ta.vals[2]!; this.animStyle = v.t === TV.REFERENCE ? v.d : -1; }
  if (ta.vals[3]) this.overlapAnchor = !!rvInt(res, ta.vals[3], 0);
});
function pwSetContent(this: JPopupWindow, v: JView | null) {
  if (this.showing) return;
  this.content = v;
  if (!this.jctx && v) this.jctx = v.ctx;
}
/** AOSP getMaxAvailableHeight: the larger of the room below and above the anchor, minus the
 *  background's vertical padding */
function pwMaxAvail(this: JPopupWindow, anchor: JView, yOffset = 0) {
  const [, ay] = locationOnScreen(anchor);
  const bottom = rootOf(anchor).height();
  const toBottom = this.overlapAnchor ? bottom - ay - yOffset : bottom - (ay + anchor.height()) - yOffset;
  const toTop = ay + yOffset;
  const [, pt, , pb] = this.bgPad();
  return Math.max(toBottom, toTop) - (pt + pb);
}
const pwShow = driven(function* pwShow(this: JPopupWindow, x: number, y: number): Gen {
  if (this.showing || !this.content) return;
  this.showing = true;
  const d = this.decor = new PopupDecorView();
  d.popup = this;
  d.ctx = this.jctx;
  const host = this.jctx?.$host;
  if (host) { d.jres = host.res; d.theme = themeOf(this.jctx) ?? host.theme; }
  d.background = this.bg;
  [d.padL, d.padT, d.padR, d.padB] = this.bgPad();
  const lp = new JFrameLP();
  lp.width = MATCH;
  lp.height = this.content.lp?.height === WRAP ? WRAP : MATCH;
  this.content.lp = lp;
  yield attachView(d, this.content);
  const dismiss = () => vcall(this, "dismiss", "()V");
  // a focusable popup takes Back and outside touches; an outsideTouchable one only the touches
  addOverlay(d, x, y, this.focusable || this.outsideTouchable, this.focusable ? dismiss : undefined, dismiss);
  yield dispatchAttached(d);
});
/** AOSP findDropDownPosition, reduced to the vertical flip and screen clamp */
const pwPlace = driven(function* pwPlace(this: JPopupWindow): Gen {
  const a = this.anchor, d = this.decor;
  if (!a || !d) return;
  const root = rootOf(a), sw = root.width() || device.width, sh = root.height() || device.height - device.statusBar;
  yield measureView(d, makeSpec(sw, MS_AT_MOST | 0), makeSpec(sh, MS_AT_MOST | 0));
  const [ax, ay] = locationOnScreen(a);
  let x = ax + this.xoff;
  if ((this.gravity & 7) === 5) x += a.width() - d.measuredW;
  const top = this.overlapAnchor ? ay : ay + a.height();
  let y = top + this.yoff;
  this.aboveAnchor = false;
  if (y + d.measuredH > sh) {
    const above = (this.overlapAnchor ? ay + a.height() : ay) - d.measuredH - this.yoff;
    if (above >= 0 || above > sh - d.measuredH - y) { y = above; this.aboveAnchor = true; }
  }
  if (this.clipping) {
    x = Math.max(0, Math.min(x, sw - d.measuredW));
    y = Math.max(0, Math.min(y, sh - d.measuredH));
  }
  const o = overlays.find((o) => o.view === d);
  if (o) { o.x = x; o.y = y; }
  requestLayout(d);
});
const pwShowDropDown = driven(function* pwShowDropDown(this: JPopupWindow, anchor: JView, xoff: number = 0, yoff: number = 0, gravity: number = 0): Gen {
  if (this.showing || !this.content) return;
  this.anchor = anchor; this.xoff = xoff; this.yoff = yoff; this.gravity = gravity;
  yield pwShow.call(this, 0, 0);
  yield pwPlace.call(this);
});
const pwShowAt = driven(function* pwShowAt(this: JPopupWindow, parent: JView, gravity: number, x: number, y: number): Gen {
  if (this.showing || !this.content) return;
  this.anchor = null;
  yield pwShow.call(this, 0, 0);
  const d = this.decor!;
  const root = parent ? rootOf(parent) : null, sw = root?.width() || device.width, sh = root?.height() || device.height - device.statusBar;
  yield measureView(d, makeSpec(sw, MS_AT_MOST | 0), makeSpec(sh, MS_AT_MOST | 0));
  const hg = gravity & 7, vg = gravity & 0x70;
  const px = hg === 1 ? ((sw - d.measuredW) >> 1) + x : hg === 5 ? sw - d.measuredW - x : x;
  const py = vg === 16 ? ((sh - d.measuredH) >> 1) + y : vg === 80 ? sh - d.measuredH - y : y;
  const o = overlays.find((o) => o.view === d);
  if (o) { o.x = px; o.y = py; }
  requestLayout(d);
});
const pwDismiss = driven(function* pwDismiss(this: JPopupWindow): Gen {
  if (!this.showing) return;
  this.showing = false;
  const d = this.decor;
  this.decor = null;
  if (d) {
    removeOverlay(d);
    yield dispatchDetached(d);
    if (this.content) yield detachView(d, this.content);
  }
  if (this.dismissL) {
    try { yield vcall(this.dismissL, "onDismiss", "()V"); } catch (e) { reportUncaught(e); }
  }
});
function pwUpdate(this: JPopupWindow) {
  if (!this.showing || !this.decor) return;
  requestLayout(this.decor);
  if (this.anchor) return pwPlace.call(this);
}
/** update(anchor, xoff, yoff, width, height): -1 leaves a dimension alone */
function pwUpdateAnchor(this: JPopupWindow, anchor: JView, xoff: number, yoff: number, width: number, height: number) {
  if (width !== -1) this.w = width;
  if (height !== -1) this.h = height;
  if (!this.showing || !this.content) return;
  this.anchor = anchor; this.xoff = xoff; this.yoff = yoff;
  return pwUpdate.call(this);
}
const pwMethods: NonNullable<NativeSpec["methods"]> = {
  "<init>(II)V": function (this: JPopupWindow, w: number, h: number) { this.w = w; this.h = h; },
  "<init>(Landroid/view/View;)V": pwSetContent,
  "<init>(Landroid/view/View;II)V": function (this: JPopupWindow, v: JView, w: number, h: number) { pwSetContent.call(this, v); this.w = w; this.h = h; },
  "<init>(Landroid/view/View;IIZ)V": function (this: JPopupWindow, v: JView, w: number, h: number, f: number) {
    pwSetContent.call(this, v); this.w = w; this.h = h; this.focusable = !!f;
  },
  "<init>(Landroid/content/Context;)V": function (this: JPopupWindow, c: unknown) { return pwInit.call(this, c, null, 0, 0); },
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function (this: JPopupWindow, c: unknown, s: JAttrSet | null) { return pwInit.call(this, c, s, 0, 0); },
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": function (this: JPopupWindow, c: unknown, s: JAttrSet | null, a: number) { return pwInit.call(this, c, s, a, 0); },
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;II)V": pwInit,
  "setContentView(Landroid/view/View;)V": pwSetContent,
  ...fieldGetters({ "getContentView()Landroid/view/View;": "content", "getWidth()I": "w", "getHeight()I": "h",
    "getInputMethodMode()I": "imMode", "getSoftInputMode()I": "softInput", "getWindowLayoutType()I": "layoutType",
    "getAnimationStyle()I": "animStyle", "getElevation()F": "elevation",
    "getEpicenterBounds()Landroid/graphics/Rect;": "epicenter" }),
  ...flagGetters({ "isShowing()Z": "showing", "isFocusable()Z": "focusable",
    "isOutsideTouchable()Z": "outsideTouchable", "isTouchable()Z": "touchable", "isClippingEnabled()Z": "clipping",
    "isClippedToScreen()Z": "clipping", "getOverlapAnchor()Z": "overlapAnchor", "isAboveAnchor()Z": "aboveAnchor" }),
  ...fieldSetters({ "setWidth(I)V": "w", "setHeight(I)V": "h", "setInputMethodMode(I)V": "imMode",
    "setSoftInputMode(I)V": "softInput", "setWindowLayoutType(I)V": "layoutType", "setAnimationStyle(I)V": "animStyle",
    "setElevation(F)V": "elevation", "setEpicenterBounds(Landroid/graphics/Rect;)V": "epicenter" }),
  ...flagSetters({ "setFocusable(Z)V": "focusable", "setOutsideTouchable(Z)V": "outsideTouchable",
    "setTouchable(Z)V": "touchable", "setClippingEnabled(Z)V": "clipping", "setIsClippedToScreen(Z)V": "clipping",
    "setOverlapAnchor(Z)V": "overlapAnchor" }),
  ...noops("<init>()V", "setIsLaidOutInScreen(Z)V", "setAttachedInDecor(Z)V", "setSplitTouchEnabled(Z)V",
    "setTouchModal(Z)V", "setIgnoreCheekPress()V", "setLayoutInScreenEnabled(Z)V", "setAllowScrollingAnchorParent(Z)V",
    "setWindowLayoutMode(II)V", "setEnterTransition(Landroid/transition/Transition;)V",
    "setExitTransition(Landroid/transition/Transition;)V"),
  ...stubs(1, "isAttachedInDecor()Z", "isSplitTouchEnabled()Z"),
  ...stubs(null, "getEnterTransition()Landroid/transition/Transition;",
    "getExitTransition()Landroid/transition/Transition;"),
  "setBackgroundDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JPopupWindow, d: JDrawable | null) {
    this.bg = d;
    if (this.decor) { this.decor.background = d; [this.decor.padL, this.decor.padT, this.decor.padR, this.decor.padB] = this.bgPad(); requestLayout(this.decor); }
  },
  "getBackground()Landroid/graphics/drawable/Drawable;": function (this: JPopupWindow) { return this.bg; },
  "setOnDismissListener(Landroid/widget/PopupWindow$OnDismissListener;)V": function (this: JPopupWindow, l: unknown) { this.dismissL = l; },
  "setTouchInterceptor(Landroid/view/View$OnTouchListener;)V": function (this: JPopupWindow, l: unknown) { this.touchInterceptor = l; },
  "getMaxAvailableHeight(Landroid/view/View;)I": function (this: JPopupWindow, a: JView) { return pwMaxAvail.call(this, a); },
  "getMaxAvailableHeight(Landroid/view/View;I)I": pwMaxAvail,
  "getMaxAvailableHeight(Landroid/view/View;IZ)I": pwMaxAvail,
  "showAsDropDown(Landroid/view/View;)V": function (this: JPopupWindow, a: JView) { return pwShowDropDown.call(this, a); },
  "showAsDropDown(Landroid/view/View;II)V": pwShowDropDown,
  "showAsDropDown(Landroid/view/View;III)V": pwShowDropDown,
  "showAtLocation(Landroid/view/View;III)V": pwShowAt,
  "dismiss()V": pwDismiss,
  "update()V": pwUpdate,
  "update(II)V": function (this: JPopupWindow, w: number, h: number) { this.w = w; this.h = h; return pwUpdate.call(this); },
  "update(IIII)V": function (this: JPopupWindow, x: number, y: number, w: number, h: number) {
    if (w !== -1) this.w = w;
    if (h !== -1) this.h = h;
    if (!this.anchor) { const o = overlays.find((o) => o.view === this.decor); if (o) { o.x = x; o.y = y; } }
    return pwUpdate.call(this);
  },
  "update(IIIIZ)V": function (this: JPopupWindow, x: number, y: number, w: number, h: number) {
    return callSelf(pwMethods, "update(IIII)V", this, x, y, w, h);
  },
  "update(Landroid/view/View;II)V": function (this: JPopupWindow, a: JView, w: number, h: number) { return pwUpdateAnchor.call(this, a, this.xoff, this.yoff, w, h); },
  "update(Landroid/view/View;IIII)V": pwUpdateAnchor,
};
rt.register({
  name: "android/widget/PopupWindow", ctor: JPopupWindow,
  statics: { INPUT_METHOD_FROM_FOCUSABLE: 0, INPUT_METHOD_NEEDED: 1, INPUT_METHOD_NOT_NEEDED: 2 },
  methods: pwMethods,
});
