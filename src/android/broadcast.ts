import { mangleMethod } from "../jvm/abi";
import { JObj, rt, callSelf, type NativeSpec } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import type { JContext } from "./context";
import { JIntent } from "./intent";
import { onMain } from "./mainloop";
import { reportUncaught } from "./os";
import { JBundle } from "./os";

interface Filter { actions: string[]; schemes?: string[]; priority?: number; }
type BroadcastResult = { code: number; data: string | null; extras: JBundle | null; aborted: boolean };
export const broadcastTransport: { send: ((intent: JIntent, permission: string | null, ordered: boolean) => Promise<void>) | null } = { send: null };
const receivers = new Map<JObj, { context: JContext; filter: Filter; handler: unknown }>();
export function registerReceiver(context: JContext, receiver: JObj | null, filter: Filter, handler: unknown = null): null {
  if (receiver) receivers.set(receiver, { context, filter, handler });
  return null;
}
export function unregisterReceiver(receiver: JObj): void { receivers.delete(receiver); }
const receiverTargets = (intent: JIntent) => [...receivers].filter(([, { context, filter }]) =>
  (!intent.pkg || intent.pkg === context.$host?.pkg) && filter.actions.includes(intent.action ?? "") &&
  (!filter.schemes?.length || filter.schemes.includes(intent.dataUri?.split(":", 1)[0] ?? "")));
export const hasBroadcastReceiver = (intent: JIntent): boolean => receiverTargets(intent).length > 0;
export function sendBroadcast(context: JContext, intent: JIntent, permission: string | null = null, ordered = false): void {
  if (broadcastTransport.send) { void broadcastTransport.send(intent, permission, ordered).catch(reportUncaught); return; }
  void deliverBroadcast(context, intent, null, ordered).catch(reportUncaught);
}
export async function deliverBroadcast(context: JContext, intent: JIntent, component: string | null, ordered: boolean, result: BroadcastResult = { code: 0, data: null, extras: null, aborted: false }): Promise<BroadcastResult> {
  if (component) {
    const receiver: JObj = await onMain(() => newObj(component.replace(/\./g, "/")));
    await deliver(receiver, context, intent, null, ordered, result); return result;
  }
  const targets = receiverTargets(intent);
  targets.sort((a, b) => (b[1].filter.priority ?? 0) - (a[1].filter.priority ?? 0));
  for (const [receiver, registration] of targets) {
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
