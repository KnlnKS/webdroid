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
  const bundle = build.outputs[0];
  server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/framework.apk") return new Response(Bun.file(`${import.meta.dir}/../vendor/aosp/framework-res.apk`));
    if (path === "/harfbuzz.wasm") return new Response(Bun.file(`${import.meta.dir}/../node_modules/harfbuzzjs/dist/harfbuzz.wasm`));
    if (path.startsWith("/vendor/aosp/") || path.startsWith("/vendor/fonts/")) return new Response(Bun.file(`${import.meta.dir}/..${path}`));
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
    const result: unknown = await page.evaluate(([url, name]) => import(url).then((module) => module[name]()), ["/index.js", name]);
    expect(errors).toEqual([]);
    return result as Awaited<ReturnType<Probes[K]>>;
  } finally { await page.close(); }
}

test.concurrent("Back waits for a suspended main job before dispatching to the top window", async () => {
  expect(await probe("back")).toEqual({ pending: ["start"], events: ["start", "end", "back"] });
}, PAGE_TIMEOUT);

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
}, PAGE_TIMEOUT);

test.concurrent("framework seek resources resolve dimensions, tint, enabled states and vector group transforms", async () => {
  const result = await probe("drawableResources");
  expect(result).toMatchObject({ heights: [6, 6, 6], above: [0, 0, 0, 0], outside: [0, 0, 0, 0], restored: true,
    rotated: [[255, 0, 0, 255], [0, 0, 0, 0]], absolute: [[255, 0, 0, 255], [0, 0, 0, 0]], dialogCenter: [255, 0, 0, 255] });
  expect(result.before[3]).toBe(255);
  expect(result.after[3]).toBeGreaterThan(0);
  expect(result.after[3]).toBeLessThan(255);
  expect(result.center[3]).toBe(128);
}, PAGE_TIMEOUT);

test.concurrent("drawable spans align suspended virtual drawing and text shadows preserve state", async () => {
  const result = await probe("drawableSpan");
  for (const span of result.results) expect(span).toEqual({ width: 14, fm: { ascent: -17, top: -17, descent: 0, bottom: 0 }, loads: 1, draws: 1, aligned: true, restored: true, hierarchy: 1 });
  expect(result).toMatchObject({ getters: [1, 10, 2, 0xffff0000], red: true, shadowRestored: true });
}, PAGE_TIMEOUT);

test.concurrent("EGL10 and EGL14 retain each thread's binding, GL objects and errors across suspension and release", async () => {
  expect(await probe("eglThread")).toEqual({ callbacks: [true, true, true], bound10: 1, interval10: 1, bound14: 1, emptySecond: true, isolated: true, restored: true,
    sameContext10: true, sameContext14: true, firstError: 0x3000, secondError: 0x3008,
    restoredAfterRelease: true, swapped: 1, pixel: [255, 0, 0, 255], mainEmpty: true, callbackRestored: true, mainStillEmpty: true, lifecycle: true,
    readback: { compiled: true, before: [1, 1], after: [2, 2], error: 0, es1: [2, 2], es1Error: 0, unaligned: 0x12345678, integerError: 0 },
    uploads: { lengths: [21, 132], error2D: 0, error3D: 0 },
    clientArrays: { pixels: [[255, 0, 0, 255], [255, 0, 0, 255]], created: 2, error: 0, unbound: true },
    bufferBindings: { outsideKept: true, inVaoKept: true, error: 0 },
    nativeClientArrays: { pixels: [[0, 0, 255, 255], [0, 255, 0, 255], [255, 0, 0, 255]], drawError: 0, kept: true, vaoError: 0x502 },
    externalTexture: { bound: true, error: 0 },
    nativeWindow: { locked: 0, dimensions: [2, 1, 2, 1], duplicate: -16, posted: 0, pixels: [255, 0, 0, 255, 0, 255, 0, 255], yv12: true, released: -22, sameHandle: true, reset: true, frames: 2 },
    windowCopy: { before: { code: 0, pixel: [0, 255, 0, 255] }, after: { code: 0, pixel: [255, 0, 0, 255] } } });
}, PAGE_TIMEOUT);

test.concurrent("ImageView reports and draws scale-type matrices and copies custom transforms", async () => {
  const { results, reset } = await probe("imageView");
  const expected = [[2, 0, 0, 3, 5, 7], [1, 0, 0, 1, 0, 0], [4.7, 0, 0, 4.7, 0, 0],
    [4.7, 0, 0, 4.7, 0, 12.5], [4.7, 0, 0, 4.7, 0, 25], [1, 0, 0, 1, 37, 31],
    [7.2, 0, 0, 7.2, -25, 0], [1, 0, 0, 1, 37, 31]];
  for (let i = 0; i < expected.length; i++) {
    expect(results[i].type).toBe(i);
    for (let j = 0; j < 6; j++) expect(results[i].matrix[j]).toBeCloseTo(expected[i][j], 5);
    for (let j = 0; j < 6; j++) expect(results[i].transform[j]).toBeCloseTo(expected[i][j] + (j === 4 ? 2 : j === 5 ? 3 : 0), 5);
    expect(results[i].bounds).toEqual([0, 0, i === 1 ? 94 : 20, i === 1 ? 72 : 10]);
    expect(results[i].restored).toBe(true);
  }
  expect(results[0].pixel).toEqual([0, 255, 0, 255]);
  expect(reset).toEqual([1, 0, 0, 1, 0, 0]);
}, PAGE_TIMEOUT);

test.concurrent("runtime shaders preserve recorded uniforms, premultiplied alpha and canvas coordinates", async () => {
  expect(await probe("runtimeShader")).toEqual({
    recorded: [255, 0, 0, 128], outside: [0, 255, 0, 255], direct: [0, 0, 255, 255], invalid: true, recordedRasters: 1, rasterizations: 2, text: [14, 39],
  });
}, PAGE_TIMEOUT);

test.concurrent("SeekBar draws its level track and thumb, and touch callbacks retain their dispatch thread", async () => {
  expect(await probe("seekBar")).toEqual({ before: [0, 0, 255, 255], thumb: [0, 255, 0, 255], after: [51, 51, 51, 255], above: [0, 0, 0, 0],
    restored: true, events: [["start", true], [75, 1, true], [90, 1, true], ["stop", true]], progress: 90, pressed: false });
}, PAGE_TIMEOUT);

test.concurrent("TextView measures and paints replacement spans with cached layouts and ellipsizes", async () => {
  const result = await probe("textView");
  expect(result).toMatchObject({ remeasured: 0, draws: 1, width: 24, center: [0, 255, 0, 255], outside: [0, 0, 0, 0], layout: true,
    ellipsized: true, cached: true, fitting: [1, 0], styles: [true, true, true],
    compound: { drawsAt: [[2, 30], [51, 31], [24, 3], [23, 60]], retained: [[2, 3, 8, 11], [1, 2, 11, 8], [0, 0, 5, 7], [2, 1, 14, 6]], restored: true },
    emptySelection: 0, independentCanvas: true, checkBoxHeight: 48, caretAtStart: true, cursorIdentity: true,
    cursorPixels: [255, 0, 0, 255], cursorCleared: true });
  expect(result.height).toBeGreaterThanOrEqual(32);
  expect(result.heightLimits).toEqual([20, 25, result.height]);
  expect(result.alignment.centers[0]).toBeLessThan(20);
  expect(result.alignment.centers[1]).toBeGreaterThan(45);
  expect(result.alignment.centers[1]).toBeLessThan(55);
  expect(result.alignment.centers[2]).toBeGreaterThan(80);
  expect(result.alignment).toMatchObject({ own: 4, relative: [5, 3, 5, 3] });
  expect(result.combined).toMatchObject({ original: "a ß replacement trailing words", same: true, pixels: true });
  expect(result.combined.width).toBeLessThanOrEqual(80);
  expect(result.combined.ellipsis).toBeGreaterThan(0);
  expect(result.selection.length).toBeGreaterThan(0);
}, PAGE_TIMEOUT);

test.concurrent("drawGlyphs draws HarfBuzz outlines where the browser draws the same font's text, and color glyphs in color", async () => {
  const { drawn, reference, differing, inked, emoji } = await probe("glyphs");
  drawn.forEach((edge, i) => expect(Math.abs(edge - reference[i])).toBeLessThanOrEqual(1));
  expect(differing).toBeLessThan(inked * 0.05);
  expect(emoji).toBeGreaterThan(200);
}, PAGE_TIMEOUT);
