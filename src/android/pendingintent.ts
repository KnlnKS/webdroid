import { awaited, type JObj, rt, driven, type Gen } from "../jvm/runtime.ts";
import { newObj, vcall, scall, after, iof } from "../jvm/natives/jentry.ts";
import { type JIntent, newIntent, putExtra } from "./intent.ts";
import { asBinder, exportBinder, importBinder, type ParcelData } from "./binder.ts";
import { notConnected } from "../jvm/natives/jthrowable.ts";
import { encodeIntent, decodeIntent } from "./intentipc.ts";
import type { PendingOperation } from "../shell/pendingintents.ts";
import { broadcastIntent } from "./server/broadcastqueue.ts";
import { startActivityFor } from "./server/atm.ts";
import { startService } from "./server/activeservices.ts";
import { thisApp } from "./server/am.ts";

/** PendingIntent.FLAG_IMMUTABLE: a send's fill-in intent is ignored */
const FLAG_IMMUTABLE = 0x4000000;
/** the operation's intent with `fill` filled in, unless its sender is immutable (PendingIntentRecord.sendInner) */
function* fillIn$(operation: PendingOperation, fill: JIntent | null): Gen<JIntent> {
  const intent = yield* awaited(decodeIntent(operation.intent));
  if (fill && !(operation.flags & FLAG_IMMUTABLE)) yield vcall(intent, "fillIn", "(Landroid/content/Intent;I)I", fill, operation.flags);
  return intent;
}
/** an activity operation's start: the intents before its last, then the last on top */
function* startOperation$(caller: JObj, operation: PendingOperation, intent: JIntent, resolvedType: string | null = null, resultTo: JObj | null = null,
  resultWho: string | null = null, requestCode = -1): Gen<number> {
  for (const data of operation.intents?.slice(0, -1) ?? []) yield startActivityFor(caller, yield* awaited(decodeIntent(data)));
  return yield* awaited(startActivityFor(caller, intent, resolvedType, resultTo, resultWho, requestCode));
}
/** PendingIntentRecord.sendInner, in the creator's process with its identity */
export const executePendingIntent = driven(function* (operation: PendingOperation, fill: ParcelData | null, alarmCount: number): Gen<void> {
  const mutable = !(operation.flags & FLAG_IMMUTABLE);
  const supplied = mutable && (fill || alarmCount) ? yield* awaited(fill ? decodeIntent(fill) : newIntent()) : null;
  if (supplied && alarmCount) yield putExtra(supplied, "android.intent.extra.ALARM_COUNT", alarmCount, "I");
  const intent = yield* fillIn$(operation, supplied);
  if (operation.kind === "broadcast") yield broadcastIntent(intent, [], false);
  else if (operation.kind === "activity") yield* startOperation$(thisApp(), operation, intent);
  else yield startService(intent, null, operation.kind === "foreground-service", operation.pkg);
});
/** what getInfoForIntentSender reports of a sender */
type PendingInfo = Pick<PendingOperation, "pkg" | "uid" | "kind" | "flags">;
export type PendingAccess = {
  create(pkg: string, kind: PendingOperation["kind"], code: number, flags: number, intent: ParcelData, intents?: ParcelData[]): Promise<number | null>;
  cancel(id: number): void | Promise<void>;
  send(id: number, fill: ParcelData | null): Promise<boolean>;
  /** the operation a start on the creator's behalf runs, which consumes a one-shot sender */
  take(id: number): PendingOperation | null | Promise<PendingOperation | null>;
  /** the sender's record, left in place */
  peek(id: number): PendingInfo | null | Promise<PendingInfo | null>;
};
/** ActivityManagerService's PendingIntentController: the broker's records, which every process asks */
export const pendingTransport: PendingAccess = { create: notConnected, cancel: notConnected, send: notConnected, take: notConnected, peek: notConnected };
function targetId(target: unknown): number {
  const handle = exportBinder(target);
  if (!handle || handle.pid !== 0) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Unknown intent sender");
  return handle.id;
}
function* senderId$(sender: JObj): Gen<number> {
  const target = iof(sender, "android/content/IIntentSender") ? sender : yield vcall(sender, "getTarget", "()Landroid/content/IIntentSender;");
  return targetId(yield asBinder(target));
}
/** a PendingIntent's (or IntentSender's) record, through its IIntentSender */
export const operationId = driven(senderId$);
/** whether the record was there to send */
function* send$(id: number, fill: JIntent | null | undefined): Gen<boolean> {
  return yield* awaited(pendingTransport.send(id, fill ? yield* awaited(encodeIntent(fill)) : null));
}
/** PendingIntent.send's IntentSender call: CanceledException when its record is gone */
export const sendIntent = driven(function* (sender: JObj, fill?: JIntent): Gen<void> {
  if (!(yield* send$(yield* senderId$(sender), fill))) throw rt.mkThrowable("android/app/PendingIntent$CanceledException", null);
});
const START_CANCELED = -96;
const KINDS: Record<PendingOperation["kind"], number> = { broadcast: 1, activity: 2, service: 4, "foreground-service": 5 };
const KIND_OF: Record<number, PendingOperation["kind"]> = { 1: "broadcast", 2: "activity", 4: "service", 5: "foreground-service" };
/** an IIntentSender over a record of the shell's registry, as AOSP's PendingIntent holds one */
export const intentSender = (id: number) => after(importBinder({ pid: 0, id }), (binder) => scall("android/content/IIntentSender$Stub", "asInterface",
  "(Landroid/os/IBinder;)Landroid/content/IIntentSender;", binder));
/** IActivityManager's IntentSender calls, over the shell's records */
export const intentSenderMethods = {
  // ActivityManagerService.getIntentSenderWithFeature: a record per creator, kind, request code,
  // flags and filterEquals-equal intent (the last of an activity list is the one launched)
  "getIntentSenderWithFeature(ILjava/lang/String;Ljava/lang/String;Landroid/os/IBinder;Ljava/lang/String;I[Landroid/content/Intent;[Ljava/lang/String;ILandroid/os/Bundle;I)Landroid/content/IIntentSender;":
    driven(function* (type: number, pkg: string, _feature: string | null, _token: unknown, _who: string | null, code: number, intents: JIntent[] | null, _types: unknown, flags: number): Gen {
      const kind = KIND_OF[type];
      if (!kind) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Bad PendingIntent type: " + type);
      if (!intents?.length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "intents must not be empty");
      for (const intent of intents) if (yield vcall(intent, "hasFileDescriptors", "()Z"))
        throw rt.mkThrowable("java/lang/IllegalArgumentException", "File descriptors passed in Intent");
      const encoded: ParcelData[] = [];
      for (const intent of intents) encoded.push(yield* awaited(encodeIntent(intent)));
      const id = yield* awaited(pendingTransport.create(pkg, kind, code, flags, encoded.at(-1)!, kind === "activity" && encoded.length > 1 ? encoded : undefined));
      return id === null ? null : intentSender(id);
    }),
  "cancelIntentSender(Landroid/content/IIntentSender;)V": driven(function* (sender: JObj): Gen { yield* awaited(pendingTransport.cancel(yield* senderId$(sender))); }),
  "getInfoForIntentSender(Landroid/content/IIntentSender;)Landroid/app/ActivityManager$PendingIntentInfo;": driven(function* (sender: JObj): Gen {
    const info = yield* awaited(pendingTransport.peek(yield* senderId$(sender)));
    return newObj("android/app/ActivityManager$PendingIntentInfo", "(Ljava/lang/String;IZI)V", info?.pkg ?? null, info?.uid ?? -1,
      +!!(info && info.flags & FLAG_IMMUTABLE), info ? KINDS[info.kind] : 0);
  }),
  // ActivityManager.START_CANCELED when the record is gone; a finished receiver hears the send, as
  // PendingIntentRecord.sendInner tells one for every kind but an ordered broadcast
  "sendIntentSender(Landroid/app/IApplicationThread;Landroid/content/IIntentSender;Landroid/os/IBinder;ILandroid/content/Intent;Ljava/lang/String;Landroid/content/IIntentReceiver;Ljava/lang/String;Landroid/os/Bundle;)I":
    driven(function* (_caller: unknown, sender: JObj, _token: unknown, _code: number, fill: JIntent | null, _type: string | null, finished: JObj | null): Gen {
      if (!(yield* send$(yield* senderId$(sender), fill))) return START_CANCELED;
      if (finished) yield vcall(finished, "performReceive", "(Landroid/content/Intent;ILjava/lang/String;Landroid/os/Bundle;ZZI)V", fill ?? (yield* awaited(newIntent())), 0, null, null, 0, 0, 0);
      return 0;
    }),
};
/** ActivityTaskManagerService.startActivityIntentSender (Activity.startIntentSenderForResult): an
 *  activity sender starts for the caller's result; any other kind is an ordinary send, which the
 *  peek leaves to consume a one-shot sender */
export const intentSenderTaskMethods = {
  "startActivityIntentSender(Landroid/app/IApplicationThread;Landroid/content/IIntentSender;Landroid/os/IBinder;Landroid/content/Intent;Ljava/lang/String;Landroid/os/IBinder;Ljava/lang/String;IIILandroid/os/Bundle;)I":
    driven(function* (caller: JObj, target: JObj, _token: unknown, fill: JIntent | null, resolvedType: string | null, resultTo: JObj | null, resultWho: string | null, requestCode: number): Gen {
      const id = yield* senderId$(target), info = yield* awaited(pendingTransport.peek(id));
      if (info?.kind !== "activity") return info && (yield* send$(id, fill)) ? 0 : START_CANCELED;
      const operation = yield* awaited(pendingTransport.take(id));
      return operation ? yield* startOperation$(caller, operation, yield* fillIn$(operation, fill), resolvedType, resultTo, resultWho, requestCode) : START_CANCELED;
    }),
};
