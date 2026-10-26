// The dev console's and e2e driver's surface `wd`; tests/e2e/drivers/webdroid.ts fires these by name. A realm's own
// input, frames and reads are its WorkerControl: `page`, `control(x, y)`'s or `foreground()`'s.
import { procIdentity } from "./procfs.ts";
import { vsyncScheduled } from "../android/vsync.ts";
import { pendingTransitions } from "../android/server/atm.ts";
import { newObj, vcall, scall } from "../jvm/natives/jentry.ts";
import type { Mirror } from "./frame-port.ts";
import { redraw, rotateDevice } from "./device.ts";
import { clearRoots } from "./hostfs.ts";
import { clearPickedDocuments } from "../android/documents.ts";
import { perf, perfReset } from "../perf.ts";
import { wasmThreads } from "../jvm/tier.ts";
import { mainDbg, onMain } from "../android/mainloop.ts";
import { rt } from "../jvm/runtime.ts";
import { appHost } from "../android/apphost.ts";
import { guestClockControl } from "../guest-clock.ts";
import { native } from "../native/debug.ts";
import { packagesWithData, removePackageData } from "./packagedata.ts";
import { nativeRequirements } from "./diagnostics.ts";
import { workerControl, type WorkerControl } from "./worker-control.ts";
import { captureLogs } from "./logs.ts";
import { yieldStats, timedParks } from "../jvm/yield.ts";
import { processBroker } from "./processes.ts";
import { foregroundWorkerSnapshot, visibleWorkersAlive, workerAotProfiles, workerSnapshots } from "./worker-diagnostics.ts";
import { within } from "./rpc.ts";
import { hasFocusedWindow, hasTouchWindow } from "../android/server/wm.ts";

type Wd = ReturnType<typeof harness>;
declare global { var wd: Wd; }

/** `ticks` counts the page's display frames; `boot` and `back` are its own */
export const installHarness = (...args: Parameters<typeof harness>): void => { globalThis.wd = harness(...args); };

function harness(canvas: HTMLCanvasElement, ticks: () => number, { boot, back }: { boot(file: string): Promise<void>; back(): Promise<void> }) {
  // wd.logs is what the e2e driver and scripts/dbg.ts read back out of the page
  const logs = captureLogs({ log: "log", warn: "warn", error: "error" }, 4000), page = workerControl(logs, () => "ready", ticks);
  /** the realm that takes input at (x, y), or the focused field's keys without a point: a system window, then
   *  the process on top, as they take the browser's own events */
  const control = (x?: number, y?: number): WorkerControl => {
    const host = processBroker().activities.shownEntries().at(-1)?.host;
    return host && !(x === undefined || y === undefined ? hasFocusedWindow() : hasTouchWindow(x, y)) ? host.control : page;
  };
  // the shown processes' windows bottom to top, then the system windows above them
  const uiTree = async (): Promise<Awaited<ReturnType<WorkerControl["uiTree"]>>> => {
    const nodes = [];
    for (const entry of processBroker().activities.shownEntries()) if (entry.host) nodes.push(...await entry.host.control.uiTree());
    return [...nodes, ...await page.uiTree()];
  };
  const rotate = async (landscape: boolean) => {
    const routed = processBroker().activities.rotate(procIdentity.pid, landscape);
    if (routed) await routed; else await rotateDevice(landscape);
  };
  return {
    rt, app: () => appHost, perf, mainDbg, guestClock: guestClockControl, nativeRequirements, native,
    perfReset, yields: yieldStats, timedParks, vsyncScheduled, pendingTransitions, logs,
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
    /** the control port of process `pid`'s Worker */
    process: (pid: number) => [...processBroker().processes()].find(entry => entry.pid === pid)?.host?.control,
    workerAotProfiles: () => workerAotProfiles(processBroker().processes()),
    /** the shown processes' canvases bottom to top, then the page's */
    displayCanvases: () => [...processBroker().activities.shownEntries().flatMap(entry => entry.host ? [entry.host.canvas] : []), canvas],
    mirrorFrames: (on: Mirror) => processBroker().hosts.mirror(on),
    foregroundWorkerSnapshot: () => foregroundWorkerSnapshot(processBroker()),
    processStarting: () => processBroker().starting(),
    background: (ms = 1000) => processBroker().activities.background(ms),
    configuration: (orientation: "portrait" | "landscape") => rotate(orientation === "landscape"),
    uiTree,
    // Center of the first visible view whose text matches, in SCREEN coords (status bar included,
    // the space a control's tap takes), topmost window first.
    locateText: (s: string): Promise<{ x: number; y: number; bounds: [number, number, number, number] } | null> => {
      const normalized = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const want = normalized(s);
      const matches = (candidate: string) => candidate === want || candidate.startsWith(want);
      return uiTree().then((nodes) => {
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
    looperDump: () => import("../android/mainloop.ts").then((m) => m.looperDump()),
    threads: wasmThreads,
    redraw,
    testFrame: async () => {
      await page.testFrame();
      for (const entry of processBroker().activities.shownEntries()) if (entry.host) await entry.host.control.testFrame();
    },
  };
}
