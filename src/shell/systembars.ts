import { attrStr, parseAXML } from "../android/axml";
import { cssColor, tfMedium } from "../android/graphics";
import { resString, type Resources } from "../android/res";
import { APPEARANCE_LIGHT_STATUS_BARS } from "../android/window";
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
export function drawSystemBarIcons(ctx: OffscreenCanvasRenderingContext2D, res: Resources, bars: SystemBars) {
  if (bars.visible & 1) drawStatusIcons(ctx, res, bars.status, bars.appearance, bars.mask, bars.systemUi);
}

type IconPaths = { wifi: Path2D; battery: Path2D; fill: Path2D; bolt: Path2D; withoutBolt: Path2D };
const paths = new WeakMap<Resources, IconPaths>();
let batteryImage: { density: number; level: number; status: number; dark: OffscreenCanvas; light: OffscreenCanvas } | null = null;
function iconPaths(res: Resources) {
  let cached = paths.get(res);
  if (cached) return cached;
  const path = (name: string) => new Path2D(resString(res, res.idFor("string", name, "android")));
  const file = res.fileOf(res.idFor("drawable", "ic_wifi_signal_4", "android"));
  const wifi = new Path2D();
  if (file) for (const node of parseAXML(file.bytes).children) {
    const data = attrStr(node, "pathData");
    if (data) wifi.addPath(new Path2D(data));
  }
  const bolt = path("config_batterymeterBoltPath"), withoutBolt = new Path2D();
  withoutBolt.rect(-3, -3, 18, 26);
  withoutBolt.addPath(bolt);
  cached = { wifi, battery: path("config_batterymeterPerimeterPath"), fill: path("config_batterymeterFillMask"), bolt, withoutBolt };
  paths.set(res, cached);
  return cached;
}
function drawBattery(p: IconPaths, color: string): OffscreenCanvas {
  const image = new OffscreenCanvas(Math.ceil(device.dp(7.8)), Math.ceil(device.dp(13)));
  const ctx = image.getContext("2d")!;
  ctx.scale(device.dp(13) / 20, device.dp(13) / 20);
  ctx.fillStyle = color;
  if (device.battery.status === 2) ctx.clip(p.withoutBolt, "evenodd");
  ctx.fill(p.battery, "evenodd");
  ctx.save();
  ctx.clip(p.fill);
  const top = device.battery.level >= 95 ? 4 : Math.floor(4 + 14 * (1 - device.battery.level / 100));
  ctx.fillRect(2, top, 8, 18 - top);
  ctx.restore();
  if (device.battery.status === 2) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.lineJoin = "round";
    ctx.stroke(p.bolt);
  }
  return image;
}
function lightBackground(color: number): boolean {
  return 0.299 * ((color >> 16) & 255) + 0.587 * ((color >> 8) & 255) + 0.114 * (color & 255) > 160;
}
let clockMinute = -1, clockText = "";

function drawStatusIcons(ctx: OffscreenCanvasRenderingContext2D, res: Resources, bg: number, appearance: number, mask: number, systemUi: number) {
  const dark = mask & APPEARANCE_LIGHT_STATUS_BARS ? !!(appearance & APPEARANCE_LIGHT_STATUS_BARS)
    : !!(systemUi & 0x2000) || lightBackground(bg);
  ctx.fillStyle = dark ? "#00000099" : "#ffffff";
  ctx.font = `500 ${device.dp(14)}px ${tfMedium.family}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const now = new Date(), minute = now.getHours() * 60 + now.getMinutes();
  if (minute !== clockMinute) { clockMinute = minute; clockText = `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`; }
  ctx.fillText(clockText, device.dp(8), device.statusBar / 2);

  // SystemUI reserves 20dp for the privacy dot beyond its 8dp end padding.
  const p = iconPaths(res), right = device.width - device.dp(28);
  if (!batteryImage || batteryImage.density !== device.density || batteryImage.level !== device.battery.level || batteryImage.status !== device.battery.status) {
    batteryImage = { density: device.density, ...device.battery, dark: drawBattery(p, "#000000"), light: drawBattery(p, "#ffffff") };
  }
  ctx.save();
  if (dark) ctx.globalAlpha *= 0.6;
  ctx.drawImage(dark ? batteryImage.dark : batteryImage.light, right - device.dp(7.8), (device.statusBar - device.dp(13)) / 2 - device.dp(0.5));
  ctx.restore();

  ctx.save();
  ctx.translate(right - device.dp(28), (device.statusBar - device.dp(15)) / 2 - device.dp(0.5));
  ctx.scale(device.dp(15) / 24, device.dp(15) / 24);
  ctx.fill(p.wifi);
  ctx.restore();
}
