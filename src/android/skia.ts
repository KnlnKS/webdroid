// The tab's CanvasKit, Skia compiled to wasm: SkPathOps and SkStroke for android.graphics.Path, and
// text drawn into bitmaps through FreeType's rasterizer. A process realm uses its page's: the tab's
// realms share one thread, so one wasm heap and one set of fonts serve them all.
import CanvasKitModule from "canvaskit-wasm";
import canvasKitPackage from "canvaskit-wasm/package.json" with { type: "json" };
import type { CanvasKit, Font, Paint, Surface, Typeface, FillType } from "canvaskit-wasm";
import { after } from "../jvm/natives/jentry.ts";
import { servedFont, platformFontBytes } from "./fonts.ts";
import { sfntTables, ownBuffer, T_COLR, T_HEAD } from "./sfnt.ts";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
let kit: CanvasKit | null = null;
let kitLoading: Promise<CanvasKit> | null = null;
// its types declare an ES default export of what is the CommonJS module.exports
const CanvasKitInit = CanvasKitModule as unknown as typeof CanvasKitModule.default;
let face: Typeface | null = null;
let emojiFace: Typeface | null = null;
let loading: Promise<void> | null = null;
let surface: Surface | null = null;
let surfaceWidth = 0, surfaceHeight = 0;
let bitmap: OffscreenCanvasRenderingContext2D | null = null;
let emojiClips = new Map<number, [number, number]>();
/** the system faces this draws text in */
export const SKIA_TEXT_FACE = servedFont("/system/fonts/Roboto-Regular.ttf"), SKIA_EMOJI_FACE = servedFont("/system/fonts/NotoColorEmoji.ttf");
/** SkPathFillType by value: CanvasKit's binding names the two plain types, SkPath takes all four */
let fillTypes: FillType[] = [];

function canvasKit(): CanvasKit | Promise<CanvasKit> {
  return kit ?? (kitLoading ??= CanvasKitInit({
    locateFile: (file) => typeof location !== "undefined" && location.protocol.startsWith("http") ? `/${file}?v=${canvasKitPackage.version}`
      : `${process.cwd()}/node_modules/canvaskit-wasm/bin/${file}`,
  }).then((k) => {
    const plain = k.FillType.Winding, values = (k.FillType as unknown as { values: FillType[] }).values;
    for (const v of [2, 3]) values[v] = Object.create(Object.getPrototypeOf(plain), { value: { value: v } });
    fillTypes = [0, 1, 2, 3].map((v) => values[v]);
    return kit = k;
  }));
}

/** CanvasKit path commands, verb then points: 0 move, 1 line, 2 quad, 3 conic (with its weight), 4 cubic, 5 close */
export type PathCommands = number[] | Float32Array;
/** SkPathOps' Op over two paths of the given SkPathFillTypes: the result's commands and fill type,
 *  or null where Skia finds none */
export function pathOp(a: PathCommands, aFill: number, b: PathCommands, bFill: number, op: number): { cmds: Float32Array; fill: number } | null | Promise<{ cmds: Float32Array; fill: number } | null> {
  return after(canvasKit(), (k) => {
    const pa = k.Path.MakeFromCmds(a), pb = k.Path.MakeFromCmds(b);
    try {
      if (!pa || !pb) return null;
      pa.setFillType(fillTypes[aFill]); pb.setFillType(fillTypes[bFill]);
      return pa.op(pb, [k.PathOp.Difference, k.PathOp.Intersect, k.PathOp.Union, k.PathOp.XOR, k.PathOp.ReverseDifference][op])
        ? { cmds: pa.toCmds(), fill: pa.getFillType().value } : null;
    } finally { pa?.delete(); pb?.delete(); }
  });
}
/** SkStroke: a path's outline at the stroke's width, cap and join (Paint's ordinals), as commands */
export function strokeCommands(cmds: PathCommands, width: number, miter: number, cap: number, join: number): Float32Array | null | Promise<Float32Array | null> {
  return after(canvasKit(), (k) => {
    const path = k.Path.MakeFromCmds(cmds);
    if (!path) return null;
    try {
      return path.stroke({ width, miter_limit: miter, precision: 1, cap: [k.StrokeCap.Butt, k.StrokeCap.Round, k.StrokeCap.Square][cap],
        join: [k.StrokeJoin.Miter, k.StrokeJoin.Round, k.StrokeJoin.Bevel][join] }) ? path.toCmds() : null;
    } finally { path.delete(); }
  });
}

function inkBounds(font: Font, paint: Paint, glyphs: Uint16Array, positions: Float32Array, x: number, y: number,
  matrix: DOMMatrix, width: number, height: number): [number, number, number, number] | null {
  const bounds = font.getGlyphBounds(glyphs, paint);
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let i = 0; i < glyphs.length; i++) {
    const offset = i * 4, gx = x + positions[i * 2], gy = y + positions[i * 2 + 1];
    if (bounds[offset + 2]! > bounds[offset]! && bounds[offset + 3]! > bounds[offset + 1]!) {
      const x0 = gx + bounds[offset]!, x1 = gx + bounds[offset + 2]!;
      const y0 = gy + bounds[offset + 1]!, y1 = gy + bounds[offset + 3]!;
      const ax0 = matrix.a * x0, ax1 = matrix.a * x1, cx0 = matrix.c * y0, cx1 = matrix.c * y1;
      const bx0 = matrix.b * x0, bx1 = matrix.b * x1, dx0 = matrix.d * y0, dx1 = matrix.d * y1;
      left = Math.min(left, Math.min(ax0, ax1) + Math.min(cx0, cx1) + matrix.e);
      right = Math.max(right, Math.max(ax0, ax1) + Math.max(cx0, cx1) + matrix.e);
      top = Math.min(top, Math.min(bx0, bx1) + Math.min(dx0, dx1) + matrix.f);
      bottom = Math.max(bottom, Math.max(bx0, bx1) + Math.max(dx0, dx1) + matrix.f);
    }
  }
  if (left === Infinity) return null;
  if (![left, top, right, bottom].every(Number.isFinite)) return [0, 0, width, height];
  return [Math.max(0, Math.floor(left) - 2), Math.max(0, Math.floor(top) - 2),
    Math.min(width, Math.ceil(right) + 2), Math.min(height, Math.ceil(bottom) + 2)];
}

function colorGlyphClips(data: ArrayBuffer): Map<number, [number, number]> {
  const tables = sfntTables(new Uint8Array(data), 0), clips = new Map<number, [number, number]>();
  const font = tables?.dv, head = tables?.at.get(T_HEAD), colr = tables?.at.get(T_COLR);
  if (!font || !head || !colr || font.getUint16(colr) !== 1) return clips;
  const units = font.getUint16(head + 18), list = colr + font.getUint32(colr + 22);
  for (let i = 0, count = font.getUint32(list + 1); i < count; i++) {
    const record = list + 5 + i * 7;
    const start = font.getUint16(record), end = font.getUint16(record + 2);
    const box = list + (font.getUint16(record + 4) << 8) + font.getUint8(record + 6);
    if (font.getUint8(box) !== 1) continue;
    const limits: [number, number] = [font.getInt16(box + 7) / units, -font.getInt16(box + 3) / units];
    for (let glyph = start; glyph <= end; glyph++) clips.set(glyph, limits);
  }
  return clips;
}

/** CanvasKit and the faces it draws bitmap text in, loaded once per realm; text falls back to Canvas2D
 *  without them */
export function loadSkia(): Promise<void> {
  return loading ??= Promise.all([
    canvasKit(),
    platformFontBytes(SKIA_TEXT_FACE).then(ownBuffer),
    platformFontBytes(SKIA_EMOJI_FACE).then(ownBuffer),
  ]).then(([canvasKit, data, emojiData]) => {
    const typeface = canvasKit.Typeface.MakeFreeTypeFaceFromData(data);
    if (!typeface) throw new Error("Roboto unavailable to Skia");
    face = typeface;
    emojiFace = canvasKit.Typeface.MakeFreeTypeFaceFromData(emojiData);
    emojiClips = colorGlyphClips(emojiData);
  }).catch(error => {
    face = emojiFace = null;
    console.warn("[skia] CanvasKit text unavailable; using Canvas2D text", error);
  });
}

/** SkCanvas::drawGlyphs of one face's laid-out glyphs (minikin's ids, and positions from the run's
 *  origin) through FreeType's rasterizer into a bitmap's context; false where CanvasKit cannot */
export function drawSkiaText(ctx: Ctx, emoji: boolean, glyphs: Uint16Array, positions: Float32Array, x: number, y: number, size: number, color: number,
  style: "fill" | "hairline", subpixel: boolean): boolean {
  const typeface = emoji ? emojiFace : face;
  if (!kit || !typeface || !glyphs.length || !Number.isFinite(size) || size <= 0) return false;
  const width = ctx.canvas.width, height = ctx.canvas.height;
  if (!width || !height || width * height > 250_000) return false;
  if (!surface || surfaceWidth !== width || surfaceHeight !== height) {
    surface?.delete();
    surface = kit.MakeSurface(width, height);
    surfaceWidth = width; surfaceHeight = height;
  }
  if (!surface) return false;
  const canvas = surface.getCanvas();
  canvas.clear(kit.TRANSPARENT);
  const m = ctx.getTransform();
  canvas.save();
  canvas.concat([m.a, m.c, m.e, m.b, m.d, m.f, 0, 0, 1]);
  const paint = new kit.Paint();
  paint.setColor(kit.Color((color >>> 16) & 255, (color >>> 8) & 255, color & 255, (color >>> 24) / 255));
  if (style === "hairline") { paint.setStyle(kit.PaintStyle.Stroke); paint.setStrokeWidth(0); }
  const font = new kit.Font(typeface, size);
  font.setEdging(kit.FontEdging.AntiAlias);
  font.setHinting(kit.FontHinting.None);
  font.setSubpixel(subpixel);
  const ink = inkBounds(font, paint, glyphs, positions, x, y, m, width, height);
  if (emoji && m.b && m.c && Math.abs(m.a * m.d - m.b * m.c - 1) > 1e-3) {
    let top = -Infinity, bottom = -Infinity;
    for (const glyph of glyphs) {
      const clip = emojiClips.get(glyph);
      if (clip) { top = Math.max(top, clip[0]); bottom = Math.max(bottom, clip[1]); }
    }
    const shear = m.b + m.c;
    const scale = Math.max(0.5, Math.min(1.1, shear < 0
      ? 1 + 0.33 * shear - 0.08 * (m.b - 0.5) : 1 + 0.025 * shear));
    if (top !== -Infinity) {
      // Android clips COLRv1 layers at the font's clip box under asymmetric shears.
      const topScale = scale - (shear < 0 && m.c > -1 && m.b >= 0.5 ? Math.max(0, 0.9 - top) * 0.7 : 0);
      canvas.clipRect(kit.LTRBRect(-width * 4,
        y - size * topScale * top, width * 4,
        y + size * (scale + Math.max(0, shear) * 0.1) * bottom), kit.ClipOp.Intersect, true);
    }
  }
  canvas.drawGlyphs(glyphs, positions, x, y, font, paint);
  canvas.restore();
  font.delete(); paint.delete();
  if (!ink) return true;
  const [left, top, right, bottom] = ink;
  const inkWidth = right - left, inkHeight = bottom - top;
  if (inkWidth <= 0 || inkHeight <= 0) return true;
  const pixels = canvas.readPixels(left, top, { width: inkWidth, height: inkHeight, colorType: kit.ColorType.RGBA_8888,
    alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
  if (!(pixels instanceof Uint8Array)) return false;
  if (style === "fill" && !emoji && Math.min((color >>> 16) & 255, (color >>> 8) & 255, color & 255) >= 200)
    for (let i = 3; i < pixels.length; i += 4)
      pixels[i] = Math.round(255 * (pixels[i]! / 255) ** 1.5);
  const rgba = pixels.buffer instanceof ArrayBuffer
    ? new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength)
    : new Uint8ClampedArray(pixels);
  if (!bitmap || bitmap.canvas.width < inkWidth || bitmap.canvas.height < inkHeight)
    bitmap = new OffscreenCanvas(Math.max(bitmap?.canvas.width ?? 0, inkWidth),
      Math.max(bitmap?.canvas.height ?? 0, inkHeight)).getContext("2d");
  if (!bitmap) return false;
  bitmap.putImageData(new ImageData(rgba, inkWidth, inkHeight), 0, 0);
  ctx.save();
  try { ctx.resetTransform(); ctx.drawImage(bitmap.canvas, 0, 0, inkWidth, inkHeight, left, top, inkWidth, inkHeight); }
  finally { ctx.restore(); }
  return true;
}
