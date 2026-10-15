// Device shell: APK boot, display and configuration, input. AOSP's ActivityThread runs the app over
// the hosted system services; SurfaceFlinger (surfaceflinger.ts) composes the display.

import { dexesIn, dexEntryNames, isDexEntry } from "../jvm/dex";
import { rt } from "../jvm/runtime";
import { appLaunched, loadAppCode, loadDex, tierReady, warmCode } from "../jvm/tier";
import { vfs, apkPath } from "./vfs";
import { inflateTree } from "../jvm/natives/jzip";
import type { Install } from "./install";
import { fixProcessBitness, processBitness, setTargetSdkVersion } from "../jvm/natives/jvmruntime";
import { Arsc } from "../android/arsc";
import { loadFramework, loadPlatformDex } from "../android/framework";
import { zygoteInit } from "../android/delegates";
import { deviceNightMode } from "../android/settings";
import { qualify as componentClass } from "../jvm/roots";
import { parseAXML, attr, attrStr, type XmlNode } from "../android/axml";
import { Resources, nativeRes } from "../android/res";
import { setDeviceNight, syncDeviceOrientation, deviceConfiguration, applyApplicationLocales, localesFromTags, initDeviceLocales, type Locales } from "../android/resnative";
import { setAppHost } from "../android/apphost";
import { loadResources, javaConfiguration, applyDeviceConfiguration } from "../android/resources";
import { registerApk, registerSplit } from "../android/assetmanager";
import { setManifest } from "../android/pm";
import { getPrefs, createAppData } from "../android/sharedprefs";
import { filePathTransport } from "./file-path";
import { PROCESS_PID, setProcessIdentity, setProcessName } from "../android/os";
import { packageUid, packages, usesSdk } from "../android/packages";
import { onMain, postMain } from "../android/mainloop";
import { after, mainThread } from "../jvm/natives/jentry";
import { deliverVsync } from "../android/vsync";
import { mark, perf } from "../perf";
import { uptimeMillis } from "../guest-clock";
import { device, orientationForRequest, setDeviceOrientation } from "./config";
import { restoreRoots } from "./hostfs";
import { notePresent } from "../native/cpu";
import { noteInput } from "../jvm/yield";
import { appArchives } from "../jvm/natives/jdex";
import { hostWindowManager, dispatchTouch, dispatchKey } from "../android/server/wm";
import { startActivityThread } from "../android/server/am";
import { configurationChanged, displayHooks, topOrientation } from "../android/server/atm";
import { setDisplayTarget, scheduleComposite } from "../android/surfaceflinger";
import { toThread } from "../jvm/natives/jthrowable";
import { note, Ev } from "../timeline";

export let SCREEN_W = device.width, SCREEN_H = device.height;
let displayChanged = () => {};
export function setDisplayChangeHandler(handler: () => void): void { displayChanged = handler; }
// Frames are composed off screen and presented whole. A task boundary inside a draw (a bytecode
// yield, an image decode) would otherwise let the browser composite the half-painted canvas.
// The bitmap transfer is a zero-copy swap; a drawImage blit cost a software rasteriser ~10 ms
// a frame. Read the screen back with toBlob: toDataURL on a transferred bitmap stalls.
let fb = new OffscreenCanvas(SCREEN_W, SCREEN_H);
let frame = fb.getContext("2d")!;
type ScreenSink = (bitmap: ImageBitmap) => void;
let screen: ScreenSink | null = null;
export function setScreenSink(sink: ScreenSink): void { screen = sink; }
export function setScreenCanvas(c: HTMLCanvasElement): void {
  const context = c.getContext("bitmaprenderer");
  screen = context ? bitmap => { context.transferFromImageBitmap(bitmap); globalThis.__wdPresented?.(c, null, performance.now()); } : null;
}
/** System windows compose over app process canvases rather than an opaque app background. */
export function setSystemDisplayTarget(): void { setDisplayTarget(frame, present, true); }
function present(): void {
  if (!screen) return;
  screen(fb.transferToImageBitmap());
  if (!perf.presentations++) { mark("firstPresented"); appLaunched(); }
  notePresent();
}

/** Apply one of ActivityInfo's fixed orientations; all other requests retain the current axes. */
function applyOrientationRequest(request: number): boolean {
  const orientation = orientationForRequest(request);
  if (!orientation || !setDeviceOrientation(orientation)) return false;
  SCREEN_W = device.width;
  SCREEN_H = device.height;
  fb = new OffscreenCanvas(SCREEN_W, SCREEN_H);
  frame = fb.getContext("2d")!;
  setDisplayTarget(frame, present);
  syncDeviceOrientation();
  displayChanged();
  return true;
}

const qualify = (pkg: string, name: string) => name.startsWith(".") ? pkg + name : name;
const isLauncher = (node: XmlNode) => node.children.some((filter) =>
  filter.name === "intent-filter" && filter.children.some((x) => x.name === "category" && attrStr(x, "name") === "android.intent.category.LAUNCHER"));

/** The launch component's orientation, resolving an alias to its target Activity when needed. */
function launcherOrientation(app: XmlNode | undefined, launcher: XmlNode, pkg: string): number {
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
let zygote: Promise<void> | null = null, booting = false;
/** What a device's zygote holds before it forks an app: the framework package and the boot class
 *  path indexed. It needs no app, so a page starts it while the app downloads. `host` settles host properties Java reads from zygoteInit on, such as the display rate. */
export function startZygote(host?: Promise<unknown>, warmed?: () => void): Promise<void> {
  return zygote ??= (async () => {
    await Promise.all([loadFramework(), loadPlatformDex()]);
    // the platform code launches use is compiled while the zygote waits, once per tab: a package arriving
    // stops it, and the spare that replaces a Worker taken early (processes.ts launch) goes through it
    if (warmed) {
      await tierReady();
      if (await warmCode(() => booting)) warmed();
    }
    // the runtime's own setup and the system font map need no app, but its bitness does (os.arch,
    // Build.CPU_ABI): a device has a zygote of each, and the app's ABI picks the one that forks it
    await Promise.all([processBitness, host, tierReady()]);
    await zygoteInit();
  })();
}

/** boots the app, resolving to its label */
export async function bootApk(install: Install, onStatus: (s: string) => void, assetKey = "", processName: string | null = null): Promise<string> {
  // The framework package must be in place before anything links, and restored storage roots
  // must resolve before the app reads a persisted tree URI: it caches the answer for the session.
  mark("bootApk"); onStatus("Reading package…"); booting = true;
  const zip = install.zip;
  const manifest = parseAXML(zip["AndroidManifest.xml"]);
  const pkg = attrStr(manifest, "package") ?? "app";
  const appNode = manifest.children.find((c) => c.name === "application");
  const launcher = appNode?.children.find((node) => (node.name === "activity" || node.name === "activity-alias") && isLauncher(node));
  if (!launcher && !processName) throw new Error("no launcher activity found");
  // the Application, then the launcher Activity a launch instantiates first
  const launch = [appNode && attrStr(appNode, "name"), !processName && launcher && (attrStr(launcher, "targetActivity") ?? attrStr(launcher, "name"))]
    .flatMap((name) => name ? [componentClass(pkg, name)] : []);
  // The app's dex goes in after the boot class path, which loadDex's first-wins keeps ahead: an
  // app's copy of a platform class is never loaded, as PathClassLoader asks its parent first.
  fixProcessBitness([...Object.keys(zip), ...rt.classpathSource?.names() ?? []]);
  // The World is the zygote's, and the app code a previous launch saved continues what the zygote numbered (host/appcode.ts): the app's dex files and its code
  // join the World once the zygote has run, before any of the app's Java
  await startZygote();
  await inflateTree(zip, isDexEntry);
  for (const name of dexEntryNames(Object.keys(zip))) for (const d of dexesIn(zip[name], name)) loadDex(d);
  mark("dexLoaded");
  await loadAppCode({ profile: zip["assets/dexopt/baseline.prof"], manifest: zip["AndroidManifest.xml"], launch });
  applicationNightOverride = nightOverride(await getPrefs(pkg, "__system_uimode").get("mode"));
  setDeviceNight(applicationNightOverride ?? device.night);
  await deviceNightMode(device.night);
  // Orientation precedes resource construction: both app and framework tables must select the
  // same -land/-port entries the Activity will see through Configuration.
  applyOrientationRequest(launcher ? launcherOrientation(appNode, launcher, pkg) : -1);
  await restoreRoots();
  rt.classpath = zip;
  // sourceDir is the base apk, not the container it arrived in: a library that re-extracts its
  // own .so with ZipFile(ApplicationInfo.sourceDir) has to find lib/, not a list of apks.
  if (install.base instanceof Uint8Array) vfs.write(apkPath(), install.base);
  else vfs.mount(apkPath(), install.base);
  for (const sp of install.splits) {
    if (sp.bytes) vfs.write(apkPath(sp.name), sp.bytes);
    else vfs.mount(apkPath(sp.name), sp.source);
  }
  mark("startZygote"); onStatus("Loading app code…");
  // the archives LoadedApk's class loader reads
  appArchives.add(apkPath()); appArchives.add(packages.get(pkg)?.path ?? apkPath());
  await onMain(initDeviceLocales);
  await vfs.prepare(pkg);
  // a Worker's files live with the broker, whose prepare created its app data
  if (!filePathTransport.calls) await createAppData(pkg);
  const labelAttr = appNode?.attrs.find((a) => a.name === "label");

  mark("dataReady"); onStatus("Loading resources…");
  const arsc = new Arsc(zip["resources.arsc"], (p) => zip[p] ?? null);
  for (const sp of install.splits) if (sp.resources) arsc.add(sp.resources);
  registerApk(apkPath(), new Resources(arsc, zip, install.lazyEntries));
  for (const sp of install.splits) registerSplit(apkPath(sp.name));
  const { target } = usesSdk(manifest);
  const jres = await onMain(() => after(javaConfiguration(deviceConfiguration()), (config) => loadResources(apkPath(), config)));
  // ActivityThread.handleBindApplication: the system Resources take the device configuration and
  // display metrics too (Resources.getSystem() starts from setToDefaults: a 0x0 display)
  await onMain(applyDeviceConfiguration);
  const res = nativeRes(jres);
  const label = !labelAttr ? pkg : labelAttr.str || (res.value(labelAttr.data).s ?? pkg);

  setAppHost({
    res, pkg, assetKey, zip,
    splits: install.splits.map((sp) => sp.name),
    setApplicationNightMode: (mode) => setApplicationNightMode(pkg, mode),
    setApplicationLocales: (locales) => setApplicationLocales(pkg, locales),
  });
  const savedLocales = await getPrefs(pkg, "__system_locales").get("tags");
  if (typeof savedLocales === "string" && savedLocales) await onMain(() => after(localesFromTags(savedLocales), applyApplicationLocales));
  setProcessIdentity(PROCESS_PID, packages.get(pkg)?.uid ?? packageUid(pkg));
  setProcessName(processName ?? pkg);
  setManifest(manifest);
  setTargetSdkVersion(target);

  hostWindowManager();
  setDisplayTarget(frame, present);
  displayHooks.requestOrientation = applyOrientationRequest;
  mark("resourcesReady"); onStatus("Starting app…");
  await onMain(() => startActivityThread(!processName));
  return label;
}

const turnDisplay = async (landscape: boolean) => { if (applyOrientationRequest(landscape ? 0 : 1)) await configurationChanged(); };
/** the page's own orientation, which the user's rotations set: the display leaves it to follow
 *  another process's activity and returns to it when the page's own fills the display again */
let ownLandscape = device.orientation === 2;
/** A physical rotation, in the process whose activity fills the display (ActivityStack.rotate). An
 *  activity that fixed or locked its orientation keeps it, as the window manager keeps the display
 *  in that orientation for it. */
export function rotateDevice(landscape: boolean): Promise<void> {
  return onMain(async () => {
    const request = topOrientation();
    if (orientationForRequest(request) !== null || request === 5 || request === 14) return;
    ownLandscape = landscape;
    await turnDisplay(landscape);
  });
}
/** the display turns for the process whose activity sets its orientation: to a Worker's display,
 *  or back to the page's own */
export const followDisplay = (landscape?: boolean): Promise<void> => onMain(() => turnDisplay(landscape ?? ownLandscape));
function applyConfigChange(): void { postMain(configurationChanged); }
function applyNightMode(night: boolean): void {
  if (setDeviceNight(night)) applyConfigChange();
}
function setApplicationLocales(pkg: string, locales: Locales): void | Promise<void> {
  return after(getPrefs(pkg, "__system_locales").set("tags", locales.tags.join(",")), () => {
    if (applyApplicationLocales(locales)) applyConfigChange();
  });
}
function setApplicationNightMode(pkg: string, mode: number): void | Promise<void> {
  return after(getPrefs(pkg, "__system_uimode").set("mode", mode), () => {
    applicationNightOverride = nightOverride(mode);
    applyNightMode(applicationNightOverride ?? device.night);
  });
}
globalThis.matchMedia?.("(prefers-color-scheme: dark)")
  .addEventListener("change", (e) => {
    Promise.resolve(deviceNightMode(e.matches)).then(() => {
      if (applicationNightOverride === null) applyNightMode(e.matches);
    }).catch(toThread());
  });

const KEYCODE_BACK = 4;
export function pressBack(): Promise<void> {
  noteInput();
  return dispatchKey(KEYCODE_BACK);
}

/** one frame now, on a vsync outside the display's pacing: a harness stepping a controlled clock.
 *  The display presents after it whether or not a window drew. */
export async function testFrame(): Promise<void> {
  // the vsync's dispatch, then the Choreographer frame it posts, run on the main looper first
  deliverVsync();
  await onMain(() => {});
  await onMain(() => {});
  redraw();
}
/** present the screen again, for a harness sampling it */
export function redraw(): void { scheduleComposite(); }

let touchDown = 0n;
/** a pointer event to the window under it, as InputDispatcher delivers it; charged to
 *  perf.inputMs, since the wall time a tap costs is otherwise in no counter at all */
export function dispatchPointer(action: number, x: number, y: number, eventTime = uptimeMillis()): Promise<void> {
  const t0 = performance.now();
  noteInput(); note(Ev.InputIn, action);
  const now = BigInt(Math.floor(eventTime));
  if (action === 0) touchDown = now;
  return dispatchTouch(action, x, y, touchDown, now).then(() => {}, toThread(mainThread)).finally(() => { perf.inputMs += performance.now() - t0; });
}
