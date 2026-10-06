// webdroid shell: phone chrome, launcher, boot + input wiring.
import { codeStats } from "./jvm/codecache";
import { offeredCount } from "./jvm/aot";
import { pendingCompilations } from "./jvm/tiering";
import "./natives";
import { PROCESS_PID } from "./android/os";
import { recordVsync, vsyncScheduled } from "./android/vsync";
import { pendingTransitions } from "./android/server/atm";
import { mountSystemCertificates } from "./shell/cacerts";
import { mountPlatformData } from "./shell/apex";

import { newObj, vcall, scall, strictThreadOwnership } from "./jvm/natives/jentry";
import { threadStates } from "./jvm/natives/jthread";
import { fetchPlatformJars, loadFramework } from "./android/framework";
import { loadSkia } from "./android/skia";
import { bootApk, firstPresented, startZygote, redraw, dispatchPointer, pressBack, rotateDevice, setDisplayChangeHandler, setScreenCanvas } from "./shell/device";
import { attachIme, drainInput } from "./shell/input";
import { clearRoots } from "./shell/hostfs";
import { clearPickedDocuments } from "./android/documents";
import { mark, perf, perfReset } from "./perf";
import { loadTier, tier } from "./jvm/tier";
import { configureJvm, jvmProfiler, parseJvmTier, DEFAULT_HOT_THRESHOLD, JVM_HOT_THRESHOLDS } from "./jvm/profile";
import { configureJvmCoverage } from "./jvm/coverage";
import { onMain } from "./android/mainloop";
import { imeInput, imeAction } from "./android/ime";
import { setWebLayer, webViewInfo } from "./android/webframes";
import { packagesWithData, removePackageData } from "./shell/packagedata";
import { clearUserData, deletePackage } from "./android/appdata";
import { jitStats } from "./native/core";
import { mountDiagnostics } from "./shell/diagnostics";
import { realmWd, type RealmWd } from "./shell/realmwd";
import { createShell } from "./shell/ui";
import { openInstallLocal, openInstallRemote } from "./shell/install";
import { fixProcessBitness } from "./jvm/natives/jvmruntime";
import { activateLocalAssets, localAsset } from "./shell/localassets";
import { vfs } from "./shell/vfs";
import { yieldStats, timedParks } from "./jvm/yield";
import { provisionPackages, provisionServices } from "./shell/provision";
import { processBroker } from "./shell/processes";
import { connectProcess, registerForegroundProcess, processPresentation } from "./shell/process-endpoint";
import { guestNow, guestSleep, uptimeMillis } from "./guest-clock";
import { device } from "./shell/config";
import { appHost } from "./android/apphost";
import { bootSystemOwner, prepareWorkerInstall } from "./shell/system-boot";
import { onProcessExit } from "./process-exit";
import { deathOf, lastExit, type Death } from "./android/server/appexitinfo";

strictThreadOwnership();
const params = new URLSearchParams(location.search);
const hotThreshold = Number(params.get("jvmHotness") ?? DEFAULT_HOT_THRESHOLD);
if (!JVM_HOT_THRESHOLDS.includes(hotThreshold)) throw new Error(`invalid jvmHotness ${hotThreshold}`);
configureJvm({ profile: params.get("jvmProfile") === "1", tier: parseJvmTier(params.get("jvmTier")), hotThreshold });
configureJvmCoverage(params.get("fuzzCoverage") === "1");
const resetPerf = (): void => { perfReset(); jvmProfiler.reset(); };

const back = async () => {
  const routed = processBroker().activities.back(PROCESS_PID);
  if (routed) await routed; else await pressBack();
};
const shell = createShell({ launch: (file, local) => { void boot(file, local); }, back: () => { void back(); } });
const { canvas, kbd } = shell;
setScreenCanvas(canvas);
setWebLayer(shell.webLayer);
setDisplayChangeHandler(shell.resizeDisplay);

void loadFramework();
void fetchPlatformJars();
if (tier === "wasm") void loadTier();
// the worker serves persisted compiled code (src/jvm/codecache.ts), so V8 can cache it
void navigator.serviceWorker?.register("/webview-worker.js").catch(() => {});

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
// this realm runs one app; it opens again in a process of its own
let runtimeStarted = false;
async function boot(file: string, local?: File) {
  if (booting || runtimeStarted) return;
  booting = true;
  shell.setState({ kind: "loading", file, stage: local ? "Opening package…" : "Downloading package…" });
  let rollbackAssets: (() => void) | undefined;
  try {
    mark("boot");
    const tierReady = tier === "wasm" ? loadTier().then(() => mark("tierLoaded")) : undefined;
    const workerMode = params.get("processMode") === "worker";
    void startZygote();
    const bitness = workerMode ? undefined : fixProcessBitness;
    const [, install] = await Promise.all([tierReady, local ? openInstallLocal(local, bitness) : openInstallRemote("/apks/" + encodeURIComponent(file), bitness), provisionPackages(), loadSkia(), displayRate]);
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
    if (workerMode) {
      shell.setState({ kind: "loading", file, stage: "Starting system services…" });
      await bootSystemOwner();
      runtimeStarted = true;
      const { pkg, label } = await prepareWorkerInstall(install);
      const broker = processBroker();
      const launch = () => {
        shell.setState({ kind: "loading", file, stage: "Starting app…" });
        const started = broker.launch(pkg, assets?.key ?? file);
        broker.watch(started.pid, death => shell.setState({ kind: "exited", file, label, crashed: death.crashed,
          crashDialog: death.crashed && death.repeated, retry: launch }));
        return started.shown.then(() => { shell.setState({ kind: "running", file, label }); },
          error => { shell.setState({ kind: "failed", file, error, retry: launch }); });
      };
      await launch();
      perf.bootMs = performance.now() - t0;
      void provisionServices({ attestationEnabled: params.get("attestation") === "1" })
        .then(() => broker.boot()).catch(error => console.error("[provision]", error));
      return;
    }
    connectProcess();
    runtimeStarted = true;
    let shown = file;
    // the task goes with its process (ActivityRecord.handleAppDied removes an activity with no saved
    // state) and the launcher returns, under AppErrors' crash dialog when it showed one. Opening the
    // app again starts a new process for it, in a frame: the other processes and the broker live on.
    const exited = (death: Death) => {
      processPresentation.visible = false;
      const pkg = appHost?.pkg;
      shell.setState({ kind: "exited", file, label: shown, crashed: death.crashed, crashDialog: death.crashed && death.repeated, retry: pkg ? () => relaunch(pkg) : null });
    };
    const relaunch = (pkg: string) => {
      shell.setState({ kind: "loading", file, stage: "Starting app…" });
      const broker = processBroker(), started = broker.launch(pkg, assets?.key ?? file);
      broker.watch(started.pid, exited);
      started.shown.then(() => shell.setState({ kind: "running", file, label: shown }), (error) => shell.setState({ kind: "failed", file, error, retry: () => relaunch(pkg) }));
    };
    // the broker tells of this process's death once it registers, with its package; only this realm
    // sees a death before then
    let registered = false;
    onProcessExit(() => { if (!registered) exited(deathOf(lastExit)); });
    const register = () => { registerForegroundProcess(); registered = true; processBroker().watch(PROCESS_PID, exited); };
    const label = shown = await bootApk(install, (stage) => shell.setState({ kind: "loading", file, stage }), assets?.key ?? file, null, register);
    // a device's Play services are up before an app launches: here their realm boots after the
    // app's first frame rather than competing with it
    void firstPresented.then(() => provisionServices({ attestationEnabled: params.get("attestation") === "1" }))
      .then(() => processBroker().boot()).catch((error) => console.error("[provision]", error));
    perf.bootMs = performance.now() - t0;
    shell.setState({ kind: "running", file, label });
  } catch (e) {
    rollbackAssets?.();
    console.error(e);
    shell.setState({ kind: "failed", file, error: e, retry: runtimeStarted ? null : () => { void boot(file, local); } });
  } finally {
    booting = false;
  }
}

const local = realmWd();
/** the realms of the processes the broker shows in frames above this one, bottom to top */
const framed = (): RealmWd[] => processBroker().activities.shownWindows().flatMap((w) => {
  const child = w === window ? undefined : (w as unknown as { wd?: RealmWd }).wd;
  return child ? [child] : [];
});
// the process on top takes the tap, as it takes the browser's own pointer events
const tap = (x: number, y: number): Promise<void> => {
  const worker = processBroker().activities.shownEntries().at(-1)?.worker;
  if (worker) return worker.control.tap(x, y);
  const top = processBroker().activities.shownWindows().at(-1);
  return (top && top !== window ? (top as unknown as { wd: RealmWd }).wd : local).tap(x, y);
};

// `?jit=0` runs the interpreter alone, to tell the tiers apart
jitStats.on = params.get("jit") !== "0";

/** Dev-console and e2e-driver surface; tests/e2e/drivers/webdroid.ts fires these by name. */
const wd = {
  ...local,
  vfs, perfReset: resetPerf, jvmProfile: () => jvmProfiler.snapshot(), yields: yieldStats, timedParks, vsyncScheduled, pendingTransitions, logs: logBuf, ticks: 0,
  // the JVM's entry points, so a page script can drive real bytecode where Canvas2D is needed
  newObj: (cls: string, desc?: string, ...args: unknown[]) => onMain(() => newObj(cls, desc, ...args)),
  vcall: (obj: unknown, name: string, desc: string, ...args: unknown[]) => onMain(() => vcall(obj, name, desc, ...args)),
  code: () => ({ ...codeStats(), offered: offeredCount(), deferred: pendingCompilations() }),
  scall: (cls: string, name: string, desc: string, ...args: unknown[]) => onMain(() => scall(cls, name, desc, ...args)),
  boot, back,
  workerProcesses: () => processBroker().workerSnapshots(),
  foregroundWorkerSnapshot: () => processBroker().foregroundWorkerSnapshot(),
  visibleWorkerProcesses: (ms = 1500) => processBroker().visibleWorkerProcesses(ms),
  displayCanvas: () => processBroker().displayCanvases(canvas).at(-1)!,
  displayCanvases: () => processBroker().displayCanvases(canvas),
  background: (ms = 1000) => processBroker().activities.background(ms),
  configuration: (orientation: "portrait" | "landscape") => rotateDevice(orientation === "landscape"),
  // the canvas capture cannot see iframe pixels: this is how a harness proves a page loaded
  web: () => webViewInfo(),
  // the processes the broker shows stack above this one in their frames, as their windows do on a display
  uiTree: async (): Promise<Awaited<ReturnType<RealmWd["uiTree"]>>> => {
    const nodes = await local.uiTree();
    for (const child of framed()) nodes.push(...await child.uiTree());
    for (const entry of processBroker().activities.shownEntries()) if (entry.worker) nodes.push(...await entry.worker.control.uiTree());
    return nodes;
  },
  // Center of the first visible view whose text matches, in SCREEN coords (status bar included,
  // the space wd.tap takes), topmost window first.
  locateText: (s: string): Promise<{ x: number; y: number } | null> => {
    const normalized = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const want = normalized(s);
    const matches = (candidate: string) => candidate === want || candidate.startsWith(want);
    return wd.uiTree().then((nodes) => {
      // topmost window first, as a tap reaches it; an exact match before a prefix, as the device driver ranks them
      const shown = nodes.reverse().filter((n) => n.bounds[2] > n.bounds[0]), texts = (n: typeof shown[number]) => [normalized(n.text), normalized(n.desc)];
      const hit = shown.find((n) => texts(n).includes(want)) ?? shown.find((n) => texts(n).some(matches));
      return hit ? { x: (hit.bounds[0] + hit.bounds[2]) / 2, y: (hit.bounds[1] + hit.bounds[3]) / 2 } : null;
    });
  },
  tap,
  tapText: async (s: string) => {
    const hit = await wd.locateText(s);
    if (!hit) return "not found: " + s;
    await tap(hit.x, hit.y);
    return `tapped ${s} @ ${hit.x},${hit.y}`;
  },
  swipe: async (x1: number, y1: number, x2: number, y2: number, ms = 400) => {
    // one move per display frame, as a finger on a panel of this rate reports them
    const steps = Math.max(2, Math.round(ms * device.refreshRate / 1000));
    const t0 = guestNow();
    const eventStart = uptimeMillis();
    void dispatchPointer(0, x1, y1, eventStart);
    for (let i = 1; i <= steps; i++) {
      const at = t0 + ms * i / steps, t = i / steps;
      await guestSleep(Math.max(0, at - guestNow()));
      // Samples keep the finger's time when host work delays their delivery; catch-up
      // timers must not turn a constant-speed drag into an accelerating fling.
      void dispatchPointer(2, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, eventStart + ms * t);
    }
    await dispatchPointer(1, x2, y2, eventStart + ms);
    return `swiped ${x1},${y1} -> ${x2},${y2}`;
  },
  // Is the main-looper queue still draining? A wedged job stops input and repaint alike, which
  // looks exactly like a settled screen from outside.
  alive: async (ms = 1500) => {
    const workersAlive = await processBroker().visibleWorkersAlive(ms);
    if (workersAlive !== null) return workersAlive;
    let id: ReturnType<typeof setTimeout>;
    return Promise.race([
      onMain(() => true).finally(() => clearTimeout(id)),
      new Promise((r) => { id = setTimeout(() => r(false), ms); }),
    ]);
  },
  // a fresh install of every app: each package's data and install state as its removal takes them,
  // with the shared storage and the picked directories
  reset: async () => {
    const broker = processBroker(), names = await packagesWithData(broker);
    await Promise.all(names.map((pkg) => removePackageData(broker, pkg)));
    await Promise.all([clearRoots(), clearPickedDocuments(), broker.files.clearAll()]);
    return names;
  },
  // an app's data cleared as Settings' "Clear storage" does, and its uninstall as the launcher's
  clearData: async (pkg: string) => (await onMain(() => clearUserData(pkg, false, false, null))).done,
  uninstall: (pkg: string) => onMain(() => deletePackage(pkg)),
  type: async (s: string) => {
    kbd.value = s;
    await imeInput(s);
    return "typed " + s;
  },
  // the keyboard's action key on the focused field (Search, Go, Done…)
  enter: async () => "action " + (await imeAction() ? "handled" : "ignored"),
  looperDump: () => import("./android/mainloop").then((m) => m.looperDump()),
  threads: threadStates,
  redraw,
  testFrame: async () => {
    await local.testFrame();
    for (const child of framed()) await child.testFrame();
    for (const entry of processBroker().activities.shownEntries()) if (entry.worker) await entry.worker.control.testFrame();
  },
};
(globalThis as any).wd = wd;

// the display: a vsync per rAF while visible, at the display's rate on a timer while the tab is hidden
let lastVsync = 0;
function vsync(time: number) {
  if (!processPresentation.visible) return;
  drainInput(); // the wheel's synthetic drag steps once per display frame
  if (recordVsync(time)) { wd.ticks++; lastVsync = performance.now(); }
}
function loop(time: number) {
  vsync(time);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
setInterval(() => {
  if (performance.now() - lastVsync > 40) vsync(performance.now());
}, 33);

attachIme(canvas, kbd);

mountSystemCertificates();
mountPlatformData();

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

