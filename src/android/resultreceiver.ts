import { JObj, rt } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { JBinder } from "./binder";
import { JParcel, parcelCreator } from "./parcel";
import { JFnRunnable, type JHandler, type JBundle } from "./os";

export class JResultReceiver extends JObj { handler: JHandler | null = null; binder: JObj | null = null; remote = false; }
class JResultBinder extends JBinder { receiver!: JResultReceiver; }
rt.register({ name: "webdroid/ResultReceiverBinder", ctor: JResultBinder, sup: "android/os/Binder", methods: {
  "onTransact(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z": async function (this: JResultBinder, code: number, data: JParcel, reply: JParcel | null) {
    if (code === 0x5f4e5446 && reply) { await vcall(reply, "writeString", "(Ljava/lang/String;)V", "android.os.IResultReceiver"); return 1; }
    if (code !== 1) return 0;
    await vcall(data, "enforceInterface", "(Ljava/lang/String;)V", "android.os.IResultReceiver");
    const result = await vcall(data, "readInt", "()I");
    const bundle = await vcall(data, "readInt", "()I") ? await vcall(data, "readBundle", "()Landroid/os/Bundle;") : null;
    await vcall(this.receiver, "send", "(ILandroid/os/Bundle;)V", result, bundle); return 1;
  },
} });
async function readReceiver(parcel: JParcel): Promise<JResultReceiver> {
  const receiver = new JResultReceiver(); receiver.remote = true;
  receiver.binder = await vcall(parcel, "readStrongBinder", "()Landroid/os/IBinder;"); return receiver;
}
rt.register({ name: "android/os/ResultReceiver", ctor: JResultReceiver, ifaces: ["android/os/Parcelable"],
  statics: { get CREATOR() { return parcelCreator("android/os/ResultReceiver", readReceiver); } }, methods: {
    "<init>(Landroid/os/Handler;)V": function (this: JResultReceiver, handler: JHandler | null) { this.handler = handler; },
    "send(ILandroid/os/Bundle;)V": async function (this: JResultReceiver, code: number, data: JBundle | null) {
      if (this.remote) {
        if (!this.binder) return;
        const parcel = new JParcel();
        await vcall(parcel, "writeInterfaceToken", "(Ljava/lang/String;)V", "android.os.IResultReceiver");
        await vcall(parcel, "writeInt", "(I)V", code); await vcall(parcel, "writeInt", "(I)V", data ? 1 : 0);
        if (data) await vcall(parcel, "writeBundle", "(Landroid/os/Bundle;)V", data);
        try { await vcall(this.binder, "transact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z", 1, parcel, null, 1); }
        catch (error) { if (!rt.iof(error, "android/os/RemoteException")) throw error; }
        return;
      }
      const deliver = () => vcall(this, "onReceiveResult", "(ILandroid/os/Bundle;)V", code, data);
      if (!this.handler) { await deliver(); return; }
      const runnable = new JFnRunnable(); runnable.fn = deliver; this.handler.post(runnable, 0);
    },
    "onReceiveResult(ILandroid/os/Bundle;)V": () => {},
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": async function (this: JResultReceiver, parcel: JParcel) {
      if (!this.binder) {
        rt.link("webdroid/ResultReceiverBinder");
        const binder = new JResultBinder(); binder.receiver = this; binder.descriptor = "android.os.IResultReceiver"; this.binder = binder;
      }
      await vcall(parcel, "writeStrongBinder", "(Landroid/os/IBinder;)V", this.binder);
    },
} });
