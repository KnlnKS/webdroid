// android.content.Intent and ComponentName are AOSP's own classes; the shell reads and builds them
// through their Java API, with the helpers here. Starting an activity from an intent is the
// shell's half of ActivityManager: resolution, the platform's own activities and results.
import { JObj, rt, driven, type Gen } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { toJsArray } from "../jvm/natives/jcoll";
import { reportUncaught, PROCESS_NAME } from "./os";
import type { AppHost } from "./apphost";
import { mkUri } from "./net";
import type { JActivity } from "./app";
import { onMain } from "./mainloop";

/** an android.content.Intent */
export type JIntent = JObj;
/** an android.content.ComponentName */
export type JComponentName = JObj;
const S = "Ljava/lang/String;", I = "Landroid/content/Intent;";

/** `new Intent(action)` */
export const newIntent = (action: string | null = null): Promise<JIntent> => newObj("android/content/Intent", `(${S})V`, action);
export const mkComponentName = (pkg: string, cls: string): Promise<JComponentName> =>
  newObj("android/content/ComponentName", `(${S}${S})V`, pkg, cls);
/** a ComponentName's package and class */
export function* componentParts$(component: JComponentName | null): Gen<{ pkg: string; cls: string } | null> {
  if (!component) return null;
  return { pkg: yield vcall(component, "getPackageName", `()${S}`), cls: yield vcall(component, "getClassName", `()${S}`) };
}
export const componentParts = driven(componentParts$);

/** what the shell routes an Intent by, read through its Java API */
export interface IntentQuery {
  action: string | null; categories: string[]; dataUri: string | null; typeStr: string | null;
  pkg: string | null; component: string | null; componentPkg: string | null; flags: number;
}
/** `resolvedType` stands for Intent.getType, as a caller's resolveTypeIfNeeded does */
export function* intentQuery$(intent: JIntent, resolvedType?: string | null): Gen<IntentQuery> {
  const component = yield* componentParts$(yield vcall(intent, "getComponent", "()Landroid/content/ComponentName;"));
  const categories: JObj | null = yield vcall(intent, "getCategories", "()Ljava/util/Set;");
  const data: JObj | null = yield vcall(intent, "getData", "()Landroid/net/Uri;");
  return {
    action: yield vcall(intent, "getAction", `()${S}`),
    categories: categories ? (yield toJsArray(categories)) as string[] : [],
    dataUri: data && (yield vcall(data, "toString", `()${S}`)),
    typeStr: resolvedType !== undefined ? resolvedType : yield vcall(intent, "getType", `()${S}`),
    pkg: yield vcall(intent, "getPackage", `()${S}`),
    component: component?.cls ?? null, componentPkg: component?.pkg ?? null,
    flags: yield vcall(intent, "getFlags", "()I"),
  };
}
export const intentQuery = driven(intentQuery$);
/** Intent.putExtra for a value of descriptor `desc` */
export const putExtra = (intent: JIntent, key: string, value: unknown, desc: string): unknown =>
  vcall(intent, "putExtra", `(${S}${desc})${I}`, key, value);

export type ActivityResultTarget = { act: JActivity; code: number };
export const activityTransport: {
  launch?: (pkg: string, process: string, component: string, intent: JIntent, result?: ActivityResultTarget) => Promise<void>;
  finish?: (act: JActivity) => boolean;
  attach?: (act: JActivity, task: number, affinity: string) => void;
  finishAffinity?: (act: JActivity) => void;
  isTaskRoot?: (act: JActivity) => boolean;
  removeTask?: (act: JActivity) => void;
  presentation?: (translucent: boolean) => void;
  /** an activity the broker started here (its record id) finished with a result */
  finished?: (remoteId: number, code: number, data: JIntent | null) => void;
} = {};
/** `sender` is the package whose identity the start carries (a PendingIntent's creator) */
export async function launchIntent(host: AppHost, intent: JIntent, result?: ActivityResultTarget, sender = host.pkg) {
  const runSystem = (system: SystemHandler) => {
    // the system activity covered its caller, which resumes after its result, unless the
    // system activity went on to start another one in front of it
    const caller = result?.act ?? host.currentActivity();
    void system(intent).then((data) => {
      if (result) deliverActivityResult(result.act, result.code, data ? RESULT_OK : RESULT_CANCELED, data);
      if (caller) setTimeout(() => void onMain(async () => { if (host.currentActivity() === caller) await host.roundTrip(caller); }).catch(reportUncaught), 0);
    }, (error) => { reportUncaught(error); if (result) deliverActivityResult(result.act, result.code, RESULT_CANCELED, null); });
  };
  if (!intent) throw rt.mkThrowable("java/lang/NullPointerException", "intent");
  const q = await intentQuery(intent);
  const system = systemActivity(q, false);
  if (system) return runSystem(system);
  const pm = await import("./pm");
  const resolved = await pm.resolveActivity(intent);
  // Instrumentation.checkStartActivityResult's message
  if (!resolved) throw rt.mkThrowable("android/content/ActivityNotFoundException", "No Activity found to handle " + await vcall(intent, "toString", `()${S}`));
  // a data-scoped system activity (the browser) answers only where no installed activity does
  if (resolved === "system") return runSystem(systemActivity(q)!);
  const pkg = resolved.owner.pkg, permission = pm.componentPermission(resolved), processName = pm.componentProcess(resolved);
  if (pkg !== sender && (!pm.exported(resolved) || permission && await pm.checkPermission(permission, sender) !== 0))
    throw rt.mkThrowable("java/lang/SecurityException", "Activity permission denied: " + resolved.name);
  const component = resolved.name.replace(/\./g, "/");
  if (pkg !== host.pkg || processName !== (PROCESS_NAME || host.pkg)) {
    if (!activityTransport.launch) throw rt.mkThrowable("android/content/ActivityNotFoundException", "Activity process unavailable: " + processName);
    return activityTransport.launch(pkg, processName, component, intent, result);
  }
  const caller = result && result.code >= 0 ? await componentParts(await vcall(result.act, "getComponentName", "()Landroid/content/ComponentName;")) : null;
  // ActivityThread delivers the launch after the caller's current lifecycle callback returns.
  void onMain(() => host.launch(component, intent, { caller, result })).catch(reportUncaught);
}

const RESULT_OK = -1, RESULT_CANCELED = 0;

/**
 * The activities the *system* provides, keyed by the action an app sends. On a device these are
 * DocumentsUI; here they are the browser's own pickers. Each answers with the result Intent, or
 * null for "the user backed out" — which is RESULT_CANCELED, not an error.
 */
type SystemHandler = (intent: JIntent) => Promise<JIntent | null>;
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
export async function mkResultIntent(uri: string | null, flags = 3 | 0x40): Promise<JIntent> {
  const intent = await newIntent();
  if (uri !== null) await vcall(intent, "setData", `(Landroid/net/Uri;)${I}`, mkUri(uri));
  await vcall(intent, "setFlags", `(I)${I}`, flags);
  return intent;
}

/** Post a result to the activity that asked for it. Scheduled, never inline: the caller is
 *  usually mid-click-handler, and androidx dispatches straight into app code from here. */
export function deliverActivityResult(act: JActivity, code: number, resultCode: number, data: JIntent | null) {
  setTimeout(() => void onMain(async () => {
    // the grant flags cover the result's data and every ClipData item URI, as ActivityManager's
    const flags: number = data ? await vcall(data, "getFlags", "()I") : 0;
    if (resultCode === RESULT_OK && data && (flags & 3)) {
      const { grantUriPermission } = await import("./contentresolver");
      const clip: JObj | null = await vcall(data, "getClipData", "()Landroid/content/ClipData;");
      const uris = [await vcall(data, "getData", "()Landroid/net/Uri;")];
      for (let i = 0, n = clip ? await vcall(clip, "getItemCount", "()I") : 0; i < n; i++)
        uris.push(await vcall(await vcall(clip, "getItemAt", "(I)Landroid/content/ClipData$Item;", i), "getUri", "()Landroid/net/Uri;"));
      for (const uri of uris) if (uri) grantUriPermission(act.$host.pkg, uri, flags);
    }
    const target = act.fragmentResults.get(code);
    if (target) {
      act.fragmentResults.delete(code);
      await vcall(target.fragment, "onActivityResult", `(II${I})V`, target.requestCode, resultCode, data);
    } else await vcall(act, "onActivityResult", `(II${I})V`, code, resultCode, data);
  }).catch(reportUncaught), 0);
}
