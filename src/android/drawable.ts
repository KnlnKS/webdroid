// android.graphics.drawable.* — Drawable hierarchy, XML inflation, 9-patch, vectors.

import { rt, JObj, type NativeSpec } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { JCanvas, JRect, JBitmap, cssColor, decodeBytes, tintedBmp } from "./graphics";
import { device } from "../shell/config";
import { Resources, type RV, type JTheme, AID, T_STR, rvColor, rvDimen, rvFloat, normRV, parseFwValue } from "./res";
import { TV, parseAXML, type XmlNode, type XmlAttr } from "./axml";

// state constants
export const ST = {
  pressed: 0x010100a7, enabled: 0x0101009e, selected: 0x010100a1, checked: 0x010100a0,
  focused: 0x0101009c, activated: 0x010102fe, window_focused: 0x0101009d, checkable: 0x0101009f,
  hovered: 0x01010367,
};

export class JDrawable extends JObj {
  bounds = new JRect();
  level = 0;
  alpha = 255;
  stateSet: number[] = [];
  callback: unknown = null; // Drawable.Callback (usually a View)
  tint: number | null = null;

  /** TS-side paint. Subclasses override. */
  paint(cv: JCanvas) {}
  intrinsicW(): number { return -1; }
  intrinsicH(): number { return -1; }
  onStateChange(): boolean { return false; }
}

function setBounds(this: JDrawable, l: number, t: number, r: number, b: number) {
  this.bounds.left = l; this.bounds.top = t; this.bounds.right = r; this.bounds.bottom = b;
  onBoundsChangeAll(this);
}
function scheduleSelf(this: JDrawable, r: unknown, when: bigint) {
  if (this.callback) void vcall(this.callback, "scheduleDrawable", "(Landroid/graphics/drawable/Drawable;Ljava/lang/Runnable;J)V", this, r, when);
}
function unscheduleSelf(this: JDrawable, r: unknown) {
  if (this.callback) void vcall(this.callback, "unscheduleDrawable", "(Landroid/graphics/drawable/Drawable;Ljava/lang/Runnable;)V", this, r);
}
function invalidateSelf(this: JDrawable) {
  if (this.callback) void vcall(this.callback, "invalidateDrawable", "(Landroid/graphics/drawable/Drawable;)V", this);
}
const drawableMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "draw(Landroid/graphics/Canvas;)V": function (this: JDrawable, cv: JCanvas) { this.paint(cv); },
  "setBounds(IIII)V": setBounds,
  "setBounds(Landroid/graphics/Rect;)V": function (this: JDrawable, r: JRect) { setBounds.call(this, r.left, r.top, r.right, r.bottom); },
  "getBounds()Landroid/graphics/Rect;": function (this: JDrawable) { return this.bounds; },
  "copyBounds(Landroid/graphics/Rect;)V": function (this: JDrawable, r: JRect) {
    r.left = this.bounds.left; r.top = this.bounds.top; r.right = this.bounds.right; r.bottom = this.bounds.bottom;
  },
  "getIntrinsicWidth()I": function (this: JDrawable) { return this.intrinsicW(); },
  "getIntrinsicHeight()I": function (this: JDrawable) { return this.intrinsicH(); },
  "getMinimumWidth()I": function (this: JDrawable) { return Math.max(0, this.intrinsicW()); },
  "getMinimumHeight()I": function (this: JDrawable) { return Math.max(0, this.intrinsicH()); },
  "setAlpha(I)V": function (this: JDrawable, a: number) { this.alpha = a; },
  "getAlpha()I": function (this: JDrawable) { return this.alpha; },
  "setColorFilter(Landroid/graphics/ColorFilter;)V": function (this: JDrawable, f: any) { this.tint = f?.tint ?? null; },
  "setColorFilter(ILandroid/graphics/PorterDuff$Mode;)V": function (this: JDrawable, c: number) { this.tint = c; },
  "clearColorFilter()V": function (this: JDrawable) { this.tint = null; },
  "setTint(I)V": function (this: JDrawable, c: number) { this.tint = c; },
  "setTintList(Landroid/content/res/ColorStateList;)V": function (this: JDrawable, csl: JColorStateList | null) {
    this.tint = csl ? cslColor(csl, this.stateSet) : null;
  },
  "setTintMode(Landroid/graphics/PorterDuff$Mode;)V": function () {},
  "setState([I)Z": function (this: JDrawable, st: Int32Array) {
    this.stateSet = [...st];
    return this.onStateChange() ? 1 : 0;
  },
  "getState()[I": function (this: JDrawable) { return Int32Array.from(this.stateSet); },
  "setLevel(I)Z": function (this: JDrawable, l: number) { this.level = l; return 1; },
  "getLevel()I": function (this: JDrawable) { return this.level; },
  "setCallback(Landroid/graphics/drawable/Drawable$Callback;)V": function (this: JDrawable, cb: unknown) { this.callback = cb; },
  "getCallback()Landroid/graphics/drawable/Drawable$Callback;": function (this: JDrawable) { return this.callback; },
  // Drawable.Callback: every AOSP wrapping drawable (LayerDrawable, DrawableContainer,
  // AnimatedVectorDrawable...) is its child's callback and forwards up to its own.
  "scheduleSelf(Ljava/lang/Runnable;J)V": scheduleSelf,
  "unscheduleSelf(Ljava/lang/Runnable;)V": unscheduleSelf,
  "invalidateSelf()V": invalidateSelf,
  "scheduleDrawable(Landroid/graphics/drawable/Drawable;Ljava/lang/Runnable;J)V": function (this: JDrawable, _d: unknown, r: unknown, when: bigint) { scheduleSelf.call(this, r, when); },
  "unscheduleDrawable(Landroid/graphics/drawable/Drawable;Ljava/lang/Runnable;)V": function (this: JDrawable, _d: unknown, r: unknown) { unscheduleSelf.call(this, r); },
  "invalidateDrawable(Landroid/graphics/drawable/Drawable;)V": invalidateSelf,
  "mutate()Landroid/graphics/drawable/Drawable;": function (this: JDrawable) { return this; },
  "getConstantState()Landroid/graphics/drawable/Drawable$ConstantState;": function () { return null; },
  "isStateful()Z": function (this: JDrawable) { return this instanceof JStateListDrawable ? 1 : 0; },
  "getPadding(Landroid/graphics/Rect;)Z": function (this: JDrawable, r: JRect) {
    const p = (this as any).padding as JRect | undefined;
    if (p) { r.left = p.left; r.top = p.top; r.right = p.right; r.bottom = p.bottom; return 1; }
    r.left = r.top = r.right = r.bottom = 0;
    return 0;
  },
  "getOpacity()I": () => -3,
  "setVisible(ZZ)Z": () => 1,
  "setAutoMirrored(Z)V": () => {},
  "jumpToCurrentState()V": () => {},
  "getCurrent()Landroid/graphics/drawable/Drawable;": function (this: JDrawable) {
    return this instanceof JStateListDrawable ? this.current() : this;
  },
  "getDirtyBounds()Landroid/graphics/Rect;": function (this: JDrawable) { return this.bounds; },
  "setChangingConfigurations(I)V": () => {},
  "setDither(Z)V": () => {},
  "setFilterBitmap(Z)V": () => {},
  "setHotspot(FF)V": () => {},
  "setHotspotBounds(IIII)V": () => {},
};
function onBoundsChangeAll(d: JDrawable) {
  if (d instanceof JLayerDrawable) d.layout();
  if (d instanceof JStateListDrawable) { const c = d.current(); if (c) copyBounds(d, c); }
}
function copyBounds(from: JDrawable, to: JDrawable) {
  to.bounds.left = from.bounds.left; to.bounds.top = from.bounds.top;
  to.bounds.right = from.bounds.right; to.bounds.bottom = from.bounds.bottom;
  onBoundsChangeAll(to);
}
rt.register({ name: "android/graphics/drawable/Drawable", ctor: JDrawable, methods: drawableMethods });
rt.register({ name: "android/graphics/drawable/Drawable$Callback", ctor: class extends JObj {} });
rt.register({ name: "android/graphics/drawable/Drawable$ConstantState", ctor: class extends JObj {} });
// marker interface for self-driven drawables (AnimatedVectorDrawable, AnimationDrawable) — start()/
// stop()/isRunning() so callers (e.g. material3's ripple host) can `instanceof` a drawable to see
// whether it animates itself. None of our drawables self-animate yet, so nothing implements it —
// registering it is enough for the instanceof check to resolve instead of throwing on a missing class.
rt.register({ name: "android/graphics/drawable/Animatable", ctor: class extends JObj {} });

// ── ColorDrawable
export class JColorDrawable extends JDrawable {
  color = 0;
  paint(cv: JCanvas) {
    if (!(this.color >>> 24) || this.alpha === 0) return;
    const ctx = cv.ctx;
    ctx.save();
    ctx.globalAlpha *= this.alpha / 255;
    ctx.fillStyle = cssColor(this.tint ?? this.color);
    ctx.fillRect(this.bounds.left, this.bounds.top, this.bounds.right - this.bounds.left, this.bounds.bottom - this.bounds.top);
    ctx.restore();
  }
}
rt.register({
  name: "android/graphics/drawable/ColorDrawable", ctor: JColorDrawable, sup: "android/graphics/drawable/Drawable",
  methods: {
    "<init>()V": function () {},
    "<init>(I)V": function (this: JColorDrawable, c: number) { this.color = c; },
    "getColor()I": function (this: JColorDrawable) { return this.color; },
    "setColor(I)V": function (this: JColorDrawable, c: number) { this.color = c; },
  },
});

// ── BitmapDrawable
export class JBitmapDrawable extends JDrawable {
  bmp: JBitmap | null = null;
  paint(cv: JCanvas) {
    if (!this.bmp) return;
    const ctx = cv.ctx;
    ctx.save();
    ctx.globalAlpha *= this.alpha / 255;
    const src = tintedBmp(this.bmp, this.tint);
    ctx.drawImage(src, this.bounds.left, this.bounds.top,
      Math.max(1, this.bounds.right - this.bounds.left), Math.max(1, this.bounds.bottom - this.bounds.top));
    ctx.restore();
  }
  intrinsicW(): number { return this.bmp ? Math.round(this.bmp.w * device.densityDpi / this.bmp.density) : -1; }
  intrinsicH(): number { return this.bmp ? Math.round(this.bmp.h * device.densityDpi / this.bmp.density) : -1; }
}
rt.register({
  name: "android/graphics/drawable/BitmapDrawable", ctor: JBitmapDrawable, sup: "android/graphics/drawable/Drawable",
  methods: {
    "<init>()V": function () {},
    "<init>(Landroid/content/res/Resources;Landroid/graphics/Bitmap;)V": function (this: JBitmapDrawable, r: unknown, b: JBitmap) { this.bmp = b; },
    "<init>(Landroid/graphics/Bitmap;)V": function (this: JBitmapDrawable, b: JBitmap) { this.bmp = b; },
    "getBitmap()Landroid/graphics/Bitmap;": function (this: JBitmapDrawable) { return this.bmp; },
    "setAntiAlias(Z)V": () => {},
    "setTileModeXY(Landroid/graphics/Shader$TileMode;Landroid/graphics/Shader$TileMode;)V": () => {},
    "setGravity(I)V": () => {},
  },
});

// ── NinePatch
class JNinePatchDrawable extends JDrawable {
  bmp: JBitmap | null = null;
  xDivs: number[] = []; yDivs: number[] = [];
  padding = new JRect();
  srcDensityScale = 1;
  paint(cv: JCanvas) {
    if (!this.bmp) return;
    const { left, top } = this.bounds;
    const dw = this.bounds.right - left, dh = this.bounds.bottom - top;
    const ctx = cv.ctx;
    ctx.save();
    ctx.globalAlpha *= this.alpha / 255;
    drawNinePatch(ctx, tintedBmp(this.bmp, this.tint), this.bmp.w, this.bmp.h, this.xDivs, this.yDivs, left, top, dw, dh);
    ctx.restore();
  }
  intrinsicW(): number { return this.bmp ? Math.round(this.bmp.w * this.srcDensityScale) : -1; }
  intrinsicH(): number { return this.bmp ? Math.round(this.bmp.h * this.srcDensityScale) : -1; }
}
rt.register({ name: "android/graphics/drawable/NinePatchDrawable", ctor: JNinePatchDrawable, sup: "android/graphics/drawable/Drawable" });
function drawNinePatch(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, img: CanvasImageSource,
  sw: number, sh: number, xDivs: number[], yDivs: number[],
  dx: number, dy: number, dw: number, dh: number,
) {
  // build segments [start, end, stretchable]
  const segs = (divs: number[], total: number) => {
    const out: [number, number, boolean][] = [];
    let pos = 0, stretch = false;
    const pts = [...divs, total];
    for (const p of pts) {
      if (p > pos) out.push([pos, p, stretch]);
      pos = p;
      stretch = !stretch;
    }
    return out;
  };
  const xs = segs(xDivs, sw), ys = segs(yDivs, sh);
  const fixedW = xs.filter((s) => !s[2]).reduce((a, s) => a + s[1] - s[0], 0);
  const stretchW = xs.filter((s) => s[2]).reduce((a, s) => a + s[1] - s[0], 0) || 1;
  const fixedH = ys.filter((s) => !s[2]).reduce((a, s) => a + s[1] - s[0], 0);
  const stretchH = ys.filter((s) => s[2]).reduce((a, s) => a + s[1] - s[0], 0) || 1;
  const xScale = Math.max(0, dw - fixedW) / stretchW;
  const yScale = Math.max(0, dh - fixedH) / stretchH;
  let destY = dy;
  for (const [y0, y1, sy] of ys) {
    const segH = sy ? (y1 - y0) * yScale : y1 - y0;
    let destX = dx;
    for (const [x0, x1, sx] of xs) {
      const segW = sx ? (x1 - x0) * xScale : x1 - x0;
      if (segW > 0 && segH > 0) ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0, destX, destY, segW, segH);
      destX += segW;
    }
    destY += segH;
  }
}
/** parse npTc chunk from a compiled 9-patch png */
function parseNinePatchChunk(png: Uint8Array): { xDivs: number[]; yDivs: number[]; padding: number[] } | null {
  let pos = 8;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  while (pos + 8 < png.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(png[pos + 4], png[pos + 5], png[pos + 6], png[pos + 7]);
    if (type === "npTc") {
      const p = pos + 8;
      const numX = png[p + 1], numY = png[p + 2];
      const be = (off: number) => view.getInt32(p + off);
      const paddingLeft = be(12), paddingRight = be(16), paddingTop = be(20), paddingBottom = be(24);
      const xDivs: number[] = [], yDivs: number[] = [];
      let q = p + 32;
      for (let i = 0; i < numX; i++) { xDivs.push(be(q - p)); q += 4; }
      for (let i = 0; i < numY; i++) { yDivs.push(be(q - p)); q += 4; }
      return { xDivs, yDivs, padding: [paddingLeft, paddingTop, paddingRight, paddingBottom] };
    }
    pos += 12 + len;
  }
  return null;
}

// ── GradientDrawable (shape)
export class JGradientDrawable extends JDrawable {
  shape = 0; // 0 rect, 1 oval, 2 line, 3 ring
  solid: number | null = null;
  radii: number[] = [0, 0, 0, 0]; // tl tr br bl
  private clampedRadii = [0, 0, 0, 0];
  strokeW = 0; strokeColor = 0; dashW = 0; dashGap = 0;
  gradColors: number[] | null = null;
  gradAngle = 0;
  gradType = 0; // linear/radial/sweep
  gradRadius = 0;
  sizeW = -1; sizeH = -1;
  padding = new JRect();
  paint(cv: JCanvas) {
    const { left, top, right, bottom } = this.bounds;
    const w = right - left, h = bottom - top;
    if (w <= 0 || h <= 0) return;
    const ctx = cv.ctx;
    ctx.save();
    ctx.globalAlpha *= this.alpha / 255;
    const path = new Path2D();
    if (this.shape === 1) path.ellipse(left + w / 2, top + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (this.shape === 2) { path.moveTo(left, top + h / 2); path.lineTo(right, top + h / 2); }
    else {
      const lim = Math.min(w / 2, h / 2), rr = this.clampedRadii;
      for (let i = 0; i < 4; i++) rr[i] = Math.min(this.radii[i], lim);
      path.roundRect(left, top, w, h, rr);
    }
    if (this.shape !== 2) {
      let fill: string | CanvasGradient | null = null;
      if (this.tint !== null) fill = cssColor(this.tint);
      else if (this.gradColors && this.gradColors.length > 1) {
        if (this.gradType === 1) {
          const g = ctx.createRadialGradient(left + w / 2, top + h / 2, 0, left + w / 2, top + h / 2, this.gradRadius || Math.max(w, h) / 2);
          this.gradColors.forEach((c, i) => g.addColorStop(i / (this.gradColors!.length - 1), cssColor(c)));
          fill = g;
        } else {
          const a = ((this.gradAngle % 360) + 360) % 360;
          const rad = a * Math.PI / 180;
          const cx = left + w / 2, cy = top + h / 2;
          const len = (Math.abs(Math.cos(rad)) * w + Math.abs(Math.sin(rad)) * h) / 2;
          const g = ctx.createLinearGradient(cx - Math.cos(rad) * len, cy + Math.sin(rad) * len, cx + Math.cos(rad) * len, cy - Math.sin(rad) * len);
          this.gradColors.forEach((c, i) => g.addColorStop(i / (this.gradColors!.length - 1), cssColor(c)));
          fill = g;
        }
      } else if (this.solid !== null) fill = cssColor(this.solid);
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill(path);
      }
    }
    if (this.strokeW > 0) {
      ctx.strokeStyle = cssColor(this.strokeColor);
      ctx.lineWidth = this.strokeW;
      if (this.dashW) ctx.setLineDash([this.dashW, this.dashGap]);
      ctx.stroke(path);
    }
    ctx.restore();
  }
  intrinsicW(): number { return this.sizeW; }
  intrinsicH(): number { return this.sizeH; }
}
rt.register({
  name: "android/graphics/drawable/GradientDrawable", ctor: JGradientDrawable, sup: "android/graphics/drawable/Drawable",
  methods: {
    "<init>()V": function () {},
    "setColor(I)V": function (this: JGradientDrawable, c: number) { this.solid = c; },
    "setColors([I)V": function (this: JGradientDrawable, cs: Int32Array) { this.gradColors = [...cs]; },
    "setCornerRadius(F)V": function (this: JGradientDrawable, r: number) { this.radii = [r, r, r, r]; },
    "setCornerRadii([F)V": function (this: JGradientDrawable, r: Float32Array) {
      this.radii = [r[0] ?? 0, r[2] ?? 0, r[4] ?? 0, r[6] ?? 0];
    },
    "setStroke(II)V": function (this: JGradientDrawable, w: number, c: number) { this.strokeW = w; this.strokeColor = c; },
    "setStroke(IIFF)V": function (this: JGradientDrawable, w: number, c: number, dw: number, dg: number) {
      this.strokeW = w; this.strokeColor = c; this.dashW = dw; this.dashGap = dg;
    },
    "setShape(I)V": function (this: JGradientDrawable, s: number) { this.shape = s; },
    "setSize(II)V": function (this: JGradientDrawable, w: number, h: number) { this.sizeW = w; this.sizeH = h; },
    "setGradientType(I)V": function (this: JGradientDrawable, t: number) { this.gradType = t; },
    "setGradientRadius(F)V": function (this: JGradientDrawable, r: number) { this.gradRadius = r; },
  },
});

/** a selector/color-state item matches when every required state is set and no negated one is */
function matchesState(it: { states: number[]; negStates: number[] }, states: number[]): boolean {
  return it.states.every((s) => states.includes(s)) && !it.negStates.some((s) => states.includes(s));
}

// ── StateListDrawable
class JStateListDrawable extends JDrawable {
  items: { states: number[]; negStates: number[]; d: JDrawable }[] = [];
  current(): JDrawable | null {
    return (this.items.find((it) => matchesState(it, this.stateSet)) ?? this.items[this.items.length - 1])?.d ?? null;
  }
  paint(cv: JCanvas) {
    const c = this.current();
    if (c) {
      copyBounds(this, c);
      c.alpha = this.alpha;
      c.tint = c.tint ?? this.tint;
      c.paint(cv);
    }
  }
  onStateChange(): boolean {
    for (const it of this.items) it.d.stateSet = this.stateSet;
    return true;
  }
  intrinsicW(): number { return this.items.reduce((a, i) => Math.max(a, i.d.intrinsicW()), -1); }
  intrinsicH(): number { return this.items.reduce((a, i) => Math.max(a, i.d.intrinsicH()), -1); }
}
rt.register({
  name: "android/graphics/drawable/StateListDrawable", ctor: JStateListDrawable, sup: "android/graphics/drawable/Drawable",
  methods: {
    "<init>()V": function () {},
    "addState([ILandroid/graphics/drawable/Drawable;)V": function (this: JStateListDrawable, st: Int32Array, d: JDrawable) {
      const states: number[] = [], neg: number[] = [];
      for (const s of st) (s >= 0 ? states : neg).push(Math.abs(s));
      this.items.push({ states, negStates: neg, d });
    },
  },
});

// ── LayerDrawable / InsetDrawable / Ripple
class JLayerDrawable extends JDrawable {
  layers: { d: JDrawable; insets: [number, number, number, number] }[] = [];
  ids: (number | null)[] = [];
  layout() {
    for (const l of this.layers) {
      l.d.bounds.left = this.bounds.left + l.insets[0];
      l.d.bounds.top = this.bounds.top + l.insets[1];
      l.d.bounds.right = this.bounds.right - l.insets[2];
      l.d.bounds.bottom = this.bounds.bottom - l.insets[3];
      onBoundsChangeAll(l.d);
    }
  }
  paint(cv: JCanvas) {
    this.layout();
    for (const l of this.layers) l.d.paint(cv);
  }
  intrinsicW(): number { return this.layers.reduce((a, l) => Math.max(a, l.d.intrinsicW() + l.insets[0] + l.insets[2]), -1); }
  intrinsicH(): number { return this.layers.reduce((a, l) => Math.max(a, l.d.intrinsicH() + l.insets[1] + l.insets[3]), -1); }
}
rt.register({
  name: "android/graphics/drawable/LayerDrawable", ctor: JLayerDrawable, sup: "android/graphics/drawable/Drawable",
  methods: {
    "<init>([Landroid/graphics/drawable/Drawable;)V": function (this: JLayerDrawable, ds: JDrawable[]) {
      for (const d of ds ?? []) this.layers.push({ d, insets: [0, 0, 0, 0] });
    },
    "getNumberOfLayers()I": function (this: JLayerDrawable) { return this.layers.length; },
    "getDrawable(I)Landroid/graphics/drawable/Drawable;": function (this: JLayerDrawable, i: number) { return this.layers[i]?.d ?? null; },
    "findDrawableByLayerId(I)Landroid/graphics/drawable/Drawable;": function (this: JLayerDrawable, id: number) {
      const i = this.ids.indexOf(id);
      return i >= 0 ? this.layers[i]?.d ?? null : null;
    },
    "setLayerInset(IIIII)V": function (this: JLayerDrawable, i: number, l: number, t: number, r: number, b: number) {
      if (this.layers[i]) this.layers[i].insets = [l, t, r, b];
    },
  },
});
/** RippleDrawable.RADIUS_AUTO: compute the radius from bounds instead of using an explicit one. */
const RADIUS_AUTO = -1;
export class JRippleDrawable extends JLayerDrawable {
  rippleColor = 0x33000000;
  /** explicit override from setRadius(), or RADIUS_AUTO to derive it from bounds each draw. */
  explicitRadius = RADIUS_AUTO;
  /**
   * RippleDrawable.computeRadius(): half the bounds' diagonal — the distance from the hotspot
   * bounds' center to a corner — so a fully-grown ripple just covers the drawable. (Not half of
   * the larger dimension: a wide, short button would then leave its corners uncovered.)
   */
  computedRadius(): number {
    const halfW = (this.bounds.right - this.bounds.left) / 2;
    const halfH = (this.bounds.bottom - this.bounds.top) / 2;
    return Math.sqrt(halfW * halfW + halfH * halfH);
  }
  radius(): number { return this.explicitRadius >= 0 ? this.explicitRadius : this.computedRadius(); }
  paint(cv: JCanvas) {
    super.paint(cv);
    if (this.stateSet.includes(ST.pressed) || this.stateSet.includes(ST.focused)) {
      const { left, top, right, bottom } = this.bounds;
      const ctx = cv.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, right - left, bottom - top);
      ctx.clip();
      ctx.fillStyle = cssColor(this.rippleColor);
      ctx.beginPath();
      ctx.arc((left + right) / 2, (top + bottom) / 2, this.radius(), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
  onStateChange(): boolean { return true; }
}
rt.register({
  name: "android/graphics/drawable/RippleDrawable", ctor: JRippleDrawable, sup: "android/graphics/drawable/LayerDrawable",
  methods: {
    "<init>(Landroid/content/res/ColorStateList;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V":
      function (this: JRippleDrawable, csl: JColorStateList | null, content: JDrawable | null) {
        if (content) this.layers.push({ d: content, insets: [0, 0, 0, 0] });
        if (csl) this.rippleColor = (cslColor(csl, []) & 0xffffff) | 0x33000000;
      },
    "setColor(Landroid/content/res/ColorStateList;)V": function (this: JRippleDrawable, csl: JColorStateList) {
      this.rippleColor = (cslColor(csl, []) & 0xffffff) | 0x33000000;
    },
    "setRadius(I)V": function (this: JRippleDrawable, r: number) { this.explicitRadius = r; },
    "getRadius()I": function (this: JRippleDrawable) { return this.explicitRadius; },
  },
});
rt.register({
  name: "android/graphics/drawable/InsetDrawable", ctor: class extends JLayerDrawable {}, sup: "android/graphics/drawable/LayerDrawable",
  methods: {
    "<init>(Landroid/graphics/drawable/Drawable;I)V": function (this: JLayerDrawable, d: JDrawable, i: number) {
      this.layers.push({ d, insets: [i, i, i, i] });
    },
    "<init>(Landroid/graphics/drawable/Drawable;IIII)V": function (this: JLayerDrawable, d: JDrawable, l: number, t: number, r: number, b: number) {
      this.layers.push({ d, insets: [l, t, r, b] });
    },
    "getDrawable()Landroid/graphics/drawable/Drawable;": function (this: JLayerDrawable) { return this.layers[0]?.d ?? null; },
  },
});

// vector drawable
class JVectorDrawable extends JDrawable {
  vw = 24; vh = 24; // dp size
  vpW = 24; vpH = 24;
  paths: { p2d: Path2D; fill: number | null; stroke: number | null; strokeW: number; fillAlpha: number; evenOdd: boolean }[] = [];
  vtint: number | null = null;
  paint(cv: JCanvas) {
    const { left, top, right, bottom } = this.bounds;
    const w = right - left, h = bottom - top;
    if (w <= 0 || h <= 0) return;
    const ctx = cv.ctx;
    ctx.save();
    ctx.globalAlpha *= this.alpha / 255;
    ctx.translate(left, top);
    ctx.scale(w / this.vpW, h / this.vpH);
    const tint = this.tint ?? this.vtint;
    for (const p of this.paths) {
      if (p.fill !== null && p.fill >>> 24) {
        ctx.fillStyle = cssColor(tint ?? p.fill);
        ctx.globalAlpha = (this.alpha / 255) * p.fillAlpha;
        ctx.fill(p.p2d, p.evenOdd ? "evenodd" : "nonzero");
      }
      if (p.stroke !== null && p.strokeW > 0) {
        ctx.strokeStyle = cssColor(tint ?? p.stroke);
        ctx.lineWidth = p.strokeW;
        ctx.stroke(p.p2d);
      }
    }
    ctx.restore();
  }
  intrinsicW(): number { return this.vw * device.density; }
  intrinsicH(): number { return this.vh * device.density; }
}
rt.register({ name: "android/graphics/drawable/VectorDrawable", ctor: JVectorDrawable, sup: "android/graphics/drawable/Drawable" });

// ── ColorStateList
export class JColorStateList extends JObj {
  items: { states: number[]; negStates: number[]; color: number }[] = [];
  defColor = -16777216;
}
export function cslColor(csl: JColorStateList, states: number[]): number {
  return csl.items.find((it) => matchesState(it, states))?.color ?? csl.defColor;
}
export function mkCsl(color: number): JColorStateList {
  const c = new JColorStateList();
  c.defColor = color;
  c.items.push({ states: [], negStates: [], color });
  return c;
}
rt.register({
  name: "android/content/res/ColorStateList", ctor: JColorStateList, ifaces: ["android/os/Parcelable"],
  methods: {
    "<init>([[I[I)V": function (this: JColorStateList, states: Int32Array[], colors: Int32Array) {
      for (let i = 0; i < states.length; i++) {
        const pos: number[] = [], neg: number[] = [];
        for (const s of states[i]) (s >= 0 ? pos : neg).push(Math.abs(s));
        this.items.push({ states: pos, negStates: neg, color: colors[i] });
      }
      this.defColor = colors[colors.length - 1] ?? -16777216;
    },
    "static valueOf(I)Landroid/content/res/ColorStateList;": (c: number) => mkCsl(c),
    "getDefaultColor()I": function (this: JColorStateList) { return this.defColor; },
    "getColorForState([II)I": function (this: JColorStateList, st: Int32Array | null, d: number) {
      return st ? cslColor(this, [...st]) : this.defColor;
    },
    "isStateful()Z": function (this: JColorStateList) { return this.items.length > 1 ? 1 : 0; },
    "withAlpha(I)Landroid/content/res/ColorStateList;": function (this: JColorStateList, a: number) {
      const c = new JColorStateList();
      c.defColor = ((a << 24) | (this.defColor & 0xffffff)) | 0;
      c.items = this.items.map((i) => ({ ...i, color: ((a << 24) | (i.color & 0xffffff)) | 0 }));
      return c;
    },
  },
});

// ─────────────────────────── drawable/CSL loading from resources

function attrRV(res: Resources, a: XmlAttr): RV {
  if (a.type === TV.STRING) return { t: T_STR, d: 0, s: a.str ?? "" };
  return normRV({ t: a.type, d: a.data });
}
function nodeAttr(res: Resources, node: XmlNode, resId: number): RV | null {
  for (const a of node.attrs) if (a.resId === resId) return attrRV(res, a);
  return null;
}
const AT = {
  color: AID("color"), drawable: AID("drawable"), shape: AID("shape"),
  radius: AID("radius"), topLeftRadius: AID("topLeftRadius"), topRightRadius: AID("topRightRadius"),
  bottomLeftRadius: AID("bottomLeftRadius"), bottomRightRadius: AID("bottomRightRadius"),
  width: AID("width"), height: AID("height"), left: AID("left"), top: AID("top"),
  right: AID("right"), bottom: AID("bottom"),
  startColor: AID("startColor"), centerColor: AID("centerColor"), endColor: AID("endColor"),
  angle: AID("angle"), type: AID("type"), gradientRadius: AID("gradientRadius"),
  src: AID("src"), alpha: AID("alpha"), tint: AID("tint"),
  viewportWidth: AID("viewportWidth"), viewportHeight: AID("viewportHeight"),
  pathData: AID("pathData"), fillColor: AID("fillColor"), strokeColor: AID("strokeColor"),
  strokeWidth: AID("strokeWidth"), fillAlpha: AID("fillAlpha"), fillType: AID("fillType"),
  insetLeft: AID("insetLeft"), insetTop: AID("insetTop"), insetRight: AID("insetRight"),
  insetBottom: AID("insetBottom"), inset: AID("inset"),
  dashWidth: AID("dashWidth"), dashGap: AID("dashGap"),
  drawableLeft: 0, id: AID("id"),
};

async function loadDrawableXml(res: Resources, bytes: Uint8Array, theme: JTheme | null): Promise<JDrawable> {
  const root = parseAXML(bytes);
  return inflateDrawableNode(res, root, theme);
}
/** an <item>/<inset>'s drawable: its android:drawable, else its first inline child */
async function itemDrawable(res: Resources, node: XmlNode, theme: JTheme | null): Promise<JDrawable | null> {
  const da = nodeAttr(res, node, AT.drawable);
  if (da) return loadDrawableRV(res, da, theme);
  return node.children.length ? inflateDrawableNode(res, node.children[0], theme) : null;
}
async function inflateDrawableNode(res: Resources, node: XmlNode, theme: JTheme | null): Promise<JDrawable> {
  const get = (id: number) => nodeAttr(res, node, id);
  const colorOf = (v: RV | null, d = 0) => {
    if (v && v.t === TV.ATTRIBUTE) v = theme?.lookup(v.d) ?? null;
    if (v && v.t === TV.REFERENCE) {
      const rr = res.resolveRefs(v);
      if (rr.t === TV.REFERENCE && rr.s) return 0; // selector file; simplify
      v = rr;
    }
    return rvColor(res, v, d);
  };
  switch (node.name) {
    case "shape": {
      const d = new JGradientDrawable();
      d.shape = rvColor(res, get(AT.shape), 0) & 3;
      for (const c of node.children) {
        const cg = (id: number) => nodeAttr(res, c, id);
        if (c.name === "solid") d.solid = colorOf(cg(AT.color), 0);
        else if (c.name === "corners") {
          const r = rvDimen(res, cg(AT.radius), -1);
          if (r >= 0) d.radii = [r, r, r, r];
          d.radii = [
            rvDimen(res, cg(AT.topLeftRadius), d.radii[0]),
            rvDimen(res, cg(AT.topRightRadius), d.radii[1]),
            rvDimen(res, cg(AT.bottomRightRadius), d.radii[2]),
            rvDimen(res, cg(AT.bottomLeftRadius), d.radii[3]),
          ];
        } else if (c.name === "stroke") {
          d.strokeW = rvDimen(res, cg(AT.width), 1);
          d.strokeColor = colorOf(cg(AT.color), 0);
          d.dashW = rvDimen(res, cg(AT.dashWidth), 0);
          d.dashGap = rvDimen(res, cg(AT.dashGap), 0);
        } else if (c.name === "gradient") {
          const cols = [colorOf(cg(AT.startColor), 0)];
          const cc = cg(AT.centerColor);
          if (cc) cols.push(colorOf(cc, 0));
          cols.push(colorOf(cg(AT.endColor), 0));
          d.gradColors = cols;
          d.gradAngle = xmlInt(res, cg(AT.angle), 0);
          d.gradType = xmlInt(res, cg(AT.type), 0);
          d.gradRadius = rvDimen(res, cg(AT.gradientRadius), 0);
        } else if (c.name === "size") {
          d.sizeW = rvDimen(res, cg(AT.width), -1);
          d.sizeH = rvDimen(res, cg(AT.height), -1);
        } else if (c.name === "padding") {
          d.padding.left = rvDimen(res, cg(AT.left), 0);
          d.padding.top = rvDimen(res, cg(AT.top), 0);
          d.padding.right = rvDimen(res, cg(AT.right), 0);
          d.padding.bottom = rvDimen(res, cg(AT.bottom), 0);
        }
      }
      return d;
    }
    case "selector": {
      const d = new JStateListDrawable();
      for (const c of node.children) {
        if (c.name !== "item") continue;
        const states: number[] = [], neg: number[] = [];
        let child: JDrawable | null = null;
        for (const a of c.attrs) {
          if (a.resId >= 0x0101009c && a.resId <= 0x010102fe && Object.values(ST).includes(a.resId)) {
            (a.data ? states : neg).push(a.resId);
          } else if (a.resId === AT.drawable) {
            child = await loadDrawableRV(res, attrRV(res, a), theme);
          }
        }
        if (!child && c.children.length) child = await inflateDrawableNode(res, c.children[0], theme);
        if (child) d.items.push({ states, negStates: neg, d: child });
      }
      return d;
    }
    case "layer-list": {
      const d = new JLayerDrawable();
      for (const c of node.children) {
        if (c.name !== "item") continue;
        const child = await itemDrawable(res, c, theme);
        if (child) {
          d.layers.push({
            d: child,
            insets: [
              rvDimen(res, nodeAttr(res, c, AT.left), 0),
              rvDimen(res, nodeAttr(res, c, AT.top), 0),
              rvDimen(res, nodeAttr(res, c, AT.right), 0),
              rvDimen(res, nodeAttr(res, c, AT.bottom), 0),
            ],
          });
          const idv = nodeAttr(res, c, AT.id);
          d.ids.push(idv ? idv.d : null);
        }
      }
      return d;
    }
    case "ripple": {
      const d = new JRippleDrawable();
      const cv = nodeAttr(res, node, AT.color);
      if (cv) d.rippleColor = (colorOf(cv, 0x33000000) & 0xffffff) | 0x40000000;
      for (const c of node.children) {
        if (c.name !== "item") continue;
        const child = await itemDrawable(res, c, theme);
        if (child) { d.layers.push({ d: child, insets: [0, 0, 0, 0] }); d.ids.push(null); }
      }
      return d;
    }
    case "inset": {
      const d = new JLayerDrawable();
      const child = await itemDrawable(res, node, theme);
      const all = rvDimen(res, get(AT.inset), 0);
      if (child) {
        d.layers.push({
          d: child,
          insets: [
            rvDimen(res, get(AT.insetLeft), all), rvDimen(res, get(AT.insetTop), all),
            rvDimen(res, get(AT.insetRight), all), rvDimen(res, get(AT.insetBottom), all),
          ],
        });
        d.ids.push(null);
      }
      return d;
    }
    case "bitmap": {
      const da = nodeAttr(res, node, AT.src);
      return da ? loadDrawableRV(res, da, theme) : new JColorDrawable();
    }
    case "vector": {
      const d = new JVectorDrawable();
      d.vw = rvDimen(res, get(AT.width), 48) / res.dm.density;
      d.vh = rvDimen(res, get(AT.height), 48) / res.dm.density;
      d.vpW = rvFloat(res, get(AT.viewportWidth), 24);
      d.vpH = rvFloat(res, get(AT.viewportHeight), 24);
      const tintV = get(AT.tint);
      if (tintV) d.vtint = colorOf(tintV, 0) || null;
      const walk = (n: XmlNode) => {
        for (const c of n.children) {
          if (c.name === "path") {
            const pd = nodeAttr(res, c, AT.pathData);
            if (pd?.s) {
              try {
                d.paths.push({
                  p2d: new Path2D(pd.s),
                  fill: (() => { const f = nodeAttr(res, c, AT.fillColor); return f ? colorOf(f, 0) : null; })(),
                  stroke: (() => { const f = nodeAttr(res, c, AT.strokeColor); return f ? colorOf(f, 0) : null; })(),
                  strokeW: rvFloat(res, nodeAttr(res, c, AT.strokeWidth), 0),
                  fillAlpha: rvFloat(res, nodeAttr(res, c, AT.fillAlpha), 1),
                  evenOdd: xmlInt(res, nodeAttr(res, c, AT.fillType), 0) === 1,
                });
              } catch { /* bad path data */ }
            }
          } else if (c.name === "group") walk(c);
          else if (c.name === "clip-path") { /* ignore */ }
        }
      };
      walk(node);
      return d;
    }
    case "color": {
      const d = new JColorDrawable();
      d.color = colorOf(get(AT.color), 0);
      return d;
    }
    case "animated-selector": case "transition": case "level-list": case "animation-list": {
      // static fallback: first item
      for (const c of node.children) {
        if (c.name === "item") {
          const da = nodeAttr(res, c, AT.drawable);
          if (da) return loadDrawableRV(res, da, theme);
          if (c.children.length) return inflateDrawableNode(res, c.children[0], theme);
        }
      }
      return new JColorDrawable();
    }
    default:
      rt.noteMissing("drawable tag <" + node.name + ">");
      return new JColorDrawable();
  }
}
/** rvInt for drawable XML attrs, which arrive unresolved: follows @references (via rvColor). */
function xmlInt(res: Resources, v: RV | null, d: number): number {
  if (!v) return d;
  if (v.t === T_STR && v.s) return parseInt(v.s) || d;
  return rvColor(res, v, d);
}
const DPI_RE = /-(l|m|h|xh|xxh|xxxh)dpi/;
const DPI: Record<string, number> = { l: 120, m: 160, h: 240, xh: 320, xxh: 480, xxxh: 640 };
/** dpi a res/ path's qualifier declares; an unqualified asset is taken at the device's own density */
function densityOfPath(path: string): number { return DPI[DPI_RE.exec(path)?.[1] ?? ""] ?? device.densityDpi; }

export async function loadDrawableRV(res: Resources, v: RV | null, theme: JTheme | null): Promise<JDrawable> {
  if (!v || v.t === TV.NULL) return new JColorDrawable();
  if (v.t === TV.ATTRIBUTE) return loadDrawableRV(res, theme?.lookup(v.d) ?? null, theme);
  if (v.t === TV.REFERENCE) return loadDrawable(res, v.d, theme);
  if (v.t >= TV.COLOR_ARGB8 && v.t <= TV.COLOR_RGB4 || v.t >= TV.INT_DEC) {
    const d = new JColorDrawable();
    d.color = v.d;
    return d;
  }
  if (v.s) { // direct file path
    return loadDrawableFile(res, v.s, theme);
  }
  return new JColorDrawable();
}

export async function loadDrawable(res: Resources, resId: number, theme: JTheme | null): Promise<JDrawable> {
  if (!resId) return new JColorDrawable();
  if (resId >>> 24 === 0x01) return frameworkDrawable(res, resId);
  const e = res.arsc?.entry(resId);
  if (!e) { rt.noteMissing("drawable 0x" + resId.toString(16)); return new JColorDrawable(); }
  if (e.value) {
    const v: RV = { t: e.value.type, d: e.value.data };
    if (v.t === TV.STRING) return loadDrawableFile(res, res.arsc!.values.get(v.d), theme);
    if (v.t === TV.REFERENCE) return loadDrawable(res, v.d, theme);
    return loadDrawableRV(res, v, theme);
  }
  return new JColorDrawable();
}

async function loadDrawableFile(res: Resources, path: string, theme: JTheme | null): Promise<JDrawable> {
  const bytes = res.zip[path];
  if (!bytes) { rt.noteMissing("drawable file " + path); return new JColorDrawable(); }
  if (path.endsWith(".xml")) return loadDrawableXml(res, bytes, theme);
  if (path.endsWith(".9.png")) {
    const chunk = parseNinePatchChunk(bytes);
    const bmp = await decodeBytes(bytes, null);
    const d = new JNinePatchDrawable();
    if (bmp && chunk) {
      d.bmp = bmp;
      d.xDivs = chunk.xDivs;
      d.yDivs = chunk.yDivs;
      d.padding.left = chunk.padding[0]; d.padding.top = chunk.padding[1];
      d.padding.right = chunk.padding[2]; d.padding.bottom = chunk.padding[3];
      d.srcDensityScale = device.densityDpi / densityOfPath(path);
    } else if (bmp) {
      const bd = new JBitmapDrawable();
      bd.bmp = bmp;
      return bd;
    }
    return d;
  }
  const bmp = await decodeBytes(bytes, null);
  const d = new JBitmapDrawable();
  if (bmp) {
    bmp.density = densityOfPath(path);
    d.bmp = bmp;
  }
  return d;
}

// ── synthetic framework drawables
// AOSP asset names decompose as [ic_]<family>_<concept>[_holo|_material][_light|_dark], the theme
// tokens in either order (ab_solid_dark_holo / ic_ab_back_holo_dark). Drop the qualifier tokens,
// then match the remaining base against the icon table and the family table below; colours come
// from the real framework palette (vendor/aosp-res/colors_holo.xml via framework-res.json).

/** icon concepts → 24dp-viewport path; key lists every AOSP name that means the same glyph */
const FW_ICONS: Record<string, string> = {
  "back|up|previous|find_previous|media_previous": "M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z",
  "forward|next|find_next|media_next|go_search": "M10 6 8.6 7.4 13.2 12l-4.6 4.6L10 18l6-6z",
  "more|moreoverflow|overflow": "M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  "search|find": "M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z",
  "close|clear|cancel|close_clear_cancel|delete": "M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z",
  "add|new": "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z",
  "done|check|commit_search|save": "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z",
  share: "M18 16.1c-.8 0-1.5.3-2 .8l-7.1-4.2a3 3 0 0 0 0-1.4l7-4.1a3 3 0 1 0-1-2.2l.1.7L8 9.8a3 3 0 1 0 0 4.4l7.1 4.2-.1.6a2.9 2.9 0 1 0 3-2.9z",
  "edit|compose": "M3 17.2V21h3.8L17.8 9.9l-3.7-3.7zm17.7-10a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7z",
  "alert|error": "M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z",
  "info|details|help": "M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z",
  "refresh|rotate|sync": "M17.6 6.4A8 8 0 1 0 19.7 14h-2.1A6 6 0 1 1 12 6a6 6 0 0 1 4.2 1.8L13 11h7V4z",
};
let ICON: Map<string, Path2D> | null = null; // built on first use: Path2D is DOM-only
function icon(name: string): Path2D | undefined {
  if (!ICON) {
    ICON = new Map();
    for (const [k, d] of Object.entries(FW_ICONS)) { const p = new Path2D(d); for (const n of k.split("|")) ICON.set(n, p); }
  }
  return ICON.get(name);
}
/** tokens that only qualify the variant, never the concept */
const QUAL = new Set(["holo", "material", "light", "dark", "inverse", "api", "am", "alpha"]);
/** families an ic_ name may name before its concept */
const ICFAM = new Set(["ab", "cab", "menu", "dialog", "input", "btn", "action", "media", "lock", "notification"]);

const fwColorCache = new Map<string, number>();
function fwc(res: Resources, name: string): number {
  let c = fwColorCache.get(name);
  if (c === undefined) fwColorCache.set(name, (c = rvColor(res, parseFwValue("@color/" + name, null, res), 0)));
  return c;
}
const av = (c: number, a: number) => ((a << 24) | (c & 0xffffff)) | 0;
const solidD = (c: number) => { const d = new JColorDrawable(); d.color = c; return d; };
/** the holo state background: transparent at rest, control-accent under press/activation */
function selD(hi: number): JStateListDrawable {
  const d = new JStateListDrawable();
  const it = (st: number[], c: number) => d.items.push({ states: st, negStates: [], d: solidD(c) });
  it([ST.pressed], av(hi, 0x99));
  for (const s of [ST.activated, ST.selected, ST.checked]) it([s], av(hi, 0x66));
  it([ST.focused], av(hi, 0x33));
  it([], 0);
  return d;
}
const DP = 2; // px per dp at our fixed xhdpi density
/** the holo spinner asset: transparent, a 1dp rule along the bottom ending in a caret triangle */
class JSpinnerBg extends JDrawable {
  norm = 0; hi = 0;
  paint(cv: JCanvas) {
    const { left, right, bottom } = this.bounds;
    const y = bottom - DP, side = 12 * DP;
    const c = this.tint ?? (this.stateSet.includes(ST.pressed) || this.stateSet.includes(ST.focused) ? this.hi : this.norm);
    const ctx = cv.ctx;
    ctx.save();
    ctx.globalAlpha *= this.alpha / 255;
    ctx.fillStyle = cssColor(av(c, 0x80));
    ctx.fillRect(left, y, right - left, DP);
    ctx.fillStyle = cssColor(c);
    ctx.beginPath();
    ctx.moveTo(right, y - side); ctx.lineTo(right, y); ctx.lineTo(right - side, y);
    ctx.fill();
    ctx.restore();
  }
  onStateChange(): boolean { return true; }
}
type FwGen = (res: Resources, dark: boolean, base: string) => JDrawable | null;
const FW_FAMILY: [RegExp, FwGen][] = [
  [/^ic_/, (r, dark, b) => {
    const t = b.split("_").slice(1);
    if (ICFAM.has(t[0])) t.shift();
    const p = icon(t.join("_"));
    if (!p) return null;
    const d = new JVectorDrawable();
    d.paths.push({ p2d: p, fill: fwc(r, dark ? "bright_foreground_holo_dark" : "bright_foreground_holo_light"), stroke: null, strokeW: 0, fillAlpha: 1, evenOdd: false });
    return d;
  }],
  // widgets draw these glyphs themselves; the framework asset is a no-op
  [/transparent|shadow|^text_cursor|^switch_|^btn_(check|radio|toggle|star)|^ratingbar|^indicator_/, () => solidD(0)],
  [/^spinner_(background|default|pressed|focused|disabled|ab)/, (r, dark) => {
    const d = new JSpinnerBg();
    d.norm = fwc(r, dark ? "hint_foreground_holo_dark" : "hint_foreground_holo_light");
    d.hi = fwc(r, dark ? "holo_control_activated" : "holo_light_control_activated");
    return d;
  }],
  [/^c?ab_|_ab(_|$)/, (r, dark) => solidD(fwc(r, dark ? "holo_primary" : "background_holo_light"))],
  [/divider/, (r) => solidD(fwc(r, "holo_gray_light"))],
  [/activated_background|_selector|item_background|selectable/, (r, dark) => selD(fwc(r, dark ? "holo_control_activated" : "holo_light_control_activated"))],
  [/^btn_|^button_/, (r, dark) => {
    const d = new JGradientDrawable();
    d.solid = fwc(r, dark ? "holo_button_normal" : "holo_light_button_normal");
    d.radii = [4, 4, 4, 4];
    return d;
  }],
  [/edit_text|editbox|textfield/, () => solidD(0)],
  [/background|panel|dialog|popup|toast|menu|frame/, (r, dark) => solidD(fwc(r, dark ? "background_holo_dark" : "background_holo_light"))],
  [/scrollbar|fastscroll|scrubber|progress/, (r) => solidD(fwc(r, "holo_gray_light"))],
];

const fwSpec = new Map<number, { gen: FwGen; dark: boolean; base: string } | null>();
function frameworkDrawable(res: Resources, resId: number): JDrawable {
  let sp = fwSpec.get(resId);
  if (sp === undefined) {
    const toks = res.idName(resId).split("_");
    const base = toks.filter((t) => !QUAL.has(t)).join("_");
    const dark = toks.includes("dark") || toks.includes("inverse");
    sp = null;
    for (const [re, gen] of FW_FAMILY) if (re.test(base)) { sp = { gen, dark, base }; break; }
    fwSpec.set(resId, sp);
  }
  const d = sp?.gen(res, sp.dark, sp.base);
  if (d) return d;
  rt.noteMissing("fw drawable " + res.idName(resId));
  return new JColorDrawable();
}

// ── ColorStateList loading (color/*.xml selectors)
const cslCache = new Map<number, JColorStateList>();
export async function loadColorStateList(res: Resources, resId: number, theme: JTheme | null): Promise<JColorStateList> {
  if (!resId) return mkCsl(0);
  const cached = cslCache.get(resId);
  if (cached) return cached;
  let out: JColorStateList;
  if (resId >>> 24 === 0x01) {
    out = mkCsl(rvColor(res, res.resolveRefs({ t: TV.REFERENCE, d: resId }), -16777216));
  } else {
    const e = res.arsc?.entry(resId);
    if (e?.value?.type === TV.STRING) {
      const path = res.arsc!.values.get(e.value.data);
      const bytes = res.zip[path];
      out = bytes ? parseCslXml(res, bytes, theme) : mkCsl(-16777216);
    } else if (e?.value) {
      const v = res.resolveRefs({ t: e.value.type, d: e.value.data });
      if (v.t === TV.REFERENCE && v.d !== resId) return loadColorStateList(res, v.d, theme);
      out = mkCsl(rvColor(res, v, -16777216));
    } else out = mkCsl(-16777216);
  }
  cslCache.set(resId, out);
  return out;
}
function parseCslXml(res: Resources, bytes: Uint8Array, theme: JTheme | null): JColorStateList {
  const root = parseAXML(bytes);
  const csl = new JColorStateList();
  for (const c of root.children) {
    if (c.name !== "item") continue;
    const states: number[] = [], neg: number[] = [];
    let color = -16777216, alphaMul = 1;
    for (const a of c.attrs) {
      if (Object.values(ST).includes(a.resId)) (a.data ? states : neg).push(a.resId);
      else if (a.resId === AT.color) {
        let v: RV | null = attrRV(res, a);
        if (v.t === TV.ATTRIBUTE) v = theme?.lookup(v.d) ?? null;
        if (v && v.t === TV.REFERENCE) v = res.resolveRefs(v);
        color = rvColor(res, v, -16777216);
      } else if (a.resId === AT.alpha) {
        alphaMul = a.type === TV.FLOAT ? new Float32Array(Int32Array.of(a.data).buffer)[0] : 1;
      }
    }
    if (alphaMul < 1) color = (((color >>> 24) * alphaMul) << 24 | (color & 0xffffff)) | 0;
    csl.items.push({ states, negStates: neg, color });
  }
  csl.defColor = csl.items.find((i) => !i.states.length && !i.negStates.length)?.color ?? csl.items[0]?.color ?? -16777216;
  return csl;
}
