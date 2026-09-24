import { JContextWrapper, JAttributionSource, systemService, wrapperMethods, display, displayListeners, grantPermissions } from "./context";
import { JWindow } from "./window";
import {
  JIntent, activityTransport, systemActivities, deliverActivityResult, RESULT_OK, RESULT_CANCELED, launchIntent, mkComponentName,
  type JComponentName
} from "./intent";
import { type JMenu, JMenuInflater, type JMenuItem, ID_HOME, showMenuPopup, barAnchor } from "./menu";
import { jarray } from "../jvm/abi";
import { reportUncaught, JBundle, PARCELABLE, PROCESS_PID, PROCESS_UID, PROCESS_NAME } from "./os";
import { type NativeSpec, rt, callSelf, JObj, stubs, noops, fieldGetters, flagGetters, fieldSetters } from "../jvm/runtime";
import { getInflater, inflateLayout } from "./inflate";
import { ensureDecor } from "./decor";
import { requestLayout, type JView, attachView, detachView, findById, requireViewById, dispatchConfigurationChanged, invalidate } from "./view";
import { dispatchFragLifecycle, type JFragment, type JFragmentManager } from "./fragment";
import { vcall, vcallOn, curThread } from "../jvm/natives/jlang";
import type { JMotionEvent } from "./motionevent";
import { appHost, jclsNameOf } from "./apphost";
import { resString } from "./res";
import { onMain } from "./mainloop";
import { getPrefs } from "./sharedprefs";
import { csText, spannedString } from "./text";
import { showToast } from "./popup";
import { newArrayList } from "../jvm/natives/jutil";
import { type JIntentSender, startIntentSender } from "./pendingintent";
import { JService, runningServices, svcStop, svcFg } from "./runningservices";
import { isMusicActive, outputSampleRate, newAudioSessionId, JSpatializer } from "./media";
import { device } from "../shell/config";
import type { JBitmap } from "./graphics";
import { JConfigurationInfo } from "./pm";
import { deviceConfiguration } from "./resnative";
import { transactionCaller } from "./binder";
import { packages } from "./packages";
import { lifecycleCallbackMethods, type ActivityLifecycleCallback } from "./lifecycle";
import { clipboardMethods } from "./clipboard";

export { fireActivityLifecycle } from "./lifecycle";

rt.markers("android/bluetooth/BluetoothProfile$ServiceListener");

class JTaskDescription extends JObj {
  label: string | null = null;
  icon: JBitmap | null = null;
  iconResource = 0;
  primaryColor = 0;
  init(label: string | null, icon: JBitmap | number | null, color: number): void {
    if (color !== 0 && (color >>> 24) !== 255) throw rt.mkThrowable("java/lang/IllegalArgumentException", "primary color must be opaque");
    this.label = label; this.primaryColor = color;
    this.icon = typeof icon === "number" ? null : icon;
    this.iconResource = typeof icon === "number" ? icon : 0;
  }
}
rt.register({
  name: "android/app/ActivityManager$TaskDescription", ctor: JTaskDescription, ifaces: ["android/os/Parcelable"],
  methods: {
    "<init>(Ljava/lang/String;II)V": function (this: JTaskDescription, label: string | null, icon: number, color: number) { this.init(label, icon, color); },
    "<init>(Ljava/lang/String;Landroid/graphics/Bitmap;I)V": function (this: JTaskDescription, label: string | null, icon: JBitmap | null, color: number) { this.init(label, icon, color); },
    ...fieldGetters({ "getLabel()Ljava/lang/String;": "label", "getIcon()Landroid/graphics/Bitmap;": "icon",
      "getIconResource()I": "iconResource", "getPrimaryColor()I": "primaryColor" }),
  },
});
class JActivityOptions extends JObj {
  animationType = -1;
  packageName: string | null = null;
  bounds: number[] | null = null;
}
const boundsAnimation = (type: 2 | 11) => async (view: JView, x: number, y: number, width: number, height: number) => {
  const options = new JActivityOptions();
  if (type === 2) {
    const context = await vcall(view, "getContext", "()Landroid/content/Context;");
    options.packageName = await vcall(context, "getPackageName", "()Ljava/lang/String;");
  }
  const location = new Int32Array(2);
  await vcall(view, "getLocationOnScreen", "([I)V", location);
  options.animationType = type;
  options.bounds = [location[0] + x, location[1] + y, width, height];
  return options;
};
rt.register({
  name: "android/app/ActivityOptions", ctor: JActivityOptions,
  methods: {
    "static makeScaleUpAnimation(Landroid/view/View;IIII)Landroid/app/ActivityOptions;": boundsAnimation(2),
    "static makeClipRevealAnimation(Landroid/view/View;IIII)Landroid/app/ActivityOptions;": boundsAnimation(11),
    "static makeBasic()Landroid/app/ActivityOptions;": () => new JActivityOptions(),
    "static makeSceneTransitionAnimation(Landroid/app/Activity;[Landroid/util/Pair;)Landroid/app/ActivityOptions;": (activity: JActivity) => {
      if (!activity) return rt.npe();
      if (activity.window.features.has(13)) throw rt.unimplemented("ActivityOptions shared element transitions");
      const options = new JActivityOptions(); options.animationType = 6; return options;
    },
    "toBundle()Landroid/os/Bundle;": function (this: JActivityOptions) {
      const bundle = new JBundle();
      if (this.packageName !== null) bundle.map.set("android:activity.packageName", this.packageName);
      if (this.animationType !== -1) bundle.map.set("android:activity.animType", this.animationType);
      if (this.bounds) for (const [i, key] of ["animStartX", "animStartY", "animWidth", "animHeight"].entries())
        bundle.map.set("android:activity." + key, this.bounds[i]);
      return bundle;
    },
  },
});
rt.register({
  name: "android/app/Instrumentation", ctor: class extends JObj {},
  methods: { "<init>()V": function () {} },
});
export class JActivity extends JContextWrapper {
  window = new JWindow();
  intent: JIntent | null = null;
  titleStr = "";
  taskDescription: JTaskDescription | null = null;
  finished = false;
  resumed = false;
  started = false;
  hasWindowFocus = false;
  actionBarObj: any = null;
  optionsMenu: JMenu | null = null;
  resultCode = 0;
  resultData: JIntent | null = null;
  /** who asked for this activity's result, and under which request code */
  resultTo: { act: JActivity; code: number } | null = null;
  callingActivity: JComponentName | null = null;
  remoteId = 0;
  activityId = 0;
  taskId = 0;
  lifecycleCbs: ActivityLifecycleCallback[] | null = null;
  fragMgr: JFragmentManager | null = null;
  fragmentResults = new Map<number, { fragment: JFragment; requestCode: number }>();
  nextFragmentRequestCode = 1;
  // set while a configuration-change relaunch is tearing this instance down, so androidx keeps
  // the ViewModelStore alive; the retained object is handed to the replacement instance.
  changingConfigurations = false;
  lastNonConfig: unknown = null;
  requestedOrientation = -1;
  mediaController: unknown = null;
}
// the API 29 Pre/Post hooks are interface defaults: an implementer's super call must find them
rt.register({
  name: "android/app/Application$ActivityLifecycleCallbacks", ctor: class extends JObj {},
  methods: Object.fromEntries(["Created", "Started", "Resumed", "Paused", "Stopped", "SaveInstanceState", "Destroyed"].flatMap((phase) => ["Pre", "Post"].map((when) =>
    [`onActivity${when}${phase}(Landroid/app/Activity;${phase === "Created" || phase === "SaveInstanceState" ? "Landroid/os/Bundle;" : ""})V`, () => {}]))),
});
export const activityMethods: NonNullable<NativeSpec["methods"]> = {
  ...wrapperMethods,
  "<init>()V": function (this: JActivity) { this.window.activity = this; },
  "getWindow()Landroid/view/Window;": function (this: JActivity) { return this.window; },
  "setMediaController(Landroid/media/session/MediaController;)V": function (this: JActivity, controller: unknown) { this.mediaController = controller; },
  "getMediaController()Landroid/media/session/MediaController;": function (this: JActivity) { return this.mediaController; },
  "getOnBackInvokedDispatcher()Landroid/window/OnBackInvokedDispatcher;": function (this: JActivity) { return this.window.backDispatcher(); },
  "getApplication()Landroid/app/Application;": function (this: JActivity) { return this.$host.application; },
  "setTaskDescription(Landroid/app/ActivityManager$TaskDescription;)V": function (this: JActivity, d: JTaskDescription | null) { this.taskDescription = d; },
  ...lifecycleCallbackMethods,
  "getWindowManager()Landroid/view/WindowManager;": function (this: JActivity) { return systemService(this, "window"); },
  "getIntent()Landroid/content/Intent;": function (this: JActivity) { return this.intent ?? (this.intent = new JIntent()); },
  "getLayoutInflater()Landroid/view/LayoutInflater;": function (this: JActivity) { return getInflater(this); },
  "getMenuInflater()Landroid/view/MenuInflater;": function (this: JActivity) {
    const m = new JMenuInflater();
    m.jctx = this;
    return m;
  },
  "setContentView(I)V": async function (this: JActivity, layoutId: number) {
    await ensureDecor(this);
    for (const child of [...this.window.contentParent!.children]) await detachView(this.window.contentParent!, child);
    await inflateLayout(this, layoutId, this.window.contentParent, true);
    requestLayout(this.window.contentParent!);
  },
  "setContentView(Landroid/view/View;)V": async function (this: JActivity, v: JView) {
    await ensureDecor(this);
    for (const child of [...this.window.contentParent!.children]) await detachView(this.window.contentParent!, child);
    if (!v.lp) {
      const lp = rt.make("android/widget/FrameLayout$LayoutParams");
      lp.width = -1; lp.height = -1;
      v.lp = lp;
    }
    await attachView(this.window.contentParent!, v);
    requestLayout(this.window.contentParent!);
  },
  "setContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": async function (this: JActivity, v: JView, lp: any) {
    v.lp = lp;
    await callSelf(activityMethods, "setContentView(Landroid/view/View;)V", this, v);
  },
  "addContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": async function (this: JActivity, v: JView, lp: any) {
    await ensureDecor(this);
    v.lp = lp;
    await attachView(this.window.contentParent!, v);
  },
  "findViewById(I)Landroid/view/View;": function (this: JActivity, id: number) {
    return vcall(this.window, "findViewById", "(I)Landroid/view/View;", id);
  },
  "setShowWhenLocked(Z)V": function (this: JActivity, show: number) { return vcall(this.window, "setFlags", "(II)V", show ? 0x80000 : 0, 0x80000); },
  "requireViewById(I)Landroid/view/View;": requireViewById,
  "onStart()V": async function (this: JActivity) { this.started = true; return dispatchFragLifecycle(this, "onStart"); },
  "onResume()V": async function (this: JActivity) { this.resumed = true; return dispatchFragLifecycle(this, "onResume"); },
  "onPause()V": function (this: JActivity) { this.resumed = false; return dispatchFragLifecycle(this, "onPause"); },
  "onStop()V": function (this: JActivity) { this.started = false; return dispatchFragLifecycle(this, "onStop"); },
  "onDestroy()V": function (this: JActivity) { return dispatchFragLifecycle(this, "onDestroy"); },
  /**
   * AOSP Activity.onBackPressed: collapse an expanded action view, then pop the fragment
   * back stack, and only if neither consumed the press, finish. androidx apps land here as
   * the OnBackPressedDispatcher's fallback, after their own callbacks declined it.
   */
  "onBackPressed()V": async function (this: JActivity) {
    const bar = this.actionBarObj;
    if (bar && (await vcall(bar, "collapseActionView", "()Z"))) return;
    const fm = await vcall(this, "getFragmentManager", "()Landroid/app/FragmentManager;");
    if (fm && !(await vcall(fm, "isStateSaved", "()Z")) && (await vcall(fm, "popBackStackImmediate", "()Z"))) return;
    await vcall(this, "finish", "()V");
  },
  // Android routes the options panel through onCreatePanelMenu/onPreparePanel/onMenuItemSelected;
  // apps (and androidx) override those, so the panel entry points must exist and delegate.
  "onCreatePanelMenu(ILandroid/view/Menu;)Z": function (this: JActivity, f: number, menu: JMenu) {
    return f === 0 ? vcall(this, "onCreateOptionsMenu", "(Landroid/view/Menu;)Z", menu) : 1;
  },
  "onPreparePanel(ILandroid/view/View;Landroid/view/Menu;)Z": function (this: JActivity, f: number, _v: unknown, menu: JMenu) {
    return f === 0 ? vcall(this, "onPrepareOptionsMenu", "(Landroid/view/Menu;)Z", menu) : 1;
  },
  "onMenuItemSelected(ILandroid/view/MenuItem;)Z": async function (this: JActivity, f: number, item: JMenuItem) {
    if (f !== 0) return 0;
    if (await vcall(this, "onOptionsItemSelected", "(Landroid/view/MenuItem;)Z", item)) return 1;
    // AOSP: an android.R.id.home nobody claimed, with DISPLAY_HOME_AS_UP set, becomes Up
    // navigation. Apps that handle Up themselves (popping a fragment, collapsing a search)
    // never get here because their onOptionsItemSelected already returned true.
    const id: number = await vcall(item, "getItemId", "()I");
    if (id === ID_HOME && this.window.actionBarView?.showUp) {
      return (await vcall(this, "onNavigateUp", "()Z")) ? 1 : 0;
    }
    return 0;
  },
  /**
   * AOSP walks getParentActivityIntent() and either recreates the task or navigateUpTo()s.
   * We have one task and no affinities, so the parent is simply whatever sits below us on
   * the stack: Up on it is Back. Routed through finish() so an app override still runs.
   */
  "onNavigateUp()Z": async function (this: JActivity) {
    await vcall(this, "finish", "()V");
    return 1;
  },
  "onNavigateUpFromChild(Landroid/app/Activity;)Z": function (this: JActivity) {
    return vcall(this, "onNavigateUp", "()Z");
  },
  /** AOSP forwards the new Configuration into the window's view hierarchy. */
  "onConfigurationChanged(Landroid/content/res/Configuration;)V": function (this: JActivity, cfg: unknown) {
    return this.window.decor ? dispatchConfigurationChanged(this.window.decor, cfg) : undefined;
  },
  // the rest of Window.Callback, as Activity's no-op defaults
  "onContentChanged()V": function () {},
  "invalidateOptionsMenu()V": function (this: JActivity) { appHost?.invalidateOptionsMenu(this); },
  "supportInvalidateOptionsMenu()V": function (this: JActivity) { appHost?.invalidateOptionsMenu(this); },
  "openOptionsMenu()V": function (this: JActivity) {
    const bar = this.window.actionBarView;
    if (!bar) return;
    const { overflow } = bar.layoutMenu();
    void showMenuPopup(barAnchor(bar), overflow.length ? overflow : bar.menuItems);
  },
  "setTitle(Ljava/lang/CharSequence;)V": function (this: JActivity, t: unknown) {
    this.titleStr = spannedString(t);
    if (this.window.actionBarView) { this.window.actionBarView.titleStr = this.titleStr; invalidate(); }
  },
  "setTitle(I)V": function (this: JActivity, id: number) {
    callSelf(activityMethods, "setTitle(Ljava/lang/CharSequence;)V", this, resString(this.$host.res, id));
  },
  "getActionBar()Landroid/app/ActionBar;": async function (this: JActivity) {
    await ensureDecor(this);
    if (!this.actionBarObj) {
      const info = rt.link("webdroid/ActionBar");
      this.actionBarObj = new info.ctor();
      this.actionBarObj.act = this;
    }
    return this.actionBarObj;
  },
  "runOnUiThread(Ljava/lang/Runnable;)V": function (this: JActivity, r: unknown) {
    void onMain(() => vcall(r, "run", "()V").catch(reportUncaught));
  },
  "finish()V": function (this: JActivity) {
    if (!this.finished) {
      this.finished = true;
      appHost?.finishActivity(this);
    }
  },
  "finishAndRemoveTask()V": function (this: JActivity) {
    if (this.finished) return;
    if (activityTransport.isTaskRoot?.(this) && activityTransport.removeTask) { this.finished = true; activityTransport.removeTask(this); }
    else callSelf(activityMethods, "finish()V", this);
  },
  "finishAffinity()V": function (this: JActivity) { callSelf(activityMethods, "finish()V", this); },
  "finishAfterTransition()V": function (this: JActivity) { callSelf(activityMethods, "finish()V", this); },
  "isTaskRoot()Z": function (this: JActivity) { return +(activityTransport.isTaskRoot?.(this) ?? false); },
  // AOSP's startActivityForResult only *starts* something; the result arrives later through
  // onActivityResult. Awaiting a system activity here would hold the serialized main-looper
  // queue for as long as its (native, modal) UI is up, which reads as a wedge.
  "startActivityForResult(Landroid/content/Intent;I)V": async function (this: JActivity, intent: JIntent, code: number) {
    const sys = intent?.component ? null : systemActivities[intent?.action ?? ""];
    if (sys) {
      void sys(intent).then(
        (data) => deliverActivityResult(this, code, data ? RESULT_OK : RESULT_CANCELED, data),
        (e) => { reportUncaught(e); deliverActivityResult(this, code, RESULT_CANCELED, null); },
      );
      return;
    }
    await launchIntent(this.$host, intent, { act: this, code });
  },
  // ActivityCompat — and so every androidx ActivityResultRegistry launcher — calls the options
  // overload, which must funnel into the body above rather than carry a second copy of it.
  "startActivityForResult(Landroid/content/Intent;ILandroid/os/Bundle;)V": function (this: JActivity, intent: JIntent, code: number) {
    return callSelf(activityMethods, "startActivityForResult(Landroid/content/Intent;I)V", this, intent, code);
  },
  "startIntentSenderForResult(Landroid/content/IntentSender;ILandroid/content/Intent;III)V": function (this: JActivity, sender: JIntentSender, code: number, fill: JIntent | null) {
    return startIntentSender(this, sender, fill, code >= 0 ? { act: this, code } : undefined);
  },
  "startIntentSenderForResult(Landroid/content/IntentSender;ILandroid/content/Intent;IIILandroid/os/Bundle;)V": function (this: JActivity, sender: JIntentSender, code: number, fill: JIntent | null) {
    return startIntentSender(this, sender, fill, code >= 0 ? { act: this, code } : undefined);
  },
  "startIntentSender(Landroid/content/IntentSender;Landroid/content/Intent;III)V": function (this: JActivity, sender: JIntentSender, fill: JIntent | null) { return startIntentSender(this, sender, fill); },
  "startIntentSender(Landroid/content/IntentSender;Landroid/content/Intent;IIILandroid/os/Bundle;)V": function (this: JActivity, sender: JIntentSender, fill: JIntent | null) { return startIntentSender(this, sender, fill); },
  "setResult(ILandroid/content/Intent;)V": function (this: JActivity, c: number, d: JIntent) {
    this.resultCode = c;
    this.resultData = d;
  },
  "requestWindowFeature(I)Z": function (this: JActivity, f: number) { this.window.features.add(f); return 1; },
  "setRequestedOrientation(I)V": function (this: JActivity, orientation: number) {
    this.requestedOrientation = orientation;
    this.$host.setRequestedOrientation(this, orientation);
  },
  "getComponentName()Landroid/content/ComponentName;": function (this: JActivity) {
    return mkComponentName(this.$host.pkg, jclsNameOf(this));
  },
  "getLocalClassName()Ljava/lang/String;": function (this: JActivity) { return jclsNameOf(this); },
  "getCallingPackage()Ljava/lang/String;": function (this: JActivity) { return this.callingActivity?.pkg ?? null; },
  "getPreferences(I)Landroid/content/SharedPreferences;": function (this: JActivity) {
    return getPrefs(this.$host.pkg, jclsNameOf(this));
  },
  // One manager per activity: a fresh instance per call could never hold a back stack, and
  // onBackPressed asks it whether the press was consumed.
  "getFragmentManager()Landroid/app/FragmentManager;": function (this: JActivity) {
    if (!this.fragMgr) {
      const manager: JFragmentManager = rt.make("android/app/FragmentManager");
      manager.act = this;
      this.fragMgr = manager;
    }
    return this.fragMgr;
  },
  // Activity.isChild is only true for the long-dead ActivityGroup embedding; AppCompat asks it
  // before relaunching for a night-mode change.
  "isChild()Z": () => 0,
  "getParent()Landroid/app/Activity;": () => null,
  "recreate()V": function (this: JActivity) { appHost?.recreateActivity(this); },
  ...fieldSetters({ "setIntent(Landroid/content/Intent;)V": "intent", "setResult(I)V": "resultCode" }),
  ...fieldGetters({ "getTitle()Ljava/lang/CharSequence;": "titleStr",
    "getRequestedOrientation()I": "requestedOrientation",
    "getCallingActivity()Landroid/content/ComponentName;": "callingActivity",
    "getLastNonConfigurationInstance()Ljava/lang/Object;": "lastNonConfig" }),
  ...flagGetters({ "isFinishing()Z": "finished", "isDestroyed()Z": "finished", "hasWindowFocus()Z": "hasWindowFocus",
    "isChangingConfigurations()Z": "changingConfigurations" }),
  "getTaskId()I": function (this: JActivity) { return this.taskId || -1; },
  // The system's dialog goes in front of the activity: it pauses, the answer is recorded, and
  // it resumes before the result is delivered. Nobody is here to tap, so asking is what grants
  // — but an app that re-reads the permission in onResume must see the grant by then.
  "requestPermissions([Ljava/lang/String;I)V": function (this: JActivity, perms: string[], code: number) {
    setTimeout(() => {
      void onMain(async () => {
        const granted = grantPermissions(perms);
        await this.$host.roundTrip(this);
        await vcall(this, "onRequestPermissionsResult", "(I[Ljava/lang/String;[I)V", code, perms, granted);
      }).catch(reportUncaught);
    }, 0);
  },
  "getVolumeControlStream()I": () => 3,
  "dispatchTouchEvent(Landroid/view/MotionEvent;)Z": async function (this: JActivity, event: JMotionEvent) {
    const thread = curThread;
    if (event.action === 0) await vcallOn(thread, this, "onUserInteraction", "()V");
    if (await vcallOn(thread, this.window, "superDispatchTouchEvent", "(Landroid/view/MotionEvent;)Z", event)) return 1;
    return vcallOn(thread, this, "onTouchEvent", "(Landroid/view/MotionEvent;)Z", event);
  },
  ...noops("registerScreenCaptureCallback(Ljava/util/concurrent/Executor;Landroid/app/Activity$ScreenCaptureCallback;)V",
    "unregisterScreenCaptureCallback(Landroid/app/Activity$ScreenCaptureCallback;)V"),
  ...noops("onCreate(Landroid/os/Bundle;)V", "onPostCreate(Landroid/os/Bundle;)V", "onRestart()V", "onPostResume()V",
    "onNewIntent(Landroid/content/Intent;)V", "onSaveInstanceState(Landroid/os/Bundle;)V",
    "onRestoreInstanceState(Landroid/os/Bundle;)V", "onActivityResult(IILandroid/content/Intent;)V",
    "onRequestPermissionsResult(I[Ljava/lang/String;[I)V", "onWindowFocusChanged(Z)V", "onAttachedToWindow()V",
    "onDetachedFromWindow()V", "onWindowAttributesChanged(Landroid/view/WindowManager$LayoutParams;)V",
    "onPanelClosed(ILandroid/view/Menu;)V", "onActionModeStarted(Landroid/view/ActionMode;)V",
    "onActionModeFinished(Landroid/view/ActionMode;)V", "onPointerCaptureChanged(Z)V",
    "onProvideKeyboardShortcuts(Ljava/util/List;Landroid/view/Menu;I)V", "onLowMemory()V", "onTrimMemory(I)V",
    "onUserInteraction()V", "onTitleChanged(Ljava/lang/CharSequence;I)V",
    "onChildTitleChanged(Landroid/app/Activity;Ljava/lang/CharSequence;)V", "closeOptionsMenu()V",
    "overridePendingTransition(II)V", "startPostponedEnterTransition()V", "reportFullyDrawn()V",
    "setVolumeControlStream(I)V", "setDefaultKeyMode(I)V", "showDialog(I)V", "dismissDialog(I)V",
    "setFinishOnTouchOutside(Z)V"),
  ...stubs(1, "onCreateOptionsMenu(Landroid/view/Menu;)Z", "onPrepareOptionsMenu(Landroid/view/Menu;)Z"),
  ...stubs(0, "onOptionsItemSelected(Landroid/view/MenuItem;)Z", "onSearchRequested()Z",
    "onSearchRequested(Landroid/view/SearchEvent;)Z", "onKeyDown(ILandroid/view/KeyEvent;)Z",
    "onKeyUp(ILandroid/view/KeyEvent;)Z", "onTouchEvent(Landroid/view/MotionEvent;)Z", "getChangingConfigurations()I",
    "shouldShowRequestPermissionRationale(Ljava/lang/String;)Z",
    "isInMultiWindowMode()Z", "isInPictureInPictureMode()Z", "isLaunchedFromBubble()Z"),
  ...stubs(null, "onWindowStartingActionMode(Landroid/view/ActionMode$Callback;)Landroid/view/ActionMode;",
    "onWindowStartingActionMode(Landroid/view/ActionMode$Callback;I)Landroid/view/ActionMode;",
    "onCreateView(Ljava/lang/String;Landroid/content/Context;Landroid/util/AttributeSet;)Landroid/view/View;",
    "onCreateView(Landroid/view/View;Ljava/lang/String;Landroid/content/Context;Landroid/util/AttributeSet;)Landroid/view/View;",
    "getCurrentFocus()Landroid/view/View;", "onRetainNonConfigurationInstance()Ljava/lang/Object;",
    "onRetainCustomNonConfigurationInstance()Ljava/lang/Object;", "getReferrer()Landroid/net/Uri;"),
};
rt.register({
  name: "android/app/Activity", ctor: JActivity, sup: "android/view/ContextThemeWrapper",
  // AOSP's Activity implements these; a library that casts an activity to one of them
  // (ComponentCallbacks2 for trim-memory, KeyEvent.Callback for key dispatch) must not fail
  ifaces: ["android/view/Window$Callback", "android/view/LayoutInflater$Factory2",
    "android/content/ComponentCallbacks2", "android/content/ComponentCallbacks",
    "android/view/KeyEvent$Callback", "android/view/View$OnCreateContextMenuListener"],
  statics: { RESULT_OK: -1, RESULT_CANCELED: 0, DEFAULT_KEYS_DISABLE: 0 },
  methods: activityMethods,
});
rt.markers("android/app/Activity$ScreenCaptureCallback");
// ListActivity: an Activity whose content is one ListView; the app's own layout supplies it
rt.register({
  name: "android/app/ListActivity", ctor: class extends JActivity { adapter: unknown = null; }, sup: "android/app/Activity",
  methods: {
    "<init>()V": function (this: JActivity) { return callSelf(activityMethods, "<init>()V", this); },
    "setListAdapter(Landroid/widget/ListAdapter;)V": function (this: JActivity & { adapter: unknown }, a: unknown) { this.adapter = a; },
    "getListAdapter()Landroid/widget/ListAdapter;": function (this: JActivity & { adapter: unknown }) { return this.adapter; },
    "getListView()Landroid/widget/ListView;": function (this: JActivity) { return this.window.decor ? findById(this.window.decor, 0x102000a) : null; },
  },
});
rt.markers("android/view/Window$Callback");
// Frame metrics are reported per frame that was actually measured; a listener registered on a
// window that never janks is one a device never calls either.
rt.markers("android/view/Window$OnFrameMetricsAvailableListener");

export class JApplication extends JContextWrapper {
  lifecycleCbs: ActivityLifecycleCallback[] | null = null;
}
rt.register({
  name: "android/app/Application", ctor: JApplication, sup: "android/content/ContextWrapper",
  ifaces: ["android/content/ComponentCallbacks2", "android/content/ComponentCallbacks"],
  methods: {
    ...wrapperMethods,
    "static getProcessName()Ljava/lang/String;": () => PROCESS_NAME || appHost?.pkg || "app",
    ...noops("<init>()V", "onCreate()V", "onTerminate()V", "onLowMemory()V", "onTrimMemory(I)V",
      "onConfigurationChanged(Landroid/content/res/Configuration;)V"),
    ...lifecycleCallbackMethods,
    "registerComponentCallbacks(Landroid/content/ComponentCallbacks;)V": () => {},
  },
});
// The application without a Context, which is how the framework's own bytecode and a great many
// libraries reach it — AOSP's LineBreakConfig gates on
// ActivityThread.currentApplication().getApplicationInfo().targetSdkVersion, and returning null
// there is a NullPointerException on the layout path, not a graceful absence. One body, three
// names: ActivityThread is the hidden one, AppGlobals the @SystemApi wrapper over it.
const currentApplication = () => appHost?.application ?? null;
// the core settings the system pushes into every process. None is set here, so every read gets
// the caller's own default — a device that has not set one reports the same.
const intCoreSetting = (_k: string, def: number) => def;
class JActivityThread extends JObj {}
let activityThread: JActivityThread | null = null;
rt.register({
  name: "android/app/ActivityThread", ctor: JActivityThread,
  methods: {
    "static currentActivityThread()Landroid/app/ActivityThread;": () => appHost ? activityThread ??= new JActivityThread() : null,
    "getApplication()Landroid/app/Application;": currentApplication,
    "static currentApplication()Landroid/app/Application;": currentApplication,
    "static currentPackageName()Ljava/lang/String;": () => appHost?.pkg ?? null,
    "static currentProcessName()Ljava/lang/String;": () => PROCESS_NAME || appHost?.pkg || null,
    "static getIntCoreSetting(Ljava/lang/String;I)I": intCoreSetting,
  },
});
rt.register({
  name: "android/app/AppGlobals", ctor: class extends JObj {},
  methods: {
    "static getInitialApplication()Landroid/app/Application;": currentApplication,
    "static getInitialPackage()Ljava/lang/String;": () => appHost?.pkg ?? null,
    "static getIntCoreSetting(Ljava/lang/String;I)I": intCoreSetting,
  },
});

rt.markers("android/content/ComponentCallbacks");
rt.register({
  name: "android/content/ComponentCallbacks2", ctor: class extends JObj {},
  ifaces: ["android/content/ComponentCallbacks"],
});

class JToast extends JObj { text = ""; }
rt.register({
  name: "android/widget/Toast", ctor: JToast,
  statics: { LENGTH_SHORT: 0, LENGTH_LONG: 1 },
  methods: {
    "static makeText(Landroid/content/Context;Ljava/lang/CharSequence;I)Landroid/widget/Toast;": async (c: unknown, t: unknown) => {
      const toast = new JToast();
      toast.text = await csText(t);
      return toast;
    },
    "static makeText(Landroid/content/Context;II)Landroid/widget/Toast;": (c: any, id: number) => {
      const toast = new JToast();
      toast.text = c?.$host ? resString(c.$host.res, id) : "";
      return toast;
    },
    "show()V": function (this: JToast) { showToast(this.text); },
    "setText(Ljava/lang/CharSequence;)V": async function (this: JToast, t: unknown) { this.text = await csText(t); },
    ...noops("setGravity(III)V", "setDuration(I)V", "cancel()V"),
  },
});

let audioCapturePolicy = 1;
class JVibrationEffect extends JObj {
  timings: bigint[] = [];
  repeat = -1;
}
rt.register({
  name: "android/os/VibrationEffect", ctor: JVibrationEffect, ifaces: ["android/os/Parcelable"],
  statics: { DEFAULT_AMPLITUDE: -1 },
  methods: {
    "static createPredefined(I)Landroid/os/VibrationEffect;": () => Object.assign(new JVibrationEffect(), { timings: [30n] }),
    "static createOneShot(JI)Landroid/os/VibrationEffect;": (ms: bigint) => Object.assign(new JVibrationEffect(), { timings: [ms] }),
    "static createWaveform([JI)Landroid/os/VibrationEffect;": (timings: BigInt64Array | bigint[], repeat: number) =>
      Object.assign(new JVibrationEffect(), { timings: Array.from(timings), repeat }),
    "static createWaveform([J[II)Landroid/os/VibrationEffect;": (timings: BigInt64Array | bigint[], _amplitudes: Int32Array, repeat: number) =>
      Object.assign(new JVibrationEffect(), { timings: Array.from(timings), repeat }),
  },
});
class JAccessibilityServiceInfo extends JObj {
  eventTypes = 0;
  feedbackType = 0;
  flags = 0;
  notificationTimeout = 0n;
  packageNames: string[] | null = null;
  capabilities = 0;
  id: string | null = null;
}
rt.register({
  name: "android/accessibilityservice/AccessibilityServiceInfo", ctor: JAccessibilityServiceInfo,
  fields: ["eventTypes", "feedbackType", "flags", "notificationTimeout", "packageNames"],
  methods: {
    "<init>()V": function () {},
    "getCapabilities()I": function (this: JAccessibilityServiceInfo) { return this.capabilities; },
    "getId()Ljava/lang/String;": function (this: JAccessibilityServiceInfo) { return this.id; },
  },
});
const activeOpWatchers = new WeakMap<JObj, Map<unknown, { ops: string[]; executor: unknown }>>();
class JHealthStats extends JObj {}
const uidHealthSnapshot = () => new JHealthStats();
rt.register({
  name: "android/os/health/HealthStats", ctor: JHealthStats,
  methods: {
    "getDataType()Ljava/lang/String;": () => "UidHealthStats",
    ...stubs(0, "hasTimer(I)Z", "hasMeasurement(I)Z", "hasStats(I)Z", "hasTimers(I)Z", "hasMeasurements(I)Z"),
    "getTimer(I)Landroid/os/health/TimerStat;": () => { throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null); },
    "getMeasurement(I)J": () => { throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null); },
    "getStats(I)Ljava/util/Map;": () => { throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null); },
    "getTimers(I)Ljava/util/Map;": () => { throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null); },
    "getMeasurements(I)Ljava/util/Map;": () => { throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null); },
  },
});
for (const [name, methods, statics] of [
  ["android/app/ActivityManager", {
    "static isUserAMonkey()Z": () => 0,
    "static isRunningInTestHarness()Z": () => 0,
    "static isRunningInUserTestHarness()Z": () => 0,
    "getMemoryClass()I": () => 256,
    "getLargeMemoryClass()I": () => 512,
    "isLowRamDevice()Z": () => 0,
    "isBackgroundRestricted()Z": () => 0,
    "getRunningAppProcesses()Ljava/util/List;": () => newArrayList([myProcess()]),
    "getProcessMemoryInfo([I)[Landroid/os/Debug$MemoryInfo;": (pids: Int32Array) => jarray(Array.from(pids, () => rt.make("android/os/Debug$MemoryInfo")), "Landroid/os/Debug$MemoryInfo;"),
    "getHistoricalProcessExitReasons(Ljava/lang/String;II)Ljava/util/List;": () => newArrayList(),
    "getAppTasks()Ljava/util/List;": () => newArrayList(appTasks()),
    "getRunningServices(I)Ljava/util/List;": (max: number) => {
      const all = [...runningServices.values()];
      return newArrayList(max < all.length ? all.slice(0, max) : all);
    },
    "getMemoryInfo(Landroid/app/ActivityManager$MemoryInfo;)V": (mi: any) => {
      if (mi) { mi.totalMem = 4n * 1024n * 1024n * 1024n; mi.availMem = 2n * 1024n * 1024n * 1024n; mi.lowMemory = 0; mi.threshold = 128n * 1024n * 1024n; }
    },
    "getDeviceConfigurationInfo()Landroid/content/pm/ConfigurationInfo;": () => {
      rt.link("android/content/pm/ConfigurationInfo");
      const info = new JConfigurationInfo(), config = deviceConfiguration();
      info.reqTouchScreen = config.touchscreen; info.reqKeyboardType = config.keyboard; info.reqNavigation = config.navigation;
      info.reqGlEsVersion = 0x30000; return info;
    },
    "static getMyMemoryState(Landroid/app/ActivityManager$RunningAppProcessInfo;)V": (info: JRunningAppProcessInfo) => {
      if (info) fillProc(info);
    },

  }],
  ["android/os/PowerManager", {
    "getLocationPowerSaveMode()I": () => 0,
    "newWakeLock(ILjava/lang/String;)Landroid/os/PowerManager$WakeLock;": () => {
      const info = rt.link("android/os/PowerManager$WakeLock");
      return new info.ctor();
    },
    // the screen is on and this app was never exempted from doze, which is the state an app
    // offering a "disable battery optimisation" prompt is asking about
    "isDeviceIdleMode()Z": () => 0,
    "getCurrentThermalStatus()I": () => 0,                                       // THERMAL_STATUS_NONE
    ...noops("addThermalStatusListener(Landroid/os/PowerManager$OnThermalStatusChangedListener;)V",
      "addThermalStatusListener(Ljava/util/concurrent/Executor;Landroid/os/PowerManager$OnThermalStatusChangedListener;)V",
      "removeThermalStatusListener(Landroid/os/PowerManager$OnThermalStatusChangedListener;)V"),
    ...stubs(1, "isInteractive()Z"),
    ...stubs(0, "isPowerSaveMode()Z", "isSustainedPerformanceModeSupported()Z", "isDeviceLightIdleMode()Z",
      "isLowPowerStandbyEnabled()Z", "isIgnoringBatteryOptimizations(Ljava/lang/String;)Z"),
  }],
  ["android/os/PowerManager$WakeLock", {
    "acquire()V": () => {}, "acquire(J)V": () => {}, "release()V": () => {},
    "isHeld()Z": () => 0, "setReferenceCounted(Z)V": () => {},
  }],
  // no radio here: getDefaultAdapter() is null, which is what a device without Bluetooth reports
  ["android/bluetooth/BluetoothAdapter", {
    "static getDefaultAdapter()Landroid/bluetooth/BluetoothAdapter;": () => null,
    "isEnabled()Z": () => 0,
  }],
  ["android/os/VibratorManager", {
    "getDefaultVibrator()Landroid/os/Vibrator;": () => systemService(null, "vibrator"),
  }],
  ["android/os/Vibrator", {
    "vibrate(J)V": (ms: bigint) => globalThis.navigator?.vibrate?.(Number(ms)),
    "vibrate(Landroid/os/VibrationEffect;)V": (effect: JVibrationEffect) =>
      globalThis.navigator?.vibrate?.(effect.timings.map(Number)),
    "hasVibrator()Z": () => 1,
    "cancel()V": () => {},
    // navigator.vibrate is a bare on/off motor: no amplitude, no composed primitives
    "hasAmplitudeControl()Z": () => 0,
    "areAllPrimitivesSupported([I)Z": () => 0,
    "arePrimitivesSupported([I)[Z": (ids: Int32Array) => new Uint8Array(ids.length),
    "areAllEffectsSupported([I)I": () => 2,
    "areEffectsSupported([I)[I": (ids: Int32Array) => new Int32Array(ids.length).fill(2),
  }],
  ["android/media/AudioManager", {
    "getAllowedCapturePolicy()I": () => audioCapturePolicy,
    "setAllowedCapturePolicy(I)V": (policy: number) => {
      if (policy < 1 || policy > 3) throw rt.mkThrowable("java/lang/IllegalArgumentException", "invalid capture policy");
      audioCapturePolicy = policy;
    },
    "getSpatializer()Landroid/media/Spatializer;": () => { rt.link("android/media/Spatializer"); return new JSpatializer(); },
    "getStreamVolume(I)I": () => 5,
    "getStreamMaxVolume(I)I": () => 10,
    "getStreamMinVolume(I)I": () => 0,
    "generateAudioSessionId()I": newAudioSessionId,
    "getRingerMode()I": () => 2,
    "isMusicActive()Z": isMusicActive,
    // the output path is the Web Audio context: its rate is real, its buffer size is not a fixed number of frames
    "getProperty(Ljava/lang/String;)Ljava/lang/String;": (k: string) => (k === "android.media.property.OUTPUT_SAMPLE_RATE" ? String(outputSampleRate()) : null),
    "getDevices(I)[Landroid/media/AudioDeviceInfo;": () => jarray([], "Landroid/media/AudioDeviceInfo;"),
    "getAudioDevicesForAttributes(Landroid/media/AudioAttributes;)Ljava/util/List;": () => newArrayList(),
    "getDirectProfilesForAttributes(Landroid/media/AudioAttributes;)Ljava/util/List;": () => newArrayList(),
    "static getDirectPlaybackSupport(Landroid/media/AudioFormat;Landroid/media/AudioAttributes;)I": (format: unknown, attrs: unknown) => {
      if (format == null || attrs == null) return rt.npe();
      return 0;
    },
    ...noops("setStreamVolume(III)V",
      "registerAudioDeviceCallback(Landroid/media/AudioDeviceCallback;Landroid/os/Handler;)V",
      "unregisterAudioDeviceCallback(Landroid/media/AudioDeviceCallback;)V"),
    ...stubs(1, "requestAudioFocus(Landroid/media/AudioManager$OnAudioFocusChangeListener;II)I",
      "requestAudioFocus(Landroid/media/AudioFocusRequest;)I",
      "abandonAudioFocus(Landroid/media/AudioManager$OnAudioFocusChangeListener;)I",
      "abandonAudioFocusRequest(Landroid/media/AudioFocusRequest;)I"),
    ...stubs(0, "getMode()I", "isSpeakerphoneOn()Z", "isBluetoothA2dpOn()Z", "isWiredHeadsetOn()Z",
      "static getDirectPlaybackSupport(Landroid/media/AudioFormat;Landroid/media/AudioAttributes;)I",
      "static getPlaybackOffloadSupport(Landroid/media/AudioFormat;Landroid/media/AudioAttributes;)I",
      "static isOffloadedPlaybackSupported(Landroid/media/AudioFormat;Landroid/media/AudioAttributes;)Z"),
    ...stubs("", "getParameters(Ljava/lang/String;)Ljava/lang/String;"),
  }, {
    MODE_NORMAL: 0, MODE_RINGTONE: 1, MODE_IN_CALL: 2, MODE_IN_COMMUNICATION: 3,
    DIRECT_PLAYBACK_NOT_SUPPORTED: 0, DIRECT_PLAYBACK_OFFLOAD_SUPPORTED: 1,
    DIRECT_PLAYBACK_OFFLOAD_GAPLESS_SUPPORTED: 3, DIRECT_PLAYBACK_BITSTREAM_SUPPORTED: 4,
    RINGER_MODE_SILENT: 0, RINGER_MODE_VIBRATE: 1, RINGER_MODE_NORMAL: 2,
    GET_DEVICES_INPUTS: 1, GET_DEVICES_OUTPUTS: 2, GET_DEVICES_ALL: 3,
    PROPERTY_OUTPUT_SAMPLE_RATE: "android.media.property.OUTPUT_SAMPLE_RATE", PROPERTY_OUTPUT_FRAMES_PER_BUFFER: "android.media.property.OUTPUT_FRAMES_PER_BUFFER",
    STREAM_VOICE_CALL: 0, STREAM_SYSTEM: 1, STREAM_RING: 2, STREAM_MUSIC: 3, STREAM_ALARM: 4, STREAM_NOTIFICATION: 5,
    AUDIOFOCUS_GAIN: 1, AUDIOFOCUS_LOSS: -1, AUDIOFOCUS_REQUEST_GRANTED: 1, AUDIOFOCUS_REQUEST_FAILED: 0,
  }],
  // A Wi-Fi-only device with no SIM: no operator, no radio, and the identifiers API 29+
  // withholds from ordinary apps are null.
  // the CellLocation family an app type-checks a (null) cell against; a device with no radio reports none
  ["android/telephony/CellLocation", {
    "static getEmpty()Landroid/telephony/CellLocation;": () => null,
    "static requestLocationUpdate()V": () => {},
  }],
  ["android/telephony/gsm/GsmCellLocation", { ...stubs(-1, "getLac()I", "getCid()I", "getPsc()I"), ...noops("<init>()V", "setLacAndCid(II)V") }],
  ["android/telephony/cdma/CdmaCellLocation", {
    ...stubs(-1, "getBaseStationId()I", "getSystemId()I", "getNetworkId()I"),
    ...stubs(0x7fffffff, "getBaseStationLatitude()I", "getBaseStationLongitude()I"),
    "static convertQuartSecToDecDegrees(I)D": (quartSec: number) => quartSec / 14400,   // AOSP: quarter-seconds of arc to degrees
    ...noops("<init>()V"),
  }],
  ["android/telephony/TelephonyManager", {
    ...stubs("", "getNetworkOperator()Ljava/lang/String;", "getNetworkOperatorName()Ljava/lang/String;",
      "getSimOperator()Ljava/lang/String;", "getSimOperatorName()Ljava/lang/String;",
      "getSimCountryIso()Ljava/lang/String;", "getNetworkCountryIso()Ljava/lang/String;"),
    ...stubs(0, "getPhoneType()I", "getNetworkType()I", "getDataNetworkType()I", "getCallState()I", "getDataState()I",
      "isNetworkRoaming()Z", "hasIccCard()Z"),
    ...stubs(1, "getSimState()I"),
    ...stubs(null, "getDeviceId()Ljava/lang/String;", "getLine1Number()Ljava/lang/String;",
      "getSubscriberId()Ljava/lang/String;", "getSimSerialNumber()Ljava/lang/String;"),
    ...noops("listen(Landroid/telephony/PhoneStateListener;I)V", "unregisterTelephonyCallback(Landroid/telephony/TelephonyCallback;)V"),
    // no radio: the one thing a registration ever hears is the initial "disconnected"/"idle"
    // state, delivered on the caller's executor as the platform does
    "registerTelephonyCallback(Ljava/util/concurrent/Executor;Landroid/telephony/TelephonyCallback;)V": (executor: unknown, cb: unknown) => {
      if (executor === null || cb === null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "executor and callback must not be null");
      const initial: [string, string, string, unknown[]][] = [
        ["android/telephony/TelephonyCallback$DataConnectionStateListener", "onDataConnectionStateChanged", "(II)V", [0, 0]],
        ["android/telephony/TelephonyCallback$CallStateListener", "onCallStateChanged", "(I)V", [0]],
      ];
      for (const [iface, name, desc, args] of initial) {
        if (!rt.iof(cb, iface)) continue;
        const task = rt.make("webdroid/TelephonyDelivery") as JObj & { run: () => Promise<void> };
        task.run = () => vcall(cb, name, desc, ...args);
        void vcall(executor, "execute", "(Ljava/lang/Runnable;)V", task).catch(reportUncaught);
      }
    },
    "getActiveModemCount()I": () => 0,
    // one radio-less manager answers for every subscription id
    "createForSubscriptionId(I)Landroid/telephony/TelephonyManager;": function (this: JObj) { return this; },
    "getCellLocation()Landroid/telephony/CellLocation;": () => null,                  // no radio: no cell
    "createForPhoneAccountHandle(Landroid/telecom/PhoneAccountHandle;)Landroid/telephony/TelephonyManager;": function (this: JObj) { return this; },
  }, {
    PHONE_TYPE_NONE: 0, PHONE_TYPE_GSM: 1, PHONE_TYPE_CDMA: 2, PHONE_TYPE_SIP: 3,
    NETWORK_TYPE_UNKNOWN: 0,
    SIM_STATE_UNKNOWN: 0, SIM_STATE_ABSENT: 1, SIM_STATE_READY: 5,
    CALL_STATE_IDLE: 0, CALL_STATE_RINGING: 1, CALL_STATE_OFFHOOK: 2,
    DATA_DISCONNECTED: 0,
  }],
  // no SIM: no active subscriptions, and every default id is INVALID_SUBSCRIPTION_ID
  ["android/telephony/SubscriptionManager", {
    "static from(Landroid/content/Context;)Landroid/telephony/SubscriptionManager;": (ctx: unknown) => systemService(ctx as Parameters<typeof systemService>[0], "telephony_subscription_service"),
    "getActiveSubscriptionInfoList()Ljava/util/List;": () => null,
    "getActiveSubscriptionInfoCount()I": () => 0,
    "getActiveSubscriptionInfoCountMax()I": () => 1,
    "getActiveSubscriptionInfo(I)Landroid/telephony/SubscriptionInfo;": () => null,
    "getActiveSubscriptionInfoForSimSlotIndex(I)Landroid/telephony/SubscriptionInfo;": () => null,
    "static getDefaultSubscriptionId()I": () => -1,
    "static getDefaultDataSubscriptionId()I": () => -1,
    "static getDefaultVoiceSubscriptionId()I": () => -1,
    "static getDefaultSmsSubscriptionId()I": () => -1,
    "static isValidSubscriptionId(I)Z": (id: number) => id >= 0 ? 1 : 0,
    ...noops("addOnSubscriptionsChangedListener(Landroid/telephony/SubscriptionManager$OnSubscriptionsChangedListener;)V",
      "addOnSubscriptionsChangedListener(Ljava/util/concurrent/Executor;Landroid/telephony/SubscriptionManager$OnSubscriptionsChangedListener;)V",
      "removeOnSubscriptionsChangedListener(Landroid/telephony/SubscriptionManager$OnSubscriptionsChangedListener;)V"),
  }, { INVALID_SUBSCRIPTION_ID: -1, DEFAULT_SUBSCRIPTION_ID: 2147483647, INVALID_SIM_SLOT_INDEX: -1 }],
  ["android/os/ext/SdkExtensions", {
    "static getExtensionVersion(I)I": () => 0,
  }],
  ["android/app/AppOpsManager", {
    "noteOpNoThrow(Ljava/lang/String;ILjava/lang/String;)I": function (this: JObj, op: string, uid: number, pkg: string) {
      return vcall(this, "checkOpNoThrow", "(Ljava/lang/String;ILjava/lang/String;)I", op, uid, pkg);
    },
    "noteOpNoThrow(Ljava/lang/String;ILjava/lang/String;Ljava/lang/String;Ljava/lang/String;)I": function (this: JObj, op: string, uid: number, pkg: string) {
      return vcall(this, "noteOpNoThrow", "(Ljava/lang/String;ILjava/lang/String;)I", op, uid, pkg);
    },
    "checkOpNoThrow(Ljava/lang/String;ILjava/lang/String;)I": (_op: string, uid: number, pkg: string) => packages.get(pkg)?.uid === uid ? 0 : 2,
    "startOpNoThrow(Ljava/lang/String;ILjava/lang/String;)I": function (this: JObj, op: string, uid: number, pkg: string) {
      return vcall(this, "checkOpNoThrow", "(Ljava/lang/String;ILjava/lang/String;)I", op, uid, pkg);
    },
    "startWatchingActive([Ljava/lang/String;Ljava/util/concurrent/Executor;Landroid/app/AppOpsManager$OnOpActiveChangedListener;)V":
      function (this: JObj, ops: string[] | null, executor: unknown, listener: unknown) {
        if (ops === null || executor === null || listener === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
        let watchers = activeOpWatchers.get(this);
        if (!watchers) activeOpWatchers.set(this, watchers = new Map());
        watchers.set(listener, { ops: [...ops], executor });
      },
    "stopWatchingActive(Landroid/app/AppOpsManager$OnOpActiveChangedListener;)V": function (this: JObj, listener: unknown) {
      activeOpWatchers.get(this)?.delete(listener);
    },
    ...stubs(null, "static permissionToOp(Ljava/lang/String;)Ljava/lang/String;"),
    ...stubs(0, "noteOp(Ljava/lang/String;ILjava/lang/String;)I", "noteProxyOp(Ljava/lang/String;Ljava/lang/String;)I",
      "noteProxyOpNoThrow(Ljava/lang/String;Ljava/lang/String;)I", "checkOp(Ljava/lang/String;ILjava/lang/String;)I",
      "unsafeCheckOpNoThrow(Ljava/lang/String;ILjava/lang/String;)I"),
    ...noops("finishOp(Ljava/lang/String;ILjava/lang/String;)V", "checkPackage(ILjava/lang/String;)V",
      "startWatchingMode(Ljava/lang/String;Ljava/lang/String;Landroid/app/AppOpsManager$OnOpChangedListener;)V",
      "stopWatchingMode(Landroid/app/AppOpsManager$OnOpChangedListener;)V"),
  }, { MODE_ALLOWED: 0, MODE_IGNORED: 1, MODE_ERRORED: 2, MODE_DEFAULT: 3 }],
  ["android/os/health/SystemHealthManager", {
    "takeMyUidSnapshot()Landroid/os/health/HealthStats;": uidHealthSnapshot,
    "takeUidSnapshot(I)Landroid/os/health/HealthStats;": (uid: number) => {
      if (uid !== PROCESS_UID) throw rt.mkThrowable("java/lang/SecurityException", "BATTERY_STATS permission required");
      return uidHealthSnapshot();
    },
    "takeUidSnapshots([I)[Landroid/os/health/HealthStats;": (uids: Int32Array) => {
      if ([...uids].some((uid) => uid !== PROCESS_UID)) throw rt.mkThrowable("java/lang/SecurityException", "BATTERY_STATS permission required");
      return jarray([...uids].map(uidHealthSnapshot), "Landroid/os/health/HealthStats;");
    },
  }],
  ["android/content/ClipboardManager", clipboardMethods],
  // UI_MODE_TYPE_NORMAL: a handset, not a car/desk/TV dock (Configuration.uiMode agrees).
  // getNightMode reports the device's own setting, which is not this app's to change.
  ["android/app/UiModeManager", {
    "getNightMode()I": () => device.night ? 2 : 1,
    "setNightMode(I)V": () => {},
    "getCurrentModeType()I": () => 1,
  }],
  ["android/app/KeyguardManager", { "isKeyguardLocked()Z": () => 0, "inKeyguardRestrictedInputMode()Z": () => 0, "isDeviceSecure()Z": () => 0 }],
  ["android/hardware/SensorManager", { "getDefaultSensor(I)Landroid/hardware/Sensor;": () => null, "getSensorList(I)Ljava/util/List;": () => newArrayList(), "registerListener(Landroid/hardware/SensorEventListener;Landroid/hardware/Sensor;I)Z": () => 0,
    "static getAltitude(FF)F": (p0: number, p: number) => Math.fround(44330 * Math.fround(1 - Math.fround(Math.pow(Math.fround(p / p0), Math.fround(1 / Math.fround(5.255)))))),
    "registerListener(Landroid/hardware/SensorEventListener;Landroid/hardware/Sensor;II)Z": () => 0,
    "registerListener(Landroid/hardware/SensorEventListener;Landroid/hardware/Sensor;ILandroid/os/Handler;)Z": () => 0,
    "static getOrientation([F[F)[F": (r: Float32Array, values: Float32Array) => {
      const stride = r.length === 9 ? 3 : 4;
      values[0] = Math.atan2(r[1], r[stride + 1]);
      values[1] = Math.asin(-r[2 * stride + 1]);
      values[2] = Math.atan2(-r[2 * stride], r[2 * stride + 2]);
      return values;
    },
    "static getRotationMatrix([F[F[F[F)Z": (r: Float32Array | null, inclination: Float32Array | null, gravity: Float32Array, geomagnetic: Float32Array) => {
      let ax = gravity[0], ay = gravity[1], az = gravity[2];
      const ex = geomagnetic[0], ey = geomagnetic[1], ez = geomagnetic[2];
      let hx = ey * az - ez * ay, hy = ez * ax - ex * az, hz = ex * ay - ey * ax;
      const h = Math.hypot(hx, hy, hz);
      if (h < 0.1) return 0;
      hx /= h; hy /= h; hz /= h;
      const a = Math.hypot(ax, ay, az);
      ax /= a; ay /= a; az /= a;
      const mx = ay * hz - az * hy, my = az * hx - ax * hz, mz = ax * hy - ay * hx;
      if (r?.length === 9) r.set([hx, hy, hz, mx, my, mz, ax, ay, az]);
      else if (r?.length === 16) r.set([hx, hy, hz, 0, mx, my, mz, 0, ax, ay, az, 0, 0, 0, 0, 1]);
      if (inclination?.length === 9 || inclination?.length === 16) {
        const e = Math.hypot(ex, ey, ez), c = (ex * mx + ey * my + ez * mz) / e, s = (ex * ax + ey * ay + ez * az) / e;
        if (inclination.length === 9) inclination.set([1, 0, 0, 0, c, s, 0, -s, c]);
        else inclination.set([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
      }
      return 1;
    },
    "unregisterListener(Landroid/hardware/SensorEventListener;)V": () => {},
    "unregisterListener(Landroid/hardware/SensorEventListener;Landroid/hardware/Sensor;)V": () => {} }],
  // a charging battery at 80%; counters the platform cannot read answer Integer/Long.MIN_VALUE
  // as BatteryManager does for an unsupported property
  ["android/os/BatteryManager", {
    "getIntProperty(I)I": (id: number) => id === 4 ? device.battery.level : id === 6 ? device.battery.status : -2147483648,
    "getLongProperty(I)J": (id: number) => id === 4 ? BigInt(device.battery.level) : id === 6 ? BigInt(device.battery.status) : -9223372036854775808n,
    "isCharging()Z": () => +(device.battery.status === 2 || device.battery.status === 5),
    "computeChargeTimeRemaining()J": () => -1n,
  }],
  ["android/hardware/display/DisplayManager", {
    // one fixed built-in display: unknown ids are null as in AOSP, and registered listeners
    // never fire because no display is ever added, removed or reconfigured here
    "getDisplay(I)Landroid/view/Display;": (id: number) => (id === 0 ? display() : null),
    "getDisplays()[Landroid/view/Display;": async () => jarray([await display()], "Landroid/view/Display;"),
    "getDisplays(Ljava/lang/String;)[Landroid/view/Display;": async (cat: string | null) => jarray(cat === null ? [await display()] : [], "Landroid/view/Display;"),
    "registerDisplayListener(Landroid/hardware/display/DisplayManager$DisplayListener;Landroid/os/Handler;)V": (l: unknown) => {
      if (l === null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "listener must not be null");
      displayListeners.add(l);
    },
    "unregisterDisplayListener(Landroid/hardware/display/DisplayManager$DisplayListener;)V": (l: unknown) => { displayListeners.delete(l); },
  }, { DISPLAY_CATEGORY_PRESENTATION: "android.hardware.display.category.PRESENTATION" }],
] as [string, NativeSpec["methods"], NativeSpec["statics"]?][]) {
  rt.register({ name, ctor: class extends JObj {}, methods, statics });
}
rt.register({ name: "android/bluetooth/le/ScanCallback", ctor: class extends JObj {} });
rt.register({ name: "android/hardware/usb/UsbManager", ctor: class extends JObj {}, methods: {
  "getDeviceList()Ljava/util/HashMap;": () => rt.make("java/util/HashMap"),
} });
rt.register({
  name: "android/hardware/fingerprint/FingerprintManager", ctor: class extends JObj {},
  methods: {
    "isHardwareDetected()Z": () => 0,
    "hasEnrolledFingerprints()Z": () => 0,
  },
});
rt.register({ name: "android/hardware/fingerprint/FingerprintManager$AuthenticationCallback", ctor: class extends JObj {} });
rt.register({ name: "android/telephony/PhoneStateListener", ctor: class extends JObj {}, methods: { "<init>()V": function () {} } });
rt.register({ name: "android/telephony/TelephonyCallback", ctor: class extends JObj {}, methods: { "<init>()V": function () {} } });
rt.register({ name: "webdroid/TelephonyDelivery", ctor: class extends JObj { run: () => Promise<void> = async () => {}; }, ifaces: ["java/lang/Runnable"],
  methods: { "run()V": function (this: { run: () => Promise<void> }) { return this.run(); } } });
rt.markers("android/telephony/TelephonyCallback$DataConnectionStateListener", "android/telephony/TelephonyCallback$CallStateListener",
  "android/telephony/TelephonyCallback$ServiceStateListener", "android/telephony/TelephonyCallback$SignalStrengthsListener",
  "android/telephony/TelephonyCallback$DisplayInfoListener");
// libphonenumber's metadata is not on this device, so neither the watcher nor formatNumber
// regroups anything: the digits a caller typed are the digits it reads back.
rt.register({
  name: "android/telephony/PhoneNumberFormattingTextWatcher", ctor: class extends JObj {},
  ifaces: ["android/text/TextWatcher"],
  methods: {
    ...noops("<init>()V", "<init>(Ljava/lang/String;)V", "beforeTextChanged(Ljava/lang/CharSequence;III)V",
      "onTextChanged(Ljava/lang/CharSequence;III)V", "afterTextChanged(Landroid/text/Editable;)V"),
  },
});
rt.register({
  name: "android/telephony/PhoneNumberUtils", ctor: class extends JObj {},
  methods: {
    "static formatNumber(Ljava/lang/String;)Ljava/lang/String;": (n: string | null) => n,
    "static formatNumber(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": (n: string | null) => n,
    "static stripSeparators(Ljava/lang/String;)Ljava/lang/String;": (n: string | null) => n?.replace(/[^0-9+]/g, "") ?? null,
  },
});
// apps `implements` this to track refresh-rate / display changes; it must link even though it never fires here
rt.markers("android/hardware/display/DisplayManager$DisplayListener", "android/app/AppOpsManager$OnOpChangedListener", "android/app/AppOpsManager$OnOpActiveChangedListener");
class JAccessibilityManager extends JObj {
  stateListeners = new Set<unknown>();
  touchListeners = new Set<unknown>();
  servicesListeners = new Set<unknown>();
  audioListeners = new Set<unknown>();
}
rt.register({
  name: "android/view/accessibility/AccessibilityManager", ctor: JAccessibilityManager,
  methods: {
    "isEnabled()Z": () => 0,
    "isAudioDescriptionRequested()Z": () => 0,
    "sendAccessibilityEvent(Landroid/view/accessibility/AccessibilityEvent;)V": () => {},
    "addAccessibilityServicesStateChangeListener(Ljava/util/concurrent/Executor;Landroid/view/accessibility/AccessibilityManager$AccessibilityServicesStateChangeListener;)V": function (this: JAccessibilityManager, _executor: unknown, listener: unknown) { this.servicesListeners.add(listener); },
    "addAudioDescriptionRequestedChangeListener(Ljava/util/concurrent/Executor;Landroid/view/accessibility/AccessibilityManager$AudioDescriptionRequestedChangeListener;)V": function (this: JAccessibilityManager, _executor: unknown, listener: unknown) { this.audioListeners.add(listener); },
    "removeAudioDescriptionRequestedChangeListener(Landroid/view/accessibility/AccessibilityManager$AudioDescriptionRequestedChangeListener;)Z": function (this: JAccessibilityManager, listener: unknown) { return +this.audioListeners.delete(listener); },
    "isTouchExplorationEnabled()Z": () => 0,
    "getRecommendedTimeoutMillis(II)I": (orig: number) => orig,
    "addAccessibilityStateChangeListener(Landroid/view/accessibility/AccessibilityManager$AccessibilityStateChangeListener;)Z": function (this: JAccessibilityManager, listener: unknown) { this.stateListeners.add(listener); return 1; },
    "removeAccessibilityStateChangeListener(Landroid/view/accessibility/AccessibilityManager$AccessibilityStateChangeListener;)Z": function (this: JAccessibilityManager, listener: unknown) { return +this.stateListeners.delete(listener); },
    "addTouchExplorationStateChangeListener(Landroid/view/accessibility/AccessibilityManager$TouchExplorationStateChangeListener;)Z": function (this: JAccessibilityManager, listener: unknown) { this.touchListeners.add(listener); return 1; },
    "removeTouchExplorationStateChangeListener(Landroid/view/accessibility/AccessibilityManager$TouchExplorationStateChangeListener;)Z": function (this: JAccessibilityManager, listener: unknown) { return +this.touchListeners.delete(listener); },
    "addAccessibilityServicesStateChangeListener(Landroid/view/accessibility/AccessibilityManager$AccessibilityServicesStateChangeListener;)V": function (this: JAccessibilityManager, listener: unknown) { this.servicesListeners.add(listener); },
    "removeAccessibilityServicesStateChangeListener(Landroid/view/accessibility/AccessibilityManager$AccessibilityServicesStateChangeListener;)Z": function (this: JAccessibilityManager, listener: unknown) { return +this.servicesListeners.delete(listener); },
    "getEnabledAccessibilityServiceList(I)Ljava/util/List;": () => newArrayList(),
    "getInstalledAccessibilityServiceList()Ljava/util/List;": () => newArrayList(),
  },
});
for (const n of ["AccessibilityStateChangeListener", "TouchExplorationStateChangeListener", "AccessibilityServicesStateChangeListener", "AudioDescriptionRequestedChangeListener"]) {
  rt.register({ name: "android/view/accessibility/AccessibilityManager$" + n, ctor: class extends JObj {} });
}
rt.register({
  name: "android/app/ActivityManager$MemoryInfo",
  ctor: class extends JObj { totalMem = 4n * 1024n ** 3n; availMem = 2n * 1024n ** 3n; lowMemory = 0; threshold = 128n * 1024n * 1024n; },
  fields: ["totalMem", "availMem", "lowMemory", "threshold"],
  methods: { "<init>()V": function () {} },
});
class JRunningAppProcessInfo extends JObj {
  processName = ""; pid = PROCESS_PID; uid = PROCESS_UID; pkgList: string[] = [];
  importance = 100; lru = 0; lastTrimLevel = 0;
  importanceReasonCode = 0; importanceReasonPid = 0;
  importanceReasonComponent: JComponentName | null = null;
}
// A task the recents list would carry. Nothing produces one — this device has no recents —
// but a class an app names as a type has to exist, or the auto-stub poisons everything that
// touches it (see "Four gaps that turned a handled failure into a fatal one").
class JRecentTaskInfo extends JObj {
  id = -1; persistentId = -1; taskId = -1; numActivities = 0; isRunning = 0;
  baseIntent: JIntent | null = null;
  baseActivity: JComponentName | null = null; topActivity: JComponentName | null = null;
  origActivity: JComponentName | null = null; description: string | null = null;
}
rt.register({
  name: "android/app/ActivityManager$RecentTaskInfo", ctor: JRecentTaskInfo, ifaces: ["android/os/Parcelable"],
  fields: ["id", "persistentId", "taskId", "numActivities", "isRunning", "baseIntent", "baseActivity", "topActivity",
    "origActivity", "description"],
  methods: { "<init>()V": function () {} },
});
/** one of the caller's tasks: the activities that share a task id, as the shell stacks them */
class JAppTask extends JObj { taskId = 0; }
function taskInfo(taskId: number): JRecentTaskInfo {
  const activities = (appHost?.activities() ?? []).filter((a) => a.taskId === taskId);
  const info = new JRecentTaskInfo(), component = (a: JActivity | undefined) => a ? mkComponentName(appHost?.pkg ?? "", jclsNameOf(a)) : null;
  info.id = info.persistentId = info.taskId = taskId;
  info.numActivities = activities.length;
  info.isRunning = activities.length ? 1 : 0;
  info.baseIntent = activities[0]?.intent ?? null;
  info.baseActivity = component(activities[0]);
  info.topActivity = component(activities.at(-1));
  return info;
}
function appTasks(): JAppTask[] {
  rt.link("android/app/ActivityManager$AppTask");
  const ids = [...new Set((appHost?.activities() ?? []).map((a) => a.taskId))];
  return ids.map((taskId) => Object.assign(new JAppTask(), { taskId }));
}
rt.register({
  name: "android/app/ActivityManager$AppTask", ctor: JAppTask,
  methods: {
    "getTaskInfo()Landroid/app/ActivityManager$RecentTaskInfo;": function (this: JAppTask) { return taskInfo(this.taskId); },
    "finishAndRemoveTask()V": function (this: JAppTask) { appHost?.finishTask(this.taskId); },
    "moveToFront()V": function () {},
    "setExcludeFromRecents(Z)V": function () {},
  },
});
rt.register({
  name: "android/app/ActivityManager$RunningAppProcessInfo", ctor: JRunningAppProcessInfo, ifaces: ["android/os/Parcelable"],
  statics: {
    IMPORTANCE_FOREGROUND: 100, IMPORTANCE_FOREGROUND_SERVICE: 125, IMPORTANCE_VISIBLE: 200,
    IMPORTANCE_PERCEPTIBLE: 230, IMPORTANCE_SERVICE: 300, IMPORTANCE_TOP_SLEEPING: 325,
    IMPORTANCE_CANT_SAVE_STATE: 350, IMPORTANCE_CACHED: 400, IMPORTANCE_BACKGROUND: 400,
    IMPORTANCE_EMPTY: 500, IMPORTANCE_GONE: 1000,
    REASON_UNKNOWN: 0, REASON_PROVIDER_IN_USE: 1, REASON_SERVICE_IN_USE: 2,
  },
  fields: ["processName", "pid", "uid", "pkgList", "importance", "lru", "lastTrimLevel", "importanceReasonCode",
    "importanceReasonPid", "importanceReasonComponent"],
  methods: { "<init>()V": function () {} },
});
let procInfo: JRunningAppProcessInfo | null = null;
function fillProc<T extends JRunningAppProcessInfo>(p: T): T {
  const pkg = appHost?.pkg ?? "";
  p.processName = PROCESS_NAME || pkg; p.pkgList = [pkg];
  p.importance = appHost?.currentActivity() ? 100 : runningServices.size ? 300 : 400;
  return p;
}
const myProcess = () => fillProc(procInfo ??= new JRunningAppProcessInfo());
// Back itself is still delivered through Activity.onBackPressed (the pre-33 route androidx's
// OnBackPressedDispatcher also serves), so the registry only has to hold the callbacks.
class JBackDispatcher extends JObj { cbs: { p: number; cb: unknown }[] = []; }
rt.register({
  name: "android/window/OnBackInvokedDispatcher", ctor: JBackDispatcher,
  statics: { PRIORITY_DEFAULT: 0, PRIORITY_OVERLAY: 1000000, PRIORITY_SYSTEM: -1 },
  methods: {
    "registerOnBackInvokedCallback(ILandroid/window/OnBackInvokedCallback;)V": function (this: JBackDispatcher, p: number, cb: unknown) {
      if (p < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Application registered OnBackInvokedCallback cannot have negative priority. Value: " + p);
      this.cbs = this.cbs.filter((e) => e.cb !== cb);
      this.cbs.push({ p, cb });
    },
    "unregisterOnBackInvokedCallback(Landroid/window/OnBackInvokedCallback;)V": function (this: JBackDispatcher, cb: unknown) { this.cbs = this.cbs.filter((e) => e.cb !== cb); },
  },
});
rt.markers("android/window/OnBackInvokedCallback");
function callingPackage(): string | null {
  const caller = transactionCaller();
  if (caller) for (const record of packages.values()) if (record.uid === caller.uid) return record.pkg;
  return null;
}
rt.register({
  name: "android/content/ContentProvider", ctor: class extends JObj { $ctx: unknown = null; },
  methods: {
    "getCallingPackage()Ljava/lang/String;": () => callingPackage(),
    "getCallingAttributionSource()Landroid/content/AttributionSource;": () => {
      const caller = transactionCaller();
      if (!caller) return null;
      rt.link("android/content/AttributionSource");
      return Object.assign(new JAttributionSource(), { uid: caller.uid, pid: caller.pid, pkg: callingPackage() });
    },
    "<init>()V": function () {},
    "onCreate()Z": () => 1,
    "getContext()Landroid/content/Context;": function (this: any) { return this.$ctx ?? appHost?.application ?? null; },
    "attachInfo(Landroid/content/Context;Landroid/content/pm/ProviderInfo;)V": async function (this: { $ctx: unknown }, c: unknown) {
      if (this.$ctx) return;
      this.$ctx = c;
      await vcall(this, "onCreate", "()Z");
    },
  },
});

rt.register({ name: "android/app/Service", ctor: JService, sup: "android/content/ContextWrapper",
  ifaces: ["android/content/ComponentCallbacks2", "android/content/ComponentCallbacks"],
  methods: {
    ...wrapperMethods,
    "getApplication()Landroid/app/Application;": function (this: JService) { return this.$host.application; },
    ...noops("<init>()V", "onCreate()V", "onDestroy()V", "onRebind(Landroid/content/Intent;)V",
      "onStart(Landroid/content/Intent;I)V"),
    ...stubs(0, "onUnbind(Landroid/content/Intent;)Z"),
    "onStartCommand(Landroid/content/Intent;II)I": async function (this: JObj, intent: JIntent, _flags: number, startId: number) {
      await vcall(this, "onStart", "(Landroid/content/Intent;I)V", intent, startId); return 1;
    },
    "stopSelf()V": function (this: JObj) { svcStop(jclsNameOf(this)); },
    "stopSelf(I)V": function (this: JObj, startId: number) { svcStop(jclsNameOf(this), startId); },
    "stopSelfResult(I)Z": function (this: JObj, startId: number) { return svcStop(jclsNameOf(this), startId); },
    "startForeground(ILandroid/app/Notification;)V": function (this: JObj) { svcFg(this, true); },
    "startForeground(ILandroid/app/Notification;I)V": function (this: JObj) { svcFg(this, true); }, // the type is advisory
    "stopForeground(Z)V": function (this: JObj) { svcFg(this, false); },
  } });
rt.register({
  name: "android/media/MediaRoute2ProviderService", ctor: class extends JService {}, sup: "android/app/Service",
  methods: { ...wrapperMethods, "<init>()V": function () {} },
});

rt.register({
  name: "android/service/quicksettings/TileService", ctor: class extends JService {}, sup: "android/app/Service",
  methods: {
    ...noops("<init>()V", "onClick()V", "onTileAdded()V", "onTileRemoved()V"),
    "startActivityAndCollapse(Landroid/content/Intent;)V": function (this: JService, intent: JIntent) {
      return vcall(this, "startActivity", "(Landroid/content/Intent;)V", intent);
    },
    "startActivityAndCollapse(Landroid/app/PendingIntent;)V": (intent: unknown) => vcall(intent, "send", "()V"),
  },
});

// API-30 WindowInsetsAnimation: the APK ships desugar stubs whose <clinit> throws
// NoClassDefFoundError; real framework classes shadow them on-device, so must ours.
rt.markers("android/view/WindowInsetsAnimation");
rt.register({
  name: "android/view/WindowInsetsAnimation$Callback", ctor: class extends JObj {},
  methods: { "<init>(I)V": () => {} },
});

class JAppWidgetManager extends JObj {}
rt.register({
  name: "android/appwidget/AppWidgetManager", ctor: JAppWidgetManager,
  methods: {
    "static getInstance(Landroid/content/Context;)Landroid/appwidget/AppWidgetManager;": () => systemService(null, "appwidget"),
    "getAppWidgetIds(Landroid/content/ComponentName;)[I": () => new Int32Array(0),
    "getInstalledProviders()Ljava/util/List;": () => newArrayList(),
    "getInstalledProvidersForPackage(Ljava/lang/String;Landroid/os/UserHandle;)Ljava/util/List;": () => newArrayList(),
    ...noops("updateAppWidget([ILandroid/widget/RemoteViews;)V",
      "updateAppWidget(Landroid/content/ComponentName;Landroid/widget/RemoteViews;)V",
      "updateAppWidget(ILandroid/widget/RemoteViews;)V", "notifyAppWidgetViewDataChanged([II)V"),
    // No widget is placed on a home screen here, so no id names one and its options are empty.
    "getAppWidgetInfo(I)Landroid/appwidget/AppWidgetProviderInfo;": () => null,
    "getAppWidgetOptions(I)Landroid/os/Bundle;": () => new JBundle(),
  },
});
// A widget host would deliver these; nothing does, but the class has to exist — an app class
// extending it cannot link otherwise, and that poisons everything it is referenced from.
rt.register({
  name: "android/appwidget/AppWidgetProvider", ctor: class extends JObj {}, sup: "android/content/BroadcastReceiver",
  methods: {
    ...noops("<init>()V", "onUpdate(Landroid/content/Context;Landroid/appwidget/AppWidgetManager;[I)V",
      "onDeleted(Landroid/content/Context;[I)V", "onEnabled(Landroid/content/Context;)V",
      "onDisabled(Landroid/content/Context;)V", "onRestored(Landroid/content/Context;[I[I)V",
      "onAppWidgetOptionsChanged(Landroid/content/Context;Landroid/appwidget/AppWidgetManager;ILandroid/os/Bundle;)V"),
  },
});
class JAppWidgetProviderInfo extends JObj {
  provider: JComponentName | null = null;
  minWidth = 0; minHeight = 0; minResizeWidth = 0; minResizeHeight = 0;
  resizeMode = 0; updatePeriodMillis = 0; initialLayout = 0; icon = 0; label = "";
}
rt.register({
  name: "android/appwidget/AppWidgetProviderInfo", ctor: JAppWidgetProviderInfo, ifaces: ["android/os/Parcelable"],
  statics: {
    RESIZE_NONE: 0, RESIZE_HORIZONTAL: 1, RESIZE_VERTICAL: 2, RESIZE_BOTH: 3,
    WIDGET_CATEGORY_HOME_SCREEN: 1, WIDGET_CATEGORY_KEYGUARD: 2, WIDGET_CATEGORY_SEARCHBOX: 4,
  },
  fields: ["provider", "minWidth", "minHeight", "minResizeWidth", "minResizeHeight", "resizeMode",
    "updatePeriodMillis", "initialLayout", "icon", "label"],
  methods: {
    "<init>()V": function () {},
    "loadLabel(Landroid/content/pm/PackageManager;)Ljava/lang/String;": function (this: JAppWidgetProviderInfo) { return this.label; },
    ...PARCELABLE,
  },
});

rt.register({
  name: "android/view/autofill/AutofillManager", ctor: class extends JObj {},
  methods: {
    ...stubs(0, "isEnabled()Z", "isAutofillSupported()Z", "hasEnabledAutofillServices()Z"),
    ...noops("notifyValueChanged(Landroid/view/View;)V",
      "notifyValueChanged(Landroid/view/View;ILandroid/view/autofill/AutofillValue;)V",
      "notifyViewEntered(Landroid/view/View;)V", "notifyViewExited(Landroid/view/View;)V",
      "notifyViewVisibilityChanged(Landroid/view/View;Z)V", "notifyViewVisibilityChanged(Landroid/view/View;IZ)V",
      "notifyViewEntered(Landroid/view/View;ILandroid/graphics/Rect;)V", "notifyViewExited(Landroid/view/View;I)V",
      "requestAutofill(Landroid/view/View;)V", "commit()V", "cancel()V",
      "registerCallback(Landroid/view/autofill/AutofillManager$AutofillCallback;)V",
      "unregisterCallback(Landroid/view/autofill/AutofillManager$AutofillCallback;)V", "disableAutofillServices()V"),
    ...stubs(null, "getAutofillServiceComponentName()Landroid/content/ComponentName;"),
  },
});
// no autofill service exists, so a registered callback never hears an event
rt.register({
  name: "android/view/autofill/AutofillManager$AutofillCallback", ctor: class extends JObj {},
  statics: { EVENT_INPUT_SHOWN: 1, EVENT_INPUT_HIDDEN: 2, EVENT_INPUT_UNAVAILABLE: 3 },
  methods: {
    "<init>()V": function () {},
    "onAutofillEvent(Landroid/view/View;II)V": () => {},
  },
});
class JAutofillValue extends JObj { v: unknown = null; }
rt.register({
  name: "android/view/autofill/AutofillValue", ctor: JAutofillValue,
  methods: {
    "static forToggle(Z)Landroid/view/autofill/AutofillValue;": (b: number) => { const a = new JAutofillValue(); a.v = b; return a; },
    "static forText(Ljava/lang/CharSequence;)Landroid/view/autofill/AutofillValue;": (t: unknown) => { const a = new JAutofillValue(); a.v = t; return a; },
    "isText()Z": function (this: JAutofillValue) { return typeof this.v === "string" ? 1 : 0; },
    "isToggle()Z": function (this: JAutofillValue) { return typeof this.v === "number" ? 1 : 0; },
    "getTextValue()Ljava/lang/CharSequence;": function (this: JAutofillValue) { return String(this.v ?? ""); },
    "getToggleValue()Z": function (this: JAutofillValue) { return this.v ? 1 : 0; },
  },
});
