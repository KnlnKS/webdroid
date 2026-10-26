// AHardwareBuffer (libnativewindow): a buffer GL renders to and samples through an EGLImage
// (EGL_ANDROID_image_native_buffer), the CPU locks, and SurfaceControl shows. Its pixels live in the
// texture of the GL that bound it, if one has, else in guest memory, or in the decoded frame a producer
// queued to it until a GL binds it; a lock reads the texture back and an unlock after writing uploads
// to it. The guest struct is GraphicBuffer's: a vtable and RefBase pointer, then the
// ANativeWindowBuffer ANGLE reaches by that offset (android_util.cpp).

import { mem } from "./mem.ts";
import { hostLib, defineHost, stp, PTR, type HostFn, type ArgReader } from "./host.ts";
import { struct } from "./struct.ts";
import { textureRec } from "./gles3-state.ts";
import { pixelArray, pixelParam, view } from "./gles3-pixels.ts";
import { CODECS, type Codec } from "./pixel-codecs.ts";
import { closeFd } from "./fd.ts";
import { after } from "../jvm/natives/jentry.ts";

type GL = WebGL2RenderingContext;
const BAD_VALUE = -22, NO_MEMORY = -12, INVALID_OPERATION = -38;
const CPU_READ = 0xf, CPU_WRITE = 0xf0, GPU_SAMPLED = 1 << 8, GPU_COLOR = 1 << 9, PROTECTED = 1 << 14,
  GPU_DATA_BUFFER = 1 << 24, GPU_CUBE_MAP = 1 << 25, GPU_MIPMAP = 1 << 26, FRONT_BUFFER = 1n << 32n;
const BLOB = 0x21, GL_RGB = 0x1907, GL_UNSIGNED_BYTE = 0x1401;
/** a format's bytes per pixel, the texture storage and upload format and type it has in GL, and its VkFormat,
 *  or `external` for a Vulkan external format */
interface Format { bpp: number; internal: number; format: number; type: number; vk?: number; external?: true }
const FORMATS = new Map<number, Format>([
  [1, { bpp: 4, internal: 0x8058, format: 0x1908, type: GL_UNSIGNED_BYTE, vk: 37 }],   // R8G8B8A8_UNORM: RGBA8
  [2, { bpp: 4, internal: 0x8051, format: GL_RGB, type: GL_UNSIGNED_BYTE, vk: 37 }],   // R8G8B8X8_UNORM: RGB8, the X byte dropped on upload
  [3, { bpp: 3, internal: 0x8051, format: GL_RGB, type: GL_UNSIGNED_BYTE }],   // R8G8B8_UNORM
  [4, { bpp: 2, internal: 0x8d62, format: GL_RGB, type: 0x8363 }],             // R5G6B5_UNORM
  [0x16, { bpp: 8, internal: 0x881a, format: 0x1908, type: 0x140b, vk: 97 }],          // R16G16B16A16_FLOAT: RGBA16F
  [0x2b, { bpp: 4, internal: 0x8059, format: 0x1908, type: 0x8368, vk: 64 }],          // R10G10B10A2_UNORM: RGB10_A2
  [0x38, { bpp: 1, internal: 0x8229, format: 0x1903, type: GL_UNSIGNED_BYTE }], // R8_UNORM
  // IMPLEMENTATION_DEFINED and Y8Cb8Cr8_420: a decoder's frames, which GL samples as RGB as an external texture does
  [0x22, { bpp: 4, internal: 0x8058, format: 0x1908, type: GL_UNSIGNED_BYTE, external: true }],
  [0x23, { bpp: 4, internal: 0x8058, format: 0x1908, type: GL_UNSIGNED_BYTE, external: true }],
  [BLOB, { bpp: 1, internal: 0, format: 0, type: 0 }],
]);
/** the conversion of a format whose texture a CPU lock reads back as RGBA bytes */
const codecOf = (format: number): Codec | undefined => CODECS.get(format);
/** the VkFormat of AHardwareBuffer format `format`, or whether Vulkan takes it as an external format */
export const vulkanFormat = (format: number): Pick<Format, "vk" | "external"> | undefined => FORMATS.get(format);

// GraphicBuffer: a vtable and RefBase::mRefs, then ANativeWindowBuffer (window.h) and its reserved_proc
const GraphicBuffer = struct(`vtable:ptr refs:ptr magic:u32 version:u32 reserved:ptr[4] incRef:ptr decRef:ptr
  width:i32 height:i32 stride:i32 format:i32 usageDeprecated:u32 layerCount:size reserved1:ptr handle:ptr usage:u64`);
const graphicBufferSize = () => GraphicBuffer.size() + (8 - 8 / PTR) * PTR;
const anwb = () => GraphicBuffer.off("magic");
const Desc = struct("width:u32 height:u32 layers:u32 format:u32 usage:u64 stride:u32 rfu0:u32 rfu1:u64");

type Frame = VideoFrame | ImageBitmap;
let scratch: OffscreenCanvasRenderingContext2D | null = null;
/** a canvas of w x h for converting pixels into a frame */
function scratchCanvas(w: number, h: number): OffscreenCanvasRenderingContext2D {
  const ctx = scratch ??= new OffscreenCanvas(1, 1).getContext("2d")!;
  if (ctx.canvas.width !== w || ctx.canvas.height !== h) { ctx.canvas.width = w; ctx.canvas.height = h; }
  return ctx;
}

let nextId = 1n;
export class HardwareBuffer {
  readonly at: number; readonly width: number; readonly height: number; readonly format: number; readonly usage: bigint;
  readonly id = nextId++;
  refs = 1;
  /** the pixels in guest memory, rows of `width`: current while no GL holds them */
  private bits = 0;
  /** the GL whose texture holds the pixels once one bound the buffer, and the framebuffer that reads it */
  private gl: GL | null = null;
  private tex: WebGLTexture | null = null;
  private fbo: WebGLFramebuffer | null = null;
  /** the usage the buffer is locked with, 0 while unlocked */
  private locked = 0;
  /** a producer's frame no GL has taken yet */
  private queued: Frame | null = null;
  constructor(at: number, width: number, height: number, format: number, usage: bigint) {
    this.at = at; this.width = width; this.height = height; this.format = format; this.usage = usage;
  }
  get bytes(): number { return this.width * this.height * FORMATS.get(this.format)!.bpp; }
  get levels(): number { return this.usage & BigInt(GPU_MIPMAP) ? Math.floor(Math.log2(Math.max(this.width, this.height))) + 1 : 1; }
  get internalFormat(): number { return FORMATS.get(this.format)!.internal; }
  /** the pixels' guest address while CPU-locked, else 0 */
  get mapped(): number { return this.locked ? this.bits : 0; }
  /** vulkan/submit.ts reads a queued frame here until it takes snapshot(), which never hands one out */
  get frame(): null { return null; }
  /** the GL holding the pixels, while its context lives */
  private get liveGl(): GL | null { const gl = this.gl; return gl && !gl.isContextLost() ? gl : null; }
  private ensureBits(): boolean {
    if (!this.bits && (this.bits = mem.malloc(this.bytes))) mem.memset(this.bits, 0, this.bytes);
    return this.bits !== 0;
  }

  /** a producer's frame of the buffer's size: its pixels from now on */
  queueFrame(frame: Frame): void {
    this.queued?.close();
    this.queued = frame;
    if (this.tex && this.liveGl) this.upload();
  }
  /** lets go of a queued frame no GL took, as a decoder reuses its frames once closed */
  dropFrame(): void { this.queued?.close(); this.queued = null; }
  /** the pixels now, as a frame its caller closes: a queued frame's copy, a blit of the texture onto the drawing buffer
   *  of its GL's canvas, whose rows run bottom up, or the guest pixels converted */
  snapshot(): Frame | null {
    const queued = this.queued, gl = this.liveGl;
    if (queued) {
      if (typeof VideoFrame !== "undefined" && queued instanceof VideoFrame) return queued.clone();
      const ctx = scratchCanvas(this.width, this.height);
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.drawImage(queued, 0, 0);
      return ctx.canvas.transferToImageBitmap();
    }
    if (gl && !gl.getContextAttributes()?.antialias) {
      const canvas = gl.canvas as OffscreenCanvas;
      if (canvas.width !== this.width || canvas.height !== this.height) { canvas.width = this.width; canvas.height = this.height; }
      const draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), scissor = gl.isEnabled(gl.SCISSOR_TEST);
      this.readFrom(gl);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      if (scissor) gl.disable(gl.SCISSOR_TEST);
      gl.blitFramebuffer(0, 0, this.width, this.height, 0, this.height, this.width, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      if (scissor) gl.enable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
      return canvas.transferToImageBitmap();
    }
    const codec = codecOf(this.format);
    if (!codec || !this.ensureBits()) return null;
    const rgba = new Uint8ClampedArray(this.width * this.height * 4);
    if (gl) rgba.set(this.readRgba(gl));
    else codec.unpack(mem.bytes(this.bits, this.bytes), rgba, this.width * this.height);
    const ctx = scratchCanvas(this.width, this.height);
    ctx.putImageData(new ImageData(rgba, this.width, this.height), 0, 0);
    return ctx.canvas.transferToImageBitmap();
  }
  /** the buffer's texture in `gl`, which from now on holds its pixels: made with the buffer's storage and
   *  contents, and bound to TEXTURE_2D. A buffer another GL held moves, leaving that GL's siblings stale. */
  texture(gl: GL): WebGLTexture | null {
    if (this.gl === gl && this.tex) { gl.bindTexture(gl.TEXTURE_2D, this.tex); return this.tex; }
    const held = this.liveGl;
    if (held && codecOf(this.format) && this.ensureBits()) this.readBack(held);
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, this.levels, this.internalFormat, this.width, this.height);
    this.gl = gl; this.tex = texture; this.fbo = null;
    textureRec(texture).owner = this;
    if (this.bits || this.queued) this.upload();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    return texture;
  }
  /** CPU-locked for `usage`, which must be CPU usage it was allocated with */
  lock(usage: bigint): number {
    const u = Number(usage & 0xffn);
    if (this.locked) return INVALID_OPERATION;
    if (!u || usage & ~0xffn) return BAD_VALUE;
    if (u & CPU_READ && !(this.usage & BigInt(CPU_READ)) || u & CPU_WRITE && !(this.usage & BigInt(CPU_WRITE))) return BAD_VALUE;
    if (!this.ensureBits()) return NO_MEMORY;
    const gl = this.liveGl;
    if (gl) this.readBack(gl);
    this.locked = u;
    return 0;
  }
  /** the CPU's writes reach the texture before unlock returns, so no fence follows */
  unlock(): number {
    if (!this.locked) return INVALID_OPERATION;
    if (this.locked & CPU_WRITE && this.liveGl) this.upload();
    this.locked = 0;
    return 0;
  }
  /** the last reference gone */
  free(): void {
    buffers.delete(this.at);
    this.queued?.close();
    if (this.bits) mem.free(this.bits);
    mem.free(this.at);
    const gl = this.liveGl;
    if (gl) { gl.deleteFramebuffer(this.fbo); gl.deleteTexture(this.tex); }
  }

  /** the guest pixels as the texture's upload format reads them */
  private uploadData(): ArrayBufferView {
    const f = FORMATS.get(this.format)!;
    if (f.format === GL_RGB && f.type === GL_UNSIGNED_BYTE && f.bpp === 4) {
      const bytes = mem.bytes(this.bits, this.bytes), rgb = new Uint8Array(this.width * this.height * 3);
      for (let i = 0, o = 0; o < rgb.length; i += 4) { rgb[o++] = bytes[i]; rgb[o++] = bytes[i + 1]; rgb[o++] = bytes[i + 2]; }
      return rgb;
    }
    const K = pixelArray(f.type);
    return view(K, this.bits, this.bytes / K.BYTES_PER_ELEMENT);
  }
  /** the texture given the guest pixels, or the queued frame, which it then holds */
  private upload(): void {
    const gl = this.gl!, f = FORMATS.get(this.format)!, was = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null, frame = this.queued;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    // a frame's pixels are premultiplied, as a buffer's are: WebGL is to keep them so
    const premultiplied = !!frame && !gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
    if (premultiplied) gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    defaultStore(gl, 0x88ec, UNPACK_STORE, () => frame ? gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, f.format, f.type, frame)
      : gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, f.format, f.type, this.uploadData()));
    if (premultiplied) gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, was);
    this.dropFrame();
  }
  /** the framebuffer over the buffer's texture, bound for reading */
  private readFrom(gl: GL): void {
    if (!this.fbo) {
      this.fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    } else gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
  }
  /** the texture's pixels, as RGBA bytes, rows top first */
  private readRgba(gl: GL): Uint8Array {
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null, rgba = new Uint8Array(this.width * this.height * 4);
    this.readFrom(gl);
    defaultStore(gl, 0x88eb, PACK_STORE, () => gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, rgba));
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
    return rgba;
  }
  /** the texture's pixels into guest memory, for a format a CPU lock reads */
  private readBack(gl: GL): void {
    const codec = codecOf(this.format);
    if (codec) mem.write(this.bits, codec.pack(this.readRgba(gl), this.width * this.height));
  }
}
const buffers = new Map<number, HardwareBuffer>();
export const bufferAt = (p: number): HardwareBuffer | undefined => buffers.get(p);
/** the buffer behind EGL_NATIVE_BUFFER_ANDROID's client buffer (eglGetNativeClientBufferANDROID's answer) */
export const clientBuffer = (p: number): HardwareBuffer | undefined => buffers.get(p - anwb());
export const nativeClientBuffer = (b: HardwareBuffer): number => b.at + anwb();

/** AHardwareBuffer_isValidDescription's rules, for the formats and usage here: one layer, no protected, front or cube-map buffers */
function supported(width: number, height: number, layers: number, format: number, usage: bigint): boolean {
  const f = FORMATS.get(format), u = Number(usage & 0xffffffffn), gpu = u & (GPU_SAMPLED | GPU_COLOR | GPU_MIPMAP);
  if (!f || width < 1 || height < 1 || layers !== 1 || width * height * f.bpp > 0x7fffffff) return false;
  if (u & (PROTECTED | GPU_CUBE_MAP | GPU_DATA_BUFFER) || usage & FRONT_BUFFER) return false;
  if (format === BLOB ? height !== 1 || gpu : u & CPU_READ && !codecOf(format)) return false;
  return true;
}
export function allocate(width: number, height: number, format: number, usage: bigint): HardwareBuffer | null {
  const size = graphicBufferSize(), at = mem.malloc(size);
  if (!at) return null;
  mem.memset(at, 0, size);
  const b = new HardwareBuffer(at, width, height, format, usage), [incRef, decRef] = refFns();
  // ANDROID_NATIVE_BUFFER_MAGIC '_bfr', and the size from the ANativeWindowBuffer on
  GraphicBuffer.write(at, { magic: 0x5f626672, version: size - anwb(), incRef, decRef, width, height, stride: width, format,
    usageDeprecated: Number(usage & 0xffffffffn), layerCount: 1 });
  mem.st64(at + GraphicBuffer.off("usage"), usage);
  buffers.set(at, b);
  return b;
}
let refs: [number, number] | null = null;
const refFns = () => refs ??= [
  defineHost("ANativeWindowBuffer:incRef", (_c, a) => { const b = clientBuffer(a.p()); if (b) b.refs++; }),
  defineHost("ANativeWindowBuffer:decRef", (_c, a) => release(clientBuffer(a.p()))),
];
export function acquire(b: HardwareBuffer): void { b.refs++; }
export function release(b: HardwareBuffer | undefined): void { if (b && --b.refs === 0) b.free(); }
// vulkan/submit.ts's calls until it takes them as methods
export const queueFrame = (b: HardwareBuffer, frame: Frame): void => b.queueFrame(frame);
export const bufferFrame = (b: HardwareBuffer): Frame | null => b.snapshot();

/** runs `fn` with the pixel-store parameters at their defaults and no buffer bound to `target`, as a host upload or readback reads them */
function defaultStore<T>(gl: GL, target: number, names: number[], fn: () => T): T {
  const bound = gl.getParameter(target === 0x88ec ? 0x88ef : 0x88ed) as WebGLBuffer | null;  // PIXEL_UNPACK/PACK_BUFFER_BINDING
  const was = names.map((n) => pixelParam(gl, n)), want = names.map((n) => (n === 0x0cf5 || n === 0x0d05 ? 1 : 0));
  if (bound) gl.bindBuffer(target, null);
  names.forEach((n, i) => { if (was[i] !== want[i]) gl.pixelStorei(n, want[i]); });
  try { return fn(); } finally {
    names.forEach((n, i) => { if (was[i] !== want[i]) gl.pixelStorei(n, was[i]); });
    if (bound) gl.bindBuffer(target, bound);
  }
}
const UNPACK_STORE = [0x0cf5, 0x0cf2, 0x0cf3, 0x0cf4], PACK_STORE = [0x0d05, 0x0d02, 0x0d03, 0x0d04];

// ── libnativewindow's AHardwareBuffer calls
/** a lock call: the buffer, usage, fence and rect, then pointers `out` reads now and fills once the lock is taken (the
 *  address is the buffer's start whatever the rect, as gralloc maps it); the first is required */
const lockCall = (out: (a: ArgReader) => ((b: HardwareBuffer) => void) | null): HostFn => (_c, a) => {
  const b = bufferAt(a.p()), usage = a.l(), fence = a.i(); a.p();
  const fill = out(a);
  if (!fill) return BAD_VALUE;
  // a fence passed in is waited on and closed
  return after(fence >= 0 ? closeFd(fence) : 0, () => {
    const r = b ? b.lock(usage) : BAD_VALUE;
    if (!r) fill(b!);
    return r;
  });
};
export function hardwareBufferInit(): void {
  const lib: Record<string, HostFn> = {
    AHardwareBuffer_allocate: (_c, a) => {
      const desc = a.p(), out = a.p();
      if (!desc || !out) return BAD_VALUE;
      const d = Desc.read(desc), usage = mem.ld64(desc + Desc.off("usage"));
      if (!supported(d.width, d.height, d.layers, d.format, usage)) return BAD_VALUE;
      const b = allocate(d.width, d.height, d.format, usage);
      if (!b) return NO_MEMORY;
      stp(out, b.at);
      return 0;
    },
    AHardwareBuffer_isSupported: (_c, a) => { const desc = a.p(), d = Desc.read(desc); return +supported(d.width, d.height, d.layers, d.format, mem.ld64(desc + Desc.off("usage"))); },
    AHardwareBuffer_acquire: (_c, a) => { const b = bufferAt(a.p()); if (b) acquire(b); },
    AHardwareBuffer_release: (_c, a) => release(bufferAt(a.p())),
    AHardwareBuffer_describe: (_c, a) => {
      const b = bufferAt(a.p()), out = a.p();
      if (!b || !out) return;
      Desc.write(out, { width: b.width, height: b.height, layers: 1, format: b.format, stride: b.width, rfu0: 0, rfu1: 0 });
      mem.st64(out + Desc.off("usage"), b.usage);
    },
    AHardwareBuffer_getId: (_c, a) => { const b = bufferAt(a.p()), out = a.p(); if (!b || !out) return BAD_VALUE; mem.st64(out, b.id); return 0; },
    AHardwareBuffer_lock: lockCall((a) => { const out = a.p(); return out ? (b) => stp(out, b.mapped) : null; }),
    AHardwareBuffer_lockAndGetInfo: lockCall((a) => {
      const out = a.p(), bpp = a.p(), bps = a.p();
      return out ? (b) => {
        const f = FORMATS.get(b.format)!;
        stp(out, b.mapped);
        if (bpp) mem.st32(bpp, f.bpp);
        if (bps) mem.st32(bps, b.width * f.bpp);
      } : null;
    }),
    // AHardwareBuffer_Planes: planeCount, then each plane's data, pixelStride and rowStride; these formats have one
    AHardwareBuffer_lockPlanes: lockCall((a) => {
      const out = a.p();
      return out ? (b) => {
        const bpp = FORMATS.get(b.format)!.bpp, plane = out + PTR;
        mem.st32(out, 1);
        stp(plane, b.mapped); mem.st32(plane + PTR, bpp); mem.st32(plane + PTR + 4, b.width * bpp);
      } : null;
    }),
    AHardwareBuffer_unlock: (_c, a) => {
      const b = bufferAt(a.p()), fence = a.p();
      if (!b) return BAD_VALUE;
      const r = b.unlock();
      if (!r && fence) mem.st32(fence, -1);
      return r;
    },
  };
  hostLib("libnativewindow.so", lib, { closed: true });
}
