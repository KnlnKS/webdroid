import { JObj, rt, driven, type Gen } from "../jvm/runtime";
import { idHash, newObj, vcall, vcallOn, curThread, type JThread } from "../jvm/natives/jlang";
import type { JContext } from "./context";
import { type ActivityResultTarget, type JIntent, launchIntent, newIntent, putExtra } from "./intent";
import { appHost } from "./apphost";
import { sendBroadcast } from "./broadcast";
import { svcStart } from "./runningservices";
import { PROCESS_NAME, PROCESS_UID } from "./os";
import { exportBinder, importBinder } from "./binder";
import { JParcel, parcelCreator } from "./parcel";
import { encodeIntent, decodeIntent, intentCodec, type IntentData } from "./intentipc";
import { PendingIntents, type PendingOperation } from "../shell/pendingintents";

export async function executePendingIntent(operation: PendingOperation, fill: IntentData | null, alarmCount: number): Promise<void> {
  const intent = await decodeIntent(operation.intent), context = appHost?.application ?? await newObj("android/content/Context");
  if (!(operation.flags & 0x4000000)) {
    const supplied = fill ? await decodeIntent(fill) : await newIntent();
    if (alarmCount) await putExtra(supplied, "android.intent.extra.ALARM_COUNT", alarmCount, "I");
    await vcall(intent, "fillIn", "(Landroid/content/Intent;I)I", supplied, operation.flags);
  }
  if (operation.kind === "broadcast") sendBroadcast(context, intent);
  else if (operation.kind === "activity") {
    for (const data of operation.intents?.slice(0, -1) ?? []) await launchIntent(context.$host, await decodeIntent(data));
    await launchIntent(context.$host, intent);
  }
  else await svcStart(context, intent, operation.kind === "foreground-service");
}
export const localPendingIntents = new PendingIntents(intentCodec, executePendingIntent);
export const pendingTransport = {
  create: (pkg: string, kind: PendingOperation["kind"], code: number, flags: number, intent: IntentData, intents?: IntentData[]) =>
    localPendingIntents.create({ pkg, kind, code, flags, intent, intents, uid: PROCESS_UID, process: PROCESS_NAME || pkg }),
  cancel: (id: number) => localPendingIntents.cancel(id),
  send: (id: number, fill: IntentData | null) => localPendingIntents.send(id, fill),
  operation: (id: number): PendingOperation | null => localPendingIntents.take(id),
  kind: (id: number): PendingOperation["kind"] | null => localPendingIntents.get(id)?.kind ?? null,
  flags: (id: number): number => localPendingIntents.get(id)?.flags ?? 0,
  creator: (id: number): { pkg: string; uid: number } | null => {
    const operation = localPendingIntents.get(id);
    return operation ? { pkg: operation.pkg, uid: operation.uid } : null;
  },
};
/** a PendingIntent: the binder of its IIntentSender, a token for the shell's record */
export class JPendingIntent extends JObj { target: JObj | null = null; }
function targetId(target: unknown): number {
  const handle = exportBinder(target);
  if (!handle || handle.pid !== 0) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Unknown intent sender");
  return handle.id;
}
export const pendingId = (intent: JPendingIntent) => targetId(intent.target);
/** an IntentSender's (or its IIntentSender's) record */
function* senderId$(sender: JObj): Gen<number> {
  const target = rt.iof(sender, "android/content/IIntentSender") ? sender : yield vcall(sender, "getTarget", "()Landroid/content/IIntentSender;");
  return targetId(yield vcall(target, "asBinder", "()Landroid/os/IBinder;"));
}
const senderId = driven(senderId$);
async function send(id: number, fill?: JIntent | null): Promise<void> {
  if (!await pendingTransport.send(id, fill ? await encodeIntent(fill) : null))
    throw rt.mkThrowable("android/app/PendingIntent$CanceledException", null);
}
export const sendIntent = async (sender: JObj, fill?: JIntent): Promise<void> => send(await senderId(sender), fill);
/** Context.startIntentSender: an activity sender starts with the creator's identity so the
 *  result can come back to the caller; any other kind is an ordinary send. */
export async function startIntentSender(context: JContext, sender: JObj, fill: JIntent | null, result?: ActivityResultTarget): Promise<void> {
  if (!sender) throw rt.mkThrowable("java/lang/NullPointerException", "intent");
  const id = await senderId(sender), operation = pendingTransport.operation(id);
  if (!operation) throw rt.mkThrowable("android/content/IntentSender$SendIntentException", null);
  if (operation.kind !== "activity") return send(id, fill);
  const intent = await decodeIntent(operation.intent);
  if (fill && !(operation.flags & 0x4000000)) await vcall(intent, "fillIn", "(Landroid/content/Intent;I)I", fill, operation.flags);
  for (const data of operation.intents?.slice(0, -1) ?? []) await launchIntent(context.$host, await decodeIntent(data), undefined, operation.pkg);
  await launchIntent(context.$host, intent, result, operation.pkg);
}
async function pending(kind: PendingOperation["kind"], context: JContext, code: number, intent: JIntent, flags: number, intents?: JIntent[]): Promise<JPendingIntent | null> {
  if (!intent) throw rt.mkThrowable("java/lang/NullPointerException", "intent");
  if ((flags & 0x6000000) === 0x6000000) throw rt.mkThrowable("java/lang/IllegalArgumentException", "PendingIntent cannot be both mutable and immutable");
  const id = await pendingTransport.create(context.$host?.pkg ?? appHost?.pkg ?? "", kind, code, flags, await encodeIntent(intent),
    intents && await Promise.all(intents.map(encodeIntent)));
  if (id === null) return null;
  rt.link("android/app/PendingIntent");
  const result = new JPendingIntent(); result.target = importBinder({ pid: 0, id }); return result;
}
/** PendingIntent.getActivities: the last intent is the one the operation launches */
function pendingActivities(context: JContext, code: number, intents: JIntent[] | null, flags: number) {
  if (!intents?.length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "intents must not be empty");
  return pending("activity", context, code, intents[intents.length - 1], flags, intents);
}
const KINDS: Record<PendingOperation["kind"], number> = { broadcast: 1, activity: 2, service: 4, "foreground-service": 5 };
/** IActivityManager's IntentSender calls, over the shell's records */
export const intentSenderMethods = {
  "getInfoForIntentSender(Landroid/content/IIntentSender;)Landroid/app/ActivityManager$PendingIntentInfo;": driven(function* (sender: JObj): Gen {
    const id = yield* senderId$(sender), creator = pendingTransport.creator(id), kind = pendingTransport.kind(id);
    return newObj("android/app/ActivityManager$PendingIntentInfo", "(Ljava/lang/String;IZI)V", creator?.pkg ?? null, creator?.uid ?? -1,
      +!!(pendingTransport.flags(id) & 0x4000000), kind ? KINDS[kind] : 0);
  }),
  // ActivityManager.START_CANCELED when the record is gone; a finished receiver hears the send, as
  // PendingIntentRecord.sendInner tells one for every kind but an ordered broadcast
  "sendIntentSender(Landroid/app/IApplicationThread;Landroid/content/IIntentSender;Landroid/os/IBinder;ILandroid/content/Intent;Ljava/lang/String;Landroid/content/IIntentReceiver;Ljava/lang/String;Landroid/os/Bundle;)I":
    driven(function* (_caller: unknown, sender: JObj, _token: unknown, _code: number, fill: JIntent | null, _type: string | null, finished: JObj | null): Gen {
      const id = yield* senderId$(sender);
      if (!(yield pendingTransport.send(id, fill ? yield encodeIntent(fill) : null))) return -96;
      if (finished) yield vcall(finished, "performReceive", "(Landroid/content/Intent;ILjava/lang/String;Landroid/os/Bundle;ZZI)V", fill ?? (yield newIntent()), 0, null, null, 0, 0, 0);
      return 0;
    }),
};
/** PendingIntent.sOnMarshaledListener: per thread, those told of each PendingIntent written to a parcel */
const marshaledListeners = new WeakMap<JThread, unknown[]>();
const listenersHere = () => { let l = marshaledListeners.get(curThread); if (!l) marshaledListeners.set(curThread, l = []); return l; };
async function writePendingIntent(this: JPendingIntent, p: JParcel, flags: number) {
  const thread = curThread;
  await vcallOn(thread, p, "writeStrongBinder", "(Landroid/os/IBinder;)V", this.target);
  for (const listener of [...marshaledListeners.get(thread) ?? []])
    await vcallOn(thread, listener, "onMarshaled", "(Landroid/app/PendingIntent;Landroid/os/Parcel;I)V", this, p, flags);
}
rt.register({ name: "android/app/PendingIntent", ctor: JPendingIntent, ifaces: ["android/os/Parcelable"],
  statics: { get CREATOR() { return parcelCreator("android/app/PendingIntent", async p => {
    const target = await vcall(p, "readStrongBinder", "()Landroid/os/IBinder;");
    if (!target) return null;
    const result = new JPendingIntent(); result.target = target; return result;
  }); } }, methods: {
    "static getActivity(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;": (context: JContext, code: number, intent: JIntent, flags: number) => pending("activity", context, code, intent, flags),
    "static getActivities(Landroid/content/Context;I[Landroid/content/Intent;I)Landroid/app/PendingIntent;": pendingActivities,
    "static getActivities(Landroid/content/Context;I[Landroid/content/Intent;ILandroid/os/Bundle;)Landroid/app/PendingIntent;": pendingActivities,
    "static getBroadcast(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;": (context: JContext, code: number, intent: JIntent, flags: number) => pending("broadcast", context, code, intent, flags),
    "static getService(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;": (context: JContext, code: number, intent: JIntent, flags: number) => pending("service", context, code, intent, flags),
    "static getForegroundService(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;": (context: JContext, code: number, intent: JIntent, flags: number) => pending("foreground-service", context, code, intent, flags),
    // PendingIntent.getIntentSender: a new IntentSender over the same IIntentSender
    "getIntentSender()Landroid/content/IntentSender;": function (this: JPendingIntent) { return newObj("android/content/IntentSender", "(Landroid/os/IBinder;)V", this.target); },
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": writePendingIntent,
    "static addOnMarshaledListener(Landroid/app/PendingIntent$OnMarshaledListener;)V": (listener: unknown) => { listenersHere().push(listener); },
    "static removeOnMarshaledListener(Landroid/app/PendingIntent$OnMarshaledListener;)V": (listener: unknown) => {
      const l = listenersHere(), i = l.indexOf(listener);
      if (i >= 0) l.splice(i, 1);
    },
    "equals(Ljava/lang/Object;)Z": function (this: JPendingIntent, other: unknown) { return +(other instanceof JPendingIntent && this.target === other.target); },
    "hashCode()I": function (this: JPendingIntent) { return idHash(this.target); },
    "cancel()V": function (this: JPendingIntent) { pendingTransport.cancel(pendingId(this)); },
    "getCreatorPackage()Ljava/lang/String;": function (this: JPendingIntent) { return pendingTransport.creator(pendingId(this))?.pkg ?? null; },
    "getCreatorUid()I": function (this: JPendingIntent) { return pendingTransport.creator(pendingId(this))?.uid ?? -1; },
    "isActivity()Z": function (this: JPendingIntent) { return +(pendingTransport.kind(pendingId(this)) === "activity"); },
    "isBroadcast()Z": function (this: JPendingIntent) { return +(pendingTransport.kind(pendingId(this)) === "broadcast"); },
    "isService()Z": function (this: JPendingIntent) { return +(pendingTransport.kind(pendingId(this)) === "service"); },
    "isForegroundService()Z": function (this: JPendingIntent) { return +(pendingTransport.kind(pendingId(this)) === "foreground-service"); },
    "isImmutable()Z": function (this: JPendingIntent) { return +(!!(pendingTransport.flags(pendingId(this)) & 0x4000000)); },
    "send()V": function (this: JPendingIntent) { return send(pendingId(this)); },
    "send(I)V": function (this: JPendingIntent) { return send(pendingId(this)); },
    "send(Landroid/content/Context;ILandroid/content/Intent;)V": function (this: JPendingIntent, _context: JContext, _code: number, fill: JIntent | null) { return send(pendingId(this), fill); },
  },
});
