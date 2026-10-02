// The TS Context classes and the helpers over them, which only the TS view layer and activity stack
// (shell/activities.ts) still reach: AOSP's ContextImpl and ContextWrapper are the app's contexts.
import { JObj, rt } from "../jvm/runtime";
import { type AppHost, appHost } from "./apphost";
import { resString } from "./res";
import { newObj, scall, vcall } from "../jvm/natives/jlang";
import { getInflater } from "./inflate";
import { mainHandler } from "./mainloop";
import { hostedService } from "./binder";

export class JContext extends JObj { declare $host: AppHost; }
class JContextImpl extends JContext { resources: unknown = null; }
export function newContextImpl(host: AppHost): JContextImpl {
  const context: JContextImpl = rt.make("android/app/ContextImpl");
  context.$host = host; context.resources = host.jresources;
  return context;
}
export class JContextWrapper extends JContext { base: JContext | null = null; }
export class JContextThemeWrapper extends JContextWrapper {}

const services = new Map<string, unknown>();
/** a string resource of the running app ("" before boot) */
export const appString = (id: number) => (appHost ? resString(appHost.res, id) : "");
// Context.XXX_SERVICE name → the manager class; getSystemService(Class) walks it backwards.
const SERVICE_CLASS: Record<string, string> = {
  window: "android/view/WindowManagerImpl",
  input_method: "android/view/inputmethod/InputMethodManager",
  print: "android/print/PrintManager",
  autofill: "android/view/autofill/AutofillManager",
};
const mainLooper = () => vcall(mainHandler(), "getLooper", "()Landroid/os/Looper;");
/** managers AOSP's bytecode serves over the services hosted behind binder, constructed as
 *  SystemServiceRegistry constructs them (for the application: this cache is per process) */
const AOSP_MANAGERS: Record<string, [cls: string, make: (ctx: unknown) => Promise<unknown>]> = {
  display: ["android/hardware/display/DisplayManager", (ctx) => newObj("android/hardware/display/DisplayManager", "(Landroid/content/Context;)V", ctx)],
  input: ["android/hardware/input/InputManager", (ctx) => newObj("android/hardware/input/InputManager", "(Landroid/content/Context;)V", ctx)],
  activity: ["android/app/ActivityManager", (ctx) => newObj("android/app/ActivityManager", "(Landroid/content/Context;Landroid/os/Handler;)V", ctx, mainHandler())],
  power: ["android/os/PowerManager", async (ctx) => newObj("android/os/PowerManager",
    "(Landroid/content/Context;Landroid/os/IPowerManager;Landroid/os/IThermalService;Landroid/os/Handler;)V",
    ctx, await hostedService("power"), await hostedService("thermalservice"), mainHandler())],
  deviceidle: ["android/os/DeviceIdleManager", async (ctx) =>
    newObj("android/os/DeviceIdleManager", "(Landroid/content/Context;Landroid/os/IDeviceIdleController;)V", ctx, await hostedService("deviceidle"))],
  power_exemption: ["android/os/PowerExemptionManager", (ctx) => newObj("android/os/PowerExemptionManager", "(Landroid/content/Context;)V", ctx)],
  user: ["android/os/UserManager", async (ctx) =>
    newObj("android/os/UserManager", "(Landroid/content/Context;Landroid/os/IUserManager;)V", ctx, await hostedService("user"))],
  uimode: ["android/app/UiModeManager", (ctx) => newObj("android/app/UiModeManager", "(Landroid/content/Context;)V", ctx)],
  alarm: ["android/app/AlarmManager", async (ctx) =>
    newObj("android/app/AlarmManager", "(Landroid/app/IAlarmManager;Landroid/content/Context;)V", await hostedService("alarm"), ctx)],
  clipboard: ["android/content/ClipboardManager", (ctx) => newObj("android/content/ClipboardManager", "(Landroid/content/Context;Landroid/os/Handler;)V", ctx, mainHandler())],
  vibrator_manager: ["android/os/VibratorManager", (ctx) => newObj("android/os/SystemVibratorManager", "(Landroid/content/Context;)V", ctx)],
  vibrator: ["android/os/Vibrator", (ctx) => newObj("android/os/SystemVibrator", "(Landroid/content/Context;)V", ctx)],
  notification: ["android/app/NotificationManager", (ctx) => newObj("android/app/NotificationManager", "(Landroid/content/Context;Landroid/os/Handler;)V", ctx, mainHandler())],
  keyguard: ["android/app/KeyguardManager", (ctx) => newObj("android/app/KeyguardManager", "(Landroid/content/Context;)V", ctx)],
  usagestats: ["android/app/usage/UsageStatsManager", async (ctx) => newObj("android/app/usage/UsageStatsManager",
    "(Landroid/content/Context;Landroid/app/usage/IUsageStatsManager;)V", ctx, await hostedService("usagestats"))],
  jobscheduler: ["android/app/job/JobScheduler", async (ctx) =>
    newObj("android/app/JobSchedulerImpl", "(Landroid/content/Context;Landroid/app/job/IJobScheduler;)V", ctx, await hostedService("jobscheduler"))],
  location: ["android/location/LocationManager", async (ctx) =>
    newObj("android/location/LocationManager", "(Landroid/content/Context;Landroid/location/ILocationManager;)V", ctx, await hostedService("location"))],
  account: ["android/accounts/AccountManager", async (ctx) =>
    newObj("android/accounts/AccountManager", "(Landroid/content/Context;Landroid/accounts/IAccountManager;)V", ctx, await hostedService("account"))],
  permission_enforcer: ["android/os/PermissionEnforcer", (ctx) => newObj("android/os/PermissionEnforcer", "(Landroid/content/Context;)V", ctx)],
  shortcut: ["android/content/pm/ShortcutManager", (ctx) => newObj("android/content/pm/ShortcutManager", "(Landroid/content/Context;)V", ctx)],
  crossprofileapps: ["android/content/pm/CrossProfileApps", async (ctx) =>
    newObj("android/content/pm/CrossProfileApps", "(Landroid/content/Context;Landroid/content/pm/ICrossProfileApps;)V", ctx, await hostedService("crossprofileapps"))],
  permission: ["android/permission/PermissionManager", (ctx) => newObj("android/permission/PermissionManager", "(Landroid/content/Context;)V", ctx)],
  legacy_permission: ["android/permission/LegacyPermissionManager", () => newObj("android/permission/LegacyPermissionManager")],
  locale: ["android/app/LocaleManager", async (ctx) =>
    newObj("android/app/LocaleManager", "(Landroid/content/Context;Landroid/app/ILocaleManager;)V", ctx, await hostedService("locale"))],
  textservices: ["android/view/textservice/TextServicesManager", async (ctx) => scall("android/view/textservice/TextServicesManager",
    "createInstance", "(Landroid/content/Context;)Landroid/view/textservice/TextServicesManager;", ctx)],
  game: ["android/app/GameManager", (ctx) => newObj("android/app/GameManager", "(Landroid/content/Context;Landroid/os/Handler;)V", ctx, mainHandler())],
  dropbox: ["android/os/DropBoxManager", async (ctx) => newObj("android/os/DropBoxManager",
    "(Landroid/content/Context;Lcom/android/internal/os/IDropBoxManagerService;)V", ctx, await hostedService("dropbox"))],
  restrictions: ["android/content/RestrictionsManager", async (ctx) =>
    newObj("android/content/RestrictionsManager", "(Landroid/content/Context;Landroid/content/IRestrictionsManager;)V", ctx, await hostedService("restrictions"))],
  accessibility: ["android/view/accessibility/AccessibilityManager", async (ctx) => scall("android/view/accessibility/AccessibilityManager",
    "getInstance", "(Landroid/content/Context;)Landroid/view/accessibility/AccessibilityManager;", ctx)],
  fingerprint: ["android/hardware/fingerprint/FingerprintManager", async (ctx) =>
    newObj("android/hardware/fingerprint/FingerprintManager", "(Landroid/content/Context;Landroid/hardware/fingerprint/IFingerprintService;)V", ctx, null)],
  biometric: ["android/hardware/biometrics/BiometricManager", async (ctx) =>
    newObj("android/hardware/biometrics/BiometricManager", "(Landroid/content/Context;Landroid/hardware/biometrics/IAuthService;)V", ctx, await hostedService("auth"))],
  usb: ["android/hardware/usb/UsbManager", async (ctx) =>
    newObj("android/hardware/usb/UsbManager", "(Landroid/content/Context;Landroid/hardware/usb/IUsbManager;)V", ctx, await hostedService("usb"))],
  appops: ["android/app/AppOpsManager", async (ctx) =>
    newObj("android/app/AppOpsManager", "(Landroid/content/Context;Lcom/android/internal/app/IAppOpsService;)V", ctx, await hostedService("appops"))],
  batterymanager: ["android/os/BatteryManager", async (ctx) => newObj("android/os/BatteryManager",
    "(Landroid/content/Context;Lcom/android/internal/app/IBatteryStats;Landroid/os/IBatteryPropertiesRegistrar;)V",
    ctx, await hostedService("batterystats"), await hostedService("batteryproperties"))],
  audio: ["android/media/AudioManager", (ctx) => newObj("android/media/AudioManager", "(Landroid/content/Context;)V", ctx)],
  sensor: ["android/hardware/SensorManager", async (ctx) =>
    newObj("android/hardware/SystemSensorManager", "(Landroid/content/Context;Landroid/os/Looper;)V", ctx, await mainLooper())],
  storage: ["android/os/storage/StorageManager", async (ctx) =>
    newObj("android/os/storage/StorageManager", "(Landroid/content/Context;Landroid/os/Looper;)V", ctx, await mainLooper())],
  phone: ["android/telephony/TelephonyManager", (ctx) => newObj("android/telephony/TelephonyManager", "(Landroid/content/Context;)V", ctx)],
  telephony_subscription_service: ["android/telephony/SubscriptionManager",
    (ctx) => newObj("android/telephony/SubscriptionManager", "(Landroid/content/Context;)V", ctx)],
  // WifiFrameworkInitializer's fetcher: a WifiManager when the device has Wi-Fi
  wifi: ["android/net/wifi/WifiManager", async (ctx) => scall("android/net/wifi/WifiFrameworkInitializer", "lambda$registerServiceWrappers$0",
    "(Landroid/content/Context;Landroid/os/IBinder;)Landroid/net/wifi/WifiManager;", ctx, await hostedService("wifi"))],
  bluetooth: ["android/bluetooth/BluetoothManager", (ctx) => newObj("android/bluetooth/BluetoothManager", "(Landroid/content/Context;)V", ctx)],
  nfc: ["android/nfc/NfcManager", (ctx) => newObj("android/nfc/NfcManager", "(Landroid/content/Context;)V", ctx)],
  appwidget: ["android/appwidget/AppWidgetManager", async (ctx) => newObj("android/appwidget/AppWidgetManager",
    "(Landroid/content/Context;Lcom/android/internal/appwidget/IAppWidgetService;)V", ctx, await scall("com/android/internal/appwidget/IAppWidgetService$Stub",
      "asInterface", "(Landroid/os/IBinder;)Lcom/android/internal/appwidget/IAppWidgetService;", await hostedService("appwidget")))],
  performance_hint: ["android/os/PerformanceHintManager", async () => scall("android/os/PerformanceHintManager", "create", "()Landroid/os/PerformanceHintManager;")],
  systemhealth: ["android/os/health/SystemHealthManager", () => newObj("android/os/health/SystemHealthManager")],
  storagestats: ["android/app/usage/StorageStatsManager", async (ctx) => newObj("android/app/usage/StorageStatsManager",
    "(Landroid/content/Context;Landroid/app/usage/IStorageStatsManager;)V", ctx, await scall("android/app/usage/IStorageStatsManager$Stub", "asInterface",
      "(Landroid/os/IBinder;)Landroid/app/usage/IStorageStatsManager;", await hostedService("storagestats")))],
  media_metrics: ["android/media/metrics/MediaMetricsManager", async (ctx) => newObj("android/media/metrics/MediaMetricsManager",
    "(Landroid/media/metrics/IMediaMetricsManager;I)V", await scall("android/media/metrics/IMediaMetricsManager$Stub", "asInterface",
      "(Landroid/os/IBinder;)Landroid/media/metrics/IMediaMetricsManager;", await hostedService("media_metrics")), await vcall(ctx, "getUserId", "()I"))],
  device_policy: ["android/app/admin/DevicePolicyManager", async (ctx) => newObj("android/app/admin/DevicePolicyManager",
    "(Landroid/content/Context;Landroid/app/admin/IDevicePolicyManager;)V", ctx, await scall("android/app/admin/IDevicePolicyManager$Stub", "asInterface",
      "(Landroid/os/IBinder;)Landroid/app/admin/IDevicePolicyManager;", await hostedService("device_policy")))],
  // with no PermissionController package installed its constructor fails, as on such a device
  permission_controller: ["android/permission/PermissionControllerManager", (ctx) =>
    newObj("android/permission/PermissionControllerManager", "(Landroid/content/Context;Landroid/os/Handler;)V", ctx, mainHandler())],
  netstats: ["android/app/usage/NetworkStatsManager", async (ctx) => newObj("android/app/usage/NetworkStatsManager",
    "(Landroid/content/Context;Landroid/net/INetworkStatsService;)V", ctx, await scall("android/net/INetworkStatsService$Stub", "asInterface",
      "(Landroid/os/IBinder;)Landroid/net/INetworkStatsService;", await hostedService("netstats")))],
  servicediscovery: ["android/net/nsd/NsdManager", async (ctx) => newObj("android/net/nsd/NsdManager", "(Landroid/content/Context;Landroid/net/nsd/INsdManager;)V",
    ctx, await scall("android/net/nsd/INsdManager$Stub", "asInterface", "(Landroid/os/IBinder;)Landroid/net/nsd/INsdManager;", await hostedService("servicediscovery")))],
  camera: ["android/hardware/camera2/CameraManager", (ctx) => newObj("android/hardware/camera2/CameraManager", "(Landroid/content/Context;)V", ctx)],
  measurement_service: ["android/adservices/measurement/MeasurementManager", (ctx) =>
    newObj("android/adservices/measurement/MeasurementManager", "(Landroid/content/Context;)V", ctx)],
  media_router: ["android/media/MediaRouter", (ctx) => newObj("android/media/MediaRouter", "(Landroid/content/Context;)V", ctx)],
  captioning: ["android/view/accessibility/CaptioningManager", (ctx) => newObj("android/view/accessibility/CaptioningManager", "(Landroid/content/Context;)V", ctx)],
  telecom: ["android/telecom/TelecomManager", (ctx) => newObj("android/telecom/TelecomManager", "(Landroid/content/Context;)V", ctx)],
  telephony_registry: ["android/telephony/TelephonyRegistryManager",
    (ctx) => newObj("android/telephony/TelephonyRegistryManager", "(Landroid/content/Context;)V", ctx)],
  connectivity: ["android/net/ConnectivityManager", async (ctx) =>
    newObj("android/net/ConnectivityManager", "(Landroid/content/Context;Landroid/net/IConnectivityManager;)V", ctx, await hostedService("connectivity"))],
};
export function systemService(jctx: JContext | null, name: string): unknown {
  if (name === "layout_inflater") return getInflater(jctx);
  let s = services.get(name);
  if (s) return s;
  const manager = AOSP_MANAGERS[name];
  if (manager) {
    const made = manager[1](appHost?.application ?? jctx);
    services.set(name, made);
    return made.then((m) => { services.set(name, m); return m; });
  }
  const cls = SERVICE_CLASS[name];
  // A service we do not model is one this device does not have: AOSP returns null, and callers
  // handle that. Handing back a stand-in object instead only moved the failure to their cast.
  if (!cls) { rt.noteMissing("systemService " + name); return null; }
  s = rt.make(cls);
  services.set(name, s);
  return s;
}
