// VectorDrawable's tree, how it draws, and AnimatedVectorDrawable's timelines. A group or path
// with an android:name is an animation target; each target's animator XML becomes a timeline
// evaluated at the time since start(), as the ObjectAnimators AOSP builds would set those
// properties.

import { parseAXML, TV, type XmlNode } from "./axml";
import { namedAttrRV, rvColor, rvFloat, rvInt, type Resources, type RV } from "./res";
import { canMorph, flatten, morph, parsePathData, pathDataString, trimmed, type PathNode } from "./pathdata";
import { cssColor } from "./graphics";
import type { Ctx2D } from "./recording";
import { accelDecel, argbLerp, interpolatorAttr } from "./interpolator";

export interface VGroup {
  name: string; rotation: number; pivotX: number; pivotY: number; scaleX: number; scaleY: number; translateX: number; translateY: number;
  children: (VGroup | VPath)[];
}
export interface VPath {
  name: string; clip: boolean; nodes: PathNode[]; path: Path2D | null;
  fillColor: number | null; strokeColor: number | null; strokeWidth: number; strokeAlpha: number; fillAlpha: number;
  trimPathStart: number; trimPathEnd: number; trimPathOffset: number;
  cap: CanvasLineCap; join: CanvasLineJoin; miter: number; evenOdd: boolean;
}
/** the vector's root: its android:alpha animates as the root's "alpha" */
export interface VRoot extends VGroup { alpha: number }
const isPath = (n: VGroup | VPath): n is VPath => "nodes" in n;

export function cloneTree<T extends VGroup>(g: T): T {
  return { ...g, children: g.children.map((c) => isPath(c) ? { ...c } : cloneTree(c)) };
}
/** the named groups and paths, as AVD targets find them */
export function namedTargets(g: VGroup, into = new Map<string, VGroup | VPath>()): Map<string, VGroup | VPath> {
  if (g.name) into.set(g.name, g);
  for (const c of g.children) if (!isPath(c)) namedTargets(c, into); else if (c.name) into.set(c.name, c);
  return into;
}

/** a tint replaces the colour and keeps the path's alpha, as SRC_IN does */
export const tinted = (color: number, tint: number | null) => tint === null ? color : (tint & 0xffffff) | Math.round((tint >>> 24) * (color >>> 24) / 255) << 24;
export function drawVectorGroup(ctx: Ctx2D, g: VGroup, tint: number | null, alpha: number) {
  ctx.save();
  ctx.translate(g.translateX + g.pivotX, g.translateY + g.pivotY);
  ctx.rotate(g.rotation * Math.PI / 180);
  ctx.scale(g.scaleX, g.scaleY);
  ctx.translate(-g.pivotX, -g.pivotY);
  for (const c of g.children) {
    if (!isPath(c)) { drawVectorGroup(ctx, c, tint, alpha); continue; }
    const path = c.trimPathStart !== 0 || c.trimPathEnd !== 1 ? trimmed(c.nodes, c.trimPathStart, c.trimPathEnd, c.trimPathOffset)
      : c.path ??= new Path2D(pathDataString(c.nodes));
    // a clip-path clips the rest of its group
    if (c.clip) { ctx.clip(path); continue; }
    if (c.fillColor !== null && c.fillColor >>> 24) {
      ctx.fillStyle = cssColor(tinted(c.fillColor, tint));
      ctx.globalAlpha = alpha * c.fillAlpha;
      ctx.fill(path, c.evenOdd ? "evenodd" : "nonzero");
    }
    if (c.strokeColor !== null && c.strokeColor >>> 24 && c.strokeWidth > 0) {
      ctx.strokeStyle = cssColor(tinted(c.strokeColor, tint));
      ctx.globalAlpha = alpha * c.strokeAlpha;
      ctx.lineWidth = c.strokeWidth; ctx.lineCap = c.cap; ctx.lineJoin = c.join; ctx.miterLimit = c.miter;
      ctx.stroke(path);
    }
  }
  ctx.restore();
}

type Value = number | PathNode[];
type Kind = "float" | "int" | "path" | "color";
interface Keyframe { fraction: number; value: Value | null; interp: ((t: number) => number) | null }
interface Holder { prop: string; kind: Kind; frames: Keyframe[] }
export type Timeline =
  | { set: true; sequential: boolean; children: Timeline[] }
  | { set: false; delay: number; duration: number; repeat: number; reverse: boolean; interp: (t: number) => number; holders: Holder[] };

const KINDS: Kind[] = ["float", "int", "path", "color"];
function kindOf(res: Resources, node: XmlNode, ...values: (RV | null)[]): Kind {
  const declared = namedAttrRV(res, node, "valueType");
  if (declared) return KINDS[rvInt(res, declared)] ?? "float";
  const v = values.find((x) => x);
  return v?.t === TV.STRING ? "path" : v && v.t >= TV.COLOR_ARGB8 && v.t <= TV.COLOR_RGB4 ? "color" : "float";
}
function parseValue(res: Resources, v: RV | null, kind: Kind): Value | null {
  if (!v) return null;
  return kind === "path" ? parsePathData(v.s ?? "") : kind === "color" ? rvColor(res, v, 0) : rvFloat(res, v, 0);
}
function holder(res: Resources, node: XmlNode): Holder {
  const from = namedAttrRV(res, node, "valueFrom"), to = namedAttrRV(res, node, "valueTo");
  const frameNodes = node.children.filter((c) => c.name === "keyframe");
  const kind = kindOf(res, node, from, to, ...frameNodes.map((k) => namedAttrRV(res, k, "value")));
  const frames: Keyframe[] = frameNodes.length
    ? frameNodes.map((k, i) => ({
      fraction: rvFloat(res, namedAttrRV(res, k, "fraction"), frameNodes.length > 1 ? i / (frameNodes.length - 1) : 1),
      value: parseValue(res, namedAttrRV(res, k, "value"), kind),
      interp: interpolatorAttr(res, k)?.f ?? null,
    }))
    : [{ fraction: 0, value: parseValue(res, from, kind), interp: null }, { fraction: 1, value: parseValue(res, to, kind), interp: null }];
  return { prop: namedAttrRV(res, node, "propertyName")?.s ?? "", kind, frames };
}
/** ObjectAnimator's path keyframes: the point at each fraction of the path's length, x animating
 *  propertyXName and y propertyYName */
function pathHolders(res: Resources, node: XmlNode, data: string): Holder[] {
  const pts = flatten(parsePathData(data)).flat(), lengths = [0];
  for (let i = 2; i < pts.length; i += 2) lengths.push(lengths[lengths.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
  const total = lengths[lengths.length - 1] || 1;
  return (["propertyXName", "propertyYName"] as const).flatMap((axis, k) => {
    const prop = namedAttrRV(res, node, axis)?.s;
    return prop ? [{ prop, kind: "float" as const, frames: lengths.map((l, i) => ({ fraction: l / total, value: pts[2 * i + k], interp: null })) }] : [];
  });
}
/** an animator resource's root: <set>, <objectAnimator> or its <propertyValuesHolder>s */
function timelineFromXml(res: Resources, node: XmlNode): Timeline {
  if (node.name === "set") {
    return { set: true, sequential: rvInt(res, namedAttrRV(res, node, "ordering")) === 1, children: node.children.map((c) => timelineFromXml(res, c)) };
  }
  const holders = node.children.filter((c) => c.name === "propertyValuesHolder").map((c) => holder(res, c));
  const data = namedAttrRV(res, node, "pathData")?.s;
  if (data) holders.push(...pathHolders(res, node, data));
  else if (!holders.length && namedAttrRV(res, node, "propertyName")) holders.push(holder(res, node));
  return {
    set: false, holders,
    delay: rvInt(res, namedAttrRV(res, node, "startOffset")),
    duration: rvInt(res, namedAttrRV(res, node, "duration"), 300),
    repeat: rvInt(res, namedAttrRV(res, node, "repeatCount")),
    reverse: rvInt(res, namedAttrRV(res, node, "repeatMode"), 1) === 2,
    interp: interpolatorAttr(res, node)?.f ?? accelDecel,
  };
}
export function loadTimeline(res: Resources, id: number): Timeline | null {
  const file = res.fileOf(id);
  return file ? timelineFromXml(res, parseAXML(file.bytes)) : null;
}
/** its length in ms: Infinity when it repeats forever */
export function timelineLength(t: Timeline): number {
  if (t.set) {
    const lengths = t.children.map(timelineLength);
    return t.sequential ? lengths.reduce((a, b) => a + b, 0) : Math.max(0, ...lengths);
  }
  return t.repeat < 0 ? Infinity : t.delay + t.duration * (t.repeat + 1);
}

type Props = Record<string, unknown>;
/** Sets the target's animated properties at `ms` into the timeline (Infinity: their end values);
 *  one not yet started leaves them alone, and one that ended holds its last value. `base` is the
 *  target as inflated, whose values stand in for a missing valueFrom/valueTo. */
export function applyTimeline(t: Timeline, ms: number, target: VGroup | VPath, base: VGroup | VPath): void {
  if (t.set) {
    let offset = 0;
    for (const child of t.children) {
      applyTimeline(child, ms === Infinity ? ms : ms - offset, target, base);
      if (t.sequential) offset += timelineLength(child);
    }
    return;
  }
  const local = ms - t.delay;
  if (local < 0) return;
  let fraction = 1;
  if (t.duration > 0 && local !== Infinity) {
    let cycle = Math.floor(local / t.duration);
    fraction = local / t.duration - cycle;
    if (t.repeat >= 0 && cycle > t.repeat) { cycle = t.repeat; fraction = 1; }
    if (t.reverse && cycle % 2 === 1) fraction = 1 - fraction;
  }
  const f = t.interp(fraction);
  for (const h of t.holders) {
    const frames = h.frames;
    let i = 0;
    while (i < frames.length - 2 && f > frames[i + 1].fraction) i++;
    const a = frames[i], b = frames[Math.min(i + 1, frames.length - 1)];
    const span = b.fraction - a.fraction;
    let local = span > 0 ? Math.max(0, Math.min(1, (f - a.fraction) / span)) : 1;
    if (b.interp) local = b.interp(local);
    const current = (base as unknown as Props)[h.prop === "pathData" ? "nodes" : h.prop] as Value;
    const from = a.value ?? current, to = b.value ?? current;
    set(target, h.prop, h.kind === "path" ? (canMorph(from as PathNode[], to as PathNode[]) ? morph(from as PathNode[], to as PathNode[], local) : from)
      : h.kind === "color" ? argbLerp(local, from as number, to as number)
      : h.kind === "int" ? Math.trunc((from as number) + ((to as number) - (from as number)) * local)
      : (from as number) + ((to as number) - (from as number)) * local);
  }
}
function set(target: VGroup | VPath, prop: string, v: Value) {
  const key = prop === "pathData" ? "nodes" : prop;
  if (!(key in target)) return;
  (target as unknown as Props)[key] = v;
  if (key === "nodes") (target as VPath).path = null;
}
