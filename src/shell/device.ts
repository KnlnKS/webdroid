// Device shell: APK boot, display and configuration, input. AOSP's ActivityThread runs the app over
// the hosted system services; SurfaceFlinger (surfaceflinger.ts) composes the display.

import { dexesOfZip, isDexEntry } from "../jvm/dex.ts";
import { rt, type Gen } from "../jvm/runtime.ts";
import { appLaunched, beginAppCode, loadAppCode, loadDex, tierReady } from "../jvm/tier.ts";
import { vfs, apkPath } from "./vfs.ts";
import { inflateTree } from "../zip.ts";
import type { Install } from "./install.ts";
import { fixProcessBitness, processBitness, setTargetSdkVersion } from "../jvm/natives/jvmruntime.ts";
import { Arsc } from "../android/arsc.ts";
import { loadFramework, mountPlatformJars } from "../android/framework.ts";
import { deviceNightMode } from "../android/settings.ts";
import { qualify as componentClass } from "../jvm/roots.ts";
import { parseAXML, attr, attrStr, type XmlNode } from "../android/axml.ts";
import { Resources, nativeRes } from "../android/res.ts";
import { setDeviceNight, syncDeviceOrientation, deviceConfiguration, applyApplicationLocales, localesFromTags, initDeviceLocales, type Locales } from "../android/resnative.ts";
import { appHost, setAppHost } from "../android/apphost.ts";
import { loadResources, javaConfiguration, applyDeviceConfiguration } from "../android/resources.ts";
import { registerApk, registerSplit } from "../android/assetmanager.ts";
import { setManifest } from "../android/pm.ts";
import { getPrefs } from "../android/sharedprefs.ts";
import { PROCESS_PID, asZygote, setProcessIdentity, setProcessName } from "../android/os.ts";
import { packageUid, packages, usesSdk } from "../android/packages.ts";
import { onMain, postMain, startMainLooper } from "../android/mainloop.ts";
import { preloadFonts } from "../android/fonts.ts";
import { preloadPaint } from "../android/paint.ts";
import { readAheadFonts } from "../android/cssfonts.ts";
import { after, callOn, initClass, mainThread, scall } from "../jvm/natives/jentry.ts";
import { deliverVsync } from "../android/vsync.ts";
import { mark, perf } from "../perf.ts";
import { uptimeMillis } from "../guest-clock.ts";
import { device, naturalLandscape, rotationForRequest, setDeviceOrientation, type Rotation } from "./config.ts";
import { restoreRoots } from "./hostfs.ts";
import { notePresent } from "../native/cpu.ts";
import { noteInput } from "../jvm/yield.ts";
import { appArchives } from "./packedarchive.ts";
import { hostWindowManager, dispatchTouch, dispatchKey } from "../android/server/wm.ts";
import { startActivityThread } from "../android/server/am.ts";
import { configurationChanged, displayHooks, orientationRequest } from "../android/server/atm.ts";
import { setDisplayTarget, scheduleComposite } from "../android/surfaceflinger.ts";
import { toThread } from "../jvm/natives/jthrowable.ts";
import { note, Ev } from "../timeline.ts";
import type { TouchPointer } from "./pointer-queue.ts";

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
let launched = false;
/** the first frame presents window colors; the launch ends with the first that composes the app's content */
function present(content: boolean): void {
  if (!screen) return;
  screen(fb.transferToImageBitmap());
  if (!perf.presentations++) { mark("firstPresented"); readAheadFonts(); }
  if (content && !launched) { launched = true; appLaunched(); }
  notePresent();
}

/** This process's rotation state: the page's start as its screen is configured, and a Worker's
 *  come with its bootstrap and with each rotation (ActivityStack.rotate). */
const rotation: Rotation = { sensor: naturalLandscape, natural: naturalLandscape };
export function setRotation(state: Rotation): void { Object.assign(rotation, state); }
/** The display turns for the request of the activity that sets its orientation (orientationRequest),
 *  answering whether its geometry changed. */
function applyOrientationRequest(request: number | null): boolean {
  const landscape = rotationForRequest(request, rotation);
  return landscape !== null && turnTo(landscape);
}
/** the display's axes turn to landscape or portrait, answering whether its geometry changed */
function turnTo(landscape: boolean): boolean {
  if (!setDeviceOrientation(landscape ? 2 : 1)) return false;
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
/** What the zygote sets up in a forked process before app code runs: libcore's MIME table is
 *  framework.jar's, System.out and System.err reach logcat, RuntimeInit.commonInit's uncaught
 *  exception handlers (LoggingHandler, KillApplicationHandler), time zone, logging, HTTP user
 *  agent and socket tagger are set, the JCA providers are installed and warmed, Typeface is
 *  initialized and the hyphenators registered; the device's languages are set and the text paint
 *  classes, whose constructors read them, initialized. The font map is bindApplication's. */
const zygoteInit = (): Promise<void> => (async () => callOn(mainThread, () => rt.drive(function* (): Gen<void> {
  // System.<clinit> reads user.name from the passwd entry of the zygote, which runs as root
  yield asZygote(() => initClass("java/lang/System"));
  // ZygoteInit.main: DDMS handlers and libcore's MimeMap over framework.jar's mime.types
  yield scall("com/android/internal/os/RuntimeInit", "preForkInit", "()V");
  yield scall("com/android/internal/os/RuntimeInit", "redirectLogStreams", "()V");
  // ZygoteInit.zygoteInit, in the forked process
  yield scall("com/android/internal/os/RuntimeInit", "commonInit", "()V");
  // ZygoteInit.preload: AndroidKeyStoreProvider installed, every provider's services resolved
  yield scall("com/android/internal/os/ZygoteInit", "warmUpJcaProviders", "()V");
  yield* preloadFonts();
  yield scall("com/android/internal/os/ZygoteInit", "preloadTextResources", "()V");
  yield initDeviceLocales();
  yield preloadPaint();
  // ActivityThread.main, once the process is forked
  yield startMainLooper();
}())))();
let zygote: Promise<void> | null = null;
/** What a device's zygote holds before it forks an app: the framework package and the boot class
 *  path indexed. It needs no app, so a page starts it while the app downloads. `host` settles host properties Java reads from zygoteInit on, such as the display rate. */
export function startZygote(host?: Promise<unknown>): Promise<void> {
  return zygote ??= (async () => {
    await Promise.all([loadFramework(), mountPlatformJars()]);
    // the runtime's own setup and the system font map need no app, but its bitness does (os.arch,
    // Build.CPU_ABI): a device has a zygote of each, and the app's ABI picks the one that forks it
    await Promise.all([processBitness, host, tierReady()]);
    await zygoteInit();
  })();
}

/** boots the app */
export async function bootApk(install: Install, onStatus: (s: string) => void, assetKey = "", processName: string | null = null): Promise<void> {
  // The framework package must be in place before anything links, and restored storage roots
  // must resolve before the app reads a persisted tree URI: it caches the answer for the session.
  mark("bootApk"); onStatus("Reading package…");
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
  // the dexes inflate, and the app's code is prepared from them, while the zygote runs
  const dexes = inflateTree(zip, isDexEntry).then(() => {
    const read = dexesOfZip(zip);
    beginAppCode(read, { profile: zip["assets/dexopt/baseline.prof"], manifest: zip["AndroidManifest.xml"], launch }, !processName, onStatus);
    return read;
  });
  await startZygote();
  for (const d of await dexes) loadDex(d);
  mark("dexLoaded");
  await loadAppCode();
  applicationNightOverride = nightOverride(await getPrefs(pkg, "__system_uimode").get("mode"));
  setDeviceNight(applicationNightOverride ?? device.night);
  await deviceNightMode(device.night);
  // Orientation precedes resource construction: both app and framework tables must select the
  // same -land/-port entries the Activity will see through Configuration. Another process of the
  // package keeps the display it started with until the activity started in it sets one.
  if (!processName && launcher) applyOrientationRequest(launcherOrientation(appNode, launcher, pkg));
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
  // a process's files live with the broker, whose prepare creates its app data
  await vfs.prepare(pkg);

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
  useDisplayRotation();
  mark("resourcesReady"); onStatus("Starting app…");
  await onMain(() => startActivityThread(!processName));
}

/** this process's activities turn the display as they launch, resume and ask for an orientation */
export function useDisplayRotation(): void { displayHooks.requestOrientation = applyOrientationRequest; }
const turnDisplay = async (landscape: boolean) => { if (turnTo(landscape)) await configurationChanged(); };
/** The sensor's rotation, which every process records (ActivityStack.rotate). The activity here
 *  that sets the display's orientation resolves it, as DisplayRotation does: one that fixed or
 *  locked its orientation keeps it, and a stopped or translucent one leaves it to another. */
export function rotateDevice(landscape: boolean): Promise<void> {
  rotation.sensor = landscape;
  return onMain(async () => { if (applyOrientationRequest(orientationRequest())) await configurationChanged(); });
}
/** the page's display turns to the orientation of the Worker whose activity fills it */
export const followDisplay = (landscape: boolean): Promise<void> => onMain(() => turnDisplay(landscape));
// system_server's realm hosts no app to hear it
function applyConfigChange(): void { if (appHost) postMain(configurationChanged); }
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
/** a touch event to the window under its first pointer, as InputDispatcher delivers it; charged to
 *  perf.inputMs, since the wall time a tap costs is otherwise in no counter at all */
export function dispatchTouches(action: number, pointers: readonly TouchPointer[], eventTime = uptimeMillis()): Promise<void> {
  const t0 = performance.now();
  noteInput(); note(Ev.InputIn, action);
  const now = BigInt(Math.floor(eventTime));
  if (action === 0) touchDown = now;
  return dispatchTouch(action, pointers, touchDown, now).then(() => {}, toThread(mainThread)).finally(() => { perf.inputMs += performance.now() - t0; });
}
/** a one-finger touch event */
export const dispatchPointer = (action: number, x: number, y: number, eventTime = uptimeMillis()): Promise<void> =>
  dispatchTouches(action, [{ id: 0, x, y }], eventTime);
