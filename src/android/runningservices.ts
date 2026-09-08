import { JObj, rt } from "../jvm/runtime";
import { type JComponentName, type JIntent, mkComponentName } from "./intent";
import type { JContext } from "./context";
import { appHost, jclsNameOf } from "./apphost";

class JRunningServiceInfo extends JObj {
  service: JComponentName | null = null;
  pid = 1000; uid = 10001; process = ""; foreground = 0; started = 0; flags = 0;
  activeSince = 0n; lastActivityTime = 0n; restarting = 0n;
  activeCount = 0; clientCount = 0; crashCount = 0;
}
rt.register({
  name: "android/app/ActivityManager$RunningServiceInfo", ctor: JRunningServiceInfo, ifaces: ["android/os/Parcelable"],
  statics: { FLAG_STARTED: 1, FLAG_FOREGROUND: 2, FLAG_SYSTEM_PROCESS: 4, FLAG_PERSISTENT_PROCESS: 8 },
  fields: {
    service: "service", pid: "pid", uid: "uid", process: "process", foreground: "foreground",
    started: "started", flags: "flags", activeSince: "activeSince", lastActivityTime: "lastActivityTime",
    restarting: "restarting", activeCount: "activeCount", clientCount: "clientCount", crashCount: "crashCount",
  },
  methods: { "<init>()V": function () {} },
});

/** started-and-not-stopped services, keyed by dotted class name (matches Class.getName()) */
export const runningServices = new Map<string, JRunningServiceInfo>();
export function svcStart(ctx: JContext, intent: JIntent | null, fg: boolean): JComponentName | null {
  const cls = intent?.component;
  if (!cls) return null;
  let si = runningServices.get(cls);
  if (!si) {
    const pkg = ctx?.$host?.pkg ?? appHost?.pkg ?? "";
    si = new JRunningServiceInfo();
    si.service = mkComponentName(pkg, cls);
    si.process = pkg;
    si.started = 1;
    si.flags = 1;
    si.activeSince = BigInt(Date.now());
    runningServices.set(cls, si);
  }
  si.lastActivityTime = BigInt(Date.now());
  if (fg) { si.foreground = 1; si.flags |= 2; }
  return si.service;
}
export function svcStop(cls: string | null | undefined): number { return cls && runningServices.delete(cls) ? 1 : 0; }
export function svcFg(svc: unknown, fg: boolean) {
  const si = runningServices.get(jclsNameOf(svc));
  if (si) { si.foreground = fg ? 1 : 0; si.flags = fg ? si.flags | 2 : si.flags & ~2; }
}
