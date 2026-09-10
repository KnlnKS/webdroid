import { JObj, rt, maySuspend } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { jarray } from "../jvm/abi";
import { installPackageArchive } from "./pm";
import { JIntent } from "./intent";
import { sendBroadcast } from "./broadcast";
import { sendIntent } from "./pendingintent";
import { appHost } from "./apphost";
import { reportUncaught } from "./os";

class JSessionParams extends JObj { mode = 1; size = -1n; packageName: string | null = null; requireUserAction = 0; }
class JSession extends JObj {
  id = 0;
  params = new JSessionParams();
  entries = new Map<string, JObj>();
  sealed = false;
}
const sessions = new Map<number, JSession>();
let nextSession = 1;
function session(id: number): JSession {
  const value = sessions.get(id);
  if (!value) throw rt.mkThrowable("java/lang/IllegalArgumentException", `Unknown install session ${id}`);
  return value;
}
rt.register({ name: "android/content/pm/PackageInstaller$SessionParams", ctor: JSessionParams,
  statics: { MODE_FULL_INSTALL: 1, MODE_INHERIT_EXISTING: 2, USER_ACTION_UNSPECIFIED: 0, USER_ACTION_REQUIRED: 1, USER_ACTION_NOT_REQUIRED: 2 },
  methods: {
    "<init>(I)V": function (this: JSessionParams, mode: number) { this.mode = mode; },
    "setSize(J)V": function (this: JSessionParams, size: bigint) { this.size = size; },
    "setAppPackageName(Ljava/lang/String;)V": function (this: JSessionParams, name: string) { this.packageName = name; },
    "setRequireUserAction(I)V": function (this: JSessionParams, action: number) { this.requireUserAction = action; },
  },
});
rt.register({ name: "android/content/pm/PackageInstaller$Session", ctor: JSession, ifaces: ["java/io/Closeable"],
  methods: {
    "openWrite(Ljava/lang/String;JJ)Ljava/io/OutputStream;": async function (this: JSession, name: string, offset: bigint, _length: bigint) {
      if (this.sealed) throw rt.mkThrowable("java/lang/SecurityException", "Session is sealed");
      if (!name || name.includes("/") || offset !== 0n) throw rt.mkThrowable("java/io/IOException", "Invalid session entry or unsupported resume offset");
      const stream = await newObj("java/io/ByteArrayOutputStream"); this.entries.set(name, stream); return stream;
    },
    "getNames()[Ljava/lang/String;": function (this: JSession) { return jarray([...this.entries.keys()], "Ljava/lang/String;"); },
    "fsync(Ljava/io/OutputStream;)V": function (this: JSession, stream: JObj) {
      if (![...this.entries.values()].includes(stream)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Stream does not belong to session");
    },
    "close()V": () => {},
    "abandon()V": function (this: JSession) { sessions.delete(this.id); this.sealed = true; this.entries.clear(); },
    "commit(Landroid/content/IntentSender;)V": maySuspend(function (this: JSession, sender: Parameters<typeof sendIntent>[0]) {
      if (this.sealed) throw rt.mkThrowable("java/lang/SecurityException", "Session is sealed");
      this.sealed = true;
      const finish = async () => {
        const result = new JIntent(); result.extras.map.set("android.content.pm.extra.SESSION_ID", this.id);
        try {
          if (this.params.mode !== 1 || this.entries.size !== 1) throw new Error("Install requires one base APK");
          const stream = this.entries.values().next().value;
          const data: Int8Array = await vcall(stream, "toByteArray", "()[B");
          const pkg = await installPackageArchive(new Uint8Array(data.buffer, data.byteOffset, data.length), this.params.packageName);
          const added = new JIntent(); added.action = "android.intent.action.PACKAGE_ADDED"; added.dataUri = `package:${pkg}`;
          sendBroadcast(appHost?.application ?? await newObj("android/content/Context"), added);
          result.extras.map.set("android.content.pm.extra.PACKAGE_NAME", pkg);
          result.extras.map.set("android.content.pm.extra.STATUS", 0);
        } catch (error) {
          result.extras.map.set("android.content.pm.extra.STATUS", 4);
          result.extras.map.set("android.content.pm.extra.STATUS_MESSAGE", error instanceof Error ? error.message : String(error));
        }
        sessions.delete(this.id); this.entries.clear();
        await sendIntent(sender, result);
      };
      void finish().catch(reportUncaught);
    }),
  },
});
class JPackageInstaller extends JObj {}
const installer = new JPackageInstaller();
export const getPackageInstaller = () => { rt.link("android/content/pm/PackageInstaller"); return installer; };
rt.register({ name: "android/content/pm/PackageInstaller", ctor: JPackageInstaller,
  statics: { STATUS_PENDING_USER_ACTION: -1, STATUS_SUCCESS: 0, STATUS_FAILURE: 1, STATUS_FAILURE_INVALID: 4,
    EXTRA_STATUS: "android.content.pm.extra.STATUS", EXTRA_STATUS_MESSAGE: "android.content.pm.extra.STATUS_MESSAGE", EXTRA_SESSION_ID: "android.content.pm.extra.SESSION_ID", EXTRA_PACKAGE_NAME: "android.content.pm.extra.PACKAGE_NAME" },
  methods: {
    "createSession(Landroid/content/pm/PackageInstaller$SessionParams;)I": (params: JSessionParams) => {
      rt.link("android/content/pm/PackageInstaller$Session");
      const value = new JSession(); value.id = nextSession++; value.params = Object.assign(new JSessionParams(), params); sessions.set(value.id, value); return value.id;
    },
    "openSession(I)Landroid/content/pm/PackageInstaller$Session;": session,
    "abandonSession(I)V": (id: number) => { const value = session(id); value.sealed = true; value.entries.clear(); sessions.delete(id); },
  },
});
