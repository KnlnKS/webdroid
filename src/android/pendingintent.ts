import { JObj, rt } from "../jvm/runtime";
import { defineException, idHash, newObj, vcall } from "../jvm/natives/jlang";
import type { JContext } from "./context";
import type { ActivityResultTarget } from "./intent";
import { appHost } from "./apphost";
import { JIntent, launchIntent } from "./intent";
import { sendBroadcast } from "./broadcast";
import { svcStart } from "./runningservices";
import { PROCESS_NAME, PROCESS_UID } from "./os";
import { exportBinder, importBinder } from "./binder";
import { JParcel, parcelCreator } from "./parcel";
import { encodeIntent, decodeIntent, type IntentData } from "./intentipc";
import { PendingIntents, type PendingOperation } from "../shell/pendingintents";

export async function executePendingIntent(operation: PendingOperation, fill: IntentData | null, alarmCount: number): Promise<void> {
  const intent = await decodeIntent(operation.intent), context = appHost?.application ?? await newObj("android/content/Context");
  if (!(operation.flags & 0x4000000)) {
    const supplied = fill ? await decodeIntent(fill) : new JIntent();
    if (alarmCount) supplied.extras.map.set("android.intent.extra.ALARM_COUNT", alarmCount);
    await vcall(intent, "fillIn", "(Landroid/content/Intent;I)I", supplied, operation.flags);
  }
  if (operation.kind === "broadcast") sendBroadcast(context, intent);
  else if (operation.kind === "activity") await launchIntent(context.$host, intent);
  else svcStart(context, intent, false);
}
export const localPendingIntents = new PendingIntents(executePendingIntent);
export const pendingTransport = {
  create: (pkg: string, kind: PendingOperation["kind"], code: number, flags: number, intent: IntentData) =>
    localPendingIntents.create({ pkg, kind, code, flags, intent, uid: PROCESS_UID, process: PROCESS_NAME || pkg }),
  cancel: (id: number) => localPendingIntents.cancel(id),
  send: (id: number, fill: IntentData | null) => localPendingIntents.send(id, fill),
  operation: (id: number): PendingOperation | null => localPendingIntents.take(id),
};
export class JIntentSender extends JObj { target: JObj | null = null; }
export class JPendingIntent extends JObj { sender = new JIntentSender(); }
function senderId(sender: JIntentSender): number {
  const handle = exportBinder(sender.target);
  if (!handle || handle.pid !== 0) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Unknown intent sender");
  return handle.id;
}
export const pendingId = (intent: JPendingIntent) => senderId(intent.sender);
defineException("android/util/AndroidException", "java/lang/Exception");
defineException("android/app/PendingIntent$CanceledException", "android/util/AndroidException");
defineException("android/content/IntentSender$SendIntentException", "android/util/AndroidException");
export async function sendIntent(sender: JIntentSender, fill?: JIntent): Promise<void> {
  if (!await pendingTransport.send(senderId(sender), fill ? await encodeIntent(fill) : null))
    throw rt.mkThrowable("android/app/PendingIntent$CanceledException", null);
}
/** Context.startIntentSender: an activity sender starts with the creator's identity so the
 *  result can come back to the caller; any other kind is an ordinary send. */
export async function startIntentSender(context: JContext, sender: JIntentSender, fill: JIntent | null, result?: ActivityResultTarget): Promise<void> {
  if (!sender) throw rt.mkThrowable("java/lang/NullPointerException", "intent");
  const id = senderId(sender), operation = pendingTransport.operation(id);
  if (!operation) throw rt.mkThrowable("android/content/IntentSender$SendIntentException", null);
  if (operation.kind !== "activity") return sendIntent(sender, fill ?? undefined);
  const intent = await decodeIntent(operation.intent);
  if (fill && !(operation.flags & 0x4000000)) await vcall(intent, "fillIn", "(Landroid/content/Intent;I)I", fill, operation.flags);
  await launchIntent(context.$host, intent, result, operation.pkg);
}
async function pending(kind: PendingOperation["kind"], context: JContext, code: number, intent: JIntent, flags: number): Promise<JPendingIntent | null> {
  if (!intent) throw rt.mkThrowable("java/lang/NullPointerException", "intent");
  if ((flags & 0x6000000) === 0x6000000) throw rt.mkThrowable("java/lang/IllegalArgumentException", "PendingIntent cannot be both mutable and immutable");
  const id = pendingTransport.create(context.$host?.pkg ?? appHost?.pkg ?? "", kind, code, flags, await encodeIntent(intent));
  if (id === null) return null;
  const result = new JPendingIntent(); result.sender.target = importBinder({ pid: 0, id }); return result;
}
rt.register({ name: "android/content/IntentSender", ctor: JIntentSender, ifaces: ["android/os/Parcelable"],
  statics: { get CREATOR() { return parcelCreator("android/content/IntentSender", async p => {
    const target = await vcall(p, "readStrongBinder", "()Landroid/os/IBinder;");
    if (!target) return null;
    const sender = new JIntentSender(); sender.target = target; return sender;
  }); } }, methods: {
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": function (this: JIntentSender, p: JParcel) { return vcall(p, "writeStrongBinder", "(Landroid/os/IBinder;)V", this.target); },
  },
});
rt.register({ name: "android/app/PendingIntent", ctor: JPendingIntent, ifaces: ["android/os/Parcelable"],
  statics: { get CREATOR() { return parcelCreator("android/app/PendingIntent", async p => {
    const target = await vcall(p, "readStrongBinder", "()Landroid/os/IBinder;");
    if (!target) return null;
    const result = new JPendingIntent(); result.sender.target = target; return result;
  }); } }, methods: {
    "static getActivity(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;": (context: JContext, code: number, intent: JIntent, flags: number) => pending("activity", context, code, intent, flags),
    "static getBroadcast(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;": (context: JContext, code: number, intent: JIntent, flags: number) => pending("broadcast", context, code, intent, flags),
    "static getService(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;": (context: JContext, code: number, intent: JIntent, flags: number) => pending("service", context, code, intent, flags),
    "getIntentSender()Landroid/content/IntentSender;": function (this: JPendingIntent) { return this.sender; },
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": function (this: JPendingIntent, p: JParcel) { return vcall(p, "writeStrongBinder", "(Landroid/os/IBinder;)V", this.sender.target); },
    "equals(Ljava/lang/Object;)Z": function (this: JPendingIntent, other: unknown) { return +(other instanceof JPendingIntent && this.sender.target === other.sender.target); },
    "hashCode()I": function (this: JPendingIntent) { return idHash(this.sender.target); },
    "cancel()V": function (this: JPendingIntent) { pendingTransport.cancel(pendingId(this)); },
    "send()V": function (this: JPendingIntent) { return sendIntent(this.sender); },
  },
});
