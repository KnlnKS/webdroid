// webdroid shell: phone chrome, launcher, boot + input wiring.

import "./natives";

import { JRenderNode, SYSTEM_FONT } from "./android/graphics";
import { setGL } from "./android/gl";
import { rt } from "./jvm/runtime";
import { bootApk, tick, dispatchPointer, pressBack, currentApp, contentTop, SCREEN_W, SCREEN_H } from "./shell/device";
import { perf, perfReset } from "./perf";
import { uiState, measureView, makeSpec } from "./android/view";
import { onMain, mainDbg } from "./android/mainloop";
import { editInput, focusedEdit, focusEditText, setInputElement } from "./android/widget";
import { overlays } from "./android/popup";
import { openDatabase } from "./android/sqlite";
import { setWebLayer, webViewInfo } from "./android/webkit";
import { native } from "./native/debug";

const root = document.getElementById("root")!;
root.innerHTML = `
<div style="display:flex;align-items:center;gap:20px;height:100%">
  <div id="phone" style="position:relative;background:#0a0a0c;border-radius:28px;padding:14px 10px;box-shadow:0 18px 60px rgba(0,0,0,.6), inset 0 0 0 2px #2a2d33">
    <div style="position:relative">
      <canvas id="screen" width="${SCREEN_W}" height="${SCREEN_H}" style="display:block;border-radius:16px;background:#000"></canvas>
      <div id="weblayer" style="position:absolute;inset:0;pointer-events:none;overflow:hidden;border-radius:16px"></div>
    </div>
    <div id="nav" style="display:flex;justify-content:space-around;padding-top:10px">
      <button class="navb" id="btn-back" title="Back">◁</button>
      <button class="navb" id="btn-home" title="Home">◯</button>
    </div>
  </div>
  <div id="side" style="width:340px;max-height:92vh;overflow:auto;font:12px/1.5 ui-monospace,monospace;color:#9aa">
    <div id="status" style="color:#7c8; margin-bottom:8px">webdroid</div>
    <div id="native" style="color:#fc6"></div>
    <div id="launcher"></div>
    <div id="missing" style="white-space:pre-wrap"></div>
  </div>
</div>
<input id="kbd" style="position:absolute;left:-9999px;top:0" autocomplete="off">
<style>
  .navb { background:none;border:none;color:#9aa;font-size:20px;cursor:pointer;padding:2px 26px;border-radius:8px }
  .navb:hover { background:#22252b }
  .appcard { display:flex;align-items:center;gap:10px;background:#1d2026;border:1px solid #2a2e35;border-radius:10px;
    padding:10px 12px;margin:6px 0;cursor:pointer;color:#dde }
  .appcard:hover { background:#252a32 }
</style>`;

const canvas = document.getElementById("screen") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const statusEl = document.getElementById("status")!;
const missingEl = document.getElementById("missing")!;
const launcherEl = document.getElementById("launcher")!;
const kbd = document.getElementById("kbd") as HTMLInputElement;
setInputElement(kbd);
// WebViews are <iframe>s over the canvas: the framework positions them, the shell owns the layer
setWebLayer(document.getElementById("weblayer")!);

// fit canvas to viewport height. getBoundingClientRect forces layout, so the rect pointer events
// map through is refreshed here and on pointerdown, not per pointermove.
let rect: DOMRect;
function fit() {
  const h = Math.min(window.innerHeight - 110, SCREEN_H / 2 * 1.2);
  const cssH = Math.max(480, h);
  canvas.style.height = `${cssH}px`;
  canvas.style.width = `${cssH * SCREEN_W / SCREEN_H}px`;
  rect = canvas.getBoundingClientRect();
}
fit();
window.addEventListener("resize", fit);

// missing panel
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
      if (logBuf.length > 400) logBuf.splice(0, 100);
    } catch { /* */ }
  };
}
window.addEventListener("error", (e) => logBuf.push("window.error: " + e.message + " @" + e.filename + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => logBuf.push("unhandledrejection: " + ((e.reason as any)?.message ?? (e.reason as any)?.msg ?? String(e.reason)) + "\n" + ((e.reason as any)?.stack ?? "").slice(0, 600)));

async function boot(file: string) {
  try {
    statusEl.textContent = "downloading " + file + "…";
    const resp = await fetch("/apks/" + encodeURIComponent(file));
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const t0 = performance.now();
    await bootApk(bytes, (s) => { statusEl.textContent = s; }, file);
    perf.bootMs = performance.now() - t0;
    statusEl.textContent = `running (boot ${perf.bootMs.toFixed(0)}ms)` + (rt.nativeRequired.size ? " — needs native code" : "");
  } catch (e) {
    console.error(e);
    statusEl.textContent = "boot failed: " + e;
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
const wd = {
  rt, uiState, overlays, perf, perfReset, mainDbg, setGL, logs: logBuf, ticks: 0, native,
  boot, app: () => currentApp(), rnodes: () => JRenderNode.all, back: () => pressBack(),
  // the canvas capture cannot see iframe pixels: this is how a harness proves a page loaded
  web: () => webViewInfo(),
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
    const roots: (readonly [any, number, number])[] = [...overlays].reverse().map((o) => [o.view, o.x, o.y] as const);
    if (decor) roots.push([decor, 0, 0]);
    for (const [rootView, ox, oy] of roots) {
      for (const { v, x, y } of walkTree(rootView, 0, ox, oy, true)) {
        const txt = String(v.text ?? "").toLowerCase(), raw = String(v.rawText ?? "").toLowerCase();
        if ((txt === want || raw === want) && v.right > v.left) return { x: x + (v.right - v.left) / 2, y: y + (v.bottom - v.top) / 2 + contentTop() };
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
  // wipe persisted app state (sqlite + prefs) so a run starts from a fresh install
  reset: () => {
    const gone: string[] = [];
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("wd:db:") || k.startsWith("wd:prefs:") || k.startsWith("wd:install:") || k.startsWith("wd:keystore:")) { localStorage.removeItem(k); gone.push(k); }
    }
    return gone;
  },
  type: async (s: string) => {
    kbd.value = s;
    await editInput(s);
    return "typed " + s;
  },
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
  if (ticking) return; // the timer fallback must not count a frame that is still in flight
  ticking = true;
  wd.ticks++;
  lastTick = performance.now();
  perf.frames++;
  void tick(ctx).then(() => { perf.frameMs += performance.now() - lastTick; }).finally(() => { ticking = false; });
}
function loop() {
  doTick();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
setInterval(() => {
  if (performance.now() - lastTick > 40) doTick();
}, 33);

// draw idle screen
ctx.fillStyle = "#111";
ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
ctx.fillStyle = "#445";
ctx.font = "40px system-ui";
ctx.textAlign = "center";
ctx.fillText("webdroid", SCREEN_W / 2, SCREEN_H / 2 - 20);
ctx.font = "26px system-ui";
ctx.fillText("pick an app on the right →", SCREEN_W / 2, SCREEN_H / 2 + 40);

// input
function coords(e: PointerEvent): [number, number] {
  return [(e.clientX - rect.left) * SCREEN_W / rect.width, (e.clientY - rect.top) * SCREEN_H / rect.height];
}
let down = false;
canvas.addEventListener("pointerdown", (e) => {
  down = true;
  rect = canvas.getBoundingClientRect();
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
  const [x, y] = coords(e);
  void dispatchPointer(0, x, y);
  // refocus hidden input if an EditText is active
  if (focusedEdit) setTimeout(() => kbd.focus(), 0);
});
canvas.addEventListener("pointermove", (e) => {
  if (!down) return;
  const [x, y] = coords(e);
  void dispatchPointer(2, x, y);
});
canvas.addEventListener("pointerup", (e) => {
  if (!down) return;
  down = false;
  const [x, y] = coords(e);
  void dispatchPointer(1, x, y);
});
canvas.addEventListener("pointercancel", () => {
  if (down) { down = false; void dispatchPointer(3, 0, 0); }
});
document.getElementById("btn-back")!.addEventListener("click", () => void pressBack());
document.getElementById("btn-home")!.addEventListener("click", () => location.reload());

kbd.addEventListener("input", () => void editInput(kbd.value));
kbd.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { focusEditText(null); }
});

// load Roboto
for (const [name, file, weight] of [["Roboto", "Roboto-Regular.ttf", "400"], ["Roboto Medium", "Roboto-Medium.ttf", "500"],
  ["Roboto", "Roboto-Bold.ttf", "700"], ["Roboto", "Roboto-Italic.ttf", "400"]] as const) {
  const f = new FontFace(name, `url(/Roboto/${file})`, {
    weight, style: file.includes("Italic") ? "italic" : "normal",
    ascentOverride: `${SYSTEM_FONT.ascent * 100}%`, descentOverride: `${SYSTEM_FONT.descent * 100}%`,
  });
  f.load().then((loaded) => {
    document.fonts.add(loaded);
    uiState.needsDraw = true;
  }).catch(() => {});
}
