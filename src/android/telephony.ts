// Telephony on a device without FEATURE_TELEPHONY: the phone process never runs, so its services
// are absent and AOSP's TelephonyManager and SubscriptionManager answer from their no-service paths
// (no modem, no SIM, no subscriptions). TelephonyRegistry is system_server's and every device has
// it; with no active modem validatePhoneId fails, so a listener is never notified and only meets
// TelephonyRegistry.checkListenerPermission (decoded from the reference AVD's services.jar).
import { JObj, rt } from "../jvm/runtime";
import { newObj, scall, vcall } from "../jvm/natives/jlang";
import { absentService, callingIdentity, hostStub } from "./binder";
import { packages } from "./packages";

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
async function locationResult(context: unknown, events: number[], pkg: string, featureId: string | null): Promise<string> {
  const { pid, uid } = callingIdentity();
  let builder = await newObj(LPQ + "$Builder");
  for (const [setter, desc, value] of [["setCallingPackage", "Ljava/lang/String;", pkg], ["setCallingFeatureId", "Ljava/lang/String;", featureId],
    ["setMethod", "Ljava/lang/String;", `listen events: [${events.join(", ")}]`], ["setCallingPid", "I", pid], ["setCallingUid", "I", uid],
    ["setMinSdkVersionForFine", "I", 29], ["setMinSdkVersionForCoarse", "I", 29], ["setMinSdkVersionForEnforcement", "I", 29]] as const) {
    builder = await vcall(builder, setter, `(${desc})${QB}`, value);
  }
  const query = await vcall(builder, "build", `()L${LPQ};`);
  const result = await scall("android/telephony/LocationAccessPolicy", "checkLocationPermission",
    `(Landroid/content/Context;L${LPQ};)Landroid/telephony/LocationAccessPolicy$LocationPermissionResult;`, context, query);
  return vcall(result, "name", "()Ljava/lang/String;");
}
/** TelephonyRegistry.checkListenerPermission: it throws for a missing permission, and a soft denial
 *  only leaves the listener unregistered, which with no modem is the same as registering it */
async function checkListenerPermission(events: number[], subId: number, pkg: string, featureId: string | null): Promise<void> {
  const context = await scall("android/app/ActivityThread", "currentApplication", "()Landroid/app/Application;"), any = (set: number[]) => events.some((e) => set.includes(e));
  const enforce = (permission: string) => vcall(context, "enforceCallingOrSelfPermission", "(Ljava/lang/String;Ljava/lang/String;)V", permission, "listen");
  if (any(LOCATION)) {
    const result = await locationResult(context, events, pkg, featureId);
    if (result === "DENIED_SOFT") return;
    if (result === "DENIED_HARD") throw rt.mkThrowable("java/lang/SecurityException", `Unable to listen for events [${events.join(", ")}] due to insufficient location permission`);
  }
  if (phoneStateRequired(events, pkg) && !await scall(TP, "checkCallingOrSelfReadPhoneState",
    "(Landroid/content/Context;ILjava/lang/String;Ljava/lang/String;Ljava/lang/String;)Z", context, subId, pkg, featureId, "listen")) return;
  if (any(PRECISE)) {
    try { await enforce("android.permission.READ_PRECISE_PHONE_STATE"); }
    catch { await scall(TP, "enforceCallingOrSelfCarrierPrivilege", "(Landroid/content/Context;ILjava/lang/String;)V", context, subId, "listen"); }
  }
  if (any(EMERGENCY)) await enforce("android.permission.READ_ACTIVE_EMERGENCY_SESSION");
  if (any(PRIVILEGED)) await enforce("android.permission.READ_PRIVILEGED_PHONE_STATE");
}

rt.register({ name: "webdroid/TelephonyRegistry", ctor: class extends JObj {}, sup: "com/android/internal/telephony/ITelephonyRegistry$Stub", methods: {
  "listenWithEventList(ZZILjava/lang/String;Ljava/lang/String;Lcom/android/internal/telephony/IPhoneStateListener;[IZ)V":
    async (_fine: number, _coarse: number, subId: number, pkg: string, featureId: string | null, _callback: JObj, events: Int32Array) => {
      if (events.length) await checkListenerPermission([...events], subId, pkg, featureId);
    },
  // subscription info never changes without a phone process, so a listener is never called back
  "addOnSubscriptionsChangedListener(Ljava/lang/String;Ljava/lang/String;Lcom/android/internal/telephony/IOnSubscriptionsChangedListener;)V": () => {},
  "addOnOpportunisticSubscriptionsChangedListener(Ljava/lang/String;Ljava/lang/String;Lcom/android/internal/telephony/IOnSubscriptionsChangedListener;)V": () => {},
  "removeOnSubscriptionsChangedListener(Ljava/lang/String;Lcom/android/internal/telephony/IOnSubscriptionsChangedListener;)V": () => {},
} });
hostStub("telephony.registry", "webdroid/TelephonyRegistry");
