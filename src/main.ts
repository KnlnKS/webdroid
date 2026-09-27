// webdroid shell: phone chrome, launcher, boot + input wiring.
import "./natives";
import { recordVsync, PROCESS_PID } from "./android/os";
import { RangeFile } from "./shell/lazyfile";
import { mountSystemCertificates } from "./shell/cacerts";

import { locateDrawnText, SYSTEM_FONT, SYSTEM_FONTS, SYSTEM_EMOJI_FONTS } from "./android/graphics";
import { rt } from "./jvm/runtime";
import { newObj, vcall, linkInit } from "./jvm/natives/jlang";
import { mangleMethod } from "./jvm/abi";
import { loadFramework } from "./android/framework";
import { loadSkiaText } from "./android/skia-text";
import { unreadAttrs } from "./android/res";
import { bootApk, tick, dispatchPointer, pressBack, currentApp, rotateDevice, SCREEN_W, SCREEN_H, setDisplayChangeHandler, setScreenCanvas } from "./shell/device";
import { attachIme, drainInput } from "./shell/input";
import { clearRoots } from "./shell/hostfs";
import { clearPickedDocuments } from "./android/documents";
import { perf, perfReset } from "./perf";
import { configureJvm, jvmProfiler, parseJvmTier } from "./jvm/profile";
import { configureJvmCoverage, jvmCoverage } from "./jvm/coverage";
import { uiState } from "./android/view";
import { onMain, mainDbg } from "./android/mainloop";
import { imeInput, imeAction } from "./android/ime";
import { overlays } from "./android/popup";
import { setWebLayer, webViewInfo } from "./android/webkit";
import { native } from "./native/debug";
import { jitStats } from "./native/core";
import { mountDiagnostics, nativeRequirements } from "./shell/diagnostics";
import { createShell } from "./shell/ui";
import { openInstallLocal, openInstallRemote } from "./shell/install";
import { activateLocalAssets, localAsset } from "./shell/localassets";
import { vfs } from "./jvm/natives/jio";
import { yieldStats, timedParks } from "./jvm/yield";
import { provisionPackages, provisionServices } from "./shell/provision";
import { connectProcess, registerForegroundProcess, processPresentation, processBroker } from "./shell/processes";
import { guestClockControl, guestNow, guestSleep } from "./guest-clock";
import { device } from "./shell/config";

const params = new URLSearchParams(location.search);
const hotThreshold = Number(params.get("jvmHotness") ?? 4096);
if (![1024, 4096, 16384].includes(hotThreshold)) throw new Error(`invalid jvmHotness ${hotThreshold}`);
configureJvm({ profile: params.get("jvmProfile") === "1", tier: parseJvmTier(params.get("jvmTier")), hotThreshold });
configureJvmCoverage(params.get("fuzzCoverage") === "1");
const resetPerf = (): void => { perfReset(); jvmProfiler.reset(); };

const back = () => { if (!processBroker().back(PROCESS_PID)) return pressBack(); };
const shell = createShell({ launch: (file, local) => { void boot(file, local); }, back: () => { void back(); } });
const { canvas, kbd } = shell;
setScreenCanvas(canvas);
setWebLayer(shell.webLayer);
setDisplayChangeHandler(shell.resizeDisplay);

void loadFramework();

if (process.env.NODE_ENV !== "production") {
  mountDiagnostics(document.querySelector<HTMLElement>("#side")!);
  void fetch("/apks").then((r) => r.json() as Promise<string[]>).catch(() => [] as string[]).then((files) => {
    for (const file of files) shell.addPackage(file);
    const auto = params.get("apk");
    if (auto && files.includes(auto)) void boot(auto);
  });
}

navigator.serviceWorker?.addEventListener("message", (event: MessageEvent) => {
  if (event.data?.kind !== "webasset" || !event.ports[0]) return;
  const port = event.ports[0], path = event.data.path;
  void localAsset(path).then((reply) => { port.postMessage(reply); port.close(); }, () => { port.postMessage({ status: 500 }); port.close(); });
});

// console capture: wd.logs is what the e2e driver and scripts/dbg.ts read back out of the page
const logBuf: string[] = [];
for (const level of ["log", "warn", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    orig(...args);
    try {
      logBuf.push(level + ": " + args.map((a) => typeof a === "string" ? a : ((a as any)?.msg ?? (a as any)?.message ?? JSON.stringify(a)?.slice(0, 200) ?? String(a))).join(" "));
      if (logBuf.length > 4000) logBuf.splice(0, 1000);
    } catch { /* */ }
  };
}
window.addEventListener("error", (e) => logBuf.push("window.error: " + e.message + " @" + e.filename + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => logBuf.push("unhandledrejection: " + ((e.reason as any)?.message ?? (e.reason as any)?.msg ?? String(e.reason)) + "\n" + ((e.reason as any)?.stack ?? "").slice(0, 600)));

let booting = false;
// App classes remain in this realm; a second boot needs a page reload.
let runtimeStarted = false;
async function boot(file: string, local?: File) {
  if (booting || runtimeStarted) return;
  booting = true;
  shell.setState({ kind: "loading", file, stage: local ? "Opening package…" : "Downloading package…" });
  let rollbackAssets: (() => void) | undefined;
  try {
    const [install] = await Promise.all([local ? openInstallLocal(local) : openInstallRemote("/apks/" + encodeURIComponent(file)), fontsReady, provisionPackages(), loadSkiaText(), displayRate]);
    const assets = local ? { key: crypto.randomUUID(), install } : null;
    if (local) {
      shell.setState({ kind: "loading", file, stage: "Preparing local app assets…" });
      await navigator.serviceWorker.register("/webview-worker.js");
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    }
    rollbackAssets = activateLocalAssets(assets);
    const t0 = performance.now();
    connectProcess();
    runtimeStarted = true;
    const app = await bootApk(install, (stage) => shell.setState({ kind: "loading", file, stage }), assets?.key ?? file, null, registerForegroundProcess);
    void provisionServices({ attestationEnabled: params.get("attestation") === "1" })
      .then(() => processBroker().boot()).catch((error) => console.error("[provision]", error));
    perf.bootMs = performance.now() - t0;
    shell.setState({ kind: "running", file, label: app.label });
  } catch (e) {
    rollbackAssets?.();
    console.error(e);
    shell.setState({ kind: "failed", file, error: e, retry: runtimeStarted ? null : () => { void boot(file, local); } });
  } finally {
    booting = false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const topDecor = (): any => currentApp()?.stack.at(-1)?.window.decor ?? null;
const clsName = (v: any): string => v.constructor?.$i?.name ?? v.constructor.name;
/** depth-first over a view tree, with each view's absolute position (parents' scroll removed) */
function* walkTree(v: any, depth = 0, ox = 0, oy = 0, visibleOnly = false): Generator<{ v: any; depth: number; x: number; y: number }> {
  if (visibleOnly && v.visibility !== 0) return;
  const x = ox + v.left + (v.translationX ?? 0), y = oy + v.top + (v.translationY ?? 0);
  yield { v, depth, x, y };
  for (const c of v.children ?? []) yield* walkTree(c, depth + 1, x - (v.scrollX ?? 0), y - (v.scrollY ?? 0), visibleOnly);
}
const tap = async (x: number, y: number) => {
  await dispatchPointer(0, x, y);
  await sleep(60);
  await dispatchPointer(1, x, y);
};

// `?jit=0` runs the interpreter alone, to tell the tiers apart
jitStats.on = params.get("jit") !== "0";

/** Dev-console and e2e-driver surface; tests/e2e/drivers/webdroid.ts fires these by name. */
const wd = {
  rt, uiState, perf, perfReset: resetPerf, jvmProfile: () => jvmProfiler.snapshot(), jvmCoverage, mainDbg, yields: yieldStats, timedParks, logs: logBuf, ticks: 0, native, guestClock: guestClockControl,
  nativeRequirements,
  layoutTrace: (on?: boolean) => { if (on !== undefined) uiState.layoutTrace = on ? { cls: {}, site: {} } : null; return uiState.layoutTrace; },
  // the JVM's entry points, so a page script can drive real bytecode where Canvas2D is needed
  newObj, vcall,
  /** a static on a bytecode class: statics live on the constructor, mangled the same way */
  scall: async (cls: string, name: string, desc: string, ...args: unknown[]) => {
    const fn = ((await linkInit(cls)).ctor as Record<string, unknown>)[mangleMethod(name, desc)];
    if (typeof fn !== "function") throw new Error(`no static ${cls}.${name}${desc}`);
    return (fn as (...a: unknown[]) => unknown)(...args);
  },
  boot, app: () => currentApp(), back,
  background: (ms = 1000) => processBroker().background(ms),
  configuration: (orientation: "portrait" | "landscape") => rotateDevice(orientation === "landscape"),
  // the canvas capture cannot see iframe pixels: this is how a harness proves a page loaded
  web: () => webViewInfo(),
  // framework attributes a layout used that nothing here reads: a look that is wrong with a
  // clean missing list is usually one of these
  unreadAttrs: () => { const a = currentApp(); return a ? unreadAttrs(a.host.res) : []; },
  tree: () => {
    const out: string[] = [];
    const line = ({ v, depth }: { v: any; depth: number }) =>
      out.push("  ".repeat(depth) + clsName(v).split("/").pop() + ` [${v.left},${v.top},${v.right},${v.bottom}] m=${v.measuredW}x${v.measuredH} vis=${v.visibility}` +
        (v.idNum > 0 ? " id=0x" + v.idNum.toString(16) : "") + (v.text !== undefined ? " text=" + JSON.stringify(String(v.text).slice(0, 30)) : "") +
        (v.background ? " bg=" + v.background.constructor.name : ""));
    const decor = topDecor();
    if (decor) for (const n of walkTree(decor)) line(n);
    for (const o of overlays) { out.push("OVERLAY:"); for (const n of walkTree(o.view, 1)) line(n); }
    return out.join("\n");
  },
  // The same shape `uiautomator dump` reports, so the two hierarchies can be diffed directly:
  // absolute device px with the status bar included, which is the space a tap is expressed in.
  uiTree: () => {
    const app = currentApp();
    const decor = topDecor();
    if (!app || !decor) return [];
    const res = app.host.res;
    const out: unknown[] = [];
    const emit = (root: any, ox: number, oy: number) => {
      for (const { v, x, y } of walkTree(root, 0, ox, oy, true)) {
        const id = v.idNum > 0 ? res.idName(v.idNum) : "";
        out.push({
          text: String(v.text ?? v.drawnText?.join(" ") ?? ""),
          desc: String(v.contentDesc ?? ""),
          cls: clsName(v).replace(/\//g, "."),
          resId: id && !id.startsWith("0x") ? `${v.idNum >>> 24 === 1 ? "android" : app.host.pkg}:id/${id}` : "",
          bounds: [x, y, x + (v.right - v.left), y + (v.bottom - v.top)],
          clickable: !!v.clickable,
          enabled: v.enabled !== false,
          editable: !!v.editable,
          scrollable: !!v.scrollable || Number(v.maxScrollY ?? 0) > 0 ||
            /(?:ScrollView|ListView|RecyclerView)$/.test(clsName(v)),
        });
      }
    };
    emit(decor, 0, 0);
    for (const o of overlays) emit(o.view, 0, 0);
    return out;
  },
  // Center of the first visible view whose text matches, in SCREEN coords (status bar included,
  // the space wd.tap takes). Overlays first, topmost first. Synchronous on purpose: the e2e
  // harness needs a value it can await from outside the page without holding an in-page promise.
  locateText: (s: string): { x: number; y: number } | null => {
    const normalized = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const want = normalized(s);
    const matches = (candidate: string) => candidate === want || candidate.startsWith(want);
    const decor = topDecor();
    // An overlay's own left/top already carry its position — the layout pass lays it out AT
    // o.x/o.y — so seeding the walk with them again doubles the offset.
    const roots: any[] = [...overlays].reverse().map((o) => o.view);
    if (decor) roots.push(decor);
    for (const rootView of roots) {
      for (const { v, x, y } of walkTree(rootView, 0, 0, 0, true)) {
        const txt = normalized(v.text), raw = normalized(v.rawText);
        // the emulator driver resolves a tapText against text OR content-desc, so an icon-only
        // control (an overflow button, a nav arrow) has to be findable here the same way
        const cd = normalized(v.contentDesc);
        if ((matches(txt) || matches(raw) || matches(cd)) && v.right > v.left)
          return { x: x + (v.right - v.left) / 2, y: y + (v.bottom - v.top) / 2 };
      }
    }
    for (const rootView of roots) {
      for (const { v } of walkTree(rootView, 0, 0, 0, true)) {
        const hit = locateDrawnText(v, want, SCREEN_W, SCREEN_H);
        if (hit) return hit;
      }
    }
    return null;
  },
  tap,
  tapText: async (s: string) => {
    const hit = wd.locateText(s);
    if (!hit) return "not found: " + s;
    await tap(hit.x, hit.y);
    return `tapped ${s} @ ${hit.x},${hit.y}`;
  },
  swipe: async (x1: number, y1: number, x2: number, y2: number, ms = 400) => {
    const steps = Math.max(2, Math.round(ms / 16));
    const t0 = guestNow();
    void dispatchPointer(0, x1, y1, t0);
    for (let i = 1; i <= steps; i++) {
      const at = t0 + ms * i / steps, t = i / steps;
      await guestSleep(Math.max(0, at - guestNow()));
      void dispatchPointer(2, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, at);
    }
    await dispatchPointer(1, x2, y2, t0 + ms);
    return `swiped ${x1},${y1} -> ${x2},${y2}`;
  },
  // Is the main-looper queue still draining? A wedged job stops input and repaint alike, which
  // looks exactly like a settled screen from outside.
  alive: (ms = 1500) => {
    let id: ReturnType<typeof setTimeout>;
    return Promise.race([
      onMain(() => true).finally(() => clearTimeout(id)),
      new Promise((r) => { id = setTimeout(() => r(false), ms); }),
    ]);
  },
  // wipe persisted app state (sqlite + prefs + the picked directories) so a run starts fresh
  reset: async () => {
    await Promise.all([clearRoots(), clearPickedDocuments(), processBroker().files.clear()]);
    const gone: string[] = [];
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("wd:db:") || k.startsWith("wd:prefs:") || k.startsWith("wd:install:") || k.startsWith("wd:keystore:")) { localStorage.removeItem(k); gone.push(k); }
    }
    return gone;
  },
  type: async (s: string) => {
    kbd.value = s;
    await imeInput(s);
    return "typed " + s;
  },
  // the keyboard's action key on the focused field (Search, Go, Done…)
  enter: async () => "action " + (await imeAction() ? "handled" : "ignored"),
  testFrame: async () => {
    if (processPresentation.visible) await tick();
    for (const frame of document.querySelectorAll("iframe")) {
      if (new URL(frame.src, location.href).origin !== location.origin) continue;
      const child = frame.contentWindow as unknown as { wd?: { testFrame?: () => Promise<void> } };
      if (child.wd?.testFrame) await child.wd.testFrame();
    }
  },
};
(globalThis as any).wd = wd;

// frame loop: rAF when visible, timer fallback when the tab is hidden/backgrounded
let lastTick = 0, ticking = false;
function doTick() {
  if (!processPresentation.visible) return;
  drainInput(); // ahead of the frame, and ahead of the guard below: a slow frame must not starve input
  if (ticking) return; // the timer fallback must not count a frame that is still in flight
  ticking = true;
  wd.ticks++;
  lastTick = performance.now();
  perf.frames++;
  void tick().then(() => { perf.completedFrames++; perf.frameMs += performance.now() - lastTick; }).finally(() => { ticking = false; });
}
function loop(time: number) {
  if (recordVsync(time)) doTick();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
setInterval(() => {
  if (performance.now() - lastTick > 40) doTick();
}, 33);

attachIme(canvas, kbd);

mountSystemCertificates();

/** The host display's rate, from rAF spacing: skipped frames only lengthen intervals, so the
 *  lower quartile is the frame period even while page startup keeps the thread busy. */
const displayRate = params.has("hz") || document.hidden ? Promise.resolve() : new Promise<void>((resolve) => {
  const stamps: number[] = [];
  const sample = (time: number) => {
    stamps.push(time);
    if (stamps.length <= 12 && !document.hidden) { requestAnimationFrame(sample); return; }
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]).sort((a, b) => a - b);
    const hz = gaps.length ? 1000 / gaps[gaps.length >> 2] : 60;
    device.refreshRate = [60, 90, 120].reduce((best, rate) => Math.abs(rate - hz) < Math.abs(best - hz) ? rate : best);
    resolve();
  };
  requestAnimationFrame(sample);
});

const fontsReady = Promise.all([Promise.all(SYSTEM_FONTS.map(async ([name, file, weight, style]) => {
  const response = await fetch(`/vendor/fonts/${file}`);
  if (!response.ok) throw new Error(`font ${file}: ${response.status}`);
  const bytes = await response.arrayBuffer();
  vfs.write(`/system/fonts/${file}`, new Uint8Array(bytes));
  const f = new FontFace(name, bytes, {
    weight: String(weight), style,
    ascentOverride: `${SYSTEM_FONT.ascent * 100}%`, descentOverride: `${SYSTEM_FONT.descent * 100}%`,
  });
  document.fonts.add(await f.load());
  return `<font weight="${weight}" style="${style}">${file}</font>`;
})), Promise.all(SYSTEM_EMOJI_FONTS.map(async ([name, file]) => {
  const url = `/vendor/fonts/${file}`;
  const [font, nativeFile] = await Promise.all([new FontFace(name, `url(${url})`).load(), RangeFile.open(url)]);
  document.fonts.add(font);
  vfs.mount(`/system/fonts/${file}`, nativeFile);
}))]).then(([fonts]) => {
  // Native Skia reads the same faces through Android's system font configuration.
  vfs.write("/system/etc/fonts.xml", new TextEncoder().encode(
    `<?xml version="1.0"?><familyset version="23"><family name="sans-serif">${fonts.join("")}</family>` +
    '<alias name="sans-serif-medium" to="sans-serif" weight="500"/>' +
    SYSTEM_EMOJI_FONTS.map(([, file]) => `<family lang="und-Zsye"><font weight="400" style="normal">${file}</font></family>`).join("") + '</familyset>'));
  uiState.needsDraw = true;
});
void fontsReady.catch((e) => console.error("[fonts]", e));
