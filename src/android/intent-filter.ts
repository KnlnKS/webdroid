// A manifest <intent-filter> as the package parser builds it (ParsedIntentInfoUtils.parseIntentInfo,
// parseData and parseRelRefGroup), matched as PackageManagerService's IntentResolver matches it:
// with AOSP's own IntentFilter.
import type { JObj, Gen } from "../jvm/runtime.ts";
import { newObj, vcall } from "../jvm/natives/jentry.ts";
import { newLinkedHashSet } from "../jvm/natives/jcoll.ts";
import { attr, attrStr, TV, type XmlNode } from "./axml.ts";
import { mkUri } from "./net.ts";
import { resString, type Resources } from "./res.ts";
import type { IntentQuery } from "./intent.ts";
import { awaited } from "../jvm/runtime.ts";

const S = "Ljava/lang/String;";
/** an attribute's string, a reference read through the resources of the filter's own package */
function value(res: Resources, node: XmlNode, name: string): string | null {
  const a = attr(node, name);
  return a?.type === TV.REFERENCE ? resString(res, a.data) : attrStr(node, name);
}
/** each attribute suffix's PatternMatcher type: LITERAL, PREFIX, SIMPLE_GLOB, ADVANCED_GLOB, SUFFIX */
const PATTERNS = [["", 0], ["Prefix", 1], ["Pattern", 2], ["AdvancedPattern", 3], ["Suffix", 4]] as const;
/** UriRelativeFilter's PATH, QUERY and FRAGMENT */
const URI_PARTS = [["path", 0], ["query", 1], ["fragment", 2]] as const;

const filters = new WeakMap<XmlNode, JObj>();
/** the IntentFilter the package parser builds from `node`, a filter of the package `res` belongs to */
export function* manifestFilter$(node: XmlNode, res: Resources): Gen<JObj> {
  const known = filters.get(node);
  if (known) return known;
  const filter: JObj = yield newObj("android/content/IntentFilter");
  yield vcall(filter, "setPriority", "(I)V", attr(node, "priority")?.data ?? 0);
  yield vcall(filter, "setOrder", "(I)V", attr(node, "order")?.data ?? 0);
  for (const child of node.children) {
    const name = child.name === "action" || child.name === "category" ? value(res, child, "name") : null;
    if (child.name === "action" && name !== null) yield vcall(filter, "addAction", `(${S})V`, name);
    else if (child.name === "category" && name !== null) yield vcall(filter, "addCategory", `(${S})V`, name);
    else if (child.name === "data") yield* addData$(filter, res, child);
    else if (child.name === "uri-relative-filter-group") yield* addGroup$(filter, res, child);
  }
  filters.set(node, filter);
  return filter;
}
function* addData$(filter: JObj, res: Resources, data: XmlNode): Gen<void> {
  const type = value(res, data, "mimeType"), group = value(res, data, "mimeGroup"), scheme = value(res, data, "scheme");
  if (type !== null) yield vcall(filter, "addDataType", `(${S})V`, type);
  if (group !== null) yield vcall(filter, "addMimeGroup", `(${S})V`, group);
  if (scheme !== null) yield vcall(filter, "addDataScheme", `(${S})V`, scheme);
  for (const [suffix, pattern] of PATTERNS) {
    const ssp = value(res, data, "ssp" + suffix);
    if (ssp !== null) yield vcall(filter, "addDataSchemeSpecificPart", `(${S}I)V`, ssp, pattern);
  }
  const host = value(res, data, "host");
  if (host !== null) yield vcall(filter, "addDataAuthority", `(${S}${S})V`, host, value(res, data, "port"));
  for (const [suffix, pattern] of PATTERNS) {
    const path = value(res, data, "path" + suffix);
    if (path !== null) yield vcall(filter, "addDataPath", `(${S}I)V`, path, pattern);
  }
}
/** the reference build parses these (Flags.relativeReferenceIntentFilters is true there) */
function* addGroup$(filter: JObj, res: Resources, node: XmlNode): Gen<void> {
  const allow = attr(node, "allow");
  const group: JObj = yield newObj("android/content/UriRelativeFilterGroup", "(I)V", allow?.type === TV.BOOLEAN && !allow.data ? 1 : 0);
  let added = false;
  for (const data of node.children) if (data.name === "data") for (const [part, id] of URI_PARTS) for (const [suffix, pattern] of PATTERNS) {
    const text = value(res, data, part + suffix);
    if (text === null) continue;
    yield vcall(group, "addUriRelativeFilter", "(Landroid/content/UriRelativeFilter;)V",
      yield newObj("android/content/UriRelativeFilter", `(II${S})V`, id, pattern, text));
    added = true;
  }
  if (added) yield vcall(filter, "addUriRelativeFilterGroup", "(Landroid/content/UriRelativeFilterGroup;)V", group);
}

/** what IntentFilter.match takes of an intent: its action, resolved type, scheme, data and categories */
type IntentTarget = { action: string | null; type: string | null; scheme: string | null; data: JObj | null; categories: JObj | null };
export function* intentTarget$(q: IntentQuery): Gen<IntentTarget> {
  const data: JObj | null = q.dataUri === null ? null : yield* awaited(mkUri(q.dataUri));
  return { action: q.action, type: q.typeStr, data, scheme: data && (yield vcall(data, "getScheme", `()${S}`)),
    categories: q.categories.length ? yield* awaited(newLinkedHashSet(q.categories)) : null };
}
/** IntentResolver.buildResolveList: the filter's match, and with `defaultOnly` its CATEGORY_DEFAULT */
export function* matches$(filter: JObj, target: IntentTarget, defaultOnly: boolean): Gen<boolean> {
  const match: number = yield vcall(filter, "match", `(${S}${S}${S}Landroid/net/Uri;Ljava/util/Set;${S})I`,
    target.action, target.type, target.scheme, target.data, target.categories, "PackageManager");
  return match >= 0 && (!defaultOnly || !!(yield vcall(filter, "hasCategory", `(${S})Z`, "android.intent.category.DEFAULT")));
}
