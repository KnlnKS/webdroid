// Fonts registered with the process realm's text engine. Canvas2D draws text with CSS fonts, so each font
// drawn becomes its own CSS family once loaded, its weight left to CSS when it has a wght axis
// (Chrome sets wght from the requested weight). An axis Chrome would set otherwise than the font
// wants (opsz, which it sets from the size; ital, which it leaves at the default; wdth and slnt
// away from 100 and 0) is pinned in an instance HarfBuzz makes.

import { instanceFace } from "./harfbuzz.ts";
import { type FvarAxis, faceCount, ownBuffer, sfntFace } from "./sfnt.ts";
import { type NativeFont, type FakedFont, type NativeTypeface, WGHT, ITAL, WDTH, pending, isPlatformFont, resolveDefault, withFonts } from "./fonts.ts";
import { whenMainIdle } from "./mainloop.ts";
import { PLATFORM_DATA } from "../jvm/bootclasspath.ts";

/** the value Chrome gives an axis on a canvas with a normal stretch and style */
const chromeAxis = (a: FvarAxis) => a.tag === WDTH ? 100 : a.tag === SLNT ? 0 : a.tag === OPSZ ? NaN : a.def;
const SLNT = 0x736c6e74, OPSZ = 0x6f70737a;
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
/** a fallback font file this large holds up the frame that first draws text in it: Komikku's 32 MB CJK collection took a 23–51 ms read and a 10–16 ms FontFace */
const READ_AHEAD_BYTES = 1 << 20;
/** Reads the default typeface's large fallback font files while the main thread is idle, as a device has them on disk, and registers the CSS face of the first
 *  family drawing from each, which text in them would otherwise wait for */
export function readAheadFonts(): void {
  const seen = new Set<string>(), typeface: NativeTypeface | undefined = resolveDefault(null);
  for (const family of typeface?.collection.families ?? []) {
    const f = family.match(400, false), path = f.font.path;
    if (seen.has(path) || !isPlatformFont(path) || PLATFORM_DATA[path] < READ_AHEAD_BYTES) continue;
    seen.add(path);
    whenMainIdle(() => void f.font.file.load().then(() => whenMainIdle(() => void withFonts(() => cssFace(f)))).catch(() => {}));
  }
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
  try {
    const face = new FontFace(name, ownBuffer(bytes), desc);
    await face.load();
    const fonts = typeof document !== "undefined" ? document.fonts
      : (globalThis as unknown as { fonts: FontFaceSet }).fonts;
    fonts.add(face);
  } catch (e) {
    console.warn("[fonts] FontFace rejected", font.path, e);
  }
  return name;
}

