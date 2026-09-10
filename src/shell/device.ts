// Device shell: APK boot, activity stack, frame loop, touch routing.

import { dexesIn } from "../jvm/dex";
import { rt, type JObj } from "../jvm/runtime";
import { analyseProgram } from "../jvm/analyse";
import { vfs, apkPath } from "../jvm/natives/jio";
import { openInstall, type Install } from "./install";
import { vcall, curThread, mainThread, setCurThread } from "../jvm/natives/jlang";
import { Arsc } from "../android/arsc";
import { loadFramework, loadFrameworkDex } from "../android/framework";
import { parseAXML, attr, attrStr, type XmlNode } from "../android/axml";
import { Resources, JTheme } from "../android/res";
import { mkJResources, setDeviceNight, syncDeviceOrientation, deviceConfiguration } from "../android/resnative";
import { setAppHost, type AppHost } from "../android/apphost";
import { setManifest, manifestActivityTheme, manifestActivityOrientation, activityHandlesConfig, CONFIG_UI_MODE, getPM } from "../android/pm";
import { JIntent, deliverActivityResult } from "../android/intent";
import { ensureDecor, startingWindow } from "../android/decor";
import { getInflater } from "../android/inflate";
import { JActivity, fireActivityLifecycle } from "../android/app";
import { JMenu, pushMenuToBar } from "../android/menu";
import { JContext } from "../android/context";
import { attachProvider } from "../android/contentresolver";
import { APPEARANCE_LIGHT_STATUS_BARS } from "../android/window";
import { reportUncaught, JBundle, dispatchVsync } from "../android/os";
import { onMain, inMainJob, mainDbg } from "../android/mainloop";
import { JView, JViewGroup, uiState, layoutPass, replayLayoutRequests, measureView, layoutView, drawView, makeSpec, MS_EXACTLY, fireGlobalLayout, fireDrawPass, dispatchAttached, dispatchDetached, guardCall } from "../android/view";
import { JMotionEvent } from "../android/motionevent";
import { dispatchWindowInsets } from "../android/windowinsets";
import { JCanvas, cssColor, tfMedium } from "../android/graphics";
import { overlays, drawToasts, dismissOverlay } from "../android/popup";
import { webLayerSweep } from "../android/webkit";
import { mangleMethod } from "../jvm/abi";
import { perf } from "../perf";
import { device, orientationForRequest, setDeviceOrientation } from "./config";
import { restoreRoots } from "./hostfs";

export let SCREEN_W = device.width, SCREEN_H = device.height;
const STATUS_H = device.statusBar;
let displayChanged = () => {};
export function setDisplayChangeHandler(handler: () => void): void { displayChanged = handler; }
// Frames are composed off screen and presented whole. A task boundary inside a draw (a bytecode
// yield, an image decode) would otherwise let the browser composite the half-painted canvas.
// The bitmap transfer is a zero-copy swap; a drawImage blit cost a software rasteriser ~10 ms
// a frame. Read the screen back with toBlob: toDataURL on a transferred bitmap stalls.
let fb = new OffscreenCanvas(SCREEN_W, SCREEN_H);
export let frame = fb.getContext("2d")!;
let screen: ImageBitmapRenderingContext | null = null;
export function setScreenCanvas(c: HTMLCanvasElement): void { screen = c.getContext("bitmaprenderer"); }
export function present(): void { screen?.transferFromImageBitmap(fb.transferToImageBitmap()); }

/** Apply one of ActivityInfo's fixed orientations; all other requests retain the current axes. */
function applyOrientationRequest(request: number): boolean {
  const orientation = orientationForRequest(request);
  if (!orientation || !setDeviceOrientation(orientation)) return false;
  SCREEN_W = device.width;
  SCREEN_H = device.height;
  fb = new OffscreenCanvas(SCREEN_W, SCREEN_H);
  frame = fb.getContext("2d")!;
  syncDeviceOrientation();
  displayChanged();
  return true;
}

/** The launch component's declaration, resolving an alias to its target Activity when needed. */
function launcherOrientation(root: XmlNode): number {
  const pkg = attrStr(root, "package") ?? "";
  const app = root.children.find((c) => c.name === "application");
  const nameOf = (node: XmlNode) => {
    const name = attrStr(node, "name") ?? "";
    return name.startsWith(".") ? pkg + name : name;
  };
  const launcher = app?.children.find((node) => (node.name === "activity" || node.name === "activity-alias") && node.children.some((filter) =>
    filter.name === "intent-filter" && filter.children.some((x) => x.name === "category" && attrStr(x, "name") === "android.intent.category.LAUNCHER")));
  if (!launcher) return -1;
  const own = attr(launcher, "screenOrientation");
  if (own) return own.data;
  const target = attrStr(launcher, "targetActivity");
  if (!target) return -1;
  const full = target.startsWith(".") ? pkg + target : target;
  const targetNode = app?.children.find((node) => node.name === "activity" && nameOf(node) === full);
  return (targetNode && attr(targetNode, "screenOrientation")?.data) ?? -1;
}

/** `?sync=1` opts into the sync tier. Off by default: see "The sync tier is worth 24x and we
 *  cannot have it yet" in the implementation history — the analysis is sound, our natives are not. */
const SYNC_TIER = typeof location !== "undefined" && new URLSearchParams(location.search).get("sync") === "1";

interface BootedApp {
  host: AppHost;
  mainActivityCls: string;
  stack: JActivity[];
  label: string;
}
let booted: BootedApp | null = null;
export function currentApp(): BootedApp | null { return booted; }
/** <activity-alias> component name → the Activity class that actually runs */
const aliasTargets = new Map<string, string>();

const FLAG_FULLSCREEN = 1024;
/** Where the top activity's window starts: FLAG_FULLSCREEN takes the status bar's rows too. */
export function contentTop(): number {
  const act = booted?.stack[booted.stack.length - 1];
  return act && (act.window.flags & FLAG_FULLSCREEN) ? 0 : STATUS_H;
}

export async function bootApk(input: Uint8Array | Install, onStatus: (s: string) => void, apkFile = ""): Promise<BootedApp> {
  // The android package registers android.R.* and fills the widgets' attr-id tables, so it has to
  // be here before anything links. main.ts starts the fetch alongside the apk's, so this waits on
  // nothing in the common case.
  // The directories a previous session picked, awaited: an app reads its persisted storage URI
  // while it is starting, and a tree that does not resolve *yet* is one that does not exist as
  // far as it is concerned — for the whole session, since it caches the answer.
  onStatus("unpacking apk…");
  const install = input instanceof Uint8Array ? openInstall(input) : input;
  const zip = install.zip;
  // Orientation precedes resource construction: both app and framework tables must select the
  // same -land/-port entries the Activity will see through Configuration.
  applyOrientationRequest(launcherOrientation(parseAXML(zip["AndroidManifest.xml"])));
  const [fwPkg] = await Promise.all([loadFramework(), restoreRoots()]);
  rt.classpath = zip;
  // sourceDir is the base apk, not the container it arrived in: a library that re-extracts its
  // own .so with ZipFile(ApplicationInfo.sourceDir) has to find lib/, not a list of apks.
  vfs.write(apkPath(), install.base);
  for (const sp of install.splits) {
    if (sp.bytes) vfs.write(apkPath(sp.name), sp.bytes);
    else vfs.mount(apkPath(sp.name), sp.source);
  }
  onStatus("loading dex…");
  // The apk goes in first: loadDex is first-wins by name, so an app shipping its own copy of a
  // framework class keeps it, as on a device where the app's dex is ahead on the class path.
  for (const name of Object.keys(zip)) {
    if (/^classes\d*\.dex$/.test(name)) for (const d of dexesIn(zip[name], name)) rt.loadDex(d);
  }
  await loadFrameworkDex();
  // Natives materialize AFTER every dex is indexed, never before: a native whose super or
  // interface is a class provenance withheld would otherwise link it, find no dex yet, and
  // auto-stub it into the class cache for the rest of the run.
  for (const name of [...rt.natives.keys()]) {
    try { rt.link(name); } catch (e) { console.warn("[link native]", name, e); }
  }
  // Every dex is loaded and every native has a prototype, so the call graph is complete and
  // nothing has been compiled yet: the only moment the suspension analysis can run.
  if (SYNC_TIER) {
    onStatus("analysing…");
    const services: Record<string, string> = {};
    for (const n of Object.keys(zip)) {
      if (n.startsWith("META-INF/services/")) services[n] = new TextDecoder().decode(zip[n]);
    }
    const a = analyseProgram(zip["AndroidManifest.xml"], services);
    console.log(`[webdroid] ${a.reachable} reachable methods, ${a.sync} cannot suspend, in ${a.ms.toFixed(0)}ms`);
  }
  const manifest = parseAXML(zip["AndroidManifest.xml"]);
  const pkg = attrStr(manifest, "package") ?? "app";
  const appNode = manifest.children.find((c) => c.name === "application");
  const appCls = (attrStr(appNode!, "name") ?? "android.app.Application").replace(/^\./, pkg + ".").replace(/\./g, "/");
  const themeAttr = appNode?.attrs.find((a) => a.name === "theme");
  const labelAttr = appNode?.attrs.find((a) => a.name === "label");
  const iconAttr = appNode?.attrs.find((a) => a.name === "icon");
  let mainActivity: string | null = null;
  aliasTargets.clear();
  const activities = new Map<string, XmlNode>();
  for (const c of appNode?.children ?? []) {
    if (c.name !== "activity" && c.name !== "activity-alias") continue;
    let n = attrStr(c, "name") ?? "";
    if (n.startsWith(".")) n = pkg + n;
    activities.set(n.replace(/\./g, "/"), c);
    // An <activity-alias> names a component, not a class: the class that runs is its
    // targetActivity. The alias keeps its own name everywhere a component is named (that is
    // what an intent resolves to and what PackageManager answers for) and only the launch
    // resolves through. Play-store icon swaps and renamed entry points are aliases, so an
    // apk whose LAUNCHER is one used to link the alias name and auto-stub it.
    const target = attrStr(c, "targetActivity");
    if (target) aliasTargets.set(n.replace(/\./g, "/"), (target.startsWith(".") ? pkg + target : target).replace(/\./g, "/"));
    const hasLauncher = c.children.some((f) =>
      f.name === "intent-filter" &&
      f.children.some((x) => x.name === "category" && attrStr(x, "name") === "android.intent.category.LAUNCHER"));
    if (hasLauncher && !mainActivity) mainActivity = n.replace(/\./g, "/");
  }
  if (!mainActivity) throw new Error("no launcher activity found");
  // ActivityThread installs providers by descending initOrder, manifest order breaking ties
  const providers = new Map<string, XmlNode>();
  const providerNodes = (appNode?.children ?? []).filter((c) => c.name === "provider");
  for (const c of providerNodes.sort((a, b) => (attr(b, "initOrder")?.data ?? 0) - (attr(a, "initOrder")?.data ?? 0))) {
    const n = attrStr(c, "name") ?? "";
    providers.set(n.startsWith(".") ? pkg + n : n, c);
  }
  setManifest(manifest, activities, providers); // PackageManager answers from the real manifest

  onStatus("resources…");
  const arsc = new Arsc(zip["resources.arsc"], (p) => zip[p] ?? null);
  for (const sp of install.splits) if (sp.resources) arsc.add(sp.resources);
  const res = new Resources(arsc, zip, install.lazyEntries);
  const jres = mkJResources(res);
  const themeResId = themeAttr?.data ?? 0;
  const theme = new JTheme();
  theme.res = res;
  // sensible base: Material Light, then app theme on top
  const fwMaterial = fwPkg.findId("style", "Theme.Material.Light.DarkActionBar");
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
    splits: install.splits.map((sp) => sp.name),
    application: null, jresources: jres,
    statusBarColor: -16777216, navBarColor: -16777216,
    launch: async (component, intent) => { await launchActivity(component, intent); },
    // finish() only requests: AOSP delivers the pause/stop/destroy chain as later main-thread
    // messages, so it queues as a main job rather than running detached alongside the caller
    finishActivity: (a) => { void onMain(() => finishActivity(a)); },
    recreateActivity: (a) => { recreateActivity(a); },
    setRequestedOrientation: (a, orientation) => { changeActivityOrientation(a, orientation); },
    currentActivity: () => booted?.stack[booted.stack.length - 1] ?? null,
    invalidateOptionsMenu: (a) => { void buildOptionsMenu(a); },
  };
  setAppHost(host);

  return onMain(async () => {
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
      for (const [pn, node] of providers) {
        try {
          const cls = pn.replace(/\./g, "/");
          if (rt.link(cls).stub) continue;
          const authority = attrStr(node, "authorities")?.split(";")[0];
          if (!authority) continue;
          const info = await vcall(getPM(), "resolveContentProvider", "(Ljava/lang/String;I)Landroid/content/pm/ProviderInfo;", authority, 128);
          if (info) await attachProvider(application, info);
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
  });
}

function launchActivity(cls: string, intent: JIntent | null): Promise<void> {
  // Startup and Java callbacks already hold the main queue; queuing again would deadlock.
  const run = async () => {
    const prev = curThread;
    setCurThread(mainThread);
    try { await launchActivity0(cls, intent); } finally { setCurThread(prev); }
  };
  return inMainJob() ? run() : onMain(run);
}
async function launchActivity0(component: string, intent: JIntent | null, relaunch?: Relaunch) {
  if (!booted) return;
  const host = booted.host;
  const cls = aliasTargets.get(component) ?? component;
  const requestedOrientation = relaunch?.requestedOrientation ?? manifestActivityOrientation(cls);
  applyOrientationRequest(requestedOrientation);
  // AOSP puts a window up from the package's own theme before the process has run a line, and
  // it stands until the activity's decor draws. That is why a launch that dies on the way up
  // still leaves a frame on a device, and it is the frame this shows.
  if (!booted.stack.length) {
    try {
      startWin = await startingWindow(host, cls);
      uiState.needsDraw = true;
    } catch (e) { console.warn("[starting window]", e); }
  }
  // Linking, <clinit> and construction are the app's code too: a static initializer that
  // throws (System.loadLibrary in one is enough) crashes the activity, exactly as on a device.
  // It must not take the boot down with it.
  let act: JActivity;
  try {
    const info = rt.link(cls);
    const p = rt.initClass(info);
    if (p) await p;
    act = new info.ctor();
  } catch (e) {
    reportUncaught(e);
    return;
  }
  act.$host = host;
  act.requestedOrientation = requestedOrientation;
  act.lastNonConfig = relaunch?.nonConfig ?? null;
  const saved = relaunch?.state ?? null;
  try {
    await vcall(act, "<init>", "()V");
    // Activity.attach(): the base context arrives before the manifest theme, which AOSP applies
    // before onCreate so an app's own setTheme layers on top of it rather than replacing it
    const baseCtx = new JContext();
    baseCtx.$host = host;
    await vcall(act, "attachBaseContext", "(Landroid/content/Context;)V", baseCtx);
    const actTheme = manifestActivityTheme(cls);
    if (actTheme) vcall(act, "setTheme", "(I)V", actTheme);
    act.window.activity = act;
    getInflater(act).privateFactory = act;
    act.intent = intent;
    const prev = booted.stack[booted.stack.length - 1];
    if (prev?.resumed) { await pauseActivity(prev); await windowFocus(prev, false); }
    booted.stack.push(act);
    try { await vcall(act, "onCreate", "(Landroid/os/Bundle;)V", saved); }
    catch (e) { reportUncaught(e); }
    // onCreate may set the window theme before its first getDecorView/setContentView.
    await ensureDecor(act);
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
    uiState.needsInsets = true; // a new window: its decor has never been handed the insets
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

const CONFIG_ORIENTATION_SIZE = 0x0080 | 0x0400;
function changeActivityOrientation(act: JActivity, request: number): void {
  if (!applyOrientationRequest(request)) return;
  uiState.needsLayout = true;
  uiState.needsDraw = true;
  uiState.needsInsets = true;
  if (activityHandlesConfig(act, CONFIG_ORIENTATION_SIZE)) {
    void onMain(() => vcall(act, "onConfigurationChanged", "(Landroid/content/res/Configuration;)V", deviceConfiguration())).catch(reportUncaught);
  } else recreateActivity(act);
}

/**
 * The device's own light/dark setting changed under a running app. AOSP delivers that the way it
 * delivers any configuration change: the top activity is told if it declared uiMode in its
 * manifest, and relaunched if it did not. An app following the system reaches its new colours
 * through one of those two doors and no other.
 */
function deviceNightChanged(night: boolean): void {
  if (!setDeviceNight(night) || !booted) return;
  uiState.needsLayout = true;
  uiState.needsDraw = true;
  const act = booted.stack[booted.stack.length - 1];
  if (!act) return;
  if (activityHandlesConfig(act, CONFIG_UI_MODE)) {
    void onMain(async () => {
      await vcall(act, "onConfigurationChanged", "(Landroid/content/res/Configuration;)V", deviceConfiguration());
    }).catch(reportUncaught);
  } else recreateActivity(act);
}
globalThis.matchMedia?.("(prefers-color-scheme: dark)")
  .addEventListener("change", (e) => deviceNightChanged(e.matches));

interface Relaunch { state: JBundle | null; nonConfig: unknown; requestedOrientation: number }

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
      await launchActivity0(cls, act.intent, { state, nonConfig, requestedOrientation: act.requestedOrientation });
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
    applyOrientationRequest(top.requestedOrientation);
    await resumeActivity(top);
    await windowFocus(top, true);
    void buildOptionsMenu(top);
  }
  // AOSP hands the result to the launcher once it is back up, before the finished instance dies.
  if (act.resultTo) deliverActivityResult(act.resultTo.act, act.resultTo.code, act.resultCode, act.resultData);
  if (act.window.decor) await dispatchDetached(act.window.decor);
  if (act.started) await stopActivity(act);
  await lifecycleStep(act, "onDestroy", "Destroyed");
  uiState.needsLayout = true;
  uiState.needsDraw = true;
  uiState.needsInsets = true; // the revealed activity's decor is the new dispatch target
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
/** The status band and its icons: one copy, so the starting window paints the same band the
 *  activity's own frame does. */
function drawStatusBar(ctx: OffscreenCanvasRenderingContext2D, appearance: number, appearanceMask: number) {
  const sb = booted!.host.statusBarColor;
  if (sb !== sbColor) { sbColor = sb; sbCss = cssColor(sb); }
  ctx.fillStyle = sbCss;
  ctx.fillRect(0, 0, SCREEN_W, STATUS_H);
  drawStatusIcons(ctx, sb, appearance, appearanceMask);
}
/** AOSP's starting window: the system's, painted from the package's theme before the app has
 *  run. It is not the app drawing, so it deliberately does not count in perf.draws — corpus
 *  reads that to mean "this apk got far enough to render", and it must keep meaning it. */
let startWin: { view: JView; fullscreen: boolean } | null = null;
async function drawStartWin(w: { view: JView; fullscreen: boolean }) {
  const contentY = w.fullscreen ? 0 : STATUS_H, ctx = frame;
  ctx.save();
  try {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    if (contentY) drawStatusBar(ctx, 0, 0);
    ctx.translate(0, contentY);
    await drawView(w.view, JCanvas.wrap(ctx, SCREEN_W, SCREEN_H - contentY));
  } catch (e) {
    perf.drawErrors++;
    console.error("[draw]", e);
  } finally {
    ctx.restore();
  }
  present();
}
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


export async function tick() {
  if (drawing) return;
  drawing = true;
  // AOSP clears mIsInTraversal in a finally: a rejected frame must not latch the guard on
  // and stop every later frame.
  try { await onMain(tick0); } finally { drawing = false; }
}
async function tick0() {
  const ctx = frame;
  try {
    // choreographer + animation callbacks. One timestamp for the whole frame, as AOSP's
    // doFrame does: every callback here awaits, so recomputing it per callback let two
    // callbacks in the SAME frame see times hundreds of ms apart during boot.
    uiState.frameTimeNanos = BigInt(Math.floor(performance.now() * 1e6));
    const presentation = uiState.frameTimeNanos + uiState.frameIntervalNanos;
    const cbs = uiState.frameCallbacks.length ? uiState.frameCallbacks.splice(0) : [];
    for (const cb of cbs as { frame?: any; run?: any; vsync?: JObj }[]) {
      mainDbg.phase = "frame:" + ((cb.frame ?? cb.run ?? cb.vsync)?.constructor?.$i?.name ?? "?");
      try {
        if (cb.frame) await guardCall(cb.frame, M_doFrame, uiState.frameTimeNanos);
        else if (cb.vsync) await dispatchVsync(cb.vsync, presentation);
        else if (cb.run) await vcall(cb.run, "run", "()V");
      } catch (e) { reportUncaught(e); }
    }

    mainDbg.phase = "anim";
    if (uiState.animHooks.size) {
      for (const hook of [...uiState.animHooks]) if (!hook()) uiState.animHooks.delete(hook);
    }
    const act = booted?.stack[booted.stack.length - 1];
    const decor = act?.window.decor;
    if (!decor) {
      if (startWin && uiState.needsDraw) {
        uiState.needsDraw = false;
        await drawStartWin(startWin);
      }
      return;
    }
    startWin = null;
    let didLayout = false;
    const contentY = contentTop(), contentH = SCREEN_H - contentY;
    // AOSP's performTraversals dispatches insets before measure, so padding a fitsSystemWindows
    // consumer sets is visible to the same pass. Waiting for one completed layout keeps a
    // listener that reads getHeight() from seeing zeros; clearing the flag BEFORE dispatching
    // means a listener's own requestApplyInsets() re-arms the next frame instead of recursing.
    if (uiState.needsInsets && decor.right > 0) {
      uiState.needsInsets = false;
      mainDbg.phase = "insets";
      try { await dispatchWindowInsets(decor); } catch (e) { console.error("[insets]", e); }
      uiState.needsLayout = true;
    }
    if (uiState.needsLayout) {
      uiState.needsLayout = false;
      didLayout = true;
      const t0 = performance.now();
      perf.layoutPasses++;
      decor.layoutRequested = true;
      layoutPass.active = true;
      try {
        // Only blow the whole tree's cached measurements away when a caller dirtied something
        // it could not name; otherwise requestLayout(view) has already marked the path to the
        // root and measureView reuses everything else.
        if (uiState.forceAll) { uiState.forceAll = false; forceLayoutFlags(decor); }
        mainDbg.phase = "measure";
        await measureView(decor, makeSpec(SCREEN_W, MS_EXACTLY), makeSpec(contentH, MS_EXACTLY));
        mainDbg.phase = "layout";
        await layoutView(decor, 0, 0, SCREEN_W, contentH);
        mainDbg.phase = "overlays";
        for (const o of overlays) {
          o.view.layoutRequested = true;
          await measureView(o.view, makeSpec(SCREEN_W, 0x80000000 | 0), makeSpec(contentH, 0x80000000 | 0));
          // AOSP lays a window out inside the screen: a dropdown anchored near the right edge
          // shifts left instead of hanging off it. The popup's own placement pass runs before
          // its content has a measured width, so this is the pass that has the real numbers —
          // and the position is written back, since hit-testing reads it too.
          o.x = Math.max(0, Math.min(o.x, SCREEN_W - o.view.measuredW));
          o.y = Math.max(0, Math.min(o.y, contentH - o.view.measuredH));
          await layoutView(o.view, o.x, o.y, o.x + o.view.measuredW, o.y + o.view.measuredH);
        }
        mainDbg.phase = "globalLayout";
        await fireGlobalLayout(decor);
      } catch (e) {
        // A subtree that cannot measure costs a frame, not the session: fall through and draw
        // whatever DID lay out. Re-arming needsLayout here would turn a deterministic throw
        // into a 60fps exception storm; the next real requestLayout() recovers.
        perf.layoutErrors++;
        console.error("[layout]", e);
      }
      layoutPass.active = false;
      replayLayoutRequests();
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
      rt.yieldGap = 50;
      try {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
        if (contentY) drawStatusBar(ctx, act!.window.appearance, act!.window.appearanceMask);
        ctx.translate(0, contentY);
        const cv = JCanvas.wrap(ctx, SCREEN_W, contentH);
        // AOSP's performDraw() dispatches OnPreDrawListener/OnDrawListener right before the
        // tree draw, on every draw pass -- not only ones that also ran a layout.
        try {
          mainDbg.phase = "preDraw";
          await fireDrawPass(decor);
          mainDbg.phase = "draw";
          await drawView(decor, cv);
          mainDbg.phase = "drawOverlays";
          for (const o of overlays) await drawView(o.view, cv);
          drawToasts(ctx, SCREEN_W, contentH);
        } catch (e) {
          perf.drawErrors++;
          console.error("[draw]", e);
        }
      } finally {
        ctx.restore();
        rt.yieldGap = 8;
      }
      present();
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
  mainDbg.phase = "";
}
function forceLayoutFlags(v: JView) {
  v.layoutRequested = true;
  v.layoutRequired = true;
  v.oldWSpec = -1;
  if (v instanceof JViewGroup) for (const c of v.children) forceLayoutFlags(c);
}
function drawStatusIcons(ctx: OffscreenCanvasRenderingContext2D, bg: number, appearance: number, appearanceMask: number) {
  // AOSP: the light-status-bars appearance bit decides once the app has set or cleared it;
  // the luminance guess only stands in for an app that never asked.
  const dark = appearanceMask & APPEARANCE_LIGHT_STATUS_BARS ? (appearance & APPEARANCE_LIGHT_STATUS_BARS) !== 0
    : 0.299 * ((bg >> 16) & 0xff) + 0.587 * ((bg >> 8) & 0xff) + 0.114 * (bg & 0xff) > 160;
  ctx.fillStyle = dark ? "rgba(0,0,0,0.85)" : "#ffffff";
  ctx.font = `500 ${device.dp(13)}px ${tfMedium.family}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const now = new Date(), minute = now.getHours() * 60 + now.getMinutes();
  if (minute !== clockMinute) { clockMinute = minute; clockText = `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`; }
  ctx.fillText(clockText, device.dp(10), STATUS_H / 2 + device.dp(0.5));
  ctx.textAlign = "right";
  const x = SCREEN_W - device.dp(8);
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = device.dp(1.25);
  ctx.strokeRect(x - device.dp(17), device.dp(6), device.dp(13), device.dp(12));
  ctx.fillRect(x - device.dp(15), device.dp(8), device.dp(9), device.dp(8));
  ctx.fillRect(x - device.dp(3.5), device.dp(9.5), device.dp(2), device.dp(5));
  ctx.beginPath();
  ctx.moveTo(x - device.dp(37), device.dp(17));
  ctx.lineTo(x - device.dp(23), device.dp(17));
  ctx.lineTo(x - device.dp(30), device.dp(7));
  ctx.closePath();
  ctx.fill();
}

let touchTarget: "decor" | { overlay: number } | null = null;
let downTime = 0;
// input joins the main queue: keeps DOWN/UP ordered and serialized with layout,
// Handler posts, and lifecycle — like Android's single main looper.
export function dispatchPointer(action: number, x: number, y: number, at = performance.now()): Promise<void> {
  // charged to perf.inputMs: the wall time a tap costs is otherwise in no counter at all.
  const t0 = performance.now();
  return onMain(() => dispatchPointer0(action, x, y, at)).finally(() => { perf.inputMs += performance.now() - t0; });
}
async function dispatchPointer0(action: number, x: number, y: number, t: number) {
  const act = booted?.stack[booted.stack.length - 1];
  const decor = act?.window.decor;
  if (!decor) return;
  const ev = new JMotionEvent();
  ev.action = action;
  ev.rawX = x;
  ev.rawY = y;
  // The same clock SystemClock.uptimeMillis reports, because app code subtracts one from the
  // other: Compose's velocity tracker divides by this dt, and 0 - 0 is not a duration.
  // t is when the event was generated, not when the queue got round to it: a gap between two
  // events has to mean the finger paused, never that the app was busy. A gesture stamps its
  // events at the times it meant, as an input driver does, so a fling's velocity does not
  // depend on how loaded the host is.
  ev.eventTime = t;
  if (action === 0) downTime = ev.eventTime;
  ev.downTime = downTime;
  const ly = y - contentTop();
  try {
    if (action === 0) {
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
    } else if (touchTarget === null) {
      // No target is latched, so the DOWN either never happened or was swallowed dismissing an
      // overlay. Falling through would dispatch this MOVE to the decor as though a finger had
      // been down on it all along, and a scroller would jump by the whole distance since its
      // stale last position.
      return;
    }
    if (touchTarget && touchTarget !== "decor") {
      const o = overlays[touchTarget.overlay];
      if (o) {
        ev.x = x - o.view.left;
        ev.y = ly - o.view.top;
        await guardCall(o.view, M_dispatch, ev);
      }
    } else {
      ev.x = x;
      ev.y = ly;
      await guardCall(decor, M_dispatch, ev);
    }
    if (action === 1 || action === 3) touchTarget = null;
  } catch (e) {
    reportUncaught(e);
  }
}
