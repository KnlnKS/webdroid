// GLSurfaceView: owns a WebGL canvas, drives the Renderer, blits into the 2D framebuffer.

import { rt, JObj } from "../jvm/runtime";
import { device } from "../shell/config";
import { mangleMethod } from "../jvm/abi";
import { vcall, JThread, setCurThread, curThread } from "../jvm/natives/jlang";
import { JView, JViewGroup, guardCall, initViewFromCtx, invalidate, uiState, requestLayout, specSize, defaultSize } from "./view";
import { onMain } from "./mainloop";
import { JCanvas, JBitmap } from "./graphics";
import { setGL } from "./gl";
import { reportUncaught } from "./os";
import { perf } from "../perf";

const M_onSurfaceCreated = mangleMethod("onSurfaceCreated", "(Ljavax/microedition/khronos/opengles/GL10;Ljavax/microedition/khronos/egl/EGLConfig;)V");
const M_onSurfaceChanged = mangleMethod("onSurfaceChanged", "(Ljavax/microedition/khronos/opengles/GL10;II)V");
const M_onDrawFrame = mangleMethod("onDrawFrame", "(Ljavax/microedition/khronos/opengles/GL10;)V");
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
    setGL(this.ctx);
    const prev = curThread;
    setCurThread(this.glThread);
    try {
      if (!this.fakeGL10) { const info = rt.link("webdroid/GL10"); this.fakeGL10 = new info.ctor(); }
      if (!this.surfaceCreated) {
        this.surfaceCreated = true;
        // EglHelper.start(): the chooser's answer is the EGLConfig onSurfaceCreated receives,
        // and renderers read back through it what the chooser recorded.
        if (!this.eglConfig) {
          this.eglConfig = this.configChooser
            ? (await vcall(this.configChooser, "chooseConfig", D_chooseConfig,
                new (rt.link("javax/microedition/khronos/egl/EGL10").ctor)(),
                new (rt.link("javax/microedition/khronos/egl/EGLDisplay").ctor)())) ?? theConfig
            : theConfig;
        }
        await guardCall(this.renderer, M_onSurfaceCreated, this.fakeGL10, this.eglConfig);
        await guardCall(this.renderer, M_onSurfaceChanged, this.fakeGL10, this.lastW, this.lastH);
      }
      await guardCall(this.renderer, M_onDrawFrame, this.fakeGL10);
    } catch (e) {
      reportUncaught(e);
    } finally {
      setCurThread(prev);
    }
  }
}

rt.register({
  name: "android/opengl/GLSurfaceView", ctor: JGLSurfaceView, sup: "android/view/ViewGroup",
  ifaces: ["android/view/SurfaceHolder$Callback"],
  statics: { RENDERMODE_WHEN_DIRTY: 0, RENDERMODE_CONTINUOUSLY: 1, DEBUG_CHECK_GL_ERROR: 1 },
  methods: {
    "<init>(Landroid/content/Context;)V": async function (this: JGLSurfaceView, c: unknown) { await initViewFromCtx(this, c, null); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: JGLSurfaceView, c: unknown, set: any) { await initViewFromCtx(this, c, set); },
    "setEGLConfigChooser(Landroid/opengl/GLSurfaceView$EGLConfigChooser;)V": function (this: JGLSurfaceView, c: unknown) { this.configChooser = c; },
    "setEGLConfigChooser(ZZ)V": () => {},
    "setEGLConfigChooser(IIIIII)V": () => {},
    "setEGLContextClientVersion(I)V": () => {},
    "setEGLContextFactory(Landroid/opengl/GLSurfaceView$EGLContextFactory;)V": () => {},
    "setEGLWindowSurfaceFactory(Landroid/opengl/GLSurfaceView$EGLWindowSurfaceFactory;)V": () => {},
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
      uiState.animHooks.add(this.hook);
      requestLayout(this);
    },
    "setRenderMode(I)V": function (this: JGLSurfaceView, m: number) { this.renderMode = m; },
    "getRenderMode()I": function (this: JGLSurfaceView) { return this.renderMode; },
    "requestRender()V": function (this: JGLSurfaceView) { this.dirty = true; invalidate(); },
    "queueEvent(Ljava/lang/Runnable;)V": function (this: JGLSurfaceView, r: unknown) {
      setTimeout(() => {
        const prev = curThread; setCurThread(this.glThread);
        void Promise.resolve(vcall(r, "run", "()V")).catch(reportUncaught).finally(() => setCurThread(prev));
      }, 0);
    },
    // GLThread stops rendering while paused; the WebGL context is kept across it, which is the
    // setPreserveEGLContextOnPause(true) behaviour and the only one we can offer.
    "onResume()V": function (this: JGLSurfaceView) { this.paused = false; invalidate(); },
    "onPause()V": function (this: JGLSurfaceView) { this.paused = true; },
    "setPreserveEGLContextOnPause(Z)V": () => {},
    "getHolder()Landroid/view/SurfaceHolder;": function (this: JGLSurfaceView) { return getHolder(this); },
    "setZOrderOnTop(Z)V": () => {},
    "setDebugFlags(I)V": () => {},
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
    "onAttachedToWindow()V": function (this: JGLSurfaceView) {
      this.ensureCanvas(this.width() || device.width, this.height() || device.height - device.statusBar);
    },
  },
});
rt.register({ name: "android/opengl/GLSurfaceView$Renderer", ctor: class extends JObj {} });
rt.register({ name: "android/opengl/GLSurfaceView$EGLConfigChooser", ctor: class extends JObj {} });
rt.register({ name: "android/opengl/GLSurfaceView$EGLContextFactory", ctor: class extends JObj {} });
rt.register({ name: "android/opengl/GLSurfaceView$EGLWindowSurfaceFactory", ctor: class extends JObj {} });

// ── SurfaceView: a real surface (an OffscreenCanvas + WebGL context) composited behind the view
// (JView.surfaceLayer). SurfaceHolder callbacks fire on the main looper once the view has a size,
// as SurfaceFlinger's surface creation does. The Java EGL10 and the native libEGL both bind to
// these surfaces (glSurfaces), so there is exactly one drawing buffer per SurfaceView.
export interface GlSurface { view: JView | null; width: number; height: number; present: ImageBitmap | null; frames: number }
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
  makeCurrent(s: GlSurface | null): boolean {
    this.gl ??= this.canvas.getContext("webgl2", { alpha: false, antialias: false, depth: true, stencil: true, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    if (!this.gl) return false;
    if (s && (this.canvas.width !== s.width || this.canvas.height !== s.height)) { this.canvas.width = s.width; this.canvas.height = s.height; }
    this.target = s;
    glSurfaces.current = this;
    setGL(this.gl);
    return true;
  }
  /** present: the frame goes to the surface, the view recomposes, and the caller waits for the
   *  next display frame (eglSwapBuffers blocks for vsync) */
  swap(): Promise<void> {
    const s = this.target;
    if (!s) return Promise.resolve();
    const bmp = this.canvas.transferToImageBitmap();
    s.present?.close();
    s.present = bmp; s.frames++;
    perf.glFrames++;
    if (s.view) { s.view.surfaceLayer = bmp; invalidate(); }
    return new Promise((r) => { if (typeof requestAnimationFrame === "function" && !document.hidden) requestAnimationFrame(() => r()); else setTimeout(r, 16); });
  }
}
export const glSurfaces = { current: null as EglContext | null };

// PixelCopy: the surface's last presented frame into a Bitmap, the listener told on its handler's looper
rt.register({ name: "android/view/PixelCopy$OnPixelCopyFinishedListener", ctor: class extends JObj {} });
const pixelCopy = async (s: GlSurface | null, bmp: JBitmap, listener: unknown): Promise<void> => {
  let result = 1;                                                              // ERROR_UNKNOWN
  if (s?.present) { bmp.ctx.drawImage(s.present, 0, 0, bmp.w, bmp.h); result = 0; }
  else if (!s) result = 2;                                                     // ERROR_TIMEOUT: nothing is there to copy
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
  },
});
/** every window surface ever created (wd.surfaces), and a coarse look at what one last presented */
export const allSurfaces: GlSurface[] = [];
export function probeSurface(i: number, grid = 32): { nonBlack: number; mean: number[]; corners: number[][] } | null {
  const s = allSurfaces[i];
  if (!s?.present) return null;
  const c = new OffscreenCanvas(grid, grid), ctx = c.getContext("2d")!;
  ctx.drawImage(s.present, 0, 0, grid, grid);
  const d = ctx.getImageData(0, 0, grid, grid).data;
  let lit = 0; const mean = [0, 0, 0];
  for (let p = 0; p < d.length; p += 4) { if (Math.max(d[p], d[p + 1], d[p + 2]) > 16) lit++; mean[0] += d[p]; mean[1] += d[p + 1]; mean[2] += d[p + 2]; }
  const px = (x: number, y: number) => [...d.subarray((y * grid + x) * 4, (y * grid + x) * 4 + 3)];
  return { nonBlack: lit / (grid * grid), mean: mean.map((m) => Math.round(m / (grid * grid))), corners: [px(0, 0), px(grid - 1, 0), px(grid >> 1, grid >> 1), px(0, grid - 1), px(grid - 1, grid - 1)] };
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
    case 0x303b: case 0x303c: return 1;                                     // MIN/MAX_SWAP_INTERVAL
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
  constructor(view: JView) { super(); this.view = view; }
}
const holders = new WeakMap<JView, JSurfaceHolder>();
function getHolder(v: JView): JSurfaceHolder {
  let h = holders.get(v);
  if (!h) { h = new JSurfaceHolder(v); holders.set(v, h); }
  return h;
}
class JSurfaceView extends JViewGroup {
  surfW = 0; surfH = 0;
  ensureSurface(): void {
    const w = this.width(), h = this.height();
    if (w <= 0 || h <= 0 || !this.attached) return;
    const holder = getHolder(this);
    if (holder.surface && this.surfW === w && this.surfH === h) return;
    const created = !holder.surface;
    if (created) allSurfaces.push(holder.surface = { view: this, width: w, height: h, present: null, frames: 0 });
    else { holder.surface!.width = w; holder.surface!.height = h; }
    this.surfW = w; this.surfH = h;
    void onMain(async () => {
      for (const cb of holder.callbacks.slice()) {
        if (created) await guardCall(cb, M_surfaceCreated, holder);
        await guardCall(cb, M_surfaceChanged, holder, holder.format, w, h);
      }
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
    "setType(I)V": () => {},
    "setKeepScreenOn(Z)V": () => {},
    "setFixedSize(II)V": () => {},
    "setSizeFromLayout()V": () => {},
    "isCreating()Z": () => 0,
    "getSurfaceFrame()Landroid/graphics/Rect;": function (this: JSurfaceHolder) { return null; },
    "lockCanvas()Landroid/graphics/Canvas;": () => null,
    "lockCanvas(Landroid/graphics/Rect;)Landroid/graphics/Canvas;": () => null,
    "unlockCanvasAndPost(Landroid/graphics/Canvas;)V": () => {},
  },
});
rt.register({ name: "android/view/SurfaceHolder$Callback", ctor: class extends JObj {} });
rt.register({ name: "android/view/SurfaceHolder$Callback2", ctor: class extends JObj {}, ifaces: ["android/view/SurfaceHolder$Callback"] });
rt.register({ name: "android/view/TextureView$SurfaceTextureListener", ctor: class extends JObj {} });
/** the Java Surface: one stable handle onto its holder's live surface, which ANativeWindow_fromSurface derefs */
export class JSurface extends JObj {
  holder: JSurfaceHolder | null = null;
  get surf(): GlSurface | null { return this.holder?.surface ?? null; }
}
rt.register({
  name: "android/view/Surface", ctor: JSurface,
  methods: {
    "<init>(Landroid/graphics/SurfaceTexture;)V": function () {},
    "isValid()Z": function (this: JSurface) { return this.surf ? 1 : 0; },
    "release()V": () => {},
  },
});
rt.register({
  name: "android/view/SurfaceView", ctor: JSurfaceView, sup: "android/view/ViewGroup",
  methods: {
    "<init>(Landroid/content/Context;)V": async function (this: JSurfaceView, c: unknown) { await initViewFromCtx(this, c, null); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: JSurfaceView, c: unknown, set: any) { await initViewFromCtx(this, c, set); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": async function (this: JSurfaceView, c: unknown, set: any) { await initViewFromCtx(this, c, set); },
    "getHolder()Landroid/view/SurfaceHolder;": function (this: JSurfaceView) { return getHolder(this); },
    "setZOrderOnTop(Z)V": () => {},
    "setZOrderMediaOverlay(Z)V": () => {},
    "setSecure(Z)V": () => {},
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

// ── the fake GL10 passed to Renderer callbacks (AndEngine ignores it, uses GLES20 statics)
rt.register({ name: "webdroid/GL10", ctor: class extends JObj {}, ifaces: ["javax/microedition/khronos/opengles/GL10", "javax/microedition/khronos/opengles/GL"] });
for (const i of ["javax/microedition/khronos/opengles/GL", "javax/microedition/khronos/opengles/GL10",
  "javax/microedition/khronos/opengles/GL11", "javax/microedition/khronos/egl/EGLConfig",
  "javax/microedition/khronos/egl/EGLDisplay", "javax/microedition/khronos/egl/EGL"]) {
  rt.register({ name: i, ctor: class extends JObj {} });
}
rt.register({
  name: "javax/microedition/khronos/egl/EGLContext", ctor: JEGLContext,
  methods: {
    "static getEGL()Ljavax/microedition/khronos/egl/EGL;": () => new (rt.link("javax/microedition/khronos/egl/EGL10").ctor)(),
    "getGL()Ljavax/microedition/khronos/opengles/GL;": () => new (rt.link("webdroid/GL10").ctor)(),
  },
});

// ── EGL10: configs answer from the live context; window surfaces are the SurfaceView's
class JEGLConfig extends JObj {}
const theConfig = new JEGLConfig();
class JEGLSurface extends JObj { surf: GlSurface | null = null; }
const attrVal = (a: Int32Array | null, k: number): number => { if (a) for (let i = 0; i + 1 < a.length && a[i] !== 0x3038; i += 2) if (a[i] === k) return a[i + 1]; return 0; };
rt.register({ name: "javax/microedition/khronos/egl/EGLSurface", ctor: JEGLSurface });
const surfaceOf = (win: unknown): GlSurface | null =>
  win instanceof JSurfaceHolder ? win.surface : win instanceof JView ? getHolder(win).surface : null;
rt.register({
  name: "javax/microedition/khronos/egl/EGL10", ctor: class extends JObj {},
  statics: {
    EGL_RED_SIZE: 0x3024, EGL_GREEN_SIZE: 0x3023, EGL_BLUE_SIZE: 0x3022, EGL_ALPHA_SIZE: 0x3021,
    EGL_DEPTH_SIZE: 0x3025, EGL_STENCIL_SIZE: 0x3026, EGL_RENDERABLE_TYPE: 0x3040, EGL_NONE: 0x3038,
    EGL_DEFAULT_DISPLAY: null, EGL_NO_CONTEXT: null, EGL_NO_DISPLAY: null, EGL_NO_SURFACE: null,
    EGL_SUCCESS: 0x3000, EGL_CONFIG_CAVEAT: 0x3027, EGL_SAMPLES: 0x3031, EGL_SAMPLE_BUFFERS: 0x3032,
    EGL_BUFFER_SIZE: 0x3020, EGL_SURFACE_TYPE: 0x3033, EGL_WINDOW_BIT: 4, EGL_PBUFFER_BIT: 1, EGL_CONFIG_ID: 0x3028,
    EGL_WIDTH: 0x3057, EGL_HEIGHT: 0x3056, EGL_BAD_ALLOC: 0x3003, EGL_BAD_NATIVE_WINDOW: 0x300b, EGL_CONTEXT_LOST: 0x300e,
    EGL_VENDOR: 0x3053, EGL_VERSION: 0x3054, EGL_EXTENSIONS: 0x3055, EGL_NATIVE_VISUAL_ID: 0x302e,
  },
  methods: {
    "eglChooseConfig(Ljavax/microedition/khronos/egl/EGLDisplay;[I[Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z":
      (display: unknown, attrs: Int32Array, configs: unknown[] | null, num: number, numConfig: Int32Array) => {
        if (configs && num > 0) configs[0] = theConfig;
        if (numConfig) numConfig[0] = 1;
        return 1;
      },
    "eglGetConfigAttrib(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z":
      (display: unknown, config: unknown, attr: number, out: Int32Array) => {
        out[0] = eglConfigAttrib(attr);
        return 1;
      },
    "eglGetError()I": () => 0x3000,
    "eglGetConfigs(Ljavax/microedition/khronos/egl/EGLDisplay;[Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z":
      (_d: unknown, configs: unknown[] | null, n: number, num: Int32Array | null) => {
        if (configs && n > 0) configs[0] = theConfig;
        if (num) num[0] = 1;
        return 1;
      },
    "eglGetDisplay(Ljava/lang/Object;)Ljavax/microedition/khronos/egl/EGLDisplay;": () =>
      new (rt.link("javax/microedition/khronos/egl/EGLDisplay").ctor)(),
    "eglInitialize(Ljavax/microedition/khronos/egl/EGLDisplay;[I)Z": (_d: unknown, v: Int32Array | null) => {
      if (v) { v[0] = 1; v[1] = 4; }
      return 1;
    },
    "eglQueryString(Ljavax/microedition/khronos/egl/EGLDisplay;I)Ljava/lang/String;": (_d: unknown, n: number) => n === 0x3053 ? "webdroid" : n === 0x3054 ? "1.4" : "",
    "eglCreateContext(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;Ljavax/microedition/khronos/egl/EGLContext;[I)Ljavax/microedition/khronos/egl/EGLContext;":
      (_d: unknown, _c: unknown, share: JEGLContext | null) => { const c = new JEGLContext(); c.egl = new EglContext(share?.egl); return c; },
    "eglCreatePbufferSurface(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;[I)Ljavax/microedition/khronos/egl/EGLSurface;":
      (_d: unknown, _c: unknown, at: Int32Array | null) => {
        const e = new JEGLSurface(); e.surf = { view: null, width: attrVal(at, 0x3057) || 1, height: attrVal(at, 0x3056) || 1, present: null, frames: 0 }; return e;
      },
    "eglCreateWindowSurface(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;Ljava/lang/Object;[I)Ljavax/microedition/khronos/egl/EGLSurface;":
      (_d: unknown, _c: unknown, win: unknown) => {
        const s = surfaceOf(win);
        // no surface yet (the view has no size): EGL_NO_SURFACE, as a real EGL answers a dead ANativeWindow
        if (!s) return null;
        const e = new JEGLSurface(); e.surf = s; return e;
      },
    "eglMakeCurrent(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLContext;)Z":
      (_d: unknown, draw: JEGLSurface | null, _r: unknown, ctx: JEGLContext | null) => {
        if (!ctx) { glSurfaces.current = null; setGL(null); return 1; }
        return ctx.egl.makeCurrent(draw?.surf ?? null) ? 1 : 0;
      },
    "eglSwapBuffers(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;)Z":
      async (_d: unknown, s: JEGLSurface | null) => { const c = glSurfaces.current; if (!s?.surf || c?.target !== s.surf) return 0; await c.swap(); return 1; },
    "eglQuerySurface(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;I[I)Z":
      (_d: unknown, s: JEGLSurface | null, attr: number, out: Int32Array) => { out[0] = attr === 0x3057 ? s?.surf?.width ?? 0 : attr === 0x3056 ? s?.surf?.height ?? 0 : 0; return 1; },
    "eglDestroySurface(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;)Z": () => 1,
    "eglDestroyContext(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLContext;)Z": () => 1,
    "eglTerminate(Ljavax/microedition/khronos/egl/EGLDisplay;)Z": () => 1,
    "eglWaitGL()Z": () => 1,
    "eglWaitNative(ILjava/lang/Object;)Z": () => 1,
    "eglGetCurrentContext()Ljavax/microedition/khronos/egl/EGLContext;": () => { const c = new JEGLContext(); c.egl = glSurfaces.current ?? new EglContext(); return c; },
  },
});
