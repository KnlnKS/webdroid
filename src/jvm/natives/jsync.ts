import { rt } from "../runtime";
import { parkTimeout, unparkTimeout } from "../yield";
import { JThread, curThread } from "./jlang";

// A parked thread wakes on its permit, its deadline, or an interrupt, which leaves the interrupt
// status set rather than throwing (LockSupport.park). The wake is a macrotask so the unparker's
// own chain runs to its next await first, and an untimed park still polls, as Java's spurious
// wakeups allow, so a permit lost to a stale thread identity cannot hang it.
function parkThread(t: JThread, timeoutMs?: number): void | Promise<void> {
  if (t.permit) { t.permit = false; return; }
  if (t.interrupted) return;
  return new Promise<void>((resolve) => {
    const done = () => { t.parked = 0; t.wake = null; t.unpark = null; unparkTimeout(id); t.permit = false; resolve(); };
    const id = parkTimeout(done, timeoutMs ?? 1000);
    t.parked = timeoutMs === undefined ? 3 : 4;
    t.unpark = () => setTimeout(done, 0);
    t.wake = done;
  });
}
const unparkThread = (t: JThread | null) => { if (!t) return; if (t.unpark) { t.unpark(); t.unpark = null; } else t.permit = true; };
// libcore's LockSupport parks through Unsafe: `absolute` times are epoch milliseconds, others
// nanoseconds, and 0 is no deadline
rt.registerJni("jdk/internal/misc/Unsafe", "park(ZJ)V", (absolute: number, time: bigint) =>
  parkThread(curThread, absolute ? Math.max(0, Number(time) - Date.now()) : time > 0n ? Number(time) / 1e6 : undefined));
rt.registerJni("jdk/internal/misc/Unsafe", "unpark(Ljava/lang/Object;)V", unparkThread);
