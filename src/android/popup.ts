// Overlay layer: toasts, popup menus, dialogs-lite. Drawn above the decor by the shell.

import { rt, JObj } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { reportUncaught } from "./os";
import { JView, invalidate, requestLayout, locationOnScreen, attachView, detachView, measureView, layoutView, makeSpec, MS_EXACTLY, MS_AT_MOST, specSize, guardCall, MATCH_PARENT, WRAP_CONTENT } from "./view";
import { JFrameLayout } from "./widget";
import type { JDrawable } from "./drawable";
import { mangleMethod } from "../jvm/abi";
import { device } from "../shell/config";
import { JCanvas, measureCtx, JRect } from "./graphics";

interface Overlay {
  view: JView;
  x: number; y: number;
  dismissOnOutside: boolean;
  /** the window's own back handling (a Dialog cancels itself); absent means dismiss iff dismissOnOutside */
  onBack?: () => unknown;
}
export const overlays: Overlay[] = [];
export function addOverlay(v: JView, x = 0, y = 0, dismissOnOutside = false, onBack?: () => unknown) {
  overlays.push({ view: v, x, y, dismissOnOutside, onBack });
  requestLayout();
}
export function removeOverlay(v: JView) {
  const i = overlays.findIndex((o) => o.view === v);
  if (i >= 0) overlays.splice(i, 1);
  requestLayout();
}

// toast: plain shell-drawn banner (not a View)
const toasts: { text: string; until: number }[] = [];
export function showToast(text: string) {
  toasts.push({ text, until: performance.now() + 2500 });
  invalidate();
}
export function drawToasts(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const now = performance.now();
  for (let i = toasts.length - 1; i >= 0; i--) {
    if (toasts[i].until < now) toasts.splice(i, 1);
  }
  const t = toasts[toasts.length - 1];
  if (!t) return;
  ctx.save();
  ctx.font = "28px Roboto, sans-serif";
  const tw = Math.min(w - 80, ctx.measureText(t.text).width + 64);
  const x = (w - tw) / 2, y = h - 176;
  const alpha = Math.min(1, (t.until - now) / 300);
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.roundRect(x, y, tw, 88, 44);
  ctx.fillStyle = "rgba(50,50,50,0.92)";
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(t.text, w / 2, y + 44, tw - 48);
  ctx.restore();
  if (toasts.length) invalidate();
}

// simple native popup menu (used by ActionBar overflow, Spinner)
class PopupMenuView extends JView {
  items: { id: number; title: string }[] = [];
  onPick: ((id: number) => void) | null = null;
  itemH = 96;
  padV = 16;
}

// android.widget.PopupMenu.OnMenuItemClickListener — pure interface. PopupMenu below already
// vcalls onMenuItemClick(MenuItem)Z from the pick handler; this only lets app classes declare
// `implements` on it.
rt.register({ name: "android/widget/PopupMenu$OnMenuItemClickListener", ctor: class extends JObj {} });

rt.register({
  name: "webdroid/PopupMenuView", ctor: PopupMenuView, sup: "android/view/View",
  methods: {
    "onMeasure(II)V": function (this: PopupMenuView) {
      const ctx = measureCtx("30px Roboto, sans-serif");
      let w = 240;
      for (const it of this.items) w = Math.max(w, ctx.measureText(it.title).width + 96);
      this.measuredW = Math.min(560, Math.ceil(w));
      this.measuredH = this.items.length * this.itemH + this.padV * 2;
    },
    "onDraw(Landroid/graphics/Canvas;)V": function (this: PopupMenuView, cv: JCanvas) {
      const ctx = cv.ctx;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = 24;
      ctx.shadowOffsetY = 6;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.roundRect(0, 0, this.width(), this.height(), 8);
      ctx.fill();
      ctx.restore();
      ctx.font = "30px Roboto, sans-serif";
      ctx.fillStyle = "rgba(0,0,0,0.87)";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (let i = 0; i < this.items.length; i++) {
        ctx.fillText(this.items[i].title, 40, this.padV + i * this.itemH + this.itemH / 2);
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
  addOverlay(v, Math.max(8, Math.min(device.width - 400, x + anchor.width() - 400)), y + 20, true);
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
    "<init>(Landroid/content/Context;Landroid/view/View;)V": async function (this: JPopupMenu, c: unknown, anchor: JView) {
      this.jctx = c;
      this.anchor = anchor;
      const { JMenu } = await import("./app");
      this.menu = new JMenu();
    },
    "getMenu()Landroid/view/Menu;": function (this: JPopupMenu) { return this.menu; },
    "getMenuInflater()Landroid/view/MenuInflater;": async function (this: JPopupMenu) {
      const info = rt.link("android/view/MenuInflater");
      const m = new info.ctor();
      m.jctx = this.jctx;
      return m;
    },
    "inflate(I)V": async function (this: JPopupMenu, id: number) {
      const info = rt.link("android/view/MenuInflater");
      const m = new info.ctor();
      m.jctx = this.jctx;
      await vcall(m, "inflate", "(ILandroid/view/Menu;)V", id, this.menu);
    },
    "setOnMenuItemClickListener(Landroid/widget/PopupMenu$OnMenuItemClickListener;)V": function (this: JPopupMenu, l: unknown) {
      this.clickL = l;
    },
    "show()V": async function (this: JPopupMenu) {
      const items = (this.menu?.items ?? []).filter((i: any) => i.visible).map((i: any) => ({ id: i.id, title: i.title }));
      showPopupMenu(this.anchor!, items, (id) => {
        const item = (this.menu?.items ?? []).find((i: any) => i.id === id);
        if (this.clickL && item) {
          void vcall(this.clickL, "onMenuItemClick", "(Landroid/view/MenuItem;)Z", item).catch(reportUncaught);
        }
      });
    },
    "dismiss()V": () => {},
  },
});

// ── android.widget.PopupWindow: a content view in its own window above the activity. Here the
// window is an overlay; PopupRoot is AOSP's PopupBackgroundView (background drawable behind the
// content, its padding around it) and sizes the content from the popup's width/height params.
const M_drawableDraw = mangleMethod("draw", "(Landroid/graphics/Canvas;)V");
class PopupRoot extends JFrameLayout { popup: JPopupWindow | null = null; }
const contentH = () => device.height - device.statusBar;
function popupSpec(param: number, avail: number, pad: number): number {
  return param === MATCH_PARENT ? makeSpec(avail - pad, MS_EXACTLY)
    : param === WRAP_CONTENT ? makeSpec(avail - pad, MS_AT_MOST)
    : makeSpec(Math.max(0, param - pad), MS_EXACTLY);
}
rt.register({
  name: "webdroid/PopupRoot", ctor: PopupRoot, sup: "android/widget/FrameLayout",
  methods: {
    "onMeasure(II)V": async function (this: PopupRoot, wSpec: number, hSpec: number) {
      const p = this.popup!, c = this.children[0];
      const pad = new JRect();
      if (p.bg) await vcall(p.bg, "getPadding", "(Landroid/graphics/Rect;)Z", pad);
      const padW = pad.left + pad.right, padH = pad.top + pad.bottom;
      this.padL = pad.left; this.padT = pad.top; this.padR = pad.right; this.padB = pad.bottom;
      if (c && c.visibility !== 8) {
        await measureView(c, popupSpec(p.w, specSize(wSpec), padW), popupSpec(p.h, specSize(hSpec), padH));
        this.measuredW = c.measuredW + padW;
        this.measuredH = c.measuredH + padH;
      } else { this.measuredW = padW; this.measuredH = padH; }
    },
    "onLayout(ZIIII)V": async function (this: PopupRoot) {
      const c = this.children[0];
      if (c && c.visibility !== 8) {
        await layoutView(c, this.padL, this.padT, this.padL + c.measuredW, this.padT + c.measuredH);
      }
    },
    "onDraw(Landroid/graphics/Canvas;)V": async function (this: PopupRoot, cv: JCanvas) {
      const bg = this.popup?.bg;
      if (!bg) return;
      const b = bg.bounds;
      b.left = 0; b.top = 0; b.right = this.width(); b.bottom = this.height();
      await guardCall((bg as any)[M_drawableDraw], bg, cv);
    },
  },
});
class JPopupWindow extends JObj {
  content: JView | null = null; root: PopupRoot | null = null;
  w = WRAP_CONTENT; h = WRAP_CONTENT;
  focusable = false; touchable = true; outsideTouchable = false; clippedToScreen = true; overlapAnchor = false;
  bg: JDrawable | null = null; dismissL: unknown = null; touchInterceptor: unknown = null;
  inputMethodMode = 0; softInputMode = 0; windowLayoutType = 1000; animStyle = -1; elevation = 0;
  anchor: JView | null = null; x = 0; y = 0;
  showing(): boolean { return !!this.root && overlays.some((o) => o.view === this.root); }
}
async function popupShow(p: JPopupWindow, x: number, y: number) {
  if (!p.content || p.showing()) return;
  const root = new PopupRoot();
  root.popup = p;
  root.jres = p.content.jres; root.theme = p.content.theme;
  attachView(root, p.content);
  p.root = root;
  p.x = x; p.y = y;
  addOverlay(root, x, y, p.outsideTouchable || p.focusable, () => popupDismiss(p));
}
async function popupDismiss(p: JPopupWindow) {
  if (!p.showing()) return;
  removeOverlay(p.root!);
  if (p.content?.parent === p.root) detachView(p.root!, p.content);
  p.root = null;
  if (p.dismissL) await vcall(p.dismissL, "onDismiss", "()V").catch(reportUncaught);
}
/** measure the would-be window so drop-down placement can flip above an anchor that has no room below */
async function popupSize(p: JPopupWindow): Promise<[number, number]> {
  const root = new PopupRoot();
  root.popup = p;
  const c = p.content!;
  const savedParent = c.parent;
  root.children.push(c); c.parent = root;
  try { await measureView(root, makeSpec(device.width, MS_AT_MOST), makeSpec(contentH(), MS_AT_MOST)); }
  finally { root.children.length = 0; c.parent = savedParent; c.layoutRequested = true; }
  return [root.measuredW, root.measuredH];
}
async function showAsDropDown(p: JPopupWindow, anchor: JView, xoff: number, yoff: number, gravity: number) {
  p.anchor = anchor;
  const [ax, ay] = locationOnScreen(anchor);
  const [w, h] = await popupSize(p);
  let x = ax + xoff;
  if ((gravity & 7) === 5) x = ax + anchor.width() - w + xoff;   // Gravity.RIGHT
  let y = (p.overlapAnchor ? ay : ay + anchor.height()) + yoff;
  // AOSP findDropDownPosition: no room below → open above the anchor
  if (y + h > contentH() && ay - h >= 0) y = (p.overlapAnchor ? ay + anchor.height() : ay) - h - yoff;
  if (p.clippedToScreen) {
    x = Math.max(0, Math.min(x, device.width - w));
    y = Math.max(0, Math.min(y, contentH() - h));
  }
  await popupShow(p, x, y);
}
async function showAtLocation(p: JPopupWindow, gravity: number, x: number, y: number) {
  const [w, h] = await popupSize(p);
  const hg = gravity & 7, vg = gravity & 0x70;
  const px = hg === 5 ? device.width - w - x : hg === 1 ? ((device.width - w) >> 1) + x : x;
  const py = vg === 0x50 ? contentH() - h - y : vg === 0x10 ? ((contentH() - h) >> 1) + y : y;
  await popupShow(p, px, py);
}
async function popupUpdate(p: JPopupWindow, x: number, y: number, w: number, h: number) {
  if (w !== -1 && w !== undefined) p.w = w;
  if (h !== -1 && h !== undefined) p.h = h;
  if (!p.showing()) return;
  const o = overlays.find((o) => o.view === p.root)!;
  o.x = p.x = x; o.y = p.y = y;
  p.root!.layoutRequested = true;
  requestLayout(p.root);
}
const pwInit = function (this: JPopupWindow, v: JView | null = null, w = WRAP_CONTENT, h = WRAP_CONTENT, focusable = 0) {
  if (v instanceof JView) this.content = v;
  this.w = w; this.h = h; this.focusable = !!focusable;
};
rt.register({
  name: "android/widget/PopupWindow", ctor: JPopupWindow,
  statics: { INPUT_METHOD_FROM_FOCUSABLE: 0, INPUT_METHOD_NEEDED: 1, INPUT_METHOD_NOT_NEEDED: 2 },
  methods: {
    "<init>()V": function (this: JPopupWindow) { pwInit.call(this); },
    "<init>(Landroid/content/Context;)V": function (this: JPopupWindow) { pwInit.call(this); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function (this: JPopupWindow) { pwInit.call(this); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": function (this: JPopupWindow) { pwInit.call(this); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;II)V": function (this: JPopupWindow) { pwInit.call(this); },
    "<init>(Landroid/view/View;)V": function (this: JPopupWindow, v: JView) { pwInit.call(this, v); },
    "<init>(II)V": function (this: JPopupWindow, w: number, h: number) { pwInit.call(this, null, w, h); },
    "<init>(Landroid/view/View;II)V": function (this: JPopupWindow, v: JView, w: number, h: number) { pwInit.call(this, v, w, h); },
    "<init>(Landroid/view/View;IIZ)V": pwInit,
    "setContentView(Landroid/view/View;)V": function (this: JPopupWindow, v: JView | null) { if (!this.showing()) this.content = v; },
    "getContentView()Landroid/view/View;": function (this: JPopupWindow) { return this.content; },
    "setWidth(I)V": function (this: JPopupWindow, w: number) { this.w = w; },
    "setHeight(I)V": function (this: JPopupWindow, h: number) { this.h = h; },
    "getWidth()I": function (this: JPopupWindow) { return this.w; },
    "getHeight()I": function (this: JPopupWindow) { return this.h; },
    "setFocusable(Z)V": function (this: JPopupWindow, f: number) { this.focusable = !!f; },
    "isFocusable()Z": function (this: JPopupWindow) { return this.focusable ? 1 : 0; },
    "setTouchable(Z)V": function (this: JPopupWindow, t: number) { this.touchable = !!t; },
    "isTouchable()Z": function (this: JPopupWindow) { return this.touchable ? 1 : 0; },
    "setOutsideTouchable(Z)V": function (this: JPopupWindow, t: number) { this.outsideTouchable = !!t; },
    "isOutsideTouchable()Z": function (this: JPopupWindow) { return this.outsideTouchable ? 1 : 0; },
    "setTouchModal(Z)V": () => {},
    "setClippingEnabled(Z)V": () => {},
    "setIsClippedToScreen(Z)V": function (this: JPopupWindow, c: number) { this.clippedToScreen = !!c; },
    "isClippedToScreen()Z": function (this: JPopupWindow) { return this.clippedToScreen ? 1 : 0; },
    "setOverlapAnchor(Z)V": function (this: JPopupWindow, o: number) { this.overlapAnchor = !!o; },
    "getOverlapAnchor()Z": function (this: JPopupWindow) { return this.overlapAnchor ? 1 : 0; },
    "setBackgroundDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JPopupWindow, d: JDrawable | null) { this.bg = d; },
    "getBackground()Landroid/graphics/drawable/Drawable;": function (this: JPopupWindow) { return this.bg; },
    "setOnDismissListener(Landroid/widget/PopupWindow$OnDismissListener;)V": function (this: JPopupWindow, l: unknown) { this.dismissL = l; },
    "setTouchInterceptor(Landroid/view/View$OnTouchListener;)V": function (this: JPopupWindow, l: unknown) { this.touchInterceptor = l; },
    "setInputMethodMode(I)V": function (this: JPopupWindow, m: number) { this.inputMethodMode = m; },
    "getInputMethodMode()I": function (this: JPopupWindow) { return this.inputMethodMode; },
    "setSoftInputMode(I)V": function (this: JPopupWindow, m: number) { this.softInputMode = m; },
    "getSoftInputMode()I": function (this: JPopupWindow) { return this.softInputMode; },
    "setWindowLayoutType(I)V": function (this: JPopupWindow, t: number) { this.windowLayoutType = t; },
    "getWindowLayoutType()I": function (this: JPopupWindow) { return this.windowLayoutType; },
    "setAnimationStyle(I)V": function (this: JPopupWindow, s: number) { this.animStyle = s; },
    "getAnimationStyle()I": function (this: JPopupWindow) { return this.animStyle; },
    "setElevation(F)V": function (this: JPopupWindow, e: number) { this.elevation = e; },
    "getElevation()F": function (this: JPopupWindow) { return this.elevation; },
    "setEnterTransition(Landroid/transition/Transition;)V": () => {},
    "setExitTransition(Landroid/transition/Transition;)V": () => {},
    "setEpicenterBounds(Landroid/graphics/Rect;)V": () => {},
    "setSplitTouchEnabled(Z)V": () => {},
    "setIgnoreCheekPress()V": () => {},
    "setLayoutInScreenEnabled(Z)V": () => {},
    "setAttachedInDecor(Z)V": () => {},
    "setWindowLayoutMode(II)V": () => {},
    "isShowing()Z": function (this: JPopupWindow) { return this.showing() ? 1 : 0; },
    "isAboveAnchor()Z": function (this: JPopupWindow) {
      return this.anchor && this.y < locationOnScreen(this.anchor)[1] ? 1 : 0;
    },
    "showAsDropDown(Landroid/view/View;)V": function (this: JPopupWindow, a: JView) { return showAsDropDown(this, a, 0, 0, 0); },
    "showAsDropDown(Landroid/view/View;II)V": function (this: JPopupWindow, a: JView, x: number, y: number) { return showAsDropDown(this, a, x, y, 0); },
    "showAsDropDown(Landroid/view/View;III)V": function (this: JPopupWindow, a: JView, x: number, y: number, g: number) { return showAsDropDown(this, a, x, y, g); },
    "showAtLocation(Landroid/view/View;III)V": function (this: JPopupWindow, _parent: JView, g: number, x: number, y: number) { return showAtLocation(this, g, x, y); },
    "update()V": function (this: JPopupWindow) { if (this.showing()) requestLayout(this.root); },
    "update(II)V": function (this: JPopupWindow, w: number, h: number) { return popupUpdate(this, this.x, this.y, w, h); },
    "update(IIII)V": function (this: JPopupWindow, x: number, y: number, w: number, h: number) { return popupUpdate(this, x, y, w, h); },
    "update(IIIIZ)V": function (this: JPopupWindow, x: number, y: number, w: number, h: number) { return popupUpdate(this, x, y, w, h); },
    "update(Landroid/view/View;II)V": async function (this: JPopupWindow, a: JView, w: number, h: number) {
      await popupUpdate(this, this.x, this.y, w, h);
    },
    "update(Landroid/view/View;IIII)V": async function (this: JPopupWindow, a: JView, xoff: number, yoff: number, w: number, h: number) {
      if (w !== -1) this.w = w;
      if (h !== -1) this.h = h;
      if (!this.showing()) return;
      await popupDismiss(this);
      await showAsDropDown(this, a, xoff, yoff, 0);
    },
    "dismiss()V": function (this: JPopupWindow) { return popupDismiss(this); },
    "getMaxAvailableHeight(Landroid/view/View;)I": function (this: JPopupWindow, a: JView) { return maxAvail(a, 0, false); },
    "getMaxAvailableHeight(Landroid/view/View;I)I": function (this: JPopupWindow, a: JView, yoff: number) { return maxAvail(a, yoff, false); },
    "getMaxAvailableHeight(Landroid/view/View;IZ)I": function (this: JPopupWindow, a: JView, yoff: number, ignoreBottomDecor: number) {
      return maxAvail(a, yoff, !!ignoreBottomDecor);
    },
  },
});
/** AOSP: the larger of the space above and below the anchor (the popup may flip) */
function maxAvail(anchor: JView, yoff: number, _ignoreBottomDecor: boolean): number {
  const [, ay] = locationOnScreen(anchor);
  const below = contentH() - (ay + anchor.height()) - yoff;
  const above = ay + yoff;
  return Math.max(below, above);
}
rt.register({ name: "android/widget/PopupWindow$OnDismissListener", ctor: class extends JObj {} });
