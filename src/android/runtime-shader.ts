import { rt } from "../jvm/runtime.ts";
import { handle, deref, FINALIZER } from "./handles.ts";
import { NativeShader, fillWithShader } from "./shader.ts";
import { localMatrix, type Affine } from "./matrix.ts";
import type { Ctx2D } from "./recording.ts";
import { device } from "../shell/config.ts";
type UniformType = { size: number; integer: boolean; upload: (gl: WebGL2RenderingContext, location: WebGLUniformLocation | null, values: number[]) => void };
type Uniform = { location: WebGLUniformLocation | null; format: UniformType; color: boolean; values: number[] };
const vector = (size: 1 | 2 | 3 | 4, integer = false): UniformType => ({ size, integer,
  upload: (gl, location, values) => integer ? gl[`uniform${size}iv`](location, values) : gl[`uniform${size}fv`](location, values),
});
const matrix = (size: 2 | 3 | 4): UniformType => ({ size: size * size, integer: false,
  upload: (gl, location, values) => gl[`uniformMatrix${size}fv`](location, false, values),
});
const uniformTypes = new Map<string, UniformType>([
  ["float", vector(1)], ["vec2", vector(2)], ["vec3", vector(3)], ["vec4", vector(4)],
  ["int", vector(1, true)], ["ivec2", vector(2, true)], ["ivec3", vector(3, true)], ["ivec4", vector(4, true)],
  ["mat2", matrix(2)], ["mat3", matrix(3)], ["mat4", matrix(4)],
]);
let surface: OffscreenCanvas | null = null;
let context: WebGL2RenderingContext | null = null;
/** created at the display's size: resizing a WebGL canvas after its context exists reallocated the
 *  drawing buffer, a 150-300 ms stall on the first ripple of each launch */
function graphics(): WebGL2RenderingContext {
  if (context) return context;
  surface = new OffscreenCanvas(device.width, device.height);
  context = surface.getContext("webgl2", { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
  if (!context) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "RuntimeShader requires WebGL2");
  return context;
}
function invalid(message: string): never { throw rt.mkThrowable("java/lang/IllegalArgumentException", message); }
function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) return invalid("Cannot allocate shader");
  gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader); gl.deleteShader(shader); return invalid(error ?? "Invalid AGSL");
  }
  return shader;
}
/** the canvases a raster reuses: they only grow, since a resize reallocates and a draw's region
 *  changes size from frame to frame as a ripple grows */
function atLeast(canvas: OffscreenCanvas, width: number, height: number): OffscreenCanvas {
  if (canvas.width < width) canvas.width = width;
  if (canvas.height < height) canvas.height = height;
  return canvas;
}
/** a `uniform shader`: sampled from a texture of what the child paints over the canvas */
type Child = { location: WebGLUniformLocation | null; shader: NativeShader | null };
type Region = readonly [number, number, number, number];
type ShaderState = { readonly uniforms: readonly Uniform[]; readonly children: readonly Child[]; readonly local: DOMMatrixReadOnly | null };
class ShaderProgram {
  readonly program: WebGLProgram;
  private cached: { state: ShaderState; key: string; pattern: CanvasPattern } | null = null;
  private raster: OffscreenCanvas | null = null;
  private readonly textures: WebGLTexture[] = [];
  private readonly childRasters: OffscreenCanvas[] = [];
  readonly transform: WebGLUniformLocation | null;
  readonly height: WebGLUniformLocation | null;
  readonly forward: WebGLUniformLocation | null;
  readonly size: WebGLUniformLocation | null;
  constructor(program: WebGLProgram, gl: WebGL2RenderingContext) {
    this.program = program;
    this.transform = gl.getUniformLocation(program, "wd_coords");
    this.height = gl.getUniformLocation(program, "wd_height");
    this.forward = gl.getUniformLocation(program, "wd_local");
    this.size = gl.getUniformLocation(program, "wd_size");
  }
  /** the shader over `region` of the device (x, y, width, height; by default the whole canvas), as
   *  a pattern in the canvas's current coordinates */
  pattern(ctx: Ctx2D, state: ShaderState, region: Region | null): CanvasPattern {
    const gl = graphics(), [rx, ry, width, height] = region ?? [0, 0, ctx.canvas.width, ctx.canvas.height];
    const canvasMatrix = ctx.getTransform(), device = state.local ? canvasMatrix.multiply(state.local) : canvasMatrix;
    const forward = rx || ry ? new DOMMatrix([1, 0, 0, 1, -rx, -ry]).multiply(device) : device, inverse = forward.inverse();
    const key = `${width},${height},${inverse.a},${inverse.b},${inverse.c},${inverse.d},${inverse.e},${inverse.f}`;
    if (this.cached?.state !== state || this.cached.key !== key) {
      const canvas = atLeast(surface!, width, height);
      gl.viewport(0, 0, width, height); gl.useProgram(this.program);
      gl.uniformMatrix3fv(this.transform, false, [inverse.a, inverse.b, 0, inverse.c, inverse.d, 0, inverse.e, inverse.f, 1]);
      gl.uniform1f(this.height, height);
      for (const u of state.uniforms) u.format.upload(gl, u.location, u.values);
      if (state.children.length) {
        gl.uniformMatrix3fv(this.forward, false, [forward.a, forward.b, 0, forward.c, forward.d, 0, forward.e, forward.f, 1]);
        state.children.forEach((child, i) => this.bindChild(gl, i, child, forward, width, height));
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // One recyclable raster per program, independent of the number of recorded draws. The
      // viewport is the surface's bottom-left corner; beyond the region the raster is never shown.
      const raster = atLeast(this.raster ??= new OffscreenCanvas(width, height), width, height);
      const target = raster.getContext("2d")!; target.globalCompositeOperation = "copy";
      target.drawImage(canvas, 0, canvas.height - height, width, height, 0, 0, width, height);
      const pattern = ctx.createPattern(raster, "no-repeat");
      if (!pattern) return invalid("Cannot create shader pattern");
      this.cached = { state, key, pattern };
    }
    this.cached.pattern.setTransform(canvasMatrix.inverse().translate(rx, ry));
    return this.cached.pattern;
  }
  /** the child painted over the canvas where the parent draws (none: transparent), premultiplied
   *  as SkSL's eval answers, on texture unit `i` */
  private bindChild(gl: WebGL2RenderingContext, i: number, child: Child, forward: DOMMatrix, width: number, height: number): void {
    const raster = atLeast(this.childRasters[i] ??= new OffscreenCanvas(width, height), width, height);
    gl.uniform2f(this.size, raster.width, raster.height);
    const c = raster.getContext("2d")!;
    c.reset();
    if (child.shader) { c.setTransform(forward); fillWithShader(c, child.shader); }
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[i] ??= gl.createTexture()!);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, raster);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(child.location, i);
  }
}
/** SkSL reads an integer literal as a float where one is wanted; GLSL ES 3 converts nothing. A
 *  literal becomes a float unless it indexes, initializes an int, or stands beside an int. */
function floatLiterals(code: string): string {
  const ints = new Set<string>();
  for (const m of code.matchAll(/\b(?:int|ivec[234])\s+(\w+)/g)) ints.add(m[1]);
  return code.replace(/(?<![\w.])\d+(?![\w.])/g, (lit: string, at: number) => {
    const before = code.slice(Math.max(0, at - 80), at), after = code.slice(at + lit.length, at + lit.length + 80);
    if (/\[\s*$/.test(before) || /^\s*\]/.test(after) || /#[^\n]*$/.test(before)) return lit;
    if (/\b(?:int|ivec[234])\s*(?:\w+\s*=|\()\s*$/.test(before)) return lit;
    const left = /(\w+)[\s()+\-*/%<>=!&|^,?:]*$/.exec(before)?.[1], right = /^[\s()+\-*/%<>=!&|^,?:]*(\w+)/.exec(after)?.[1];
    return left && ints.has(left) || right && ints.has(right) ? lit : lit + ".0";
  });
}
/** what a source compiles to, once: RippleDrawable makes a RuntimeShader for every ripple, and
 *  Skia keeps the compiled program for an effect it has seen */
type Effect = { program: ShaderProgram; uniforms: Map<string, Uniform>; children: Map<string, Child> };
const effects = new Map<string, Effect>();
function compileEffect(source: string): Effect {
  const gl = graphics(), uniforms = new Map<string, Uniform>(), children = new Map<string, Child>();
  let code = floatLiterals(source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
    .replace(/\b(?:half|float)([234])x([234])\b/g, (_type, columns: string, rows: string) => columns === rows ? "mat" + columns : `mat${columns}x${rows}`)
    .replace(/\b(?:half|float)([234])\b/g, "vec$1")
    .replace(/\bint([234])\b/g, "ivec$1").replace(/\bhalf\b/g, "float"));
  // a child shader is a texture its eval samples at the canvas position of a local point
  code = code.replace(/\buniform\s+shader\s+(\w+)\s*;/g, (_decl, name: string) => {
    children.set(name, { location: null, shader: null });
    return `uniform sampler2D ${name};`;
  });
  for (const name of children.keys()) code = code.replace(new RegExp(`\\b${name}\\s*\\.\\s*eval\\s*\\(`, "g"), `wd_eval(${name}, `);
  for (const match of code.matchAll(/(layout\s*\(\s*color\s*\)\s*)?\buniform\s+(\w+)\s+([^;]+);/g)) {
    if (match[2] === "sampler2D") continue;
    const [, color, type, declarations] = match, format = uniformTypes.get(type);
    if (!format || color && type !== "vec4") invalid("Unsupported AGSL uniform type: " + type);
    for (const declaration of declarations.split(",")) {
      const parsed = /^\s*(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*$/.exec(declaration);
      if (!parsed) invalid("Unsupported AGSL uniform declaration: " + declaration);
      const [, name, array] = parsed, count = Number(array ?? 1);
      if (!Number.isSafeInteger(count) || count < 1) invalid("Invalid uniform array: " + name);
      uniforms.set(name, { location: null, format, color: !!color, values: new Array(format.size * count).fill(0) });
    }
  }
  const vertex = compile(gl, gl.VERTEX_SHADER, `#version 300 es
    void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`);
  let fragment: WebGLShader | null = null;
  try {
    fragment = compile(gl, gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float; precision highp int;
      uniform mat3 wd_coords; uniform float wd_height; out vec4 wd_color;
      uniform mat3 wd_local; uniform vec2 wd_size;
      vec4 wd_eval(sampler2D s, vec2 p) { vec3 d = wd_local * vec3(p, 1.0); return texture(s, d.xy / wd_size); }
      ${/\b(?:float|vec[234])\s+saturate\s*\(/.test(code) ? "" : "#define saturate(x) clamp(x, 0.0, 1.0)"}
      ${code.replace(/layout\s*\(\s*color\s*\)\s*/g, "").replace(/\bmain\s*\(/g, "wd_main(")}
      void main() { wd_color = wd_main((wd_coords * vec3(gl_FragCoord.x, wd_height - gl_FragCoord.y, 1.0)).xy); }`);
    const program = gl.createProgram();
    if (!program) invalid("Cannot allocate shader program");
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const error = gl.getProgramInfoLog(program); gl.deleteProgram(program); invalid(error ?? "Invalid AGSL program");
    }
    for (const [name, u] of uniforms) u.location = gl.getUniformLocation(program, name);
    for (const [name, c] of children) c.location = gl.getUniformLocation(program, name);
    const effect = { program: new ShaderProgram(program, gl), uniforms, children };
    effects.set(source, effect);
    return effect;
  } finally { gl.deleteShader(vertex); if (fragment) gl.deleteShader(fragment); }
}
/** a RuntimeShader's builder: the compiled AGSL and the uniforms and child shaders set so far */
export class RuntimeShaderBuilder {
  private readonly program: ShaderProgram;
  private readonly uniforms = new Map<string, Uniform>();
  private readonly children = new Map<string, Child>();
  constructor(source: string) {
    const effect = effects.get(source) ?? compileEffect(source);
    this.program = effect.program;
    for (const [name, u] of effect.uniforms) this.uniforms.set(name, { ...u, values: u.values.slice() });
    for (const [name, c] of effect.children) this.children.set(name, { ...c });
  }
  /** a uniform the shader may not declare, set when it does (SkRuntimeShaderBuilder's uniform().fVar) */
  trySet(name: string, values: ArrayLike<number>, color = false): void {
    if (this.uniforms.has(name)) this.set(name, values, color);
  }
  /** nativeUpdateShader: a child shader, what `name.eval` samples */
  setChild(name: string, shader: NativeShader | null): void {
    const c = this.children.get(name);
    if (!c) invalid("unable to find shader named " + name);
    if (c.shader !== shader) { c.shader = shader; this.last = null; }
  }
  /** a shader of the current state with child `name` bound to `child`, the builder's own binding kept */
  withChild(name: string, child: NativeShader): NativeShader {
    const c = this.children.get(name);
    if (!c) invalid("unable to find shader named " + name);
    const own = c.shader;
    this.setChild(name, child);
    try { return this.shader(null); } finally { this.setChild(name, own); }
  }
  set(name: string, values: ArrayLike<number>, color = false, integer = false): void {
    const u = this.uniforms.get(name);
    if (!u || u.values.length !== values.length || u.color !== color || u.format.integer !== integer) invalid("Invalid uniform: " + name);
    let changed = false;
    for (let i = 0; i < values.length; i++) { changed ||= u.values[i] !== values[i]; u.values[i] = values[i]; }
    if (changed) this.last = null;
  }
  /** the state of the last shader made, which the next shares while the uniforms and local matrix
   *  are unchanged: RuntimeShader makes a shader after every uniform set, and the program caches
   *  its raster per state */
  private last: { key: string; state: ShaderState } | null = null;
  /** nativeCreateShader: the program with the uniforms as they are now, rasterized over `region` of
   *  the device when the draw is known to stay inside it */
  shader(local: Affine | null, region: Region | null = null): NativeShader {
    const key = String(local);
    if (this.last?.key !== key) this.last = { key, state: { local: local ? new DOMMatrixReadOnly(local) : null,
      uniforms: [...this.uniforms.values()].map(u => ({ ...u, values: [...u.values] })), children: [...this.children.values()].map(c => ({ ...c })) } };
    const program = this.program, state = this.last.state;
    return new NativeRuntimeShader(local, ctx => program.pattern(ctx, state, region));
  }
}
class NativeRuntimeShader extends NativeShader {
  private readonly draw: (ctx: Ctx2D) => CanvasPattern;
  constructor(local: Affine | null, draw: (ctx: Ctx2D) => CanvasPattern) { super(local); this.draw = draw; }
  override get atReplay(): boolean { return true; }
  override pattern(ctx: Ctx2D): CanvasPattern { return this.draw(ctx); }
}
const shaderBuilder = (h: bigint) => deref<RuntimeShaderBuilder>(h);
rt.registerJnis("android/graphics/RuntimeShader", {
  "nativeGetFinalizer()J": () => FINALIZER,
  "nativeCreateBuilder(Ljava/lang/String;)J": (source: string) => handle(new RuntimeShaderBuilder(source)),
  "nativeCreateShader(JJ)J": (b: bigint, m: bigint) => handle(shaderBuilder(b).shader(localMatrix(m))),
  "nativeUpdateUniforms(JLjava/lang/String;FFFFI)V": (b: bigint, name: string, x: number, y: number, z: number, w: number, n: number) =>
    shaderBuilder(b).set(name, [x, y, z, w].slice(0, n)),
  "nativeUpdateUniforms(JLjava/lang/String;IIIII)V": (b: bigint, name: string, x: number, y: number, z: number, w: number, n: number) =>
    shaderBuilder(b).set(name, [x, y, z, w].slice(0, n), false, true),
  "nativeUpdateUniforms(JLjava/lang/String;[FZ)V": (b: bigint, name: string, values: Float32Array, isColor: number) =>
    shaderBuilder(b).set(name, values, !!isColor),
  "nativeUpdateShader(JLjava/lang/String;J)V": (b: bigint, name: string, shader: bigint) =>
    shaderBuilder(b).setChild(name, shader ? deref<NativeShader>(shader) : null),
  "nativeUpdateUniforms(JLjava/lang/String;[I)V": (b: bigint, name: string, values: Int32Array) =>
    shaderBuilder(b).set(name, values, false, true),
});
