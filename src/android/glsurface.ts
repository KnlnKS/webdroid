// The GL surfaces EGL (egl.ts) draws to: a Surface's BLAST queue, a SurfaceTexture, a pbuffer; and
// SurfaceTexture's native half.
import { rt, JObj, peerField, setDeclared } from "../jvm/runtime.ts";
import { vcall, curThread, scall, after, iof } from "../jvm/natives/jentry.ts";
import { deref, handle, ownedHandle, release } from "./handles.ts";
import { uptimeNanos } from "../guest-clock.ts";
import { gl, tables, activate, currentContext } from "../native/gl-context.ts";
import { bindTexture, texImageSource } from "../native/gles3.ts";
import { perf } from "../perf.ts";
import { nativeSurface, glSurfaceOf, type Surface } from "./surfaceflinger.ts";
import { detached } from "../jvm/natives/jthrowable.ts";
import type { EglContext } from "./egl.ts";

export interface GlSurface {
  width: number;
  height: number;
  /** ANativeWindow_setBuffersGeometry's buffer size, which the consumer scales to the surface's; 0 follows width/height */
  userWidth?: number;
  userHeight?: number;
  present: ImageBitmap | VideoFrame | null;
  frames: number;
  swapInterval?: number;
  presentationTimeNanos?: bigint;
  onFrame?: () => void;
  /** the buffer a Canvas (Surface.lockCanvas, a HardwareRenderer) draws a SurfaceTexture's next frame into */
  canvas?: OffscreenCanvas;
  /** a BLAST queue's producer side (surfaceflinger.ts glSurfaceOf): a frame goes to the queue, which
   *  releases it once the layer latches the next */
  post?: (frame: ImageBitmap | VideoFrame) => void;
}
/** a frame's size: a decoder's visible area, or an image's */
export const frameSize = (f: TexImageSource): [number, number] =>
  "displayWidth" in f ? [f.displayWidth, f.displayHeight] : [(f as ImageBitmap).width, (f as ImageBitmap).height];
/** the timestamp a consumer reads for a frame just queued to `s`: a decoder's presentation time, else
 *  eglPresentationTimeANDROID's, which applies to this frame only, else now */
export function frameTimestamp(s: GlSurface, frame: ImageBitmap | VideoFrame | null): bigint {
  const t = frame && "timestamp" in frame && frame.timestamp !== null ? BigInt(frame.timestamp) * 1000n : s.presentationTimeNanos ?? uptimeNanos();
  s.presentationTimeNanos = undefined;
  return t;
}
export const bufferWidth = (s: GlSurface): number => s.userWidth || s.width;
export const bufferHeight = (s: GlSurface): number => s.userHeight || s.height;
export function presentSurface(surface: GlSurface, frame: ImageBitmap | VideoFrame): void {
  if (!surface.post) surface.present?.close();
  surface.present = frame;
  surface.frames++;
  perf.glFrames++;
  surface.post?.(frame);
  surface.onFrame?.();
}
/** the surface a Surface or SurfaceTexture draws to, while it exists */
export function surfaceTarget(win: unknown): GlSurface | null {
  const s = iof(win, "android/view/Surface") ? nativeSurface(win as JObj) : null;
  return s ? glSurfaceOf(s) : liveSurface(surfaceTextureOf(win));
}
/** EGLImpl's native window: a Surface or SurfaceTexture, or the Surface of a SurfaceView's or a
 *  SurfaceHolder's, which AOSP's own classes answer through Java */
export function windowSurface(win: unknown): GlSurface | null | Promise<GlSurface | null> {
  const s = surfaceTarget(win);
  if (s || !(win instanceof JObj)) return s;
  const holder = iof(win, "android/view/SurfaceView") ? vcall(win, "getHolder", "()Landroid/view/SurfaceHolder;") : win;
  return after(holder, (h: JObj | null) => h && iof(h, "android/view/SurfaceHolder")
    ? after(vcall(h, "getSurface", "()Landroid/view/Surface;"), surfaceTarget) : null);
}
// SurfaceTexture's native half (android_graphics_SurfaceTexture.cpp over libnativedisplay's
// SurfaceTexture and EGLConsumer): the producer side is a GlSurface whose latest frame
// updateTexImage latches into the texture. Statuses are the status_t the JNI turns into throws.
const NO_INIT = -19, INVALID_OPERATION = -38;
const IDENTITY = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
/** GLConsumer::computeTransformMatrix for a buffer with no crop or transform: SurfaceFlinger's
 *  top-row-at-t=0 textures, flipped for applications */
const FLIP_V = Float32Array.of(1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1);
export class NativeSurfaceTexture {
  texName: number; weak: object | null;
  surface: GlSurface = { width: 1, height: 1, present: null, frames: 0, onFrame: () => this.frameAvailable() };
  abandoned = false;
  /** mOpMode == attachedToGL, over texture `texName` in `context` (null until first used: mEglContext) */
  attached: boolean;
  context: EglContext | null = null;
  /** the surface's frame count at the last latch; a current buffer exists once one latched */
  latched = 0;
  current = false;
  queued = 0n;
  timestamp = 0n;
  matrix = IDENTITY;
  constructor(texName: number, detached: boolean, weak: object | null) { this.texName = texName; this.weak = weak; this.attached = !detached; }
  /** JNISurfaceTextureContext::onFrameAvailable: postEventFromNative(weakThiz) */
  frameAvailable(): void {
    this.queued = frameTimestamp(this.surface, this.surface.present);
    if (!this.weak) return;
    detached(() => scall(SURFACE_TEXTURE, "postEventFromNative", "(Ljava/lang/ref/WeakReference;)V", this.weak));
  }
  /** EGLConsumer::checkAndUpdateEglStateLocked: the first use records the current context */
  private eglState(thread: object, contextCheck: boolean): boolean {
    const current = activate(thread);
    if (!contextCheck) this.context ??= current;
    return current !== null && this.context === current;
  }
  /** bindTextureImageLocked, uploading `frame` when it is new */
  private bind(frame: ImageBitmap | VideoFrame | null): void {
    if (!gl) return;
    bindTexture(0x8d65, this.texName);                                         // GL_TEXTURE_EXTERNAL_OES
    if (frame && tables().textures[this.texName]) texImageSource(0x0de1, 0, 0x1908, 0x1908, 0x1401, frame);
  }
  update(thread: object = curThread): number {
    if (this.abandoned) return NO_INIT;
    if (!this.eglState(thread, false)) return INVALID_OPERATION;
    const s = this.surface;
    if (!s.present || s.frames === this.latched) { this.bind(null); return 0; }
    this.latched = s.frames;
    this.current = true;
    this.timestamp = this.queued;
    this.matrix = FLIP_V;
    this.bind(s.present);
    return 0;
  }
  releaseTexImage(): number {
    if (this.abandoned) return NO_INIT;
    if (this.attached && !this.eglState(curThread, true)) return INVALID_OPERATION;
    if (this.current) {
      this.current = false;
      this.timestamp = 0n;
      if (this.attached) this.bind(null);
    }
    return 0;
  }
  /** a detach deletes the texture in the current context; an attach binds the current image to a new one */
  detach(thread: object = curThread): number {
    if (this.abandoned) return NO_INIT;
    const current = activate(thread);
    if (!this.attached || (this.context && this.context !== current)) return INVALID_OPERATION;
    const t = tables().textures;
    if (current && gl && t[this.texName]) { gl.deleteTexture(t[this.texName]!); t[this.texName] = null; }
    this.context = null;
    this.attached = false;
    return 0;
  }
  attach(texName: number, thread: object = curThread): number {
    if (this.abandoned) return NO_INIT;
    const current = activate(thread);
    if (this.attached || !current) return INVALID_OPERATION;
    this.texName = texName;
    this.bind(this.current ? this.surface.present : null);
    this.context = current;
    this.attached = true;
    return 0;
  }
  release(): void {
    if (this.abandoned) return;
    this.abandoned = true;
    const s = this.surface;
    s.present?.close();
    s.present = null;
    s.onFrame = undefined;
    const current = currentContext(curThread);
    if (current?.target === s) current.target = null;
  }
}
const SURFACE_TEXTURE = "android/graphics/SurfaceTexture";
const stPtr = peerField<bigint>(SURFACE_TEXTURE, "mSurfaceTexture");
/** the native SurfaceTexture behind a Java one, or null for any other object */
export function surfaceTextureOf(o: unknown): NativeSurfaceTexture | null {
  const n = o && typeof o === "object" && iof(o, SURFACE_TEXTURE) ? deref(stPtr(o)) : null;
  return n instanceof NativeSurfaceTexture ? n : null;
}
const nst = (st: object) => surfaceTextureOf(st)!;
/** a producer's view of its SurfaceTexture: gone once the consumer is abandoned */
const liveSurface = (st: NativeSurfaceTexture | null) => st && !st.abandoned ? st.surface : null;
const throwIf = (status: number, invalid: string, other: string) => {
  if (status === INVALID_OPERATION) throw rt.mkThrowable("java/lang/IllegalStateException", invalid);
  if (status < 0) throw rt.mkThrowable("java/lang/RuntimeException", other);
};
rt.registerJnis(SURFACE_TEXTURE, {
  // single-buffer mode needs no more than this: a producer here never waits on a free buffer
  "nativeInit(ZIZLjava/lang/ref/WeakReference;)V": function (this: JObj, detached: number, texName: number, _single: number, weak: object) {
    setDeclared(this, SURFACE_TEXTURE, { mSurfaceTexture: ownedHandle(new NativeSurfaceTexture(texName, !!detached, weak)) });
  },
  "nativeFinalize()V": function (this: JObj) {
    const h = stPtr(this);
    nst(this).weak = null;
    setDeclared(this, SURFACE_TEXTURE, { mSurfaceTexture: 0n });
    release(h);
  },
  "nativeUpdateTexImage()V": function (this: object) {
    throwIf(nst(this).update(), "Unable to update texture contents (see logcat for details)", "Error during updateTexImage (see logcat for details)");
  },
  "nativeReleaseTexImage()V": function (this: object) {
    throwIf(nst(this).releaseTexImage(), "Unable to release texture contents (see logcat for details)", "Error during updateTexImage (see logcat for details)");
  },
  "nativeDetachFromGLContext()I": function (this: object) { return nst(this).detach(); },
  "nativeAttachToGLContext(I)I": function (this: object, texName: number) { return nst(this).attach(texName); },
  "nativeGetTransformMatrix([F)V": function (this: object, out: Float32Array) { out.set(nst(this).matrix); },
  "nativeGetTimestamp()J": function (this: object) { return nst(this).timestamp; },
  // HAL_DATASPACE_UNKNOWN: no producer here tags its buffers
  "nativeGetDataSpace()I": () => 0,
  // BufferQueueConsumer::setDefaultBufferSize refuses an empty size without an error the JNI reports
  "nativeSetDefaultBufferSize(II)V": function (this: object, w: number, h: number) {
    if (w <= 0 || h <= 0) return;
    const s = nst(this).surface;
    s.width = w; s.height = h;
  },
  "nativeRelease()V": function (this: object) { nst(this).release(); },
  "nativeIsReleased()Z": function (this: object) { return +nst(this).abandoned; },
});
// new Surface(SurfaceTexture): a producer on the texture's GL surface
rt.registerJnis("android/view/Surface", {
  "nativeCreateFromSurfaceTexture(Landroid/graphics/SurfaceTexture;)J": (texture: object) => {
    const producer = liveSurface(nst(texture));
    if (!producer) throw rt.mkThrowable("java/lang/IllegalArgumentException", "SurfaceTexture has already been released");
    return handle({ queue: null, layer: null, producer } satisfies Surface);
  },
});
