import { awaited, rt, type JObj, type Gen } from "../jvm/runtime.ts";
import { after, vcall, scall } from "../jvm/natives/jentry.ts";
import { toJsArray } from "../jvm/natives/jcoll.ts";
import { onMain } from "./mainloop.ts";
import { isPlatformFont, platformFontBytes, typefaceOf, ITAL, WGHT } from "./fonts.ts";
import { localAsset } from "../shell/localassets.ts";
import type { WebSettingsAdapter } from "./websettings.ts";
import type { WebFonts } from "../shell/webpage/protocol.ts";

// ── the renderer's settings. AwSettings sets Blink's per-script family and size preferences, which a
// host browser does not let a page set: the standard family (a page's default text) and default size
// apply as the document's lowest-precedence style. Every family name of the system font map that is
// no CSS generic (sans-serif-light, arial, times new roman...) is a font face of the device's fonts,
// as Skia's Android font manager resolves a page's family names.
type WebFace = { family: string; path: string; weight: string; style: string; stretch: string };
const GENERIC = new Set(["sans-serif", "serif", "monospace", "cursive", "fantasy"]);
const WDTH = 0x77647468;
/** the faces of `t`'s first family, named `family`. A variable face's weight is its wght range, an
 *  alias's (sans-serif-light) its base weight; an italic made by its ital axis is left to the
 *  browser's oblique, and a set wdth is the face's stretch. */
function typefaceFaces(family: string, t: JObj | null): WebFace[] {
  const typeface = typefaceOf(t), fam = typeface.collection.families[0], base = typeface.baseWeight, out = new Map<string, WebFace>();
  if (!fam) return [];
  const fonts = base === 400 ? fam.fonts : [fam.closest(base, false), fam.closest(base, true)];
  for (const f of fonts) {
    const axes = f.fvarAxes, wght = axes.find((a) => a.tag === WGHT), wdth = f.axes.find((a) => a.tag === WDTH)?.value ?? 100;
    if (f.ttcIndex || f.italic && axes.some((a) => a.tag === ITAL) || !isPlatformFont(f.path)) continue;
    const weight = wght ? base === 400 ? `${wght.min} ${wght.max}` : String(base) : String(f.weight), style = f.italic ? "italic" : "normal";
    out.set(f.path + style, { family, path: f.path, weight, style, stretch: `${wdth}%` });
  }
  return [...out.values()];
}
let systemFaces: Promise<WebFace[]> | null = null;
const standardFaces = new Map<string, Promise<WebFace[]>>();
export async function webFonts(settings: WebSettingsAdapter): Promise<WebFonts> {
  const name = settings.v.standardFontFamily || "sans-serif";
  systemFaces ??= onMain(() => after(scall("android/graphics/Typeface", "getSystemFontMap", "()Ljava/util/Map;"), (map: JObj) => rt.drive(function* (): Gen<WebFace[]> {
    const faces: WebFace[] = [];
    // an ArrayMap's entries are its iterator, so the names are read first
    for (const family of (yield* awaited(toJsArray(yield vcall(map, "keySet", "()Ljava/util/Set;")))) as string[])
      if (!GENERIC.has(family)) faces.push(...typefaceFaces(family, yield vcall(map, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", family)));
    return faces;
  }()))).catch(() => []);
  let standard = standardFaces.get(name);
  // an unknown name is the default family's, as the font manager answers it
  if (!standard) standardFaces.set(name, standard = onMain(() => after(scall("android/graphics/Typeface", "create", "(Ljava/lang/String;I)Landroid/graphics/Typeface;", name, 0),
    (t: JObj) => typefaceFaces("wd-standard", t))).catch(() => []));
  const [system, std] = await Promise.all([systemFaces, standard]), size = settings.v.defaultFontSize;
  const rules = (std.length ? "font-family:wd-standard;" : "") + (size !== 16 ? `font-size:${size}px;` : "");
  return { faces: [...system, ...std], css: rules && `:where(:root){${rules}}` };
}
/** what a frame's worker asks of the app: an apk asset, or a device font its settings use */
export async function webAsset(path: unknown): Promise<{ status: number; bytes?: Uint8Array; type?: string }> {
  if (typeof path !== "string" || !isPlatformFont(path)) return localAsset(path);
  return { status: 200, bytes: await platformFontBytes(path), type: path.endsWith(".otf") ? "font/otf" : "font/ttf" };
}
