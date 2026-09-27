import { JObj, rt, stubs, noops, driven, type Gen } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { type JHandler, JBundle, JMessage, obtain } from "./os";
import { JBinder, callingIdentity } from "./binder";
import { JParcel, parcelCreator } from "./parcel";

async function readMessage(p: JParcel): Promise<JMessage> {
  const m = new JMessage();
  for (const key of ["what", "arg1", "arg2"] as const) m[key] = await vcall(p, "readInt", "()I");
  if (await vcall(p, "readInt", "()I")) m.obj = await vcall(p, "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
  m.whenMs = Number(await vcall(p, "readLong", "()J"));
  m.data = await vcall(p, "readBundle", "()Landroid/os/Bundle;");
  m.replyTo = await readMessenger(p);
  m.sendingUid = await vcall(p, "readInt", "()I"); m.workSourceUid = await vcall(p, "readInt", "()I");
  return m;
}
rt.register({ name: "android/os/Message", ctor: JMessage, ifaces: ["android/os/Parcelable"],
  fields: ["what", "arg1", "arg2", "obj", "replyTo", "sendingUid", "workSourceUid"],
  statics: { get CREATOR() { return parcelCreator("android/os/Message", readMessage); } }, methods: {
    "static obtain()Landroid/os/Message;": () => new JMessage(),
    "static obtain(Landroid/os/Handler;)Landroid/os/Message;": (h: JHandler) => obtain(h),
    "static obtain(Landroid/os/Handler;I)Landroid/os/Message;": (h: JHandler, w: number) => obtain(h, w),
    "static obtain(Landroid/os/Handler;ILjava/lang/Object;)Landroid/os/Message;": (h: JHandler, w: number, o: unknown) => obtain(h, w, o),
    "static obtain(Landroid/os/Handler;III)Landroid/os/Message;": (h: JHandler, w: number, a: number, b: number) => obtain(h, w, null, a, b),
    "static obtain(Landroid/os/Handler;IIILjava/lang/Object;)Landroid/os/Message;": (h: JHandler, w: number, a: number, b: number, o: unknown) => obtain(h, w, o, a, b),
    "static obtain(Landroid/os/Handler;Ljava/lang/Runnable;)Landroid/os/Message;": (h: JHandler, r: unknown) => obtain(h, 0, null, 0, 0, r),
    "static obtain(Landroid/os/Message;)Landroid/os/Message;": (m: JMessage) => {
      const copy = obtain(m.target, m.what, m.obj, m.arg1, m.arg2, m.callback);
      copy.asynchronous = m.asynchronous;
      copy.replyTo = m.replyTo; copy.sendingUid = m.sendingUid; copy.workSourceUid = m.workSourceUid;
      if (m.data) { copy.data = new JBundle(); copy.data.map = new Map(m.data.map); copy.data.loader = m.data.loader; }
      return copy;
    },
    "setAsynchronous(Z)V": function (this: JMessage, value: number) { this.asynchronous = !!value; },
    "isAsynchronous()Z": function (this: JMessage) { return +this.asynchronous; },
    "getTarget()Landroid/os/Handler;": function (this: JMessage) { return this.target; },
    "getWhen()J": function (this: JMessage) { return BigInt(Math.floor(this.whenMs)); },
    "setTarget(Landroid/os/Handler;)V": function (this: JMessage, h: JHandler) { this.target = h; },
    "sendToTarget()V": function (this: JMessage) { this.target?.send(this, 0); },
    "getCallback()Ljava/lang/Runnable;": function (this: JMessage) { return this.callback; },
    "getData()Landroid/os/Bundle;": function (this: JMessage) { return this.data ??= new JBundle(); },
    "peekData()Landroid/os/Bundle;": function (this: JMessage) { return this.data; },
    "setData(Landroid/os/Bundle;)V": function (this: JMessage, data: JBundle | null) { this.data = data; },
    ...noops("<init>()V", "recycle()V"),
    ...stubs(0, "describeContents()I"),
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JMessage, p: JParcel, flags: number): Gen {
      if (this.callback) throw rt.mkThrowable("java/lang/RuntimeException", "Cannot marshal callbacks");
      for (const value of [this.what, this.arg1, this.arg2, this.obj ? 1 : 0]) yield vcall(p, "writeInt", "(I)V", value);
      if (this.obj) yield vcall(p, "writeParcelable", "(Landroid/os/Parcelable;I)V", this.obj, flags);
      yield vcall(p, "writeLong", "(J)V", BigInt(this.whenMs));
      yield vcall(p, "writeBundle", "(Landroid/os/Bundle;)V", this.data);
      yield vcall(p, "writeStrongBinder", "(Landroid/os/IBinder;)V", this.replyTo?.binder ?? null);
      yield vcall(p, "writeInt", "(I)V", this.sendingUid); yield vcall(p, "writeInt", "(I)V", this.workSourceUid);
    }),
} });

class JMessengerBinder extends JBinder { handler!: JHandler; }
rt.register({ name: "webdroid/MessengerBinder", ctor: JMessengerBinder, sup: "android/os/Binder", methods: {
  "onTransact(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z": driven(function* (this: JMessengerBinder, code: number, data: JParcel, reply: JParcel | null): Gen {
    if (code === 0x5f4e5446 && reply) { yield vcall(reply, "writeString", "(Ljava/lang/String;)V", "android.os.IMessenger"); return 1; }
    if (code !== 1) return 0;
    yield vcall(data, "enforceInterface", "(Ljava/lang/String;)V", "android.os.IMessenger");
    if (yield vcall(data, "readInt", "()I")) {
      const message = yield readMessage(data); message.sendingUid = callingIdentity().uid; this.handler.send(message, 0);
    }
    return 1;
  }),
} });
export class JMessenger extends JObj { binder: JObj | null = null; }
const handlers = new WeakMap<JHandler, JMessengerBinder>();
async function readMessenger(p: JParcel): Promise<JMessenger | null> {
  const binder: JObj | null = await vcall(p, "readStrongBinder", "()Landroid/os/IBinder;");
  if (!binder) return null;
  const messenger = new JMessenger(); messenger.binder = binder; return messenger;
}
rt.register({ name: "android/os/Messenger", ctor: JMessenger, ifaces: ["android/os/Parcelable"],
  statics: { get CREATOR() { return parcelCreator("android/os/Messenger", readMessenger); } }, methods: {
    "<init>(Landroid/os/Handler;)V": function (this: JMessenger, h: JHandler) {
      let binder = handlers.get(h);
      if (!binder) { rt.link("webdroid/MessengerBinder"); binder = new JMessengerBinder(); binder.handler = h; binder.descriptor = "android.os.IMessenger"; handlers.set(h, binder); }
      this.binder = binder;
    },
    "<init>(Landroid/os/IBinder;)V": function (this: JMessenger, binder: JObj) { this.binder = binder; },
    "send(Landroid/os/Message;)V": driven(function* (this: JMessenger, m: JMessage): Gen {
      if (this.binder instanceof JMessengerBinder) { m.sendingUid = callingIdentity().uid; this.binder.handler.send(m, 0); return; }
      const parcel = new JParcel();
      yield vcall(parcel, "writeInterfaceToken", "(Ljava/lang/String;)V", "android.os.IMessenger");
      yield vcall(parcel, "writeInt", "(I)V", 1);
      yield vcall(m, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
      yield vcall(this.binder, "transact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z", 1, parcel, null, 1);
    }),
    "getBinder()Landroid/os/IBinder;": function (this: JMessenger) { return this.binder; },
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JMessenger, p: JParcel): Gen { yield vcall(p, "writeStrongBinder", "(Landroid/os/IBinder;)V", this.binder); }),
    "static readMessengerOrNullFromParcel(Landroid/os/Parcel;)Landroid/os/Messenger;": readMessenger,
    "static writeMessengerOrNullToParcel(Landroid/os/Messenger;Landroid/os/Parcel;)V": driven(function* (m: JMessenger | null, p: JParcel): Gen { yield vcall(p, "writeStrongBinder", "(Landroid/os/IBinder;)V", m?.binder ?? null); }),
    "equals(Ljava/lang/Object;)Z": function (this: JMessenger, other: unknown) { return other instanceof JMessenger && this.binder === other.binder ? 1 : 0; },
    "hashCode()I": function (this: JMessenger) { return vcall(this.binder, "hashCode", "()I"); },
} });
