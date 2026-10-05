import { rt } from "../jvm/runtime";
import { realmWd } from "./realmwd";
import { processExited } from "../process-exit";
import { dispatchPointer, pressBack, SCREEN_W, SCREEN_H } from "./device";
import { mainDbg } from "../android/mainloop";
import { recordVsync } from "../android/vsync";
import { perf } from "../perf";
import { processPresentation } from "./process-endpoint";
import { nativeRequirements } from "./diagnostics";

/** Copies only observable data; a page never receives this JVM's objects or callbacks. */
export function workerControl(logs: string[], phase: () => string) {
  let ticks = 0;
  const local = realmWd();
  return {
    snapshot: async () => ({ phase: phase(), dead: processExited(), ticks, width: SCREEN_W, height: SCREEN_H,
      main: { ...mainDbg }, perf: { ...perf }, missing: [...rt.missing], nativeRequired: nativeRequirements(), logs: logs.slice() }),
    uiTree: local.uiTree,
    tap: local.tap,
    pointer: async (action: number, x: number, y: number) => { await dispatchPointer(action, x, y); },
    back: async () => { await pressBack(); },
    frame: async (time: number) => { if (processPresentation.visible && !processExited() && recordVsync(time)) ticks++; },
    testFrame: local.testFrame,
  };
}
export type WorkerControl = ReturnType<typeof workerControl>;
export const workerControlMethods = ["snapshot", "uiTree", "tap", "pointer", "back", "frame", "testFrame"] as const;
