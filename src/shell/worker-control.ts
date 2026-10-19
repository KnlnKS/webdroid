import { PROCESS_PID, PROCESS_UID, PROCESS_NAME } from "../android/os.ts";
import { appHost } from "../android/apphost.ts";
import { rt } from "../jvm/runtime.ts";
import { realmWd } from "./realmwd.ts";
import { processExited } from "../process-exit.ts";
import { pressBack, SCREEN_W, SCREEN_H } from "./device.ts";
import { yieldStats, timedParks } from "../jvm/yield.ts";
import { webViewInfo } from "../android/webframes.ts";
import { mainDbg, onMain } from "../android/mainloop.ts";
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

/** Copies only observable data; a page never receives this JVM's objects or callbacks. */
export function workerControl(logs: string[], phase: () => string) {
  let ticks = 0;
  const local = realmWd();
  hostFrames(time => { if (processPresentation.visible && !processExited() && recordVsync(time)) ticks++; });
  return {
    aotProfile: async () => ({phase:phase(),dead:processExited(),
      identity:{pid:PROCESS_PID,uid:PROCESS_UID,process:PROCESS_NAME,pkg:appHost?.pkg ?? null},
      profile:await existingAotProfile()}),
    snapshot: async () => ({ phase: phase(), dead: processExited(), ticks, width: SCREEN_W, height: SCREEN_H,
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
    uiTree: local.uiTree,
    tap: local.tap,
    swipe,
    type: async (text: string) => { await imeInput(text, text.length, text.length, false, imeState().generation); },
    enter: async () => imeAction(imeState().generation),
    imeState: async () => imeState(),
    back: async () => { await pressBack(); },
    testFrame: local.testFrame,
    /** the frame-path events since `from` (ms since the epoch), each [ms since the epoch, event, arg] */
    timeline: async (from: number) => timelineSince(from - performance.timeOrigin),
  };
}
export type WorkerControl = ReturnType<typeof workerControl>;
