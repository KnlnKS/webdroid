// Device shell: APK boot, activity stack, frame loop, touch routing.

import { unzipSync } from "fflate";
import { DexFile } from "../jvm/dex";
import { rt } from "../jvm/runtime";
import { vfs } from "../jvm/natives/jio";
import { vcall, curThread, mainThread, setCurThread, newObj } from "../jvm/natives/jlang";
import { Arsc } from "../android/arsc";
import { parseAXML, attrStr, type XmlNode } from "../android/axml";
import { Resources, JTheme } from "../android/res";
import { mkJResources } from "../android/resnative";
import { setAppHost, setManifest, type AppHost, JIntent, ensureDecor, JActivity, JMenu, pushMenuToBar, JContext, fireActivityLifecycle, APPEARANCE_LIGHT_STATUS_BARS } from "../android/app";
import { reportUncaught, JBundle } from "../android/os";
import { onMain, inMainJob } from "../android/mainloop";
import {
  JView, JViewGroup, uiState, measureView, layoutView, drawView, makeSpec, MS_EXACTLY,
  JMotionEvent, fireGlobalLayout, fireDrawPass, dispatchAttached, dispatchDetached, guardCall,
} from "../android/view";
import { JCanvas, cssColor, tfMedium } from "../android/graphics";
import { overlays, drawToasts, dismissOverlay } from "../android/popup";
import { webLayerSweep } from "../android/webkit";
import { mangleMethod } from "../jvm/abi";
import { perf } from "../perf";
import { device } from "./config";
import fw from "../android/framework-res.json";

export const SCREEN_W = device.width, SCREEN_H = device.height, STATUS_H = device.statusBar;

interface BootedApp {
  host: AppHost;
  mainActivityCls: string;
  stack: JActivity[];
  label: string;
}
let booted: BootedApp | null = null;
export function currentApp(): BootedApp | null { return booted; }

const FLAG_FULLSCREEN = 1024;
/** Where the top activity's window starts: FLAG_FULLSCREEN takes the status bar's rows too. */
export function contentTop(): number {
  const act = booted?.stack[booted.stack.length - 1];
  return act && (act.window.flags & FLAG_FULLSCREEN) ? 0 : STATUS_H;
}

export async function bootApk(bytes: Uint8Array, onStatus: (s: string) => void, apkFile = ""): Promise<BootedApp> {
  // materialize every registered native class so directly-constructed instances have methods
  for (const name of [...rt.natives.keys()]) {
    try { rt.link(name); } catch (e) { console.warn("[link native]", name, e); }
  }
  onStatus("unpacking apk…");
  const zip = unzipSync(bytes);
  rt.classpath = zip;
  vfs.write("/data/app/base.apk", bytes);
  onStatus("loading dex…");
  for (const [name, data] of Object.entries(zip)) {
    if (/^classes\d*\.dex$/.test(name)) rt.loadDex(new DexFile(data, name));
  }
  const manifest = parseAXML(zip["AndroidManifest.xml"]);
  const pkg = attrStr(manifest, "package") ?? "app";
  const appNode = manifest.children.find((c) => c.name === "application");
  const appCls = (attrStr(appNode!, "name") ?? "android.app.Application").replace(/^\./, pkg + ".").replace(/\./g, "/");
  const themeAttr = appNode?.attrs.find((a) => a.name === "theme");
  const labelAttr = appNode?.attrs.find((a) => a.name === "label");
  const iconAttr = appNode?.attrs.find((a) => a.name === "icon");
  // find launcher activity
  let mainActivity: string | null = null;
  const activities = new Map<string, XmlNode>();
  for (const c of appNode?.children ?? []) {
    if (c.name !== "activity" && c.name !== "activity-alias") continue;
    let n = attrStr(c, "name") ?? "";
    if (n.startsWith(".")) n = pkg + n;
    activities.set(n.replace(/\./g, "/"), c);
    const hasLauncher = c.children.some((f) =>
      f.name === "intent-filter" &&
      f.children.some((x) => x.name === "category" && attrStr(x, "name") === "android.intent.category.LAUNCHER"));
    if (hasLauncher && !mainActivity) mainActivity = n.replace(/\./g, "/");
  }
  if (!mainActivity) throw new Error("no launcher activity found");
  const providers = new Map<string, XmlNode>();
  for (const c of appNode?.children ?? []) {
    if (c.name !== "provider") continue;
    const n = attrStr(c, "name") ?? "";
    providers.set(n.startsWith(".") ? pkg + n : n, c);
  }
  setManifest(manifest, activities, providers); // PackageManager answers from the real manifest

  onStatus("resources…");
  const arsc = new Arsc(zip["resources.arsc"]);
  const res = new Resources(arsc, zip);
  const jres = mkJResources(res);
  const themeResId = themeAttr?.data ?? 0;
  const theme = new JTheme();
  theme.res = res;
  // sensible base: Material Light, then app theme on top
  const fwMaterial = fw.ids.style?.["Theme.Material.Light.DarkActionBar"] ?? 0;
  if (fwMaterial) theme.apply(fwMaterial);
  if (themeResId) theme.apply(themeResId);

  let label = pkg;
  if (labelAttr) {
    if (labelAttr.str) label = labelAttr.str;
    else {
      const s = res.value(labelAttr.data);
      label = s.s ?? pkg;
    }
  }

  const host: AppHost = {
    res, theme, pkg, apkFile, appLabel: label, themeResId, iconRes: iconAttr?.data ?? 0, zip,
    application: null, jresources: jres,
    statusBarColor: -16777216, navBarColor: -16777216,
    launch: async (component, intent) => { await launchActivity(component, intent); },
    // finish() only requests: AOSP delivers the pause/stop/destroy chain as later main-thread
    // messages, so it queues as a main job rather than running detached alongside the caller
    finishActivity: (a) => { void onMain(() => finishActivity(a)); },
    recreateActivity: (a) => { recreateActivity(a); },
    currentActivity: () => booted?.stack[booted.stack.length - 1] ?? null,
    invalidateOptionsMenu: (a) => { void buildOptionsMenu(a); },
  };
  setAppHost(host);

  onStatus("starting app…");
  const baseCtx = new JContext();
  baseCtx.$host = host;
  let appInfo;
  try {
    appInfo = rt.link(appCls);
  } catch {
    appInfo = rt.link("android/app/Application");
  }
  const p0 = rt.initClass(appInfo);
  if (p0) await p0;
  const application = new appInfo.ctor();
  host.application = application;
  application.$host = host;
  try {
    await vcall(application, "<init>", "()V");
    await vcall(application, "attachBaseContext", "(Landroid/content/Context;)V", baseCtx);
    // ContentProviders run before Application.onCreate (androidx-startup initializers
    // like WorkManager live here)
    for (const pn of providers.keys()) {
      try {
        const cls = pn.replace(/\./g, "/");
        if (rt.link(cls).stub) continue;
        const prov = await newObj(cls);
        prov.$ctx = application;
        await vcall(prov, "onCreate", "()Z");
      } catch (e) { console.warn("[provider]", pn, (e as { msg?: string })?.msg ?? e); }
    }
    await vcall(application, "onCreate", "()V");
  } catch (e) {
    reportUncaught(e);
  }

  booted = { host, mainActivityCls: mainActivity, stack: [], label };
  onStatus("launching " + mainActivity.split("/").pop());
  await launchActivity(mainActivity, null);
  return booted;
}

function launchActivity(cls: string, intent: JIntent | null): Promise<void> {
  // Activity lifecycle is main-looper work: serialize and pin the thread identity.
  // Java-side startActivity already runs inside a main-looper job (click handlers,
  // Handler posts); re-entering the queue there would deadlock on ourselves, so a caller
  // that already HOLDS the queue runs inline. Holding it is not the same as being on the
  // main thread — boot pins curThread to the main thread without taking the queue, and
  // launching inline from there let the whole activity-start chain interleave with tick
  // jobs at every await (Compose then created its composition twice: once from onMeasure,
  // once from onAttachedToWindow, neither having stored the result yet).
  const run = async () => {
    const prev = curThread;
    setCurThread(mainThread);
    try { await launchActivity0(cls, intent); } finally { setCurThread(prev); }
  };
  return inMainJob() ? run() : onMain(run);
}
async function launchActivity0(cls: string, intent: JIntent | null, relaunch?: Relaunch) {
  if (!booted) return;
  const host = booted.host;
  let info;
  try {
    info = rt.link(cls);
  } catch (e) {
    reportUncaught(e);
    return;
  }
  const p = rt.initClass(info);
  if (p) await p;
  const act: JActivity = new info.ctor();
  act.$host = host;
  act.lastNonConfig = relaunch?.nonConfig ?? null;
  const saved = relaunch?.state ?? null;
  try {
    await vcall(act, "<init>", "()V");
    act.window.activity = act;
    act.intent = intent;
    const prev = booted.stack[booted.stack.length - 1];
    if (prev?.resumed) { await pauseActivity(prev); await windowFocus(prev, false); }
    booted.stack.push(act);
    await ensureDecor(act);
    try { await vcall(act, "onCreate", "(Landroid/os/Bundle;)V", saved); }
    catch (e) { reportUncaught(e); }
    await fireActivityLifecycle(act, "Created", saved);
    // Android dispatches onAttachedToWindow after onCreate, before onStart — and it must
    // happen even if a later lifecycle callback throws (androidx ViewPager.populate needs it).
    if (act.window.decor) await dispatchAttached(act.window.decor);
    try { await vcall(act, "onStart", "()V"); } catch (e) { reportUncaught(e); }
    await fireActivityLifecycle(act, "Started");
    try { await vcall(act, "onPostCreate", "(Landroid/os/Bundle;)V", saved); } catch (e) { reportUncaught(e); }
    try { await vcall(act, "onResume", "()V"); } catch (e) { reportUncaught(e); }
    await fireActivityLifecycle(act, "Resumed");
    try { await vcall(act, "onPostResume", "()V"); } catch (e) { reportUncaught(e); }
    await windowFocus(act, true);
    // AOSP stops the covered activity only once the new one is up
    if (prev?.started) await stopActivity(prev);
    void buildOptionsMenu(act);
    uiState.needsLayout = true;
    uiState.needsDraw = true;
    // Fragment pages (ViewPager/FragmentPagerAdapter) instantiate asynchronously, after this
    // frame's layout. Schedule extra re-layouts so they get measured/laid out once present.
    uiState.settle = Math.max(uiState.settle, 6);
    for (const delay of [80, 200, 450]) {
      setTimeout(() => { uiState.needsLayout = true; uiState.needsDraw = true; }, delay);
    }
  } catch (e) {
    reportUncaught(e);
  }
}

interface Relaunch { state: JBundle | null; nonConfig: unknown }

/**
 * A configuration change an activity did not declare in its manifest relaunches it: AOSP saves
 * the instance state and the non-configuration instance, tears the instance down, then starts a
 * fresh one with both. That relaunch IS how such an app sees a new Configuration at all — it is
 * the whole of AppCompat's day/night switch — so recreate() has to do it for real.
 */
export function recreateActivity(act: JActivity): void {
  const cls = (act.constructor as any)?.$i?.name as string | undefined;
  if (!cls || !booted || booted.stack.indexOf(act) < 0) return;
  // AOSP's recreate() only schedules the relaunch; running it nested inside the caller's own
  // main-looper job (a click handler) would tear the activity down underneath it.
  setTimeout(() => void onMain(async () => {
    if (!booted) return;
    const i = booted.stack.indexOf(act);
    if (i < 0) return;
    const prev = curThread;
    setCurThread(mainThread);
    // androidx keeps the ViewModelStore only while the activity says it is changing config.
    act.changingConfigurations = true;
    const state = new JBundle();
    let nonConfig: unknown = null;
    try {
      try {
        if (act.resumed) { await vcall(act, "onPause", "()V"); await fireActivityLifecycle(act, "Paused"); }
        await windowFocus(act, false);
        await vcall(act, "onSaveInstanceState", "(Landroid/os/Bundle;)V", state);
        if (act.window.decor) await dispatchDetached(act.window.decor);
        await vcall(act, "onStop", "()V");
        await fireActivityLifecycle(act, "Stopped");
        nonConfig = await vcall(act, "onRetainNonConfigurationInstance", "()Ljava/lang/Object;");
        await vcall(act, "onDestroy", "()V");
        await fireActivityLifecycle(act, "Destroyed");
      } catch (e) { reportUncaught(e); }
      booted.stack.splice(i, 1);
      await launchActivity0(cls, act.intent, { state, nonConfig });
    } catch (e) { reportUncaught(e); }
    finally { setCurThread(prev); }
  }), 0);
}

async function lifecycleStep(act: JActivity, method: string, phase: Parameters<typeof fireActivityLifecycle>[1]) {
  try { await vcall(act, method, "()V"); } catch (e) { reportUncaught(e); }
  await fireActivityLifecycle(act, phase);
}
const pauseActivity = (act: JActivity) => lifecycleStep(act, "onPause", "Paused");
const stopActivity = (act: JActivity) => lifecycleStep(act, "onStop", "Stopped");
/** Returning to a covered activity: onRestart → onStart → onResume → onPostResume, with the
 *  ActivityLifecycleCallbacks a fresh launch fires. androidx moves its fragments to RESUMED in
 *  onPostResume, so pages created after a round-trip were stuck STARTED without it. */
async function resumeActivity(act: JActivity) {
  if (!act.started) {
    try { await vcall(act, "onRestart", "()V"); } catch (e) { reportUncaught(e); }
    await lifecycleStep(act, "onStart", "Started");
  }
  if (!act.resumed) await lifecycleStep(act, "onResume", "Resumed");
  try { await vcall(act, "onPostResume", "()V"); } catch (e) { reportUncaught(e); }
}
/** ViewRootImpl reports window focus once the resumed activity's window is up and takes it
 *  away when another window covers it. Only a change is delivered, as the window manager does;
 *  game loops start and stop on this callback, so a silent default left them never started. */
async function windowFocus(act: JActivity, has: boolean) {
  if (act.hasWindowFocus === has) return;
  act.hasWindowFocus = has;
  const z = has ? 1 : 0;
  try {
    await vcall(act, "onWindowFocusChanged", "(Z)V", z);
    if (act.window.decor) await vcall(act.window.decor, "dispatchWindowFocusChanged", "(Z)V", z);
  } catch (e) { reportUncaught(e); }
}

async function finishActivity(act: JActivity) {
  if (!booted) return;
  const i = booted.stack.indexOf(act);
  if (i < 0) return;
  booted.stack.splice(i, 1);
  act.finished = true;
  if (act.resumed) await pauseActivity(act);
  await windowFocus(act, false);
  const top = booted.stack[booted.stack.length - 1];
  if (top) {
    await resumeActivity(top);
    await windowFocus(top, true);
    void buildOptionsMenu(top);
  }
  if (act.window.decor) await dispatchDetached(act.window.decor);
  if (act.started) await stopActivity(act);
  await lifecycleStep(act, "onDestroy", "Destroyed");
  uiState.needsLayout = true;
  uiState.needsDraw = true;
}

async function buildOptionsMenu(act: JActivity) {
  if (!act.window.actionBarView) return;
  const menu = new JMenu();
  menu.bar = act.window.actionBarView;
  act.optionsMenu = menu;
  try {
    await vcall(act, "onCreatePanelMenu", "(ILandroid/view/Menu;)Z", 0, menu);
    await vcall(act, "onPreparePanel", "(ILandroid/view/View;Landroid/view/Menu;)Z", 0, null, menu);
  } catch (e) { reportUncaught(e); }
  pushMenuToBar(menu);
}

// A key is input like a touch: it runs as a main-looper job, so androidx's main-thread asserts
// (handleLifecycleEvent inside the finish path) see the main thread, not whichever worker
// last set curThread.
export function pressBack(): Promise<void> {
  return inMainJob() ? pressBack0() : onMain(pressBack0);
}
async function pressBack0() {
  // the topmost window takes the key: a dialog or popup before the activity under it
  const top = overlays[overlays.length - 1];
  const act = booted?.stack[booted.stack.length - 1];
  try {
    if (top?.onBack) await top.onBack();
    else if (top?.dismissOnOutside) await dismissOverlay(top);
    else if (act) await vcall(act, "onBackPressed", "()V");
  } catch (e) { reportUncaught(e); }
}

const M_doFrame = mangleMethod("doFrame", "(J)V");
const M_dispatch = mangleMethod("dispatchTouchEvent", "(Landroid/view/MotionEvent;)Z");
let drawing = false;
let sbColor = NaN, sbCss = "";
let clockMinute = -1, clockText = "";
// Views committed outside a layout pass (androidx addViewInLayout, async fragment
// commits) can leave measured != laid-out sizes with no pass scheduled. Detect and
// schedule one more full pass; fingerprint prevents re-trigger loops on legit mismatches.
let lastSettleFp = 0;
function settleWatch(root: any): void {
  // Hash rather than concatenate: this walks the whole tree, and building a string per
  // mismatch made every drawn frame allocate proportionally to the tree.
  let fp = 0, n = 0;
  const stack = [root];
  while (stack.length) {
    const v = stack.pop();
    if (!v || v.visibility === 8) continue;
    const w = v.right - v.left, h = v.bottom - v.top;
    if ((v.measuredW !== w || v.measuredH !== h) && v.measuredW > 0 && v.measuredH > 0) {
      n++;
      fp = (Math.imul(fp, 33) ^ (v.idNum ?? 0)) >>> 0;
      fp = (Math.imul(fp, 33) ^ (w * 31 + h)) >>> 0;
      fp = (Math.imul(fp, 33) ^ (v.measuredW * 31 + v.measuredH)) >>> 0;
    }
    for (const c of v.children ?? []) stack.push(c);
  }
  // A mismatch means someone committed a view outside a layout pass; the cached specs are
  // no longer trustworthy anywhere, so ask for a full re-measure rather than a cached one.
  if (n && fp !== lastSettleFp) { uiState.needsLayout = true; uiState.needsDraw = true; uiState.forceAll = true; }
  lastSettleFp = n ? fp : 0;
}


export async function tick(ctx: CanvasRenderingContext2D) {
  if (drawing) return;
  drawing = true;
  // AOSP clears mIsInTraversal in a finally: a rejected frame must not latch the guard on
  // and stop every later frame.
  try { await onMain(() => tick0(ctx)); } finally { drawing = false; }
}
async function tick0(ctx: CanvasRenderingContext2D) {
  try {
    // choreographer + animation callbacks. One timestamp for the whole frame, as AOSP's
    // doFrame does: every callback here awaits, so recomputing it per callback let two
    // callbacks in the SAME frame see times hundreds of ms apart during boot.
    uiState.frameTimeNanos = BigInt(Math.floor(performance.now() * 1e6));
    const cbs = uiState.frameCallbacks.splice(0);
    for (const cb of cbs as { frame?: any; run?: any }[]) {
      try {
        if (cb.frame) await guardCall((cb.frame as any)[M_doFrame], cb.frame, uiState.frameTimeNanos);
        else if (cb.run) await vcall(cb.run, "run", "()V");
      } catch (e) { reportUncaught(e); }
    }

    for (const hook of [...uiState.animHooks]) {
      if (!hook()) uiState.animHooks.delete(hook);
    }
    const act = booted?.stack[booted.stack.length - 1];
    const decor = act?.window.decor;
    if (!decor) return;
    let didLayout = false;
    const contentY = contentTop(), contentH = SCREEN_H - contentY;
    if (uiState.needsLayout) {
      uiState.needsLayout = false;
      didLayout = true;
      const t0 = performance.now();
      perf.layoutPasses++;
      decor.layoutRequested = true;
      try {
        // Only blow the whole tree's cached measurements away when a caller dirtied something
        // it could not name; otherwise requestLayout(view) has already marked the path to the
        // root and measureView reuses everything else.
        if (uiState.forceAll) { uiState.forceAll = false; forceLayoutFlags(decor); }
        await measureView(decor, makeSpec(SCREEN_W, MS_EXACTLY), makeSpec(contentH, MS_EXACTLY));
        await layoutView(decor, 0, 0, SCREEN_W, contentH);
        for (const o of overlays) {
          o.view.layoutRequested = true;
          await measureView(o.view, makeSpec(SCREEN_W, 0x80000000 | 0), makeSpec(contentH, 0x80000000 | 0));
          await layoutView(o.view, o.x, o.y, o.x + o.view.measuredW, o.y + o.view.measuredH);
        }
        await fireGlobalLayout(decor);
      } catch (e) {
        // A subtree that cannot measure costs a frame, not the session: fall through and draw
        // whatever DID lay out. Re-arming needsLayout here would turn a deterministic throw
        // into a 60fps exception storm; the next real requestLayout() recovers.
        perf.layoutErrors++;
        console.error("[layout]", e);
      }
      perf.layoutMs += performance.now() - t0;
      uiState.needsDraw = true;
      // stateful app views (ViewPager etc.) may cache specs mid-build: settle with extra passes
      if (uiState.settle > 0) {
        uiState.settle--;
        uiState.needsLayout = true;
      }
    }
    if (uiState.needsDraw) {
      uiState.needsDraw = false;
      const t0 = performance.now();
      perf.draws++;
      const laidOut = didLayout;
      ctx.save();
      try {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
        if (contentY) {
          const sb = booted!.host.statusBarColor;
          if (sb !== sbColor) { sbColor = sb; sbCss = cssColor(sb); }
          ctx.fillStyle = sbCss;
          ctx.fillRect(0, 0, SCREEN_W, STATUS_H);
          drawStatusIcons(ctx, sb, act!.window);
        }
        ctx.translate(0, contentY);
        const cv = JCanvas.wrap(ctx, SCREEN_W, contentH);
        // AOSP's performDraw() dispatches OnPreDrawListener/OnDrawListener right before the
        // tree draw, on every draw pass -- not only ones that also ran a layout.
        try {
          await fireDrawPass(decor);
          await drawView(decor, cv);
          for (const o of overlays) await drawView(o.view, cv);
          drawToasts(ctx, SCREEN_W, contentH);
        } catch (e) {
          perf.drawErrors++;
          console.error("[draw]", e);
        }
      } finally {
        ctx.restore();
      }
      perf.drawMs += performance.now() - t0;
      // WebView frames are DOM over the canvas: show the ones this pass drew, hide the rest
      webLayerSweep(contentY, overlays.length > 0);
      // Only meaningful right after a layout pass: without one, measured-vs-laid-out sizes
      // cannot have changed, so the walk is pure cost.
      if (laidOut) settleWatch(decor);
    }
  } catch (e) {
    console.error("[tick]", e);
  }
}
function forceLayoutFlags(v: JView) {
  v.layoutRequested = true;
  v.layoutRequired = true;
  v.oldWSpec = -1;
  if (v instanceof JViewGroup) for (const c of v.children) forceLayoutFlags(c);
}
function drawStatusIcons(ctx: CanvasRenderingContext2D, bg: number, w: JActivity["window"]) {
  // AOSP: the light-status-bars appearance bit decides once the app has set or cleared it;
  // the luminance guess only stands in for an app that never asked.
  const dark = w.appearanceMask & APPEARANCE_LIGHT_STATUS_BARS ? (w.appearance & APPEARANCE_LIGHT_STATUS_BARS) !== 0
    : 0.299 * ((bg >> 16) & 0xff) + 0.587 * ((bg >> 8) & 0xff) + 0.114 * (bg & 0xff) > 160;
  ctx.fillStyle = dark ? "rgba(0,0,0,0.85)" : "#ffffff";
  ctx.font = `500 26px ${tfMedium.family}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const now = new Date(), minute = now.getHours() * 60 + now.getMinutes();
  if (minute !== clockMinute) { clockMinute = minute; clockText = `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`; }
  ctx.fillText(clockText, 20, STATUS_H / 2 + 1);
  ctx.textAlign = "right";
  const x = SCREEN_W - 16;
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = 2.5;
  ctx.strokeRect(x - 34, 12, 26, 24);
  ctx.fillRect(x - 30, 16, 18, 16);
  ctx.fillRect(x - 7, 19, 4, 10);
  ctx.beginPath();
  ctx.moveTo(x - 74, 34);
  ctx.lineTo(x - 46, 34);
  ctx.lineTo(x - 60, 14);
  ctx.closePath();
  ctx.fill();
}

let touchTarget: "decor" | { overlay: number } | null = null;
// input joins the main queue: keeps DOWN/UP ordered and serialized with layout,
// Handler posts, and lifecycle — like Android's single main looper.
export function dispatchPointer(action: number, x: number, y: number): Promise<void> {
  // charged to perf.inputMs: the wall time a tap costs is otherwise in no counter at all.
  const t0 = performance.now();
  return onMain(() => dispatchPointer0(action, x, y)).finally(() => { perf.inputMs += performance.now() - t0; });
}
async function dispatchPointer0(action: number, x: number, y: number) {
  const act = booted?.stack[booted.stack.length - 1];
  const decor = act?.window.decor;
  if (!decor) return;
  const ev = new JMotionEvent();
  ev.action = action;
  ev.rawX = x;
  ev.rawY = y;
  const ly = y - contentTop();
  try {
    if (action === 0) {
      // hit-test overlays topmost first
      for (let i = overlays.length - 1; i >= 0; i--) {
        const o = overlays[i];
        const v = o.view;
        if (x >= v.left && x < v.right && ly >= v.top && ly < v.bottom) {
          touchTarget = { overlay: i };
          break;
        }
        if (o.dismissOnOutside) {
          await dismissOverlay(o);
          touchTarget = null;
          return;
        }
      }
      if (touchTarget === null) touchTarget = "decor";
    }
    if (touchTarget && touchTarget !== "decor") {
      const o = overlays[touchTarget.overlay];
      if (o) {
        ev.x = x - o.view.left;
        ev.y = ly - o.view.top;
        await guardCall((o.view as any)[M_dispatch], o.view, ev);
      }
    } else {
      ev.x = x;
      ev.y = ly;
      await guardCall((decor as any)[M_dispatch], decor, ev);
    }
    if (action === 1 || action === 3) touchTarget = null;
  } catch (e) {
    reportUncaught(e);
  }
}
