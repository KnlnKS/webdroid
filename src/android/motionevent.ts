import { JObj, rt } from "../jvm/runtime";
import { JInputEvent } from "./hardware";
import { obtainEvent, copyEvent } from "./view";

/**
 * The scrollers keep velocity as an EWMA over one sample per frame. A finger that stops moving
 * but stays down produces no samples at all, so the last move's speed survives to the UP and
 * flings a gesture the user had already brought to rest. Those frames did have a velocity —
 * zero — so feed it to them: n missing frames is the same weight applied n times. One frame of
 * silence is the normal cadence between a move and the up that follows it, and costs nothing.
 */
export const restVelocity = (v: number, weight: number, idleMs: number) =>
  v * weight ** Math.max(0, idleMs / 16 - 1);

export const SCROLL_WEIGHT = 0.8;
/** arm a fling above this px/frame, decay it by DECAY each frame, stop below STOP */
export const FLING = { arm: 2, decay: 0.95, stop: 0.7 };
export const trackVelocity = (prev: number, d: number, dtMs: number) =>
  SCROLL_WEIGHT * prev + (1 - SCROLL_WEIGHT) * (d / dtMs * 16);

export class JMotionEvent extends JInputEvent {
  deviceId = 1; source = 0x1002;
  action = 0; flags = 0; edgeFlags = 0; metaState = 0; toolType = 1;
  pressure = 1; size = 0.1; xPrecision = 1; yPrecision = 1;
  touchMajor = 0; touchMinor = 0; toolMajor = 0; toolMinor = 0; orientation = 0;
  x = 0; y = 0;
  rawX = 0; rawY = 0;
  downTime = 0;
  eventTime = 0;
}
function axisValue(this: JMotionEvent, axis: number): number {
  switch (axis) {
    case 0: return this.x; case 1: return this.y; case 2: return this.pressure; case 3: return this.size;
    case 4: return this.touchMajor; case 5: return this.touchMinor; case 6: return this.toolMajor;
    case 7: return this.toolMinor; case 8: return this.orientation;
    default: return 0;
  }
}
function obtainFullEvent(dt: bigint, et: bigint, action: number, x: number, y: number, pressure: number, size: number,
  metaState: number, xPrecision: number, yPrecision: number, deviceId: number, edgeFlags: number, source = 2, flags = 0): JMotionEvent {
  return Object.assign(obtainEvent(dt, et, action, x, y, metaState), { pressure, size, xPrecision, yPrecision, deviceId, edgeFlags, source, flags });
}
rt.register({
  name: "android/view/MotionEvent", ctor: JMotionEvent, sup: "android/view/InputEvent", ifaces: ["android/os/Parcelable"],
  statics: {
    ACTION_DOWN: 0, ACTION_UP: 1, ACTION_MOVE: 2, ACTION_CANCEL: 3, ACTION_OUTSIDE: 4,
    ACTION_POINTER_DOWN: 5, ACTION_POINTER_UP: 6, ACTION_MASK: 0xff, ACTION_POINTER_INDEX_MASK: 0xff00,
    INVALID_POINTER_ID: -1,
  },
  methods: {
    "getAxisValue(I)F": axisValue,
    "getAxisValue(II)F": axisValue,
    "getFlags()I": function (this: JMotionEvent) { return this.flags; },
    "getClassification()I": () => 0,
    "getPressure(I)F": function (this: JMotionEvent) { return this.pressure; },
    "getEventTimeNanos()J": function (this: JMotionEvent) { return BigInt(Math.floor(Number(this.eventTime) * 1e6)); },
    "getAction()I": function (this: JMotionEvent) { return this.action; },
    "getActionMasked()I": function (this: JMotionEvent) { return this.action & 0xff; },
    "getActionIndex()I": () => 0,
    "getX()F": function (this: JMotionEvent) { return this.x; },
    "getY()F": function (this: JMotionEvent) { return this.y; },
    "getX(I)F": function (this: JMotionEvent) { return this.x; },
    "getY(I)F": function (this: JMotionEvent) { return this.y; },
    "getRawX()F": function (this: JMotionEvent) { return this.rawX; },
    "getRawY()F": function (this: JMotionEvent) { return this.rawY; },
    "getPointerCount()I": () => 1,
    "getPointerId(I)I": () => 0,
    "findPointerIndex(I)I": () => 0,
    // Single-pointer model (matches getX(I)/getY(I) above): every index reuses this event's
    // one tracked position, so PointerCoords is filled from the same backing fields.
    "getPointerCoords(ILandroid/view/MotionEvent$PointerCoords;)V": function (this: JMotionEvent, idx: number, out: JPointerCoords) {
      if (!out) return;
      out.x = this.x; out.y = this.y;
      out.pressure = this.pressure; out.size = this.size;
      out.orientation = this.orientation;
      out.touchMajor = this.touchMajor; out.touchMinor = this.touchMinor;
      out.toolMajor = this.toolMajor; out.toolMinor = this.toolMinor;
    },
    "getDownTime()J": function (this: JMotionEvent) { return BigInt(Math.round(this.downTime)); },
    "getEventTime()J": function (this: JMotionEvent) { return BigInt(Math.round(this.eventTime)); },
    "setAction(I)V": function (this: JMotionEvent, a: number) { this.action = a; },
    "offsetLocation(FF)V": function (this: JMotionEvent, dx: number, dy: number) { this.x += dx; this.y += dy; },
    "setLocation(FF)V": function (this: JMotionEvent, x: number, y: number) { this.x = x; this.y = y; },
    "getEdgeFlags()I": function (this: JMotionEvent) { return this.edgeFlags; },
    "transform(Landroid/graphics/Matrix;)V": () => {},
    "recycle()V": () => {},
    "getHistorySize()I": () => 0,
    "getHistoricalX(I)F": function (this: JMotionEvent) { return this.x; },
    "getHistoricalY(I)F": function (this: JMotionEvent) { return this.y; },
    "getHistoricalEventTime(I)J": function (this: JMotionEvent) { return BigInt(Math.round(this.eventTime)); },
    "getPressure()F": function (this: JMotionEvent) { return this.pressure; },
    "getSize()F": function (this: JMotionEvent) { return this.size; },
    "getSize(I)F": function (this: JMotionEvent) { return this.size; },
    "getToolMajor(I)F": function (this: JMotionEvent) { return this.toolMajor; },
    "getToolMinor(I)F": function (this: JMotionEvent) { return this.toolMinor; },
    "getToolType(I)I": function (this: JMotionEvent) { return this.toolType; },
    "getButtonState()I": () => 0,
    "getMetaState()I": function (this: JMotionEvent) { return this.metaState; },
    "static obtain(JJIFFI)Landroid/view/MotionEvent;": obtainEvent,
    "static obtain(JJIFFFFIFFII)Landroid/view/MotionEvent;": obtainFullEvent,
    "static obtain(JJIFFFFIFFIIII)Landroid/view/MotionEvent;": obtainFullEvent,
    "static obtainNoHistory(Landroid/view/MotionEvent;)Landroid/view/MotionEvent;": copyEvent,
    "static obtain(Landroid/view/MotionEvent;)Landroid/view/MotionEvent;": copyEvent,
  },
});

// MotionEvent$PointerCoords: a per-pointer snapshot filled in by getPointerCoords(int, PointerCoords).
// x/y are public Java fields (direct iget/iput from app code), not getter methods.
class JPointerCoords extends JObj {
  x = 0; y = 0; pressure = 0; size = 0;
  orientation = 0; toolMajor = 0; toolMinor = 0; touchMajor = 0; touchMinor = 0;
}
rt.register({
  name: "android/view/MotionEvent$PointerCoords", ctor: JPointerCoords,
  fields: {
    x: "x", y: "y", pressure: "pressure", size: "size", orientation: "orientation",
    toolMajor: "toolMajor", toolMinor: "toolMinor", touchMajor: "touchMajor", touchMinor: "touchMinor",
  },
  methods: {
    "<init>()V": () => {},
    "<init>(Landroid/view/MotionEvent$PointerCoords;)V": function (this: JPointerCoords, o: JPointerCoords | null) {
      if (o) Object.assign(this, o);
    },
    "clear()V": function (this: JPointerCoords) {
      this.x = this.y = this.pressure = this.size = this.orientation = 0;
      this.toolMajor = this.toolMinor = this.touchMajor = this.touchMinor = 0;
    },
    "copyFrom(Landroid/view/MotionEvent$PointerCoords;)V": function (this: JPointerCoords, o: JPointerCoords | null) {
      if (o) Object.assign(this, o);
    },
  },
});

// DragEvent: no drag-and-drop gesture pipeline exists (nothing ever starts a drag), but the
// class must exist for View$OnDragListener.onDrag(View, DragEvent) and app code that reads
// DragEvent.ACTION_* constants to link.
class JDragEvent extends JObj {
  action = 0; x = 0; y = 0; resultV = false;
  clipData: unknown = null; clipDescription: unknown = null; localState: unknown = null;
}
rt.register({
  name: "android/view/DragEvent", ctor: JDragEvent, ifaces: ["android/os/Parcelable"],
  statics: {
    ACTION_DRAG_STARTED: 1, ACTION_DRAG_LOCATION: 2, ACTION_DROP: 3,
    ACTION_DRAG_ENDED: 4, ACTION_DRAG_ENTERED: 5, ACTION_DRAG_EXITED: 6,
  },
  methods: {
    "getAction()I": function (this: JDragEvent) { return this.action; },
    "getX()F": function (this: JDragEvent) { return this.x; },
    "getY()F": function (this: JDragEvent) { return this.y; },
    "getResult()Z": function (this: JDragEvent) { return this.resultV ? 1 : 0; },
    "getClipData()Landroid/content/ClipData;": function (this: JDragEvent) { return this.clipData; },
    "getClipDescription()Landroid/content/ClipDescription;": function (this: JDragEvent) { return this.clipDescription; },
    "getLocalState()Ljava/lang/Object;": function (this: JDragEvent) { return this.localState; },
    "toString()Ljava/lang/String;": () => "DragEvent",
  },
});
