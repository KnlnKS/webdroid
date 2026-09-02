// android.net: ConnectivityManager and the network-callback plumbing. Network state is read back
// out of ConnectivityManager's own NetworkInfo so the two cannot disagree; nothing here simulates
// the network going away.

import { rt, JObj } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { reportUncaught } from "./os";

const netUp = async (): Promise<number> =>
  (await vcall(new (rt.link("android/net/NetworkInfo").ctor)(), "isConnected", "()Z")) ? 1 : 0;
let theNetwork: unknown = null;
const network = () => (theNetwork ??= new (rt.link("android/net/Network").ctor)());
const netCaps = () => new (rt.link("android/net/NetworkCapabilities").ctor)();
const netCallbacks = new Set<unknown>();
async function fireNetAvailable(cb: unknown) {
  if (!netCallbacks.has(cb) || !(await netUp())) return;
  await vcall(cb, "onAvailable", "(Landroid/net/Network;)V", network());
  await vcall(cb, "onCapabilitiesChanged", "(Landroid/net/Network;Landroid/net/NetworkCapabilities;)V", network(), netCaps());
}
rt.register({ name: "android/net/Network", ctor: class extends JObj {} });
rt.register({
  name: "android/net/NetworkCapabilities", ctor: class extends JObj {},
  statics: {
    TRANSPORT_CELLULAR: 0, TRANSPORT_WIFI: 1, TRANSPORT_ETHERNET: 3, TRANSPORT_VPN: 4,
    NET_CAPABILITY_NOT_METERED: 11, NET_CAPABILITY_INTERNET: 12, NET_CAPABILITY_NOT_RESTRICTED: 13,
    NET_CAPABILITY_TRUSTED: 14, NET_CAPABILITY_NOT_VPN: 15, NET_CAPABILITY_VALIDATED: 16,
    NET_CAPABILITY_NOT_ROAMING: 18, NET_CAPABILITY_NOT_CONGESTED: 20, NET_CAPABILITY_NOT_SUSPENDED: 21,
    NET_CAPABILITY_TEMPORARILY_NOT_METERED: 25,
  },
  methods: { "hasCapability(I)Z": netUp, "hasTransport(I)Z": (t: number) => (t === 1 ? 1 : 0) },
});
class JNetworkRequest extends JObj { caps: number[] = []; transports: number[] = []; }
class JNetworkRequestBuilder extends JObj { r = new JNetworkRequest(); }
rt.register({
  name: "android/net/NetworkRequest", ctor: JNetworkRequest,
  methods: {
    "hasCapability(I)Z": function (this: JNetworkRequest, c: number) { return this.caps.includes(c) ? 1 : 0; },
    "hasTransport(I)Z": function (this: JNetworkRequest, t: number) { return this.transports.includes(t) ? 1 : 0; },
  },
});
rt.register({
  name: "android/net/NetworkRequest$Builder", ctor: JNetworkRequestBuilder,
  methods: {
    "<init>()V": function () {},
    "addCapability(I)Landroid/net/NetworkRequest$Builder;": function (this: JNetworkRequestBuilder, c: number) { this.r.caps.push(c); return this; },
    "removeCapability(I)Landroid/net/NetworkRequest$Builder;": function (this: JNetworkRequestBuilder, c: number) {
      this.r.caps = this.r.caps.filter((x) => x !== c); return this;
    },
    "addTransportType(I)Landroid/net/NetworkRequest$Builder;": function (this: JNetworkRequestBuilder, t: number) { this.r.transports.push(t); return this; },
    "build()Landroid/net/NetworkRequest;": function (this: JNetworkRequestBuilder) {
      const r = new JNetworkRequest();
      r.caps = this.r.caps.slice(); r.transports = this.r.transports.slice();
      return r;
    },
  },
});
rt.register({
  name: "android/net/ConnectivityManager$NetworkCallback", ctor: class extends JObj {},
  methods: {
    "<init>()V": function () {}, "<init>(I)V": function () {},
    "onAvailable(Landroid/net/Network;)V": () => {},
    "onLosing(Landroid/net/Network;I)V": () => {},
    "onLost(Landroid/net/Network;)V": () => {},
    "onUnavailable()V": () => {},
    "onCapabilitiesChanged(Landroid/net/Network;Landroid/net/NetworkCapabilities;)V": () => {},
    "onLinkPropertiesChanged(Landroid/net/Network;Landroid/net/LinkProperties;)V": () => {},
    "onBlockedStatusChanged(Landroid/net/Network;Z)V": () => {},
  },
});

const registerCallback = (cb: unknown) => {
  if (!cb) return;
  netCallbacks.add(cb);
  setTimeout(() => void fireNetAvailable(cb).catch(reportUncaught), 0);
};
rt.register({
  name: "android/net/ConnectivityManager", ctor: class extends JObj {},
  methods: {
    "getActiveNetworkInfo()Landroid/net/NetworkInfo;": () => new (rt.link("android/net/NetworkInfo").ctor)(),
    "getActiveNetwork()Landroid/net/Network;": () => null,
    "registerNetworkCallback(Landroid/net/NetworkRequest;Landroid/net/ConnectivityManager$NetworkCallback;)V": (_r: unknown, cb: unknown) => registerCallback(cb),
    "registerNetworkCallback(Landroid/net/NetworkRequest;Landroid/net/ConnectivityManager$NetworkCallback;Landroid/os/Handler;)V": (_r: unknown, cb: unknown) => registerCallback(cb),
    "registerDefaultNetworkCallback(Landroid/net/ConnectivityManager$NetworkCallback;)V": registerCallback,
    "requestNetwork(Landroid/net/NetworkRequest;Landroid/net/ConnectivityManager$NetworkCallback;)V": (_r: unknown, cb: unknown) => registerCallback(cb),
    "unregisterNetworkCallback(Landroid/net/ConnectivityManager$NetworkCallback;)V": (cb: unknown) => { netCallbacks.delete(cb); },
    "getNetworkCapabilities(Landroid/net/Network;)Landroid/net/NetworkCapabilities;": () => netCaps(),
    "isActiveNetworkMetered()Z": () => 0,
  },
});
rt.register({
  name: "android/net/NetworkInfo", ctor: class extends JObj {},
  methods: {
    "isConnected()Z": () => 1,
    "isConnectedOrConnecting()Z": () => 1,
    "getType()I": () => 1,
    "isAvailable()Z": () => 1,
    "isRoaming()Z": () => 0,
  },
});
