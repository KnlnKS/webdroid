// The app's activity stack: launches (with their launch modes), the lifecycle transitions,
// relaunches for configuration changes, finishing, and the task's place behind the home screen.

import { rt, type Gen, driven } from "../jvm/runtime";
import { vcall, callOn, curThread, mainThread, setCurThread } from "../jvm/natives/jlang";
import { jclsNameOf, type AppHost, type ActivityLaunch } from "../android/apphost";
import { manifestActivityTheme, manifestActivityOrientation, manifestLaunchMode, manifestTaskAffinity } from "../android/pm";
import { JIntent, deliverActivityResult, activityTransport, mkComponentName } from "../android/intent";
import { ensureDecor, startingWindow } from "../android/decor";
import { getInflater } from "../android/inflate";
import { JActivity, fireActivityLifecycle } from "../android/app";
import { JMenu, pushMenuToBar } from "../android/menu";
import { newContextImpl } from "../android/context";
import { reportUncaught, JBundle } from "../android/os";
import { onMain, inMainJob } from "../android/mainloop";
import { JView, uiState, requestLayoutAll, dispatchAttached, dispatchDetached } from "../android/view";
import { detachContextOverlays } from "../android/popup";
import { setGuestTimeout } from "../guest-clock";
import { affinityRun } from "./activitytasks";
import { applyOrientationRequest } from "./device";

export interface BootedApp {
  host: AppHost;
  mainActivityCls: string;
  stack: JActivity[];
  label: string;
  /** moveTaskToBack put the task behind the home screen */
  background: boolean;
}
export let booted: BootedApp | null = null;
export function setBootedApp(app: BootedApp): void { booted = app; }
/** <activity-alias> component name → the Activity class that actually runs */
export const aliasTargets = new Map<string, string>();

export const invalidateWindow = () => {
  uiState.needsLayout = uiState.needsDraw = uiState.needsInsets = true;
  activityTransport.presentation?.(!!booted?.stack.length && booted.stack.every(act => act.window.translucent));
};
export function visibleActivities(): JActivity[] {
  const stack = booted?.stack ?? [];
  let first = stack.length - 1;
  while (first > 0 && stack[first].window.translucent) first--;
  return first > 0 ? stack.slice(first) : stack;
}

/** AOSP's starting window: the system's, painted from the package's theme before the app has
 *  run. It is not the app drawing, so it deliberately does not count in perf.draws — corpus
 *  reads that to mean "this apk got far enough to render", and it must keep meaning it. */
export let startWin: { view: JView; fullscreen: boolean } | null = null;
export function dropStartingWindow(): void { startWin = null; }

/** what the launcher sends when the app's icon is tapped */
export function launchMain(): Promise<void> {
  if (!booted?.mainActivityCls) return Promise.resolve();
  const intent = new JIntent();
  intent.action = "android.intent.action.MAIN";
  intent.categories.add("android.intent.category.LAUNCHER");
  intent.component = booted.mainActivityCls.replaceAll("/", ".");
  intent.componentPkg = booted.host.pkg;
  intent.flags = 0x10000000;
  return launchActivity(booted.mainActivityCls, intent);
}
function launchActivity(cls: string, intent: JIntent | null, options?: ActivityLaunch): Promise<void> {
  // Startup and Java callbacks already hold the main queue; queuing again would deadlock.
  const run = () => callOn(mainThread, async () => {
    if (!await reuseActivity(cls, intent, options)) await launchActivity0(cls, intent, undefined, options);
  });
  return inMainJob() ? run() : onMain(run);
}
const FLAG_ACTIVITY_CLEAR_TASK = 0x8000, FLAG_ACTIVITY_CLEAR_TOP = 0x4000000, FLAG_ACTIVITY_NEW_TASK = 0x10000000, FLAG_ACTIVITY_SINGLE_TOP = 0x20000000;
const LAUNCH_SINGLE_TOP = 1, LAUNCH_SINGLE_TASK = 2;
/** ActivityStarter's reuse rules within this process's stack: launchMode and the CLEAR_TASK,
 *  CLEAR_TOP and SINGLE_TOP flags either clear activities off the task or route the intent to an
 *  existing instance through onNewIntent. True when no new instance should be created. */
const reuseActivity = driven(function* reuseActivity(component: string, intent: JIntent | null, options?: ActivityLaunch): Gen<boolean> {
  if (!booted || options?.remoteId || options?.result) return false;
  const stack = booted.stack, flags = intent?.flags ?? 0;
  // an <activity-alias> launches in its target's launch mode, as the package parser copies it
  const cls = aliasTargets.get(component) ?? component, mode = manifestLaunchMode(cls);
  const top = stack.at(-1);
  if (flags & FLAG_ACTIVITY_CLEAR_TASK && flags & FLAG_ACTIVITY_NEW_TASK) {
    for (const act of stack.filter((a) => a.taskId === top?.taskId).reverse()) yield finishActivity(act, false);
    return false;
  }
  const name = cls.replace(/\//g, ".");
  let i = stack.length - 1;
  while (i >= 0 && (stack[i].finished || jclsNameOf(stack[i]) !== name)) i--;
  if (i < 0) return false;
  if (mode >= LAUNCH_SINGLE_TASK || flags & FLAG_ACTIVITY_CLEAR_TOP) {
    for (const above of stack.slice(i + 1).reverse()) yield finishActivity(above, false);
    // a standard activity under CLEAR_TOP alone is itself finished and created afresh
    if (!mode && !(flags & FLAG_ACTIVITY_SINGLE_TOP)) { yield finishActivity(stack[i], false); return false; }
  } else if (!(mode === LAUNCH_SINGLE_TOP || flags & FLAG_ACTIVITY_SINGLE_TOP) || stack[i] !== top) return false;
  // an activity never receives a new intent while resumed: onPause, onNewIntent, then back up
  const act = stack[i];
  if (act.resumed) { yield pauseActivity(act); yield windowFocus(act, false); }
  yield safeCall(act, "onNewIntent", "(Landroid/content/Intent;)V", intent);
  yield resumeTop(act);
  invalidateWindow();
  return true;
});
const launchActivity0 = driven(function* launchActivity0(component: string, intent: JIntent | null, relaunch?: Relaunch, options?: ActivityLaunch): Gen {
  if (!booted) return;
  const host = booted.host;
  const cls = aliasTargets.get(component) ?? component;
  const requestedOrientation = relaunch?.requestedOrientation ?? manifestActivityOrientation(cls);
  applyOrientationRequest(requestedOrientation);
  // AOSP puts a window up from the package's own theme before the process has run a line, and
  // it stands until the activity's decor draws. That is why a launch that dies on the way up
  // still leaves a frame on a device, and it is the frame this shows.
  if (!booted.stack.length) {
    try {
      startWin = yield startingWindow(host, cls);
      uiState.needsDraw = true;
    } catch (e) { console.warn("[starting window]", e); }
  }
  // Linking, <clinit> and construction are the app's code too: a static initializer that
  // throws (System.loadLibrary in one is enough) crashes the activity, exactly as on a device.
  // It must not take the boot down with it.
  let act: JActivity;
  try {
    const info = rt.link(cls);
    const p = rt.initClass(info);
    if (p) yield p;
    act = new info.ctor();
  } catch (e) {
    reportUncaught(e);
    if (options?.remoteId) throw e;
    return;
  }
  act.$host = host;
  act.callingActivity = options?.caller ? mkComponentName(options.caller.pkg, options.caller.cls) : null;
  act.resultTo = options?.result ?? null;
  act.remoteId = options?.remoteId ?? 0;
  act.activityId = options?.activityId ?? 0; act.taskId = options?.taskId ?? 0;
  if (!act.activityId) {
    const previous = booted.stack.at(-1);
    activityTransport.attach?.(act, options?.taskId ?? (intent && intent.flags & 0x10000000 ? 0 : previous?.taskId ?? 0), manifestTaskAffinity(cls));
  }
  act.requestedOrientation = requestedOrientation;
  act.lastNonConfig = relaunch?.nonConfig ?? null;
  const saved = relaunch?.state ?? null;
  try {
    yield vcall(act, "<init>", "()V");
    // Activity.attach(): the base context arrives before the manifest theme, which AOSP applies
    // before onCreate so an app's own setTheme layers on top of it rather than replacing it
    const baseCtx = newContextImpl(host);
    yield vcall(act, "attachBaseContext", "(Landroid/content/Context;)V", baseCtx);
    const actTheme = manifestActivityTheme(cls);
    if (actTheme) yield vcall(act, "setTheme", "(I)V", actTheme);
    act.window.activity = act;
    getInflater(act).privateFactory = act;
    act.intent = intent;
    const prev = booted.stack.at(-1);
    if (prev?.resumed) { yield pauseActivity(prev); yield windowFocus(prev, false); }
    booted.stack.push(act);
    yield safeCall(act, "onCreate", "(Landroid/os/Bundle;)V", saved);
    // onCreate may set the window theme before its first getDecorView/setContentView.
    yield ensureDecor(act);
    yield fireActivityLifecycle(act, "Created", saved);
    // Android dispatches onAttachedToWindow after onCreate, before onStart, even if a later
    // lifecycle callback throws.
    if (act.window.decor) yield dispatchAttached(act.window.decor);
    yield lifecycleStep(act, "onStart", "Started");
    yield safeCall(act, "onPostCreate", "(Landroid/os/Bundle;)V", saved);
    yield lifecycleStep(act, "onResume", "Resumed");
    yield safeCall(act, "onPostResume");
    yield windowFocus(act, true);
    // AOSP stops the covered activity only once the new one is up
    if (!act.window.translucent) {
      for (const covered of booted.stack.slice(0, -1)) if (covered.started) yield stopActivity(covered);
    }
    requestOptionsMenu(act);
    invalidateWindow();
  } catch (e) {
    reportUncaught(e);
  }
});

interface Relaunch { state: JBundle | null; nonConfig: unknown; requestedOrientation: number }

/** An undeclared configuration change relaunches the activity: AOSP saves the instance state and
 *  the non-configuration instance, tears it down, then starts a fresh one with both. */
export function recreateActivity(act: JActivity): void {
  const cls = (act.constructor as any)?.$i?.name as string | undefined;
  if (!cls || !booted || booted.stack.indexOf(act) < 0) return;
  // AOSP's recreate() only schedules the relaunch; running it nested inside the caller's own
  // main-looper job (a click handler) would tear the activity down underneath it.
  setGuestTimeout(() => void onMain(async () => {
    if (!booted) return;
    const i = booted.stack.indexOf(act);
    if (i < 0) return;
    const prev = curThread;
    setCurThread(mainThread);
    // androidx keeps the ViewModelStore only while the activity says it is changing config.
    act.changingConfigurations = true;
    const state = new JBundle();
    let nonConfig: unknown = null;
    try {
      try {
        if (act.resumed) { await vcall(act, "onPause", "()V"); await fireActivityLifecycle(act, "Paused"); }
        await windowFocus(act, false);
        await vcall(act, "onSaveInstanceState", "(Landroid/os/Bundle;)V", state);
        if (act.window.decor) await dispatchDetached(act.window.decor);
        await vcall(act, "onStop", "()V");
        await fireActivityLifecycle(act, "Stopped");
        nonConfig = await vcall(act, "onRetainNonConfigurationInstance", "()Ljava/lang/Object;");
        await vcall(act, "onDestroy", "()V");
        await fireActivityLifecycle(act, "Destroyed");
      } catch (e) { reportUncaught(e); }
      await detachContextOverlays(act);
      booted.stack.splice(i, 1);
      const options = { caller: act.callingActivity, result: act.resultTo ?? undefined, remoteId: act.remoteId, activityId: act.activityId, taskId: act.taskId };
      act.remoteId = 0;
      await launchActivity0(cls, act.intent, { state, nonConfig, requestedOrientation: act.requestedOrientation }, options);
      requestLayoutAll();
    } catch (e) { reportUncaught(e); }
    finally { setCurThread(prev); }
  }), 0);
}

const safeCall = driven(function* safeCall(act: JActivity, method: string, desc: string = "()V", ...args: unknown[]): Gen {
  try { yield vcall(act, method, desc, ...args); } catch (e) { reportUncaught(e); }
});
const lifecycleStep = driven(function* lifecycleStep(act: JActivity, method: string, phase: Parameters<typeof fireActivityLifecycle>[1]): Gen {
  yield safeCall(act, method);
  yield fireActivityLifecycle(act, phase);
});
const pauseActivity = (act: JActivity) => lifecycleStep(act, "onPause", "Paused");
const stopActivity = (act: JActivity) => lifecycleStep(act, "onStop", "Stopped");
/** Returning to a covered activity: onRestart → onStart → onResume → onPostResume, with the
 *  ActivityLifecycleCallbacks a fresh launch fires. */
const resumeActivity = driven(function* resumeActivity(act: JActivity): Gen {
  yield startActivity(act);
  if (!act.resumed) yield lifecycleStep(act, "onResume", "Resumed");
  yield safeCall(act, "onPostResume");
});
const startActivity = driven(function* startActivity(act: JActivity): Gen {
  if (!act.started) {
    yield safeCall(act, "onRestart");
    yield lifecycleStep(act, "onStart", "Started");
  }
});
const resumeTop = driven(function* resumeTop(top: JActivity): Gen {
  applyOrientationRequest(top.requestedOrientation);
  for (const act of visibleActivities()) if (act !== top) yield startActivity(act);
  yield resumeActivity(top);
  yield windowFocus(top, true);
  requestOptionsMenu(top);
});
/** ViewRootImpl reports window focus once the resumed activity's window is up and takes it
 *  away when another window covers it; only a change is delivered. */
const windowFocus = driven(function* windowFocus(act: JActivity, has: boolean): Gen {
  if (act.hasWindowFocus === has) return;
  act.hasWindowFocus = has;
  const z = has ? 1 : 0;
  try {
    yield vcall(act, "onWindowFocusChanged", "(Z)V", z);
    if (act.window.decor) yield vcall(act.window.decor, "dispatchWindowFocusChanged", "(Z)V", z);
  } catch (e) { reportUncaught(e); }
});

const finishActivity = driven(function* finishActivity(act: JActivity, resume: boolean = true): Gen {
  if (!booted) return;
  const i = booted.stack.indexOf(act);
  if (i < 0) return;
  booted.stack.splice(i, 1);
  act.finished = true;
  if (act.resumed) yield pauseActivity(act);
  yield windowFocus(act, false);
  const remote = activityTransport.finish?.(act) ?? false;
  const top = booted.stack.at(-1);
  if (top && !top.finished && !remote && resume) yield resumeTop(top);
  // AOSP hands the result to the launcher once it is back up, before the finished instance dies.
  if (act.resultTo) deliverActivityResult(act.resultTo.act, act.resultTo.code, act.resultCode, act.resultData);
  if (act.window.decor) yield dispatchDetached(act.window.decor);
  if (act.started) yield stopActivity(act);
  yield lifecycleStep(act, "onDestroy", "Destroyed");
  yield detachContextOverlays(act);
  invalidateWindow();
});

/** the broker has already dropped a removed task's records */
export const finishTask = (taskId: number, resume: boolean) => finishActivities(() => booted?.stack.filter(a => a.taskId === taskId) ?? [], resume, true);
export const finishActivityIds = (ids: number[], resume: boolean) => finishActivities(() => booted?.stack.filter(a => ids.includes(a.activityId)) ?? [], resume, false);
/** a process of its own (no broker) walks its own stack */
function localAffinityGroup(act: JActivity): JActivity[] {
  const task = booted?.stack.filter(a => a.taskId === act.taskId) ?? [];
  return affinityRun(task, task.indexOf(act), a => manifestTaskAffinity(jclsNameOf(a))).reverse();
}
function finishActivities(select: () => JActivity[], resume: boolean, removedTask: boolean): Promise<void> {
  return onMain(async () => {
    const activities = select();
    for (const act of activities) {
      act.finished = true;
      // finishActivityAffinity finishes each with RESULT_CANCELED
      if (removedTask) act.remoteId = 0; else { act.resultCode = 0; act.resultData = null; }
    }
    for (const act of activities.reverse()) await finishActivity(act, false);
    const top = booted?.stack.at(-1);
    if (resume && top) await resumeTop(top);
  });
}

/** Home is showing: the last activity finished, or the task was moved to the back. */
export const atHome = () => !!booted?.mainActivityCls && (!booted.stack.length || booted.background);
async function sendTaskToBack(): Promise<void> {
  if (!booted || booted.background) return;
  booted.background = true;
  await activityVisibility0("pause");
  await activityVisibility0("stop");
  uiState.needsDraw = true;
}
export function activityVisibility(phase: "pause" | "stop" | "resume" | "visible"): Promise<void> {
  return onMain(() => activityVisibility0(phase));
}
export async function activityVisibility0(phase: "pause" | "stop" | "resume" | "visible"): Promise<void> {
  if (phase === "resume" && booted) booted.background = false;
  const act = booted?.host.currentActivity();
  // returning to an app whose last activity finished starts it again, as its icon would
  if (!act) { if (phase === "resume") await launchMain(); return; }
  if (phase === "pause") {
    if (act.resumed) await pauseActivity(act);
    await windowFocus(act, false);
  } else if (phase === "stop") {
    for (const covered of booted!.stack) if (covered.started) await stopActivity(covered);
  } else {
    for (const visible of visibleActivities()) await startActivity(visible);
    if (phase === "resume") {
      await resumeActivity(act);
      await windowFocus(act, true);
    }
    uiState.needsLayout = uiState.needsDraw = true;
  }
}

const menuRebuilds = new WeakSet<JActivity>();
/** PhoneWindow's invalidatePanelMenu: one rebuild however often it is asked, as a later main-thread
 *  job; menu inflation loads drawables, which must not interleave with another load on the thread */
function requestOptionsMenu(a: JActivity): void {
  if (menuRebuilds.has(a)) return;
  menuRebuilds.add(a);
  void onMain(() => { menuRebuilds.delete(a); return buildOptionsMenu(a); });
}
const buildOptionsMenu = driven(function* buildOptionsMenu(act: JActivity): Gen {
  if (!act.window.actionBarView) return;
  const menu = new JMenu();
  menu.bar = act.window.actionBarView;
  act.optionsMenu = menu;
  try {
    yield vcall(act, "onCreatePanelMenu", "(ILandroid/view/Menu;)Z", 0, menu);
    yield vcall(act, "onPreparePanel", "(ILandroid/view/View;Landroid/view/Menu;)Z", 0, null, menu);
  } catch (e) { reportUncaught(e); }
  pushMenuToBar(menu);
});

/** The AppHost entry points the activity stack answers. */
export const activityHost: Pick<AppHost, "launch" | "finishActivity" | "roundTrip" | "recreateActivity" | "moveTaskToBack"
  | "currentActivity" | "activities" | "finishTask" | "finishAffinity" | "invalidateOptionsMenu"> = {
  launch: async (component, intent, options) => { await launchActivity(component, intent, options); },
  // finish() only requests: AOSP delivers the pause/stop/destroy chain as later main-thread
  // messages, so it queues as a main job rather than running detached alongside the caller
  finishActivity: (a) => { void onMain(() => finishActivity(a)); },
  roundTrip: async (a) => {
    if (a.resumed) { await pauseActivity(a); await windowFocus(a, false); }
    await resumeActivity(a);
    await windowFocus(a, true);
  },
  recreateActivity: (a) => { recreateActivity(a); },
  moveTaskToBack: () => { void onMain(sendTaskToBack); },
  currentActivity: () => booted?.stack.at(-1) ?? null,
  activities: () => booted?.stack.slice() ?? [],
  finishTask: (taskId) => { void finishTask(taskId, true); },
  finishAffinity: (a) => {
    if (activityTransport.finishAffinity) activityTransport.finishAffinity(a);
    else void finishActivities(() => localAffinityGroup(a), true, false);
  },
  invalidateOptionsMenu: requestOptionsMenu,
};
