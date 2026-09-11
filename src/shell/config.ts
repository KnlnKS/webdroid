/**
 * The one device profile. The screen is resolved at module init: `?screen=` / `WEBDROID_SCREEN`
 * pin one for a run and the shell's settings panel persists one. This file imports nothing and
 * treats every host global as optional, because bun scripts import it too.
 */

/** AOSP DisplayMetrics.DENSITY_DEFAULT: the dpi at which one dp is one px. */
const DENSITY_DEFAULT = 160;

/** what the shell persists a user-chosen screen under. Not app state: `wd.reset()` leaves it. */
const SCREEN_KEY = "wd:screen";

export type Screen = { width: number; height: number; densityDpi: number };
type DeviceOrientation = 1 | 2; // Configuration.ORIENTATION_PORTRAIT / LANDSCAPE

/** Fixed ActivityInfo requests. Sensor/user/unspecified requests keep the display as it is. */
export function orientationForRequest(request: number): DeviceOrientation | null {
  if (request === 0 || request === 6 || request === 8 || request === 11) return 2;
  if (request === 1 || request === 7 || request === 9 || request === 12) return 1;
  return null;
}

/** Rotate a configured framebuffer while preserving its exact two dimensions and density. */
function orientScreen(screen: Screen, orientation: DeviceOrientation): Screen {
  const landscape = screen.width > screen.height;
  if ((orientation === 2) === landscape || screen.width === screen.height) return screen;
  return { width: screen.height, height: screen.width, densityDpi: screen.densityDpi };
}

/** A current phone: 480dpi divides both sides exactly and keeps the 360dp width bucket. */
const DEFAULT: Screen = { width: 1080, height: 2424, densityDpi: 480 };

/** `1080x2424@480` — the dpi is optional and falls back to the built-in profile's. */
export function parseScreen(s: string | null | undefined): Screen | null {
  const m = /^\s*(\d+)\s*x\s*(\d+)\s*(?:@\s*(\d+))?\s*$/i.exec(s ?? "");
  if (!m) return null;
  const width = +m[1], height = +m[2], densityDpi = m[3] ? +m[3] : DEFAULT.densityDpi;
  return width > 0 && height > 0 && densityDpi > 0 ? { width, height, densityDpi } : null;
}

const formatScreen = (s: Screen): string => `${s.width}x${s.height}@${s.densityDpi}`;

/** localStorage throws outright in some privacy modes, so every touch of it is guarded. */
export function readStoredScreen(): Screen | null {
  try { return parseScreen(globalThis.localStorage?.getItem(SCREEN_KEY)); } catch { return null; }
}

export function storeScreen(s: Screen | null): void {
  try {
    if (s) globalThis.localStorage?.setItem(SCREEN_KEY, formatScreen(s));
    else globalThis.localStorage?.removeItem(SCREEN_KEY);
  } catch { /* the setting is a convenience, not state anything depends on */ }
}

/** A per-run pin beats a persisted preference, so an e2e run scores the geometry it asked for. */
function resolveScreen(): Screen {
  const url = typeof location !== "undefined" ? new URLSearchParams(location.search).get("screen") : null;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.WEBDROID_SCREEN;
  return parseScreen(url) ?? parseScreen(env) ?? readStoredScreen() ?? DEFAULT;
}

const screen = resolveScreen();

export const device = {
  width: screen.width,
  height: screen.height,
  densityDpi: screen.densityDpi,
  /** AOSP: DisplayMetrics.density is densityDpi/160, so the two can never disagree */
  get density(): number { return this.densityDpi / DENSITY_DEFAULT; },
  /** AOSP status_bar_height */
  statusBarDp: 24,
  /** the gesture/navigation bar: not painted (the activity spans the whole framebuffer), but it
   *  is what the device reports as the bottom window inset, so an edge-to-edge app pads for it */
  navBarDp: 24,
  /** AOSP ViewConfiguration.TOUCH_SLOP: dp of travel before a press counts as a drag */
  touchSlopDp: 8,
  /** AOSP ViewConfiguration.SCROLL_FACTOR: dp scrolled per wheel/keyboard scroll unit */
  scrollUnitDp: 64,
  sdk: 33,
  release: "13",
  lang: "en",
  region: "US",
  /** the browser's dark-mode preference, live as a device's is (see setDeviceNight) */
  get night(): boolean { return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false; },
  /** PackageManager.hasSystemFeature: what this device can back — touch, both orientations,
   *  a network, a WebView — and nothing it cannot (no camera, GPS, telephony or sensors) */
  features: ["android.hardware.touchscreen", "android.hardware.touchscreen.multitouch", "android.hardware.touchscreen.multitouch.distinct",
    "android.hardware.faketouch", "android.hardware.screen.portrait", "android.hardware.screen.landscape", "android.hardware.wifi",
    "android.software.webview", "android.software.input_methods", "android.software.home_screen", "android.software.app_widgets"],
  /** /proc/cpuinfo, /proc/meminfo and uname: VFPv3 without NEON, as the ARM32 tier implements */
  cpu: { cores: 4, features: "swp half thumb fastmult vfp edsp thumbee vfpv3 tls", hardware: "webdroid", memKb: 2 * 1024 * 1024 },
  get statusBar(): number { return Math.round(this.statusBarDp * this.density); },
  get navBar(): number { return Math.round(this.navBarDp * this.density); },
  get touchSlop(): number { return Math.round(this.touchSlopDp * this.density); },
  get scrollUnit(): number { return this.scrollUnitDp * this.density; },
  get widthDp(): number { return Math.round(this.width / this.density); },
  get orientation(): DeviceOrientation { return this.width > this.height ? 2 : 1; },
  get smallestWidthDp(): number { return Math.round(Math.min(this.width, this.height) / this.density); },
  /** the activity's height in dp — the status bar is not part of it */
  get heightDp(): number { return Math.round((this.height - this.statusBar) / this.density); },
  /** full display height in dp, status bar included (resource qualifiers use this) */
  get screenHeightDp(): number { return Math.round(this.height / this.density); },
  /** unrounded: stroke widths and glyph offsets are legitimately fractional */
  dp(n: number): number { return n * this.density; },
};

/** Apply an Activity orientation to the live display. Returns whether its geometry changed. */
export function setDeviceOrientation(orientation: DeviceOrientation): boolean {
  const next = orientScreen(device, orientation);
  if (next === device) return false;
  device.width = next.width;
  device.height = next.height;
  return true;
}
