// android.graphics.drawable.* — Drawable hierarchy, XML inflation, 9-patch, vectors.

import { rt, JObj, type NativeSpec } from "../jvm/runtime";
import { vcall, mkEnumSet } from "../jvm/natives/jlang";
import { mangleMethod } from "../jvm/abi";
import { JCanvas, JRect, JRectF, JBitmap, JPaint, cssColor, decodeBytes, tintedBmp, insetsOf } from "./graphics";
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
  autoMirrored = false;
  layoutDir = 0;
  visible = true;

  /** TS-side paint. Subclasses override. */
  paint(cv: JCanvas) {}
  intrinsicW(): number { return -1; }
  intrinsicH(): number { return -1; }
  onStateChange(): boolean { return false; }
}

const M_onBoundsChange = mangleMethod("onBoundsChange", "(Landroid/graphics/Rect;)V");
const M_onStateChange = mangleMethod("onStateChange", "([I)Z");
const M_onLevelChange = mangleMethod("onLevelChange", "(I)Z");
const M_drawD = mangleMethod("draw", "(Landroid/graphics/Canvas;)V");
/**
 * Draw a drawable this one does not own. A container must go through the child's virtual
 * `draw(Canvas)`, never its TS `paint()`: an app-dex Drawable subclass (Material's
 * MaterialShapeDrawable, every library's shape/insets wrapper) has no `paint`, so it inherits
 * the base class's empty one and the child silently draws nothing. Returns whatever the child
 * returns, so a compiled override that suspends is awaitable by a caller that can.
 */
export function drawChild(d: JDrawable, cv: JCanvas): unknown {
  const f = (d as unknown as Record<string, (cv: JCanvas) => unknown>)[M_drawD];
  return f ? f.call(d, cv) : d.paint(cv);
}
/** AOSP setBounds: only a real change reaches onBoundsChange, dispatched virtually so an app
 *  subclass's override (shape caches, wrapped children) sees it */
function setBounds(this: JDrawable, l: number, t: number, r: number, b: number) {
  const bd = this.bounds;
  if (bd.left === l && bd.top === t && bd.right === r && bd.bottom === b) return;
  bd.left = l; bd.top = t; bd.right = r; bd.bottom = b;
  const f = (this as any)[M_onBoundsChange];
  const res = f ? f.call(this, bd) : onBoundsChangeAll(this);
  if (res instanceof Promise) return res;
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
  "setState([I)Z": async function (this: JDrawable, st: Int32Array) {
    const cur = this.stateSet;
    if (cur.length === st.length && cur.every((v, i) => v === st[i])) return 0;
    this.stateSet = [...st];
    // AOSP: every onStateChange that reports a visual change invalidates (StateListDrawable's
    // selectDrawable, RippleDrawable's setRippleActive); the callback is how a Compose ripple
    // host learns to re-record its layer, so a silent state change leaves a pressed ripple stuck.
    if (!await (this as any)[M_onStateChange].call(this, st)) return 0;
    invalidateSelf.call(this);
    return 1;
  },
  "onStateChange([I)Z": function (this: JDrawable) { return this.onStateChange() ? 1 : 0; },
  "onBoundsChange(Landroid/graphics/Rect;)V": function (this: JDrawable) { onBoundsChangeAll(this); },
  "onLevelChange(I)Z": () => 0,
  "getState()[I": function (this: JDrawable) { return Int32Array.from(this.stateSet); },
  "setLevel(I)Z": function (this: JDrawable, l: number) {
    if (this.level === l) return 0;
    this.level = l;
    return (this as any)[M_onLevelChange].call(this, l);
  },
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
  "static resolveOpacity(II)I": (a: number, b: number) => a === b ? a : a === 0 || b === 0 ? 0 : a === -3 || b === -3 ? -3 : a === -2 || b === -2 ? -2 : -1,
  "setVisible(ZZ)Z": function (this: JDrawable, v: number) { const changed = this.visible !== !!v; this.visible = !!v; return changed ? 1 : 0; },
  "isVisible()Z": function (this: JDrawable) { return this.visible ? 1 : 0; },
  "getColorFilter()Landroid/graphics/ColorFilter;": () => null,
  "setTintBlendMode(Landroid/graphics/BlendMode;)V": () => {},
  "getChangingConfigurations()I": () => 0,
  "getOutline(Landroid/graphics/Outline;)V": function (this: JDrawable, o: unknown) {
    const b = this.bounds;
    return vcall(o, "setRect", "(IIII)V", b.left, b.top, b.right, b.bottom);
  },
  "getOpticalInsets()Landroid/graphics/Insets;": () => insetsOf(0, 0, 0, 0),
  "getTransparentRegion()Landroid/graphics/Region;": () => null,
  "isProjected()Z": () => 0,
  "canApplyTheme()Z": () => 0,
  "applyTheme(Landroid/content/res/Resources$Theme;)V": () => {},
  "onLayoutDirectionChanged(I)Z": () => 0,
  "inflate(Landroid/content/res/Resources;Lorg/xmlpull/v1/XmlPullParser;Landroid/util/AttributeSet;)V": () => {},
  "inflate(Landroid/content/res/Resources;Lorg/xmlpull/v1/XmlPullParser;Landroid/util/AttributeSet;Landroid/content/res/Resources$Theme;)V": () => {},
  "setAutoMirrored(Z)V": function (this: JDrawable, m: number) { this.autoMirrored = !!m; },
  "isAutoMirrored()Z": function (this: JDrawable) { return this.autoMirrored ? 1 : 0; },
  "setLayoutDirection(I)Z": function (this: JDrawable, d: number) {
    if (this.layoutDir === d) return 0;
    this.layoutDir = d;
    return 1;
  },
  "getLayoutDirection()I": function (this: JDrawable) { return this.layoutDir; },
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
  solidCsl: JColorStateList | null = null;
  onStateChange(): boolean {
    if (!this.solidCsl) return false;
    const c = cslColor(this.solidCsl, this.stateSet);
    if (c === this.solid) return false;
    this.solid = c;
    return true;
  }
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
    "<init>(Landroid/graphics/drawable/GradientDrawable$Orientation;[I)V": function (this: JGradientDrawable, o: { ord?: number } | null, cs: Int32Array | null) {
      this.gradColors = cs ? [...cs] : null;
      this.gradAngle = ORIENT_ANGLE[o?.ord ?? 0] ?? 0;
    },
    "setOrientation(Landroid/graphics/drawable/GradientDrawable$Orientation;)V": function (this: JGradientDrawable, o: { ord?: number } | null) { this.gradAngle = ORIENT_ANGLE[o?.ord ?? 0] ?? 0; },
    "getCornerRadius()F": function (this: JGradientDrawable) { return this.radii[0]; },
    "getCornerRadii()[F": function (this: JGradientDrawable) {
      const r = this.radii;
      return Float32Array.from([r[0], r[0], r[1], r[1], r[2], r[2], r[3], r[3]]);
    },
    "setColor(Landroid/content/res/ColorStateList;)V": function (this: JGradientDrawable, csl: JColorStateList | null) {
      this.solidCsl = csl;
      this.solid = csl ? cslColor(csl, this.stateSet) : null;
    },
    "getColor()Landroid/content/res/ColorStateList;": function (this: JGradientDrawable) { return this.solidCsl ?? (this.solid !== null ? mkCsl(this.solid) : null); },
  },
});
// GradientDrawable.Orientation ordinals (TOP_BOTTOM first) as the angle each one means
const ORIENT_ANGLE = [270, 225, 180, 135, 90, 45, 0, 315];
mkEnumSet("android/graphics/drawable/GradientDrawable$Orientation", ["TOP_BOTTOM", "TR_BL", "RIGHT_LEFT", "BR_TL", "BOTTOM_TOP", "BL_TR", "LEFT_RIGHT", "TL_BR"]);

/** a selector/color-state item matches when every required state is set and no negated one is */
function matchesState(it: { states: number[]; negStates: number[] }, states: number[]): boolean {
  return it.states.every((s) => states.includes(s)) && !it.negStates.some((s) => states.includes(s));
}

class JStateListDrawable extends JDrawable {
  items: { states: number[]; negStates: number[]; d: JDrawable }[] = [];
  current(): JDrawable | null {
    return (this.items.find((it) => matchesState(it, this.stateSet)) ?? this.items[this.items.length - 1])?.d ?? null;
  }
  /** the child to draw, with this drawable's bounds and paint state pushed onto it */
  target(): JDrawable | null {
    const c = this.current();
    if (!c) return null;
    copyBounds(this, c);
    c.alpha = this.alpha;
    c.tint = c.tint ?? this.tint;
    return c;
  }
  paint(cv: JCanvas) { this.target()?.paint(cv); }
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
    "draw(Landroid/graphics/Canvas;)V": function (this: JStateListDrawable, cv: JCanvas) {
      const c = this.target();
      return c ? drawChild(c, cv) : undefined;
    },
    "<init>()V": function () {},
    "addState([ILandroid/graphics/drawable/Drawable;)V": function (this: JStateListDrawable, st: Int32Array, d: JDrawable) {
      const states: number[] = [], neg: number[] = [];
      for (const s of st) (s >= 0 ? states : neg).push(Math.abs(s));
      this.items.push({ states, negStates: neg, d });
    },
  },
});

class JLayerDrawable extends JDrawable {
  layers: { d: JDrawable; insets: [number, number, number, number]; w?: number; h?: number; gravity?: number }[] = [];
  ids: (number | null)[] = [];
  /** AOSP updateLayerBounds: insets, then an explicit layer size placed by its gravity */
  layout() {
    for (const l of this.layers) {
      let L = this.bounds.left + l.insets[0], T = this.bounds.top + l.insets[1];
      let R = this.bounds.right - l.insets[2], B = this.bounds.bottom - l.insets[3];
      const w = l.w !== undefined && l.w >= 0 ? l.w : -1, h = l.h !== undefined && l.h >= 0 ? l.h : -1;
      if (w >= 0 || h >= 0) {
        const g = l.gravity || (w >= 0 && h >= 0 ? 0x33 : w >= 0 ? 0x73 : 0x37);
        if (w >= 0) { const hg = g & 7; L = hg === 1 ? ((L + R - w) >> 1) : hg === 5 ? R - w : L; R = L + w; }
        if (h >= 0) { const vg = g & 0x70; T = vg === 16 ? ((T + B - h) >> 1) : vg === 80 ? B - h : T; B = T + h; }
      }
      setBounds.call(l.d, L, T, R, B);
    }
  }
  paint(cv: JCanvas) {
    this.layout();
    for (const l of this.layers) l.d.paint(cv);
  }
  /** Every layer through its virtual draw. Stays synchronous — no promise allocated — unless a
   *  compiled child actually suspends, in which case the rest follow it in order. */
  drawLayers(cv: JCanvas): unknown {
    this.layout();
    const step = (i: number): unknown => {
      for (; i < this.layers.length; i++) {
        const r = drawChild(this.layers[i].d, cv);
        if (r instanceof Promise) return r.then(() => step(i + 1));
      }
    };
    return step(0);
  }
  intrinsicW(): number { return this.layers.reduce((a, l) => Math.max(a, l.d.intrinsicW() + l.insets[0] + l.insets[2]), -1); }
  intrinsicH(): number { return this.layers.reduce((a, l) => Math.max(a, l.d.intrinsicH() + l.insets[1] + l.insets[3]), -1); }
}
rt.register({
  name: "android/graphics/drawable/LayerDrawable", ctor: JLayerDrawable, sup: "android/graphics/drawable/Drawable",
  methods: {
    "draw(Landroid/graphics/Canvas;)V": function (this: JLayerDrawable, cv: JCanvas) { return this.drawLayers(cv); },
    // AOSP: each layer's inset plus that layer's own padding, the widest of each edge. This is
    // what an InsetDrawable used as a window background reports, and what tells the window how
    // far inside itself the content has to sit.
    "getPadding(Landroid/graphics/Rect;)Z": async function (this: JLayerDrawable, r: JRect) {
      r.left = r.top = r.right = r.bottom = 0;
      const p = new JRect();
      for (const l of this.layers) {
        p.left = p.top = p.right = p.bottom = 0;
        await vcall(l.d, "getPadding", "(Landroid/graphics/Rect;)Z", p);
        r.left = Math.max(r.left, l.insets[0] + p.left);
        r.top = Math.max(r.top, l.insets[1] + p.top);
        r.right = Math.max(r.right, l.insets[2] + p.right);
        r.bottom = Math.max(r.bottom, l.insets[3] + p.bottom);
      }
      return r.left || r.top || r.right || r.bottom ? 1 : 0;
    },
    "<init>([Landroid/graphics/drawable/Drawable;)V": function (this: JLayerDrawable, ds: JDrawable[]) {
      for (const d of ds ?? []) this.layers.push({ d, insets: [0, 0, 0, 0] });
    },
    // AOSP hands the state to every layer: a Material button's fill is a MaterialShapeDrawable
    // inside an InsetDrawable inside the ripple, and it is the one that reads state_checked
    "onStateChange([I)Z": async function (this: JLayerDrawable, st: Int32Array) {
      let changed = this.onStateChange();
      for (const l of this.layers) if (await vcall(l.d, "setState", "([I)Z", st)) changed = true;
      return changed ? 1 : 0;
    },
    "isStateful()Z": () => 1,
    "getNumberOfLayers()I": function (this: JLayerDrawable) { return this.layers.length; },
    "getDrawable(I)Landroid/graphics/drawable/Drawable;": function (this: JLayerDrawable, i: number) { return this.layers[i]?.d ?? null; },
    "findDrawableByLayerId(I)Landroid/graphics/drawable/Drawable;": function (this: JLayerDrawable, id: number) {
      const i = this.ids.indexOf(id);
      return i >= 0 ? this.layers[i]?.d ?? null : null;
    },
    "setLayerInset(IIIII)V": function (this: JLayerDrawable, i: number, l: number, t: number, r: number, b: number) {
      if (this.layers[i]) this.layers[i].insets = [l, t, r, b];
    },
    "setLayerInsetLeft(II)V": function (this: JLayerDrawable, i: number, v: number) { if (this.layers[i]) this.layers[i].insets[0] = v; },
    "setLayerInsetTop(II)V": function (this: JLayerDrawable, i: number, v: number) { if (this.layers[i]) this.layers[i].insets[1] = v; },
    "setLayerInsetRight(II)V": function (this: JLayerDrawable, i: number, v: number) { if (this.layers[i]) this.layers[i].insets[2] = v; },
    "setLayerInsetBottom(II)V": function (this: JLayerDrawable, i: number, v: number) { if (this.layers[i]) this.layers[i].insets[3] = v; },
    "setLayerInsetStart(II)V": function (this: JLayerDrawable, i: number, v: number) { if (this.layers[i]) this.layers[i].insets[0] = v; },
    "setLayerInsetEnd(II)V": function (this: JLayerDrawable, i: number, v: number) { if (this.layers[i]) this.layers[i].insets[2] = v; },
    "getLayerInsetLeft(I)I": function (this: JLayerDrawable, i: number) { return this.layers[i]?.insets[0] ?? 0; },
    "getLayerInsetTop(I)I": function (this: JLayerDrawable, i: number) { return this.layers[i]?.insets[1] ?? 0; },
    "getLayerInsetRight(I)I": function (this: JLayerDrawable, i: number) { return this.layers[i]?.insets[2] ?? 0; },
    "getLayerInsetBottom(I)I": function (this: JLayerDrawable, i: number) { return this.layers[i]?.insets[3] ?? 0; },
    "getLayerInsetStart(I)I": function (this: JLayerDrawable, i: number) { return this.layers[i]?.insets[0] ?? 0; },
    "getLayerInsetEnd(I)I": function (this: JLayerDrawable, i: number) { return this.layers[i]?.insets[2] ?? 0; },
    "setLayerSize(III)V": function (this: JLayerDrawable, i: number, w: number, h: number) { if (this.layers[i]) { this.layers[i].w = w; this.layers[i].h = h; } },
    "setLayerWidth(II)V": function (this: JLayerDrawable, i: number, w: number) { if (this.layers[i]) this.layers[i].w = w; },
    "setLayerHeight(II)V": function (this: JLayerDrawable, i: number, h: number) { if (this.layers[i]) this.layers[i].h = h; },
    "getLayerWidth(I)I": function (this: JLayerDrawable, i: number) { return this.layers[i]?.w ?? -1; },
    "getLayerHeight(I)I": function (this: JLayerDrawable, i: number) { return this.layers[i]?.h ?? -1; },
    "setLayerGravity(II)V": function (this: JLayerDrawable, i: number, g: number) { if (this.layers[i]) this.layers[i].gravity = g; },
    "getLayerGravity(I)I": function (this: JLayerDrawable, i: number) { return this.layers[i]?.gravity ?? 0; },
    "setId(II)V": function (this: JLayerDrawable, i: number, id: number) { this.ids[i] = id; },
    "getId(I)I": function (this: JLayerDrawable, i: number) { return this.ids[i] ?? -1; },
    "addLayer(Landroid/graphics/drawable/Drawable;)I": function (this: JLayerDrawable, d: JDrawable) {
      d.callback = this;
      this.layers.push({ d, insets: [0, 0, 0, 0] });
      return this.layers.length - 1;
    },
    "setDrawableByLayerId(ILandroid/graphics/drawable/Drawable;)Z": function (this: JLayerDrawable, id: number, d: JDrawable) {
      const i = this.ids.indexOf(id);
      if (i < 0 || !this.layers[i]) return 0;
      this.layers[i].d = d; d.callback = this;
      return 1;
    },
    "setDrawable(ILandroid/graphics/drawable/Drawable;)V": function (this: JLayerDrawable, i: number, d: JDrawable) { if (this.layers[i]) { this.layers[i].d = d; d.callback = this; } },
  },
});
/** RippleDrawable.RADIUS_AUTO: compute the radius from bounds instead of using an explicit one. */
const RADIUS_AUTO = -1;
// AOSP RippleForeground timings: the ripple grows from the hotspot to cover the bounds while
// fading in, and on release finishes growing while fading out.
const RIPPLE_ENTER_MS = 225, RIPPLE_ENTER_ALPHA_MS = 75, RIPPLE_EXIT_MS = 150;
const decel = (t: number) => 1 - (1 - t) * (1 - t);
/**
 * AdaptiveIconDrawable: two 108dp layers behind a 72dp viewport, clipped to the device mask.
 * Every `@mipmap/ic_launcher` on a modern app is one, and without it an app's own icon — the
 * one it puts in its about screen and its first-run dialog — is a blank square.
 */
class JAdaptiveIconDrawable extends JLayerDrawable {
  /** AOSP getFullBounds: each layer is the viewport grown by 25% on every side */
  layout() {
    const { left, top, right, bottom } = this.bounds;
    const dx = (right - left) / 4, dy = (bottom - top) / 4;
    for (const l of this.layers) setBounds.call(l.d, left - dx, top - dy, right + dx, bottom + dy);
  }
  clip(cv: JCanvas) {
    const { left, top, right, bottom } = this.bounds;
    cv.ctx.beginPath();
    cv.ctx.roundRect(left, top, right - left, bottom - top, Math.min(right - left, bottom - top) * 0.28);
    cv.ctx.clip();
  }
  paint(cv: JCanvas) {
    cv.ctx.save();
    this.clip(cv);
    super.paint(cv);
    cv.ctx.restore();
  }
  // the viewport, not the 108dp layers the children actually are
  intrinsicW(): number { const w = super.intrinsicW(); return w < 0 ? w : Math.round(w * 2 / 3); }
  intrinsicH(): number { const h = super.intrinsicH(); return h < 0 ? h : Math.round(h * 2 / 3); }
}
rt.register({
  name: "android/graphics/drawable/AdaptiveIconDrawable", ctor: JAdaptiveIconDrawable,
  sup: "android/graphics/drawable/LayerDrawable",
  methods: {
    "<init>(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V":
      function (this: JAdaptiveIconDrawable, bg: JDrawable | null, fg: JDrawable | null) {
        for (const d of [bg, fg]) if (d) this.layers.push({ d, insets: [0, 0, 0, 0] });
      },
    "getBackground()Landroid/graphics/drawable/Drawable;": function (this: JAdaptiveIconDrawable) { return this.layers[0]?.d ?? null; },
    "getForeground()Landroid/graphics/drawable/Drawable;": function (this: JAdaptiveIconDrawable) { return this.layers[1]?.d ?? null; },
    "draw(Landroid/graphics/Canvas;)V": function (this: JAdaptiveIconDrawable, cv: JCanvas) {
      cv.ctx.save();
      this.clip(cv);
      const r = this.drawLayers(cv);
      return r instanceof Promise ? r.finally(() => cv.ctx.restore()) : cv.ctx.restore();
    },
  },
});

export class JRippleDrawable extends JLayerDrawable {
  rippleColor = 0x33000000;
  /** explicit override from setRadius(), or RADIUS_AUTO to derive it from bounds each draw. */
  explicitRadius = RADIUS_AUTO;
  active = false; enterAt = 0; exitAt = 0;
  hx = Number.NaN; hy = Number.NaN;
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
  setColor(csl: JColorStateList | null) {
    // AOSP getRipplePaint caps the ripple at 50% opacity whatever the state list says
    const c = csl ? cslColor(csl, this.stateSet) : 0x33000000;
    this.rippleColor = (c >>> 24) > 0x80 ? ((c & 0xffffff) | 0x80000000) | 0 : c;
  }
  paint(cv: JCanvas) {
    super.paint(cv);
    this.ripple(cv);
  }
  ripple(cv: JCanvas) {
    const now = performance.now();
    let grow: number, fade: number, animating: boolean;
    if (this.active) {
      const t = (now - this.enterAt) / RIPPLE_ENTER_MS;
      grow = decel(Math.min(1, t));
      fade = Math.min(1, (now - this.enterAt) / RIPPLE_ENTER_ALPHA_MS);
      animating = t < 1;
    } else if (this.exitAt) {
      const t = (now - this.exitAt) / RIPPLE_EXIT_MS;
      if (t >= 1) { this.exitAt = 0; return; }
      grow = 1;
      fade = 1 - t;
      animating = true;
    } else return;
    const { left, top, right, bottom } = this.bounds;
    const cx0 = (left + right) / 2, cy0 = (top + bottom) / 2;
    const cx = Number.isNaN(this.hx) ? cx0 : this.hx + (cx0 - this.hx) * grow;
    const cy = Number.isNaN(this.hy) ? cy0 : this.hy + (cy0 - this.hy) * grow;
    const ctx = cv.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, right - left, bottom - top);
    ctx.clip();
    ctx.globalAlpha *= fade * (this.alpha / 255);
    ctx.fillStyle = cssColor(this.rippleColor);
    ctx.beginPath();
    ctx.arc(cx, cy, this.radius() * grow, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (animating) invalidateSelf.call(this);
  }
  onStateChange(): boolean {
    const active = this.stateSet.includes(ST.pressed) && this.stateSet.includes(ST.enabled);
    if (active === this.active) return false;
    this.active = active;
    const now = performance.now();
    if (active) { this.enterAt = now; this.exitAt = 0; } else this.exitAt = now;
    return true;
  }
}
rt.register({
  name: "android/graphics/drawable/RippleDrawable", ctor: JRippleDrawable, sup: "android/graphics/drawable/LayerDrawable",
  methods: {
    "draw(Landroid/graphics/Canvas;)V": function (this: JRippleDrawable, cv: JCanvas) {
      const r = this.drawLayers(cv);
      return r instanceof Promise ? r.then(() => this.ripple(cv)) : this.ripple(cv);
    },
    "<init>(Landroid/content/res/ColorStateList;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V":
      function (this: JRippleDrawable, csl: JColorStateList | null, content: JDrawable | null) {
        if (content) this.layers.push({ d: content, insets: [0, 0, 0, 0] });
        this.setColor(csl);
      },
    "setColor(Landroid/content/res/ColorStateList;)V": function (this: JRippleDrawable, csl: JColorStateList) {
      this.setColor(csl);
      invalidateSelf.call(this);
    },
    "setHotspot(FF)V": function (this: JRippleDrawable, x: number, y: number) { this.hx = x; this.hy = y; },
    "isProjected()Z": () => 0,
    "isStateful()Z": () => 1,
    "hasFocusStateSpecified()Z": () => 1,
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
// ── DrawableWrapper: one child, everything forwarded (AOSP's base for Clip/Scale/Inset and any
// app drawable that decorates another). Bounds, state and level reach the child through its
// own virtual hooks; draw() dispatches virtually so a compiled child subclass paints itself.
export class JDrawableWrapper extends JDrawable {
  dr: JDrawable | null = null;
  paint(cv: JCanvas) { if (this.dr) drawChild(this.dr, cv); }
  intrinsicW(): number { return this.dr ? this.dr.intrinsicW() : -1; }
  intrinsicH(): number { return this.dr ? this.dr.intrinsicH() : -1; }
  onStateChange(): boolean { return this.dr ? this.dr.onStateChange() : false; }
}
function wrapSet(this: JDrawableWrapper, d: JDrawable | null) {
  if (this.dr) this.dr.callback = null;
  this.dr = d;
  if (d) {
    d.callback = this;
    d.stateSet = this.stateSet; d.level = this.level;
    setBounds.call(d, this.bounds.left, this.bounds.top, this.bounds.right, this.bounds.bottom);
  }
}
rt.register({
  name: "android/graphics/drawable/DrawableWrapper", ctor: JDrawableWrapper, sup: "android/graphics/drawable/Drawable",
  ifaces: ["android/graphics/drawable/Drawable$Callback"],
  methods: {
    "<init>(Landroid/graphics/drawable/Drawable;)V": wrapSet,
    "setDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JDrawableWrapper, d: JDrawable | null) { wrapSet.call(this, d); invalidateSelf.call(this); },
    "getDrawable()Landroid/graphics/drawable/Drawable;": function (this: JDrawableWrapper) { return this.dr; },
    "draw(Landroid/graphics/Canvas;)V": function (this: JDrawableWrapper, cv: JCanvas) { if (this.dr) return (this.dr as any)[M_drawD].call(this.dr, cv); },
    "onBoundsChange(Landroid/graphics/Rect;)V": function (this: JDrawableWrapper, r: JRect) { if (this.dr) return setBounds.call(this.dr, r.left, r.top, r.right, r.bottom); },
    "onStateChange([I)Z": function (this: JDrawableWrapper, st: Int32Array) { return this.dr ? vcall(this.dr, "setState", "([I)Z", st) : 0; },
    "onLevelChange(I)Z": function (this: JDrawableWrapper, l: number) { return this.dr ? vcall(this.dr, "setLevel", "(I)Z", l) : 0; },
    "isStateful()Z": function (this: JDrawableWrapper) { return this.dr ? vcall(this.dr, "isStateful", "()Z") : 0; },
    "hasFocusStateSpecified()Z": function (this: JDrawableWrapper) { return this.dr ? vcall(this.dr, "hasFocusStateSpecified", "()Z") : 0; },
    "getPadding(Landroid/graphics/Rect;)Z": function (this: JDrawableWrapper, r: JRect) {
      if (this.dr) return vcall(this.dr, "getPadding", "(Landroid/graphics/Rect;)Z", r);
      r.left = r.top = r.right = r.bottom = 0; return 0;
    },
    "getOpacity()I": function (this: JDrawableWrapper) { return this.dr ? vcall(this.dr, "getOpacity", "()I") : -2; },
    "setAlpha(I)V": function (this: JDrawableWrapper, a: number) { this.alpha = a; if (this.dr) return vcall(this.dr, "setAlpha", "(I)V", a); },
    "getAlpha()I": function (this: JDrawableWrapper) { return this.dr ? vcall(this.dr, "getAlpha", "()I") : 255; },
    "setColorFilter(Landroid/graphics/ColorFilter;)V": function (this: JDrawableWrapper, f: unknown) { if (this.dr) return vcall(this.dr, "setColorFilter", "(Landroid/graphics/ColorFilter;)V", f); },
    "setTintList(Landroid/content/res/ColorStateList;)V": function (this: JDrawableWrapper, c: unknown) { if (this.dr) return vcall(this.dr, "setTintList", "(Landroid/content/res/ColorStateList;)V", c); },
    "setTintMode(Landroid/graphics/PorterDuff$Mode;)V": function (this: JDrawableWrapper, m: unknown) { if (this.dr) return vcall(this.dr, "setTintMode", "(Landroid/graphics/PorterDuff$Mode;)V", m); },
    "setVisible(ZZ)Z": function (this: JDrawableWrapper, v: number, r: number) { return this.dr ? vcall(this.dr, "setVisible", "(ZZ)Z", v, r) : 0; },
    "jumpToCurrentState()V": function (this: JDrawableWrapper) { if (this.dr) return vcall(this.dr, "jumpToCurrentState", "()V"); },
    "mutate()Landroid/graphics/drawable/Drawable;": function (this: JDrawableWrapper) { if (this.dr) void vcall(this.dr, "mutate", "()Landroid/graphics/drawable/Drawable;"); return this; },
    "applyTheme(Landroid/content/res/Resources$Theme;)V": () => {},
    "canApplyTheme()Z": () => 0,
    "inflate(Landroid/content/res/Resources;Lorg/xmlpull/v1/XmlPullParser;Landroid/util/AttributeSet;Landroid/content/res/Resources$Theme;)V": () => {},
    "getOutline(Landroid/graphics/Outline;)V": function (this: JDrawableWrapper, o: unknown) { if (this.dr) return vcall(this.dr, "getOutline", "(Landroid/graphics/Outline;)V", o); },
    "getChangingConfigurations()I": () => 0,
    "getConstantState()Landroid/graphics/drawable/Drawable$ConstantState;": () => null,
  },
});
// ── android.graphics.drawable.shapes + ShapeDrawable: a Shape is resized to the drawable's
// bounds and painted with the drawable's own Paint (translated to the bounds origin, as AOSP).
export class JShape extends JObj {
  w = 0; h = 0;
  path(): Path2D { const p = new Path2D(); p.rect(0, 0, this.w, this.h); return p; }
}
class JOvalShape extends JShape {
  path(): Path2D { const p = new Path2D(); p.ellipse(this.w / 2, this.h / 2, this.w / 2, this.h / 2, 0, 0, Math.PI * 2); return p; }
}
const rr = (p: Path2D, x: number, y: number, w: number, h: number, radii: Float32Array | null) => {
  if (!radii) { p.rect(x, y, w, h); return; }
  // AOSP radii are [tl-x, tl-y, tr-x, tr-y, br-x, br-y, bl-x, bl-y]
  p.roundRect(x, y, w, h, [
    { x: radii[0], y: radii[1] }, { x: radii[2], y: radii[3] }, { x: radii[4], y: radii[5] }, { x: radii[6], y: radii[7] },
  ]);
};
class JRoundRectShape extends JShape {
  outer: Float32Array | null = null; inset: JRectF | null = null; inner: Float32Array | null = null;
  path(): Path2D {
    const p = new Path2D();
    rr(p, 0, 0, this.w, this.h, this.outer);
    if (this.inset) {
      const i = this.inset;
      // the inner ring is cut out (even-odd fill in ShapeDrawable's draw)
      const q = new Path2D();
      rr(q, i.left, i.top, this.w - i.left - i.right, this.h - i.top - i.bottom, this.inner);
      p.addPath(q);
    }
    return p;
  }
}
const M_shapeDraw = mangleMethod("draw", "(Landroid/graphics/Canvas;Landroid/graphics/Paint;)V");
const M_onResize = mangleMethod("onResize", "(FF)V");
const shapeMethods: NonNullable<NativeSpec["methods"]> = {
  "<init>()V": function () {},
  "getWidth()F": function (this: JShape) { return this.w; },
  "getHeight()F": function (this: JShape) { return this.h; },
  "resize(FF)V": function (this: JShape, w: number, h: number) {
    w = Math.max(0, w); h = Math.max(0, h);
    if (this.w === w && this.h === h) return;
    this.w = w; this.h = h;
    return (this as any)[M_onResize].call(this, w, h);
  },
  "onResize(FF)V": () => {},
  "hasAlpha()Z": () => 1,
  "getOutline(Landroid/graphics/Outline;)V": () => {},
  "draw(Landroid/graphics/Canvas;Landroid/graphics/Paint;)V": function (this: JShape, cv: JCanvas, p: JPaint) {
    const path = this.path();
    const evenOdd = this instanceof JRoundRectShape && !!this.inset;
    cv.drawShape(p, (c) => c.fill(path, evenOdd ? "evenodd" : "nonzero"), (c) => c.stroke(path));
  },
  "clone()Landroid/graphics/drawable/shapes/Shape;": function (this: JShape) { return Object.assign(new (this.constructor as any)(), this); },
};
rt.register({ name: "android/graphics/drawable/shapes/Shape", ctor: JShape, ifaces: ["java/lang/Cloneable"], methods: shapeMethods });
rt.register({ name: "android/graphics/drawable/shapes/RectShape", ctor: class extends JShape {}, sup: "android/graphics/drawable/shapes/Shape", methods: { "<init>()V": function () {} } });
rt.register({ name: "android/graphics/drawable/shapes/OvalShape", ctor: JOvalShape, sup: "android/graphics/drawable/shapes/RectShape", methods: { "<init>()V": function () {} } });
rt.register({
  name: "android/graphics/drawable/shapes/RoundRectShape", ctor: JRoundRectShape, sup: "android/graphics/drawable/shapes/RectShape",
  methods: {
    "<init>([FLandroid/graphics/RectF;[F)V": function (this: JRoundRectShape, outer: Float32Array | null, inset: JRectF | null, inner: Float32Array | null) {
      if (outer && outer.length < 8) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", "outer radii must have >= 8 values");
      if (inner && inner.length < 8) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", "inner radii must have >= 8 values");
      this.outer = outer; this.inset = inset; this.inner = inner;
    },
  },
});

export class JShapeDrawable extends JDrawable {
  shape: JShape | null = null;
  p = new JPaint();
  iw = 0; ih = 0;
  padding: JRect | null = null;
  effPaint(): JPaint { return this.tint === null ? this.p : Object.assign(new JPaint(), this.p, { color: this.tint }); }
  /** sync path for native callers (LayerDrawable layers): native shape geometry only */
  paint(cv: JCanvas) {
    const sh = this.shape;
    if (!sh) return;
    const b = this.bounds, ctx = cv.ctx;
    sh.w = b.right - b.left; sh.h = b.bottom - b.top;
    ctx.save();
    ctx.translate(b.left, b.top);
    (shapeMethods["draw(Landroid/graphics/Canvas;Landroid/graphics/Paint;)V"] as any).call(sh, cv, this.effPaint());
    ctx.restore();
  }
  intrinsicW(): number { return this.iw; }
  intrinsicH(): number { return this.ih; }
}
rt.register({
  name: "android/graphics/drawable/ShapeDrawable", ctor: JShapeDrawable, sup: "android/graphics/drawable/Drawable",
  methods: {
    "<init>()V": function (this: JShapeDrawable) { this.p.antiAlias = true; },
    "<init>(Landroid/graphics/drawable/shapes/Shape;)V": function (this: JShapeDrawable, sh: JShape | null) { this.shape = sh; this.p.antiAlias = true; },
    "getPaint()Landroid/graphics/Paint;": function (this: JShapeDrawable) { return this.p; },
    "getShape()Landroid/graphics/drawable/shapes/Shape;": function (this: JShapeDrawable) { return this.shape; },
    "setShape(Landroid/graphics/drawable/shapes/Shape;)V": function (this: JShapeDrawable, sh: JShape | null) { this.shape = sh; invalidateSelf.call(this); },
    "setIntrinsicWidth(I)V": function (this: JShapeDrawable, w: number) { this.iw = w; },
    "setIntrinsicHeight(I)V": function (this: JShapeDrawable, h: number) { this.ih = h; },
    "setPadding(IIII)V": function (this: JShapeDrawable, l: number, t: number, r: number, b: number) {
      if (!l && !t && !r && !b) { this.padding = null; return; }
      const p = this.padding ?? (this.padding = new JRect());
      p.left = l; p.top = t; p.right = r; p.bottom = b;
    },
    "setPadding(Landroid/graphics/Rect;)V": function (this: JShapeDrawable, r: JRect | null) {
      if (!r) { this.padding = null; return; }
      const p = this.padding ?? (this.padding = new JRect());
      p.left = r.left; p.top = r.top; p.right = r.right; p.bottom = r.bottom;
    },
    "setAlpha(I)V": function (this: JShapeDrawable, a: number) { this.alpha = a; this.p.color = ((a << 24) | (this.p.color & 0xffffff)) | 0; invalidateSelf.call(this); },
    "getAlpha()I": function (this: JShapeDrawable) { return this.p.color >>> 24; },
    "getOpacity()I": function (this: JShapeDrawable) { const a = this.p.color >>> 24; return a === 255 ? -1 : a === 0 ? -2 : -3; },
    "getOutline(Landroid/graphics/Outline;)V": () => {},
    // the virtual route: an app Shape subclass's onResize/draw, and an app ShapeDrawable's onDraw
    "draw(Landroid/graphics/Canvas;)V": async function (this: JShapeDrawable, cv: JCanvas) {
      const sh = this.shape;
      if (!sh) return;
      const b = this.bounds, ctx = cv.ctx;
      await vcall(sh, "resize", "(FF)V", b.right - b.left, b.bottom - b.top);
      ctx.save();
      ctx.translate(b.left, b.top);
      try { await vcall(this, "onDraw", "(Landroid/graphics/drawable/shapes/Shape;Landroid/graphics/Canvas;Landroid/graphics/Paint;)V", sh, cv, this.effPaint()); }
      finally { ctx.restore(); }
    },
    "onDraw(Landroid/graphics/drawable/shapes/Shape;Landroid/graphics/Canvas;Landroid/graphics/Paint;)V": function (this: JShapeDrawable, sh: JShape, cv: JCanvas, p: JPaint) {
      return (sh as any)[M_shapeDraw].call(sh, cv, p);
    },
  },
});
rt.register({ name: "android/graphics/drawable/VectorDrawable", ctor: JVectorDrawable, sup: "android/graphics/drawable/Drawable" });

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
    case "adaptive-icon": {
      const d = new JAdaptiveIconDrawable();
      for (const n of ["background", "foreground"]) {
        const c = node.children.find((k) => k.name === n);
        const child = c ? await itemDrawable(res, c, theme) : null;
        if (child) d.layers.push({ d: child, insets: [0, 0, 0, 0] });
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
  norm = 0; hi = 0; rule = true;
  paint(cv: JCanvas) {
    const { left, right, bottom } = this.bounds;
    const y = bottom - DP, side = 12 * DP;
    const c = this.tint ?? (this.stateSet.includes(ST.pressed) || this.stateSet.includes(ST.focused) ? this.hi : this.norm);
    const ctx = cv.ctx;
    ctx.save();
    ctx.globalAlpha *= this.alpha / 255;
    if (this.rule) {
      ctx.fillStyle = cssColor(av(c, 0x80));
      ctx.fillRect(left, y, right - left, DP);
    }
    ctx.fillStyle = cssColor(c);
    ctx.beginPath();
    if (this.rule) { ctx.moveTo(right, y - side); ctx.lineTo(right, y); ctx.lineTo(right - side, y); }
    else { // the Material caret points down, centred on the drawable's right edge
      const cy = (this.bounds.top + bottom) / 2, w = 5 * DP;
      ctx.moveTo(right - 2 * w, cy - w / 2); ctx.lineTo(right, cy - w / 2); ctx.lineTo(right - w, cy + w);
    }
    ctx.fill();
    ctx.restore();
  }
  onStateChange(): boolean { return true; }
}
type FwGen = (res: Resources, dark: boolean, base: string, material: boolean) => JDrawable | null;
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
  [/^spinner_(background|default|pressed|focused|disabled|ab)/, (r, dark, _base, material) => {
    const d = new JSpinnerBg();
    // the Material asset is the caret alone; only the Holo one carries the rule under it
    d.rule = !material;
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

const fwSpec = new Map<number, { gen: FwGen; dark: boolean; base: string; material: boolean } | null>();
function frameworkDrawable(res: Resources, resId: number): JDrawable {
  let sp = fwSpec.get(resId);
  if (sp === undefined) {
    const toks = res.idName(resId).split("_");
    const base = toks.filter((t) => !QUAL.has(t)).join("_");
    const dark = toks.includes("dark") || toks.includes("inverse");
    sp = null;
    for (const [re, gen] of FW_FAMILY) if (re.test(base)) { sp = { gen, dark, base, material: toks.includes("material") }; break; }
    fwSpec.set(resId, sp);
  }
  const d = sp?.gen(res, sp.dark, sp.base, sp.material);
  if (d) return d;
  rt.noteMissing("fw drawable " + res.idName(resId));
  return new JColorDrawable();
}

// ── ColorStateList loading (color/*.xml selectors)
// Keyed by theme as well as id: a Material colour selector is a list of `?attr/` items, so
// the same resource is a different list under every ThemeOverlay that reads it.
const NO_THEME = {};
const cslCache = new WeakMap<object, Map<number, JColorStateList>>();
export async function loadColorStateList(res: Resources, resId: number, theme: JTheme | null): Promise<JColorStateList> {
  if (!resId) return mkCsl(0);
  const key = theme ?? NO_THEME;
  let byId = cslCache.get(key);
  if (!byId) cslCache.set(key, byId = new Map());
  const cached = byId.get(resId);
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
  byId.set(resId, out);
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
