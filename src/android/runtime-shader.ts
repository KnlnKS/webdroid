import { rt, type NativeSpec } from "../jvm/runtime";
import { JShader } from "./graphics";

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Uniform = { location: WebGLUniformLocation | null; type: string; size: number; color: boolean; values: number[] };
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
export class JRuntimeShader extends JShader {
  private compiled: { program: WebGLProgram } | null = null;
  private uniforms = new Map<string, Uniform>();
  private revision = 0;
  private cached = "";
  private raster: OffscreenCanvas | null = null;
  private patternValue: CanvasPattern | null = null;
  private transform: WebGLUniformLocation | null = null;
  private height: WebGLUniformLocation | null = null;
  init(source: string): void {
    if (source == null) throw rt.mkThrowable("java/lang/NullPointerException", "shader");
    const gl = graphics();
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
      .replace(/\b(?:half|float)([234])x([234])\b/g, "mat$1x$2")
      .replace(/\b(?:half|float)([234])\b/g, "vec$1")
      .replace(/\bint([234])\b/g, "ivec$1").replace(/\bhalf\b/g, "float");
    for (const match of code.matchAll(/(layout\s*\(\s*color\s*\)\s*)?uniform\s+(\w+)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*;/g)) {
      const [, color, type, name, array] = match;
      const count = type === "float" || type === "int" ? 1 : /^[ib]?vec[234]$/.test(type) ? Number(type.at(-1)) : /^mat[234]$/.test(type) ? Number(type.at(-1)) ** 2 : 0;
      if (!count) invalid("Unsupported AGSL uniform type: " + type);
      this.uniforms.set(name, { location: null, type, size: count * Number(array ?? 1), color: !!color, values: new Array(count * Number(array ?? 1)).fill(0) });
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
      this.compiled = { program }; programs.register(this.compiled, program);
      for (const [name, u] of this.uniforms) u.location = gl.getUniformLocation(program, name);
      this.transform = gl.getUniformLocation(program, "wd_coords"); this.height = gl.getUniformLocation(program, "wd_height");
    } finally { gl.deleteShader(vertex); if (fragment) gl.deleteShader(fragment); }
  }
  set(name: string, values: ArrayLike<number>, color = false, integer = false): void {
    if (name == null || values == null) throw rt.mkThrowable("java/lang/NullPointerException", "uniform");
    const u = this.uniforms.get(name);
    if (!u || u.size !== values.length || u.color !== color || /^(?:int|ivec)/.test(u.type) !== integer) invalid("Invalid uniform: " + name);
    let changed = false;
    for (let i = 0; i < values.length; i++) { changed ||= u.values[i] !== values[i]; u.values[i] = values[i]; }
    if (changed) this.revision++;
  }
  override deferredPattern(): (ctx: Context) => CanvasPattern {
    const snapshot = new JRuntimeShader();
    snapshot.compiled = this.compiled;
    snapshot.transform = this.transform; snapshot.height = this.height;
    snapshot.local = this.local ? [...this.local] : null;
    snapshot.uniforms = new Map([...this.uniforms].map(([name, u]) => [name, { ...u, values: [...u.values] }]));
    return ctx => snapshot.pattern(ctx);
  }
  override pattern(ctx: Context): CanvasPattern {
    const gl = graphics(), width = ctx.canvas.width, height = ctx.canvas.height;
    const canvasMatrix = ctx.getTransform();
    const local = this.local ? canvasMatrix.multiply(new DOMMatrix(this.local)) : canvasMatrix;
    const inverse = local.inverse();
    const key = `${width},${height},${inverse.a},${inverse.b},${inverse.c},${inverse.d},${inverse.e},${inverse.f},${this.revision}`;
    if (this.cached !== key || !this.patternValue) {
      const canvas = surface!;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      gl.viewport(0, 0, width, height); gl.useProgram(this.compiled!.program);
      gl.uniformMatrix3fv(this.transform, false, [inverse.a, inverse.b, 0, inverse.c, inverse.d, 0, inverse.e, inverse.f, 1]);
      gl.uniform1f(this.height, height);
      for (const u of this.uniforms.values()) {
        if (u.type === "float") gl.uniform1fv(u.location, u.values);
        else if (u.type === "vec2") gl.uniform2fv(u.location, u.values);
        else if (u.type === "vec3") gl.uniform3fv(u.location, u.values);
        else if (u.type === "vec4") gl.uniform4fv(u.location, u.values);
        else if (u.type === "int") gl.uniform1iv(u.location, u.values);
        else if (u.type === "ivec2") gl.uniform2iv(u.location, u.values);
        else if (u.type === "ivec3") gl.uniform3iv(u.location, u.values);
        else if (u.type === "ivec4") gl.uniform4iv(u.location, u.values);
        else if (u.type === "mat2") gl.uniformMatrix2fv(u.location, false, u.values);
        else if (u.type === "mat3") gl.uniformMatrix3fv(u.location, false, u.values);
        else if (u.type === "mat4") gl.uniformMatrix4fv(u.location, false, u.values);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const raster = this.raster ??= new OffscreenCanvas(width, height);
      if (raster.width !== width) raster.width = width;
      if (raster.height !== height) raster.height = height;
      const target = raster.getContext("2d")!; target.globalCompositeOperation = "copy"; target.drawImage(canvas, 0, 0);
      this.patternValue = ctx.createPattern(raster, "no-repeat"); this.cached = key;
    }
    this.patternValue!.setTransform(canvasMatrix.inverse());
    return this.patternValue!;
  }
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
