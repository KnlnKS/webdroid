import { recordVsync } from "./android/os";
// webdroid shell: phone chrome, launcher, boot + input wiring.

import "./natives";
import { RangeFile } from "./shell/lazyfile";
import { mountSystemCertificates } from "./shell/cacerts";

import { JRenderNode, SYSTEM_FONT } from "./android/graphics";
import { setGL } from "./android/gl";
import { rt } from "./jvm/runtime";
import { newObj, vcall, linkInit, suspendTrace } from "./jvm/natives/jlang";
import { mangleMethod } from "./jvm/abi";
import { loadFramework } from "./android/framework";
import { unreadAttrs } from "./android/res";
import { bootApk, tick, dispatchPointer, pressBack, currentApp, contentTop, SCREEN_W, SCREEN_H, setDisplayChangeHandler, setScreenCanvas, frame, present } from "./shell/device";
import { attachInput, drainInput } from "./shell/input";
import { clearRoots } from "./shell/hostfs";
import { perf, perfReset } from "./perf";
import { uiState, measureView, makeSpec } from "./android/view";
import { onMain, mainDbg } from "./android/mainloop";
import { imeInput, imeAction, imeActive, imeHasAction, imeSelection, imeFinishComposition } from "./android/ime";
import { setInputElement } from "./android/textview";
import { overlays } from "./android/popup";
import { openDatabase } from "./android/sqlite";
import { setWebLayer, webViewInfo } from "./android/webkit";
import { native } from "./native/debug";
import { allSurfaces, probeSurface } from "./android/glview";
import { device, parseScreen, readStoredScreen, storeScreen, type Screen } from "./shell/config";
import { openInstallRemote } from "./shell/install";
import { vfs } from "./jvm/natives/jio";
import { yieldStats, timedParks } from "./jvm/yield";

const root = document.getElementById("root")!;

/** the shell's own chrome, shared between the markup that declares it and the fit that subtracts it */
const SIDE_W = 340, GAP = 20, MARGIN = 24;
root.innerHTML = `
<div style="display:flex;align-items:center;gap:${GAP}px;height:100%">
  <div id="phone" style="position:relative;background:#0a0a0c;border-radius:28px;padding:14px 10px;box-shadow:0 18px 60px rgba(0,0,0,.6), inset 0 0 0 2px #2a2d33">
    <div style="position:relative">
      <canvas id="screen" width="${SCREEN_W}" height="${SCREEN_H}" style="display:block;border-radius:16px;background:#000;touch-action:none"></canvas>
      <div id="weblayer" style="position:absolute;inset:0;pointer-events:none;overflow:hidden;border-radius:16px"></div>
    </div>
    <div id="nav" style="display:flex;justify-content:space-around;padding-top:10px">
      <button class="navb" id="btn-back" title="Back">◁</button>
      <button class="navb" id="btn-home" title="Home">◯</button>
    </div>
  </div>
  <div id="side" style="width:${SIDE_W}px;max-height:92vh;overflow:auto;font:12px/1.5 ui-monospace,monospace;color:#9aa">
    <div id="status" style="color:#7c8; margin-bottom:8px">webdroid</div>
    <div id="native" style="color:#fc6"></div>
    <div id="screencfg">
      <label>w <input id="cfg-w" type="number" min="1" step="1"></label>
      <label>h <input id="cfg-h" type="number" min="1" step="1"></label>
      <label>dpi <input id="cfg-dpi" type="number" min="1" step="1"></label>
      <button id="cfg-apply">Apply</button>
      <button id="cfg-reset" title="back to the built-in profile">Reset</button>
      <div id="cfg-note"></div>
    </div>
    <div id="launcher"></div>
    <div id="missing" style="white-space:pre-wrap"></div>
  </div>
</div>
<textarea id="kbd" style="position:absolute;left:-9999px;top:0" autocomplete="off"></textarea>
<style>
  html, body { overscroll-behavior: none }
  .navb { background:none;border:none;color:#9aa;font-size:20px;cursor:pointer;padding:2px 26px;border-radius:8px }
  .navb:hover { background:#22252b }
  .appcard { display:flex;align-items:center;gap:10px;background:#1d2026;border:1px solid #2a2e35;border-radius:10px;
    padding:10px 12px;margin:6px 0;cursor:pointer;color:#dde }
  .appcard:hover { background:#252a32 }
  #screencfg { display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:8px 0 10px;
    padding:8px 10px;background:#1d2026;border:1px solid #2a2e35;border-radius:10px }
  #screencfg label { display:flex;align-items:center;gap:4px;color:#678 }
  #screencfg input { width:52px;background:#12141a;border:1px solid #2a2e35;border-radius:6px;
    color:#dde;padding:3px 5px;font:inherit }
  #screencfg button { background:#252a32;border:1px solid #343a44;border-radius:6px;color:#dde;
    padding:3px 9px;cursor:pointer;font:inherit }
  #screencfg button:hover { background:#2e343d }
  #cfg-note { flex-basis:100%;color:#678 }
</style>`;

const canvas = document.getElementById("screen") as HTMLCanvasElement;
setScreenCanvas(canvas);
const statusEl = document.getElementById("status")!;
const missingEl = document.getElementById("missing")!;
const launcherEl = document.getElementById("launcher")!;
const kbd = document.getElementById("kbd") as HTMLTextAreaElement;
setInputElement(kbd);
// WebViews are <iframe>s over the canvas: the framework positions them, the shell owns the layer
setWebLayer(document.getElementById("weblayer")!);

/**
 * Fit the framebuffer into whatever the viewport has left, at any aspect ratio or density.
 * The bezel padding and the nav row are the stylesheet's, so measure the difference between
 * the phone and the canvas rather than restating it as a magic constant — the old formula's
 * `SCREEN_H / 2 * 1.2` was a 768 that only meant anything at 1280 tall and density 2, and it
 * bounded no width at all, so a wide framebuffer pushed the sidebar off screen.
 * Never scaled past 1 CSS px per device px: the canvas is the framebuffer, not a poster.
 */
const phoneEl = document.getElementById("phone")!;
function fit() {
  const chromeW = phoneEl.offsetWidth - canvas.offsetWidth;
  const chromeH = phoneEl.offsetHeight - canvas.offsetHeight;
  const availW = window.innerWidth - SIDE_W - GAP - chromeW - MARGIN;
  const availH = window.innerHeight - chromeH - MARGIN;
  const s = Math.max(0.1, Math.min(availW / SCREEN_W, availH / SCREEN_H, 1));
  canvas.style.width = `${SCREEN_W * s}px`;
  canvas.style.height = `${SCREEN_H * s}px`;
}
fit();
window.addEventListener("resize", fit);
setDisplayChangeHandler(() => {
  canvas.width = SCREEN_W;
  canvas.height = SCREEN_H;
  fit();
});

// ── the screen setting. Applying reloads: the profile is read once at module init, before
// anything that derives from it, so a reload is correct by construction and costs the frame
// path nothing. It is also what a device does when its display size changes — it relaunches.
const cfgW = document.getElementById("cfg-w") as HTMLInputElement;
const cfgH = document.getElementById("cfg-h") as HTMLInputElement;
const cfgDpi = document.getElementById("cfg-dpi") as HTMLInputElement;
const cfgNote = document.getElementById("cfg-note")!;
cfgW.value = String(device.width);
cfgH.value = String(device.height);
cfgDpi.value = String(device.densityDpi);
const describe = () => {
  const s = parseScreen(`${cfgW.value}x${cfgH.value}@${cfgDpi.value}`);
  // dp size is what decides which layout an app picks, so show it rather than make it a surprise
  cfgNote.textContent = s
    ? `${Math.round(s.width / (s.densityDpi / 160))}×${Math.round(s.height / (s.densityDpi / 160))}dp` +
      (readStoredScreen() ? "" : " (built-in)")
    : "not a screen size";
};
describe();
for (const el of [cfgW, cfgH, cfgDpi]) el.addEventListener("input", describe);
const applyScreen = (s: Screen | null) => { storeScreen(s); location.reload(); };
document.getElementById("cfg-apply")!.addEventListener("click", () => {
  const s = parseScreen(`${cfgW.value}x${cfgH.value}@${cfgDpi.value}`);
  if (s) applyScreen(s); else describe();
});
document.getElementById("cfg-reset")!.addEventListener("click", () => applyScreen(null));

let missingDirty = false;
rt.onMissing = () => { missingDirty = true; };
setInterval(() => {
  if (!missingDirty) return;
  missingDirty = false;
  const items = [...rt.missing];
  missingEl.textContent = `missing APIs (${items.length}):\n` + items.slice(-60).join("\n");
}, 800);
rt.onUncaught = (e: any) => {
  statusEl.textContent = "uncaught: " + (e?.msg ?? e);
  statusEl.style.color = "#e77";
};
const nativeEl = document.getElementById("native")!;
rt.onNativeRequired = (lib, abi) => { nativeEl.textContent = "native code required: " + lib + " (" + abi + ")"; };

// The android resource package is the same for every app: start it now so a boot never waits.
void loadFramework();

// launcher: whatever is in apks/, named from the filename
void fetch("/apks").then((r) => r.json() as Promise<string[]>).catch(() => [] as string[]).then((files) => {
  for (const file of files) {
    const name = file.replace(/\.x?apk$/i, "").replace(/[-_]v?\d[\d.]*$/, "").replace(/[-_]+/g, " ");
    const el = document.createElement("div");
    el.className = "appcard";
    el.innerHTML = `<b></b><span style="margin-left:auto;color:#678"></span>`;
    el.firstElementChild!.textContent = name;
    el.lastElementChild!.textContent = file;
    el.onclick = () => void boot(file);
    launcherEl.appendChild(el);
  }
  const auto = new URLSearchParams(location.search).get("apk");
  if (auto && files.includes(auto)) void boot(auto);
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

async function boot(file: string) {
  try {
    statusEl.textContent = "downloading " + file + "…";
    const [install] = await Promise.all([openInstallRemote("/apks/" + encodeURIComponent(file)), fontsReady]);
    const t0 = performance.now();
    await bootApk(install, (s) => { statusEl.textContent = s; }, file);
    perf.bootMs = performance.now() - t0;
    statusEl.textContent = `running (boot ${perf.bootMs.toFixed(0)}ms)` + (rt.nativeRequired.size ? " — needs native code" : "");
  } catch (e) {
    console.error(e);
    statusEl.textContent = "boot failed: " + ((e as any)?.msg ?? e);
    statusEl.style.color = "#e77";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const topDecor = (): any => { const app = currentApp(); return app?.stack[app.stack.length - 1]?.window.decor ?? null; };
const clsName = (v: any): string => v.constructor?.$i?.name ?? v.constructor.name;
/** depth-first over a view tree, with each view's absolute position (parents' scroll removed) */
function* walkTree(v: any, depth = 0, ox = 0, oy = 0, skipGone = false): Generator<{ v: any; depth: number; x: number; y: number }> {
  if (skipGone && v.visibility === 8) return;
  const x = ox + v.left, y = oy + v.top;
  yield { v, depth, x, y };
  for (const c of v.children ?? []) yield* walkTree(c, depth + 1, x - (v.scrollX ?? 0), y - (v.scrollY ?? 0), skipGone);
}
const tap = async (x: number, y: number) => {
  await dispatchPointer(0, x, y);
  await sleep(60);
  await dispatchPointer(1, x, y);
};

/** Dev-console and e2e-driver surface; tests/e2e/drivers/webdroid.ts fires these by name. */
// `?natcheck=1` before anything links: the suspension analysis believes what a native
// declares about itself, so a native that returns a promise without being async has to be
// findable rather than guessed at.
rt.auditNatives = new URLSearchParams(location.search).get("natcheck") === "1";

const wd = {
  rt, uiState, overlays, perf, perfReset, mainDbg, yields: yieldStats, timedParks, suspends: suspendTrace, setGL, logs: logBuf, ticks: 0, native, vfs,
  surfaces: () => allSurfaces.map((s) => ({ view: s.view?.constructor.name, width: s.width, height: s.height, frames: s.frames, present: !!s.present })), probeSurface,
  // The JVM's own entry points, so a script can drive real bytecode from the page the way
  // scripts/fwtest.ts drives it headless. That is the only way to exercise anything needing
  // Canvas2D — text metrics, a bitmap raster, an image decode — since bun has no canvas.
  newObj, vcall, linkInit,
  jni: (cls: string, sig: string) => rt.jniFn(cls, sig),
  /** a static on a bytecode class: statics live on the constructor, mangled the same way */
  scall: async (cls: string, name: string, desc: string, ...args: unknown[]) => {
    const fn = ((await linkInit(cls)).ctor as Record<string, unknown>)[mangleMethod(name, desc)];
    if (typeof fn !== "function") throw new Error(`no static ${cls}.${name}${desc}`);
    return (fn as (...a: unknown[]) => unknown)(...args);
  },
  nativeLiars: () => [...rt.nativeLiars].sort(),
  boot, app: () => currentApp(), rnodes: () => JRenderNode.all, back: () => pressBack(),
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
    const res = app.host.res, top = contentTop();
    const out: unknown[] = [];
    const emit = (root: any, ox: number, oy: number) => {
      for (const { v, x, y } of walkTree(root, 0, ox, oy, true)) {
        const id = v.idNum > 0 ? res.idName(v.idNum) : "";
        out.push({
          text: String(v.text ?? ""),
          desc: String(v.contentDesc ?? ""),
          cls: clsName(v).replace(/\//g, "."),
          resId: id && !id.startsWith("0x") ? `${v.idNum >>> 24 === 1 ? "android" : app.host.pkg}:id/${id}` : "",
          bounds: [x, y + top, x + (v.right - v.left), y + top + (v.bottom - v.top)],
          clickable: !!v.clickable,
        });
      }
    };
    emit(decor, 0, 0);
    for (const o of overlays) emit(o.view, 0, 0);
    return out;
  },
  find: (idOrCls: number | string): any[] => {
    const decor = topDecor();
    if (!decor) return [];
    return [...walkTree(decor)].map((n) => n.v).filter((v) => v.idNum === idOrCls || (typeof idOrCls === "string" && clsName(v).includes(idOrCls)));
  },
  // Center of the first visible view whose text matches, in SCREEN coords (status bar included,
  // the space wd.tap takes). Overlays first, topmost first. Synchronous on purpose: the e2e
  // harness needs a value it can await from outside the page without holding an in-page promise.
  locateText: (s: string): { x: number; y: number } | null => {
    const want = s.toLowerCase();
    const decor = topDecor();
    // An overlay's own left/top already carry its position — the layout pass lays it out AT
    // o.x/o.y — so seeding the walk with them again doubles the offset.
    const roots: any[] = [...overlays].reverse().map((o) => o.view);
    if (decor) roots.push(decor);
    for (const rootView of roots) {
      for (const { v, x, y } of walkTree(rootView, 0, 0, 0, true)) {
        const txt = String(v.text ?? "").toLowerCase(), raw = String(v.rawText ?? "").toLowerCase();
        // the emulator driver resolves a tapText against text OR content-desc, so an icon-only
        // control (an overflow button, a nav arrow) has to be findable here the same way
        const cd = String(v.contentDesc ?? "").toLowerCase();
        if ((txt === want || raw === want || cd === want) && v.right > v.left) return { x: x + (v.right - v.left) / 2, y: y + (v.bottom - v.top) / 2 + contentTop() };
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
    await dispatchPointer(0, x1, y1);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await dispatchPointer(2, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
      await sleep(ms / steps);
    }
    await dispatchPointer(1, x2, y2);
    return `swiped ${x1},${y1} -> ${x2},${y2}`;
  },
  // Is the main-looper queue still draining? Every input, layout and frame goes through the one
  // serialized queue in android/mainloop.ts; if a job in it never settles, the app stops
  // responding AND stops repainting — which is indistinguishable from "the screen settled"
  // unless you probe the queue directly.
  alive: (ms = 1500) => Promise.race([
    onMain(() => true),
    new Promise((r) => setTimeout(() => r(false), ms)),
  ]),
  // wipe persisted app state (sqlite + prefs + the picked directories) so a run starts fresh
  reset: () => {
    void clearRoots();
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
  /** the IME action key — what a search field is waiting for after wd.type */
  enter: () => imeAction(),
  measure: (v: any, w: number, wm: number, h: number, hm: number) =>
    measureView(v, makeSpec(w, wm), makeSpec(h, hm)).then(() => [v.measuredW, v.measuredH]),
  querydb: async (sql: string) => {
    const app = currentApp();
    const jdb = await openDatabase(`/data/data/${app?.host.pkg}/databases/database.db`);
    return jdb.db!.exec(sql).map((r) => ({ cols: r.columns, rows: r.values.slice(0, 5) }));
  },
};
(globalThis as any).wd = wd;

// frame loop: rAF when visible, timer fallback when the tab is hidden/backgrounded
let lastTick = 0, ticking = false;
function doTick() {
  drainInput(); // ahead of the frame, and ahead of the guard below: a slow frame must not starve input
  if (ticking) return; // the timer fallback must not count a frame that is still in flight
  ticking = true;
  wd.ticks++;
  lastTick = performance.now();
  perf.frames++;
  void tick().then(() => { perf.frameMs += performance.now() - lastTick; }).finally(() => { ticking = false; });
}
function loop(time: number) {
  recordVsync(time);
  doTick();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
setInterval(() => {
  if (performance.now() - lastTick > 40) doTick();
}, 33);

frame.fillStyle = "#111";
frame.fillRect(0, 0, SCREEN_W, SCREEN_H);
frame.fillStyle = "#445";
frame.font = `${device.dp(20)}px system-ui`;
frame.textAlign = "center";
frame.fillText("webdroid", SCREEN_W / 2, SCREEN_H / 2 - device.dp(10));
frame.font = `${device.dp(13)}px system-ui`;
frame.fillText("pick an app on the right →", SCREEN_W / 2, SCREEN_H / 2 + device.dp(20));
present();

attachInput(canvas, () => {
  if (imeActive()) setTimeout(() => kbd.focus(), 0);
});
document.getElementById("btn-back")!.addEventListener("click", () => void pressBack());
document.getElementById("btn-home")!.addEventListener("click", () => location.reload());

kbd.addEventListener("input", (event) => void imeInput(kbd.value, kbd.selectionStart, kbd.selectionEnd, event instanceof InputEvent && event.isComposing));
kbd.addEventListener("select", () => void imeSelection(kbd.selectionStart, kbd.selectionEnd));
kbd.addEventListener("compositionend", () => void imeFinishComposition());
kbd.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing && imeHasAction()) { e.preventDefault(); void imeAction(); }
});

mountSystemCertificates();

const fontsReady = Promise.all([Promise.all([
  ["Roboto", "Roboto-Regular.ttf", "400", "normal"], ["Roboto Medium", "Roboto-Medium.ttf", "500", "normal"],
  ["Roboto", "Roboto-Bold.ttf", "700", "normal"], ["Roboto", "Roboto-Italic.ttf", "400", "italic"],
].map(async ([name, file, weight, style]) => {
  const response = await fetch(`/Roboto/${file}`);
  if (!response.ok) throw new Error(`font ${file}: ${response.status}`);
  const bytes = await response.arrayBuffer();
  vfs.write(`/system/fonts/${file}`, new Uint8Array(bytes));
  const f = new FontFace(name, bytes, {
    weight, style,
    ascentOverride: `${SYSTEM_FONT.ascent * 100}%`, descentOverride: `${SYSTEM_FONT.descent * 100}%`,
  });
  document.fonts.add(await f.load());
  return `<font weight="${weight}" style="${style}">${file}</font>`;
})), RangeFile.open("/vendor/Noto-COLRv1.ttf").then(font => vfs.mount("/system/fonts/Noto-COLRv1.ttf", font))]).then(([fonts]) => {
  // Native Skia reads the same faces through Android's system font configuration.
  vfs.write("/system/etc/fonts.xml", new TextEncoder().encode(
    `<?xml version="1.0"?><familyset version="23"><family name="sans-serif">${fonts.join("")}</family>` +
    '<alias name="sans-serif-medium" to="sans-serif" weight="500"/><family lang="und-Zsye"><font weight="400" style="normal">Noto-COLRv1.ttf</font></family></familyset>'));
  uiState.needsDraw = true;
});
void fontsReady.catch((e) => console.error("[fonts]", e));
