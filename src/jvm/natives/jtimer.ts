import { JObj, rt } from "../runtime";
import { vcallAsync } from "./jlang";
import { clearGuestInterval, clearGuestTimeout, setGuestInterval, setGuestTimeout, type GuestTimer } from "../../guest-clock";

// java.util.Timer: one background timer thread per Timer in the JDK; here the tasks are host
// timers, cancelled together with the Timer that scheduled them.
class JTimerTask extends JObj { handle: GuestTimer | null = null; repeating = false; }
class JTimer extends JObj { tasks = new Set<JTimerTask>(); }
function timerCancel(t: JTimerTask) {
  if (t.handle === null) return;
  if (t.repeating) clearGuestInterval(t.handle); else clearGuestTimeout(t.handle);
  t.handle = null;
}
function schedule(timer: JTimer, task: JTimerTask, delay: number, period = 0) {
  timer.tasks.add(task);
  task.repeating = period > 0;
  const run = () => { void vcallAsync(task, "run", "()V").catch(() => {}); };
  task.handle = period > 0
    ? setGuestTimeout(() => { run(); task.handle = setGuestInterval(run, period); }, Math.max(0, delay))
    : setGuestTimeout(() => { task.handle = null; timer.tasks.delete(task); run(); }, Math.max(0, delay));
}
rt.register({
  name: "java/util/TimerTask", ctor: JTimerTask, ifaces: ["java/lang/Runnable"],
  methods: {
    "<init>()V": function () {},
    "run()V": function () {},
    "cancel()Z": function (this: JTimerTask) { const live = this.handle !== null; timerCancel(this); return live ? 1 : 0; },
    "scheduledExecutionTime()J": () => BigInt(Date.now()),
  },
});
rt.register({
  name: "java/util/Timer", ctor: JTimer,
  methods: {
    "<init>()V": function () {},
    "<init>(Z)V": function () {},
    "<init>(Ljava/lang/String;)V": function () {},
    "<init>(Ljava/lang/String;Z)V": function () {},
    "schedule(Ljava/util/TimerTask;J)V": function (this: JTimer, t: JTimerTask, d: bigint) { schedule(this, t, Number(d)); },
    "schedule(Ljava/util/TimerTask;JJ)V": function (this: JTimer, t: JTimerTask, d: bigint, p: bigint) { schedule(this, t, Number(d), Number(p)); },
    "schedule(Ljava/util/TimerTask;Ljava/util/Date;)V": function (this: JTimer, t: JTimerTask, when: { t?: number }) {
      schedule(this, t, (when?.t ?? Date.now()) - Date.now());
    },
    "scheduleAtFixedRate(Ljava/util/TimerTask;JJ)V": function (this: JTimer, t: JTimerTask, d: bigint, p: bigint) { schedule(this, t, Number(d), Number(p)); },
    "cancel()V": function (this: JTimer) { for (const t of this.tasks) timerCancel(t); this.tasks.clear(); },
    "purge()I": function (this: JTimer) { for (const t of [...this.tasks]) if (t.handle === null) this.tasks.delete(t); return 0; },
  },
});
