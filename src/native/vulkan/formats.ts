// VkFormats as the host's WebGPU formats: which VkFormat each GPUTextureFormat and GPUVertexFormat is,
// and the Vulkan format features that follow from WebGPU's capability tables and the adapter's features.

import { toHalf } from "../../android/bitmap.ts";

/** VkFormatFeatureFlagBits */
export const F = {
  SAMPLED: 0x1, STORAGE: 0x2, STORAGE_ATOMIC: 0x4, UNIFORM_TEXEL: 0x8, STORAGE_TEXEL: 0x10, VERTEX: 0x40, COLOR: 0x80, BLEND: 0x100, DEPTH: 0x200,
  BLIT_SRC: 0x400, BLIT_DST: 0x800, LINEAR: 0x1000, TRANSFER_SRC: 0x4000, TRANSFER_DST: 0x8000,
} as const;

export interface TextureFormat {
  gpu: GPUTextureFormat;
  /** bytes per texel block, and the block's width and height */
  bytes: number; bw: number; bh: number;
  depth: boolean; stencil: boolean;
  /** the WebGPU feature the format needs, if any */
  needs?: GPUFeatureName;
}
// capabilities, as WebGPU's table gives them: f filterable, r renderable, b blendable, m multisample,
// s storage, 1 renderable/blendable/multisample/storage with texture-formats-tier1, a 32-bit atomics in storage
const COLOR: [number, GPUTextureFormat, number, string][] = [
  [9, "r8unorm", 1, "frbm1"], [10, "r8snorm", 1, "f1"], [13, "r8uint", 1, "rm1"], [14, "r8sint", 1, "rm1"],
  [16, "rg8unorm", 2, "frbm1"], [17, "rg8snorm", 2, "f1"], [20, "rg8uint", 2, "rm1"], [21, "rg8sint", 2, "rm1"],
  [37, "rgba8unorm", 4, "frbms"], [38, "rgba8snorm", 4, "fs1"], [41, "rgba8uint", 4, "rms"], [42, "rgba8sint", 4, "rms"],
  [43, "rgba8unorm-srgb", 4, "frbm"], [44, "bgra8unorm", 4, "frbm"], [50, "bgra8unorm-srgb", 4, "frbm"],
  [64, "rgb10a2unorm", 4, "frbm1"], [68, "rgb10a2uint", 4, "rm1"],
  [70, "r16unorm", 2, "f1"], [71, "r16snorm", 2, "f1"], [74, "r16uint", 2, "rm1"], [75, "r16sint", 2, "rm1"], [76, "r16float", 2, "frbm1"],
  [77, "rg16unorm", 4, "f1"], [78, "rg16snorm", 4, "f1"], [81, "rg16uint", 4, "rm1"], [82, "rg16sint", 4, "rm1"], [83, "rg16float", 4, "frbm1"],
  [91, "rgba16unorm", 8, "f1"], [92, "rgba16snorm", 8, "f1"], [95, "rgba16uint", 8, "rms"], [96, "rgba16sint", 8, "rms"], [97, "rgba16float", 8, "frbms"],
  [98, "r32uint", 4, "rsa"], [99, "r32sint", 4, "rsa"], [100, "r32float", 4, "rms"],
  [101, "rg32uint", 8, "rs"], [102, "rg32sint", 8, "rs"], [103, "rg32float", 8, "rs"],
  [107, "rgba32uint", 16, "rs"], [108, "rgba32sint", 16, "rs"], [109, "rgba32float", 16, "rs"],
  [122, "rg11b10ufloat", 4, "f1"], [123, "rgb9e5ufloat", 4, "f"],
];
const DEPTH: [number, GPUTextureFormat, number, boolean, boolean, GPUFeatureName?][] = [
  [124, "depth16unorm", 2, true, false], [125, "depth24plus", 4, true, false], [126, "depth32float", 4, true, false],
  [127, "stencil8", 1, false, true], [129, "depth24plus-stencil8", 4, true, true], [130, "depth32float-stencil8", 5, true, true, "depth32float-stencil8"],
];
/** compressed families: first VkFormat, then each format's WebGPU name, block size and bytes */
const BC: [number, GPUTextureFormat, number][] = [
  [133, "bc1-rgba-unorm", 8], [134, "bc1-rgba-unorm-srgb", 8], [135, "bc2-rgba-unorm", 16], [136, "bc2-rgba-unorm-srgb", 16],
  [137, "bc3-rgba-unorm", 16], [138, "bc3-rgba-unorm-srgb", 16], [139, "bc4-r-unorm", 8], [140, "bc4-r-snorm", 8],
  [141, "bc5-rg-unorm", 16], [142, "bc5-rg-snorm", 16], [143, "bc6h-rgb-ufloat", 16], [144, "bc6h-rgb-float", 16],
  [145, "bc7-rgba-unorm", 16], [146, "bc7-rgba-unorm-srgb", 16],
];
const ETC2: [number, GPUTextureFormat, number][] = [
  [147, "etc2-rgb8unorm", 8], [148, "etc2-rgb8unorm-srgb", 8], [149, "etc2-rgb8a1unorm", 8], [150, "etc2-rgb8a1unorm-srgb", 8],
  [151, "etc2-rgba8unorm", 16], [152, "etc2-rgba8unorm-srgb", 16], [153, "eac-r11unorm", 8], [154, "eac-r11snorm", 8],
  [155, "eac-rg11unorm", 16], [156, "eac-rg11snorm", 16],
];
const ASTC = ["4x4", "5x4", "5x5", "6x5", "6x6", "8x5", "8x6", "8x8", "10x5", "10x6", "10x8", "10x10", "12x10", "12x12"];

const textures = new Map<number, TextureFormat & { caps: string }>();
for (const [vk, gpu, bytes, caps] of COLOR) textures.set(vk, { gpu, bytes, bw: 1, bh: 1, depth: false, stencil: false, caps });
for (const [vk, gpu, bytes, depth, stencil, needs] of DEPTH) textures.set(vk, { gpu, bytes, bw: 1, bh: 1, depth, stencil, needs, caps: "rm" });
for (const [vk, gpu, bytes] of BC) textures.set(vk, { gpu, bytes, bw: 4, bh: 4, depth: false, stencil: false, needs: "texture-compression-bc", caps: "f" });
for (const [vk, gpu, bytes] of ETC2) textures.set(vk, { gpu, bytes, bw: 4, bh: 4, depth: false, stencil: false, needs: "texture-compression-etc2", caps: "f" });
ASTC.forEach((dims, i) => {
  const [bw, bh] = dims.split("x").map(Number);
  for (const srgb of [0, 1]) textures.set(157 + 2 * i + srgb, { gpu: `astc-${dims}-unorm${srgb ? "-srgb" : ""}` as GPUTextureFormat, bytes: 16, bw, bh, depth: false, stencil: false, needs: "texture-compression-astc", caps: "f" });
});
const byGpu = new Map([...textures].map(([vk, f]) => [f.gpu, vk]));

export const textureFormat = (vk: number): TextureFormat | undefined => textures.get(vk);
/** what a compressed format's texels decode to without loss: 8-bit unorm channels, else half floats */
export const decodedFormat = (f: TextureFormat): GPUTextureFormat => f.gpu.endsWith("-srgb") ? "rgba8unorm-srgb" : /^(bc[456]|eac)/.test(f.gpu) ? "rgba16float" : "rgba8unorm";

const srgb = (c: number) => c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
/** RGB9E5 as EXT_texture_shared_exponent packs it */
function rgb9e5([r, g, b]: number[]): number {
  const max = 511 / 512 * 2 ** 16, [cr, cg, cb] = [r, g, b].map((c) => clamp(c || 0, 0, max)), top = Math.max(cr, cg, cb);
  let e = Math.max(-16, Math.floor(Math.log2(top))) + 16;
  if (Math.floor(top / 2 ** (e - 24) + 0.5) === 512) e++;
  const [mr, mg, mb] = [cr, cg, cb].map((c) => Math.floor(c / 2 ** (e - 24) + 0.5));
  return (mr | mg << 9 | mb << 18 | e << 27) >>> 0;
}
/** a colour format's texel of the colour `c` (channels as clearValue reads them), as a clear writes it */
export function texel(f: TextureFormat, c: GPUColorDict): Uint8Array {
  const rgba = [c.r, c.g, c.b, c.a], out = new DataView(new ArrayBuffer(f.bytes));
  const half = (x: number) => toHalf(Math.max(0, x));
  switch (f.gpu) {
    case "rgb10a2unorm": case "rgb10a2uint": {
      const [r, g, b, a] = f.gpu === "rgb10a2uint" ? rgba : rgba.map((x, i) => Math.round(clamp(x, 0, 1) * (i < 3 ? 1023 : 3)));
      out.setUint32(0, ((r & 1023) | (g & 1023) << 10 | (b & 1023) << 20 | (a & 3) << 30) >>> 0, true); break;
    }
    case "rg11b10ufloat": out.setUint32(0, ((half(c.r) >> 4 & 0x7ff) | (half(c.g) >> 4 & 0x7ff) << 11 | (half(c.b) >> 5 & 0x3ff) << 22) >>> 0, true); break;
    case "rgb9e5ufloat": out.setUint32(0, rgb9e5(rgba), true); break;
    default: {
      const [, order, size, kind, s] = /^(r|rg|rgba|bgra)(8|16|32)(unorm|snorm|uint|sint|float)(-srgb)?$/.exec(f.gpu)!, bits = +size;
      const channels = order === "bgra" ? [c.b, c.g, c.r, c.a] : rgba.slice(0, order.length);
      channels.forEach((x, i) => {
        const v = kind === "unorm" ? Math.round(clamp(s && i < 3 ? srgb(x) : x, 0, 1) * (2 ** bits - 1))
          : kind === "snorm" ? Math.round(clamp(x, -1, 1) * (2 ** (bits - 1) - 1)) : kind === "float" && bits === 16 ? toHalf(x) : x;
        if (kind === "float" && bits === 32) out.setFloat32(i * 4, x, true);
        else if (bits === 8) out.setUint8(i, v & 0xff);
        else if (bits === 16) out.setUint16(i * 2, v & 0xffff, true);
        else out.setUint32(i * 4, v >>> 0, true);
      });
    }
  }
  return new Uint8Array(out.buffer);
}
export const vkFormatOf = (gpu: GPUTextureFormat): number | undefined => byGpu.get(gpu);

const VERTEX = new Map<number, GPUVertexFormat>([
  [9, "unorm8"], [10, "snorm8"], [13, "uint8"], [14, "sint8"], [16, "unorm8x2"], [17, "snorm8x2"], [20, "uint8x2"], [21, "sint8x2"],
  [37, "unorm8x4"], [38, "snorm8x4"], [41, "uint8x4"], [42, "sint8x4"], [44, "unorm8x4-bgra"], [64, "unorm10-10-10-2"],
  [70, "unorm16"], [71, "snorm16"], [74, "uint16"], [75, "sint16"], [76, "float16"],
  [77, "unorm16x2"], [78, "snorm16x2"], [81, "uint16x2"], [82, "sint16x2"], [83, "float16x2"],
  [91, "unorm16x4"], [92, "snorm16x4"], [95, "uint16x4"], [96, "sint16x4"], [97, "float16x4"],
  [98, "uint32"], [99, "sint32"], [100, "float32"], [101, "uint32x2"], [102, "sint32x2"], [103, "float32x2"],
  [104, "uint32x3"], [105, "sint32x3"], [106, "float32x3"], [107, "uint32x4"], [108, "sint32x4"], [109, "float32x4"],
]);
export const vertexFormat = (vk: number): GPUVertexFormat | undefined => VERTEX.get(vk);

/** the texel buffer features of the formats whose texels are 32-bit components, which shaders read as arrays of them
 *  (spirv/): uniform texel buffers in the single-component ones, as a sampled buffer's format is unknown to its shader */
const texelBuffer = (vk: number) => vk >= 98 && vk <= 100 ? F.UNIFORM_TEXEL | F.STORAGE_TEXEL : [101, 102, 103, 107, 108, 109].includes(vk) ? F.STORAGE_TEXEL : 0;
/** VkFormatProperties for `vk` on an adapter with `features`: optimal-tiling and buffer features; nothing is linear */
export function formatFeatures(vk: number, features: ReadonlySet<string>): { optimal: number; buffer: number } {
  const buffer = (VERTEX.has(vk) ? F.VERTEX : 0) | texelBuffer(vk), f = textures.get(vk);
  if (!f || (f.needs && !features.has(f.needs))) return { optimal: 0, buffer };
  const tier1 = features.has("texture-formats-tier1"), caps = f.caps, has = (c: string) => caps.includes(c) || (tier1 && caps.includes("1"));
  let optimal = F.SAMPLED | F.TRANSFER_SRC | F.TRANSFER_DST;
  // a depth format filters only through a comparison sampler in WebGPU, which Vulkan does not ask about here
  if (f.depth || f.stencil) return { optimal: optimal | F.DEPTH, buffer };
  const float32 = f.gpu === "r32float" || f.gpu === "rg32float" || f.gpu === "rgba32float";
  if (caps.includes("f") || (float32 && features.has("float32-filterable"))) optimal |= F.LINEAR;
  const renderable = has("r") || (f.gpu === "rg11b10ufloat" && features.has("rg11b10ufloat-renderable"));
  if (renderable) optimal |= F.COLOR;
  // blits sample the source and render the destination (internal.ts), which integer formats' channels cannot
  if (!f.gpu.endsWith("int")) optimal |= F.BLIT_SRC | (renderable ? F.BLIT_DST : 0);
  if (renderable && (has("b") || (float32 && features.has("float32-blendable")) || f.gpu === "rg11b10ufloat")) optimal |= F.BLEND;
  if (has("s") || (f.gpu === "bgra8unorm" && features.has("bgra8unorm-storage"))) optimal |= F.STORAGE;
  if (caps.includes("a")) optimal |= F.STORAGE_ATOMIC;
  return { optimal, buffer };
}
/** whether `vk` takes 4 samples: WebGPU's multisample column */
export function multisamples(vk: number, features: ReadonlySet<string>): boolean {
  const f = textures.get(vk);
  return !!f && (f.caps.includes("m") || (features.has("texture-formats-tier1") && f.caps.includes("1")));
}
