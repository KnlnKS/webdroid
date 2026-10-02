// The broadcast queue for AOSP's ActivityThread: the broker carries a broadcast to each process,
// whose registered receivers hear it through scheduleRegisteredReceiver and whose manifest
// receivers through scheduleReceiver. An ordered delivery waits for the receiver's finishReceiver,
// whose result the next receiver starts from; the sender's result receiver hears the last.
import { JObj } from "../../jvm/runtime";
import { newObj, vcall } from "../../jvm/natives/jlang";
import { hostedService } from "../binder";
import { PROCESS_UID, reportUncaught } from "../os";
import { appHost } from "../apphost";
import { checkPermission } from "../permissions";
import { broadcastTransport, filterMatches, stickyBroadcasts, type BroadcastResult } from "../broadcast";
import type { JBundle } from "../os";
import { scheduleOnApp, compatInfo, thisApp } from "./am";
import { processState, PROCESS_STATE_RECEIVER } from "./atm";

export type Sender = { uid: number; pkg: string };
const SYSTEM_UID = 1000, SYSTEM: Sender = { uid: SYSTEM_UID, pkg: "android" };
const RECEIVER_NOT_EXPORTED = 4, GET_SHARED_LIBRARY_FILES = 0x400n;
const INTENT = "Landroid/content/Intent;", S = "Ljava/lang/String;", BUNDLE = "Landroid/os/Bundle;";
const REGISTERED = `(Landroid/content/IIntentReceiver;${INTENT}I${S}${BUNDLE}ZZZIII${S})V`;
const RECEIVER = `(${INTENT}Landroid/content/pm/ActivityInfo;Landroid/content/res/CompatibilityInfo;I${S}${BUNDLE}ZZIII${S})V`;

/** a BroadcastFilter: an IIntentReceiver's registration, by the receiver */
type Registration = { filter: JObj; permission: string | null; flags: number; pkg: string };
const registered = new Map<JObj, Registration>();

/** the receivers' finishReceiver calls in delivery order, by the token PendingResult sends */
const finishing = new Map<JObj, ((result: BroadcastResult) => void)[]>();
function finished(token: JObj): Promise<BroadcastResult> {
  return new Promise((resolve) => { const q = finishing.get(token); if (q) q.push(resolve); else finishing.set(token, [resolve]); });
}

const scheduleRegistered = (receiver: JObj, intent: JObj, r: BroadcastResult, ordered: boolean, sticky: boolean, sender: Sender) =>
  scheduleOnApp("scheduleRegisteredReceiver", REGISTERED, receiver, intent, r.code, r.data, r.extras, +ordered, +sticky, +!ordered, 0,
    processState(PROCESS_STATE_RECEIVER), sender.uid, sender.pkg);

/** a registered receiver hears a broadcast unless its package, export or permission rules it out */
async function hears(registration: Registration, intent: JObj, sender: Sender): Promise<boolean> {
  const pkg: string | null = await vcall(intent, "getPackage", `()${S}`);
  if (pkg && pkg !== registration.pkg) return false;
  if (sender.uid !== SYSTEM_UID && sender.uid !== PROCESS_UID) {
    if (registration.flags & RECEIVER_NOT_EXPORTED) return false;
    if (registration.permission && await checkPermission(registration.permission, sender.pkg) !== 0) return false;
  }
  return filterMatches(registration.filter, intent);
}

/** this process's share of a broadcast: one manifest receiver, or every registered one it matches */
export async function deliverBroadcast(intent: JObj, component: string | null, ordered: boolean, result: BroadcastResult, sender: Sender | null): Promise<BroadcastResult> {
  const from = sender ?? SYSTEM;
  if (component) {
    const name = await newObj("android/content/ComponentName", `(${S}${S})V`, appHost!.pkg, component);
    const info = await vcall(await hostedService("package"), "getReceiverInfo", `(Landroid/content/ComponentName;JI)Landroid/content/pm/ActivityInfo;`, name, GET_SHARED_LIBRARY_FILES, 0);
    if (!info) throw new Error("Receiver not installed: " + component);
    const copy = await newObj("android/content/Intent", `(${INTENT})V`, intent);
    await vcall(copy, "setComponent", `(Landroid/content/ComponentName;)${INTENT}`, name);
    const done = finished(thisApp());
    await scheduleOnApp("scheduleReceiver", RECEIVER, copy, info, compatInfo(), result.code, result.data, result.extras, +ordered, 0, 0,
      processState(PROCESS_STATE_RECEIVER), from.uid, from.pkg);
    const answer = await done;
    return ordered ? answer : result;
  }
  // as the registered receivers' resolver, an intent without an action reaches none
  if (await vcall(intent, "getAction", `()${S}`) === null) return result;
  const targets: [JObj, number][] = [];
  for (const [receiver, registration] of registered)
    if (await hears(registration, intent, from)) targets.push([receiver, await vcall(registration.filter, "getPriority", "()I")]);
  for (const [receiver] of targets.sort((a, b) => b[1] - a[1])) {
    if (!registered.has(receiver)) continue;
    if (!ordered) { await scheduleRegistered(receiver, intent, result, false, false, from); continue; }
    const done = finished(receiver);
    await scheduleRegistered(receiver, intent, result, true, false, from);
    result = await done;
    if (result.aborted) break;
  }
  return result;
}

/** ActivityManagerService.broadcastIntent: through every process, then to the sender's result receiver */
export async function broadcastIntent(intent: JObj, permissions: string[], ordered: boolean, resultTo: JObj | null = null, initial?: BroadcastResult): Promise<void> {
  const copy = await newObj("android/content/Intent", `(${INTENT})V`, intent);
  const final = await broadcastTransport.send!(copy, permissions, ordered, initial);
  if (resultTo) await scheduleOnApp("scheduleRegisteredReceiver", REGISTERED, resultTo, copy, final.code, final.data, final.extras, 0, 0, 1, 0,
    processState(PROCESS_STATE_RECEIVER), PROCESS_UID, appHost!.pkg);
}

/** the methods IActivityManager adds for ActivityThread's receivers */
export const broadcastQueueMethods = {
  // a registration matching a sticky broadcast gets the first back and its receiver hears each
  "registerReceiverWithFeature(Landroid/app/IApplicationThread;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Landroid/content/IIntentReceiver;Landroid/content/IntentFilter;Ljava/lang/String;II)Landroid/content/Intent;":
    async (_caller: JObj, pkg: string, _feature: string | null, _id: string | null, receiver: JObj | null, filter: JObj, permission: string | null, _user: number, flags: number) => {
      const stickies: JObj[] = [];
      for (const [action, make] of stickyBroadcasts) {
        if (!await vcall(filter, "hasAction", `(${S})Z`, action)) continue;
        const sticky = await make();
        if (await filterMatches(filter, sticky)) stickies.push(sticky);
      }
      if (receiver) {
        registered.set(receiver, { filter, permission, flags, pkg });
        const none: BroadcastResult = { code: 0, data: null, extras: null, aborted: false };
        for (const sticky of stickies) void scheduleRegistered(receiver, sticky, none, false, true, SYSTEM).catch(reportUncaught);
      }
      return stickies[0] ?? null;
    },
  "unregisterReceiver(Landroid/content/IIntentReceiver;)V": (receiver: JObj) => { registered.delete(receiver); },
  "broadcastIntentWithFeature(Landroid/app/IApplicationThread;Ljava/lang/String;Landroid/content/Intent;Ljava/lang/String;Landroid/content/IIntentReceiver;ILjava/lang/String;Landroid/os/Bundle;[Ljava/lang/String;[Ljava/lang/String;[Ljava/lang/String;ILandroid/os/Bundle;ZZI)I":
    (_caller: JObj, _feature: string | null, intent: JObj, _type: string | null, resultTo: JObj | null, code: number, data: string | null, extras: JBundle | null,
      permissions: string[] | null, _excluded: unknown, _excludedPackages: unknown, _op: number, _options: unknown, serialized: number) => {
      void broadcastIntent(intent, [...permissions ?? []], !!serialized, resultTo, { code, data, extras, aborted: false }).catch(reportUncaught);
      return 0;
    },
  "finishReceiver(Landroid/os/IBinder;ILjava/lang/String;Landroid/os/Bundle;ZI)V": (who: JObj, code: number, data: string | null, extras: JBundle | null, aborted: number) => {
    const q = finishing.get(who), resolve = q?.shift();
    if (q && !q.length) finishing.delete(who);
    resolve?.({ code, data, extras, aborted: !!aborted });
  },
};
