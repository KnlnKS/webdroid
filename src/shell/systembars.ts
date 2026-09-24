import { cssColor } from "../android/graphics";
import { device } from "./config";
import type { JView } from "../android/view";
import { rootWindowInsets } from "../android/windowinsets";
import type { Overlay } from "../android/popup";

export function resolveSystemBars(activity: JView, overlays: readonly Overlay[]) {
  let root = activity;
  for (let i = overlays.length - 1; i >= 0; i--) {
    const view = overlays[i].view, window = view.windowOwner;
    if (view.visibility !== 0 || !window || window.flags & 8) continue;
    if (view.left <= 0 && view.top <= 0 && view.right >= device.width && view.bottom >= device.height) { root = view; break; }
  }
  const window = root.windowOwner;
  return { root, visible: rootWindowInsets(root).vis, status: window?.statusBarColor ?? -16777216,
    navigation: window?.navBarColor ?? -16777216, appearance: window?.appearance ?? 0,
    mask: window?.appearanceMask ?? 0, systemUi: root.systemUiVisibility };
}
type SystemBars = ReturnType<typeof resolveSystemBars>;
export function drawSystemBarBackgrounds(ctx: OffscreenCanvasRenderingContext2D, bars: SystemBars) {
  if (bars.visible & 1) { ctx.fillStyle = cssColor(bars.status); ctx.fillRect(0, 0, device.width, device.statusBar); }
  if (bars.visible & 2) { ctx.fillStyle = cssColor(bars.navigation); ctx.fillRect(0, device.height - device.navBar, device.width, device.navBar); }
}
