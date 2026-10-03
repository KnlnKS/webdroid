// InputChannel and InputEventReceiver's natives: the socket pair between the window manager and a
// window. The server end publishes an event; the client end's receiver gets it as a callback on its
// looper (NativeInputEventReceiver's handleEvent) and finishes it by sequence number, which settles
// the publisher's wait.
import { rt, type JObj } from "../jvm/runtime";
import { vcall, newObj } from "../jvm/natives/jentry";
import { handle, deref, release, FINALIZER } from "./handles";
import { nativeParcel, readInt, readLocalObject, writeInt, writeLocalObject } from "./parcel";
import { mangleField } from "../jvm/abi";
import type { NativeLooper } from "./mainloop";

interface Receiver { looper: NativeLooper; receiver: JObj }
export class Channel {
  peer: Channel | null = null;
  receiver: Receiver | null = null;
  /** a focus change the client end's receiver has not heard yet */
  focus: boolean | null = null;
  readonly pending = new Map<number, (handled: boolean) => void>();
  constructor(readonly name: string, readonly token: JObj) {}
}
let nextSeq = 1;
/** publish `event` on the server end: resolves with whether the window handled it, or false when no
 *  receiver listens on the client end */
export function publish(server: Channel, event: JObj): Promise<boolean> {
  const client = server.peer, r = client?.receiver;
  if (!client || !r) return Promise.resolve(false);
  const seq = nextSeq++;
  return new Promise((resolve) => {
    client.pending.set(seq, resolve);
    r.looper.post(() => vcall(r.receiver, "dispatchInputEvent", "(ILandroid/view/InputEvent;)V", seq, event));
  });
}
/** tell the client end's window it gained or lost input focus (InputDispatcher's focus event) */
export function sendFocus(server: Channel, hasFocus: boolean): void {
  const client = server.peer;
  if (!client) return;
  client.focus = hasFocus;
  deliverFocus(client);
}
function deliverFocus(client: Channel): void {
  const r = client.receiver, focus = client.focus;
  if (!r || focus === null) return;
  client.focus = null;
  r.looper.post(() => vcall(r.receiver, "onFocusEvent", "(Z)V", +focus));
}
/** each native InputChannel (a dup too) is its own reference to the shared channel end */
const channel = (h: bigint) => deref<{ end: Channel }>(h).end;
const ref = (end: Channel) => handle({ end });
/** the channel end behind a Java InputChannel */
export const channelOf = (input: JObj): Channel => channel((input as unknown as Record<string, bigint>)[mangleField("android/view/InputChannel", "mPtr")]);
const PTR = mangleField("android/os/MessageQueue", "mPtr");

rt.registerJnis("android/view/InputChannel", {
  "nativeOpenInputChannelPair(Ljava/lang/String;)[J": async (name: string) => {
    const token = await newObj("android/os/Binder", "()V");
    const server = new Channel(name, token), client = new Channel(name, token);
    server.peer = client; client.peer = server;
    return BigInt64Array.of(ref(server), ref(client));
  },
  "nativeGetFinalizer()J": () => FINALIZER,
  "nativeDispose(J)V": (h: bigint) => release(h),
  "nativeDup(J)J": (h: bigint) => ref(channel(h)),
  "nativeGetName(J)Ljava/lang/String;": (h: bigint) => channel(h).name,
  "nativeGetToken(J)Landroid/os/IBinder;": (h: bigint) => channel(h).token,
  "nativeWriteToParcel(Landroid/os/Parcel;J)V": (parcel: JObj, h: bigint) => {
    const p = nativeParcel(parcel);
    writeInt(p, h ? 1 : 0);
    if (h) writeLocalObject(p, channel(h));
  },
  "nativeReadFromParcel(Landroid/os/Parcel;)J": (parcel: JObj) => {
    const p = nativeParcel(parcel), end = readInt(p) ? readLocalObject<Channel>(p) : null;
    return end ? ref(end) : 0n;
  },
});

const receiverOf = (h: bigint) => deref<{ channel: Channel }>(h);
rt.registerJnis("android/view/InputEventReceiver", {
  "nativeInit(Ljava/lang/ref/WeakReference;Landroid/view/InputChannel;Landroid/os/MessageQueue;)J":
    (weak: JObj, input: JObj, queue: Record<string, bigint>) => {
      const c = channelOf(input);
      c.receiver = { looper: deref<NativeLooper>(queue[PTR]), receiver: vcall(weak, "get", "()Ljava/lang/Object;") };
      deliverFocus(c);
      return handle({ channel: c });
    },
  "nativeDispose(J)V": (h: bigint) => {
    const { channel: c } = receiverOf(h);
    c.receiver = null;
    for (const resolve of c.pending.values()) resolve(false);
    c.pending.clear();
    release(h);
  },
  "nativeFinishInputEvent(JIZ)V": (h: bigint, seq: number, handled: number) => {
    const pending = receiverOf(h).channel.pending, resolve = pending.get(seq);
    pending.delete(seq);
    resolve?.(!!handled);
  },
  // events are published one at a time as they arrive, never batched
  "nativeConsumeBatchedInputEvents(JJ)Z": () => 0,
  "nativeProbablyHasInput(J)Z": (h: bigint) => +(receiverOf(h).channel.pending.size > 0),
  "nativeReportTimeline(JIJJ)V": () => {},
  "nativeDump(JLjava/lang/String;)Ljava/lang/String;": (h: bigint, prefix: string) => `${prefix}${receiverOf(h).channel.name}\n`,
});
