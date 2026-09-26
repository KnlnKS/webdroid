// GLSurfaceView: owns a WebGL canvas, drives the Renderer, blits into the 2D framebuffer.

import { rt, JObj, stubs, noops, driven, type Gen } from "../jvm/runtime";
import { device } from "../shell/config";
import { mangleMethod } from "../jvm/abi";
import { vcall, vcallOn, JThread, setCurThread, curThread } from "../jvm/natives/jlang";
import { JView, JViewGroup, guardCall, initViewFromCtx, invalidate, uiState, requestLayout, specSize, defaultSize } from "./view";
import { onMain } from "./mainloop";
import { JCanvas, JBitmap, JMatrix, JRect } from "./graphics";
import { setGL, gl, tables } from "./gl";
import { reportUncaught, mainLooper, mainHandler } from "./os";
import { perf } from "../perf";
import { bindEglCurrent, boundEglCurrent, glSurfaces } from "../native/egl-current";

const D_chooseConfig = "(Ljavax/microedition/khronos/egl/EGL10;Ljavax/microedition/khronos/egl/EGLDisplay;)Ljavax/microedition/khronos/egl/EGLConfig;";

class JGLSurfaceView extends JViewGroup {
  glCanvas: OffscreenCanvas | null = null;
  ctx: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  renderer: unknown = null;
  configChooser: unknown = null;
  eglConfig: JObj | null = null;
  glThread = new JThread();
  surfaceCreated = false;
  lastW = 0; lastH = 0;
  renderMode = 1; // 1 = CONTINUOUSLY, 0 = WHEN_DIRTY
  dirty = true;
  inFlight = false;
  paused = false;
  t0 = 0;
  hook: (() => boolean) | null = null;
  fakeGL10: JObj | null = null;

  ensureCanvas(w: number, h: number) {
    if (w <= 0 || h <= 0) return;
    if (!this.glCanvas || this.lastW !== w || this.lastH !== h) {
      this.glCanvas = new OffscreenCanvas(w, h);
      // A SurfaceView's surface is opaque unless the app asks for a translucent format.
      this.ctx = (this.glCanvas.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true })
        ?? this.glCanvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: true })) as WebGL2RenderingContext;
      this.lastW = w; this.lastH = h;
      this.surfaceCreated = false;
    }
  }
  async runFrame() {
    if (!this.ctx || !this.renderer) return;
    const prev = curThread;
    setCurThread(this.glThread);
    setGL(this.ctx);
    setCurThread(prev);
    try {
      if (!this.fakeGL10) { const info = rt.link("webdroid/GL10"); this.fakeGL10 = new info.ctor(); }
      if (!this.surfaceCreated) {
        this.surfaceCreated = true;
        // EglHelper.start(): the chooser's answer is the EGLConfig onSurfaceCreated receives,
        // and renderers read back through it what the chooser recorded.
        if (!this.eglConfig) {
          this.eglConfig = this.configChooser
            ? (await vcallOn(this.glThread, this.configChooser, "chooseConfig", D_chooseConfig,
                rt.make("javax/microedition/khronos/egl/EGL10"),
                egl10Display)) ?? theConfig
            : theConfig;
        }
        await vcallOn(this.glThread, this.renderer, "onSurfaceCreated", "(Ljavax/microedition/khronos/opengles/GL10;Ljavax/microedition/khronos/egl/EGLConfig;)V", this.fakeGL10, this.eglConfig);
        await vcallOn(this.glThread, this.renderer, "onSurfaceChanged", "(Ljavax/microedition/khronos/opengles/GL10;II)V", this.fakeGL10, this.lastW, this.lastH);
      }
      await vcallOn(this.glThread, this.renderer, "onDrawFrame", "(Ljavax/microedition/khronos/opengles/GL10;)V", this.fakeGL10);
    } catch (e) {
      reportUncaught(e);
    }
  }
}

rt.register({
  name: "android/opengl/GLSurfaceView", ctor: JGLSurfaceView, sup: "android/view/ViewGroup",
  ifaces: ["android/view/SurfaceHolder$Callback"],
  statics: { RENDERMODE_WHEN_DIRTY: 0, RENDERMODE_CONTINUOUSLY: 1, DEBUG_CHECK_GL_ERROR: 1 },
  methods: {
    "<init>(Landroid/content/Context;)V": driven(function* (this: JGLSurfaceView, c: unknown): Gen { yield initViewFromCtx(this, c, null); }),
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": driven(function* (this: JGLSurfaceView, c: unknown, set: any): Gen { yield initViewFromCtx(this, c, set); }),
    "setEGLConfigChooser(Landroid/opengl/GLSurfaceView$EGLConfigChooser;)V": function (this: JGLSurfaceView, c: unknown) { this.configChooser = c; },
    "setRenderer(Landroid/opengl/GLSurfaceView$Renderer;)V": function (this: JGLSurfaceView, r: unknown) {
      this.renderer = r;
      if (this.hook) uiState.animHooks.delete(this.hook);
      const self = this;
      // GLThread: one frame in flight. onDrawFrame may await the app's own update thread across
      // ticks, so the frame is not awaited here (that would park the main-looper queue on it)
      // and the next tick composites whatever has landed, as SurfaceFlinger does for a GL surface.
      const done = () => {
        self.inFlight = false;
        perf.glFrames++; perf.glFrameMs += performance.now() - self.t0;
        invalidate();
      };
      this.hook = () => {
        if (!self.attached || self.paused) return true;
        if (self.inFlight) { perf.glSkipped++; return true; }
        if (self.renderMode === 1 || self.dirty) {
          self.dirty = false; self.inFlight = true; self.t0 = performance.now();
          void self.runFrame().finally(done);
        }
        return true;
      };
      if (this.attached) uiState.animHooks.add(this.hook);
      requestLayout(this);
    },
    "setRenderMode(I)V": function (this: JGLSurfaceView, m: number) { this.renderMode = m; },
    "getRenderMode()I": function (this: JGLSurfaceView) { return this.renderMode; },
    "requestRender()V": function (this: JGLSurfaceView) { this.dirty = true; invalidate(); },
    "queueEvent(Ljava/lang/Runnable;)V": function (this: JGLSurfaceView, r: unknown) {
      setTimeout(() => {
        try { void Promise.resolve(vcallOn(this.glThread, r, "run", "()V")).catch(reportUncaught); } catch (e) { reportUncaught(e); }
      }, 0);
    },
    // GLThread stops rendering while paused; the WebGL context is kept across it, which is the
    // setPreserveEGLContextOnPause(true) behaviour and the only one we can offer.
    "onResume()V": function (this: JGLSurfaceView) { this.paused = false; invalidate(); },
    "onPause()V": function (this: JGLSurfaceView) { this.paused = true; },
    "getHolder()Landroid/view/SurfaceHolder;": function (this: JGLSurfaceView) { return getHolder(this); },
    ...noops("setEGLConfigChooser(ZZ)V", "setEGLConfigChooser(IIIIII)V", "setEGLContextClientVersion(I)V",
      "setEGLContextFactory(Landroid/opengl/GLSurfaceView$EGLContextFactory;)V",
      "setEGLWindowSurfaceFactory(Landroid/opengl/GLSurfaceView$EGLWindowSurfaceFactory;)V",
      "setPreserveEGLContextOnPause(Z)V", "setZOrderOnTop(Z)V", "setDebugFlags(I)V"),
    "onMeasure(II)V": function (this: JGLSurfaceView, w: number, h: number) {
      this.measuredW = defaultSize(specSize(w), w);
      this.measuredH = defaultSize(specSize(h), h);
    },
    "onLayout(ZIIII)V": function (this: JGLSurfaceView) {
      this.ensureCanvas(this.width(), this.height());
    },
    "onDraw(Landroid/graphics/Canvas;)V": function (this: JGLSurfaceView, cv: JCanvas) {
      if (this.glCanvas && this.surfaceCreated) {
        cv.ctx.drawImage(this.glCanvas, 0, 0, this.width(), this.height());
      }
    },
    "onDetachedFromWindow()V": function (this: JGLSurfaceView) {
      if (this.hook) uiState.animHooks.delete(this.hook);
    },
    "onAttachedToWindow()V": function (this: JGLSurfaceView) {
      if (this.hook) uiState.animHooks.add(this.hook);
      this.ensureCanvas(this.width() || device.width, this.height() || device.height - device.statusBar);
    },
  },
});
rt.markers("android/opengl/GLSurfaceView$Renderer", "android/opengl/GLSurfaceView$EGLConfigChooser",
  "android/opengl/GLSurfaceView$EGLContextFactory", "android/opengl/GLSurfaceView$EGLWindowSurfaceFactory");

// ── SurfaceView: a real surface (an OffscreenCanvas + WebGL context) composited behind the view
// (JView.surfaceLayer). SurfaceHolder callbacks fire on the main looper once the view has a size,
// as SurfaceFlinger's surface creation does. The Java EGL10 and the native libEGL both bind to
// these surfaces (glSurfaces), so there is exactly one drawing buffer per SurfaceView.
export interface GlSurface {
  view: JView | null;
  width: number;
  height: number;
  /** ANativeWindow_setBuffersGeometry's buffer size, which the view scales to its own; 0 follows width/height */
  userWidth?: number;
  userHeight?: number;
  present: ImageBitmap | VideoFrame | null;
  frames: number;
  swapInterval?: number;
  presentationTimeNanos?: bigint;
  onFrame?: () => void;
}
export const bufferWidth = (s: GlSurface): number => s.userWidth || s.width;
export const bufferHeight = (s: GlSurface): number => s.userHeight || s.height;
export function presentSurface(surface: GlSurface, frame: ImageBitmap | VideoFrame): void {
  surface.present?.close();
  surface.present = frame;
  surface.frames++;
  perf.glFrames++;
  if (surface.view) { surface.view.surfaceLayer = frame; invalidate(surface.view); }
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
  /** present: the frame goes to the surface, the view recomposes, and the caller waits for the
   *  next display frame (eglSwapBuffers blocks for vsync) */
  swap(): Promise<boolean> {
    const s = this.target;
    if (!s || this.gl?.isContextLost()) return Promise.resolve(false);
    let bmp: ImageBitmap;
    try { bmp = this.canvas.transferToImageBitmap(); }
    catch (e) { if (this.gl?.isContextLost()) return Promise.resolve(false); throw e; }
    presentSurface(s, bmp);
    this.fit(s);
    if (s.swapInterval === 0) return Promise.resolve(!this.gl?.isContextLost());
    return new Promise((r) => { const done = () => r(!this.gl?.isContextLost()); if (typeof requestAnimationFrame === "function" && !document.hidden) requestAnimationFrame(done); else setTimeout(done, 16); });
  }
}
export function setEglSwapInterval(interval: number, thread = curThread): number {
  const context = boundEglCurrent(thread);
  if (!context) return eglFailure(0x3006, 0, thread);
  if (!context.target) return eglFailure(0x300d, 0, thread);
  context.target.swapInterval = Math.max(0, Math.min(1, interval));
  return 1;
}
let pixelCopyFrame: OffscreenCanvas | HTMLCanvasElement | null = null;
export function setPixelCopyFrame(frame: OffscreenCanvas | HTMLCanvasElement): void { pixelCopyFrame = frame; }
// PixelCopy: the surface's last presented frame into a Bitmap, the listener told on its handler's looper
rt.markers("android/view/PixelCopy$OnPixelCopyFinishedListener");
const pixelCopy = async (s: GlSurface | null, bmp: JBitmap, listener: unknown): Promise<void> => {
  let result = 1;                                                              // ERROR_UNKNOWN
  if (s?.present) { bmp.ctx.drawImage(s.present, 0, 0, bmp.w, bmp.h); result = 0; }
  else if (!s) result = 2;                                                     // ERROR_TIMEOUT: nothing is there to copy
  await onMain(() => vcall(listener, "onPixelCopyFinished", "(I)V", result));
};
const windowPixelCopy = async (rect: JRect | null, bmp: JBitmap, listener: unknown): Promise<void> => {
  const left = rect?.left ?? 0, top = rect?.top ?? 0;
  const width = rect ? rect.right - left : device.width;
  const height = rect ? rect.bottom - top : device.height;
  let result = 0;
  if (width <= 0 || height <= 0 || bmp.recycled || bmp.immutable) result = 5;
  else if (left < 0 || top < 0 || left + width > device.width || top + height > device.height) result = 4;
  else if (!pixelCopyFrame) result = 3;
  else bmp.ctx.drawImage(pixelCopyFrame, left, top, width, height, 0, 0, bmp.w, bmp.h);
  await onMain(() => vcall(listener, "onPixelCopyFinished", "(I)V", result));
};
rt.register({
  name: "android/view/PixelCopy", ctor: class extends JObj {},
  statics: { SUCCESS: 0, ERROR_UNKNOWN: 1, ERROR_TIMEOUT: 2, ERROR_SOURCE_NO_DATA: 3, ERROR_SOURCE_INVALID: 4, ERROR_DESTINATION_INVALID: 5 },
  methods: {
    "static request(Landroid/view/SurfaceView;Landroid/graphics/Bitmap;Landroid/view/PixelCopy$OnPixelCopyFinishedListener;Landroid/os/Handler;)V":
      (v: JView, bmp: JBitmap, l: unknown) => { void pixelCopy(getHolder(v).surface, bmp, l); },
    "static request(Landroid/view/Surface;Landroid/graphics/Bitmap;Landroid/view/PixelCopy$OnPixelCopyFinishedListener;Landroid/os/Handler;)V":
      (s: JSurface, bmp: JBitmap, l: unknown) => { void pixelCopy(s.surf, bmp, l); },
    "static request(Landroid/view/Window;Landroid/graphics/Rect;Landroid/graphics/Bitmap;Landroid/view/PixelCopy$OnPixelCopyFinishedListener;Landroid/os/Handler;)V":
      (_window: unknown, rect: JRect | null, bmp: JBitmap, listener: unknown) => { void windowPixelCopy(rect, bmp, listener); },
  },
});
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
const D_created = "(Landroid/view/SurfaceHolder;)V", D_changed = "(Landroid/view/SurfaceHolder;III)V";
const M_surfaceCreated = mangleMethod("surfaceCreated", D_created);
const M_surfaceChanged = mangleMethod("surfaceChanged", D_changed);
const M_surfaceDestroyed = mangleMethod("surfaceDestroyed", D_created);
const PIXEL_FORMAT_RGBA_8888 = 1;
class JSurfaceHolder extends JObj {
  view: JView;
  callbacks: unknown[] = [];
  surface: GlSurface | null = null;
  jsurface: JSurface | null = null;
  format = PIXEL_FORMAT_RGBA_8888;
  frame = new JRect();
  creating = false;
  constructor(view: JView) { super(); this.view = view; }
}
const holders = new WeakMap<JView, JSurfaceHolder>();
function getHolder(v: JView): JSurfaceHolder {
  let h = holders.get(v);
  if (!h) { h = new JSurfaceHolder(v); holders.set(v, h); }
  return h;
}
class JSurfaceView extends JViewGroup {
  surfaceBacked = true;
  surfW = 0; surfH = 0;
  syncSurface(): void { this.ensureSurface(); }
  ensureSurface(): void {
    const w = this.width(), h = this.height();
    if (w <= 0 || h <= 0 || !this.attached) return;
    const holder = getHolder(this);
    if (holder.surface && this.surfW === w && this.surfH === h) return;
    const created = !holder.surface;
    if (created) holder.surface = { view: this, width: w, height: h, present: null, frames: 0 };
    else { holder.surface!.width = w; holder.surface!.height = h; }
    this.surfW = w; this.surfH = h;
    holder.frame.right = w;
    holder.frame.bottom = h;
    void onMain(async () => {
      holder.creating = created;
      try {
        for (const cb of holder.callbacks.slice()) {
          if (created) await guardCall(cb, M_surfaceCreated, holder);
          await guardCall(cb, M_surfaceChanged, holder, holder.format, w, h);
        }
      } finally { holder.creating = false; }
    });
  }
  destroySurface(): void {
    const holder = getHolder(this), s = holder.surface;
    if (!s) return;
    holder.surface = null;
    s.present?.close();
    this.surfaceLayer = null;
    if (glSurfaces.current?.target === s) glSurfaces.current.target = null;
    void onMain(async () => {
      for (const cb of holder.callbacks.slice()) await guardCall(cb, M_surfaceDestroyed, holder);
    });
  }
}
rt.register({
  name: "android/view/SurfaceHolder", ctor: JSurfaceHolder,
  statics: { SURFACE_TYPE_NORMAL: 0, SURFACE_TYPE_HARDWARE: 1, SURFACE_TYPE_GPU: 2, SURFACE_TYPE_PUSH_BUFFERS: 3 },
  methods: {
    "addCallback(Landroid/view/SurfaceHolder$Callback;)V": function (this: JSurfaceHolder, cb: unknown) { if (!this.callbacks.includes(cb)) this.callbacks.push(cb); },
    "removeCallback(Landroid/view/SurfaceHolder$Callback;)V": function (this: JSurfaceHolder, cb: unknown) { const i = this.callbacks.indexOf(cb); if (i >= 0) this.callbacks.splice(i, 1); },
    "getSurface()Landroid/view/Surface;": function (this: JSurfaceHolder) { return this.jsurface ??= Object.assign(new JSurface(), { holder: this }); },
    "setFormat(I)V": function (this: JSurfaceHolder, f: number) { this.format = f; },
    ...noops("setType(I)V", "setKeepScreenOn(Z)V", "setFixedSize(II)V", "setSizeFromLayout()V",
      "unlockCanvasAndPost(Landroid/graphics/Canvas;)V"),
    "isCreating()Z": function (this: JSurfaceHolder) { return this.creating ? 1 : 0; },
    "getSurfaceFrame()Landroid/graphics/Rect;": function (this: JSurfaceHolder) { return this.frame; },
    ...stubs(null, "lockCanvas()Landroid/graphics/Canvas;",
      "lockCanvas(Landroid/graphics/Rect;)Landroid/graphics/Canvas;"),
  },
});
rt.markers("android/view/SurfaceHolder$Callback");
rt.register({ name: "android/view/SurfaceHolder$Callback2", ctor: class extends JObj {}, ifaces: ["android/view/SurfaceHolder$Callback"] });
rt.markers("android/view/TextureView$SurfaceTextureListener");
class JSurfaceTexture extends JObj {
  surface: GlSurface = { view: null, width: 1, height: 1, present: null, frames: 0, onFrame: () => this.frameAvailable() };
  released = false;
  textureName = 0;
  timestamp = 0n;
  listener: unknown = null;
  onUpdate: (() => void) | undefined;
  looper = (curThread.looper as typeof mainLooper) ?? mainLooper;
  frameAvailable(): void {
    this.onUpdate?.();
    const listener = this.listener;
    if (listener) void this.looper.run(() => !this.released && this.listener === listener
      ? vcall(listener, "onFrameAvailable", "(Landroid/graphics/SurfaceTexture;)V", this) : undefined).catch(reportUncaught);
  }
  update(): void {
    if (this.released || !gl || !tables().textures[this.textureName]) throw rt.mkThrowable("java/lang/IllegalStateException", "SurfaceTexture has no current texture");
    const frame = this.surface.present;
    if (!frame) return;
    gl.bindTexture(gl.TEXTURE_2D, tables().textures[this.textureName]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    if (typeof VideoFrame !== "undefined" && frame instanceof VideoFrame) this.timestamp = BigInt(frame.timestamp) * 1000n;
  }
  release(): void {
    if (this.released) return;
    this.released = true;
    this.surface.present?.close();
    this.surface.present = null;
    if (this.surface.view) this.surface.view.surfaceLayer = null;
    this.surface.view = null;
    this.surface.onFrame = undefined;
    if (glSurfaces.current?.target === this.surface) glSurfaces.current.target = null;
  }
}
rt.register({
  name: "android/graphics/SurfaceTexture", ctor: JSurfaceTexture,
  methods: {
    "<init>(I)V": function (this: JSurfaceTexture, texture: number) { this.textureName = texture; },
    "<init>(Z)V": (single: number) => { if (single) rt.unimplemented("SurfaceTexture single-buffer mode"); },
    "<init>(IZ)V": function (this: JSurfaceTexture, texture: number, single: number) { if (single) rt.unimplemented("SurfaceTexture single-buffer mode"); this.textureName = texture; },
    "setOnFrameAvailableListener(Landroid/graphics/SurfaceTexture$OnFrameAvailableListener;)V": function (this: JSurfaceTexture, listener: unknown) { this.listener = listener; },
    "setOnFrameAvailableListener(Landroid/graphics/SurfaceTexture$OnFrameAvailableListener;Landroid/os/Handler;)V": function (this: JSurfaceTexture, listener: unknown, handler: ReturnType<typeof mainHandler> | null) { this.listener = listener; if (handler) this.looper = handler.looper; },
    "updateTexImage()V": function (this: JSurfaceTexture) { this.update(); },
    "getTransformMatrix([F)V": function (this: JSurfaceTexture, matrix: Float32Array) {
      if (!matrix) throw rt.mkThrowable("java/lang/NullPointerException", null);
      if (matrix.length !== 16) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Matrix must have 16 elements");
      // updateTexImage uploads the visible frame without a crop or producer transform.
      matrix.fill(0);
      matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
    },
    "getTimestamp()J": function (this: JSurfaceTexture) { return this.timestamp; },
    "setDefaultBufferSize(II)V": function (this: JSurfaceTexture, w: number, h: number) {
      if (w <= 0 || h <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid buffer size");
      this.surface.width = w; this.surface.height = h;
    },
    "isReleased()Z": function (this: JSurfaceTexture) { return +this.released; },
    "release()V": function (this: JSurfaceTexture) { this.release(); },
  },
});
rt.markers("android/graphics/SurfaceTexture$OnFrameAvailableListener");
class JTextureView extends JView {
  surfaceBacked = true;
  listener: unknown = null;
  texture: JSurfaceTexture | null = null;
  opaque = true;
  syncSurface(): void { this.ensureSurface(); }
  ensureSurface(): void {
    const w = this.width(), h = this.height();
    if (!this.attached || w <= 0 || h <= 0) return;
    const created = !this.texture;
    const texture = this.texture ??= rt.make("android/graphics/SurfaceTexture") as JSurfaceTexture;
    if (!created && texture.surface.width === w && texture.surface.height === h) return;
    texture.surface.view = this;
    texture.onUpdate = () => {
      if (this.listener) void onMain(() => this.texture === texture && this.listener
        ? vcall(this.listener, "onSurfaceTextureUpdated", "(Landroid/graphics/SurfaceTexture;)V", texture) : undefined);
    };
    texture.surface.width = w; texture.surface.height = h;
    const listener = this.listener;
    if (listener) void onMain(() => vcall(listener, created ? "onSurfaceTextureAvailable" : "onSurfaceTextureSizeChanged", "(Landroid/graphics/SurfaceTexture;II)V", texture, w, h));
  }
  destroySurface(): void {
    const texture = this.texture, listener = this.listener;
    if (!texture) return;
    this.texture = null;
    this.surfaceLayer = null;
    texture.surface.view = null;
    texture.onUpdate = undefined;
    void onMain(async () => {
      if (!listener || await vcall(listener, "onSurfaceTextureDestroyed", "(Landroid/graphics/SurfaceTexture;)Z", texture)) texture.release();
    });
  }
}
rt.register({
  name: "android/view/TextureView", ctor: JTextureView, sup: "android/view/View",
  methods: {
    "<init>(Landroid/content/Context;)V": driven(function* (this: JTextureView, c: unknown): Gen { yield initViewFromCtx(this, c, null); }),
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": driven(function* (this: JTextureView, c: unknown, set: any): Gen { yield initViewFromCtx(this, c, set); }),
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": driven(function* (this: JTextureView, c: unknown, set: any): Gen { yield initViewFromCtx(this, c, set); }),
    "setSurfaceTextureListener(Landroid/view/TextureView$SurfaceTextureListener;)V": function (this: JTextureView, l: unknown) { this.listener = l; },
    "getSurfaceTextureListener()Landroid/view/TextureView$SurfaceTextureListener;": function (this: JTextureView) { return this.listener; },
    "getSurfaceTexture()Landroid/graphics/SurfaceTexture;": function (this: JTextureView) { return this.texture; },
    "isAvailable()Z": function (this: JTextureView) { return +(this.texture !== null); },
    "setOpaque(Z)V": function (this: JTextureView, opaque: number) { this.opaque = !!opaque; },
    "isOpaque()Z": function (this: JTextureView) { return +this.opaque; },
    "setTransform(Landroid/graphics/Matrix;)V": function (this: JTextureView, matrix: JMatrix | null) {
      this.surfaceTransform = matrix ? [...matrix.m] : null;
      invalidate(this);
    },
    "getTransform(Landroid/graphics/Matrix;)Landroid/graphics/Matrix;": function (this: JTextureView, matrix: JMatrix | null) {
      matrix ??= new JMatrix();
      matrix.m = this.surfaceTransform ? [...this.surfaceTransform] : [1, 0, 0, 1, 0, 0];
      return matrix;
    },
    "onLayout(ZIIII)V": function (this: JTextureView) { this.ensureSurface(); },
    "onAttachedToWindow()V": function (this: JTextureView) { this.ensureSurface(); },
    "onDetachedFromWindow()V": function (this: JTextureView) { this.destroySurface(); },
    "lockCanvas()Landroid/graphics/Canvas;": () => null,
    "getBitmap()Landroid/graphics/Bitmap;": () => null,
  },
});
/** A Surface handle can be released without releasing its producer's buffer queue. */
export class JSurface extends JObj {
  holder: JSurfaceHolder | null = null;
  texture: JSurfaceTexture | null = null;
  released = false;
  get surf(): GlSurface | null { return this.released ? null : this.holder?.surface ?? (this.texture && !this.texture.released ? this.texture.surface : null); }
  setFrameRate(rate: number, compatibility: number, strategy = 0): void {
    if (this.released) throw rt.mkThrowable("java/lang/IllegalStateException", "Surface has been released");
    if (!Number.isFinite(rate) || rate < 0 || (rate !== 0 && ((compatibility !== 0 && compatibility !== 1) || (strategy !== 0 && strategy !== 1)))) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid frame rate preference");
    // The browser controls display refresh; this preference does not throttle frame production.
  }
}
rt.register({
  name: "android/view/Surface", ctor: JSurface,
  methods: {
    "<init>(Landroid/graphics/SurfaceTexture;)V": function (this: JSurface, texture: JSurfaceTexture) {
      if (!texture) throw rt.mkThrowable("java/lang/IllegalArgumentException", "surfaceTexture must not be null");
      this.texture = texture;
    },
    "isValid()Z": function (this: JSurface) { return this.surf ? 1 : 0; },
    "setFrameRate(FI)V": function (this: JSurface, rate: number, compatibility: number) { this.setFrameRate(rate, compatibility); },
    "setFrameRate(FII)V": function (this: JSurface, rate: number, compatibility: number, strategy: number) { this.setFrameRate(rate, compatibility, strategy); },
    "clearFrameRate()V": function (this: JSurface) { this.setFrameRate(0, 0); },
    "release()V": function (this: JSurface) { this.released = true; },
  },
});
rt.register({
  name: "android/view/SurfaceView", ctor: JSurfaceView, sup: "android/view/ViewGroup",
  methods: {
    "<init>(Landroid/content/Context;)V": driven(function* (this: JSurfaceView, c: unknown): Gen { yield initViewFromCtx(this, c, null); }),
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": driven(function* (this: JSurfaceView, c: unknown, set: any): Gen { yield initViewFromCtx(this, c, set); }),
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": driven(function* (this: JSurfaceView, c: unknown, set: any): Gen { yield initViewFromCtx(this, c, set); }),
    "getHolder()Landroid/view/SurfaceHolder;": function (this: JSurfaceView) { return getHolder(this); },
    ...noops("setZOrderOnTop(Z)V", "setZOrderMediaOverlay(Z)V", "setSecure(Z)V"),
    "onMeasure(II)V": function (this: JSurfaceView, w: number, h: number) {
      this.measuredW = defaultSize(specSize(w), w);
      this.measuredH = defaultSize(specSize(h), h);
    },
    "onLayout(ZIIII)V": function (this: JSurfaceView) { this.ensureSurface(); },
    "onAttachedToWindow()V": function (this: JSurfaceView) { this.ensureSurface(); },
    "onDetachedFromWindow()V": function (this: JSurfaceView) { this.destroySurface(); },
    "onWindowVisibilityChanged(I)V": function (this: JSurfaceView, vis: number) { if (vis === 0) this.ensureSurface(); },
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

// ── EGL10: configs answer from the live context; window surfaces are the SurfaceView's
class JEGLConfig extends JObj {}
rt.register({ name: "javax/microedition/khronos/egl/EGLConfig", ctor: JEGLConfig });
const theConfig = new JEGLConfig();
class JEGLSurface extends JObj { surf: GlSurface | null = null; }
const egl10Current = new WeakMap<object, JEGLContext>();
const attrVal = (a: Int32Array | null, k: number): number => { if (a) for (let i = 0; i + 1 < a.length && a[i] !== 0x3038; i += 2) if (a[i] === k) return a[i + 1]; return 0; };
rt.register({ name: "javax/microedition/khronos/egl/EGLSurface", ctor: JEGLSurface });
const noEglContext = new JEGLContext(), noEglSurface = new JEGLSurface();
const egl10Display = new JEGL10Display(), noEglDisplay = new JEGL10Display();
const EGL_BAD_DISPLAY = 0x3008;
const egl10DisplayValid = (display: unknown) => display === egl10Display;
const eglContexts = new WeakMap<EglContext, JEGLContext>();
const surfaceOf = (win: unknown): GlSurface | null =>
  win instanceof JSurface ? win.surf : win instanceof JSurfaceTexture ? (win.released ? null : win.surface) : win instanceof JSurfaceHolder ? win.surface : win instanceof JView ? getHolder(win).surface : null;
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
      (display: unknown, attrs: Int32Array, configs: unknown[] | null, num: number, numConfig: Int32Array) => {
        if (!egl10DisplayValid(display)) return eglFailure(EGL_BAD_DISPLAY, 0);
        if (configs && num > 0) configs[0] = theConfig;
        if (numConfig) numConfig[0] = 1;
        return 1;
      },
    "eglGetConfigAttrib(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z":
      (display: unknown, config: unknown, attr: number, out: Int32Array) => {
        if (!egl10DisplayValid(display)) return eglFailure(EGL_BAD_DISPLAY, 0);
        out[0] = eglConfigAttrib(attr);
        return 1;
      },
    "eglGetError()I": takeEglError,
    "eglGetConfigs(Ljavax/microedition/khronos/egl/EGLDisplay;[Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z":
      (display: unknown, configs: unknown[] | null, n: number, num: Int32Array | null) => {
        if (!egl10DisplayValid(display)) return eglFailure(EGL_BAD_DISPLAY, 0);
        if (configs && n > 0) configs[0] = theConfig;
        if (num) num[0] = 1;
        return 1;
      },
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
        const e = new JEGLSurface(); e.surf = { view: null, width: attrVal(at, 0x3057) || 1, height: attrVal(at, 0x3056) || 1, present: null, frames: 0 }; return e;
      },
    "eglCreateWindowSurface(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;Ljava/lang/Object;[I)Ljavax/microedition/khronos/egl/EGLSurface;":
      (display: unknown, _c: unknown, win: unknown) => {
        if (!egl10DisplayValid(display)) return eglFailure(EGL_BAD_DISPLAY, noEglSurface);
        const s = surfaceOf(win);
        // no surface yet (the view has no size): EGL_NO_SURFACE, as a real EGL answers a dead ANativeWindow
        if (!s) return noEglSurface;
        const e = new JEGLSurface(); e.surf = s; return e;
      },
    "eglMakeCurrent(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLContext;)Z":
      (display: unknown, draw: JEGLSurface | null, _r: unknown, ctx: JEGLContext | null) => {
        if (!egl10DisplayValid(display)) return eglFailure(EGL_BAD_DISPLAY, 0);
        if (!ctx || ctx === noEglContext) { egl10Current.delete(curThread); bindEglCurrent(curThread, null); return 1; }
        if (!ctx.egl.makeCurrent(draw?.surf ?? null)) return eglFailure(ctx.egl.gl?.isContextLost() ? 0x300e : 0x3006, 0);
        egl10Current.set(curThread, ctx); bindEglCurrent(curThread, ctx.egl); return 1;
      },
    "eglSwapBuffers(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;)Z":
      driven(function* (display: unknown, s: JEGLSurface | null): Gen {
        const thread = curThread, c = glSurfaces.current;
        if (!egl10DisplayValid(display)) return eglFailure(EGL_BAD_DISPLAY, 0, thread);
        if (!s?.surf || c?.target !== s.surf) return eglFailure(0x300d, 0, thread);
        return (yield c.swap()) ? 1 : eglFailure(0x300e, 0, thread);
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
      if (egl10Current.get(curThread) === ctx) egl10Current.delete(curThread);
      return 1;
    },
    "eglDestroySurface(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;)Z":
      (display: unknown) => egl10DisplayValid(display) ? 1 : eglFailure(EGL_BAD_DISPLAY, 0),
    "eglTerminate(Ljavax/microedition/khronos/egl/EGLDisplay;)Z":
      (display: unknown) => egl10DisplayValid(display) ? 1 : eglFailure(EGL_BAD_DISPLAY, 0),
    ...stubs(1, "eglWaitGL()Z", "eglWaitNative(ILjava/lang/Object;)Z"),
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

class JEGLHandle extends JObj { constructor(readonly handle = 0) { super(); } }
class JEGL14Display extends JEGLHandle {}
class JEGL14Config extends JEGLHandle {}
class JEGL14Context extends JEGLHandle { egl: EglContext | null = null; }
class JEGL14Surface extends JEGLHandle { surf: GlSurface | null = null; owned = false; }
rt.register({ name: "android/opengl/EGLObjectHandle", ctor: JEGLHandle, methods: {
  "getNativeHandle()J": function (this: JEGLHandle) { return BigInt(this.handle); },
  "getHandle()I": function (this: JEGLHandle) { return this.handle; },
  "hashCode()I": function (this: JEGLHandle) { return this.handle; },
  "equals(Ljava/lang/Object;)Z": function (this: JEGLHandle, other: unknown) { return +(other instanceof JEGLHandle && other.constructor === this.constructor && other.handle === this.handle); },
} });
for (const [name, ctor] of [["EGLDisplay", JEGL14Display], ["EGLConfig", JEGL14Config], ["EGLContext", JEGL14Context], ["EGLSurface", JEGL14Surface]] as const) {
  rt.register({ name: "android/opengl/" + name, ctor, sup: "android/opengl/EGLObjectHandle" });
  rt.link("android/opengl/" + name);
}
const noDisplay = new JEGL14Display(), noContext = new JEGL14Context(), noSurface = new JEGL14Surface();
const defaultDisplay = new JEGL14Display(1), defaultConfig = new JEGL14Config(1);
let eglHandle = 2;
const egl14Contexts = new WeakMap<EglContext, JEGL14Context>();
const eglErrors = new WeakMap<JThread, number>();
function eglOut(array: Int32Array | null, offset: number, value: number): void {
  if (!array) return;
  if (offset < 0 || offset >= array.length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid EGL result offset");
  array[offset] = value;
}
export function eglFailure<T>(error: number, result: T, thread = curThread): T { eglErrors.set(thread, error); return result; }
export function takeEglError(thread = curThread): number { const error = eglErrors.get(thread) ?? 0x3000; eglErrors.delete(thread); return error; }
rt.register({ name: "android/opengl/EGL14", ctor: class extends JObj {}, statics: {
  EGL_NO_DISPLAY: noDisplay, EGL_NO_CONTEXT: noContext, EGL_NO_SURFACE: noSurface, EGL_DEFAULT_DISPLAY: 0,
  EGL_NONE: 0x3038, EGL_SUCCESS: 0x3000, EGL_WIDTH: 0x3057, EGL_HEIGHT: 0x3056, EGL_CONTEXT_CLIENT_VERSION: 0x3098,
  EGL_CONFIG_ID: 0x3028, EGL_CONTEXT_CLIENT_TYPE: 0x3097, EGL_RENDER_BUFFER: 0x3086,
  EGL_OPENGL_ES_API: 0x30a0, EGL_BACK_BUFFER: 0x3084,
  EGL_RED_SIZE: 0x3024, EGL_GREEN_SIZE: 0x3023, EGL_BLUE_SIZE: 0x3022, EGL_ALPHA_SIZE: 0x3021,
  EGL_DEPTH_SIZE: 0x3025, EGL_STENCIL_SIZE: 0x3026, EGL_RENDERABLE_TYPE: 0x3040, EGL_SURFACE_TYPE: 0x3033,
  EGL_MIN_SWAP_INTERVAL: 0x303b, EGL_MAX_SWAP_INTERVAL: 0x303c,
  EGL_OPENGL_ES2_BIT: 4, EGL_PBUFFER_BIT: 1, EGL_WINDOW_BIT: 4,
}, methods: {
  "static eglGetDisplay(I)Landroid/opengl/EGLDisplay;": (display: number) => display === 0 ? defaultDisplay : eglFailure(0x3008, noDisplay),
  "static eglInitialize(Landroid/opengl/EGLDisplay;[II[II)Z": (display: JEGL14Display, major: Int32Array | null, majorOffset: number, minor: Int32Array | null, minorOffset: number) => {
    if (display !== defaultDisplay) return eglFailure(0x3008, 0);
    eglOut(major, majorOffset, 1); eglOut(minor, minorOffset, 4); return 1;
  },
  "static eglQueryString(Landroid/opengl/EGLDisplay;I)Ljava/lang/String;": (display: JEGL14Display, name: number) => display !== defaultDisplay ? eglFailure(0x3008, null) : name === 0x3053 ? "webdroid" : name === 0x3054 ? "1.4" : name === 0x308d ? "OpenGL_ES" : "",
  "static eglChooseConfig(Landroid/opengl/EGLDisplay;[II[Landroid/opengl/EGLConfig;II[II)Z": (display: JEGL14Display, attrs: Int32Array | null, offset: number, configs: JEGL14Config[] | null, configOffset: number, size: number, count: Int32Array | null, countOffset: number) => {
    if (display !== defaultDisplay) return eglFailure(0x3008, 0);
    let matches = true;
    for (let i = offset; attrs && i + 1 < attrs.length && attrs[i] !== 0x3038; i += 2) {
      const actual = eglConfigAttrib(attrs[i]), requested = attrs[i + 1];
      if (requested !== -1 && (attrs[i] === 0x3033 || attrs[i] === 0x3040 ? (actual & requested) !== requested : actual < requested)) matches = false;
    }
    eglOut(count, countOffset, +matches);
    if (matches && configs && size > 0) {
      if (configOffset < 0 || configOffset >= configs.length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid EGL config offset");
      configs[configOffset] = defaultConfig;
    }
    return 1;
  },
  "static eglGetConfigAttrib(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLConfig;I[II)Z": (display: JEGL14Display, config: JEGL14Config, attr: number, out: Int32Array, offset: number) => {
    if (display !== defaultDisplay || config !== defaultConfig) return eglFailure(0x3005, 0);
    eglOut(out, offset, eglConfigAttrib(attr)); return 1;
  },
  "static eglCreateContext(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLConfig;Landroid/opengl/EGLContext;[II)Landroid/opengl/EGLContext;": (display: JEGL14Display, config: JEGL14Config, share: JEGL14Context, attrs: Int32Array | null, offset: number) => {
    if (display !== defaultDisplay || config !== defaultConfig) return eglFailure(0x3005, noContext);
    const version = attrVal(attrs?.subarray(offset) ?? null, 0x3098) || 1;
    if (version < 1 || version > 3) return eglFailure(0x3004, noContext);
    const context = new JEGL14Context(eglHandle++); context.egl = new EglContext(share?.egl ?? undefined); context.egl.major = version; return context;
  },
  "static eglCreatePbufferSurface(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLConfig;[II)Landroid/opengl/EGLSurface;": (display: JEGL14Display, config: JEGL14Config, attrs: Int32Array | null, offset: number) => {
    if (display !== defaultDisplay || config !== defaultConfig) return eglFailure(0x3005, noSurface);
    const a = attrs?.subarray(offset) ?? null, width = attrVal(a, 0x3057) || 1, height = attrVal(a, 0x3056) || 1;
    if (width < 0 || height < 0) return eglFailure(0x3004, noSurface);
    const surface = new JEGL14Surface(eglHandle++); surface.owned = true;
    surface.surf = { view: null, width, height, present: null, frames: 0 }; return surface;
  },
  "static eglCreateWindowSurface(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLConfig;Ljava/lang/Object;[II)Landroid/opengl/EGLSurface;": (display: JEGL14Display, config: JEGL14Config, window: unknown) => {
    if (display !== defaultDisplay || config !== defaultConfig) return eglFailure(0x3005, noSurface);
    const target = surfaceOf(window); if (!target) return eglFailure(0x300b, noSurface);
    const surface = new JEGL14Surface(eglHandle++); surface.surf = target; return surface;
  },
  "static eglMakeCurrent(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLSurface;Landroid/opengl/EGLSurface;Landroid/opengl/EGLContext;)Z": (display: JEGL14Display, draw: JEGL14Surface, _read: JEGL14Surface, context: JEGL14Context) => {
    if (display !== defaultDisplay) return eglFailure(0x3008, 0);
    if (context === noContext) { glSurfaces.current = null; return 1; }
    if (!context?.egl || !context.egl.makeCurrent(draw?.surf ?? null)) return eglFailure(context?.egl?.gl?.isContextLost() ? 0x300e : 0x3006, 0);
    egl14Contexts.set(context.egl, context); return 1;
  },
  "static eglGetCurrentContext()Landroid/opengl/EGLContext;": () => {
    const current = glSurfaces.current;
    if (!current) return noContext;
    let context = egl14Contexts.get(current);
    if (!context) { context = new JEGL14Context(eglHandle++); context.egl = current; egl14Contexts.set(current, context); }
    return context;
  },
  "static eglQueryContext(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLContext;I[II)Z":
    (display: JEGL14Display, context: JEGL14Context, attribute: number, out: Int32Array, offset: number) => {
      if (display !== defaultDisplay) return eglFailure(0x3008, 0);
      if (!context?.egl) return eglFailure(0x3006, 0);
      let value: number;
      if (attribute === 0x3028) value = 1;
      else if (attribute === 0x3097) value = 0x30a0;
      else if (attribute === 0x3098) value = context.egl.major;
      else if (attribute === 0x3086) value = boundEglCurrent(curThread) === context.egl && context.egl.target ? 0x3084 : 0x3038;
      else return eglFailure(0x3004, 0);
      eglOut(out, offset, value);
      return 1;
  },
  "static eglSwapBuffers(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLSurface;)Z": driven(function* (_display: JEGL14Display, surface: JEGL14Surface): Gen {
    const thread = curThread, context = glSurfaces.current;
    if (!surface?.surf || context?.target !== surface.surf) return eglFailure(0x300d, 0);
    return (yield context.swap()) ? 1 : eglFailure(0x300e, 0, thread);
  }),
  "static eglSwapInterval(Landroid/opengl/EGLDisplay;I)Z": (display: JEGL14Display, interval: number) =>
    display === defaultDisplay ? setEglSwapInterval(interval) : eglFailure(0x3008, 0),
  "static eglDestroySurface(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLSurface;)Z": (_display: JEGL14Display, surface: JEGL14Surface) => {
    if (!surface?.surf) return eglFailure(0x300d, 0);
    if (glSurfaces.current?.target === surface.surf) glSurfaces.current.target = null;
    if (surface.owned) surface.surf.present?.close(); surface.surf = null; return 1;
  },
  "static eglDestroyContext(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLContext;)Z": (_display: JEGL14Display, context: JEGL14Context) => {
    if (!context?.egl) return eglFailure(0x3006, 0);
    if (glSurfaces.current === context.egl) { glSurfaces.current = null; }
    context.egl = null; return 1;
  },
  "static eglReleaseThread()Z": () => { glSurfaces.current = null; takeEglError(); return 1; },
  "static eglTerminate(Landroid/opengl/EGLDisplay;)Z": (display: JEGL14Display) => display === defaultDisplay ? 1 : eglFailure(0x3008, 0),
  "static eglGetError()I": takeEglError,
} });
