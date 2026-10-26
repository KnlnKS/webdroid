import { appHost } from "../android/apphost.ts";
import { rt } from "../jvm/runtime.ts";
import { processExited } from "../process-exit.ts";
import { dispatchTouches, pressBack, testFrame, SCREEN_W, SCREEN_H } from "./device.ts";
import { yieldStats, timedParks } from "../jvm/yield.ts";
import { webViewInfo } from "../android/webframes.ts";
import { mainDbg, onMain } from "../android/mainloop.ts";
import { guestNow, guestSleep, uptimeMillis } from "../guest-clock.ts";
import { device } from "./config.ts";
import { ACTION_DOWN, ACTION_MOVE, ACTION_UP } from "../android/input-codes.ts";
import { dumpWindows } from "./uiautomator.ts";
import { imeInput, imeAction, imeState } from "../android/ime.ts";
import { displayShown, vsyncScheduled } from "../android/vsync.ts";
import { pendingTransitions } from "../android/server/atm.ts";
import { perf } from "../perf.ts";
import { nativeRequirements } from "./diagnostics.ts";
import { existingAotProfile } from "./aot-profile.ts";
import { timelineSince } from "../timeline.ts";
import { tierStatus } from "../jvm/tier.ts";
import { procIdentity } from "./procfs.ts";
import { native } from "../native/debug.ts";
import { connectFromHost } from "../native/socket/unix.ts";
import type { Loopback } from "../native/socket/core.ts";
import { dropFile } from "../native/fd.ts";

/** connections the host opened to this process's unix sockets (`forward`), by id, each closed once the host has not
 *  polled it for FORWARD_IDLE_MS */
const forwarded = new Map<number, { conn: Loopback; idle: ReturnType<typeof setTimeout> }>();
const FORWARD_IDLE_MS = 60_000;
function unforward(id: number): void {
  const open = forwarded.get(id);
  if (!open) return;
  forwarded.delete(id); clearTimeout(open.idle);
  open.conn.close().forEach(dropFile);
}
type NativeEntries = typeof native;
/** wd.native (debug.ts) as another realm calls it: each entry's result, or a copy of its value */
type NativeCalls = { [K in keyof NativeEntries]: NativeEntries[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> :
  () => Promise<NativeEntries[K] extends Set<infer V> ? V[] : NativeEntries[K]> };
const nativeCalls = Object.fromEntries(Object.entries(native).map(([name, entry]: [string, unknown]) => [name, typeof entry === "function"
  ? async (...args: unknown[]) => entry(...args) : async () => entry instanceof Set ? [...entry] : structuredClone({ ...entry as object })])) as NativeCalls;
/** one finger's touch event, at `eventTime` on the guest's uptime clock */
const touch = (action: number, x: number, y: number, eventTime?: number) => dispatchTouches(action, [{ id: 0, x, y }], eventTime);
const identity = () => ({ pid: procIdentity.pid, uid: procIdentity.uid, process: procIdentity.name, pkg: appHost?.pkg ?? null });
const framesBy = (map: Map<string, string[]>) => Object.fromEntries([...map].map(([name, frames]) => [name, frames.slice()]));

/** how far a process Worker's start has come (process-worker.ts) */
export type WorkerPhase = "attaching" | StartPhase | "failed";
/** the phases a starting Worker reports to the page, the last once its endpoint is served */
export type StartPhase = "packages" | "platform" | "application" | "ready";
/** What the harness drives and reads of one process realm: the page's own (harness.ts's wd) and each Worker's
 *  through its control port. Copies only observable data; a page never receives this JVM's objects or callbacks. */
export function workerControl(logs: string[], phase: () => WorkerPhase, ticks: () => number) {
  return {
    aotProfile: async () => ({ phase: phase(), dead: processExited(), identity: identity(), profile: await existingAotProfile() }),
    snapshot: async () => ({ phase: phase(), dead: processExited(), ticks: ticks(), width: SCREEN_W, height: SCREEN_H, identity: identity(),
      missingAt: framesBy(rt.missingAt), placeholders: [...rt.placeholders], placeholderAt: framesBy(rt.placeholderAt),
      vsyncScheduled: vsyncScheduled(), pendingTransitions: pendingTransitions(),
      yields: {pushes:yieldStats.pushes,fires:yieldStats.fires,pending:yieldStats.pending()}, timedParks: timedParks.size, web: webViewInfo(),
      main: { ...mainDbg }, perf: { ...perf },
      marks: performance.getEntriesByType("mark").filter(e=>e.name.startsWith("wd:")).map(e=>[e.name.slice(3),performance.timeOrigin+e.startTime] as const), missing: [...rt.missing], nativeRequired: nativeRequirements(), logs: logs.slice() }),
    /** whether the app's Wasm code was attached from persisted code, or once `save` settles it, saved */
    codeReadiness: async (save: boolean) => {
      const wasm = tierStatus();
      if (!wasm) return null;
      if (save) await wasm.appSettle?.();
      return { saved: !!wasm.appSaved, source: wasm.appSource ?? null, attached: !!wasm.appAttached, rejected: wasm.appRejected ?? null,
        kept: !!wasm.appBuilds?.some(build => build.kept), persisted: save ? !!await wasm.appPersisted?.() : null };
    },
    /** where the Wasm tier's on-demand compiling stands, and what it compiled since such a mark (World.demandSince) */
    demandMark: async () => tierStatus()?.demandMark?.() ?? null,
    demandSince: async (mark: number[]) => tierStatus()?.demandSince?.(mark) ?? null,
    alive: async () => processExited() || phase() !== "ready" ? false : onMain(() => !processExited()),
    // The same shape `uiautomator dump` reports, so the two hierarchies can be diffed directly:
    // absolute device px with the status bar included, which is the space a tap is expressed in.
    // A process that has ended shows no window; its own main loop answers nothing.
    uiTree: async (): Promise<Awaited<ReturnType<typeof dumpWindows>>> => processExited() ? [] : onMain(dumpWindows),
    tap: async (x: number, y: number): Promise<void> => {
      // a 60 ms press on the guest's clock, which a controlled clock would otherwise skip past. The
      // finger lifts on time however long the app takes to handle the press, as on a touchscreen:
      // a late UP would read as a long press.
      const down = touch(ACTION_DOWN, x, y);
      await guestSleep(60);
      await Promise.all([down, touch(ACTION_UP, x, y)]);
    },
    // Each sample keeps its scheduled uptime however late it is delivered, so catch-up samples do not
    // turn a constant-speed drag into an accelerating fling.
    swipe: async (x1: number, y1: number, x2: number, y2: number, ms = 400): Promise<void> => {
      const steps = Math.max(2, Math.round(ms * device.refreshRate / 1000));
      const t0 = guestNow(), eventStart = uptimeMillis();
      void touch(ACTION_DOWN, x1, y1, eventStart);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await guestSleep(Math.max(0, t0 + ms * t - guestNow()));
        void touch(ACTION_MOVE, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, eventStart + ms * t);
      }
      await touch(ACTION_UP, x2, y2, eventStart + ms);
    },
    type: async (text: string) => { await imeInput(text, text.length, text.length, false, imeState().generation); },
    enter: async () => imeAction(imeState().generation),
    imeState: async () => imeState(),
    back: async () => { await pressBack(); },
    testFrame: async (): Promise<void> => { if (displayShown()) await testFrame(); },
    /** the frame-path events since `from` (ms since the epoch), each [ms since the epoch, event, arg] */
    timeline: async (from: number) => timelineSince(from - performance.timeOrigin),
    /** debug (adb forward): writes `bytes` to connection `id` to the stream socket listening at `path`, opening it first, and
     *  answers what it has read since, or null once it has closed or nothing listens there */
    forward: async (id: number, path: string, bytes: Uint8Array): Promise<Uint8Array | null> => {
      const open = forwarded.get(id), conn = open?.conn ?? connectFromHost(path);
      if (!conn) return null;
      clearTimeout(open?.idle);
      forwarded.set(id, { conn, idle: setTimeout(() => unforward(id), FORWARD_IDLE_MS) });
      if (bytes.length) conn.write(bytes);
      const out = new Uint8Array(conn.available());
      conn.take(out, 0, out.length);
      if (!out.length && conn.eof) { unforward(id); return null; }
      return out;
    },
    /** this realm's wd.native debug entries (debug.ts) */
    native: nativeCalls,
  };
}
export type WorkerControl = ReturnType<typeof workerControl>;
