// The desktop keyboard on system_server's focused window: the keys a phone's keyboard has, with
// Escape and the browser's Back key as the phone's Back.
import { dispatchKey, hasFocusedWindow } from "../android/server/wm.ts";
import { imeActive } from "../android/ime.ts";
import { keyCodeOfDom, keyCodes } from "../android/keycodes.ts";
import { onProcessExit } from "../process-exit.ts";

const BACK = keyCodes.get("BACK")!;
const forwarded = new Map([["Escape", BACK], ["BrowserBack", BACK],
  ...["Enter", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].map(key => [key, keyCodeOfDom.get(key)!] as const)]);

/** every key but Back stays with `kbd` while the IME edits through it */
export function attachKeyboard(kbd: HTMLTextAreaElement): void {
  const listeners = new AbortController(), close = () => listeners.abort();
  document.addEventListener("keydown", event => {
    if (!hasFocusedWindow() || event.isComposing) return;
    const key = forwarded.get(event.key);
    if (key === undefined || key !== BACK && event.target === kbd && imeActive()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void dispatchKey(key).catch(error => console.error("[input]", error));
  }, { capture: true, signal: listeners.signal });
  window.addEventListener("pagehide", close, { once: true });
  onProcessExit(close);
}
