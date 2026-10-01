// InputChannel and InputEventReceiver's natives: the socket pair between the window manager and a
// window. The server end publishes an event; the client end's receiver gets it as a callback on its
// looper (NativeInputEventReceiver's handleEvent) and finishes it by sequence number, which settles
// the publisher's wait.
import { rt, type JObj } from "../jvm/runtime";
import { vcall, newObj } from "../jvm/natives/jlang";
import { handle, deref, release, FINALIZER } from "./handles";
import { mangleField } from "../jvm/abi";
import type { NativeLooper } from "./mainloop";

interface Receiver { looper: NativeLooper; receiver: JObj }
export class Channel {
  peer: Channel | null = null;
  receiver: Receiver | null = null;
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
const channel = (h: bigint) => deref<Channel>(h);
const PTR = mangleField("android/os/MessageQueue", "mPtr");

rt.registerJnis("android/view/InputChannel", {
  "nativeOpenInputChannelPair(Ljava/lang/String;)[J": async (name: string) => {
    const token = await newObj("android/os/Binder", "()V");
    const server = new Channel(name, token), client = new Channel(name, token);
    server.peer = client; client.peer = server;
    return BigInt64Array.of(handle(server), handle(client));
  },
  "nativeGetFinalizer()J": () => FINALIZER,
  "nativeDispose(J)V": (h: bigint) => {
    const c = channel(h);
    if (c.peer) c.peer.peer = null;
    for (const resolve of c.pending.values()) resolve(false);
    release(h);
  },
  "nativeDup(J)J": (h: bigint) => handle(channel(h)),
  "nativeGetName(J)Ljava/lang/String;": (h: bigint) => channel(h).name,
  "nativeGetToken(J)Landroid/os/IBinder;": (h: bigint) => channel(h).token,
});

const receiverOf = (h: bigint) => deref<{ channel: Channel }>(h);
rt.registerJnis("android/view/InputEventReceiver", {
  "nativeInit(Ljava/lang/ref/WeakReference;Landroid/view/InputChannel;Landroid/os/MessageQueue;)J":
    (weak: JObj, input: Record<string, bigint>, queue: Record<string, bigint>) => {
      const c = channel(input[mangleField("android/view/InputChannel", "mPtr")]);
      c.receiver = { looper: deref<NativeLooper>(queue[PTR]), receiver: vcall(weak, "get", "()Ljava/lang/Object;") };
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
