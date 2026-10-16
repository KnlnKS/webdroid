// ActivityTaskManagerService and its ActivityClientController for AOSP's ActivityThread: this
// process's activities on one task, each driven through ClientTransactions in the order
// ActivityTaskSupervisor gives them. Starting pauses the resumed activity, launches and resumes the
// new one once that pause is reported, and stops what it covers when it goes idle; finishing
// pauses, resumes the one below with any result it is owed, then stops and destroys.
import { awaited, rt, JObj, noops, stubs, setDeclared, getDeclared, driven, type Gen } from "../../jvm/runtime";
import { after, newObj, vcall, scall, staticField } from "../../jvm/natives/jentry";
import { logUncaught, detached } from "../../jvm/natives/jthrowable";
import { once, shareable } from "../../jvm/suspend";
import { newArrayList } from "../../jvm/natives/jcoll";
import { configurations, resizeWindows, setClientVisible } from "./wm";
import { notifyDisplayChanged } from "../display";
import { asSystem, systemToken } from "../binder";
import { appHost } from "../apphost";
import { componentParts$, intentQuery$, mkComponentName, systemActivity, withComponent$, SYSTEM_ACTIVITY, type ComponentRef, type JIntent, type SystemHandler, type SystemResult } from "../intent";
import { grantResultUris } from "../urigrants";
import { attached, thisApp, userLaunched, pms, runsHere } from "./am";

const CT = "android/app/servertransaction/";
const PROCESS_STATE_TOP = 2, START_SUCCESS = 0, START_INTENT_NOT_RESOLVED = -1;
const GET_META_DATA = 0x80n, MATCH_DEFAULT_ONLY = 0x10000n;

/** a start in another process, and the result target there when it asked for one */
export type ResultDelivery = { caller: ComponentRef; deliver: (resultCode: number, data: JIntent | null) => void };
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
/** PackageManager.resolveIntent's activity */
function* resolveActivity(intent: JObj, resolvedType: string | null, flags: bigint): Gen<JObj | null> {
  const resolved = yield vcall(yield* awaited(pms()), "resolveIntent", "(Landroid/content/Intent;Ljava/lang/String;JI)Landroid/content/pm/ResolveInfo;", intent, resolvedType, flags, 0);
  return resolved && getDeclared<JObj | null>(resolved, "android/content/pm/ResolveInfo", "activityInfo");
}
const activityClientController = once(() => newObj("webdroid/ActivityClientController"));

function* transaction(app: JObj, callbacks: JObj | null | (JObj | null)[], lifecycle: JObj | null): Gen<JObj> {
  const tx = yield scall(CT + "ClientTransaction", "obtain", `(Landroid/app/IApplicationThread;)L${CT}ClientTransaction;`, app);
  for (const callback of [callbacks].flat()) if (callback) yield vcall(tx, "addCallback", `(L${CT}ClientTransactionItem;)V`, callback);
  if (lifecycle) yield vcall(tx, "setLifecycleStateRequest", `(L${CT}ActivityLifecycleItem;)V`, lifecycle);
  return tx;
}
const send = (app: JObj, tx: JObj) => vcall(app, "scheduleTransaction", `(L${CT}ClientTransaction;)V`, tx);
function* schedule(app: JObj, callbacks: JObj | null | (JObj | null)[], lifecycle: JObj | null): Gen<void> {
  yield send(app, yield* transaction(app, callbacks, lifecycle));
}
const item = (cls: string, desc: string, ...args: unknown[]) => scall(CT + cls, "obtain", `(${desc})L${CT}${cls};`, ...args);

const topResumedItem = (r: ActivityRecord, onTop: boolean) => item("TopResumedActivityChangeItem", "Landroid/os/IBinder;Z", r.token, +onTop);
/** pause the resumed activity and wait for the client to report it */
function pause(r: ActivityRecord): Promise<void> {
  if (r.pausing) return r.pausing.done;
  if (r.state !== "resumed") return Promise.resolve();
  r.state = "pausing";
  const reported = Promise.withResolvers<void>();
  // every pause of `r` waits on it
  const done = shareable(rt.drive(function* (): Gen<void> {
    yield* schedule(r.app, yield topResumedItem(r, false), yield pauseItem(r, r.finishing));
    yield reported.promise;
  }()));
  r.pausing = { done, settle: reported.resolve };
  return done;
}
/** pause the top activity until what is on top has paused: a start may push above it meanwhile */
function* pauseTop(): Gen<void> {
  for (let top = stack.at(-1); top && (top.state === "resumed" || top.pausing); top = stack.at(-1)) yield pause(top);
}
const settlePause = (r: ActivityRecord) => { r.pausing?.settle(); r.pausing = null; };
const pauseItem = (r: ActivityRecord, finishing = false) => item("PauseActivityItem", "Landroid/os/IBinder;ZZZZ", r.token, +finishing, 0, 0, 0);
const resumeItem = (r: ActivityRecord) => item("ResumeActivityItem", "Landroid/os/IBinder;ZZ", r.token, 1, 0);
function* resume(r: ActivityRecord): Gen<void> {
  const results = r.results.splice(0);
  r.state = "resumed";
  yield* setClientVisible(r.token, true);
  if (displayHooks.requestOrientation?.(orientationRequest())) yield configurationChanged();
  const top = yield topResumedItem(r, true);
  if (yield* ensureConfiguration(r, results, yield resumeItem(r), top)) return;
  const delivery = results.length ? yield item("ActivityResultItem", "Landroid/os/IBinder;Ljava/util/List;", r.token, yield newArrayList(results)) : null;
  yield* schedule(r.app, [delivery, top], yield resumeItem(r));
}

const CFG = "Landroid/content/res/Configuration;", CONFIG_WINDOW_CONFIGURATION = 0x20000000;
/** ActivityRecord.ensureActivityConfiguration: an activity that declared every changed bit in its
 *  configChanges hears the change; any other relaunches, ending at `lifecycle` with `results`
 *  delivered and `after` run. Returns whether it relaunched. */
function* ensureConfiguration(r: ActivityRecord, results: JObj[], lifecycle: JObj, after: JObj | null = null): Gen<boolean> {
  const { global, override } = yield* awaited(configurations());
  const diff: number = yield vcall(r.config, "diff", `(${CFG})I`, global);
  if (!diff) return false;
  r.config = global;
  // ActivityRecord.getConfigurationChanges: the window configuration (bounds, rotation) never relaunches
  const changes = diff & ~CONFIG_WINDOW_CONFIGURATION;
  const windowInfo = yield newObj("android/window/ActivityWindowInfo", "()V");
  if (!(changes & ~(yield vcall(r.info, "getRealConfigChanged", "()I")))) {
    yield* schedule(r.app, yield item("ActivityConfigurationChangeItem", `Landroid/os/IBinder;${CFG}Landroid/window/ActivityWindowInfo;`, r.token, override, windowInfo), null);
    return false;
  }
  const merged = yield newObj("android/util/MergedConfiguration", `(${CFG}${CFG})V`, global, override);
  yield* schedule(r.app, [yield item("ActivityRelaunchItem", "Landroid/os/IBinder;Ljava/util/List;Ljava/util/List;ILandroid/util/MergedConfiguration;ZLandroid/window/ActivityWindowInfo;",
    r.token, results.length ? yield newArrayList(results) : null, null, changes, merged, 1, windowInfo), after], lifecycle);
  return true;
}
/** the shell's display: turns it for the request orientationRequest finds, answering whether it turned */
export const displayHooks: { requestOrientation?: (request: number | null) => boolean } = {};
/** ActivityTaskManagerService.updateConfigurationLocked: the process hears the new configuration,
 *  then each visible activity (the others when they next resume), then each window its new frames */
export const configurationChanged = driven(function* (): Gen<void> {
  notifyDisplayChanged();
  // a process yet to attach reads the configuration as it binds
  if (attached()) {
    const { global } = yield* awaited(configurations());
    yield* schedule(thisApp(), yield item("ConfigurationChangeItem", `${CFG}I`, global, 0), null);
  }
  for (const r of [...stack]) {
    if (r.state === "resumed") yield* ensureConfiguration(r, [], yield resumeItem(r));
    else if (r.state === "paused") yield* ensureConfiguration(r, [], yield pauseItem(r));
  }
  yield resizeWindows();
});
/**
 * WindowContainer.getOrientation over this process's task: from the top, the first visible activity
 * that asks for an orientation or covers what is beneath it. Null when none does: every activity
 * here is stopped, or translucent over another process's activity, which then sets it.
 */
export function orientationRequest(records: readonly Pick<ActivityRecord, "orientation" | "translucent" | "state" | "finishing">[] = stack): number | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.finishing || r.state === "stopping" || r.state === "stopped" || r.state === "destroying") continue;
    if (r.orientation !== -1 || !r.translucent) return r.orientation;
  }
  return null;
}
function* stop(r: ActivityRecord): Gen<void> {
  if (r.state !== "paused") return;
  r.state = "stopping";
  yield* setClientVisible(r.token, false);
  yield* schedule(r.app, null, yield item("StopActivityItem", "Landroid/os/IBinder;", r.token));
}
/** take it off the stack, once, telling the broker what a remote caller is owed */
function* destroy(r: ActivityRecord): Gen<void> {
  const i = stack.indexOf(r);
  if (i < 0) return;
  stack.splice(i, 1);
  r.state = "destroying";
  reportPresentation();
  // a start waiting on its pause goes on: the report would find no record
  settlePause(r);
  if (r.remote) activityTransport.finished?.(r.remote.id, r.owed?.code ?? RESULT_CANCELED, r.owed?.data ?? null);
  yield* schedule(r.app, null, yield item("DestroyActivityItem", "Landroid/os/IBinder;Z", r.token, +r.finishing));
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
function* reuseActivity(intent: JObj, info: JObj): Gen<boolean> {
  const flags: number = yield vcall(intent, "getFlags", "()I"), mode = getDeclared<number>(info, AI, "launchMode");
  if ((flags & FLAG_CLEAR_TASK) && (flags & FLAG_NEW_TASK)) {
    yield* clearAbove(null);
    return false;
  }
  const name = getDeclared<string>(info, AI, "name");
  const existing = [...stack].reverse().find((r) => !r.finishing && getDeclared<string>(r.info, AI, "name") === name);
  if (!existing) return false;
  const singleTop = mode === LAUNCH_SINGLE_TOP || (flags & FLAG_SINGLE_TOP) !== 0;
  if (existing === stack.at(-1) && (singleTop || mode >= LAUNCH_SINGLE_TASK)) { yield* newIntent(existing, intent); return true; }
  if (mode >= LAUNCH_SINGLE_TASK || (flags & FLAG_ACTIVITY_CLEAR_TOP)) {
    // a standard activity under CLEAR_TOP without SINGLE_TOP is itself replaced by a new instance
    const reuse = mode !== LAUNCH_MULTIPLE || singleTop;
    yield* clearAbove(reuse ? existing : stack[stack.indexOf(existing) - 1] ?? null);
    if (reuse) yield* newIntent(existing, intent);
    return reuse;
  }
  if (flags & FLAG_REORDER_TO_FRONT) {
    const top = stack.at(-1)!;
    yield pause(top);
    stack.splice(stack.indexOf(existing), 1);
    stack.push(existing);
    existing.state = "paused";
    yield* newIntent(existing, intent);
    yield* resume(existing);
    return true;
  }
  return false;
}
/** finish every activity above `target` (all of them for null): those covered are destroyed, and
 *  the top finishes, resuming what is then below it; each owes its caller RESULT_CANCELED */
function* clearAbove(target: ActivityRecord | null): Gen<void> {
  const above = stack.slice(target ? stack.indexOf(target) + 1 : 0);
  for (const r of above.slice(0, -1)) {
    if (r.finishing) continue;
    r.finishing = true;
    yield* owedResult(r, RESULT_CANCELED, null);
    yield* destroy(r);
  }
  const top = above.at(-1);
  if (top) yield* finish(top, RESULT_CANCELED, null);
}
/** ActivityRecord.deliverNewIntentLocked: onNewIntent, around a temporary pause when resumed */
function* newIntent(r: ActivityRecord, intent: JObj): Gen<void> {
  const referrer = yield newObj("com/android/internal/content/ReferrerIntent", "(Landroid/content/Intent;Ljava/lang/String;)V", intent, appHost!.pkg);
  yield* schedule(r.app, yield item("NewIntentItem", "Landroid/os/IBinder;Ljava/util/List;Z", r.token, yield newArrayList([referrer]), +(r.state === "resumed")), null);
}

/** ActivityStarter: a resolved activity on top of this process's task, or the instance already there that takes the intent */
function* startActivity(app: JObj, intent: JObj, info: JObj, resultTo: ActivityRecord | null, resultWho: string | null, requestCode: number,
  remote: ActivityRecord["remote"] = null): Gen<void> {
  transitions++;
  try {
    if (yield* reuseActivity(intent, info)) return;
    const token = yield* awaited(systemToken());
    const orientation = getDeclared<number>(info, AI, "screenOrientation"), translucent = yield* translucentTheme(info);
    yield* pauseTop();
    // the display turns for the activity before it launches, so that it starts in that orientation
    if (displayHooks.requestOrientation?.(orientationRequest([...stack, { orientation, translucent, state: "launching", finishing: false }]))) yield configurationChanged();
    const { global, override } = yield* awaited(configurations());
    const windowInfo = yield newObj("android/window/ActivityWindowInfo", "()V");
    const launch = yield item("LaunchActivityItem",
      "Landroid/os/IBinder;Landroid/content/Intent;ILandroid/content/pm/ActivityInfo;Landroid/content/res/Configuration;Landroid/content/res/Configuration;" +
      "ILjava/lang/String;Lcom/android/internal/app/IVoiceInteractor;ILandroid/os/Bundle;Landroid/os/PersistableBundle;Ljava/util/List;Ljava/util/List;" +
      "Landroid/app/ActivityOptions$SceneTransitionInfo;ZLandroid/app/ProfilerInfo;Landroid/os/IBinder;Landroid/app/IActivityClientController;" +
      "Landroid/os/IBinder;ZLandroid/os/IBinder;Landroid/os/IBinder;Landroid/window/ActivityWindowInfo;",
      token, intent, stack.length + 1, info, global, override, 0, null, null, PROCESS_STATE_TOP, null, null, null, null, null, 1, null,
      yield newObj("android/os/Binder", "()V"), yield activityClientController(), yield newObj("android/os/Binder", "()V"), 0, null,
      yield newObj("android/os/Binder", "()V"), windowInfo);
    const r: ActivityRecord = { token, intent, info, app, state: "resumed", resultTo, resultWho, requestCode, results: [], finishing: false,
      translucent, pausing: null, owed: null, remote, config: global, orientation };
    const tx = yield* transaction(app, [launch, yield topResumedItem(r, true)], yield resumeItem(r));
    // a start that pushed while this one waited is on top now: AOSP's starts run one at a time, so it pauses too.
    // The launch is sent as it is pushed, so that a later start's pause of it reaches the client after it
    yield* pauseTop();
    stack.push(r);
    reportPresentation();
    yield send(app, tx);
  } finally { transitions--; }
}

const STYLEABLE = "com/android/internal/R$styleable";
/** the package's resources as AttributeCache reads them, through a package context of the system
 *  context: an activity may start before the Application exists */
const packageResources = once(driven(function* (): Gen<JObj> {
  const system = yield vcall(yield scall("android/app/ActivityThread", "currentActivityThread", "()Landroid/app/ActivityThread;"), "getSystemContext", "()Landroid/app/ContextImpl;");
  return yield vcall(yield vcall(system, "createPackageContext", "(Ljava/lang/String;I)Landroid/content/Context;", appHost!.pkg, 0), "getResources", "()Landroid/content/res/Resources;");
}));
/** ActivityRecord's occludesParent from the activity's theme: one translucent or floating, or showing
 *  the wallpaper, lets what is under it show */
function* translucentTheme(info: JObj): Gen<boolean> {
  const theme = yield vcall(yield* awaited(packageResources()), "newTheme", "()Landroid/content/res/Resources$Theme;");
  yield vcall(theme, "applyStyle", "(IZ)V", yield vcall(info, "getThemeResource", "()I"), 1);
  const a = yield vcall(theme, "obtainStyledAttributes", "([I)Landroid/content/res/TypedArray;", yield staticField(STYLEABLE, "Window"));
  try {
    return !!(yield scall(AI, "isTranslucentOrFloating", "(Landroid/content/res/TypedArray;)Z", a)) ||
      !!(yield vcall(a, "getBoolean", "(IZ)Z", yield staticField(STYLEABLE, "Window_windowShowWallpaper"), 0));
  } finally { yield vcall(a, "recycle", "()V"); }
}
/** the broker shows the process under this one while every activity here lets it show through */
const reportPresentation = () => activityTransport.presentation?.(stack.length > 0 && stack.every((r) => r.translucent));

/** the launcher activity of `pkg`, as the home screen starts it */
export const startMainActivity = driven(function* (app: JObj, pkg: string): Gen<void> {
  const intent = yield newObj("android/content/Intent", "(Ljava/lang/String;)V", "android.intent.action.MAIN");
  yield vcall(intent, "addCategory", "(Ljava/lang/String;)Landroid/content/Intent;", "android.intent.category.LAUNCHER");
  yield vcall(intent, "setPackage", "(Ljava/lang/String;)Landroid/content/Intent;", pkg);
  yield vcall(intent, "addFlags", "(I)Landroid/content/Intent;", 0x10200000);   // NEW_TASK | RESET_TASK_IF_NEEDED
  const info = yield* resolveActivity(intent, null, GET_META_DATA);
  if (!info) throw new Error(`no launcher activity in ${pkg}`);
  yield vcall(intent, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;",
    yield vcall(info, "getComponentName", "()Landroid/content/ComponentName;"));
  yield* startActivity(app, intent, info, null, null, -1);
});

const AI = "android/content/pm/ActivityInfo";
const isActivity = (info: JObj, ref: ComponentRef) => getDeclared<string>(info, AI, "packageName") === ref.pkg && getDeclared<string>(info, AI, "name") === ref.cls;
/** a resolved start: it runs here, or `remote`ly through the broker in the activity's own process */
type Start = { run: () => Gen<unknown>; remote: boolean };
/** ActivityStarter.execute up to the start itself: the resolved activity's start, or an error code */
function* resolveStart(app: JObj, intent: JObj, resolvedType: string | null, resultTo: JObj | null, resultWho: string | null, requestCode: number): Gen<Start | number> {
  const info = yield* resolveActivity(intent, resolvedType, MATCH_DEFAULT_ONLY | GET_META_DATA);
  // ActivityStarter keeps a result record only for a start for a result by an activity not finishing
  const source = byToken(resultTo), resultRecord = requestCode >= 0 && !source?.finishing ? source : null;
  const q = yield* intentQuery$(intent), system = systemActivity(q, false) ??
    (info && isActivity(info, { pkg: "android", cls: SYSTEM_ACTIVITY }) ? systemActivity(q) : null);
  if (system) return { run: () => runSystemActivity(system, intent, resultRecord, resultWho, requestCode), remote: false };
  if (!info) return START_INTENT_NOT_RESOLVED;
  const copy = yield* withComponent$(intent, yield vcall(info, "getComponentName", "()Landroid/content/ComponentName;"));
  const pkg = getDeclared<string>(info, AI, "packageName"), process = getDeclared<string>(info, AI, "processName");
  if (runsHere(pkg, process)) return { run: () => startActivity(app, copy, info, resultRecord, resultWho, requestCode), remote: false };
  const launch = activityTransport.launch;
  if (!launch) return START_INTENT_NOT_RESOLVED;
  return { remote: true, run: function* () {
    yield launch(pkg, process, getDeclared<string>(info, AI, "name").replaceAll(".", "/"), copy, resultRecord ? {
      caller: { pkg: appHost!.pkg, cls: getDeclared<string>(resultRecord.info, AI, "name") },
      deliver: (resultCode, data) => detached(() => asSystem(() => rt.drive(deliverResult(resultRecord, resultWho, requestCode, resultCode, data))), logUncaught),
    } : undefined);
  } };
}
/** runs `starts` in order off the caller: the pause a local start waits for runs on the caller's main thread,
 *  so the call returns once it is under way, as ActivityStarter returns once the pause is scheduled */
const detachStarts = (starts: Start[]) => detached(() => rt.drive(function* () { for (const start of starts) yield* start.run(); }()), logUncaught);
export const startActivityFor = driven(function* (app: JObj, intent: JObj, resolvedType: string | null = null, resultTo: JObj | null = null, resultWho: string | null = null, requestCode: number = -1): Gen<number> {
  transitions++;
  try {
    const start = yield* resolveStart(app, intent, resolvedType, resultTo, resultWho, requestCode);
    if (typeof start === "number") return start;
    if (start.remote) yield* start.run(); else detachStarts([start]);
    return START_SUCCESS;
  } finally { transitions--; }
});
/** ActivityStartController.startActivities: each intent resolved, then started in order, the last on top */
const startActivities = driven(function* (app: JObj, intents: JObj[], resolvedTypes: (string | null)[] | null, resultTo: JObj | null): Gen<number> {
  transitions++;
  try {
    const starts: Start[] = [];
    for (const [i, intent] of intents.entries()) {
      const start = yield* resolveStart(app, intent, resolvedTypes?.[i] ?? null, i ? null : resultTo, null, -1);
      if (typeof start === "number") return start;
      starts.push(start);
    }
    detachStarts(starts);
    return START_SUCCESS;
  } finally { transitions--; }
});
const RESULT_OK = -1;
/** an activity the platform package answers over the browser (DocumentsUI's pickers, share, the
 *  browser): it covers its caller, which resumes with any result it asked for */
function* runSystemActivity(run: SystemHandler, intent: JObj, resultTo: ActivityRecord | null, resultWho: string | null, requestCode: number): Gen<void> {
  let result: SystemResult = null;
  try { result = yield* awaited(run(intent)); } catch (error) { logUncaught(error); }
  const { resultCode, data } = result && "resultCode" in result ? result : { resultCode: result ? RESULT_OK : RESULT_CANCELED, data: result };
  yield* deliverResult(resultTo ?? stack.at(-1) ?? null, resultWho, requestCode, resultCode, data);
}
/** a result from an activity that covered `to` elsewhere (the browser, another process): the
 *  caller takes it as it resumes */
function* deliverResult(to: ActivityRecord | null, resultWho: string | null, requestCode: number, resultCode: number, data: JObj | null): Gen<void> {
  if (!to || to.finishing) return;
  if (resultCode === RESULT_OK && data) yield grantResultUris(appHost!.pkg, data);
  if (requestCode >= 0) to.results.push(yield newObj("android/app/ResultInfo", "(Ljava/lang/String;IILandroid/content/Intent;)V", resultWho, requestCode, resultCode, data));
  if (stack.at(-1) === to) yield coverTop();
}
/** the pause and resume a system window over the top activity leaves behind (a permission prompt) */
export const coverTop = driven(function* (): Gen<void> {
  const top = stack.at(-1);
  if (top?.state === "resumed") { yield pause(top); yield* resume(top); }
});
/** the broker's launch of one of this process's activities for another process */
export const startActivityInProcess = driven(function* (component: string, intent: JObj, remoteId: number, caller: ComponentRef | null): Gen<void> {
  const name = yield* awaited(mkComponentName(appHost!.pkg, component.replaceAll("/", ".")));
  const info = yield vcall(yield* awaited(pms()), "getActivityInfo", "(Landroid/content/ComponentName;JI)Landroid/content/pm/ActivityInfo;", name, GET_META_DATA, 0);
  if (!info) throw new Error("Activity not installed: " + component);
  yield vcall(intent, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", name);
  yield* startActivity(thisApp(), intent, info, null, null, -1, { id: remoteId, caller });
});
/** the broker showing or hiding this process: its top activity pauses, what is paused stops, and
 *  the top resumes (the launcher activity starts again in an emptied app process, as its icon
 *  would). Shown behind a translucent process, a stopped top starts again without resuming, as
 *  ActivityRecord.makeActiveIfNeeded does. */
export const taskVisibility = driven(function* (phase: "pause" | "stop" | "resume" | "visible"): Gen<void> {
  const top = stack.at(-1), pkg = appHost!.pkg;
  if (!top) { if (phase === "resume" && userLaunched()) yield startMainActivity(thisApp(), pkg); return; }
  if (phase === "pause") yield pause(top);
  else if (phase === "stop") for (const r of [...stack]) yield* stop(r);
  else if (phase === "resume" && top.state !== "resumed") yield* resume(top);
  else if (phase === "visible" && top.state === "stopped") {
    top.state = "paused";
    yield* setClientVisible(top.token, true);
    yield* schedule(top.app, null, yield item("StartActivityItem", "Landroid/os/IBinder;Landroid/app/ActivityOptions$SceneTransitionInfo;", top.token, null));
  }
});

/** the result a finishing activity owes the one that started it for one */
function* owedResult(r: ActivityRecord, resultCode: number, data: JObj | null): Gen<void> {
  r.owed = { code: resultCode, data };
  if (r.resultTo)
    r.resultTo.results.push(yield newObj("android/app/ResultInfo", "(Ljava/lang/String;IILandroid/content/Intent;)V", r.resultWho, r.requestCode, resultCode, data));
}
function* finish(r: ActivityRecord, resultCode: number, data: JObj | null): Gen<boolean> {
  transitions++;
  try {
    if (r.finishing) return true;
    r.finishing = true;
    yield* owedResult(r, resultCode, data);
    const covered = stack.slice(stack.indexOf(r) + 1).some((a) => !a.finishing);
    yield pause(r);
    // the top running activity resumes, skipping those still finishing (ActivityTaskSupervisor.topRunningActivity)
    const next = [...stack].reverse().find((a) => !a.finishing);
    if (!covered && next && next.state !== "resumed") yield* resume(next);
    yield* destroy(r);
    return true;
  } finally { transitions--; }
}

/** ActivityRecord.navigateUpTo: finish up to the nearest instance of the destination below, which
 *  gets the intent as a new one, or, a standard activity not asked to clear top, is replaced by a
 *  new instance; with none, only `r` finishes. Returns whether the destination was in the task. */
function* navigateUpTo(r: ActivityRecord, dest: JObj, resultCode: number, resultData: JObj | null): Gen<boolean> {
  const target = yield* componentParts$(yield vcall(dest, "getComponent", "()Landroid/content/ComponentName;"));
  const parent = target ? stack.slice(0, stack.indexOf(r)).reverse().find((p) => isActivity(p.info, target)) ?? null : null;
  const covered = parent ? stack.slice(stack.indexOf(parent) + 1, stack.indexOf(r)) : [];
  const reuse = parent && (getDeclared<number>(parent.info, AI, "launchMode") !== LAUNCH_MULTIPLE ||
    ((yield vcall(dest, "getFlags", "()I")) & FLAG_ACTIVITY_CLEAR_TOP) !== 0);
  const restarted = parent && !reuse && (yield* awaited(startActivityFor(r.app, dest))) === START_SUCCESS;
  detached(() => rt.drive(function* () {
    for (const c of covered) yield* finish(c, RESULT_CANCELED, null);
    if (reuse) yield* newIntent(parent!, dest);
    if (restarted) yield* finish(parent!, resultCode, resultData);
    yield* finish(r, resultCode, resultData);
  }()), logUncaught);
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
  "activityIdle(Landroid/os/IBinder;Landroid/content/res/Configuration;Z)V": driven(function* (token: JObj) {
    const r = byToken(token);
    if (!r || r.translucent) return;
    for (const below of stack.slice(0, stack.indexOf(r))) yield* stop(below);
  }),
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
    detached(() => rt.drive(finish(r, resultCode, data)), logUncaught);
    return 1;
  },
  "navigateUpTo(Landroid/os/IBinder;Landroid/content/Intent;Ljava/lang/String;ILandroid/content/Intent;)Z":
    driven(function* (token: JObj, dest: JObj, _type: string | null, resultCode: number, data: JObj | null) {
      const r = byToken(token);
      return r ? +(yield* navigateUpTo(r, dest, resultCode, data)) : 0;
    }),
  // the task's affinity is its root activity's
  "shouldUpRecreateTask(Landroid/os/IBinder;Ljava/lang/String;)Z": (token: JObj, affinity: string | null) =>
    +(!!byToken(token) && getDeclared<string | null>(stack[0].info, AI, "taskAffinity") !== affinity),
  // Task.finishActivityAffinity: it and the activities directly below it that share its affinity
  "finishActivityAffinity(Landroid/os/IBinder;)Z": (token: JObj) => {
    const r = byToken(token);
    if (!r) return 0;
    const affinity = getDeclared<string | null>(r.info, AI, "taskAffinity"), doomed: ActivityRecord[] = [];
    for (let i = stack.indexOf(r); i >= 0 && getDeclared<string | null>(stack[i].info, AI, "taskAffinity") === affinity; i--) doomed.push(stack[i]);
    detached(() => rt.drive(function* () { for (const d of doomed.reverse()) yield* finish(d, RESULT_CANCELED, null); }()), logUncaught);
    return 1;
  },
  // back on a root activity: AOSP moves a launcher-started task back; one task, so it finishes
  "onBackPressed(Landroid/os/IBinder;Landroid/app/IRequestFinishCallback;)V": (_token: JObj, callback: JObj) =>
    vcall(callback, "requestFinish", "()V"),
  "getCallingActivity(Landroid/os/IBinder;)Landroid/content/ComponentName;": driven(callingActivity),
  "getCallingPackage(Landroid/os/IBinder;)Ljava/lang/String;": driven(function* (token: JObj) {
    const c = yield* callingActivity(token);
    return c && (yield vcall(c, "getPackageName", "()Ljava/lang/String;"));
  }),
  "getTaskForActivity(Landroid/os/IBinder;Z)I": (token: JObj) => byToken(token) ? TASK_ID : -1,
  "isTopOfTask(Landroid/os/IBinder;)Z": (token: JObj) => +(stack.at(-1)?.token === token),
  "getDisplayId(Landroid/os/IBinder;)I": () => 0,
  "getRequestedOrientation(Landroid/os/IBinder;)I": (token: JObj) => byToken(token)?.orientation ?? -1,
  "setRequestedOrientation(Landroid/os/IBinder;I)V": (token: JObj, orientation: number) => {
    const r = byToken(token);
    if (!r || r.orientation === orientation) return;
    r.orientation = orientation;
    if (displayHooks.requestOrientation?.(orientationRequest())) detached(configurationChanged, logUncaught);
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
function* callingActivity(token: JObj): Gen<JObj | null> {
  const r = byToken(token), caller = r?.remote?.caller;
  return r?.resultTo ? component(r.resultTo) : caller ? mkComponentName(caller.pkg, caller.cls) : null;
}
// IAppTask: this process's one task
const TASK_ID = 1;
const component = (r: ActivityRecord | undefined) => r ? vcall(r.info, "getComponentName", "()Landroid/content/ComponentName;") : null;
// Task.RemoteToken: every TaskInfo carries it, and TaskInfo.writeToParcel writes it unchecked
rt.register({ name: "webdroid/TaskToken", ctor: class extends JObj {}, sup: "android/window/IWindowContainerToken$Stub", methods: {} });
const taskToken = once(() => after(newObj("webdroid/TaskToken"), (token) => newObj("android/window/WindowContainerToken", "(Landroid/window/IWindowContainerToken;)V", token)));
rt.register({ name: "webdroid/AppTask", ctor: class extends JObj {}, sup: "android/app/IAppTask$Stub", methods: {
  "getTaskInfo()Landroid/app/ActivityManager$RecentTaskInfo;": driven(function* () {
    const info = yield newObj("android/app/ActivityManager$RecentTaskInfo"), base = yield component(stack[0]);
    return setDeclared(info, "android/app/ActivityManager$RecentTaskInfo", {
      id: TASK_ID, persistentId: TASK_ID, taskId: TASK_ID, numActivities: stack.length, isRunning: +(stack.length > 0), token: yield taskToken(),
      baseIntent: stack[0]?.intent ?? null, baseActivity: base, realActivity: base, topActivity: yield component(stack.at(-1)) });
  }),
  "finishAndRemoveTask()V": () => detached(() => rt.drive(clearAbove(null)), logUncaught),
  // one task is shown at a time, and there are no recents to exclude it from
  ...noops("moveToFront(Landroid/app/IApplicationThread;Ljava/lang/String;)V", "setExcludeFromRecents(Z)V"),
} });
const appTask = once(() => newObj("webdroid/AppTask"));

/** the methods IActivityTaskManager adds for ActivityThread's activities */
export const activityTaskMethods = {
  "getAppTasks(Ljava/lang/String;)Ljava/util/List;": () => stack.length ? after(appTask(), (task) => newArrayList([task])) : newArrayList([]),
  "getActivityClientController()Landroid/app/IActivityClientController;": activityClientController,
  // nothing captures the screen, so a screen-capture observer is never called
  ...noops("registerScreenCaptureObserver(Landroid/os/IBinder;Landroid/app/IScreenCaptureObserver;)V",
    "unregisterScreenCaptureObserver(Landroid/os/IBinder;Landroid/app/IScreenCaptureObserver;)V"),
  "startActivity(Landroid/app/IApplicationThread;Ljava/lang/String;Ljava/lang/String;Landroid/content/Intent;Ljava/lang/String;Landroid/os/IBinder;Ljava/lang/String;IILandroid/app/ProfilerInfo;Landroid/os/Bundle;)I":
    (app: JObj, _pkg: string, _feature: string, intent: JObj, resolvedType: string | null, resultTo: JObj | null, resultWho: string | null, requestCode: number) =>
      startActivityFor(app, intent, resolvedType, resultTo, resultWho, requestCode),
  "startActivities(Landroid/app/IApplicationThread;Ljava/lang/String;Ljava/lang/String;[Landroid/content/Intent;[Ljava/lang/String;Landroid/os/IBinder;Landroid/os/Bundle;I)I":
    (app: JObj, _pkg: string, _feature: string, intents: JObj[], resolvedTypes: (string | null)[] | null, resultTo: JObj | null) =>
      startActivities(app, intents, resolvedTypes, resultTo),
};
