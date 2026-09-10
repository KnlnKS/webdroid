import { JObj, rt } from "../jvm/runtime";
import { JPendingIntent, sendIntent, watchPendingIntent } from "./broadcast";
import { JIntent } from "./intent";
import { reportUncaught, uptimeMillis } from "./os";

type Alarm = { type: number; at: number; interval: number; operation: JPendingIntent; unwatch: () => void };
const alarms = new Map<JObj, Alarm>();
let timer: ReturnType<typeof setTimeout> | null = null;
function remove(target: JObj) {
  const alarm = alarms.get(target);
  if (!alarm) return;
  alarms.delete(target); alarm.unwatch(); arm();
}
function arm() {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  let delay = Infinity;
  const wall = Date.now(), elapsed = uptimeMillis();
  for (const alarm of alarms.values()) delay = Math.min(delay, alarm.at - (alarm.type < 2 ? wall : elapsed));
  if (delay !== Infinity) timer = setTimeout(fire, Math.max(0, Math.min(delay, 0x7fffffff)));
}
function fire() {
  timer = null;
  const wall = Date.now(), elapsed = uptimeMillis();
  for (const [target, alarm] of alarms) {
    const now = alarm.type < 2 ? wall : elapsed;
    if (alarm.at > now) continue;
    const count = alarm.interval ? 1 + Math.floor((now - alarm.at) / alarm.interval) : 1;
    if (alarm.interval) alarm.at += count * alarm.interval;
    else { alarms.delete(target); alarm.unwatch(); }
    const fill = new JIntent(); fill.extras.map.set("android.intent.extra.ALARM_COUNT", Math.min(count, 0x7fffffff));
    void sendIntent(alarm.operation.sender, fill).catch(error => {
      if (alarms.get(target) === alarm) remove(target);
      if (!rt.iof(error, "android/app/PendingIntent$CanceledException")) reportUncaught(error);
    });
  }
  arm();
}
function schedule(type: number, at: bigint, operation: JPendingIntent, interval = 0) {
  if (type < 0 || type > 3) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid alarm type");
  if (!operation) throw rt.mkThrowable("java/lang/NullPointerException", "operation");
  const target = operation.sender.target;
  if (!target) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Missing intent sender");
  remove(target);
  const unwatch = watchPendingIntent(operation, () => remove(target));
  if (!unwatch) return;
  alarms.set(target, { type, at: Math.max(0, Number(at)), interval, operation, unwatch }); arm();
}
function repeating(type: number, at: bigint, interval: bigint, operation: JPendingIntent) {
  if (interval <= 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Non-positive alarm interval");
  schedule(type, at, operation, Number(interval));
}
rt.register({ name: "android/app/AlarmManager", ctor: class extends JObj {},
  statics: { RTC_WAKEUP: 0, RTC: 1, ELAPSED_REALTIME_WAKEUP: 2, ELAPSED_REALTIME: 3 }, methods: {
    "set(IJLandroid/app/PendingIntent;)V": schedule,
    "setExact(IJLandroid/app/PendingIntent;)V": schedule,
    "setAndAllowWhileIdle(IJLandroid/app/PendingIntent;)V": schedule,
    "setExactAndAllowWhileIdle(IJLandroid/app/PendingIntent;)V": schedule,
    "setWindow(IJJLandroid/app/PendingIntent;)V": (type: number, at: bigint, _window: bigint, operation: JPendingIntent) => schedule(type, at, operation),
    "setRepeating(IJJLandroid/app/PendingIntent;)V": repeating,
    "setInexactRepeating(IJJLandroid/app/PendingIntent;)V": repeating,
    "cancel(Landroid/app/PendingIntent;)V": (operation: JPendingIntent) => {
      if (!operation) throw rt.mkThrowable("java/lang/NullPointerException", "operation");
      if (operation.sender.target) remove(operation.sender.target);
    },
    "canScheduleExactAlarms()Z": () => 1,
  },
});
