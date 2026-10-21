// The current GL context. A thread (a Java thread, or the JThread a native thread runs as) has at
// most one EGL context current; every GL entry point first selects its caller's, whose WebGL
// context, handle tables and error flags gles1, gles3 and the Java bindings then work on.
import type { EglContext } from "../android/egl.ts";
import type { HostFn } from "./host.ts";
import type { Cpu } from "./cpu.ts";

export type GL = WebGL2RenderingContext | WebGLRenderingContext;
// handle tables: index 1.. → object (0 = null/none, matching GL semantics). They belong to the
// context that minted the handles, as EGL objects do: re-selecting a context keeps last frame's
// VBOs and textures, and a context seen for the first time starts empty — the "EGL context lost"
// case renderers already reload from in onSurfaceCreated.
export type Tables = {
  programs: (WebGLProgram | null)[]; shaders: (WebGLShader | null)[]; buffers: (WebGLBuffer | null)[];
  textures: (WebGLTexture | null)[]; uniforms: (WebGLUniformLocation | null)[];
  vaos: (WebGLVertexArrayObject | null)[]; fbos: (WebGLFramebuffer | null)[]; rbos: (WebGLRenderbuffer | null)[];
  samplers: (WebGLSampler | null)[]; queries: (WebGLQuery | null)[]; syncs: (WebGLSync | null)[]; tfs: (WebGLTransformFeedback | null)[];
  ids: WeakMap<object, number>; // object → handle, for the *_BINDING queries
  /** the context's error flags: one raised host-side, reported before WebGL's; `clean` while WebGL
   *  has latched none since it last answered NO_ERROR; `mixed` once a caller outside gles3 (whose
   *  state tracking proves calls error-free) has used it */
  err: number; clean: boolean; mixed: boolean;
};
const freshTables = (): Tables => ({ programs: [null], shaders: [null], buffers: [null], textures: [null], uniforms: [null],
  vaos: [null], fbos: [null], rbos: [null], samplers: [null], queries: [null], syncs: [null], tfs: [null], ids: new WeakMap(), err: 0, clean: false, mixed: false });
const tablesOf = new WeakMap<GL, Tables>();
/** what a thread with no current context sees */
const NONE = freshTables();
export let gl: GL | null = null;
let T = NONE;
export const tables = (): Tables => T;

const current = new WeakMap<object, EglContext>();
let owner: object | null = null, selected: EglContext | null = null;
/** makes `context` current on `thread` (null releases it), and selects it */
export function bindContext(thread: object, context: EglContext | null): void {
  if (context) current.set(thread, context); else current.delete(thread);
  owner = thread;
  select(context);
}
export const currentContext = (thread: object): EglContext | null => current.get(thread) ?? null;
/** selects the context current on `thread`, as each GL entry point does before it acts */
export function activate(thread: object): EglContext | null {
  if (thread !== owner) { owner = thread; select(current.get(thread) ?? null); }
  return selected;
}
const warned = new WeakSet<object>();
function none(cpu: Cpu, name: string): number {
  if (!warned.has(cpu.jthread)) { warned.add(cpu.jthread); console.warn(`[gl] ${name}: call to OpenGL ES API with no current context`); }
  return 0;
}
/** libGLES's entry point `name`: it selects the calling thread's current context, then runs `before` and `fn`. With none current it is
 *  a logged no-op, as libEGL makes it; it never faults the thread (MapLibre deletes its textures on a GLThread whose context is already released) */
export const entry = (name: string, fn: HostFn, before?: () => void): HostFn => before
  ? (cpu, a) => { if (activate(cpu.jthread) === null) return none(cpu, name); before(); return fn(cpu, a); }
  : (cpu, a) => (activate(cpu.jthread) === null ? none(cpu, name) : fn(cpu, a));
function select(context: EglContext | null): void {
  selected = context;
  const next = context?.gl ?? null;
  if (next === gl) return;
  gl = next;
  if (!next) { T = NONE; return; }
  let t = tablesOf.get(next);
  if (!t) tablesOf.set(next, t = freshTables());
  T = t;
}

/**
 * glGetError. WebGL's getError waits for every queued GPU command (after a present, the whole
 * frame), so while the context is clean NO_ERROR is answered here. GL lets OUT_OF_MEMORY surface
 * late, and WebGL keeps its flags latched until asked, so an allocation that gles3 validated as
 * WebGL does reports a real OOM at the next query that reaches WebGL; Chrome usually loses the
 * context instead, which is always asked.
 */
export function takeError(): number {
  const e = T.err;
  if (e) { T.err = 0; return e; }
  if (!gl || (T.clean && !gl.isContextLost())) return 0;
  const w = gl.getError();
  T.clean = w === 0 && !T.mixed;
  return w;
}
/** a call gles3 does not track reached the current context */
export function untracked(): void { T.clean = false; T.mixed = true; }
/** a tracked call WebGL may reject reached it: the next glGetError asks WebGL */
export function unsure(): void { T.clean = false; }
/** an error GL raises that WebGL would not: kept until glGetError, the first one winning as in GL */
export function raise(e: number): void { T.err ||= e; }
export function put<O extends object>(tbl: (O | null)[], obj: O | null): number {
  tbl.push(obj);
  if (obj) T.ids.set(obj, tbl.length - 1);
  return tbl.length - 1;
}
