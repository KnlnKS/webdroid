// ActivityManagerService's ProcessRecord for this process: its IApplicationThread once it attached,
// the order system_server's calls reach it in, and what the services driving it ask the package
// manager for. The activity manager's tables (atm, activeservices, broadcastqueue) share it.
import { rt, type JObj } from "../../jvm/runtime.ts";
import { callOn, curThread, staticField, vcall } from "../../jvm/natives/jentry.ts";
import { hostedService } from "../binder.ts";
import { processName } from "../os.ts";
import { appHost } from "../apphost.ts";
import { GET_SHARED_LIBRARY_FILES } from "../packages.ts";

/** ActivityManagerService.STOCK_PM_FLAGS, what its package queries ask for */
export const STOCK_PM_FLAGS = BigInt(GET_SHARED_LIBRARY_FILES);
/** the package manager, as system_server's services reach it */
export const pms = (): JObj | Promise<JObj> => hostedService("package")!;
/** a component of `pkg` in `process` runs in this process */
export const runsHere = (pkg: string, process: string): boolean => pkg === appHost?.pkg && process === processName();
export const compatInfo = () => staticField<JObj>("android/content/res/CompatibilityInfo", "DEFAULT_COMPATIBILITY_INFO");

/** `thread` once the process attached; `userLaunched` for the app the user launched, whose launcher activity starts with it */
export const processRecord: { thread: JObj | null; userLaunched: boolean } = { thread: null, userLaunched: false };
/** this process's IApplicationThread, once it attached */
export function thisApp(): JObj {
  if (!processRecord.thread) throw rt.mkThrowable("java/lang/IllegalStateException", "Process has not attached");
  return processRecord.thread;
}
let lane: Promise<unknown> = Promise.resolve();
/** a call on this process's IApplicationThread after those made before it, as the system server's
 *  calls reach a process in order; arguments may be pending */
export function scheduleOnApp(name: string, desc: string, ...args: unknown[]): Promise<void> {
  const thread = curThread;
  const call = lane.then(() => Promise.all(args)).then((ready) => callOn(thread, () => vcall(thisApp(), name, desc, ...ready)));
  lane = call.catch(() => {});
  return call;
}
