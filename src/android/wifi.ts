// IWifiManager, under AOSP's WifiManager, WifiInfo, ScanResult and DhcpInfo: the page's network is
// the one Wi-Fi network ConnectivityService reports (services.ts), connected while the page is
// online, as the reference AVD's AndroidWifi access point (dumpsys wifi's mWifiInfo) apart from its
// address, which the network's LinkProperties do not carry either. WifiServiceImpl's checks are
// kept (decoded from the AVD's service-wifi.jar): ACCESS_WIFI_STATE to read, CHANGE_WIFI_STATE to
// change, location access to see the network's identity or scan results. There is no radio to scan
// or toggle: a scan fails and setWifiEnabled is refused.
import { JObj, declaredField, rt } from "../jvm/runtime";
import { newArrayList } from "../jvm/natives/jcoll";
import { linkInit, newObj, scall, vcall } from "../jvm/natives/jlang";
import { mangleStaticField } from "../jvm/abi";
import { callingIdentity, hostStub } from "./binder";
import { enforceCallingOrSelfPermission, uidPermissionState } from "./pm";
import { packages } from "./packages";
import { locationTransport } from "./locationmanager";
import { DNS_SERVER, netUp, theNetwork } from "./services";

const WIFI_STATE_ENABLED = 3, WIFI_STANDARD_LEGACY = 1, SECURITY_TYPE_OPEN = 0, REDACT_FOR_ACCESS_FINE_LOCATION = 1n;
const S = "Ljava/lang/String;", SLICE = "com/android/wifi/x/com/android/modules/utils/ParceledListSlice";
const emptySlice = () => newObj(SLICE, "(Ljava/util/List;)V", newArrayList());

const enforce = (permission: string) => enforceCallingOrSelfPermission(permission, "WifiService");
const enforceAccess = () => enforce("android.permission.ACCESS_WIFI_STATE");
/** WifiPermissionsUtil.enforceCanAccessScanResults for an app: location on, and fine location (coarse
 *  below Q) */
function canAccessScanResults(pkg: string): boolean {
  const { uid } = callingIdentity(), held = (name: string) => !uidPermissionState("android.permission." + name, uid);
  return locationTransport.enabled() && (held("ACCESS_FINE_LOCATION") || (packages.get(pkg)?.sdk.target ?? 0) < 29 && held("ACCESS_COARSE_LOCATION"));
}
async function connectionInfo(): Promise<JObj> {
  const info = await newObj("android/net/wifi/WifiInfo");
  if (!netUp()) return info;
  const state = (await linkInit("android/net/wifi/SupplicantState")).ctor[mangleStaticField("COMPLETED")];
  const set = (name: string, desc: string, value: unknown) => vcall(info, name, `(${desc})V`, value);
  await set("setSupplicantState", "Landroid/net/wifi/SupplicantState;", state);
  await set("setSSID", "Landroid/net/wifi/WifiSsid;", await scall("android/net/wifi/WifiSsid", "fromUtf8Text", "(Ljava/lang/CharSequence;)Landroid/net/wifi/WifiSsid;", "AndroidWifi"));
  await set("setBSSID", S, "00:13:10:85:fe:01");
  await set("setMacAddress", S, "02:15:de:00:00:00");
  for (const [name, value] of [["setNetworkId", 0], ["setRssi", -50], ["setLinkSpeed", 1], ["setTxLinkSpeedMbps", 1], ["setRxLinkSpeedMbps", 2],
    ["setMaxSupportedTxLinkSpeedMbps", 11], ["setMaxSupportedRxLinkSpeedMbps", 11], ["setFrequency", 2447], ["setWifiStandard", WIFI_STANDARD_LEGACY],
    ["setCurrentSecurityType", SECURITY_TYPE_OPEN], ["setScore", 60]] as const) await set(name, "I", value);
  for (const name of ["setUsable", "setIsPrimary", "setTrusted"]) await set(name, "Z", 1);
  return info;
}
/** an IPv4 address as DhcpInfo holds it: the first octet lowest */
const inet4 = (address: string) => address.split(".").reduceRight((n, octet) => (n << 8) | +octet, 0);

const locks = new Set<unknown>(), multicast = new Map<unknown, string>();
rt.register({ name: "webdroid/WifiService", ctor: class extends JObj {}, sup: "android/net/wifi/IWifiManager$Stub", methods: {
  "getWifiEnabledState()I": async () => { await enforceAccess(); return WIFI_STATE_ENABLED; },
  [`getConnectionInfo(${S}${S})Landroid/net/wifi/WifiInfo;`]: async (pkg: string) => {
    await enforceAccess();
    const info = await connectionInfo(), redactions: bigint = await vcall(info, "getApplicableRedactions", "()J");
    return vcall(info, "makeCopy", "(J)Landroid/net/wifi/WifiInfo;", canAccessScanResults(pkg) ? redactions & ~REDACT_FOR_ACCESS_FINE_LOCATION : redactions);
  },
  "getCurrentNetwork()Landroid/net/Network;": () => netUp() ? theNetwork() : null,
  [`getDhcpInfo(${S})Landroid/net/DhcpInfo;`]: async () => {
    await enforceAccess();
    const info = await newObj("android/net/DhcpInfo");
    if (netUp()) (info as unknown as Record<string, number>)[declaredField("android/net/DhcpInfo", "dns1")] = inet4(DNS_SERVER);
    return info;
  },
  // this device never scans: no results, and a scan request fails
  [`getScanResults(${S}${S})L${SLICE};`]: async () => { await enforceAccess(); return emptySlice(); },
  [`startScan(${S}${S})Z`]: async () => { await enforce("android.permission.CHANGE_WIFI_STATE"); return 0; },
  // an app sees no saved networks from Q, and the page's network is not one it can change
  [`getConfiguredNetworks(${S}${S}Z)L${SLICE};`]: async () => { await enforceAccess(); return emptySlice(); },
  [`setWifiEnabled(${S}Z)Z`]: async () => { await enforce("android.permission.CHANGE_WIFI_STATE"); return 0; },
  ...Object.fromEntries(["reconnect", "reassociate", "disconnect"].map((name) =>
    [`${name}(${S})Z`, async () => { await enforce("android.permission.CHANGE_WIFI_STATE"); return 0; }])),
  "isScanAlwaysAvailable()Z": () => 0,
  "getVerboseLoggingLevel()I": () => 0,
  // the AVD's 2.4 GHz-only radio, with none of the optional features (p2p, aware, rtt...) this device lacks
  "is24GHzBandSupported()Z": () => 1,
  "is5GHzBandSupported()Z": () => 0,
  "getSupportedFeatures()J": () => 0n,
  [`acquireWifiLock(Landroid/os/IBinder;I${S}Landroid/os/WorkSource;${S}Landroid/os/Bundle;)Z`]: async (binder: unknown) => {
    await enforce("android.permission.WAKE_LOCK");
    locks.add(binder);
    return 1;
  },
  "releaseWifiLock(Landroid/os/IBinder;)Z": async (binder: unknown) => { await enforce("android.permission.WAKE_LOCK"); return +locks.delete(binder); },
  [`acquireMulticastLock(Landroid/os/IBinder;${S})V`]: async (binder: unknown, tag: string) => {
    await enforce("android.permission.CHANGE_WIFI_MULTICAST_STATE");
    multicast.set(binder, tag);
  },
  [`releaseMulticastLock(${S})V`]: async (tag: string) => {
    await enforce("android.permission.CHANGE_WIFI_MULTICAST_STATE");
    for (const [binder, held] of multicast) if (held === tag) { multicast.delete(binder); break; }
  },
  "isMulticastEnabled()Z": () => +(multicast.size > 0),
} });
hostStub("wifi", "webdroid/WifiService");
