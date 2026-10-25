// The power and battery services: the device profile's battery, and a screen that never sleeps.
import { awaited, JObj, noops, stubs, driven, type Gen } from "../jvm/runtime.ts";
import { jarray } from "../jvm/abi.ts";
import { newObj, vcall, after, staticField } from "../jvm/natives/jentry.ts";
import { device } from "../shell/config.ts";
import { newIntent, putExtra, registerSystemActivity } from "./intent.ts";
import { ownedBy, packages } from "./packages.ts";
import { persisted } from "../shell/device-storage.ts";
import type { PackageState } from "../shell/packagedata.ts";
import { procIdentity } from "../shell/procfs.ts";
import { callingIdentity, enforceCallingOrSelfPermission, hostService } from "./binder.ts";
import { stickyBroadcasts } from "./server/broadcastqueue.ts";

// IPowerManager: the screen is on and never dozes, battery saver is off, and wake locks are
// accepted, as nothing here sleeps. IThermalService: no thermal pressure (THERMAL_STATUS_NONE) and
// no headroom forecast (NaN, as on the reference AVD, which has no thermal HAL).
hostService("power", "webdroid/PowerManagerService", "android/os/IPowerManager$Stub", {
  ...stubs(1, "isInteractive()Z", "isWakeLockLevelSupported(I)Z"),
  ...stubs(0, "isPowerSaveMode()Z", "isDeviceIdleMode()Z", "isLightDeviceIdleMode()Z", "isLowPowerStandbyEnabled()Z", "isLowPowerStandbySupported()Z"),
  "getPowerSaveState(I)Landroid/os/PowerSaveState;": driven(function* () {
    return yield vcall(yield newObj("android/os/PowerSaveState$Builder"), "build", "()Landroid/os/PowerSaveState;");
  }),
  ...noops("acquireWakeLock(Landroid/os/IBinder;ILjava/lang/String;Ljava/lang/String;Landroid/os/WorkSource;Ljava/lang/String;ILandroid/os/IWakeLockCallback;)V",
    "acquireWakeLockAsync(Landroid/os/IBinder;ILjava/lang/String;Ljava/lang/String;Landroid/os/WorkSource;Ljava/lang/String;)V",
    "releaseWakeLock(Landroid/os/IBinder;I)V", "releaseWakeLockAsync(Landroid/os/IBinder;I)V",
    "updateWakeLockWorkSource(Landroid/os/IBinder;Landroid/os/WorkSource;Ljava/lang/String;)V",
    "updateWakeLockUids(Landroid/os/IBinder;[I)V", "updateWakeLockUidsAsync(Landroid/os/IBinder;[I)V",
    "updateWakeLockCallback(Landroid/os/IBinder;Landroid/os/IWakeLockCallback;)V"),
});
hostService("thermalservice", "webdroid/ThermalService", "android/os/IThermalService$Stub", {
  "getCurrentThermalStatus()I": () => 0,
  "getThermalHeadroom(I)F": () => NaN,
  // ThermalManagerService reports the current status to a listener as it registers
  "registerThermalStatusListener(Landroid/os/IThermalStatusListener;)Z": (listener: unknown) => after(vcall(listener, "onStatusChange", "(I)V", 0), () => 1),
  "unregisterThermalStatusListener(Landroid/os/IThermalStatusListener;)Z": () => 1,
});
// IDeviceIdleController's power-save allowlist, which PowerManager.isIgnoringBatteryOptimizations
// reads. The system's "let this app run in the background?" dialog, answered by the grant policy runtime
// permissions follow (permissions.ts). AOSP's activity ignores an app that did not declare the
// permission to ask, which reads as the user declining; the dialog runs in the asking process,
// which answers only for its own package.
/** the allowlist, by package: every package reads it, a data clear leaves it and the package's
 *  removal takes it, as DeviceIdleController's package-removed receiver does */
const allowlist = persisted("wd:deviceidle:", (saved) => saved === true ? true : null, { scope: "device-read" });
export const allowlistData: PackageState = { remove: (pkg) => allowlist.remove(pkg), packages: () => allowlist.packages() };
registerSystemActivity("android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS", driven(function* (intent: JObj) {
  const data: JObj | null = yield vcall(intent, "getData", "()Landroid/net/Uri;");
  const pkg: string | null = data && (yield vcall(data, "getScheme", "()Ljava/lang/String;")) === "package" ? yield vcall(data, "getSchemeSpecificPart", "()Ljava/lang/String;") : null;
  if (!pkg || !ownedBy(pkg, procIdentity.uid) || !packages.get(pkg)!.requested.has("android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS")) return null;
  allowlist.set(pkg, true);
  return newIntent();
}));
const exempt = (pkg: string) => +!!allowlist.get(pkg);
hostService("deviceidle", "webdroid/DeviceIdleController", "android/os/IDeviceIdleController$Stub", {
  "isPowerSaveWhitelistApp(Ljava/lang/String;)Z": exempt,
  "isPowerSaveWhitelistExceptIdleApp(Ljava/lang/String;)Z": exempt,
});

// IBatteryStats and IBatteryPropertiesRegistrar, under BatteryManager: the configured battery's
// capacity and status; any other property is NAME_NOT_FOUND, as healthd answers one its HAL lacks
const BATTERY_CAPACITY = 4, BATTERY_STATUS = 6, NAME_NOT_FOUND = -2;
/** BATTERY_STATUS_CHARGING or FULL, which the reference AVD reports as plugged into AC */
const pluggedIn = () => device.battery.status === 2 || device.battery.status === 5;
/** BatteryService's low level: unplugged at or under config_lowBatteryWarningLevel (20) */
export const batteryLow = (): boolean => !pluggedIn() && device.battery.level <= 20;
// the extras BatteryService puts on BATTERY_CHANGED that the battery model determines
stickyBroadcasts.set("android.intent.action.BATTERY_CHANGED", driven(function* (): Gen<JObj> {
  const intent = yield* awaited(newIntent("android.intent.action.BATTERY_CHANGED"));
  // as recorded on the reference AVD: REGISTERED_ONLY, REPLACE_PENDING, EXCLUDE_STOPPED_PACKAGES
  yield vcall(intent, "setFlags", "(I)Landroid/content/Intent;", 0x60000010);
  for (const [key, value, desc] of [["status", device.battery.status, "I"], ["health", 2, "I"], ["present", 1, "Z"],
    ["level", device.battery.level, "I"], ["scale", 100, "I"], ["plugged", pluggedIn() ? 1 : 0, "I"], ["battery_low", +batteryLow(), "Z"]] as const)
    yield putExtra(intent, key, value, desc);
  return intent;
}));
/** BatteryStatsService.takeUidSnapshot: no uid's usage is recorded here, so a snapshot holds no
 *  values; another uid's needs BATTERY_STATS */
const HPARCELER = "Landroid/os/health/HealthStatsParceler;";
function* uidSnapshot(uid: number): Gen<JObj> {
  if (uid !== callingIdentity().uid) yield enforceCallingOrSelfPermission("android.permission.BATTERY_STATS", null);
  return yield newObj("android/os/health/HealthStatsParceler", "(Landroid/os/health/HealthStatsWriter;)V", yield newObj("android/os/health/HealthStatsWriter",
    "(Landroid/os/health/HealthKeys$Constants;)V", yield staticField("android/os/health/UidHealthStats", "CONSTANTS")));
}
function* uidSnapshots(uids: Int32Array): Gen<JObj[]> {
  const snapshots: JObj[] = [];
  for (const uid of uids) snapshots.push(yield* uidSnapshot(uid));
  return jarray(snapshots, HPARCELER);
}
hostService("batterystats", "webdroid/BatteryStatsService", "com/android/internal/app/IBatteryStats$Stub", {
  "isCharging()Z": () => +pluggedIn(),
  "computeChargeTimeRemaining()J": () => -1n,
  [`takeUidSnapshot(I)${HPARCELER}`]: driven(uidSnapshot),
  [`takeUidSnapshots([I)[${HPARCELER}`]: driven(uidSnapshots),
  "takeUidSnapshotsAsync([ILandroid/os/ResultReceiver;)V": driven(function* (uids: Int32Array, receiver: JObj) {
    const result = yield newObj("android/os/Bundle", "(I)V", 1);
    yield vcall(result, "putParcelableArray", "(Ljava/lang/String;[Landroid/os/Parcelable;)V", "uid_snapshots", yield* uidSnapshots(uids));
    yield vcall(receiver, "send", "(ILandroid/os/Bundle;)V", 0, result);
  }),
});
// IPowerStatsService: present on every device; nothing here reads a power monitor
hostService("powerstats", "webdroid/PowerStatsService", "android/os/IPowerStatsService$Stub");
hostService("batteryproperties", "webdroid/BatteryPropertiesRegistrar", "android/os/IBatteryPropertiesRegistrar$Stub", {
  "getProperty(ILandroid/os/BatteryProperty;)I": (id: number, prop: JObj) => {
    const value = id === BATTERY_CAPACITY ? device.battery.level : id === BATTERY_STATUS ? device.battery.status : null;
    return value === null ? NAME_NOT_FOUND : after(vcall(prop, "setLong", "(J)V", BigInt(value)), () => 0);
  },
});
