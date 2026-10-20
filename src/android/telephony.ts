// Telephony on a device without FEATURE_TELEPHONY: the phone process never runs, so its services
// are absent and AOSP's TelephonyManager and SubscriptionManager answer from their no-service paths
// (no modem, no SIM, no subscriptions). TelephonyRegistry is system_server's and every device has
// it; with no active modem validatePhoneId fails, so a listener is never notified and only meets
// TelephonyRegistry.checkListenerPermission (decoded from the reference AVD's services.jar).
import { awaited, JObj, rt, driven, type Gen } from "../jvm/runtime.ts";
import { newObj, scall, vcall } from "../jvm/natives/jentry.ts";
import { absentService, callingIdentity, enforceCallingOrSelfPermission, hostService, serviceContext } from "./binder.ts";
import { packages } from "./packages.ts";

absentService("phone", "isub", "iphonesubinfo", "carrier_config", "isms", "simphonebook", "telephony_ims");
// SystemServer starts Telecom only with a microphone, telephony or FEATURE_TELECOM
absentService("telecom");

const TP = "com/android/internal/telephony/TelephonyPermissions";
// TelephonyCallback.EVENT_*: those TelephonyRegistry gates on a permission
const LOCATION = [5, 11], PRIVILEGED = [16, 18, 24, 35, 40, 41], EMERGENCY = [29, 30];
const PRECISE = [12, 13, 14, 26, 27, 28, 31, 32, 33, 34, 37, 39];
const targetSdk = (pkg: string) => packages.get(pkg)?.sdk.target ?? 0;
/** isPhoneStatePermissionRequired: its platform-compat changes are enabled after R */
function phoneStateRequired(events: number[], pkg: string): boolean {
  const has = (...e: number[]) => e.some((x) => events.includes(x)), afterR = targetSdk(pkg) > 30;
  return has(3, 4, 25) || has(6, 36, 23, 11) && afterR || has(21) && !afterR;
}
const LPQ = "android/telephony/LocationAccessPolicy$LocationPermissionQuery", QB = `L${LPQ}$Builder;`;
/** LocationAccessPolicy's verdict on the caller, with TelephonyRegistry's query (every minimum SDK Q) */
function* locationResult(context: unknown, events: number[], pkg: string, featureId: string | null): Gen<string> {
  const { pid, uid } = callingIdentity();
  let builder = yield newObj(LPQ + "$Builder");
  for (const [setter, desc, value] of [["setCallingPackage", "Ljava/lang/String;", pkg], ["setCallingFeatureId", "Ljava/lang/String;", featureId],
    ["setMethod", "Ljava/lang/String;", `listen events: [${events.join(", ")}]`], ["setCallingPid", "I", pid], ["setCallingUid", "I", uid],
    ["setMinSdkVersionForFine", "I", 29], ["setMinSdkVersionForCoarse", "I", 29], ["setMinSdkVersionForEnforcement", "I", 29]] as const) {
    builder = yield vcall(builder, setter, `(${desc})${QB}`, value);
  }
  const query = yield vcall(builder, "build", `()L${LPQ};`);
  const result = yield scall("android/telephony/LocationAccessPolicy", "checkLocationPermission",
    `(Landroid/content/Context;L${LPQ};)Landroid/telephony/LocationAccessPolicy$LocationPermissionResult;`, context, query);
  return yield vcall(result, "name", "()Ljava/lang/String;");
}
/** TelephonyRegistry.checkListenerPermission: it throws for a missing permission, and a soft denial
 *  only leaves the listener unregistered, which with no modem is the same as registering it */
function* checkListenerPermission(events: number[], subId: number, pkg: string, featureId: string | null): Gen<void> {
  const context = yield* awaited(serviceContext()), any = (set: number[]) => events.some((e) => set.includes(e));
  const enforce = (permission: string) => enforceCallingOrSelfPermission(permission, "listen");
  if (any(LOCATION)) {
    const result = yield* locationResult(context, events, pkg, featureId);
    if (result === "DENIED_SOFT") return;
    if (result === "DENIED_HARD") throw rt.mkThrowable("java/lang/SecurityException", `Unable to listen for events [${events.join(", ")}] due to insufficient location permission`);
  }
  if (phoneStateRequired(events, pkg) && !(yield scall(TP, "checkCallingOrSelfReadPhoneState",
    "(Landroid/content/Context;ILjava/lang/String;Ljava/lang/String;Ljava/lang/String;)Z", context, subId, pkg, featureId, "listen"))) return;
  if (any(PRECISE)) {
    try { yield enforce("android.permission.READ_PRECISE_PHONE_STATE"); }
    catch { yield scall(TP, "enforceCallingOrSelfCarrierPrivilege", "(Landroid/content/Context;ILjava/lang/String;)V", context, subId, "listen"); }
  }
  if (any(EMERGENCY)) yield enforce("android.permission.READ_ACTIVE_EMERGENCY_SESSION");
  if (any(PRIVILEGED)) yield enforce("android.permission.READ_PRIVILEGED_PHONE_STATE");
}

hostService("telephony.registry", "webdroid/TelephonyRegistry", "com/android/internal/telephony/ITelephonyRegistry$Stub", {
  "listenWithEventList(ZZILjava/lang/String;Ljava/lang/String;Lcom/android/internal/telephony/IPhoneStateListener;[IZ)V":
    driven(function* (_fine: number, _coarse: number, subId: number, pkg: string, featureId: string | null, _callback: JObj, events: Int32Array) {
      if (events.length) yield* checkListenerPermission([...events], subId, pkg, featureId);
    }),
  // subscription info never changes without a phone process, so a listener is never called back
  "addOnSubscriptionsChangedListener(Ljava/lang/String;Ljava/lang/String;Lcom/android/internal/telephony/IOnSubscriptionsChangedListener;)V": () => {},
  "addOnOpportunisticSubscriptionsChangedListener(Ljava/lang/String;Ljava/lang/String;Lcom/android/internal/telephony/IOnSubscriptionsChangedListener;)V": () => {},
  "removeOnSubscriptionsChangedListener(Ljava/lang/String;Lcom/android/internal/telephony/IOnSubscriptionsChangedListener;)V": () => {},
});
