import { JObj, rt } from "../jvm/runtime";
import { JPendingIntent, pendingId, localPendingIntents } from "./pendingintent";
import { Alarms } from "../shell/alarms";
import { reportUncaught, uptimeMillis } from "./os";

const localAlarms = new Alarms(localPendingIntents, uptimeMillis, reportUncaught);
export const alarmTransport = {
  schedule: (id: number, type: number, at: number, interval: number) => localAlarms.schedule(id, type, at, interval),
  cancel: (id: number) => localAlarms.cancel(id),
};
function schedule(type: number, at: bigint, operation: JPendingIntent, interval = 0) {
  if (type < 0 || type > 3) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid alarm type");
  if (!operation) throw rt.mkThrowable("java/lang/NullPointerException", "operation");
  alarmTransport.schedule(pendingId(operation), type, Math.max(0, Number(at)), interval);
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
      alarmTransport.cancel(pendingId(operation));
    },
    "canScheduleExactAlarms()Z": () => 1,
  },
});
