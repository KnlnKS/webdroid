// What every fwtest exercise shares: the runner that reports what the real bytecode reached, and
// the comparisons against values the reference AVD printed for the same calls.
import { readFileSync } from "node:fs";
import type { DexFile } from "../../src/jvm/dex.ts";
import { rt, JObj, declaredField } from "../../src/jvm/runtime.ts";
import { vcall, scall, linkInit, staticField, classNameOf } from "../../src/jvm/natives/jentry.ts";

const reached: string[] = [];
/** how a harness makes dex files known to the Java that runs: the driver gives its World's */
export const loader = { loadDex: (_dex: DexFile): void => { throw new Error("no World to load into"); } };
rt.onMissing = (w) => { reached.push(w); };

/** what each exercise reported, for a driver that compares them with its expectations */
export const results: { name: string; status: "ok" | "MISS" | "FAIL"; detail: string }[] = [];
/** run `fn`, reporting it ok, MISS (it reached natives we do not answer) or FAIL */
export async function exercise(name: string, fn: () => Promise<void>) {
  const before = reached.length;
  try {
    await fn();
    const missed = reached.slice(before);
    console.log(`${missed.length ? "MISS" : "ok  "} ${name}${missed.length ? "  " + missed.slice(0, 3).join(" ") : ""}`);
    results.push({ name, status: missed.length ? "MISS" : "ok", detail: missed.slice(0, 3).join(" ") });
  } catch (e) {
    let msg: string;
    try { msg = e instanceof Error ? String(e) : String(await vcall(e, "toString", "()Ljava/lang/String;")); } catch { msg = `${classNameOf(e)}: ${(e as { msg?: string }).msg}`; }
    console.log(`FAIL ${name}  ${msg.split("\n")[0].slice(0, 150)}`);
    results.push({ name, status: "FAIL", detail: msg.split("\n")[0].slice(0, 150) });
    if (process.env.FWTEST_STACK) {
      for (let t: unknown = e; t; t = t instanceof Error ? null : await vcall(t, "getCause", "()Ljava/lang/Throwable;")) {
        const frames = t instanceof Error ? [t.stack] : [await vcall(t, "toString", "()Ljava/lang/String;"), ...((await vcall(t, "getStackTrace", "()[Ljava/lang/StackTraceElement;")) as unknown[]).slice(0, 12)];
        for (const f of frames) console.log("    " + (typeof f === "string" ? f : await vcall(f, "toString", "()Ljava/lang/String;")));
      }
    }
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
export async function thrown(f: () => unknown): Promise<string> {
  try { await f(); return "ok"; } catch (e) {
    if (e instanceof Error) throw e;
    return String(await vcall(e, "toString", "()Ljava/lang/String;"));
  }
}

/** the java.lang.Class of the named class, the way the language names it */
export const classMirror = (name: string) => scall("java/lang/Class", "forName", "(Ljava/lang/String;)Ljava/lang/Class;", name.replaceAll("/", "."));
/** a class's statics, initialized, by mangled name (`s$NAME`, as mangleStaticField spells it) */
export const statics = async (cls: string) => {
  await linkInit(cls);
  return new Proxy({} as Record<string, any>, { get: (_, key) => typeof key === "string" && key.startsWith("s$") ? staticField(cls, key.slice(2)) : undefined });
};
/** an object of a class that implements the interface `iface`, answering `name` with `fn` */
let listeners = 0;
export const listener = (iface: string, name: string, desc: string, fn: (...a: any[]) => unknown) => {
  const cls = "fwtest/Listener" + listeners++;
  rt.register({ name: cls, ctor: class extends JObj {}, ifaces: [iface], methods: { [name + desc]: fn } });
  return rt.make(cls);
};
/** a Java Paint.FontMetrics' (or FontMetricsInt's) top, ascent, descent, bottom and leading */
export const fontMetrics = (fm: object, cls = "FontMetrics") =>
  ["top", "ascent", "descent", "bottom", "leading"].map((k) => (fm as Record<string, number>)[declaredField(`android/graphics/Paint$${cls}`, k)]);

const vectorProbe = readFileSync("tests/fixtures/vector-drawable.txt", "utf8").trim().split("\n");
/** VectorDrawableProbe's lines with `tag` (scripts/vector-probe.ts), the tag removed */
export const vectorProbeLines = (tag: string) => vectorProbe.filter((l) => l.startsWith(tag + " ")).map((l) => l.slice(tag.length + 1));
/** a Java Rect's (or RectF's) left, top, right and bottom: instance fields are mangled properties */
export const ltrb = (r: object, cls: "Rect" | "RectF" = "Rect") =>
  ["left", "top", "right", "bottom"].map((k) => (r as Record<string, number>)[declaredField(`android/graphics/${cls}`, k)]);
