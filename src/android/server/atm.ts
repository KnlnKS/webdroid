// ActivityTaskManagerService and its ActivityClientController for AOSP's ActivityThread: this
// process's activities on one task, each driven through ClientTransactions in the order
// ActivityTaskSupervisor gives them. Starting pauses the resumed activity, launches and resumes the
// new one once that pause is reported, and stops what it covers when it goes idle; finishing
// pauses, resumes the one below with any result it is owed, then stops and destroys.
import { rt, JObj, noops, stubs, declaredField } from "../../jvm/runtime";
import { newObj, vcall, scall } from "../../jvm/natives/jlang";
import { newArrayList } from "../../jvm/natives/jcoll";
import { configurations } from "./wm";
import { hostedService } from "../binder";

const CT = "android/app/servertransaction/";
const PROCESS_STATE_TOP = 2, START_SUCCESS = 0, START_INTENT_NOT_RESOLVED = -1;
const GET_META_DATA = 0x80n, MATCH_DEFAULT_ONLY = 0x10000n;

type State = "launching" | "resumed" | "pausing" | "paused" | "stopping" | "stopped" | "destroying";
interface ActivityRecord {
  token: JObj; intent: JObj; info: JObj; app: JObj; state: State;
  resultTo: ActivityRecord | null; resultWho: string | null; requestCode: number;
  results: JObj[]; finishing: boolean; translucent: boolean;
  paused: (() => void) | null;
}
const stack: ActivityRecord[] = [];
const byToken = (token: JObj | null) => stack.find((r) => r.token === token) ?? null;
const pms = () => hostedService("package") as Promise<JObj>;
const resolveInfoField = () => declaredField("android/content/pm/ResolveInfo", "activityInfo");
let controller: JObj | null = null;
const activityClientController = async () => controller ??= await newObj("webdroid/ActivityClientController");

async function schedule(app: JObj, callback: JObj | null, lifecycle: JObj | null): Promise<void> {
  const tx = await scall(CT + "ClientTransaction", "obtain", `(Landroid/app/IApplicationThread;)L${CT}ClientTransaction;`, app);
  if (callback) await vcall(tx, "addCallback", `(L${CT}ClientTransactionItem;)V`, callback);
  if (lifecycle) await vcall(tx, "setLifecycleStateRequest", `(L${CT}ActivityLifecycleItem;)V`, lifecycle);
  await vcall(app, "scheduleTransaction", `(L${CT}ClientTransaction;)V`, tx);
}
const item = (cls: string, desc: string, ...args: unknown[]) => scall(CT + cls, "obtain", `(${desc})L${CT}${cls};`, ...args);

/** pause the resumed activity and wait for the client to report it */
async function pause(r: ActivityRecord): Promise<void> {
  if (r.state !== "resumed") return;
  r.state = "pausing";
  const paused = new Promise<void>((resolve) => { r.paused = resolve; });
  await schedule(r.app, null, await item("PauseActivityItem", "Landroid/os/IBinder;ZZZZ", r.token, +r.finishing, 0, 0, 0));
  return paused;
}
async function resume(r: ActivityRecord): Promise<void> {
  const results = r.results.splice(0);
  const delivery = results.length ? await item("ActivityResultItem", "Landroid/os/IBinder;Ljava/util/List;", r.token, newArrayList(results)) : null;
  r.state = "resumed";
  await schedule(r.app, delivery, await item("ResumeActivityItem", "Landroid/os/IBinder;ZZ", r.token, 1, 0));
}
async function stop(r: ActivityRecord): Promise<void> {
  if (r.state !== "paused") return;
  r.state = "stopping";
  await schedule(r.app, null, await item("StopActivityItem", "Landroid/os/IBinder;", r.token));
}
async function destroy(r: ActivityRecord): Promise<void> {
  r.state = "destroying";
  stack.splice(stack.indexOf(r), 1);
  await schedule(r.app, null, await item("DestroyActivityItem", "Landroid/os/IBinder;Z", r.token, +r.finishing));
}

/** ActivityStarter: a resolved activity on top of this process's task */
export async function startActivity(app: JObj, intent: JObj, info: JObj, resultTo: ActivityRecord | null, resultWho: string | null, requestCode: number): Promise<void> {
  const token = await newObj("android/os/Binder", "()V");
  const prev = stack.at(-1);
  const r: ActivityRecord = { token, intent, info, app, state: "launching", resultTo, resultWho, requestCode, results: [], finishing: false, translucent: false, paused: null };
  if (prev) await pause(prev);
  stack.push(r);
  const { global, override } = await configurations();
  const windowInfo = await newObj("android/window/ActivityWindowInfo", "()V");
  const launch = await item("LaunchActivityItem",
    "Landroid/os/IBinder;Landroid/content/Intent;ILandroid/content/pm/ActivityInfo;Landroid/content/res/Configuration;Landroid/content/res/Configuration;" +
    "ILjava/lang/String;Lcom/android/internal/app/IVoiceInteractor;ILandroid/os/Bundle;Landroid/os/PersistableBundle;Ljava/util/List;Ljava/util/List;" +
    "Landroid/app/ActivityOptions$SceneTransitionInfo;ZLandroid/app/ProfilerInfo;Landroid/os/IBinder;Landroid/app/IActivityClientController;" +
    "Landroid/os/IBinder;ZLandroid/os/IBinder;Landroid/os/IBinder;Landroid/window/ActivityWindowInfo;",
    token, intent, stack.length, info, global, override, 0, null, null, PROCESS_STATE_TOP, null, null, null, null, null, 1, null,
    await newObj("android/os/Binder", "()V"), await activityClientController(), await newObj("android/os/Binder", "()V"), 0, null,
    await newObj("android/os/Binder", "()V"), windowInfo);
  r.state = "resumed";
  await schedule(app, launch, await item("ResumeActivityItem", "Landroid/os/IBinder;ZZ", token, 1, 0));
}

/** the launcher activity of `pkg`, as the home screen starts it */
export async function startMainActivity(app: JObj, pkg: string): Promise<void> {
  const intent = await newObj("android/content/Intent", "(Ljava/lang/String;)V", "android.intent.action.MAIN");
  await vcall(intent, "addCategory", "(Ljava/lang/String;)Landroid/content/Intent;", "android.intent.category.LAUNCHER");
  await vcall(intent, "setPackage", "(Ljava/lang/String;)Landroid/content/Intent;", pkg);
  await vcall(intent, "addFlags", "(I)Landroid/content/Intent;", 0x10200000);   // NEW_TASK | RESET_TASK_IF_NEEDED
  const resolved = await vcall(await pms(), "resolveIntent", "(Landroid/content/Intent;Ljava/lang/String;JI)Landroid/content/pm/ResolveInfo;", intent, null, GET_META_DATA, 0);
  const info: JObj | null = resolved ? (resolved as Record<string, JObj>)[resolveInfoField()] : null;
  if (!info) throw new Error(`no launcher activity in ${pkg}`);
  await vcall(intent, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;",
    await vcall(info, "getComponentName", "()Landroid/content/ComponentName;"));
  await startActivity(app, intent, info, null, null, -1);
}

async function finish(r: ActivityRecord, resultCode: number, data: JObj | null): Promise<boolean> {
  if (r.finishing) return true;
  r.finishing = true;
  if (r.resultTo && r.requestCode >= 0) {
    r.resultTo.results.push(await newObj("android/app/ResultInfo", "(Ljava/lang/String;IILandroid/content/Intent;)V", r.resultWho, r.requestCode, resultCode, data));
  }
  const wasTop = stack.at(-1) === r;
  await pause(r);
  const below = stack[stack.indexOf(r) - 1];
  if (wasTop && below) await resume(below);
  await destroy(r);
  return true;
}

rt.register({ name: "webdroid/ActivityClientController", ctor: class extends JObj {}, sup: "android/app/IActivityClientController$Stub", methods: {
  "activityPaused(Landroid/os/IBinder;)V": (token: JObj) => {
    const r = byToken(token);
    if (!r) return;
    r.state = "paused";
    const done = r.paused; r.paused = null; done?.();
  },
  "activityResumed(Landroid/os/IBinder;Z)V": () => {},
  "activityTopResumedStateLost()V": () => {},
  // the new top drew: what it covers stops, unless the top is translucent
  "activityIdle(Landroid/os/IBinder;Landroid/content/res/Configuration;Z)V": async (token: JObj) => {
    const r = byToken(token);
    if (!r || r.translucent) return;
    for (const below of stack.slice(0, stack.indexOf(r))) await stop(below);
  },
  "activityStopped(Landroid/os/IBinder;Landroid/os/Bundle;Landroid/os/PersistableBundle;Ljava/lang/CharSequence;)V": (token: JObj) => {
    const r = byToken(token); if (r) r.state = "stopped";
  },
  "activityDestroyed(Landroid/os/IBinder;)V": () => {},
  "finishActivity(Landroid/os/IBinder;ILandroid/content/Intent;I)Z": async (token: JObj, resultCode: number, data: JObj | null) => {
    const r = byToken(token);
    return r ? +(await finish(r, resultCode, data)) : 0;
  },
  // back on a root activity: AOSP moves a launcher-started task back; one task, so it finishes
  "onBackPressed(Landroid/os/IBinder;Landroid/app/IRequestFinishCallback;)V": (_token: JObj, callback: JObj) =>
    vcall(callback, "requestFinish", "()V"),
  "getCallingActivity(Landroid/os/IBinder;)Landroid/content/ComponentName;": (token: JObj) => {
    const to = byToken(token)?.resultTo;
    return to ? vcall(to.info, "getComponentName", "()Landroid/content/ComponentName;") : null;
  },
  "getCallingPackage(Landroid/os/IBinder;)Ljava/lang/String;": (token: JObj) => {
    const to = byToken(token)?.resultTo;
    return to ? vcall(to.info, "getComponentName", "()Landroid/content/ComponentName;").then((c: JObj) => vcall(c, "getPackageName", "()Ljava/lang/String;")) : null;
  },
  "getTaskForActivity(Landroid/os/IBinder;Z)I": (token: JObj) => byToken(token) ? 1 : -1,
  "isTopOfTask(Landroid/os/IBinder;)Z": (token: JObj) => +(stack.at(-1)?.token === token),
  "getDisplayId(Landroid/os/IBinder;)I": () => 0,
  "getRequestedOrientation(Landroid/os/IBinder;)I": () => -1,
  "willActivityBeVisible(Landroid/os/IBinder;)Z": (token: JObj) => +(stack.at(-1)?.token === token),
  "convertToTranslucent(Landroid/os/IBinder;Landroid/os/Bundle;)Z": (token: JObj) => { const r = byToken(token); if (r) r.translucent = true; return 1; },
  "convertFromTranslucent(Landroid/os/IBinder;)Z": (token: JObj) => { const r = byToken(token); if (r) r.translucent = false; return 1; },
  ...stubs(0, "isImmersive(Landroid/os/IBinder;)Z", "isRootVoiceInteraction(Landroid/os/IBinder;)Z"),
  ...noops("setTaskDescription(Landroid/os/IBinder;Landroid/app/ActivityManager$TaskDescription;)V",
    "reportSizeConfigurations(Landroid/os/IBinder;Landroid/window/SizeConfigurationBuckets;)V",
    "reportActivityFullyDrawn(Landroid/os/IBinder;Z)V", "setRecentsScreenshotEnabled(Landroid/os/IBinder;Z)V",
    "setImmersive(Landroid/os/IBinder;Z)V", "splashScreenAttached(Landroid/os/IBinder;)V", "invalidateHomeTaskSnapshot(Landroid/os/IBinder;)V",
    "overridePendingTransition(Landroid/os/IBinder;Ljava/lang/String;III)V", "setRequestedOrientation(Landroid/os/IBinder;I)V"),
} });

/** the methods IActivityTaskManager adds for ActivityThread's activities */
export const activityTaskMethods = {
  "getActivityClientController()Landroid/app/IActivityClientController;": activityClientController,
  "startActivity(Landroid/app/IApplicationThread;Ljava/lang/String;Ljava/lang/String;Landroid/content/Intent;Ljava/lang/String;Landroid/os/IBinder;Ljava/lang/String;IILandroid/app/ProfilerInfo;Landroid/os/Bundle;)I":
    async (app: JObj, _pkg: string, _feature: string, intent: JObj, resolvedType: string | null, resultTo: JObj | null, resultWho: string | null, requestCode: number) => {
      const resolved = await vcall(await pms(), "resolveIntent", "(Landroid/content/Intent;Ljava/lang/String;JI)Landroid/content/pm/ResolveInfo;",
        intent, resolvedType, MATCH_DEFAULT_ONLY | GET_META_DATA, 0);
      const info: JObj | null = resolved ? (resolved as Record<string, JObj>)[resolveInfoField()] : null;
      if (!info) return START_INTENT_NOT_RESOLVED;
      const copy = await newObj("android/content/Intent", "(Landroid/content/Intent;)V", intent);
      await vcall(copy, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", await vcall(info, "getComponentName", "()Landroid/content/ComponentName;"));
      await startActivity(app, copy, info, byToken(resultTo), resultWho, requestCode);
      return START_SUCCESS;
    },
};
