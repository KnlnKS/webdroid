import { rt, type NativeSpec } from "../jvm/runtime";
import { JShader } from "./graphics";

import type { Ctx2D } from "./recording";
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
function graphics(): WebGL2RenderingContext {
  if (context) return context;
  surface = new OffscreenCanvas(1, 1);
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
const programs = new FinalizationRegistry<WebGLProgram>(program => context?.deleteProgram(program));
type ShaderState = { readonly uniforms: readonly Uniform[]; readonly local: DOMMatrixReadOnly | null };
class ShaderProgram {
  private cached: { state: ShaderState; key: string; pattern: CanvasPattern } | null = null;
  private raster: OffscreenCanvas | null = null;
  readonly transform: WebGLUniformLocation | null;
  readonly height: WebGLUniformLocation | null;
  constructor(readonly program: WebGLProgram, gl: WebGL2RenderingContext) {
    this.transform = gl.getUniformLocation(program, "wd_coords");
    this.height = gl.getUniformLocation(program, "wd_height");
    programs.register(this, program);
  }
  pattern(ctx: Ctx2D, state: ShaderState): CanvasPattern {
    const gl = graphics(), width = ctx.canvas.width, height = ctx.canvas.height;
    const canvasMatrix = ctx.getTransform();
    const inverse = (state.local ? canvasMatrix.multiply(state.local) : canvasMatrix).inverse();
    const key = `${width},${height},${inverse.a},${inverse.b},${inverse.c},${inverse.d},${inverse.e},${inverse.f}`;
    if (this.cached?.state !== state || this.cached.key !== key) {
      const canvas = surface!;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      gl.viewport(0, 0, width, height); gl.useProgram(this.program);
      gl.uniformMatrix3fv(this.transform, false, [inverse.a, inverse.b, 0, inverse.c, inverse.d, 0, inverse.e, inverse.f, 1]);
      gl.uniform1f(this.height, height);
      for (const u of state.uniforms) u.format.upload(gl, u.location, u.values);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // One recyclable raster per program, independent of the number of recorded draws.
      const raster = this.raster ??= new OffscreenCanvas(width, height);
      if (raster.width !== width) raster.width = width;
      if (raster.height !== height) raster.height = height;
      const target = raster.getContext("2d")!; target.globalCompositeOperation = "copy"; target.drawImage(canvas, 0, 0);
      const pattern = ctx.createPattern(raster, "no-repeat");
      if (!pattern) return invalid("Cannot create shader pattern");
      this.cached = { state, key, pattern };
    }
    this.cached.pattern.setTransform(canvasMatrix.inverse());
    return this.cached.pattern;
  }
}
export class JRuntimeShader extends JShader {
  private compiled: ShaderProgram | null = null;
  private uniforms = new Map<string, Uniform>();
  private captured: { local: string; pattern: (ctx: Ctx2D) => CanvasPattern } | null = null;
  init(source: string): void {
    if (source == null) throw rt.mkThrowable("java/lang/NullPointerException", "shader");
    const gl = graphics();
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
      .replace(/\b(?:half|float)([234])x([234])\b/g, (_type, columns: string, rows: string) => columns === rows ? "mat" + columns : `mat${columns}x${rows}`)
      .replace(/\b(?:half|float)([234])\b/g, "vec$1")
      .replace(/\bint([234])\b/g, "ivec$1").replace(/\bhalf\b/g, "float");
    for (const match of code.matchAll(/(layout\s*\(\s*color\s*\)\s*)?\buniform\s+(\w+)\s+([^;]+);/g)) {
      const [, color, type, declarations] = match, format = uniformTypes.get(type);
      if (!format || color && type !== "vec4") invalid("Unsupported AGSL uniform type: " + type);
      for (const declaration of declarations.split(",")) {
        const parsed = /^\s*(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*$/.exec(declaration);
        if (!parsed) invalid("Unsupported AGSL uniform declaration: " + declaration);
        const [, name, array] = parsed, count = Number(array ?? 1);
        if (!Number.isSafeInteger(count) || count < 1) invalid("Invalid uniform array: " + name);
        this.uniforms.set(name, { location: null, format, color: !!color, values: new Array(format.size * count).fill(0) });
      }
    }
    const vertex = compile(gl, gl.VERTEX_SHADER, `#version 300 es
      void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`);
    let fragment: WebGLShader | null = null;
    try {
      fragment = compile(gl, gl.FRAGMENT_SHADER, `#version 300 es
        precision highp float; precision highp int;
        uniform mat3 wd_coords; uniform float wd_height; out vec4 wd_color;
        ${code.replace(/layout\s*\(\s*color\s*\)\s*/g, "").replace(/\bmain\s*\(/g, "wd_main(")}
        void main() { wd_color = wd_main((wd_coords * vec3(gl_FragCoord.x, wd_height - gl_FragCoord.y, 1.0)).xy); }`);
      const program = gl.createProgram();
      if (!program) invalid("Cannot allocate shader program");
      gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const error = gl.getProgramInfoLog(program); gl.deleteProgram(program); invalid(error ?? "Invalid AGSL program");
      }
      this.compiled = new ShaderProgram(program, gl);
      for (const [name, u] of this.uniforms) u.location = gl.getUniformLocation(program, name);
    } finally { gl.deleteShader(vertex); if (fragment) gl.deleteShader(fragment); }
  }
  set(name: string, values: ArrayLike<number>, color = false, integer = false): void {
    if (name == null || values == null) throw rt.mkThrowable("java/lang/NullPointerException", "uniform");
    const u = this.uniforms.get(name);
    if (!u || u.values.length !== values.length || u.color !== color || u.format.integer !== integer) invalid("Invalid uniform: " + name);
    let changed = false;
    for (let i = 0; i < values.length; i++) { changed ||= u.values[i] !== values[i]; u.values[i] = values[i]; }
    if (changed) this.captured = null;
  }
  override deferredPattern(): (ctx: Ctx2D) => CanvasPattern {
    const local = this.local?.join(",") ?? "";
    if (!this.captured || this.captured.local !== local) {
      const program = this.compiled;
      if (!program) return invalid("Shader is not initialized");
      const state: ShaderState = { local: this.local ? new DOMMatrixReadOnly(this.local) : null,
        uniforms: [...this.uniforms.values()].map(u => ({ ...u, values: [...u.values] })) };
      this.captured = { local, pattern: ctx => program.pattern(ctx, state) };
    }
    return this.captured.pattern;
  }
  override pattern(ctx: Ctx2D): CanvasPattern { return this.deferredPattern()(ctx); }

}
const methods: NonNullable<NativeSpec["methods"]> = {
  "<init>(Ljava/lang/String;)V": function (this: JRuntimeShader, source: string) { this.init(source); },
  "setFloatUniform(Ljava/lang/String;[F)V": function (this: JRuntimeShader, name: string, values: Float32Array) { this.set(name, values); },
  "setIntUniform(Ljava/lang/String;[I)V": function (this: JRuntimeShader, name: string, values: Int32Array) { this.set(name, values, false, true); },
  "setColorUniform(Ljava/lang/String;I)V": function (this: JRuntimeShader, name: string, color: number) {
    this.set(name, [(color >>> 16 & 255) / 255, (color >>> 8 & 255) / 255, (color & 255) / 255, (color >>> 24) / 255], true);
  },
};
for (const integer of [false, true]) for (let count = 1; count <= 4; count++) {
  methods[`set${integer ? "Int" : "Float"}Uniform(Ljava/lang/String;${(integer ? "I" : "F").repeat(count)})V`] =
    function (this: JRuntimeShader, name: string, ...values: number[]) { this.set(name, values, false, integer); };
}
rt.register({ name: "android/graphics/RuntimeShader", ctor: JRuntimeShader, sup: "android/graphics/Shader", methods });
