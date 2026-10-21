// IAlarmManager: AlarmManagerService, hosted once in system_server (SYSTEM_SERVICES). A PendingIntent's
// alarm is the broker's scheduler's (shell/alarms.ts), which sends it as its creator made it; an
// OnAlarmListener's fires by a call to its IAlarmListener, unless the listener's process died first.
// Exact alarms need the permission AlarmManagerService asks for.
import { awaited, JObj, rt, driven, type Gen } from "../jvm/runtime.ts";
import { asBinder, callingIdentity, hostService, newStub, onCallerDeath, oneway } from "./binder.ts";
import { notConnected } from "../jvm/natives/jthrowable.ts";
import { operationId } from "./pendingintent.ts";
import type { Alarms } from "../shell/alarms.ts";
import { clearGuestTimeout, setSystemTimeout, uptimeMillis, wallMillis, type GuestTimer } from "../guest-clock.ts";
import { ownedBy, packages, usesSdk } from "./packages.ts";

/** the PendingIntent alarms' scheduler, which system_server's realm takes from the broker */
let scheduler: Pick<Alarms, "schedule" | "cancel"> = { schedule: notConnected, cancel: notConnected };
export function useAlarmScheduler(alarms: Pick<Alarms, "schedule" | "cancel">): void { scheduler = alarms; }

/** AlarmManagerService.hasScheduleExactAlarmInternal and the REQUIRE_EXACT_ALARM_PERMISSION change:
 *  an app targeting S or later needs USE_EXACT_ALARM (T or later) or SCHEDULE_EXACT_ALARM, which is
 *  denied by default from U */
function canScheduleExact(pkg: string): boolean {
  const record = packages.get(pkg);
  if (!record) return false;
  const target = usesSdk(record.root).target;
  return target < 31 || target >= 33 && record.requested.has("android.permission.USE_EXACT_ALARM")
    || target < 34 && record.requested.has("android.permission.SCHEDULE_EXACT_ALARM");
}
/** AppOpsManager.checkPackage, as set() makes it of its caller */
function checkPackage(pkg: string, uid: number): void {
  if (!ownedBy(pkg, uid)) throw rt.mkThrowable("java/lang/SecurityException", `Package ${pkg} does not belong to ${uid}`);
}
/** each listener's pending alarm by the listener's binder; its process's death removes it */
const listenerAlarms = new Map<unknown, { timer: GuestTimer; unwatch: () => void }>();
function removeListener(binder: unknown): void {
  const alarm = listenerAlarms.get(binder);
  if (!alarm) return;
  listenerAlarms.delete(binder); clearGuestTimeout(alarm.timer); alarm.unwatch();
}
let completion: JObj | Promise<JObj> | undefined;
const WINDOW_EXACT = 0n;
hostService("alarm", "webdroid/AlarmManagerService", "android/app/IAlarmManager$Stub", {
  "set(Ljava/lang/String;IJJJILandroid/app/PendingIntent;Landroid/app/IAlarmListener;Ljava/lang/String;Landroid/os/WorkSource;Landroid/app/AlarmManager$AlarmClockInfo;)V":
    driven(function* (pkg: string, type: number, at: bigint, window: bigint, interval: bigint, _flags: number, operation: JObj | null, listener: JObj | null): Gen<void> {
      const { pid, uid } = callingIdentity();
      checkPackage(pkg, uid);
      if (type < 0 || type > 3) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid alarm type " + type);
      if (window === WINDOW_EXACT && !canScheduleExact(pkg))
        throw rt.mkThrowable("java/lang/SecurityException", `Caller ${pkg} needs to hold android.permission.SCHEDULE_EXACT_ALARM or android.permission.USE_EXACT_ALARM to set exact alarms.`);
      const trigger = Math.max(0, Number(at));
      if (operation) { yield* awaited(scheduler.schedule(yield* awaited(operationId(operation)), type, trigger, Number(interval))); return; }
      if (!listener) return;
      const binder = yield asBinder(listener), done = (yield* awaited(completion ??= newStub("webdroid/AlarmCompleteListener"))) as JObj;
      removeListener(binder);
      const delay = trigger - (type < 2 ? wallMillis() : uptimeMillis());
      const timer = setSystemTimeout(() => {
        removeListener(binder);
        oneway(listener, "doAlarm", "(Landroid/app/IAlarmCompleteListener;)V", done);
      }, Math.max(0, delay));
      listenerAlarms.set(binder, { timer, unwatch: onCallerDeath(pid, () => removeListener(binder)) });
    }),
  "remove(Landroid/app/PendingIntent;Landroid/app/IAlarmListener;)V": driven(function* (operation: JObj | null, listener: JObj | null): Gen<void> {
    if (operation) yield* awaited(scheduler.cancel(yield* awaited(operationId(operation))));
    if (listener) removeListener(yield asBinder(listener));
  }),
  "canScheduleExactAlarms(Ljava/lang/String;)Z": (pkg: string) => +canScheduleExact(pkg),
  "hasScheduleExactAlarm(Ljava/lang/String;I)Z": (pkg: string) => +canScheduleExact(pkg),
  // no alarm clock is set on this device
  "getNextAlarmClock(I)Landroid/app/AlarmManager$AlarmClockInfo;": () => null,
}, { system: true });
// a listener alarm's completion: nothing waits on it here, as no wake lock is held for delivery
rt.register({ name: "webdroid/AlarmCompleteListener", ctor: class extends JObj {}, sup: "android/app/IAlarmCompleteListener$Stub", methods: {
  "alarmComplete(Landroid/os/IBinder;)V": () => {},
} });
