import { mangleMethod } from "../jvm/abi";
import { JObj, rt, callSelf, driven, type NativeSpec, type Gen } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import type { JContext } from "./context";
import type { JIntent } from "./intent";
import { onMain } from "./mainloop";
import { reportUncaught, JBundle } from "./os";

type BroadcastResult = { code: number; data: string | null; extras: JBundle | null; aborted: boolean };
export const broadcastTransport: { send: ((intent: JIntent, permission: string | null, ordered: boolean) => Promise<void>) | null } = { send: null };
/** an IntentFilter, AOSP's own */
type JIntentFilter = JObj;
type Registration = { context: JContext; filter: JIntentFilter; handler: unknown };
const receivers = new Map<JObj, Registration>();
/** broadcasts the system keeps current (BatteryService's BATTERY_CHANGED), by action. As in
 *  ActivityManagerService, a registration matching one gets it back and its receiver hears it at once. */
export const stickyBroadcasts = new Map<string, () => JIntent | Promise<JIntent>>();
/** IntentFilter.match(ContentResolver, Intent, boolean, String), as the broadcast queue matches a registration */
function* matches$(filter: JIntentFilter, intent: JIntent): Gen<boolean> {
  return (yield vcall(filter, "match", "(Landroid/content/ContentResolver;Landroid/content/Intent;ZLjava/lang/String;)I", null, intent, 0, "ActivityManager")) >= 0;
}
export const registerReceiver = driven(function* registerReceiver$(context: JContext, receiver: JObj | null, filter: JIntentFilter, handler: unknown = null): Gen<JIntent | null> {
  if (receiver) receivers.set(receiver, { context, filter, handler });
  let first: JIntent | null = null;
  for (const [action, make] of stickyBroadcasts) {
    if (!(yield vcall(filter, "hasAction", "(Ljava/lang/String;)Z", action))) continue;
    const sticky: JIntent = yield make();
    if (!(yield* matches$(filter, sticky))) continue;
    first ??= sticky;
    if (receiver) void deliver(receiver, context, sticky, handler, false, { code: 0, data: null, extras: null, aborted: false }).catch(reportUncaught);
  }
  return first;
});
export function unregisterReceiver(receiver: JObj): void { receivers.delete(receiver); }
/** a registered receiver is found through its filter's actions, so an intent without one reaches
 *  none; the highest priority first */
const receiverTargets = driven(function* receiverTargets$(intent: JIntent): Gen<[JObj, Registration][]> {
  if ((yield vcall(intent, "getAction", "()Ljava/lang/String;")) === null) return [];
  const pkg: string | null = yield vcall(intent, "getPackage", "()Ljava/lang/String;");
  const targets: [JObj, Registration, number][] = [];
  for (const [receiver, registration] of receivers) {
    if (pkg && pkg !== registration.context.$host?.pkg || !(yield* matches$(registration.filter, intent))) continue;
    targets.push([receiver, registration, yield vcall(registration.filter, "getPriority", "()I")]);
  }
  return targets.sort((a, b) => b[2] - a[2]).map(([receiver, registration]) => [receiver, registration]);
});
export const hasBroadcastReceiver = async (intent: JIntent): Promise<boolean> => (await receiverTargets(intent)).length > 0;
export function sendBroadcast(context: JContext, intent: JIntent, permission: string | null = null, ordered = false): void {
  if (broadcastTransport.send) { void broadcastTransport.send(intent, permission, ordered).catch(reportUncaught); return; }
  void deliverBroadcast(context, intent, null, ordered).catch(reportUncaught);
}
export async function deliverBroadcast(context: JContext, intent: JIntent, component: string | null, ordered: boolean, result: BroadcastResult = { code: 0, data: null, extras: null, aborted: false }): Promise<BroadcastResult> {
  if (component) {
    const receiver: JObj = await onMain(() => newObj(component.replaceAll(".", "/")));
    await deliver(receiver, context, intent, null, ordered, result); return result;
  }
  for (const [receiver, registration] of await receiverTargets(intent)) {
    if (result.aborted) break;
    await deliver(receiver, registration.context ?? context, intent, registration.handler, ordered, result);
  }
  return result;
}
class JPendingResult extends JObj {
  state!: BroadcastResult; ordered = false; detached = false;
  finish!: () => void;
}
const pendingResults = new WeakMap<JObj, JPendingResult>();
async function deliver(receiver: JObj, context: JContext, intent: JIntent, handler: unknown, ordered: boolean, state: BroadcastResult): Promise<void> {
  rt.link("android/content/BroadcastReceiver$PendingResult");
  const pending = new JPendingResult(); pending.state = state; pending.ordered = ordered;
  const finished = new Promise<void>((resolve) => { pending.finish = resolve; });
  const run = async () => {
    pendingResults.set(receiver, pending);
    try { await vcall(receiver, "onReceive", "(Landroid/content/Context;Landroid/content/Intent;)V", context, intent); }
    finally { pendingResults.delete(receiver); if (!pending.detached) pending.finish(); }
  };
  if (handler) {
    const runnable = new JObj();
    Object.assign(runnable, { [mangleMethod("run", "()V")]: () => { void run().catch(reportUncaught); } });
    await vcall(handler, "post", "(Ljava/lang/Runnable;)Z", runnable);
  } else await onMain(run);
  await finished;
}
const resultMethods: NonNullable<NativeSpec["methods"]> = {
  "getResultCode()I": function (this: JPendingResult) { return this.state.code; },
  "setResultCode(I)V": function (this: JPendingResult, code: number) { this.state.code = code; },
  "getResultData()Ljava/lang/String;": function (this: JPendingResult) { return this.state.data; },
  "setResultData(Ljava/lang/String;)V": function (this: JPendingResult, data: string | null) { this.state.data = data; },
  "getResultExtras(Z)Landroid/os/Bundle;": function (this: JPendingResult, make: number) { return make ? this.state.extras ??= new JBundle() : this.state.extras; },
  "setResultExtras(Landroid/os/Bundle;)V": function (this: JPendingResult, extras: JBundle | null) { this.state.extras = extras; },
  "abortBroadcast()V": function (this: JPendingResult) { if (this.ordered) this.state.aborted = true; },
  "clearAbortBroadcast()V": function (this: JPendingResult) { this.state.aborted = false; },
  "getAbortBroadcast()Z": function (this: JPendingResult) { return this.state.aborted ? 1 : 0; },
};
rt.register({ name: "android/content/BroadcastReceiver$PendingResult", ctor: JPendingResult, methods: {
  ...resultMethods, "finish()V": function (this: JPendingResult) { this.finish(); },
} });
rt.register({ name: "android/content/BroadcastReceiver", ctor: class extends JObj {}, methods: {
  "<init>()V": function () {},
  "isOrderedBroadcast()Z": function (this: JObj) { return pendingResults.get(this)?.ordered ? 1 : 0; },
  "goAsync()Landroid/content/BroadcastReceiver$PendingResult;": function (this: JObj) {
    const pending = pendingResults.get(this); if (!pending) return null;
    pending.detached = true; pendingResults.delete(this); return pending;
  },
  ...Object.fromEntries(Object.keys(resultMethods).map((signature) => [signature, function (this: JObj, ...args: unknown[]) {
    const pending = pendingResults.get(this); if (!pending) throw rt.mkThrowable("java/lang/IllegalStateException", "No pending broadcast");
    return callSelf(resultMethods, signature, pending, ...args);
  }])),
} });
