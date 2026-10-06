import { PROCESS_PID, PROCESS_UID, PROCESS_NAME } from "../android/os";
import { appHost } from "../android/apphost";
import { jvmCoverage } from "../jvm/coverage";
import { rt } from "../jvm/runtime";
import { realmWd } from "./realmwd";
import { processExited } from "../process-exit";
import { dispatchPointer, pressBack, SCREEN_W, SCREEN_H } from "./device";
import { yieldStats, timedParks } from "../jvm/yield";
import { webViewInfo } from "../android/webframes";
import { mainDbg, onMain } from "../android/mainloop";
import { recordVsync } from "../android/vsync";
import { swipe } from "./gesture";
import { imeInput, imeAction, imeState } from "../android/ime";
import { vsyncScheduled } from "../android/vsync";
import { pendingTransitions } from "../android/server/atm";
import { perf } from "../perf";
import { processPresentation } from "./process-endpoint";
import { nativeRequirements } from "./diagnostics";
import { existingAotProfile } from "./aot-profile";

/** Copies only observable data; a page never receives this JVM's objects or callbacks. */
export function workerControl(logs: string[], phase: () => string) {
  let ticks = 0;
  const local = realmWd();
  return {
    aotProfile: async () => ({phase:phase(),dead:processExited(),
      identity:{pid:PROCESS_PID,uid:PROCESS_UID,process:PROCESS_NAME,pkg:appHost?.pkg ?? null},
      profile:await existingAotProfile()}),
    snapshot: async () => ({ phase: phase(), dead: processExited(), ticks, width: SCREEN_W, height: SCREEN_H,
      identity: {pid:PROCESS_PID,uid:PROCESS_UID,process:PROCESS_NAME,pkg:appHost?.pkg ?? null},
      missingAt: Object.fromEntries([...rt.missingAt].map(([name,frames])=>[name,frames.slice()])),
      placeholders: [...rt.placeholders], placeholderAt: Object.fromEntries([...rt.placeholderAt].map(([name,frames])=>[name,frames.slice()])),
      coverage: jvmCoverage.snapshot(), compositor: Reflect.get(local,"compositorStatus") ?? null,
      vsyncScheduled: vsyncScheduled(), pendingTransitions: pendingTransitions(),
      yields: {pushes:yieldStats.pushes,fires:yieldStats.fires,pending:yieldStats.pending()}, timedParks: timedParks.size, web: webViewInfo(),
      main: { ...mainDbg }, perf: { ...perf }, missing: [...rt.missing], nativeRequired: nativeRequirements(), logs: logs.slice() }),
    alive: async () => processExited() || phase() !== "ready" ? false : onMain(() => !processExited()),
    uiTree: local.uiTree,
    tap: local.tap,
    swipe,
    type: async (text: string) => { await imeInput(text, text.length, text.length, false, imeState().generation); },
    enter: async () => imeAction(imeState().generation),
    imeState: async () => imeState(),
    pointer: async (action: number, x: number, y: number) => { await dispatchPointer(action, x, y); },
    back: async () => { await pressBack(); },
    frame: async (time: number) => { if (processPresentation.visible && !processExited() && recordVsync(time)) ticks++; },
    testFrame: local.testFrame,
  };
}
export type WorkerControl = ReturnType<typeof workerControl>;
export { workerControlMethods } from "./worker-control-methods";
