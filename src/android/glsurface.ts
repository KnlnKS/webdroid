// The GL surfaces EGL draws to (a Surface's BLAST queue, a SurfaceTexture, a pbuffer), the EGL
// contexts over WebGL2 that draw them, SurfaceTexture's native half, and the Java EGL10/EGL14
// bindings. The native libEGL (native/egl.ts) binds to the same contexts and surfaces.
import { awaited, rt, JObj, stubs, driven, declaredField, setDeclared, type Gen } from "../jvm/runtime";
import { vcall, JThread, curThread, scall, after, iof, linkClass } from "../jvm/natives/jentry";
import { deref, handle, ownedHandle, release } from "./handles";
import { uptimeMillis } from "../guest-clock";
import { gl, tables, untracked } from "./gl";
import { vsync } from "./vsync";
import { perf } from "../perf";
import { bindEglCurrent, boundEglCurrent, glSurfaces } from "../native/egl-current";
import { nativeSurface, glSurfaceOf, type Surface } from "./surfaceflinger";
import { detached } from "../jvm/natives/jthrowable";

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
/** An EGL context owns the WebGL2 context: WebGL binds one to a canvas for life, so making a
 *  surface current retargets the canvas to the surface's size, and a swap hands the finished frame
 *  to the surface as an ImageBitmap (what the compositor draws, what a probe samples). A shared
 *  context shares the canvas, hence the object namespace. */
export class EglContext {
  canvas: OffscreenCanvas;
  gl: WebGL2RenderingContext | null = null;
  target: GlSurface | null = null;
  major = 2;
  constructor(share?: EglContext | null) { this.canvas = share?.canvas ?? new OffscreenCanvas(1, 1); }
  makeCurrent(s: GlSurface | null, thread = curThread): boolean {
    this.gl ??= this.canvas.getContext("webgl2", { alpha: false, antialias: false, depth: true, stencil: true, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    if (!this.gl || this.gl.isContextLost()) return false;
    if (s) this.fit(s);
    this.target = s;
    bindEglCurrent(thread, this);
    return true;
  }
  /** the drawing buffer takes the surface's buffer size; a new geometry applies from the next frame */
  private fit(s: GlSurface): void {
    const width = bufferWidth(s), height = bufferHeight(s);
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
  }
  /** present: the frame goes to the surface's consumer and the caller waits for the next display
   *  frame (eglSwapBuffers blocks for vsync) */
  swap(): Promise<boolean> {
    const s = this.target;
    if (!s || this.gl?.isContextLost()) return Promise.resolve(false);
    let bmp: ImageBitmap;
    try { bmp = this.canvas.transferToImageBitmap(); }
    catch (e) { if (this.gl?.isContextLost()) return Promise.resolve(false); throw e; }
    presentSurface(s, bmp);
    this.fit(s);
    if (s.swapInterval === 0) return Promise.resolve(!this.gl?.isContextLost());
    return vsync().then(() => !this.gl?.isContextLost());
  }
}
export function setEglSwapInterval(interval: number, thread = curThread): number {
  const context = boundEglCurrent(thread);
  if (!context) return eglFailure(0x3006, 0, thread);
  if (!context.target) return eglFailure(0x300d, 0, thread);
  context.target.swapInterval = Math.max(0, Math.min(1, interval));
  return 1;
}
class JEGLContext extends JObj { egl!: EglContext; }
/** the one EGL config: RGBA8, depth 24, stencil 8, no multisampling, ES1/2/3, window + pbuffer */
export function eglConfigAttrib(attr: number): number {
  switch (attr) {
    case 0x3024: case 0x3023: case 0x3022: case 0x3021: return 8;
    case 0x3020: return 32; case 0x3025: return 24; case 0x3026: return 8;   // BUFFER_SIZE, DEPTH_SIZE, STENCIL_SIZE
    case 0x3031: case 0x3032: return 0;                                     // SAMPLES, SAMPLE_BUFFERS
    case 0x3033: return 1 | 4;                                              // SURFACE_TYPE: PBUFFER | WINDOW
    case 0x3040: return 1 | 4 | 0x40;                                       // RENDERABLE_TYPE: ES1 | ES2 | ES3
    case 0x3027: return 0x3038; case 0x3028: return 1;                      // CONFIG_CAVEAT: NONE; CONFIG_ID
    case 0x302e: return 1;                                                  // NATIVE_VISUAL_ID: RGBA_8888
    case 0x3039: return 1; case 0x303a: return 0;                           // BIND_TO_TEXTURE_RGB/RGBA
    case 0x303b: return 0; case 0x303c: return 1;                            // MIN/MAX_SWAP_INTERVAL
    case 0x303f: return 0x308e;                                             // COLOR_BUFFER_TYPE: RGB
    case 0x302a: case 0x302b: return 4096; case 0x302c: return 1 << 24;     // MAX_PBUFFER_WIDTH/HEIGHT/PIXELS
    default: return 0;
  }
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
  constructor(public texName: number, detached: boolean, public weak: object | null) { this.attached = !detached; }
  /** JNISurfaceTextureContext::onFrameAvailable: postEventFromNative(weakThiz) */
  frameAvailable(): void {
    const frame = this.surface.present;
    this.queued = typeof VideoFrame !== "undefined" && frame instanceof VideoFrame ? BigInt(frame.timestamp) * 1000n
      : this.surface.presentationTimeNanos ?? BigInt(Math.floor(uptimeMillis() * 1e6));
    this.surface.presentationTimeNanos = undefined;
    if (!this.weak) return;
    detached(() => scall(SURFACE_TEXTURE, "postEventFromNative", "(Ljava/lang/ref/WeakReference;)V", this.weak));
  }
  /** EGLConsumer::checkAndUpdateEglStateLocked: the first use records the current context */
  private eglState(contextCheck: boolean): boolean {
    const current = glSurfaces.current;
    if (!contextCheck) this.context ??= current;
    return current !== null && this.context === current;
  }
  /** bindTextureImageLocked, uploading `frame` when it is new */
  private bind(frame: ImageBitmap | VideoFrame | null): void {
    if (!gl) return;
    const texture = tables().textures[this.texName] ?? null;
    untracked();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (texture && frame) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  }
  update(): number {
    if (this.abandoned) return NO_INIT;
    if (!this.eglState(false)) return INVALID_OPERATION;
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
    if (this.attached && !this.eglState(true)) return INVALID_OPERATION;
    if (this.current) {
      this.current = false;
      this.timestamp = 0n;
      if (this.attached) this.bind(null);
    }
    return 0;
  }
  /** a detach deletes the texture in the current context; an attach binds the current image to a new one */
  detach(): number {
    if (this.abandoned) return NO_INIT;
    const current = glSurfaces.current;
    if (!this.attached || (this.context && this.context !== current)) return INVALID_OPERATION;
    const t = tables().textures;
    if (current && gl && t[this.texName]) { gl.deleteTexture(t[this.texName]!); t[this.texName] = null; }
    this.context = null;
    this.attached = false;
    return 0;
  }
  attach(texName: number): number {
    if (this.abandoned) return NO_INIT;
    const current = glSurfaces.current;
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
    if (glSurfaces.current?.target === s) glSurfaces.current.target = null;
  }
}
const SURFACE_TEXTURE = "android/graphics/SurfaceTexture";
let stField = "";
const stPtr = () => stField ||= declaredField(SURFACE_TEXTURE, "mSurfaceTexture");
/** the native SurfaceTexture behind a Java one, or null for any other object */
export function surfaceTextureOf(o: unknown): NativeSurfaceTexture | null {
  const n = o && typeof o === "object" && iof(o, SURFACE_TEXTURE) ? deref((o as Record<string, bigint>)[stPtr()]) : null;
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
  "nativeInit(ZIZLjava/lang/ref/WeakReference;)V": function (this: Record<string, bigint>, detached: number, texName: number, _single: number, weak: object) {
    this[stPtr()] = ownedHandle(new NativeSurfaceTexture(texName, !!detached, weak));
  },
  "nativeFinalize()V": function (this: Record<string, bigint>) {
    const h = this[stPtr()];
    nst(this).weak = null;
    this[stPtr()] = 0n;
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
rt.register({ name: "webdroid/GL10", ctor: class extends JObj {}, ifaces: ["javax/microedition/khronos/opengles/GL10", "javax/microedition/khronos/opengles/GL"],
  methods: { "glViewport(IIII)V": (x: number, y: number, w: number, h: number) => gl?.viewport(x, y, w, h) },
});
for (const i of ["javax/microedition/khronos/opengles/GL", "javax/microedition/khronos/opengles/GL10",
  "javax/microedition/khronos/opengles/GL11",
  "javax/microedition/khronos/egl/EGL"]) {
  rt.register({ name: i, ctor: class extends JObj {} });
}
class JEGL10Display extends JObj {}
rt.register({ name: "javax/microedition/khronos/egl/EGLDisplay", ctor: JEGL10Display });
rt.register({
  name: "javax/microedition/khronos/egl/EGLContext", ctor: JEGLContext,
  methods: {
    "static getEGL()Ljavax/microedition/khronos/egl/EGL;": () => rt.make("javax/microedition/khronos/egl/EGL11"),
    "getGL()Ljavax/microedition/khronos/opengles/GL;": () => rt.make("webdroid/GL10"),
  },
});

// ── EGL10: configs answer from the live context
class JEGLConfig extends JObj {}
rt.register({ name: "javax/microedition/khronos/egl/EGLConfig", ctor: JEGLConfig });
const theConfig = new JEGLConfig();
class JEGLSurface extends JObj { surf: GlSurface | null = null; }
const attrVal = (a: Int32Array | null, k: number): number => { if (a) for (let i = 0; i + 1 < a.length && a[i] !== 0x3038; i += 2) if (a[i] === k) return a[i + 1]; return 0; };
rt.register({ name: "javax/microedition/khronos/egl/EGLSurface", ctor: JEGLSurface });
const noEglContext = new JEGLContext(), noEglSurface = new JEGLSurface();
const egl10Display = new JEGL10Display(), noEglDisplay = new JEGL10Display();
const EGL_BAD_DISPLAY = 0x3008;
const egl10DisplayValid = (display: unknown) => display === egl10Display;
/** the one config, as both eglGetConfigs and a matching eglChooseConfig report it */
function egl10Configs(display: unknown, configs: unknown[] | null, n: number, num: Int32Array | null): number {
  if (!egl10DisplayValid(display)) return eglFailure(EGL_BAD_DISPLAY, 0);
  if (configs && n > 0) configs[0] = theConfig;
  if (num) num[0] = 1;
  return 1;
}
const eglContexts = new WeakMap<EglContext, JEGLContext>();
class JEGL10 extends JObj {}
rt.register({
  name: "javax/microedition/khronos/egl/EGL10", ctor: JEGL10,
  statics: {
    EGL_RED_SIZE: 0x3024, EGL_GREEN_SIZE: 0x3023, EGL_BLUE_SIZE: 0x3022, EGL_ALPHA_SIZE: 0x3021,
    EGL_DEPTH_SIZE: 0x3025, EGL_STENCIL_SIZE: 0x3026, EGL_RENDERABLE_TYPE: 0x3040, EGL_NONE: 0x3038,
    EGL_DEFAULT_DISPLAY: null, EGL_NO_CONTEXT: noEglContext, EGL_NO_DISPLAY: noEglDisplay, EGL_NO_SURFACE: noEglSurface,
    EGL_SUCCESS: 0x3000, EGL_CONFIG_CAVEAT: 0x3027, EGL_SAMPLES: 0x3031, EGL_SAMPLE_BUFFERS: 0x3032,
    EGL_BUFFER_SIZE: 0x3020, EGL_SURFACE_TYPE: 0x3033, EGL_WINDOW_BIT: 4, EGL_PBUFFER_BIT: 1, EGL_CONFIG_ID: 0x3028,
    EGL_WIDTH: 0x3057, EGL_HEIGHT: 0x3056, EGL_BAD_ALLOC: 0x3003, EGL_BAD_DISPLAY, EGL_BAD_NATIVE_WINDOW: 0x300b, EGL_CONTEXT_LOST: 0x300e,
    EGL_VENDOR: 0x3053, EGL_VERSION: 0x3054, EGL_EXTENSIONS: 0x3055, EGL_NATIVE_VISUAL_ID: 0x302e,
  },
  methods: {
    "eglChooseConfig(Ljavax/microedition/khronos/egl/EGLDisplay;[I[Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z":
      (display: unknown, _attrs: Int32Array, configs: unknown[] | null, n: number, num: Int32Array | null) => egl10Configs(display, configs, n, num),
    "eglGetConfigAttrib(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z":
      (display: unknown, config: unknown, attr: number, out: Int32Array) => {
        if (!egl10DisplayValid(display)) return eglFailure(EGL_BAD_DISPLAY, 0);
        out[0] = eglConfigAttrib(attr);
        return 1;
      },
    "eglGetError()I": takeEglError,
    "eglGetConfigs(Ljavax/microedition/khronos/egl/EGLDisplay;[Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z": egl10Configs,
    "eglGetDisplay(Ljava/lang/Object;)Ljavax/microedition/khronos/egl/EGLDisplay;": (nativeDisplay: unknown) =>
      nativeDisplay == null ? egl10Display : eglFailure(EGL_BAD_DISPLAY, noEglDisplay),
    "eglInitialize(Ljavax/microedition/khronos/egl/EGLDisplay;[I)Z": (display: unknown, v: Int32Array | null) => {
      if (!egl10DisplayValid(display)) return eglFailure(EGL_BAD_DISPLAY, 0);
      if (v) { v[0] = 1; v[1] = 4; }
      return 1;
    },
    "eglQueryString(Ljavax/microedition/khronos/egl/EGLDisplay;I)Ljava/lang/String;": (display: unknown, n: number) => {
      if (!egl10DisplayValid(display)) return eglFailure(EGL_BAD_DISPLAY, null);
      return n === 0x3053 ? "webdroid" : n === 0x3054 ? "1.4" : "";
    },
    "eglCreateContext(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;Ljavax/microedition/khronos/egl/EGLContext;[I)Ljavax/microedition/khronos/egl/EGLContext;":
      (display: unknown, _c: unknown, share: JEGLContext | null, at: Int32Array | null) => {
        if (!egl10DisplayValid(display)) return eglFailure(EGL_BAD_DISPLAY, noEglContext);
        const c = new JEGLContext(); c.egl = new EglContext(share?.egl); c.egl.major = attrVal(at, 0x3098) || 1;
        eglContexts.set(c.egl, c); return c;
      },
    "eglCreatePbufferSurface(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;[I)Ljavax/microedition/khronos/egl/EGLSurface;":
      (display: unknown, _c: unknown, at: Int32Array | null) => {
        if (!egl10DisplayValid(display)) return eglFailure(EGL_BAD_DISPLAY, noEglSurface);
        const e = new JEGLSurface(); e.surf = { width: attrVal(at, 0x3057) || 1, height: attrVal(at, 0x3056) || 1, present: null, frames: 0 }; return e;
      },
    "eglCreateWindowSurface(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;Ljava/lang/Object;[I)Ljavax/microedition/khronos/egl/EGLSurface;":
      (display: unknown, _c: unknown, win: unknown) => {
        if (!egl10DisplayValid(display)) return eglFailure(EGL_BAD_DISPLAY, noEglSurface);
        // no surface yet (the view has no size): EGL_NO_SURFACE, as a real EGL answers a dead ANativeWindow
        return after(windowSurface(win), (s) => s ? Object.assign(new JEGLSurface(), { surf: s }) : noEglSurface);
      },
    "eglMakeCurrent(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLContext;)Z":
      (display: unknown, draw: JEGLSurface | null, _r: unknown, ctx: JEGLContext | null) => {
        if (!egl10DisplayValid(display)) return eglFailure(EGL_BAD_DISPLAY, 0);
        if (!ctx || ctx === noEglContext) { bindEglCurrent(curThread, null); return 1; }
        if (!ctx.egl.makeCurrent(draw?.surf ?? null)) return eglFailure(ctx.egl.gl?.isContextLost() ? 0x300e : 0x3006, 0);
        return 1;
      },
    "eglSwapBuffers(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;)Z":
      driven(function* (display: unknown, s: JEGLSurface | null): Gen {
        const thread = curThread, c = glSurfaces.current;
        if (!egl10DisplayValid(display)) return eglFailure(EGL_BAD_DISPLAY, 0, thread);
        if (!s?.surf || c?.target !== s.surf) return eglFailure(0x300d, 0, thread);
        return (yield* awaited(c.swap())) ? 1 : eglFailure(0x300e, 0, thread);
      }),
    "eglQuerySurface(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;I[I)Z":
      (display: unknown, s: JEGLSurface | null, attr: number, out: Int32Array) => {
        if (!egl10DisplayValid(display)) return eglFailure(EGL_BAD_DISPLAY, 0);
        out[0] = attr === 0x3057 ? s?.surf?.width ?? 0 : attr === 0x3056 ? s?.surf?.height ?? 0 : 0;
        return 1;
      },
    "eglDestroyContext(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLContext;)Z": (display: unknown, ctx: JEGLContext | null) => {
      if (!egl10DisplayValid(display)) return eglFailure(EGL_BAD_DISPLAY, 0);
      if (ctx && boundEglCurrent(curThread) === ctx.egl) bindEglCurrent(curThread, null);
      return 1;
    },
    "eglDestroySurface(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;)Z":
      (display: unknown) => egl10DisplayValid(display) ? 1 : eglFailure(EGL_BAD_DISPLAY, 0),
    "eglTerminate(Ljavax/microedition/khronos/egl/EGLDisplay;)Z":
      (display: unknown) => egl10DisplayValid(display) ? 1 : eglFailure(EGL_BAD_DISPLAY, 0),
    ...stubs(1, "eglWaitGL()Z", "eglWaitNative(ILjava/lang/Object;)Z"),
    "eglGetCurrentDisplay()Ljavax/microedition/khronos/egl/EGLDisplay;": () => glSurfaces.current ? egl10Display : noEglDisplay,
    "eglGetCurrentContext()Ljavax/microedition/khronos/egl/EGLContext;": () => {
      const current = glSurfaces.current;
      if (!current) return noEglContext;
      let c = eglContexts.get(current);
      if (!c) { c = new JEGLContext(); c.egl = current; eglContexts.set(current, c); }
      return c;
    },
  },
});
rt.register({
  name: "javax/microedition/khronos/egl/EGL11", ctor: class extends JEGL10 {}, sup: "javax/microedition/khronos/egl/EGL10",
  statics: { EGL_MIN_SWAP_INTERVAL: 0x303b, EGL_MAX_SWAP_INTERVAL: 0x303c },
  methods: { "eglSwapInterval(Ljavax/microedition/khronos/egl/EGLDisplay;I)Z": (display: unknown, interval: number) =>
    egl10DisplayValid(display) ? setEglSwapInterval(interval) : eglFailure(EGL_BAD_DISPLAY, 0) },
});

// android_opengl_EGL14.cpp: an EGLObjectHandle's long names a context or surface record here; the
// one display and config are handle 1, and handle 0 is EGL_NO_*
type Ctx = { egl: EglContext | null };
type Surf = { surf: GlSurface | null; owned: boolean };
const DEFAULT = 1n;
let handleField = "";
const mHandle = () => handleField ||= declaredField("android/opengl/EGLObjectHandle", "mHandle");
const handleOf = (o: JObj | null): bigint => o ? (o as unknown as Record<string, bigint>)[mHandle()] : 0n;
const eglObject = (cls: string, h: bigint): JObj => setDeclared(rt.make("android/opengl/" + cls), "android/opengl/EGLObjectHandle", { mHandle: h });
const ctxOf = (o: JObj | null) => deref<Ctx | undefined>(handleOf(o));
const surfOf = (o: JObj | null) => deref<Surf | undefined>(handleOf(o));
const isDefault = (o: JObj | null) => handleOf(o) === DEFAULT;
const noContext = () => eglObject("EGLContext", 0n), noSurface = () => eglObject("EGLSurface", 0n);
const egl14Contexts = new WeakMap<EglContext, Ctx>();
const eglErrors = new WeakMap<JThread, number>();
function eglOut(array: Int32Array | null, offset: number, value: number): void {
  if (!array) return;
  if (offset < 0 || offset >= array.length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid EGL result offset");
  array[offset] = value;
}
export function eglFailure<T>(error: number, result: T, thread = curThread): T { eglErrors.set(thread, error); return result; }
export function takeEglError(thread = curThread): number { const error = eglErrors.get(thread) ?? 0x3000; eglErrors.delete(thread); return error; }
const newSurface = (surf: GlSurface, owned: boolean) => eglObject("EGLSurface", handle({ surf, owned } satisfies Surf));
const windowSurface14 = (display: JObj, config: JObj, window: unknown) => {
  if (!isDefault(display) || !isDefault(config)) return eglFailure(0x3005, noSurface());
  return after(windowSurface(window), (target) => target ? newSurface(target, false) : eglFailure(0x300b, noSurface()));
};
rt.registerJnis("android/opengl/EGL14", {
  "_nativeClassInit()V": () => {
    const egl = linkClass("android/opengl/EGL14");
    egl.setStatic("EGL_NO_CONTEXT", noContext());
    egl.setStatic("EGL_NO_DISPLAY", eglObject("EGLDisplay", 0n));
    egl.setStatic("EGL_NO_SURFACE", noSurface());
  },
  "eglGetDisplay(I)Landroid/opengl/EGLDisplay;": (display: number) => display === 0 ? eglObject("EGLDisplay", DEFAULT) : eglFailure(0x3008, eglObject("EGLDisplay", 0n)),
  "eglInitialize(Landroid/opengl/EGLDisplay;[II[II)Z": (display: JObj, major: Int32Array | null, majorOffset: number, minor: Int32Array | null, minorOffset: number) => {
    if (!isDefault(display)) return eglFailure(0x3008, 0);
    eglOut(major, majorOffset, 1); eglOut(minor, minorOffset, 4); return 1;
  },
  "eglQueryString(Landroid/opengl/EGLDisplay;I)Ljava/lang/String;": (display: JObj, name: number) => !isDefault(display) ? eglFailure(0x3008, null) : name === 0x3053 ? "webdroid" : name === 0x3054 ? "1.4" : name === 0x308d ? "OpenGL_ES" : "",
  "eglChooseConfig(Landroid/opengl/EGLDisplay;[II[Landroid/opengl/EGLConfig;II[II)Z": (display: JObj, attrs: Int32Array | null, offset: number, configs: JObj[] | null, configOffset: number, size: number, count: Int32Array | null, countOffset: number) => {
    if (!isDefault(display)) return eglFailure(0x3008, 0);
    let matches = true;
    for (let i = offset; attrs && i + 1 < attrs.length && attrs[i] !== 0x3038; i += 2) {
      const actual = eglConfigAttrib(attrs[i]), requested = attrs[i + 1];
      if (requested !== -1 && (attrs[i] === 0x3033 || attrs[i] === 0x3040 ? (actual & requested) !== requested : actual < requested)) matches = false;
    }
    eglOut(count, countOffset, +matches);
    if (matches && configs && size > 0) {
      if (configOffset < 0 || configOffset >= configs.length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid EGL config offset");
      configs[configOffset] = eglObject("EGLConfig", DEFAULT);
    }
    return 1;
  },
  "eglGetConfigAttrib(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLConfig;I[II)Z": (display: JObj, config: JObj, attr: number, out: Int32Array, offset: number) => {
    if (!isDefault(display) || !isDefault(config)) return eglFailure(0x3005, 0);
    eglOut(out, offset, eglConfigAttrib(attr)); return 1;
  },
  "eglCreateContext(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLConfig;Landroid/opengl/EGLContext;[II)Landroid/opengl/EGLContext;": (display: JObj, config: JObj, share: JObj | null, attrs: Int32Array | null, offset: number) => {
    if (!isDefault(display) || !isDefault(config)) return eglFailure(0x3005, noContext());
    const version = attrVal(attrs?.subarray(offset) ?? null, 0x3098) || 1;
    if (version < 1 || version > 3) return eglFailure(0x3004, noContext());
    const egl = new EglContext(ctxOf(share)?.egl ?? undefined), ctx: Ctx = { egl };
    egl.major = version; egl14Contexts.set(egl, ctx);
    return eglObject("EGLContext", handle(ctx));
  },
  "eglCreatePbufferSurface(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLConfig;[II)Landroid/opengl/EGLSurface;": (display: JObj, config: JObj, attrs: Int32Array | null, offset: number) => {
    if (!isDefault(display) || !isDefault(config)) return eglFailure(0x3005, noSurface());
    const a = attrs?.subarray(offset) ?? null, width = attrVal(a, 0x3057) || 1, height = attrVal(a, 0x3056) || 1;
    if (width < 0 || height < 0) return eglFailure(0x3004, noSurface());
    return newSurface({ width, height, present: null, frames: 0 }, true);
  },
  "_eglCreateWindowSurface(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLConfig;Ljava/lang/Object;[II)Landroid/opengl/EGLSurface;": windowSurface14,
  "_eglCreateWindowSurfaceTexture(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLConfig;Ljava/lang/Object;[II)Landroid/opengl/EGLSurface;": windowSurface14,
  "eglMakeCurrent(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLSurface;Landroid/opengl/EGLSurface;Landroid/opengl/EGLContext;)Z": (display: JObj, draw: JObj, _read: JObj, context: JObj) => {
    if (!isDefault(display)) return eglFailure(0x3008, 0);
    if (!handleOf(context)) { glSurfaces.current = null; return 1; }
    const egl = ctxOf(context)?.egl;
    if (!egl || !egl.makeCurrent(surfOf(draw)?.surf ?? null)) return eglFailure(egl?.gl?.isContextLost() ? 0x300e : 0x3006, 0);
    return 1;
  },
  "eglGetCurrentContext()Landroid/opengl/EGLContext;": () => {
    const current = glSurfaces.current;
    if (!current) return noContext();
    let ctx = egl14Contexts.get(current);
    if (!ctx) egl14Contexts.set(current, ctx = { egl: current });
    return eglObject("EGLContext", handle(ctx));
  },
  "eglQueryContext(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLContext;I[II)Z": (display: JObj, context: JObj, attribute: number, out: Int32Array, offset: number) => {
    if (!isDefault(display)) return eglFailure(0x3008, 0);
    const egl = ctxOf(context)?.egl;
    if (!egl) return eglFailure(0x3006, 0);
    let value: number;
    if (attribute === 0x3028) value = 1;
    else if (attribute === 0x3097) value = 0x30a0;
    else if (attribute === 0x3098) value = egl.major;
    else if (attribute === 0x3086) value = boundEglCurrent(curThread) === egl && egl.target ? 0x3084 : 0x3038;
    else return eglFailure(0x3004, 0);
    eglOut(out, offset, value);
    return 1;
  },
  "eglSwapBuffers(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLSurface;)Z": driven(function* (_display: JObj, surface: JObj): Gen {
    const thread = curThread, context = glSurfaces.current, surf = surfOf(surface)?.surf;
    if (!surf || context?.target !== surf) return eglFailure(0x300d, 0);
    return (yield* awaited(context.swap())) ? 1 : eglFailure(0x300e, 0, thread);
  }),
  "eglSwapInterval(Landroid/opengl/EGLDisplay;I)Z": (display: JObj, interval: number) =>
    isDefault(display) ? setEglSwapInterval(interval) : eglFailure(0x3008, 0),
  "eglDestroySurface(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLSurface;)Z": (_display: JObj, surface: JObj) => {
    const s = surfOf(surface);
    if (!s?.surf) return eglFailure(0x300d, 0);
    if (glSurfaces.current?.target === s.surf) glSurfaces.current.target = null;
    if (s.owned) s.surf.present?.close();
    s.surf = null; release(handleOf(surface)); return 1;
  },
  "eglDestroyContext(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLContext;)Z": (_display: JObj, context: JObj) => {
    const ctx = ctxOf(context);
    if (!ctx?.egl) return eglFailure(0x3006, 0);
    if (glSurfaces.current === ctx.egl) glSurfaces.current = null;
    egl14Contexts.delete(ctx.egl); ctx.egl = null; release(handleOf(context)); return 1;
  },
  "eglReleaseThread()Z": () => { glSurfaces.current = null; takeEglError(); return 1; },
  "eglTerminate(Landroid/opengl/EGLDisplay;)Z": (display: JObj) => isDefault(display) ? 1 : eglFailure(0x3008, 0),
  "eglGetError()I": takeEglError,
});
