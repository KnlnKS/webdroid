// IAlarmManager: AlarmManagerService, hosted once in system_server (SYSTEM_SERVICES), with one table of
// alarms and one timer for the next. A PendingIntent's alarm is sent by the broker's records as its
// creator made it, and goes when the record is canceled; an OnAlarmListener's fires by a call to its
// IAlarmListener, unless the listener's process died first. Exact alarms need the permission
// AlarmManagerService asks for.
import { awaited, JObj, rt, driven, type Gen } from "../jvm/runtime.ts";
import { asBinder, callingIdentity, checkCallingPackage, hostService, newStub, onCallerDeath, oneway } from "./binder.ts";
import { logUncaught, notConnected, unconnected } from "../jvm/natives/jthrowable.ts";
import { operationId } from "./pendingintent.ts";
import type { PendingIntents } from "../shell/pendingintents.ts";
import type { PackageState } from "../shell/packagedata.ts";
import { clearGuestTimeout, setSystemTimeout, uptimeMillis, wallMillis, type GuestTimer } from "../guest-clock.ts";
import { packages, usesSdk } from "./packages.ts";

/** the broker's PendingIntent records, which system_server's realm takes */
let intents: Pick<PendingIntents, "get" | "watch" | "send"> = { get: unconnected, watch: unconnected, send: notConnected };
export function useAlarmIntents(records: Pick<PendingIntents, "get" | "watch" | "send">): void { intents = records; }
/** a type's clock: RTC and RTC_WAKEUP the wall's, ELAPSED_REALTIME and its wakeup the uptime's */
const now = (type: number) => type < 2 ? wallMillis() : uptimeMillis();
type Alarm = { type: number; at: number; interval: number; uid: number; unwatch: () => void; fire: (count: number) => void };
/** the alarms, by their PendingIntent record's id or their listener's binder */
const alarms = new Map<number | JObj, Alarm>();
let timer: GuestTimer | null = null;
function arm(): void {
  if (timer !== null) { clearGuestTimeout(timer); timer = null; }
  let delay = Infinity;
  for (const alarm of alarms.values()) delay = Math.min(delay, alarm.at - now(alarm.type));
  if (delay !== Infinity) timer = setSystemTimeout(fire, Math.max(0, Math.min(delay, 0x7fffffff)));
}
/** what is due fires, a repeating alarm once for the intervals it missed */
function fire(): void {
  timer = null;
  for (const [key, alarm] of alarms) {
    const at = now(alarm.type);
    if (alarm.at > at) continue;
    const count = alarm.interval ? 1 + Math.floor((at - alarm.at) / alarm.interval) : 1;
    if (alarm.interval) alarm.at += count * alarm.interval;
    else { alarms.delete(key); alarm.unwatch(); }
    alarm.fire(Math.min(count, 0x7fffffff));
  }
  arm();
}
function add(key: number | JObj, alarm: Alarm): void { alarms.set(key, alarm); arm(); }
export function removeAlarm(key: number | JObj): void {
  const alarm = alarms.get(key);
  if (!alarm) return;
  alarms.delete(key); alarm.unwatch(); arm();
}
/** an alarm sending PendingIntent record `id`, in place of one it had */
export function setOperationAlarm(id: number, type: number, at: number, interval: number): void {
  removeAlarm(id);
  const unwatch = intents.watch(id, () => removeAlarm(id)), operation = intents.get(id);
  if (!unwatch || !operation) return;
  const alarm: Alarm = { type, at, interval, uid: operation.uid, unwatch, fire: (count) => void intents.send(id, null, count).catch((error) => {
    if (alarms.get(id) === alarm) removeAlarm(id);
    logUncaught(error);
  }) };
  add(id, alarm);
}
/** a package's data clear: AlarmManagerInternal.removeAlarmsForUid */
export const alarmData: PackageState = { clear(_pkg, uid) { for (const [key, alarm] of alarms) if (alarm.uid === uid) removeAlarm(key); } };

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
let completion: JObj | Promise<JObj> | undefined;
const WINDOW_EXACT = 0n;
hostService("alarm", "webdroid/AlarmManagerService", "android/app/IAlarmManager$Stub", {
  "set(Ljava/lang/String;IJJJILandroid/app/PendingIntent;Landroid/app/IAlarmListener;Ljava/lang/String;Landroid/os/WorkSource;Landroid/app/AlarmManager$AlarmClockInfo;)V":
    driven(function* (pkg: string, type: number, at: bigint, window: bigint, interval: bigint, _flags: number, operation: JObj | null, listener: JObj | null): Gen<void> {
      const { pid, uid } = callingIdentity();
      checkCallingPackage(pkg);
      if (type < 0 || type > 3) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid alarm type " + type);
      if (window === WINDOW_EXACT && !canScheduleExact(pkg))
        throw rt.mkThrowable("java/lang/SecurityException", `Caller ${pkg} needs to hold android.permission.SCHEDULE_EXACT_ALARM or android.permission.USE_EXACT_ALARM to set exact alarms.`);
      const trigger = Math.max(0, Number(at));
      if (operation) { setOperationAlarm(yield* awaited(operationId(operation)), type, trigger, Number(interval)); return; }
      if (!listener) return;
      const binder: JObj = yield asBinder(listener), done = (yield* awaited(completion ??= newStub("webdroid/AlarmCompleteListener"))) as JObj;
      removeAlarm(binder);
      // a listener's alarm fires once; its process's death removes it
      add(binder, { type, at: trigger, interval: 0, uid, unwatch: onCallerDeath(pid, () => removeAlarm(binder)),
        fire: () => oneway(listener, "doAlarm", "(Landroid/app/IAlarmCompleteListener;)V", done) });
    }),
  "remove(Landroid/app/PendingIntent;Landroid/app/IAlarmListener;)V": driven(function* (operation: JObj | null, listener: JObj | null): Gen<void> {
    if (operation) removeAlarm(yield* awaited(operationId(operation)));
    if (listener) removeAlarm(yield asBinder(listener));
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
