import { JObj, rt } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { mkFile, vfs } from "../jvm/natives/jio";
import { appHost } from "./apphost";
import { transactionCaller } from "./binder";
import { JAttributionSource } from "./context";
import { mkPfd, PROCESS_PID } from "./os";
import { packages } from "./packages";

function callingPackage(): string | null {
  const caller = transactionCaller();
  if (caller) for (const record of packages.values()) if (record.uid === caller.uid) return record.pkg;
  return null;
}

let nextPipeId = 1;
rt.register({
  name: "android/content/ContentProvider", ctor: class extends JObj { $ctx: unknown = null; },
  methods: {
    "openPipeHelper(Landroid/net/Uri;Ljava/lang/String;Landroid/os/Bundle;Ljava/lang/Object;Landroid/content/ContentProvider$PipeDataWriter;)Landroid/os/ParcelFileDescriptor;":
      async (uri: unknown, mime: string, opts: unknown, args: unknown, writer: unknown) => {
        if (!writer) rt.npe();
        const path = `/data/local/tmp/webdroid-pipe-${PROCESS_PID}-${nextPipeId++}`;
        const output = await vcall(rt.link("android/os/ParcelFileDescriptor").ctor, "open", "(Ljava/io/File;I)Landroid/os/ParcelFileDescriptor;", mkFile(path), 0x2c000000);
        try {
          await vcall(writer, "writeDataToPipe", "(Landroid/os/ParcelFileDescriptor;Landroid/net/Uri;Ljava/lang/String;Landroid/os/Bundle;Ljava/lang/Object;)V", output, uri, mime, opts, args);
          await vcall(output, "close", "()V");
          const bytes = vfs.read(path);
          if (!bytes) throw rt.mkThrowable("java/io/IOException", "Pipe output unavailable");
          return mkPfd(bytes, null);
        } finally {
          await vcall(output, "close", "()V");
          vfs.delete(path);
        }
      },
    "getCallingPackage()Ljava/lang/String;": () => callingPackage(),
    "getCallingAttributionSource()Landroid/content/AttributionSource;": () => {
      const caller = transactionCaller();
      if (!caller) return null;
      rt.link("android/content/AttributionSource");
      return Object.assign(new JAttributionSource(), { uid: caller.uid, pid: caller.pid, pkg: callingPackage() });
    },
    "<init>()V": function () {},
    "onCreate()Z": () => 1,
    "getContext()Landroid/content/Context;": function (this: { $ctx: unknown }) { return this.$ctx ?? appHost?.application ?? null; },
    "attachInfo(Landroid/content/Context;Landroid/content/pm/ProviderInfo;)V": async function (this: { $ctx: unknown }, c: unknown) {
      if (this.$ctx) return;
      this.$ctx = c;
      await vcall(this, "onCreate", "()Z");
    },
  },
});
rt.markers("android/content/ContentProvider$PipeDataWriter");
