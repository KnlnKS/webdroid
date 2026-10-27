// android.content.Intent and ComponentName are AOSP's own classes; the shell reads and builds them
// through their Java API with the helpers here. The activities the platform answers through the
// browser (pickers, share, VIEW) register here too.
import { awaited, type JObj, driven, type Gen } from "../jvm/runtime.ts";
import { newObj, vcall } from "../jvm/natives/jentry.ts";
import { toJsArray } from "../jvm/natives/jcoll.ts";
import { mkUri } from "./net.ts";

/** an android.content.Intent */
export type JIntent = JObj;
/** an android.content.ComponentName */
export type JComponentName = JObj;
const S = "Ljava/lang/String;", I = "Landroid/content/Intent;";

/** `new Intent(action)` */
export const newIntent = (action: string | null = null): PromiseOrVal<JIntent> => newObj("android/content/Intent", `(${S})V`, action);
export const mkComponentName = (pkg: string, cls: string): PromiseOrVal<JComponentName> =>
  newObj("android/content/ComponentName", `(${S}${S})V`, pkg, cls);
/** a component by its package and class name */
export type ComponentRef = { pkg: string; cls: string };
/** a ComponentName's package and class */
export function* componentParts$(component: JComponentName | null): Gen<ComponentRef | null> {
  if (!component) return null;
  return { pkg: yield vcall(component, "getPackageName", `()${S}`), cls: yield vcall(component, "getClassName", `()${S}`) };
}
/** a copy of `intent` sent to `component` */
export function* withComponent$(intent: JIntent, component: JComponentName): Gen<JIntent> {
  const copy = yield newObj("android/content/Intent", `(${I})V`, intent);
  yield vcall(copy, "setComponent", `(Landroid/content/ComponentName;)${I}`, component);
  return copy;
}

/** what the shell routes an Intent by, read through its Java API */
export interface IntentQuery {
  action: string | null; categories: string[]; dataUri: string | null; typeStr: string | null;
  pkg: string | null; component: string | null; componentPkg: string | null;
}
/** `resolvedType` stands for Intent.getType, as a caller's resolveTypeIfNeeded does */
export function* intentQuery$(intent: JIntent, resolvedType?: string | null): Gen<IntentQuery> {
  const component = yield* componentParts$(yield vcall(intent, "getComponent", "()Landroid/content/ComponentName;"));
  const categories: JObj | null = yield vcall(intent, "getCategories", "()Ljava/util/Set;");
  const data: JObj | null = yield vcall(intent, "getData", "()Landroid/net/Uri;");
  return {
    action: yield vcall(intent, "getAction", `()${S}`),
    categories: categories ? (yield* awaited(toJsArray(categories))) as string[] : [],
    dataUri: data && (yield vcall(data, "toString", `()${S}`)),
    typeStr: resolvedType !== undefined ? resolvedType : yield vcall(intent, "getType", `()${S}`),
    pkg: yield vcall(intent, "getPackage", `()${S}`),
    component: component?.cls ?? null, componentPkg: component?.pkg ?? null,
  };
}
/** Intent.putExtra for a value of descriptor `desc` */
export const putExtra = (intent: JIntent, key: string, value: unknown, desc: string): unknown =>
  vcall(intent, "putExtra", `(${S}${desc})${I}`, key, value);

/**
 * The activities the *system* provides, keyed by the action an app sends. On a device these are
 * DocumentsUI; here they are the browser's own pickers. Each answers with the result Intent, or
 * null for "the user backed out" — which is RESULT_CANCELED, not an error.
 */
/** a system activity's result: its data as RESULT_OK, null as RESULT_CANCELED, or an explicit code */
export type SystemResult = JIntent | null | { resultCode: number; data: JIntent | null };
export type SystemHandler = (intent: JIntent) => PromiseOrVal<SystemResult>;
const systemActivities = new Map<string, { run: SystemHandler; schemes?: string[] }[]>();
/** `schemes` scopes a handler to intents whose data has one of them; such a handler yields to
 *  any installed activity that matches, as a default browser does to an app's own links. */
export function registerSystemActivity(action: string, run: SystemHandler, schemes?: string[]) {
  const handlers = systemActivities.get(action) ?? [];
  systemActivities.set(action, [...handlers, { run, schemes }]);
}
/** The platform package answers for them, as ResolverActivity and DocumentsUI do on a device, so
 *  an intent resolved to that component and started explicitly reaches the same handler. */
export const SYSTEM_ACTIVITY = "com.android.internal.app.ResolverActivity";
export function systemActivity(intent: Pick<IntentQuery, "action" | "dataUri" | "component" | "componentPkg"> | null, scoped = true): SystemHandler | null {
  if (!intent || intent.component && (intent.componentPkg !== "android" || intent.component !== SYSTEM_ACTIVITY)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(intent.dataUri ?? "")?.[1].toLowerCase() ?? "";
  return systemActivities.get(intent.action ?? "")?.find((h) => h.schemes ? scoped && h.schemes.includes(scheme) : true)?.run ?? null;
}
/** a picker's result: the chosen uri, with the grants it carries */
export const mkResultIntent = driven(function* (uri: string | null, flags: number): Gen<JIntent> {
  const intent = yield* awaited(newIntent());
  if (uri !== null) yield vcall(intent, "setData", `(Landroid/net/Uri;)${I}`, yield* awaited(mkUri(uri)));
  yield vcall(intent, "setFlags", `(I)${I}`, flags);
  return intent;
});
