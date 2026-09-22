// Host input: the browser's pointer and wheel streams become Android MotionEvents, so a
// trackpad's two-finger swipe reaches every app as a phone's one-finger drag.
import { device } from "./config";
import { dispatchPointer } from "./device";
import { setInputElement } from "../android/textview";
import { imeInput, imeAction, imeActive, imeHasAction, imeSelection, imeFinishComposition } from "../android/ime";
import { guestNow } from "../guest-clock";

export function attachIme(canvas: HTMLCanvasElement, kbd: HTMLTextAreaElement): void {
  setInputElement(kbd);
  attachInput(canvas, () => { if (imeActive()) setTimeout(() => kbd.focus(), 0); });
  kbd.addEventListener("input", (event) => void imeInput(kbd.value, kbd.selectionStart, kbd.selectionEnd, event instanceof InputEvent && event.isComposing));
  kbd.addEventListener("select", () => void imeSelection(kbd.selectionStart, kbd.selectionEnd));
  kbd.addEventListener("compositionend", () => void imeFinishComposition());
  kbd.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing && imeHasAction()) { e.preventDefault(); void imeAction(); }
  });
}

// getBoundingClientRect forces layout, so the rect a gesture maps through is read once when the
// gesture starts, not per move.
let rect = new DOMRect(0, 0, 1, 1);
let down = false;
type PointerSample = { action: number; x: number; y: number; at: number };
let pointerPending = false;
let pendingMove: PointerSample | null = null;
let pendingEnd: PointerSample | null = null;

const at = (e: { clientX: number; clientY: number }): [number, number] =>
  [(e.clientX - rect.left) * device.width / rect.width, (e.clientY - rect.top) * device.height / rect.height];

function sendPointer(sample: PointerSample): void {
  if (pointerPending) {
    if (sample.action === 2) pendingMove = sample;
    else pendingEnd = sample;
    return;
  }
  pointerPending = true;
  requestAnimationFrame(() => {
    void dispatchPointer(sample.action, sample.x, sample.y, sample.at).finally(() => {
      pointerPending = false;
      const next = pendingMove ?? pendingEnd;
      if (pendingMove) pendingMove = null;
      else pendingEnd = null;
      if (next) sendPointer(next);
    });
  });
}

// The synthetic finger a wheel burst drives: where it went down, how far the deltas have carried
// it, and where it was last dispatched.
let ox = 0, oy = 0, ax = 0, ay = 0, lx = 0, ly = 0;
let live = false, armed = false, lastWheel = 0, pending = 0;

/** A wheel stream — the fingers, and the momentum macOS sends after they lift — never gaps this
 *  long, and Chrome exposes no phase to tell the two apart. */
const WHEEL_IDLE_MS = 120;

function send(action: number, x: number, y: number) {
  lx = x; ly = y;
  pending++;
  void dispatchPointer(action, x, y).finally(() => { pending--; });
}

function cancelWheel() {
  if (armed) void dispatchPointer(3, lx, ly);
  live = armed = false;
}

/** `onDown` runs after a press is dispatched: the shell refocuses its hidden IME input there. */
function attachInput(canvas: HTMLCanvasElement, onDown: () => void) {
  canvas.addEventListener("pointerdown", (e) => {
    if (live) cancelWheel();
    down = true;
    rect = canvas.getBoundingClientRect();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    const [x, y] = at(e);
    sendPointer({ action: 0, x, y, at: guestNow() });
    onDown();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!down) return;
    const [x, y] = at(e);
    sendPointer({ action: 2, x, y, at: guestNow() });
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!down) return;
    down = false;
    const [x, y] = at(e);
    sendPointer({ action: 1, x, y, at: guestNow() });
  });
  canvas.addEventListener("pointercancel", () => {
    if (!down) return;
    down = false;
    sendPointer({ action: 3, x: 0, y: 0, at: guestNow() });
  });
  canvas.addEventListener("wheel", (e) => {
    // the page must not scroll under the phone, and a horizontal swipe must not walk history.
    // Chrome hands over non-cancelable wheels once its compositor owns a scroll; calling
    // preventDefault on one of those only logs.
    if (e.cancelable) e.preventDefault();
    if (down) return;
    if (!live) {
      rect = canvas.getBoundingClientRect();
      [ox, oy] = at(e);
      ax = ay = 0;
      live = true;
      armed = false;
    }
    // deltaMode: 0 = CSS px, which is what a trackpad sends; 1 = lines; 2 = pages. A wheel notch
    // is three DOM lines and one AXIS_VSCROLL unit, which this device scrolls by scrollUnit px.
    const line = e.deltaMode === 1 ? device.scrollUnit / 3 : 0;
    ax += e.deltaX * (line || (e.deltaMode ? device.width : device.width / rect.width));
    ay += e.deltaY * (line || (e.deltaMode ? device.height : device.height / rect.height));
    lastWheel = performance.now();
  }, { passive: false });
}

/**
 * One step of the wheel gesture, once per frame. AOSP drains input in Choreographer's input
 * phase, ahead of animation and layout, and this has to for the same reason: a trackpad fires up
 * to 120 times a second while dispatchPointer resolves through the serialized main-looper queue,
 * so one MOVE per event builds a backlog and the gesture visibly lags the fingers. Accumulate
 * instead, and dispatch where the fingers have reached once the previous one has landed.
 */
export function drainInput() {
  if (!live || pending) return;
  const idle = performance.now() - lastWheel > WHEEL_IDLE_MS;
  if (!armed) {
    // Under the slop nothing is dispatched at all, so a stray two-finger nudge cannot land a
    // press highlight, a tap or a long press on whatever the cursor happens to be over.
    if (Math.hypot(ax, ay) < device.touchSlop) { if (idle) live = false; return; }
    armed = true;
    // DOWN at the origin: the app measures its own slop from where the gesture began. The MOVE
    // below goes out in the same pass, so the scroll container intercepts and cancels the child
    // it pressed within one dispatch instead of leaving it lit for a frame.
    send(0, ox, oy);
  }
  // The finger follows the content, and is deliberately not clamped to the screen — pinning it
  // at an edge would stop a long coast dead, and every scroll container works off deltas.
  const x = ox - ax, y = oy - ay;
  if (x !== lx || y !== ly) { send(2, x, y); return; }
  // The momentum after the fingers lift arrives as more wheel events, so by the time the stream
  // goes quiet the velocity has decayed on its own: UP flings nothing, and the trackpad's
  // inertia is the only inertia. UP rather than CANCEL because CANCEL makes a ViewPager snap
  // back to the page it started on instead of turning it.
  if (idle) { live = armed = false; send(1, x, y); }
}
