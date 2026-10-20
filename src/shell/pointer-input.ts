// One page-owned canvas's pointer/wheel stream. Java dispatch stays behind the injected boundary.
import { ACTION_CANCEL, ACTION_DOWN, ACTION_MOVE, ACTION_POINTER_DOWN, ACTION_POINTER_UP, ACTION_UP, queuePointer, type PointerSample,
  type TouchPointer } from "./pointer-queue.ts";

export type PointerGeometry = { width: number; height: number; scrollUnit: number; touchSlop: number; edgeSlop: number; minScalingSpan: number };
/** a MotionEvent's action and pointers to the display */
export type PointerDispatch = (action: number, pointers: TouchPointer[]) => Promise<void>;
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
    get scrollUnit() { return geometry().scrollUnit; }, get touchSlop() { return geometry().touchSlop; },
    get edgeSlop() { return geometry().edgeSlop; }, get minScalingSpan() { return geometry().minScalingSpan; } };
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

  // The wheel burst being driven (null while none is), whether its fingers are down, and the pointers
  // last dispatched for it.
  let hand: WheelHand | null = null, armed = false, last: TouchPointer[] = [], lastWheel = 0, pending = 0;

  /** A wheel stream — the fingers, and the momentum macOS sends after they lift — never gaps this
   *  long, and Chrome exposes no phase to tell the two apart. */
  const WHEEL_IDLE_MS = 120;

  function send(action: number, pointers: TouchPointer[]) {
    last = pointers;
    pending++;
    void dispatch(action, pointers).catch(error => { if (!closed) console.error("[input]", error); }).finally(() => { pending--; });
  }

  function cancelWheel() {
    if (armed) void dispatch(ACTION_CANCEL, last);
    hand = null; armed = false;
  }

  /** Lift the burst's fingers where they were last dispatched; a pinch's first finger goes first. */
  function releaseWheel() {
    if (armed) {
      if (last.length > 1) send(ACTION_POINTER_UP, last);
      send(ACTION_UP, last.slice(-1));
    }
    hand = null; armed = false;
  }

  /** `onDown` runs after a press is dispatched: the shell refocuses its hidden IME input there. */
  function listen() {
    listenOn("pointerdown", (e) => {
      if (hand) cancelWheel();
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
      // Chrome sends a trackpad pinch as wheel events with ctrlKey set, as it does Ctrl + a mouse
      // wheel; a burst that changes kind ends the gesture it was driving and starts the other.
      if (hand && hand.pinch !== e.ctrlKey) releaseWheel();
      if (!hand) {
        rect = canvas.getBoundingClientRect();
        const [x, y] = at(e);
        hand = e.ctrlKey ? pinchHand(device, x, y) : dragHand(device, rect, x, y);
      }
      hand.add(e);
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
    if (closed || !hand || pending) return;
    const idle = performance.now() - lastWheel > WHEEL_IDLE_MS;
    if (!armed) {
      // Under the slop nothing is dispatched at all, so a stray two-finger nudge cannot land a
      // press highlight, a tap or a long press on whatever the cursor happens to be over.
      if (hand.travel() < device.touchSlop) {
        if (idle) hand = null;
        return;
      }
      armed = true;
      // The MOVE below goes out in the same pass, so the scroll container intercepts and cancels the
      // child it pressed within one dispatch instead of leaving it lit for a frame.
      const down = hand.down();
      send(ACTION_DOWN, down.slice(0, 1));
      if (down.length > 1) send(ACTION_POINTER_DOWN | 1 << 8, down);
    }
    // The fingers follow the content, and are deliberately not clamped to the screen — pinning one at
    // an edge would stop a long coast dead, and every scroll container works off deltas, as every
    // scale detector works off span ratios.
    const next = hand.step();
    if (next.some((p, i) => p.x !== last[i].x || p.y !== last[i].y)) {
      send(ACTION_MOVE, next);
      return;
    }
    // The momentum after the fingers lift arrives as more wheel events, so by the time the stream
    // goes quiet the velocity has decayed on its own: UP flings nothing, and the trackpad's
    // inertia is the only inertia. UP rather than CANCEL because CANCEL makes a ViewPager snap
    // back to the page it started on instead of turning it.
    if (idle) releaseWheel();
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
    moved = armed = false;
    hand = null;
  } };
}

/** The synthetic fingers a wheel burst drives, in id order: `add` takes an event's deltas, `travel` is
 *  how far they would carry a finger from where it goes down, `down` places the fingers and `step`
 *  moves them on for the next MOVE. */
interface WheelHand { readonly pinch: boolean; add(e: WheelEvent): void; travel(): number; down(): TouchPointer[]; step(): TouchPointer[] }

/** A scroll: one finger, carried from where the burst began as far as the deltas go. */
function dragHand(device: PointerGeometry, rect: DOMRect, ox: number, oy: number): WheelHand {
  let ax = 0, ay = 0;
  return {
    pinch: false,
    add(e) {
      // deltaMode: 0 = CSS px, which is what a trackpad sends; 1 = lines; 2 = pages. A wheel notch
      // is three DOM lines and one AXIS_VSCROLL unit, which this device scrolls by scrollUnit px.
      const line = e.deltaMode === 1 ? device.scrollUnit / 3 : 0;
      ax += e.deltaX * (line || (e.deltaMode ? device.width : device.width / rect.width));
      ay += e.deltaY * (line || (e.deltaMode ? device.height : device.height / rect.height));
    },
    travel: () => Math.hypot(ax, ay),
    // at the origin: the app measures its own slop from where the gesture began
    down: () => [{ id: 0, x: ox, y: oy }],
    step: () => [{ id: 0, x: ox - ax, y: oy - ay }],
  };
}

/** A pinch: two fingers either side of the cursor, whose span follows the scale the deltas encode.
 *  They go down level, on the cursor's row: a phone's layout stacks full-width bands (bars, chips,
 *  sheets, the content between), and a level pair stays in the band the cursor is over where a pair
 *  across the rows lands one finger on a neighbour, which split touch then gives it. */
function pinchHand(device: PointerGeometry, ox: number, oy: number): WheelHand {
  /** the pinch's scale, the scale its fingers last moved to (1 where they went down), and half their
   *  starting span (0 until they go down) */
  let scale = 1, shown = 1, half = 0;
  const fingers = (k: number): TouchPointer[] => [{ id: 0, x: ox - half * k, y: oy }, { id: 1, x: ox + half * k, y: oy }];
  /** ScaleGestureDetector ends a scale below config_minScalingSpan; a pixel over, so float rounding cannot */
  const minSpan = () => device.minScalingSpan + 1;
  /** Half the span a pinch starts at. The detector begins once the span has moved its slop and is at
   *  least the minimum, so a spread starts one minimum span apart, the shortest reach. A squeeze needs
   *  room to close and starts two apart, or as far apart as the display allows outside its edge slop. */
  const startHalf = (spread: boolean) => (spread ? minSpan() : Math.min(2 * minSpan(), device.width - 2 * device.edgeSlop)) / 2;
  return {
    pinch: true,
    add(e) {
      // Chrome's pinch deltas encode deltaY = -100 ln(scale). Lines (Firefox's mouse notch is three)
      // count as a third of the 100 px Chrome gives a notch. The fingers close to one minimum span.
      scale = Math.max(scale * Math.exp(-e.deltaY * (e.deltaMode ? 100 / 3 : 1) / 100), minSpan() / 2 / (half || startHalf(false)));
    },
    // each finger travels half the span's change
    travel: () => startHalf(scale > 1) * Math.abs(scale - 1),
    down() {
      // About the cursor, slid only as far as keeps both out of the edge slop, where a press reads
      // as the edge of a hand: Google Maps, like AOSP's early ScaleGestureDetector, defers a pinch
      // until such a finger leaves it.
      half = startHalf(scale > 1);
      const slop = device.edgeSlop;
      ox = Math.min(Math.max(ox, slop + half), device.width - slop - half);
      oy = Math.min(Math.max(oy, slop), device.height - slop);
      return fingers(1);
    },
    // The fingers ease in and out as a hand's do: a detector scales by each MOVE's span ratio only
    // once it has taken the gesture, ScaleGestureDetector on the MOVE that crosses its slop and Google
    // Maps on its third sample, so the first steps must be short. A MOVE carries a finger as far as it
    // has come, or half the way left if that is less, but at least the touch slop and a pixel, so the
    // first just crosses it.
    step() {
      const rest = Math.abs(scale - shown) * half;
      const step = Math.max(device.touchSlop + 1, Math.min(Math.abs(shown - 1) * half, rest / 2));
      shown = rest <= step ? scale : shown + Math.sign(scale - shown) * step / half;
      return fingers(shown);
    },
  };
}
