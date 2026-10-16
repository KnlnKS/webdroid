import { declaredField } from "../../src/jvm/runtime.ts";
import { newObj, vcall, scall } from "../../src/jvm/natives/jentry.ts";
import { mangleStaticField } from "../../src/jvm/abi.ts";
import { exercise, same, thrown, statics, listener, ltrb } from "./harness.ts";

// Bitmap, BitmapFactory and BitmapRegionDecoder against the reference AVD: every expected value below
// was printed by the same calls there (images in tests/fixtures/images). Headless there is no image
// decoder, so a decode here gets a stand-in that has only the requested size: what these check is
// geometry, configs, flags, nine-patch data and the pixel API, not decoded pixels.
const BITMAP = "android/graphics/Bitmap", BF = "android/graphics/BitmapFactory", OPTS = "android/graphics/BitmapFactory$Options";
const hex = (v: number) => (v >>> 0).toString(16);
const configs = async () => await statics(`${BITMAP}$Config`);
const image = (name: string) => Bun.file(`tests/fixtures/images/${name}`).bytes().then((b) => new Int8Array(b.buffer, b.byteOffset, b.length));
/** "WxH CONFIG rb= bc= abc= alpha= premul= mut=", as the device probe printed it */
async function info(b: unknown): Promise<string> {
  if (!b) return "null";
  const i = (name: string) => vcall(b, name, "()I"), z = async (name: string) => !!(await vcall(b, name, "()Z"));
  const cfg = await vcall(await vcall(b, "getConfig", "()Landroid/graphics/Bitmap$Config;"), "name", "()Ljava/lang/String;");
  return `${await i("getWidth")}x${await i("getHeight")} ${cfg} rb=${await i("getRowBytes")} bc=${await i("getByteCount")} abc=${await i("getAllocationByteCount")}`
    + ` alpha=${await z("hasAlpha")} premul=${await z("isPremultiplied")} mut=${await z("isMutable")}`;
}
async function px(b: unknown): Promise<string> {
  const out: string[] = [], w = await vcall(b, "getWidth", "()I"), h = await vcall(b, "getHeight", "()I");
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push(hex(await vcall(b, "getPixel", "(II)I", x, y)));
  return out.join(" ");
}
const create = async (w: number, h: number, config: string) =>
  scall(BITMAP, "createBitmap", "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;", w, h, (await configs())[`s$${config}`]);
const bufferBytes = async (b: unknown, n: number) => {
  const buf = await scall("java/nio/ByteBuffer", "allocate", "(I)Ljava/nio/ByteBuffer;", n);
  await vcall(b, "copyPixelsToBuffer", "(Ljava/nio/Buffer;)V", buf);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await vcall(buf, "get", "(I)B", i)) & 0xff);
  return `${out.join(",")} pos=${await vcall(buf, "position", "()I")}`;
};
(globalThis as Record<string, unknown>).createImageBitmap ??= async (source: Blob, ...args: unknown[]) => {
  const size = (args.length > 1 ? args[4] : args[0]) as ImageBitmapOptions | undefined, rect = args.length > 1 ? args as number[] : null;
  return { width: size?.resizeWidth ?? rect?.[2], height: size?.resizeHeight ?? rect?.[3], close() {} };
};

await exercise("Bitmap: pixels, configs, copies, buffers, parcels (device values)", async () => {
  const b = await create(3, 2, "ARGB_8888");
  same("create", await info(b), "3x2 ARGB_8888 rb=12 bc=24 abc=24 alpha=true premul=true mut=true");
  const g0 = await vcall(b, "getGenerationId", "()I");
  for (const [x, y, c] of [[0, 0, 0x80FF0000], [1, 0, 0x01808080], [2, 0, 0x40123456], [0, 1, 0xff00ff00], [1, 1, 0x00ffffff], [2, 1, 0x7f7f7f7f]])
    await vcall(b, "setPixel", "(III)V", x, y, c | 0);
  same("generation", (await vcall(b, "getGenerationId", "()I")) !== g0, true);
  same("premultiplied round trip", await px(b), "80ff0000 1ffffff 40143458 ff00ff00 0 7f7e7e7e");
  const out = new Int32Array(8);
  await vcall(b, "getPixels", "([IIIIIII)V", out, 1, 4, 1, 0, 2, 2);
  same("getPixels", [...out].map(hex).join(" "), "0 1ffffff 40143458 0 0 0 7f7e7e7e 0");
  same("copyPixelsToBuffer", await bufferBytes(b, 24), "128,0,0,128,1,1,1,1,5,13,22,64,0,255,0,255,0,0,0,0,63,63,63,127 pos=24");
  const copy = async (config: string, mutable: number) => vcall(b, "copy", "(Landroid/graphics/Bitmap$Config;Z)Landroid/graphics/Bitmap;", (await configs())[`s$${config}`], mutable);
  const c565 = await copy("RGB_565", 1);
  same("copy 565", `${await info(c565)} | ${await px(c565)}`, "3x2 RGB_565 rb=6 bc=12 abc=12 alpha=false premul=false mut=true | ff840000 ff000000 ff080c18 ff00ff00 ff000000 ff424142");
  const cA8 = await copy("ALPHA_8", 0);
  same("copy A8", `${await info(cA8)} | ${await px(cA8)} | ${await vcall(cA8, "getColorSpace", "()Landroid/graphics/ColorSpace;")}`,
    "3x2 ALPHA_8 rb=3 bc=6 abc=6 alpha=true premul=true mut=false | 80000000 1000000 40000000 ff000000 0 7f000000 | null");
  const c4444 = await copy("ARGB_4444", 1);
  same("copy 4444", `${await info(c4444)} | ${await px(c4444)}`, "3x2 ARGB_4444 rb=6 bc=12 abc=12 alpha=true premul=true mut=true | 88ff0000 0 44004040 ff00ff00 0 77929292");
  const cF16 = await copy("RGBA_F16", 1);
  same("copy F16", `${await info(cF16)} | ${await px(cF16)}`, "3x2 RGBA_F16 rb=24 bc=48 abc=48 alpha=true premul=true mut=true | 80ff0000 1ffffff 40143458 ff00ff00 0 7f7f7f7f");
  same("F16 color space", await vcall(await vcall(cF16, "getColorSpace", "()Landroid/graphics/ColorSpace;"), "getName", "()Ljava/lang/String;"), "scRGB-nl IEC 61966-2-2:2003");
  same("copy HARDWARE", await info(await copy("HARDWARE", 0)), "3x2 HARDWARE rb=12 bc=24 abc=24 alpha=true premul=true mut=false");
  const c1010102 = await copy("RGBA_1010102", 1);
  same("copy 1010102", `${await info(c1010102)} | ${await px(c1010102)}`, "3x2 RGBA_1010102 rb=12 bc=24 abc=24 alpha=true premul=true mut=true | aac00000 0 550f2742 ff00ff00 0 55bdbdbd");
  same("create 4444 is 8888", await info(await create(2, 2, "ARGB_4444")), "2x2 ARGB_8888 rb=8 bc=16 abc=16 alpha=true premul=true mut=true");
  same("create HARDWARE", await thrown(() => create(2, 2, "HARDWARE")), "java.lang.IllegalArgumentException: can't create mutable bitmap with Config.HARDWARE");
  const a8 = await create(2, 1, "ALPHA_8");
  await vcall(a8, "setPixel", "(III)V", 0, 0, 0x80ff0000 | 0); await vcall(a8, "setPixel", "(III)V", 1, 0, 0xff123456 | 0);
  same("A8", `${await px(a8)} | ${await bufferBytes(a8, 2)}`, "80000000 ff000000 | 128,255 pos=2");
  const r565 = await create(2, 1, "RGB_565");
  await vcall(r565, "setPixel", "(III)V", 0, 0, 0x80ff8040 | 0); await vcall(r565, "setPixel", "(III)V", 1, 0, 0xff123456 | 0);
  await vcall(r565, "setHasAlpha", "(Z)V", 1);
  same("565", `${await px(r565)} | ${await bufferBytes(r565, 4)} | ${await vcall(r565, "hasAlpha", "()Z")}`, "ffff8242 ff103452 | 8,252,170,17 pos=4 | 0");
  const f16 = await create(1, 1, "RGBA_F16");
  await vcall(f16, "setPixel", "(III)V", 0, 0, 0x80ff4000 | 0);
  same("F16", `${await px(f16)} | ${await bufferBytes(f16, 8)}`, "80ff4000 | 4,56,8,48,0,0,4,56 pos=8");
  const e = await create(2, 1, "ARGB_8888");
  await vcall(e, "eraseColor", "(I)V", 0x7f00ff00);
  same("erase", await px(e), "7f00ff00 7f00ff00");
  await vcall(e, "eraseColor", "(J)V", await scall("android/graphics/Color", "pack", "(FFFF)J", 0.5, 0.25, 1, 1));
  same("erase long", await px(e), "ff8040ff ff8040ff");
  const p3 = await scall("android/graphics/ColorSpace", "get", "(Landroid/graphics/ColorSpace$Named;)Landroid/graphics/ColorSpace;",
    (await statics("android/graphics/ColorSpace$Named")).s$DISPLAY_P3);
  await vcall(e, "eraseColor", "(J)V", await scall("android/graphics/Color", "pack", "(FFFFLandroid/graphics/ColorSpace;)J", 1, 0, 0, 1, p3));
  same("erase P3 red", await px(e), "ffff0000 ffff0000");
  const o = await create(1, 1, "ARGB_8888");
  await vcall(o, "setPixel", "(III)V", 0, 0, 0x80FF0000 | 0);
  await vcall(o, "setHasAlpha", "(Z)V", 0);
  same("opaque keeps the memory", `${await vcall(o, "hasAlpha", "()Z")} ${await px(o)} ${await vcall(o, "isPremultiplied", "()Z")}`, "0 80800000 0");
  const u = await create(1, 1, "ARGB_8888");
  await vcall(u, "setPremultiplied", "(Z)V", 0);
  await vcall(u, "setPixel", "(III)V", 0, 0, 0x01808080);
  same("unpremultiplied", `${await px(u)} | ${await bufferBytes(u, 4)}`, "1808080 | 128,128,128,1 pos=4");
  const from = await create(2, 1, "ARGB_8888");
  await vcall(from, "copyPixelsFromBuffer", "(Ljava/nio/Buffer;)V", await scall("java/nio/ByteBuffer", "wrap", "([B)Ljava/nio/ByteBuffer;", Int8Array.of(-128, 0, 0, -128, 10, 20, 30, 40)));
  same("copyPixelsFromBuffer", await px(from), "80ff0000 284080bf");
  const re = await create(3, 2, "ARGB_8888"), rg = await vcall(re, "getGenerationId", "()I");
  await vcall(re, "reconfigure", "(IILandroid/graphics/Bitmap$Config;)V", 2, 2, (await configs()).s$RGB_565);
  same("reconfigure", `${await info(re)} ${(await vcall(re, "getGenerationId", "()I")) !== rg}`, "2x2 RGB_565 rb=4 bc=8 abc=24 alpha=false premul=false mut=true true");
  same("reconfigure larger", await thrown(async () => vcall(re, "reconfigure", "(IILandroid/graphics/Bitmap$Config;)V", 4, 4, (await configs()).s$ARGB_8888)),
    "java.lang.IllegalArgumentException: Bitmap not large enough to support new configuration");
  const fromColors = await scall(BITMAP, "createBitmap", "([IIILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;", Int32Array.of(0x80ff0000 | 0, 0xff00ff00 | 0, 0x01808080, 0), 2, 2, (await configs()).s$ARGB_8888);
  same("from colors", `${await info(fromColors)} | ${await px(fromColors)}`, "2x2 ARGB_8888 rb=8 bc=16 abc=16 alpha=true premul=true mut=false | 80ff0000 ff00ff00 1ffffff 0");
  const colors565 = await scall(BITMAP, "createBitmap", "([IIILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;", Int32Array.of(0x80ff0000 | 0, 0xff00ff00 | 0), 2, 1, (await configs()).s$RGB_565);
  same("565 from colors", `${await info(colors565)} | ${await px(colors565)}`, "2x1 RGB_565 rb=4 bc=4 abc=4 alpha=false premul=false mut=false | ffff0000 ff00ff00");
  same("sameAs", [await vcall(b, "sameAs", "(Landroid/graphics/Bitmap;)Z", await copy("ARGB_8888", 0)), await vcall(b, "sameAs", "(Landroid/graphics/Bitmap;)Z", c565)], "1,0");
  const alpha = await vcall(b, "extractAlpha", "()Landroid/graphics/Bitmap;");
  same("extractAlpha", `${await info(alpha)} | ${await px(alpha)}`, "3x2 ALPHA_8 rb=4 bc=8 abc=8 alpha=true premul=true mut=true | 80000000 1000000 40000000 ff000000 0 7f000000");
  await vcall(b, "setDensity", "(I)V", 213);
  const parcel = await scall("android/os/Parcel", "obtain", "()Landroid/os/Parcel;");
  await vcall(b, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
  await vcall(parcel, "setDataPosition", "(I)V", 0);
  const back = await vcall((await statics(BITMAP))[mangleStaticField("CREATOR")], "createFromParcel", "(Landroid/os/Parcel;)Ljava/lang/Object;", parcel);
  same("parcel", `${await info(back)} dens=${await vcall(back, "getDensity", "()I")} | ${await px(back)} | ${await vcall(back, "sameAs", "(Landroid/graphics/Bitmap;)Z", b)}`,
    "3x2 ARGB_8888 rb=12 bc=24 abc=24 alpha=true premul=true mut=true dens=213 | 80ff0000 1ffffff 40143458 ff00ff00 0 7f7e7e7e | 1");
  await vcall(b, "recycle", "()V");
  same("recycled", await thrown(() => vcall(b, "getPixel", "(II)I", 0, 0)), "java.lang.IllegalStateException: Can't call getPixel() on a recycled bitmap");
});

await exercise("BitmapFactory: bounds, sampling, density, configs, nine-patch, inBitmap (device values)", async () => {
  const opts = async (set: Record<string, unknown> = {}) => {
    const o = await newObj(OPTS, "()V") as Record<string, unknown>;
    for (const [k, v] of Object.entries(set)) o[declaredField(OPTS, k)] = k === "inPreferredConfig" && typeof v === "string" ? (await configs())[`s$${v}`] : v;
    return o;
  };
  const out = async (o: Record<string, unknown>) => {
    const f = (k: string) => o[declaredField(OPTS, k)];
    const cfg = f("outConfig") && await vcall(f("outConfig"), "name", "()Ljava/lang/String;");
    const cs = f("outColorSpace") && await vcall(f("outColorSpace"), "getName", "()Ljava/lang/String;");
    return `${f("outWidth")}x${f("outHeight")} ${f("outMimeType")} ${cfg ?? null} ${cs?.split(" ")[0] ?? null}`;
  };
  const decode = async (bytes: Int8Array, o: Record<string, unknown> | null) =>
    scall(BF, "decodeByteArray", "([BIILandroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;", bytes, 0, bytes.length, o);
  const sampled: Record<string, string> = {
    "alpha.png": "10x6 5x3 3x2 2x1 2x1 1x1", "opaque.jpg": "10x6 5x3 3x2 3x2 2x1 2x1", "rotated.jpg": "10x6 5x3 3x2 3x2 2x1 2x1",
    "lossless.webp": "10x6 5x3 3x2 3x2 2x1 1x1", "anim.gif": "3x2 2x1 1x1 1x1 1x1 1x1", "patch.9.png": "48x48 24x24 16x16 12x12 9x9 6x6",
    "truncated.png": "64x64 32x32 21x21 16x16 12x12 8x8",
  };
  const mime: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
  for (const [name, want] of Object.entries(sampled)) {
    const bytes = await image(name), got: string[] = [];
    for (const sample of [1, 2, 3, 4, 5, 8]) {
      const o = await opts({ inJustDecodeBounds: 1, inSampleSize: sample });
      if (await decode(bytes, o) !== null) throw new Error("a bounds decode returned a bitmap");
      const [size, type, cfg, cs] = (await out(o)).split(" ");
      same(`${name} bounds`, `${type} ${cfg} ${cs}`, `${mime[name.split(".").pop()!]} ARGB_8888 sRGB`);
      got.push(size);
    }
    same(`${name} sampled`, got.join(" "), want);
  }
  const png = await image("alpha.png"), jpg = await image("opaque.jpg"), patch = await image("patch.9.png"), insets = await image("insets.9.png");
  const decoded = async (bytes: Int8Array, set: Record<string, unknown>) => {
    const o = await opts(set), b = await decode(bytes, o);
    return `${await info(b)} dens=${b && await vcall(b, "getDensity", "()I")} | ${await out(o)}`;
  };
  same("density 160 to 320", await decoded(png, { inDensity: 160, inTargetDensity: 320 }), "20x12 ARGB_8888 rb=80 bc=960 abc=960 alpha=true premul=true mut=false dens=320 | 10x6 image/png ARGB_8888 sRGB");
  same("density 480 to 320", await decoded(png, { inDensity: 480, inTargetDensity: 320 }), "7x4 ARGB_8888 rb=28 bc=112 abc=112 alpha=true premul=true mut=false dens=320 | 10x6 image/png ARGB_8888 sRGB");
  same("density and sample", await decoded(png, { inDensity: 480, inTargetDensity: 320, inSampleSize: 2 }), "3x2 ARGB_8888 rb=12 bc=24 abc=24 alpha=true premul=true mut=false dens=320 | 5x3 image/png ARGB_8888 sRGB");
  same("unscaled", await decoded(png, { inDensity: 160, inTargetDensity: 320, inScaled: 0 }), "10x6 ARGB_8888 rb=40 bc=240 abc=240 alpha=true premul=true mut=false dens=160 | 10x6 image/png ARGB_8888 sRGB");
  same("opaque jpeg", await decoded(jpg, {}).then((s) => s.split(" dens")[0]), "10x6 ARGB_8888 rb=40 bc=240 abc=240 alpha=false premul=false mut=false");
  same("png as 565", await decoded(png, { inPreferredConfig: "RGB_565" }).then((s) => s.split(" | ")[1]), "10x6 image/png ARGB_8888 sRGB");
  same("jpeg as 565", await decoded(jpg, { inPreferredConfig: "RGB_565" }), "10x6 RGB_565 rb=20 bc=120 abc=120 alpha=false premul=false mut=false dens=" + await scall(BITMAP, "getDefaultDensity", "()I") + " | 10x6 image/jpeg RGB_565 sRGB");
  for (const [config, want] of [["ALPHA_8", "ARGB_8888"], ["HARDWARE", "HARDWARE"], ["ARGB_4444", "ARGB_8888"], [null, "ARGB_8888"]])
    same(`png as ${config}`, (await decoded(png, { inPreferredConfig: config })).split(" ")[1], want);
  same("mutable unpremultiplied", (await decoded(png, { inMutable: 1, inPremultiplied: 0 })).split(" dens")[0], "10x6 ARGB_8888 rb=40 bc=240 abc=240 alpha=true premul=false mut=true");
  const pad = await newObj("android/graphics/Rect", "(IIII)V", 7, 7, 7, 7) as object;
  const decodeStream = async (bytes: Int8Array, o: unknown) => scall(BF, "decodeStream", "(Ljava/io/InputStream;Landroid/graphics/Rect;Landroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;",
    await newObj("java/io/ByteArrayInputStream", "([B)V", bytes), pad, o);
  const padding = () => ltrb(pad).join(",");
  await decodeStream(png, null);
  same("no nine-patch padding", padding(), "-1,-1,-1,-1");
  const np = await decodeStream(patch, null);
  same("nine-patch", `${await info(np)} pad ${padding()} chunk ${[...await vcall(np, "getNinePatchChunk", "()[B")]}`,
    "48x48 ARGB_8888 rb=192 bc=9216 abc=9216 alpha=false premul=false mut=false pad 0,0,0,0 chunk 1,2,2,9,32,0,0,0,40,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,48,0,0,0,24,0,0,0,25,0,0,0,41,0,0,0,42,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,34,34,34,-1,34,34,34,-1,34,34,34,-1,34,34,34,-1,34,34,34,-1,34,34,34,-1");
  const optical = async (b: unknown) => { const r = await newObj("android/graphics/Rect", "()V") as object; await vcall(b, "getOpticalInsets", "(Landroid/graphics/Rect;)V", r); return ltrb(r).join(","); };
  same("optical insets", [await optical(np), await optical(await decodeStream(insets, null))].join(" "), "0,0,0,0 1,2,3,4");
  same("nine-patch 160 to 240", `${(await info(await decodeStream(patch, await opts({ inDensity: 160, inTargetDensity: 240 })))).split(" ")[0]} pad ${padding()}`, "72x72 pad 0,0,0,0");
  const reuse = await create(10, 6, "ARGB_8888"), bigger = await create(20, 20, "ARGB_8888");
  same("inBitmap", (await decode(png, await opts({ inBitmap: reuse, inMutable: 1 }))) === reuse, true);
  same("inBitmap larger", `${(await decode(png, await opts({ inBitmap: bigger, inMutable: 1 }))) === bigger} ${await info(bigger)}`, "true 10x6 ARGB_8888 rb=40 bc=240 abc=1600 alpha=true premul=true mut=true");
  same("inBitmap too small", await thrown(async () => decode(png, await opts({ inBitmap: await create(4, 4, "ARGB_8888"), inMutable: 1 }))), "java.lang.IllegalArgumentException: Problem decoding into existing bitmap");
  same("inBitmap 565 for alpha", await thrown(async () => decode(png, await opts({ inBitmap: await create(10, 6, "RGB_565"), inMutable: 1 }))), "java.lang.IllegalArgumentException: Problem decoding into existing bitmap");
  const immutable = await decode(png, null);
  same("inBitmap immutable", (await decode(png, await opts({ inBitmap: immutable }))) !== immutable, true);
  const small = await create(5, 3, "ARGB_8888");
  same("inBitmap sampled", `${(await decode(png, await opts({ inBitmap: small, inMutable: 1, inSampleSize: 2 }))) === small} ${(await info(small)).split(" ")[0]}`, "true 5x3");
  const garbage = await opts();
  same("garbage", `${await decode(Int8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10), garbage)} ${await out(garbage)}`, "null -1x-1 null null null");
  same("empty stream", await scall(BF, "decodeStream", "(Ljava/io/InputStream;)Landroid/graphics/Bitmap;", await newObj("java/io/ByteArrayInputStream", "([B)V", new Int8Array(0))), null);
  same("missing file", await scall(BF, "decodeFile", "(Ljava/lang/String;)Landroid/graphics/Bitmap;", "/data/local/tmp/nope.png"), null);
});

await exercise("BitmapRegionDecoder (device values)", async () => {
  const BRD = "android/graphics/BitmapRegionDecoder", png = await image("alpha.png");
  const open = async (bytes: Int8Array) => scall(BRD, "newInstance", "([BII)Landroid/graphics/BitmapRegionDecoder;", bytes, 0, bytes.length);
  const rd = await open(png), rect = (l: number, t: number, r: number, b: number) => newObj("android/graphics/Rect", "(IIII)V", l, t, r, b);
  const o = await newObj(OPTS, "()V") as Record<string, unknown>;
  o[declaredField(OPTS, "inSampleSize")] = 2;
  const region = await vcall(rd, "decodeRegion", "(Landroid/graphics/Rect;Landroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;", await rect(1, 1, 8, 6), o);
  same("region", `${await vcall(rd, "getWidth", "()I")}x${await vcall(rd, "getHeight", "()I")} ${await info(region)} ${o[declaredField(OPTS, "outWidth")]}x${o[declaredField(OPTS, "outHeight")]} ${o[declaredField(OPTS, "outMimeType")]}`,
    "10x6 3x2 ARGB_8888 rb=12 bc=24 abc=24 alpha=true premul=true mut=false 3x2 image/png");
  const partial = await vcall(rd, "decodeRegion", "(Landroid/graphics/Rect;Landroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;", await rect(-2, -2, 4, 4), null);
  same("partly outside", (await info(partial)).split(" ")[0], "6x6");
  same("outside", await thrown(async () => vcall(rd, "decodeRegion", "(Landroid/graphics/Rect;Landroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;", await rect(20, 20, 30, 30), null)),
    "java.lang.IllegalArgumentException: rectangle is outside the image");
  same("gif", await thrown(async () => open(await image("anim.gif"))), "java.io.IOException: Image format not supported");
  same("garbage", await thrown(() => open(Int8Array.of(1, 2, 3))), "java.io.IOException: Image format not supported");
});

await exercise("ImageDecoder: headers, targets, allocators, partial input, drawables (device values)", async () => {
  const ID = "android/graphics/ImageDecoder", SRC = "Landroid/graphics/ImageDecoder$Source;";
  const source = (bytes: Int8Array) => scall(ID, "createSource", `([B)${SRC}`, bytes);
  const onHeader = (fn: (decoder: unknown) => unknown) => listener(`${ID}$OnHeaderDecodedListener`, "onHeaderDecoded", `(Landroid/graphics/ImageDecoder;Landroid/graphics/ImageDecoder$ImageInfo;${SRC})V`, fn);
  const bitmap = async (bytes: Int8Array, fn?: (decoder: unknown) => unknown) =>
    fn ? scall(ID, "decodeBitmap", `(${SRC}Landroid/graphics/ImageDecoder$OnHeaderDecodedListener;)Landroid/graphics/Bitmap;`, await source(bytes), onHeader(fn))
      : scall(ID, "decodeBitmap", `(${SRC})Landroid/graphics/Bitmap;`, await source(bytes));
  const withDensity = async (b: unknown) => `${await info(b)} dens=${await vcall(b, "getDensity", "()I")}`;
  const headers: Record<string, string> = {
    "alpha.png": "10x6 image/png false", "opaque.jpg": "10x6 image/jpeg false", "rotated.jpg": "6x10 image/jpeg false",
    "lossless.webp": "10x6 image/webp false", "anim.gif": "3x2 image/gif true", "patch.9.png": "48x48 image/png false",
  };
  for (const [name, want] of Object.entries(headers)) {
    const i = await scall(ID, "decodeHeader", `(${SRC})Landroid/graphics/ImageDecoder$ImageInfo;`, await source(await image(name)));
    const size = await vcall(i, "getSize", "()Landroid/util/Size;");
    same(`${name} header`, `${await vcall(size, "getWidth", "()I")}x${await vcall(size, "getHeight", "()I")} ${await vcall(i, "getMimeType", "()Ljava/lang/String;")} ${!!await vcall(i, "isAnimated", "()Z")}`, want);
  }
  const png = await image("alpha.png"), jpg = await image("opaque.jpg");
  same("default allocator", await withDensity(await bitmap(png)), "10x6 HARDWARE rb=40 bc=240 abc=240 alpha=true premul=true mut=false dens=0");
  same("EXIF orientation", await withDensity(await bitmap(await image("rotated.jpg"))), "6x10 HARDWARE rb=24 bc=240 abc=240 alpha=false premul=false mut=false dens=0");
  const crop = await newObj("android/graphics/Rect", "(IIII)V", 1, 1, 4, 3);
  same("target, crop, mutable", await info(await bitmap(png, async (d) => {
    await vcall(d, "setTargetSize", "(II)V", 5, 3); await vcall(d, "setCrop", "(Landroid/graphics/Rect;)V", crop);
    await vcall(d, "setMutableRequired", "(Z)V", 1); await vcall(d, "setAllocator", "(I)V", 1);
  })), "3x2 ARGB_8888 rb=12 bc=24 abc=24 alpha=true premul=true mut=true");
  same("sample size", await info(await bitmap(png, (d) => vcall(d, "setTargetSampleSize", "(I)V", 3))), "3x2 HARDWARE rb=12 bc=24 abc=24 alpha=true premul=true mut=false");
  same("alpha mask of colour", (await info(await bitmap(png, async (d) => { await vcall(d, "setDecodeAsAlphaMaskEnabled", "(Z)V", 1); await vcall(d, "setAllocator", "(I)V", 1); }))).split(" ")[1], "ARGB_8888");
  same("low RAM", await info(await bitmap(jpg, async (d) => { await vcall(d, "setMemorySizePolicy", "(I)V", 0); await vcall(d, "setAllocator", "(I)V", 1); })),
    "10x6 RGB_565 rb=20 bc=120 abc=120 alpha=false premul=false mut=false");
  const pad = await newObj("android/graphics/Rect", "()V") as object;
  await bitmap(await image("patch.9.png"), (d) => vcall(d, "setOutPaddingRect", "(Landroid/graphics/Rect;)V", pad));
  same("nine-patch padding", ltrb(pad).join(","), "0,0,0,0");
  let seen = "";
  const partial = listener(`${ID}$OnPartialImageListener`, "onPartialImage", "(Landroid/graphics/ImageDecoder$DecodeException;)Z", async (e: unknown) => {
    seen = `${await vcall(e, "getError", "()I")} ${await vcall(e, "getMessage", "()Ljava/lang/String;")} ${await vcall(e, "getCause", "()Ljava/lang/Throwable;")}`;
    return 1;
  });
  const truncated = await image("truncated.png");
  same("partial image", `${await info(await bitmap(truncated, (d) => vcall(d, "setOnPartialImageListener", "(Landroid/graphics/ImageDecoder$OnPartialImageListener;)V", partial)))} seen ${seen}`,
    "64x64 HARDWARE rb=256 bc=16384 abc=16384 alpha=false premul=false mut=false seen 2 Input was incomplete. null");
  same("incomplete", await thrown(() => bitmap(truncated)), "android.graphics.ImageDecoder$DecodeException: Input was incomplete.");
  same("garbage", await thrown(() => bitmap(Int8Array.of(1, 2, 3, 4, 5, 6, 7, 8))),
    "android.graphics.ImageDecoder$DecodeException: Failed to create image decoder with message 'unimplemented'Input contained an error.");
  const buffer = await scall("java/nio/ByteBuffer", "wrap", "([B)Ljava/nio/ByteBuffer;", png);
  same("ByteBuffer source", await info(await scall(ID, "decodeBitmap", `(${SRC})Landroid/graphics/Bitmap;`, await scall(ID, "createSource", `(Ljava/nio/ByteBuffer;)${SRC}`, buffer))),
    "10x6 HARDWARE rb=40 bc=240 abc=240 alpha=true premul=true mut=false");
  const drawable = async (bytes: Int8Array) => {
    const d = await scall(ID, "decodeDrawable", `(${SRC})Landroid/graphics/drawable/Drawable;`, await source(bytes));
    const name = await vcall(await vcall(d, "getClass", "()Ljava/lang/Class;"), "getSimpleName", "()Ljava/lang/String;");
    return `${name} ${await vcall(d, "getIntrinsicWidth", "()I")}x${await vcall(d, "getIntrinsicHeight", "()I")}`;
  };
  same("drawables", [await drawable(png), await drawable(await image("patch.9.png")), await drawable(await image("anim.gif"))].join(", "),
    "BitmapDrawable 10x6, NinePatchDrawable 48x48, AnimatedImageDrawable 3x2");
});
