import { awaited, type JObj, rt, driven, type Gen } from "../jvm/runtime.ts";
import { newObj, vcall, scall, after, iof } from "../jvm/natives/jentry.ts";
import { type JIntent, newIntent } from "./intent.ts";
import { asBinder, exportBinder, importBinder, type BinderHandle, type ParcelData } from "./binder.ts";
import { SYSTEM_SERVER_PID } from "./os.ts";
import { broker } from "../shell/broker-access.ts";
import { encodeIntent, decodeIntent } from "./intentipc.ts";
import type { PendingOperation } from "../shell/pendingintents.ts";

/** PendingIntent.FLAG_IMMUTABLE: a send's fill-in intent is ignored */
const FLAG_IMMUTABLE = 0x4000000;
/** the operation's intent with `fill` filled in, unless its sender is immutable (PendingIntentRecord.sendInner) */
export function* fillIn$(operation: PendingOperation, fill: JIntent | null): Gen<JIntent> {
  const intent = yield* awaited(decodeIntent(operation.intent));
  if (fill && !(operation.flags & FLAG_IMMUTABLE)) yield vcall(intent, "fillIn", "(Landroid/content/Intent;I)I", fill, operation.flags);
  return intent;
}
/** what getInfoForIntentSender reports of a sender */
type PendingInfo = Pick<PendingOperation, "pkg" | "uid" | "kind" | "flags">;
/** ActivityManagerService's PendingIntentController: the broker's records, which every process asks */
export type PendingAccess = {
  create(pkg: string, kind: PendingOperation["kind"], code: number, flags: number, intent: ParcelData, intents?: ParcelData[]): Promise<number | null>;
  cancel(id: number): PromiseOrVal<void>;
  send(id: number, fill: ParcelData | null): Promise<boolean>;
  /** the operation a start on the creator's behalf runs, which consumes a one-shot sender */
  take(id: number): PromiseOrVal<PendingOperation | null>;
  /** the sender's record, left in place */
  peek(id: number): PromiseOrVal<PendingInfo | null>;
};
/** a record's IIntentSender: a binder of system_server's, numbered apart from those it exports */
const senderHandle = (id: number): BinderHandle => ({ pid: SYSTEM_SERVER_PID, id: -id });
/** the record a sender's handle stands for */
export const senderRecord = (h: BinderHandle): number | null => h.pid === SYSTEM_SERVER_PID && h.id < 0 ? -h.id : null;
function targetId(target: unknown): number {
  const handle = exportBinder(target), id = handle && senderRecord(handle);
  if (!id) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Unknown intent sender");
  return id;
}
/** a PendingIntent's (or IntentSender's) record, through its IIntentSender */
export function* senderId$(sender: JObj): Gen<number> {
  const target = iof(sender, "android/content/IIntentSender") ? sender : yield vcall(sender, "getTarget", "()Landroid/content/IIntentSender;");
  return targetId(yield asBinder(target));
}
export const operationId = driven(senderId$);
/** whether the record was there to send */
export function* sendPending$(id: number, fill: JIntent | null | undefined): Gen<boolean> {
  return yield* awaited(broker().pending.send(id, fill ? yield* awaited(encodeIntent(fill)) : null));
}
/** PendingIntent.send's IntentSender call: CanceledException when its record is gone */
export const sendIntent = driven(function* (sender: JObj, fill?: JIntent): Gen<void> {
  if (!(yield* sendPending$(yield* senderId$(sender), fill))) throw rt.mkThrowable("android/app/PendingIntent$CanceledException", null);
});
export const START_CANCELED = -96;
const KINDS: Record<PendingOperation["kind"], number> = { broadcast: 1, activity: 2, service: 4, "foreground-service": 5 };
const KIND_OF: Record<number, PendingOperation["kind"]> = { 1: "broadcast", 2: "activity", 4: "service", 5: "foreground-service" };
/** an IIntentSender over a record of the shell's registry, as AOSP's PendingIntent holds one */
export const intentSender = (id: number) => after(importBinder(senderHandle(id)), (binder) => scall("android/content/IIntentSender$Stub", "asInterface",
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
      const id = yield* awaited(broker().pending.create(pkg, kind, code, flags, encoded.at(-1)!, kind === "activity" && encoded.length > 1 ? encoded : undefined));
      return id === null ? null : intentSender(id);
    }),
  "cancelIntentSender(Landroid/content/IIntentSender;)V": driven(function* (sender: JObj): Gen { yield* awaited(broker().pending.cancel(yield* senderId$(sender))); }),
  "getInfoForIntentSender(Landroid/content/IIntentSender;)Landroid/app/ActivityManager$PendingIntentInfo;": driven(function* (sender: JObj): Gen {
    const info = yield* awaited(broker().pending.peek(yield* senderId$(sender)));
    return newObj("android/app/ActivityManager$PendingIntentInfo", "(Ljava/lang/String;IZI)V", info?.pkg ?? null, info?.uid ?? -1,
      +!!(info && info.flags & FLAG_IMMUTABLE), info ? KINDS[info.kind] : 0);
  }),
  // ActivityManager.START_CANCELED when the record is gone; a finished receiver hears the send, as
  // PendingIntentRecord.sendInner tells one for every kind but an ordered broadcast
  "sendIntentSender(Landroid/app/IApplicationThread;Landroid/content/IIntentSender;Landroid/os/IBinder;ILandroid/content/Intent;Ljava/lang/String;Landroid/content/IIntentReceiver;Ljava/lang/String;Landroid/os/Bundle;)I":
    driven(function* (_caller: unknown, sender: JObj, _token: unknown, _code: number, fill: JIntent | null, _type: string | null, finished: JObj | null): Gen {
      if (!(yield* sendPending$(yield* senderId$(sender), fill))) return START_CANCELED;
      if (finished) yield vcall(finished, "performReceive", "(Landroid/content/Intent;ILjava/lang/String;Landroid/os/Bundle;ZZI)V", fill ?? (yield* awaited(newIntent())), 0, null, null, 0, 0, 0);
      return 0;
    }),
};
