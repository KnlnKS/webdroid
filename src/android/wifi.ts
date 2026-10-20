// IWifiManager, under AOSP's WifiManager, WifiInfo, ScanResult and DhcpInfo: the page's network is
// the one Wi-Fi network ConnectivityService reports (services.ts), connected while the page is
// online, as the reference AVD's AndroidWifi access point (dumpsys wifi's mWifiInfo) apart from its
// address, which the network's LinkProperties do not carry either. WifiServiceImpl's checks are
// kept (decoded from the AVD's service-wifi.jar): ACCESS_WIFI_STATE to read, CHANGE_WIFI_STATE to
// change, location access to see the network's identity or scan results. There is no radio to scan
// or toggle: a scan fails and setWifiEnabled is refused.
import { awaited, JObj, setDeclared, rt, driven, type Gen } from "../jvm/runtime.ts";
import { newArrayList } from "../jvm/natives/jcoll.ts";
import { after, staticField, newObj, scall, vcall } from "../jvm/natives/jentry.ts";
import { callingIdentity, enforceCallingOrSelfPermission, hostStub } from "./binder.ts";
import { checkUidPermission } from "./permissions.ts";
import { packages } from "./packages.ts";
import { locationEnabled } from "./locationmanager.ts";
import { DNS_SERVER, netUp, theNetwork } from "./services.ts";

const WIFI_STATE_ENABLED = 3, WIFI_STANDARD_LEGACY = 1, SECURITY_TYPE_OPEN = 0, REDACT_FOR_ACCESS_FINE_LOCATION = 1n;
const S = "Ljava/lang/String;", SLICE = "com/android/wifi/x/com/android/modules/utils/ParceledListSlice";
const emptySlice = () => after(newArrayList(), list => newObj(SLICE, "(Ljava/util/List;)V", list));

const enforce = (permission: string) => enforceCallingOrSelfPermission(permission, "WifiService");
const enforceAccess = () => enforce("android.permission.ACCESS_WIFI_STATE");
/** there is no radio to change: refused once the caller may ask */
const refuseChange = () => after(enforce("android.permission.CHANGE_WIFI_STATE"), () => 0);
/** WifiPermissionsUtil.enforceCanAccessScanResults for an app: location on, and fine location (coarse
 *  below Q) */
function* canAccessScanResults(pkg: string): Gen<boolean> {
  const { uid } = callingIdentity(), check = (name: string) => checkUidPermission("android.permission." + name, uid);
  return (yield* awaited(locationEnabled())) && ((yield* awaited(check("ACCESS_FINE_LOCATION"))) === 0 || (packages.get(pkg)?.sdk.target ?? 0) < 29 && (yield* awaited(check("ACCESS_COARSE_LOCATION"))) === 0);
}
function* connectionInfo(): Gen<JObj> {
  const info = yield newObj("android/net/wifi/WifiInfo");
  if (!netUp()) return info;
  const state = yield staticField("android/net/wifi/SupplicantState", "COMPLETED");
  const set = (name: string, desc: string, value: unknown) => vcall(info, name, `(${desc})V`, value);
  yield set("setSupplicantState", "Landroid/net/wifi/SupplicantState;", state);
  yield set("setSSID", "Landroid/net/wifi/WifiSsid;", yield scall("android/net/wifi/WifiSsid", "fromUtf8Text", "(Ljava/lang/CharSequence;)Landroid/net/wifi/WifiSsid;", "AndroidWifi"));
  yield set("setBSSID", S, "00:13:10:85:fe:01");
  yield set("setMacAddress", S, "02:15:de:00:00:00");
  for (const [name, value] of [["setNetworkId", 0], ["setRssi", -50], ["setLinkSpeed", 1], ["setTxLinkSpeedMbps", 1], ["setRxLinkSpeedMbps", 2],
    ["setMaxSupportedTxLinkSpeedMbps", 11], ["setMaxSupportedRxLinkSpeedMbps", 11], ["setFrequency", 2447], ["setWifiStandard", WIFI_STANDARD_LEGACY],
    ["setCurrentSecurityType", SECURITY_TYPE_OPEN], ["setScore", 60]] as const) yield set(name, "I", value);
  for (const name of ["setUsable", "setIsPrimary", "setTrusted"]) yield set(name, "Z", 1);
  return info;
}
/** an IPv4 address as DhcpInfo holds it: the first octet lowest */
const inet4 = (address: string) => address.split(".").reduceRight((n, octet) => (n << 8) | +octet, 0);

const locks = new Set<unknown>(), multicast = new Map<unknown, string>();
rt.register({ name: "webdroid/WifiService", ctor: class extends JObj {}, sup: "android/net/wifi/IWifiManager$Stub", methods: {
  "getWifiEnabledState()I": () => after(enforceAccess(), () => WIFI_STATE_ENABLED),
  [`getConnectionInfo(${S}${S})Landroid/net/wifi/WifiInfo;`]: driven(function* (pkg: string) {
    yield enforceAccess();
    const info = yield* connectionInfo(), redactions: bigint = yield vcall(info, "getApplicableRedactions", "()J");
    return yield vcall(info, "makeCopy", "(J)Landroid/net/wifi/WifiInfo;", (yield* canAccessScanResults(pkg)) ? redactions & ~REDACT_FOR_ACCESS_FINE_LOCATION : redactions);
  }),
  "getCurrentNetwork()Landroid/net/Network;": () => netUp() ? theNetwork() : null,
  [`getDhcpInfo(${S})Landroid/net/DhcpInfo;`]: driven(function* () {
    yield enforceAccess();
    const info = yield newObj("android/net/DhcpInfo");
    if (netUp()) setDeclared(info, "android/net/DhcpInfo", { dns1: inet4(DNS_SERVER) });
    return info;
  }),
  // this device never scans: no results, and a scan request fails
  [`getScanResults(${S}${S})L${SLICE};`]: driven(function* () { yield enforceAccess(); return yield emptySlice(); }),
  [`startScan(${S}${S})Z`]: refuseChange,
  // an app sees no saved networks from Q, and the page's network is not one it can change
  [`getConfiguredNetworks(${S}${S}Z)L${SLICE};`]: driven(function* () { yield enforceAccess(); return yield emptySlice(); }),
  [`setWifiEnabled(${S}Z)Z`]: refuseChange,
  ...Object.fromEntries(["reconnect", "reassociate", "disconnect"].map((name) => [`${name}(${S})Z`, refuseChange])),
  "isScanAlwaysAvailable()Z": () => 0,
  "getVerboseLoggingLevel()I": () => 0,
  // the AVD's 2.4 GHz-only radio, with none of the optional features (p2p, aware, rtt...) this device lacks
  "is24GHzBandSupported()Z": () => 1,
  "is5GHzBandSupported()Z": () => 0,
  "getSupportedFeatures()J": () => 0n,
  [`acquireWifiLock(Landroid/os/IBinder;I${S}Landroid/os/WorkSource;${S}Landroid/os/Bundle;)Z`]: (binder: unknown) =>
    after(enforce("android.permission.WAKE_LOCK"), () => { locks.add(binder); return 1; }),
  "releaseWifiLock(Landroid/os/IBinder;)Z": (binder: unknown) => after(enforce("android.permission.WAKE_LOCK"), () => +locks.delete(binder)),
  [`acquireMulticastLock(Landroid/os/IBinder;${S})V`]: (binder: unknown, tag: string) =>
    after(enforce("android.permission.CHANGE_WIFI_MULTICAST_STATE"), () => { multicast.set(binder, tag); }),
  [`releaseMulticastLock(${S})V`]: (tag: string) => after(enforce("android.permission.CHANGE_WIFI_MULTICAST_STATE"), () => {
    for (const [binder, held] of multicast) if (held === tag) { multicast.delete(binder); break; }
  }),
  "isMulticastEnabled()Z": () => +(multicast.size > 0),
} });
hostStub("wifi", "webdroid/WifiService");
