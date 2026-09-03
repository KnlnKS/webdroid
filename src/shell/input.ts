// Host input: the browser's pointer stream becomes Android MotionEvents. The shell owns the
// mapping from the canvas's CSS box to framebuffer px; the framework only ever sees a
// MotionEvent, and never learns what kind of device produced it.
import { device } from "./config";
import { dispatchPointer } from "./device";

// getBoundingClientRect forces layout, so the rect a gesture maps through is read once when the
// gesture starts, not per move.
let rect = new DOMRect(0, 0, 1, 1);
let down = false;

const at = (e: { clientX: number; clientY: number }): [number, number] =>
  [(e.clientX - rect.left) * device.width / rect.width, (e.clientY - rect.top) * device.height / rect.height];

/** `onDown` runs after a press is dispatched: the shell refocuses its hidden IME input there. */
export function attachInput(canvas: HTMLCanvasElement, onDown: () => void) {
  canvas.addEventListener("pointerdown", (e) => {
    down = true;
    rect = canvas.getBoundingClientRect();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    const [x, y] = at(e);
    void dispatchPointer(0, x, y);
    onDown();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!down) return;
    const [x, y] = at(e);
    void dispatchPointer(2, x, y);
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!down) return;
    down = false;
    const [x, y] = at(e);
    void dispatchPointer(1, x, y);
  });
  canvas.addEventListener("pointercancel", () => {
    if (!down) return;
    down = false;
    void dispatchPointer(3, 0, 0);
  });
}
