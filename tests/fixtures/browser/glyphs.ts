import { NativeFont, NativeFamily, NativeTypeface, FontCollection, FakedFont, wrapFont, withFonts } from "../../../src/android/fonts.ts";
import { cssFace } from "../../../src/android/cssfonts.ts";
import { drawGlyphs, shapeTextRun } from "../../../src/android/shaping.ts";
import { NativePaint } from "../../../src/android/paint.ts";
import type { Ctx2D } from "../../../src/android/recording.ts";
import { bootPlatform } from "./boot.ts";

const W = 120, H = 80;
/** ink box of an alpha channel, and how many pixels are saturated color */
function scan(ctx: Ctx2D) {
  const d = ctx.getImageData(0, 0, W, H).data;
  let l = W, t = H, r = -1, b = -1, colored = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] <= 128) continue;
    const x = (i >> 2) % W, y = (i >> 2) / W | 0;
    l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y);
    if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 64) colored++;
  }
  return { ink: [l, t, r, b], alpha: d.filter((_, i) => i % 4 === 3), colored };
}

/** Canvas.drawGlyphs from shaped runs: Roboto's outlines against the browser's fillText of the same
 *  file (ink boxes, and how many pixels one covers and the other does not), and an emoji glyph,
 *  which has no outline, in color */
export default async function glyphs() {
  await bootPlatform();
  const bytes = async (file: string) => new Uint8Array(await (await fetch(`/vendor/aosp/system/fonts/${file}`)).arrayBuffer());
  const roboto = NativeFont.of(await bytes("Roboto-Regular.ttf"), 0, 400, false), emoji = NativeFont.of(await bytes("NotoColorEmoji.ttf"), 0, 400, false);
  const families = [new NativeFamily([roboto]), new NativeFamily([emoji], "und-Zsye")];
  const paint = new NativePaint();
  paint.tf = new NativeTypeface(new FontCollection(families), 400, 0, 400, false); paint.textSize = 40; paint.language = "en-US";
  const draw = async (text: string, ctx: Ctx2D) => {
    const run = await shapeTextRun(text, 0, text.length, 0, text.length, false, paint);
    const positions = Float32Array.from({ length: run.ids.length * 2 }, (_, i) => i & 1 ? 50 : 10 + run.x[i >> 1]);
    await drawGlyphs((run) => run.fill(ctx), Int32Array.from(run.ids), 0, positions, 0, run.ids.length, wrapFont(run.fonts[0].font), paint);
    return run;
  };
  const drawn = new OffscreenCanvas(W, H).getContext("2d")!, reference = new OffscreenCanvas(W, H).getContext("2d")!;
  const run = await draw("Hig", drawn);
  reference.font = `40px "${await withFonts(() => cssFace(new FakedFont(roboto, 0, 400, 0)))}"`;
  for (let i = 0; i < 3; i++) reference.fillText("Hig"[i], 10 + run.x[i], 50);
  const a = scan(drawn), b = scan(reference);
  let differing = 0, inked = 0;
  for (let i = 0; i < a.alpha.length; i++) { if (Math.abs(a.alpha[i] - b.alpha[i]) > 160) differing++; if (b.alpha[i] > 128) inked++; }
  const color = new OffscreenCanvas(W, H).getContext("2d")!;
  await draw("👍", color);
  return { drawn: a.ink, reference: b.ink, differing, inked, emoji: scan(color).colored };
}
