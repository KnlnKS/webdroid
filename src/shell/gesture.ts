import { device } from "./config.ts";
import { dispatchPointer } from "./device.ts";
import { guestNow, guestSleep, uptimeMillis } from "../guest-clock.ts";

/** Scheduled sample uptime survives delayed delivery, so catch-up samples
 * don't turn a constant-speed drag into an accelerating fling. */
export async function swipe(x1: number, y1: number, x2: number, y2: number, ms = 400): Promise<void> {
  const steps = Math.max(2, Math.round(ms * device.refreshRate / 1000));
  const t0 = guestNow(), eventStart = uptimeMillis();
  void dispatchPointer(0, x1, y1, eventStart);
  for (let i = 1; i <= steps; i++) {
    const at = t0 + ms * i / steps, t = i / steps;
    await guestSleep(Math.max(0, at - guestNow()));
    void dispatchPointer(2, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, eventStart + ms * t);
  }
  await dispatchPointer(1, x2, y2, eventStart + ms);
}
