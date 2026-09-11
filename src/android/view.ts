import { perf } from "../perf";
import { setInvalidateHook, JRect, JCanvas, JMatrix, matMul, rotM, type JPoint } from "./graphics";
import { mangleMethod, jmethod, type JMethod, jarray } from "../jvm/abi";
import { vcall, vcallMaybe, after, idHash } from "../jvm/natives/jlang";
import { type JDrawable, type JColorStateList, ST, loadDrawableRV, JColorDrawable, loadDrawable, cslColor } from "./drawable";
import { JMotionEvent } from "./motionevent";
import { JObj, rt, type NativeSpec, maySuspend, stubs, noops } from "../jvm/runtime";
import { type Resources, type JTheme, attrTable, type JAttrSet, obtainStyled, rvDimen, rvInt, rvString, askTheme } from "./res";
import { mainHandler, reportUncaught } from "./os";
import type { JDisplayMetrics } from "./util";
import { csText } from "./text";
import { device } from "../shell/config";
import { rootWindowInsets, type JWindowInsets, sysIns } from "./windowinsets";
import { mkVPA } from "./viewanimator";
import type { JContext } from "./context";
import { onMain, mainDbg } from "./mainloop";
import type { JWindow } from "./window";

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
  /** a traversal owes the tree an inset dispatch (requestApplyInsets, a new listener, a new
   *  top activity). One boolean test per frame when nothing asked. */
  needsInsets: true,
  needsDraw: true,
  /** the next pass must re-measure everything: a caller dirtied something it could not name */
  forceAll: true,
  frameCallbacks: [] as unknown[],
  animHooks: new Set<() => boolean>(), // ts-side animators; return false to remove
  /** the current frame's timestamp. AOSP's Choreographer computes this ONCE in doFrame and
   *  hands the same value to every callback; Compose's BroadcastFrameClock fans one timestamp
   *  to all withFrameNanos awaiters, so animations desync if callbacks see different times. */
  frameTimeNanos: 0n,
  frameIntervalNanos: 0n,
  /** debug only (wd.layoutTrace): requestLayout counts by requesting class, and by frame phase
   *  plus the two native frames that asked. Null costs one test per request. */
  layoutTrace: null as { cls: Record<string, number>; site: Record<string, number> } | null,
};
function traceLayoutRequest(t: NonNullable<typeof uiState.layoutTrace>, v: JView | null | undefined) {
  const cls = v ? ((v.constructor as { $i?: { name: string } }).$i?.name ?? v.constructor.name) : "(all)";
  t.cls[cls] = (t.cls[cls] ?? 0) + 1;
  // stack[0] is the message, [1] this function, [2] requestLayout; the callers follow
  const callers = (new Error().stack ?? "").split("\n").slice(3, 5).map((l) => /at (?:async )?([^\s(]+)/.exec(l)?.[1] ?? "?");
  const site = `${mainDbg.phase || "-"} ${callers.join("<")}`;
  t.site[site] = (t.site[site] ?? 0) + 1;
}
export function invalidate(v?: JView) {
  perf.invalidates++; uiState.needsDraw = true;
  if (v) descendantInvalidated(v, v);
}
const M_onDescInv = mangleMethod("onDescendantInvalidated", "(Landroid/view/View;Landroid/view/View;)V");
const M_requestLayout = mangleMethod("requestLayout", "()V");
/**
 * AOSP View.invalidate: parent.onDescendantInvalidated(child, target), each ViewGroup passing it
 * up. Only an overriding ancestor needs the call (Compose's AndroidViewHolder re-records the layer
 * its hosted view is baked into); the base walks on.
 */
function descendantInvalidated(child: JView, target: JView) {
  for (let p = child.parent; p; child = p, p = p.parent) {
    const f = jmethod(p, M_onDescInv);
    if (f && f !== nativeOnDescInv) { void guardApply(f as JMethod, p, child, target); return; }
  }
}
function nativeOnDescInv(this: JViewGroup, _child: JView, target: JView) { invalidate(); descendantInvalidated(this, target); }
function nativeRequestLayout(this: JView) { requestLayout(this); }
/** AOSP's addView and removeView call the parent's requestLayout() virtually: an override
 *  (RecyclerView defers while it binds or lays out) decides first */
export function requestLayoutVirtual(v: JView) {
  const f = jmethod(v, M_requestLayout);
  if (f && f !== nativeRequestLayout) void guardApply(f as JMethod, v);
  else requestLayout(v);
}
setInvalidateHook(invalidate);
let focusHook: (v: JView, on: boolean) => void = () => {};
export const setFocusHook = (h: typeof focusHook) => { focusHook = h; };
/** compat.ts owns android.view.animation; View.startAnimation hands it the view to drive */
let startViewAnim: (v: JView, a: unknown) => void = () => {};
export const setViewAnimHook = (h: typeof startViewAnim) => { startViewAnim = h; };
function takeFocus(v: JView) {
  v.focused = true;
  focusHook(v, true);
  focusMoved(v, v);
  return 1;
}
/** AOSP reports every focus transition to the root's observer; the tree-walk only runs when someone listens */
function focusMoved(v: JView, now: JView | null) {
  let root: JView = v;
  while (root.parent) root = root.parent;
  const o = vtoMap.get(root);
  if (!o || !o.focusLs.length) return;
  const old = o.focused === now ? null : o.focused;
  o.focused = now;
  void o.dispatchFocusChanged(old, now);
}
/**
 * Schedule a layout pass. Pass the view whose measurement went stale so the pass can skip
 * the clean parts of the tree (AOSP marks the view and walks UP to the root; children are
 * re-measured only when their parent hands them different specs).
 */
export function requestLayout(v: JView) {
  uiState.needsLayout = true; uiState.needsDraw = true;
  if (uiState.layoutTrace) traceLayoutRequest(uiState.layoutTrace, v);
  perf.layoutRequests++;
  if (layoutPass.active && v.attached && !layoutPass.requesters.includes(v)) layoutPass.requesters.push(v);
  for (let p: JView | null = v; p; p = p.parent) {
    p.layoutRequested = true;
    p.oldWSpec = -1;
    clearMeasureCache(p);
    // AOSP calls the parent's requestLayout() virtually: an override (Compose's AndroidViewHolder
    // asks its layout node to remeasure, DrawerLayout declines mid-layout) resumes the walk itself
    const par = p.parent;
    if (!par || par.layoutRequested) break;
    const f = jmethod(par, M_requestLayout);
    if (f && f !== nativeRequestLayout) { void guardApply(f as JMethod, par); break; }
  }
}
/** A configuration change (orientation, night mode, a relaunch), like boot, leaves every cached
 *  measurement stale, and no single view names that: the next pass re-measures every window. */
export function requestLayoutAll() {
  uiState.needsLayout = true; uiState.needsDraw = true; uiState.forceAll = true;
  perf.layoutRequestsAll++;
  if (uiState.layoutTrace) traceLayoutRequest(uiState.layoutTrace, null);
}
/**
 * AOSP ViewRootImpl.mLayoutRequesters. A requestLayout() made while the tree lays out stops at an
 * ancestor the pass has flagged, and that ancestor's layout then clears the flag, so the request
 * could vanish. Requests are collected only during layout (isInLayout): one made during measure
 * is served by the same pass's layout, which clears the requester's flag.
 */
export const layoutPass = { active: false, requesters: [] as JView[] };
/** ViewRootImpl.performLayout: a window root's layout, with in-layout requests collected */
export async function layoutRoot(v: JView, l: number, t: number, r: number, b: number) {
  layoutPass.active = true;
  try { await layoutView(v, l, t, r, b); } finally { layoutPass.active = false; }
}
const validRequesters: JView[] = [];
function shownPath(v: JView): boolean {
  for (let p: JView | null = v; p; p = p.parent) if (p.visibility === 8) return false;
  return true;
}
/**
 * AOSP getValidLayoutRequesters: only a requester whose flag survived the pass lost its request,
 * and only one still attached and not under a GONE ancestor asks again. Every requester's flagged
 * path is cleared first, so the new request marks it to the root. The repeat runs in the next
 * frame's pass rather than as a second pass in this one.
 */
export function replayLayoutRequests() {
  const rs = layoutPass.requesters;
  if (!rs.length) return;
  for (const r of rs) if (r.layoutRequested && r.attached && shownPath(r)) validRequesters.push(r);
  for (const r of rs) for (let p: JView | null = r; p && p.layoutRequested; p = p.parent) p.layoutRequested = false;
  rs.length = 0;
  for (const r of validRequesters) requestLayoutVirtual(r);
  validRequesters.length = 0;
}

const M_onMeasure = mangleMethod("onMeasure", "(II)V");
const M_performClick = mangleMethod("performClick", "()Z");

/** drop one registration of `l` (Android listener lists are identity sets) */
export function removeFrom(ls: unknown[], l: unknown) {
  const i = ls.indexOf(l);
  if (i >= 0) ls.splice(i, 1);
}
async function performClick(this: JView) {
  if (!this.clickL) return 0;
  await vcall(this.clickL, "onClick", "(Landroid/view/View;)V", this);
  return 1;
}
function setBackground(this: JView, d: JDrawable | null) {
  if (this.background) this.background.callback = null;
  this.background = d;
  // AOSP hands a fresh background the view's current state; without it a stateful drawable
  // paints its "no state at all" entry until something else happens to the view
  if (d) { d.callback = this; void this.refreshDrawableState(); }
  invalidate();
}
/** this view's origin in window coordinates */
function windowOffset(view: JView): [number, number] {
  let tx = 0, ty = 0;
  for (let v: JView | null = view; v; v = v.parent) { tx += v.left - v.scrollX + v.translationX; ty += v.top - v.scrollY + v.translationY; }
  return [tx, ty];
}
function removeChild(this: JViewGroup, c: JView) { detachView(this, c); }
function removeChildInLayout(this: JViewGroup, c: JView) { detachView(this, c, false); }
/** AOSP removeViews/removeAllViews: the children leave without requests and the parent asks
 *  once; the *InLayout forms do not ask at all */
function removeRange(vg: JViewGroup, start: number, n: number, request: boolean) {
  const gone = vg.children.slice(start, start + n);
  for (const c of gone) detachView(vg, c, false);
  if (request && gone.length) { requestLayoutVirtual(vg); invalidate(vg); }
}
/** AOSP addViewInLayout: addViewInner without the parent's request. Unless the caller prevents
 *  it, the child's own setLayoutParams asks, before the child has a parent to pass it to. */
async function addInLayout(this: JViewGroup, c: JView, i: number, lp: JLayoutParams, preventRequestLayout?: number) {
  c.lp = lp ? await convertLp(this, lp) : c.lp;
  if (!preventRequestLayout) requestLayoutVirtual(c);
  attachView(this, c, i, false);
  return 1;
}
/** AOSP attachViewToParent: re-links a child detachViewFromParent took out. It never left the
 *  window, so there is no attach dispatch, no hierarchy callback and no request. */
async function attachToParent(this: JViewGroup, c: JView, i: number, lp: JLayoutParams) {
  c.lp = lp ? await convertLp(this, lp) : c.lp;
  linkChild(this, c, i);
}
export function obtainEvent(dt: bigint, et: bigint, action: number, x: number, y: number, metaState = 0) {
  const e = new JMotionEvent();
  e.downTime = Number(dt); e.eventTime = Number(et); e.action = action; e.x = e.rawX = x; e.y = e.rawY = y;
  e.deviceId = 0; e.source = 2; e.size = 1; e.metaState = metaState; e.toolType = 0;
  return e;
}
export function copyEvent(src: JMotionEvent) {
  const e = new JMotionEvent();
  Object.assign(e, src);
  return e;
}
const M_performLongClick = mangleMethod("performLongClick", "()Z");
const M_onLayout = mangleMethod("onLayout", "(ZIIII)V");
const M_draw = mangleMethod("draw", "(Landroid/graphics/Canvas;)V");
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
const M_onCreateDrawableState = mangleMethod("onCreateDrawableState", "(I)[I");
const M_setBounds = mangleMethod("setBounds", "(IIII)V");

/** absolute position of v's top-left: translations applied, each ancestor's scroll removed */
export function locationOnScreen(v: JView): [number, number] {
  let x = 0, y = 0;
  for (let p: JView | null = v; p; p = p.parent) {
    x += p.left + p.translationX - (p.parent ? p.parent.scrollX : 0);
    y += p.top + p.translationY - (p.parent ? p.parent.scrollY : 0);
  }
  return [x, y];
}
/** AOSP: fills baseState's trailing zeros IN PLACE — callers ignore the return value */
function mergeStates(base: Int32Array, extra: Int32Array | null): Int32Array {
  if (!extra) return base;
  let i = base.length - 1;
  while (i >= 0 && base[i] === 0) i--;
  base.set(extra.subarray(0, base.length - i - 1), i + 1);
  return base;
}

export async function guardCall(self: unknown, mangled: string, ...args: unknown[]): Promise<any> {
  const r = (jmethod(self, mangled) as JMethod).apply(self, args);
  return r instanceof Promise ? await r : r;
}

export async function guardMaybe(self: unknown, mangled: string, ...args: unknown[]): Promise<any> {
  const fn = jmethod(self, mangled);
  if (!fn) return undefined;
  const r = fn.apply(self, args);
  return r instanceof Promise ? await r : r;
}

async function guardApply(fn: JMethod, self: unknown, ...args: unknown[]): Promise<any> {
  const r = fn.apply(self, args);
  return r instanceof Promise ? await r : r;
}

class JPointerIcon extends JObj { type = 0; }
const pointerIcons = new Map<number, JPointerIcon>();
rt.register({
  name: "android/view/PointerIcon", ctor: JPointerIcon, ifaces: ["android/os/Parcelable"],
  methods: {
    "static getSystemIcon(Landroid/content/Context;I)Landroid/view/PointerIcon;": (context: unknown, type: number) => {
      if (!context) throw rt.mkThrowable("java/lang/IllegalArgumentException", "context must not be null");
      let icon = pointerIcons.get(type);
      if (!icon) { icon = new JPointerIcon(); icon.type = type; pointerIcons.set(type, icon); }
      return icon;
    },
    "getType()I": function (this: JPointerIcon) { return this.type; },
  },
});

export class JView extends JObj {
  ctx: unknown = null;            // android Context
  jres: Resources | null = null;
  theme: JTheme | null = null;
  parent: JView | null = null;
  attached = false;
  windowOwner: JWindow | null = null;

  idNum = -1;
  /** android:contentDescription — the label an icon-only control answers to */
  contentDesc: string | null = null;
  /** nested scrolling: AOSP defaults this on for ScrollView/RecyclerView-shaped children,
   *  and the accepted parent is remembered for the life of one gesture */
  nestedEnabled = true;
  nestedParent: JView | null = null;
  tag: unknown = null;
  keyedTags = new Map<number, unknown>();
  outlineProvider: unknown = null;
  stateListAnimator: unknown = null;
  keyboardCluster = false;
  touchBlocksFocus = false;
  pointerIcon: JPointerIcon | null = null;
  left = 0; top = 0; right = 0; bottom = 0;
  static $nextDrawingId = 0;
  measuredW = 0; measuredH = 0;
  oldWSpec = -1; oldHSpec = -1;
  /** AOSP mMeasureCache: up to three spec pairs and the sizes they produced, [w, h, mw, mh] each,
   *  so a parent measuring a child under alternating specs does not re-run its onMeasure.
   *  Emptied wherever the old specs are reset, as AOSP's requestLayout/forceLayout clear it. */
  mc: Float64Array | null = null;
  mcLen = 0; mcNext = 0;
  /** AOSP PFLAG3_MEASURE_NEEDED_BEFORE_LAYOUT: the cache answered the last measure, so this
   *  view's children may hold another spec's sizes; layout re-runs onMeasure first */
  measureBeforeLayout = false;
  padL = 0; padT = 0; padR = 0; padB = 0;
  minW = 0; minH = 0;
  lp: JLayoutParams | null = null;
  visibility = 0;                  // 0 visible, 4 invisible, 8 gone
  background: JDrawable | null = null;
  foreground: JDrawable | null = null;
  /** a SurfaceView's surface: composited behind the view's own drawing, like SurfaceFlinger does */
  surfaceLayer: OffscreenCanvas | ImageBitmap | VideoFrame | null = null;
  alphaV = 1;
  scrollX = 0; scrollY = 0;
  translationX = 0; translationY = 0; translationZ = 0;
  scaleXv = 1; scaleYv = 1;
  rotationV = 0;
  pivotXv: number | null = null; pivotYv: number | null = null;
  clickable = false; longClickable = false;
  enabled = true; pressed = false; selected = false; activated = false; focused = false;
  focusable = false; focusableInTouchMode = false;
  autoHandwritingEnabled = true;
  clickL: unknown = null; longClickL: unknown = null; touchL: unknown = null; keyL: unknown = null; focusL: unknown = null;
  insetsL: unknown = null; a11yDelegate: unknown = null; dragL: unknown = null;
  fitsSys = false;
  overlay: JViewOverlay | null = null;
  layoutChangeLs: unknown[] = [];
  attachLs: unknown[] = [];
  layoutRequested = true;
  /** AOSP PFLAG_LAYOUT_REQUIRED: set when onMeasure ran, cleared when onLayout consumed it */
  layoutRequired = true;
  overScrollMode = 0;
  layerType = 0;
  elevationV = 0;
  longPressTimer: ReturnType<typeof setTimeout> | null = null;
  transientState = 0; textAlignment = 1;
  clipBounds: JRect | null = null; bgTint: JColorStateList | null = null;
  tooltip: unknown = null;
  win: unknown = null; // ViewRootImpl-ish owner
  /** an offscreen canvas when layerType asks for one (see drawLayered) */
  layerCanvas: OffscreenCanvas | null = null;
  /** the running android.view.animation.Animation and the transformation it last produced */
  jAnim: unknown = null;
  animTf: { alpha: number; matrix: { m: number[] } } | null = null;

  width(): number { return this.right - this.left; }
  height(): number { return this.bottom - this.top; }

  /** the states this view contributes itself; a TS subclass adds its own on top */
  baseState(): number[] {
    const st: number[] = [ST.window_focused];
    if (this.enabled) st.push(ST.enabled);
    if (this.pressed) st.push(ST.pressed);
    if (this.selected) st.push(ST.selected);
    if (this.activated) st.push(ST.activated);
    if (this.focused) st.push(ST.focused);
    return st;
  }
  /** AOSP's cached mDrawableState — what onCreateDrawableState last produced, app states included */
  stateCache: number[] | null = null;
  drawableState(): number[] { return this.stateCache ?? this.baseState(); }
  async refreshDrawableState() {
    // through the virtual onCreateDrawableState: state_checked/checkable/error live only in
    // the app's override (every Material toggle is one), and nothing else ever sees them
    this.stateCache = null;
    const raw = await guardMaybe(this, M_onCreateDrawableState, 0) as Int32Array | null;
    const st = raw ? [...raw].filter((x) => x !== 0) : this.baseState();
    this.stateCache = st;
    if (this.background) await vcall(this.background, "setState", "([I)Z", Int32Array.from(st));
    await guardMaybe(this, M_drawableStateChanged);
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

const AT = attrTable(
  "id", "tag", "background", "padding", "paddingLeft", "paddingTop", "paddingRight", "paddingBottom",
  "paddingStart", "paddingEnd", "layout_width", "layout_height", "layout_margin", "layout_marginLeft",
  "layout_marginTop", "layout_marginRight", "layout_marginBottom", "layout_marginStart",
  "layout_marginEnd", "layout_gravity", "layout_weight", "gravity", "orientation", "visibility",
  "clickable", "enabled", "minWidth", "minHeight", "alpha", "focusable", "scaleType", "src",
  "contentDescription", "weightSum", "divider", "showDividers", "dividerPadding", "fillViewport",
  "scrollbars", "fadeScrollbars", "clipToPadding", "clipChildren", "descendantFocusability",
  "foreground", "duplicateParentState", "baselineAligned", "autoHandwritingEnabled");
// ── ViewOverlay: a drawing layer over the host's content. AOSP keeps an internal ViewGroup for
// it; ours holds the two lists the host's draw pass walks, which is all anything reads back.
class JViewOverlay extends JObj {
  drawables: JDrawable[] = [];
  views: JView[] = [];
  constructor(public host: JView) { super(); }
}
rt.register({
  name: "android/view/ViewOverlay", ctor: JViewOverlay,
  methods: {
    "add(Landroid/graphics/drawable/Drawable;)V": function (this: JViewOverlay, d: JDrawable) {
      if (!this.drawables.includes(d)) { this.drawables.push(d); invalidate(); }
    },
    "remove(Landroid/graphics/drawable/Drawable;)V": function (this: JViewOverlay, d: JDrawable) {
      removeFrom(this.drawables, d); invalidate();
    },
    "clear()V": function (this: JViewOverlay) { this.drawables.length = 0; this.views.length = 0; invalidate(); },
  },
});
class JViewGroupOverlay extends JViewOverlay {}
rt.register({
  name: "android/view/ViewGroupOverlay", ctor: JViewGroupOverlay, sup: "android/view/ViewOverlay",
  methods: {
    // an overlay view is laid out by whoever put it there, so it keeps the bounds it arrives with
    "add(Landroid/view/View;)V": async function (this: JViewOverlay, v: JView) {
      if (this.views.includes(v)) return;
      this.views.push(v);
      if (this.host.attached) await dispatchAttached(v);
      invalidate();
    },
    "remove(Landroid/view/View;)V": function (this: JViewOverlay, v: JView) { removeFrom(this.views, v); invalidate(); },
  },
});
/** every window here is the one framebuffer, so one token answers for all of them */
class JWindowId extends JObj {}
const WINDOW_ID = new JWindowId();
rt.register({ name: "android/view/WindowId", ctor: JWindowId });

/** AOSP View.dispatchApplyWindowInsets: a listener wins outright, otherwise the virtual
 *  onApplyWindowInsets. ViewGroup's override calls this as its super. */
async function viewDispatchInsets(this: JView, ins: unknown) {
  if (this.insetsL) {
    return await vcall(this.insetsL, "onApplyWindowInsets",
      "(Landroid/view/View;Landroid/view/WindowInsets;)Landroid/view/WindowInsets;", this, ins);
  }
  return await vcall(this, "onApplyWindowInsets", "(Landroid/view/WindowInsets;)Landroid/view/WindowInsets;", ins);
}

/** apply base View attrs from an AttributeSet (used by native View ctor) */
// defStyleAttr is the widget's own style attribute (buttonStyle, editTextStyle, ...). Without it
// tiers 3 and 4 of the cascade are dead for every base-View attribute, which is why a Button had
// to be handed a background in TypeScript instead of resolving Widget.Material.Button's.
async function applyViewAttrs(v: JView, set: JAttrSet | null, defStyleAttr = 0) {
  if (!v.jres || (!set?.node && !defStyleAttr)) return;
  const res = v.jres;
  const ta = obtainStyled(res, v.theme, set, [
    AT.id, AT.background, AT.padding, AT.paddingLeft, AT.paddingTop, AT.paddingRight, AT.paddingBottom,
    AT.visibility, AT.clickable, AT.enabled, AT.minWidth, AT.minHeight, AT.alpha, AT.focusable,
    AT.paddingStart, AT.paddingEnd, AT.tag, AT.contentDescription, AT.autoHandwritingEnabled,
  ], defStyleAttr, 0);
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
  if (g(17)) v.contentDesc = rvString(res, g(17));
  if (g(18)) v.autoHandwritingEnabled = !!rvInt(res, g(18), 1);
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

export function clearMeasureCache(v: JView) { v.mcLen = v.mcNext = 0; }
function measureCacheFind(v: JView, wSpec: number, hSpec: number): number {
  const c = v.mc!;
  for (let i = 0; i < v.mcLen * 4; i += 4) if (c[i] === wSpec && c[i + 1] === hSpec) return i;
  return -1;
}
function measureCachePut(v: JView, wSpec: number, hSpec: number) {
  const c = v.mc ??= new Float64Array(12);
  let i = measureCacheFind(v, wSpec, hSpec);
  if (i < 0) {
    i = v.mcNext * 4;
    v.mcNext = (v.mcNext + 1) % 3;
    if (v.mcLen < 3) v.mcLen++;
  }
  c[i] = wSpec; c[i + 1] = hSpec; c[i + 2] = v.measuredW; c[i + 3] = v.measuredH;
}
/** AOSP View.sAlwaysRemeasureExactly: an app targeting M (23) or lower re-measures under a changed
 *  EXACTLY spec even at the size it already has; its LinearLayout weights relied on that pass */
let alwaysRemeasureExactly = false;
export function setAlwaysRemeasureExactly(on: boolean) { alwaysRemeasureExactly = on; }
export async function measureView(v: JView, wSpec: number, hSpec: number) {
  // AOSP View.measure: with no forced layout and identical specs the previous measurement
  // still holds. Without this every pass re-measured the whole tree from the root.
  if (!v.layoutRequested) {
    if (wSpec === v.oldWSpec && hSpec === v.oldHSpec) return;
    // AOSP: a changed spec that is EXACTLY the size the view already measures needs no measure
    if (!alwaysRemeasureExactly && specMode(wSpec) === MS_EXACTLY && specMode(hSpec) === MS_EXACTLY &&
        v.measuredW === specSize(wSpec) && v.measuredH === specSize(hSpec)) {
      v.oldWSpec = wSpec; v.oldHSpec = hSpec;
      measureCachePut(v, wSpec, hSpec);
      perf.exactSkips++;
      return;
    }
    // a spec pair this view already measured under since its last request: the size it produced
    const i = v.mcLen ? measureCacheFind(v, wSpec, hSpec) : -1;
    if (i >= 0) {
      const c = v.mc!;
      v.oldWSpec = wSpec; v.oldHSpec = hSpec;
      v.measuredW = c[i + 2]; v.measuredH = c[i + 3];
      v.measureBeforeLayout = true;
      v.layoutRequired = true;
      perf.measureCacheHits++;
      return;
    }
  }
  v.oldWSpec = wSpec; v.oldHSpec = hSpec;
  perf.onMeasures++;
  try {
    await guardCall(v, M_onMeasure, wSpec, hSpec);
    v.layoutRequired = true;   // AOSP sets PFLAG_LAYOUT_REQUIRED whenever onMeasure runs
    v.measureBeforeLayout = false;
    measureCachePut(v, wSpec, hSpec);
  } catch (e) {
    v.oldWSpec = -1;
    clearMeasureCache(v);
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
  if (r - l !== ow || b - t !== oh) void guardMaybe(v, M_onSizeChanged, r - l, b - t, ow, oh);
  for (const ll of [...v.layoutChangeLs]) {
    void vcall(ll, "onLayoutChange", "(Landroid/view/View;IIIIIIII)V", v, l, t, r, b, oldL, oldT, oldR, oldB);
  }
}

export async function layoutView(v: JView, l: number, t: number, r: number, b: number) {
  // AOSP View.layout: a measure the cache answered left the children as the last onMeasure did
  if (v.measureBeforeLayout) {
    v.measureBeforeLayout = false;
    perf.onMeasures++;
    await guardCall(v, M_onMeasure, v.oldWSpec, v.oldHSpec);
  }
  const oldL = v.left, oldT = v.top, oldR = v.right, oldB = v.bottom;
  const changed = oldL !== l || oldT !== t || oldR !== r || oldB !== b;
  const ow = v.width(), oh = v.height();
  v.left = l; v.top = t; v.right = r; v.bottom = b;
  if ((r - l !== v.measuredW || b - t !== v.measuredH) && v.measuredW > 0 && v.measuredH > 0) perf.layoutMismatch++;
  if (changed) {
    await guardMaybe(v, M_onSizeChanged, r - l, b - t, ow, oh);
  }
  // AOSP View.layout: onLayout runs only when the frame moved or a measure re-ran
  // (PFLAG_LAYOUT_REQUIRED). Without the gate every pass walked the whole tree laying out
  // children the measure memo had just skipped, which is what made settle passes cost.
  if (changed || v.layoutRequired) {
    await guardCall(v, M_onLayout, changed ? 1 : 0, l, t, r, b);
    v.layoutRequired = false;
  }
  v.layoutRequested = false;
  // AOSP only notifies OnLayoutChangeListener when the bounds actually moved
  if (changed) {
    for (const ll of [...v.layoutChangeLs]) {
      await vcall(ll, "onLayoutChange", "(Landroid/view/View;IIIIIIII)V", v, l, t, r, b, oldL, oldT, oldR, oldB);
    }
  }
}

/** full draw of the subtree onto ctx (already positioned at parent's content origin) */
const M_computeScroll = mangleMethod("computeScroll", "()V");
const M_drawableDraw = mangleMethod("draw", "(Landroid/graphics/Canvas;)V");
const noopComputeScroll = () => {};
/** AOSP drawChild: a child the parent's clip rejects is not drawn at all, unless a transform or
 *  an animation could move it into view. An off-screen ViewPager page never runs its onDraw, so
 *  a spinner on it cannot keep the whole window repainting. */
const clipRejects = (p: JViewGroup, v: JView): boolean =>
  p.clipChildren && !v.jAnim && !v.animTf && !v.translationX && !v.translationY && !v.rotationV && v.scaleXv === 1 && v.scaleYv === 1 &&
  (v.right - p.scrollX <= 0 || v.bottom - p.scrollY <= 0 || v.left - p.scrollX >= p.width() || v.top - p.scrollY >= p.height());
export async function drawView(v: JView, cv: JCanvas, parent?: JViewGroup) {
  if (v.visibility !== 0) return;
  // Android calls computeScroll() before drawing each child — drives Scroller
  // animations (ViewPager page snaps, OverScroller flings)
  const cs = jmethod(v, M_computeScroll);
  if (cs && cs !== noopComputeScroll) await guardApply(cs, v);
  if (parent && clipRejects(parent, v)) { perf.viewsRejected++; return; }
  perf.viewsDrawn++;
  const ctx = cv.ctx;
  // AOSP View.draw() brackets the whole thing with getSaveCount()/restoreToCount(): a view
  // that throws between save() and restore() must not leave its clip on the shared context,
  // or every later frame inherits a dead frame's clip and the screen stays blank.
  const sc = cv.saveCount;
  ctx.save();
  try {
    ctx.translate(v.left + v.translationX, v.top + v.translationY);
    if (v.alphaV < 1) ctx.globalAlpha *= v.alphaV;
    const tf = v.animTf;
    if (tf) {
      if (tf.alpha < 1) ctx.globalAlpha *= tf.alpha;
      const m = tf.matrix.m;
      if (m[0] !== 1 || m[1] !== 0 || m[2] !== 0 || m[3] !== 1 || m[4] !== 0 || m[5] !== 0) ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    }
    if (v.rotationV || v.scaleXv !== 1 || v.scaleYv !== 1) {
      const px = v.pivotXv ?? v.width() / 2, py = v.pivotYv ?? v.height() / 2;
      ctx.translate(px, py);
      if (v.rotationV) ctx.rotate(v.rotationV * Math.PI / 180);
      ctx.scale(v.scaleXv, v.scaleYv);
      ctx.translate(-px, -py);
    }
    // A view with a layer composites its own pixels separately, which is the whole point of
    // asking for one: ShapeableImageView draws its mask with a DST_OUT paint that must erase
    // the image and nothing underneath it.
    const w = v.width(), h = v.height();
    if (v.layerType && w > 0 && h > 0) await drawLayered(v, cv, w, h);
    else {
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.clip();
      await drawSelf(v, cv);
    }
  } catch (e) {
    perf.drawErrors++;
    noteDrawError(v, e);
  } finally {
    while (cv.saveCount > sc) { ctx.restore(); cv.saveCount--; }
    ctx.restore();
  }
}

async function drawLayered(v: JView, cv: JCanvas, w: number, h: number) {
  let layer = v.layerCanvas;
  if (!layer || layer.width !== w || layer.height !== h) layer = v.layerCanvas = new OffscreenCanvas(w, h);
  const lctx = layer.getContext("2d") as OffscreenCanvasRenderingContext2D;
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.globalCompositeOperation = "source-over";
  lctx.globalAlpha = 1;
  lctx.clearRect(0, 0, w, h);
  const lcv = JCanvas.wrap(lctx, w, h);
  await drawSelf(v, lcv);
  cv.ctx.drawImage(layer, 0, 0);
}

/**
 * AOSP's View.draw(Canvas) is a public method widgets override — TextInputLayout paints its
 * label and box there and calls super — so the traversal goes through the override when there
 * is one, and straight to the base body when there is not.
 */
const baseDraw = maySuspend(function (this: JView, cv: JCanvas) { return drawContent(this, cv); });
function drawSelf(v: JView, cv: JCanvas): Promise<void> {
  const fn = jmethod(v, M_draw);
  return fn && fn !== baseDraw ? guardApply(fn, v, cv) : drawContent(v, cv);
}
/** the view's own painting, in its own coordinate space: background, content, children, overlay */
async function drawContent(v: JView, cv: JCanvas) {
  const ctx = cv.ctx;
  if (v.surfaceLayer) {
    const recorder = ctx as typeof ctx & { __isRecorder?: boolean; __record?: (draw: (target: typeof ctx) => void) => void };
    // A surface's current frame can be replaced and closed before this display list replays.
    if (recorder.__isRecorder) recorder.__record!((target) => {
      if (v.surfaceLayer) target.drawImage(v.surfaceLayer, 0, 0, v.width(), v.height());
    });
    else ctx.drawImage(v.surfaceLayer, 0, 0, v.width(), v.height());
  }
  else if (v.background) {
    // through setBounds, not the fields: AOSP's onBoundsChange is where wrapper/shape drawables
    // (and app subclasses) rebuild their geometry, and it only fires on a real change
    await guardCall(v.background, M_setBounds, 0, 0, v.width(), v.height());
    await guardCall(v.background, M_drawableDraw, cv);
  }
  ctx.translate(-v.scrollX, -v.scrollY);
  await guardMaybe(v, M_onDraw, cv);
  await guardMaybe(v, M_dispatchDraw, cv);
  if (v.overlay) await drawOverlay(v.overlay, cv);
}

/** AOSP: a ViewGroup's overlay can host views, a plain View's only drawables */
function overlayOf(this: JView) {
  return (this.overlay ??= this instanceof JViewGroup ? new JViewGroupOverlay(this) : new JViewOverlay(this));
}

/** AOSP draws the overlay last, over the host's own content and children */
async function drawOverlay(o: JViewOverlay, cv: JCanvas) {
  for (const d of o.drawables) await guardCall(d, M_drawableDraw, cv);
  for (const v of o.views) await drawView(v, cv);
}

/** One log line per offending view class: a broken subtree must not log 60x a second. */
const drawErrSeen = new Set<string>();
function noteDrawError(v: JView, e: unknown) {
  const k = (v as any).constructor?.$i?.name ?? "?";
  if (drawErrSeen.has(k)) return;
  drawErrSeen.add(k);
  console.error("[draw]", k, e);
}

function drawingRect(this: JView, r: JRect) {
  r.left = this.scrollX; r.top = this.scrollY;
  r.right = this.scrollX + this.width(); r.bottom = this.scrollY + this.height();
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
  "setPadding(IIII)V": setPadding,
  "setPaddingRelative(IIII)V": setPadding,
  "setMinimumWidth(I)V": function (this: JView, v: number) { this.minW = v; },
  "setMinimumHeight(I)V": function (this: JView, v: number) { this.minH = v; },
  "getMinimumWidth()I": function (this: JView) { return this.minW; },
  "getMinimumHeight()I": function (this: JView) { return this.minH; },
  "getLayoutParams()Landroid/view/ViewGroup$LayoutParams;": function (this: JView) { return this.lp; },
  "setLayoutParams(Landroid/view/ViewGroup$LayoutParams;)V": maySuspend(function (this: JView, lp: JLayoutParams) {
    this.lp = lp;
    requestLayout(this);
    return resolveLp(lp);
  }),
  "getVisibility()I": function (this: JView) { return this.visibility; },
  "setVisibility(I)V": function (this: JView, v: number) {
    if (this.visibility !== v) { this.visibility = v; requestLayout(this); invalidate(this); }
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
  "isLongClickable()Z": function (this: JView) { return this.longClickable ? 1 : 0; },
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
  "setAutoHandwritingEnabled(Z)V": function (this: JView, enabled: number) { this.autoHandwritingEnabled = !!enabled; },
  "isAutoHandwritingEnabled()Z": function (this: JView) { return this.autoHandwritingEnabled ? 1 : 0; },
  "requestFocus()Z": function (this: JView) { return takeFocus(this); },
  "findFocus()Landroid/view/View;": function (this: JView) { return this.focused ? this : null; },
  "clearFocus()V": function (this: JView) { this.focused = false; focusHook(this, false); focusMoved(this, null); },
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
  "measure(II)V": maySuspend(function (this: JView, w: number, h: number) { return measureView(this, w, h); }),
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
  "layout(IIII)V": maySuspend(function (this: JView, l: number, t: number, r: number, b: number) {
    return layoutView(this, l, t, r, b);
  }),
  // AOSP's own body: background, content, children, foreground — at the canvas origin, with
  // the transform and clip left to whoever is drawing this view.
  "draw(Landroid/graphics/Canvas;)V": baseDraw,
  "invalidate()V": function (this: JView) { invalidate(this); },
  "invalidate(IIII)V": function (this: JView) { invalidate(this); },
  "invalidate(Landroid/graphics/Rect;)V": function (this: JView) { invalidate(this); },
  "postInvalidate()V": function (this: JView) { invalidate(this); },
  "postInvalidateOnAnimation()V": function (this: JView) { invalidate(this); },
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
    mainHandler().post(r, Math.max(0, Number(when) - performance.now()));
  },
  "unscheduleDrawable(Landroid/graphics/drawable/Drawable;Ljava/lang/Runnable;)V": function (_d: unknown, r: unknown) { mainHandler().cancel(r); },
  // AOSP's 1-arg form cancels everything scheduled by that drawable. Compose's
  // AndroidComposeView calls it; without the overload the whole draw pass threw.
  "unscheduleDrawable(Landroid/graphics/drawable/Drawable;)V": () => {},
  // AOSP marks this view and walks UP to the root, stopping at the first ancestor already
  // requesting. Calling the helper with no view took the "caller could not name a view"
  // branch instead, forcing a full-tree re-measure -- on every androidx/Compose relayout,
  // which is the one path that reaches here. Do NOT pre-set layoutRequested: the helper's
  // walk breaks at the first marked node, so marking `this` first would skip the ancestors.
  "requestLayout()V": nativeRequestLayout,
  "forceLayout()V": function (this: JView) { this.layoutRequested = true; clearMeasureCache(this); },
  "isLayoutRequested()Z": function (this: JView) { return this.layoutRequested ? 1 : 0; },
  "post(Ljava/lang/Runnable;)Z": function (r: unknown) { return mainHandler().post(r, 0); },
  "postDelayed(Ljava/lang/Runnable;J)Z": function (r: unknown, d: bigint) { return mainHandler().post(r, Number(d)); },
  "removeCallbacks(Ljava/lang/Runnable;)Z": function (r: unknown) { mainHandler().cancel(r); return 1; },
  "postOnAnimation(Ljava/lang/Runnable;)V": function (this: JView, r: unknown) {
    uiState.frameCallbacks.push({ run: r });
  },
  "getDrawableState()[I": function (this: JView) { return Int32Array.from(this.drawableState()); },
  "refreshDrawableState()V": function (this: JView) { return this.refreshDrawableState(); },
  "dispatchConfigurationChanged(Landroid/content/res/Configuration;)V": function (this: JView, cfg: unknown) {
    return dispatchConfigurationChanged(this, cfg);
  },
  "isAttachedToWindow()Z": function (this: JView) { return this.attached ? 1 : 0; },
  "getWindowToken()Landroid/os/IBinder;": function (this: JView) { return this.attached ? this : null; },
  "getApplicationWindowToken()Landroid/os/IBinder;": function (this: JView) { return this; },
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
  "setLayerType(ILandroid/graphics/Paint;)V": function (this: JView, t: number) { this.layerType = t; },
  "getLayerType()I": function (this: JView) { return this.layerType; },
  "setContentDescription(Ljava/lang/CharSequence;)V": async function (this: JView, cs: unknown) { this.contentDesc = cs === null ? null : await csText(cs); },
  "getContentDescription()Ljava/lang/CharSequence;": function (this: JView) { return this.contentDesc; },
  "setAccessibilityDelegate(Landroid/view/View$AccessibilityDelegate;)V": function (this: JView, d: unknown) { this.a11yDelegate = d; },
  "getAccessibilityDelegate()Landroid/view/View$AccessibilityDelegate;": function (this: JView) { return this.a11yDelegate; },
  "setStateListAnimator(Landroid/animation/StateListAnimator;)V": async function (this: JView, sla: unknown) {
    this.stateListAnimator = sla;
    if (sla) await vcall(sla, "setTarget", "(Landroid/view/View;)V", this);
  },
  "getStateListAnimator()Landroid/animation/StateListAnimator;": function (this: JView) { return this.stateListAnimator; },
  "setKeyboardNavigationCluster(Z)V": function (this: JView, v: number) { this.keyboardCluster = !!v; },
  "setTouchscreenBlocksFocus(Z)V": function (this: JView, v: number) { this.touchBlocksFocus = !!v; },
  "getTouchscreenBlocksFocus()Z": function (this: JView) { return this.touchBlocksFocus ? 1 : 0; },
  "isKeyboardNavigationCluster()Z": function (this: JView) { return this.keyboardCluster ? 1 : 0; },
  "setOutlineProvider(Landroid/view/ViewOutlineProvider;)V": function (this: JView, p: unknown) { this.outlineProvider = p; },
  "getOutlineProvider()Landroid/view/ViewOutlineProvider;": function (this: JView) { return this.outlineProvider ?? bgOutline; },
  "setPointerIcon(Landroid/view/PointerIcon;)V": function (this: JView, icon: JPointerIcon | null) { this.pointerIcon = icon; },
  "getPointerIcon()Landroid/view/PointerIcon;": function (this: JView) { return this.pointerIcon; },
  "onResolvePointerIcon(Landroid/view/MotionEvent;I)Landroid/view/PointerIcon;": function (this: JView) { return this.pointerIcon; },
  // AOSP asks the delegate first, then performs the standard actions itself. The two
  // accessibility-focus actions belong to a running accessibility service; there is none here,
  // so they report the same false a device with the screen reader off reports.
  "performAccessibilityAction(ILandroid/os/Bundle;)Z": maySuspend(function (this: JView, action: number, args: unknown) {
    if (this.a11yDelegate) {
      return vcall(this.a11yDelegate, "performAccessibilityAction", "(Landroid/view/View;ILandroid/os/Bundle;)Z", this, action, args);
    }
    switch (action) {
      case 0x01: return this.focusable && !this.focused ? takeFocus(this) : 0;   // ACTION_FOCUS
      case 0x02: if (!this.focused) return 0; return after(vcallMaybe(this, "clearFocus", "()V"), () => 1);
      case 0x04: case 0x08: return after(vcallMaybe(this, "setSelected", "(Z)V", action === 0x04 ? 1 : 0), () => 1);
      case 0x10: return this.clickable ? guardCall(this, M_performClick) : 0;
      case 0x20: return this.longClickable ? vcall(this, "performLongClick", "()Z") : 0;
    }
    return 0;
  }),
  // the system UI never changes underneath the app here, so the listener has nothing to hear
  "setOnSystemUiVisibilityChangeListener(Landroid/view/View$OnSystemUiVisibilityChangeListener;)V": () => {},
  "setFitsSystemWindows(Z)V": function (this: JView, on: number) { this.fitsSys = !!on; },
  "requestApplyInsets()V": () => { uiState.needsInsets = true; },
  // registering a listener is the moment an app declares interest, and it usually happens after
  // the first traversal has already dispatched — re-arm so this listener sees one too
  "setOnApplyWindowInsetsListener(Landroid/view/View$OnApplyWindowInsetsListener;)V": function (this: JView, l: unknown) {
    this.insetsL = l;
    uiState.needsInsets = true;
  },
  "setOverScrollMode(I)V": function (this: JView, m: number) { this.overScrollMode = m; },
  "getOverScrollMode()I": function (this: JView) { return this.overScrollMode; },
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
            await guardCall(this, M_performLongClick);
          }, 450);
        }
        return 1;
      case 2: { // MOVE
        const slop = device.dp(10);
        if (ev.x < -slop || ev.y < -slop || ev.x > this.width() + slop || ev.y > this.height() + slop) {
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
          await guardCall(this, M_performClick);
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
    return await guardCall(this, M_onTouchEvent, ev);
  },
  // Pointer events already enter the main queue as they arrive, without frame batching.
  "requestUnbufferedDispatch(Landroid/view/MotionEvent;)V": () => {},
  "requestDisallowInterceptTouchEvent(Z)V": function (this: JView, dis: number) {
    let v: JView | null = this.parent;
    while (v) { (v as any).disallowIntercept = !!dis; v = v.parent; }
  },
  "cancelLongPress()V": function (this: JView) {
    if (this.longPressTimer) { clearTimeout(this.longPressTimer); this.longPressTimer = null; }
  },
  // ── nested scrolling, child half (AOSP View). A scrolling child offers each scroll to its
  // parents first; a CoordinatorLayout Behavior is how a collapsing app bar, a bottom sheet or
  // a swipe-refresh consumes it. androidx's helpers fall back to these framework methods
  // whenever the parent is not one of its own interfaces.
  "setNestedScrollingEnabled(Z)V": function (this: JView, v: number) { this.nestedEnabled = !!v; },
  "isNestedScrollingEnabled()Z": function (this: JView) { return this.nestedEnabled ? 1 : 0; },
  "startNestedScroll(I)Z": async function (this: JView, axes: number) {
    if (this.nestedParent) return 1;
    if (!this.nestedEnabled) return 0;
    for (let p: JView | null = this.parent; p; p = p.parent) {
      if (await vcall(p, "onStartNestedScroll", "(Landroid/view/View;Landroid/view/View;I)Z", this, this, axes)) {
        this.nestedParent = p;
        await vcall(p, "onNestedScrollAccepted", "(Landroid/view/View;Landroid/view/View;I)V", this, this, axes);
        return 1;
      }
    }
    return 0;
  },
  "stopNestedScroll()V": async function (this: JView) {
    const p = this.nestedParent;
    this.nestedParent = null;
    if (p) await vcall(p, "onStopNestedScroll", "(Landroid/view/View;)V", this);
  },
  "hasNestedScrollingParent()Z": function (this: JView) { return this.nestedParent ? 1 : 0; },
  "dispatchNestedPreScroll(II[I[I)Z": async function (this: JView, dx: number, dy: number, consumed: Int32Array | null, offset: Int32Array | null) {
    const p = this.nestedParent;
    if (!p || (!dx && !dy)) { if (offset) { offset[0] = 0; offset[1] = 0; } return 0; }
    const c = consumed ?? new Int32Array(2);
    c[0] = 0; c[1] = 0;
    await vcall(p, "onNestedPreScroll", "(Landroid/view/View;II[I)V", this, dx, dy, c);
    if (offset) { offset[0] = 0; offset[1] = 0; }
    return c[0] !== 0 || c[1] !== 0 ? 1 : 0;
  },
  "dispatchNestedScroll(IIII[I)Z": async function (this: JView, dxc: number, dyc: number, dxu: number, dyu: number, offset: Int32Array | null) {
    const p = this.nestedParent;
    if (offset) { offset[0] = 0; offset[1] = 0; }
    if (!p || (!dxc && !dyc && !dxu && !dyu)) return 0;
    await vcall(p, "onNestedScroll", "(Landroid/view/View;IIII)V", this, dxc, dyc, dxu, dyu);
    return 1;
  },
  "dispatchNestedPreFling(FF)Z": async function (this: JView, vx: number, vy: number) {
    const p = this.nestedParent;
    return p ? await vcall(p, "onNestedPreFling", "(Landroid/view/View;FF)Z", this, vx, vy) : 0;
  },
  "dispatchNestedFling(FFZ)Z": async function (this: JView, vx: number, vy: number, consumed: number) {
    const p = this.nestedParent;
    return p ? await vcall(p, "onNestedFling", "(Landroid/view/View;FFZ)Z", this, vx, vy, consumed) : 0;
  },
  "computeScroll()V": noopComputeScroll,
  "setFocusable(I)V": function (this: JView, v: number) { this.focusable = v === 1; },
  // No drag gesture is ever dispatched (no drag-and-drop pipeline exists), so this only stores
  // the listener for parity with the other setOn*Listener setters -- nothing ever calls it.
  "setOnDragListener(Landroid/view/View$OnDragListener;)V": function (this: JView, l: unknown) { this.dragL = l; },
  // Compose pairs this with the setter above and calls it on detach — which only happens once
  // something actually destroys a view hierarchy.
  "clearViewTranslationCallback()V": () => {},
  "getUniqueDrawingId()J": function (this: JView) { return BigInt((this as unknown as { $udid?: number }).$udid ??= ++JView.$nextDrawingId); },
  "transformMatrixToGlobal(Landroid/graphics/Matrix;)V": maySuspend(function (this: JView, m: unknown) {
    const [tx, ty] = windowOffset(this);
    void vcall(m, "postTranslate", "(FF)Z", tx, ty);
  }),
  "transformMatrixToLocal(Landroid/graphics/Matrix;)V": maySuspend(function (this: JView, m: unknown) {
    const [tx, ty] = windowOffset(this);
    void vcall(m, "postTranslate", "(FF)Z", -tx, -ty);
  }),
  "getAutofillId()Landroid/view/autofill/AutofillId;": () => rt.make("android/view/autofill/AutofillId"),
  "hasOnClickListeners()Z": function (this: JView) { return this.clickL ? 1 : 0; },
  "requestRectangleOnScreen(Landroid/graphics/Rect;)Z": maySuspend(function (this: JView, rect: JRect) {
    return vcall(this, "requestRectangleOnScreen", "(Landroid/graphics/Rect;Z)Z", rect, 0);
  }),
  "requestRectangleOnScreen(Landroid/graphics/Rect;Z)Z": async function (this: JView, rect: JRect, immediate: number) {
    let scrolled = 0;
    for (let child: JView = this, parent = child.parent; parent; child = parent, parent = parent.parent) {
      scrolled |= await vcall(parent, "requestChildRectangleOnScreen", "(Landroid/view/View;Landroid/graphics/Rect;Z)Z", child, rect, immediate);
      const x = child.left - child.scrollX, y = child.top - child.scrollY;
      rect.left += x; rect.right += x; rect.top += y; rect.bottom += y;
    }
    return scrolled;
  },
  "getMatrix()Landroid/graphics/Matrix;": function (this: JView) {
    const m = new JMatrix();
    const px = this.pivotXv ?? this.width() / 2, py = this.pivotYv ?? this.height() / 2;
    let a = [1, 0, 0, 1, this.translationX, this.translationY] as [number, number, number, number, number, number];
    if (this.rotationV) a = matMul(a, rotM(this.rotationV, px, py));
    if (this.scaleXv !== 1 || this.scaleYv !== 1) {
      a = matMul(a, [this.scaleXv, 0, 0, this.scaleYv, px - this.scaleXv * px, py - this.scaleYv * py]);
    }
    m.m = a;
    return m;
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
  "requestFocus(I)Z": function (this: JView) { return takeFocus(this); },
  "requestFocus(ILandroid/graphics/Rect;)Z": function (this: JView) { return takeFocus(this); },
  "offsetLeftAndRight(I)V": function (this: JView, d: number) { this.left += d; this.right += d; invalidate(); },
  "offsetTopAndBottom(I)V": function (this: JView, d: number) { this.top += d; this.bottom += d; invalidate(); },
  // AOSP's setLeft/setTop/setRight/setBottom: direct bounds mutation outside a layout pass
  // (Compose's placement phase positions children this way). Same size/layout-change
  // notifications layoutView fires, since AOSP's setFrame() backs both paths.
  "setLeft(I)V": function (this: JView, v: number) { setBound(this, v, this.top, this.right, this.bottom); },
  "setTop(I)V": function (this: JView, v: number) { setBound(this, this.left, v, this.right, this.bottom); },
  "setRight(I)V": function (this: JView, v: number) { setBound(this, this.left, this.top, v, this.bottom); },
  "setBottom(I)V": function (this: JView, v: number) { setBound(this, this.left, this.top, this.right, v); },
  // AOSP View.dispatchKeyEvent: the OnKeyListener sees the event first, then KeyEvent.dispatch
  // routes it to onKeyDown/onKeyUp by action.
  "dispatchKeyEvent(Landroid/view/KeyEvent;)Z": async function (this: JView, ev: unknown) {
    const code = await vcall(ev, "getKeyCode", "()I"), action = await vcall(ev, "getAction", "()I");
    if (this.keyL && this.enabled && (await vcall(this.keyL, "onKey", "(Landroid/view/View;ILandroid/view/KeyEvent;)Z", this, code, ev))) return 1;
    return action === 0 ? vcall(this, "onKeyDown", "(ILandroid/view/KeyEvent;)Z", code, ev)
      : action === 1 ? vcall(this, "onKeyUp", "(ILandroid/view/KeyEvent;)Z", code, ev) : 0;
  },
  "onSaveInstanceState()Landroid/os/Parcelable;": () => EMPTY_STATE,
  "getDrawingTime()J": () => BigInt(Math.floor(performance.now())),
  "verifyDrawable(Landroid/graphics/drawable/Drawable;)Z": function (this: JView, d: unknown) { return d === this.background ? 1 : 0; },
  "onCreateDrawableState(I)[I": function (this: JView, extra: number) {
    const base = this.baseState();
    const out = new Int32Array(base.length + Math.max(0, extra | 0));
    out.set(base);
    return out;
  },
  "static mergeDrawableStates([I[I)[I": mergeStates,
  "mergeDrawableStates([I[I)[I": mergeStates,
  "getFitsSystemWindows()Z": function (this: JView) { return this.fitsSys ? 1 : 0; },
  // The overlay is a layer on top of the host's own content that anything can park a drawable
  // (or, for a ViewGroup, a view) in without touching the hierarchy. Material's SearchView
  // expand and androidx transitions both animate through it.
  "getOverlay()Landroid/view/ViewOverlay;": overlayOf,
  "getOverlay()Landroid/view/ViewGroupOverlay;": overlayOf,
  "getWindowId()Landroid/view/WindowId;": function (this: JView) { return this.attached ? WINDOW_ID : null; },
  "getRootWindowInsets()Landroid/view/WindowInsets;": () => rootWindowInsets(),
  "getWindowInsetsController()Landroid/view/WindowInsetsController;": maySuspend(function (this: JView) {
    if (!this.attached) return null;
    let root: JView = this;
    while (root.parent) root = root.parent;
    return root.windowOwner ? vcall(root.windowOwner, "getInsetsController", "()Landroid/view/WindowInsetsController;") : null;
  }),
  // AOSP: a view that fits system windows turns the bars into padding and consumes them; one
  // that does not still offers them to the deprecated fitSystemWindows(Rect) an app may override.
  "onApplyWindowInsets(Landroid/view/WindowInsets;)Landroid/view/WindowInsets;": async function (this: JView, ins: JWindowInsets) {
    if (!ins || ins.consumedV) return ins;
    const s = sysIns(ins);
    if (this.fitsSys) {
      this.padL = s.left; this.padT = s.top; this.padR = s.right; this.padB = s.bottom;
      requestLayout(this);
    } else if (!await vcall(this, "fitSystemWindows", "(Landroid/graphics/Rect;)Z", Object.assign(new JRect(), s))) {
      return ins;
    }
    return vcall(ins, "consumeSystemWindowInsets", "()Landroid/view/WindowInsets;");
  },
  "dispatchApplyWindowInsets(Landroid/view/WindowInsets;)Landroid/view/WindowInsets;": viewDispatchInsets,
  "postOnAnimationDelayed(Ljava/lang/Runnable;J)V": function (this: JView, r: unknown, d: bigint) {
    setTimeout(() => uiState.frameCallbacks.push({ run: r }), Number(d));
  },
  "getParentForAccessibility()Landroid/view/ViewParent;": function (this: JView) { return this.parent; },
  "startAnimation(Landroid/view/animation/Animation;)V": function (this: JView, a: unknown) { startViewAnim(this, a); },
  "setAnimation(Landroid/view/animation/Animation;)V": function (this: JView, a: unknown) { this.jAnim = a; },
  "clearAnimation()V": function (this: JView) { this.jAnim = null; this.animTf = null; invalidate(); },
  "getAnimation()Landroid/view/animation/Animation;": function (this: JView) { return this.jAnim; },
  "animate()Landroid/view/ViewPropertyAnimator;": function (this: JView) { return mkVPA(this); },
  "getForeground()Landroid/graphics/drawable/Drawable;": function (this: JView) { return this.foreground; },
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
  "hasTransientState()Z": function (this: JView) { return this.transientState > 0 ? 1 : 0; },
  "setHasTransientState(Z)V": function (this: JView, v: number) { this.transientState = Math.max(0, this.transientState + (v ? 1 : -1)); },
  "static combineMeasuredStates(II)I": (a: number, b: number) => a | b,
  "getPivotX()F": function (this: JView) { return this.pivotXv ?? this.width() / 2; },
  "getPivotY()F": function (this: JView) { return this.pivotYv ?? this.height() / 2; },
  "getTranslationZ()F": function (this: JView) { return this.translationZ; },
  "getZ()F": function (this: JView) { return this.elevationV + this.translationZ; },
  "setTransitionVisibility(I)V": function (this: JView, v: number) { this.visibility = v; invalidate(); },
  "getClipBounds()Landroid/graphics/Rect;": function (this: JView) { return this.clipBounds; },
  "setClipBounds(Landroid/graphics/Rect;)V": function (this: JView, r: JRect | null) { this.clipBounds = r; invalidate(); },
  "invalidateOutline()V": () => { invalidate(); },
  "getBackgroundTintList()Landroid/content/res/ColorStateList;": function (this: JView) { return this.bgTint; },
  "setBackgroundTintList(Landroid/content/res/ColorStateList;)V": function (this: JView, csl: JColorStateList | null) {
    this.bgTint = csl;
    if (this.background) this.background.tint = csl ? cslColor(csl, this.drawableState()) : null;
    invalidate();
  },
  "getDrawingRect(Landroid/graphics/Rect;)V": drawingRect,
  "getFocusedRect(Landroid/graphics/Rect;)V": drawingRect,
  "getGlobalVisibleRect(Landroid/graphics/Rect;Landroid/graphics/Point;)Z": function (this: JView, r: JRect, off: { x: number; y: number } | null) {
    const [x, y] = locationOnScreen(this);
    r.left = x; r.top = y; r.right = x + this.width(); r.bottom = y + this.height();
    if (off) { off.x = x - this.left; off.y = y - this.top; }
    return 1;
  },
  "getWindowVisibleDisplayFrame(Landroid/graphics/Rect;)V": function (this: JView, r: JRect) {
    let root: JView = this;
    while (root.parent) root = root.parent;
    r.left = 0; r.top = device.statusBar; r.right = root.width() || device.width; r.bottom = device.statusBar + (root.height() || device.height - device.statusBar);
  },
  "bringToFront()V": function (this: JView) {
    const p = this.parent as JViewGroup | null;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) { p.children.splice(i, 1); p.children.push(this); invalidate(); }
  },
  "setTooltipText(Ljava/lang/CharSequence;)V": function (this: JView, t: unknown) { this.tooltip = t; },
  "getTooltipText()Ljava/lang/CharSequence;": function (this: JView) { return this.tooltip; },
  "setTextAlignment(I)V": function (this: JView, a: number) { this.textAlignment = a; },
  "getTextAlignment()I": function (this: JView) { return this.textAlignment; },
  "hasFocusable()Z": function (this: JView) { return this.visibility === 0 && (this.focusable || this.focusableInTouchMode) ? 1 : 0; },
  "computeHorizontalScrollExtent()I": function (this: JView) { return this.width(); },
  "computeHorizontalScrollOffset()I": function (this: JView) { return this.scrollX; },
  "computeHorizontalScrollRange()I": function (this: JView) { return this.width(); },
  "computeVerticalScrollExtent()I": function (this: JView) { return this.height(); },
  "computeVerticalScrollOffset()I": function (this: JView) { return this.scrollY; },
  "computeVerticalScrollRange()I": function (this: JView) { return this.height(); },
  "setLeftTopRightBottom(IIII)V": function (this: JView, l: number, t: number, r: number, b: number) {
    this.left = l; this.top = t; this.right = r; this.bottom = b; invalidate();
  },
  "findOnBackInvokedDispatcher()Landroid/window/OnBackInvokedDispatcher;": function (this: JView) {
    // the window this view is in: an attached view's context is its activity (or dialog)
    const c = this.ctx as { window?: { backDispatcher?: () => unknown }; win?: { backDispatcher?: () => unknown } } | null;
    const w = c?.window ?? c?.win;
    return this.attached && w?.backDispatcher ? w.backDispatcher() : null;
  },
  "isLaidOut()Z": function (this: JView) { return this.right > 0 || this.bottom > 0 ? 1 : 0; },
  ...stubs(1, "isInTouchMode()Z", "performHapticFeedback(I)Z", "isHardwareAccelerated()Z", "hasWindowFocus()Z",
    "getTransitionAlpha()F", "hasOverlappingRendering()Z", "isLayoutDirectionResolved()Z"),
  ...noops("playSoundEffect(I)V", "onLayout(ZIIII)V", "onSizeChanged(IIII)V", "onDraw(Landroid/graphics/Canvas;)V",
    "dispatchDraw(Landroid/graphics/Canvas;)V", "drawableStateChanged()V", "jumpDrawablesToCurrentState()V",
    "onAttachedToWindow()V", "onDetachedFromWindow()V", "onConfigurationChanged(Landroid/content/res/Configuration;)V",
    "onFinishInflate()V", "setOnCreateContextMenuListener(Landroid/view/View$OnCreateContextMenuListener;)V",
    "setSaveEnabled(Z)V", "setSaveFromParentEnabled(Z)V", "setWillNotDraw(Z)V", "setHapticFeedbackEnabled(Z)V",
    "setSoundEffectsEnabled(Z)V", "setImportantForAccessibility(I)V", "setAccessibilityLiveRegion(I)V",
    "onInitializeAccessibilityNodeInfo(Landroid/view/accessibility/AccessibilityNodeInfo;)V",
    "onInitializeAccessibilityEvent(Landroid/view/accessibility/AccessibilityEvent;)V", "setLabelFor(I)V",
    "destroyDrawingCache()V", "buildDrawingCache()V", "setClipToOutline(Z)V", "setTransitionName(Ljava/lang/String;)V",
    "setForegroundGravity(I)V", "sendAccessibilityEvent(I)V", "announceForAccessibility(Ljava/lang/CharSequence;)V",
    "setSystemUiVisibility(I)V", "setVerticalScrollBarEnabled(Z)V", "setHorizontalScrollBarEnabled(Z)V",
    "setScrollBarStyle(I)V", "setScrollContainer(Z)V", "setImportantForAutofill(I)V",
    "setDefaultFocusHighlightEnabled(Z)V", "setForceDarkAllowed(Z)V",
    "setWindowInsetsAnimationCallback(Landroid/view/WindowInsetsAnimation$Callback;)V",
    "setViewTranslationCallback(Landroid/view/translation/ViewTranslationCallback;)V",
    "setImportantForContentCapture(I)V", "setFocusedByDefault(Z)V", "setKeepScreenOn(Z)V", "setRequestedFrameRate(F)V",
    "onRestoreInstanceState(Landroid/os/Parcelable;)V", "saveHierarchyState(Landroid/util/SparseArray;)V",
    "restoreHierarchyState(Landroid/util/SparseArray;)V", "setDrawingCacheEnabled(Z)V",
    "addFocusables(Ljava/util/ArrayList;II)V", "addTouchables(Ljava/util/ArrayList;)V", "cancelPendingInputEvents()V",
    "setTouchDelegate(Landroid/view/TouchDelegate;)V", "setAccessibilityPaneTitle(Ljava/lang/CharSequence;)V",
    "setStateDescription(Ljava/lang/CharSequence;)V", "setAccessibilityHeading(Z)V", "setScreenReaderFocusable(Z)V",
    "setDuplicateParentStateEnabled(Z)V", "setAddStatesFromChildren(Z)V", "onWindowFocusChanged(Z)V",
    "dispatchWindowFocusChanged(Z)V", "onFocusChanged(ZILandroid/graphics/Rect;)V", "setRotationX(F)V",
    "setRotationY(F)V", "setTransitionAlpha(F)V", "setBackgroundTintMode(Landroid/graphics/PorterDuff$Mode;)V",
    "setOnHoverListener(Landroid/view/View$OnHoverListener;)V", "setVerticalFadingEdgeEnabled(Z)V",
    "setScrollbarFadingEnabled(Z)V", "setScrollIndicators(II)V", "setNextFocusLeftId(I)V", "setNextFocusRightId(I)V",
    "setSystemGestureExclusionRects(Ljava/util/List;)V", "setFrameContentVelocity(F)V",
    "setAnimationMatrix(Landroid/graphics/Matrix;)V", "onScrollChanged(IIII)V",
    "onVisibilityChanged(Landroid/view/View;I)V", "onVisibilityAggregated(Z)V", "onWindowVisibilityChanged(I)V",
    "onWindowSystemUiVisibilityChanged(I)V", "onAnimationStart()V", "onAnimationEnd()V", "onRtlPropertiesChanged(I)V",
    "drawableHotspotChanged(FF)V", "setLayoutDirection(I)V", "setTextDirection(I)V"),
  ...stubs(0, "getWindowVisibility()I", "getImportantForAccessibility()I", "getSystemUiVisibility()I",
    "onInterceptTouchEvent(Landroid/view/MotionEvent;)Z", "willNotDraw()Z", "canScrollVertically(I)Z",
    "canScrollHorizontally(I)Z", "isShowingLayoutBounds()Z", "getImportantForAutofill()I", "getKeepScreenOn()Z",
    "onKeyDown(ILandroid/view/KeyEvent;)Z", "onKeyUp(ILandroid/view/KeyEvent;)Z",
    "dispatchGenericMotionEvent(Landroid/view/MotionEvent;)Z",
    "dispatchPopulateAccessibilityEvent(Landroid/view/accessibility/AccessibilityEvent;)Z",
    "isAccessibilityHeading()Z", "isScreenReaderFocusable()Z", "isInLayout()Z", "getMeasuredState()I",
    "getRotationX()F", "getRotationY()F", "getClipToOutline()Z", "isHovered()Z", "isAccessibilityFocused()Z",
    "isDuplicateParentStateEnabled()Z", "getAccessibilityLiveRegion()I", "getVerticalFadingEdgeLength()I",
    "awakenScrollBars()Z", "getWindowSystemUiVisibility()I", "onHoverEvent(Landroid/view/MotionEvent;)Z",
    "dispatchHoverEvent(Landroid/view/MotionEvent;)Z", "onDragEvent(Landroid/view/DragEvent;)Z",
    "onKeyPreIme(ILandroid/view/KeyEvent;)Z", "onCheckIsTextEditor()Z", "fitSystemWindows(Landroid/graphics/Rect;)Z",
    "isInEditMode()Z", "getLayoutDirection()I", "getTextDirection()I", "isPaddingRelative()Z"),
  ...stubs(null, "getContentCaptureSession()Landroid/view/contentcapture/ContentCaptureSession;",
    "getDrawingCache()Landroid/graphics/Bitmap;", "getTransitionName()Ljava/lang/String;",
    "createAccessibilityNodeInfo()Landroid/view/accessibility/AccessibilityNodeInfo;",
    "getAccessibilityNodeProvider()Landroid/view/accessibility/AccessibilityNodeProvider;",
    "getAccessibilityPaneTitle()Ljava/lang/CharSequence;", "getStateDescription()Ljava/lang/CharSequence;",
    "getBackgroundTintMode()Landroid/graphics/PorterDuff$Mode;",
    "onCreateInputConnection(Landroid/view/inputmethod/EditorInfo;)Landroid/view/inputmethod/InputConnection;"),
  ...stubs(-1, "getBaseline()I"),
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

function setPadding(this: JView, l: number, t: number, r: number, b: number) {
  this.padL = l; this.padT = t; this.padR = r; this.padB = b;
  requestLayout(this);
}
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
export async function initViewFromCtx(v: JView, jctx: unknown, set: JAttrSet | null, defStyleAttr = 0) {
  v.ctx = jctx;
  if (jctx) {
    const host = (jctx as JContext | null)?.$host;
    if (host) {
      v.jres = host.res;
      v.theme = await askTheme(jctx) ?? host.theme;
    }
  }
  await applyViewAttrs(v, set, defStyleAttr);
}

export class JViewGroup extends JView {
  children: JView[] = [];
  /** ViewGroup.getNestedScrollAxes() — the axes of the nested scroll in progress */
  nestedAxes = 0;
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
  if (jmethod(vg, M_checkLp)) {
    const ok = await guardCall(vg, M_checkLp, lp);
    if (!ok) {
      const converted = await guardMaybe(vg, M_generateLp, lp);
      if (converted) return converted as JLayoutParams;
    }
  }
  return lp;
}

/** The array and parent link alone, which is all AOSP's attachViewToParent does. False when the
 *  link would make a cycle. */
function linkChild(parent: JViewGroup, child: JView, index: number): boolean {
  // integrity: never create a cycle (child already an ancestor of parent)
  for (let a: JView | null = parent; a; a = a.parent) {
    if (a === child) {
      console.error("[webdroid] refused cyclic addView:", (child.constructor as any)?.$i?.name, "into", (parent.constructor as any)?.$i?.name);
      return false;
    }
  }
  if (child.parent) detachView(child.parent as JViewGroup, child);
  if (index < 0 || index > parent.children.length) parent.children.push(child);
  else parent.children.splice(index, 0, child);
  child.parent = parent;
  return true;
}
/** AOSP detachViewFromParent: the child leaves the array but stays attached to the window */
function unlinkChild(parent: JViewGroup, child: JView): boolean {
  const i = parent.children.indexOf(child);
  if (i < 0) return false;
  parent.children.splice(i, 1);
  child.parent = null;
  return true;
}
/** AOSP removeViewInternal and removeDetachedView: the hierarchy listener hears of it and the
 *  child leaves the window */
function childRemoved(parent: JViewGroup, child: JView) {
  if (parent.hierarchyChangeL) {
    void vcall(parent.hierarchyChangeL, "onChildViewRemoved", "(Landroid/view/View;Landroid/view/View;)V", parent, child);
  }
  if (child.attached) void onMain(() => dispatchDetached(child));
}
/**
 * AOSP addViewInner: every addView overload funnels here (see addViewFunnel/addView3 below), as
 * does addViewInLayout, which passes request=false. addView asks the parent for layout through
 * its virtual requestLayout(); the in-layout form leaves that to the pass already running.
 */
export function attachView(parent: JViewGroup, child: JView, index = -1, request = true) {
  if (!linkChild(parent, child, index)) return;
  if (parent.hierarchyChangeL) {
    void vcall(parent.hierarchyChangeL, "onChildViewAdded", "(Landroid/view/View;Landroid/view/View;)V", parent, child);
  }
  // Android attaches inline; we cannot, so queue behind the current main-looper job rather
  // than starting a chain that interleaves with the caller at its first await (Compose's
  // composition installs a snapshot read observer that must not see foreign reads).
  if (parent.attached) void onMain(() => dispatchAttached(child));
  if (request) { requestLayoutVirtual(parent); invalidate(parent); }
}
/** AOSP removeView (request) and removeViewInLayout (no request) */
export function detachView(parent: JViewGroup, child: JView, request = true) {
  if (!unlinkChild(parent, child)) return;
  childRemoved(parent, child);
  if (request) { requestLayoutVirtual(parent); invalidate(parent); }
}
export async function dispatchAttached(v: JView) {
  if (v.attached) return;
  await attachTree(v);
  // Queued attachment may follow an unattached measure and an empty hosted display list.
  requestLayout(v);
  invalidate(v);
}
async function attachTree(v: JView) {
  if (v.attached) return;
  v.attached = true;
  mergeVTO(v);
  try { await guardMaybe(v, M_onAttached); } catch (e) { reportUncaught(e); }
  // a snapshot, as AOSP's copy-on-write list: a one-shot listener removing itself must not skip the next
  for (const l of [...v.attachLs]) {
    try { await vcall(l, "onViewAttachedToWindow", "(Landroid/view/View;)V", v); } catch (e) { reportUncaught(e); }
  }
  // one child's failure must not prevent its siblings from attaching (e.g. ViewPager populate)
  if (v instanceof JViewGroup) for (const c of [...v.children]) {
    try { await attachTree(c); } catch (e) { reportUncaught(e); }
  }
  v.layoutRequested = true;
  clearMeasureCache(v);
}
/**
 * A Configuration change reaches a view hierarchy the way AOSP's ViewRootImpl delivers it —
 * down the tree, each view's own onConfigurationChanged. It is the only signal an activity that
 * declared the change in its manifest ever gets, and Compose's AndroidComposeView listens on it
 * to republish LocalConfiguration (hence isSystemInDarkTheme).
 */
export async function dispatchConfigurationChanged(v: JView, cfg: unknown) {
  try { await guardMaybe(v, M_onConfigChanged, cfg); } catch (e) { reportUncaught(e); }
  if (v instanceof JViewGroup) for (const c of [...v.children]) await dispatchConfigurationChanged(c, cfg);
}
export async function dispatchDetached(v: JView) {
  if (!v.attached) return;
  v.attached = false;
  if (v instanceof JViewGroup) for (const c of [...v.children]) await dispatchDetached(c);
  await guardMaybe(v, M_onDetached);
  for (const l of [...v.attachLs]) await vcall(l, "onViewDetachedFromWindow", "(Landroid/view/View;)V", v);
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

const M_checkLp = mangleMethod("checkLayoutParams", "(Landroid/view/ViewGroup$LayoutParams;)Z");
const M_generateLp = mangleMethod("generateLayoutParams", "(Landroid/view/ViewGroup$LayoutParams;)Landroid/view/ViewGroup$LayoutParams;");
const M_addView3 = mangleMethod("addView", "(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;)V");
const M_genDefaultLP = mangleMethod("generateDefaultLayoutParams", "()Landroid/view/ViewGroup$LayoutParams;");
const M_resolveLD = mangleMethod("resolveLayoutDirection", "(I)V");
/** AOSP View.resolveLayoutParams: start/end constraints and margins become left/right here */
export function resolveLp(lp: JLayoutParams): unknown { return (jmethod(lp, M_resolveLD) as JMethod).call(lp, 0); }

/** the native terminal: every other overload reaches the tree through here */
async function addView3(this: JViewGroup, c: JView, i: number, lp: JLayoutParams | null) {
  c.lp = lp ? await convertLp(this, lp)
    : c.lp ? await convertLp(this, c.lp)
    : await guardCall(this, M_genDefaultLP);
  await resolveLp(c.lp!);
  attachView(this, c, i);
}
/**
 * AOSP funnels every addView overload through the overridable 3-arg one, and subclasses do real
 * work there -- ViewPager sets lp.isDecor and, mid-layout, lp.needsMeasure + addViewInLayout, which
 * is the only way a page committed during its own measure pass ever gets sized. Calling attachView
 * directly from each overload skipped all of it.
 */
async function addViewFunnel(vg: JViewGroup, c: JView, i: number, lp: JLayoutParams | null) {
  const f = jmethod(vg, M_addView3);
  if (f && f !== addView3) return void await guardApply(f, vg, c, i, lp);
  await addView3.call(vg, c, i, lp);
}

const vgMethods: NativeSpec["methods"] = {
  // AOSP ViewGroup: self first (listener or onApplyWindowInsets), then each child in order,
  // threading the possibly-modified insets along and stopping as soon as one consumes them.
  "dispatchApplyWindowInsets(Landroid/view/WindowInsets;)Landroid/view/WindowInsets;": async function (this: JViewGroup, ins: unknown) {
    let cur = await viewDispatchInsets.call(this, ins);
    for (const c of this.children) {
      if ((cur as JWindowInsets)?.consumedV) break;
      if (c.visibility === 8) continue;
      cur = await vcall(c, "dispatchApplyWindowInsets", "(Landroid/view/WindowInsets;)Landroid/view/WindowInsets;", cur);
    }
    return cur;
  },
  "addView(Landroid/view/View;)V": async function (this: JViewGroup, c: JView) {
    return addViewFunnel(this, c, -1, null);
  },
  "addView(Landroid/view/View;I)V": maySuspend(function (this: JViewGroup, c: JView, i: number) {
    return addViewFunnel(this, c, i, null);
  }),
  "addView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": maySuspend(function (this: JViewGroup, c: JView, lp: JLayoutParams) {
    return addViewFunnel(this, c, -1, lp);
  }),
  "addView(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;)V": addView3,
  "addView(Landroid/view/View;II)V": maySuspend(function (this: JViewGroup, c: JView, w: number, h: number) {
    const lp = new JLayoutParams();
    lp.width = w; lp.height = h;
    return addViewFunnel(this, c, -1, lp);
  }),
  "removeView(Landroid/view/View;)V": removeChild,
  "removeViewInLayout(Landroid/view/View;)V": removeChildInLayout,
  "removeViewAt(I)V": function (this: JViewGroup, i: number) {
    const c = this.children[i];
    if (c) detachView(this, c);
  },
  "removeAllViews()V": function (this: JViewGroup) { removeRange(this, 0, this.children.length, true); },
  "removeAllViewsInLayout()V": function (this: JViewGroup) { removeRange(this, 0, this.children.length, false); },
  "getChildCount()I": function (this: JViewGroup) { return this.children.length; },
  "getChildAt(I)Landroid/view/View;": function (this: JViewGroup, i: number) { return this.children[i] ?? null; },
  "indexOfChild(Landroid/view/View;)I": function (this: JViewGroup, c: JView) { return this.children.indexOf(c); },
  "removeViews(II)V": function (this: JViewGroup, start: number, n: number) { removeRange(this, start, n, true); },
  "removeViewsInLayout(II)V": function (this: JViewGroup, start: number, n: number) { removeRange(this, start, n, false); },
  "detachViewFromParent(I)V": function (this: JViewGroup, i: number) {
    const c = this.children[i];
    if (c) unlinkChild(this, c);
  },
  "getFocusedChild()Landroid/view/View;": function (this: JViewGroup) {
    return this.children.find((c) => c.focused || (c instanceof JViewGroup && findByPred(c, (v) => v.focused))) ?? null;
  },
  "offsetRectIntoDescendantCoords(Landroid/view/View;Landroid/graphics/Rect;)V": function (this: JViewGroup, d: JView, r: JRect) {
    const [px, py] = locationOnScreen(this), [dx, dy] = locationOnScreen(d);
    r.left += px - dx; r.right += px - dx; r.top += py - dy; r.bottom += py - dy;
  },
  "bringChildToFront(Landroid/view/View;)V": function (this: JViewGroup, c: JView) {
    const i = this.children.indexOf(c);
    if (i >= 0) { this.children.splice(i, 1); this.children.push(c); invalidate(); }
  },
  "generateDefaultLayoutParams()Landroid/view/ViewGroup$LayoutParams;": function () {
    const lp = new JLayoutParams();
    return lp;
  },
  "generateLayoutParams(Landroid/util/AttributeSet;)Landroid/view/ViewGroup$LayoutParams;": function (this: JViewGroup, set: JAttrSet) {
    return lpFromAttrs(new JMarginLP(), this.jres!, set);
  },
  "generateLayoutParams(Landroid/view/ViewGroup$LayoutParams;)Landroid/view/ViewGroup$LayoutParams;": function (this: JViewGroup, lp: JLayoutParams) {
    return lp;
  },
  "dispatchDraw(Landroid/graphics/Canvas;)V": async function (this: JViewGroup, cv: JCanvas) {
    const n = this.children.length;
    if (!this.drawingOrderEnabled) { for (const c of this.children) await drawView(c, cv, this); return; }
    // a subclass's getChildDrawingOrder picks which child paints at each z step (AOSP buildOrderedChildList)
    for (let i = 0; i < n; i++) {
      const c = this.children[await vcall(this, "getChildDrawingOrder", "(II)I", n, i)];
      if (c) await drawView(c, cv, this);
    }
  },
  "setChildrenDrawingOrderEnabled(Z)V": function (this: JViewGroup, e: number) { this.drawingOrderEnabled = !!e; },
  "isChildrenDrawingOrderEnabled()Z": function (this: JViewGroup) { return this.drawingOrderEnabled ? 1 : 0; },
  "getChildDrawingOrder(II)I": (_n: number, i: number) => i,
  "getChildDrawingOrder(I)I": maySuspend(function (this: JViewGroup, i: number) { return vcall(this, "getChildDrawingOrder", "(II)I", this.children.length, i); }),
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
  "measureChildWithMargins(Landroid/view/View;IIII)V": maySuspend(function (this: JViewGroup, c: JView, ws: number, wu: number, hs: number, hu: number) {
    return measureChildWithMargins(this, c, ws, wu, hs, hu);
  }),
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
  "getDescendantFocusability()I": () => 0x20000,
  "addViewInLayout(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;)Z": addInLayout,
  "addViewInLayout(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;Z)Z": addInLayout,
  "attachViewToParent(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;)V": attachToParent,
  // the child was already unlinked by detachViewFromParent; this is the rest of its removal
  "removeDetachedView(Landroid/view/View;Z)V": function (this: JViewGroup, c: JView) {
    unlinkChild(this, c);
    childRemoved(this, c);
  },
  "detachViewFromParent(Landroid/view/View;)V": function (this: JViewGroup, c: JView) { unlinkChild(this, c); },
  "drawChild(Landroid/graphics/Canvas;Landroid/view/View;J)Z": async function (this: JViewGroup, cv: JCanvas, c: JView) {
    await drawView(c, cv, this);
    return 0;
  },
  "static getChildMeasureSpec(III)I": (spec: number, padding: number, dim: number) => childMeasureSpec(spec, padding, dim),
  ...noops("onViewAdded(Landroid/view/View;)V", "onViewRemoved(Landroid/view/View;)V",
    "setChildrenDrawingCacheEnabled(Z)V", "setHandwritingBoundsOffsets(FFFF)V", "suppressLayout(Z)V",
    "setMotionEventSplittingEnabled(Z)V", "setDescendantFocusability(I)V",
    "requestChildFocus(Landroid/view/View;Landroid/view/View;)V", "focusableViewAvailable(Landroid/view/View;)V",
    "requestTransparentRegion(Landroid/view/View;)V", "setLayoutTransition(Landroid/animation/LayoutTransition;)V",
    "setAddStatesFromChildren(Z)V", "childDrawableStateChanged(Landroid/view/View;)V",
    "startViewTransition(Landroid/view/View;)V", "endViewTransition(Landroid/view/View;)V"),
  ...stubs(null, "focusSearch(Landroid/view/View;I)Landroid/view/View;",
    "getLayoutTransition()Landroid/animation/LayoutTransition;"),
  ...stubs(0, "onRequestFocusInDescendants(ILandroid/graphics/Rect;)Z",
    "requestChildRectangleOnScreen(Landroid/view/View;Landroid/graphics/Rect;Z)Z", "isTransitionGroup()Z"),
  ...stubs(1, "checkLayoutParams(Landroid/view/ViewGroup$LayoutParams;)Z"),
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
    let intercepted = false;
    if (!this.disallowIntercept && (action === 0 || this.touchTarget)) {
      intercepted = !!(await guardCall(this, M_onIntercept, ev));
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
        const handled = await guardCall(c, M_dispatchTouch, ev);
        ev.x = ox; ev.y = oy;
        if (handled) { this.touchTarget = c; return 1; }
      }
    } else if (this.touchTarget && !intercepted) {
      const c = this.touchTarget;
      const ox = ev.x, oy = ev.y;
      ev.x = ev.x + this.scrollX - (c.left + c.translationX);
      ev.y = ev.y + this.scrollY - (c.top + c.translationY);
      const handled = await guardCall(c, M_dispatchTouch, ev);
      ev.x = ox; ev.y = oy;
      if (action === 1 || action === 3) this.touchTarget = null;
      return handled ? 1 : 0;
    } else if (this.touchTarget && intercepted) {
      // send cancel to target, take over
      const c = this.touchTarget;
      const oldAction = ev.action;
      ev.action = 3;
      await guardCall(c, M_dispatchTouch, ev);
      ev.action = oldAction;
      this.touchTarget = null;
    }
    const self = await guardCall(this, M_onTouchEvent, ev);
    return self ? 1 : 0;
  },
};

export function lpFromAttrs<T extends JLayoutParams>(lp: T, res: Resources, set: JAttrSet | null): T {
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

// ViewTreeObserver
class JVTO extends JObj {
  globalLayoutLs: unknown[] = [];
  preDrawLs: unknown[] = [];
  drawLs: unknown[] = [];
  scrollLs: unknown[] = [];
  focusLs: unknown[] = [];
  focused: JView | null = null;
  dispatchFocusChanged(old: JView | null, now: JView | null) { return fanOut(this.focusLs, "onGlobalFocusChanged", "(Landroid/view/View;Landroid/view/View;)V", old, now); }
  dispatchGlobalLayout() { return fanOut(this.globalLayoutLs, "onGlobalLayout", "()V"); }
  dispatchPreDraw() { return fanOut(this.preDrawLs, "onPreDraw", "()Z"); }
  dispatchOnDraw() { return fanOut(this.drawLs, "onDraw", "()V"); }
  dispatchScrollChanged() { return fanOut(this.scrollLs, "onScrollChanged", "()V"); }
}
async function fanOut(ls: unknown[], name: string, desc: string, ...args: unknown[]): Promise<void> {
  if (!ls.length) return;
  for (const l of [...ls]) {
    try { await vcall(l, name, desc, ...args); } catch (e) { console.error("[vto]", e); }
  }
}
const vtoMap = new WeakMap<JView, JVTO>();
const VTO_LISTS = ["globalLayoutLs", "preDrawLs", "drawLs", "scrollLs", "focusLs"] as const;
/**
 * AOSP's floating ViewTreeObserver: a listener registered before the view was attached goes on
 * the detached subtree's own observer, and dispatchAttachedToWindow merges it into the window's.
 * Without the merge the window never fires it — which is a fragment that stays mid-animation.
 */
function mergeVTO(v: JView): void {
  const floating = vtoMap.get(v);
  if (!floating || !v.parent) return;
  vtoMap.delete(v);
  const real = getVTO(v);
  for (const k of VTO_LISTS) real[k].push(...floating[k]);
}
function getVTO(v: JView): JVTO {
  let root: JView = v;
  while (root.parent) root = root.parent;
  let o = vtoMap.get(root);
  if (!o) vtoMap.set(root, (o = new JVTO()));
  return o;
}
/** fire-and-forget: scroll setters are synchronous void natives, same shape as refreshDrawableState */
function fireScrollChanged(v: JView) { void getVTO(v).dispatchScrollChanged(); }
class JA11yAction extends JObj { actionId = 0; label: string | null = null; }
rt.register({ name: "android/view/accessibility/AccessibilityNodeInfo", ctor: class extends JObj {}, ifaces: ["android/os/Parcelable"] });
rt.markers("android/view/accessibility/AccessibilityRecord");
rt.register({
  name: "android/view/accessibility/AccessibilityNodeInfo$AccessibilityAction", ctor: JA11yAction,
  methods: {
    "<init>(ILjava/lang/CharSequence;)V": async function (this: JA11yAction, id: number, label: unknown) {
      this.actionId = id;
      this.label = label === null ? null : await csText(label);
    },
    "getId()I": function (this: JA11yAction) { return this.actionId; },
    "getLabel()Ljava/lang/CharSequence;": function (this: JA11yAction) { return this.label; },
  },
});
rt.markers("android/view/autofill/AutofillId");
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
  "OnPreDrawListener", "OnWindowFocusChangeListener", "OnDrawListener", "OnGlobalFocusChangeListener",
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
    ...Object.fromEntries(([["focusLs", "GlobalFocusChange"], ["scrollLs", "ScrollChanged"], ["globalLayoutLs", "GlobalLayout"],
      ["preDrawLs", "PreDraw"], ["drawLs", "Draw"]] as const).flatMap(([k, n]) => {
      const t = `On${n}Listener(Landroid/view/ViewTreeObserver$On${n}Listener;)V`;
      return [[`add${t}`, function (this: JVTO, l: unknown) { this[k].push(l); }], [`remove${t}`, function (this: JVTO, l: unknown) { removeFrom(this[k], l); }]];
    })),
    "removeGlobalOnLayoutListener(Landroid/view/ViewTreeObserver$OnGlobalLayoutListener;)V": function (this: JVTO, l: unknown) { removeFrom(this.globalLayoutLs, l); },
    "isAlive()Z": () => 1,
    "dispatchOnGlobalLayout()V": maySuspend(function (this: JVTO) { return this.dispatchGlobalLayout(); }),
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

export const lpAttrs = function (this: JLayoutParams, _c: unknown, set: JAttrSet) { lpFromAttrs(this, set.res, set); };
const marginCopy = function (this: JMarginLP, o: JLayoutParams | null) {
  if (!o) return;
  this.width = o.width; this.height = o.height;
  if (o instanceof JMarginLP) { this.marginL = o.marginL; this.marginT = o.marginT; this.marginR = o.marginR; this.marginB = o.marginB; }
};
rt.register({
  name: "android/view/ViewGroup$LayoutParams", ctor: JLayoutParams,
  statics: { MATCH_PARENT: -1, FILL_PARENT: -1, WRAP_CONTENT: -2 },
  fields: ["width", "height"],
  methods: {
    "<init>(II)V": function (this: JLayoutParams, w: number, h: number) { this.width = w; this.height = h; },
    "<init>(Landroid/view/ViewGroup$LayoutParams;)V": function (this: JLayoutParams, o: JLayoutParams) {
      if (o) { this.width = o.width; this.height = o.height; }
    },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": lpAttrs,
    "resolveLayoutDirection(I)V": () => {},
  },
});
rt.register({
  name: "android/view/ViewGroup$MarginLayoutParams", ctor: JMarginLP, sup: "android/view/ViewGroup$LayoutParams",
  fields: { leftMargin: "marginL", topMargin: "marginT", rightMargin: "marginR", bottomMargin: "marginB" },
  methods: {
    "<init>(II)V": function (this: JMarginLP, w: number, h: number) { this.width = w; this.height = h; },
    "<init>(Landroid/view/ViewGroup$LayoutParams;)V": marginCopy,
    "<init>(Landroid/view/ViewGroup$MarginLayoutParams;)V": marginCopy,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": lpAttrs,
    // AOSP changes the params alone: the view asks for layout when they are applied to it
    "setMargins(IIII)V": function (this: JMarginLP, l: number, t: number, r: number, b: number) {
      this.marginL = l; this.marginT = t; this.marginR = r; this.marginB = b;
    },
    "setMarginStart(I)V": function (this: JMarginLP, v: number) { this.marginL = v; },
    "setMarginEnd(I)V": function (this: JMarginLP, v: number) { this.marginR = v; },
    "getMarginStart()I": function (this: JMarginLP) { return this.marginL; },
    "getMarginEnd()I": function (this: JMarginLP) { return this.marginR; },
    "getLayoutDirection()I": () => 0,
    "setLayoutDirection(I)V": () => {},
  },
});

rt.register({
  name: "android/view/View", ctor: JView,
  ifaces: ["android/graphics/drawable/Drawable$Callback"],
  statics: {
    VISIBLE: 0, INVISIBLE: 4, GONE: 8, NO_ID: -1,
    EMPTY_STATE_SET: new Int32Array(0), SELECTED_STATE_SET: Int32Array.of(0x10100a1),
    MEASURED_STATE_MASK: -0x1000000, MEASURED_SIZE_MASK: 0x00ffffff,
    SYSTEM_UI_FLAG_VISIBLE: 0, SYSTEM_UI_FLAG_LOW_PROFILE: 1, SYSTEM_UI_FLAG_HIDE_NAVIGATION: 2, SYSTEM_UI_FLAG_FULLSCREEN: 4, SYSTEM_UI_FLAG_LAYOUT_STABLE: 0x100,
    SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION: 0x200, SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN: 0x400, SYSTEM_UI_FLAG_IMMERSIVE: 0x800, SYSTEM_UI_FLAG_IMMERSIVE_STICKY: 0x1000,
    LAYER_TYPE_NONE: 0, LAYER_TYPE_SOFTWARE: 1, LAYER_TYPE_HARDWARE: 2,
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
  "OnKeyListener", "OnFocusChangeListener", "OnHoverListener", "OnGenericMotionListener", "OnScrollChangeListener",
  "OnSystemUiVisibilityChangeListener", "OnCapturedPointerListener", "OnContextClickListener", "OnUnhandledKeyEventListener",
]) rt.register({ name: "android/view/View$" + n, ctor: class extends JObj {} });
// AbsSavedState / View.BaseSavedState: the Parcelable a view's onSaveInstanceState wraps its
// super's state in. Nothing parcels here (state never leaves the process), so the chain is
// the object graph itself.
class JAbsSavedState extends JObj { superState: unknown = null; }
const EMPTY_STATE = new JAbsSavedState();
const savedStateMethods: NonNullable<NativeSpec["methods"]> = {
  "<init>(Landroid/os/Parcelable;)V": function (this: JAbsSavedState, sup: unknown) {
    if (sup == null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "superState must not be null");
    this.superState = sup === EMPTY_STATE ? null : sup;
  },
  "getSuperState()Landroid/os/Parcelable;": function (this: JAbsSavedState) { return this.superState ?? EMPTY_STATE; },
  ...noops("<init>(Landroid/os/Parcel;)V", "<init>(Landroid/os/Parcel;Ljava/lang/ClassLoader;)V",
    "writeToParcel(Landroid/os/Parcel;I)V"),
  ...stubs(0, "describeContents()I"),
};
rt.register({ name: "android/view/AbsSavedState", ctor: JAbsSavedState, ifaces: ["android/os/Parcelable"], statics: { EMPTY_STATE }, methods: savedStateMethods });
rt.register({ name: "android/view/View$BaseSavedState", ctor: class extends JAbsSavedState {}, sup: "android/view/AbsSavedState", methods: savedStateMethods });
// AccessibilityDelegate is a class in AOSP: apps subclass it and call super.
rt.register({
  name: "android/view/View$AccessibilityDelegate", ctor: class extends JObj {},
  methods: {
    "<init>()V": () => {},
    "sendAccessibilityEvent(Landroid/view/View;I)V": maySuspend((h: unknown, t: number) => vcall(h, "sendAccessibilityEvent", "(I)V", t)),
    "sendAccessibilityEventUnchecked(Landroid/view/View;Landroid/view/accessibility/AccessibilityEvent;)V": () => {},
    "onPopulateAccessibilityEvent(Landroid/view/View;Landroid/view/accessibility/AccessibilityEvent;)V": () => {},
    "onInitializeAccessibilityEvent(Landroid/view/View;Landroid/view/accessibility/AccessibilityEvent;)V": maySuspend((h: unknown, e: unknown) =>
      vcall(h, "onInitializeAccessibilityEvent", "(Landroid/view/accessibility/AccessibilityEvent;)V", e)),
    "onInitializeAccessibilityNodeInfo(Landroid/view/View;Landroid/view/accessibility/AccessibilityNodeInfo;)V": maySuspend((h: unknown, i: unknown) =>
      vcall(h, "onInitializeAccessibilityNodeInfo", "(Landroid/view/accessibility/AccessibilityNodeInfo;)V", i)),
    "dispatchPopulateAccessibilityEvent(Landroid/view/View;Landroid/view/accessibility/AccessibilityEvent;)Z": maySuspend((h: unknown, e: unknown) =>
      vcall(h, "dispatchPopulateAccessibilityEvent", "(Landroid/view/accessibility/AccessibilityEvent;)Z", e)),
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
    "onDescendantInvalidated(Landroid/view/View;Landroid/view/View;)V": nativeOnDescInv,
    // ── nested scrolling, parent half (AOSP ViewGroup). The base declines and passes nothing
    // on; a subclass that wants the scroll (CoordinatorLayout, SwipeRefreshLayout) overrides
    // onStartNestedScroll. Declining here is what lets a child walk further up the tree.
    "onStartNestedScroll(Landroid/view/View;Landroid/view/View;I)Z": () => 0,
    "onNestedScrollAccepted(Landroid/view/View;Landroid/view/View;I)V": function (this: JViewGroup, _c: JView, _t: JView, axes: number) { this.nestedAxes = axes; },
    "onStopNestedScroll(Landroid/view/View;)V": function (this: JViewGroup) { this.nestedAxes = 0; },
    "onNestedFling(Landroid/view/View;FFZ)Z": (_t: JView, _vx: number, _vy: number, consumed: number) => (consumed ? 0 : 1),
    ...stubs(0, "shouldDelayChildPressedState()Z", "onNestedPreFling(Landroid/view/View;FF)Z"),
    ...noops("onNestedScroll(Landroid/view/View;IIII)V", "onNestedPreScroll(Landroid/view/View;II[I)V"),
    "getNestedScrollAxes()I": function (this: JViewGroup) { return this.nestedAxes; },
    "cleanupLayoutState(Landroid/view/View;)V": (c: JView) => { c.layoutRequested = false; },
    ...viewMethods, ...vgMethods },
});
rt.markers("android/view/ViewParent", "android/view/ViewManager");
// apps `implements` this to watch a ViewGroup's addView/removeView traffic
rt.markers("android/view/ViewGroup$OnHierarchyChangeListener");
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
// the one display mode: the panel's size at its refresh rate
class JDisplayMode extends JObj {}
let theMode: JDisplayMode | null = null;
const displayMode = () => (theMode ??= new JDisplayMode());
rt.register({
  name: "android/view/Display$Mode", ctor: JDisplayMode,
  methods: {
    "getModeId()I": () => 1,
    "getPhysicalWidth()I": () => device.width,
    "getPhysicalHeight()I": () => device.height,
    "getRefreshRate()F": () => 60,
  },
});
rt.register({
  name: "android/view/Display", ctor: JDisplay,
  methods: {
    "getWidth()I": () => device.width,
    // getMetrics excludes the system bars; getRealMetrics is the whole display
    "getHeight()I": () => device.height - device.statusBar,
    "getMetrics(Landroid/util/DisplayMetrics;)V": (dm: JDisplayMetrics) => fillMetrics(dm, device.height - device.statusBar),
    "getRealMetrics(Landroid/util/DisplayMetrics;)V": (dm: JDisplayMetrics) => fillMetrics(dm, device.height),
    "getSize(Landroid/graphics/Point;)V": (p: JPoint) => { p.x = device.width; p.y = device.height - device.statusBar; },
    "getRealSize(Landroid/graphics/Point;)V": (p: JPoint) => { p.x = device.width; p.y = device.height; },
    "getRefreshRate()F": () => 60,
    "getPresentationDeadlineNanos()J": () => 16666667n,
    "getMode()Landroid/view/Display$Mode;": () => displayMode(),
    "getSupportedModes()[Landroid/view/Display$Mode;": () => jarray([displayMode()], "Landroid/view/Display$Mode;"),
    // a rectangular framebuffer has no rounded corners; androidx asks the Display and the
    // WindowInsets for them through the same descriptor
    "getRoundedCorner(I)Landroid/view/RoundedCorner;": () => null,
    ...stubs(0, "getRotation()I", "isWideColorGamut()Z", "isHdr()Z", "getDisplayId()I"),
    ...stubs(0n, "getAppVsyncOffsetNanos()J"),
    ...stubs(null, "getCutout()Landroid/view/DisplayCutout;"),
  },
});

// ── OrientationEventListener: the device is fixed portrait, so enable() never produces a
// rotation callback; canDetectOrientation() is honest about having an accelerometer.
class JOrientationEventListener extends JObj { enabled = 0; rate = 3; }
rt.register({
  name: "android/view/OrientationEventListener", ctor: JOrientationEventListener,
  statics: { ORIENTATION_UNKNOWN: -1 },
  methods: {
    "<init>(Landroid/content/Context;I)V": function (this: JOrientationEventListener, _c: unknown, rate: number) { this.rate = rate; },
    "enable()V": function (this: JOrientationEventListener) { this.enabled = 1; },
    "disable()V": function (this: JOrientationEventListener) { this.enabled = 0; },
    ...noops("<init>(Landroid/content/Context;)V", "onOrientationChanged(I)V"),
    ...stubs(1, "canDetectOrientation()Z"),
  },
});
