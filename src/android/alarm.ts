// IAlarmManager, the TS half of AOSP's AlarmManager: PendingIntent alarms belong to the shell's
// scheduler (the broker's, across processes), and an OnAlarmListener's alarm fires in this process
// by calling its IAlarmListener. Exact alarms need the permission AlarmManagerService asks for.
import { awaited, JObj, rt, driven, type Gen } from "../jvm/runtime.ts";
import { newObj, vcall, after } from "../jvm/natives/jentry.ts";
import { logUncaught } from "../jvm/natives/jthrowable.ts";
import { postMain } from "./mainloop.ts";
import { operationId, localPendingIntents } from "./pendingintent.ts";
import { Alarms } from "../shell/alarms.ts";
import { clearGuestTimeout, setGuestTimeout, uptimeMillis, type GuestTimer } from "../guest-clock.ts";
import { packages, usesSdk } from "./packages.ts";

const localAlarms = new Alarms(localPendingIntents, uptimeMillis, logUncaught);
export const alarmTransport: {
  schedule(id: number, type: number, at: number, interval: number): void | Promise<void>;
  cancel(id: number): void | Promise<void>;
} = {
  schedule: (id: number, type: number, at: number, interval: number) => localAlarms.schedule(id, type, at, interval),
  cancel: (id: number) => localAlarms.cancel(id),
};

/** AlarmManagerService.hasScheduleExactAlarmInternal and the REQUIRE_EXACT_ALARM_PERMISSION change:
 *  an app targeting S or later needs USE_EXACT_ALARM (T or later) or SCHEDULE_EXACT_ALARM, which is
 *  denied by default from U */
function canScheduleExact(pkg: string): boolean {
  const record = packages.get(pkg);
  if (!record) return false;
  const target = usesSdk(record.root).target;
  return target < 31 || target >= 33 && record.permissions.has("android.permission.USE_EXACT_ALARM")
    || target < 34 && record.permissions.has("android.permission.SCHEDULE_EXACT_ALARM");
}
const listenerAlarms = new Map<unknown, GuestTimer>();
const WINDOW_EXACT = 0n;
rt.register({ name: "webdroid/AlarmManagerService", ctor: class extends JObj {}, sup: "android/app/IAlarmManager$Stub", methods: {
  "set(Ljava/lang/String;IJJJILandroid/app/PendingIntent;Landroid/app/IAlarmListener;Ljava/lang/String;Landroid/os/WorkSource;Landroid/app/AlarmManager$AlarmClockInfo;)V":
    driven(function* (pkg: string, type: number, at: bigint, window: bigint, interval: bigint, _flags: number, operation: JObj | null, listener: unknown): Gen<void> {
      if (type < 0 || type > 3) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid alarm type " + type);
      if (window === WINDOW_EXACT && !canScheduleExact(pkg))
        throw rt.mkThrowable("java/lang/SecurityException", `Caller ${pkg} needs to hold android.permission.SCHEDULE_EXACT_ALARM or android.permission.USE_EXACT_ALARM to set exact alarms.`);
      const trigger = Math.max(0, Number(at));
      if (operation) { yield* awaited(alarmTransport.schedule(yield* awaited(operationId(operation)), type, trigger, Number(interval))); return; }
      clearGuestTimeout(listenerAlarms.get(listener));
      const delay = trigger - (type < 2 ? Date.now() : uptimeMillis());
      listenerAlarms.set(listener, setGuestTimeout(() => {
        listenerAlarms.delete(listener);
        postMain(() => after(newObj("webdroid/AlarmCompleteListener"), (done) =>
          vcall(listener, "doAlarm", "(Landroid/app/IAlarmCompleteListener;)V", done)));
      }, Math.max(0, Math.min(delay, 0x7fffffff))));
    }),
  "remove(Landroid/app/PendingIntent;Landroid/app/IAlarmListener;)V": driven(function* (operation: JObj | null, listener: unknown): Gen<void> {
    if (operation) yield* awaited(alarmTransport.cancel(yield* awaited(operationId(operation))));
    if (listener) { clearGuestTimeout(listenerAlarms.get(listener)); listenerAlarms.delete(listener); }
  }),
  "canScheduleExactAlarms(Ljava/lang/String;)Z": (pkg: string) => +canScheduleExact(pkg),
  "hasScheduleExactAlarm(Ljava/lang/String;I)Z": (pkg: string) => +canScheduleExact(pkg),
  // no alarm clock is set on this device
  "getNextAlarmClock(I)Landroid/app/AlarmManager$AlarmClockInfo;": () => null,
} });
// a listener alarm's completion: nothing waits on it here, as no wake lock is held for delivery
rt.register({ name: "webdroid/AlarmCompleteListener", ctor: class extends JObj {}, sup: "android/app/IAlarmCompleteListener$Stub", methods: {
  "alarmComplete(Landroid/os/IBinder;)V": () => {},
} });
