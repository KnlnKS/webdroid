import { mangleMethod } from "../jvm/abi";
import { JObj, rt } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import type { JContext } from "./context";
import { JIntent, launchIntent } from "./intent";
import { onMain } from "./mainloop";
import { reportUncaught } from "./os";
import { svcStart } from "./runningservices";

interface Filter { actions: string[]; schemes?: string[]; }
const receivers = new Map<JObj, { context: JContext; filter: Filter; handler: unknown }>();
export function registerReceiver(context: JContext, receiver: JObj | null, filter: Filter, handler: unknown = null): null {
  if (receiver) receivers.set(receiver, { context, filter, handler });
  return null;
}
export function unregisterReceiver(receiver: JObj): void { receivers.delete(receiver); }
export function sendBroadcast(context: JContext, intent: JIntent): void {
  const targets = [...receivers].filter(([, { context: receiverContext, filter }]) =>
    (!intent.pkg || intent.pkg === receiverContext.$host?.pkg) && filter.actions.includes(intent.action ?? "") &&
    (!filter.schemes?.length || filter.schemes.includes(intent.dataUri?.split(":", 1)[0] ?? "")));
  for (const [receiver, registration] of targets) {
    const run = () => vcall(receiver, "onReceive", "(Landroid/content/Context;Landroid/content/Intent;)V", registration.context ?? context, intent);
    if (registration.handler) {
      const runnable = new JObj();
      Object.assign(runnable, { [mangleMethod("run", "()V")]: () => { void run().catch(reportUncaught); } });
      void vcall(registration.handler, "post", "(Ljava/lang/Runnable;)Z", runnable).catch(reportUncaught);
    } else void onMain(run).catch(reportUncaught);
  }
}
class JIntentSender extends JObj {
  operation: { kind: "activity" | "broadcast" | "service"; context: JContext; intent: JIntent; immutable: boolean } | null = null;
  canceled = false;
}
export async function sendIntent(sender: JIntentSender, fill?: JIntent): Promise<void> {
  const operation = sender.operation;
  if (sender.canceled || !operation) throw rt.mkThrowable("android/app/PendingIntent$CanceledException", null);
  const intent = await newObj("android/content/Intent", "(Landroid/content/Intent;)V", operation.intent) as JIntent;
  if (fill && !operation.immutable) for (const [key, value] of fill.extras.map) intent.extras.map.set(key, value);
  if (operation.kind === "broadcast") sendBroadcast(operation.context, intent);
  else if (operation.kind === "activity") await launchIntent(operation.context.$host, intent);
  else await svcStart(operation.context, intent, false);
}
rt.register({ name: "android/content/IntentSender", ctor: JIntentSender, ifaces: ["android/os/Parcelable"] });
class JPendingIntent extends JObj { sender = new JIntentSender(); }
function pending(kind: "activity" | "broadcast" | "service", context: JContext, intent: JIntent, flags: number): JPendingIntent {
  const result = new JPendingIntent(); result.sender.operation = { kind, context, intent, immutable: !!(flags & 0x4000000) }; return result;
}
rt.register({
  name: "android/app/PendingIntent", ctor: JPendingIntent, ifaces: ["android/os/Parcelable"],
  methods: {
    "static getActivity(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;": (context: JContext, _code: number, intent: JIntent, flags: number) => pending("activity", context, intent, flags),
    "static getBroadcast(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;": (context: JContext, _code: number, intent: JIntent, flags: number) => pending("broadcast", context, intent, flags),
    "static getService(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;": (context: JContext, _code: number, intent: JIntent, flags: number) => pending("service", context, intent, flags),
    "getIntentSender()Landroid/content/IntentSender;": function (this: JPendingIntent) { return this.sender; },
    "cancel()V": function (this: JPendingIntent) { this.sender.canceled = true; },
    "send()V": function (this: JPendingIntent) { return sendIntent(this.sender); },
  },
});
