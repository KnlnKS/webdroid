import { JObj, rt, driven, type Gen } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";

class JRemoteCallbackList extends JObj {
  callbacks = new Map<unknown, JCallback>();
  broadcast: JCallback[] | null = null;
  killed = false;
}
class JCallback extends JObj {
  dead = false;
  constructor(readonly list: JRemoteCallbackList, readonly binder: unknown, readonly callback: unknown, readonly cookie: unknown) { super(); }
}
rt.register({ name: "android/os/RemoteCallbackList$Callback", ctor: JCallback, ifaces: ["android/os/IBinder$DeathRecipient"], methods: {
  "binderDied()V": driven(function* (this: JCallback): Gen {
    this.dead = true;
    this.list.callbacks.delete(this.binder);
    yield vcall(this.list, "onCallbackDied", "(Landroid/os/IInterface;Ljava/lang/Object;)V", this.callback, this.cookie);
  }),
} });

function begin(list: JRemoteCallbackList): number {
  if (list.broadcast?.length) throw rt.mkThrowable("java/lang/IllegalStateException", "beginBroadcast() called while already in a broadcast");
  list.broadcast = [...list.callbacks.values()];
  return list.broadcast.length;
}
function finish(list: JRemoteCallbackList): void {
  if (!list.broadcast) throw rt.mkThrowable("java/lang/IllegalStateException", "finishBroadcast() called outside of a broadcast");
  list.broadcast = null;
}
function item(items: Iterable<JCallback> | null, index: number): JCallback {
  if (!items) throw rt.mkThrowable("java/lang/NullPointerException", null);
  if (Array.isArray(items) && index >= 0 && index < items.length) return items[index];
  if (index >= 0) for (const callback of items) if (index-- === 0) return callback;
  throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", String(index));
}
async function broadcast(list: JRemoteCallbackList, consumer: unknown, cookie: boolean, both = false): Promise<void> {
  begin(list);
  try {
    for (const entry of list.broadcast!) {
      if (both) await vcall(consumer, "accept", "(Ljava/lang/Object;Ljava/lang/Object;)V", entry.callback, entry.cookie);
      else await vcall(consumer, "accept", "(Ljava/lang/Object;)V", cookie ? entry.cookie : entry.callback);
    }
  } finally { finish(list); }
}
rt.register({ name: "android/os/RemoteCallbackList", ctor: JRemoteCallbackList, methods: {
  "<init>()V": () => {},
  "register(Landroid/os/IInterface;)Z": function (this: JRemoteCallbackList, callback: unknown) {
    if (callback == null) throw rt.mkThrowable("java/lang/NullPointerException", "callback must not be null");
    return vcall(this, "register", "(Landroid/os/IInterface;Ljava/lang/Object;)Z", callback, null);
  },
  "register(Landroid/os/IInterface;Ljava/lang/Object;)Z": driven(function* (this: JRemoteCallbackList, callback: unknown, cookie: unknown): Gen {
    if (callback == null) throw rt.mkThrowable("java/lang/NullPointerException", "callback must not be null");
    if (this.killed) return 0;
    const binder = (yield vcall(callback, "asBinder", "()Landroid/os/IBinder;"));
    rt.link("android/os/RemoteCallbackList$Callback");
    const entry = new JCallback(this, binder, callback, cookie);
    try { (yield vcall(binder, "linkToDeath", "(Landroid/os/IBinder$DeathRecipient;I)V", entry, 0)); }
    catch (error) { if (rt.iof(error, "android/os/RemoteException")) return 0; throw error; }
    if (this.killed || entry.dead) {
      yield vcall(binder, "unlinkToDeath", "(Landroid/os/IBinder$DeathRecipient;I)Z", entry, 0);
      return 0;
    }
    const previous = this.callbacks.get(binder);
    this.callbacks.set(binder, entry);
    if (previous) yield vcall(binder, "unlinkToDeath", "(Landroid/os/IBinder$DeathRecipient;I)Z", previous, 0);
    return 1;
  }),
  "unregister(Landroid/os/IInterface;)Z": driven(function* (this: JRemoteCallbackList, callback: unknown): Gen {
    const binder = (yield vcall(callback, "asBinder", "()Landroid/os/IBinder;")), entry = this.callbacks.get(binder);
    if (!entry) return 0;
    this.callbacks.delete(binder);
    yield vcall(binder, "unlinkToDeath", "(Landroid/os/IBinder$DeathRecipient;I)Z", entry, 0);
    return 1;
  }),
  "kill()V": driven(function* (this: JRemoteCallbackList): Gen {
    this.killed = true;
    const entries = [...this.callbacks.values()]; this.callbacks.clear();
    for (const entry of entries) (yield vcall(entry.binder, "unlinkToDeath", "(Landroid/os/IBinder$DeathRecipient;I)Z", entry, 0));
  }),
  "beginBroadcast()I": function (this: JRemoteCallbackList) { return begin(this); },
  "finishBroadcast()V": function (this: JRemoteCallbackList) { finish(this); },
  "getBroadcastItem(I)Landroid/os/IInterface;": function (this: JRemoteCallbackList, index: number) { return item(this.broadcast, index).callback; },
  "getBroadcastCookie(I)Ljava/lang/Object;": function (this: JRemoteCallbackList, index: number) { return item(this.broadcast, index).cookie; },
  "getRegisteredCallbackCount()I": function (this: JRemoteCallbackList) { return this.callbacks.size; },
  "getRegisteredCallbackItem(I)Landroid/os/IInterface;": function (this: JRemoteCallbackList, index: number) { return this.killed ? null : item(this.callbacks.values(), index).callback; },
  "getRegisteredCallbackCookie(I)Ljava/lang/Object;": function (this: JRemoteCallbackList, index: number) { return this.killed ? null : item(this.callbacks.values(), index).cookie; },
  "onCallbackDied(Landroid/os/IInterface;)V": () => {},
  "onCallbackDied(Landroid/os/IInterface;Ljava/lang/Object;)V": function (this: JRemoteCallbackList, callback: unknown) { return vcall(this, "onCallbackDied", "(Landroid/os/IInterface;)V", callback); },
  "broadcast(Ljava/util/function/Consumer;)V": function (this: JRemoteCallbackList, consumer: unknown) { return broadcast(this, consumer, false); },
  "broadcast(Ljava/util/function/BiConsumer;)V": function (this: JRemoteCallbackList, consumer: unknown) { return broadcast(this, consumer, false, true); },
  "broadcastForEachCookie(Ljava/util/function/Consumer;)V": function (this: JRemoteCallbackList, consumer: unknown) { return broadcast(this, consumer, true); },
} });
