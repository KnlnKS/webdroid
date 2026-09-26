// Device shell: APK boot, activity stack, frame loop, touch routing.

import { dexesIn } from "../jvm/dex";
import { rt, type JObj, type Gen } from "../jvm/runtime";
import { vfs, apkPath } from "../jvm/natives/jio";
import { openInstall, type Install } from "./install";
import { vcall, vcallOn, callOn, curThread, mainThread, setCurThread, JThrowable, stackTraceText } from "../jvm/natives/jlang";
import { Arsc } from "../android/arsc";
import { loadFramework, loadFrameworkDex } from "../android/framework";
import { parseAXML, attr, attrStr, type XmlNode } from "../android/axml";
import { Resources, JTheme } from "../android/res";
import { mkJResources, setDeviceNight, syncDeviceOrientation, deviceConfiguration } from "../android/resnative";
import { setAppHost, type AppHost, type ActivityLaunch } from "../android/apphost";
import { setManifest, manifestActivityTheme, manifestActivityOrientation, activityHandlesConfig, CONFIG_UI_MODE, getPM, usesSdk } from "../android/pm";
import { JIntent, deliverActivityResult, activityTransport, mkComponentName } from "../android/intent";
import { ensureDecor, startingWindow } from "../android/decor";
import { getInflater } from "../android/inflate";
import { JActivity, fireActivityLifecycle, dispatchSplashExit } from "../android/app";
import { getPrefs } from "../android/sharedprefs";

import { JMenu, pushMenuToBar } from "../android/menu";
import { JContext } from "../android/context";
import { attachProvider } from "../android/contentresolver";
import { reportUncaught, JBundle, dispatchVsync, PROCESS_PID, setProcessIdentity, setProcessName } from "../android/os";
import { packageUid, packages } from "../android/packages";
import { onMain, inMainJob, mainDbg } from "../android/mainloop";
import { JView, JViewGroup, uiState, requestLayoutAll, replayLayoutRequests, measureView, layoutRoot, clearMeasureCache, setViewTargetSdk, drawView, makeSpec, MS_EXACTLY, fireGlobalLayout, fireDrawPass, dispatchAttached, dispatchDetached, guardCall } from "../android/view";
import { JMotionEvent } from "../android/motionevent";
import { dispatchWindowInsets, rootWindowInsets } from "../android/windowinsets";
import { JCanvas } from "../android/graphics";
import { overlays, drawToasts, dismissOverlay, detachContextOverlays } from "../android/popup";
import { webLayerSweep } from "../android/webkit";
import { mangleMethod } from "../jvm/abi";
import { perf } from "../perf";
import { guestNow, setGuestTimeout } from "../guest-clock";
import { device, orientationForRequest, setDeviceOrientation } from "./config";
import { resolveSystemBars, drawSystemBarBackgrounds } from "./systembars";
import { restoreRoots } from "./hostfs";
import { setPixelCopyFrame } from "../android/glview";
import { requestResponsiveSlices } from "../native/cpu";

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
  screen.transferFromImageBitmap(fb.transferToImageBitmap());
  perf.presentations++;
}

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

interface BootedApp {
  host: AppHost;
  mainActivityCls: string;
  stack: JActivity[];
  label: string;
}
let booted: BootedApp | null = null;
let applicationNightOverride: boolean | null = null;
export function currentApp(): BootedApp | null { return booted; }
/** <activity-alias> component name → the Activity class that actually runs */
const aliasTargets = new Map<string, string>();

const invalidateWindow = () => {
  uiState.needsLayout = uiState.needsDraw = uiState.needsInsets = true;
  activityTransport.presentation?.(!!booted?.stack.length && booted.stack.every(act => act.window.translucent));
};
function visibleActivities(): JActivity[] {
  const stack = booted?.stack ?? [];
  let first = stack.length - 1;
  while (first > 0 && stack[first].window.translucent) first--;
  return first > 0 ? stack.slice(first) : stack;
}

export async function bootApk(input: Uint8Array | Install, onStatus: (s: string) => void, assetKey = "", processName: string | null = null, prepared?: () => void): Promise<BootedApp> {
  // The framework package must be in place before anything links, and restored storage roots
  // must resolve before the app reads a persisted tree URI: it caches the answer for the session.
  onStatus("Reading package…");
  const install = input instanceof Uint8Array ? openInstall(input) : input;
  const zip = install.zip;
  const manifest = parseAXML(zip["AndroidManifest.xml"]);
  const pkg = attrStr(manifest, "package") ?? "app";
  const savedNightMode = getPrefs(pkg, "__system_uimode").map.get("mode");
  applicationNightOverride = savedNightMode === 1 ? false : savedNightMode === 2 ? true : null;
  setDeviceNight(applicationNightOverride ?? device.night);
  // Orientation precedes resource construction: both app and framework tables must select the
  // same -land/-port entries the Activity will see through Configuration.
  applyOrientationRequest(launcherOrientation(manifest));
  const [fwPkg] = await Promise.all([loadFramework(), restoreRoots()]);
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
  // The apk goes in first: loadDex is first-wins by name, so an app shipping its own copy of a
  // framework class keeps it, as on a device where the app's dex is ahead on the class path.
  for (const name of Object.keys(zip)) {
    if (/^classes\d*\.dex$/.test(name)) for (const d of dexesIn(zip[name], name)) rt.loadDex(d);
  }
  await loadFrameworkDex();
  // Natives materialize AFTER every dex is indexed, never before: a native whose super or
  // interface is a class provenance withheld would otherwise link it, find no dex yet, and
  // auto-stub it into the class cache for the rest of the run.
  rt.linkNatives((name, e) => console.warn("[link native]", name, e));
  rt.classLoader = rt.make("dalvik/system/PathClassLoader");
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
  const res = new Resources(arsc, zip, install.lazyEntries);
  const jres = mkJResources(res);
  const themeResId = themeAttr?.data ?? 0;
  const theme = new JTheme();
  theme.res = res;
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
    res, theme, pkg, assetKey, appLabel: label, themeResId, iconRes: iconAttr?.data ?? 0, zip,
    splits: install.splits.map((sp) => sp.name),
    application: null, jresources: jres,
    launch: async (component, intent, options) => { await launchActivity(component, intent, options); },
    // finish() only requests: AOSP delivers the pause/stop/destroy chain as later main-thread
    // messages, so it queues as a main job rather than running detached alongside the caller
    finishActivity: (a) => { void onMain(() => finishActivity(a)); },
    roundTrip: async (a) => {
      if (a.resumed) { await pauseActivity(a); await windowFocus(a, false); }
      await resumeActivity(a);
      await windowFocus(a, true);
    },
    recreateActivity: (a) => { recreateActivity(a); },
    setRequestedOrientation: (a, orientation) => { changeActivityOrientation(a, orientation); },
    setApplicationNightMode: (mode) => { setApplicationNightMode(pkg, mode); },
    currentActivity: () => booted?.stack.at(-1) ?? null,
    activities: () => booted?.stack.slice() ?? [],
    finishTask: (taskId) => { void finishTask(taskId, true); },
    invalidateOptionsMenu: (a) => { void buildOptionsMenu(a); },
  };
  setAppHost(host);
  setProcessIdentity(PROCESS_PID, packages.get(pkg)?.uid ?? packageUid(pkg));
  setProcessName(processName ?? pkg);
  setManifest(manifest, activities, providers);
  setViewTargetSdk(usesSdk(manifest).target);
  prepared?.();

  return onMain(async () => {
    onStatus("Starting app…");
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
          if (!authority) continue;
          const info = await vcallOn(mainThread, getPM(), "resolveContentProvider", "(Ljava/lang/String;I)Landroid/content/pm/ProviderInfo;", authority, 128) as Parameters<typeof attachProvider>[1] | null;
          if (info) await attachProvider(application, info);
        } catch (e) { console.warn("[provider]", pn, (e as { msg?: string })?.msg ?? e); }
      }
      await vcallOn(mainThread, application, "onCreate", "()V");
    } catch (e) {
      reportUncaught(e);
    }

    booted = { host, mainActivityCls: mainActivity ?? "", stack: [], label };
    if (!processName && mainActivity) {
      onStatus("Opening app…");
      const intent = new JIntent();
      intent.action = "android.intent.action.MAIN";
      intent.categories.add("android.intent.category.LAUNCHER");
      intent.component = mainActivity.replaceAll("/", ".");
      intent.componentPkg = pkg;
      intent.flags = 0x10000000;
      await launchActivity(mainActivity, intent);
    }
    return booted;
  });
}

function launchActivity(cls: string, intent: JIntent | null, options?: ActivityLaunch): Promise<void> {
  // Startup and Java callbacks already hold the main queue; queuing again would deadlock.
  const run = async () => {
    const prev = curThread;
    setCurThread(mainThread);
    try { await launchActivity0(cls, intent, undefined, options); } finally { setCurThread(prev); }
  };
  return inMainJob() ? run() : onMain(run);
}
function launchActivity0(component: string, intent: JIntent | null, relaunch?: Relaunch, options?: ActivityLaunch): unknown { return rt.drive(launchActivity0$(component, intent, relaunch, options)); }
function* launchActivity0$(component: string, intent: JIntent | null, relaunch?: Relaunch, options?: ActivityLaunch): Gen {
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
      startWin = (yield startingWindow(host, cls));
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
    if (p) (yield p);
    act = new info.ctor();
  } catch (e) {
    reportUncaught(e);
    if (options?.remoteId) throw e;
    return;
  }
  act.$host = host;
  act.callingActivity = options?.caller ? mkComponentName(options.caller.pkg, options.caller.cls) : null;
  act.resultTo = options?.result ?? null;
  act.remoteId = options?.remoteId ?? 0;
  act.activityId = options?.activityId ?? 0; act.taskId = options?.taskId ?? 0;
  if (!act.activityId) {
    const previous = booted.stack.at(-1);
    activityTransport.attach?.(act, options?.taskId ?? (intent && intent.flags & 0x10000000 ? 0 : previous?.taskId ?? 0));
  }
  act.requestedOrientation = requestedOrientation;
  act.lastNonConfig = relaunch?.nonConfig ?? null;
  const saved = relaunch?.state ?? null;
  try {
    (yield vcall(act, "<init>", "()V"));
    // Activity.attach(): the base context arrives before the manifest theme, which AOSP applies
    // before onCreate so an app's own setTheme layers on top of it rather than replacing it
    const baseCtx = new JContext();
    baseCtx.$host = host;
    (yield vcall(act, "attachBaseContext", "(Landroid/content/Context;)V", baseCtx));
    const actTheme = manifestActivityTheme(cls);
    if (actTheme) vcall(act, "setTheme", "(I)V", actTheme);
    act.window.activity = act;
    getInflater(act).privateFactory = act;
    act.intent = intent;
    const prev = booted.stack.at(-1);
    if (prev?.resumed) { (yield pauseActivity(prev)); (yield windowFocus(prev, false)); }
    booted.stack.push(act);
    (yield safeCall(act, "onCreate", "(Landroid/os/Bundle;)V", saved));
    // onCreate may set the window theme before its first getDecorView/setContentView.
    (yield ensureDecor(act));
    (yield fireActivityLifecycle(act, "Created", saved));
    // Android dispatches onAttachedToWindow after onCreate, before onStart, even if a later
    // lifecycle callback throws.
    if (act.window.decor) (yield dispatchAttached(act.window.decor));
    (yield lifecycleStep(act, "onStart", "Started"));
    (yield safeCall(act, "onPostCreate", "(Landroid/os/Bundle;)V", saved));
    (yield lifecycleStep(act, "onResume", "Resumed"));
    (yield safeCall(act, "onPostResume"));
    (yield windowFocus(act, true));
    // AOSP stops the covered activity only once the new one is up
    if (!act.window.translucent) {
      for (const covered of booted.stack.slice(0, -1)) if (covered.started) (yield stopActivity(covered));
    }
    void buildOptionsMenu(act);
    invalidateWindow();
  } catch (e) {
    reportUncaught(e);
  }
}

const CONFIG_ORIENTATION_SIZE = 0x0080 | 0x0400;
function changeActivityOrientation(act: JActivity, request: number): void {
  if (!applyOrientationRequest(request)) return;
  invalidateWindow();
  requestLayoutAll();
  if (activityHandlesConfig(act, CONFIG_ORIENTATION_SIZE)) {
    void onMain(() => vcall(act, "onConfigurationChanged", "(Landroid/content/res/Configuration;)V", deviceConfiguration())).catch(reportUncaught);
  } else recreateActivity(act);
}

/** A night-mode change reaches the top activity as any configuration change does: through
 *  onConfigurationChanged if it declared uiMode, through a relaunch otherwise. */
function applyNightMode(night: boolean): void {
  if (!setDeviceNight(night) || !booted) return;
  requestLayoutAll();
  const act = booted.stack.at(-1);
  if (!act) return;
  if (activityHandlesConfig(act, CONFIG_UI_MODE)) {
    void onMain(async () => {
      await vcall(act, "onConfigurationChanged", "(Landroid/content/res/Configuration;)V", deviceConfiguration());
    }).catch(reportUncaught);
  } else recreateActivity(act);
}
function setApplicationNightMode(pkg: string, mode: number): void {
  const prefs = getPrefs(pkg, "__system_uimode");
  prefs.map.set("mode", mode);
  prefs.persist();
  applicationNightOverride = mode === 1 ? false : mode === 2 ? true : null;
  applyNightMode(applicationNightOverride ?? device.night);
}
globalThis.matchMedia?.("(prefers-color-scheme: dark)")
  .addEventListener("change", (e) => { if (applicationNightOverride === null) applyNightMode(e.matches); });

interface Relaunch { state: JBundle | null; nonConfig: unknown; requestedOrientation: number }

/** An undeclared configuration change relaunches the activity: AOSP saves the instance state and
 *  the non-configuration instance, tears it down, then starts a fresh one with both. */
function recreateActivity(act: JActivity): void {
  const cls = (act.constructor as any)?.$i?.name as string | undefined;
  if (!cls || !booted || booted.stack.indexOf(act) < 0) return;
  // AOSP's recreate() only schedules the relaunch; running it nested inside the caller's own
  // main-looper job (a click handler) would tear the activity down underneath it.
  setGuestTimeout(() => void onMain(async () => {
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
      await detachContextOverlays(act);
      booted.stack.splice(i, 1);
      const options = { caller: act.callingActivity, result: act.resultTo ?? undefined, remoteId: act.remoteId, activityId: act.activityId, taskId: act.taskId };
      act.remoteId = 0;
      await launchActivity0(cls, act.intent, { state, nonConfig, requestedOrientation: act.requestedOrientation }, options);
      requestLayoutAll();
    } catch (e) { reportUncaught(e); }
    finally { setCurThread(prev); }
  }), 0);
}

function safeCall(act: JActivity, method: string, desc = "()V", ...args: unknown[]): unknown { return rt.drive(safeCall$(act, method, desc, ...args)); }
function* safeCall$(act: JActivity, method: string, desc = "()V", ...args: unknown[]): Gen {
  try { (yield vcall(act, method, desc, ...args)); } catch (e) { reportUncaught(e); }
}
function lifecycleStep(act: JActivity, method: string, phase: Parameters<typeof fireActivityLifecycle>[1]): unknown { return rt.drive(lifecycleStep$(act, method, phase)); }
function* lifecycleStep$(act: JActivity, method: string, phase: Parameters<typeof fireActivityLifecycle>[1]): Gen {
  (yield safeCall(act, method));
  (yield fireActivityLifecycle(act, phase));
}
const pauseActivity = (act: JActivity) => lifecycleStep(act, "onPause", "Paused");
const stopActivity = (act: JActivity) => lifecycleStep(act, "onStop", "Stopped");
/** Returning to a covered activity: onRestart → onStart → onResume → onPostResume, with the
 *  ActivityLifecycleCallbacks a fresh launch fires. */
function resumeActivity(act: JActivity): unknown { return rt.drive(resumeActivity$(act)); }
function* resumeActivity$(act: JActivity): Gen {
  (yield startActivity(act));
  if (!act.resumed) (yield lifecycleStep(act, "onResume", "Resumed"));
  (yield safeCall(act, "onPostResume"));
}
function startActivity(act: JActivity): unknown { return rt.drive(startActivity$(act)); }
function* startActivity$(act: JActivity): Gen {
  if (!act.started) {
    (yield safeCall(act, "onRestart"));
    (yield lifecycleStep(act, "onStart", "Started"));
  }
}
function resumeTop(top: JActivity): unknown { return rt.drive(resumeTop$(top)); }
function* resumeTop$(top: JActivity): Gen {
  applyOrientationRequest(top.requestedOrientation);
  for (const act of visibleActivities()) if (act !== top) (yield startActivity(act));
  (yield resumeActivity(top));
  (yield windowFocus(top, true));
  void buildOptionsMenu(top);
}
/** ViewRootImpl reports window focus once the resumed activity's window is up and takes it
 *  away when another window covers it; only a change is delivered. */
function windowFocus(act: JActivity, has: boolean): unknown { return rt.drive(windowFocus$(act, has)); }
function* windowFocus$(act: JActivity, has: boolean): Gen {
  if (act.hasWindowFocus === has) return;
  act.hasWindowFocus = has;
  const z = has ? 1 : 0;
  try {
    (yield vcall(act, "onWindowFocusChanged", "(Z)V", z));
    if (act.window.decor) (yield vcall(act.window.decor, "dispatchWindowFocusChanged", "(Z)V", z));
  } catch (e) { reportUncaught(e); }
}

function finishActivity(act: JActivity, resume = true): unknown { return rt.drive(finishActivity$(act, resume)); }
function* finishActivity$(act: JActivity, resume = true): Gen {
  if (!booted) return;
  const i = booted.stack.indexOf(act);
  if (i < 0) return;
  booted.stack.splice(i, 1);
  act.finished = true;
  if (act.resumed) (yield pauseActivity(act));
  (yield windowFocus(act, false));
  const remote = activityTransport.finish?.(act) ?? false;
  const top = booted.stack.at(-1);
  if (top && !top.finished && !remote && resume) (yield resumeTop(top));
  // AOSP hands the result to the launcher once it is back up, before the finished instance dies.
  if (act.resultTo) deliverActivityResult(act.resultTo.act, act.resultTo.code, act.resultCode, act.resultData);
  if (act.window.decor) (yield dispatchDetached(act.window.decor));
  if (act.started) (yield stopActivity(act));
  (yield lifecycleStep(act, "onDestroy", "Destroyed"));
  (yield detachContextOverlays(act));
  invalidateWindow();
}

export function finishTask(taskId: number, resume: boolean): Promise<void> {
  return onMain(async () => {
    const activities = booted?.stack.filter(a => a.taskId === taskId) ?? [];
    for (const act of activities) { act.finished = true; act.remoteId = 0; }
    for (const act of activities.reverse()) await finishActivity(act, false);
    const top = booted?.stack.at(-1);
    if (resume && top) await resumeTop(top);
  });
}

export function activityVisibility(phase: "pause" | "stop" | "resume" | "visible"): Promise<void> {
  return onMain(async () => {
    const act = booted?.host.currentActivity();
    if (!act) return;
    if (phase === "pause") {
      if (act.resumed) await pauseActivity(act);
      await windowFocus(act, false);
    } else if (phase === "stop") {
      for (const covered of booted!.stack) if (covered.started) await stopActivity(covered);
    } else {
      for (const visible of visibleActivities()) await startActivity(visible);
      if (phase === "resume") {
        await resumeActivity(act);
        await windowFocus(act, true);
      }
      uiState.needsLayout = uiState.needsDraw = true;
    }
  });
}

function buildOptionsMenu(act: JActivity): unknown { return rt.drive(buildOptionsMenu$(act)); }
function* buildOptionsMenu$(act: JActivity): Gen {
  if (!act.window.actionBarView) return;
  const menu = new JMenu();
  menu.bar = act.window.actionBarView;
  act.optionsMenu = menu;
  try {
    (yield vcall(act, "onCreatePanelMenu", "(ILandroid/view/Menu;)Z", 0, menu));
    (yield vcall(act, "onPreparePanel", "(ILandroid/view/View;Landroid/view/Menu;)Z", 0, null, menu));
  } catch (e) { reportUncaught(e); }
  pushMenuToBar(menu);
}

// A key is input like a touch: it runs as a main-looper job, so androidx's main-thread asserts
// (handleLifecycleEvent inside the finish path) see the main thread, not whichever worker
// last set curThread.
export function pressBack(): Promise<void> {
  return onMain(pressBack0);
}
function pressBack0(): void | Promise<void> { return rt.drive(pressBack0$()); }
function* pressBack0$(): Gen<void> {
  // the topmost window takes the key: a dialog or popup before the activity under it
  let top;
  for (let i = overlays.length - 1; i >= 0; i--) {
    if (overlays[i].view.visibility === 0) { top = overlays[i]; break; }
  }
  const act = booted?.stack.at(-1);
  try {
    if (top?.onBack) (yield top.onBack());
    else if (top?.dismissOnOutside) (yield dismissOverlay(top));
    else if (act) (yield vcall(act, "onBackPressed", "()V"));
  } catch (e) { reportUncaught(e); }
}

const M_doFrame = mangleMethod("doFrame", "(J)V");
const M_dispatch = mangleMethod("dispatchTouchEvent", "(Landroid/view/MotionEvent;)Z");
let drawing = false;
/** AOSP's starting window: the system's, painted from the package's theme before the app has
 *  run. It is not the app drawing, so it deliberately does not count in perf.draws — corpus
 *  reads that to mean "this apk got far enough to render", and it must keep meaning it. */
let startWin: { view: JView; fullscreen: boolean } | null = null;
function drawStartWin(w: { view: JView; fullscreen: boolean }): unknown { return rt.drive(drawStartWin$(w)); }
function* drawStartWin$(w: { view: JView; fullscreen: boolean }): Gen {
  const contentY = w.fullscreen ? 0 : STATUS_H, ctx = frame;
  ctx.save();
  try {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    ctx.translate(0, contentY);
    (yield drawView(w.view, JCanvas.wrap(ctx, SCREEN_W, SCREEN_H - contentY)));
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
}

export async function tick() {
  if (drawing) return;
  drawing = true;
  // AOSP clears mIsInTraversal in a finally: a rejected frame must not latch the guard on
  // and stop every later frame.
  try { await onMain(tick0); } finally { drawing = false; }
}
function tick0(): unknown { return rt.drive(tick0$()); }
function* tick0$(): Gen {
  const ctx = frame;
  try {
    // choreographer + animation callbacks. One timestamp for the whole frame, as AOSP's
    // doFrame does: every callback here awaits, so recomputing it per callback let two
    // callbacks in the SAME frame see times hundreds of ms apart during boot.
    uiState.frameTimeNanos = BigInt(Math.floor(guestNow() * 1e6));
    const presentation = uiState.frameTimeNanos + uiState.frameIntervalNanos;
    const cbs = uiState.frameCallbacks.length ? uiState.frameCallbacks.splice(0) : [];
    for (const cb of cbs as { frame?: any; run?: any; vsync?: JObj }[]) {
      mainDbg.phase = "frame:" + ((cb.frame ?? cb.run ?? cb.vsync)?.constructor?.$i?.name ?? "?");
      try {
        if (cb.frame) (yield guardCall(cb.frame, M_doFrame, uiState.frameTimeNanos));
        else if (cb.vsync) (yield dispatchVsync(cb.vsync, presentation));
        else if (cb.run) (yield vcall(cb.run, "run", "()V"));
      } catch (e) { reportUncaught(e); }
    }

    mainDbg.phase = "anim";
    if (uiState.animHooks.size) {
      for (const hook of [...uiState.animHooks]) if (!hook()) uiState.animHooks.delete(hook);
    }
    const activities = visibleActivities();
    const act = activities.at(-1);
    const decor = act?.window.decor;
    if (!decor) {
      if (startWin && uiState.needsDraw) {
        uiState.needsDraw = false;
        (yield drawStartWin(startWin));
      }
      return;
    }
    startWin = null;
    // Dispatch before measure so decor margins and descendant inset padding affect this pass.
    // Clear first: a listener's requestApplyInsets() belongs to the next traversal.
    const insetsChanged = uiState.needsInsets;
    if (insetsChanged) {
      uiState.needsInsets = false;
      perf.insetsPasses++;
      mainDbg.phase = "insets";
      try {
        for (const activity of activities) if (activity.window.decor) (yield dispatchWindowInsets(activity.window.decor));
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
          (yield measureView(root, makeSpec(SCREEN_W, MS_EXACTLY), makeSpec(SCREEN_H, MS_EXACTLY)));
          mainDbg.phase = "layout";
          (yield layoutRoot(root, 0, 0, SCREEN_W, SCREEN_H));
        }
        mainDbg.phase = "overlays";
        for (const o of overlays) {
          const win = o.view.windowOwner, floating = !!win?.dialog;
          const visible = win?.fitInsetsIgnoringVisibility ? ~0 : rootWindowInsets(o.view).vis;
          const top = floating && (win.fitInsetsSides & 2) && (win.fitInsetsTypes & visible & 1) ? STATUS_H : 0;
          const bottom = floating && (win.fitInsetsSides & 8) && (win.fitInsetsTypes & visible & 2) ? device.navBar : 0;
          (yield measureView(o.view, makeSpec(SCREEN_W, 0x80000000 | 0), makeSpec(SCREEN_H - top - bottom, 0x80000000 | 0)));
          if (floating) {
            const gravity = win!.gravity;
            o.x = (gravity & 7) === 3 ? 0 : (gravity & 7) === 5 ? SCREEN_W - o.view.measuredW : (SCREEN_W - o.view.measuredW) >> 1;
            o.y = (gravity & 0x70) === 0x30 ? top : (gravity & 0x70) === 0x50 ? SCREEN_H - bottom - o.view.measuredH : top + ((SCREEN_H - top - bottom - o.view.measuredH) >> 1);
          }
          // AOSP lays a window out inside the screen: a dropdown anchored near the right edge
          // shifts left instead of hanging off it. The popup's own placement pass runs before
          // its content has a measured width, so this is the pass that has the real numbers —
          // and the position is written back, since hit-testing reads it too.
          o.x = Math.max(0, Math.min(o.x, SCREEN_W - o.view.measuredW));
          o.y = Math.max(0, Math.min(o.y, SCREEN_H - o.view.measuredH));
          const right = o.x + o.view.measuredW, bottomEdge = o.y + o.view.measuredH;
          const frameChanged = o.view.left !== o.x || o.view.top !== o.y || o.view.right !== right || o.view.bottom !== bottomEdge;
          (yield layoutRoot(o.view, o.x, o.y, right, bottomEdge));
          // Floating windows need their final frame to calculate window-local bar insets.
          if (insetsChanged || frameChanged) (yield dispatchWindowInsets(o.view));
        }
        mainDbg.phase = "globalLayout";
        for (const activity of activities) if (activity.window.decor) (yield fireGlobalLayout(activity.window.decor));
      } catch (e) {
        // A subtree that cannot measure costs a frame, not the session: fall through and draw
        // whatever DID lay out. Re-arming needsLayout here would turn a deterministic throw
        // into a 60fps exception storm; the next real requestLayout() recovers.
        perf.layoutErrors++;
        console.error("[layout]", e instanceof JThrowable ? (yield stackTraceText(e)) : e);
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
        const cv = JCanvas.wrap(ctx, SCREEN_W, SCREEN_H);
        // AOSP's performDraw() dispatches OnPreDrawListener/OnDrawListener right before the
        // tree draw, on every draw pass -- not only ones that also ran a layout.
        try {
          const bars = resolveSystemBars(decor, overlays);
          for (const activity of activities) {
            const root = activity.window.decor;
            if (!root) continue;
            mainDbg.phase = "preDraw";
            (yield fireDrawPass(root));
            mainDbg.phase = "draw";
            (yield drawView(root, cv));
            if (root === bars.root) drawSystemBarBackgrounds(ctx, bars);
          }
          mainDbg.phase = "drawOverlays";
          for (const o of overlays) {
            if (o.view.visibility !== 0) continue;
            const dim = o.dim?.() ?? 0;
            if (dim > 0) { ctx.fillStyle = `rgba(0,0,0,${dim})`; ctx.fillRect(0, 0, SCREEN_W, SCREEN_H); }
            (yield drawView(o.view, cv));
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
        try { (yield dispatchSplashExit(activity)); } catch (error) { reportUncaught(error); }
      }
      perf.drawMs += performance.now() - t0;
      // WebView frames are DOM over the canvas: show the ones this pass drew, hide the rest
      webLayerSweep(overlays.some(o => o.view.visibility === 0));
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
  clearMeasureCache(v);
  if (v instanceof JViewGroup) for (const c of v.children) forceLayoutFlags(c);
}

let touchTarget: "decor" | { overlay: number } | null = null;
let downTime = 0;
// input joins the main queue: keeps DOWN/UP ordered and serialized with layout,
// Handler posts, and lifecycle — like Android's single main looper.
export function dispatchPointer(action: number, x: number, y: number, at = guestNow()): Promise<void> {
  // charged to perf.inputMs: the wall time a tap costs is otherwise in no counter at all.
  const t0 = performance.now();
  requestResponsiveSlices();
  return onMain(() => dispatchPointer0(action, x, y, at)).finally(() => { perf.inputMs += performance.now() - t0; });
}
function dispatchPointer0(action: number, x: number, y: number, t: number): void | Promise<void> { return rt.drive(dispatchPointer0$(action, x, y, t)); }
function* dispatchPointer0$(action: number, x: number, y: number, t: number): Gen<void> {
  const window = booted?.stack.at(-1)?.window, decor = window?.decor;
  if (!decor) return;
  const ev = new JMotionEvent();
  ev.action = action;
  ev.rawX = x;
  ev.rawY = y;
  // SystemClock.uptimeMillis's clock, stamped when the event was generated rather than when the
  // queue reached it, so a fling's velocity does not depend on how loaded the host is.
  ev.eventTime = t;
  if (action === 0) downTime = ev.eventTime;
  ev.downTime = downTime;
  try {
    if (action === 0) {
      for (let i = overlays.length - 1; i >= 0; i--) {
        const o = overlays[i];
        const v = o.view;
        if (v.visibility !== 0) continue;
        if (x >= v.left && x < v.right && y >= v.top && y < v.bottom) {
          touchTarget = { overlay: i };
          break;
        }
        if (o.dismissOnOutside) {
          (yield dismissOverlay(o));
          touchTarget = null;
          return;
        }
        if (o.modal) { touchTarget = { overlay: i }; break; }
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
      if (o?.view.visibility === 0) {
        ev.x = x - o.view.left;
        ev.y = y - o.view.top;
        (yield guardCall(o.view, M_dispatch, ev));
      }
    } else {
      ev.x = x;
      ev.y = y;
      (yield guardCall(window.callbackObj ?? window.activity, M_dispatch, ev));
    }
    if (action === 1 || action === 3) touchTarget = null;
  } catch (e) {
    reportUncaught(e);
  }
}
