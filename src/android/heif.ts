let modulePromise: ReturnType<typeof import("libheif-js/libheif-wasm/libheif-bundle.mjs").default> | undefined;

export async function decodeHeif(bytes: Uint8Array): Promise<ImageBitmap> {
  const module = await (modulePromise ??= import("libheif-js/libheif-wasm/libheif-bundle.mjs").then(m => m.default()));
  const decoder = new module.HeifDecoder();
  const images: ReturnType<typeof decoder.decode> = [];
  try {
    images.push(...decoder.decode(bytes));
    const image = images.find(image => image.is_primary()) ?? images[0];
    if (!image) throw new Error("HEIF contains no decodable image");
    const pixels = await new Promise<ImageData | null>(resolve => {
      image.display(new ImageData(image.get_width(), image.get_height()), resolve);
    });
    if (!pixels) throw new Error("HEIF pixel decoding failed");
    return await createImageBitmap(pixels);
  } finally {
    for (const image of images) image.free();
    if (decoder.decoder) module.heif_context_free(decoder.decoder);
  }
}

export function isHeif(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || bytes[4] !== 102 || bytes[5] !== 116 || bytes[6] !== 121 || bytes[7] !== 112) return false;
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (size < 16 || size > bytes.length) return false;
  for (let i = 8; i + 4 <= size; i += i === 8 ? 8 : 4) {
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(String.fromCharCode(...bytes.subarray(i, i + 4)))) return true;
  }
  return false;
}
