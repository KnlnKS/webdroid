import { afterAll, expect, test } from "bun:test";
import "../natives";
import { newObj, vcall } from "../jvm/natives/jlang";
import { rt } from "../jvm/runtime";
import { vfs } from "../jvm/natives/jio";
import { getPM, installPackageArchive } from "./pm";
import { parsePackageArchive } from "./packagearchive";
import { JContext } from "./context";
import { JIntent } from "./intent";
import { onMain } from "./mainloop";
import { mangleMethod } from "../jvm/abi";
import type { JBundle } from "./os";

const path = "/data/local/tmp/package-test.apk";
const bytes = new Uint8Array(await Bun.file(new URL("../../apks/mihon-v0.20.4.apk", import.meta.url)).arrayBuffer());
vfs.write(path, bytes);
afterAll(() => { vfs.files.delete(path); vfs.files.delete("/data/app/app.mihon/base.apk"); });

test("archive queries resolve their own metadata and real signing certificates without installing classes", async () => {
  const before = rt.dexes.length;
  const archive = await parsePackageArchive(bytes);
  expect(archive.pkg).toBe("app.mihon");
  expect(archive.certificates[0]?.[0]).toBe(0x30);
  const info = await vcall(getPM(), "getPackageArchiveInfo", "(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;", path, 0x8000080);
  expect(info.packageName).toBe("app.mihon");
  expect(info.versionName).toBe("0.20.4");
  expect(await vcall(getPM(), "getApplicationLabel", "(Landroid/content/pm/ApplicationInfo;)Ljava/lang/CharSequence;", info.applicationInfo)).toBe("Mihon");
  const signers = await vcall(info.signingInfo, "getApkContentsSigners", "()[Landroid/content/pm/Signature;");
  expect(new Uint8Array(await vcall(signers[0], "toByteArray", "()[B"))).toEqual(archive.certificates[0]);
  const without = await vcall(getPM(), "getPackageArchiveInfo", "(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;", path, 0);
  expect(without.applicationInfo.metaData).toBeNull();
  expect(without.signatures).toBeNull();
  expect(without.signingInfo).toBeNull();
  expect(rt.dexes.length).toBe(before);
  expect(await vcall(getPM(), "getPackageArchiveInfo", "(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;", "/missing.apk", 0)).toBeNull();
  await expect(installPackageArchive(bytes, "different.package")).rejects.toThrow("differs");
  expect(vfs.exists("/data/app/app.mihon/base.apk")).toBe(false);
});

test("installer commits written APK bytes and delivers status through a mutable broadcast intent", async () => {
  const context = new JContext(), received: JBundle[] = [];
  const receiver = await newObj("android/content/BroadcastReceiver");
  receiver[mangleMethod("onReceive", "(Landroid/content/Context;Landroid/content/Intent;)V")] = (_context: JContext, intent: JIntent) => { received.push(intent.extras); };
  const filter = await newObj("android/content/IntentFilter", "(Ljava/lang/String;)V", "test.INSTALL");
  await vcall(context, "registerReceiver", "(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;)Landroid/content/Intent;", receiver, filter);
  const intent = new JIntent(); intent.action = "test.INSTALL"; intent.extras.map.set("original", 7);
  const pending = await vcall(rt.link("android/app/PendingIntent").ctor, "getBroadcast", "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;", context, 1, intent, 0x2000000);
  const sender = await vcall(pending, "getIntentSender", "()Landroid/content/IntentSender;");
  const installer = await vcall(getPM(), "getPackageInstaller", "()Landroid/content/pm/PackageInstaller;");
  const params = await newObj("android/content/pm/PackageInstaller$SessionParams", "(I)V", 1);
  const id = await vcall(installer, "createSession", "(Landroid/content/pm/PackageInstaller$SessionParams;)I", params);
  const session = await vcall(installer, "openSession", "(I)Landroid/content/pm/PackageInstaller$Session;", id);
  const output = await vcall(session, "openWrite", "(Ljava/lang/String;JJ)Ljava/io/OutputStream;", "base.apk", 0n, BigInt(bytes.length));
  await vcall(output, "write", "([BII)V", new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length), 0, bytes.length);
  await vcall(session, "fsync", "(Ljava/io/OutputStream;)V", output);
  await vcall(output, "close", "()V");
  await vcall(session, "commit", "(Landroid/content/IntentSender;)V", sender);
  for (let i = 0; i < 100 && !received.length; i++) { await Bun.sleep(5); await onMain(() => {}); }
  expect(received[0]?.map.get("android.content.pm.extra.STATUS")).toBe(0);
  expect(received[0]?.map.get("android.content.pm.extra.SESSION_ID")).toBe(id);
  expect(received[0]?.map.get("original")).toBe(7);
  expect(vfs.read("/data/app/app.mihon/base.apk")).toEqual(bytes);
  const installed = await vcall(getPM(), "getInstalledPackages", "(I)Ljava/util/List;", 0x8000000);
  expect(installed.a.some((info: { packageName: string }) => info.packageName === "app.mihon")).toBe(true);
  await vcall(context, "unregisterReceiver", "(Landroid/content/BroadcastReceiver;)V", receiver);
});

test("failed install sessions report failure and cannot be committed twice", async () => {
  const context = new JContext(), received: JIntent[] = [];
  const receiver = await newObj("android/content/BroadcastReceiver");
  receiver[mangleMethod("onReceive", "(Landroid/content/Context;Landroid/content/Intent;)V")] = (_context: JContext, intent: JIntent) => { received.push(intent); };
  const filter = await newObj("android/content/IntentFilter", "(Ljava/lang/String;)V", "test.FAILURE");
  await vcall(context, "registerReceiver", "(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;)Landroid/content/Intent;", receiver, filter);
  const intent = new JIntent(); intent.action = "test.FAILURE";
  const pending = await vcall(rt.link("android/app/PendingIntent").ctor, "getBroadcast", "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;", context, 2, intent, 0x2000000);
  const sender = await vcall(pending, "getIntentSender", "()Landroid/content/IntentSender;");
  const installer = await vcall(getPM(), "getPackageInstaller", "()Landroid/content/pm/PackageInstaller;");
  const params = await newObj("android/content/pm/PackageInstaller$SessionParams", "(I)V", 1);
  const id = await vcall(installer, "createSession", "(Landroid/content/pm/PackageInstaller$SessionParams;)I", params);
  const session = await vcall(installer, "openSession", "(I)Landroid/content/pm/PackageInstaller$Session;", id);
  await vcall(session, "commit", "(Landroid/content/IntentSender;)V", sender);
  for (let i = 0; i < 100 && !received.length; i++) { await Bun.sleep(5); await onMain(() => {}); }
  expect(received[0]?.extras.map.get("android.content.pm.extra.STATUS")).toBe(4);
  expect(received[0]?.extras.map.get("android.content.pm.extra.PACKAGE_NAME")).toBeUndefined();
  await expect(vcall(session, "commit", "(Landroid/content/IntentSender;)V", sender)).rejects.toBeDefined();
  await vcall(context, "unregisterReceiver", "(Landroid/content/BroadcastReceiver;)V", receiver);
});
