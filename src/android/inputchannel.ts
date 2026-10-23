// InputChannel and InputEventReceiver's natives: the socket pair between the window manager and a
// window. The server end publishes an event; the client end's receiver gets it as a callback on its
// looper (NativeInputEventReceiver's handleEvent) and finishes it by sequence number, which settles
// the publisher's wait.
import { rt, getDeclared, waits, type JObj } from "../jvm/runtime.ts";
import { after, vcall, newObj } from "../jvm/natives/jentry.ts";
import { handle, deref, release, FINALIZER } from "./handles.ts";
import { nativeParcel, readInt, readLocalObject, writeInt, writeLocalObject } from "./parcel.ts";
import type { NativeLooper } from "./mainloop.ts";
import { note, Ev } from "../timeline.ts";

interface Receiver { looper: NativeLooper; receiver: JObj }
export class Channel {
  readonly name: string; readonly token: JObj;
  peer: Channel | null = null;
  receiver: Receiver | null = null;
  /** a focus change the client end's receiver has not heard yet */
  focus: boolean | null = null;
  readonly pending = new Map<number, (handled: boolean) => void>();
  constructor(name: string, token: JObj) { this.name = name; this.token = token; }
}
let nextSeq = 1;
/** publish `event` on the server end: resolves with whether the window handled it, or false when no
 *  receiver listens on the client end. `dispatching` runs as the client's looper begins dispatching it */
export function publish(server: Channel, event: JObj, dispatching?: () => void): Promise<boolean> {
  const client = server.peer, r = client?.receiver;
  if (!client || !r) return Promise.resolve(false);
  const seq = nextSeq++;
  note(Ev.InputPublish, seq);
  return new Promise((resolve) => {
    client.pending.set(seq, (handled) => { note(Ev.InputDone, seq); resolve(handled); });
    r.looper.post(() => {
      note(Ev.InputDispatch, seq);
      dispatching?.();
      return vcall(r.receiver, "dispatchInputEvent", "(ILandroid/view/InputEvent;)V", seq, event);
    });
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
interface NativeInputChannel { end: Channel | null }
const channel = (h: bigint) => deref<NativeInputChannel>(h)?.end ?? null;
const ref = (end: Channel) => handle({ end });
/** the channel end behind a Java InputChannel */
export const channelOf = (input: JObj): Channel => {
  const end = channel(getDeclared<bigint>(input, "android/view/InputChannel", "mPtr"));
  if (!end) throw rt.mkThrowable("java/lang/RuntimeException", "NativeInputChannel has no corresponding InputChannel");
  return end;
};

rt.registerJnis("android/view/InputChannel", {
  "nativeOpenInputChannelPair(Ljava/lang/String;)[J": async (name: string) => {
    const token = await newObj("android/os/Binder", "()V");
    const server = new Channel(name, token), client = new Channel(name, token);
    server.peer = client; client.peer = server;
    return BigInt64Array.of(ref(server), ref(client));
  },
  "nativeGetFinalizer()J": () => FINALIZER,
  // JNI dispose resets the channel; NAR alone destroys its still-addressable wrapper.
  "nativeDispose(J)V": (h: bigint) => { const native = deref<NativeInputChannel>(h); if (native) native.end = null; },
  "nativeDup(J)J": (h: bigint) => {
    const end = channel(h);
    if (!end) throw rt.mkThrowable("java/lang/RuntimeException", "NativeInputChannel has no corresponding InputChannel");
    return ref(end);
  },
  "nativeGetName(J)Ljava/lang/String;": (h: bigint) => channel(h)?.name ?? null,
  "nativeGetToken(J)Landroid/os/IBinder;": (h: bigint) => channel(h)?.token ?? null,
  "nativeWriteToParcel(Landroid/os/Parcel;J)V": (parcel: JObj, h: bigint) => {
    const p = nativeParcel(parcel);
    const end = channel(h);
    writeInt(p, end ? 1 : 0);
    if (end) writeLocalObject(p, end);
  },
  "nativeReadFromParcel(Landroid/os/Parcel;)J": (parcel: JObj) => {
    const p = nativeParcel(parcel), end = readInt(p) ? readLocalObject<Channel>(p) : null;
    return end ? ref(end) : 0n;
  },
});

const receiverOf = (h: bigint) => deref<{ channel: Channel }>(h);
rt.registerJnis("android/view/InputEventReceiver", {
  "nativeInit(Ljava/lang/ref/WeakReference;Landroid/view/InputChannel;Landroid/os/MessageQueue;)J":
    waits((weak: JObj, input: JObj, queue: JObj) => {
      const c = channelOf(input), looper = deref<NativeLooper>(getDeclared<bigint>(queue, "android/os/MessageQueue", "mPtr"));
      return after(vcall(weak, "get", "()Ljava/lang/Object;") as JObj | Promise<JObj>, (receiver) => {
        c.receiver = { looper, receiver };
        deliverFocus(c);
        return handle({ channel: c });
      });
    }),
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
