// libinput's MotionEvent (Input.cpp) behind android.view.MotionEvent's mNativePtr, with
// android_view_MotionEvent.cpp's natives. MotionEvent, PointerCoords and PointerProperties run
// from AOSP bytecode; TS reaches an event's native state through motionOf.

import { rt, type JObj, declaredField, peerField } from "../jvm/runtime.ts";
import { ownedHandle, deref } from "./handles.ts";
import { matrixOf } from "./matrix.ts";
import { readInt, readLong, writeInt, writeLong, readFloat, writeFloat, type NativeParcel, nativeParcel } from "./parcel.ts";
import { ACTION_CANCEL, ACTION_DOWN, ACTION_MOVE, ACTION_POINTER_DOWN, ACTION_POINTER_UP, ACTION_UP, AXIS_ORIENTATION, AXIS_PRESSURE,
  AXIS_RELATIVE_X, AXIS_RELATIVE_Y, AXIS_SIZE, AXIS_TOOL_MAJOR, AXIS_TOOL_MINOR, AXIS_TOUCH_MAJOR, AXIS_TOUCH_MINOR, AXIS_X, AXIS_Y,
  FLAG_CANCELED, SOURCE_CLASS_JOYSTICK, SOURCE_CLASS_POINTER, SOURCE_CLASS_POSITION, SOURCE_MOUSE_RELATIVE } from "./input-codes.ts";

const ME = "android/view/MotionEvent", PC = "android/view/MotionEvent$PointerCoords", PP = "android/view/MotionEvent$PointerProperties";
const HISTORY_CURRENT = -0x80000000;
/** AMOTION_EVENT_PRIVATE_FLAG_SUPPORTS_ORIENTATION and _SUPPORTS_DIRECTIONAL_ORIENTATION: kept from Java */
const SUPPORTS_ORIENTATION = 0x80;
const DIRECTIONAL = 0x100, PRIVATE_FLAGS = 0x180;
const MAX_POINTERS = 16, MAX_AXES = 30;
const f32 = Math.fround;

// ── ui::Transform: [a, b, tx, c, d, ty] with x' = a·x + b·y + tx and y' = c·x + d·y + ty, in float
type Xform = Float32Array;
const IDENTITY_XF = () => Float32Array.of(1, 0, 0, 0, 1, 0);
const mapX = (t: Xform, x: number, y: number) => f32(f32(f32(t[0] * x) + f32(t[1] * y)) + t[2]);
const mapY = (t: Xform, x: number, y: number) => f32(f32(f32(t[3] * x) + f32(t[4] * y)) + t[5]);
/** n · m: m applies first */
function compose(n: Xform, m: Xform): Xform {
  const dot = (p: number, q: number, r: number, s: number) => f32(f32(p * q) + f32(r * s));
  return Float32Array.of(dot(n[0], m[0], n[1], m[3]), dot(n[0], m[1], n[1], m[4]), f32(dot(n[0], m[2], n[1], m[5]) + n[2]),
    dot(n[3], m[0], n[4], m[3]), dot(n[3], m[1], n[4], m[4]), f32(dot(n[3], m[2], n[4], m[5]) + n[5]));
}
function inverse(t: Xform): Xform {
  if (t[0] === 1 && t[1] === 0 && t[3] === 0 && t[4] === 1) return Float32Array.of(1, 0, -t[2], 0, 1, -t[5]);
  const idet = f32(1 / f32(f32(t[0] * t[4]) - f32(t[1] * t[3])));
  const r = Float32Array.of(f32(t[4] * idet), f32(-t[1] * idet), 0, f32(-t[3] * idet), f32(t[0] * idet), 0);
  r[2] = mapX(r, -t[2], -t[5]); r[5] = mapY(r, -t[2], -t[5]);
  return r;
}
const ROT_90 = 4, ROT_INVALID = 0x80;
/** Transform::getOrientation: ROT_0/FLIP_H/FLIP_V/ROT_90 bits of a rotation that keeps the axes */
function orientation(t: Xform): number {
  const [a, b, , c, d] = t;
  if (b === 0 && c === 0) return (a < 0 ? 1 : 0) | (d < 0 ? 2 : 0);
  if (a === 0 && d === 0) return ROT_90 | (b > 0 ? 2 : 0) | (c < 0 ? 1 : 0);
  return ROT_INVALID;
}
/** ui::Transform(orientation): the rotation alone */
function rotationOf(flags: number): Xform {
  const t = IDENTITY_XF();
  if (flags & ROT_INVALID) return t;
  const h = flags & 1 ? -1 : 1, v = flags & 2 ? -1 : 1;
  if (flags & ROT_90) { t[0] = 0; t[1] = -v; t[3] = h; t[4] = 0; } else { t[0] = h; t[4] = v; }
  return t;
}
/** roundTransformedCoords: to 1/1024, half away from zero (std::round) */
const round = (v: number) => f32((v < 0 ? -Math.round(-v * 1024) : Math.round(v * 1024)) / 1024);

// ── PointerCoords: BitSet64 of axes (MSB first, as Java's mPackedAxisBits) and their values
class Coords {
  /** axes 0-31 at bit 31 - axis, and 32-63 at bit 63 - axis */
  hi = 0; lo = 0;
  v = new Float32Array(64);
  resampled = false;
  has(axis: number): boolean { return axis < 32 ? (this.hi >>> (31 - axis) & 1) === 1 : (this.lo >>> (63 - axis) & 1) === 1; }
  get(axis: number): number { return axis >= 0 && axis < 64 ? this.v[axis] : 0; }
  set(axis: number, value: number): void {
    if (axis < 0 || axis > 63) return;
    if (!this.has(axis)) {
      if (value === 0) return;
      if (popcount(this.hi) + popcount(this.lo) >= MAX_AXES) return;
      if (axis < 32) this.hi |= 1 << (31 - axis); else this.lo |= 1 << (63 - axis);
    }
    this.v[axis] = value;
  }
  copy(): Coords {
    const c = new Coords();
    c.hi = this.hi; c.lo = this.lo; c.v.set(this.v); c.resampled = this.resampled;
    return c;
  }
  /** the set axes in ascending order */
  *axes(): Generator<number> { for (let i = 0; i < 64; i++) if (this.has(i)) yield i; }
}
const popcount = (n: number) => { n = n - ((n >>> 1) & 0x55555555); n = (n & 0x33333333) + ((n >>> 2) & 0x33333333); return ((n + (n >>> 4) & 0xf0f0f0f) * 0x1010101) >>> 24; };
function scaleAxis(c: Coords, axis: number, s: number) { if (c.has(axis)) c.v[axis] = f32(c.v[axis] * s); }
/** PointerCoords::transform: the point, relative motion (rotation only) and orientation */
function transformCoords(c: Coords, t: Xform) {
  const x = c.v[AXIS_X], y = c.v[AXIS_Y];
  c.set(AXIS_X, mapX(t, x, y)); c.set(AXIS_Y, mapY(t, x, y));
  if (c.has(AXIS_RELATIVE_X) || c.has(AXIS_RELATIVE_Y)) {
    const r = rotationOf(orientation(t)), rx = c.v[AXIS_RELATIVE_X], ry = c.v[AXIS_RELATIVE_Y];
    c.set(AXIS_RELATIVE_X, mapX(r, rx, ry)); c.set(AXIS_RELATIVE_Y, mapY(r, rx, ry));
  }
  if (c.has(AXIS_ORIENTATION)) c.set(AXIS_ORIENTATION, transformAngle(t, c.v[AXIS_ORIENTATION], true));
}
/** transformAngle: the clockwise angle from vertical a vector at `angle` takes under `t`, kept within
 *  ±π/2 unless the angle is directional */
function transformAngle(t: Xform, angle: number, directional: boolean): number {
  const sx = f32(Math.sin(angle)), sy = f32(-Math.cos(angle));
  let x = f32(mapX(t, sx, sy) - t[2]), y = f32(mapY(t, sx, sy) - t[5]);
  if (!directional && y > 0) { x = -x; y = -y; }
  return atan2f(x, -y);
}
// bionic's atan2f and atanf (msun's e_atan2f.c and s_atanf.c) in float: the device's orientations
// differ from a correctly rounded atan2 in the last place
const ATAN_HI = [4.6364760399e-01, 7.8539812565e-01, 9.8279368877e-01, 1.5707962513e+00].map(f32);
const ATAN_LO = [5.0121582440e-09, 3.7748947079e-08, 3.4473217170e-08, 7.5497894159e-08].map(f32);
const AT = [3.3333328366e-01, -1.9999158382e-01, 1.4253635705e-01, -1.0648017377e-01, 6.1687607318e-02].map(f32);
const floatWord = (x: number) => { FLOAT[0] = x; return FLOAT_BITS[0]; };
const FLOAT = new Float32Array(1), FLOAT_BITS = new Int32Array(FLOAT.buffer);
function atanf(x: number): number {
  const hx = floatWord(x), ix = hx & 0x7fffffff;
  let id: number;
  if (ix >= 0x4c800000) return ix > 0x7f800000 ? x + x : hx > 0 ? f32(ATAN_HI[3] + ATAN_LO[3]) : f32(-ATAN_HI[3] - ATAN_LO[3]);
  if (ix < 0x3ee00000) { if (ix < 0x39800000) return x; id = -1; }
  else {
    x = Math.abs(x);
    if (ix < 0x3f980000) {
      if (ix < 0x3f300000) { id = 0; x = f32(f32(f32(2 * x) - 1) / f32(2 + x)); } else { id = 1; x = f32(f32(x - 1) / f32(x + 1)); }
    } else if (ix < 0x401c0000) { id = 2; x = f32(f32(x - 1.5) / f32(1 + f32(1.5 * x))); } else { id = 3; x = f32(-1 / x); }
  }
  const z = f32(x * x), w = f32(z * z);
  const s = f32(f32(z * f32(AT[0] + f32(w * f32(AT[2] + f32(w * AT[4]))))) + f32(w * f32(AT[1] + f32(w * AT[3]))));
  if (id < 0) return f32(x - f32(x * s));
  const r = f32(ATAN_HI[id] - f32(f32(f32(x * s) - ATAN_LO[id]) - x));
  return hx < 0 ? -r : r;
}
const PI = f32(Math.PI), PI_O_2 = f32(Math.PI / 2), PI_LO = f32(-8.7422776573e-08);
function atan2f(y: number, x: number): number {
  const hx = floatWord(x), ix = hx & 0x7fffffff, hy = floatWord(y), iy = hy & 0x7fffffff;
  if (ix > 0x7f800000 || iy > 0x7f800000) return x + y;
  if (hx === 0x3f800000) return atanf(y);
  let m = (hy >>> 31) | ((hx >>> 30) & 2);
  if (iy === 0) return m < 2 ? y : m === 2 ? PI : -PI;
  if (ix === 0) return hy < 0 ? -PI_O_2 : PI_O_2;
  if (ix === 0x7f800000 || iy === 0x7f800000) return f32(Math.atan2(y, x));
  const k = (iy - ix) >> 23;
  let z: number;
  if (k > 26) { z = f32(PI_O_2 + f32(0.5 * PI_LO)); m &= 1; }
  else if (k < -26 && hx < 0) z = 0;
  else z = atanf(Math.abs(f32(y / x)));
  return m === 0 ? z : m === 1 ? -z : m === 2 ? f32(PI - f32(z - PI_LO)) : f32(f32(z - PI_LO) - PI);
}
const shouldDisregardTransformation = (source: number) =>
  (source & SOURCE_CLASS_JOYSTICK) === SOURCE_CLASS_JOYSTICK || (source & SOURCE_CLASS_POSITION) === SOURCE_CLASS_POSITION ||
  (source & SOURCE_MOUSE_RELATIVE) === SOURCE_MOUSE_RELATIVE;
const withoutTranslation = (t: Xform, x: number, y: number): [number, number] =>
  [round(f32(mapX(t, x, y) - t[2])), round(f32(mapY(t, x, y) - t[5]))];
/** MotionEvent::calculateTransformedAxisValue */
function transformedAxis(axis: number, source: number, flags: number, t: Xform, c: Coords): number {
  if (shouldDisregardTransformation(source)) return c.get(axis);
  if (axis === AXIS_X || axis === AXIS_Y) {
    const x = c.v[AXIS_X], y = c.v[AXIS_Y];
    if ((source & SOURCE_CLASS_POINTER) !== SOURCE_CLASS_POINTER) return withoutTranslation(t, x, y)[axis];
    return round(axis === AXIS_X ? mapX(t, x, y) : mapY(t, x, y));
  }
  if (axis === AXIS_RELATIVE_X || axis === AXIS_RELATIVE_Y) return withoutTranslation(t, c.v[AXIS_RELATIVE_X], c.v[AXIS_RELATIVE_Y])[axis - AXIS_RELATIVE_X];
  if (axis === AXIS_ORIENTATION) return flags & SUPPORTS_ORIENTATION ? transformAngle(t, c.v[AXIS_ORIENTATION], !!(flags & DIRECTIONAL)) : 0;
  return c.get(axis);
}

/** InputEvent::nextId: a random id tagged with IdGenerator's Source::OTHER */
export function nextId(): number {
  return (Math.random() * 0x10000000) | 0x30000000;
}

export class NativeMotionEvent {
  id = 0; deviceId = 0; source = 0; displayId = 0;
  action = 0; actionButton = 0; flags = 0; edgeFlags = 0; metaState = 0; buttonState = 0; classification = 0;
  xform: Xform = IDENTITY_XF();
  rawXform: Xform = IDENTITY_XF();
  xPrecision = 0; yPrecision = 0;
  rawXCursor = NaN; rawYCursor = NaN;
  downTime = 0n;
  ids: number[] = [];
  tools: number[] = [];
  /** one event time per sample, the current sample last */
  times: bigint[] = [];
  /** pointer coordinates sample by sample, each sample's pointers in pointer order */
  coords: Coords[] = [];
  get pointerCount(): number { return this.ids.length; }
  get historySize(): number { return this.times.length - 1; }
  get eventTime(): bigint { return this.times[this.times.length - 1]; }
  rawCoords(i: number, h = this.historySize): Coords { return this.coords[h * this.ids.length + i]; }
  axis(axis: number, i = 0, h = this.historySize): number { return transformedAxis(axis, this.source, this.flags, this.xform, this.rawCoords(i, h)); }
  rawAxis(axis: number, i = 0, h = this.historySize): number { return transformedAxis(axis, this.source, this.flags, this.rawXform, this.rawCoords(i, h)); }
  findPointerIndex(id: number): number { return this.ids.indexOf(id); }
  /** MotionEvent::offsetLocation */
  offsetLocation(dx: number, dy: number): void {
    const t = this.xform = Float32Array.from(this.xform);
    t[2] = f32(t[2] + dx); t[5] = f32(t[5] + dy);
  }
  /** Java's setLocation, which offsets the transform to put pointer 0 there */
  setLocation(x: number, y: number): void { this.offsetLocation(f32(x - this.axis(AXIS_X)), f32(y - this.axis(AXIS_Y))); }
  copyFrom(o: NativeMotionEvent, keepHistory: boolean): void {
    this.id = o.id; this.deviceId = o.deviceId; this.source = o.source; this.displayId = o.displayId;
    this.action = o.action; this.actionButton = o.actionButton; this.flags = o.flags; this.edgeFlags = o.edgeFlags;
    this.metaState = o.metaState; this.buttonState = o.buttonState; this.classification = o.classification;
    this.xform = o.xform; this.rawXform = o.rawXform; this.xPrecision = o.xPrecision; this.yPrecision = o.yPrecision;
    this.rawXCursor = o.rawXCursor; this.rawYCursor = o.rawYCursor; this.downTime = o.downTime;
    this.ids = o.ids.slice(); this.tools = o.tools.slice();
    if (keepHistory) { this.times = o.times.slice(); this.coords = o.coords.map((c) => c.copy()); }
    else {
      const n = o.ids.length, at = o.historySize * n;
      this.times = [o.eventTime]; this.coords = o.coords.slice(at, at + n).map((c) => c.copy());
    }
  }
}

const ptrOf = peerField<bigint>(ME, "mNativePtr");
const at = (h: bigint) => deref<NativeMotionEvent>(h);
/** the event at `h` (a new one when 0) after `fill`, as a handle */
const into = (h: bigint, fill: (e: NativeMotionEvent) => unknown): bigint => {
  const e = h ? at(h) : new NativeMotionEvent();
  fill(e);
  return h || ownedHandle(e);
};
const xformOf = (matrix: object): Float32Array => { const m = matrixOf(matrix); return Float32Array.of(m[0], m[1], m[2], m[3], m[4], m[5]); };
/** the native event behind a Java MotionEvent */
export const motionOf = (ev: object): NativeMotionEvent => at(ptrOf(ev));

// ── JNI
const iae = (msg: string) => rt.mkThrowable("java/lang/IllegalArgumentException", msg);
const npe = (msg: string) => rt.mkThrowable("java/lang/NullPointerException", msg);
function checkPointer(e: NativeMotionEvent, i: number) { if (i < 0 || i >= e.pointerCount) throw iae(`invalid pointerIndex ${i} for ${describe(e)}`); }
function checkHistory(e: NativeMotionEvent, h: number) { if (h < 0 || h >= e.historySize) throw iae(`historyPos ${h} out of range for ${describe(e)}`); }
function sample(e: NativeMotionEvent, i: number, h: number): number {
  checkPointer(e, i);
  if (h === HISTORY_CURRENT) return e.historySize;
  checkHistory(e, h);
  return h;
}
const ACTIONS = ["DOWN", "UP", "MOVE", "CANCEL", "OUTSIDE", "POINTER_DOWN", "POINTER_UP", "HOVER_MOVE", "SCROLL", "HOVER_ENTER", "HOVER_EXIT", "BUTTON_PRESS", "BUTTON_RELEASE"];
const SOURCES: [number, string][] = [[0x101, "KEYBOARD"], [0x201, "DPAD"], [0x401, "GAMEPAD"], [0x1002, "TOUCHSCREEN"], [0x2002, "MOUSE"],
  [0x4002, "STYLUS"], [0x8002, "BLUETOOTH_STYLUS"], [0x10004, "TRACKBALL"], [0x20004, "MOUSE_RELATIVE"], [0x100008, "TOUCHPAD"],
  [0x200000, "TOUCH_NAVIGATION"], [0x400000, "ROTARY_ENCODER"], [0x1000010, "JOYSTICK"], [0x4000000, "HDMI"], [0x8000000, "SENSOR"]];
const TOOLS = ["UNKNOWN", "FINGER", "STYLUS", "MOUSE", "ERASER", "PALM"];
const g6 = (v: number) => String(Number(v.toPrecision(6)));
/** operator<<(std::ostream&, const MotionEvent&), as the natives' exception messages carry it */
function describe(e: NativeMotionEvent): string {
  const masked = e.action & 0xff, index = e.action >> 8;
  let s = `MotionEvent { action=${ACTIONS[masked] ?? masked}${masked === ACTION_POINTER_DOWN || masked === ACTION_POINTER_UP ? `(${index})` : ""}`;
  if (e.actionButton) s += `, actionButton=${e.actionButton}`;
  for (let i = 0; i < e.pointerCount; i++) {
    s += `, id[${i}]=${e.ids[i]}`;
    const x = e.axis(AXIS_X, i), y = e.axis(AXIS_Y, i);
    if (x !== 0 || y !== 0) s += `, x[${i}]=${g6(x)}, y[${i}]=${g6(y)}`;
    if (e.tools[i] !== 1) s += `, toolType[${i}]=${TOOLS[e.tools[i]] ?? e.tools[i]}`;
  }
  if (e.buttonState) s += `, buttonState=${e.buttonState}`;
  if (e.metaState) s += `, metaState=${e.metaState}`;
  if (e.flags) s += `, flags=0x${(e.flags >>> 0).toString(16)}`;
  if (e.edgeFlags) s += `, edgeFlags=${e.edgeFlags}`;
  if (e.pointerCount !== 1) s += `, pointerCount=${e.pointerCount}`;
  if (e.historySize) s += `, historySize=${e.historySize}`;
  const source = SOURCES.filter(([bits]) => (e.source & bits) === bits && bits & ~0xff).map(([, n]) => n).join(" | ") || `0x${e.source.toString(16)}`;
  return s + `, eventTime=${e.eventTime}, downTime=${e.downTime}, deviceId=${e.deviceId}, source=${source}, displayId=${e.displayId}, eventId=0x${(e.id >>> 0).toString(16)}}`;
}

type PCFields = Record<"x" | "y" | "pressure" | "size" | "touchMajor" | "touchMinor" | "toolMajor" | "toolMinor" | "orientation" | "relativeX" | "relativeY" | "isResampled" | "bits" | "values", string>;
let pcf: PCFields | null = null;
const pcFields = (): PCFields => pcf ??= {
  x: declaredField(PC, "x"), y: declaredField(PC, "y"), pressure: declaredField(PC, "pressure"), size: declaredField(PC, "size"),
  touchMajor: declaredField(PC, "touchMajor"), touchMinor: declaredField(PC, "touchMinor"), toolMajor: declaredField(PC, "toolMajor"),
  toolMinor: declaredField(PC, "toolMinor"), orientation: declaredField(PC, "orientation"), relativeX: declaredField(PC, "relativeX"),
  relativeY: declaredField(PC, "relativeY"), isResampled: declaredField(PC, "isResampled"), bits: declaredField(PC, "mPackedAxisBits"),
  values: declaredField(PC, "mPackedAxisValues"),
};
let ppf: [id: string, toolType: string] | null = null;
const ppFields = () => ppf ??= [declaredField(PP, "id"), declaredField(PP, "toolType")];
/** the axes PointerCoords keeps as fields, in field order with their axis */
const FIELD_AXES: [keyof PCFields, number][] = [["x", AXIS_X], ["y", AXIS_Y], ["pressure", AXIS_PRESSURE], ["size", AXIS_SIZE],
  ["touchMajor", AXIS_TOUCH_MAJOR], ["touchMinor", AXIS_TOUCH_MINOR], ["toolMajor", AXIS_TOOL_MAJOR], ["toolMinor", AXIS_TOOL_MINOR],
  ["orientation", AXIS_ORIENTATION], ["relativeX", AXIS_RELATIVE_X], ["relativeY", AXIS_RELATIVE_Y]];
const FIELD_HI = FIELD_AXES.reduce((m, [, a]) => m | 1 << (31 - a), 0);
/** pointerCoordsToNative: Java coordinates mapped by `t`, the inverse of the event's transform, as
 *  calculateTransformedXY maps them (rounded) */
function coordsToNative(o: Record<string, any>, source: number, t: Xform): Coords {
  const f = pcFields(), c = new Coords();
  const x = o[f.x], y = o[f.y];
  if ((source & SOURCE_CLASS_POINTER) !== SOURCE_CLASS_POINTER) {
    const [rx, ry] = withoutTranslation(t, x, y);
    c.set(AXIS_X, rx); c.set(AXIS_Y, ry);
  } else { c.set(AXIS_X, round(mapX(t, x, y))); c.set(AXIS_Y, round(mapY(t, x, y))); }
  for (let k = 2; k < FIELD_AXES.length; k++) c.set(FIELD_AXES[k][1], o[f[FIELD_AXES[k][0]]]);
  const bits: bigint = o[f.bits];
  if (bits) {
    const values: Float32Array | null = o[f.values];
    if (values) {
      let index = 0;
      for (let axis = 0; axis < 64; axis++) if (bits >> BigInt(63 - axis) & 1n) c.set(axis, values[index++]);
    }
  }
  c.resampled = !!o[f.isResampled];
  return c;
}
/** pointerCoordsFromNative */
function coordsFromNative(e: NativeMotionEvent, c: Coords, o: Record<string, any>): void {
  const f = pcFields();
  o[f.x] = transformedAxis(AXIS_X, e.source, e.flags, e.xform, c);
  o[f.y] = transformedAxis(AXIS_Y, e.source, e.flags, e.xform, c);
  for (let k = 2; k < FIELD_AXES.length; k++) {
    const [name, axis] = FIELD_AXES[k];
    o[f[name]] = axis === AXIS_ORIENTATION || axis === AXIS_RELATIVE_X || axis === AXIS_RELATIVE_Y
      ? transformedAxis(axis, e.source, e.flags, e.xform, c) : c.get(axis);
  }
  o[f.isResampled] = +c.resampled;
  const hi = c.hi & ~FIELD_HI, lo = c.lo;
  if (hi || lo) {
    const count = popcount(hi) + popcount(lo);
    let values: Float32Array | null = o[f.values];
    if (!values || values.length < count) { let size = 8; while (size < count) size *= 2; o[f.values] = values = new Float32Array(size); }
    let index = 0;
    for (let axis = 0; axis < 64; axis++) if (axis < 32 ? hi >>> (31 - axis) & 1 : lo >>> (63 - axis) & 1) values[index++] = c.v[axis];
    // the array is stored back: a field's array is a copy
    o[f.values] = values;
  }
  o[f.bits] = BigInt(hi >>> 0) << 32n | BigInt(lo >>> 0);
}
function pointerArrays(count: number, props: unknown[] | null, coords: unknown[] | null) {
  if (count < 1) throw iae("pointerCount must be at least 1");
  if (!props) throw iae("pointerProperties array must not be null");
  if (props.length < count) throw iae("pointerProperties array must be large enough to hold all pointers");
  if (!coords) throw iae("pointerCoords array must not be null");
  if (coords.length < count) throw iae("pointerCoords array must be large enough to hold all pointers");
}

/** MotionEvent::split: the action and pointers of `src` limited to the pointers in `idBits` */
function split(dst: NativeMotionEvent, src: NativeMotionEvent, idBits: number): void {
  const masked = src.action & 0xff, actionId = src.ids[src.action >> 8 & 0xff];
  const kept: number[] = [];
  for (let i = 0; i < src.pointerCount; i++) if (idBits >>> src.ids[i] & 1) kept.push(i);
  let action = src.action;
  if (masked === ACTION_POINTER_DOWN || masked === ACTION_POINTER_UP) {
    if (idBits >>> actionId & 1) {
      action = kept.length === 1 ? masked === ACTION_POINTER_DOWN ? ACTION_DOWN : src.flags & FLAG_CANCELED ? ACTION_CANCEL : ACTION_UP
        : masked | kept.findIndex((i) => src.ids[i] === actionId) << 8;
    } else action = ACTION_MOVE;
  }
  dst.copyFrom(src, true);
  dst.id = nextId(); dst.action = action;
  dst.ids = kept.map((i) => src.ids[i]); dst.tools = kept.map((i) => src.tools[i]);
  dst.coords = [];
  for (let h = 0; h <= src.historySize; h++) for (const i of kept) dst.coords.push(src.rawCoords(i, h).copy());
}

const writeXform = (p: NativeParcel, t: Xform) => { for (const i of [0, 1, 2, 3, 4, 5]) writeFloat(p, t[i]); };
const readXform = (p: NativeParcel): Xform => Float32Array.from([0, 1, 2, 3, 4, 5], () => readFloat(p));
function writeEvent(e: NativeMotionEvent, p: NativeParcel): void {
  writeInt(p, e.pointerCount); writeInt(p, e.times.length);
  writeInt(p, e.id); writeInt(p, e.deviceId); writeInt(p, e.source); writeInt(p, e.displayId);
  writeInt(p, 32); for (let i = 0; i < 8; i++) writeInt(p, 0); // the HMAC, which this host never signs
  for (const v of [e.action, e.actionButton, e.flags, e.edgeFlags, e.metaState, e.buttonState, e.classification]) writeInt(p, v);
  writeXform(p, e.xform);
  writeFloat(p, e.xPrecision); writeFloat(p, e.yPrecision); writeFloat(p, e.rawXCursor); writeFloat(p, e.rawYCursor);
  writeXform(p, e.rawXform);
  writeLong(p, e.downTime);
  for (let i = 0; i < e.pointerCount; i++) { writeInt(p, e.ids[i]); writeInt(p, e.tools[i]); }
  for (let h = 0; h < e.times.length; h++) {
    writeLong(p, e.times[h]);
    for (let i = 0; i < e.pointerCount; i++) {
      const c = e.rawCoords(i, h);
      writeInt(p, c.lo); writeInt(p, c.hi);
      for (const axis of c.axes()) writeFloat(p, c.v[axis]);
      writeInt(p, +c.resampled);
    }
  }
}
function readEvent(e: NativeMotionEvent, p: NativeParcel): boolean {
  const pointers = readInt(p), samples = readInt(p);
  if (pointers <= 0 || pointers > MAX_POINTERS || samples <= 0) return false;
  e.id = readInt(p); e.deviceId = readInt(p); e.source = readInt(p); e.displayId = readInt(p);
  const hmac = readInt(p);
  if (hmac !== 32) return false;
  for (let i = 0; i < 8; i++) readInt(p);
  [e.action, e.actionButton, e.flags, e.edgeFlags, e.metaState, e.buttonState, e.classification] = Array.from({ length: 7 }, () => readInt(p));
  e.xform = readXform(p);
  e.xPrecision = readFloat(p); e.yPrecision = readFloat(p); e.rawXCursor = readFloat(p); e.rawYCursor = readFloat(p);
  e.rawXform = readXform(p);
  e.downTime = readLong(p);
  e.ids = []; e.tools = [];
  for (let i = 0; i < pointers; i++) { e.ids.push(readInt(p)); e.tools.push(readInt(p)); }
  e.times = []; e.coords = [];
  for (let h = 0; h < samples; h++) {
    e.times.push(readLong(p));
    for (let i = 0; i < pointers; i++) {
      const c = new Coords();
      c.lo = readInt(p); c.hi = readInt(p);
      for (const axis of c.axes()) c.v[axis] = readFloat(p);
      c.resampled = readInt(p) !== 0;
      e.coords.push(c);
    }
  }
  return true;
}

const AXIS_LABELS = [
  ..."X Y PRESSURE SIZE TOUCH_MAJOR TOUCH_MINOR TOOL_MAJOR TOOL_MINOR ORIENTATION VSCROLL HSCROLL Z RX RY RZ HAT_X HAT_Y LTRIGGER RTRIGGER THROTTLE RUDDER WHEEL GAS BRAKE DISTANCE TILT SCROLL RELATIVE_X RELATIVE_Y".split(" "),
  "RESERVED_29", "RESERVED_30", "RESERVED_31",
  ...Array.from({ length: 16 }, (_, i) => `GENERIC_${i + 1}`),
  ..."GESTURE_X_OFFSET GESTURE_Y_OFFSET GESTURE_SCROLL_X_DISTANCE GESTURE_SCROLL_Y_DISTANCE GESTURE_PINCH_SCALE_FACTOR GESTURE_SWIPE_FINGER_COUNT".split(" "),
];

/** the axes PointerCoords::scale scales */
const SCALED_AXES = [AXIS_X, AXIS_Y, AXIS_TOUCH_MAJOR, AXIS_TOUCH_MINOR, AXIS_TOOL_MAJOR, AXIS_TOOL_MINOR, AXIS_RELATIVE_X, AXIS_RELATIVE_Y];
rt.registerJnis(ME, {
  "nativeInitialize(JIIIIIIIIIFFFFJJI[Landroid/view/MotionEvent$PointerProperties;[Landroid/view/MotionEvent$PointerCoords;)J": (ptr: bigint,
    deviceId: number, source: number, displayId: number, action: number, flags: number, edgeFlags: number, metaState: number, buttonState: number,
    classification: number, xOffset: number, yOffset: number, xPrecision: number, yPrecision: number, downTime: bigint, eventTime: bigint,
    count: number, props: Record<string, number>[] | null, coords: Record<string, unknown>[] | null): bigint => {
    pointerArrays(count, props, coords);
    const xform = Float32Array.of(1, 0, xOffset, 0, 1, yOffset), inv = inverse(xform);
    const ids: number[] = [], tools: number[] = [], raw: Coords[] = [];
    const [id, tool] = ppFields();
    flags &= ~PRIVATE_FLAGS;
    for (let i = 0; i < count; i++) {
      const pp = props![i], pc = coords![i];
      if (!pp) return 0n;
      if (!pc) throw npe("pointerCoords");
      ids.push(pp[id]); tools.push(pp[tool]);
      const c = coordsToNative(pc, source, inv);
      if (c.get(AXIS_ORIENTATION) !== 0) flags |= PRIVATE_FLAGS;
      raw.push(c);
    }
    return into(ptr, (e) => Object.assign(e, { id: nextId(), deviceId, source, displayId, action, actionButton: 0, flags, edgeFlags, metaState, buttonState,
      classification, xform, rawXform: IDENTITY_XF(), xPrecision, yPrecision, rawXCursor: NaN, rawYCursor: NaN, downTime, ids, tools, times: [eventTime], coords: raw }));
  },
  "nativeDispose(J)V": () => {},
  "nativeAddBatch(JJ[Landroid/view/MotionEvent$PointerCoords;I)V": (ptr: bigint, eventTime: bigint, coords: Record<string, unknown>[] | null, metaState: number) => {
    const e = at(ptr), n = e.pointerCount;
    if (!coords) throw iae("pointerCoords array must not be null");
    if (coords.length < n) throw iae("pointerCoords array must be large enough to hold all pointers");
    const inv = inverse(e.xform), raw: Coords[] = [];
    for (let i = 0; i < n; i++) {
      if (!coords[i]) throw npe("pointerCoords");
      raw.push(coordsToNative(coords[i], e.source, inv));
    }
    e.times.push(eventTime); e.coords.push(...raw);
    e.metaState |= metaState;
  },
  "nativeGetPointerCoords(JIILandroid/view/MotionEvent$PointerCoords;)V": (ptr: bigint, i: number, h: number, out: Record<string, unknown> | null) => {
    const e = at(ptr), s = sample(e, i, h);
    if (!out) throw npe("pointerCoords must not be null");
    coordsFromNative(e, e.rawCoords(i, s), out);
  },
  "nativeGetPointerProperties(JILandroid/view/MotionEvent$PointerProperties;)V": (ptr: bigint, i: number, out: Record<string, number> | null) => {
    const e = at(ptr);
    checkPointer(e, i);
    if (!out) throw npe("pointerProperties must not be null");
    const [id, tool] = ppFields();
    out[id] = e.ids[i]; out[tool] = e.tools[i];
  },
  "nativeReadFromParcel(JLandroid/os/Parcel;)J": (ptr: bigint, p: JObj) => {
    return into(ptr, (e) => { if (!readEvent(e, nativeParcel(p))) throw rt.mkThrowable("java/lang/RuntimeException", "Failed to read MotionEvent parcel."); });
  },
  "nativeWriteToParcel(JLandroid/os/Parcel;)V": (ptr: bigint, p: JObj) => writeEvent(at(ptr), nativeParcel(p)),
  "nativeAxisToString(I)Ljava/lang/String;": (axis: number) => AXIS_LABELS[axis] ?? null,
  "nativeAxisFromString(Ljava/lang/String;)I": (label: string) => AXIS_LABELS.indexOf(label),
  "nativeGetPointerId(JI)I": (ptr: bigint, i: number) => { const e = at(ptr); checkPointer(e, i); return e.ids[i]; },
  "nativeGetToolType(JI)I": (ptr: bigint, i: number) => { const e = at(ptr); checkPointer(e, i); return e.tools[i]; },
  "nativeGetEventTimeNanos(JI)J": (ptr: bigint, h: number) => {
    const e = at(ptr);
    if (h === HISTORY_CURRENT) return e.eventTime;
    checkHistory(e, h);
    return e.times[h];
  },
  "nativeGetRawAxisValue(JIII)F": (ptr: bigint, axis: number, i: number, h: number) => { const e = at(ptr); return e.rawAxis(axis, i, sample(e, i, h)); },
  "nativeGetAxisValue(JIII)F": (ptr: bigint, axis: number, i: number, h: number) => { const e = at(ptr); return e.axis(axis, i, sample(e, i, h)); },
  "nativeTransform(JLandroid/graphics/Matrix;)V": (ptr: bigint, matrix: object) => {
    const e = at(ptr);
    e.xform = compose(xformOf(matrix), e.xform);
  },
  "nativeApplyTransform(JLandroid/graphics/Matrix;)V": (ptr: bigint, matrix: object) => {
    const e = at(ptr), t = xformOf(matrix);
    for (const c of e.coords) transformCoords(c, t);
    if (!isNaN(e.rawXCursor) && !isNaN(e.rawYCursor)) {
      const x = e.rawXCursor, y = e.rawYCursor;
      e.rawXCursor = mapX(t, x, y); e.rawYCursor = mapY(t, x, y);
    }
  },
  "nativeCopy(JJZ)J": (dst: bigint, src: bigint, keepHistory: number) => {
    return into(dst, (e) => e.copyFrom(at(src), !!keepHistory));
  },
  "nativeSplit(JJI)J": (dst: bigint, src: bigint, idBits: number) => {
    return into(dst, (e) => split(e, at(src), idBits));
  },
  "nativeGetId(J)I": (ptr: bigint) => at(ptr).id,
  "nativeGetDeviceId(J)I": (ptr: bigint) => at(ptr).deviceId,
  "nativeGetSource(J)I": (ptr: bigint) => at(ptr).source,
  "nativeSetSource(JI)V": (ptr: bigint, source: number) => { at(ptr).source = source; },
  "nativeGetDisplayId(J)I": (ptr: bigint) => at(ptr).displayId,
  "nativeSetDisplayId(JI)V": (ptr: bigint, id: number) => { at(ptr).displayId = id; },
  "nativeGetAction(J)I": (ptr: bigint) => at(ptr).action,
  "nativeSetAction(JI)V": (ptr: bigint, action: number) => { at(ptr).action = action; },
  "nativeGetActionButton(J)I": (ptr: bigint) => at(ptr).actionButton,
  "nativeSetActionButton(JI)V": (ptr: bigint, button: number) => { at(ptr).actionButton = button; },
  "nativeIsTouchEvent(J)Z": (ptr: bigint) => {
    const e = at(ptr), masked = e.action & 0xff;
    return +((e.source & SOURCE_CLASS_POINTER) === SOURCE_CLASS_POINTER && masked <= ACTION_POINTER_UP);
  },
  // Java sees the flags without the private orientation bits, and cannot change those
  "nativeGetFlags(J)I": (ptr: bigint) => at(ptr).flags & ~PRIVATE_FLAGS,
  "nativeSetFlags(JI)V": (ptr: bigint, flags: number) => { const e = at(ptr); e.flags = flags & ~PRIVATE_FLAGS | e.flags & PRIVATE_FLAGS; },
  "nativeGetEdgeFlags(J)I": (ptr: bigint) => at(ptr).edgeFlags,
  "nativeSetEdgeFlags(JI)V": (ptr: bigint, flags: number) => { at(ptr).edgeFlags = flags; },
  "nativeGetMetaState(J)I": (ptr: bigint) => at(ptr).metaState,
  "nativeGetButtonState(J)I": (ptr: bigint) => at(ptr).buttonState,
  "nativeSetButtonState(JI)V": (ptr: bigint, state: number) => { at(ptr).buttonState = state; },
  "nativeGetClassification(J)I": (ptr: bigint) => at(ptr).classification,
  "nativeOffsetLocation(JFF)V": (ptr: bigint, dx: number, dy: number) => at(ptr).offsetLocation(dx, dy),
  "nativeGetRawXOffset(J)F": (ptr: bigint) => at(ptr).xform[2],
  "nativeGetRawYOffset(J)F": (ptr: bigint) => at(ptr).xform[5],
  "nativeGetXPrecision(J)F": (ptr: bigint) => at(ptr).xPrecision,
  "nativeGetYPrecision(J)F": (ptr: bigint) => at(ptr).yPrecision,
  "nativeGetXCursorPosition(J)F": (ptr: bigint) => { const e = at(ptr); return round(mapX(e.xform, e.rawXCursor, e.rawYCursor)); },
  "nativeGetYCursorPosition(J)F": (ptr: bigint) => { const e = at(ptr); return round(mapY(e.xform, e.rawXCursor, e.rawYCursor)); },
  "nativeSetCursorPosition(JFF)V": (ptr: bigint, x: number, y: number) => {
    const e = at(ptr), inv = inverse(e.xform);
    e.rawXCursor = mapX(inv, x, y); e.rawYCursor = mapY(inv, x, y);
  },
  "nativeGetDownTimeNanos(J)J": (ptr: bigint) => at(ptr).downTime,
  "nativeSetDownTimeNanos(JJ)V": (ptr: bigint, t: bigint) => { at(ptr).downTime = t; },
  "nativeGetPointerCount(J)I": (ptr: bigint) => at(ptr).pointerCount,
  "nativeFindPointerIndex(JI)I": (ptr: bigint, id: number) => at(ptr).findPointerIndex(id),
  "nativeGetHistorySize(J)I": (ptr: bigint) => at(ptr).historySize,
  "nativeScale(JF)V": (ptr: bigint, s: number) => {
    const e = at(ptr);
    e.xform = Float32Array.from(e.xform); e.xform[2] = f32(e.xform[2] * s); e.xform[5] = f32(e.xform[5] * s);
    e.rawXform = Float32Array.from(e.rawXform); e.rawXform[2] = f32(e.rawXform[2] * s); e.rawXform[5] = f32(e.rawXform[5] * s);
    e.xPrecision = f32(e.xPrecision * s); e.yPrecision = f32(e.yPrecision * s);
    e.rawXCursor = f32(e.rawXCursor * s); e.rawYCursor = f32(e.rawYCursor * s);
    for (const c of e.coords) for (const axis of SCALED_AXES) scaleAxis(c, axis, s);
  },
  // MotionEvent::getSurfaceRotation: the inverse of the rotation the event's transform applies
  "nativeGetSurfaceRotation(J)I": (ptr: bigint) => {
    const o = orientation(at(ptr).xform);
    return o === 0 ? 0 : o === ROT_90 ? 3 : o === 3 ? 2 : o === 7 ? 1 : -1;
  },
});
