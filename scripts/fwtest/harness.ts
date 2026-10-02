// What every fwtest exercise shares: the runner that reports what the real bytecode reached, and
// the comparisons against values the reference AVD printed for the same calls.
import { rt, JObj, declaredField } from "../../src/jvm/runtime";
import { vcall, linkInit } from "../../src/jvm/natives/jlang";
import { mangleMethod } from "../../src/jvm/abi";

const reached: string[] = [];
rt.onMissing = (w) => { reached.push(w); };

/** run `fn`, reporting it ok, MISS (it reached natives we do not answer) or FAIL */
export async function exercise(name: string, fn: () => Promise<void>) {
  const before = reached.length;
  try {
    await fn();
    const missed = reached.slice(before);
    console.log(`${missed.length ? "MISS" : "ok  "} ${name}${missed.length ? "  " + missed.slice(0, 3).join(" ") : ""}`);
  } catch (e) {
    const msg = e instanceof Error ? String(e) : String(await vcall(e, "toString", "()Ljava/lang/String;"));
    console.log(`FAIL ${name}  ${msg.split("\n")[0].slice(0, 150)}`);
  }
}

export function same(what: string, got: unknown, want: unknown) {
  if (String(got) !== String(want)) throw new Error(`${what}: ${got}, not ${want}`);
}
/** each of `got` within `tol` (relative, at least absolute) of `want` */
export function near(what: string, got: number[], want: number[], tol = 1e-5) {
  if (got.length !== want.length || got.some((g, i) => Math.abs(g - want[i]) > tol * Math.max(1, Math.abs(want[i])))) throw new Error(`${what}: [${got}], not [${want}]`);
}
/** "ok", or the Java throwable `f` threw as its toString(); a JS error is the exercise's own failure */
export async function thrown(f: () => Promise<unknown>): Promise<string> {
  try { await f(); return "ok"; } catch (e) {
    if (e instanceof Error) throw e;
    return String(await vcall(e, "toString", "()Ljava/lang/String;"));
  }
}

/** a class's statics, initialized: they live on the constructor, mangled */
export const statics = async (cls: string) => (await linkInit(cls)).ctor as Record<string, any>;
/** a listener object answering `name` with `fn` */
export const listener = (name: string, desc: string, fn: (...a: any[]) => unknown) => Object.assign(rt.make("java/lang/Object") as JObj, { [mangleMethod(name, desc)]: fn });
/** a Java Paint.FontMetrics' (or FontMetricsInt's) top, ascent, descent, bottom and leading */
export const fontMetrics = (fm: object, cls = "FontMetrics") =>
  ["top", "ascent", "descent", "bottom", "leading"].map((k) => (fm as Record<string, number>)[declaredField(`android/graphics/Paint$${cls}`, k)]);

const vectorProbe = (await Bun.file("tests/fixtures/vector-drawable.txt").text()).trim().split("\n");
/** VectorDrawableProbe's lines with `tag` (scripts/vector-probe.ts), the tag removed */
export const vectorProbeLines = (tag: string) => vectorProbe.filter((l) => l.startsWith(tag + " ")).map((l) => l.slice(tag.length + 1));
/** a Java Rect's (or RectF's) left, top, right and bottom: instance fields are mangled properties */
export const ltrb = (r: object, cls: "Rect" | "RectF" = "Rect") =>
  ["left", "top", "right", "bottom"].map((k) => (r as Record<string, number>)[declaredField(`android/graphics/${cls}`, k)]);
