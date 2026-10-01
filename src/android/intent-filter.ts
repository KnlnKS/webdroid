import { type JParcel, readInt, writeInt, readString, writeString, writeStrings, parcelCreator } from "./parcel";
import { vcall } from "../jvm/natives/jlang";
import { mkIter, toJsArray } from "../jvm/natives/jcoll";
import type { JPersistableBundle } from "./os";
import { JObj, rt, driven, type Gen } from "../jvm/runtime";
import { attr, attrStr, TV, type XmlNode } from "./axml";
import { jarray } from "../jvm/abi";
import { type JUri, hostPort, mkUri, uriDecode, uriParts } from "./net";
import { appHost } from "./apphost";
import { resString } from "./res";

/** what a manifest filter matches of an intent: its action, categories, data and resolved type */
export interface IntentFields { action: string | null; categories: Iterable<string>; dataUri: string | null; typeStr: string | null }

function value(node: XmlNode, name: string): string | null {
  const a = attr(node, name);
  return a?.type === TV.REFERENCE && appHost ? resString(appHost.res, a.data) : attrStr(node, name);
}

// Android's simple glob consumes greedily without regular-expression backtracking.
function simpleGlob(pattern: string, text: string): boolean {
  let p = 0, t = 0;
  while (p < pattern.length && t < text.length) {
    let c = pattern[p++]!, escaped = c === "\\";
    if (escaped) c = pattern[p++]!;
    if (pattern[p] === "*") {
      p++;
      if (!escaped && c === ".") {
        if (p === pattern.length) return true;
        let next = pattern[p++]!;
        if (next === "\\") next = pattern[p++]!;
        while (t < text.length && text[t] !== next) t++;
        if (t === text.length) return false;
        t++;
      } else while (text[t] === c && t < text.length) t++;
    } else if ((c !== "." || escaped) && c !== text[t++]) return false;
    else if (c === "." && !escaped) t++;
  }
  return p === pattern.length && t === text.length || pattern.slice(p) === ".*";
}

class JPatternMatcher extends JObj {
  path = ""; type = 0; parsed: Int32Array | null = null;
  matches(text: string): boolean {
    switch (this.type) {
      case 0: return text === this.path;
      case 1: return text.startsWith(this.path);
      case 2: return simpleGlob(this.path, text);
      case 4: return text.endsWith(this.path);
      default: throw rt.mkThrowable("java/lang/UnsupportedOperationException", "PatternMatcher type " + this.type);
    }
  }
}
async function readPattern(parcel: JParcel): Promise<JPatternMatcher> {
  rt.link("android/os/PatternMatcher");
  const pattern = new JPatternMatcher(); pattern.path = readString(parcel)!; pattern.type = readInt(parcel);
  pattern.parsed = await vcall(parcel, "createIntArray", "()[I"); return pattern;
}
async function writePattern(pattern: JPatternMatcher, parcel: JParcel): Promise<void> {
  writeString(parcel, pattern.path); writeInt(parcel, pattern.type);
  await vcall(parcel, "writeIntArray", "([I)V", pattern.parsed);
}
rt.register({ name: "android/os/PatternMatcher", ctor: JPatternMatcher, ifaces: ["android/os/Parcelable"],
statics: { get CREATOR() { return parcelCreator("android/os/PatternMatcher", readPattern); } }, methods: {
  "<init>(Landroid/os/Parcel;)V": driven(function* (this: JPatternMatcher, p: JParcel): Gen { Object.assign(this, yield readPattern(p)); }),
  "describeContents()I": () => 0,
  "writeToParcel(Landroid/os/Parcel;I)V": function (this: JPatternMatcher, p: JParcel) { return writePattern(this, p); },
  "<init>(Ljava/lang/String;I)V": function (this: JPatternMatcher, path: string, type: number) { this.path = path; this.type = type; },
  "getPath()Ljava/lang/String;": function (this: JPatternMatcher) { return this.path; },
  "getType()I": function (this: JPatternMatcher) { return this.type; },
  "match(Ljava/lang/String;)Z": function (this: JPatternMatcher, text: string | null) { return text === null ? 0 : +this.matches(text); },
} });
function matchAuthority(authority: string | null, wantedHost: string, wantedPort: number | null): number {
  if (authority === null) return -2;
  authority = hostPort(authority);
  const colon = authority.indexOf(":", authority.startsWith("[") ? authority.indexOf("]") : 0);
  const host = uriDecode(colon < 0 ? authority : authority.slice(0, colon))!.toLowerCase();
  const wanted = wantedHost.toLowerCase();
  if (!(wanted.startsWith("*") ? host.endsWith(wanted.slice(1)) : host === wanted)) return -2;
  if (wantedPort !== null) return colon >= 0 && Number(authority.slice(colon + 1)) === wantedPort ? 0x400000 : -2;
  return 0x300000;
}

function patterns(data: XmlNode[], name: string, text: string): boolean | null {
  let present = false;
  for (const node of data) {
    for (const suffix of ["", "Prefix", "Suffix", "Pattern", "AdvancedPattern"]) {
      const pattern = value(node, name + suffix);
      if (pattern === null) continue;
      present = true;
      if (suffix === "" ? text === pattern : suffix === "Prefix" ? text.startsWith(pattern) :
        suffix === "Suffix" ? text.endsWith(pattern) : suffix === "Pattern" && simpleGlob(pattern, text)) return true;
    }
  }
  return present ? false : null;
}

export function matchesIntentFilter(filter: XmlNode, intent: IntentFields, defaultOnly: boolean): boolean {
  const has = (kind: string, name: string) => filter.children.some((n) => n.name === kind && value(n, "name") === name);
  if (intent.action && !has("action", intent.action)) return false;
  if (defaultOnly && !has("category", "android.intent.category.DEFAULT")) return false;
  for (const category of intent.categories) if (!has("category", category)) return false;
  if (filter.children.some((n) => n.name === "uri-relative-filter-group")) return false;
  const data = filter.children.filter((n) => n.name === "data");
  const schemes = data.map((n) => value(n, "scheme")).filter((s) => s !== null);
  const types = data.map((n) => value(n, "mimeType")).filter((s) => s !== null);
  if (!schemes.length && !types.length) return intent.dataUri === null && intent.typeStr === null;
  const uri = intent.dataUri === null ? null : uriParts(mkUri(intent.dataUri));
  if (schemes.length) {
    if (!schemes.includes(uri?.scheme ?? "")) return false;
    const ssp = patterns(data, "ssp", uriDecode(uri?.ssp ?? "")!);
    if (ssp !== true) {
      const authorities = data.filter((n) => value(n, "host") !== null);
      if (authorities.length) {
        if (!authorities.some(n => matchAuthority(uri?.authority ?? null, value(n, "host")!, value(n, "port") === null ? null : Number(value(n, "port"))) >= 0)) return false;
        if (patterns(data, "path", uriDecode(uri?.path ?? "")!) === false) return false;
      } else if (ssp === false) return false;
    }
  } else if (uri?.scheme && uri.scheme !== "content" && uri.scheme !== "file") return false;
  if (!types.length) return intent.typeStr === null;
  if (!intent.typeStr) return false;
  const [major, minor] = intent.typeStr.split("/");
  return types.some((type) => {
    const [a, b] = type.split("/");
    return !!minor && !!b && (a === major || a === "*" || major === "*") && (b === minor || b === "*" || minor === "*");
  });
}

export class JIntentFilter extends JObj {
  actions: string[] = []; schemes: string[] = []; types: string[] = []; categories: string[] = [];
  authorities: { host: string; port: number | null }[] = [];
  paths: JPatternMatcher[] = []; ssp: JPatternMatcher[] = [];
  staticTypes: string[] = []; mimeGroups: string[] = [];
  priority = 0; staticPartial = 0; dynamicPartial = 0; autoVerify = 0; visibility = 0; order = 0;
  extras: JPersistableBundle | null = null;
  /** IntentFilter.match: NO_MATCH_ACTION (-3), a data/type failure, NO_MATCH_CATEGORY (-4), or the data match */
  match(action: string | null, type: string | null, scheme: string | null, data: JUri | null, categories: Iterable<string>): number {
    if (action !== null && !this.actions.includes(action)) return -3;
    const r = this.matchData(type, scheme, data);
    if (r < 0) return r;
    for (const c of categories) if (!this.categories.includes(c)) return -4;
    return r;
  }
  matchData(type: string | null, scheme: string | null, data: JUri | null): number {
    if (!this.types.length && !this.schemes.length) return type === null && data === null ? 0x100000 + 0x8000 : -2;
    let match = 0x100000;
    if (this.schemes.length) {
      if (scheme === null || !this.schemes.includes(scheme)) return -2;
      match = 0x200000;
      if (this.ssp.length && data && this.ssp.some(p => p.matches(uriDecode(uriParts(data).ssp)!))) match = 0x580000;
      else if (this.authorities.length) {
        const parts = data ? uriParts(data) : null;
        match = -2;
        for (const authority of this.authorities) {
          match = matchAuthority(parts?.authority ?? null, authority.host, authority.port);
          if (match >= 0) break;
        }
        if (match < 0) return -2;
        if (this.paths.length) {
          if (!this.paths.some(path => path.matches(uriDecode(parts?.path ?? "")!))) return -2;
          match = 0x500000;
        }
      } else if (this.ssp.length) return -2;
    } else if (scheme !== null && scheme !== "" && scheme !== "content" && scheme !== "file") return -2;
    if (this.types.length) {
      if (type === null) return -1;
      const slash = type.indexOf("/"), base = slash < 0 ? type : type.slice(0, slash);
      if (!(type === "*/*" || this.types.some(t => t === type || t === "*" || t === base || type.endsWith("/*") && t.startsWith(base + "/")))) return -1;
      return 0x600000 + 0x8000;
    }
    return type !== null ? -1 : match + 0x8000;
  }
}
function readStrings(p: JParcel): string[] {
  const values: string[] = [], count = readInt(p);
  if (count < 0 || count > (p.size - p.pos) / 4) throw rt.mkThrowable("android/os/BadParcelableException", "Invalid string count");
  for (let i = 0; i < count; i++) values.push(readString(p)!); return values;
}
const filterLists = ["categories", "schemes", "staticTypes", "types", "mimeGroups"] as const;
const filterInts = ["priority", "staticPartial", "dynamicPartial", "autoVerify", "visibility", "order"] as const;
async function readFilter(p: JParcel): Promise<JIntentFilter> {
  rt.link("android/content/IntentFilter");
  const filter = new JIntentFilter(); filter.actions = readStrings(p);
  for (const key of filterLists) if (readInt(p)) filter[key] = readStrings(p);
  for (let n = readInt(p); n > 0; n--) filter.ssp.push(await readPattern(p));
  for (let n = readInt(p); n > 0; n--) {
    const host = readString(p)!; readString(p); readInt(p); const port = readInt(p);
    filter.authorities.push({ host, port: port < 0 ? null : port });
  }
  for (let n = readInt(p); n > 0; n--) filter.paths.push(await readPattern(p));
  for (const key of filterInts) filter[key] = readInt(p);
  if (readInt(p)) filter.extras = await vcall(p, "readPersistableBundle", "()Landroid/os/PersistableBundle;");
  if (readInt(p)) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "URI-relative intent filter groups");
  return filter;
}
async function writeFilter(filter: JIntentFilter, p: JParcel): Promise<void> {
  writeStrings(p, filter.actions);
  for (const key of filterLists) { writeInt(p, +!!filter[key].length); if (filter[key].length) writeStrings(p, filter[key]); }
  writeInt(p, filter.ssp.length); for (const pattern of filter.ssp) await writePattern(pattern, p);
  writeInt(p, filter.authorities.length);
  for (const { host, port } of filter.authorities) {
    const wild = host.startsWith("*"); writeString(p, host); writeString(p, wild ? host.slice(1) : host);
    writeInt(p, +wild); writeInt(p, port ?? -1);
  }
  writeInt(p, filter.paths.length); for (const pattern of filter.paths) await writePattern(pattern, p);
  for (const key of filterInts) writeInt(p, filter[key]);
  writeInt(p, +!!filter.extras); if (filter.extras) await vcall(p, "writePersistableBundle", "(Landroid/os/PersistableBundle;)V", filter.extras);
  writeInt(p, 0);
}
const addAction = function (this: JIntentFilter, a: string) { this.actions.push(a); };
rt.register({
  name: "android/content/IntentFilter", ctor: JIntentFilter, ifaces: ["android/os/Parcelable"],
  statics: { get CREATOR() { return parcelCreator("android/content/IntentFilter", readFilter); }, MATCH_CATEGORY_MASK: 0xfff0000, MATCH_ADJUSTMENT_MASK: 0xffff, MATCH_ADJUSTMENT_NORMAL: 0x8000, MATCH_CATEGORY_EMPTY: 0x100000, MATCH_CATEGORY_SCHEME: 0x200000,
    MATCH_CATEGORY_TYPE: 0x600000, NO_MATCH_TYPE: -1, NO_MATCH_DATA: -2, NO_MATCH_ACTION: -3, NO_MATCH_CATEGORY: -4 },
  methods: {
    "<init>(Landroid/os/Parcel;)V": driven(function* (this: JIntentFilter, p: JParcel): Gen { Object.assign(this, yield readFilter(p)); }),
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": function (this: JIntentFilter, p: JParcel) { return writeFilter(this, p); },
    "setPriority(I)V": function (this: JIntentFilter, priority: number) { this.priority = priority; },
    "getPriority()I": function (this: JIntentFilter) { return this.priority; },
    "<init>()V": function () {},
    "<init>(Ljava/lang/String;)V": addAction,
    "addAction(Ljava/lang/String;)V": addAction,
    "countActions()I": function (this: JIntentFilter) { return this.actions.length; },
    "getAction(I)Ljava/lang/String;": function (this: JIntentFilter, i: number) { return this.actions[i] ?? null; },
    "hasAction(Ljava/lang/String;)Z": function (this: JIntentFilter, a: string) { return this.actions.includes(a) ? 1 : 0; },
    "actionsIterator()Ljava/util/Iterator;": function (this: JIntentFilter) { return mkIter(this.actions.slice()); },
    "addCategory(Ljava/lang/String;)V": function (this: JIntentFilter, c: string) { this.categories.push(c); },
    "hasCategory(Ljava/lang/String;)Z": function (this: JIntentFilter, c: string) { return this.categories.includes(c) ? 1 : 0; },
    "countCategories()I": function (this: JIntentFilter) { return this.categories.length; },
    "countDataSchemes()I": function (this: JIntentFilter) { return this.schemes.length; },
    "countDataTypes()I": function (this: JIntentFilter) { return this.types.length; },
    "matchAction(Ljava/lang/String;)Z": function (this: JIntentFilter, a: string | null) { return a !== null && this.actions.includes(a) ? 1 : 0; },
    "matchCategories(Ljava/util/Set;)Ljava/lang/String;": driven(function* (this: JIntentFilter, cats: unknown): Gen {
      for (const c of cats ? (yield toJsArray(cats)) as string[] : []) if (!this.categories.includes(c)) return c;
      return null;
    }),
    "matchData(Ljava/lang/String;Ljava/lang/String;Landroid/net/Uri;)I": function (this: JIntentFilter, type: string | null, scheme: string | null, data: JUri | null) {
      return this.matchData(type, scheme, data);
    },
    "match(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Landroid/net/Uri;Ljava/util/Set;Ljava/lang/String;)I":
    driven(function* (this: JIntentFilter, action: string | null, type: string | null, scheme: string | null, data: JUri | null, cats: unknown): Gen {
      return this.match(action, type, scheme, data, cats ? (yield toJsArray(cats)) as string[] : []);
    }),
    "addDataAuthority(Ljava/lang/String;Ljava/lang/String;)V": function (this: JIntentFilter, host: string, port: string | null) { this.authorities.push({ host, port: port === null ? null : Number(port) }); },
    "addDataPath(Ljava/lang/String;I)V": function (this: JIntentFilter, path: string, type: number) {
      rt.link("android/os/PatternMatcher"); this.paths.push(Object.assign(new JPatternMatcher(), { path, type }));
    },
    "addDataSchemeSpecificPart(Ljava/lang/String;I)V": function (this: JIntentFilter, ssp: string, type: number) {
      rt.link("android/os/PatternMatcher"); this.ssp.push(Object.assign(new JPatternMatcher(), { path: ssp, type }));
    },
    "addMimeGroup(Ljava/lang/String;)V": function (this: JIntentFilter, group: string) { if (!this.mimeGroups.includes(group)) this.mimeGroups.push(group); },
    "countMimeGroups()I": function (this: JIntentFilter) { return this.mimeGroups.length; },
    "getMimeGroup(I)Ljava/lang/String;": function (this: JIntentFilter, i: number) { return this.mimeGroups[i] ?? null; },
    "setAutoVerify(Z)V": function (this: JIntentFilter, verify: number) { this.autoVerify = verify; },
    "setVisibilityToInstantApp(I)V": function (this: JIntentFilter, visibility: number) { this.visibility = visibility; },
    "isVisibleToInstantApp()Z": function (this: JIntentFilter) { return this.visibility !== 0 ? 1 : 0; },
    "isExplicitlyVisibleToInstantApp()Z": function (this: JIntentFilter) { return this.visibility === 1 ? 1 : 0; },
    "isImplicitlyVisibleToInstantApp()Z": function (this: JIntentFilter) { return this.visibility === 2 ? 1 : 0; },
    "getCategory(I)Ljava/lang/String;": function (this: JIntentFilter, i: number) { return this.categories[i] ?? null; },
    "getDataScheme(I)Ljava/lang/String;": function (this: JIntentFilter, i: number) { return this.schemes[i] ?? null; },
    "hasDataScheme(Ljava/lang/String;)Z": function (this: JIntentFilter, scheme: string) { return this.schemes.includes(scheme) ? 1 : 0; },
    "getDataType(I)Ljava/lang/String;": function (this: JIntentFilter, i: number) { return this.types[i] ?? null; },
    "getHosts()[Ljava/lang/String;": function (this: JIntentFilter) { return jarray(this.authorities.map((a) => a.host), "Ljava/lang/String;"); },
    "setOrder(I)V": function (this: JIntentFilter, order: number) { this.order = order; },
    "getOrder()I": function (this: JIntentFilter) { return this.order; },
    "countDataPaths()I": function (this: JIntentFilter) { return this.paths.length; },
    "getDataPath(I)Landroid/os/PatternMatcher;": function (this: JIntentFilter, index: number) { if (index < 0 || index >= this.paths.length) rt.aio(index, this.paths.length); return this.paths[index]; },
    "hasDataPath(Ljava/lang/String;)Z": function (this: JIntentFilter, path: string) { return +this.paths.some(p => p.matches(path)); },
    "addDataScheme(Ljava/lang/String;)V": function (this: { schemes: string[] }, scheme: string) { this.schemes.push(scheme); },
    "addDataType(Ljava/lang/String;)V": function (this: JIntentFilter, type: string) {
      const slash = type.indexOf("/");
      if (slash <= 0 || slash + 1 >= type.length) throw rt.mkThrowable("android/content/IntentFilter$MalformedMimeTypeException", type);
      if (type.slice(slash + 1) === "*") { type = type.slice(0, slash); this.staticPartial = 1; }
      if (!this.types.includes(type)) this.types.push(type);
      if (!this.staticTypes.includes(type)) this.staticTypes.push(type);
    },
    "hasDataType(Ljava/lang/String;)Z": function (this: { types: string[] }, type: string) { return this.types.includes(type) ? 1 : 0; },
  },
});
