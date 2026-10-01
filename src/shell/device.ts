// Device shell: APK boot, display and configuration, frame loop, touch routing. The activity
// stack is activities.ts.

import { dexesIn, isDexEntry } from "../jvm/dex";
import { rt, type Gen, type JObj, driven } from "../jvm/runtime";
import { vfs, apkPath } from "./vfs";
import { inflateTree } from "../jvm/natives/jzip";
import type { Install } from "./install";
import { vcall, vcallOn, callOn, mainThread, JThrowable, stackTraceText, scall, after } from "../jvm/natives/jlang";
import { processEnv } from "./environment";
import { setTargetSdkVersion } from "../jvm/natives/jreflect";
import { Arsc } from "../android/arsc";
import { loadFramework, loadPlatformDex } from "../android/framework";
import { zygoteInit } from "../android/delegates";
import { fetchSystemFonts, mountSystemFonts } from "../android/fonts";
import { loadCode, fetchLinkTable, useLinkTable, startupDone } from "../jvm/codecache";
import { compileProfile, parseBaselineProfile } from "../jvm/baselineprof";
import { parseAXML, attr, attrStr, type XmlNode } from "../android/axml";
import { Resources, nativeRes } from "../android/res";
import { setDeviceNight, syncDeviceOrientation, deviceConfiguration, applyApplicationLocales, localesFromTags, initDeviceLocales, type JLocaleList } from "../android/resnative";
import { setAppHost, jclsNameOf, type AppHost } from "../android/apphost";
import { loadResources, newTheme, javaConfiguration, applyDeviceConfiguration } from "../android/resources";
import { registerApk } from "../android/assetmanager";
import { setManifest, activityHandlesConfig, CONFIG_UI_MODE, resolveProvider } from "../android/pm";
import { windowDim, windowParams } from "../android/window";
import { absGravity, gravityApply } from "../android/gravity";
import { JActivity, dispatchSplashExit } from "../android/app";
import { getPrefs } from "../android/sharedprefs";
import { newContextImpl } from "../android/context";
import { attachProvider } from "../android/contentresolver";
import { reportUncaught, PROCESS_PID, setProcessIdentity, setProcessName } from "../android/os";
import { pressBackKey } from "../android/keyevent";
import {
  booted, setBootedApp, aliasTargets, activityHost, launchMain, recreateActivity, invalidateWindow, visibleActivities,
  atHome, activityVisibility0, startWin, dropStartingWindow, type BootedApp,
} from "./activities";
import { packageUid, packages, usesSdk } from "../android/packages";
import { onMain, mainDbg, mainLooper, fnRunnable, type JFnRunnable } from "../android/mainloop";
import { mainChoreographer, deliverVsync, CALLBACK_TRAVERSAL } from "../android/vsync";
import { JView, JViewGroup, uiState, setFrameRequester, requestLayoutAll, replayLayoutRequests, measureView, layoutRoot, clearMeasureCache, setViewTargetSdk, drawView, makeSpec, MS_EXACTLY, fireGlobalLayout, fireDrawPass, guardCall } from "../android/view";
import { obtainAsCopy } from "../android/motionevent";
import { touchEvent } from "../android/inputdevices";
import { dispatchWindowInsets, rootWindowInsets } from "../android/windowinsets";
import { windowCanvas, setCanvasTargetSdk } from "../android/canvas";
import { animateRenderThread } from "../android/rtanimator";
import { overlays, drawToasts, FLAG_NOT_FOCUSABLE, FLAG_NOT_TOUCHABLE, FLAG_NOT_TOUCH_MODAL, FLAG_WATCH_OUTSIDE_TOUCH, type Overlay } from "../android/popup";
import { webLayerSweep } from "../android/webkit";
import { mangleMethod } from "../jvm/abi";
import { perf } from "../perf";
import { guestNow, uptimeMillis } from "../guest-clock";
import { device, orientationForRequest, setDeviceOrientation } from "./config";
import { resolveSystemBars, drawSystemBarBackgrounds } from "./systembars";
import { restoreRoots } from "./hostfs";
import { setPixelCopyFrame, latchSurfaces } from "../android/glview";
import { notePresent } from "../native/cpu";
import { noteInput } from "../jvm/yield";
import { stageD } from "../jvm/provenance";
import { appArchives } from "../jvm/natives/jdex";
import { hostWindowManager, dispatchTouch } from "../android/server/wm";
import { startActivityThread } from "../android/server/am";
import { setDisplayTarget } from "../android/surfaceflinger";

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
export function setScreenCanvas(c: HTMLCanvasElement): void { screen = c.getContext("bitmaprenderer"); setPixelCopyFrame(c); }
export function present(): void {
  if (!screen) return;
  latchSurfaces();
  screen.transferFromImageBitmap(fb.transferToImageBitmap());
  if (!perf.presentations++) startupDone();
  notePresent();
}

/** Apply one of ActivityInfo's fixed orientations; all other requests retain the current axes. */
export function applyOrientationRequest(request: number): boolean {
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

const qualify = (pkg: string, name: string) => name.startsWith(".") ? pkg + name : name;
const isLauncher = (node: XmlNode) => node.children.some((filter) =>
  filter.name === "intent-filter" && filter.children.some((x) => x.name === "category" && attrStr(x, "name") === "android.intent.category.LAUNCHER"));

/** The launch component's declaration, resolving an alias to its target Activity when needed. */
function launcherOrientation(root: XmlNode): number {
  const pkg = attrStr(root, "package") ?? "";
  const app = root.children.find((c) => c.name === "application");
  const launcher = app?.children.find((node) => (node.name === "activity" || node.name === "activity-alias") && isLauncher(node));
  if (!launcher) return -1;
  const own = attr(launcher, "screenOrientation");
  if (own) return own.data;
  const target = attrStr(launcher, "targetActivity");
  if (!target) return -1;
  const full = qualify(pkg, target);
  const targetNode = app?.children.find((node) => node.name === "activity" && qualify(pkg, attrStr(node, "name") ?? "") === full);
  return (targetNode && attr(targetNode, "screenOrientation")?.data) ?? -1;
}

/** UiModeManager's persisted application night mode: MODE_NIGHT_NO, MODE_NIGHT_YES, else the device's */
let applicationNightOverride: boolean | null = null;
const nightOverride = (mode: unknown): boolean | null => mode === 1 ? false : mode === 2 ? true : null;
export function currentApp(): BootedApp | null { return booted; }
let zygote: Promise<void> | null = null;
/** What a device's zygote holds before it forks an app: the framework package, the boot class
 *  path indexed and the natives linked. It needs no app, so a page starts it while the app
 *  downloads. Natives link after the platform is indexed, never before: a native whose super or
 *  interface is a class provenance withheld would otherwise find no dex and be auto-stubbed. */
export function startZygote(): Promise<void> {
  return zygote ??= (async () => {
    const table = fetchLinkTable();
    await Promise.all([loadFramework(), loadPlatformDex()]);
    useLinkTable(await table, rt.linkFingerprint());
    await rt.linkNatives((name, e) => console.warn("[link native]", name, e), 8);
    // the runtime's own setup and the system font map need no app: a device's zygote runs them
    mountSystemFonts(await fetchSystemFonts());
    await zygoteInit();
    scheduleTraversal();
  })();
}

export async function bootApk(install: Install, onStatus: (s: string) => void, assetKey = "", processName: string | null = null, prepared?: () => void): Promise<BootedApp> {
  // The framework package must be in place before anything links, and restored storage roots
  // must resolve before the app reads a persisted tree URI: it caches the answer for the session.
  onStatus("Reading package…");
  const zip = install.zip;
  const manifest = parseAXML(zip["AndroidManifest.xml"]);
  const pkg = attrStr(manifest, "package") ?? "app";
  applicationNightOverride = nightOverride(getPrefs(pkg, "__system_uimode").map.get("mode"));
  setDeviceNight(applicationNightOverride ?? device.night);
  // Orientation precedes resource construction: both app and framework tables must select the
  // same -land/-port entries the Activity will see through Configuration.
  applyOrientationRequest(launcherOrientation(manifest));
  const code = loadCode(processName ?? pkg);
  await Promise.all([startZygote(), restoreRoots()]);
  // ActivityThread.main: an app process does not track unclosed resources
  await scall("dalvik/system/CloseGuard", "setEnabled", "(Z)V", 0);
  rt.classpath = zip;
  // sourceDir is the base apk, not the container it arrived in: a library that re-extracts its
  // own .so with ZipFile(ApplicationInfo.sourceDir) has to find lib/, not a list of apks.
  if (install.base instanceof Uint8Array) vfs.write(apkPath(), install.base);
  else vfs.mount(apkPath(), install.base);
  for (const sp of install.splits) {
    if (sp.bytes) vfs.write(apkPath(sp.name), sp.bytes);
    else vfs.mount(apkPath(sp.name), sp.source);
  }
  onStatus("Loading app code…");
  await inflateTree(zip, isDexEntry);
  // The app's dex goes in after the boot class path, which loadDex's first-wins keeps ahead: an
  // app's copy of a platform class is never loaded, as PathClassLoader asks its parent first.
  for (const name of Object.keys(zip)) {
    if (isDexEntry(name)) for (const d of dexesIn(zip[name], name)) rt.loadDex(d);
  }
  await code;
  const profile = zip["assets/dexopt/baseline.prof"] && parseBaselineProfile(zip["assets/dexopt/baseline.prof"]);
  if (profile) compileProfile(rt, Object.keys(zip).filter(isDexEntry).map((name) => [name, zip[name]]), profile);
  // LoadedApk makes the app's class loader under ActivityThread; the TS stack makes it here
  appArchives.add(apkPath()); appArchives.add(packages.get(pkg)?.path ?? apkPath());
  if (!stageD()) rt.classLoader = rt.make("dalvik/system/PathClassLoader");
  await initDeviceLocales();
  await vfs.prepare(pkg);
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
    const n = qualify(pkg, attrStr(c, "name") ?? "").replace(/\./g, "/");
    activities.set(n, c);
    // An <activity-alias> names a component, not a class: the class that runs is its
    // targetActivity. The alias keeps its own name everywhere a component is named (that is
    // what an intent resolves to and what PackageManager answers for) and only the launch
    // resolves through.
    const target = attrStr(c, "targetActivity");
    if (target) aliasTargets.set(n, qualify(pkg, target).replace(/\./g, "/"));
    if (!mainActivity && isLauncher(c)) mainActivity = n;
  }
  if (!mainActivity && !processName) throw new Error("no launcher activity found");
  // ActivityThread installs providers by descending initOrder, manifest order breaking ties
  const providers = new Map<string, XmlNode>();
  const providerNodes = (appNode?.children ?? []).filter((c) => c.name === "provider");
  for (const c of providerNodes.sort((a, b) => (attr(b, "initOrder")?.data ?? 0) - (attr(a, "initOrder")?.data ?? 0))) {
    providers.set(qualify(pkg, attrStr(c, "name") ?? ""), c);
  }

  onStatus("Loading resources…");
  const arsc = new Arsc(zip["resources.arsc"], (p) => zip[p] ?? null);
  for (const sp of install.splits) if (sp.resources) arsc.add(sp.resources);
  registerApk(apkPath(), new Resources(arsc, zip, install.lazyEntries));
  const themeResId = themeAttr?.data ?? 0;
  const { target } = usesSdk(manifest);
  const jres = await loadResources(apkPath(), await javaConfiguration(deviceConfiguration()));
  // ActivityThread.handleBindApplication: the system Resources take the device configuration and
  // display metrics too (Resources.getSystem() starts from setToDefaults: a 0x0 display)
  await applyDeviceConfiguration();
  const res = nativeRes(jres);
  // ContextImpl.getTheme: the manifest's theme, or the platform default for the target SDK
  const theme = await newTheme(jres, null, await scall("android/content/res/Resources", "selectDefaultTheme", "(II)I", themeResId, target));

  const label = !labelAttr ? pkg : labelAttr.str || (res.value(labelAttr.data).s ?? pkg);

  const host: AppHost = {
    res, theme, pkg, assetKey, appLabel: label, themeResId, iconRes: iconAttr?.data ?? 0, zip,
    splits: install.splits.map((sp) => sp.name),
    application: null, jresources: jres,
    ...activityHost,
    setRequestedOrientation: (a, orientation) => { changeActivityOrientation(a, orientation); },
    setApplicationNightMode: (mode) => { setApplicationNightMode(pkg, mode); },
    setApplicationLocales: (locales) => { setApplicationLocales(pkg, locales); },
  };
  setAppHost(host);
  const savedLocales = getPrefs(pkg, "__system_locales").map.get("tags");
  if (typeof savedLocales === "string" && savedLocales) applyApplicationLocales(await localesFromTags(savedLocales));
  setProcessIdentity(PROCESS_PID, packages.get(pkg)?.uid ?? packageUid(pkg));
  setProcessName(processName ?? pkg);
  setManifest(manifest);
  setViewTargetSdk(target);
  await setCanvasTargetSdk(target);
  setTargetSdkVersion(target);
  prepared?.();

  if (stageD()) {
    hostWindowManager();
    setDisplayTarget(frame, present);
    const app: BootedApp = { host, mainActivityCls: "", stack: [], label, background: false };
    setBootedApp(app);
    onStatus("Starting app…");
    await onMain(startActivityThread);
    return app;
  }
  return onMain(async () => {
    onStatus("Starting app…");
    // handleBindApplication names the process, which Process.myProcessName answers
    await scall("android/os/Process", "setArgV0", "(Ljava/lang/String;)V", processName ?? pkg);
    const baseCtx = newContextImpl(host);
    // ActivityThread.setupGraphicsSupport: temporary files go to the app's cache directory
    const tmpdir: string = await vcall(await vcall(baseCtx, "getCacheDir", "()Ljava/io/File;"), "getAbsolutePath", "()Ljava/lang/String;");
    await scall("java/lang/System", "setProperty", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", "java.io.tmpdir", tmpdir);
    processEnv.TMPDIR = tmpdir;
    // handleBindApplication installs the app's network security config (AndroidNSSP, and the
    // cleartext policy) before any of its code runs
    await callOn(mainThread, () => scall("android/security/net/config/NetworkSecurityConfigProvider", "install", "(Landroid/content/Context;)V", baseCtx));
    let appInfo;
    try {
      appInfo = rt.link(appCls);
    } catch {
      appInfo = rt.link("android/app/Application");
    }
    const p0 = rt.initClass(appInfo);
    if (p0) await p0;
    const application = callOn(mainThread, () => new appInfo.ctor());
    host.application = application;
    application.$host = host;
    try {
      await vcallOn(mainThread, application, "<init>", "()V");
      await vcallOn(mainThread, application, "attachBaseContext", "(Landroid/content/Context;)V", baseCtx);
      // ContentProviders install before Application.onCreate
      for (const [pn, node] of providers) {
        if (processName) {
          const declared = attrStr(node, "process") ?? attrStr(appNode!, "process") ?? pkg;
          if ((declared.startsWith(":") ? pkg + declared : declared) !== processName) continue;
        }
        try {
          const cls = pn.replace(/\./g, "/");
          if (rt.link(cls).stub) continue;
          const authority = attrStr(node, "authorities")?.split(";")[0];
          const component = authority ? resolveProvider(authority) : null;
          if (component) await attachProvider(application, component);
        } catch (e) { console.warn("[provider]", pn, (e as { msg?: string })?.msg ?? e); }
      }
      await vcallOn(mainThread, application, "onCreate", "()V");
    } catch (e) {
      reportUncaught(e);
    }

    // only the app's own process answers the launcher; a child process runs components
    const app: BootedApp = { host, mainActivityCls: processName ? "" : mainActivity ?? "", stack: [], label, background: false };
    setBootedApp(app);
    if (app.mainActivityCls) {
      onStatus("Opening app…");
      await launchMain();
    }
    return app;
  });
}


/** A physical rotation. An activity that fixed or locked its orientation keeps it, as the window
 *  manager keeps the display in that orientation for it. */
export function rotateDevice(landscape: boolean): Promise<void> {
  return onMain(async () => {
    const act = booted?.stack.at(-1), request = act?.requestedOrientation ?? -1;
    if (act && orientationForRequest(request) === null && request !== 5 && request !== 14) changeActivityOrientation(act, landscape ? 0 : 1);
  });
}
const CONFIG_ORIENTATION_SIZE = 0x0080 | 0x0400;
function changeActivityOrientation(act: JActivity, request: number): void {
  if (!applyOrientationRequest(request)) return;
  invalidateWindow();
  deliverConfigChange(act, CONFIG_ORIENTATION_SIZE);
}
/** A configuration change reaches an activity through onConfigurationChanged if it declared
 *  every changed bit, through a relaunch otherwise. */
function deliverConfigChange(act: JActivity, bits: number): void {
  requestLayoutAll();
  // AOSP's resources take the change first, as ActivityThread applies it before the activity sees it
  void onMain(() => after(applyDeviceConfiguration(), (config) => {
    if (activityHandlesConfig(jclsNameOf(act), bits)) return vcall(act, "onConfigurationChanged", "(Landroid/content/res/Configuration;)V", config);
    recreateActivity(act);
  })).catch(reportUncaught);
}
function applyConfigChange(bits: number): void {
  if (!booted) return;
  const act = booted.stack.at(-1);
  if (act) deliverConfigChange(act, bits);
  else requestLayoutAll();
}
function applyNightMode(night: boolean): void {
  if (setDeviceNight(night)) applyConfigChange(CONFIG_UI_MODE);
}
function setApplicationLocales(pkg: string, locales: JLocaleList): void {
  const prefs = getPrefs(pkg, "__system_locales");
  prefs.map.set("tags", locales.tags.join(","));
  prefs.persist();
  if (applyApplicationLocales(locales)) applyConfigChange(0x0004 | 0x2000); // CONFIG_LOCALE | CONFIG_LAYOUT_DIRECTION
}
function setApplicationNightMode(pkg: string, mode: number): void {
  const prefs = getPrefs(pkg, "__system_uimode");
  prefs.map.set("mode", mode);
  prefs.persist();
  applicationNightOverride = nightOverride(mode);
  applyNightMode(applicationNightOverride ?? device.night);
}
globalThis.matchMedia?.("(prefers-color-scheme: dark)")
  .addEventListener("change", (e) => { if (applicationNightOverride === null) applyNightMode(e.matches); });


// A key is input like a touch: it runs as a main-looper job, so androidx's main-thread asserts
// (handleLifecycleEvent inside the finish path) see the main thread, not whichever worker
// last set curThread.
export function pressBack(): Promise<void> {
  noteInput();
  return onMain(pressBack0);
}
const pressBack0 = driven(function* pressBack0(): Gen<void> {
  // the focused window takes the key: the topmost focusable one, else the activity under them.
  // ViewRootImpl hands it to the root view, which a decor passes to its window's callback.
  let top: JObj | undefined;
  for (let i = overlays.length - 1; i >= 0; i--) {
    const o = overlays[i];
    if (o.view.visibility === 0 && !(o.flags & FLAG_NOT_FOCUSABLE)) { top = (o.view.windowOwner?.callbackObj as JObj | null) ?? o.view; break; }
  }
  const act = booted?.stack.at(-1);
  try {
    if (top) yield pressBackKey(top);
    else if (act && !booted!.background) yield pressBackKey(act);
  } catch (e) { reportUncaught(e); }
});

const M_dispatch = mangleMethod("dispatchTouchEvent", "(Landroid/view/MotionEvent;)Z");
const drawStartWin = driven(function* drawStartWin(w: { view: JView; fullscreen: boolean }): Gen {
  const contentY = w.fullscreen ? 0 : STATUS_H, ctx = frame;
  ctx.save();
  try {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    ctx.translate(0, contentY);
    yield drawView(w.view, windowCanvas(ctx, SCREEN_W, SCREEN_H - contentY));
    ctx.resetTransform();
    const bars = resolveSystemBars(w.view, []);
    drawSystemBarBackgrounds(ctx, bars);
  } catch (e) {
    perf.drawErrors++;
    console.error("[draw]", e);
  } finally {
    ctx.restore();
  }
  present();
});

let traversal: JFnRunnable | null = null, traversalPending = false;
const frameWaiters: (() => void)[] = [];
/** ViewRootImpl.scheduleTraversals: the windows lay out and draw in the next vsync's frame, after
 *  that frame's input and animation callbacks */
export function scheduleTraversal(): void {
  if (traversalPending || !mainLooper || stageD()) return;
  traversalPending = true;
  traversal ??= fnRunnable(runTraversal);
  void after(mainChoreographer(), (c) => vcall(c, "postCallback", "(ILjava/lang/Runnable;Ljava/lang/Object;)V", CALLBACK_TRAVERSAL, traversal, null));
}
setFrameRequester(scheduleTraversal);
async function runTraversal(): Promise<void> {
  traversalPending = false;
  const t0 = performance.now();
  perf.frames++;
  try {
    await tick0(choreographerFrameTime());
    perf.completedFrames++; perf.frameMs += performance.now() - t0;
  } finally { for (const resolve of frameWaiters.splice(0)) resolve(); }
}
/** the frame time Choreographer.doFrame hands every callback of this frame */
const choreographerFrameTime = (): Promise<bigint> => after(mainChoreographer(), (c) => vcall(c, "getFrameTimeNanos", "()J")) as Promise<bigint>;
/** one frame now, on a vsync outside the display's pacing: a harness stepping a controlled clock */
export function testFrame(): Promise<void> {
  const done = new Promise<void>((resolve) => frameWaiters.push(resolve));
  scheduleTraversal();
  deliverVsync();
  return done;
}
const tick0 = driven(function* tick0(frameTime: Promise<bigint>): Gen {
  const ctx = frame;
  try {
    const frameTimeNanos: bigint = yield frameTime;
    mainDbg.phase = "anim";
    if (uiState.animHooks.size) {
      for (const hook of [...uiState.animHooks]) if (!hook()) uiState.animHooks.delete(hook);
      if (uiState.animHooks.size) scheduleTraversal();
    }
    if (animateRenderThread(Number(frameTimeNanos / 1000000n))) uiState.needsDraw = true;
    const activities = visibleActivities();
    const act = activities.at(-1);
    const decor = act?.window.decor;
    if (!decor || booted?.background) {
      if (startWin && uiState.needsDraw && !booted?.background) {
        uiState.needsDraw = false;
        yield drawStartWin(startWin);
      } else if (atHome() && uiState.needsDraw) {
        // the last activity finished: the home screen, not its final frame, is what shows
        uiState.needsDraw = false;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
        present();
      }
      return;
    }
    dropStartingWindow();
    // Dispatch before measure so decor margins and descendant inset padding affect this pass.
    // Clear first: a listener's requestApplyInsets() belongs to the next traversal.
    const insetsChanged = uiState.needsInsets;
    if (insetsChanged) {
      uiState.needsInsets = false;
      perf.insetsPasses++;
      mainDbg.phase = "insets";
      try {
        for (const activity of activities) if (activity.window.decor) yield dispatchWindowInsets(activity.window.decor);
      } catch (e) { console.error("[insets]", e); }
      uiState.needsLayout = true;
    }
    if (uiState.needsLayout) {
      uiState.needsLayout = false;
      const t0 = performance.now();
      perf.layoutPasses++;
      try {
        // Boot or a configuration change: every window's cached measurements are stale.
        // Otherwise requestLayout(view) has marked the path to its root and measureView reuses
        // everything else; a window nothing asked for is not re-measured at all.
        if (uiState.forceAll) {
          uiState.forceAll = false;
          for (const activity of activities) if (activity.window.decor) forceLayoutFlags(activity.window.decor);
          for (const o of overlays) forceLayoutFlags(o.view);
        }
        for (const activity of activities) {
          const root = activity.window.decor;
          if (!root) continue;
          mainDbg.phase = "measure";
          yield measureView(root, makeSpec(SCREEN_W, MS_EXACTLY), makeSpec(SCREEN_H, MS_EXACTLY));
          mainDbg.phase = "layout";
          yield layoutRoot(root, 0, 0, SCREEN_W, SCREEN_H);
        }
        mainDbg.phase = "overlays";
        for (const o of overlays) {
          // a dialog, or a WindowManager window with a gravity, is placed inside the system bars
          // it fits; any other window stays where it was put
          const win = o.view.windowOwner, params = windowParams(o.view), placed = win?.dialog ? win : params?.gravity ? params : null;
          const visible = placed?.fitInsetsIgnoringVisibility ? ~0 : rootWindowInsets(o.view).vis;
          const top = placed && (placed.fitInsetsSides & 2) && (placed.fitInsetsTypes & visible & 1) ? STATUS_H : 0;
          const bottom = placed && (placed.fitInsetsSides & 8) && (placed.fitInsetsTypes & visible & 2) ? device.navBar : 0;
          yield measureView(o.view, makeSpec(SCREEN_W, 0x80000000 | 0), makeSpec(SCREEN_H - top - bottom, 0x80000000 | 0));
          if (placed) {
            const frame = { left: 0, top, right: SCREEN_W, bottom: SCREEN_H - bottom };
            gravityApply(absGravity(placed.gravity), o.view.measuredW, o.view.measuredH, frame, placed === params ? params.x : 0, placed === params ? params.y : 0, frame);
            o.x = frame.left; o.y = frame.top;
          }
          // AOSP lays a window out inside the screen: a dropdown anchored near the right edge
          // shifts left instead of hanging off it. The popup's own placement pass runs before
          // its content has a measured width, so this is the pass that has the real numbers —
          // and the position is written back, since hit-testing reads it too.
          o.x = Math.max(0, Math.min(o.x, SCREEN_W - o.view.measuredW));
          o.y = Math.max(0, Math.min(o.y, SCREEN_H - o.view.measuredH));
          const right = o.x + o.view.measuredW, bottomEdge = o.y + o.view.measuredH;
          const frameChanged = o.view.left !== o.x || o.view.top !== o.y || o.view.right !== right || o.view.bottom !== bottomEdge;
          yield layoutRoot(o.view, o.x, o.y, right, bottomEdge);
          // Floating windows need their final frame to calculate window-local bar insets.
          if (insetsChanged || frameChanged) yield dispatchWindowInsets(o.view);
        }
        mainDbg.phase = "globalLayout";
        for (const activity of activities) if (activity.window.decor) yield fireGlobalLayout(activity.window.decor);
      } catch (e) {
        // A subtree that cannot measure costs a frame, not the session: fall through and draw
        // whatever DID lay out. Re-arming needsLayout here would turn a deterministic throw
        // into a 60fps exception storm; the next real requestLayout() recovers.
        perf.layoutErrors++;
        console.error("[layout]", e instanceof JThrowable ? yield stackTraceText(e) : e);
      }
      mainDbg.phase = "replay";
      replayLayoutRequests();
      perf.layoutMs += performance.now() - t0;
      uiState.needsDraw = true;
    }
    if (uiState.needsDraw) {
      uiState.needsDraw = false;
      const t0 = performance.now();
      perf.draws++;
      ctx.save();
      rt.yieldGap = 50;
      try {
        if (activities[0].window.translucent) ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
        else { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, SCREEN_W, SCREEN_H); }
        const cv = windowCanvas(ctx, SCREEN_W, SCREEN_H);
        // AOSP's performDraw() dispatches OnPreDrawListener/OnDrawListener right before the
        // tree draw, on every draw pass -- not only ones that also ran a layout.
        try {
          const bars = resolveSystemBars(decor, overlays);
          for (const activity of activities) {
            const root = activity.window.decor;
            if (!root) continue;
            const dim = windowDim(activity.window);
            if (dim) { ctx.fillStyle = `rgba(0,0,0,${dim})`; ctx.fillRect(0, 0, SCREEN_W, SCREEN_H); }
            mainDbg.phase = "preDraw";
            yield fireDrawPass(root);
            mainDbg.phase = "draw";
            yield drawView(root, cv);
            if (root === bars.root) drawSystemBarBackgrounds(ctx, bars);
          }
          mainDbg.phase = "drawOverlays";
          for (const o of overlays) {
            if (o.view.visibility !== 0) continue;
            const dim = o.dim?.() ?? 0;
            if (dim > 0) { ctx.fillStyle = `rgba(0,0,0,${dim})`; ctx.fillRect(0, 0, SCREEN_W, SCREEN_H); }
            yield drawView(o.view, cv);
            if (o.view === bars.root) drawSystemBarBackgrounds(ctx, bars);
          }
          drawToasts(ctx, SCREEN_W, SCREEN_H);
        } catch (e) {
          perf.drawErrors++;
          console.error("[draw]", e);
        }
      } finally {
        ctx.restore();
        rt.yieldGap = 8;
      }
      present();
      for (const activity of activities) {
        try { yield dispatchSplashExit(activity); } catch (error) { reportUncaught(error); }
      }
      perf.drawMs += performance.now() - t0;
      // WebView frames are DOM over the canvas: show the ones this pass drew, hide the rest
      webLayerSweep();
    }
  } catch (e) {
    console.error("[tick]", e);
  }
  mainDbg.phase = "";
});
function forceLayoutFlags(v: JView) {
  v.layoutRequested = true;
  v.layoutRequired = true;
  v.oldWSpec = -1;
  clearMeasureCache(v);
  if (v instanceof JViewGroup) for (const c of v.children) forceLayoutFlags(c);
}

let touchTarget: "decor" | Overlay | null = null;
let downTime = 0;
// input joins the main queue: keeps DOWN/UP ordered and serialized with layout,
// Handler posts, and lifecycle — like Android's single main looper.
export function dispatchPointer(action: number, x: number, y: number, at = guestNow()): Promise<void> {
  // charged to perf.inputMs: the wall time a tap costs is otherwise in no counter at all.
  const t0 = performance.now();
  noteInput();
  if (stageD()) {
    const now = BigInt(Math.floor(uptimeMillis()));
    if (action === 0) touchDown = now;
    return dispatchTouch(action, x, y, touchDown, now).then(() => {}, reportUncaught).finally(() => { perf.inputMs += performance.now() - t0; });
  }
  return onMain(() => dispatchPointer0(action, x, y, at)).finally(() => { perf.inputMs += performance.now() - t0; });
}
let touchDown = 0n;
/** InputEventReceiver's delivery to a window: the event in the window's coordinates, recycled once
 *  dispatch finishes */
const deliverTouch = driven(function* deliverTouch(target: JObj, action: number, x: number, y: number, downMs: number, atMs: number, left: number, top: number): Gen {
  const ev: JObj = yield obtainAsCopy(touchEvent(action, x, y, downMs, atMs, left, top));
  try { return yield guardCall(target, M_dispatch, ev); }
  finally { yield vcall(ev, "recycle", "()V"); }
});
const dispatchPointer0 = driven(function* dispatchPointer0(action: number, x: number, y: number, t: number): Gen<void> {
  // a tap on the home screen is a tap on the app's icon
  if (atHome()) { if (action === 1) yield activityVisibility0("resume"); return; }
  const window = booted?.stack.at(-1)?.window, decor = window?.decor;
  if (!decor) return;
  // SystemClock.uptimeMillis's clock, stamped when the event was generated rather than when the
  // queue reached it, so a fling's velocity does not depend on how loaded the host is.
  if (action === 0) downTime = t;
  try {
    if (action === 0) {
      // InputDispatcher: the topmost touchable window whose frame holds the point, or that is
      // touch-modal, takes the gesture; FLAG_WATCH_OUTSIDE_TOUCH windows above it see ACTION_OUTSIDE
      touchTarget = "decor";
      for (let i = overlays.length - 1; i >= 0; i--) {
        const o = overlays[i], v = o.view;
        if (v.visibility !== 0) continue;
        const inside = x >= v.left && x < v.right && y >= v.top && y < v.bottom;
        if (!(o.flags & FLAG_NOT_TOUCHABLE) && (inside || !(o.flags & (FLAG_NOT_FOCUSABLE | FLAG_NOT_TOUCH_MODAL)))) { touchTarget = o; break; }
        if (o.flags & FLAG_WATCH_OUTSIDE_TOUCH) yield deliverTouch(v, 4, x, y, downTime, t, v.left, v.top);
      }
    } else if (touchTarget === null) {
      // No target is latched: the DOWN never happened. Falling through would dispatch this MOVE
      // to the decor as though a finger had been down on it all along, and a scroller would
      // jump by the whole distance since its stale last position.
      return;
    }
    if (touchTarget !== "decor") {
      // a window the gesture's DOWN removed (a dismissed popup) takes nothing more of it
      const v = touchTarget.view;
      if (v.visibility === 0 && overlays.includes(touchTarget)) yield deliverTouch(v, action, x, y, downTime, t, v.left, v.top);
    } else yield deliverTouch(window.callbackObj ?? window.activity, action, x, y, downTime, t, 0, 0);
    if (action === 1 || action === 3) touchTarget = null;
  } catch (e) {
    reportUncaught(e);
  }
});
