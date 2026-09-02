// android.view.View/ViewGroup: measure→layout→draw pipeline + touch dispatch.
// Canvas coordinates: draw() runs with ctx translated to the view's top-left.

import { rt, JObj, type NativeSpec } from "../jvm/runtime";
import { perf } from "../perf";
import { device } from "../shell/config";
import { mangleMethod } from "../jvm/abi";
import { vcall, idHash } from "../jvm/natives/jlang";
import { JCanvas, JRect, setInvalidateHook, JMatrix } from "./graphics";
import { JDrawable, ST, loadDrawableRV, JColorDrawable, loadDrawable } from "./drawable";
import { reportUncaught, mainHandler, type JDisplayMetrics } from "./os";
import { onMain } from "./mainloop";
import { type Resources, JTheme, JAttrSet, AID, obtainStyled, rvDimen, rvInt, rvString } from "./res";

export { AID };

// MeasureSpec
export const MS_EXACTLY = 0x40000000;
export const MS_AT_MOST = -0x80000000;
export const MS_UNSPEC = 0;
export const specMode = (s: number) => s & 0xc0000000;
export const specSize = (s: number) => s & 0x3fffffff;
export const makeSpec = (size: number, mode: number) => ((size & 0x3fffffff) | mode) | 0;

export const MATCH_PARENT = -1, WRAP_CONTENT = -2;

// invalidation plumbing — the shell polls these
export const uiState = {
  needsLayout: true,
  needsDraw: true,
  /** the next pass must re-measure everything: a caller dirtied something it could not name */
  forceAll: true,
  settle: 2,
  frameCallbacks: [] as unknown[],
  animHooks: new Set<() => boolean>(), // ts-side animators; return false to remove
  /** the current frame's timestamp. AOSP's Choreographer computes this ONCE in doFrame and
   *  hands the same value to every callback; Compose's BroadcastFrameClock fans one timestamp
   *  to all withFrameNanos awaiters, so animations desync if callbacks see different times. */
  frameTimeNanos: 0n,
};
export function invalidate() { perf.invalidates++; uiState.needsDraw = true; }
setInvalidateHook(invalidate);
/**
 * Schedule a layout pass. Pass the view whose measurement went stale so the pass can skip
 * the clean parts of the tree (AOSP marks the view and walks UP to the root; children are
 * re-measured only when their parent hands them different specs). Callers that cannot name
 * a view fall back to re-measuring everything.
 */
export function requestLayout(v?: JView | null) {
  uiState.needsLayout = true; uiState.needsDraw = true; uiState.settle = 3;
  if (!v) { uiState.forceAll = true; return; }
  for (let p: JView | null = v; p; p = p.parent) {
    if (p.layoutRequested) break;
    p.layoutRequested = true;
    p.oldWSpec = -1;
  }
}

const M_onMeasure = mangleMethod("onMeasure", "(II)V");
const M_performClick = mangleMethod("performClick", "()Z");

/** drop one registration of `l` (Android listener lists are identity sets) */
function removeFrom(ls: unknown[], l: unknown) {
  const i = ls.indexOf(l);
  if (i >= 0) ls.splice(i, 1);
}
async function performClick(this: JView) {
  if (!this.clickL) return 0;
  await vcall(this.clickL, "onClick", "(Landroid/view/View;)V", this);
  return 1;
}
function setBackground(this: JView, d: JDrawable | null) {
  this.background = d;
  invalidate();
}
/** this view's origin in window coordinates */
function windowOffset(view: JView): [number, number] {
  let tx = 0, ty = 0;
  for (let v: JView | null = view; v; v = v.parent) { tx += v.left - v.scrollX + v.translationX; ty += v.top - v.scrollY + v.translationY; }
  return [tx, ty];
}
function removeChild(this: JViewGroup, c: JView) { detachView(this, c); }
function removeAllChildren(this: JViewGroup) { for (const c of [...this.children]) detachView(this, c); }
async function attachInLayout(this: JViewGroup, c: JView, i: number, lp: JLayoutParams) {
  c.lp = lp ? await convertLp(this, lp) : c.lp;
  attachView(this, c, i);
  return 1;
}
function obtainEvent(dt: bigint, et: bigint, action: number, x: number, y: number) {
  const e = new JMotionEvent();
  e.downTime = Number(dt); e.eventTime = Number(et); e.action = action; e.x = x; e.y = y;
  return e;
}
function copyEvent(src: JMotionEvent) {
  const e = new JMotionEvent();
  Object.assign(e, { action: src.action, x: src.x, y: src.y, rawX: src.rawX, rawY: src.rawY, downTime: src.downTime, eventTime: src.eventTime });
  return e;
}
const M_performLongClick = mangleMethod("performLongClick", "()Z");
const M_onLayout = mangleMethod("onLayout", "(ZIIII)V");
const M_onDraw = mangleMethod("onDraw", "(Landroid/graphics/Canvas;)V");
const M_dispatchDraw = mangleMethod("dispatchDraw", "(Landroid/graphics/Canvas;)V");
const M_onSizeChanged = mangleMethod("onSizeChanged", "(IIII)V");
const M_onTouchEvent = mangleMethod("onTouchEvent", "(Landroid/view/MotionEvent;)Z");
const M_onIntercept = mangleMethod("onInterceptTouchEvent", "(Landroid/view/MotionEvent;)Z");
const M_dispatchTouch = mangleMethod("dispatchTouchEvent", "(Landroid/view/MotionEvent;)Z");
const M_onAttached = mangleMethod("onAttachedToWindow", "()V");
const M_onDetached = mangleMethod("onDetachedFromWindow", "()V");
const M_onConfigChanged = mangleMethod("onConfigurationChanged", "(Landroid/content/res/Configuration;)V");
const M_drawableStateChanged = mangleMethod("drawableStateChanged", "()V");

/** absolute position of v's top-left: translations applied, each ancestor's scroll removed */
export function locationOnScreen(v: JView): [number, number] {
  let x = 0, y = 0;
  for (let p: JView | null = v; p; p = p.parent) {
    x += p.left + p.translationX - (p.parent ? p.parent.scrollX : 0);
    y += p.top + p.translationY - (p.parent ? p.parent.scrollY : 0);
  }
  return [x, y];
}
function mergeStates(base: Int32Array, extra: Int32Array | null): Int32Array {
  const out = new Int32Array(base.length + (extra?.length ?? 0));
  out.set(base);
  if (extra) out.set(extra, base.length);
  return out;
}

/** call a (possibly async) compiled method and settle it */
export async function guardCall(fn: unknown, self: unknown, ...args: unknown[]): Promise<any> {
  const r = (fn as (...a: unknown[]) => unknown).apply(self, args);
  return r instanceof Promise ? await r : r;
}

export class JView extends JObj {
  ctx: unknown = null;            // android Context
  jres: Resources | null = null;
  theme: JTheme | null = null;
  parent: JView | null = null;
  attached = false;

  idNum = -1;
  tag: unknown = null;
  keyedTags = new Map<number, unknown>();
  outlineProvider: unknown = null;
  stateListAnimator: unknown = null;
  keyboardCluster = false;
  touchBlocksFocus = false;
  left = 0; top = 0; right = 0; bottom = 0;
  static $nextDrawingId = 0;
  measuredW = 0; measuredH = 0;
  oldWSpec = -1; oldHSpec = -1;
  padL = 0; padT = 0; padR = 0; padB = 0;
  minW = 0; minH = 0;
  lp: JLayoutParams | null = null;
  visibility = 0;                  // 0 visible, 4 invisible, 8 gone
  background: JDrawable | null = null;
  foreground: JDrawable | null = null;
  alphaV = 1;
  scrollX = 0; scrollY = 0;
  translationX = 0; translationY = 0; translationZ = 0;
  scaleXv = 1; scaleYv = 1;
  rotationV = 0;
  pivotXv: number | null = null; pivotYv: number | null = null;
  clickable = false; longClickable = false;
  enabled = true; pressed = false; selected = false; activated = false; focused = false;
  focusable = false; focusableInTouchMode = false;
  clickL: unknown = null; longClickL: unknown = null; touchL: unknown = null; keyL: unknown = null; focusL: unknown = null;
  insetsL: unknown = null; a11yDelegate: unknown = null; dragL: unknown = null;
  layoutChangeLs: unknown[] = [];
  attachLs: unknown[] = [];
  layoutRequested = true;
  /** AOSP PFLAG_LAYOUT_REQUIRED: set when onMeasure ran, cleared when onLayout consumed it */
  layoutRequired = true;
  overScrollMode = 0;
  layerType = 0;
  elevationV = 0;
  longPressTimer: ReturnType<typeof setTimeout> | null = null;
  win: unknown = null; // ViewRootImpl-ish owner

  width(): number { return this.right - this.left; }
  height(): number { return this.bottom - this.top; }

  drawableState(): number[] {
    const st: number[] = [ST.window_focused];
    if (this.enabled) st.push(ST.enabled);
    if (this.pressed) st.push(ST.pressed);
    if (this.selected) st.push(ST.selected);
    if (this.activated) st.push(ST.activated);
    if (this.focused) st.push(ST.focused);
    return st;
  }
  async refreshDrawableState() {
    const st = this.drawableState();
    if (this.background) {
      this.background.stateSet = st;
      this.background.onStateChange();
    }
    const f = (this as any)[M_drawableStateChanged];
    if (f) await guardCall(f, this);
    if (this.stateListAnimator) await vcall(this.stateListAnimator, "setState", "([I)V", Int32Array.from(st));
    invalidate();
  }
}

export class JLayoutParams extends JObj { width = WRAP_CONTENT; height = WRAP_CONTENT; }
export class JMarginLP extends JLayoutParams {
  marginL = 0; marginT = 0; marginR = 0; marginB = 0;
}
export class JFrameLP extends JMarginLP { gravity = -1; }
export class JLinearLP extends JMarginLP { weight = 0; gravity = -1; }

const AT = {
  id: AID("id"), tag: AID("tag"), background: AID("background"),
  padding: AID("padding"), paddingLeft: AID("paddingLeft"), paddingTop: AID("paddingTop"),
  paddingRight: AID("paddingRight"), paddingBottom: AID("paddingBottom"),
  paddingStart: AID("paddingStart"), paddingEnd: AID("paddingEnd"),
  layout_width: AID("layout_width"), layout_height: AID("layout_height"),
  layout_margin: AID("layout_margin"), layout_marginLeft: AID("layout_marginLeft"),
  layout_marginTop: AID("layout_marginTop"), layout_marginRight: AID("layout_marginRight"),
  layout_marginBottom: AID("layout_marginBottom"), layout_marginStart: AID("layout_marginStart"),
  layout_marginEnd: AID("layout_marginEnd"),
  layout_gravity: AID("layout_gravity"), layout_weight: AID("layout_weight"),
  gravity: AID("gravity"), orientation: AID("orientation"),
  visibility: AID("visibility"), clickable: AID("clickable"), enabled: AID("enabled"),
  minWidth: AID("minWidth"), minHeight: AID("minHeight"), alpha: AID("alpha"),
  focusable: AID("focusable"), scaleType: AID("scaleType"), src: AID("src"),
  contentDescription: AID("contentDescription"), weightSum: AID("weightSum"),
  divider: AID("divider"), showDividers: AID("showDividers"), dividerPadding: AID("dividerPadding"),
  fillViewport: AID("fillViewport"), scrollbars: AID("scrollbars"), fadeScrollbars: AID("fadeScrollbars"),
  clipToPadding: AID("clipToPadding"), clipChildren: AID("clipChildren"),
  descendantFocusability: AID("descendantFocusability"), foreground: AID("foreground"),
  duplicateParentState: AID("duplicateParentState"), baselineAligned: AID("baselineAligned"),
};

/** apply base View attrs from an AttributeSet (used by native View ctor) */
async function applyViewAttrs(v: JView, set: JAttrSet | null) {
  if (!set?.node || !v.jres) return;
  const res = v.jres;
  const ta = obtainStyled(res, v.theme, set, [
    AT.id, AT.background, AT.padding, AT.paddingLeft, AT.paddingTop, AT.paddingRight, AT.paddingBottom,
    AT.visibility, AT.clickable, AT.enabled, AT.minWidth, AT.minHeight, AT.alpha, AT.focusable,
    AT.paddingStart, AT.paddingEnd, AT.tag,
  ], 0, 0);
  const g = (i: number) => ta.vals[i];
  if (g(0)) v.idNum = g(0)!.d;
  const bgv = g(1);
  if (bgv) {
    v.background = await loadDrawableRV(res, bgv, v.theme);
  }
  const pad = g(2) ? rvDimen(res, g(2), 0) : null;
  if (pad !== null) { v.padL = v.padT = v.padR = v.padB = Math.round(pad); }
  if (g(3)) v.padL = Math.round(rvDimen(res, g(3), v.padL));
  if (g(4)) v.padT = Math.round(rvDimen(res, g(4), v.padT));
  if (g(5)) v.padR = Math.round(rvDimen(res, g(5), v.padR));
  if (g(6)) v.padB = Math.round(rvDimen(res, g(6), v.padB));
  if (g(14)) v.padL = Math.round(rvDimen(res, g(14), v.padL));
  if (g(15)) v.padR = Math.round(rvDimen(res, g(15), v.padR));
  if (g(7)) v.visibility = rvInt(res, g(7), 0) * 4;
  if (g(8)) v.clickable = !!rvInt(res, g(8), 0);
  if (g(9)) v.enabled = !!rvInt(res, g(9), 1);
  if (g(10)) v.minW = Math.round(rvDimen(res, g(10), 0));
  if (g(11)) v.minH = Math.round(rvDimen(res, g(11), 0));
  if (g(12)) v.alphaV = Math.max(0, Math.min(1, (g(12)!.t === 4 ? g(12)!.d : 1)));
  if (g(16)) v.tag = rvString(res, g(16));
}

export function defaultSize(size: number, spec: number): number {
  const mode = specMode(spec), sz = specSize(spec);
  return mode === MS_UNSPEC ? size : sz;
}
export function resolveSizeAndState(size: number, spec: number): number {
  const mode = specMode(spec), sz = specSize(spec);
  if (mode === MS_EXACTLY) return sz;
  if (mode === MS_AT_MOST) return Math.min(size, sz);
  return size;
}

export async function measureView(v: JView, wSpec: number, hSpec: number) {
  // AOSP View.measure: with no forced layout and identical specs the previous measurement
  // still holds. Without this every pass re-measured the whole tree from the root.
  if (!v.layoutRequested && wSpec === v.oldWSpec && hSpec === v.oldHSpec) return;
  v.oldWSpec = wSpec; v.oldHSpec = hSpec;
  try {
    await guardCall((v as any)[M_onMeasure], v, wSpec, hSpec);
    v.layoutRequired = true;   // AOSP sets PFLAG_LAYOUT_REQUIRED whenever onMeasure runs
  } catch (e) {
    v.oldWSpec = -1;
    throw e;
  }
}

/** setLeft/setTop/setRight/setBottom: assign bounds directly and fire the same
 *  size-changed/layout-changed notifications layoutView fires, without a measure/layout pass. */
function setBound(v: JView, l: number, t: number, r: number, b: number) {
  const oldL = v.left, oldT = v.top, oldR = v.right, oldB = v.bottom;
  if (oldL === l && oldT === t && oldR === r && oldB === b) return;
  const ow = v.width(), oh = v.height();
  v.left = l; v.top = t; v.right = r; v.bottom = b;
  invalidate();
  const f = (v as any)[M_onSizeChanged];
  if (f && (r - l !== ow || b - t !== oh)) void guardCall(f, v, r - l, b - t, ow, oh);
  for (const ll of v.layoutChangeLs) {
    void vcall(ll, "onLayoutChange", "(Landroid/view/View;IIIIIIII)V", v, l, t, r, b, oldL, oldT, oldR, oldB);
  }
}

export async function layoutView(v: JView, l: number, t: number, r: number, b: number) {
  const oldL = v.left, oldT = v.top, oldR = v.right, oldB = v.bottom;
  const changed = oldL !== l || oldT !== t || oldR !== r || oldB !== b;
  const ow = v.width(), oh = v.height();
  v.left = l; v.top = t; v.right = r; v.bottom = b;
  if (changed) {
    const f = (v as any)[M_onSizeChanged];
    if (f) await guardCall(f, v, r - l, b - t, ow, oh);
  }
  // AOSP View.layout: onLayout runs only when the frame moved or a measure re-ran
  // (PFLAG_LAYOUT_REQUIRED). Without the gate every pass walked the whole tree laying out
  // children the measure memo had just skipped, which is what made settle passes cost.
  if (changed || v.layoutRequired) {
    await guardCall((v as any)[M_onLayout], v, changed ? 1 : 0, l, t, r, b);
    v.layoutRequired = false;
  }
  v.layoutRequested = false;
  // AOSP only notifies OnLayoutChangeListener when the bounds actually moved
  if (changed) {
    for (const ll of v.layoutChangeLs) {
      await vcall(ll, "onLayoutChange", "(Landroid/view/View;IIIIIIII)V", v, l, t, r, b, oldL, oldT, oldR, oldB);
    }
  }
}

/** full draw of the subtree onto ctx (already positioned at parent's content origin) */
const M_computeScroll = mangleMethod("computeScroll", "()V");
const M_drawableDraw = mangleMethod("draw", "(Landroid/graphics/Canvas;)V");
const noopComputeScroll = () => {};
export async function drawView(v: JView, cv: JCanvas) {
  if (v.visibility !== 0) return;
  // Android calls computeScroll() before drawing each child — drives Scroller
  // animations (ViewPager page snaps, OverScroller flings)
  const cs = (v as any)[M_computeScroll];
  if (cs && cs !== noopComputeScroll) await guardCall(cs, v);
  const ctx = cv.ctx;
  // AOSP View.draw() brackets the whole thing with getSaveCount()/restoreToCount(): a view
  // that throws between save() and restore() must not leave its clip on the shared context,
  // or every later frame inherits a dead frame's clip and the screen stays blank.
  const sc = cv.saveCount;
  ctx.save();
  try {
    ctx.translate(v.left + v.translationX, v.top + v.translationY);
    if (v.alphaV < 1) ctx.globalAlpha *= v.alphaV;
    if (v.rotationV || v.scaleXv !== 1 || v.scaleYv !== 1) {
      const px = v.pivotXv ?? v.width() / 2, py = v.pivotYv ?? v.height() / 2;
      ctx.translate(px, py);
      if (v.rotationV) ctx.rotate(v.rotationV * Math.PI / 180);
      ctx.scale(v.scaleXv, v.scaleYv);
      ctx.translate(-px, -py);
    }
    ctx.beginPath();
    ctx.rect(0, 0, v.width(), v.height());
    ctx.clip();
    if (v.background) {
      v.background.bounds.left = 0; v.background.bounds.top = 0;
      v.background.bounds.right = v.width(); v.background.bounds.bottom = v.height();
      await guardCall((v.background as any)[M_drawableDraw], v.background, cv);
    }
    ctx.translate(-v.scrollX, -v.scrollY);
    const od = (v as any)[M_onDraw];
    if (od) await guardCall(od, v, cv);
    const dd = (v as any)[M_dispatchDraw];
    if (dd) await guardCall(dd, v, cv);
  } catch (e) {
    perf.drawErrors++;
    noteDrawError(v, e);
  } finally {
    while (cv.saveCount > sc) { ctx.restore(); cv.saveCount--; }
    ctx.restore();
  }
}

/** One log line per offending view class: a broken subtree must not log 60x a second. */
const drawErrSeen = new Set<string>();
function noteDrawError(v: JView, e: unknown) {
  const k = (v as any).constructor?.$i?.name ?? "?";
  if (drawErrSeen.has(k)) return;
  drawErrSeen.add(k);
  console.error("[draw]", k, e);
}

const viewMethods: NativeSpec["methods"] = {
  "<init>(Landroid/content/Context;)V": async function (this: JView, c: unknown) { await initViewFromCtx(this, c, null); },
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: JView, c: unknown, a: JAttrSet | null) {
    await initViewFromCtx(this, c, a);
  },
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": async function (this: JView, c: unknown, a: JAttrSet | null) {
    await initViewFromCtx(this, c, a);
  },
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;II)V": async function (this: JView, c: unknown, a: JAttrSet | null) {
    await initViewFromCtx(this, c, a);
  },
  "getContext()Landroid/content/Context;": function (this: JView) { return this.ctx; },
  "getResources()Landroid/content/res/Resources;": function (this: JView) { return this.jres?.jobj ?? null; },
  "getId()I": function (this: JView) { return this.idNum; },
  "setId(I)V": function (this: JView, i: number) { this.idNum = i; },
  "getTag()Ljava/lang/Object;": function (this: JView) { return this.tag; },
  "setTag(Ljava/lang/Object;)V": function (this: JView, t: unknown) { this.tag = t; },
  "getTag(I)Ljava/lang/Object;": function (this: JView, k: number) { return this.keyedTags.get(k) ?? null; },
  "setTag(ILjava/lang/Object;)V": function (this: JView, k: number, t: unknown) { this.keyedTags.set(k, t); },
  // API 29 layout-inspector bookkeeping: only Studio's attribute inspector ever reads it back
  "saveAttributeDataForStyleable(Landroid/content/Context;[ILandroid/util/AttributeSet;Landroid/content/res/TypedArray;II)V": () => {},
  "getParent()Landroid/view/ViewParent;": function (this: JView) { return this.parent; },
  "getWidth()I": function (this: JView) { return this.width(); },
  "getHeight()I": function (this: JView) { return this.height(); },
  "getLeft()I": function (this: JView) { return this.left; },
  "getTop()I": function (this: JView) { return this.top; },
  "getRight()I": function (this: JView) { return this.right; },
  "getBottom()I": function (this: JView) { return this.bottom; },
  "getMeasuredWidth()I": function (this: JView) { return this.measuredW; },
  "getMeasuredHeight()I": function (this: JView) { return this.measuredH; },
  "getMeasuredWidthAndState()I": function (this: JView) { return this.measuredW; },
  "getMeasuredHeightAndState()I": function (this: JView) { return this.measuredH; },
  "getPaddingLeft()I": function (this: JView) { return this.padL; },
  "getPaddingTop()I": function (this: JView) { return this.padT; },
  "getPaddingRight()I": function (this: JView) { return this.padR; },
  "getPaddingBottom()I": function (this: JView) { return this.padB; },
  "getPaddingStart()I": function (this: JView) { return this.padL; },
  "getPaddingEnd()I": function (this: JView) { return this.padR; },
  "setPadding(IIII)V": function (this: JView, l: number, t: number, r: number, b: number) {
    this.padL = l; this.padT = t; this.padR = r; this.padB = b;
    requestLayout(this);
  },
  "setPaddingRelative(IIII)V": function (this: JView, l: number, t: number, r: number, b: number) {
    this.padL = l; this.padT = t; this.padR = r; this.padB = b;
    requestLayout(this);
  },
  "setMinimumWidth(I)V": function (this: JView, v: number) { this.minW = v; },
  "setMinimumHeight(I)V": function (this: JView, v: number) { this.minH = v; },
  "getMinimumWidth()I": function (this: JView) { return this.minW; },
  "getMinimumHeight()I": function (this: JView) { return this.minH; },
  "getLayoutParams()Landroid/view/ViewGroup$LayoutParams;": function (this: JView) { return this.lp; },
  "setLayoutParams(Landroid/view/ViewGroup$LayoutParams;)V": function (this: JView, lp: JLayoutParams) {
    this.lp = lp;
    requestLayout(this);
  },
  "getVisibility()I": function (this: JView) { return this.visibility; },
  "setVisibility(I)V": function (this: JView, v: number) {
    if (this.visibility !== v) { this.visibility = v; requestLayout(this); }
  },
  "isShown()Z": function (this: JView) {
    let v: JView | null = this;
    while (v) { if (v.visibility !== 0) return 0; v = v.parent; }
    return 1;
  },
  "setBackground(Landroid/graphics/drawable/Drawable;)V": setBackground,
  "setBackgroundDrawable(Landroid/graphics/drawable/Drawable;)V": setBackground,
  "setBackgroundColor(I)V": function (this: JView, c: number) {
    const d = new JColorDrawable();
    d.color = c;
    setBackground.call(this, d);
  },
  "setBackgroundResource(I)V": async function (this: JView, id: number) {
    setBackground.call(this, id ? await loadDrawable(this.jres!, id, this.theme) : null);
  },
  "getBackground()Landroid/graphics/drawable/Drawable;": function (this: JView) { return this.background; },
  "setForeground(Landroid/graphics/drawable/Drawable;)V": function (this: JView, d: JDrawable | null) { this.foreground = d; },
  "getAlpha()F": function (this: JView) { return this.alphaV; },
  "setAlpha(F)V": function (this: JView, a: number) { this.alphaV = a; invalidate(); },
  "setTranslationX(F)V": function (this: JView, x: number) { this.translationX = x; invalidate(); },
  "setTranslationY(F)V": function (this: JView, y: number) { this.translationY = y; invalidate(); },
  "setTranslationZ(F)V": function (this: JView, z: number) { this.translationZ = z; },
  "getTranslationX()F": function (this: JView) { return this.translationX; },
  "getTranslationY()F": function (this: JView) { return this.translationY; },
  "setScaleX(F)V": function (this: JView, s: number) { this.scaleXv = s; invalidate(); },
  "setScaleY(F)V": function (this: JView, s: number) { this.scaleYv = s; invalidate(); },
  "getScaleX()F": function (this: JView) { return this.scaleXv; },
  "getScaleY()F": function (this: JView) { return this.scaleYv; },
  "setRotation(F)V": function (this: JView, r: number) { this.rotationV = r; invalidate(); },
  "getRotation()F": function (this: JView) { return this.rotationV; },
  "setPivotX(F)V": function (this: JView, p: number) { this.pivotXv = p; },
  "setPivotY(F)V": function (this: JView, p: number) { this.pivotYv = p; },
  "setElevation(F)V": function (this: JView, e: number) { this.elevationV = e; },
  "getElevation()F": function (this: JView) { return this.elevationV; },
  "setScrollX(I)V": function (this: JView, x: number) {
    const old = this.scrollX;
    this.scrollX = x; invalidate();
    if (old !== x) fireScrollChanged(this);
  },
  "setScrollY(I)V": function (this: JView, y: number) {
    const old = this.scrollY;
    this.scrollY = y; invalidate();
    if (old !== y) fireScrollChanged(this);
  },
  "getScrollX()I": function (this: JView) { return this.scrollX; },
  "getScrollY()I": function (this: JView) { return this.scrollY; },
  "scrollTo(II)V": function (this: JView, x: number, y: number) {
    const ox = this.scrollX, oy = this.scrollY;
    this.scrollX = x; this.scrollY = y; invalidate();
    if (ox !== x || oy !== y) fireScrollChanged(this);
  },
  "scrollBy(II)V": function (this: JView, x: number, y: number) {
    this.scrollX += x; this.scrollY += y; invalidate();
    if (x || y) fireScrollChanged(this);
  },
  "isEnabled()Z": function (this: JView) { return this.enabled ? 1 : 0; },
  "setEnabled(Z)V": function (this: JView, e: number) {
    this.enabled = !!e;
    void this.refreshDrawableState();
  },
  "isClickable()Z": function (this: JView) { return this.clickable ? 1 : 0; },
  "setClickable(Z)V": function (this: JView, c: number) { this.clickable = !!c; },
  "setLongClickable(Z)V": function (this: JView, c: number) { this.longClickable = !!c; },
  "isPressed()Z": function (this: JView) { return this.pressed ? 1 : 0; },
  "setPressed(Z)V": function (this: JView, p: number) { this.pressed = !!p; void this.refreshDrawableState(); },
  "isSelected()Z": function (this: JView) { return this.selected ? 1 : 0; },
  "setSelected(Z)V": function (this: JView, s: number) { this.selected = !!s; void this.refreshDrawableState(); },
  "isActivated()Z": function (this: JView) { return this.activated ? 1 : 0; },
  "setActivated(Z)V": function (this: JView, a: number) { this.activated = !!a; void this.refreshDrawableState(); },
  "isFocused()Z": function (this: JView) { return this.focused ? 1 : 0; },
  "hasFocus()Z": function (this: JView) { return this.focused ? 1 : 0; },
  "setFocusable(Z)V": function (this: JView, f: number) { this.focusable = !!f; },
  "setFocusableInTouchMode(Z)V": function (this: JView, f: number) { this.focusableInTouchMode = !!f; },
  "requestFocus()Z": function (this: JView) { this.focused = true; return 1; },
  "findFocus()Landroid/view/View;": function (this: JView) { return this.focused ? this : null; },
  "clearFocus()V": function (this: JView) { this.focused = false; },
  "isInTouchMode()Z": () => 1,
  "setOnClickListener(Landroid/view/View$OnClickListener;)V": function (this: JView, l: unknown) {
    this.clickL = l;
    if (l) this.clickable = true;
  },
  "setOnLongClickListener(Landroid/view/View$OnLongClickListener;)V": function (this: JView, l: unknown) {
    this.longClickL = l;
    if (l) this.longClickable = true;
  },
  "setOnTouchListener(Landroid/view/View$OnTouchListener;)V": function (this: JView, l: unknown) { this.touchL = l; },
  "setOnKeyListener(Landroid/view/View$OnKeyListener;)V": function (this: JView, l: unknown) { this.keyL = l; },
  "setOnFocusChangeListener(Landroid/view/View$OnFocusChangeListener;)V": function (this: JView, l: unknown) { this.focusL = l; },
  "getOnFocusChangeListener()Landroid/view/View$OnFocusChangeListener;": function (this: JView) { return this.focusL; },
  "addOnLayoutChangeListener(Landroid/view/View$OnLayoutChangeListener;)V": function (this: JView, l: unknown) {
    this.layoutChangeLs.push(l);
  },
  "removeOnLayoutChangeListener(Landroid/view/View$OnLayoutChangeListener;)V": function (this: JView, l: unknown) {
    removeFrom(this.layoutChangeLs, l);
  },
  "addOnAttachStateChangeListener(Landroid/view/View$OnAttachStateChangeListener;)V": function (this: JView, l: unknown) {
    this.attachLs.push(l);
  },
  "removeOnAttachStateChangeListener(Landroid/view/View$OnAttachStateChangeListener;)V": function (this: JView, l: unknown) {
    removeFrom(this.attachLs, l);
  },
  "performClick()Z": performClick,
  "callOnClick()Z": performClick,
  "performLongClick()Z": async function (this: JView) {
    if (this.longClickL) return await vcall(this.longClickL, "onLongClick", "(Landroid/view/View;)Z", this);
    return 0;
  },
  "performHapticFeedback(I)Z": () => 1,
  "playSoundEffect(I)V": () => {},
  "measure(II)V": function (this: JView, w: number, h: number) { return measureView(this, w, h); },
  "onMeasure(II)V": function (this: JView, wSpec: number, hSpec: number) {
    const bw = Math.max(this.minW, this.background?.intrinsicW() ?? 0);
    const bh = Math.max(this.minH, this.background?.intrinsicH() ?? 0);
    const cw = Math.max(bw, this.padL + this.padR);
    const ch = Math.max(bh, this.padT + this.padB);
    // Android's getDefaultSize makes a wrap_content plain View fill AT_MOST — a well-known quirk
    // that real layouts avoid. For an exact plain android.view.View (a divider/spacer, no custom
    // onDraw content), respect the wrap_content LP so it collapses instead of filling. Custom
    // View subclasses keep Android semantics (they may render content sized by getDefaultSize).
    const plain = (this.constructor as any)?.$i?.name === "android/view/View";
    this.measuredW = plain && this.lp && this.lp.width === WRAP_CONTENT ? resolveSizeAndState(cw, wSpec) : defaultSize(cw, wSpec);
    this.measuredH = plain && this.lp && this.lp.height === WRAP_CONTENT ? resolveSizeAndState(ch, hSpec) : defaultSize(ch, hSpec);
  },
  "setMeasuredDimension(II)V": function (this: JView, w: number, h: number) {
    this.measuredW = w & 0xffffff; this.measuredH = h & 0xffffff;
  },
  "layout(IIII)V": function (this: JView, l: number, t: number, r: number, b: number) {
    return layoutView(this, l, t, r, b);
  },
  "onLayout(ZIIII)V": function () {},
  "onSizeChanged(IIII)V": function () {},
  "onDraw(Landroid/graphics/Canvas;)V": function () {},
  "dispatchDraw(Landroid/graphics/Canvas;)V": function () {},
  "draw(Landroid/graphics/Canvas;)V": function (this: JView, cv: JCanvas) {
    // explicit draw of the subtree at current canvas origin (used by app code occasionally)
    const saveL = this.left, saveT = this.top;
    this.left = 0; this.top = 0;
    const p = drawView(this, cv);
    this.left = saveL; this.top = saveT;
    return p;
  },
  "invalidate()V": function () { invalidate(); },
  "invalidate(IIII)V": function () { invalidate(); },
  "invalidate(Landroid/graphics/Rect;)V": function () { invalidate(); },
  "postInvalidate()V": function () { invalidate(); },
  "postInvalidateOnAnimation()V": function () { invalidate(); },
  // The region is only a hint in AOSP and there is no dirty-region tracking here.
  "postInvalidate(IIII)V": function () { invalidate(); },
  "postInvalidateOnAnimation(IIII)V": function () { invalidate(); },
  "postInvalidateDelayed(J)V": function (ms: bigint) { setTimeout(invalidate, Number(ms)); },
  "postInvalidateDelayed(JIIII)V": function (ms: bigint) { setTimeout(invalidate, Number(ms)); },
  "invalidateDrawable(Landroid/graphics/drawable/Drawable;)V": function () { invalidate(); },
  // AOSP posts these on the attached window's handler, i.e. the main looper. Going straight
  // to setTimeout skipped the main-looper queue, so a posted Runnable could interleave with a
  // layout or a Handler dispatch at every await -- the check-then-act race class that gave us
  // the double composition. It also means removeCallbacks can actually cancel.
  "scheduleDrawable(Landroid/graphics/drawable/Drawable;Ljava/lang/Runnable;J)V": function (r0: unknown, r: unknown, when: bigint) {
    mainHandler().postRun(r, Math.max(0, Number(when) - performance.now()));
  },
  "unscheduleDrawable(Landroid/graphics/drawable/Drawable;Ljava/lang/Runnable;)V": function (_d: unknown, r: unknown) { mainHandler().cancelRun(r); },
  // AOSP's 1-arg form cancels everything scheduled by that drawable. Compose's
  // AndroidComposeView calls it; without the overload the whole draw pass threw.
  "unscheduleDrawable(Landroid/graphics/drawable/Drawable;)V": () => {},
  // AOSP marks this view and walks UP to the root, stopping at the first ancestor already
  // requesting. Calling the helper with no view took the "caller could not name a view"
  // branch instead, forcing a full-tree re-measure -- on every androidx/Compose relayout,
  // which is the one path that reaches here. Do NOT pre-set layoutRequested: the helper's
  // walk breaks at the first marked node, so marking `this` first would skip the ancestors.
  "requestLayout()V": function (this: JView) { requestLayout(this); },
  "forceLayout()V": function (this: JView) { this.layoutRequested = true; },
  "isLayoutRequested()Z": function (this: JView) { return this.layoutRequested ? 1 : 0; },
  "post(Ljava/lang/Runnable;)Z": function (r: unknown) { return mainHandler().postRun(r, 0); },
  "postDelayed(Ljava/lang/Runnable;J)Z": function (r: unknown, d: bigint) { return mainHandler().postRun(r, Number(d)); },
  "removeCallbacks(Ljava/lang/Runnable;)Z": function (r: unknown) { mainHandler().cancelRun(r); return 1; },
  "postOnAnimation(Ljava/lang/Runnable;)V": function (this: JView, r: unknown) {
    uiState.frameCallbacks.push({ run: r });
  },
  "getDrawableState()[I": function (this: JView) { return Int32Array.from(this.drawableState()); },
  "refreshDrawableState()V": function (this: JView) { return this.refreshDrawableState(); },
  "drawableStateChanged()V": function () {},
  "jumpDrawablesToCurrentState()V": function () {},
  "onAttachedToWindow()V": function () {},
  "onDetachedFromWindow()V": function () {},
  "onConfigurationChanged(Landroid/content/res/Configuration;)V": function () {},
  "dispatchConfigurationChanged(Landroid/content/res/Configuration;)V": function (this: JView, cfg: unknown) {
    return dispatchConfigurationChanged(this, cfg);
  },
  "onFinishInflate()V": function () {},
  "isAttachedToWindow()Z": function (this: JView) { return this.attached ? 1 : 0; },
  "getWindowToken()Landroid/os/IBinder;": function (this: JView) { return this.attached ? this : null; },
  "getApplicationWindowToken()Landroid/os/IBinder;": function (this: JView) { return this; },
  "getWindowVisibility()I": function (this: JView) { return 0; },
  "getRootView()Landroid/view/View;": function (this: JView) {
    let v: JView = this;
    while (v.parent) v = v.parent;
    return v;
  },
  "getLocationOnScreen([I)V": function (this: JView, out: Int32Array) { [out[0], out[1]] = locationOnScreen(this); },
  "getLocationInWindow([I)V": function (this: JView, out: Int32Array) { [out[0], out[1]] = locationOnScreen(this); },
  "getHitRect(Landroid/graphics/Rect;)V": function (this: JView, r: JRect) {
    r.left = this.left; r.top = this.top; r.right = this.right; r.bottom = this.bottom;
  },
  "getGlobalVisibleRect(Landroid/graphics/Rect;)Z": function (this: JView, r: JRect) {
    const [x, y] = locationOnScreen(this);
    r.left = x; r.top = y; r.right = x + this.width(); r.bottom = y + this.height();
    return 1;
  },
  "getLocalVisibleRect(Landroid/graphics/Rect;)Z": function (this: JView, r: JRect) {
    r.left = 0; r.top = 0; r.right = this.width(); r.bottom = this.height();
    return 1;
  },
  "findViewById(I)Landroid/view/View;": function (this: JView, id: number) { return findById(this, id); },
  "findViewWithTag(Ljava/lang/Object;)Landroid/view/View;": function (this: JView, tag: unknown) {
    return findByPred(this, (v) => v.tag === tag);
  },
  "setOnCreateContextMenuListener(Landroid/view/View$OnCreateContextMenuListener;)V": () => {},
  "setSaveEnabled(Z)V": () => {},
  "setSaveFromParentEnabled(Z)V": () => {},
  "setWillNotDraw(Z)V": () => {},
  "setLayerType(ILandroid/graphics/Paint;)V": function (this: JView, t: number) { this.layerType = t; },
  "getLayerType()I": function (this: JView) { return this.layerType; },
  "setHapticFeedbackEnabled(Z)V": () => {},
  "setSoundEffectsEnabled(Z)V": () => {},
  "setContentDescription(Ljava/lang/CharSequence;)V": () => {},
  "getContentDescription()Ljava/lang/CharSequence;": () => null,
  "setImportantForAccessibility(I)V": () => {},
  "getImportantForAccessibility()I": () => 0,
  "setAccessibilityDelegate(Landroid/view/View$AccessibilityDelegate;)V": function (this: JView, d: unknown) { this.a11yDelegate = d; },
  "getAccessibilityDelegate()Landroid/view/View$AccessibilityDelegate;": function (this: JView) { return this.a11yDelegate; },
  "setAccessibilityLiveRegion(I)V": () => {},
  "onInitializeAccessibilityNodeInfo(Landroid/view/accessibility/AccessibilityNodeInfo;)V": () => {},
  "onInitializeAccessibilityEvent(Landroid/view/accessibility/AccessibilityEvent;)V": () => {},
  "setLabelFor(I)V": () => {},
  "setStateListAnimator(Landroid/animation/StateListAnimator;)V": async function (this: JView, sla: unknown) {
    this.stateListAnimator = sla;
    if (sla) await vcall(sla, "setTarget", "(Landroid/view/View;)V", this);
  },
  "getStateListAnimator()Landroid/animation/StateListAnimator;": function (this: JView) { return this.stateListAnimator; },
  "setKeyboardNavigationCluster(Z)V": function (this: JView, v: number) { this.keyboardCluster = !!v; },
  "setTouchscreenBlocksFocus(Z)V": function (this: JView, v: number) { this.touchBlocksFocus = !!v; },
  "getTouchscreenBlocksFocus()Z": function (this: JView) { return this.touchBlocksFocus ? 1 : 0; },
  "destroyDrawingCache()V": () => {},
  "buildDrawingCache()V": () => {},
  "isKeyboardNavigationCluster()Z": function (this: JView) { return this.keyboardCluster ? 1 : 0; },
  "setOutlineProvider(Landroid/view/ViewOutlineProvider;)V": function (this: JView, p: unknown) { this.outlineProvider = p; },
  "getOutlineProvider()Landroid/view/ViewOutlineProvider;": function (this: JView) { return this.outlineProvider ?? bgOutline; },
  "setClipToOutline(Z)V": () => {},
  "setTransitionName(Ljava/lang/String;)V": () => {},
  "setPointerIcon(Landroid/view/PointerIcon;)V": () => {},
  "setForegroundGravity(I)V": () => {},
  "sendAccessibilityEvent(I)V": () => {},
  "announceForAccessibility(Ljava/lang/CharSequence;)V": () => {},
  "setSystemUiVisibility(I)V": () => {},
  "getSystemUiVisibility()I": () => 0,
  "setFitsSystemWindows(Z)V": () => {},
  "requestApplyInsets()V": () => {},
  "setOnApplyWindowInsetsListener(Landroid/view/View$OnApplyWindowInsetsListener;)V": function (this: JView, l: unknown) { this.insetsL = l; },
  "setOverScrollMode(I)V": function (this: JView, m: number) { this.overScrollMode = m; },
  "getOverScrollMode()I": function (this: JView) { return this.overScrollMode; },
  "setVerticalScrollBarEnabled(Z)V": () => {},
  "setHorizontalScrollBarEnabled(Z)V": () => {},
  "setScrollBarStyle(I)V": () => {},
  "setScrollContainer(Z)V": () => {},
  "isHardwareAccelerated()Z": () => 1,
  "getViewTreeObserver()Landroid/view/ViewTreeObserver;": function (this: JView) { return getVTO(this); },
  "onTouchEvent(Landroid/view/MotionEvent;)Z": async function (this: JView, ev: JMotionEvent) {
    if (!this.clickable && !this.longClickable) return 0;
    if (!this.enabled) return 1;
    switch (ev.action & 0xff) {
      case 0: // DOWN
        this.pressed = true;
        void this.refreshDrawableState();
        if (this.longClickable) {
          this.longPressTimer = setTimeout(async () => {
            this.longPressTimer = null;
            await guardCall((this as any)[M_performLongClick], this);
          }, 450);
        }
        return 1;
      case 2: { // MOVE
        if (ev.x < -20 || ev.y < -20 || ev.x > this.width() + 20 || ev.y > this.height() + 20) {
          this.pressed = false;
          void this.refreshDrawableState();
        }
        return 1;
      }
      case 1: { // UP
        if (this.longPressTimer) { clearTimeout(this.longPressTimer); this.longPressTimer = null; }
        const wasPressed = this.pressed;
        this.pressed = false;
        void this.refreshDrawableState();
        if (wasPressed && this.clickable) {
          await guardCall((this as any)[M_performClick], this);
        }
        return 1;
      }
      case 3: // CANCEL
        if (this.longPressTimer) { clearTimeout(this.longPressTimer); this.longPressTimer = null; }
        this.pressed = false;
        void this.refreshDrawableState();
        return 1;
    }
    return 0;
  },
  "dispatchTouchEvent(Landroid/view/MotionEvent;)Z": async function (this: JView, ev: JMotionEvent) {
    if (this.touchL) {
      const r = await vcall(this.touchL, "onTouch", "(Landroid/view/View;Landroid/view/MotionEvent;)Z", this, ev);
      if (r) return 1;
    }
    return await guardCall((this as any)[M_onTouchEvent], this, ev);
  },
  "onInterceptTouchEvent(Landroid/view/MotionEvent;)Z": () => 0,
  "requestDisallowInterceptTouchEvent(Z)V": function (this: JView, dis: number) {
    let v: JView | null = this.parent;
    while (v) { (v as any).disallowIntercept = !!dis; v = v.parent; }
  },
  "cancelLongPress()V": function (this: JView) {
    if (this.longPressTimer) { clearTimeout(this.longPressTimer); this.longPressTimer = null; }
  },
  "willNotDraw()Z": () => 0,
  "canScrollVertically(I)Z": () => 0,
  "canScrollHorizontally(I)Z": () => 0,
  "computeScroll()V": noopComputeScroll,
  "setImportantForAutofill(I)V": () => {},
  "setFocusable(I)V": function (this: JView, v: number) { this.focusable = v === 1; },
  "setDefaultFocusHighlightEnabled(Z)V": () => {},
  // No drag gesture is ever dispatched (no drag-and-drop pipeline exists), so this only stores
  // the listener for parity with the other setOn*Listener setters -- nothing ever calls it.
  "setOnDragListener(Landroid/view/View$OnDragListener;)V": function (this: JView, l: unknown) { this.dragL = l; },
  "setForceDarkAllowed(Z)V": () => {},
  "setWindowInsetsAnimationCallback(Landroid/view/WindowInsetsAnimation$Callback;)V": () => {},
  "isShowingLayoutBounds()Z": () => 0,
  "hasWindowFocus()Z": () => 1,
  "setViewTranslationCallback(Landroid/view/translation/ViewTranslationCallback;)V": () => {},
  // Compose pairs this with the setter above and calls it on detach — which only happens once
  // something actually destroys a view hierarchy.
  "clearViewTranslationCallback()V": () => {},
  "setImportantForContentCapture(I)V": () => {},
  "getContentCaptureSession()Landroid/view/contentcapture/ContentCaptureSession;": () => null,
  "getUniqueDrawingId()J": function (this: JView) { return BigInt((this as unknown as { $udid?: number }).$udid ??= ++JView.$nextDrawingId); },
  "transformMatrixToGlobal(Landroid/graphics/Matrix;)V": function (this: JView, m: unknown) {
    const [tx, ty] = windowOffset(this);
    void vcall(m, "postTranslate", "(FF)Z", tx, ty);
  },
  "transformMatrixToLocal(Landroid/graphics/Matrix;)V": function (this: JView, m: unknown) {
    const [tx, ty] = windowOffset(this);
    void vcall(m, "postTranslate", "(FF)Z", -tx, -ty);
  },
  "setFocusedByDefault(Z)V": () => {},
  "getImportantForAutofill()I": () => 0,
  "getAutofillId()Landroid/view/autofill/AutofillId;": () => new (rt.link("android/view/autofill/AutofillId").ctor)(),
  "getBaseline()I": () => -1,
  "hasOnClickListeners()Z": function (this: JView) { return this.clickL ? 1 : 0; },
  "setKeepScreenOn(Z)V": () => {},
  "getKeepScreenOn()Z": () => 0,
  "requestRectangleOnScreen(Landroid/graphics/Rect;)Z": () => 0,
  "getMatrix()Landroid/graphics/Matrix;": async function () {
    return new JMatrix();
  },
  "hashCode()I": function (this: JView) { return idHash(this); },
  "getY()F": function (this: JView) { return this.top + this.translationY; },
  "getX()F": function (this: JView) { return this.left + this.translationX; },
  "setY(F)V": function (this: JView, y: number) { this.translationY = y - this.top; invalidate(); },
  "setX(F)V": function (this: JView, x: number) { this.translationX = x - this.left; invalidate(); },
  "getSuggestedMinimumWidth()I": function (this: JView) { return Math.max(this.minW, this.background?.intrinsicW() ?? 0); },
  "getSuggestedMinimumHeight()I": function (this: JView) { return Math.max(this.minH, this.background?.intrinsicH() ?? 0); },
  "isFocusable()Z": function (this: JView) { return this.focusable ? 1 : 0; },
  "isFocusableInTouchMode()Z": function (this: JView) { return this.focusableInTouchMode ? 1 : 0; },
  "requestFocus(I)Z": function (this: JView) { this.focused = true; return 1; },
  "requestFocus(ILandroid/graphics/Rect;)Z": function (this: JView) { this.focused = true; return 1; },
  "offsetLeftAndRight(I)V": function (this: JView, d: number) { this.left += d; this.right += d; invalidate(); },
  "offsetTopAndBottom(I)V": function (this: JView, d: number) { this.top += d; this.bottom += d; invalidate(); },
  // AOSP's setLeft/setTop/setRight/setBottom: direct bounds mutation outside a layout pass
  // (Compose's placement phase positions children this way). Same size/layout-change
  // notifications layoutView fires, since AOSP's setFrame() backs both paths.
  "setLeft(I)V": function (this: JView, v: number) { setBound(this, v, this.top, this.right, this.bottom); },
  "setTop(I)V": function (this: JView, v: number) { setBound(this, this.left, v, this.right, this.bottom); },
  "setRight(I)V": function (this: JView, v: number) { setBound(this, this.left, this.top, v, this.bottom); },
  "setBottom(I)V": function (this: JView, v: number) { setBound(this, this.left, this.top, this.right, v); },
  "onKeyDown(ILandroid/view/KeyEvent;)Z": () => 0,
  "onKeyUp(ILandroid/view/KeyEvent;)Z": () => 0,
  // AOSP View.dispatchKeyEvent: the OnKeyListener sees the event first, then KeyEvent.dispatch
  // routes it to onKeyDown/onKeyUp by action.
  "dispatchKeyEvent(Landroid/view/KeyEvent;)Z": async function (this: JView, ev: unknown) {
    const code = await vcall(ev, "getKeyCode", "()I"), action = await vcall(ev, "getAction", "()I");
    if (this.keyL && this.enabled && (await vcall(this.keyL, "onKey", "(Landroid/view/View;ILandroid/view/KeyEvent;)Z", this, code, ev))) return 1;
    return action === 0 ? vcall(this, "onKeyDown", "(ILandroid/view/KeyEvent;)Z", code, ev)
      : action === 1 ? vcall(this, "onKeyUp", "(ILandroid/view/KeyEvent;)Z", code, ev) : 0;
  },
  "dispatchGenericMotionEvent(Landroid/view/MotionEvent;)Z": () => 0,
  "onSaveInstanceState()Landroid/os/Parcelable;": () => null,
  "onRestoreInstanceState(Landroid/os/Parcelable;)V": () => {},
  "saveHierarchyState(Landroid/util/SparseArray;)V": () => {},
  "restoreHierarchyState(Landroid/util/SparseArray;)V": () => {},
  "setDrawingCacheEnabled(Z)V": () => {},
  "getDrawingCache()Landroid/graphics/Bitmap;": () => null,
  "getDrawingTime()J": () => BigInt(Math.floor(performance.now())),
  "verifyDrawable(Landroid/graphics/drawable/Drawable;)Z": function (this: JView, d: unknown) { return d === this.background ? 1 : 0; },
  "onCreateDrawableState(I)[I": function (this: JView) { return Int32Array.from(this.drawableState()); },
  "static mergeDrawableStates([I[I)[I": mergeStates,
  "mergeDrawableStates([I[I)[I": mergeStates,
  "addFocusables(Ljava/util/ArrayList;II)V": () => {},
  "addTouchables(Ljava/util/ArrayList;)V": () => {},
  "cancelPendingInputEvents()V": () => {},
  "getFitsSystemWindows()Z": () => 0,
  // Stays null: androidx's WindowInsetsCompat wrapping path for a real (non-null) instance
  // reaches WindowInsets.Builder (unimplemented) and other API-30 methods this fixed-viewport
  // WindowInsets doesn't have, which turns into an uncaught exception inside Compose's
  // recomposer and kills all further recomposition (see "Mihon recomposes" in NOTES.md for
  // the same failure shape). The Insets/getInsets/getSystemWindowInsets wiring below still
  // answers correctly for any WindowInsets instance obtained through a path that already works.
  "getRootWindowInsets()Landroid/view/WindowInsets;": () => null,
  "onApplyWindowInsets(Landroid/view/WindowInsets;)Landroid/view/WindowInsets;": (i: unknown) => i,
  "dispatchApplyWindowInsets(Landroid/view/WindowInsets;)Landroid/view/WindowInsets;": async function (this: JView, ins: unknown) {
    if (this.insetsL) {
      return await vcall(this.insetsL, "onApplyWindowInsets",
        "(Landroid/view/View;Landroid/view/WindowInsets;)Landroid/view/WindowInsets;", this, ins);
    }
    return await vcall(this, "onApplyWindowInsets", "(Landroid/view/WindowInsets;)Landroid/view/WindowInsets;", ins);
  },
  "getTransitionName()Ljava/lang/String;": () => null,
  "postOnAnimationDelayed(Ljava/lang/Runnable;J)V": function (this: JView, r: unknown, d: bigint) {
    setTimeout(() => uiState.frameCallbacks.push({ run: r }), Number(d));
  },
  "setTouchDelegate(Landroid/view/TouchDelegate;)V": () => {},
  "createAccessibilityNodeInfo()Landroid/view/accessibility/AccessibilityNodeInfo;": () => null,
  "getAccessibilityNodeProvider()Landroid/view/accessibility/AccessibilityNodeProvider;": () => null,
  "dispatchPopulateAccessibilityEvent(Landroid/view/accessibility/AccessibilityEvent;)Z": () => 0,
  "getParentForAccessibility()Landroid/view/ViewParent;": function (this: JView) { return this.parent; },
  "getAccessibilityPaneTitle()Ljava/lang/CharSequence;": () => null,
  "setAccessibilityPaneTitle(Ljava/lang/CharSequence;)V": () => {},
  "getStateDescription()Ljava/lang/CharSequence;": () => null,
  "setStateDescription(Ljava/lang/CharSequence;)V": () => {},
  "isAccessibilityHeading()Z": () => 0,
  "setAccessibilityHeading(Z)V": () => {},
  "isScreenReaderFocusable()Z": () => 0,
  "setScreenReaderFocusable(Z)V": () => {},
  "setDuplicateParentStateEnabled(Z)V": () => {},
  "setAddStatesFromChildren(Z)V": () => {},
  "startAnimation(Landroid/view/animation/Animation;)V": () => { invalidate(); }, // view animations complete instantly
  "clearAnimation()V": () => {},
  "getAnimation()Landroid/view/animation/Animation;": () => null,
  "animate()Landroid/view/ViewPropertyAnimator;": function (this: JView) { return mkVPA(this); },
  "getForeground()Landroid/graphics/drawable/Drawable;": function (this: JView) { return this.foreground; },
  "onWindowFocusChanged(Z)V": () => {},
  "dispatchWindowFocusChanged(Z)V": () => {},
  "onFocusChanged(ZILandroid/graphics/Rect;)V": () => {},
  "getHandler()Landroid/os/Handler;": async function () {
    const info = rt.link("android/os/Handler");
    const p = rt.initClass(info);
    if (p) await p;
    return new info.ctor();
  },
  "getDisplay()Landroid/view/Display;": async function () {
    const info = rt.link("android/view/Display");
    return new info.ctor();
  },
  "setNestedScrollingEnabled(Z)V": () => {},
  "isInEditMode()Z": () => 0,
  "isLaidOut()Z": function (this: JView) { return this.right > 0 || this.bottom > 0 ? 1 : 0; },
  "getLayoutDirection()I": () => 0,
  "setLayoutDirection(I)V": () => {},
  "getTextDirection()I": () => 0,
  "setTextDirection(I)V": () => {},
  "isPaddingRelative()Z": () => 0,
  "resolveSizeAndState(III)I": (size: number, spec: number) => resolveSizeAndState(size, spec),
  "static resolveSizeAndState(III)I": (size: number, spec: number) => resolveSizeAndState(size, spec),
  "static resolveSize(II)I": (size: number, spec: number) => resolveSizeAndState(size, spec),
  "static getDefaultSize(II)I": (size: number, spec: number) => defaultSize(size, spec),
  "static generateViewId()I": (() => { let n = 0x00ffff00; return () => ++n; })(),
  "static inflate(Landroid/content/Context;ILandroid/view/ViewGroup;)Landroid/view/View;": async (ctx: unknown, id: number, root: unknown) => {
    const { inflateLayout } = await import("./inflate");
    return inflateLayout(ctx, id, root, !!root);
  },
};

export function findById(v: JView, id: number): JView | null {
  if (v.idNum === id) return v;
  if (v instanceof JViewGroup) {
    for (const c of v.children) {
      const r = findById(c, id);
      if (r) return r;
    }
  }
  return null;
}
function findByPred(v: JView, p: (v: JView) => boolean): JView | null {
  if (p(v)) return v;
  if (v instanceof JViewGroup) {
    for (const c of v.children) {
      const r = findByPred(c, p);
      if (r) return r;
    }
  }
  return null;
}

/** a view built by native code (a picker's stepper, a dialog row) takes its parent's context, resources and theme */
export function inheritContext(child: JView, from: JView) {
  child.ctx = from.ctx; child.jres = from.jres; child.theme = from.theme;
}
export async function initViewFromCtx(v: JView, jctx: unknown, set: JAttrSet | null) {
  v.ctx = jctx;
  if (jctx) {
    const host = (jctx as any).$host;
    if (host) {
      v.jres = host.res;
      v.theme = host.theme;
    }
  }
  await applyViewAttrs(v, set);
}

// ── ViewGroup
export class JViewGroup extends JView {
  children: JView[] = [];
  drawingOrderEnabled = false;
  clipChildren = true;
  clipToPadding = true;
  disallowIntercept = false;
  touchTarget: JView | null = null;
  hierarchyChangeL: unknown = null;
}
/** Convert a LayoutParams to one this ViewGroup accepts (e.g. ViewPager needs its own LP type,
 *  and casts in its onLayout otherwise). Dispatches to the ViewGroup's own check/generate overrides. */
async function convertLp(vg: JViewGroup, lp: JLayoutParams | null): Promise<JLayoutParams | null> {
  if (!lp) return lp;
  const check = (vg as any)[mangleMethod("checkLayoutParams", "(Landroid/view/ViewGroup$LayoutParams;)Z")];
  if (typeof check === "function") {
    const ok = await guardCall(check, vg, lp);
    if (!ok) {
      const gen = (vg as any)[mangleMethod("generateLayoutParams", "(Landroid/view/ViewGroup$LayoutParams;)Landroid/view/ViewGroup$LayoutParams;")];
      if (typeof gen === "function") {
        const converted = await guardCall(gen, vg, lp);
        if (converted) return converted as JLayoutParams;
      }
    }
  }
  return lp;
}

export function attachView(parent: JViewGroup, child: JView, index = -1) {
  // integrity: never create a cycle (child already an ancestor of parent)
  for (let a: JView | null = parent; a; a = a.parent) {
    if (a === child) {
      console.error("[webdroid] refused cyclic addView:", (child.constructor as any)?.$i?.name, "into", (parent.constructor as any)?.$i?.name, new Error().stack?.split("\n").slice(1, 6).join(" | "));
      return;
    }
  }
  if (child.parent) detachView(child.parent as JViewGroup, child);
  if (index < 0 || index > parent.children.length) parent.children.push(child);
  else parent.children.splice(index, 0, child);
  child.parent = parent;
  // every addView overload funnels here (see addViewFunnel/addView3 below), and
  // addViewInLayout/attachViewToParent call this directly too -- so this is the one
  // place that sees every child ever added, regardless of call path.
  if (parent.hierarchyChangeL) {
    void vcall(parent.hierarchyChangeL, "onChildViewAdded", "(Landroid/view/View;Landroid/view/View;)V", parent, child);
  }
  // Android attaches inline; we cannot, so queue behind the current main-looper job rather
  // than starting a chain that interleaves with the caller at its first await (Compose's
  // composition installs a snapshot read observer that must not see foreign reads).
  if (parent.attached) void onMain(() => dispatchAttached(child));
  requestLayout(parent);
}
export function detachView(parent: JViewGroup, child: JView) {
  const i = parent.children.indexOf(child);
  if (i >= 0) parent.children.splice(i, 1);
  child.parent = null;
  if (parent.hierarchyChangeL) {
    void vcall(parent.hierarchyChangeL, "onChildViewRemoved", "(Landroid/view/View;Landroid/view/View;)V", parent, child);
  }
  if (child.attached) void onMain(() => dispatchDetached(child));
  requestLayout(parent);
}
export async function dispatchAttached(v: JView) {
  if (v.attached) return;
  v.attached = true;
  const f = (v as any)[M_onAttached];
  if (f) try { await guardCall(f, v); } catch (e) { reportUncaught(e); }
  for (const l of v.attachLs) {
    try { await vcall(l, "onViewAttachedToWindow", "(Landroid/view/View;)V", v); } catch (e) { reportUncaught(e); }
  }
  // one child's failure must not prevent its siblings from attaching (e.g. ViewPager populate)
  if (v instanceof JViewGroup) for (const c of [...v.children]) {
    try { await dispatchAttached(c); } catch (e) { reportUncaught(e); }
  }
}
/**
 * A Configuration change reaches a view hierarchy the way AOSP's ViewRootImpl delivers it —
 * down the tree, each view's own onConfigurationChanged. It is the only signal an activity that
 * declared the change in its manifest ever gets, and Compose's AndroidComposeView listens on it
 * to republish LocalConfiguration (hence isSystemInDarkTheme).
 */
export async function dispatchConfigurationChanged(v: JView, cfg: unknown) {
  const f = (v as any)[M_onConfigChanged];
  if (f) try { await guardCall(f, v, cfg); } catch (e) { reportUncaught(e); }
  if (v instanceof JViewGroup) for (const c of [...v.children]) await dispatchConfigurationChanged(c, cfg);
}
export async function dispatchDetached(v: JView) {
  if (!v.attached) return;
  v.attached = false;
  if (v instanceof JViewGroup) for (const c of [...v.children]) await dispatchDetached(c);
  const f = (v as any)[M_onDetached];
  if (f) await guardCall(f, v);
  for (const l of v.attachLs) await vcall(l, "onViewDetachedFromWindow", "(Landroid/view/View;)V", v);
}

/** AOSP getChildMeasureSpec */
export function childMeasureSpec(spec: number, padding: number, childDim: number): number {
  const mode = specMode(spec);
  const size = Math.max(0, specSize(spec) - padding);
  if (childDim >= 0) return makeSpec(childDim, MS_EXACTLY);
  if (childDim === MATCH_PARENT) {
    if (mode === MS_EXACTLY) return makeSpec(size, MS_EXACTLY);
    if (mode === MS_AT_MOST) return makeSpec(size, MS_AT_MOST);
    return makeSpec(size, MS_UNSPEC);
  }
  // WRAP_CONTENT
  return mode === MS_UNSPEC ? makeSpec(size, MS_UNSPEC) : makeSpec(size, MS_AT_MOST);
}
export async function measureChildWithMargins(vg: JViewGroup, child: JView, wSpec: number, wUsed: number, hSpec: number, hUsed: number) {
  const lp = child.lp;
  const ml = lp instanceof JMarginLP ? lp.marginL + lp.marginR : 0;
  const mt = lp instanceof JMarginLP ? lp.marginT + lp.marginB : 0;
  await measureView(child,
    childMeasureSpec(wSpec, vg.padL + vg.padR + ml + wUsed, lp?.width ?? WRAP_CONTENT),
    childMeasureSpec(hSpec, vg.padT + vg.padB + mt + hUsed, lp?.height ?? WRAP_CONTENT));
}

const M_addView3 = mangleMethod("addView", "(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;)V");
const M_genDefaultLP = mangleMethod("generateDefaultLayoutParams", "()Landroid/view/ViewGroup$LayoutParams;");

/** the native terminal: every other overload reaches the tree through here */
async function addView3(this: JViewGroup, c: JView, i: number, lp: JLayoutParams | null) {
  c.lp = lp ? await convertLp(this, lp)
    : c.lp ? await convertLp(this, c.lp)
    : await guardCall((this as any)[M_genDefaultLP], this);
  attachView(this, c, i);
}
/**
 * AOSP funnels every addView overload through the overridable 3-arg one, and subclasses do real
 * work there -- ViewPager sets lp.isDecor and, mid-layout, lp.needsMeasure + addViewInLayout, which
 * is the only way a page committed during its own measure pass ever gets sized. Calling attachView
 * directly from each overload skipped all of it.
 */
async function addViewFunnel(vg: JViewGroup, c: JView, i: number, lp: JLayoutParams | null) {
  const f = (vg as any)[M_addView3];
  if (f && f !== addView3) return void await guardCall(f, vg, c, i, lp);
  await addView3.call(vg, c, i, lp);
}

const vgMethods: NativeSpec["methods"] = {
  "addView(Landroid/view/View;)V": function (this: JViewGroup, c: JView) {
    return addViewFunnel(this, c, -1, null);
  },
  "addView(Landroid/view/View;I)V": function (this: JViewGroup, c: JView, i: number) {
    return addViewFunnel(this, c, i, null);
  },
  "addView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": function (this: JViewGroup, c: JView, lp: JLayoutParams) {
    return addViewFunnel(this, c, -1, lp);
  },
  "addView(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;)V": addView3,
  "addView(Landroid/view/View;II)V": function (this: JViewGroup, c: JView, w: number, h: number) {
    const lp = new JLayoutParams();
    lp.width = w; lp.height = h;
    return addViewFunnel(this, c, -1, lp);
  },
  "removeView(Landroid/view/View;)V": removeChild,
  "removeViewInLayout(Landroid/view/View;)V": removeChild,
  "removeViewAt(I)V": function (this: JViewGroup, i: number) {
    const c = this.children[i];
    if (c) detachView(this, c);
  },
  "removeAllViews()V": removeAllChildren,
  "removeAllViewsInLayout()V": removeAllChildren,
  "getChildCount()I": function (this: JViewGroup) { return this.children.length; },
  "getChildAt(I)Landroid/view/View;": function (this: JViewGroup, i: number) { return this.children[i] ?? null; },
  "indexOfChild(Landroid/view/View;)I": function (this: JViewGroup, c: JView) { return this.children.indexOf(c); },
  "bringChildToFront(Landroid/view/View;)V": function (this: JViewGroup, c: JView) {
    const i = this.children.indexOf(c);
    if (i >= 0) { this.children.splice(i, 1); this.children.push(c); invalidate(); }
  },
  "generateDefaultLayoutParams()Landroid/view/ViewGroup$LayoutParams;": function () {
    const lp = new JLayoutParams();
    lp.width = WRAP_CONTENT; lp.height = WRAP_CONTENT;
    return lp;
  },
  "generateLayoutParams(Landroid/util/AttributeSet;)Landroid/view/ViewGroup$LayoutParams;": function (this: JViewGroup, set: JAttrSet) {
    return lpFromAttrs(new JMarginLP(), this.jres!, set);
  },
  "generateLayoutParams(Landroid/view/ViewGroup$LayoutParams;)Landroid/view/ViewGroup$LayoutParams;": function (this: JViewGroup, lp: JLayoutParams) {
    return lp;
  },
  "checkLayoutParams(Landroid/view/ViewGroup$LayoutParams;)Z": () => 1,
  "dispatchDraw(Landroid/graphics/Canvas;)V": async function (this: JViewGroup, cv: JCanvas) {
    const n = this.children.length;
    if (!this.drawingOrderEnabled) { for (const c of this.children) await drawView(c, cv); return; }
    // a subclass's getChildDrawingOrder picks which child paints at each z step (AOSP buildOrderedChildList)
    for (let i = 0; i < n; i++) {
      const c = this.children[await vcall(this, "getChildDrawingOrder", "(II)I", n, i)];
      if (c) await drawView(c, cv);
    }
  },
  "setChildrenDrawingOrderEnabled(Z)V": function (this: JViewGroup, e: number) { this.drawingOrderEnabled = !!e; },
  "isChildrenDrawingOrderEnabled()Z": function (this: JViewGroup) { return this.drawingOrderEnabled ? 1 : 0; },
  "getChildDrawingOrder(II)I": (_n: number, i: number) => i,
  "getChildDrawingOrder(I)I": function (this: JViewGroup, i: number) { return vcall(this, "getChildDrawingOrder", "(II)I", this.children.length, i); },
  "onMeasure(II)V": async function (this: JViewGroup, w: number, h: number) {
    // default: act like FrameLayout-lite
    let mw = 0, mh = 0;
    for (const c of this.children) {
      if (c.visibility === 8) continue;
      await measureChildWithMargins(this, c, w, 0, h, 0);
      mw = Math.max(mw, c.measuredW);
      mh = Math.max(mh, c.measuredH);
    }
    this.measuredW = resolveSizeAndState(mw + this.padL + this.padR, w);
    this.measuredH = resolveSizeAndState(mh + this.padT + this.padB, h);
  },
  "onLayout(ZIIII)V": async function (this: JViewGroup) {
    for (const c of this.children) {
      if (c.visibility === 8) continue;
      await layoutView(c, this.padL, this.padT, this.padL + c.measuredW, this.padT + c.measuredH);
    }
  },
  "measureChildWithMargins(Landroid/view/View;IIII)V": function (this: JViewGroup, c: JView, ws: number, wu: number, hs: number, hu: number) {
    return measureChildWithMargins(this, c, ws, wu, hs, hu);
  },
  "measureChild(Landroid/view/View;II)V": async function (this: JViewGroup, c: JView, ws: number, hs: number) {
    await measureView(c,
      childMeasureSpec(ws, this.padL + this.padR, c.lp?.width ?? WRAP_CONTENT),
      childMeasureSpec(hs, this.padT + this.padB, c.lp?.height ?? WRAP_CONTENT));
  },
  "measureChildren(II)V": async function (this: JViewGroup, ws: number, hs: number) {
    for (const c of this.children) {
      if (c.visibility === 8) continue;
      await measureChildWithMargins(this, c, ws, 0, hs, 0);
    }
  },
  "setOnHierarchyChangeListener(Landroid/view/ViewGroup$OnHierarchyChangeListener;)V": function (this: JViewGroup, l: unknown) {
    this.hierarchyChangeL = l;
  },
  "setClipChildren(Z)V": function (this: JViewGroup, v: number) { this.clipChildren = !!v; },
  "setClipToPadding(Z)V": function (this: JViewGroup, v: number) { this.clipToPadding = !!v; },
  "getClipToPadding()Z": function (this: JViewGroup) { return this.clipToPadding ? 1 : 0; },
  "setMotionEventSplittingEnabled(Z)V": () => {},
  "setDescendantFocusability(I)V": () => {},
  "getDescendantFocusability()I": () => 0x20000,
  "requestChildFocus(Landroid/view/View;Landroid/view/View;)V": () => {},
  "focusableViewAvailable(Landroid/view/View;)V": () => {},
  "requestTransparentRegion(Landroid/view/View;)V": () => {},
  "setLayoutTransition(Landroid/animation/LayoutTransition;)V": () => {},
  "getLayoutTransition()Landroid/animation/LayoutTransition;": () => null,
  "setAddStatesFromChildren(Z)V": () => {},
  "childDrawableStateChanged(Landroid/view/View;)V": () => {},
  "addViewInLayout(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;)Z": attachInLayout,
  "addViewInLayout(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;Z)Z": attachInLayout,
  "attachViewToParent(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;)V": attachInLayout,
  "removeDetachedView(Landroid/view/View;Z)V": removeChild,
  "detachViewFromParent(Landroid/view/View;)V": removeChild,
  "drawChild(Landroid/graphics/Canvas;Landroid/view/View;J)Z": async function (this: JViewGroup, cv: JCanvas, c: JView) {
    await drawView(c, cv);
    return 0;
  },
  "static getChildMeasureSpec(III)I": (spec: number, padding: number, dim: number) => childMeasureSpec(spec, padding, dim),
  "isTransitionGroup()Z": () => 0,
  "startViewTransition(Landroid/view/View;)V": () => {},
  "endViewTransition(Landroid/view/View;)V": () => {},
  "dispatchKeyEvent(Landroid/view/KeyEvent;)Z": () => 0,
  "offsetDescendantRectToMyCoords(Landroid/view/View;Landroid/graphics/Rect;)V": function (this: JViewGroup, c: JView, r: JRect) {
    let v: JView | null = c;
    while (v && v !== this) {
      r.left += v.left; r.right += v.left; r.top += v.top; r.bottom += v.top;
      v = v.parent;
    }
  },
  "dispatchTouchEvent(Landroid/view/MotionEvent;)Z": async function (this: JViewGroup, ev: JMotionEvent) {
    const action = ev.action & 0xff;
    if (this.touchL) {
      const r = await vcall(this.touchL, "onTouch", "(Landroid/view/View;Landroid/view/MotionEvent;)Z", this, ev);
      if (r) return 1;
    }
    if (action === 0) { this.touchTarget = null; this.disallowIntercept = false; }
    // intercept?
    let intercepted = false;
    if (!this.disallowIntercept && (action === 0 || this.touchTarget)) {
      intercepted = !!(await guardCall((this as any)[M_onIntercept], this, ev));
    }
    if (action === 0 && !intercepted) {
      // find touch target among children (reverse order)
      for (let i = this.children.length - 1; i >= 0; i--) {
        const c = this.children[i];
        if (c.visibility !== 0) continue;
        const cx = ev.x + this.scrollX - (c.left + c.translationX);
        const cy = ev.y + this.scrollY - (c.top + c.translationY);
        if (cx < 0 || cy < 0 || cx >= c.width() || cy >= c.height()) continue;
        const ox = ev.x, oy = ev.y;
        ev.x = cx; ev.y = cy;
        const handled = await guardCall((c as any)[M_dispatchTouch], c, ev);
        ev.x = ox; ev.y = oy;
        if (handled) { this.touchTarget = c; return 1; }
      }
    } else if (this.touchTarget && !intercepted) {
      const c = this.touchTarget;
      const ox = ev.x, oy = ev.y;
      ev.x = ev.x + this.scrollX - (c.left + c.translationX);
      ev.y = ev.y + this.scrollY - (c.top + c.translationY);
      const handled = await guardCall((c as any)[M_dispatchTouch], c, ev);
      ev.x = ox; ev.y = oy;
      if (action === 1 || action === 3) this.touchTarget = null;
      return handled ? 1 : 0;
    } else if (this.touchTarget && intercepted) {
      // send cancel to target, take over
      const c = this.touchTarget;
      const oldAction = ev.action;
      ev.action = 3;
      await guardCall((c as any)[M_dispatchTouch], c, ev);
      ev.action = oldAction;
      this.touchTarget = null;
    }
    const self = await guardCall((this as any)[M_onTouchEvent], this, ev);
    return self ? 1 : 0;
  },
};

function lpFromAttrs<T extends JLayoutParams>(lp: T, res: Resources, set: JAttrSet | null): T {
  if (!set?.node) return lp;
  const ta = obtainStyled(res, set.theme, set, [
    AT.layout_width, AT.layout_height, AT.layout_margin, AT.layout_marginLeft, AT.layout_marginTop,
    AT.layout_marginRight, AT.layout_marginBottom, AT.layout_gravity, AT.layout_weight,
    AT.layout_marginStart, AT.layout_marginEnd,
  ], 0, 0);
  const dim = (i: number, dflt: number) => {
    const v = ta.vals[i];
    if (!v) return dflt;
    if (v.t >= 0x10 && v.d < 0) return v.d; // MATCH_PARENT/WRAP_CONTENT enums
    return Math.round(rvDimen(res, v, dflt));
  };
  lp.width = dim(0, WRAP_CONTENT);
  lp.height = dim(1, WRAP_CONTENT);
  if (lp instanceof JMarginLP) {
    const m = ta.vals[2] ? Math.round(rvDimen(res, ta.vals[2], 0)) : null;
    if (m !== null) { lp.marginL = lp.marginT = lp.marginR = lp.marginB = m; }
    if (ta.vals[3]) lp.marginL = Math.round(rvDimen(res, ta.vals[3], lp.marginL));
    if (ta.vals[4]) lp.marginT = Math.round(rvDimen(res, ta.vals[4], lp.marginT));
    if (ta.vals[5]) lp.marginR = Math.round(rvDimen(res, ta.vals[5], lp.marginR));
    if (ta.vals[6]) lp.marginB = Math.round(rvDimen(res, ta.vals[6], lp.marginB));
    if (ta.vals[9]) lp.marginL = Math.round(rvDimen(res, ta.vals[9], lp.marginL));
    if (ta.vals[10]) lp.marginR = Math.round(rvDimen(res, ta.vals[10], lp.marginR));
  }
  if (lp instanceof JFrameLP && ta.vals[7]) lp.gravity = rvInt(res, ta.vals[7], -1);
  if (lp instanceof JLinearLP) {
    if (ta.vals[7]) lp.gravity = rvInt(res, ta.vals[7], -1);
    if (ta.vals[8]) lp.weight = ta.vals[8]!.t === 4 ? ta.vals[8]!.d : rvInt(res, ta.vals[8], 0);
  }
  return lp;
}
export { lpFromAttrs };

// ── MotionEvent
export class JMotionEvent extends JObj {
  action = 0;
  x = 0; y = 0;
  rawX = 0; rawY = 0;
  downTime = 0;
  eventTime = 0;
}
rt.register({
  name: "android/view/MotionEvent", ctor: JMotionEvent, ifaces: ["android/os/Parcelable"],
  statics: {
    ACTION_DOWN: 0, ACTION_UP: 1, ACTION_MOVE: 2, ACTION_CANCEL: 3, ACTION_OUTSIDE: 4,
    ACTION_POINTER_DOWN: 5, ACTION_POINTER_UP: 6, ACTION_MASK: 0xff, ACTION_POINTER_INDEX_MASK: 0xff00,
    INVALID_POINTER_ID: -1,
  },
  methods: {
    "isFromSource(I)Z": (src: number) => ((0x1002 & src) === src || (0x2 & src) === src ? 1 : 0),
    "getAxisValue(I)F": () => 0,
    "getAxisValue(II)F": () => 0,
    "getFlags()I": () => 0,
    "getDeviceId()I": () => 0,
    "getClassification()I": () => 0,
    "getPressure(I)F": () => 1,
    "getEventTimeNanos()J": function (this: JMotionEvent) { return BigInt(Math.floor(Number(this.eventTime) * 1e6)); },
    "getAction()I": function (this: JMotionEvent) { return this.action; },
    "getActionMasked()I": function (this: JMotionEvent) { return this.action & 0xff; },
    "getActionIndex()I": () => 0,
    "getX()F": function (this: JMotionEvent) { return this.x; },
    "getY()F": function (this: JMotionEvent) { return this.y; },
    "getX(I)F": function (this: JMotionEvent) { return this.x; },
    "getY(I)F": function (this: JMotionEvent) { return this.y; },
    "getRawX()F": function (this: JMotionEvent) { return this.rawX; },
    "getRawY()F": function (this: JMotionEvent) { return this.rawY; },
    "getPointerCount()I": () => 1,
    "getPointerId(I)I": () => 0,
    "findPointerIndex(I)I": () => 0,
    // Single-pointer model (matches getX(I)/getY(I) above): every index reuses this event's
    // one tracked position, so PointerCoords is filled from the same backing fields.
    "getPointerCoords(ILandroid/view/MotionEvent$PointerCoords;)V": function (this: JMotionEvent, idx: number, out: JPointerCoords) {
      if (!out) return;
      out.x = this.x; out.y = this.y;
      out.pressure = 1; out.size = 0.1;
      out.orientation = 0;
      out.touchMajor = out.touchMinor = out.toolMajor = out.toolMinor = 0;
    },
    "getDownTime()J": function (this: JMotionEvent) { return BigInt(Math.round(this.downTime)); },
    "getEventTime()J": function (this: JMotionEvent) { return BigInt(Math.round(this.eventTime)); },
    "setAction(I)V": function (this: JMotionEvent, a: number) { this.action = a; },
    "offsetLocation(FF)V": function (this: JMotionEvent, dx: number, dy: number) { this.x += dx; this.y += dy; },
    "setLocation(FF)V": function (this: JMotionEvent, x: number, y: number) { this.x = x; this.y = y; },
    "getEdgeFlags()I": () => 0,
    "transform(Landroid/graphics/Matrix;)V": () => {},
    "recycle()V": () => {},
    "getHistorySize()I": () => 0,
    "getHistoricalX(I)F": function (this: JMotionEvent) { return this.x; },
    "getHistoricalY(I)F": function (this: JMotionEvent) { return this.y; },
    "getHistoricalEventTime(I)J": function (this: JMotionEvent) { return BigInt(Math.round(this.eventTime)); },
    "getPressure()F": () => 1,
    "getSize()F": () => 0.1,
    "getToolType(I)I": () => 1,
    "getSource()I": () => 0x1002,
    "getButtonState()I": () => 0,
    "getMetaState()I": () => 0,
    "static obtain(JJIFFI)Landroid/view/MotionEvent;": obtainEvent,
    "static obtain(JJIFFFFIFFII)Landroid/view/MotionEvent;": obtainEvent,
    "static obtainNoHistory(Landroid/view/MotionEvent;)Landroid/view/MotionEvent;": copyEvent,
    "static obtain(Landroid/view/MotionEvent;)Landroid/view/MotionEvent;": copyEvent,
  },
});

// MotionEvent$PointerCoords: a per-pointer snapshot filled in by getPointerCoords(int, PointerCoords).
// x/y are public Java fields (direct iget/iput from app code), not getter methods.
class JPointerCoords extends JObj {
  x = 0; y = 0; pressure = 0; size = 0;
  orientation = 0; toolMajor = 0; toolMinor = 0; touchMajor = 0; touchMinor = 0;
}
rt.register({
  name: "android/view/MotionEvent$PointerCoords", ctor: JPointerCoords,
  fields: {
    x: "x", y: "y", pressure: "pressure", size: "size", orientation: "orientation",
    toolMajor: "toolMajor", toolMinor: "toolMinor", touchMajor: "touchMajor", touchMinor: "touchMinor",
  },
  methods: {
    "<init>()V": () => {},
    "<init>(Landroid/view/MotionEvent$PointerCoords;)V": function (this: JPointerCoords, o: JPointerCoords | null) {
      if (o) Object.assign(this, o);
    },
    "clear()V": function (this: JPointerCoords) {
      this.x = this.y = this.pressure = this.size = this.orientation = 0;
      this.toolMajor = this.toolMinor = this.touchMajor = this.touchMinor = 0;
    },
    "copyFrom(Landroid/view/MotionEvent$PointerCoords;)V": function (this: JPointerCoords, o: JPointerCoords | null) {
      if (o) Object.assign(this, o);
    },
  },
});

// DragEvent: no drag-and-drop gesture pipeline exists (nothing ever starts a drag), but the
// class must exist for View$OnDragListener.onDrag(View, DragEvent) and app code that reads
// DragEvent.ACTION_* constants to link.
class JDragEvent extends JObj {
  action = 0; x = 0; y = 0; resultV = false;
  clipData: unknown = null; clipDescription: unknown = null; localState: unknown = null;
}
rt.register({
  name: "android/view/DragEvent", ctor: JDragEvent, ifaces: ["android/os/Parcelable"],
  statics: {
    ACTION_DRAG_STARTED: 1, ACTION_DRAG_LOCATION: 2, ACTION_DROP: 3,
    ACTION_DRAG_ENDED: 4, ACTION_DRAG_ENTERED: 5, ACTION_DRAG_EXITED: 6,
  },
  methods: {
    "getAction()I": function (this: JDragEvent) { return this.action; },
    "getX()F": function (this: JDragEvent) { return this.x; },
    "getY()F": function (this: JDragEvent) { return this.y; },
    "getResult()Z": function (this: JDragEvent) { return this.resultV ? 1 : 0; },
    "getClipData()Landroid/content/ClipData;": function (this: JDragEvent) { return this.clipData; },
    "getClipDescription()Landroid/content/ClipDescription;": function (this: JDragEvent) { return this.clipDescription; },
    "getLocalState()Ljava/lang/Object;": function (this: JDragEvent) { return this.localState; },
    "toString()Ljava/lang/String;": () => "DragEvent",
  },
});

// ViewPropertyAnimator-lite: applies instantly, fires end listeners
function mkVPA(v: JView): any {
  const info = rt.link("webdroid/VPA");
  const o = new info.ctor();
  o.view = v;
  return o;
}
class JVPA extends JObj {
  view: JView | null = null;
  endAction: unknown = null;
}
rt.register({
  name: "webdroid/VPA", ctor: JVPA,
  methods: {
    "alpha(F)Landroid/view/ViewPropertyAnimator;": function (this: JVPA, a: number) { if (this.view) this.view.alphaV = a; invalidate(); return this; },
    "translationX(F)Landroid/view/ViewPropertyAnimator;": function (this: JVPA, x: number) { if (this.view) this.view.translationX = x; invalidate(); return this; },
    "translationY(F)Landroid/view/ViewPropertyAnimator;": function (this: JVPA, y: number) { if (this.view) this.view.translationY = y; invalidate(); return this; },
    "scaleX(F)Landroid/view/ViewPropertyAnimator;": function (this: JVPA, s: number) { if (this.view) this.view.scaleXv = s; invalidate(); return this; },
    "scaleY(F)Landroid/view/ViewPropertyAnimator;": function (this: JVPA, s: number) { if (this.view) this.view.scaleYv = s; invalidate(); return this; },
    "rotation(F)Landroid/view/ViewPropertyAnimator;": function (this: JVPA, r: number) { if (this.view) this.view.rotationV = r; invalidate(); return this; },
    "setDuration(J)Landroid/view/ViewPropertyAnimator;": function (this: JVPA) { return this; },
    "setStartDelay(J)Landroid/view/ViewPropertyAnimator;": function (this: JVPA) { return this; },
    "setInterpolator(Landroid/view/animation/Interpolator;)Landroid/view/ViewPropertyAnimator;": function (this: JVPA) { return this; },
    "setListener(Landroid/animation/Animator$AnimatorListener;)Landroid/view/ViewPropertyAnimator;": function (this: JVPA) { return this; },
    "withEndAction(Ljava/lang/Runnable;)Landroid/view/ViewPropertyAnimator;": function (this: JVPA, r: unknown) {
      mainHandler().postRun(r, 20);
      return this;
    },
    "start()V": () => {},
    "cancel()V": () => {},
  },
});

// ViewTreeObserver
class JVTO extends JObj {
  globalLayoutLs: unknown[] = [];
  preDrawLs: unknown[] = [];
  drawLs: unknown[] = [];
  scrollLs: unknown[] = [];
  async dispatchGlobalLayout() {
    for (const l of [...this.globalLayoutLs]) {
      try { await vcall(l, "onGlobalLayout", "()V"); } catch (e) { console.error("[vto]", e); }
    }
  }
  async dispatchPreDraw() {
    for (const l of [...this.preDrawLs]) {
      try { await vcall(l, "onPreDraw", "()Z"); } catch (e) { console.error("[vto]", e); }
    }
  }
  async dispatchOnDraw() {
    for (const l of [...this.drawLs]) {
      try { await vcall(l, "onDraw", "()V"); } catch (e) { console.error("[vto]", e); }
    }
  }
  async dispatchScrollChanged() {
    for (const l of [...this.scrollLs]) {
      try { await vcall(l, "onScrollChanged", "()V"); } catch (e) { console.error("[vto]", e); }
    }
  }
}
const vtoMap = new WeakMap<JView, JVTO>();
function getVTO(v: JView): JVTO {
  let root: JView = v;
  while (root.parent) root = root.parent;
  let o = vtoMap.get(root);
  if (!o) vtoMap.set(root, (o = new JVTO()));
  return o;
}
/** fire-and-forget: scroll setters are synchronous void natives, same shape as refreshDrawableState */
function fireScrollChanged(v: JView) { void getVTO(v).dispatchScrollChanged(); }
rt.register({
  name: "android/view/accessibility/AccessibilityNodeInfo$AccessibilityAction", ctor: class extends JObj {},
});
rt.register({ name: "android/view/autofill/AutofillId", ctor: class extends JObj {} });
rt.register({
  name: "android/view/TouchDelegate", ctor: class extends JObj {},
  methods: {
    "<init>(Landroid/graphics/Rect;Landroid/view/View;)V": () => {},
    "onTouchEvent(Landroid/view/MotionEvent;)Z": () => 0,
  },
});
// ViewTreeObserver callback interfaces — apps `implements` these directly (Compose's
// AndroidComposeView registers OnPreDrawListener/OnScrollChangedListener itself, for one).
for (const n of [
  "OnGlobalLayoutListener", "OnScrollChangedListener", "OnTouchModeChangeListener",
  "OnPreDrawListener", "OnWindowFocusChangeListener", "OnDrawListener",
]) rt.register({ name: "android/view/ViewTreeObserver$" + n, ctor: class extends JObj {} });
rt.register({
  name: "android/view/ViewTreeObserver", ctor: JVTO,
  methods: {
    // Real Android's touch mode is a d-pad/keyboard-vs-touch input concept; webdroid has no
    // non-touch input source and never toggles it, so these link and store nothing to remove.
    "addOnWindowFocusChangeListener(Landroid/view/ViewTreeObserver$OnWindowFocusChangeListener;)V": () => {},
    "removeOnWindowFocusChangeListener(Landroid/view/ViewTreeObserver$OnWindowFocusChangeListener;)V": () => {},
    "addOnTouchModeChangeListener(Landroid/view/ViewTreeObserver$OnTouchModeChangeListener;)V": () => {},
    "removeOnTouchModeChangeListener(Landroid/view/ViewTreeObserver$OnTouchModeChangeListener;)V": () => {},
    "addOnScrollChangedListener(Landroid/view/ViewTreeObserver$OnScrollChangedListener;)V": function (this: JVTO, l: unknown) { this.scrollLs.push(l); },
    "removeOnScrollChangedListener(Landroid/view/ViewTreeObserver$OnScrollChangedListener;)V": function (this: JVTO, l: unknown) { removeFrom(this.scrollLs, l); },
    "addOnGlobalLayoutListener(Landroid/view/ViewTreeObserver$OnGlobalLayoutListener;)V": function (this: JVTO, l: unknown) { this.globalLayoutLs.push(l); },
    "removeOnGlobalLayoutListener(Landroid/view/ViewTreeObserver$OnGlobalLayoutListener;)V": function (this: JVTO, l: unknown) { removeFrom(this.globalLayoutLs, l); },
    "removeGlobalOnLayoutListener(Landroid/view/ViewTreeObserver$OnGlobalLayoutListener;)V": function (this: JVTO, l: unknown) { removeFrom(this.globalLayoutLs, l); },
    "addOnPreDrawListener(Landroid/view/ViewTreeObserver$OnPreDrawListener;)V": function (this: JVTO, l: unknown) { this.preDrawLs.push(l); },
    "removeOnPreDrawListener(Landroid/view/ViewTreeObserver$OnPreDrawListener;)V": function (this: JVTO, l: unknown) { removeFrom(this.preDrawLs, l); },
    "addOnDrawListener(Landroid/view/ViewTreeObserver$OnDrawListener;)V": function (this: JVTO, l: unknown) { this.drawLs.push(l); },
    "removeOnDrawListener(Landroid/view/ViewTreeObserver$OnDrawListener;)V": function (this: JVTO, l: unknown) { removeFrom(this.drawLs, l); },
    "isAlive()Z": () => 1,
    "dispatchOnGlobalLayout()V": function (this: JVTO) { return this.dispatchGlobalLayout(); },
  },
});
/** layout pass: OnGlobalLayoutListener fires when the tree's layout actually ran */
export async function fireGlobalLayout(root: JView) {
  const o = vtoMap.get(root);
  if (!o) return;
  await o.dispatchGlobalLayout();
}
/** draw pass: AOSP's performTraversals fires OnPreDrawListener then OnDrawListener right
 *  before the tree is actually drawn, on every draw -- not only ones that also laid out. */
export async function fireDrawPass(root: JView) {
  const o = vtoMap.get(root);
  if (!o) return;
  await o.dispatchPreDraw();
  await o.dispatchOnDraw();
}

// layout params natives
rt.register({
  name: "android/view/ViewGroup$LayoutParams", ctor: JLayoutParams,
  statics: { MATCH_PARENT: -1, FILL_PARENT: -1, WRAP_CONTENT: -2 },
  fields: { width: "width", height: "height" },
  methods: {
    "<init>(II)V": function (this: JLayoutParams, w: number, h: number) { this.width = w; this.height = h; },
    "<init>(Landroid/view/ViewGroup$LayoutParams;)V": function (this: JLayoutParams, o: JLayoutParams) {
      if (o) { this.width = o.width; this.height = o.height; }
    },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function (this: JLayoutParams, c: unknown, set: JAttrSet) {
      lpFromAttrs(this, set.res, set);
    },
  },
});
rt.register({
  name: "android/view/ViewGroup$MarginLayoutParams", ctor: JMarginLP, sup: "android/view/ViewGroup$LayoutParams",
  fields: { leftMargin: "marginL", topMargin: "marginT", rightMargin: "marginR", bottomMargin: "marginB" },
  methods: {
    "<init>(II)V": function (this: JMarginLP, w: number, h: number) { this.width = w; this.height = h; },
    "<init>(Landroid/view/ViewGroup$LayoutParams;)V": function (this: JMarginLP, o: JLayoutParams) {
      if (o) {
        this.width = o.width; this.height = o.height;
        if (o instanceof JMarginLP) {
          this.marginL = o.marginL; this.marginT = o.marginT; this.marginR = o.marginR; this.marginB = o.marginB;
        }
      }
    },
    "<init>(Landroid/view/ViewGroup$MarginLayoutParams;)V": function (this: JMarginLP, o: JMarginLP) {
      if (o) {
        this.width = o.width; this.height = o.height;
        this.marginL = o.marginL; this.marginT = o.marginT; this.marginR = o.marginR; this.marginB = o.marginB;
      }
    },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function (this: JMarginLP, c: unknown, set: JAttrSet) {
      lpFromAttrs(this, set.res, set);
    },
    "setMargins(IIII)V": function (this: JMarginLP, l: number, t: number, r: number, b: number) {
      this.marginL = l; this.marginT = t; this.marginR = r; this.marginB = b;
      requestLayout();
    },
    "setMarginStart(I)V": function (this: JMarginLP, v: number) { this.marginL = v; },
    "setMarginEnd(I)V": function (this: JMarginLP, v: number) { this.marginR = v; },
    "getMarginStart()I": function (this: JMarginLP) { return this.marginL; },
    "getMarginEnd()I": function (this: JMarginLP) { return this.marginR; },
  },
});

rt.register({
  name: "android/view/View", ctor: JView,
  ifaces: ["android/graphics/drawable/Drawable$Callback"],
  statics: {
    VISIBLE: 0, INVISIBLE: 4, GONE: 8, NO_ID: -1,
    MEASURED_STATE_MASK: -0x1000000, MEASURED_SIZE_MASK: 0x00ffffff,
    SYSTEM_UI_FLAG_VISIBLE: 0, LAYER_TYPE_NONE: 0, LAYER_TYPE_SOFTWARE: 1, LAYER_TYPE_HARDWARE: 2,
    SCROLLBARS_INSIDE_OVERLAY: 0, OVER_SCROLL_ALWAYS: 0, OVER_SCROLL_NEVER: 2,
    FOCUS_DOWN: 130, FOCUS_UP: 33, FOCUS_LEFT: 17, FOCUS_RIGHT: 66,
    TEXT_ALIGNMENT_INHERIT: 0, LAYOUT_DIRECTION_LTR: 0,
  },
  methods: viewMethods,
});
// View callback interfaces — apps `implements` these, so the type must be registered even
// though View itself only ever stores + vcalls the instance.
for (const n of [
  "OnClickListener", "OnLongClickListener", "OnTouchListener", "OnAttachStateChangeListener",
  "OnCreateContextMenuListener", "OnApplyWindowInsetsListener", "OnLayoutChangeListener", "OnDragListener",
  "OnKeyListener", "OnFocusChangeListener", "OnGenericMotionListener", "OnHoverListener", "OnScrollChangeListener",
]) rt.register({ name: "android/view/View$" + n, ctor: class extends JObj {} });
// AccessibilityDelegate is a class in AOSP: apps subclass it and call super.
rt.register({
  name: "android/view/View$AccessibilityDelegate", ctor: class extends JObj {},
  methods: {
    "<init>()V": () => {},
    "sendAccessibilityEvent(Landroid/view/View;I)V": (h: unknown, t: number) => vcall(h, "sendAccessibilityEvent", "(I)V", t),
    "sendAccessibilityEventUnchecked(Landroid/view/View;Landroid/view/accessibility/AccessibilityEvent;)V": () => {},
    "onPopulateAccessibilityEvent(Landroid/view/View;Landroid/view/accessibility/AccessibilityEvent;)V": () => {},
    "onInitializeAccessibilityEvent(Landroid/view/View;Landroid/view/accessibility/AccessibilityEvent;)V": (h: unknown, e: unknown) =>
      vcall(h, "onInitializeAccessibilityEvent", "(Landroid/view/accessibility/AccessibilityEvent;)V", e),
    "onInitializeAccessibilityNodeInfo(Landroid/view/View;Landroid/view/accessibility/AccessibilityNodeInfo;)V": (h: unknown, i: unknown) =>
      vcall(h, "onInitializeAccessibilityNodeInfo", "(Landroid/view/accessibility/AccessibilityNodeInfo;)V", i),
    "dispatchPopulateAccessibilityEvent(Landroid/view/View;Landroid/view/accessibility/AccessibilityEvent;)Z": (h: unknown, e: unknown) =>
      vcall(h, "dispatchPopulateAccessibilityEvent", "(Landroid/view/accessibility/AccessibilityEvent;)Z", e),
    "onRequestSendAccessibilityEvent(Landroid/view/ViewGroup;Landroid/view/View;Landroid/view/accessibility/AccessibilityEvent;)Z": () => 1,
    "getAccessibilityNodeProvider(Landroid/view/View;)Landroid/view/accessibility/AccessibilityNodeProvider;": () => null,
    "performAccessibilityAction(Landroid/view/View;ILandroid/os/Bundle;)Z": () => 0,
  },
});
// AccessibilityNodeProvider: custom-drawn views (e.g. a Compose canvas) override
// getAccessibilityNodeProvider() to return one of these and supply a virtual node tree.
// There is no real accessibility-tree consumer here, so it only needs to link and hold
// AOSP's default (non-throwing) method bodies — nothing ever calls into a virtual node.
rt.register({
  name: "android/view/accessibility/AccessibilityNodeProvider", ctor: class extends JObj {},
  statics: { HOST_VIEW_ID: -1 },
  methods: {
    "<init>()V": () => {},
    "createAccessibilityNodeInfo(I)Landroid/view/accessibility/AccessibilityNodeInfo;": () => null,
    "addExtraDataToAccessibilityNodeInfo(ILandroid/view/accessibility/AccessibilityNodeInfo;Ljava/lang/String;Landroid/os/Bundle;)V": () => {},
    "findAccessibilityNodeInfosByText(Ljava/lang/String;I)Ljava/util/List;": () => null,
    "performAction(IILandroid/os/Bundle;)Z": () => 0,
    "findFocus(I)Landroid/view/accessibility/AccessibilityNodeInfo;": () => null,
  },
});
rt.register({
  name: "android/view/View$MeasureSpec", ctor: class extends JObj {},
  statics: { EXACTLY: MS_EXACTLY, AT_MOST: MS_AT_MOST, UNSPECIFIED: 0 },
  methods: {
    "static makeMeasureSpec(II)I": (size: number, mode: number) => makeSpec(size, mode),
    "static getMode(I)I": (s: number) => specMode(s),
    "static getSize(I)I": (s: number) => specSize(s),
  },
});
rt.register({
  name: "android/view/ViewGroup", ctor: JViewGroup, sup: "android/view/View",
  ifaces: ["android/view/ViewParent", "android/view/ViewManager"],
  methods: {
    "onDescendantInvalidated(Landroid/view/View;Landroid/view/View;)V": () => { invalidate(); },
    "shouldDelayChildPressedState()Z": () => 0, ...viewMethods, ...vgMethods },
});
rt.register({ name: "android/view/ViewParent", ctor: class extends JObj {} });
rt.register({ name: "android/view/ViewManager", ctor: class extends JObj {} });
// apps `implements` this to watch a ViewGroup's addView/removeView traffic
rt.register({ name: "android/view/ViewGroup$OnHierarchyChangeListener", ctor: class extends JObj {} });
// ViewOutlineProvider: abstract outline strategy (View.setOutlineProvider). Nothing in the
// draw pipeline consumes an Outline's shape yet (no clip/shadow rendering exists), so this
// only has to link and answer getOutline() correctly in isolation — same bar as Outline
// itself (android/graphics/Outline), which already exists.
const GET_OUTLINE_DESC = "(Landroid/view/View;Landroid/graphics/Outline;)V";
class JViewOutlineProvider extends JObj {}
function mkOutlineProvider(fill: (view: JView, outline: unknown) => unknown): JViewOutlineProvider {
  const o = new JViewOutlineProvider();
  (o as unknown as Record<string, unknown>)[mangleMethod("getOutline", GET_OUTLINE_DESC)] = fill;
  return o;
}
// AOSP's default provider for every View: no background-outline shape is modeled here, so this
// always takes the plain-bounds-rect fallback AOSP itself uses when the background can't supply one.
const bgOutline = mkOutlineProvider((view, outline) => vcall(outline, "setRect", "(IIII)V", 0, 0, view.width(), view.height()));
rt.register({
  name: "android/view/ViewOutlineProvider", ctor: JViewOutlineProvider,
  methods: {
    "<init>()V": () => {},
    // abstract in AOSP — app subclasses override it; default no-op keeps a base-typed call safe.
    ["getOutline" + GET_OUTLINE_DESC]: () => {},
  },
  statics: {
    BACKGROUND: bgOutline,
    ALPHA: mkOutlineProvider(async (view, outline) => {
      await vcall(outline, "setRect", "(IIII)V", 0, 0, view.width(), view.height());
      await vcall(outline, "setAlpha", "(F)V", 1);
    }),
  },
});
class JDisplay extends JObj {}
function fillMetrics(dm: JDisplayMetrics, heightPx: number) {
  dm.density = device.density; dm.densityDpi = device.densityDpi; dm.scaledDensity = device.density;
  dm.widthPixels = device.width; dm.heightPixels = heightPx;
}
rt.register({
  name: "android/view/Display", ctor: JDisplay,
  methods: {
    "getWidth()I": () => device.width,
    // getMetrics excludes the system bars; getRealMetrics is the whole display
    "getHeight()I": () => device.height - device.statusBar,
    "getRotation()I": () => 0,
    "getMetrics(Landroid/util/DisplayMetrics;)V": (dm: JDisplayMetrics) => fillMetrics(dm, device.height - device.statusBar),
    "getRealMetrics(Landroid/util/DisplayMetrics;)V": (dm: JDisplayMetrics) => fillMetrics(dm, device.height),
    "getRefreshRate()F": () => 60,
    "getDisplayId()I": () => 0,
  },
});

// ── OrientationEventListener: the device is fixed portrait, so enable() never produces a
// rotation callback; canDetectOrientation() is honest about having an accelerometer.
class JOrientationEventListener extends JObj { enabled = 0; rate = 3; }
rt.register({
  name: "android/view/OrientationEventListener", ctor: JOrientationEventListener,
  statics: { ORIENTATION_UNKNOWN: -1 },
  methods: {
    "<init>(Landroid/content/Context;)V": function () {},
    "<init>(Landroid/content/Context;I)V": function (this: JOrientationEventListener, _c: unknown, rate: number) { this.rate = rate; },
    "enable()V": function (this: JOrientationEventListener) { this.enabled = 1; },
    "disable()V": function (this: JOrientationEventListener) { this.enabled = 0; },
    "canDetectOrientation()Z": () => 1,
    "onOrientationChanged(I)V": () => {},
  },
});
