import { rt, driven, type Gen } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { JBinder, binderTransport, callingIdentity, exportParcel, type ParcelData } from "./binder";
import { JParcel, readInt, readString, writeInt, writeString } from "./parcel";
import { JBundle, bundleBox, bundlePrimitive, PROCESS_PID, PROCESS_UID, reportUncaught, type JHandler } from "./os";
import { AUTHENTICATOR, AUTH_RESPONSE, authenticators, authenticatorMethods } from "./authenticator";
import { accountFuture, type JAccountFuture } from "./accountfuture";
import { appHost } from "./apphost";
import { packages } from "./packages";
import { onMain } from "./mainloop";

export const accountTransport: {
  request: (type: string, code: number, key: string, data: ParcelData) => Promise<number>;
  finish: (key: string) => Promise<void>;
} = {
  request: async () => { throw rt.mkThrowable("android/os/RemoteException", "Account service unavailable"); },
  finish: async () => {},
};
export function accountOptions(options: JBundle | null): JBundle {
  rt.link("android/os/Bundle"); const copy = new JBundle(); copy.map = new Map(options?.map);
  copy.map.set("androidPackageName", appHost?.pkg ?? "");
  copy.map.set("callerUid", bundleBox(PROCESS_UID, "I")); copy.map.set("callerPid", bundleBox(PROCESS_PID, "I"));
  return copy;
}
class JAccountResponse extends JBinder { receive: ((code: number, p: JParcel) => Promise<void>) | null = null; uid = -1; }
rt.register({ name: "webdroid/AccountResponse", ctor: JAccountResponse, sup: "android/os/Binder", methods: {
  "onTransact(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z": driven(function* (this: JAccountResponse, code: number, p: JParcel, reply: JParcel | null): Gen {
    if (code === 0x5f4e5446 && reply) { writeString(reply, AUTH_RESPONSE); return 1; }
    if (code < 1 || code > 3) return 0;
    const caller = callingIdentity();
    if (caller.uid !== this.uid && caller.uid !== 1000) throw rt.mkThrowable("java/lang/SecurityException", "Reply does not belong to this authenticator");
    (yield vcall(p, "enforceInterface", "(Ljava/lang/String;)V", AUTH_RESPONSE));
    (yield this.receive?.(code, p)); return 1;
  }),
} });
let nextRequest = 1;
export function requestAccount(request: {
  type: string; method: typeof authenticatorMethods[number][0]; args: unknown[];
  activity?: unknown; callback?: unknown; handler?: JHandler | null; convert?: (result: JBundle) => unknown;
}): JAccountFuture {
  const future = accountFuture(request.callback, request.handler ?? null), key = PROCESS_PID + ":account:" + nextRequest++;
  const owner = authenticators().find(a => a.type === request.type), code = authenticatorMethods.findIndex(m => m[0] === request.method) + 1;
  const uid = owner && packages.get(owner.packageName)?.uid;
  if (uid === undefined) { future.finish({ kind: "error", error: rt.mkThrowable("android/accounts/AuthenticatorException", "No authenticator for account type") }); return future; }
  rt.link("webdroid/AccountResponse"); rt.link("android/os/Parcel");
  const response = new JAccountResponse(); response.uid = uid; response.descriptor = AUTH_RESPONSE;
  let inflight = false, retry = false, stop = () => {};
  const finish = () => { stop(); stop = () => {}; void accountTransport.finish(key).catch(reportUncaught); };
  future.cleanup = () => { response.receive = null; if (!inflight) finish(); };
  const error = (code: number, message: string | null) => {
    if (code === 4 || code === 100 || code === 101) future.finish({ kind: "canceled" });
    else future.finish({ kind: "error", error: rt.mkThrowable(code === 3 ? "java/io/IOException" : code === 7 ? "java/lang/IllegalArgumentException" : "android/accounts/AuthenticatorException", message) });
  };
  const send = async () => {
    if (!future.pending) return;
    if (inflight) { retry = true; return; }
    inflight = true; stop(); stop = () => {};
    try {
      const p = new JParcel(); await vcall(p, "writeInterfaceToken", "(Ljava/lang/String;)V", AUTHENTICATOR);
      await vcall(p, "writeStrongBinder", "(Landroid/os/IBinder;)V", response);
      const types = authenticatorMethods[code - 1][1];
      for (let i = 0; i < types.length; i++) {
        const value = request.args[i], type = types[i];
        if (type === "Ljava/lang/String;") writeString(p, typeof value === "string" ? value : null);
        else if (type === "[Ljava/lang/String;") await vcall(p, "writeStringArray", "([Ljava/lang/String;)V", value);
        else if (type === "Landroid/os/Bundle;") { writeInt(p, +!!value); if (value) await vcall(p, "writeBundle", "(Landroid/os/Bundle;)V", value); }
        else await vcall(p, "writeTypedObject", "(Landroid/os/Parcelable;I)V", value, 0);
      }
      if (!future.pending) return;
      const pid = await accountTransport.request(request.type, code, key, exportParcel(p));
      if (future.pending) {
        if (!binderTransport.alive(pid)) error(1, "Authenticator process died");
        else stop = binderTransport.watch(pid, () => error(1, "Authenticator process died"));
      }
    } catch { error(1, "Authenticator request failed"); }
    finally {
      inflight = false;
      if (!future.pending) finish();
      else if (retry) { retry = false; void send(); }
    }
  };
  response.receive = async (code, p) => {
    if (!future.pending || code === 2) return;
    if (code === 3) { error(readInt(p), readString(p)); return; }
    const result: JBundle | null = readInt(p) ? await vcall(p, "readBundle", "()Landroid/os/Bundle;") : null;
    if (!result) { error(5, "Null authenticator response"); return; }
    const failure = Number(bundlePrimitive(result.map.get("errorCode"), "I", 0));
    const message = result.map.get("errorMessage");
    if (failure) { error(failure, typeof message === "string" ? message : null); return; }
    const intent = result.map.get("intent");
    try {
      if (intent && request.activity) await onMain(() => vcall(request.activity, "startActivity", "(Landroid/content/Intent;)V", intent));
      else if (bundlePrimitive(result.map.get("retry"), "Z", 0)) await send();
      else future.finish({ kind: "result", value: request.convert ? request.convert(result) : result });
    } catch { error(5, "Invalid authenticator response"); }
  };
  void send(); return future;
}
