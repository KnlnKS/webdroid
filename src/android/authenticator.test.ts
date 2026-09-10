import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { mangleMethod } from "../jvm/abi";
import { AUTHENTICATOR, AUTH_RESPONSE } from "./authenticator";
import { exportBinder, exportParcel, importParcel, receiveTransaction } from "./binder";
import type { JParcel } from "./parcel";
import type { JIntent } from "./intent";

const ON_TRANSACTION = mangleMethod("onTransact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z");

test("authenticator Binder dispatch reaches the virtual feature method and enforces caller privilege", async () => {
  const auth = await newObj("android/accounts/AbstractAccountAuthenticator"), callback = await newObj("android/os/Binder");
  const received = Promise.withResolvers<unknown>();
  callback[ON_TRANSACTION] = async (code: number, p: JParcel) => {
    expect(code).toBe(1); await vcall(p, "enforceInterface", "(Ljava/lang/String;)V", AUTH_RESPONSE);
    expect(await vcall(p, "readInt", "()I")).toBe(1);
    received.resolve(await vcall(p, "readBundle", "()Landroid/os/Bundle;")); return 1;
  };
  auth[mangleMethod("hasFeatures", "(Landroid/accounts/AccountAuthenticatorResponse;Landroid/accounts/Account;[Ljava/lang/String;)Landroid/os/Bundle;")] = async (_response: unknown, account: { name: string }, features: string[]) => {
    expect(account.name).toBe("fixture"); expect(features).toEqual(["feature"]);
    const result = await newObj("android/os/Bundle"); await vcall(result, "putBoolean", "(Ljava/lang/String;Z)V", "booleanResult", 1); return result;
  };
  const p = await newObj("android/os/Parcel"), account = await newObj("android/accounts/Account", "(Ljava/lang/String;Ljava/lang/String;)V", "fixture", "test.account");
  await vcall(p, "writeInterfaceToken", "(Ljava/lang/String;)V", AUTHENTICATOR);
  await vcall(p, "writeStrongBinder", "(Landroid/os/IBinder;)V", callback);
  await vcall(p, "writeTypedObject", "(Landroid/os/Parcelable;I)V", account, 0);
  await vcall(p, "writeStringArray", "([Ljava/lang/String;)V", ["feature"]);
  const handle = exportBinder(await vcall(auth, "getIBinder", "()Landroid/os/IBinder;"))!, data = exportParcel(p);
  const denied = await receiveTransaction({ handle, code: 7, flags: 0, data }, { pid: 777, uid: 27777 });
  try { await vcall(importParcel(denied.data), "readException", "()V"); throw new Error("permission check missing"); }
  catch (error) { expect(rt.iof(error, "java/lang/SecurityException")).toBe(1); }
  await receiveTransaction({ handle, code: 7, flags: 1, data }, { pid: 0, uid: 1000 });
  expect(await vcall(await received.promise, "getBoolean", "(Ljava/lang/String;)Z", "booleanResult")).toBe(1);
});

test("authenticator activity replies retain their response callback across Intent parcels", async () => {
  const auth = await newObj("android/accounts/AbstractAccountAuthenticator"), callback = await newObj("android/os/Binder");
  const activity = Promise.withResolvers<JIntent>(), canceled = Promise.withResolvers<void>();
  callback[ON_TRANSACTION] = async (code: number, p: JParcel) => {
    await vcall(p, "enforceInterface", "(Ljava/lang/String;)V", AUTH_RESPONSE);
    if (code === 1) {
      expect(await vcall(p, "readInt", "()I")).toBe(1);
      activity.resolve((await vcall(p, "readBundle", "()Landroid/os/Bundle;")).map.get("intent"));
    } else {
      expect(code).toBe(3); expect(await vcall(p, "readInt", "()I")).toBe(4);
      expect(await vcall(p, "readString", "()Ljava/lang/String;")).toBe("canceled"); canceled.resolve();
    }
    return 1;
  };
  auth[mangleMethod("addAccount", "(Landroid/accounts/AccountAuthenticatorResponse;Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Landroid/os/Bundle;)Landroid/os/Bundle;")] = async (response: unknown) => {
    const intent = await newObj("android/content/Intent"), result = await newObj("android/os/Bundle");
    await vcall(intent, "putExtra", "(Ljava/lang/String;Landroid/os/Parcelable;)Landroid/content/Intent;", "accountAuthenticatorResponse", response);
    await vcall(result, "putParcelable", "(Ljava/lang/String;Landroid/os/Parcelable;)V", "intent", intent); return result;
  };
  const p = await newObj("android/os/Parcel");
  await vcall(p, "writeInterfaceToken", "(Ljava/lang/String;)V", AUTHENTICATOR);
  await vcall(p, "writeStrongBinder", "(Landroid/os/IBinder;)V", callback);
  for (const value of ["test.account", null]) await vcall(p, "writeString", "(Ljava/lang/String;)V", value);
  await vcall(p, "writeStringArray", "([Ljava/lang/String;)V", null); await vcall(p, "writeInt", "(I)V", 0);
  await receiveTransaction({ handle: exportBinder(await vcall(auth, "getIBinder", "()Landroid/os/IBinder;"))!, code: 1, flags: 1, data: exportParcel(p) }, { pid: 0, uid: 1000 });
  const intent = await activity.promise, wire = await newObj("android/os/Parcel");
  await vcall(wire, "writeParcelable", "(Landroid/os/Parcelable;I)V", intent, 0);
  const copy = await vcall(importParcel(exportParcel(wire)), "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
  await vcall(copy.extras.map.get("accountAuthenticatorResponse"), "onError", "(ILjava/lang/String;)V", 4, "canceled");
  await canceled.promise;
});

test("authenticator network exceptions reach the response as Android error codes", async () => {
  const auth = await newObj("android/accounts/AbstractAccountAuthenticator"), callback = await newObj("android/os/Binder");
  const received = Promise.withResolvers<number>();
  callback[ON_TRANSACTION] = async (code: number, p: JParcel) => {
    expect(code).toBe(3); await vcall(p, "enforceInterface", "(Ljava/lang/String;)V", AUTH_RESPONSE);
    received.resolve(await vcall(p, "readInt", "()I")); return 1;
  };
  auth[mangleMethod("getAuthTokenLabel", "(Ljava/lang/String;)Ljava/lang/String;")] = () => { throw rt.mkThrowable("android/accounts/NetworkErrorException", "fixture"); };
  const p = await newObj("android/os/Parcel");
  await vcall(p, "writeInterfaceToken", "(Ljava/lang/String;)V", AUTHENTICATOR);
  await vcall(p, "writeStrongBinder", "(Landroid/os/IBinder;)V", callback);
  await vcall(p, "writeString", "(Ljava/lang/String;)V", "scope");
  await receiveTransaction({ handle: exportBinder(await vcall(auth, "getIBinder", "()Landroid/os/IBinder;"))!, code: 4, flags: 1, data: exportParcel(p) }, { pid: 0, uid: 1000 });
  expect(await received.promise).toBe(3);
});
