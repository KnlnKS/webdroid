// Host input: the browser's pointer and wheel streams become Android MotionEvents, so a
// trackpad's two-finger swipe reaches every app as a phone's one-finger drag.
import { device } from "./config.ts";
import { dispatchTouches } from "./device.ts";
import { attachRealmInput, serveInput } from "./input-port.ts";
import { onProcessExit } from "../process-exit.ts";
let closeInput: (() => void) | undefined;
onProcessExit(() => closeInput?.());
if (typeof window !== "undefined") window.addEventListener("pagehide", () => closeInput?.(), { once: true });

/** `source` takes the pointer stream; the page-side editor (input-port.ts) owns the text control for the root and every Worker */
export function attachIme(canvas: HTMLCanvasElement, kbd: HTMLTextAreaElement, source: HTMLElement): void {
  closeInput?.();
  let closed = false, stop: (() => void) | undefined;
  const { port1, port2 } = new MessageChannel();
  const realm = attachRealmInput(canvas, device, port2, { dispatch: dispatchTouches, kbd, source });
  void serveInput(port1).then(close => { if (closed) close(); else stop = close; });
  closeInput = () => {
    if (closed) return;
    closed = true; realm.close(); stop?.(); port1.close();
  };
}
