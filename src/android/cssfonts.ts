// Fonts registered with the process realm's text engine. Canvas2D draws text with CSS fonts, so each font
// drawn becomes its own CSS family once loaded, its weight left to CSS when it has a wght axis
// (Chrome sets wght from the requested weight). An axis Chrome would set otherwise than the font
// wants (opsz, which it sets from the size; ital, which it leaves at the default; wdth and slnt
// away from 100 and 0) is pinned in an instance HarfBuzz makes.

import { instanceFace } from "./harfbuzz.ts";
import { type FvarAxis, faceCount, sfntFace } from "./sfnt.ts";
import { type NativeFont, type FakedFont, WGHT, ITAL, pending } from "./fonts.ts";

/** the value Chrome gives an axis on a canvas with a normal stretch and style */
const chromeAxis = (a: FvarAxis) => a.tag === WDTH ? 100 : a.tag === SLNT ? 0 : a.tag === OPSZ ? NaN : a.def;
const WDTH = 0x77647468, SLNT = 0x736c6e74, OPSZ = 0x6f70737a;
const cssFaces = new WeakMap<NativeFont, Map<number, string | Promise<string>>>();
let cssFaceIds = 0;
/** the CSS family that draws `f` as minikin draws it, once registered */
export function cssFace(f: FakedFont): string {
  const font = f.font, ital = f.italic < 0 ? -1 : f.italic;
  let byItal = cssFaces.get(font);
  if (!byItal) cssFaces.set(font, byItal = new Map());
  const face = byItal.get(ital);
  if (typeof face === "string") return face;
  if (face) pending(face);
  const made = registerCss(font, ital).then((name) => { byItal!.set(ital, name); return name; });
  byItal.set(ital, made);
  return pending(made);
}
async function registerCss(font: NativeFont, ital: number): Promise<string> {
  await font.file.load();
  const name = `wd-font-${++cssFaceIds}`;
  if (typeof FontFace === "undefined") return name;
  const fvar = font.fvarAxes, wght = fvar.find((a) => a.tag === WGHT);
  const pins: [number, number][] = [];
  for (const a of fvar) {
    const value = a.tag === ITAL && ital >= 0 ? ital : font.axes.find((x) => x.tag === a.tag)?.value ?? a.def;
    if (a.tag !== WGHT && value !== chromeAxis(a)) pins.push([a.tag, value]);
  }
  const face = faceCount(font.bytes) > 1 || font.ttcIndex ? sfntFace(font.bytes, font.ttcIndex) : font.bytes;
  // a face HarfBuzz cannot instance draws at Chrome's axis values
  const bytes = pins.length ? await instanceFace(font.bytes, font.ttcIndex, pins).catch((e) => {
    console.warn("[fonts] cannot pin axes of", font.path || "an app font", e);
    return face;
  }) : face;
  const m = font.faceMetrics, desc: FontFaceDescriptors = {
    weight: wght ? `${wght.min} ${wght.max}` : String(font.weight),
    style: font.italic || ital === 1 ? "italic" : "normal",
  };
  // keep the browser's line metrics Paint's
  if (m) { desc.ascentOverride = `${m.ascent * 100}%`; desc.descentOverride = `${m.descent * 100}%`; }
  const src = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  try {
    const face = new FontFace(name, src as ArrayBuffer, desc);
    await face.load();
    const fonts = typeof document !== "undefined" ? document.fonts
      : (globalThis as unknown as { fonts: FontFaceSet }).fonts;
    fonts.add(face);
  } catch (e) {
    console.warn("[fonts] FontFace rejected", font.path, e);
  }
  return name;
}

