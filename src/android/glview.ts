// GLSurfaceView: owns a WebGL canvas, drives the Renderer, blits into the 2D framebuffer.

import { rt, JObj } from "../jvm/runtime";
import { device } from "../shell/config";
import { mangleMethod } from "../jvm/abi";
import { vcall, JThread, setCurThread, curThread } from "../jvm/natives/jlang";
import { JViewGroup, guardCall, initViewFromCtx, invalidate, uiState, requestLayout, specSize, defaultSize } from "./view";
import { JCanvas } from "./graphics";
import { setGL, gl } from "./gl";
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
        await guardCall((this.renderer as any)[M_onSurfaceCreated], this.renderer, this.fakeGL10, this.eglConfig);
        await guardCall((this.renderer as any)[M_onSurfaceChanged], this.renderer, this.fakeGL10, this.lastW, this.lastH);
      }
      await guardCall((this.renderer as any)[M_onDrawFrame], this.renderer, this.fakeGL10);
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

// SurfaceHolder
class JSurfaceHolder extends JObj { view: JGLSurfaceView | null = null; }
const holders = new WeakMap<JGLSurfaceView, JSurfaceHolder>();
function getHolder(v: JGLSurfaceView): JSurfaceHolder {
  let h = holders.get(v);
  if (!h) { h = new JSurfaceHolder(); h.view = v; holders.set(v, h); }
  return h;
}
rt.register({
  name: "android/view/SurfaceHolder", ctor: class extends JObj {},
  methods: {
    "addCallback(Landroid/view/SurfaceHolder$Callback;)V": () => {},
    "getSurface()Landroid/view/Surface;": () => null,
    "setFormat(I)V": () => {},
    "setType(I)V": () => {},
    "setKeepScreenOn(Z)V": () => {},
    "getSurfaceFrame()Landroid/graphics/Rect;": () => null,
    "lockCanvas()Landroid/graphics/Canvas;": () => null,
  },
});
rt.register({ name: "android/view/SurfaceHolder$Callback", ctor: class extends JObj {} });
rt.register({ name: "android/view/Surface", ctor: class extends JObj {} });

// SurfaceView (non-GL) — basic stub
rt.register({
  name: "android/view/SurfaceView", ctor: class extends JViewGroup {}, sup: "android/view/ViewGroup",
  methods: {
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: JViewGroup, c: unknown, set: any) { await initViewFromCtx(this, c, set); },
    "getHolder()Landroid/view/SurfaceHolder;": () => new (rt.link("android/view/SurfaceHolder").ctor)(),
    "setZOrderOnTop(Z)V": () => {},
    "setZOrderMediaOverlay(Z)V": () => {},
  },
});

// ── the fake GL10 passed to Renderer callbacks (AndEngine ignores it, uses GLES20 statics)
rt.register({ name: "webdroid/GL10", ctor: class extends JObj {}, ifaces: ["javax/microedition/khronos/opengles/GL10", "javax/microedition/khronos/opengles/GL"] });
for (const i of ["javax/microedition/khronos/opengles/GL", "javax/microedition/khronos/opengles/GL10",
  "javax/microedition/khronos/opengles/GL11", "javax/microedition/khronos/egl/EGLConfig",
  "javax/microedition/khronos/egl/EGLDisplay",
  "javax/microedition/khronos/egl/EGLSurface", "javax/microedition/khronos/egl/EGL"]) {
  rt.register({ name: i, ctor: class extends JObj {} });
}
rt.register({
  name: "javax/microedition/khronos/egl/EGLContext", ctor: class extends JObj {},
  methods: {
    "static getEGL()Ljavax/microedition/khronos/egl/EGL;": () => new (rt.link("javax/microedition/khronos/egl/EGL10").ctor)(),
    "getGL()Ljavax/microedition/khronos/opengles/GL;": () => new (rt.link("webdroid/GL10").ctor)(),
  },
});

// ── EGL10: enough for AndEngine's config query
class JEGLConfig extends JObj {}
const theConfig = new JEGLConfig();
rt.register({
  name: "javax/microedition/khronos/egl/EGL10", ctor: class extends JObj {},
  statics: {
    EGL_RED_SIZE: 0x3024, EGL_GREEN_SIZE: 0x3023, EGL_BLUE_SIZE: 0x3022, EGL_ALPHA_SIZE: 0x3021,
    EGL_DEPTH_SIZE: 0x3025, EGL_STENCIL_SIZE: 0x3026, EGL_RENDERABLE_TYPE: 0x3040, EGL_NONE: 0x3038,
    EGL_DEFAULT_DISPLAY: null, EGL_NO_CONTEXT: null, EGL_NO_DISPLAY: null, EGL_NO_SURFACE: null,
    EGL_SUCCESS: 0x3000, EGL_CONFIG_CAVEAT: 0x3027, EGL_SAMPLES: 0x3031, EGL_SAMPLE_BUFFERS: 0x3032,
  },
  methods: {
    "eglChooseConfig(Ljavax/microedition/khronos/egl/EGLDisplay;[I[Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z":
      (display: unknown, attrs: Int32Array, configs: unknown[] | null, num: number, numConfig: Int32Array) => {
        if (configs) configs[0] = theConfig;
        if (numConfig) numConfig[0] = 1;
        return 1;
      },
    "eglGetConfigAttrib(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z":
      (display: unknown, config: unknown, attr: number, out: Int32Array) => {
        // colour is always RGBA8; depth/stencil/samples are whatever the live context got.
        const a = gl?.getContextAttributes();
        const map: Record<number, number> = { 0x3024: 8, 0x3023: 8, 0x3022: 8, 0x3021: 8,
          0x3025: a && !a.depth ? 0 : 16, 0x3026: a?.stencil ? 8 : 0, 0x3031: a?.antialias ? 4 : 0, 0x3032: a?.antialias ? 1 : 0 };
        out[0] = map[attr] ?? 0;
        return 1;
      },
    "eglGetError()I": () => 0x3000,
    "eglGetConfigs(Ljavax/microedition/khronos/egl/EGLDisplay;[Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z":
      (_d: unknown, configs: unknown[] | null, _n: number, num: Int32Array | null) => {
        if (configs) configs[0] = theConfig;
        if (num) num[0] = 1;
        return 1;
      },
    "eglGetDisplay(Ljava/lang/Object;)Ljavax/microedition/khronos/egl/EGLDisplay;": () =>
      new (rt.link("javax/microedition/khronos/egl/EGLDisplay").ctor)(),
    "eglInitialize(Ljavax/microedition/khronos/egl/EGLDisplay;[I)Z": (_d: unknown, v: Int32Array | null) => {
      if (v) { v[0] = 1; v[1] = 4; }
      return 1;
    },
    "eglCreateContext(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;Ljavax/microedition/khronos/egl/EGLContext;[I)Ljavax/microedition/khronos/egl/EGLContext;":
      () => new (rt.link("javax/microedition/khronos/egl/EGLContext").ctor)(),
    "eglCreatePbufferSurface(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;[I)Ljavax/microedition/khronos/egl/EGLSurface;":
      () => new (rt.link("javax/microedition/khronos/egl/EGLSurface").ctor)(),
    "eglMakeCurrent(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLContext;)Z": () => 1,
    "eglDestroySurface(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;)Z": () => 1,
    "eglDestroyContext(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLContext;)Z": () => 1,
    "eglTerminate(Ljavax/microedition/khronos/egl/EGLDisplay;)Z": () => 1,
  },
});
