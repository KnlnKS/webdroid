import { inputWindowRegions, watchInputWindows, hasFocusedWindow } from "../android/server/wm.ts";
import { onProcessExit } from "../process-exit.ts";

/** Transparent hit regions keep nonmodal windows from intercepting the app/WebView underneath. */
export function systemInputLayer(canvas: HTMLCanvasElement, geometry: () => { width: number; height: number }) {
  const element = document.createElement("div");
  element.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:2147483647";
  element.tabIndex = -1;
  element.style.outline = "none";
  canvas.parentElement!.append(element);
  let focused = false, previous: HTMLElement | null = null;
  const stop = watchInputWindows(() => {
    const nextFocus = hasFocusedWindow();
    if (nextFocus && !focused) {
      previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.focus({ preventScroll: true });
    } else if (!nextFocus && focused) {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      previous = null;
    }
    focused = nextFocus;
    const { width, height } = geometry();
    element.replaceChildren(...inputWindowRegions().map(rect => {
      const hit = document.createElement("div");
      hit.style.cssText = "position:absolute;pointer-events:auto;touch-action:none";
      hit.style.left = 100 * rect.left / width + "%";
      hit.style.top = 100 * rect.top / height + "%";
      hit.style.width = 100 * (rect.right - rect.left) / width + "%";
      hit.style.height = 100 * (rect.bottom - rect.top) / height + "%";
      return hit;
    }));
  });
  let closed = false;
  function close() {
    if (closed) return;
    closed = true; stop(); element.remove(); window.removeEventListener("pagehide", close);
  }
  window.addEventListener("pagehide", close, { once: true });
  onProcessExit(close);
  return { element, close };
}
