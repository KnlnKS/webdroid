// The broadcast queue for AOSP's ActivityThread: the broker carries a broadcast to each process,
// whose registered receivers hear it through scheduleRegisteredReceiver and whose manifest
// receivers through scheduleReceiver. An ordered delivery waits for the receiver's finishReceiver,
// whose result the next receiver starts from; the sender's result receiver hears the last.
import { awaited, type JObj, driven, type Gen } from "../../jvm/runtime.ts";
import { after, newObj, vcall } from "../../jvm/natives/jentry.ts";
import { logUncaught, detached } from "../../jvm/natives/jthrowable.ts";
import { parcelled, unparcelled } from "../binder.ts";
import { encodeIntent } from "../intentipc.ts";
import { broker } from "../../shell/broker-access.ts";
import { receivers, type BroadcastData } from "../../shell/broker-contract.ts";
import { runningApp } from "../apphost.ts";
import { checkPermission } from "../permissions.ts";
import { mkComponentName, withComponent$, type JIntent } from "../intent.ts";
import { scheduleOnApp, compatInfo, thisApp, pms, STOCK_PM_FLAGS } from "./process.ts";
import { processState, PROCESS_STATE_RECEIVER } from "./atm.ts";
import { procIdentity } from "../../shell/procfs.ts";

type BroadcastResult = { code: number; data: string | null; extras: JObj | null; aborted: boolean };
/** a result as it crosses processes, its extras parcelled */
export const resultData = (result: BroadcastResult): PromiseOrVal<BroadcastData> =>
  after(result.extras && parcelled(result.extras), (extras) => ({ ...result, extras }));
export const broadcastResult = (data: BroadcastData): PromiseOrVal<BroadcastResult> =>
  after(data.extras && unparcelled("android/os/Bundle", data.extras), (extras) => ({ ...data, extras }));
/** a broadcast to every process, through the broker: `permissions` are those a receiver must hold; it answers the final result */
function* send$(intent: JIntent, permissions: string[], ordered: boolean, initial?: BroadcastResult): Gen<BroadcastResult> {
  const data = yield* awaited(encodeIntent(intent)), targets = yield* receivers(intent), from = initial && (yield* awaited(resultData(initial)));
  return yield* awaited(broadcastResult(yield* awaited(broker().broadcast(data, targets, permissions, ordered, from))));
}
/** broadcasts the system keeps current (BatteryService's BATTERY_CHANGED), by action. As in
 *  ActivityManagerService, a registration matching one gets it back and its receiver hears it at once. */
export const stickyBroadcasts = new Map<string, () => PromiseOrVal<JIntent>>();
/** IntentFilter.match(ContentResolver, Intent, boolean, String), as the broadcast queue matches a registration */
function* filterMatches(filter: JObj, intent: JIntent): Gen<boolean> {
  return (yield vcall(filter, "match", "(Landroid/content/ContentResolver;Landroid/content/Intent;ZLjava/lang/String;)I", null, intent, 0, "ActivityManager")) >= 0;
}

export type Sender = { uid: number; pkg: string };
const SYSTEM_UID = 1000, SYSTEM: Sender = { uid: SYSTEM_UID, pkg: "android" };
const RECEIVER_NOT_EXPORTED = 4;
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
function* hears(registration: Registration, intent: JObj, sender: Sender): Gen<boolean> {
  const pkg: string | null = yield vcall(intent, "getPackage", `()${S}`);
  if (pkg && pkg !== registration.pkg) return false;
  if (sender.uid !== SYSTEM_UID && sender.uid !== procIdentity.uid) {
    if (registration.flags & RECEIVER_NOT_EXPORTED) return false;
    if (registration.permission && (yield* awaited(checkPermission(registration.permission, sender.pkg))) !== 0) return false;
  }
  return yield* filterMatches(registration.filter, intent);
}

/** this process's share of a broadcast: one manifest receiver, or every registered one it matches */
export const deliverBroadcast = driven(function* (intent: JObj, component: string | null, ordered: boolean, result: BroadcastResult, sender: Sender | null): Gen<BroadcastResult> {
  const from = sender ?? SYSTEM;
  if (component) {
    const name = yield* awaited(mkComponentName(runningApp().pkg, component));
    const info = yield vcall(yield* awaited(pms()), "getReceiverInfo", `(Landroid/content/ComponentName;JI)Landroid/content/pm/ActivityInfo;`, name, STOCK_PM_FLAGS, 0);
    if (!info) throw new Error("Receiver not installed: " + component);
    const copy = yield* withComponent$(intent, name);
    const done = finished(thisApp());
    yield scheduleOnApp("scheduleReceiver", RECEIVER, copy, info, compatInfo(), result.code, result.data, result.extras, +ordered, 0, 0,
      processState(PROCESS_STATE_RECEIVER), from.uid, from.pkg);
    const answer = yield* awaited(done);
    return ordered ? answer : result;
  }
  // as the registered receivers' resolver, an intent without an action reaches none
  if ((yield vcall(intent, "getAction", `()${S}`)) === null) return result;
  const targets: [JObj, number][] = [];
  for (const [receiver, registration] of registered)
    if (yield* hears(registration, intent, from)) targets.push([receiver, yield vcall(registration.filter, "getPriority", "()I")]);
  for (const [receiver] of targets.sort((a, b) => b[1] - a[1])) {
    if (!registered.has(receiver)) continue;
    if (!ordered) { yield scheduleRegistered(receiver, intent, result, false, false, from); continue; }
    const done = finished(receiver);
    yield scheduleRegistered(receiver, intent, result, true, false, from);
    result = yield* awaited(done);
    if (result.aborted) break;
  }
  return result;
});

/** ActivityManagerService.broadcastIntent: through every process, then to the sender's result receiver */
export const broadcastIntent = driven(function* (intent: JObj, permissions: string[], ordered: boolean, resultTo: JObj | null = null, initial?: BroadcastResult): Gen<void> {
  const copy = yield newObj("android/content/Intent", `(${INTENT})V`, intent);
  const final = yield* send$(copy, permissions, ordered, initial);
  if (resultTo) yield scheduleRegistered(resultTo, copy, final, false, false, { uid: procIdentity.uid, pkg: runningApp().pkg });
});

/** the methods IActivityManager adds for ActivityThread's receivers */
export const broadcastQueueMethods = {
  // a registration matching a sticky broadcast gets the first back and its receiver hears each
  "registerReceiverWithFeature(Landroid/app/IApplicationThread;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Landroid/content/IIntentReceiver;Landroid/content/IntentFilter;Ljava/lang/String;II)Landroid/content/Intent;":
    driven(function* (_caller: JObj, pkg: string, _feature: string | null, _id: string | null, receiver: JObj | null, filter: JObj, permission: string | null, _user: number, flags: number) {
      const stickies: JObj[] = [];
      for (const [action, make] of stickyBroadcasts) {
        if (!(yield vcall(filter, "hasAction", `(${S})Z`, action))) continue;
        const sticky = yield* awaited(make());
        if (yield* filterMatches(filter, sticky)) stickies.push(sticky);
      }
      if (receiver) {
        registered.set(receiver, { filter, permission, flags, pkg });
        const none: BroadcastResult = { code: 0, data: null, extras: null, aborted: false };
        for (const sticky of stickies) detached(() => scheduleRegistered(receiver, sticky, none, false, true, SYSTEM), logUncaught);
      }
      return stickies[0] ?? null;
    }),
  "unregisterReceiver(Landroid/content/IIntentReceiver;)V": (receiver: JObj) => { registered.delete(receiver); },
  "broadcastIntentWithFeature(Landroid/app/IApplicationThread;Ljava/lang/String;Landroid/content/Intent;Ljava/lang/String;Landroid/content/IIntentReceiver;ILjava/lang/String;Landroid/os/Bundle;[Ljava/lang/String;[Ljava/lang/String;[Ljava/lang/String;ILandroid/os/Bundle;ZZI)I":
    (_caller: JObj, _feature: string | null, intent: JObj, _type: string | null, resultTo: JObj | null, code: number, data: string | null, extras: JObj | null,
      permissions: string[] | null, _excluded: unknown, _excludedPackages: unknown, _op: number, _options: unknown, serialized: number) => {
      detached(() => broadcastIntent(intent, [...permissions ?? []], !!serialized, resultTo, { code, data, extras, aborted: false }), logUncaught);
      return 0;
    },
  "finishReceiver(Landroid/os/IBinder;ILjava/lang/String;Landroid/os/Bundle;ZI)V": (who: JObj, code: number, data: string | null, extras: JObj | null, aborted: number) => {
    const q = finishing.get(who), resolve = q?.shift();
    if (q && !q.length) finishing.delete(who);
    resolve?.({ code, data, extras, aborted: !!aborted });
  },
};
