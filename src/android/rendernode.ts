// hwui's RenderNode and RenderProperties, and SkiaRecordingCanvas: the native halves of
// android.graphics.RenderNode, RecordingCanvas and CanvasProperty, whose Java runs from AOSP
// bytecode. A node's display list is a deferred command list (recording.ts) that drawing the
// node replays against the real target, with the node's properties applied as
// RenderNodeDrawable applies them. There is no RenderThread: elevation shadows, Z reordering,
// projection and stretch are properties kept, not drawn; animators run from the frame loop
// (rtanimator.ts), and position listeners hear where a frame drew their node (positionUpdates).

import { Recorder, displayListLength, isRecording, recordOrRun, replay, replayingCanvas, replayFor, transformOf, type Ctx2D, type DisplayList } from "./recording.ts";
import { rt } from "../jvm/runtime.ts";
import { handle, deref, ownedHandle, refBaseHandle, incStrong, decStrong, REFBASE_FINALIZER } from "./handles.ts";
import { NativePath } from "./path.ts";
import { perf } from "../perf.ts";
import type { NativeRenderEffect } from "./rendereffect.ts";
import { NativePaint, copyPaint, paintAt } from "./paint.ts";
import { type NativeColorFilter, COMPOSITE } from "./graphics.ts";
import { Camera3D, type Mat, IDENTITY, identity, mul, translateM, scaleM, about, setPivotedTransform, invert, isIdentity, applyMatrix, matrixAt, deviceBounds } from "./matrix.ts";
import { NativeCanvas, canvasAt, drawInLayer, clipRoundRect } from "./canvas.ts";
import { drawCircle, drawRoundRect } from "./canvas-draw.ts";
import { addAnimator, endAnimators } from "./rtanimator.ts";
import type { RuntimeShaderBuilder } from "./runtime-shader.ts";
import type { TextureLayer } from "./texturelayer.ts";
import { drawFunctor, trackingClips, pushClip, popClip } from "./webfunctor.ts";

const f32 = Math.fround, ALPHA_EPSILON = f32(0.001), NON_ZERO_EPSILON = f32(0.001);
/** MathUtils::isZero */
const isZero = (v: number) => Math.abs(v) <= NON_ZERO_EPSILON;
/** RenderProperties' clipping flags */
const CLIP_TO_BOUNDS = 1, CLIP_TO_CLIP_BOUNDS = 2;
/** Outline::Type */
const Outline = { None: 0, Empty: 1, Path: 2, RoundRect: 3 } as const;
type Outline = (typeof Outline)[keyof typeof Outline];
let nextId = 1n;

/** RenderNode with its RenderProperties and LayerProperties. Setters answer whether the value
 *  changed, as RP_SET does. */
export class NativeRenderNode {
  readonly name: string | null;
  readonly id = nextId++;
  /** the display list, null until one is recorded (RenderNode::isValid) */
  ops: DisplayList | null = null;
  left = 0; top = 0; right = 0; bottom = 0;
  alpha = 1; overlapping = false; elevation = 0;
  tx = 0; ty = 0; tz = 0; rotation = 0; rotationX = 0; rotationY = 0; scaleX = 1; scaleY = 1;
  pivotX = 0; pivotY = 0; pivotExplicit = false;
  /** mMatrixOrPivotDirty, and the transform updateMatrix computed (null before the first) */
  dirty = false; transform: Mat | null = null;
  private camera3d: Camera3D | null = null;
  get camera(): Camera3D { return this.camera3d ??= new Camera3D(); }
  clipFlags = CLIP_TO_BOUNDS; clipL = 0; clipT = 0; clipR = 0; clipB = 0;
  staticMatrix: Mat | null = null; animationMatrix: Mat | null = null;
  outline: Outline = Outline.None; outlineClip = false; outlineAlpha = 0; outlineRadius = 0;
  outlineL = 0; outlineT = 0; outlineR = 0; outlineB = 0; outlinePath: NativePath | null = null;
  revealClip = false; revealX = 0; revealY = 0; revealRadius = 0;
  ambientColor = 0xff000000 | 0; spotColor = 0xff000000 | 0;
  /** LayerProperties: LayerType (0 none, 1 software, 2 render layer) and what setFromPaint takes */
  layerType = 0; layerAlpha = 255; layerBlend: string | null = null; layerFilter: NativeColorFilter | null = null;
  effect: NativeRenderEffect | null = null; backdrop: NativeRenderEffect | null = null;
  projectBackwards = false; projectionReceiver = false; forceDark = true; usageHint = 0;
  stretch: { x: number; y: number; maxX: number; maxY: number } | null = null;
  positionListener: object | null = null;
  /** the bounds last reported to the position listener */
  position: [number, number, number, number] | null = null;
  effectInput: OffscreenCanvas | null = null; effectCanvas: NativeCanvas | null = null;
  drawing = false;
  constructor(name: string | null) { this.name = name; }
  get width() { return this.right - this.left; }
  get height() { return this.bottom - this.top; }
  get z() { return this.elevation + this.tz; }

  /** RenderProperties::updateMatrix */
  updateMatrix(): void {
    if (!this.dirty) return;
    if (!this.pivotExplicit) { this.pivotX = f32(this.width / 2); this.pivotY = f32(this.height / 2); }
    const px = this.pivotX, py = this.pivotY;
    if (isZero(this.rotationX) && isZero(this.rotationY)) {
      setPivotedTransform(this.transform ??= identity(), this.tx, this.ty, this.rotation, this.scaleX, this.scaleY, px, py);
    } else {
      const cam = this.camera, t3d = identity();
      cam.stack.push(cam.top.slice());
      cam.rotate(1, 0, 0, this.rotationX); cam.rotate(0, -1, 0, this.rotationY); cam.rotate(0, 0, 1, -this.rotation);
      cam.matrix(t3d);
      cam.stack.pop();
      this.transform = mul(mul(translateM(px + this.tx, py + this.ty), mul(t3d, translateM(-px, -py))), about(scaleM(this.scaleX, this.scaleY), px, py));
    }
    this.dirty = false;
  }
  hasTransform(): boolean { this.updateMatrix(); return !!this.transform && !isIdentity(this.transform); }
  /** RP_SET_AND_DIRTY over a transform property */
  setTransform<K extends "tx" | "ty" | "rotation" | "rotationX" | "rotationY" | "scaleX" | "scaleY">(key: K, v: number): number {
    if (this[key] === v) return 0;
    this[key] = v; this.dirty = true;
    return 1;
  }
  setPivot(key: "pivotX" | "pivotY", v: number): number {
    if (this[key] !== v || !this.pivotExplicit) {
      this[key] = v; this.dirty = true; this.pivotExplicit = true;
      return 1;
    }
    return 0;
  }
  /** a side changed: the size follows, and an implicit pivot must be recomputed */
  setSide(key: "left" | "top" | "right" | "bottom", v: number): number {
    if (this[key] === v) return 0;
    this[key] = v;
    if (!this.pivotExplicit) this.dirty = true;
    return 1;
  }
  get cameraZ(): number { return f32(this.camera.location[2] / 72); }
  /** LayerProperties::setFromPaint */
  setLayerPaint(p: NativePaint | null): number {
    const alpha = p ? p.color >>> 24 : 255, blend = p?.blendName ?? null, filter = p?.colorFilter ?? null;
    const changed = alpha !== this.layerAlpha || blend !== this.layerBlend || filter !== this.layerFilter;
    this.layerAlpha = alpha; this.layerBlend = blend; this.layerFilter = filter;
    return +changed;
  }
  /** Outline::getPath is non-null for a round rect or path outline, which a shadow needs */
  get hasShadow(): boolean { return this.z > 0 && (this.outline === Outline.RoundRect || this.outline === Outline.Path) && this.outlineAlpha !== 0; }
  /** RenderNode::nothingToDraw */
  get nothingToDraw(): boolean {
    return this.alpha <= 0 || this.scaleX === 0 || this.scaleY === 0 || this.outlineClip && this.outline === Outline.Empty;
  }
  setDisplayList(ops: DisplayList | null) {
    this.ops = ops;
    if (ops) perf.rnRecord += displayListLength(ops);
  }
}
const nodeAt = (h: bigint) => deref<NativeRenderNode>(h);

/** a frame's position changes for RenderNode.PositionUpdateListeners: listener, then the node's
 *  bounds in the surface, which the renderer delivers before it queues the frame */
export const positionUpdates: [object, number, number, number, number][] = [];
/** RenderNodeDrawable's setViewProperties: the node's position and transform */
function setViewProperties(ctx: Ctx2D, n: NativeRenderNode): void {
  if (n.left || n.top) ctx.translate(n.left, n.top);
  if (n.staticMatrix) applyMatrix(ctx, n.staticMatrix);
  else if (n.animationMatrix) applyMatrix(ctx, n.animationMatrix);
  if (n.hasTransform()) applyMatrix(ctx, n.transform!);
}
const sameCoordinate = (a: number, b: number) => a === b || Number.isNaN(a) && Number.isNaN(b);
/** PositionListenerTrampoline::onPositionUpdated: the node's bounds through the frame's transform,
 *  rounded when it only translates, reported when they changed */
function notePosition(ctx: Ctx2D, n: NativeRenderNode): void {
  ctx.save();
  setViewProperties(ctx, n);
  const m = transformOf(ctx), d = deviceBounds(m, 0, 0, n.width, n.height);
  let l = d[0], t = d[1], r = d[2], b = d[3];
  const identityScale = m.b === 0 && m.c === 0 && m.a === 1 && m.d === 1;
  ctx.restore();
  if (identityScale) {
    l = Math.round(l); t = Math.round(t); r = Math.round(r); b = Math.round(b);
  }
  l = Math.trunc(l); t = Math.trunc(t); r = Math.trunc(r); b = Math.trunc(b);
  const last = n.position;
  if (last && sameCoordinate(last[0], l) && sameCoordinate(last[1], t) && sameCoordinate(last[2], r) && sameCoordinate(last[3], b)) return;
  if (last) { last[0] = l; last[1] = t; last[2] = r; last[3] = b; }
  else n.position = [l, t, r, b];
  positionUpdates.push([n.positionListener!, l, t, r, b]);
}
/** RenderNodeDrawable: the node's display list replayed into ctx under its properties */
export function drawNodeInto(ctx: Ctx2D, n: NativeRenderNode) {
  const ops = n.ops, w = n.width, h = n.height;
  if (n.positionListener && !n.drawing) notePosition(ctx, n);
  if (!ops?.length || n.drawing || n.nothingToDraw) return;
  ctx.save();
  n.drawing = true;
  let clipped = false;
  // A bad op must not abandon this node's save, or its clip leaks into the frame.
  try {
    setViewProperties(ctx, n);
    // A layer composites with the node's alpha. hwui also promotes a translucent node with
    // overlapping rendering to a layer; here its alpha multiplies each draw instead, since an
    // offscreen raster per fading node doubled Compose's draw time in the measurements.
    const effect = n.effect && w > 0 && h > 0 ? n.effect : null;
    const layer = w > 0 && h > 0 && n.layerType === 2;
    let clipFlags = n.clipFlags;
    if (layer && n.alpha < 1) clipFlags &= ~CLIP_TO_BOUNDS;
    if (clipFlags) {
      let l = n.clipL, t = n.clipT, r = n.clipR, b = n.clipB;
      if (clipFlags & CLIP_TO_BOUNDS) {
        l = clipFlags & CLIP_TO_CLIP_BOUNDS ? Math.max(0, l) : 0; t = clipFlags & CLIP_TO_CLIP_BOUNDS ? Math.max(0, t) : 0;
        r = clipFlags & CLIP_TO_CLIP_BOUNDS ? Math.min(w, r) : w; b = clipFlags & CLIP_TO_CLIP_BOUNDS ? Math.min(h, b) : h;
      }
      ctx.beginPath(); ctx.rect(l, t, r - l, b - t); ctx.clip();
      if (trackingClips()) { pushClip(ctx, l, t, r, b); clipped = true; }
    }
    if (n.revealClip) { ctx.beginPath(); ctx.arc(n.revealX, n.revealY, n.revealRadius, 0, 2 * Math.PI); ctx.clip(); }
    else if (n.outlineClip) {
      if (n.outline === Outline.RoundRect) clipRoundRect(ctx, n.outlineL, n.outlineT, n.outlineR, n.outlineB, n.outlineRadius);
      else if (n.outline === Outline.Path) ctx.clip(n.outlinePath!.path(), n.outlinePath!.fillRule);
    }
    perf.rnReplay += displayListLength(ops);
    if (effect) {
      // an effect filters the node's own pixels, so it rasterises node-local
      const surface = n.effectInput ??= new OffscreenCanvas(w, h);
      if (surface.width !== w) surface.width = w;
      if (surface.height !== h) surface.height = h;
      const input = surface.getContext("2d")!; input.reset();
      const canvas = n.effectCanvas ??= NativeCanvas.over(input, w, h);
      canvas.setTarget(input, w, h, null);
      replayFor(canvas, () => replay(input, ops));
      ctx.globalAlpha *= n.alpha;
      effect.draw(ctx, surface);
    } else if (layer) {
      const blend = n.layerBlend && n.layerBlend !== "SRC_OVER" ? COMPOSITE[n.layerBlend] ?? null : null;
      drawInLayer(ctx, { left: 0, top: 0, right: w, bottom: h }, { alpha: n.layerAlpha * n.alpha, blend, filter: n.layerFilter }, ops);
    } else {
      ctx.globalAlpha *= n.alpha;
      replay(ctx, ops);
    }
  }
  catch (e) { perf.drawErrors++; noteNodeError(e); }
  finally { n.drawing = false; ctx.restore(); if (clipped) popClip(); }
}
const nodeErrSeen = new Set<string>();
function noteNodeError(e: unknown) {
  const k = String((e as Error)?.message ?? e).slice(0, 120);
  if (nodeErrSeen.has(k)) return;
  nodeErrSeen.add(k);
  console.error("[renderNode]", e);
}

const set = <K extends keyof NativeRenderNode>(key: K) => (h: bigint, v: NativeRenderNode[K]) => {
  const n = nodeAt(h);
  if (n[key] === v) return 0;
  n[key] = v;
  return 1;
};
const get = <K extends keyof NativeRenderNode>(key: K) => (h: bigint) => nodeAt(h)[key];
const bool = <K extends keyof NativeRenderNode>(key: K) => (h: bigint) => +!!nodeAt(h)[key];
const setBool = (key: "overlapping" | "forceDark" | "projectBackwards" | "projectionReceiver") => (h: bigint, v: number) => set(key)(h, !!v);
const transformSetter = (key: "tx" | "ty" | "rotation" | "rotationX" | "rotationY" | "scaleX" | "scaleY") => (h: bigint, v: number) => nodeAt(h).setTransform(key, v);
const sideSetter = (key: "left" | "top" | "right" | "bottom") => (h: bigint, v: number) => nodeAt(h).setSide(key, v);

rt.registerJnis("android/graphics/RenderNode", {
  "nCreate(Ljava/lang/String;)J": (name: string | null) => refBaseHandle(new NativeRenderNode(name), 1),
  "nGetNativeFinalizer()J": () => REFBASE_FINALIZER,
  // RenderNode::output: the node's properties, to the log
  "nOutput(J)V": (h: bigint) => {
    const n = nodeAt(h);
    console.log(`RenderNode(${n.name}) ${n.left},${n.top},${n.right},${n.bottom} alpha=${n.alpha} ops=${n.ops ? displayListLength(n.ops) : "none"}`);
  },
  // sizeof(RenderNode) on the reference device, and what the display list's slots take
  "nGetUsageSize(J)I": (h: bigint) => 1288 + (nodeAt(h).ops?.length ?? 0) * 8,
  "nGetAllocatedSize(J)I": (h: bigint) => { const n = nodeAt(h).ops?.length ?? 0; return 1288 + (n ? Math.ceil(n * 8 / 4096) * 4096 : 0); },
  // RenderNodeAnimators run from the frame loop (rtanimator.ts)
  "nAddAnimator(JJ)V": (h: bigint, a: bigint) => addAnimator(nodeAt(h), a),
  "nEndAllAnimators(J)V": (h: bigint) => endAnimators(nodeAt(h)),
  "nForceEndAnimators(J)V": (h: bigint) => endAnimators(nodeAt(h)),
  // the RenderThread reports a drawn node's position per frame; the listener is kept, not called
  "nRequestPositionUpdates(JLjava/lang/ref/WeakReference;)V": (h: bigint, l: object | null) => {
    const n = nodeAt(h);
    n.positionListener = l; n.position = null;
  },
  "nDiscardDisplayList(J)V": (h: bigint) => { nodeAt(h).ops = null; },
  "nIsValid(J)Z": (h: bigint) => +(nodeAt(h).ops !== null),
  "nSetUsageHint(JI)V": (h: bigint, hint: number) => { nodeAt(h).usageHint = hint; },
  "nSetIsTextureView(J)V": () => {},

  "nGetTransformMatrix(JJ)V": (h: bigint, out: bigint) => {
    const n = nodeAt(h);
    n.updateMatrix();
    matrixAt(out).set(n.transform ?? IDENTITY);
  },
  "nGetInverseTransformMatrix(JJ)V": (h: bigint, out: bigint) => {
    const n = nodeAt(h);
    n.updateMatrix();
    matrixAt(out).set((n.transform && invert(n.transform)) ?? IDENTITY);
  },
  "nHasIdentityMatrix(J)Z": (h: bigint) => +!nodeAt(h).hasTransform(),
  "nGetUniqueId(J)J": (h: bigint) => nodeAt(h).id,
  "nSetStaticMatrix(JJ)Z": (h: bigint, m: bigint) => { nodeAt(h).staticMatrix = m ? matrixAt(m).slice() : null; return 1; },
  "nSetAnimationMatrix(JJ)Z": (h: bigint, m: bigint) => { nodeAt(h).animationMatrix = m ? matrixAt(m).slice() : null; return 1; },
  "nGetAnimationMatrix(JJ)Z": (h: bigint, out: bigint) => {
    const m = nodeAt(h).animationMatrix;
    if (m) matrixAt(out).set(m);
    return +!!m;
  },

  "nSetLayerType(JI)Z": (h: bigint, type: number) => {
    const n = nodeAt(h);
    if (n.layerType === type) return 0;
    n.layerType = type;
    n.setLayerPaint(null);
    return 1;
  },
  "nGetLayerType(J)I": get("layerType"),
  "nSetLayerPaint(JJ)Z": (h: bigint, p: bigint) => nodeAt(h).setLayerPaint(p ? paintAt(p) : null),
  "nSetRenderEffect(JJ)Z": (h: bigint, e: bigint) => set("effect")(h, e ? deref<NativeRenderEffect>(e) : null),
  // a backdrop effect filters what is drawn behind the node, which needs the compositor's surface
  "nSetBackdropRenderEffect(JJ)Z": (h: bigint, e: bigint) => set("backdrop")(h, e ? deref<NativeRenderEffect>(e) : null),
  "nSetHasOverlappingRendering(JZ)Z": setBool("overlapping"),
  "nHasOverlappingRendering(J)Z": bool("overlapping"),
  "nSetAllowForceDark(JZ)Z": setBool("forceDark"),
  "nGetAllowForceDark(J)Z": bool("forceDark"),
  "nSetProjectBackwards(JZ)Z": setBool("projectBackwards"),
  "nSetProjectionReceiver(JZ)Z": setBool("projectionReceiver"),

  "nSetClipToBounds(JZ)Z": (h: bigint, clip: number) => {
    const n = nodeAt(h), flags = clip ? n.clipFlags | CLIP_TO_BOUNDS : n.clipFlags & ~CLIP_TO_BOUNDS;
    if (flags === n.clipFlags) return 0;
    n.clipFlags = flags;
    return 1;
  },
  "nGetClipToBounds(J)Z": (h: bigint) => +!!(nodeAt(h).clipFlags & CLIP_TO_BOUNDS),
  "nSetClipBounds(JIIII)Z": (h: bigint, l: number, t: number, r: number, b: number) => {
    const n = nodeAt(h), flagged = !(n.clipFlags & CLIP_TO_CLIP_BOUNDS);
    n.clipFlags |= CLIP_TO_CLIP_BOUNDS;
    if (n.clipL === l && n.clipT === t && n.clipR === r && n.clipB === b) return +flagged;
    n.clipL = l; n.clipT = t; n.clipR = r; n.clipB = b;
    return 1;
  },
  "nSetClipBoundsEmpty(J)Z": (h: bigint) => {
    const n = nodeAt(h);
    if (!(n.clipFlags & CLIP_TO_CLIP_BOUNDS)) return 0;
    n.clipFlags &= ~CLIP_TO_CLIP_BOUNDS;
    return 1;
  },
  "nSetOutlineRoundRect(JIIIIFF)Z": (h: bigint, l: number, t: number, r: number, b: number, radius: number, alpha: number) => {
    const n = nodeAt(h);
    n.outline = Outline.RoundRect; n.outlineL = l; n.outlineT = t; n.outlineR = r; n.outlineB = b;
    n.outlineRadius = radius; n.outlineAlpha = alpha; n.outlinePath = null;
    return 1;
  },
  "nSetOutlinePath(JJF)Z": (h: bigint, p: bigint, alpha: number) => {
    const n = nodeAt(h), path = new NativePath();
    path.set(deref<NativePath>(p));
    n.outline = Outline.Path; n.outlinePath = path; n.outlineAlpha = alpha;
    return 1;
  },
  "nSetOutlineEmpty(J)Z": (h: bigint) => { const n = nodeAt(h); n.outline = Outline.Empty; n.outlinePath = null; n.outlineAlpha = 0; return 1; },
  "nSetOutlineNone(J)Z": (h: bigint) => { const n = nodeAt(h); n.outline = Outline.None; n.outlinePath = null; n.outlineAlpha = 0; return 1; },
  "nHasShadow(J)Z": (h: bigint) => +nodeAt(h).hasShadow,
  "nSetClipToOutline(JZ)Z": (h: bigint, clip: number) => { nodeAt(h).outlineClip = !!clip; return 1; },
  "nGetClipToOutline(J)Z": bool("outlineClip"),
  "nSetRevealClip(JZFFF)Z": (h: bigint, clip: number, x: number, y: number, radius: number) => {
    const n = nodeAt(h);
    n.revealClip = !!clip; n.revealX = x; n.revealY = y; n.revealRadius = radius;
    return 1;
  },
  // the overscroll stretch (StretchEffect::mergeWith), which hwui draws as a shader over the layer
  "nStretch(JFFFF)Z": (h: bigint, x: number, y: number, maxX: number, maxY: number) => {
    const n = nodeAt(h), s = n.stretch;
    n.stretch = s ? { x: s.x + x, y: s.y + y, maxX: Math.max(s.maxX, maxX), maxY: Math.max(s.maxY, maxY) } : { x, y, maxX, maxY };
    return 1;
  },
  "nClearStretch(J)Z": (h: bigint) => { const n = nodeAt(h); if (!n.stretch) return 0; n.stretch = null; return 1; },

  "nSetAlpha(JF)Z": (h: bigint, a: number) => {
    const alpha = a <= ALPHA_EPSILON ? 0 : a >= f32(1 - ALPHA_EPSILON) ? 1 : a;
    return set("alpha")(h, alpha);
  },
  "nGetAlpha(J)F": get("alpha"),
  "nSetElevation(JF)Z": set("elevation"), "nGetElevation(J)F": get("elevation"),
  "nSetTranslationX(JF)Z": transformSetter("tx"), "nGetTranslationX(J)F": get("tx"),
  "nSetTranslationY(JF)Z": transformSetter("ty"), "nGetTranslationY(J)F": get("ty"),
  "nSetTranslationZ(JF)Z": set("tz"), "nGetTranslationZ(J)F": get("tz"),
  "nSetRotation(JF)Z": transformSetter("rotation"), "nGetRotation(J)F": get("rotation"),
  "nSetRotationX(JF)Z": transformSetter("rotationX"), "nGetRotationX(J)F": get("rotationX"),
  "nSetRotationY(JF)Z": transformSetter("rotationY"), "nGetRotationY(J)F": get("rotationY"),
  "nSetScaleX(JF)Z": transformSetter("scaleX"), "nGetScaleX(J)F": get("scaleX"),
  "nSetScaleY(JF)Z": transformSetter("scaleY"), "nGetScaleY(J)F": get("scaleY"),
  "nSetPivotX(JF)Z": (h: bigint, v: number) => nodeAt(h).setPivot("pivotX", v),
  "nSetPivotY(JF)Z": (h: bigint, v: number) => nodeAt(h).setPivot("pivotY", v),
  "nGetPivotX(J)F": (h: bigint) => { const n = nodeAt(h); n.updateMatrix(); return n.pivotX; },
  "nGetPivotY(J)F": (h: bigint) => { const n = nodeAt(h); n.updateMatrix(); return n.pivotY; },
  "nResetPivot(J)Z": (h: bigint) => {
    const n = nodeAt(h);
    if (!n.pivotExplicit) return 0;
    n.pivotExplicit = false; n.dirty = true;
    return 1;
  },
  "nIsPivotExplicitlySet(J)Z": bool("pivotExplicit"),
  // Sk3DView's camera, placed at (0, 0, distance) inches; Java passes the negated distance
  "nSetCameraDistance(JF)Z": (h: bigint, d: number) => {
    const n = nodeAt(h);
    if (d === n.cameraZ) return 0;
    n.camera.location = [0, 0, f32(d * 72)];
    n.dirty = true;
    return 1;
  },
  "nGetCameraDistance(J)F": (h: bigint) => nodeAt(h).cameraZ,
  "nSetLeft(JI)Z": sideSetter("left"), "nSetTop(JI)Z": sideSetter("top"),
  "nSetRight(JI)Z": sideSetter("right"), "nSetBottom(JI)Z": sideSetter("bottom"),
  "nGetLeft(J)I": get("left"), "nGetTop(J)I": get("top"), "nGetRight(J)I": get("right"), "nGetBottom(J)I": get("bottom"),
  "nGetWidth(J)I": (h: bigint) => nodeAt(h).width,
  "nGetHeight(J)I": (h: bigint) => nodeAt(h).height,
  "nSetLeftTopRightBottom(JIIII)Z": (h: bigint, l: number, t: number, r: number, b: number) => {
    const n = nodeAt(h);
    if (n.left === l && n.top === t && n.right === r && n.bottom === b) return 0;
    n.left = l; n.top = t; n.right = r; n.bottom = b;
    if (!n.pivotExplicit) n.dirty = true;
    return 1;
  },
  "nOffsetLeftAndRight(JI)Z": (h: bigint, d: number) => { if (!d) return 0; const n = nodeAt(h); n.left += d; n.right += d; return 1; },
  "nOffsetTopAndBottom(JI)Z": (h: bigint, d: number) => { if (!d) return 0; const n = nodeAt(h); n.top += d; n.bottom += d; return 1; },
  "nSetAmbientShadowColor(JI)Z": set("ambientColor"), "nGetAmbientShadowColor(J)I": get("ambientColor"),
  "nSetSpotShadowColor(JI)Z": set("spotColor"), "nGetSpotShadowColor(J)I": get("spotColor"),
});

// ── RecordingCanvas: SkiaRecordingCanvas records into a display list its node takes when done ──
/** a new recording over a fresh canvas state; the list goes to its node when the recording finishes */
function beginRecording(nc: NativeCanvas, w: number, h: number) {
  const rec = nc.recorder!;
  rec.take();
  nc.setTarget(rec.ctx, w, h, null);
}
/** AnimatedRippleDrawable: the ripple's circle through its RuntimeShader, with the uniforms the
 *  animated properties drive set as drawn (the turbulence as RippleShader.setNoisePhase sets it) */
const RIPPLE_SCALE = 1.5, PI = Math.PI, PI_ROTATE_RIGHT = PI * 0.0078125, PI_ROTATE_LEFT = -PI_ROTATE_RIGHT;
function drawRipple(ctx: Ctx2D, x: number, y: number, radius: number, paint: NativePaint, progress: number, phase: number, color: number, b: RuntimeShaderBuilder) {
  const circle = (name: string, offset: number, scale: number, angle: number) =>
    b.trySet(name, [offset + phase * scale * Math.cos(angle), offset + phase * scale * Math.sin(angle)]);
  const rotation = (name: string, angle: number) => b.trySet(name, [Math.cos(angle), Math.sin(angle)]);
  b.trySet("in_origin", [x, y]);
  b.trySet("in_maxRadius", [radius]);
  b.trySet("in_progress", [progress]);
  b.trySet("in_turbulencePhase", [phase]);
  b.trySet("in_noisePhase", [phase * 0.001]);
  b.trySet("in_color", [(color >>> 16 & 255) / 255, (color >>> 8 & 255) / 255, (color & 255) / 255, (color >>> 24) / 255], true);
  circle("in_tCircle1", RIPPLE_SCALE * 0.5, 0.01, RIPPLE_SCALE * 0.55);
  circle("in_tCircle2", RIPPLE_SCALE * 0.2, -0.0066, RIPPLE_SCALE * 0.45);
  circle("in_tCircle3", RIPPLE_SCALE, -0.0066, RIPPLE_SCALE * 0.35);
  rotation("in_tRotation1", phase * PI_ROTATE_RIGHT + 1.7 * PI);
  rotation("in_tRotation2", phase * PI_ROTATE_LEFT + 2 * PI);
  rotation("in_tRotation3", phase * PI_ROTATE_RIGHT + 2.75 * PI);
  // the shader is rasterized only under the circle (RippleDrawable fills it), not the whole window
  const m = ctx.getTransform(), W = ctx.canvas.width, H = ctx.canvas.height;
  const ex = Math.hypot(m.a, m.c) * radius + 1, ey = Math.hypot(m.b, m.d) * radius + 1;
  const cx = m.a * x + m.c * y + m.e, cy = m.b * x + m.d * y + m.f;
  const x0 = Math.max(0, Math.floor(cx - ex)), y0 = Math.max(0, Math.floor(cy - ey));
  const x1 = Math.min(W, Math.ceil(cx + ex)), y1 = Math.min(H, Math.ceil(cy + ey));
  if (x1 <= x0 || y1 <= y0) return;
  const shaded = new NativePaint();
  copyPaint(paint, shaded);
  shaded.shader = b.shader(null, [x0, y0, x1 - x0, y1 - y0]);
  drawCircle(NativeCanvas.over(ctx), x, y, radius, shaded);
}
/** CanvasProperty's containers: a float, or a paint an animator changes, read when replayed */
type Property<T> = { value: T };
export const prop = <T>(h: bigint) => deref<Property<T>>(h);
rt.registerJnis("android/graphics/RecordingCanvas", {
  "nCreateDisplayListCanvas(JII)J": (_node: bigint, w: number, h: number) => {
    const nc = new NativeCanvas();
    nc.recorder = new Recorder();
    beginRecording(nc, w, h);
    return handle(nc);
  },
  "nResetDisplayListCanvas(JJII)V": (h: bigint, _node: bigint, w: number, ht: number) => beginRecording(canvasAt(h), w, ht),
  // SkiaRecordingCanvas::finishRecording closes what is still open before the node takes the list
  "nFinishRecording(JJ)V": (h: bigint, node: bigint) => {
    const nc = canvasAt(h);
    nc.restoreToCount(1);
    nodeAt(node).setDisplayList(nc.recorder!.take());
  },
  "nDrawRenderNode(JJ)V": (h: bigint, node: bigint) => {
    const nc = canvasAt(h), n = nodeAt(node);
    replayFor(nc, () => recordOrRun(nc.ctx, (ctx) => drawNodeInto(ctx, n)));
  },
  // A reorder barrier draws its children by Z; without shadows to cast, they draw in order here.
  "nEnableZ(JZ)V": () => {},
  // DeviceInfo::maxTextureSize on the reference device
  "nGetMaximumTextureWidth()I": () => 8192,
  "nGetMaximumTextureHeight()I": () => 8192,
  // a display list holds its properties, as hwui's does, and reads their values (which render-thread
  // animators move) when it replays
  "nDrawCircle(JJJJJ)V": (h: bigint, x: bigint, y: bigint, r: bigint, p: bigint) => {
    const [px, py, pr, pp] = [prop<number>(x), prop<number>(y), prop<number>(r), prop<NativePaint>(p)];
    recordOrRun(canvasAt(h).ctx, (ctx) => drawCircle(NativeCanvas.over(ctx), px.value, py.value, pr.value, pp.value));
  },
  "nDrawRoundRect(JJJJJJJJ)V": (h: bigint, l: bigint, t: bigint, r: bigint, b: bigint, rx: bigint, ry: bigint, p: bigint) => {
    const [pl, pt, pr, pb, prx, pry, pp] = [prop<number>(l), prop<number>(t), prop<number>(r), prop<number>(b), prop<number>(rx), prop<number>(ry), prop<NativePaint>(p)];
    recordOrRun(canvasAt(h).ctx, (ctx) => drawRoundRect(NativeCanvas.over(ctx), pl.value, pt.value, pr.value, pb.value, prx.value, pry.value, pp.value));
  },
  // the ripple is a RuntimeShader animated on the RenderThread
  "nDrawRipple(JJJJJJJIJ)V": (h: bigint, x: bigint, y: bigint, r: bigint, p: bigint, progress: bigint, phase: bigint, color: number, builder: bigint) => {
    const [px, py, pr, pp, pg, ph] = [prop<number>(x), prop<number>(y), prop<number>(r), prop<NativePaint>(p), prop<number>(progress), prop<number>(phase)];
    const shader = deref<RuntimeShaderBuilder>(builder);
    recordOrRun(canvasAt(h).ctx, (ctx) => drawRipple(ctx, px.value, py.value, pr.value, pp.value, pg.value, ph.value, color, shader));
  },
  "nDrawTextureLayer(JJ)V": (h: bigint, layer: bigint) => {
    const l = deref<TextureLayer>(layer);
    recordOrRun(canvasAt(h).ctx, (ctx) => l.draw(ctx));
  },
  // replayed, the functor is clipped by the nodes drawing it and the canvas replaying them
  "nDrawWebViewFunctor(JI)V": (h: bigint, functor: number) => {
    const nc = canvasAt(h);
    if (isRecording(nc.ctx)) recordOrRun(nc.ctx, (ctx) => {
      const r = replayingCanvas();
      drawFunctor(ctx, functor, r ? [r.cl, r.ct, r.cr, r.cb] : null);
    });
    else drawFunctor(nc.ctx, functor, [nc.cl, nc.ct, nc.cr, nc.cb]);
  },
});
rt.registerJnis("android/graphics/CanvasProperty", {
  "nCreateFloat(F)J": (value: number) => ownedHandle({ value }),
  "nCreatePaint(J)J": (p: bigint) => { const value = new NativePaint(); copyPaint(paintAt(p), value); return ownedHandle({ value }); },
});
// A VirtualRefBasePtr adds its own reference to a JNI-created RefBase object.
rt.registerJnis("com/android/internal/util/VirtualRefBasePtr", {
  "nIncStrong(J)V": incStrong,
  "nDecStrong(J)V": decStrong,
});
