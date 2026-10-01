// android.net: Uri and Wi-Fi. The network itself is the connectivity service's
// (services.ts), under AOSP's ConnectivityManager.

import { rt, JObj, noops, driven, type Gen } from "../jvm/runtime";
import { vcall, curThread, stringHash, mkEnumSet } from "../jvm/natives/jlang";
import { newArrayList, newLinkedHashSet } from "../jvm/natives/jcoll";
import { pathOf } from "../jvm/natives/jio";
import { type JParcel, parcelCreator } from "./parcel";

// android.net.Uri: one string, split lazily the way AOSP's StringUri does (scheme, then
// hierarchical authority/path/query or an opaque scheme-specific part, then fragment).
// Getters decode; getEncoded* hand back the raw slice.
export class JUri extends JObj { uri = ""; p: UriParts | null = null; }
type UriParts = { scheme: string | null; ssp: string; hier: boolean; authority: string | null; path: string; query: string | null; fragment: string | null };
export function mkUri(s: string): JUri { const u = new JUri(); u.uri = s; return u; }
export function uriParts(u: JUri): UriParts {
  if (u.p) return u.p;
  const s = u.uri;
  let scheme: string | null = null, rest = s;
  const c = s.indexOf(":");
  if (c > 0 && !/[/?#]/.test(s.slice(0, c))) { scheme = s.slice(0, c); rest = s.slice(c + 1); }
  let fragment: string | null = null;
  const h = rest.indexOf("#");
  if (h >= 0) { fragment = rest.slice(h + 1); rest = rest.slice(0, h); }
  const hier = scheme === null || rest.startsWith("/");
  let authority: string | null = null, path = "", query: string | null = null;
  if (hier) {
    let r = rest;
    if (r.startsWith("//")) {
      const e = r.slice(2).search(/[/?]/);
      authority = e < 0 ? r.slice(2) : r.slice(2, 2 + e);
      r = e < 0 ? "" : r.slice(2 + e);
    }
    const q = r.indexOf("?");
    if (q >= 0) { query = r.slice(q + 1); path = r.slice(0, q); } else path = r;
  }
  return (u.p = { scheme, ssp: rest, hier, authority, path, query, fragment });
}
/** the raw (encoded) path segments of a hierarchical uri; an opaque one has none */
const rawSegments = (p: UriParts) => p.hier ? p.path.split("/").filter(Boolean) : [];
/** an authority's host[:port], past any userinfo */
export const hostPort = (authority: string) => authority.slice(authority.lastIndexOf("@") + 1);
const compareUri = function (this: JUri, o: JUri) { return this.uri < o.uri ? -1 : this.uri > o.uri ? 1 : 0; };
const URI_ALLOWED = /[A-Za-z0-9_\-!.~'()*]/;
function uriEncode(s: string | null, allow = ""): string | null {
  if (s === null) return null;
  let out = "";
  for (const ch of s) {
    if (URI_ALLOWED.test(ch) || allow.includes(ch)) out += ch;
    else for (const b of new TextEncoder().encode(ch)) out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}
// AOSP decodes leniently: a malformed escape stays literal, and '+' is NOT a space.
export function uriDecode(s: string | null): string | null {
  if (s === null) return null;
  if (!s.includes("%")) return s;
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
    const bytes = new Uint8Array(m.length / 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(m.slice(i * 3 + 1, i * 3 + 3), 16);
    return new TextDecoder().decode(bytes);
  });
}
function* queryPairs(q: string | null): Generator<[string, string]> {
  if (q === null) return;
  for (const kv of q.split("&")) {
    if (!kv) continue;
    const e = kv.indexOf("=");
    yield e < 0 ? [kv, ""] : [kv.slice(0, e), kv.slice(e + 1)];
  }
}
export async function readUri(p: JParcel): Promise<JUri | null> {
  const kind = await vcall(p, "readInt", "()I");
  if (!kind) return null;
  if (kind < 1 || kind > 3) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown URI type: " + kind);
  const text = await vcall(p, "readString8", "()Ljava/lang/String;");
  rt.link("android/net/Uri");
  if (kind === 1) {
    if (text === null) throw rt.mkThrowable("java/lang/NullPointerException", "uriString");
    return mkUri(text);
  }
  const part = async (allow = ""): Promise<string | null> => {
    const representation = await vcall(p, "readInt", "()I");
    if (representation !== 1 && representation !== 2) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown URI representation: " + representation);
    const value = await vcall(p, "readString8", "()Ljava/lang/String;");
    if (representation === 1) return value;
    return uriEncode(value, allow);
  };
  if (kind === 2) {
    const ssp = await part(), fragment = await part();
    return mkUri(text + ":" + ssp + (fragment ? "#" + fragment : ""));
  }
  const authority = await part();
  let path = await part("/");
  if ((text || authority) && path && !path.startsWith("/")) path = "/" + path;
  const query = await part(), fragment = await part();
  return mkUri((text === null ? "" : text + ":") + (authority === null ? "" : "//" + authority) + (path ?? "") +
    (query ? "?" + query : "") + (fragment ? "#" + fragment : ""));
}
export async function writeUri(p: JParcel, uri: JUri | null): Promise<void> {
  await vcall(p, "writeInt", "(I)V", uri ? 1 : 0);
  if (uri) await vcall(p, "writeString8", "(Ljava/lang/String;)V", uri.uri);
}
rt.register({
  name: "android/net/Uri", ctor: JUri, ifaces: ["android/os/Parcelable", "java/lang/Comparable"],
  statics: { get EMPTY() { return mkUri(""); }, get CREATOR() { return parcelCreator("android/net/Uri", readUri); } },
  methods: {
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JUri, p: JParcel): Gen { yield writeUri(p, this); }),
    "static writeToParcel(Landroid/os/Parcel;Landroid/net/Uri;)V": writeUri,
    "static parse(Ljava/lang/String;)Landroid/net/Uri;": (s: string) => mkUri(s),
    "static fromFile(Ljava/io/File;)Landroid/net/Uri;": (f: JObj) => mkUri("file://" + uriEncode(pathOf(f), "/")),
    "static fromParts(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Landroid/net/Uri;": (scheme: string | null, ssp: string | null, frag: string | null) => {
      if (scheme === null) throw rt.mkThrowable("java/lang/NullPointerException", "scheme");
      if (ssp === null) throw rt.mkThrowable("java/lang/NullPointerException", "ssp");
      return mkUri(scheme + ":" + uriEncode(ssp) + (frag !== null ? "#" + uriEncode(frag) : ""));
    },
    "static encode(Ljava/lang/String;)Ljava/lang/String;": (s: string | null) => uriEncode(s),
    "static encode(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": (s: string | null, allow: string | null) => uriEncode(s, allow ?? ""),
    "static decode(Ljava/lang/String;)Ljava/lang/String;": (s: string | null) => uriDecode(s),
    "static withAppendedPath(Landroid/net/Uri;Ljava/lang/String;)Landroid/net/Uri;": (u: JUri, seg: string) => {
      const b = uriBuilderFrom(u);
      appendEncodedPath(b, uriEncode(seg)!);
      return buildUri(b);
    },
    "toString()Ljava/lang/String;": function (this: JUri) { return this.uri; },
    "isHierarchical()Z": function (this: JUri) { return uriParts(this).hier ? 1 : 0; },
    "isOpaque()Z": function (this: JUri) { return uriParts(this).hier ? 0 : 1; },
    "isAbsolute()Z": function (this: JUri) { return uriParts(this).scheme !== null ? 1 : 0; },
    "isRelative()Z": function (this: JUri) { return uriParts(this).scheme === null ? 1 : 0; },
    "getScheme()Ljava/lang/String;": function (this: JUri) { return uriParts(this).scheme; },
    "getSchemeSpecificPart()Ljava/lang/String;": function (this: JUri) { return uriDecode(uriParts(this).ssp); },
    "getEncodedSchemeSpecificPart()Ljava/lang/String;": function (this: JUri) { return uriParts(this).ssp; },
    "getAuthority()Ljava/lang/String;": function (this: JUri) { return uriDecode(uriParts(this).authority); },
    "getEncodedAuthority()Ljava/lang/String;": function (this: JUri) { return uriParts(this).authority; },
    "getUserInfo()Ljava/lang/String;": function (this: JUri) {
      const a = uriParts(this).authority, i = a?.lastIndexOf("@") ?? -1;
      return a && i >= 0 ? uriDecode(a.slice(0, i)) : null;
    },
    "getHost()Ljava/lang/String;": function (this: JUri) {
      const a = uriParts(this).authority;
      if (a === null) return null;
      const h = hostPort(a), c = h.indexOf(":");
      return uriDecode(c < 0 ? h : h.slice(0, c));
    },
    "getPort()I": function (this: JUri) {
      const a = uriParts(this).authority;
      if (a === null) return -1;
      const h = hostPort(a), c = h.indexOf(":");
      const n = c < 0 ? NaN : parseInt(uriDecode(h.slice(c + 1))!, 10);
      return Number.isInteger(n) ? n : -1;
    },
    "getPath()Ljava/lang/String;": function (this: JUri) { const p = uriParts(this); return p.hier ? uriDecode(p.path) : null; },
    "getEncodedPath()Ljava/lang/String;": function (this: JUri) { const p = uriParts(this); return p.hier ? p.path : null; },
    "getPathSegments()Ljava/util/List;": function (this: JUri) { return newArrayList(rawSegments(uriParts(this)).map((x) => uriDecode(x))); },
    "getLastPathSegment()Ljava/lang/String;": function (this: JUri) {
      const segs = rawSegments(uriParts(this));
      return segs.length ? uriDecode(segs[segs.length - 1]) : null;
    },
    "getQuery()Ljava/lang/String;": function (this: JUri) { return uriDecode(uriParts(this).query); },
    "getEncodedQuery()Ljava/lang/String;": function (this: JUri) { return uriParts(this).query; },
    "getQueryParameter(Ljava/lang/String;)Ljava/lang/String;": function (this: JUri, k: string | null) {
      if (k === null) throw rt.mkThrowable("java/lang/NullPointerException", "key");
      const p = uriParts(this);
      if (!p.hier) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "This isn't a hierarchical URI.");
      const ek = uriEncode(k);
      for (const [kk, v] of queryPairs(p.query)) if (kk === ek) return uriDecode(v);
      return null;
    },
    "getQueryParameters(Ljava/lang/String;)Ljava/util/List;": function (this: JUri, k: string) {
      const p = uriParts(this), ek = uriEncode(k), out: unknown[] = [];
      for (const [kk, v] of queryPairs(p.query)) if (kk === ek) out.push(uriDecode(v));
      return newArrayList(out);
    },
    "getQueryParameterNames()Ljava/util/Set;": function (this: JUri) {
      const p = uriParts(this);
      if (!p.hier) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "This isn't a hierarchical URI.");
      const names: unknown[] = [];
      for (const [kk] of queryPairs(p.query)) names.push(uriDecode(kk));
      return newLinkedHashSet(names);
    },
    "getBooleanQueryParameter(Ljava/lang/String;Z)Z": function (this: JUri, k: string, d: number) {
      const p = uriParts(this), ek = uriEncode(k);
      for (const [kk, v] of queryPairs(p.query)) {
        if (kk !== ek) continue;
        const f = uriDecode(v)!.toLowerCase();
        return f === "false" || f === "0" ? 0 : 1;
      }
      return d;
    },
    "getFragment()Ljava/lang/String;": function (this: JUri) { return uriDecode(uriParts(this).fragment); },
    "getEncodedFragment()Ljava/lang/String;": function (this: JUri) { return uriParts(this).fragment; },
    "buildUpon()Landroid/net/Uri$Builder;": function (this: JUri) { return uriBuilderFrom(this); },
    "normalizeScheme()Landroid/net/Uri;": function (this: JUri) {
      const p = uriParts(this);
      if (p.scheme === null || p.scheme === p.scheme.toLowerCase()) return this;
      return mkUri(p.scheme.toLowerCase() + this.uri.slice(p.scheme.length));
    },
    "compareTo(Landroid/net/Uri;)I": compareUri,
    "compareTo(Ljava/lang/Object;)I": compareUri,
    "equals(Ljava/lang/Object;)Z": function (this: JUri, o: unknown) { return o instanceof JUri && o.uri === this.uri ? 1 : 0; },
    "hashCode()I": function (this: JUri) { return stringHash(this.uri); },
    "describeContents()I": () => 0,
  },
});
// Uri.Builder keeps every part already ENCODED, as AOSP does, so build() is a join.
class JUriBuilder extends JObj {
  scheme: string | null = null; opaque: string | null = null; authority: string | null = null;
  path: string | null = null; query: string | null = null; fragment: string | null = null;
}
function uriBuilderFrom(u: JUri): JUriBuilder {
  const p = uriParts(u), b = new JUriBuilder();
  b.scheme = p.scheme;
  if (p.hier) { b.authority = p.authority; b.path = p.path || null; b.query = p.query; }
  else b.opaque = p.ssp;
  b.fragment = p.fragment;
  return b;
}
function appendEncodedPath(b: JUriBuilder, seg: string) {
  const cur = b.path;
  b.path = cur === null || cur === "" ? (b.authority !== null || b.opaque === null ? "/" : "") + seg
    : cur.endsWith("/") ? cur + seg : cur + "/" + seg;
  b.opaque = null;
}
function buildUri(b: JUriBuilder): JUri {
  if (b.opaque !== null) {
    if (b.scheme === null) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "An opaque URI must have a scheme.");
    return mkUri(b.scheme + ":" + b.opaque + (b.fragment !== null ? "#" + b.fragment : ""));
  }
  let path = b.path ?? "";
  if (b.authority !== null && path && !path.startsWith("/")) path = "/" + path;
  let s = "";
  if (b.scheme !== null) s += b.scheme + ":";
  if (b.authority !== null) s += "//" + b.authority;
  s += path;
  if (b.query !== null) s += "?" + b.query;
  if (b.fragment !== null) s += "#" + b.fragment;
  return mkUri(s);
}
const B = "Landroid/net/Uri$Builder;";
const bset = (f: keyof JUriBuilder, enc: (s: string | null) => string | null, hier = true) =>
  function (this: JUriBuilder, v: string | null) { (this as any)[f] = enc(v); if (hier) this.opaque = null; return this; };
rt.register({
  name: "android/net/Uri$Builder", ctor: JUriBuilder,
  methods: {
    "<init>()V": function () {},
    [`scheme(Ljava/lang/String;)${B}`]: bset("scheme", (s) => s, false),
    [`opaquePart(Ljava/lang/String;)${B}`]: function (this: JUriBuilder, s: string | null) { this.opaque = uriEncode(s); return this; },
    [`encodedOpaquePart(Ljava/lang/String;)${B}`]: function (this: JUriBuilder, s: string | null) { this.opaque = s; return this; },
    [`authority(Ljava/lang/String;)${B}`]: bset("authority", (s) => uriEncode(s)),
    [`encodedAuthority(Ljava/lang/String;)${B}`]: bset("authority", (s) => s),
    [`path(Ljava/lang/String;)${B}`]: bset("path", (s) => uriEncode(s, "/")),
    [`encodedPath(Ljava/lang/String;)${B}`]: bset("path", (s) => s),
    [`appendPath(Ljava/lang/String;)${B}`]: function (this: JUriBuilder, s: string) { appendEncodedPath(this, uriEncode(s)!); return this; },
    [`appendEncodedPath(Ljava/lang/String;)${B}`]: function (this: JUriBuilder, s: string) { appendEncodedPath(this, s); return this; },
    [`query(Ljava/lang/String;)${B}`]: bset("query", (s) => uriEncode(s, " ")),
    [`encodedQuery(Ljava/lang/String;)${B}`]: bset("query", (s) => s),
    [`appendQueryParameter(Ljava/lang/String;Ljava/lang/String;)${B}`]: function (this: JUriBuilder, k: string, v: string | null) {
      const kv = uriEncode(k) + "=" + (uriEncode(v) ?? "");
      this.query = this.query === null ? kv : this.query + "&" + kv;
      this.opaque = null;
      return this;
    },
    [`clearQuery()${B}`]: function (this: JUriBuilder) { this.query = null; return this; },
    [`fragment(Ljava/lang/String;)${B}`]: bset("fragment", (s) => uriEncode(s), false),
    [`encodedFragment(Ljava/lang/String;)${B}`]: bset("fragment", (s) => s, false),
    "build()Landroid/net/Uri;": function (this: JUriBuilder) { return buildUri(this); },
    "toString()Ljava/lang/String;": function (this: JUriBuilder) { return buildUri(this).uri; },
  },
});


// ── Wi-Fi: the relay's network is the one Wi-Fi network, and everything a location permission
// would gate (SSID, BSSID, address) reads as the platform's redacted values
class JWifiInfo extends JObj {}
class JScanResult extends JObj {
  SSID: string | null = null;
  BSSID: string | null = null;
  capabilities: string | null = null;
  level = 0;
  frequency = 0;
  timestamp = 0n;
}
rt.register({
  name: "android/net/wifi/ScanResult", ctor: JScanResult, ifaces: ["android/os/Parcelable"],
  fields: ["SSID", "BSSID", "capabilities", "level", "frequency", "timestamp"],
  methods: { "<init>()V": function () {}, "describeContents()I": () => 0 },
});
const supplicantStates = mkEnumSet("android/net/wifi/SupplicantState", [
  "DISCONNECTED", "INTERFACE_DISABLED", "INACTIVE", "SCANNING", "AUTHENTICATING", "ASSOCIATING",
  "ASSOCIATED", "FOUR_WAY_HANDSHAKE", "GROUP_HANDSHAKE", "COMPLETED", "DORMANT", "UNINITIALIZED", "INVALID",
]);
rt.register({
  name: "android/net/wifi/WifiInfo", ctor: JWifiInfo, ifaces: ["android/net/TransportInfo", "android/os/Parcelable"],
  methods: {
    "getSSID()Ljava/lang/String;": () => "<unknown ssid>",
    "getSupplicantState()Landroid/net/wifi/SupplicantState;": () => supplicantStates[11],
    "getBSSID()Ljava/lang/String;": () => "02:00:00:00:00:00",
    "getMacAddress()Ljava/lang/String;": () => "02:00:00:00:00:00",
    "getNetworkId()I": () => -1,
    "getIpAddress()I": () => 0,
    "getRssi()I": () => -127,
    "getLinkSpeed()I": () => -1,
    "getFrequency()I": () => -1,
    "getHiddenSSID()Z": () => 0,
    "describeContents()I": () => 0,
    "toString()Ljava/lang/String;": () => "SSID: <unknown ssid>, BSSID: 02:00:00:00:00:00, MAC: 02:00:00:00:00:00, RSSI: -127, Link speed: -1Mbps, Net ID: -1",
  },
});
class JDhcpInfo extends JObj { ipAddress = 0; gateway = 0; netmask = 0; dns1 = 0; dns2 = 0; serverAddress = 0; leaseDuration = 0; }
rt.register({
  name: "android/net/DhcpInfo", ctor: JDhcpInfo, ifaces: ["android/os/Parcelable"],
  fields: ["ipAddress", "gateway", "netmask", "dns1", "dns2", "serverAddress", "leaseDuration"],
  methods: { "<init>()V": function () {} },
});
class JWifiLock extends JObj { held = false; refCounted = true; acquisitions = 0; }
const wifiLockMethods = {
  "acquire()V": function (this: JWifiLock) {
    if (this.refCounted) this.acquisitions++;
    this.held = true;
  },
  "release()V": function (this: JWifiLock) {
    if (this.refCounted) {
      if (--this.acquisitions < 0) throw rt.mkThrowable("java/lang/RuntimeException", "WifiLock under-locked");
      this.held = this.acquisitions > 0;
    } else this.held = false;
  },
  "isHeld()Z": function (this: JWifiLock) { return +this.held; },
  "setReferenceCounted(Z)V": function (this: JWifiLock, enabled: number) { this.refCounted = !!enabled; },
};
rt.register({
  name: "android/net/wifi/WifiManager$WifiLock", ctor: JWifiLock,
  methods: wifiLockMethods,
});
rt.register({ name: "android/net/wifi/WifiManager$MulticastLock", ctor: class extends JWifiLock {}, methods: wifiLockMethods });
rt.register({
  name: "android/net/wifi/WifiManager", ctor: class extends JObj {},
  statics: { WIFI_STATE_DISABLED: 1, WIFI_STATE_ENABLED: 3, WIFI_STATE_UNKNOWN: 4, WIFI_STATE_CHANGED_ACTION: "android.net.wifi.WIFI_STATE_CHANGED", NETWORK_STATE_CHANGED_ACTION: "android.net.wifi.STATE_CHANGE", SCAN_RESULTS_AVAILABLE_ACTION: "android.net.wifi.SCAN_RESULTS" },
  methods: {
    "static calculateSignalLevel(II)I": (rssi: number, numLevels: number) => {
      if (rssi <= -100) return 0;
      const top = (numLevels - 1) | 0;
      if (rssi >= -55) return top;
      const scaled = Math.fround(Math.fround(Math.fround(rssi + 100) * Math.fround(top)) / 45);
      return Math.trunc(scaled) | 0;
    },
    // the one network is Wi-Fi: WIFI_STATE_ENABLED
    "isWifiEnabled()Z": () => 1,
    "getWifiState()I": () => 3,
    "setWifiEnabled(Z)Z": () => 0,
    "getConnectionInfo()Landroid/net/wifi/WifiInfo;": () => new JWifiInfo(),
    "getDhcpInfo()Landroid/net/DhcpInfo;": () => new JDhcpInfo(),
    "getScanResults()Ljava/util/List;": () => newArrayList(),
    "getConfiguredNetworks()Ljava/util/List;": () => newArrayList(),
    "createWifiLock(ILjava/lang/String;)Landroid/net/wifi/WifiManager$WifiLock;": () => new JWifiLock(),
    "createWifiLock(Ljava/lang/String;)Landroid/net/wifi/WifiManager$WifiLock;": () => new JWifiLock(),
    "createMulticastLock(Ljava/lang/String;)Landroid/net/wifi/WifiManager$MulticastLock;": () => rt.make("android/net/wifi/WifiManager$MulticastLock"),
    "startScan()Z": () => 0,
    "isScanAlwaysAvailable()Z": () => 0,
    "is5GHzBandSupported()Z": () => 0,
    "isP2pSupported()Z": () => 0,
  },
});
// TrafficStats: per-thread socket tagging for the kernel's accounting. Bytes are counted per
// tag nowhere here, so the tag is kept per thread and the totals answer UNSUPPORTED (-1).
const threadTags = new WeakMap<object, number>();
rt.register({
  name: "android/net/TrafficStats", ctor: class extends JObj {},
  statics: { UNSUPPORTED: -1 },
  methods: {
    "static setThreadStatsTag(I)V": (tag: number) => { threadTags.set(curThread, tag); },
    "static getThreadStatsTag()I": () => threadTags.get(curThread) ?? -1,
    "static getThreadStatsUid()I": () => -1,
    "static clearThreadStatsTag()V": () => { threadTags.set(curThread, -1); },
    "static getAndSetThreadStatsTag(I)I": (tag: number) => { const t = curThread; const old = threadTags.get(t) ?? -1; threadTags.set(t, tag); return old; },
    ...noops("static tagSocket(Ljava/net/Socket;)V", "static untagSocket(Ljava/net/Socket;)V",
      "static tagDatagramSocket(Ljava/net/DatagramSocket;)V", "static untagDatagramSocket(Ljava/net/DatagramSocket;)V",
      "static incrementOperationCount(I)V", "static incrementOperationCount(II)V"),
    // ActivityThread binds the stats service here; no per-uid stats are kept, so there is nothing to bind
    "static init(Landroid/content/Context;)V": () => {},
    "static getTotalRxBytes()J": () => -1n,
    "static getTotalTxBytes()J": () => -1n,
    "static getMobileRxBytes()J": () => -1n,
    "static getMobileTxBytes()J": () => -1n,
    "static getUidRxBytes(I)J": () => -1n,
    "static getUidTxBytes(I)J": () => -1n,
  },
});
