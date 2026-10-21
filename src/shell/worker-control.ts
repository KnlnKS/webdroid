import { PROCESS_PID, PROCESS_UID, PROCESS_NAME } from "../android/os.ts";
import { appHost } from "../android/apphost.ts";
import { rt } from "../jvm/runtime.ts";
import { processExited } from "../process-exit.ts";
import { dispatchPointer, pressBack, testFrame, SCREEN_W, SCREEN_H } from "./device.ts";
import { yieldStats, timedParks } from "../jvm/yield.ts";
import { webViewInfo } from "../android/webframes.ts";
import { mainDbg, onMain } from "../android/mainloop.ts";
import { guestSleep } from "../guest-clock.ts";
import { dumpWindows } from "./uiautomator.ts";
import { swipe } from "./gesture.ts";
import { imeInput, imeAction, imeState } from "../android/ime.ts";
import { hostFrames, recordVsync, vsyncScheduled } from "../android/vsync.ts";
import { pendingTransitions } from "../android/server/atm.ts";
import { perf } from "../perf.ts";
import { processPresentation } from "./process-endpoint.ts";
import { nativeRequirements } from "./diagnostics.ts";
import { existingAotProfile } from "./aot-profile.ts";
import { timelineSince } from "../timeline.ts";
import { tierStatus } from "../jvm/tier.ts";

/** the vsyncs this realm's shown display has had while its process lives; `frame` runs first on each shown frame */
export function countVsyncs(frame?: () => void): () => number {
  let ticks = 0;
  hostFrames(time => {
    if (!processPresentation.visible) return;
    frame?.();
    if (!processExited() && recordVsync(time)) ticks++;
  });
  return () => ticks;
}

/** how far a process Worker's start has come (process-worker.ts) */
export type WorkerPhase = "attaching" | "packages" | "platform" | "application" | "ready" | "failed";
/** What the harness drives and reads of one process realm: the page's own (harness.ts's wd) and each Worker's
 *  through its control port. Copies only observable data; a page never receives this JVM's objects or callbacks. */
export function workerControl(logs: string[], phase: () => WorkerPhase, ticks: () => number) {
  return {
    aotProfile: async () => ({phase:phase(),dead:processExited(),
      identity:{pid:PROCESS_PID,uid:PROCESS_UID,process:PROCESS_NAME,pkg:appHost?.pkg ?? null},
      profile:await existingAotProfile()}),
    snapshot: async () => ({ phase: phase(), dead: processExited(), ticks: ticks(), width: SCREEN_W, height: SCREEN_H,
      identity: {pid:PROCESS_PID,uid:PROCESS_UID,process:PROCESS_NAME,pkg:appHost?.pkg ?? null},
      missingAt: Object.fromEntries([...rt.missingAt].map(([name,frames])=>[name,frames.slice()])),
      placeholders: [...rt.placeholders], placeholderAt: Object.fromEntries([...rt.placeholderAt].map(([name,frames])=>[name,frames.slice()])),
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
      const down = dispatchPointer(0, x, y);
      await guestSleep(60);
      await Promise.all([down, dispatchPointer(1, x, y)]);
    },
    swipe,
    type: async (text: string) => { await imeInput(text, text.length, text.length, false, imeState().generation); },
    enter: async () => imeAction(imeState().generation),
    imeState: async () => imeState(),
    back: async () => { await pressBack(); },
    testFrame: async (): Promise<void> => { if (processPresentation.visible) await testFrame(); },
    /** the frame-path events since `from` (ms since the epoch), each [ms since the epoch, event, arg] */
    timeline: async (from: number) => timelineSince(from - performance.timeOrigin),
  };
}
export type WorkerControl = ReturnType<typeof workerControl>;
