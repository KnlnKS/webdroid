// IConnectivityManager: one Wi-Fi network (netId 100), the one the page reaches the internet
// through, up while the page is online. Its capabilities and link properties are the reference
// AVD's Wi-Fi network as an app sees it (no transport info, owner or admin uids); its DNS server is
// one any resolver can use, as port-53 datagrams are answered over DNS-over-HTTPS (shell/relay.ts).
// Callbacks reach ConnectivityManager's CallbackHandler as CALLBACK_* messages through the
// Messenger each request carries, as ConnectivityService sends them.
import { once } from "../jvm/suspend.ts";
import { awaited, JObj, rt, noops, setDeclared, driven, type Gen } from "../jvm/runtime.ts";
import { jarray } from "../jvm/abi.ts";
import { newObj, vcall, scall, linkInit, staticField } from "../jvm/natives/jentry.ts";
import { postMain } from "./mainloop.ts";
import { hostService, newStub } from "./binder.ts";

const NET_ID = 100, TYPE_WIFI = 1, TRANSPORT_WIFI = 1;
export const DNS_SERVER = "8.8.8.8";
/** NET_CAPABILITY_*: NOT_METERED, INTERNET, NOT_RESTRICTED, TRUSTED, NOT_VPN, VALIDATED, NOT_ROAMING,
 *  FOREGROUND, NOT_CONGESTED, NOT_SUSPENDED, NOT_VCN_MANAGED, NOT_BANDWIDTH_CONSTRAINED */
const CAPABILITIES = [11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 28, 37];
export const netUp = (): boolean => typeof navigator === "undefined" || navigator.onLine !== false;
const NC = "android/net/NetworkCapabilities", NCB = "Landroid/net/NetworkCapabilities$Builder;";
export const theNetwork = once(() => newObj("android/net/Network", "(I)V", NET_ID));
const capabilities = once(driven(function* (): Gen<JObj> {
  let b = yield newObj(`${NC}$Builder`);
  b = yield vcall(b, "addTransportType", `(I)${NCB}`, TRANSPORT_WIFI);
  for (const c of CAPABILITIES) b = yield vcall(b, "addCapability", `(I)${NCB}`, c);
  b = yield vcall(b, "setLinkUpstreamBandwidthKbps", `(I)${NCB}`, 12000);
  b = yield vcall(b, "setLinkDownstreamBandwidthKbps", `(I)${NCB}`, 30000);
  b = yield vcall(b, "setSignalStrength", `(I)${NCB}`, -50);
  return yield vcall(b, "build", `()L${NC};`);
}));
const linkProperties = once(driven(function* (): Gen<JObj> {
  const lp = yield newObj("android/net/LinkProperties");
  yield vcall(lp, "setInterfaceName", "(Ljava/lang/String;)V", "wlan0");
  const dns = yield scall("java/net/InetAddress", "getByName", "(Ljava/lang/String;)Ljava/net/InetAddress;", DNS_SERVER);
  yield vcall(lp, "addDnsServer", "(Ljava/net/InetAddress;)Z", dns);
  return lp;
}));
/** `n` is the one network: then `answer`, else null */
const ifOurs = (answer: () => unknown) => driven(function* (n: unknown): Gen {
  return n != null && (yield vcall(n, "equals", "(Ljava/lang/Object;)Z", yield theNetwork())) === 1 ? yield answer() : null;
});
const networkInfo = driven(function* (): Gen<JObj> {
  const info = yield newObj("android/net/NetworkInfo", "(IILjava/lang/String;Ljava/lang/String;)V", TYPE_WIFI, 0, "WIFI", "");
  const connected = yield staticField("android/net/NetworkInfo$DetailedState", netUp() ? "CONNECTED" : "DISCONNECTED");
  yield vcall(info, "setDetailedState", "(Landroid/net/NetworkInfo$DetailedState;Ljava/lang/String;Ljava/lang/String;)V", connected, null, "");
  yield vcall(info, "setIsAvailable", "(Z)V", 1);
  return info;
});
/** ConnectivityManager's CALLBACK_* message codes */
const callbackCode = (name: string) => staticField<number>("android/net/ConnectivityManager", name);
type Registration = { request: JObj; messenger: JObj };
const registrations = new Map<JObj, Registration>();
let nextRequestId = 1;
/** ConnectivityService.callCallbackForRequest: the request, the network and what the code carries */
function* sendCallback(r: Registration, name: string): Gen<void> {
  const data = yield newObj("android/os/Bundle"), put = (cls: string, value: unknown) =>
    vcall(data, "putParcelable", "(Ljava/lang/String;Landroid/os/Parcelable;)V", cls, value);
  yield put("NetworkRequest", r.request);
  yield put("Network", yield theNetwork());
  if (name === "CALLBACK_AVAILABLE") {
    yield put("NetworkCapabilities", yield* awaited(capabilities()));
    yield put("LinkProperties", yield* awaited(linkProperties()));
  }
  const msg = yield scall("android/os/Message", "obtain", "()Landroid/os/Message;");
  setDeclared(msg, "android/os/Message", { what: yield* awaited(callbackCode(name)) });
  yield vcall(msg, "setData", "(Landroid/os/Bundle;)V", data);
  yield vcall(r.messenger, "send", "(Landroid/os/Message;)V", msg);
}
/** a request's NetworkRequest, registered for callbacks; one the network satisfies hears of it */
const register = driven(function* (caps: unknown, legacyType: number, messenger: JObj, type: number): Gen<JObj> {
  const types = (yield* awaited(linkInit("android/net/NetworkRequest$Type"))).call("values", "()[Landroid/net/NetworkRequest$Type;")() as JObj[];
  const request: JObj = yield newObj("android/net/NetworkRequest", "(Landroid/net/NetworkCapabilities;IILandroid/net/NetworkRequest$Type;)V",
    caps ?? (yield newObj(NC)), legacyType, nextRequestId++, types[type]);
  const r = { request, messenger };
  registrations.set(request, r);
  if (netUp() && (yield vcall(caps ?? (yield* awaited(capabilities())), "satisfiedByNetworkCapabilities", `(L${NC};)Z`, yield* awaited(capabilities()))))
    yield* sendCallback(r, "CALLBACK_AVAILABLE");
  return request;
});
hostService("connectivity", "webdroid/ConnectivityService", "android/net/IConnectivityManager$Stub", {
  "getActiveNetwork()Landroid/net/Network;": () => netUp() ? theNetwork() : null,
  "getActiveNetworkForUid(IZ)Landroid/net/Network;": () => netUp() ? theNetwork() : null,
  "getAllNetworks()[Landroid/net/Network;": driven(function* () { return jarray(netUp() ? [yield theNetwork()] : [], "Landroid/net/Network;"); }),
  "getActiveNetworkInfo()Landroid/net/NetworkInfo;": networkInfo,
  "getActiveNetworkInfoForUid(IZ)Landroid/net/NetworkInfo;": networkInfo,
  "getAllNetworkInfo()[Landroid/net/NetworkInfo;": driven(function* () { return jarray([yield networkInfo()], "Landroid/net/NetworkInfo;"); }),
  // the one network's own type answers; this device has no other
  "getNetworkInfo(I)Landroid/net/NetworkInfo;": (type: number) => type === TYPE_WIFI ? networkInfo() : null,
  "getNetworkInfoForUid(Landroid/net/Network;IZ)Landroid/net/NetworkInfo;": ifOurs(networkInfo),
  "getNetworkCapabilities(Landroid/net/Network;Ljava/lang/String;Ljava/lang/String;)Landroid/net/NetworkCapabilities;": ifOurs(capabilities),
  "getLinkProperties(Landroid/net/Network;)Landroid/net/LinkProperties;": ifOurs(linkProperties),
  "getActiveLinkProperties()Landroid/net/LinkProperties;": () => netUp() ? linkProperties() : null,
  "isActiveNetworkMetered()Z": () => 0,
  "isDefaultNetworkActive()Z": () => +netUp(),
  // RESTRICT_BACKGROUND_STATUS_DISABLED: data saver is off
  "getRestrictBackgroundStatusByCaller()I": () => 1,
  "getProxyForNetwork(Landroid/net/Network;)Landroid/net/ProxyInfo;": () => null,
  "requestNetwork(ILandroid/net/NetworkCapabilities;ILandroid/os/Messenger;ILandroid/os/IBinder;IILjava/lang/String;Ljava/lang/String;)Landroid/net/NetworkRequest;":
    (_uid: number, caps: unknown, type: number, messenger: JObj, _timeout: number, _binder: unknown, legacyType: number) => register(caps, legacyType, messenger, type),
  "listenForNetwork(Landroid/net/NetworkCapabilities;Landroid/os/Messenger;Landroid/os/IBinder;ILjava/lang/String;Ljava/lang/String;)Landroid/net/NetworkRequest;":
    (caps: unknown, messenger: JObj) => register(caps, -1, messenger, 1),
  "releaseNetworkRequest(Landroid/net/NetworkRequest;)V": (request: JObj) => { registrations.delete(request); },
  // the network is already validated; revalidation is only a hint
  ...noops("reportNetworkConnectivity(Landroid/net/Network;Z)V",
    "registerNetworkActivityListener(Landroid/net/INetworkActivityListener;)V",
    "unregisterNetworkActivityListener(Landroid/net/INetworkActivityListener;)V"),
});
if (typeof addEventListener !== "undefined") for (const event of ["online", "offline"])
  addEventListener(event, () => postMain(() => rt.drive(function* () {
    for (const r of registrations.values()) yield* sendCallback(r, event === "online" ? "CALLBACK_AVAILABLE" : "CALLBACK_LOST");
  }())));

// NetworkUtils (libframework-connectivity-jni): binding to the one network, which every socket
// already uses
rt.claimNativeLib("framework-connectivity-jni");
let boundNetwork = 0n;
rt.registerJnis("android/net/NetworkUtils", {
  "bindProcessToNetworkHandle(J)Z": (handle: bigint) => { boundNetwork = handle; return 1; },
  "getBoundNetworkHandleForProcess()J": () => boundNetwork,
  "bindProcessToNetworkForHostResolution(I)Z": () => 1,
  "bindSocketToNetworkHandle(Ljava/io/FileDescriptor;J)I": () => 0,
});

// INsdManager, under AOSP's NsdManager: the browser cannot join the multicast groups DNS-SD needs,
// so NsdService is present but every discovery, registration and resolution fails with
// FAILURE_INTERNAL_ERROR on the client's callback instead of inventing services.
const NSD = "android/net/connectivity/android/net/nsd/", NSD_INFO = "Landroid/net/nsd/NsdServiceInfo;", FAILURE_INTERNAL_ERROR = 0;
class JNsdConnector extends JObj { callback: JObj | null = null; }
const nsdFailure = (callback: string) => function (this: JNsdConnector, key: number) {
  return vcall(this.callback, callback, "(II)V", key, FAILURE_INTERNAL_ERROR);
};
rt.register({ name: "webdroid/NsdServiceConnector", ctor: JNsdConnector, sup: NSD + "INsdServiceConnector$Stub", methods: {
  "discoverServices(ILandroid/net/nsd/DiscoveryRequest;)V": nsdFailure("onDiscoverServicesFailed"),
  [`registerService(IL${NSD}AdvertisingRequest;)V`]: nsdFailure("onRegisterServiceFailed"),
  [`resolveService(I${NSD_INFO})V`]: nsdFailure("onResolveServiceFailed"),
  [`registerServiceInfoCallback(I${NSD_INFO})V`]: nsdFailure("onServiceInfoCallbackRegistrationFailed"),
  ...noops("startDaemon()V"),
} });
hostService("servicediscovery", "webdroid/NsdService", "android/net/nsd/INsdManager$Stub", {
  [`connect(L${NSD}INsdManagerCallback;Z)L${NSD}INsdServiceConnector;`]: async (callback: JObj) => {
    const connector = await newStub("webdroid/NsdServiceConnector") as JNsdConnector;
    connector.callback = callback;
    return connector;
  },
});
