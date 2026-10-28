// EGL 1.5 over WebGL2 for its three front ends: libEGL (native/egl.ts), android.opengl's EGL14 and EGLExt, and EGLImpl, the
// javax.microedition EGL10 that GLSurfaceView and EGLContext.getEGL() run in framework.jar's bytecode. One display; an RGBA8888 and an
// RGB888 config (GLSurfaceView's default chooser wants alpha 0 exactly); contexts that own a WebGL2 context; window surfaces over a
// Surface's or SurfaceTexture's GL surface, and pbuffers. Every front end names them by the same handles. A call leaves its thread's
// error, EGL_SUCCESS or the one it failed with, which eglGetError answers and resets; the eglGetCurrent* queries leave it, as AOSP's do.
import { rt, JObj, getDeclared, setDeclared, peerField, noEffect, waits } from "../jvm/runtime.ts";
import { curThread, iof, linkClass } from "../jvm/natives/jentry.ts";
import { bindContext, currentContext } from "../native/gl-context.ts";
import { vsync } from "./vsync.ts";
import { bufferHeight, bufferWidth, presentSurface, surfaceTextureOf, type GlSurface } from "./glsurface.ts";
import { glSurfaceOf, nativeSurface } from "./surfaceflinger.ts";

export const SUCCESS = 0x3000, NOT_INITIALIZED = 0x3001, BAD_ACCESS = 0x3002, BAD_ALLOC = 0x3003, BAD_ATTRIBUTE = 0x3004, BAD_CONFIG = 0x3005,
  BAD_CONTEXT = 0x3006, BAD_DISPLAY = 0x3008, BAD_MATCH = 0x3009, BAD_NATIVE_PIXMAP = 0x300a, BAD_NATIVE_WINDOW = 0x300b, BAD_PARAMETER = 0x300c,
  BAD_SURFACE = 0x300d, CONTEXT_LOST = 0x300e;
export const NONE = 0x3038, DISPLAY = 1;
const DRAW = 0x3059, READ = 0x305a, ES_API = 0x30a0, BACK_BUFFER = 0x3084, NO_TEXTURE = 0x305c, DONT_CARE = -1;
export type Attribs = Map<number, number>;
/** an EGL_NONE-terminated list of (attribute, value) pairs, of which `at(i)` reads the i-th int */
export function attribList(at: (i: number) => number, length = Infinity): Attribs {
  const m: Attribs = new Map();
  for (let i = 0; i + 1 < length && at(i) !== NONE; i += 2) m.set(at(i), at(i + 1));
  return m;
}

// ── errors
const errors = new WeakMap<object, number>();
/** a call of thread `t` begins: the error an earlier one left is gone */
export const begin = (t: object): void => { errors.delete(t); };
export function fail<T>(t: object, error: number, result: T): T { errors.set(t, error); return result; }
export function getError(t: object): number { const e = errors.get(t) ?? SUCCESS; errors.delete(t); return e; }

// ── contexts and surfaces
/** pbuffers: EGL's own surfaces, which no consumer shows */
const pbuffers = new WeakSet<GlSurface>();
/** An EGL context owns a WebGL2 context. WebGL binds one to a canvas for life, so making a surface current sizes the canvas to the
 *  surface's buffers, and a swap hands the finished frame to the surface as an ImageBitmap. A shared context shares the canvas, hence
 *  the object namespace; a pbuffer does not resize it while a sharing context is current on a surface (resizing clears it). */
export class EglContext {
  canvas: OffscreenCanvas;
  gl: WebGL2RenderingContext | null = null;
  /** while current: the draw and read surfaces, and the thread */
  target: GlSurface | null = null;
  read: GlSurface | null = null;
  thread: object | null = null;
  major = 2;
  config = 1;
  private readonly group: Set<EglContext>;
  constructor(share?: EglContext | null) {
    this.canvas = share?.canvas ?? new OffscreenCanvas(1, 1);
    (this.group = share?.group ?? new Set()).add(this);
  }
  makeCurrent(draw: GlSurface | null, thread: object = curThread, read: GlSurface | null = draw): boolean {
    const config = configOf(this.config)!;
    this.gl ??= this.canvas.getContext("webgl2", { alpha: config.get(0x3021)! > 0, antialias: config.get(0x3032) === 1, depth: true, stencil: true, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    if (!this.gl || this.gl.isContextLost()) return false;
    const was = currentContext(thread);
    if (was && was !== this) was.thread = null;
    if (draw && !(pbuffers.has(draw) && [...this.group].some((c) => c !== this && c.thread && c.target))) this.fit(draw);
    this.target = draw; this.read = read; this.thread = thread;
    bindContext(thread, this);
    return true;
  }
  /** the drawing buffer takes the surface's buffer size; a new geometry applies from the next frame */
  private fit(s: GlSurface): void {
    const width = bufferWidth(s), height = bufferHeight(s);
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
  }
  /** present: the frame goes to the surface's consumer and the caller waits for the next display frame (eglSwapBuffers blocks for vsync) */
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
  /** `thread` has no context current */
  static release(thread: object): void {
    const c = currentContext(thread);
    if (c) c.thread = null;
    bindContext(thread, null);
  }
  destroy(): void { this.group.delete(this); }
}
interface Surf { surface: GlSurface; config: number }
const contexts = new Map<number, EglContext>(), surfaces = new Map<number, Surf>();
/** a context's or GL surface's handle: a released one keeps its number, which no longer names it */
const names = new WeakMap<object, number>();
let last = 0;
function name(table: Map<number, EglContext | Surf>, o: EglContext | GlSurface, entry: EglContext | Surf): number {
  names.set(o, ++last);
  table.set(last, entry);
  return last;
}
function drop(h: number, s: Surf): void {
  surfaces.delete(h);
  if (pbuffers.has(s.surface)) { s.surface.present?.close(); s.surface.present = null; }
}

// ── the display
let refs = 0;
/** begins a call that takes a display (begin), answering whether `dpy` is the display, initialized, as such a call requires */
export function enter(t: object, dpy: number): boolean {
  begin(t);
  if (dpy !== DISPLAY) return fail(t, BAD_DISPLAY, false);
  return refs > 0 || fail(t, NOT_INITIALIZED, false);
}
/** eglGetDisplay: EGL_DEFAULT_DISPLAY's is the only one */
export function getDisplay(t: object, native: number | bigint): number { begin(t); return Number(native) === 0 ? DISPLAY : fail(t, BAD_PARAMETER, 0); }
export function initialize(t: object, dpy: number): boolean {
  begin(t);
  if (dpy !== DISPLAY) return fail(t, BAD_DISPLAY, false);
  refs++;
  return true;
}
/** Android counts initializations: the last termination releases the display's contexts and surfaces, those current staying usable
 *  until released */
export function terminate(t: object, dpy: number): boolean {
  begin(t);
  if (dpy !== DISPLAY) return fail(t, BAD_DISPLAY, false);
  if (refs > 0 && --refs === 0) {
    for (const c of contexts.values()) c.destroy();
    contexts.clear();
    for (const [h, s] of surfaces) drop(h, s);
  }
  return true;
}
/** EGLImpl.getInitCount */
const initCount = (dpy: number): number => (dpy === DISPLAY ? refs : 0);
const STRINGS: Record<number, string> = { 0x3053: "webdroid", 0x3054: "1.5", 0x308d: "OpenGL_ES",
  0x3055: "EGL_ANDROID_get_native_client_buffer EGL_ANDROID_image_native_buffer EGL_ANDROID_native_fence_sync EGL_ANDROID_presentation_time EGL_KHR_create_context EGL_KHR_fence_sync "
    + "EGL_KHR_image_base EGL_KHR_surfaceless_context EGL_KHR_wait_sync" };
export function queryString(t: object, dpy: number, n: number): string | null {
  return enter(t, dpy) ? STRINGS[n] ?? fail(t, BAD_PARAMETER, null) : null;
}

// ── configs: the attributes of EGL 1.5's table 3.1, 0x3020 (BUFFER_SIZE) to 0x3042 (CONFORMANT), then RECORDABLE_ANDROID and
// COLOR_COMPONENT_TYPE_EXT; the WebGL2 context behind them is the same, with alpha for the configs with alpha bits and multisampled
// (antialias) for those with sample buffers
const SURFACES = 1 | 4, RENDERABLE = 1 | 4 | 0x40;                                 // PBUFFER | WINDOW; ES | ES2 | ES3
const config = (id: number, alpha: number, visual: number, samples = 0): Attribs => new Map([
  [0x3020, 24 + alpha], [0x3021, alpha], [0x3022, 8], [0x3023, 8], [0x3024, 8], [0x3025, 24], [0x3026, 8], [0x3027, NONE], [0x3028, id],
  [0x3029, 0], [0x302a, 4096], [0x302b, 1 << 24], [0x302c, 4096], [0x302d, 0], [0x302e, visual], [0x302f, NONE], [0x3031, samples], [0x3032, +(samples > 0)],
  [0x3033, SURFACES], [0x3034, NONE], [0x3035, 0], [0x3036, 0], [0x3037, 0], [0x3039, 0], [0x303a, 0], [0x303b, 0], [0x303c, 1],
  [0x303d, 0], [0x303e, 0], [0x303f, 0x308e], [0x3040, RENDERABLE], [0x3042, RENDERABLE], [0x3142, 0], [0x3339, 0x333a],
]);
const CONFIGS = [config(1, 8, 1), config(2, 0, 2), config(3, 8, 1, 4), config(4, 0, 2, 4)];
const configOf = (h: number): Attribs | undefined => CONFIGS[h - 1];
// EGL 1.5 table 3.4: which attributes select at least, or by a mask, or are ignored (the rest exactly), and the defaults besides DONT_CARE
const AT_LEAST = new Set([0x3020, 0x3021, 0x3022, 0x3023, 0x3024, 0x3025, 0x3026, 0x3031, 0x3032, 0x303d, 0x303e]), MASK = new Set([0x3033, 0x3040, 0x3042]);
const IGNORED = new Set([0x302a, 0x302b, 0x302c, 0x302e, 0x3035, 0x3036, 0x3037]), MATCH_NATIVE_PIXMAP = 0x3041;
const DEFAULTS: Attribs = new Map([[0x3029, 0], [0x3033, 4], [0x3034, NONE], [0x303f, 0x308e], [0x3040, 1], [0x3339, 0x333a]]);
const wanted = (want: Attribs, k: number): number => want.get(k) ?? DEFAULTS.get(k) ?? (AT_LEAST.has(k) || MASK.has(k) ? 0 : DONT_CARE);
const selects = (c: Attribs, want: Attribs): boolean => [...c].every(([k, have]) => {
  const v = wanted(want, k);
  return v === DONT_CARE || IGNORED.has(k) || (AT_LEAST.has(k) ? have >= v : MASK.has(k) ? (have & v) === v : have === v);
});
export function getConfigs(t: object, dpy: number): number[] | null { return enter(t, dpy) ? CONFIGS.map((c) => c.get(0x3028)!) : null; }
/** the configs `want` selects, in 3.4.1.2's order: more of the color bits it asks for, then the smaller buffer, then fewer samples */
export function chooseConfig(t: object, dpy: number, want: Attribs): number[] | null {
  if (!enter(t, dpy)) return null;
  for (const k of want.keys()) if (!CONFIGS[0].has(k) && k !== MATCH_NATIVE_PIXMAP) return fail(t, BAD_ATTRIBUTE, null);
  const id = want.get(0x3028) ?? DONT_CARE;
  if (id !== DONT_CARE) return configOf(id) ? [id] : [];
  if ((want.get(MATCH_NATIVE_PIXMAP) ?? NONE) !== NONE) return [];
  const bits = (c: Attribs) => [0x3021, 0x3022, 0x3023, 0x3024].reduce((n, k) => n + (wanted(want, k) > 0 ? c.get(k)! : 0), 0);
  return CONFIGS.filter((c) => selects(c, want)).sort((a, b) => bits(b) - bits(a) || a.get(0x3020)! - b.get(0x3020)! || a.get(0x3031)! - b.get(0x3031)!).map((c) => c.get(0x3028)!);
}
export function getConfigAttrib(t: object, dpy: number, config: number, attr: number): number | null {
  if (!enter(t, dpy)) return null;
  const c = configOf(config);
  return !c ? fail(t, BAD_CONFIG, null) : c.get(attr) ?? fail(t, BAD_ATTRIBUTE, null);
}

// ── contexts
/** ES 1.0, 1.1, 2.0 and 3.0, as EGL_CONTEXT_CLIENT_VERSION (EGL_CONTEXT_MAJOR_VERSION) and EGL_CONTEXT_MINOR_VERSION ask */
export function createContext(t: object, dpy: number, config: number, share: number, want: Attribs): number {
  if (!enter(t, dpy)) return 0;
  if (!configOf(config)) return fail(t, BAD_CONFIG, 0);
  const shared = share ? contexts.get(share) : null, major = want.get(0x3098) ?? 1, minor = want.get(0x30fb) ?? 0;
  if (shared === undefined) return fail(t, BAD_CONTEXT, 0);
  if (major === 1 ? minor !== 0 && minor !== 1 : major !== 2 && major !== 3 || minor !== 0) return fail(t, BAD_MATCH, 0);
  const c = new EglContext(shared);
  c.major = major; c.config = config;
  return name(contexts, c, c);
}
/** a context current somewhere stays current until released */
export function destroyContext(t: object, dpy: number, h: number): boolean {
  if (!enter(t, dpy)) return false;
  const c = contexts.get(h);
  if (!c) return fail(t, BAD_CONTEXT, false);
  contexts.delete(h);
  c.destroy();
  return true;
}
export function makeCurrent(t: object, dpy: number, draw: number, read: number, ctx: number): boolean {
  begin(t);
  if (dpy !== DISPLAY) return fail(t, BAD_DISPLAY, false);
  if (!ctx) {
    if (draw || read) return fail(t, BAD_MATCH, false);
    EglContext.release(t);
    return true;
  }
  if (!refs) return fail(t, NOT_INITIALIZED, false);
  const c = contexts.get(ctx), d = surfaces.get(draw), r = surfaces.get(read);
  if (!c) return fail(t, BAD_CONTEXT, false);
  if (draw && !d || read && !r) return fail(t, BAD_SURFACE, false);
  if (!d !== !r) return fail(t, BAD_MATCH, false);
  if (c.thread && c.thread !== t) return fail(t, BAD_ACCESS, false);
  return c.makeCurrent(d?.surface ?? null, t, r?.surface ?? null) || fail(t, c.gl?.isContextLost() ? CONTEXT_LOST : BAD_ALLOC, false);
}
export function releaseThread(t: object): boolean { begin(t); EglContext.release(t); return true; }
export function queryContext(t: object, dpy: number, h: number, attr: number): number | null {
  if (!enter(t, dpy)) return null;
  const c = contexts.get(h);
  if (!c) return fail(t, BAD_CONTEXT, null);
  switch (attr) {
    case 0x3028: return c.config;
    case 0x3097: return ES_API;                                                // CONTEXT_CLIENT_TYPE
    case 0x3098: return c.major;                                               // CONTEXT_CLIENT_VERSION
    case 0x3086: return c.thread && c.target ? BACK_BUFFER : NONE;             // RENDER_BUFFER
  }
  return fail(t, BAD_ATTRIBUTE, null);
}
export function getCurrentContext(t: object): number { const c = currentContext(t); return c ? names.get(c) ?? name(contexts, c, c) : 0; }
export const getCurrentDisplay = (t: object): number => (currentContext(t) ? DISPLAY : 0);
export function getCurrentSurface(t: object, which: number): number {
  const c = currentContext(t);
  if (!c) return 0;
  if (which !== DRAW && which !== READ) return fail(t, BAD_PARAMETER, 0);
  const s = which === DRAW ? c.target : c.read;
  return s ? names.get(s) ?? 0 : 0;
}

// ── surfaces
export function createWindowSurface(t: object, dpy: number, config: number, window: GlSurface | null): number {
  if (!enter(t, dpy)) return 0;
  if (!configOf(config)) return fail(t, BAD_CONFIG, 0);
  return window ? name(surfaces, window, { surface: window, config }) : fail(t, BAD_NATIVE_WINDOW, 0);
}
export function createPbufferSurface(t: object, dpy: number, config: number, want: Attribs): number {
  if (!enter(t, dpy)) return 0;
  if (!configOf(config)) return fail(t, BAD_CONFIG, 0);
  const width = want.get(0x3057) ?? 0, height = want.get(0x3056) ?? 0;
  if (width < 0 || height < 0) return fail(t, BAD_PARAMETER, 0);
  const surface: GlSurface = { width: width || 1, height: height || 1, present: null, frames: 0 };
  pbuffers.add(surface);
  return name(surfaces, surface, { surface, config });
}
/** a surface current somewhere stays current until released */
export function destroySurface(t: object, dpy: number, h: number): boolean {
  if (!enter(t, dpy)) return false;
  const s = surfaces.get(h);
  if (!s) return fail(t, BAD_SURFACE, false);
  drop(h, s);
  return true;
}
/** what no surface here supports: pixmaps and copies to them, binding as a texture, client buffers; `h` names the surface it is asked of */
export function unsupported(t: object, dpy: number, error: number, h?: number): boolean {
  return enter(t, dpy) && fail(t, h === undefined || surfaces.has(h) ? error : BAD_SURFACE, false);
}
export function querySurface(t: object, dpy: number, h: number, attr: number): number | null {
  if (!enter(t, dpy)) return null;
  const s = surfaces.get(h);
  if (!s) return fail(t, BAD_SURFACE, null);
  switch (attr) {
    case 0x3057: return bufferWidth(s.surface);
    case 0x3056: return bufferHeight(s.surface);
    case 0x3028: return s.config;
    case 0x3093: return 0x3095;                                                // SWAP_BEHAVIOR: BUFFER_DESTROYED
    case 0x3086: return BACK_BUFFER;                                           // RENDER_BUFFER
    case 0x3058: case 0x3082: case 0x3083: return 0;                           // LARGEST_PBUFFER, MIPMAP_TEXTURE, MIPMAP_LEVEL
    case 0x3080: case 0x3081: return NO_TEXTURE;                               // TEXTURE_FORMAT, TEXTURE_TARGET
    case 0x3099: return 0x309a;                                                // MULTISAMPLE_RESOLVE: DEFAULT
    case 0x3090: case 0x3091: case 0x3092: return -1;                          // HORIZONTAL/VERTICAL_RESOLUTION, PIXEL_ASPECT_RATIO: UNKNOWN
  }
  return fail(t, BAD_ATTRIBUTE, null);
}
/** the attributes a surface can be set to are those it has: no preserved swaps, box resolves or mipmaps */
export function surfaceAttrib(t: object, dpy: number, h: number, attr: number, value: number): boolean {
  if (!enter(t, dpy)) return false;
  if (!surfaces.has(h)) return fail(t, BAD_SURFACE, false);
  if (attr === 0x3093) return value === 0x3095 || fail(t, value === 0x3094 ? BAD_MATCH : BAD_PARAMETER, false);
  if (attr === 0x3099) return value === 0x309a || fail(t, value === 0x309b ? BAD_MATCH : BAD_PARAMETER, false);
  return attr === 0x3083 || fail(t, BAD_ATTRIBUTE, false);
}
/** a window's frame goes to its consumer, after which the caller waits for vsync unless its swap interval is 0; a pbuffer has no
 *  front buffer, so its swap does nothing */
export function swapBuffers(t: object, dpy: number, h: number): PromiseOrVal<boolean> {
  if (!enter(t, dpy)) return false;
  const s = surfaces.get(h), c = currentContext(t);
  if (!s || !c || c.target !== s.surface) return fail(t, BAD_SURFACE, false);
  if (pbuffers.has(s.surface)) return true;
  return c.swap().then((ok) => ok || fail(t, CONTEXT_LOST, false));
}
export function swapInterval(t: object, dpy: number, interval: number): boolean {
  if (!enter(t, dpy)) return false;
  const c = currentContext(t);
  if (!c) return fail(t, BAD_CONTEXT, false);
  if (!c.target) return fail(t, BAD_SURFACE, false);
  c.target.swapInterval = Math.max(0, Math.min(1, interval));
  return true;
}
/** EGL_ANDROID_presentation_time: the time the surface's next frame carries to its consumer */
export function presentationTime(t: object, dpy: number, h: number, nanos: bigint): boolean {
  if (!enter(t, dpy)) return false;
  const s = surfaces.get(h);
  if (!s) return fail(t, BAD_SURFACE, false);
  s.surface.presentationTimeNanos = nanos;
  return true;
}

// ── the client API: OpenGL ES alone, whose work WebGL orders itself
export function bindAPI(t: object, api: number): boolean { begin(t); return api === ES_API || fail(t, BAD_PARAMETER, false); }
export function queryAPI(t: object): number { begin(t); return ES_API; }
export function waitClient(t: object): boolean { begin(t); return true; }
/** EGL_CORE_NATIVE_ENGINE is the one engine */
export function waitNative(t: object, engine: number): boolean { begin(t); return engine === 0x305b || fail(t, BAD_PARAMETER, false); }

// ── Java's front ends
const iae = (message?: string) => rt.mkThrowable("java/lang/IllegalArgumentException", message ?? null);
const uoe = (message: string) => rt.mkThrowable("java/lang/UnsupportedOperationException", message);
const answer = (out: Int32Array, at: number, value: number | null): number => { if (value === null) return 0; out[at] = value; return 1; };
const settled = (r: PromiseOrVal<boolean>): PromiseOrVal<number> => (r instanceof Promise ? r.then(Number) : +r);
/** the GL surface a window surface draws to: a Surface's, or a SurfaceTexture's (null once abandoned); undefined for an object with
 *  no native window, which the JNI refuses */
function windowOf(win: unknown): GlSurface | null | undefined {
  if (iof(win, "android/view/Surface")) { const s = nativeSurface(win as JObj); return s ? glSurfaceOf(s) : undefined; }
  const st = surfaceTextureOf(win);
  return st ? (st.abandoned ? null : st.surface) : undefined;
}

// android_opengl_EGL14.cpp: an EGLObjectHandle's long is the handle, and the EGL_NO_* objects stand for handle 0
const E14 = "android/opengl/";
const handle14 = (o: JObj | null): number => {
  if (!o) throw iae("Object is set to null.");
  return Number(getDeclared<bigint>(o, E14 + "EGLObjectHandle", "mHandle"));
};
const no14: Record<string, JObj> = {};
const make14 = (cls: string, h: number): JObj => setDeclared(rt.make(E14 + cls), E14 + "EGLObjectHandle", { mHandle: BigInt(h) });
const object14 = (cls: string, h: number): JObj => (h === 0 && no14[cls]) || make14(cls, h);
/** glgen's checks of an array argument from its offset, `need` elements long */
function array<T extends { length: number }>(a: T | null, at: number, name: string, offset = name + "Offset", need = 1, needName = String(need)): T {
  if (!a) throw iae(`${name} == null`);
  if (at < 0) throw iae(`${offset} < 0`);
  if (a.length - at < need) throw iae(`length - ${offset} < ${needName} < needed`);
  return a;
}
function attribs14(a: Int32Array | null, at: number, nullable = false, offset = "offset"): Attribs {
  if (!a) { if (nullable) return new Map(); throw iae("attrib_list == null"); }
  if (at < 0) throw iae(`${offset} < 0`);
  if (!a.subarray(at).includes(NONE)) throw iae("attrib_list must contain EGL_NONE!");
  return attribList((i) => a[at + i], a.length - at);
}
/** eglGetConfigs' and eglChooseConfig's out arrays, checked before `find` runs: up to config_size configs, and their count */
function configs14(find: () => number[] | null, configs: JObj[] | null, configsAt: number, size: number, num: Int32Array | null, numAt: number): number {
  if (configs) array(configs, configsAt, "configs", "configsOffset", size, "config_size");
  const count = array(num, numAt, "num_config"), found = find();
  if (!found) return 0;
  const n = configs ? Math.min(Math.max(size, 0), found.length) : found.length;
  for (let i = 0; i < n && configs; i++) configs[configsAt + i] = object14("EGLConfig", found[i]);
  count[numAt] = n;
  return 1;
}
function window14(dpy: JObj, config: JObj, win: unknown, list: Int32Array | null, at: number): JObj {
  const d = handle14(dpy), c = handle14(config), w = windowOf(win);
  if (w === undefined) throw iae("Make sure the SurfaceView or associated SurfaceHolder has a valid Surface");
  attribs14(list, at, true);
  return object14("EGLSurface", createWindowSurface(curThread, d, c, w));
}
function clientBuffer14(dpy: JObj, _type: number, _buffer: unknown, config: JObj, list: Int32Array | null, at: number): JObj {
  const d = handle14(dpy);
  handle14(config);
  attribs14(list, at);
  unsupported(curThread, d, BAD_PARAMETER);
  return object14("EGLSurface", 0);
}
const D = "Landroid/opengl/EGLDisplay;", C = "Landroid/opengl/EGLConfig;", X = "Landroid/opengl/EGLContext;", S = "Landroid/opengl/EGLSurface;";
rt.registerJnis(E14 + "EGL14", {
  "_nativeClassInit()V": () => {
    const egl = linkClass(E14 + "EGL14");
    for (const cls of ["EGLContext", "EGLDisplay", "EGLSurface"]) egl.setStatic("EGL_NO_" + cls.slice(3).toUpperCase(), no14[cls] = make14(cls, 0));
  },
  "eglGetError()I": () => getError(curThread),
  "eglGetDisplay(I)Landroid/opengl/EGLDisplay;": (native: number) => object14("EGLDisplay", getDisplay(curThread, native)),
  "eglGetDisplay(J)Landroid/opengl/EGLDisplay;": (native: bigint) => object14("EGLDisplay", getDisplay(curThread, native)),
  [`eglInitialize(${D}[II[II)Z`]: (dpy: JObj, major: Int32Array | null, majorAt: number, minor: Int32Array | null, minorAt: number) => {
    const d = handle14(dpy);
    if (major) array(major, majorAt, "major");
    if (minor) array(minor, minorAt, "minor");
    if (!initialize(curThread, d)) return 0;
    if (major) major[majorAt] = 1;
    if (minor) minor[minorAt] = 5;
    return 1;
  },
  [`eglTerminate(${D})Z`]: (dpy: JObj) => +terminate(curThread, handle14(dpy)),
  [`eglQueryString(${D}I)Ljava/lang/String;`]: (dpy: JObj, n: number) => queryString(curThread, handle14(dpy), n),
  [`eglGetConfigs(${D}[${C}II[II)Z`]: (dpy: JObj, configs: JObj[] | null, configsAt: number, size: number, num: Int32Array | null, numAt: number) => {
    const d = handle14(dpy);
    return configs14(() => getConfigs(curThread, d), configs, configsAt, size, num, numAt);
  },
  [`eglChooseConfig(${D}[II[${C}II[II)Z`]: (dpy: JObj, list: Int32Array | null, at: number, configs: JObj[] | null, configsAt: number, size: number, num: Int32Array | null, numAt: number) => {
    const d = handle14(dpy), want = attribs14(list, at, false, "attrib_listOffset");
    return configs14(() => chooseConfig(curThread, d, want), configs, configsAt, size, num, numAt);
  },
  [`eglGetConfigAttrib(${D}${C}I[II)Z`]: (dpy: JObj, config: JObj, attr: number, value: Int32Array | null, at: number) => {
    const d = handle14(dpy), c = handle14(config), out = array(value, at, "value", "offset");
    return answer(out, at, getConfigAttrib(curThread, d, c, attr));
  },
  [`_eglCreateWindowSurface(${D}${C}Ljava/lang/Object;[II)${S}`]: window14,
  [`_eglCreateWindowSurfaceTexture(${D}${C}Ljava/lang/Object;[II)${S}`]: window14,
  [`eglCreatePbufferSurface(${D}${C}[II)${S}`]: (dpy: JObj, config: JObj, list: Int32Array | null, at: number) => {
    const d = handle14(dpy), c = handle14(config);
    return object14("EGLSurface", createPbufferSurface(curThread, d, c, attribs14(list, at)));
  },
  [`eglCreatePixmapSurface(${D}${C}I[II)${S}`]: () => { throw uoe("eglCreatePixmapSurface"); },
  [`eglCreatePbufferFromClientBuffer(${D}II${C}[II)${S}`]: clientBuffer14,
  [`eglCreatePbufferFromClientBuffer(${D}IJ${C}[II)${S}`]: clientBuffer14,
  [`eglDestroySurface(${D}${S})Z`]: (dpy: JObj, s: JObj) => +destroySurface(curThread, handle14(dpy), handle14(s)),
  [`eglQuerySurface(${D}${S}I[II)Z`]: (dpy: JObj, s: JObj, attr: number, value: Int32Array | null, at: number) => {
    const d = handle14(dpy), h = handle14(s), out = array(value, at, "value", "offset");
    return answer(out, at, querySurface(curThread, d, h, attr));
  },
  [`eglSurfaceAttrib(${D}${S}II)Z`]: (dpy: JObj, s: JObj, attr: number, value: number) => +surfaceAttrib(curThread, handle14(dpy), handle14(s), attr, value),
  [`eglBindTexImage(${D}${S}I)Z`]: (dpy: JObj, s: JObj) => +unsupported(curThread, handle14(dpy), BAD_MATCH, handle14(s)),
  [`eglReleaseTexImage(${D}${S}I)Z`]: (dpy: JObj, s: JObj) => +unsupported(curThread, handle14(dpy), BAD_MATCH, handle14(s)),
  [`eglCopyBuffers(${D}${S}I)Z`]: (dpy: JObj, s: JObj) => +unsupported(curThread, handle14(dpy), BAD_NATIVE_PIXMAP, handle14(s)),
  [`eglSwapInterval(${D}I)Z`]: (dpy: JObj, interval: number) => +swapInterval(curThread, handle14(dpy), interval),
  [`eglSwapBuffers(${D}${S})Z`]: waits((dpy: JObj, s: JObj) => settled(swapBuffers(curThread, handle14(dpy), handle14(s)))),
  [`eglCreateContext(${D}${C}${X}[II)${X}`]: (dpy: JObj, config: JObj, share: JObj, list: Int32Array | null, at: number) => {
    const d = handle14(dpy), c = handle14(config), s = handle14(share);
    return object14("EGLContext", createContext(curThread, d, c, s, attribs14(list, at)));
  },
  [`eglDestroyContext(${D}${X})Z`]: (dpy: JObj, ctx: JObj) => +destroyContext(curThread, handle14(dpy), handle14(ctx)),
  [`eglMakeCurrent(${D}${S}${S}${X})Z`]: (dpy: JObj, draw: JObj, read: JObj, ctx: JObj) => {
    const d = handle14(dpy), w = handle14(draw), r = handle14(read), c = handle14(ctx);
    return +makeCurrent(curThread, d, w, r, c);
  },
  [`eglQueryContext(${D}${X}I[II)Z`]: (dpy: JObj, ctx: JObj, attr: number, value: Int32Array | null, at: number) => {
    const d = handle14(dpy), c = handle14(ctx), out = array(value, at, "value", "offset");
    return answer(out, at, queryContext(curThread, d, c, attr));
  },
  [`eglGetCurrentContext()${X}`]: () => object14("EGLContext", getCurrentContext(curThread)),
  [`eglGetCurrentSurface(I)${S}`]: (which: number) => object14("EGLSurface", getCurrentSurface(curThread, which)),
  [`eglGetCurrentDisplay()${D}`]: () => object14("EGLDisplay", getCurrentDisplay(curThread)),
  "eglBindAPI(I)Z": (api: number) => +bindAPI(curThread, api),
  "eglQueryAPI()I": () => queryAPI(curThread),
  "eglWaitClient()Z": () => +waitClient(curThread),
  "eglWaitGL()Z": () => +waitClient(curThread),
  "eglWaitNative(I)Z": (engine: number) => +waitNative(curThread, engine),
  "eglReleaseThread()Z": () => +releaseThread(curThread),
});
rt.registerJnis(E14 + "EGLExt", {
  ...noEffect("_nativeClassInit()V"),
  [`eglPresentationTimeANDROID(${D}${S}J)Z`]: (dpy: JObj, s: JObj, nanos: bigint) => +presentationTime(curThread, handle14(dpy), handle14(s), nanos),
});

// com_google_android_gles_jni_EGLImpl.cpp: each EGL object's long is its handle; a null argument, an attribute list that EGL_NONE does
// not end or a short array throws
const GJ = "com/google/android/gles_jni/";
const peer = (cls: string, field: string): ((o: JObj | null) => number) => {
  const read = peerField<bigint>(GJ + cls, field);
  return (o) => { if (!o) throw iae(); return Number(read(o)); };
};
const display10 = peer("EGLDisplayImpl", "mEGLDisplay"), config10 = peer("EGLConfigImpl", "mEGLConfig");
const context10 = peer("EGLContextImpl", "mEGLContext"), surface10 = peer("EGLSurfaceImpl", "mEGLSurface");
function attribs10(a: Int32Array | null): Attribs {
  if (!a) return new Map();
  if (a.at(-1) !== NONE) throw iae();
  return attribList((i) => a[i], a.length);
}
/** a value array at least one long, which an answered query writes */
function value10(a: Int32Array | null): Int32Array { if (!a || a.length < 1) throw iae(); return a; }
function configs10(find: () => number[] | null, configs: JObj[] | null, size: number, num: Int32Array | null): number {
  if (configs && configs.length < size || num && num.length < 1) throw iae();
  const found = find(), n = !found ? 0 : configs ? Math.min(Math.max(size, 0), found.length) : found.length;
  if (num) num[0] = n;
  for (let i = 0; i < n && configs; i++) configs[i] = setDeclared(rt.make(GJ + "EGLConfigImpl"), GJ + "EGLConfigImpl", { mEGLConfig: BigInt(found![i]) });
  return +!!found;
}
function window10(dpy: JObj | null, config: JObj | null, win: unknown, list: Int32Array | null, invalid: string): bigint {
  const d = display10(dpy), c = config10(config);
  attribs10(list);
  const w = windowOf(win);
  if (w === undefined) throw iae(invalid);
  return BigInt(createWindowSurface(curThread, d, c, w));
}
const K = "Ljavax/microedition/khronos/egl/", KD = K + "EGLDisplay;", KC = K + "EGLConfig;", KX = K + "EGLContext;", KS = K + "EGLSurface;";
type Obj = JObj | null;
rt.registerJnis(GJ + "EGLImpl", {
  ...noEffect("_nativeClassInit()V"),
  [`getInitCount(${KD})I`]: (dpy: Obj) => initCount(display10(dpy)),
  // EGLImpl reports EGL 1.0
  [`eglInitialize(${KD}[I)Z`]: (dpy: Obj, version: Int32Array | null) => {
    const d = display10(dpy);
    if (version && version.length < 2) throw iae();
    if (!initialize(curThread, d)) return 0;
    if (version) { version[0] = 1; version[1] = 0; }
    return 1;
  },
  [`eglTerminate(${KD})Z`]: (dpy: Obj) => +terminate(curThread, display10(dpy)),
  [`_eglGetDisplay(Ljava/lang/Object;)J`]: () => BigInt(getDisplay(curThread, 0)),
  [`eglQueryString(${KD}I)Ljava/lang/String;`]: (dpy: Obj, n: number) => queryString(curThread, display10(dpy), n),
  [`eglGetConfigs(${KD}[${KC}I[I)Z`]: (dpy: Obj, configs: JObj[] | null, size: number, num: Int32Array | null) => {
    const d = display10(dpy);
    return configs10(() => getConfigs(curThread, d), configs, size, num);
  },
  [`eglChooseConfig(${KD}[I[${KC}I[I)Z`]: (dpy: Obj, list: Int32Array | null, configs: JObj[] | null, size: number, num: Int32Array | null) => {
    const d = display10(dpy), want = attribs10(list);
    return configs10(() => chooseConfig(curThread, d, want), configs, size, num);
  },
  [`eglGetConfigAttrib(${KD}${KC}I[I)Z`]: (dpy: Obj, config: Obj, attr: number, value: Int32Array | null) => {
    const d = display10(dpy), c = config10(config), out = value10(value);
    return answer(out, 0, getConfigAttrib(curThread, d, c, attr));
  },
  [`_eglCreateContext(${KD}${KC}${KX}[I)J`]: (dpy: Obj, config: Obj, share: Obj, list: Int32Array | null) => {
    const d = display10(dpy), c = config10(config), s = context10(share);
    return BigInt(createContext(curThread, d, c, s, attribs10(list)));
  },
  [`eglDestroyContext(${KD}${KX})Z`]: (dpy: Obj, ctx: Obj) => +destroyContext(curThread, display10(dpy), context10(ctx)),
  [`_eglCreatePbufferSurface(${KD}${KC}[I)J`]: (dpy: Obj, config: Obj, list: Int32Array | null) => {
    const d = display10(dpy), c = config10(config);
    return BigInt(createPbufferSurface(curThread, d, c, attribs10(list)));
  },
  [`_eglCreatePixmapSurface(${KS}${KD}${KC}Ljava/lang/Object;[I)V`]: () => { throw uoe("eglCreatePixmapSurface"); },
  [`_eglCreateWindowSurface(${KD}${KC}Ljava/lang/Object;[I)J`]: (dpy: Obj, config: Obj, win: unknown, list: Int32Array | null) =>
    window10(dpy, config, win, list, "Make sure the SurfaceView or associated SurfaceHolder has a valid Surface"),
  [`_eglCreateWindowSurfaceTexture(${KD}${KC}Ljava/lang/Object;[I)J`]: (dpy: Obj, config: Obj, win: unknown, list: Int32Array | null) =>
    window10(dpy, config, win, list, "Make sure the SurfaceTexture is valid"),
  [`eglDestroySurface(${KD}${KS})Z`]: (dpy: Obj, s: Obj) => +destroySurface(curThread, display10(dpy), surface10(s)),
  [`eglQuerySurface(${KD}${KS}I[I)Z`]: (dpy: Obj, s: Obj, attr: number, value: Int32Array | null) => {
    const d = display10(dpy), h = surface10(s), out = value10(value);
    return answer(out, 0, querySurface(curThread, d, h, attr));
  },
  [`eglQueryContext(${KD}${KX}I[I)Z`]: (dpy: Obj, ctx: Obj, attr: number, value: Int32Array | null) => {
    const d = display10(dpy), c = context10(ctx), out = value10(value);
    return answer(out, 0, queryContext(curThread, d, c, attr));
  },
  [`eglMakeCurrent(${KD}${KS}${KS}${KX})Z`]: (dpy: Obj, draw: Obj, read: Obj, ctx: Obj) => {
    const d = display10(dpy), w = surface10(draw), r = surface10(read), c = context10(ctx);
    return +makeCurrent(curThread, d, w, r, c);
  },
  [`eglSwapBuffers(${KD}${KS})Z`]: waits((dpy: Obj, s: Obj) => settled(swapBuffers(curThread, display10(dpy), surface10(s)))),
  // AOSP leaves eglCopyBuffers unimplemented: false, with no EGL call
  [`eglCopyBuffers(${KD}${KS}Ljava/lang/Object;)Z`]: (dpy: Obj, s: Obj, pixmap: unknown) => { display10(dpy); surface10(s); if (!pixmap) throw iae(); return 0; },
  "_eglGetCurrentContext()J": () => BigInt(getCurrentContext(curThread)),
  "_eglGetCurrentDisplay()J": () => BigInt(getCurrentDisplay(curThread)),
  "_eglGetCurrentSurface(I)J": (which: number) => {
    if (which !== DRAW && which !== READ) throw iae();
    return BigInt(getCurrentSurface(curThread, which));
  },
  "eglGetError()I": () => getError(curThread),
  "eglReleaseThread()Z": () => +releaseThread(curThread),
  "eglWaitGL()Z": () => +waitClient(curThread),
  "eglWaitNative(ILjava/lang/Object;)Z": (engine: number) => +waitNative(curThread, engine),
});
