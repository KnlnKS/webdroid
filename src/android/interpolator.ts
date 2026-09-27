// android.view.animation's interpolators, interpolator resources as AnimationUtils inflates them
// (the XML tag names the class, its attributes the constructor arguments), and ArgbEvaluator's
// colour interpolation.

import { rt, JObj } from "../jvm/runtime";
import { parseAXML, attr, TV, type XmlNode } from "./axml";
import { rvFloat, namedAttrRV, type Resources } from "./res";
import { flatten, parsePathData } from "./pathdata";
import { pathKeyframeData, type JPath } from "./path";

/** AOSP's AccelerateDecelerateInterpolator, the default for animators and view animations */
export function accelDecel(t: number) { return Math.cos((t + 1) * Math.PI) / 2 + 0.5; }
const lerp = (f: number, a: number, b: number) => a + (b - a) * f;
/** AOSP ArgbEvaluator: per-channel interpolation in linear light (gamma 2.2), alpha linear */
export function argbLerp(f: number, s: number, e: number): number {
  const ch = (c: number, sh: number) => ((c >>> sh) & 0xff) / 255;
  const lin = (c: number) => Math.pow(c, 2.2), gam = (c: number) => Math.pow(c, 1 / 2.2);
  const a = lerp(f, ch(s, 24), ch(e, 24));
  const r = gam(lerp(f, lin(ch(s, 16)), lin(ch(e, 16))));
  const g = gam(lerp(f, lin(ch(s, 8)), lin(ch(e, 8))));
  const b = gam(lerp(f, lin(ch(s, 0)), lin(ch(e, 0))));
  return ((Math.round(a * 255) << 24) | (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255)) | 0;
}

export class JInterpolator extends JObj {
  a = 0; b = 0;
  f: (t: number) => number = (t) => t;
}
const anticipate = (t: number, s: number) => t * t * ((s + 1) * t - s);
const overshoot = (t: number, s: number) => t * t * ((s + 1) * t + s);
const bounce = (t: number) => t * t * 8;
const CURVES: Record<string, (t: number, a: number, b: number) => number> = {
  LinearInterpolator: (t) => t,
  AccelerateDecelerateInterpolator: accelDecel,
  AccelerateInterpolator: (t, a) => a === 1 ? t * t : Math.pow(t, 2 * a),
  DecelerateInterpolator: (t, a) => a === 1 ? 1 - (1 - t) * (1 - t) : 1 - Math.pow(1 - t, 2 * a),
  OvershootInterpolator: (t, a) => overshoot(t - 1, a) + 1,
  AnticipateInterpolator: anticipate,
  AnticipateOvershootInterpolator: (t, a, b) => t < 0.5 ? 0.5 * anticipate(t * 2, a * b) : 0.5 * (overshoot(t * 2 - 2, a * b) + 2),
  BounceInterpolator: (t) => {
    t *= 1.1226;
    return t < 0.3535 ? bounce(t) : t < 0.7408 ? bounce(t - 0.54719) + 0.7 : t < 0.9644 ? bounce(t - 0.8526) + 0.9 : bounce(t - 1.0435) + 0.95;
  },
  CycleInterpolator: (t, a) => Math.sin(2 * Math.PI * a * t),
  PathInterpolator: (t) => t,
};
/** the constructor defaults: tension 2 (and AnticipateOvershoot's extra tension 1.5), else factor 1 */
const DEFAULTS: Record<string, [number, number]> = {
  OvershootInterpolator: [2, 0], AnticipateInterpolator: [2, 0], AnticipateOvershootInterpolator: [2, 1.5],
};

/** PathInterpolator over a curve from (0, 0) to (1, 1) given as points in x order: y at x by
 *  binary search and linear interpolation, as its approximated path is read */
function pathCurve(pts: ArrayLike<number>): (t: number) => number {
  const n = pts.length >> 1;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t < pts[2 * mid]) hi = mid; else lo = mid; }
    const x0 = pts[2 * lo], x1 = pts[2 * hi], span = x1 - x0;
    return span ? pts[2 * lo + 1] + (pts[2 * hi + 1] - pts[2 * lo + 1]) * (t - x0) / span : pts[2 * lo + 1];
  };
}
function bezierCurve(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const pts: number[] = [];
  for (let i = 0; i <= 400; i++) {
    const s = i / 400, u = 1 - s;
    pts.push(3 * u * u * s * x1 + 3 * u * s * s * x2 + s * s * s, 3 * u * u * s * y1 + 3 * u * s * s * y2 + s * s * s);
  }
  return pathCurve(pts);
}
const quadCurve = (x: number, y: number) => bezierCurve(2 / 3 * x, 2 / 3 * y, 1 / 3 + 2 / 3 * x, 1 / 3 + 2 / 3 * y);
const dataCurve = (data: string) => pathCurve(flatten(parsePathData(data)).flat());

for (const n of ["android/view/animation/Interpolator", "android/animation/TimeInterpolator"]) {
  rt.register({ name: n, ctor: class extends JObj {} });
}
function init(it: JInterpolator, name: string, a?: number, b?: number): JInterpolator {
  const fn = CURVES[name], [da, db] = DEFAULTS[name] ?? [1, 0];
  it.a = a ?? da; it.b = b ?? db;
  it.f = (t) => fn(t, it.a, it.b);
  return it;
}
const interpolatorOf = (name: string, a?: number, b?: number) => init(rt.make("android/view/animation/" + name) as JInterpolator, name, a, b);
for (const name of Object.keys(CURVES)) {
  const curve = (f: (t: number) => number) => function (this: JInterpolator) { this.f = f; };
  rt.register({
    name: "android/view/animation/" + name, ctor: class extends JInterpolator {},
    ifaces: ["android/view/animation/Interpolator", "android/animation/TimeInterpolator"],
    methods: {
      "<init>()V": function (this: JInterpolator) { init(this, name); },
      "<init>(F)V": function (this: JInterpolator, a: number) { init(this, name, a); },
      "<init>(FF)V": name === "PathInterpolator"
        ? function (this: JInterpolator, x: number, y: number) { curve(quadCurve(x, y)).call(this); }
        : function (this: JInterpolator, a: number, b: number) { init(this, name, a, b); },
      "<init>(FFFF)V": function (this: JInterpolator, x1: number, y1: number, x2: number, y2: number) { curve(bezierCurve(x1, y1, x2, y2)).call(this); },
      "<init>(Landroid/graphics/Path;)V": function (this: JInterpolator, path: JPath) {
        const data = pathKeyframeData(path);
        curve(pathCurve(data.filter((_, i) => i % 3 !== 0))).call(this);
      },
      "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function (this: JInterpolator) { init(this, name); },
      "getInterpolation(F)F": function (this: JInterpolator, t: number) { return Math.fround(this.f(t)); },
    },
  });
}

const number = (res: Resources, node: XmlNode, name: string, fallback: number) => rvFloat(res, namedAttrRV(res, node, name), fallback);
/** an interpolator resource's root element */
export function interpolatorFromXml(res: Resources, node: XmlNode): JInterpolator {
  const name = node.name[0].toUpperCase() + node.name.slice(1);
  if (!CURVES[name]) throw rt.mkThrowable("java/lang/RuntimeException", "Unknown interpolator name: " + node.name);
  const it = interpolatorOf(name, number(res, node, name === "CycleInterpolator" ? "cycles" : name.endsWith("celerateInterpolator") ? "factor" : "tension", DEFAULTS[name]?.[0] ?? 1),
    number(res, node, "extraTension", DEFAULTS[name]?.[1] ?? 0));
  if (name === "PathInterpolator") {
    const data = attr(node, "pathData")?.str;
    const x1 = number(res, node, "controlX1", 0), y1 = number(res, node, "controlY1", 0);
    it.f = data ? dataCurve(data) : attr(node, "controlX2") ? bezierCurve(x1, y1, number(res, node, "controlX2", 0), number(res, node, "controlY2", 0)) : quadCurve(x1, y1);
  }
  return it;
}
const loaded = new WeakMap<Resources, Map<number, JInterpolator>>();
/** AnimationUtils.loadInterpolator: interpolators are immutable, so one per resource */
export function loadInterpolator(res: Resources, id: number): JInterpolator {
  let cache = loaded.get(res);
  if (!cache) loaded.set(res, cache = new Map());
  let it = cache.get(id);
  if (!it) {
    const file = res.fileOf(id);
    if (!file) throw rt.mkThrowable("android/content/res/Resources$NotFoundException", "Can't load animation resource ID #0x" + id.toString(16));
    cache.set(id, it = interpolatorFromXml(res, parseAXML(file.bytes)));
  }
  return it;
}
/** an element's android:interpolator, which names a resource */
export function interpolatorAttr(res: Resources, node: XmlNode): JInterpolator | null {
  const a = attr(node, "interpolator");
  return a?.type === TV.REFERENCE && a.data ? loadInterpolator(res, a.data) : null;
}
