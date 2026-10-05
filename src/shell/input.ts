// Host input: the browser's pointer and wheel streams become Android MotionEvents, so a
// trackpad's two-finger swipe reaches every app as a phone's one-finger drag.
import { device } from "./config";
import { dispatchPointer } from "./device";
import { setInputElement, imeInput, imeAction, imeActive, imeHasAction, imeSelection, imeFinishComposition } from "../android/ime";
import { attachPointerInput } from "./pointer-input";
let input: ReturnType<typeof attachPointerInput> | undefined;

export function attachIme(canvas: HTMLCanvasElement, kbd: HTMLTextAreaElement): void {
  setInputElement(kbd);
  input?.close();
  input = attachPointerInput(canvas, () => device, dispatchPointer, () => { if (imeActive()) setTimeout(() => kbd.focus(), 0); });
  kbd.addEventListener("input", (event) => void imeInput(kbd.value, kbd.selectionStart, kbd.selectionEnd, event instanceof InputEvent && event.isComposing));
  kbd.addEventListener("select", () => void imeSelection(kbd.selectionStart, kbd.selectionEnd));
  kbd.addEventListener("compositionend", () => void imeFinishComposition());
  kbd.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing && imeHasAction()) { e.preventDefault(); void imeAction(); }
  });
}

export function drainInput(): void { input?.drain(); }
