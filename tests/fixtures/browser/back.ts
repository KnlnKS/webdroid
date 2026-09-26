import "../../../src/natives";
import { onMain } from "../../../src/android/mainloop";
import { overlays } from "../../../src/android/popup";
import { JView } from "../../../src/android/view";
import { pressBack } from "../../../src/shell/device";

async function probe() {
  const events: string[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  overlays.push({ view: new JView(), x: 0, y: 0, dismissOnOutside: false,
    onBack: () => { events.push("back"); } });
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
