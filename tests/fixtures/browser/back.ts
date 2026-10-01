import "../../../src/natives";
import { onMain } from "../../../src/android/mainloop";
import { overlays } from "../../../src/android/popup";
import { JView } from "../../../src/android/view";
import { keyActionOf } from "../../../src/android/keyevent";
import type { JObj } from "../../../src/jvm/runtime";
import { mangleMethod } from "../../../src/jvm/abi";
import { pressBack } from "../../../src/shell/device";
import { loadPlatformDex } from "../../../src/android/framework";
import { rt } from "../../../src/jvm/runtime";
import { startMainLooper } from "../../../src/android/mainloop";

async function probe() {
  await loadPlatformDex();
  rt.linkNatives();
  await startMainLooper();
  const events: string[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const view = Object.assign(new JView(), {
    [mangleMethod("dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z")]: (ev: JObj) => { if (keyActionOf(ev) === 1) events.push("back"); return 1; },
  });
  overlays.push({ view, x: 0, y: 0, flags: 0 });
  try {
    const job = onMain(async () => {
      events.push("start");
      entered.resolve();
      await release.promise;
      events.push("end");
    });
    await entered.promise;
    const back = pressBack();
    await Promise.resolve();
    const pending = events.slice();
    release.resolve();
    await Promise.all([job, back]);
    return { pending, events };
  } finally { overlays.pop(); }
}
export default probe;
