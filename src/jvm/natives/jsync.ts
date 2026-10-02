import { rt } from "../runtime";
import { parkTimeout, unparkTimeout, yieldToLoop } from "../yield";
import { wallMillis } from "../../guest-clock";
import { JThread, curThread } from "./jlang";

// A parked thread wakes on its permit, its deadline, or an interrupt, which leaves the interrupt
// status set rather than throwing (LockSupport.park). The wake is a macrotask so the unparker's
// own chain runs to its next await first, and an untimed park still polls, as Java's spurious
// wakeups allow, so a permit lost to a stale thread identity cannot hang it. The macrotask is the
// yield channel's: a clamped setTimeout cost each executor handoff 1 to 4 ms.
function parkThread(t: JThread, timeoutMs?: number): void | Promise<void> {
  if (t.permit) { t.permit = false; return; }
  if (t.interrupted) return;
  return new Promise<void>((resolve) => {
    let woken = false;
    // the first of permit, deadline and interrupt wakes it; a later one must not touch the next park
    const done = () => {
      if (woken) return;
      woken = true; t.parked = 0; t.wake = null; t.unpark = null; unparkTimeout(id); t.permit = false; resolve();
    };
    const id = parkTimeout(done, timeoutMs ?? 1000);
    t.parked = timeoutMs === undefined ? 3 : 4;
    t.unpark = () => void yieldToLoop().then(done);
    t.wake = done;
  });
}
const unparkThread = (t: JThread | null) => { if (!t) return; if (t.unpark) { t.unpark(); t.unpark = null; } else t.permit = true; };
// libcore's LockSupport parks through Unsafe: `absolute` times are epoch milliseconds, others
// nanoseconds, and 0 is no deadline
rt.registerJni("jdk/internal/misc/Unsafe", "park(ZJ)V", (absolute: number, time: bigint) =>
  parkThread(curThread, absolute ? Math.max(0, Number(time) - wallMillis()) : time > 0n ? Number(time) / 1e6 : undefined));
rt.registerJni("jdk/internal/misc/Unsafe", "unpark(Ljava/lang/Object;)V", unparkThread);
// libcore's AtomicLong asks whether the VM compares-and-sets 8 bytes without a lock; JS does
rt.registerJni("java/util/concurrent/atomic/AtomicLong", "VMSupportsCS8()Z", () => 1);
