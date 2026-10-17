// The harness surface (`wd`, tests/e2e/drivers/webdroid.ts) every process realm has: its app, its
// diagnostics, and its own windows, frames and touches. The page's `wd` adds the process Workers
// the broker shows beneath its system windows.
import { rt } from "../jvm/runtime.ts";
import { appHost } from "../android/apphost.ts";
import { perf } from "../perf.ts";
import { mainDbg, onMain } from "../android/mainloop.ts";
import { guestClockControl, guestSleep } from "../guest-clock.ts";
import { nativeRequirements } from "./diagnostics.ts";
import { native } from "../native/debug.ts";
import { processExited } from "../process-exit.ts";
import { dumpWindows } from "./uiautomator.ts";
import { dispatchPointer, testFrame } from "./device.ts";
import { processPresentation } from "./process-endpoint.ts";

export type RealmWd = ReturnType<typeof realmWd>;
export function realmWd() {
  return {
    rt, app: () => appHost, perf, mainDbg, guestClock: guestClockControl, nativeRequirements, native,
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
