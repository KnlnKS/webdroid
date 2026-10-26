// AHardwareBuffer (libnativewindow): a buffer GL renders to and samples through an EGLImage
// (EGL_ANDROID_image_native_buffer), the CPU locks, and SurfaceControl shows. Its pixels live in the
// texture of the GL that bound it, if one has, else in guest memory, or in the decoded frame a producer
// queued to it until a GL binds it; a lock reads the texture back and an unlock after writing uploads
// to it. The guest struct is GraphicBuffer's: a vtable and RefBase pointer, then the
// ANativeWindowBuffer ANGLE reaches by that offset (android_util.cpp).

import { mem } from "./mem.ts";
import { hostLib, defineHost, stp, PTR, type HostFn } from "./host.ts";
import { pixelParam } from "./gles3-pixels.ts";
import { closeFd } from "./fd.ts";

type GL = WebGL2RenderingContext;
const BAD_VALUE = -22, NO_MEMORY = -12, INVALID_OPERATION = -38;
const CPU_READ = 0xf, CPU_WRITE = 0xf0, GPU_SAMPLED = 1 << 8, GPU_COLOR = 1 << 9, PROTECTED = 1 << 14,
  GPU_DATA_BUFFER = 1 << 24, GPU_CUBE_MAP = 1 << 25, GPU_MIPMAP = 1 << 26, FRONT_BUFFER = 1n << 32n;
const BLOB = 0x21, GL_RGB = 0x1907, GL_UNSIGNED_BYTE = 0x1401;
/** n pixels of a format a CPU lock reads, from guest bytes into RGBA ones and back */
interface Codec { unpack(src: Uint8Array, rgba: Uint8ClampedArray, n: number): void; pack(rgba: Uint8Array, n: number): Uint8Array }
/** pixels of `bpp` bytes, the first `channels` of them R, G, B and A in order and the rest an opaque X */
function bytewise(bpp: number, channels: number): Codec {
  if (bpp === 4 && channels === 4) return { unpack: (src, rgba, n) => rgba.set(src.subarray(0, n * 4)), pack: (rgba) => rgba };
  return {
    unpack(src, rgba, n) { for (let i = 0; i < n; i++) { for (let c = 0; c < channels; c++) rgba[i * 4 + c] = src[i * bpp + c]; rgba[i * 4 + 3] = 255; } },
    pack(rgba, n) {
      const out = new Uint8Array(n * bpp);
      for (let i = 0; i < n; i++) { for (let c = 0; c < bpp; c++) out[i * bpp + c] = c < channels ? rgba[i * 4 + c] : 255; }
      return out;
    },
  };
}
const RGB565: Codec = {
  unpack(src, rgba, n) {
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const v = src[i * 2] | src[i * 2 + 1] << 8;
      rgba[o] = (v >> 11) * 255 / 31; rgba[o + 1] = (v >> 5 & 63) * 255 / 63; rgba[o + 2] = (v & 31) * 255 / 31; rgba[o + 3] = 255;
    }
  },
  pack(rgba, n) {
    const out = new Uint8Array(n * 2);
    for (let i = 0, o = 0; i < n; i++, o += 4) { const v = (rgba[o] >> 3) << 11 | (rgba[o + 1] >> 2) << 5 | rgba[o + 2] >> 3; out[i * 2] = v; out[i * 2 + 1] = v >> 8; }
    return out;
  },
};
/** a format's bytes per pixel, the texture storage and upload format and type it has in GL, and the
 *  conversion of a format whose texture a CPU lock reads back as RGBA bytes */
interface Format { bpp: number; internal: number; format: number; type: number; codec?: Codec }
const FORMATS = new Map<number, Format>([
  [1, { bpp: 4, internal: 0x8058, format: 0x1908, type: GL_UNSIGNED_BYTE, codec: bytewise(4, 4) }],  // R8G8B8A8_UNORM: RGBA8
  [2, { bpp: 4, internal: 0x8051, format: GL_RGB, type: GL_UNSIGNED_BYTE, codec: bytewise(4, 3) }],  // R8G8B8X8_UNORM: RGB8, the X byte dropped on upload
  [3, { bpp: 3, internal: 0x8051, format: GL_RGB, type: GL_UNSIGNED_BYTE, codec: bytewise(3, 3) }],  // R8G8B8_UNORM
  [4, { bpp: 2, internal: 0x8d62, format: GL_RGB, type: 0x8363, codec: RGB565 }],                    // R5G6B5_UNORM
  [0x16, { bpp: 8, internal: 0x881a, format: 0x1908, type: 0x140b }],                                // R16G16B16A16_FLOAT: RGBA16F
  [0x2b, { bpp: 4, internal: 0x8059, format: 0x1908, type: 0x8368 }],                                // R10G10B10A2_UNORM: RGB10_A2
  [0x38, { bpp: 1, internal: 0x8229, format: 0x1903, type: GL_UNSIGNED_BYTE, codec: bytewise(1, 1) }], // R8_UNORM
  // IMPLEMENTATION_DEFINED and Y8Cb8Cr8_420: a decoder's frames, which GL samples as RGB as an external texture does
  [0x22, { bpp: 4, internal: 0x8058, format: 0x1908, type: GL_UNSIGNED_BYTE }],
  [0x23, { bpp: 4, internal: 0x8058, format: 0x1908, type: GL_UNSIGNED_BYTE }],
  [BLOB, { bpp: 1, internal: 0, format: 0, type: 0 }],
]);
const codecOf = (format: number): Codec | undefined => FORMATS.get(format)?.codec;

// GraphicBuffer: vtable, RefBase::mRefs, then ANativeWindowBuffer: android_native_base_t (magic, version,
// reserved[4], incRef, decRef), width, height, stride, format, usage_deprecated, layerCount, reserved[1],
// handle, usage (64-bit) and reserved_proc
const anwb = () => 2 * PTR;
function layout(): { fields: number; layers: number; usage: number; size: number } {
  const fields = anwb() + 8 + 6 * PTR, layers = fields + 20 + PTR - 1 & -PTR, usage = layers + 3 * PTR + 7 & -8;
  return { fields, layers, usage, size: usage + 8 + (8 - 8 / PTR) * PTR };
}

let nextId = 1n;
export class HardwareBuffer {
  readonly at: number; readonly width: number; readonly height: number; readonly format: number; readonly usage: bigint;
  readonly id = nextId++;
  refs = 1;
  /** the pixels in guest memory, rows of `width`: current while no GL holds them */
  bits = 0;
  /** the GL whose texture holds the pixels once one bound the buffer, and the framebuffer that reads it */
  gl: GL | null = null; texture: WebGLTexture | null = null; fbo: WebGLFramebuffer | null = null;
  /** the usage the buffer is locked with, 0 while unlocked */
  locked = 0;
  /** a queued frame no GL has taken yet */
  frame: VideoFrame | ImageBitmap | null = null;
  constructor(at: number, width: number, height: number, format: number, usage: bigint) {
    this.at = at; this.width = width; this.height = height; this.format = format; this.usage = usage;
  }
  get bytes(): number { return this.width * this.height * FORMATS.get(this.format)!.bpp; }
  get levels(): number { return this.usage & BigInt(GPU_MIPMAP) ? Math.floor(Math.log2(Math.max(this.width, this.height))) + 1 : 1; }
  get internalFormat(): number { return FORMATS.get(this.format)!.internal; }
}
const buffers = new Map<number, HardwareBuffer>();
/** the textures buffers own: a guest's glDeleteTextures leaves them to the buffer's release */
const owned = new WeakSet<WebGLTexture>();
export const bufferAt = (p: number): HardwareBuffer | undefined => buffers.get(p);
export const ownsTexture = (t: WebGLTexture): boolean => owned.has(t);

/** AHardwareBuffer_isValidDescription's rules, for the formats and usage here: one layer, no protected, front or cube-map buffers */
function supported(width: number, height: number, layers: number, format: number, usage: bigint): boolean {
  const f = FORMATS.get(format), u = Number(usage & 0xffffffffn), gpu = u & (GPU_SAMPLED | GPU_COLOR | GPU_MIPMAP);
  if (!f || width < 1 || height < 1 || layers !== 1 || width * height * f.bpp > 0x7fffffff) return false;
  if (u & (PROTECTED | GPU_CUBE_MAP | GPU_DATA_BUFFER) || usage & FRONT_BUFFER) return false;
  if (format === BLOB ? height !== 1 || gpu : u & CPU_READ && !f.codec) return false;
  return true;
}
export function allocate(width: number, height: number, format: number, usage: bigint): HardwareBuffer | null {
  const L = layout(), at = mem.malloc(L.size);
  if (!at) return null;
  mem.memset(at, 0, L.size);
  const b = new HardwareBuffer(at, width, height, format, usage), base = at + anwb();
  mem.st32(base, 0x5f626672); mem.st32(base + 4, L.size - anwb());       // ANDROID_NATIVE_BUFFER_MAGIC '_bfr', its size
  stp(base + 8 + 4 * PTR, refFns()[0]); stp(base + 8 + 5 * PTR, refFns()[1]);
  mem.st32(at + L.fields, width); mem.st32(at + L.fields + 4, height); mem.st32(at + L.fields + 8, width);
  mem.st32(at + L.fields + 12, format); mem.st32(at + L.fields + 16, Number(usage & 0xffffffffn) | 0);
  stp(at + L.layers, 1); mem.st64(at + L.usage, usage);
  buffers.set(at, b);
  return b;
}
let refs: [number, number] | null = null;
const refFns = () => refs ??= [
  defineHost("ANativeWindowBuffer:incRef", (_c, a) => { const b = buffers.get(a.p() - anwb()); if (b) b.refs++; }),
  defineHost("ANativeWindowBuffer:decRef", (_c, a) => release(buffers.get(a.p() - anwb()))),
];
export function acquire(b: HardwareBuffer): void { b.refs++; }
export function release(b: HardwareBuffer | undefined): void {
  if (!b || --b.refs > 0) return;
  buffers.delete(b.at);
  b.frame?.close();
  if (b.bits) mem.free(b.bits);
  mem.free(b.at);
  const gl = b.gl;
  if (gl && !gl.isContextLost()) { gl.deleteFramebuffer(b.fbo); gl.deleteTexture(b.texture); }
}

// ── between guest memory and the texture
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
function ensureBits(b: HardwareBuffer): boolean {
  if (!b.bits && (b.bits = mem.malloc(b.bytes))) mem.memset(b.bits, 0, b.bytes);
  return b.bits !== 0;
}
/** the guest pixels as the texture's upload format reads them */
function uploadData(b: HardwareBuffer): ArrayBufferView {
  const bytes = mem.bytes(b.bits, b.bytes), f = FORMATS.get(b.format)!;
  if (f.format === GL_RGB && f.type === GL_UNSIGNED_BYTE && f.bpp === 4) {
    const rgb = new Uint8Array(b.width * b.height * 3);
    for (let i = 0, o = 0; o < rgb.length; i += 4) { rgb[o++] = bytes[i]; rgb[o++] = bytes[i + 1]; rgb[o++] = bytes[i + 2]; }
    return rgb;
  }
  const K = f.type === 0x8363 || f.type === 0x140b ? Uint16Array : f.type === 0x8368 ? Uint32Array : Uint8Array;
  return bytes.byteOffset % K.BYTES_PER_ELEMENT ? new K(bytes.slice().buffer) : new K(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength / K.BYTES_PER_ELEMENT);
}
/** the texture given the guest pixels, or the queued frame, which it then holds */
function upload(b: HardwareBuffer): void {
  const gl = b.gl!, f = FORMATS.get(b.format)!, was = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null, frame = b.frame;
  gl.bindTexture(gl.TEXTURE_2D, b.texture);
  // a frame's pixels are premultiplied, as a buffer's are: WebGL is to keep them so
  const premultiplied = !!frame && !gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
  if (premultiplied) gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  defaultStore(gl, 0x88ec, UNPACK_STORE, () => frame ? gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, f.format, f.type, frame)
    : gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, b.width, b.height, f.format, f.type, uploadData(b)));
  if (premultiplied) gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.bindTexture(gl.TEXTURE_2D, was);
  frame?.close(); b.frame = null;
}
/** a producer's frame of the buffer's size queued to it: its pixels from now on */
export function queueFrame(b: HardwareBuffer, frame: VideoFrame | ImageBitmap): void {
  b.frame?.close();
  b.frame = frame;
  if (b.gl && b.texture && !b.gl.isContextLost()) upload(b);
}
/** the framebuffer over the buffer's texture, bound for reading */
function readFrom(b: HardwareBuffer): void {
  const gl = b.gl!;
  if (!b.fbo) {
    b.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, b.fbo);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, b.texture, 0);
  } else gl.bindFramebuffer(gl.READ_FRAMEBUFFER, b.fbo);
}
/** the texture's pixels, as RGBA bytes, rows top first */
function readRgba(b: HardwareBuffer): Uint8Array {
  const gl = b.gl!, read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null, rgba = new Uint8Array(b.width * b.height * 4);
  readFrom(b);
  defaultStore(gl, 0x88eb, PACK_STORE, () => gl.readPixels(0, 0, b.width, b.height, gl.RGBA, gl.UNSIGNED_BYTE, rgba));
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
  return rgba;
}
/** the texture's pixels into guest memory, for a format a CPU lock reads */
function readBack(b: HardwareBuffer): void {
  const codec = codecOf(b.format);
  if (codec) mem.write(b.bits, codec.pack(readRgba(b), b.width * b.height));
}
/** the buffer's texture in `gl`, which from now on holds its pixels: made with the buffer's storage and
 *  contents, and bound to TEXTURE_2D. A buffer another GL held moves, leaving that GL's siblings stale. */
export function bufferTexture(b: HardwareBuffer, gl: GL): WebGLTexture | null {
  if (b.gl === gl && b.texture) { gl.bindTexture(gl.TEXTURE_2D, b.texture); return b.texture; }
  if (b.gl && codecOf(b.format) && ensureBits(b)) readBack(b);
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, b.levels, b.internalFormat, b.width, b.height);
  b.gl = gl; b.texture = texture; b.fbo = null;
  owned.add(texture);
  if (b.bits || b.frame) upload(b);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  return texture;
}

// ── frames for SurfaceControl
let scratch: OffscreenCanvasRenderingContext2D | null = null;
/** the buffer's pixels now, as a frame: blitted from its texture onto the drawing buffer of its GL's canvas,
 *  whose rows run bottom up, or converted from guest memory */
export function bufferFrame(b: HardwareBuffer): ImageBitmap | null {
  const gl = b.gl;
  if (gl && !gl.isContextLost() && !gl.getContextAttributes()?.antialias) {
    const canvas = gl.canvas as OffscreenCanvas;
    if (canvas.width !== b.width || canvas.height !== b.height) { canvas.width = b.width; canvas.height = b.height; }
    const draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), scissor = gl.isEnabled(gl.SCISSOR_TEST);
    readFrom(b);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    if (scissor) gl.disable(gl.SCISSOR_TEST);
    gl.blitFramebuffer(0, 0, b.width, b.height, 0, b.height, b.width, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    if (scissor) gl.enable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
    return canvas.transferToImageBitmap();
  }
  const codec = codecOf(b.format);
  if (!codec || !ensureBits(b)) return null;
  const rgba = new Uint8ClampedArray(b.width * b.height * 4);
  if (gl) rgba.set(readRgba(b));
  else codec.unpack(mem.bytes(b.bits, b.bytes), rgba, b.width * b.height);
  const ctx = scratch ??= new OffscreenCanvas(1, 1).getContext("2d")!;
  if (ctx.canvas.width !== b.width || ctx.canvas.height !== b.height) { ctx.canvas.width = b.width; ctx.canvas.height = b.height; }
  ctx.putImageData(new ImageData(rgba, b.width, b.height), 0, 0);
  return ctx.canvas.transferToImageBitmap();
}

// ── EGLImages of buffers (EGL_ANDROID_image_native_buffer); each holds a reference to its buffer
const images = new Map<number, HardwareBuffer>();
let lastImage = 0;
/** the buffer behind EGL_NATIVE_BUFFER_ANDROID's client buffer (eglGetNativeClientBufferANDROID's answer) */
export const clientBuffer = (p: number): HardwareBuffer | undefined => buffers.get(p - anwb());
export const nativeClientBuffer = (b: HardwareBuffer): number => b.at + anwb();
export function createImage(b: HardwareBuffer): number { acquire(b); images.set(++lastImage, b); return lastImage; }
export const imageBuffer = (h: number): HardwareBuffer | undefined => images.get(h);
export function destroyImage(h: number): boolean {
  const b = images.get(h);
  if (!b) return false;
  images.delete(h); release(b);
  return true;
}

// ── libnativewindow's AHardwareBuffer calls
/** AHardwareBuffer_Desc: width, height, layers, format, usage (64-bit), stride, rfu0, rfu1 */
function describe(b: HardwareBuffer, out: number): void {
  mem.st32(out, b.width); mem.st32(out + 4, b.height); mem.st32(out + 8, 1); mem.st32(out + 12, b.format);
  mem.st64(out + 16, b.usage); mem.st32(out + 24, b.width); mem.st32(out + 28, 0); mem.st64(out + 32, 0n);
}
/** the buffer CPU-locked for `usage`, which must be CPU usage it was allocated with; a fence passed in is waited on and closed */
async function lock(b: HardwareBuffer | undefined, usage: bigint, fence: number): Promise<number> {
  if (fence >= 0) await closeFd(fence);
  const u = Number(usage & 0xffn);
  if (!b || !u || usage & ~0xffn || b.locked) return b?.locked ? INVALID_OPERATION : BAD_VALUE;
  if (u & CPU_READ && !(b.usage & BigInt(CPU_READ)) || u & CPU_WRITE && !(b.usage & BigInt(CPU_WRITE))) return BAD_VALUE;
  if (!ensureBits(b)) return NO_MEMORY;
  if (b.gl && !b.gl.isContextLost()) readBack(b);
  b.locked = u;
  return 0;
}
const B = (p: number) => buffers.get(p);
export function hardwareBufferInit(): void {
  const lib: Record<string, HostFn> = {
    AHardwareBuffer_allocate: (_c, a) => {
      const desc = a.p(), out = a.p();
      if (!desc || !out) return BAD_VALUE;
      const width = mem.ld32(desc), height = mem.ld32(desc + 4), layers = mem.ld32(desc + 8), format = mem.ld32(desc + 12), usage = mem.ld64(desc + 16);
      if (!supported(width, height, layers, format, usage)) return BAD_VALUE;
      const b = allocate(width, height, format, usage);
      if (!b) return NO_MEMORY;
      stp(out, b.at);
      return 0;
    },
    AHardwareBuffer_isSupported: (_c, a) => {
      const desc = a.p();
      return +supported(mem.ld32(desc), mem.ld32(desc + 4), mem.ld32(desc + 8), mem.ld32(desc + 12), mem.ld64(desc + 16));
    },
    AHardwareBuffer_acquire: (_c, a) => { const b = B(a.p()); if (b) acquire(b); },
    AHardwareBuffer_release: (_c, a) => release(B(a.p())),
    AHardwareBuffer_describe: (_c, a) => { const b = B(a.p()), out = a.p(); if (b && out) describe(b, out); },
    AHardwareBuffer_getId: (_c, a) => { const b = B(a.p()), out = a.p(); if (!b || !out) return BAD_VALUE; mem.st64(out, b.id); return 0; },
    // the address returned is the buffer's start whatever the rect, as gralloc maps it
    AHardwareBuffer_lock: (_c, a) => {
      const b = B(a.p()), usage = a.l(), fence = a.i(); a.p(); const out = a.p();
      if (!out) return BAD_VALUE;
      return lock(b, usage, fence).then((r) => { if (!r) stp(out, b!.bits); return r; });
    },
    AHardwareBuffer_lockAndGetInfo: (_c, a) => {
      const b = B(a.p()), usage = a.l(), fence = a.i(); a.p(); const out = a.p(), bpp = a.p(), bps = a.p();
      if (!out) return BAD_VALUE;
      return lock(b, usage, fence).then((r) => {
        if (r) return r;
        const f = FORMATS.get(b!.format)!;
        stp(out, b!.bits);
        if (bpp) mem.st32(bpp, f.bpp);
        if (bps) mem.st32(bps, b!.width * f.bpp);
        return 0;
      });
    },
    // AHardwareBuffer_Planes: planeCount, then each plane's data, pixelStride and rowStride; these formats have one
    AHardwareBuffer_lockPlanes: (_c, a) => {
      const b = B(a.p()), usage = a.l(), fence = a.i(); a.p(); const out = a.p();
      if (!out) return BAD_VALUE;
      return lock(b, usage, fence).then((r) => {
        if (r) return r;
        const bpp = FORMATS.get(b!.format)!.bpp, plane = out + PTR;
        mem.st32(out, 1);
        stp(plane, b!.bits); mem.st32(plane + PTR, bpp); mem.st32(plane + PTR + 4, b!.width * bpp);
        return 0;
      });
    },
    // the CPU's writes reach the texture before unlock returns, so no fence follows
    AHardwareBuffer_unlock: (_c, a) => {
      const b = B(a.p()), fence = a.p();
      if (!b) return BAD_VALUE;
      if (!b.locked) return INVALID_OPERATION;
      if (b.locked & CPU_WRITE && b.gl && !b.gl.isContextLost()) upload(b);
      b.locked = 0;
      if (fence) mem.st32(fence, -1);
      return 0;
    },
  };
  hostLib("libnativewindow.so", lib, { closed: true });
}
