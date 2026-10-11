// Host input: the browser's pointer and wheel streams become Android MotionEvents, so a
// trackpad's two-finger swipe reaches every app as a phone's one-finger drag.
import { device } from "./config";
import { dispatchPointer } from "./device";
import { setInputElement, imeInput, imeAction, imeActive, imeHasAction, imeSelection, imeFinishComposition } from "../android/ime";
import { receiveIme, serveIme } from "./ime-port";
import { onProcessExit } from "../process-exit";
import { attachPointerInput } from "./pointer-input";
let closeInput: (() => void) | undefined;
onProcessExit(() => closeInput?.());
if (typeof window !== "undefined") window.addEventListener("pagehide", () => closeInput?.(), { once: true });

export function attachIme(canvas: HTMLCanvasElement, kbd: HTMLTextAreaElement, source: HTMLElement = canvas): void {
  closeInput?.();
  const events = new AbortController();
  let closed = false, focusTimer: ReturnType<typeof setTimeout> | undefined;
  let keyboard: ReturnType<typeof receiveIme> | undefined, stop: (() => void) | undefined;
  let channel: MessageChannel | undefined;
  if (source !== canvas) {
    // The same ordered page-side editor owns root and Worker controls. Java never mutates
    // the root DOM control while a later local edit is still queued.
    setInputElement(null);
    channel = new MessageChannel();
    keyboard = receiveIme(channel.port2, canvas, kbd);
    void serveIme(channel.port1).then(close => { if (closed) close(); else stop = close; });
  } else {
    setInputElement(kbd);
    kbd.addEventListener("input", event => void imeInput(kbd.value, kbd.selectionStart, kbd.selectionEnd, event instanceof InputEvent && event.isComposing), { signal: events.signal });
    kbd.addEventListener("select", () => void imeSelection(kbd.selectionStart, kbd.selectionEnd), { signal: events.signal });
    kbd.addEventListener("compositionend", () => void imeFinishComposition(), { signal: events.signal });
    kbd.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.isComposing && imeHasAction()) { event.preventDefault(); void imeAction(); }
    }, { signal: events.signal });
  }
  const pointers = attachPointerInput(canvas, () => device, dispatchPointer, () => {
    if (!imeActive()) return;
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => { if (!closed) { if (keyboard) keyboard.focus(); else kbd.focus(); } }, 0);
  }, source);
  closeInput = () => {
    if (closed) return;
    closed = true; clearTimeout(focusTimer); events.abort(); pointers.close(); keyboard?.close(); stop?.();
    channel?.port1.close(); channel?.port2.close();
  };
}
