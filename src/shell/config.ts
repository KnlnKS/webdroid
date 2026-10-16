/**
 * The one device profile. The screen is resolved at module init: `?screen=` / `WEBDROID_SCREEN`
 * pin one for a run and the shell's settings panel persists one. This file imports only recorded
 * data and treats every host global as optional, because bun scripts import it too.
 */
import { DEVICE_PROPERTIES } from "./device-properties";

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

/** What DisplayRotation resolves a request against, each landscape or not: the orientation
 *  sensor's proposed rotation (the last physical one) and the natural rotation (ROTATION_0). */
export type Rotation = { sensor: boolean; natural: boolean };
/** DisplayRotation.rotationForOrientation, landscape or not: a fixed request keeps its own,
 *  nosensor takes the natural rotation and any other the sensor's, as no rotation lock is set.
 *  Locked (14) keeps the display as it is, as does null: no activity that sets it. */
export function rotationForRequest(request: number | null, rotation: Rotation): boolean | null {
  if (request === null || request === 14) return null;
  const fixed = orientationForRequest(request);
  return fixed ? fixed === 2 : request === 5 ? rotation.natural : rotation.sensor;
}

/** Rotate a configured framebuffer while preserving its exact two dimensions and density. */
function orientScreen(screen: Screen, orientation: DeviceOrientation): Screen {
  const landscape = screen.width > screen.height;
  if ((orientation === 2) === landscape || screen.width === screen.height) return screen;
  return { width: screen.height, height: screen.width, densityDpi: screen.densityDpi };
}

/** A current phone: 480dpi divides both sides exactly and keeps the 360dp width bucket. */
const DEFAULT: Screen = { width: 1080, height: 2160, densityDpi: 480 };

/** `1080x2160@480` — the dpi is optional and falls back to the built-in profile's. */
export function parseScreen(s: string | null | undefined): Screen | null {
  const m = /^\s*(\d+)\s*x\s*(\d+)\s*(?:@\s*(\d+))?\s*$/i.exec(s ?? "");
  if (!m) return null;
  const width = +m[1], height = +m[2], densityDpi = m[3] ? +m[3] : DEFAULT.densityDpi;
  return width > 0 && height > 0 && densityDpi > 0 ? { width, height, densityDpi } : null;
}

/** the `?screen=` form parseScreen reads back */
export const formatScreen = (s: Screen): string => `${s.width}x${s.height}@${s.densityDpi}`;

/** localStorage throws outright in some privacy modes, so every touch of it is guarded. */
function readStoredScreen(): Screen | null {
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
const query = typeof location === "undefined" ? null : new URLSearchParams(location.search);
const statusBarDp = Number(query?.get("statusBarDp") ?? 0);
const pinnedHz = Number(query?.get("hz"));

export const device = {
  width: screen.width,
  height: screen.height,
  densityDpi: screen.densityDpi,
  /** `?hz=` pins it (process Workers inherit the page's); otherwise the shell sets the host
   *  display's rate before boot. Choreographer, Display and eglSwapBuffers pace to it. */
  refreshRate: pinnedHz > 0 ? pinnedHz : 60,
  get frameIntervalNanos(): bigint { return BigInt(Math.round(1e9 / this.refreshRate)); },
  /** AOSP: DisplayMetrics.density is densityDpi/160, so the two can never disagree */
  get density(): number { return this.densityDpi / DENSITY_DEFAULT; },
  statusBarDp: Number.isFinite(statusBarDp) && statusBarDp >= 0 ? statusBarDp : 0,
  /** the gesture/navigation bar inset */
  navBarDp: 24,
  /** AOSP ViewConfiguration.TOUCH_SLOP: dp of travel before a press counts as a drag */
  touchSlopDp: 8,
  /** AOSP ViewConfiguration.EDGE_SLOP: dp from the screen's edge where a touch reads as the edge of a hand */
  edgeSlopDp: 12,
  /** AOSP ViewConfiguration.SCROLL_FACTOR: dp scrolled per wheel/keyboard scroll unit */
  scrollUnitDp: 64,
  /** framework-res config_minScalingSpan: ScaleGestureDetector does not scale two fingers closer */
  minScalingSpanMm: 27,
  battery: { level: 80, status: 2 },
  sdk: Number(DEVICE_PROPERTIES["ro.build.version.sdk"]),
  release: DEVICE_PROPERTIES["ro.build.version.release"],
  lang: "en",
  region: "US",
  /** persist.sys.locale: the BCP 47 tag of the device's one language */
  get locale(): string { return `${this.lang}-${this.region}`; },
  /** the host's zone, which the device's persist.sys.timezone names */
  get timezone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; },
  /** the browser's dark-mode preference, live as a device's is (see setDeviceNight) */
  get night(): boolean { return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false; },
  /** PackageManager.hasSystemFeature: what this device can back — touch, both orientations,
   *  a network, a WebView, printing (the browser's print dialog), location (browser geolocation
   *  stands behind the gps and network providers the LocationManager lists) — and nothing it
   *  cannot (no camera, telephony or sensors) */
  features: ["android.hardware.touchscreen", "android.hardware.touchscreen.multitouch", "android.hardware.touchscreen.multitouch.distinct",
    "android.hardware.faketouch", "android.hardware.screen.portrait", "android.hardware.screen.landscape", "android.hardware.wifi",
    "android.hardware.location", "android.hardware.location.gps", "android.hardware.location.network",
    "android.software.webview", "android.software.print", "android.software.input_methods", "android.software.home_screen", "android.software.app_widgets"],
  /** CPU and memory descriptors shared by procfs and sysconf. */
  cpu: { cores: 4, features: "swp half thumb fastmult vfp edsp thumbee vfpv3 neon tls", memKb: 2 * 1024 * 1024 },
  get statusBar(): number { return Math.round(this.statusBarDp * this.density); },
  get navBar(): number { return Math.round(this.navBarDp * this.density); },
  get touchSlop(): number { return Math.round(this.touchSlopDp * this.density); },
  get edgeSlop(): number { return Math.round(this.edgeSlopDp * this.density); },
  get scrollUnit(): number { return this.scrollUnitDp * this.density; },
  /** getDimensionPixelSize of a mm dimension: xdpi, which display.ts reports as densityDpi, per inch */
  get minScalingSpan(): number { return Math.round(this.minScalingSpanMm * this.densityDpi / 25.4); },
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

/** whether the configured screen, the display's natural rotation (ROTATION_0), is landscape */
export const naturalLandscape = screen.width > screen.height;

/** Apply an Activity orientation to the live display. Returns whether its geometry changed. */
export function setDeviceOrientation(orientation: DeviceOrientation): boolean {
  const next = orientScreen(device, orientation);
  if (next === device) return false;
  device.width = next.width;
  device.height = next.height;
  return true;
}
