// webdroid shell: phone chrome, launcher, boot + input wiring.
import "./natives.ts";
import { PROCESS_PID } from "./android/os.ts";
import { vsyncScheduled } from "./android/vsync.ts";
import { pendingTransitions } from "./android/server/atm.ts";
import { mountSystemCertificates } from "./shell/cacerts.ts";
import { mountPlatformData } from "./shell/apex.ts";

import { newObj, vcall, scall } from "./jvm/natives/jentry.ts";
import { platformJarBlobs, loadFramework } from "./android/framework.ts";
import { loadSkia } from "./android/skia.ts";
import type { Mirror } from "./shell/frame-port.ts";
import { startZygote, redraw, pressBack, rotateDevice, setDisplayChangeHandler, setScreenCanvas } from "./shell/device.ts";
import { attachIme } from "./shell/input.ts";
import { attachKeyboard } from "./shell/keyboard-input.ts";
import { drainPointers } from "./shell/pointer-input.ts";
import { clearRoots } from "./shell/hostfs.ts";
import { clearPickedDocuments } from "./android/documents.ts";
import { mark, perf, perfReset } from "./perf.ts";
import { loadTier, wasmThreads } from "./jvm/tier.ts";
import { mainDbg, onMain } from "./android/mainloop.ts";
import { rt } from "./jvm/runtime.ts";
import { appHost } from "./android/apphost.ts";
import { guestClockControl } from "./guest-clock.ts";
import { native } from "./native/debug.ts";
import { packagesWithData, removePackageData } from "./shell/packagedata.ts";
import { clearUserData, deletePackage } from "./android/appdata.ts";
import { jitStats } from "./native/core.ts";
import { mountDiagnostics, nativeRequirements } from "./shell/diagnostics.ts";
import { countVsyncs, workerControl, type WorkerControl } from "./shell/worker-control.ts";
import { createShell } from "./shell/ui.ts";
import { captureLogs } from "./shell/logs.ts";
import { openInstallLocal, openInstallRemote } from "./shell/install.ts";
import { activateLocalAssets, localAsset } from "./shell/localassets.ts";
import { vfs } from "./shell/vfs.ts";
import { yieldStats, timedParks } from "./jvm/yield.ts";
import { provisionPackages, provisionServices } from "./shell/provision.ts";
import { processBroker } from "./shell/processes.ts";
import { foregroundWorkerSnapshot, visibleWorkerProcesses, visibleWorkersAlive, within, workerAotProfiles, workerSnapshots } from "./shell/worker-diagnostics.ts";
import { displayRate } from "./shell/display-rate.ts";
import { device } from "./shell/config.ts";
import { bootSystemOwner, prepareWorkerInstall } from "./shell/system-boot.ts";
import { hasFocusedWindow, hasTouchWindow } from "./android/server/wm.ts";
import { systemInputLayer } from "./shell/system-input.ts";

const params = new URLSearchParams(location.search);

const back = async () => {
  if (hasFocusedWindow()) { await pressBack(); return; }
  const routed = processBroker().activities.back(PROCESS_PID);
  if (routed) await routed; else await pressBack();
};
const rotate = async (landscape: boolean) => {
  const routed = processBroker().activities.rotate(PROCESS_PID, landscape);
  if (routed) await routed; else await rotateDevice(landscape);
};
const shell = createShell({ launch: (file, local) => { void boot(file, local); }, back: () => { void back(); } });
const { canvas, kbd } = shell;
setScreenCanvas(canvas);
const systemInput = systemInputLayer(canvas, () => device);
setDisplayChangeHandler(shell.resizeDisplay);

void loadFramework();
void platformJarBlobs();
void loadTier().then(() => mark("tierLoaded"), () => {});
// the next app's process loads its runtime while the page waits for a package to open, as a device's zygote waits forked
processBroker().hosts.prestart();

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

// wd.logs is what the e2e driver and scripts/dbg.ts read back out of the page
const logBuf = captureLogs({ log: "log", warn: "warn", error: "error" }, 4000);

let booting = false;
// the page opens one app; reopening it starts a new process
let runtimeStarted = false;
async function boot(file: string, local?: File) {
  if (booting || runtimeStarted) return;
  booting = true;
  shell.setState({ kind: "loading", file, stage: local ? "Opening package…" : "Downloading package…" });
  let rollbackAssets: (() => void) | undefined;
  try {
    mark("boot");
    void startZygote(displayRate());
    // the app's process needs only the package: the system realm waits for the page's tier itself
    const [install] = await Promise.all([local ? openInstallLocal(local) : openInstallRemote("/apks/" + encodeURIComponent(file)), provisionPackages(), loadSkia()]);
    const assets = local ? { key: crypto.randomUUID(), install } : null;
    if (local) {
      shell.setState({ kind: "loading", file, stage: "Preparing local app assets…" });
      await navigator.serviceWorker.register("/webview-worker.js");
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    }
    mark("installOpened");
    rollbackAssets = activateLocalAssets(assets);
    const t0 = performance.now();
    shell.setState({ kind: "loading", file, stage: "Starting system services…" });
    canvas.style.position = "relative";
    canvas.style.zIndex = "2147483647";
    canvas.style.background = "transparent";
    canvas.style.pointerEvents = "none";
    await displayRate();
    runtimeStarted = true;
    const { pkg, label } = await prepareWorkerInstall(install);
    const broker = processBroker();
    let started!: ReturnType<typeof broker.launch>;
    // the task goes with its process (ActivityRecord.handleAppDied removes an activity with no saved
    // state) and the launcher returns, under AppErrors' crash dialog when it showed one; opening the
    // app again starts a new process for it while the other processes and the broker live on
    const launch = () => {
      shell.setState({ kind: "loading", file, stage: "Starting app…" });
      started = broker.launch(pkg, assets?.key ?? file);
      broker.watch(started.pid, death => shell.setState({ kind: "exited", file, label, crashed: death.crashed,
        crashDialog: death.crashed && death.repeated, retry: launch }));
      return started.shown.then(() => { shell.setState({ kind: "running", file, label }); },
        error => { shell.setState({ kind: "failed", file, error, retry: launch }); });
    };
    // the app's process is sent its package before the system realm's Java takes the page
    await Promise.all([launch(), bootSystemOwner()]);
    perf.bootMs = performance.now() - t0;
    // other packages' processes start once the app has shown its first frame
    void broker.presented(started.pid).then(() => provisionServices({ attestationEnabled: params.get("attestation") === "1" }))
      .then(() => broker.boot()).catch(error => console.error("[provision]", error));
  } catch (e) {
    rollbackAssets?.();
    console.error(e);
    shell.setState({ kind: "failed", file, error: e, retry: runtimeStarted ? null : () => { void boot(file, local); } });
  } finally {
    booting = false;
  }
}

// several fingers' moves and a wheel's synthetic drag drain once per display frame
const ticks = countVsyncs(drainPointers), page = workerControl(logBuf, () => "ready", ticks);
/** the realm that takes input at (x, y), or the focused field's keys without a point: a system window, then
 *  the process on top, as they take the browser's own events */
const control = (x?: number, y?: number): WorkerControl => {
  const host = processBroker().activities.shownEntries().at(-1)?.host;
  return host && !(x === undefined || y === undefined ? hasFocusedWindow() : hasTouchWindow(x, y)) ? host.control : page;
};

// `?jit=0` runs the interpreter alone, to tell the tiers apart
jitStats.on = params.get("jit") !== "0";

/** Dev-console and e2e-driver surface; tests/e2e/drivers/webdroid.ts fires these by name. A realm's own
 *  input, frames and reads are its WorkerControl: `page`, `control(x, y)`'s or `foreground()`'s. */
const wd = {
  rt, app: () => appHost, perf, mainDbg, guestClock: guestClockControl, nativeRequirements, native,
  vfs, perfReset, yields: yieldStats, timedParks, vsyncScheduled, pendingTransitions, logs: logBuf,
  get ticks() { return ticks(); },
  page, control,
  /** the foreground process Worker's control, if one is in front */
  foreground: (): WorkerControl | undefined => processBroker().foregroundHost()?.control,
  // the JVM's entry points, so a page script can drive real bytecode where Canvas2D is needed
  newObj: (cls: string, desc?: string, ...args: unknown[]) => onMain(() => newObj(cls, desc, ...args)),
  vcall: (obj: unknown, name: string, desc: string, ...args: unknown[]) => onMain(() => vcall(obj, name, desc, ...args)),
  scall: (cls: string, name: string, desc: string, ...args: unknown[]) => onMain(() => scall(cls, name, desc, ...args)),
  boot, back,
  workerProcesses: () => workerSnapshots(processBroker().processes()),
  workerAotProfiles: () => workerAotProfiles(processBroker().processes()),
  /** the shown processes' canvases bottom to top, then the page's */
  displayCanvases: () => [...processBroker().activities.shownEntries().flatMap(entry => entry.host ? [entry.host.canvas] : []), canvas],
  mirrorFrames: (on: Mirror) => processBroker().hosts.mirror(on),
  foregroundWorkerSnapshot: () => foregroundWorkerSnapshot(processBroker()),
  processStarting: () => processBroker().starting(),
  visibleWorkerProcesses: (ms = 1500) => visibleWorkerProcesses(processBroker(), ms),
  background: (ms = 1000) => processBroker().activities.background(ms),
  configuration: (orientation: "portrait" | "landscape") => rotate(orientation === "landscape"),
  // the shown processes' windows bottom to top, then the system windows above them
  uiTree: async (): Promise<Awaited<ReturnType<WorkerControl["uiTree"]>>> => {
    const nodes = [];
    for (const entry of processBroker().activities.shownEntries()) if (entry.host) nodes.push(...await entry.host.control.uiTree());
    return [...nodes, ...await page.uiTree()];
  },
  // Center of the first visible view whose text matches, in SCREEN coords (status bar included,
  // the space a control's tap takes), topmost window first.
  locateText: (s: string): Promise<{ x: number; y: number; bounds: [number, number, number, number] } | null> => {
    const normalized = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const want = normalized(s);
    const matches = (candidate: string) => candidate === want || candidate.startsWith(want);
    return wd.uiTree().then((nodes) => {
      // topmost window first, as a tap reaches it; an exact match before a prefix, as the device driver ranks them
      const shown = nodes.reverse().filter((n) => n.bounds[2] > n.bounds[0]), texts = (n: typeof shown[number]) => [normalized(n.text), normalized(n.desc)];
      const hit = shown.find((n) => texts(n).includes(want)) ?? shown.find((n) => texts(n).some(matches));
      return hit ? { x: (hit.bounds[0] + hit.bounds[2]) / 2, y: (hit.bounds[1] + hit.bounds[3]) / 2, bounds: hit.bounds } : null;
    });
  },
  // Is the main-looper queue still draining? A wedged job stops input and repaint alike, which
  // looks exactly like a settled screen from outside.
  alive: async (ms = 1500) => {
    const [root, workers] = await Promise.all([within(page.alive(), ms, () => false), visibleWorkersAlive(processBroker(), ms)]);
    return root && workers !== false;
  },
  // a fresh install of every app: each package's data and install state as its removal takes them,
  // with the shared storage and the picked directories
  reset: async () => {
    const broker = processBroker(), names = await packagesWithData(broker);
    await Promise.all(names.map((pkg) => removePackageData(broker, pkg)));
    // the disk Worker lets its files go before the origin's storage is emptied under it
    await broker.files.clearAll();
    await Promise.all([clearRoots(), clearPickedDocuments()]);
    return names;
  },
  // an app's data cleared as Settings' "Clear storage" does, and its uninstall as the launcher's
  clearData: async (pkg: string) => (await onMain(() => clearUserData(pkg, false, false, null))).done,
  uninstall: (pkg: string) => onMain(() => deletePackage(pkg)),
  looperDump: () => import("./android/mainloop.ts").then((m) => m.looperDump()),
  threads: wasmThreads,
  redraw,
  testFrame: async () => {
    await page.testFrame();
    for (const entry of processBroker().activities.shownEntries()) if (entry.host) await entry.host.control.testFrame();
  },
};
(globalThis as any).wd = wd;

attachIme(canvas, kbd, systemInput.element);
attachKeyboard(kbd);

mountSystemCertificates();
mountPlatformData();

// system_server boots while the page waits for a package to open, as a device's does before any app launches. A page opened for
// an app boots it once the app's process has its package: the page serves that process's code meanwhile.
if (!params.has("apk")) {
  void startZygote(displayRate());
  void provisionPackages().then(bootSystemOwner).catch(() => {});
}
