// System services and binder-ish plumbing, and FileObserver's inotify.

import { awaited, rt, JObj, noops, driven, type Gen } from "../jvm/runtime.ts";
import { newObj, vcall } from "../jvm/natives/jentry.ts";
import { logUncaught } from "../jvm/natives/jthrowable.ts";
import { utf8 } from "../jvm/abi.ts";
import { javaReadFd } from "../native/fd.ts";
import { javaInotifyAddWatch, javaInotifyInit, javaInotifyRmWatch } from "../native/inotify.ts";
import { newArrayList } from "../jvm/natives/jcoll.ts";
import { hostStub, newStub } from "./binder.ts";

// IRestrictionsManager, under AOSP's RestrictionsManager: no device or profile owner manages this
// device, so there are no restrictions and no provider to ask
rt.register({ name: "webdroid/RestrictionsManagerService", ctor: class extends JObj {}, sup: "android/content/IRestrictionsManager$Stub", methods: {
  "getApplicationRestrictions(Ljava/lang/String;)Landroid/os/Bundle;": () => newObj("android/os/Bundle"),
  "getApplicationRestrictionsPerAdminForUser(ILjava/lang/String;)Ljava/util/List;": () => newArrayList(),
  "hasRestrictionsProvider()Z": () => 0,
  "createLocalApprovalIntent()Landroid/content/Intent;": () => null,
  "requestPermission(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Landroid/os/PersistableBundle;)V": () => {
    throw rt.mkThrowable("java/lang/IllegalStateException", "Cannot request permission without a restrictions provider registered");
  },
} });
hostStub("restrictions", "webdroid/RestrictionsManagerService");

// INsdManager, under AOSP's NsdManager: the browser cannot join the multicast groups DNS-SD needs,
// so NsdService is present but every discovery, registration and resolution fails with
// FAILURE_INTERNAL_ERROR on the client's callback instead of inventing services.
const NSD = "android/net/connectivity/android/net/nsd/", NSD_INFO = "Landroid/net/nsd/NsdServiceInfo;", FAILURE_INTERNAL_ERROR = 0;
class JNsdConnector extends JObj { callback: JObj | null = null; }
const nsdFailure = (callback: string) => function (this: JNsdConnector, key: number) {
  return vcall(this.callback, callback, "(II)V", key, FAILURE_INTERNAL_ERROR);
};
rt.register({ name: "webdroid/NsdServiceConnector", ctor: JNsdConnector, sup: NSD + "INsdServiceConnector$Stub", methods: {
  "discoverServices(ILandroid/net/nsd/DiscoveryRequest;)V": nsdFailure("onDiscoverServicesFailed"),
  [`registerService(IL${NSD}AdvertisingRequest;)V`]: nsdFailure("onRegisterServiceFailed"),
  [`resolveService(I${NSD_INFO})V`]: nsdFailure("onResolveServiceFailed"),
  [`registerServiceInfoCallback(I${NSD_INFO})V`]: nsdFailure("onServiceInfoCallbackRegistrationFailed"),
  ...noops("startDaemon()V"),
} });
rt.register({ name: "webdroid/NsdService", ctor: class extends JObj {}, sup: "android/net/nsd/INsdManager$Stub", methods: {
  [`connect(L${NSD}INsdManagerCallback;Z)L${NSD}INsdServiceConnector;`]: async (callback: JObj) => {
    const connector = await newStub("webdroid/NsdServiceConnector") as JNsdConnector;
    connector.callback = callback;
    return connector;
  },
} });
hostStub("servicediscovery", "webdroid/NsdService");

// IDropBoxManagerService, under AOSP's DropBoxManager: tags are enabled, as by default on a device,
// and entries are accepted; reading them back needs READ_LOGS, which no app holds, so there are none
rt.register({ name: "webdroid/DropBoxManagerService", ctor: class extends JObj {}, sup: "com/android/internal/os/IDropBoxManagerService$Stub", methods: {
  "isTagEnabled(Ljava/lang/String;)Z": () => 1,
  ...noops("addData(Ljava/lang/String;[BI)V", "addFile(Ljava/lang/String;Landroid/os/ParcelFileDescriptor;I)V"),
  "getNextEntryWithAttribution(Ljava/lang/String;JLjava/lang/String;Ljava/lang/String;)Landroid/os/DropBoxManager$Entry;": () => null,
} });
hostStub("dropbox", "webdroid/DropBoxManagerService");

// FileObserver's inotify instance, over the descriptor table's, which the VFS reports its changes to
rt.registerJnis("android/os/FileObserver$ObserverThread", {
  "init()I": () => javaInotifyInit(),
  // android_os_FileObserver.cpp's loop: each event to onEvent(wd, mask, name) until a read fails
  "observe(I)V": driven(function* (this: JObj, fd: number): Gen {
    const buf = new Uint8Array(512), view = new DataView(buf.buffer);
    for (let n: number; (n = yield* awaited(javaReadFd(fd, buf))) >= 16;) {
      for (let at = 0; at + 16 <= n;) {
        const len = view.getUint32(at + 12, true), name = buf.subarray(at + 16, at + 16 + len);
        const path = len ? utf8.dec.decode(name.subarray(0, name.indexOf(0) < 0 ? len : name.indexOf(0))) : null;
        try { yield vcall(this, "onEvent", "(IILjava/lang/String;)V", view.getInt32(at, true), view.getInt32(at + 4, true), path); }
        catch (error) { logUncaught(error); }
        at += 16 + len;
      }
    }
  }),
  "startWatching(I[Ljava/lang/String;I[I)V": (fd: number, paths: string[], mask: number, wfds: Int32Array) => {
    paths.forEach((path, i) => { wfds[i] = fd < 0 ? -1 : Math.max(-1, javaInotifyAddWatch(fd, path, mask)); });
  },
  "stopWatching(I[I)V": (fd: number, wfds: Int32Array) => { for (const wd of wfds) if (wd >= 0) javaInotifyRmWatch(fd, wd); },
});
