// Overlay layer: toasts, popup menus, dialogs-lite. Drawn above the decor by the shell.

import { rt, JObj } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { reportUncaught } from "./os";
import { JView, invalidate, requestLayout, locationOnScreen } from "./view";
import { device } from "../shell/config";
import { JCanvas, measureCtx } from "./graphics";

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
