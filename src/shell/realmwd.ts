// The harness surface (`wd`, tests/e2e/drivers/webdroid.ts) every process realm has: its app, its
// diagnostics, and its own windows, frames and touches. The page's `wd` adds the process Workers
// the broker shows beneath its system windows.
import { rt } from "../jvm/runtime";
import { appHost } from "../android/apphost";
import { jvmCoverage } from "../jvm/coverage";
import { perf } from "../perf";
import { tier } from "../jvm/tier";
import { mainDbg, onMain } from "../android/mainloop";
import { guestClockControl, guestSleep } from "../guest-clock";
import { nativeRequirements } from "./diagnostics";
import { native } from "../native/debug";
import { processExited } from "../process-exit";
import { dumpWindows } from "./uiautomator";
import { dispatchPointer, testFrame } from "./device";
import { processPresentation } from "./process-endpoint";
import { codeStats, settleCode } from "../jvm/codecache";
import { offeredCount } from "../jvm/aot";
import { pendingCompilations } from "../jvm/tiering";

export type RealmWd = ReturnType<typeof realmWd>;
export function realmWd() {
  return {
    rt, tier, app: () => appHost, jvmCoverage, perf, mainDbg, guestClock: guestClockControl, nativeRequirements, native,
    code: () => ({ ...codeStats(), offered: offeredCount(), deferred: pendingCompilations() }),
    codeSettle: settleCode,
    // The same shape `uiautomator dump` reports, so the two hierarchies can be diffed directly:
    // absolute device px with the status bar included, which is the space a tap is expressed in.
    // A process that has ended shows no window; its own main loop answers nothing.
    uiTree: (): Promise<Awaited<ReturnType<typeof dumpWindows>>> => processExited() ? Promise.resolve([]) : onMain(dumpWindows),
    testFrame: (): Promise<void> => processPresentation.visible ? testFrame() : Promise.resolve(),
    tap: async (x: number, y: number): Promise<void> => {
      // a 60 ms press on the guest's clock, which a controlled clock would otherwise skip past. The
      // finger lifts on time however long the app takes to handle the press, as on a touchscreen:
      // a late UP would read as a long press.
      const down = dispatchPointer(0, x, y);
      await guestSleep(60);
      await Promise.all([down, dispatchPointer(1, x, y)]);
    },
  };
}
