import { awaited, type JObj, rt, driven, type Gen } from "../jvm/runtime.ts";
import { newObj, vcall, scall, after, iof } from "../jvm/natives/jentry.ts";
import { type JIntent, newIntent, putExtra } from "./intent.ts";
import { exportBinder, importBinder, notConnected, type ParcelData } from "./binder.ts";
import { encodeIntent, decodeIntent } from "./intentipc.ts";
import type { PendingOperation } from "../shell/pendingintents.ts";
import { broadcastIntent } from "./server/broadcastqueue.ts";
import { startActivityFor } from "./server/atm.ts";
import { startService } from "./server/activeservices.ts";
import { thisApp } from "./server/am.ts";

/** PendingIntentRecord.sendInner, in the creator's process with its identity */
export const executePendingIntent = driven(function* (operation: PendingOperation, fill: ParcelData | null, alarmCount: number): Gen<void> {
  const intent = yield* awaited(decodeIntent(operation.intent));
  if (!(operation.flags & 0x4000000)) {
    const supplied = fill ? yield* awaited(decodeIntent(fill)) : yield* awaited(newIntent());
    if (alarmCount) yield putExtra(supplied, "android.intent.extra.ALARM_COUNT", alarmCount, "I");
    yield vcall(intent, "fillIn", "(Landroid/content/Intent;I)I", supplied, operation.flags);
  }
  if (operation.kind === "broadcast") yield broadcastIntent(intent, [], false);
  else if (operation.kind === "activity") {
    for (const data of operation.intents?.slice(0, -1) ?? []) yield startActivityFor(thisApp(), yield* awaited(decodeIntent(data)));
    yield startActivityFor(thisApp(), intent);
  } else yield startService(intent, null, operation.kind === "foreground-service", operation.pkg);
});
export type PendingAccess = {
  create(pkg: string, kind: PendingOperation["kind"], code: number, flags: number, intent: ParcelData, intents?: ParcelData[]): Promise<number | null>;
  cancel(id: number): void | Promise<void>;
  send(id: number, fill: ParcelData | null): Promise<boolean>;
  operation(id: number): PendingOperation | null | Promise<PendingOperation | null>;
  kind(id: number): PendingOperation["kind"] | null | Promise<PendingOperation["kind"] | null>;
  flags(id: number): number | Promise<number>;
  creator(id: number): { pkg: string; uid: number } | null | Promise<{ pkg: string; uid: number } | null>;
};
/** ActivityManagerService's PendingIntentController: the broker's records, which every process asks */
export const pendingTransport: PendingAccess = {
  create: notConnected, cancel: notConnected, send: notConnected, operation: notConnected, kind: notConnected, flags: notConnected, creator: notConnected,
};
function targetId(target: unknown): number {
  const handle = exportBinder(target);
  if (!handle || handle.pid !== 0) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Unknown intent sender");
  return handle.id;
}
function* senderId$(sender: JObj): Gen<number> {
  const target = iof(sender, "android/content/IIntentSender") ? sender : yield vcall(sender, "getTarget", "()Landroid/content/IIntentSender;");
  return targetId(yield vcall(target, "asBinder", "()Landroid/os/IBinder;"));
}
/** a PendingIntent's (or IntentSender's) record, through its IIntentSender */
export const operationId = driven(senderId$);
/** PendingIntent.send's IntentSender call: CanceledException when its record is gone */
export const sendIntent = driven(function* (sender: JObj, fill?: JIntent): Gen<void> {
  const id = yield* senderId$(sender);
  if (!(yield* awaited(pendingTransport.send(id, fill ? yield* awaited(encodeIntent(fill)) : null)))) throw rt.mkThrowable("android/app/PendingIntent$CanceledException", null);
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
    const id = yield* senderId$(sender), creator = yield* awaited(pendingTransport.creator(id)), kind = yield* awaited(pendingTransport.kind(id));
    return newObj("android/app/ActivityManager$PendingIntentInfo", "(Ljava/lang/String;IZI)V", creator?.pkg ?? null, creator?.uid ?? -1,
      +!!((yield* awaited(pendingTransport.flags(id))) & 0x4000000), kind ? KINDS[kind] : 0);
  }),
  // ActivityManager.START_CANCELED when the record is gone; a finished receiver hears the send, as
  // PendingIntentRecord.sendInner tells one for every kind but an ordered broadcast
  "sendIntentSender(Landroid/app/IApplicationThread;Landroid/content/IIntentSender;Landroid/os/IBinder;ILandroid/content/Intent;Ljava/lang/String;Landroid/content/IIntentReceiver;Ljava/lang/String;Landroid/os/Bundle;)I":
    driven(function* (_caller: unknown, sender: JObj, _token: unknown, _code: number, fill: JIntent | null, _type: string | null, finished: JObj | null): Gen {
      const id = yield* senderId$(sender);
      if (!(yield* awaited(pendingTransport.send(id, fill ? yield* awaited(encodeIntent(fill)) : null)))) return START_CANCELED;
      if (finished) yield vcall(finished, "performReceive", "(Landroid/content/Intent;ILjava/lang/String;Landroid/os/Bundle;ZZI)V", fill ?? (yield* awaited(newIntent())), 0, null, null, 0, 0, 0);
      return 0;
    }),
};
/** ActivityTaskManagerService.startActivityIntentSender (Activity.startIntentSenderForResult): an
 *  activity sender starts for the caller's result; any other kind is an ordinary send */
export const intentSenderTaskMethods = {
  "startActivityIntentSender(Landroid/app/IApplicationThread;Landroid/content/IIntentSender;Landroid/os/IBinder;Landroid/content/Intent;Ljava/lang/String;Landroid/os/IBinder;Ljava/lang/String;IIILandroid/os/Bundle;)I":
    driven(function* (caller: JObj, target: JObj, _token: unknown, fill: JIntent | null, resolvedType: string | null, resultTo: JObj | null, resultWho: string | null, requestCode: number): Gen {
      const id = yield* senderId$(target), operation = yield* awaited(pendingTransport.operation(id));
      if (!operation) return START_CANCELED;
      if (operation.kind !== "activity") return (yield* awaited(pendingTransport.send(id, fill ? yield* awaited(encodeIntent(fill)) : null))) ? 0 : START_CANCELED;
      const intent = yield* awaited(decodeIntent(operation.intent));
      if (fill && !(operation.flags & 0x4000000)) yield vcall(intent, "fillIn", "(Landroid/content/Intent;I)I", fill, operation.flags);
      for (const data of operation.intents?.slice(0, -1) ?? []) yield startActivityFor(caller, yield* awaited(decodeIntent(data)));
      return startActivityFor(caller, intent, resolvedType, resultTo, resultWho, requestCode);
    }),
};
