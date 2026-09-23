import CanvasKitInit from "canvaskit-wasm";
import { version as canvasKitVersion } from "canvaskit-wasm/package.json";
import type { CanvasKit, Font, Paint, Surface, Typeface } from "canvaskit-wasm";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
let kit: CanvasKit | null = null;
let face: Typeface | null = null;
let emojiFace: Typeface | null = null;
let loading: Promise<void> | null = null;
let surface: Surface | null = null;
let surfaceWidth = 0, surfaceHeight = 0;
let bitmap: OffscreenCanvasRenderingContext2D | null = null;
let emojiClips = new Map<number, [number, number]>();
const ligatureGlyphs: Record<string, string> = { fi: "\uFB01", fl: "\uFB02", ffi: "\uFB03", ffl: "\uFB04" };

function inkBounds(font: Font, paint: Paint, glyphs: Uint16Array, x: number, y: number,
  matrix: DOMMatrix, width: number, height: number): [number, number, number, number] | null {
  const bounds = font.getGlyphBounds(glyphs, paint), advances = font.getGlyphWidths(glyphs, paint);
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity, pen = x;
  for (let i = 0; i < glyphs.length; i++) {
    const offset = i * 4;
    if (bounds[offset + 2]! > bounds[offset]! && bounds[offset + 3]! > bounds[offset + 1]!) {
      const x0 = pen + bounds[offset]!, x1 = pen + bounds[offset + 2]!;
      const y0 = y + bounds[offset + 1]!, y1 = y + bounds[offset + 3]!;
      const ax0 = matrix.a * x0, ax1 = matrix.a * x1, cx0 = matrix.c * y0, cx1 = matrix.c * y1;
      const bx0 = matrix.b * x0, bx1 = matrix.b * x1, dx0 = matrix.d * y0, dx1 = matrix.d * y1;
      left = Math.min(left, Math.min(ax0, ax1) + Math.min(cx0, cx1) + matrix.e);
      right = Math.max(right, Math.max(ax0, ax1) + Math.max(cx0, cx1) + matrix.e);
      top = Math.min(top, Math.min(bx0, bx1) + Math.min(dx0, dx1) + matrix.f);
      bottom = Math.max(bottom, Math.max(bx0, bx1) + Math.max(dx0, dx1) + matrix.f);
    }
    pen += advances[i]!;
  }
  if (left === Infinity) return null;
  if (![left, top, right, bottom].every(Number.isFinite)) return [0, 0, width, height];
  return [Math.max(0, Math.floor(left) - 2), Math.max(0, Math.floor(top) - 2),
    Math.min(width, Math.ceil(right) + 2), Math.min(height, Math.ceil(bottom) + 2)];
}

function colorGlyphClips(data: ArrayBuffer): Map<number, [number, number]> {
  const font = new DataView(data), tables = font.getUint16(4);
  let head = 0, colr = 0;
  for (let i = 0; i < tables; i++) {
    const entry = 12 + i * 16, tag = font.getUint32(entry);
    if (tag === 0x68656164) head = font.getUint32(entry + 8);
    if (tag === 0x434f4c52) colr = font.getUint32(entry + 8);
  }
  const clips = new Map<number, [number, number]>();
  if (!head || !colr || font.getUint16(colr) !== 1) return clips;
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

export function loadSkiaText(): Promise<void> {
  return loading ??= Promise.all([
    CanvasKitInit({ locateFile: () => `/canvaskit.wasm?v=${canvasKitVersion}` }),
    fetch("/vendor/fonts/Roboto-Regular.ttf").then(response => response.arrayBuffer()),
    fetch("/vendor/fonts/NotoColorEmoji.ttf").then(response => response.arrayBuffer()),
  ]).then(([canvasKit, data, emojiData]) => {
    const typeface = canvasKit.Typeface.MakeFreeTypeFaceFromData(data);
    if (!typeface) throw new Error("Roboto unavailable to Skia");
    kit = canvasKit; face = typeface;
    emojiFace = canvasKit.Typeface.MakeFreeTypeFaceFromData(emojiData);
    emojiClips = colorGlyphClips(emojiData);
  }).catch(error => {
    kit = null;
    face = emojiFace = null;
    console.warn("[skia-text] CanvasKit unavailable; using Canvas2D text", error);
  });
}

export function drawSkiaText(ctx: Ctx, text: string, x: number, y: number, size: number, color: number,
  style: "fill" | "hairline" = "fill", subpixel = false): boolean {
  if (!kit || !face || !text || !Number.isFinite(size) || size <= 0) return false;
  const shaped = text.replace(/ff[il]|f[il]/g, sequence => ligatureGlyphs[sequence]!);
  const hasLigature = shaped !== text;
  text = shaped;
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
  let font = new kit.Font(face, size);
  let emoji = false;
  let glyphs = font.getGlyphIDs(text);
  let missing = glyphs.some(id => id === 0);
  if (missing) {
    const repaired = text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
    if (repaired !== text) { text = repaired; glyphs = font.getGlyphIDs(text); missing = glyphs.some(id => id === 0); }
  }
  if (missing) {
    font.delete();
    if (!emojiFace) { paint.delete(); canvas.restore(); return false; }
    font = new kit.Font(emojiFace, size);
    emoji = true;
    glyphs = font.getGlyphIDs(text);
    if (glyphs.some(id => id === 0)) {
      font.delete(); paint.delete(); canvas.restore(); return false;
    }
  }
  font.setEdging(kit.FontEdging.AntiAlias);
  font.setHinting(kit.FontHinting.None);
  font.setSubpixel(subpixel && !hasLigature);
  const ink = inkBounds(font, paint, glyphs, x, y, m, width, height);
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
  canvas.drawText(text, x, y, paint, font);
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
