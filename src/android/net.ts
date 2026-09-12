// android.net: Uri, plus ConnectivityManager and the network-callback plumbing. Network state is
// read back out of ConnectivityManager's own NetworkInfo so the two cannot disagree; nothing here
// simulates the network going away.

import { rt, JObj, stubs, noops } from "../jvm/runtime";
import { vcall, curThread, stringHash, mkEnumSet } from "../jvm/natives/jlang";
import { newArrayList, newLinkedHashSet } from "../jvm/natives/jutil";
import { jarray } from "../jvm/abi";
import type { JFile } from "../jvm/natives/jio";
import { reportUncaught } from "./os";
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
class UriNode { code = -1; exact = new Map<string, UriNode>(); num: UriNode | null = null; text: UriNode | null = null; }
class JUriMatcher extends JObj { root = new UriNode(); }
rt.register({
  name: "android/content/UriMatcher", ctor: JUriMatcher,
  statics: { NO_MATCH: -1 },
  methods: {
    "<init>(I)V": function (this: JUriMatcher, code: number) { this.root.code = code; },
    "addURI(Ljava/lang/String;Ljava/lang/String;I)V": function (this: JUriMatcher, authority: string, path: string | null, code: number) {
      const segs = [authority, ...(path ?? "").split("/").filter(Boolean)];
      let n = this.root;
      for (const s of segs) {
        if (s === "#") n = n.num ??= new UriNode();
        else if (s === "*") n = n.text ??= new UriNode();
        else { let c = n.exact.get(s); if (!c) n.exact.set(s, (c = new UriNode())); n = c; }
      }
      n.code = code;
    },
    "match(Landroid/net/Uri;)I": function (this: JUriMatcher, u: JUri | null) {
      const p = u ? uriParts(u) : null;
      if (!p || p.authority === null) return this.root.code;
      const segs = [uriDecode(p.authority)!, ...p.path.split("/").filter(Boolean).map((x) => uriDecode(x)!)];
      let n: UriNode | null = this.root;
      for (const s of segs) {
        n = n.exact.get(s) ?? (n.num && /^\d+$/.test(s) ? n.num : n.text);
        if (!n) return -1;
      }
      return n.code;
    },
  },
});
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
    "writeToParcel(Landroid/os/Parcel;I)V": async function (this: JUri, p: JParcel) { await writeUri(p, this); },
    "static writeToParcel(Landroid/os/Parcel;Landroid/net/Uri;)V": writeUri,
    "static parse(Ljava/lang/String;)Landroid/net/Uri;": (s: string) => mkUri(s),
    "static fromFile(Ljava/io/File;)Landroid/net/Uri;": (f: JFile) => mkUri("file://" + uriEncode(f.path, "/")),
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
      const h = a.slice(a.lastIndexOf("@") + 1);
      const c = h.indexOf(":");
      return uriDecode(c < 0 ? h : h.slice(0, c));
    },
    "getPort()I": function (this: JUri) {
      const a = uriParts(this).authority;
      if (a === null) return -1;
      const h = a.slice(a.lastIndexOf("@") + 1), c = h.indexOf(":");
      const n = c < 0 ? NaN : parseInt(uriDecode(h.slice(c + 1))!, 10);
      return Number.isInteger(n) ? n : -1;
    },
    "getPath()Ljava/lang/String;": function (this: JUri) { const p = uriParts(this); return p.hier ? uriDecode(p.path) : null; },
    "getEncodedPath()Ljava/lang/String;": function (this: JUri) { const p = uriParts(this); return p.hier ? p.path : null; },
    "getPathSegments()Ljava/util/List;": function (this: JUri) {
      const p = uriParts(this);
      return newArrayList(p.hier ? p.path.split("/").filter(Boolean).map((x) => uriDecode(x)) : []);
    },
    "getLastPathSegment()Ljava/lang/String;": function (this: JUri) {
      const p = uriParts(this);
      const segs = p.hier ? p.path.split("/").filter(Boolean) : [];
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
    "compareTo(Landroid/net/Uri;)I": function (this: JUri, o: JUri) { return this.uri < o.uri ? -1 : this.uri > o.uri ? 1 : 0; },
    "compareTo(Ljava/lang/Object;)I": function (this: JUri, o: JUri) { return this.uri < o.uri ? -1 : this.uri > o.uri ? 1 : 0; },
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

/** the transport the one modelled network runs on: ConnectivityManager.TYPE_WIFI */
const NET_TYPE = 1;
const netUp = async (): Promise<number> =>
  (await vcall(rt.make("android/net/NetworkInfo"), "isConnected", "()Z")) ? 1 : 0;
class JNetwork extends JObj { id = 1; }
let theNetwork: JNetwork | null = null;
let boundNetwork: JNetwork | null = null;
const network = (): JNetwork => (theNetwork ??= rt.make("android/net/Network") as JNetwork);
const knownNetwork = (n: unknown): n is JNetwork => n instanceof JNetwork && n.id === network().id;
const netCaps = () => rt.make("android/net/NetworkCapabilities");
const netCallbacks = new Set<unknown>();
async function fireNetAvailable(cb: unknown) {
  if (!netCallbacks.has(cb) || !(await netUp())) return;
  await vcall(cb, "onAvailable", "(Landroid/net/Network;)V", network());
  await vcall(cb, "onCapabilitiesChanged", "(Landroid/net/Network;Landroid/net/NetworkCapabilities;)V", network(), netCaps());
}
rt.register({
  name: "android/net/Network", ctor: JNetwork, ifaces: ["android/os/Parcelable"],
  methods: {
    "getNetworkHandle()J": function (this: JNetwork) { return this.id ? (BigInt(this.id) << 32n) | 0xcafed00dn : 0n; },
    "static fromNetworkHandle(J)Landroid/net/Network;": (handle: bigint) => {
      if (handle <= 0n || (handle & 0xffffffffn) !== 0xcafed00dn) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid network handle");
      const n = new JNetwork(); n.id = Number(handle >> 32n); return n;
    },
    "equals(Ljava/lang/Object;)Z": function (this: JNetwork, other: unknown) { return other instanceof JNetwork && this.id === other.id ? 1 : 0; },
    "hashCode()I": function (this: JNetwork) { return Math.imul(this.id, 11); },
    "toString()Ljava/lang/String;": function (this: JNetwork) { return String(this.id); },
  },
});
const networkCapabilities = new Set([11, 12, 13, 14, 15, 18, 20, 21]);
rt.register({
  name: "android/net/NetworkCapabilities", ctor: class extends JObj {},
  statics: {
    TRANSPORT_CELLULAR: 0, TRANSPORT_WIFI: 1, TRANSPORT_ETHERNET: 3, TRANSPORT_VPN: 4,
    NET_CAPABILITY_NOT_METERED: 11, NET_CAPABILITY_INTERNET: 12, NET_CAPABILITY_NOT_RESTRICTED: 13,
    NET_CAPABILITY_TRUSTED: 14, NET_CAPABILITY_NOT_VPN: 15, NET_CAPABILITY_VALIDATED: 16,
    NET_CAPABILITY_NOT_ROAMING: 18, NET_CAPABILITY_NOT_CONGESTED: 20, NET_CAPABILITY_NOT_SUSPENDED: 21,
    NET_CAPABILITY_TEMPORARILY_NOT_METERED: 25,
  },
  methods: { "hasCapability(I)Z": async (c: number) => networkCapabilities.has(c) ? netUp() : 0, "hasTransport(I)Z": (t: number) => (t === NET_TYPE ? 1 : 0),
    // no bandwidth estimate: the platform's "unspecified"
    "getLinkDownstreamBandwidthKbps()I": () => 0, "getLinkUpstreamBandwidthKbps()I": () => 0, "getSignalStrength()I": () => -2147483648 },
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
    ...noops("onAvailable(Landroid/net/Network;)V", "onLosing(Landroid/net/Network;I)V",
      "onLost(Landroid/net/Network;)V", "onUnavailable()V",
      "onCapabilitiesChanged(Landroid/net/Network;Landroid/net/NetworkCapabilities;)V",
      "onLinkPropertiesChanged(Landroid/net/Network;Landroid/net/LinkProperties;)V",
      "onBlockedStatusChanged(Landroid/net/Network;Z)V"),
  },
});

rt.markers("android/net/ConnectivityManager$OnNetworkActiveListener");
const activeListeners = new Set<unknown>();
const registerCallback = (cb: unknown) => {
  if (!cb) return;
  netCallbacks.add(cb);
  setTimeout(() => void fireNetAvailable(cb).catch(reportUncaught), 0);
};
const registerOnHandler = async (cb: unknown, handler: unknown) => {
  if (!cb || !handler) throw rt.mkThrowable("java/lang/NullPointerException", "callback and handler are required");
  netCallbacks.add(cb);
  const task = rt.make("webdroid/FnRunnable");
  task.fn = () => fireNetAvailable(cb);
  await vcall(handler, "post", "(Ljava/lang/Runnable;)Z", task);
};
rt.register({
  name: "android/net/ConnectivityManager", ctor: class extends JObj {},
  statics: { TYPE_MOBILE: 0, TYPE_WIFI: 1, TYPE_ETHERNET: 9, TYPE_VPN: 17, RESTRICT_BACKGROUND_STATUS_DISABLED: 1 },
  methods: {
    "getActiveNetworkInfo()Landroid/net/NetworkInfo;": () => rt.make("android/net/NetworkInfo"),
    // the one Network, present exactly when NetworkInfo says connected (a null here with a
    // connected NetworkInfo reads as "no internet" to every modern connectivity check)
    "getActiveNetwork()Landroid/net/Network;": async () => (await netUp()) ? network() : null,
    "getAllNetworks()[Landroid/net/Network;": async () => jarray((await netUp()) ? [network()] : [], "Landroid/net/Network;"),
    "getNetworkInfo(Landroid/net/Network;)Landroid/net/NetworkInfo;": (n: unknown) => knownNetwork(n) ? rt.make("android/net/NetworkInfo") : null,
    // by network type (TYPE_WIFI/TYPE_MOBILE...): the one network we model is the active one,
    // so its own type answers and every other type has no info, as on a device without it
    "getNetworkInfo(I)Landroid/net/NetworkInfo;": async (t: number) =>
      (await netUp()) && t === NET_TYPE ? rt.make("android/net/NetworkInfo") : null,
    "getLinkProperties(Landroid/net/Network;)Landroid/net/LinkProperties;": () => null,
    "bindProcessToNetwork(Landroid/net/Network;)Z": (n: unknown) => {
      if (n != null && !knownNetwork(n)) return 0;
      boundNetwork = n ?? null; return 1;
    },
    "getBoundNetworkForProcess()Landroid/net/Network;": () => boundNetwork,
    "getRestrictBackgroundStatus()I": () => 1,
    "registerNetworkCallback(Landroid/net/NetworkRequest;Landroid/net/ConnectivityManager$NetworkCallback;)V": (_r: unknown, cb: unknown) => registerCallback(cb),
    "registerNetworkCallback(Landroid/net/NetworkRequest;Landroid/net/ConnectivityManager$NetworkCallback;Landroid/os/Handler;)V": async (_r: unknown, cb: unknown, handler: unknown) => registerOnHandler(cb, handler),
    "registerDefaultNetworkCallback(Landroid/net/ConnectivityManager$NetworkCallback;)V": registerCallback,
    "registerDefaultNetworkCallback(Landroid/net/ConnectivityManager$NetworkCallback;Landroid/os/Handler;)V": registerOnHandler,
    "requestNetwork(Landroid/net/NetworkRequest;Landroid/net/ConnectivityManager$NetworkCallback;)V": (_r: unknown, cb: unknown) => registerCallback(cb),
    "unregisterNetworkCallback(Landroid/net/ConnectivityManager$NetworkCallback;)V": (cb: unknown) => { netCallbacks.delete(cb); },
    "getNetworkCapabilities(Landroid/net/Network;)Landroid/net/NetworkCapabilities;": (n: unknown) => knownNetwork(n) ? netCaps() : null,
    "isActiveNetworkMetered()Z": () => 0,
    // The relay has no radio power-saving transitions while its network is available.
    "isDefaultNetworkActive()Z": async () => (await netUp()) ? 1 : 0,
    "addDefaultNetworkActiveListener(Landroid/net/ConnectivityManager$OnNetworkActiveListener;)V": (listener: unknown) => { activeListeners.add(listener); },
    "removeDefaultNetworkActiveListener(Landroid/net/ConnectivityManager$OnNetworkActiveListener;)V": (listener: unknown) => {
      if (!activeListeners.delete(listener)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Listener not registered");
    },
  },
});
const states = mkEnumSet("android/net/NetworkInfo$State", ["CONNECTING", "CONNECTED", "SUSPENDED", "DISCONNECTING", "DISCONNECTED", "UNKNOWN"]);
const detailedStates = mkEnumSet("android/net/NetworkInfo$DetailedState", ["IDLE", "SCANNING", "CONNECTING", "AUTHENTICATING", "OBTAINING_IPADDR", "CONNECTED", "SUSPENDED", "DISCONNECTING", "DISCONNECTED", "FAILED", "BLOCKED", "VERIFYING_POOR_LINK", "CAPTIVE_PORTAL_CHECK"]);
rt.register({
  name: "android/net/NetworkInfo", ctor: class extends JObj {},
  methods: {
    "getType()I": () => NET_TYPE,
    "getTypeName()Ljava/lang/String;": () => "WIFI",
    "getState()Landroid/net/NetworkInfo$State;": () => { rt.link("android/net/NetworkInfo$State"); return states[1]; },
    "getDetailedState()Landroid/net/NetworkInfo$DetailedState;": () => { rt.link("android/net/NetworkInfo$DetailedState"); return detailedStates[5]; },
    ...stubs(1, "isConnected()Z", "isConnectedOrConnecting()Z", "isAvailable()Z"),
    ...stubs(0, "getSubtype()I", "isRoaming()Z"),
    ...stubs("", "getSubtypeName()Ljava/lang/String;"),
    ...stubs(null, "getExtraInfo()Ljava/lang/String;", "getReason()Ljava/lang/String;"),
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
    "static clearThreadStatsTag()V": () => { threadTags.set(curThread, -1); },
    "static getAndSetThreadStatsTag(I)I": (tag: number) => { const t = curThread; const old = threadTags.get(t) ?? -1; threadTags.set(t, tag); return old; },
    ...noops("static tagSocket(Ljava/net/Socket;)V", "static untagSocket(Ljava/net/Socket;)V",
      "static tagDatagramSocket(Ljava/net/DatagramSocket;)V", "static untagDatagramSocket(Ljava/net/DatagramSocket;)V",
      "static incrementOperationCount(I)V", "static incrementOperationCount(II)V"),
    "static getTotalRxBytes()J": () => -1n,
    "static getTotalTxBytes()J": () => -1n,
    "static getMobileRxBytes()J": () => -1n,
    "static getMobileTxBytes()J": () => -1n,
    "static getUidRxBytes(I)J": () => -1n,
    "static getUidTxBytes(I)J": () => -1n,
  },
});

// The one network is Wi-Fi (NetworkInfo says so), so the Wi-Fi radio is on and associated.
// What a browser cannot see is what AOSP hides from an app without location access anyway:
// the SSID/BSSID placeholders, no RSSI, no scan results.
rt.register({
  name: "android/net/wifi/WifiInfo", ctor: class extends JObj {},
  methods: {
    "getSSID()Ljava/lang/String;": () => "<unknown ssid>",
    "getBSSID()Ljava/lang/String;": () => "02:00:00:00:00:00",
    "getMacAddress()Ljava/lang/String;": () => "02:00:00:00:00:00",
    "getRssi()I": () => -127,
    "getNetworkId()I": () => -1,
    "getLinkSpeed()I": () => -1,
    "getFrequency()I": () => -1,
    "getIpAddress()I": () => 0,
    "toString()Ljava/lang/String;": () => "SSID: <unknown ssid>, BSSID: 02:00:00:00:00:00, MAC: 02:00:00:00:00:00, RSSI: -127, Link speed: -1Mbps, Net ID: -1",
  },
});
rt.register({
  name: "android/net/wifi/WifiManager", ctor: class extends JObj {},
  statics: { WIFI_STATE_DISABLED: 1, WIFI_STATE_ENABLED: 3 },
  methods: {
    "isWifiEnabled()Z": () => 1,
    "getWifiState()I": () => 3,
    "getConnectionInfo()Landroid/net/wifi/WifiInfo;": () => rt.make("android/net/wifi/WifiInfo"),
    "getScanResults()Ljava/util/List;": () => newArrayList(),
    "getConfiguredNetworks()Ljava/util/List;": () => newArrayList(),
    ...stubs(0, "startScan()Z", "is5GHzBandSupported()Z", "isScanAlwaysAvailable()Z", "setWifiEnabled(Z)Z"),
  },
});
