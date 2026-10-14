// Runtime paths that need a real Canvas2D/WebGL: the fixtures in fixtures/browser are bundled once,
// served beside the framework resources, and each probe runs in its own page.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
// Each probe loads the whole runtime into a fresh page and the GL probes compile shaders in software;
// under a loaded host that alone passes bun's 5 s default, which bounds nothing these tests check.
const PAGE_TIMEOUT = 60_000;

beforeAll(async () => {
  const [build, launched] = await Promise.all([
    Bun.build({ entrypoints: [`${import.meta.dir}/fixtures/browser/index.ts`], target: "browser", format: "esm" }),
    chromium.launch({ headless: true }),
  ]);
  browser = launched;
  if (!build.success) throw new AggregateError(build.logs, "browser fixture build failed");
  // Streamed responses (a BuildArtifact's, a Bun.file's) intermittently arrive duplicated or fail under concurrent
  // browser load: each file is served from memory, read once.
  const bundle = await build.outputs[0].text(), fontIndex = Bun.spawnSync(["bun", "scripts/font-index.ts"]).stdout.toString();
  const files = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
  server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    const file = async (at: string, headers: Record<string, string> = {}) => {
      if (!files.has(at)) files.set(at, Bun.file(`${import.meta.dir}/..${at}`).bytes() as Promise<Uint8Array<ArrayBuffer>>);
      const bytes = await files.get(at)!, range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
      if (!range) return new Response(bytes, { headers });
      const end = Math.min(range[2] ? +range[2] + 1 : bytes.length, bytes.length);
      return new Response(bytes.subarray(+range[1], end), { status: 206, headers: { ...headers, "content-range": `bytes ${range[1]}-${end - 1}/${bytes.length}` } });
    };
    if (path === "/framework.apk") return file("/vendor/aosp/framework-res.apk");
    if (path === "/font-index.json") return new Response(fontIndex, { headers: { "content-type": "application/json" } });
    if (path === "/harfbuzz.wasm" || path === "/harfbuzz-subset.wasm") return file(`/node_modules/harfbuzzjs/dist${path}`);
    if (path === "/canvaskit.wasm") return file("/node_modules/canvaskit-wasm/bin/canvaskit.wasm", { "content-type": "application/wasm" });
    // no saved platform build: the page compiles what it runs
    if (path.startsWith("/aot/")) return new Response(null, { status: 404 });
    if (path.startsWith("/vendor/aosp/") || path.startsWith("/tests/fixtures/images/")) return file(path);
    return path === "/index.js" ? new Response(bundle, { headers: { "content-type": "text/javascript" } }) : new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
  } });
}, PAGE_TIMEOUT);
afterAll(async () => { await browser?.close(); server?.stop(true); });

type Probes = typeof import("./fixtures/browser/index");

/** A fixture's probe result, from a fresh page: the runtime's globals are per realm. */
async function probe<K extends keyof Probes>(name: K): Promise<Awaited<ReturnType<Probes[K]>>> {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(server.url.href);
    const result: unknown = await page.evaluate(async ([url, name]) => {
      try { return await (await import(url))[name](); }
      catch (error) {
        const causes: string[] = [], seen = new Set();
        for (let cause: any = error; cause && !seen.has(cause); cause = cause.cause) {
          seen.add(cause);
          causes.push(`${cause.constructor?.$i?.name ?? cause.name ?? "Error"}: ${cause.msg ?? cause.message ?? String(cause)}\n${cause.stack ?? ""}`);
        }
        throw new Error(causes.join("\nCaused by: "));
      }
    }, ["/index.js", name]);
    expect(errors).toEqual([]);
    return result as Awaited<ReturnType<Probes[K]>>;
  } finally { await page.close(); }
}

test.concurrent("blur mask styles combine geometry before paint alpha and preserve canvas state", async () => {
  const probeResult = await probe("blurMask");
  for (const result of probeResult.results) {
    expect(result.restored).toBe(true);
    expect(result.clipped).toBe(0);
    expect(result.maximum).toBeLessThanOrEqual(128);
    if (result.style === "OUTER") expect(result.inside).toBe(0);
    else expect(result.inside).toBeGreaterThan(90);
    if (result.style === "INNER") expect(result.outside).toBe(0);
    else expect(result.outside).toBeGreaterThan(0);
    if (result.style === "SOLID") expect(result.inside).toBe(128);
    expect(result.repeated).toBe(true);
  }
  const borders = new Map([[0, 0], [1, 3], [2, 4], [3, 5], [5, 8], [10, 17]]);
  for (const result of probeResult.extracted) {
    const border = result.style === "INNER" ? 0 : borders.get(result.radius)!;
    expect(result).toMatchObject({ width: 20 + 2 * border, height: 20 + 2 * border, offsets: [0 - border, 0 - border],
      config: 1, density: 480, rowBytes: (20 + 2 * border + 3) & ~3, distinct: true, rgb: 0 });
    if (result.radius === 0) expect(result.alpha).toBe(128);
  }
  expect(probeResult).toMatchObject({ shaded: [0, 255, 0, 64], position: 400, copiedAlpha: 127, originalAlpha: 0,
    plane: { inside: [0, 255, 0, 128], outside: [0, 0, 0, 0], restored: true }, changed: [255, 0, 0, 128] });
  expect(probeResult.tints).toMatchObject({ identity: true, clear: [0, 0, 0, 0], before: [255, 0, 0, 64] });
  for (const [index, value] of [91, 53, 43, 192].entries()) expect(Math.abs(probeResult.tints.add[index] - value)).toBeLessThanOrEqual(2);
  for (const [index, value] of [64, 64, 0, 64].entries()) expect(Math.abs(probeResult.tints.multiply[index] - value)).toBeLessThanOrEqual(2);
  const fx = probeResult.effects;
  expect(fx).toMatchObject({ cornerCut: 0, cornerCenter: 255, noShadow: 0, tablePartial: 0 });
  expect(fx.shadow).toBeGreaterThan(0);
  // the reference device's pixels under the same emboss: the top-left edge dark, the bottom-right lit (by
  // how much follows the blur's profile, the browser's Gaussian here and three box passes there)
  for (const [index, value] of [51, 168, 125].entries()) expect(Math.abs(fx.emboss[index] - value)).toBeLessThanOrEqual(12);
  expect(fx.scaled[1] - 2).toBeGreaterThan((fx.scaled[0] - 2) * 1.8);
  // as on the reference device, SUBPIXEL_TEXT leaves the hinted advances alone and LINEAR_TEXT measures 130
  expect(fx.measured[1]).toBe(fx.measured[0]);
  expect(fx.measured[2]).toBe(130);
}, PAGE_TIMEOUT);

// Values recorded on the reference AVD (the text box there is drawn without anti-aliasing, a pixel narrower).
test.concurrent("AOSP's Canvas reports the reference device's clips, saves, layers and bitmap densities", async () => {
  const { textOnPath, ...result } = await probe("canvas");
  expect(result).toEqual({
    clip0: "[0,0][100,80]", qr: [0, 1, 1, 0, 1],
    restore: ["Underflow in restore - more restores than saves", "Underflow in restoreToCount - more restores than saves"],
    clipRect: [1, 1, "[10,10][50,50]", 2], clipOut: [0, "[0,0][0,0]", 1], clipOutSides: [1, "[0,40][100,80]", 1, "[10,40][100,80]"],
    rotated: ["[-14,-24][114,104]", 1, "[30,20][70,60]"], scaled: ["[-5,-1][45,26]", 0, "[0,0][0,0]", 1], clipPath: [1, "[30,20][70,60]", 1, 0],
    saveLayer: [1, 2, "[0,0][50,50]"], empty: [0, "[0,0][0,0]", 0, 1],
    partialClip: ["[1.0, 0.0, 3.0][0.0, 1.0, 4.0][0.0, 0.0, 1.0]", "[-3,-4][7,6]"], partialMatrix: ["[1.0, 0.0, 0.0][0.0, 1.0, 0.0][0.0, 0.0, 1.0]", "[1,1][3,3]"],
    density: [0, "ff0000ff", "0", "800000ff", "0"], colors: ["80ff0000", "8000ff00", "0"],
    unclipped: [1, 2, "0", "ffff0000", 1, "ff807f00", "ff00ff00"], punch: ["7fffffff", "ffffffff"],
    clearText: [true, false], nestedPicture: ["ffff0000", "ffff0000"],
    recording: [100, 1, 8192, 0, "[0,0][100,50]", 0, 1],
    recorded: [1, "No recording in progress, forgot to call #beginRecording()?", "Software rendering doesn't support drawRenderNode"],
    shaders: { gradient: true, replaced: "1,0,0,1,5,0", bitmap: true, composed: "source-over", recomposed: "1,0,0,1,7,0" },
  });
  [12, 25, 55, 39].forEach((v, i) => expect(Math.abs((textOnPath as number[])[i] - v)).toBeLessThanOrEqual(1));
}, PAGE_TIMEOUT);

test.concurrent("framework drawables resolve dimensions, tint, enabled states and group transforms; vectors match the device", async () => {
  const result = await probe("drawableResources");
  expect(result).toMatchObject({ heights: [6, 6, 6], above: [0, 0, 0, 0], outside: [0, 0, 0, 0], restored: true,
    rotated: [[255, 0, 0, 255], [0, 0, 0, 0]], absolute: [[255, 0, 0, 255], [0, 0, 0, 0]] });
  expect(result.before[3]).toBe(255);
  expect(result.after[3]).toBeGreaterThan(0);
  expect(result.after[3]).toBeLessThan(255);
  expect(result.center[3]).toBe(128);
  // VectorDrawableProbe's pixels on the reference device (scripts/vector-probe.ts): within 3 per channel
  const device = (await Bun.file(`${import.meta.dir}/fixtures/vector-drawable.txt`).text()).split("\n").filter((l) => l.startsWith("px "));
  for (const line of device) {
    const [, name, , , ...hex] = line.split(" "), got = result.vectors[name];
    const worst = Math.max(...hex.map((h, i) => Math.max(...[24, 16, 8, 0].map((s) => Math.abs(((parseInt(h, 16) >>> s) & 255) - ((got[i] >>> s) & 255))))));
    expect([name, worst <= 3]).toEqual([name, true]);
  }
}, PAGE_TIMEOUT);

test.concurrent("drawable spans align their drawable and text shadows preserve state", async () => {
  const result = await probe("drawableSpan");
  for (const span of result.results) expect(span).toEqual({ width: 14, fm: { ascent: -17, top: -17, descent: 0, bottom: 0 }, aligned: true, restored: true, hierarchy: true });
  expect(result).toMatchObject({ getters: [1, 10, 2, 0xffff0000 | 0], red: true, shadowRestored: true });
}, PAGE_TIMEOUT);

test.concurrent("EGL10 and EGL14 retain each thread's binding, GL objects and errors across suspension and release", async () => {
  expect(await probe("eglThread")).toEqual({ bound10: 1, interval10: 1, bound14: 1, emptySecond: true, isolated: true, restored: true,
    sameContext10: true, sameContext14: true, firstError: 0x3000, secondError: 0x3008,
    restoredAfterRelease: true, swapped: 1, pixel: [255, 0, 0, 255], mainEmpty: true, callbackRestored: true, mainStillEmpty: true,
    readback: { compiled: true, before: [1, 1], after: [2, 2], error: 0, es1: [2, 2], es1Error: 0, unaligned: 0x12345678, integerError: 0 },
    uploads: { lengths: [21, 132], error2D: 0, error3D: 0 },
    clientArrays: { pixels: [[255, 0, 0, 255], [255, 0, 0, 255]], created: 2, error: 0, unbound: true },
    bufferBindings: { outsideKept: true, inVaoKept: true, error: 0 },
    nativeClientArrays: { pixels: [[0, 0, 255, 255], [0, 255, 0, 255], [255, 0, 0, 255]], drawError: 0, kept: true, vaoError: 0x502 },
    externalTexture: { bound: true, error: 0 },
    surfaceTexture: { latched: { matrix: [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1], stamped: true, texel: [255, 0, 0, 255] },
      otherContext: "java/lang/IllegalStateException", deleted: true, attached: [255, 0, 0, 255], released: [1, "java/lang/RuntimeException"] },
    nativeWindow: { locked: 0, dimensions: [2, 1, 2, 1], duplicate: -16, posted: 0, pixels: [255, 0, 0, 255, 0, 255, 0, 255], yv12: true, released: -22, sameHandle: true, reset: true, frames: 2 } });
}, PAGE_TIMEOUT);

// hwui blurs by Blur::convertRadiusToSigma: sigma = 0.57735 * radius + 0.5, 6.27 for a radius of 10
test.concurrent("render effects blur by hwui's sigma, offset a chained input and color-filter the content", async () => {
  const { blurred, shifted, inverted } = await probe("renderEffect");
  const phi = (z: number) => 0.5 * (1 + Math.tanh(0.7978845608 * (z + 0.044715 * z ** 3)));
  for (const x of [22, 26, 30, 34, 38]) expect(Math.abs(blurred[x] - 255 * phi((x + 0.5 - 30) / 6.27))).toBeLessThanOrEqual(8);
  for (const x of [27, 31, 35, 39]) expect(Math.abs(shifted[x] - blurred[x - 5])).toBeLessThanOrEqual(2);
  expect([inverted[10], inverted[50]]).toEqual([255, 0]);
}, PAGE_TIMEOUT);

test.concurrent("runtime shaders preserve recorded uniforms, premultiplied alpha and canvas coordinates", async () => {
  expect(await probe("runtimeShader")).toEqual({
    recorded: [255, 0, 0, 128], outside: [0, 255, 0, 255], direct: [0, 0, 255, 255], invalid: true, recordedRasters: 1, rasterizations: 2, rippleCenter: [255, 0, 0, 128],
    rippleDiff: 0, rippleInked: true,
  });
}, PAGE_TIMEOUT);

test.concurrent("drawGlyphs draws HarfBuzz outlines where the browser draws the same font's text, and color glyphs in color", async () => {
  const { drawn, reference, differing, inked, emoji } = await probe("glyphs");
  drawn.forEach((edge, i) => expect(Math.abs(edge - reference[i])).toBeLessThanOrEqual(1));
  expect(differing).toBeLessThan(inked * 0.05);
  expect(emoji).toBeGreaterThan(200);
}, PAGE_TIMEOUT);

// The pixels are what the reference AVD's BitmapFactory decoded from the same files (a JPEG within
// 2 per channel, as decoders' IDCTs may differ).
const DEVICE_PNG = "ff0000c8 ff1900be ff3200b4 ff4b00aa ff6400a0 3c7b0095 3c95008c 3cae0084 3cc80077 3ce1006e ff0028c8 ff1928be ff3228b4 ff4b28aa ff6428a0 5a7d2896 5a96288b 5ab02882 5ac92877 5ae0286e ff0050c8 ff1950be ff3250b4 ff4b50aa ff6450a0 787d5197 7897518c 78ae5182 78c85177 78e1516e ff0078c8 ff1978be ff3278b4 ff4b78aa ff6478a0 967e7996 9696798b 96af7981 96c97979 96e0796e ff00a0c8 ff19a0be ff32a0b4 ff4ba0aa ff64a0a0 b47da096 b496a08c b4b0a082 b4c8a078 b4e1a06e ff00c8c8 ff19c8be ff32c8b4 ff4bc8aa ff64c8a0 d27dc897 d297c88c d2afc882 d2c8c878 d2e1c86e";
const DEVICE_JPEG = "ff00066f ff0c0972 ff260977 ff400875 ff590775 ff710871 ff880972 ffa00970 ffbd0976 ffcb0b78 ff08267c ff182a80 ff322881 ff4b2781 ff662780 ff7c287e ff95297e ffad297d ffc72980 ffd82b85 ff074e7c ff185081 ff344f84 ff4c4f84 ff664f83 ff7e5081 ff965180 ffae5180 ffc95083 ffd85486 ff08757c ff17787f ff327681 ff4b7581 ff647680 ff7d787f ff95777f ffad7880 ffc87881 ffd67b84 ff089e79 ff17a17d ff33a080 ff4ca07f ff65a080 ff7da07f ff96a27e ffaea17e ffc6a27e ffd7a582 ff12be82 ff23c186 ff3dc08a ff57bf8a ff71c089 ff89c087 ffa0c188 ffb8c286 ffd2c189 ffe2c58d";
test.concurrent("decoded bitmaps, ImageDecoder post-processing and animated frames match the device", async () => {
  const result = await probe("bitmapDecode");
  expect(result.png.map((v) => v.toString(16)).join(" ")).toBe(DEVICE_PNG);
  const channels = (v: number) => [v >>> 24, v >>> 16 & 255, v >>> 8 & 255, v & 255];
  DEVICE_JPEG.split(" ").map((v) => parseInt(v, 16)).forEach((want, i) => {
    for (const [k, c] of channels(want).entries()) expect(Math.abs(channels(result.jpeg[i])[k] - c)).toBeLessThanOrEqual(2);
  });
  expect(result.rotated).toEqual(result.jpeg);
  expect(result).toMatchObject({ truncated: [64, 64], upright: [6, 10], processed: [0xff0000ff, 0],
    invalid: "java.lang.IllegalArgumentException: invalid return from postProcess: -2",
    gif: { still: [255, 0, 0, 255], first: [255, 0, 0, 255], second: [0, 0, 255, 255], running: 1 } });
}, PAGE_TIMEOUT);
