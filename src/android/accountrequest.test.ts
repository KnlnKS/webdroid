import { expect, test } from "bun:test";
import "../natives";
import { accountOptions } from "./accountrequest";
import { PROCESS_PID, PROCESS_UID } from "./os";
import { appHost } from "./apphost";
import { newObj, vcall } from "../jvm/natives/jlang";
import { AUTH_RESPONSE } from "./authenticator";
import { exportBinder, exportParcel, importParcel, receiveTransaction } from "./binder";
import { rt } from "../jvm/runtime";

test("account options copy caller data and replace caller-supplied identity", async () => {
  const options = await newObj("android/os/Bundle");
  options.map.set("androidPackageName", "spoofed"); options.map.set("callerUid", -1); options.map.set("callerPid", -1); options.map.set("custom", "fixture");
  const copy = accountOptions(options);
  expect(copy.map.get("androidPackageName")).toBe(appHost?.pkg ?? "");
  expect(copy.map.get("callerUid")).toBe(PROCESS_UID); expect(copy.map.get("callerPid")).toBe(PROCESS_PID);
  expect(copy.map.get("custom")).toBe("fixture"); expect(options.map.get("callerUid")).toBe(-1);
});

test("account response Binder rejects a different authenticator UID", async () => {
  const response = await newObj("webdroid/AccountResponse"), p = await newObj("android/os/Parcel");
  response.uid = 28001; let continued = 0;
  response.receive = async () => { continued++; };
  await vcall(p, "writeInterfaceToken", "(Ljava/lang/String;)V", AUTH_RESPONSE);
  const request = { handle: exportBinder(response)!, code: 2, flags: 0, data: exportParcel(p) };
  const denied = await receiveTransaction(request, { pid: 38002, uid: 28002 });
  try { await vcall(importParcel(denied.data), "readException", "()V"); throw new Error("reply identity accepted"); }
  catch (error) { expect(rt.iof(error, "java/lang/SecurityException")).toBe(1); }
  expect(continued).toBe(0);
  await receiveTransaction(request, { pid: 38001, uid: 28001 }); expect(continued).toBe(1);
});
