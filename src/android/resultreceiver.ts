import { JObj, rt, driven, type Gen } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { JBinder } from "./binder";
import { JParcel, parcelCreator } from "./parcel";
import { JFnRunnable, type JHandler, type JBundle } from "./os";

class JResultReceiver extends JObj { handler: JHandler | null = null; binder: JObj | null = null; remote = false; }
class JResultBinder extends JBinder { receiver!: JResultReceiver; }
rt.register({ name: "webdroid/ResultReceiverBinder", ctor: JResultBinder, sup: "android/os/Binder", methods: {
  "onTransact(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z": driven(function* (this: JResultBinder, code: number, data: JParcel, reply: JParcel | null): Gen {
    if (code === 0x5f4e5446 && reply) { yield vcall(reply, "writeString", "(Ljava/lang/String;)V", "android.os.IResultReceiver"); return 1; }
    if (code !== 1) return 0;
    yield vcall(data, "enforceInterface", "(Ljava/lang/String;)V", "android.os.IResultReceiver");
    const result = yield vcall(data, "readInt", "()I");
    const bundle = (yield vcall(data, "readInt", "()I")) ? yield vcall(data, "readBundle", "()Landroid/os/Bundle;") : null;
    yield vcall(this.receiver, "send", "(ILandroid/os/Bundle;)V", result, bundle); return 1;
  }),
} });
async function readReceiver(parcel: JParcel): Promise<JResultReceiver> {
  const receiver = new JResultReceiver(); receiver.remote = true;
  receiver.binder = await vcall(parcel, "readStrongBinder", "()Landroid/os/IBinder;"); return receiver;
}
rt.register({ name: "android/os/ResultReceiver", ctor: JResultReceiver, ifaces: ["android/os/Parcelable"],
  statics: { get CREATOR() { return parcelCreator("android/os/ResultReceiver", readReceiver); } }, methods: {
    "<init>(Landroid/os/Handler;)V": function (this: JResultReceiver, handler: JHandler | null) { this.handler = handler; },
    "send(ILandroid/os/Bundle;)V": driven(function* (this: JResultReceiver, code: number, data: JBundle | null): Gen {
      if (this.remote) {
        if (!this.binder) return;
        const parcel = new JParcel();
        yield vcall(parcel, "writeInterfaceToken", "(Ljava/lang/String;)V", "android.os.IResultReceiver");
        yield vcall(parcel, "writeInt", "(I)V", code); yield vcall(parcel, "writeInt", "(I)V", data ? 1 : 0);
        if (data) yield vcall(parcel, "writeBundle", "(Landroid/os/Bundle;)V", data);
        try { yield vcall(this.binder, "transact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z", 1, parcel, null, 1); }
        catch (error) { if (!rt.iof(error, "android/os/RemoteException")) throw error; }
        return;
      }
      const deliver = () => vcall(this, "onReceiveResult", "(ILandroid/os/Bundle;)V", code, data);
      if (!this.handler) { yield deliver(); return; }
      const runnable = new JFnRunnable(); runnable.fn = deliver; this.handler.post(runnable, 0);
    }),
    "onReceiveResult(ILandroid/os/Bundle;)V": () => {},
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JResultReceiver, parcel: JParcel): Gen {
      if (!this.binder) {
        rt.link("webdroid/ResultReceiverBinder");
        const binder = new JResultBinder(); binder.receiver = this; binder.descriptor = "android.os.IResultReceiver"; this.binder = binder;
      }
      yield vcall(parcel, "writeStrongBinder", "(Landroid/os/IBinder;)V", this.binder);
    }),
} });
