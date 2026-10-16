// One page-owned canvas's pointer/wheel stream. Java dispatch stays behind the injected boundary.
import { queuePointer, type PointerSample, type TouchPointer } from "./pointer-queue";

export type PointerGeometry = { width: number; height: number; scrollUnit: number; touchSlop: number };
/** a MotionEvent's action and pointers to the display */
export type PointerDispatch = (action: number, pointers: TouchPointer[]) => Promise<void>;
const ACTION_DOWN = 0, ACTION_UP = 1, ACTION_MOVE = 2, ACTION_CANCEL = 3, ACTION_POINTER_DOWN = 5, ACTION_POINTER_UP = 6;
/** InputReader's MAX_POINTERS: a touchscreen reports no more */
const MAX_POINTERS = 16;
/** the key of the second finger a modifier-held press mirrors; browser pointerIds are never negative */
const MIRROR = -1;
const attached = new Set<() => void>();
/** send every canvas's batched finger moves and step its wheel gesture: once per display frame */
export function drainPointers(): void { for (const drain of attached) drain(); }
export function attachPointerInput(canvas: HTMLCanvasElement, geometry: () => PointerGeometry,
  dispatch: PointerDispatch, onDown: () => void = () => {}, source: HTMLElement = canvas) {
  const listeners = new AbortController();
  let closed = false;
  const device = { get width() { return geometry().width; }, get height() { return geometry().height; },
    get scrollUnit() { return geometry().scrollUnit; }, get touchSlop() { return geometry().touchSlop; } };
  function listenOn<K extends keyof HTMLElementEventMap>(name: K, handler: (event: HTMLElementEventMap[K]) => void,
    options: AddEventListenerOptions = {}) {
    source.addEventListener(name, handler, { ...options, signal: listeners.signal });
  }
  // getBoundingClientRect forces layout, so the rect a gesture maps through is read once when the
  // gesture starts, not per move.
  let rect = new DOMRect(0, 0, 1, 1);
  /** the gesture's pointers by browser pointerId (MIRROR for the mirrored finger) */
  const touches = new Map<number, TouchPointer>();
  /** the pointer whose press is mirrored through the screen's centre, and the mirror's marker */
  let mirrored: number | null = null;
  let marker: HTMLElement | null = null;
  let moved = false;
  let pointerPending = false;
  const pendingPointers: PointerSample[] = [];

  const at = (e: { clientX: number; clientY: number }): [number, number] =>
    [(e.clientX - rect.left) * device.width / rect.width, (e.clientY - rect.top) * device.height / rect.height];

  /** Dispatch at once (Chrome already aligns moves to frames), so the frame being prepared sees
   *  the input; while one is in flight, later samples queue and consecutive moves coalesce. */
  function sendPointer(sample: PointerSample): void {
    if (pointerPending) {
      queuePointer(pendingPointers, sample);
      return;
    }
    pointerPending = true;
    void dispatch(sample.action, sample.pointers).catch(error => { if (!closed) console.error("[input]", error); }).finally(() => {
      pointerPending = false;
      const next = closed ? undefined : pendingPointers.shift();
      if (next) sendPointer(next);
    });
  }

  /** the gesture's pointers in id order, copied so a queued sample keeps them as they were */
  const snapshot = () => [...touches.values()].sort((a, b) => a.id - b.id).map(p => ({ ...p }));
  /** One MOVE for every pointer that moved since the last, as InputReader reports one per sync */
  function flushMove() {
    if (!moved) return;
    moved = false;
    if (touches.size) sendPointer({ action: ACTION_MOVE, pointers: snapshot() });
  }
  /** A pointer goes down with the lowest id not in use, as InputReader assigns them; the first
   *  is DOWN, any other POINTER_DOWN with its index among the pointers. */
  function press(key: number, x: number, y: number) {
    let id = 0;
    while ([...touches.values()].some(p => p.id === id)) id++;
    touches.set(key, { id, x, y });
    const pointers = snapshot();
    sendPointer({ action: pointers.length === 1 ? ACTION_DOWN : ACTION_POINTER_DOWN | pointers.findIndex(p => p.id === id) << 8, pointers });
  }
  /** POINTER_UP still carries the lifting pointer; the last pointer up is UP */
  function lift(key: number) {
    const { id } = touches.get(key)!, pointers = snapshot();
    touches.delete(key);
    sendPointer({ action: pointers.length === 1 ? ACTION_UP : ACTION_POINTER_UP | pointers.findIndex(p => p.id === id) << 8, pointers });
  }
  /** move a pointer to where the event is, and the mirrored finger opposite it */
  function track(key: number, e: PointerEvent): TouchPointer | undefined {
    const p = touches.get(key);
    if (!p) return;
    [p.x, p.y] = at(e);
    const mirror = key === mirrored ? touches.get(MIRROR) : undefined;
    if (mirror) {
      mirror.x = device.width - p.x; mirror.y = device.height - p.y;
      marker?.style.setProperty("translate", `${rect.left + rect.right - e.clientX}px ${rect.top + rect.bottom - e.clientY}px`);
    }
    return p;
  }
  function endMirror() {
    mirrored = null;
    marker?.remove();
    marker = null;
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
    void dispatch(action, [{ id: 0, x, y }]).catch(error => { if (!closed) console.error("[input]", error); }).finally(() => { pending--; });
  }

  function cancelWheel() {
    if (armed) void dispatch(ACTION_CANCEL, [{ id: 0, x: lx, y: ly }]);
    live = armed = false;
  }

  /** `onDown` runs after a press is dispatched: the shell refocuses its hidden IME input there. */
  function listen() {
    listenOn("pointerdown", (e) => {
      if (live) cancelWheel();
      if (touches.has(e.pointerId) || touches.size === MAX_POINTERS) return;
      if (!touches.size) rect = canvas.getBoundingClientRect();
      try { source.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      flushMove();
      const [x, y] = at(e);
      press(e.pointerId, x, y);
      // A mouse or pen has one pointer, so with Alt held its press brings a second finger,
      // mirrored through the screen's centre as the emulator's pinch does: dragging toward or
      // away from the centre pinches, and around it rotates.
      if (e.altKey && e.pointerType !== "touch" && touches.size === 1) {
        mirrored = e.pointerId;
        press(MIRROR, device.width - x, device.height - y);
        marker = document.createElement("div");
        marker.style.cssText = "position:fixed;left:-10px;top:-10px;width:20px;height:20px;border-radius:50%;pointer-events:none;"
          + "z-index:2147483647;background:rgb(255 255 255/.35);box-shadow:0 0 0 2px rgb(0 0 0/.35)";
        document.body.append(marker);
        track(e.pointerId, e);
      }
      onDown();
    });
    listenOn("pointermove", (e) => {
      if (!track(e.pointerId, e)) return;
      // Each finger's move is an event of its own, with a microtask checkpoint after it, so the
      // moves of several fingers wait for the frame's drain: Chrome dispatches a frame's moves just
      // before its animation frame callbacks. One browser pointer moves at once, as before.
      moved = true;
      if (touches.size - +(mirrored !== null) === 1) flushMove();
    });
    listenOn("pointerup", (e) => {
      if (!touches.has(e.pointerId)) return;
      flushMove();
      track(e.pointerId, e);
      lift(e.pointerId);
      if (e.pointerId === mirrored) { lift(MIRROR); endMirror(); }
    });
    listenOn("pointercancel", (e) => {
      if (!touches.has(e.pointerId)) return;
      // the whole gesture is cancelled; the pointers still down are ignored until they lift
      moved = false;
      sendPointer({ action: ACTION_CANCEL, pointers: snapshot() });
      touches.clear();
      endMirror();
    });
    listenOn("wheel", (e) => {
      // the page must not scroll under the phone, and a horizontal swipe must not walk history.
      // Chrome hands over non-cancelable wheels once its compositor owns a scroll; calling
      // preventDefault on one of those only logs.
      if (e.cancelable) e.preventDefault();
      if (touches.size) return;
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
  function drain() {
    flushMove(); // several fingers' moves this frame
    if (closed || !live || pending) return;
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
  listen();
  attached.add(drain);
  return { close(): void {
    if (closed) return;
    closed = true;
    attached.delete(drain);
    listeners.abort();
    pendingPointers.length = 0;
    touches.clear();
    endMirror();
    moved = live = armed = false;
  } };
}
