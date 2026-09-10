import { mangleMethod } from "../jvm/abi";
import { JObj, rt, callSelf, type NativeSpec, maySuspend } from "../jvm/runtime";
import { defineException, idHash, newObj, vcall } from "../jvm/natives/jlang";
import type { JContext } from "./context";
import { JIntent, launchIntent } from "./intent";
import { onMain } from "./mainloop";
import { reportUncaught } from "./os";
import { svcStart } from "./runningservices";
import { JBundle } from "./os";
import { JBinder } from "./binder";
import { JParcel, parcelCreator } from "./parcel";

interface Filter { actions: string[]; schemes?: string[]; priority?: number; }
export type BroadcastResult = { code: number; data: string | null; extras: JBundle | null; aborted: boolean };
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
class JIntentToken extends JBinder {
  operation: { kind: "activity" | "broadcast" | "service"; context: JContext; intent: JIntent; immutable: boolean; oneShot: boolean } | null = null;
  key = "";
  canceled = false;
}
const intentTokens = new Map<string, JIntentToken>();
function cancelToken(token: JIntentToken) {
  token.canceled = true;
  if (intentTokens.get(token.key) === token) intentTokens.delete(token.key);
}
class JIntentSender extends JObj {
  target: JObj | null = null;
  get operation() { return this.target instanceof JIntentToken ? this.target.operation : null; }
}
defineException("android/util/AndroidException", "java/lang/Exception");
defineException("android/app/PendingIntent$CanceledException", "android/util/AndroidException");
export async function sendIntent(sender: JIntentSender, fill?: JIntent): Promise<void> {
  if (!(sender.target instanceof JIntentToken)) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "remote intent sending unavailable");
  return sendOperation(sender.target, fill);
}
async function sendOperation(sender: JIntentToken, fill?: JIntent): Promise<void> {
  const operation = sender.operation;
  if (sender.canceled || !operation) throw rt.mkThrowable("android/app/PendingIntent$CanceledException", null);
  if (operation.oneShot) cancelToken(sender);
  const intent = await newObj("android/content/Intent", "(Landroid/content/Intent;)V", operation.intent) as JIntent;
  if (fill && !operation.immutable) for (const [key, value] of fill.extras.map) intent.extras.map.set(key, value);
  if (operation.kind === "broadcast") sendBroadcast(operation.context, intent);
  else if (operation.kind === "activity") await launchIntent(operation.context.$host, intent);
  else await svcStart(operation.context, intent, false);
}
rt.register({ name: "webdroid/IntentToken", ctor: JIntentToken, sup: "android/os/Binder" });
rt.register({ name: "android/content/IntentSender", ctor: JIntentSender, ifaces: ["android/os/Parcelable"],
  statics: { get CREATOR() { return parcelCreator("android/content/IntentSender", async p => {
    const target = await vcall(p, "readStrongBinder", "()Landroid/os/IBinder;");
    if (!target) return null;
    const sender = new JIntentSender(); sender.target = target; return sender;
  }); } }, methods: {
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": maySuspend(function (this: JIntentSender, p: JParcel) { return vcall(p, "writeStrongBinder", "(Landroid/os/IBinder;)V", this.target); }),
  },
});
export class JPendingIntent extends JObj { sender = new JIntentSender(); }
function pending(kind: "activity" | "broadcast" | "service", context: JContext, code: number, intent: JIntent, flags: number): JPendingIntent | null {
  if (!intent) throw rt.mkThrowable("java/lang/NullPointerException", "intent");
  if ((flags & 0x6000000) === 0x6000000) throw rt.mkThrowable("java/lang/IllegalArgumentException", "PendingIntent cannot be both mutable and immutable");
  const key = JSON.stringify([context.$host?.pkg ?? "", kind, code, flags & ~0x38000000,
    intent.action, intent.dataUri, intent.typeStr, intent.pkg, intent.componentPkg, intent.component, [...intent.categories].sort()]);
  let target = intentTokens.get(key);
  if (target && flags & 0x10000000) { cancelToken(target); target = undefined; }
  if (!target && flags & 0x20000000) return null;
  if (target?.operation && flags & 0x8000000) {
    target.operation.intent.extras = new JBundle();
    target.operation.intent.extras.map = new Map(intent.extras.map);
  }
  if (!target) {
    rt.link("android/content/Intent");
    const copy = new JIntent(); copy.copyFrom(intent);
    rt.link("webdroid/IntentToken"); target = new JIntentToken(); target.key = key;
    target.operation = { kind, context, intent: copy, immutable: !!(flags & 0x4000000), oneShot: !!(flags & 0x40000000) };
    intentTokens.set(key, target);
  }
  const result = new JPendingIntent(); result.sender.target = target; return result;
}
rt.register({
  name: "android/app/PendingIntent", ctor: JPendingIntent, ifaces: ["android/os/Parcelable"],
  statics: { get CREATOR() { return parcelCreator("android/app/PendingIntent", async p => {
    const target = await vcall(p, "readStrongBinder", "()Landroid/os/IBinder;");
    if (!target) return null;
    const pending = new JPendingIntent(); pending.sender.target = target; return pending;
  }); } },
  methods: {
    "static getActivity(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;": (context: JContext, code: number, intent: JIntent, flags: number) => pending("activity", context, code, intent, flags),
    "static getBroadcast(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;": (context: JContext, code: number, intent: JIntent, flags: number) => pending("broadcast", context, code, intent, flags),
    "static getService(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;": (context: JContext, code: number, intent: JIntent, flags: number) => pending("service", context, code, intent, flags),
    "getIntentSender()Landroid/content/IntentSender;": function (this: JPendingIntent) { return this.sender; },
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": maySuspend(function (this: JPendingIntent, p: JParcel) { return vcall(p, "writeStrongBinder", "(Landroid/os/IBinder;)V", this.sender.target); }),
    "equals(Ljava/lang/Object;)Z": function (this: JPendingIntent, other: unknown) { return +(other instanceof JPendingIntent && this.sender.target === other.sender.target); },
    "hashCode()I": function (this: JPendingIntent) { return idHash(this.sender.target); },
    "cancel()V": function (this: JPendingIntent) {
      if (!(this.sender.target instanceof JIntentToken)) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "remote intent cancellation unavailable");
      cancelToken(this.sender.target);
    },
    "send()V": maySuspend(function (this: JPendingIntent) { return sendIntent(this.sender); }),
  },
});
