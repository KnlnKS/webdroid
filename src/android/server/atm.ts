// ActivityTaskManagerService and its ActivityClientController for AOSP's ActivityThread: this
// process's activities on one task, each driven through ClientTransactions in the order
// ActivityTaskSupervisor gives them. Starting pauses the resumed activity, launches and resumes the
// new one once that pause is reported, and stops what it covers when it goes idle; finishing
// pauses, resumes the one below with any result it is owed, then stops and destroys.
import { rt, JObj, noops, stubs, declaredField, setDeclared, getDeclared } from "../../jvm/runtime";
import { newObj, vcall, scall, reportUncaught, linkInit } from "../../jvm/natives/jlang";
import { mangleStaticField } from "../../jvm/abi";
import { newArrayList } from "../../jvm/natives/jcoll";
import { configurations, resizeWindows } from "./wm";
import { notifyDisplayChanged } from "../display";
import { hostedService, systemToken } from "../binder";
import { appHost } from "../apphost";
import { PROCESS_NAME } from "../os";
import { intentQuery, mkComponentName, systemActivity, SYSTEM_ACTIVITY, type ComponentRef, type JIntent, type SystemHandler } from "../intent";
import { grantResultUris } from "../urigrants";
import { thisApp, userLaunched } from "./am";

const CT = "android/app/servertransaction/";
const PROCESS_STATE_TOP = 2, START_SUCCESS = 0, START_INTENT_NOT_RESOLVED = -1;
const GET_META_DATA = 0x80n, MATCH_DEFAULT_ONLY = 0x10000n;

/** a start in another process, and the result target there when it asked for one */
export type ResultDelivery = { code: number; caller: ComponentRef; deliver: (resultCode: number, data: JIntent | null) => void };
/** the broker's half of ActivityTaskManager: starts in other processes and their results */
export const activityTransport: {
  launch?: (pkg: string, process: string, component: string, intent: JIntent, result?: ResultDelivery) => Promise<void>;
  presentation?: (translucent: boolean) => void;
  /** an activity the broker started here (its record id) finished with a result */
  finished?: (remoteId: number, code: number, data: JIntent | null) => void;
} = {};

/** a resumed activity is also the top resumed one: it hears that with its resume, and loses it
 *  in the transaction that pauses it */
type State = "launching" | "resumed" | "pausing" | "paused" | "stopping" | "stopped" | "destroying";
interface ActivityRecord {
  token: JObj; intent: JObj; info: JObj; app: JObj; state: State;
  /** the activity here that started this one for a result (ActivityStarter's resultRecord) */
  resultTo: ActivityRecord | null; resultWho: string | null; requestCode: number;
  results: JObj[]; finishing: boolean; translucent: boolean;
  /** the pause under way, settled by the client's report (or its destroy): a second pause, such
   *  as a finish racing a start's, waits on the same one */
  pausing: { done: Promise<void>; settle: () => void } | null;
  /** the result it finishes with, owed to `resultTo` or the remote caller */
  owed: { code: number; data: JObj | null } | null;
  /** the broker's record of a start from another process, and the activity there awaiting a result */
  remote: { id: number; caller: ComponentRef | null } | null;
  /** the global configuration it last had, and the orientation it asks for */
  config: JObj; orientation: number;
}
const stack: ActivityRecord[] = [];
const byToken = (token: JObj | null) => stack.find((r) => r.token === token) ?? null;
export const PROCESS_STATE_SERVICE = 10, PROCESS_STATE_RECEIVER = 11;
/** the process state the activity manager reports with a call: top while an activity here is
 *  resumed, else the state of the component it runs */
export const foreground = (): boolean => stack.some((r) => r.state === "resumed");
export const processState = (component: number): number => foreground() ? PROCESS_STATE_TOP : component;
const pms = () => hostedService("package") as Promise<JObj>;
const resolveInfoField = () => declaredField("android/content/pm/ResolveInfo", "activityInfo");
let controller: JObj | null = null;
const activityClientController = async () => controller ??= await newObj("webdroid/ActivityClientController");

async function schedule(app: JObj, callbacks: JObj | null | (JObj | null)[], lifecycle: JObj | null): Promise<void> {
  const tx = await scall(CT + "ClientTransaction", "obtain", `(Landroid/app/IApplicationThread;)L${CT}ClientTransaction;`, app);
  for (const callback of [callbacks].flat()) if (callback) await vcall(tx, "addCallback", `(L${CT}ClientTransactionItem;)V`, callback);
  if (lifecycle) await vcall(tx, "setLifecycleStateRequest", `(L${CT}ActivityLifecycleItem;)V`, lifecycle);
  await vcall(app, "scheduleTransaction", `(L${CT}ClientTransaction;)V`, tx);
}
const item = (cls: string, desc: string, ...args: unknown[]) => scall(CT + cls, "obtain", `(${desc})L${CT}${cls};`, ...args);

const topResumedItem = (r: ActivityRecord, onTop: boolean) => item("TopResumedActivityChangeItem", "Landroid/os/IBinder;Z", r.token, +onTop);
/** pause the resumed activity and wait for the client to report it */
function pause(r: ActivityRecord): Promise<void> {
  if (r.pausing) return r.pausing.done;
  if (r.state !== "resumed") return Promise.resolve();
  r.state = "pausing";
  const reported = Promise.withResolvers<void>();
  const done = (async () => {
    await schedule(r.app, await topResumedItem(r, false), await item("PauseActivityItem", "Landroid/os/IBinder;ZZZZ", r.token, +r.finishing, 0, 0, 0));
    await reported.promise;
  })();
  r.pausing = { done, settle: reported.resolve };
  return done;
}
const settlePause = (r: ActivityRecord) => { r.pausing?.settle(); r.pausing = null; };
const resumeItem = (r: ActivityRecord) => item("ResumeActivityItem", "Landroid/os/IBinder;ZZ", r.token, 1, 0);
async function resume(r: ActivityRecord): Promise<void> {
  const results = r.results.splice(0);
  r.state = "resumed";
  if (displayHooks.requestOrientation?.(r.orientation)) await configurationChanged();
  const top = await topResumedItem(r, true);
  if (await ensureConfiguration(r, results, await resumeItem(r), top)) return;
  const delivery = results.length ? await item("ActivityResultItem", "Landroid/os/IBinder;Ljava/util/List;", r.token, newArrayList(results)) : null;
  await schedule(r.app, [delivery, top], await resumeItem(r));
}

const CFG = "Landroid/content/res/Configuration;";
/** ActivityRecord.ensureActivityConfiguration: an activity that declared every changed bit in its
 *  configChanges hears the change; any other relaunches, ending at `lifecycle` with `results`
 *  delivered and `after` run. Returns whether it relaunched. */
async function ensureConfiguration(r: ActivityRecord, results: JObj[], lifecycle: JObj, after: JObj | null = null): Promise<boolean> {
  const { global, override } = await configurations();
  const changes: number = await vcall(r.config, "diff", `(${CFG})I`, global);
  if (!changes) return false;
  r.config = global;
  const windowInfo = await newObj("android/window/ActivityWindowInfo", "()V");
  if (!(changes & ~await vcall(r.info, "getRealConfigChanged", "()I"))) {
    await schedule(r.app, await item("ActivityConfigurationChangeItem", `Landroid/os/IBinder;${CFG}Landroid/window/ActivityWindowInfo;`, r.token, override, windowInfo), null);
    return false;
  }
  const merged = await newObj("android/util/MergedConfiguration", `(${CFG}${CFG})V`, global, override);
  await schedule(r.app, [await item("ActivityRelaunchItem", "Landroid/os/IBinder;Ljava/util/List;Ljava/util/List;ILandroid/util/MergedConfiguration;ZLandroid/window/ActivityWindowInfo;",
    r.token, results.length ? newArrayList(results) : null, null, changes, merged, 1, windowInfo), after], lifecycle);
  return true;
}
/** the shell's display: turns it for an orientation request, answering whether it turned */
export const displayHooks: { requestOrientation?: (request: number) => boolean } = {};
/** ActivityTaskManagerService.updateConfigurationLocked: the process hears the new configuration,
 *  then each visible activity (the others when they next resume), then each window its new frames */
export async function configurationChanged(): Promise<void> {
  notifyDisplayChanged();
  const { global } = await configurations();
  await schedule(thisApp(), await item("ConfigurationChangeItem", `${CFG}I`, global, 0), null);
  for (const r of [...stack]) {
    if (r.state === "resumed") await ensureConfiguration(r, [], await resumeItem(r));
    else if (r.state === "paused") await ensureConfiguration(r, [], await item("PauseActivityItem", "Landroid/os/IBinder;ZZZZ", r.token, 0, 0, 0, 0));
  }
  await resizeWindows();
}
/** the orientation the top activity asks for, or unspecified */
export const topOrientation = (): number => stack.at(-1)?.orientation ?? -1;
async function stop(r: ActivityRecord): Promise<void> {
  if (r.state !== "paused") return;
  r.state = "stopping";
  await schedule(r.app, null, await item("StopActivityItem", "Landroid/os/IBinder;", r.token));
}
/** take it off the stack, once, telling the broker what a remote caller is owed */
async function destroy(r: ActivityRecord): Promise<void> {
  const i = stack.indexOf(r);
  if (i < 0) return;
  stack.splice(i, 1);
  r.state = "destroying";
  reportPresentation();
  // a start waiting on its pause goes on: the report would find no record
  settlePause(r);
  if (r.remote) activityTransport.finished?.(r.remote.id, r.owed?.code ?? RESULT_CANCELED, r.owed?.data ?? null);
  await schedule(r.app, null, await item("DestroyActivityItem", "Landroid/os/IBinder;Z", r.token, +r.finishing));
}

/** activity starts and finishes still waiting on their clients' lifecycle reports */
let transitions = 0;
export const pendingTransitions = (): number => transitions;

const LAUNCH_MULTIPLE = 0, LAUNCH_SINGLE_TOP = 1, LAUNCH_SINGLE_TASK = 2, RESULT_CANCELED = 0;
const FLAG_ACTIVITY_CLEAR_TOP = 0x4000000, FLAG_SINGLE_TOP = 0x20000000, FLAG_NEW_TASK = 0x10000000, FLAG_CLEAR_TASK = 0x8000, FLAG_REORDER_TO_FRONT = 0x20000;
/** ActivityStarter's reuse of an instance in the task (one task per process): a singleTop or
 *  SINGLE_TOP start of the top activity, a singleTask/singleInstance activity, or CLEAR_TOP clear
 *  what is above it and hand it the intent; REORDER_TO_FRONT brings it to the top; CLEAR_TASK with
 *  NEW_TASK empties the task first. Returns whether the existing instance took the intent. */
async function reuseActivity(intent: JObj, info: JObj): Promise<boolean> {
  const flags: number = await vcall(intent, "getFlags", "()I"), mode = getDeclared<number>(info, AI, "launchMode");
  if ((flags & FLAG_CLEAR_TASK) && (flags & FLAG_NEW_TASK)) {
    await clearAbove(null);
    return false;
  }
  const name = getDeclared<string>(info, AI, "name");
  const existing = [...stack].reverse().find((r) => !r.finishing && getDeclared<string>(r.info, AI, "name") === name);
  if (!existing) return false;
  const singleTop = mode === LAUNCH_SINGLE_TOP || (flags & FLAG_SINGLE_TOP) !== 0;
  if (existing === stack.at(-1) && (singleTop || mode >= LAUNCH_SINGLE_TASK)) return newIntent(existing, intent).then(() => true);
  if (mode >= LAUNCH_SINGLE_TASK || (flags & FLAG_ACTIVITY_CLEAR_TOP)) {
    // a standard activity under CLEAR_TOP without SINGLE_TOP is itself replaced by a new instance
    const reuse = mode !== LAUNCH_MULTIPLE || singleTop;
    await clearAbove(reuse ? existing : stack[stack.indexOf(existing) - 1] ?? null);
    if (reuse) await newIntent(existing, intent);
    return reuse;
  }
  if (flags & FLAG_REORDER_TO_FRONT) {
    const top = stack.at(-1)!;
    await pause(top);
    stack.splice(stack.indexOf(existing), 1);
    stack.push(existing);
    existing.state = "paused";
    await newIntent(existing, intent);
    await resume(existing);
    return true;
  }
  return false;
}
/** finish every activity above `target` (all of them for null): those covered are destroyed, and
 *  the top finishes, resuming what is then below it; each owes its caller RESULT_CANCELED */
async function clearAbove(target: ActivityRecord | null): Promise<void> {
  const above = stack.slice(target ? stack.indexOf(target) + 1 : 0);
  for (const r of above.slice(0, -1)) {
    if (r.finishing) continue;
    r.finishing = true;
    await owedResult(r, RESULT_CANCELED, null);
    await destroy(r);
  }
  const top = above.at(-1);
  if (top) await finish(top, RESULT_CANCELED, null);
}
/** ActivityRecord.deliverNewIntentLocked: onNewIntent, around a temporary pause when resumed */
async function newIntent(r: ActivityRecord, intent: JObj): Promise<void> {
  const referrer = await newObj("com/android/internal/content/ReferrerIntent", "(Landroid/content/Intent;Ljava/lang/String;)V", intent, appHost!.pkg);
  await schedule(r.app, await item("NewIntentItem", "Landroid/os/IBinder;Ljava/util/List;Z", r.token, newArrayList([referrer]), +(r.state === "resumed")), null);
}

/** ActivityStarter: a resolved activity on top of this process's task, or the instance already there that takes the intent */
async function startActivity(app: JObj, intent: JObj, info: JObj, resultTo: ActivityRecord | null, resultWho: string | null, requestCode: number,
  remote: ActivityRecord["remote"] = null): Promise<void> {
  transitions++;
  try {
    if (await reuseActivity(intent, info)) return;
    const token = systemToken();
    const prev = stack.at(-1);
    const orientation = getDeclared<number>(info, AI, "screenOrientation");
    if (prev) await pause(prev);
    // the display turns for an activity that fixes its orientation before it launches
    if (displayHooks.requestOrientation?.(orientation)) await configurationChanged();
    const { global, override } = await configurations();
    const r: ActivityRecord = { token, intent, info, app, state: "launching", resultTo, resultWho, requestCode, results: [], finishing: false,
      translucent: await translucentTheme(info), pausing: null, owed: null, remote, config: global, orientation };
    stack.push(r);
    reportPresentation();
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
    await schedule(app, [launch, await topResumedItem(r, true)], await resumeItem(r));
  } finally { transitions--; }
}

const STYLEABLE = "com/android/internal/R$styleable";
/** the package's resources as AttributeCache reads them, through a package context of the system
 *  context: an activity may start before the Application exists */
let resources: Promise<JObj> | null = null;
const packageResources = () => resources ??= (async () => {
  const system = await vcall(await scall("android/app/ActivityThread", "currentActivityThread", "()Landroid/app/ActivityThread;"), "getSystemContext", "()Landroid/app/ContextImpl;");
  return vcall(await vcall(system, "createPackageContext", "(Ljava/lang/String;I)Landroid/content/Context;", appHost!.pkg, 0), "getResources", "()Landroid/content/res/Resources;");
})();
/** ActivityRecord's occludesParent from the activity's theme: one translucent or floating, or showing
 *  the wallpaper, lets what is under it show */
async function translucentTheme(info: JObj): Promise<boolean> {
  const theme = await vcall(await packageResources(), "newTheme", "()Landroid/content/res/Resources$Theme;");
  await vcall(theme, "applyStyle", "(IZ)V", await vcall(info, "getThemeResource", "()I"), 1);
  const statics = (await linkInit(STYLEABLE)).ctor as Record<string, unknown>;
  const a = await vcall(theme, "obtainStyledAttributes", "([I)Landroid/content/res/TypedArray;", statics[mangleStaticField("Window")]);
  try {
    return !!await scall(AI, "isTranslucentOrFloating", "(Landroid/content/res/TypedArray;)Z", a) ||
      !!await vcall(a, "getBoolean", "(IZ)Z", statics[mangleStaticField("Window_windowShowWallpaper")], 0);
  } finally { await vcall(a, "recycle", "()V"); }
}
/** the broker shows the process under this one while every activity here lets it show through */
const reportPresentation = () => activityTransport.presentation?.(stack.length > 0 && stack.every((r) => r.translucent));

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

const AI = "android/content/pm/ActivityInfo";
/** ActivityStarter.execute: the resolved activity starts here, or through the broker in its own process */
export async function startActivityFor(app: JObj, intent: JObj, resolvedType: string | null = null, resultTo: JObj | null = null, resultWho: string | null = null, requestCode = -1): Promise<number> {
  transitions++;
  try {
    const resolved = await vcall(await pms(), "resolveIntent", "(Landroid/content/Intent;Ljava/lang/String;JI)Landroid/content/pm/ResolveInfo;",
      intent, resolvedType, MATCH_DEFAULT_ONLY | GET_META_DATA, 0);
    const info: JObj | null = resolved ? (resolved as Record<string, JObj>)[resolveInfoField()] : null;
    // ActivityStarter keeps a result record only for a start for a result by an activity not finishing
    const source = byToken(resultTo), resultRecord = requestCode >= 0 && !source?.finishing ? source : null;
    const q = await intentQuery(intent), system = systemActivity(q, false) ??
      (info && getDeclared<string>(info, AI, "packageName") === "android" && getDeclared<string>(info, AI, "name") === SYSTEM_ACTIVITY ? systemActivity(q) : null);
    if (system) { void runSystemActivity(system, intent, resultRecord, resultWho, requestCode).catch(reportUncaught); return START_SUCCESS; }
    if (!info) return START_INTENT_NOT_RESOLVED;
    const copy = await newObj("android/content/Intent", "(Landroid/content/Intent;)V", intent);
    await vcall(copy, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", await vcall(info, "getComponentName", "()Landroid/content/ComponentName;"));
    const pkg = getDeclared<string>(info, AI, "packageName"), process = getDeclared<string>(info, AI, "processName");
    // the pause a local start waits for runs on the caller's main thread, so the call returns once it
    // is under way, as ActivityStarter returns once the pause is scheduled
    if (pkg === appHost?.pkg && process === (PROCESS_NAME || pkg)) void startActivity(app, copy, info, resultRecord, resultWho, requestCode).catch(reportUncaught);
    else if (activityTransport.launch) {
      await activityTransport.launch(pkg, process, getDeclared<string>(info, AI, "name").replaceAll(".", "/"), copy, resultRecord ? {
        code: requestCode, caller: { pkg: appHost!.pkg, cls: getDeclared<string>(resultRecord.info, AI, "name") },
        deliver: (resultCode, data) => void deliverResult(resultRecord, resultWho, requestCode, resultCode, data).catch(reportUncaught),
      } : undefined);
    }
    else return START_INTENT_NOT_RESOLVED;
    return START_SUCCESS;
  } finally { transitions--; }
}
const RESULT_OK = -1;
/** an activity the platform package answers over the browser (DocumentsUI's pickers, share, the
 *  browser): it covers its caller, which resumes with any result it asked for */
async function runSystemActivity(run: SystemHandler, intent: JObj, resultTo: ActivityRecord | null, resultWho: string | null, requestCode: number): Promise<void> {
  let data: JObj | null = null;
  try { data = await run(intent); } catch (error) { reportUncaught(error); }
  await deliverResult(resultTo ?? stack.at(-1) ?? null, resultWho, requestCode, data ? RESULT_OK : RESULT_CANCELED, data);
}
/** a result from an activity that covered `to` elsewhere (the browser, another process): the
 *  caller takes it as it resumes */
async function deliverResult(to: ActivityRecord | null, resultWho: string | null, requestCode: number, resultCode: number, data: JObj | null): Promise<void> {
  if (!to || to.finishing) return;
  if (resultCode === RESULT_OK && data) await grantResultUris(appHost!.pkg, data);
  if (requestCode >= 0) to.results.push(await newObj("android/app/ResultInfo", "(Ljava/lang/String;IILandroid/content/Intent;)V", resultWho, requestCode, resultCode, data));
  if (stack.at(-1) === to) await coverTop();
}
/** the pause and resume a system window over the top activity leaves behind (a permission prompt) */
export async function coverTop(): Promise<void> {
  const top = stack.at(-1);
  if (top?.state === "resumed") { await pause(top); await resume(top); }
}
/** the broker's launch of one of this process's activities for another process */
export async function startActivityInProcess(component: string, intent: JObj, remoteId: number, caller: ComponentRef | null): Promise<void> {
  const name = await mkComponentName(appHost!.pkg, component.replaceAll("/", "."));
  const info = await vcall(await pms(), "getActivityInfo", "(Landroid/content/ComponentName;JI)Landroid/content/pm/ActivityInfo;", name, GET_META_DATA, 0);
  if (!info) throw new Error("Activity not installed: " + component);
  await vcall(intent, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", name);
  await startActivity(thisApp(), intent, info, null, null, -1, { id: remoteId, caller });
}
/** the broker showing or hiding this process: its top activity pauses, what is paused stops, and
 *  the top resumes (the launcher activity starts again in an emptied app process, as its icon
 *  would). Shown behind a translucent process, a stopped top starts again without resuming, as
 *  ActivityRecord.makeActiveIfNeeded does. */
export async function taskVisibility(phase: "pause" | "stop" | "resume" | "visible"): Promise<void> {
  const top = stack.at(-1), pkg = appHost!.pkg;
  if (!top) { if (phase === "resume" && userLaunched()) await startMainActivity(thisApp(), pkg); return; }
  if (phase === "pause") await pause(top);
  else if (phase === "stop") for (const r of [...stack]) await stop(r);
  else if (phase === "resume" && top.state !== "resumed") await resume(top);
  else if (phase === "visible" && top.state === "stopped") {
    top.state = "paused";
    await schedule(top.app, null, await item("StartActivityItem", "Landroid/os/IBinder;Landroid/app/ActivityOptions$SceneTransitionInfo;", top.token, null));
  }
}

/** the result a finishing activity owes the one that started it for one */
async function owedResult(r: ActivityRecord, resultCode: number, data: JObj | null): Promise<void> {
  r.owed = { code: resultCode, data };
  if (r.resultTo)
    r.resultTo.results.push(await newObj("android/app/ResultInfo", "(Ljava/lang/String;IILandroid/content/Intent;)V", r.resultWho, r.requestCode, resultCode, data));
}
async function finish(r: ActivityRecord, resultCode: number, data: JObj | null): Promise<boolean> {
  transitions++;
  try {
    if (r.finishing) return true;
    r.finishing = true;
    await owedResult(r, resultCode, data);
    const wasTop = stack.at(-1) === r;
    await pause(r);
    const below = stack[stack.indexOf(r) - 1];
    if (wasTop && below) await resume(below);
    await destroy(r);
    return true;
  } finally { transitions--; }
}

const isComponent = async (r: ActivityRecord, component: JObj | null) => !!component &&
  getDeclared<string>(r.info, AI, "packageName") === await vcall(component, "getPackageName", "()Ljava/lang/String;") &&
  getDeclared<string>(r.info, AI, "name") === await vcall(component, "getClassName", "()Ljava/lang/String;");
/** ActivityRecord.navigateUpTo: finish up to the nearest instance of the destination below, which
 *  gets the intent as a new one, or, a standard activity not asked to clear top, is replaced by a
 *  new instance; with none, only `r` finishes. Returns whether the destination was in the task. */
async function navigateUpTo(r: ActivityRecord, dest: JObj, resultCode: number, resultData: JObj | null): Promise<boolean> {
  const component: JObj | null = await vcall(dest, "getComponent", "()Landroid/content/ComponentName;");
  let parent: ActivityRecord | null = null;
  for (let i = stack.indexOf(r) - 1; i >= 0 && !parent; i--) if (await isComponent(stack[i], component)) parent = stack[i];
  const covered = parent ? stack.slice(stack.indexOf(parent) + 1, stack.indexOf(r)) : [];
  const reuse = parent && (getDeclared<number>(parent.info, AI, "launchMode") !== LAUNCH_MULTIPLE ||
    (await vcall(dest, "getFlags", "()I") & FLAG_ACTIVITY_CLEAR_TOP) !== 0);
  const restarted = parent && !reuse && await startActivityFor(r.app, dest) === START_SUCCESS;
  void (async () => {
    for (const c of covered) await finish(c, RESULT_CANCELED, null);
    if (reuse) await newIntent(parent!, dest);
    if (restarted) await finish(parent!, resultCode, resultData);
    await finish(r, resultCode, resultData);
  })().catch(reportUncaught);
  return reuse || !!restarted;
}

function setTranslucent(token: JObj, translucent: boolean): number {
  const r = byToken(token);
  if (r) { r.translucent = translucent; reportPresentation(); }
  return 1;
}
rt.register({ name: "webdroid/ActivityClientController", ctor: class extends JObj {}, sup: "android/app/IActivityClientController$Stub", methods: {
  "activityPaused(Landroid/os/IBinder;)V": (token: JObj) => {
    const r = byToken(token);
    if (!r) return;
    r.state = "paused";
    settlePause(r);
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
  // Activity.recreate's relaunch, started and done in the client; nothing here waits on it
  ...noops("activityLocalRelaunch(Landroid/os/IBinder;)V", "activityRelaunched(Landroid/os/IBinder;)V"),
  // as a start: the pause a finish waits for runs on the caller's main thread
  "finishActivity(Landroid/os/IBinder;ILandroid/content/Intent;I)Z": (token: JObj, resultCode: number, data: JObj | null) => {
    const r = byToken(token);
    if (!r) return 0;
    void finish(r, resultCode, data).catch(reportUncaught);
    return 1;
  },
  "navigateUpTo(Landroid/os/IBinder;Landroid/content/Intent;Ljava/lang/String;ILandroid/content/Intent;)Z":
    async (token: JObj, dest: JObj, _type: string | null, resultCode: number, data: JObj | null) => {
      const r = byToken(token);
      return r ? +await navigateUpTo(r, dest, resultCode, data) : 0;
    },
  // the task's affinity is its root activity's
  "shouldUpRecreateTask(Landroid/os/IBinder;Ljava/lang/String;)Z": (token: JObj, affinity: string | null) =>
    +(!!byToken(token) && getDeclared<string | null>(stack[0].info, AI, "taskAffinity") !== affinity),
  // Task.finishActivityAffinity: it and the activities directly below it that share its affinity
  "finishActivityAffinity(Landroid/os/IBinder;)Z": (token: JObj) => {
    const r = byToken(token);
    if (!r) return 0;
    const affinity = getDeclared<string | null>(r.info, AI, "taskAffinity"), doomed: ActivityRecord[] = [];
    for (let i = stack.indexOf(r); i >= 0 && getDeclared<string | null>(stack[i].info, AI, "taskAffinity") === affinity; i--) doomed.push(stack[i]);
    void (async () => { for (const d of doomed.reverse()) await finish(d, RESULT_CANCELED, null); })().catch(reportUncaught);
    return 1;
  },
  // back on a root activity: AOSP moves a launcher-started task back; one task, so it finishes
  "onBackPressed(Landroid/os/IBinder;Landroid/app/IRequestFinishCallback;)V": (_token: JObj, callback: JObj) =>
    vcall(callback, "requestFinish", "()V"),
  "getCallingActivity(Landroid/os/IBinder;)Landroid/content/ComponentName;": (token: JObj) => callingActivity(token),
  "getCallingPackage(Landroid/os/IBinder;)Ljava/lang/String;": async (token: JObj) => {
    const c = await callingActivity(token);
    return c && vcall(c, "getPackageName", "()Ljava/lang/String;");
  },
  "getTaskForActivity(Landroid/os/IBinder;Z)I": (token: JObj) => byToken(token) ? TASK_ID : -1,
  "isTopOfTask(Landroid/os/IBinder;)Z": (token: JObj) => +(stack.at(-1)?.token === token),
  "getDisplayId(Landroid/os/IBinder;)I": () => 0,
  "getRequestedOrientation(Landroid/os/IBinder;)I": (token: JObj) => byToken(token)?.orientation ?? -1,
  "setRequestedOrientation(Landroid/os/IBinder;I)V": (token: JObj, orientation: number) => {
    const r = byToken(token);
    if (!r || r.orientation === orientation) return;
    r.orientation = orientation;
    if (stack.at(-1) === r && displayHooks.requestOrientation?.(orientation)) void configurationChanged().catch(reportUncaught);
  },
  "willActivityBeVisible(Landroid/os/IBinder;)Z": (token: JObj) => +(stack.at(-1)?.token === token),
  "convertToTranslucent(Landroid/os/IBinder;Landroid/os/Bundle;)Z": (token: JObj) => setTranslucent(token, true),
  "convertFromTranslucent(Landroid/os/IBinder;)Z": (token: JObj) => setTranslucent(token, false),
  ...stubs(0, "isImmersive(Landroid/os/IBinder;)Z", "isRootVoiceInteraction(Landroid/os/IBinder;)Z"),
  ...noops("setTaskDescription(Landroid/os/IBinder;Landroid/app/ActivityManager$TaskDescription;)V",
    "reportSizeConfigurations(Landroid/os/IBinder;Landroid/window/SizeConfigurationBuckets;)V",
    "reportActivityFullyDrawn(Landroid/os/IBinder;Z)V", "setRecentsScreenshotEnabled(Landroid/os/IBinder;Z)V",
    "setImmersive(Landroid/os/IBinder;Z)V", "splashScreenAttached(Landroid/os/IBinder;)V", "invalidateHomeTaskSnapshot(Landroid/os/IBinder;)V",
    // no keyguard is shown and the screen never turns off
    "setShowWhenLocked(Landroid/os/IBinder;Z)V", "setInheritShowWhenLocked(Landroid/os/IBinder;Z)V", "setTurnScreenOn(Landroid/os/IBinder;Z)V",
    // activity transitions are not animated, so an override has nothing to replace
    "overridePendingTransition(Landroid/os/IBinder;Ljava/lang/String;III)V", "overrideActivityTransition(Landroid/os/IBinder;ZIII)V",
    "clearOverrideActivityTransition(Landroid/os/IBinder;Z)V"),
} });

/** the activity that started this one for a result, here or in another process */
async function callingActivity(token: JObj): Promise<JObj | null> {
  const r = byToken(token), caller = r?.remote?.caller;
  return r?.resultTo ? component(r.resultTo) : caller ? mkComponentName(caller.pkg, caller.cls) : null;
}
// IAppTask: this process's one task
const TASK_ID = 1;
const component = (r: ActivityRecord | undefined) => r ? vcall(r.info, "getComponentName", "()Landroid/content/ComponentName;") : null;
rt.register({ name: "webdroid/AppTask", ctor: class extends JObj {}, sup: "android/app/IAppTask$Stub", methods: {
  "getTaskInfo()Landroid/app/ActivityManager$RecentTaskInfo;": async () => {
    const info = await newObj("android/app/ActivityManager$RecentTaskInfo", "()V");
    return setDeclared(info, "android/app/ActivityManager$RecentTaskInfo", {
      id: TASK_ID, persistentId: TASK_ID, taskId: TASK_ID, numActivities: stack.length, isRunning: +(stack.length > 0),
      baseIntent: stack[0]?.intent ?? null, baseActivity: await component(stack[0]), topActivity: await component(stack.at(-1)) });
  },
  "finishAndRemoveTask()V": () => void clearAbove(null).catch(reportUncaught),
  // one task is shown at a time, and there are no recents to exclude it from
  ...noops("moveToFront(Landroid/app/IApplicationThread;Ljava/lang/String;)V", "setExcludeFromRecents(Z)V"),
} });
let appTask: Promise<JObj> | null = null;

/** the methods IActivityTaskManager adds for ActivityThread's activities */
export const activityTaskMethods = {
  "getAppTasks(Ljava/lang/String;)Ljava/util/List;": async () => newArrayList(stack.length ? [await (appTask ??= newObj("webdroid/AppTask"))] : []),
  "getActivityClientController()Landroid/app/IActivityClientController;": activityClientController,
  // nothing captures the screen, so a screen-capture observer is never called
  ...noops("registerScreenCaptureObserver(Landroid/os/IBinder;Landroid/app/IScreenCaptureObserver;)V",
    "unregisterScreenCaptureObserver(Landroid/os/IBinder;Landroid/app/IScreenCaptureObserver;)V"),
  "startActivity(Landroid/app/IApplicationThread;Ljava/lang/String;Ljava/lang/String;Landroid/content/Intent;Ljava/lang/String;Landroid/os/IBinder;Ljava/lang/String;IILandroid/app/ProfilerInfo;Landroid/os/Bundle;)I":
    (app: JObj, _pkg: string, _feature: string, intent: JObj, resolvedType: string | null, resultTo: JObj | null, resultWho: string | null, requestCode: number) =>
      startActivityFor(app, intent, resolvedType, resultTo, resultWho, requestCode),
};
