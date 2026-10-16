// Host input: the browser's pointer and wheel streams become Android MotionEvents, so a
// trackpad's two-finger swipe reaches every app as a phone's one-finger drag.
import { device } from "./config.ts";
import { dispatchTouches } from "./device.ts";
import { imeActive } from "../android/ime.ts";
import { receiveIme, serveIme } from "./ime-port.ts";
import { onProcessExit } from "../process-exit.ts";
import { attachPointerInput } from "./pointer-input.ts";
let closeInput: (() => void) | undefined;
onProcessExit(() => closeInput?.());
if (typeof window !== "undefined") window.addEventListener("pagehide", () => closeInput?.(), { once: true });

/** `source` takes the pointer stream; the page-side editor (ime-port.ts) owns the text control for the root and every Worker */
export function attachIme(canvas: HTMLCanvasElement, kbd: HTMLTextAreaElement, source: HTMLElement): void {
  closeInput?.();
  let closed = false, focusTimer: ReturnType<typeof setTimeout> | undefined, stop: (() => void) | undefined;
  const channel = new MessageChannel(), keyboard = receiveIme(channel.port2, canvas, kbd);
  void serveIme(channel.port1).then(close => { if (closed) close(); else stop = close; });
  const pointers = attachPointerInput(canvas, () => device, dispatchTouches, () => {
    if (!imeActive()) return;
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => { if (!closed) keyboard.focus(); }, 0);
  }, source);
  closeInput = () => {
    if (closed) return;
    closed = true; clearTimeout(focusTimer); pointers.close(); keyboard.close(); stop?.();
    channel.port1.close(); channel.port2.close();
  };
}
