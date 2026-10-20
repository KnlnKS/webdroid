// TextureView's consumer and producer halves under AOSP's TextureView: hwui's DeferredLayerUpdater
// (TextureLayer) over the view's SurfaceTexture, which RecordingCanvas.drawTextureLayer draws with
// the layer's transform and paint, and the ANativeWindow TextureView.lockCanvas draws into.
import { rt, type JObj, peerField, setDeclared } from "../jvm/runtime.ts";
import { handle, deref, release } from "./handles.ts";
import { canvasOf } from "./canvas.ts";
import { paintAt } from "./paint.ts";
import { type Mat, isIdentity, applyMatrix } from "./matrix.ts";
import type { NativeBitmap } from "./bitmap.ts";
import type { Ctx2D } from "./recording.ts";
import { type NativeSurfaceTexture, surfaceTextureOf, presentSurface, bufferWidth, bufferHeight } from "./glsurface.ts";

export class TextureLayer {
  texture: NativeSurfaceTexture | null = null;
  width = 0; height = 0; opaque = false;
  transform: Mat | null = null;
  alpha = 1;
  /** the producer's latest frame: the layer consumes in async mode, so a draw shows the newest */
  get frame(): ImageBitmap | VideoFrame | null {
    const st = this.texture;
    return st && !st.abandoned ? st.surface.present : null;
  }
  /** LayerDrawable: the frame scaled to the layer's size, under its transform and paint alpha */
  draw(ctx: Ctx2D): void {
    const frame = this.frame;
    if (!frame || this.width <= 0 || this.height <= 0) return;
    ctx.save();
    if (this.transform) applyMatrix(ctx, this.transform);
    ctx.globalAlpha *= this.alpha;
    ctx.drawImage(frame, 0, 0, this.width, this.height);
    ctx.restore();
  }
  copyInto(target: OffscreenCanvasRenderingContext2D, w: number, h: number): boolean {
    const frame = this.frame;
    if (!frame) return false;
    target.drawImage(frame, 0, 0, w, h);
    return true;
  }
}
const layerAt = (h: bigint) => deref<TextureLayer>(h);

rt.registerJnis("android/graphics/TextureLayer", {
  "nPrepare(JIIZ)Z": (h: bigint, w: number, ht: number, opaque: number) => {
    const l = layerAt(h), changed = l.width !== w || l.height !== ht || l.opaque !== !!opaque;
    l.width = w; l.height = ht; l.opaque = !!opaque;
    return +changed;
  },
  "nSetLayerPaint(JJ)V": (h: bigint, p: bigint) => { layerAt(h).alpha = p ? (paintAt(p).color >>> 24) / 255 : 1; },
  "nSetTransform(JJ)V": (h: bigint, m: bigint) => {
    const matrix = m ? deref<Mat>(m) : null;
    layerAt(h).transform = matrix && !isIdentity(matrix) ? matrix.slice() : null;
  },
  "nSetSurfaceTexture(JLandroid/graphics/SurfaceTexture;)V": (h: bigint, st: JObj | null) => { layerAt(h).texture = surfaceTextureOf(st); },
  // the next draw reads the newest frame, which is what applying the update latches
  "nUpdateSurfaceTexture(J)V": () => {},
});

/** HardwareRenderer's texture-layer natives, which hwui.ts registers with the proxy's */
export const textureLayerNatives = {
  "nCreateTextureLayer(J)J": () => handle(new TextureLayer()),
  "nPushLayerUpdate(JJ)V": () => {},
  "nCancelLayerUpdate(JJ)V": () => {},
  // a render-node layer is replayed each frame rather than cached, so there is nothing to build
  "nBuildLayer(JJ)V": () => {},
  "nDetachSurfaceTexture(JJ)V": (_proxy: bigint, h: bigint) => { layerAt(h).texture = null; },
  "nCopyLayerInto(JJJ)Z": (_proxy: bigint, h: bigint, bitmap: bigint) => {
    const b = deref<NativeBitmap>(bitmap);
    return +layerAt(h).copyInto(b.ctx, b.w, b.h);
  },
};

// TextureView.lockCanvas: an ANativeWindow over the view's SurfaceTexture, a raster per lock that
// unlocking queues as the texture's next frame
interface NativeWindow { texture: NativeSurfaceTexture; raster: OffscreenCanvas | null }
const TEXTURE_VIEW = "android/view/TextureView", nativeWindow = peerField<bigint>(TEXTURE_VIEW, "mNativeWindow");
rt.registerJnis(TEXTURE_VIEW, {
  "nCreateNativeWindow(Landroid/graphics/SurfaceTexture;)V": function (this: JObj, st: JObj) {
    const texture = surfaceTextureOf(st);
    setDeclared(this, TEXTURE_VIEW, { mNativeWindow: texture ? handle({ texture, raster: null } satisfies NativeWindow) : 0n });
  },
  "nDestroyNativeWindow()V": function (this: JObj) {
    const h = nativeWindow(this);
    setDeclared(this, TEXTURE_VIEW, { mNativeWindow: 0n });
    if (h) release(h);
  },
  "nLockCanvas(JLandroid/graphics/Canvas;Landroid/graphics/Rect;)Z": (h: bigint, canvas: JObj) => {
    const window = h ? deref<NativeWindow>(h) : null, s = window?.texture.surface;
    if (!window || window.texture.abandoned || !s) return 0;
    const w = bufferWidth(s), ht = bufferHeight(s);
    const raster = window.raster ??= new OffscreenCanvas(w, ht);
    if (raster.width !== w || raster.height !== ht) { raster.width = w; raster.height = ht; }
    canvasOf(canvas).setTarget(raster.getContext("2d")!, w, ht, null);
    return 1;
  },
  "nUnlockCanvasAndPost(JLandroid/graphics/Canvas;)V": (h: bigint) => {
    const window = h ? deref<NativeWindow>(h) : null;
    if (window?.raster && !window.texture.abandoned) presentSurface(window.texture.surface, window.raster.transferToImageBitmap());
  },
});
