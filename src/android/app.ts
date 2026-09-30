import { JContextWrapper, JContextThemeWrapper, JAttributionSource, systemService, wrapperMethods, themeWrapperMethods, display, displayListeners, grantPermissions, type JContext } from "./context";
import { JWindow } from "./window";
import {
  JIntent, activityTransport, launchIntent, mkComponentName,
  type JComponentName
} from "./intent";
import { type JMenu, JMenuInflater, type JMenuItem, ID_HOME, showMenuPopup, barAnchor } from "./menu";
import { jarray } from "../jvm/abi";
import { reportUncaught, JBundle, PARCELABLE, PROCESS_UID, PROCESS_NAME, mkPfd } from "./os";
import { backKeyMethods, dispatchWindowKey, type JKeyEvent } from "./keyevent";
import { type NativeSpec, rt, callSelf, JObj, stubs, noops, fieldGetters, flagGetters, fieldSetters, driven, type Gen } from "../jvm/runtime";
import { getInflater, inflateLayout } from "./inflate";
import { ensureDecor } from "./decor";
import { requestLayout, type JView, type JLayoutParams, setWindowContent, findById, requireViewById, dispatchConfigurationChanged, invalidate } from "./view";
import { dispatchFragLifecycle, type JFragment, type JFragmentManager } from "./fragment";
import { vcall, vcallOn, curThread, mainThread, vcallUncaught, newObj } from "../jvm/natives/jlang";
import { type JParcel, parcelCreator, readInt, writeInt } from "./parcel";
import type { JMotionEvent } from "./motionevent";
import { appHost, jclsNameOf } from "./apphost";
import { resString } from "./res";
import { inMainJob, onMain } from "./mainloop";
import { getPrefs } from "./sharedprefs";
import { spannedString } from "./text";
import { newArrayList } from "../jvm/natives/jutil";
import { type JIntentSender, startIntentSender } from "./pendingintent";
import { svcStop, svcFg } from "./runningservices";
import { isMusicActive, outputSampleRate, newAudioSessionId, JSpatializer } from "./media";
import { device } from "../shell/config";
import type { JBitmap } from "./graphics";
import { getPM } from "./pm";
import { transactionCaller } from "./binder";
import { packages } from "./packages";
import { lifecycleCallbackMethods, type ActivityLifecycleCallback } from "./lifecycle";
import { clipboardMethods } from "./clipboard";
import { JActionMode, startActionMode } from "./actionmode";

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
  shareIdentity = false;
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
      if (this.shareIdentity) bundle.map.set("android:activity.shareIdentity", 1);
      return bundle;
    },
    "setShareIdentityEnabled(Z)Landroid/app/ActivityOptions;": function (this: JActivityOptions, on: number) { this.shareIdentity = !!on; return this; },
    "isShareIdentityEnabled()Z": function (this: JActivityOptions) { return this.shareIdentity ? 1 : 0; },
  },
});
rt.register({
  name: "android/app/Instrumentation", ctor: class extends JObj {},
  methods: { "<init>()V": function () {} },
});
class JSplashScreenView extends JObj { removed = false; }
rt.register({ name: "android/window/SplashScreenView", ctor: JSplashScreenView, methods: {
  "remove()V": function (this: JSplashScreenView) { this.removed = true; },
} });
class JSplashScreen extends JObj { listener: unknown = null; exitSent = false; }
rt.register({ name: "android/window/SplashScreen", ctor: JSplashScreen, methods: {
  "setOnExitAnimationListener(Landroid/window/SplashScreen$OnExitAnimationListener;)V": function (this: JSplashScreen, listener: unknown) { this.listener = listener; invalidate(); },
  "clearOnExitAnimationListener()V": function (this: JSplashScreen) { this.listener = null; },
} });
rt.markers("android/window/SplashScreen$OnExitAnimationListener");
export const dispatchSplashExit = driven(function* dispatchSplashExit(activity: JActivity): Gen<void> {
  const splash = activity.splashScreen;
  if (!splash?.listener || splash.exitSent) return;
  splash.exitSent = true;
  rt.link("android/window/SplashScreenView");
  yield vcall(splash.listener, "onSplashScreenExit", "(Landroid/window/SplashScreenView;)V", new JSplashScreenView());
});
export class JActivity extends JContextThemeWrapper {
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
  actionMode: JActionMode | null = null;
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
  splashScreen: JSplashScreen | null = null;
}
// the API 29 Pre/Post hooks are interface defaults: an implementer's super call must find them
rt.register({
  name: "android/app/Application$ActivityLifecycleCallbacks", ctor: class extends JObj {},
  methods: Object.fromEntries(["Created", "Started", "Resumed", "Paused", "Stopped", "SaveInstanceState", "Destroyed"].flatMap((phase) => ["Pre", "Post"].map((when) =>
    [`onActivity${when}${phase}(Landroid/app/Activity;${phase === "Created" || phase === "SaveInstanceState" ? "Landroid/os/Bundle;" : ""})V`, () => {}]))),
});
function activityActionMode(this: JActivity, cb: unknown) { return startActionMode(this, cb); }
function senderForResult(this: JActivity, s: JIntentSender, code: number, fill: JIntent | null) {
  return startIntentSender(this, s, fill, code >= 0 ? { act: this, code } : undefined);
}
function invalidateOptionsMenu(this: JActivity) { appHost?.invalidateOptionsMenu(this); }
function finishActivity(this: JActivity) { callSelf(activityMethods, "finish()V", this); }
const setActivityContent = driven(function* setActivityContent(act: JActivity, v: JView, lp: JLayoutParams | null): Gen {
  yield ensureDecor(act);
  yield setWindowContent(act.window.contentParent!, v, lp);
});
export const activityMethods: NonNullable<NativeSpec["methods"]> = {
  ...themeWrapperMethods,
  "<init>()V": function (this: JActivity) { this.window.activity = this; },
  "getWindow()Landroid/view/Window;": function (this: JActivity) { return this.window; },
  "getSplashScreen()Landroid/window/SplashScreen;": function (this: JActivity) {
    if (!this.splashScreen) { rt.link("android/window/SplashScreen"); this.splashScreen = new JSplashScreen(); }
    return this.splashScreen;
  },
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
  "startActionMode(Landroid/view/ActionMode$Callback;)Landroid/view/ActionMode;": activityActionMode,
  "startActionMode(Landroid/view/ActionMode$Callback;I)Landroid/view/ActionMode;": activityActionMode,
  "setContentView(I)V": driven(function* (this: JActivity, layoutId: number): Gen {
    yield ensureDecor(this);
    yield vcall(this.window.contentParent!, "removeAllViews", "()V");
    yield inflateLayout(this, layoutId, this.window.contentParent, true);
    requestLayout(this.window.contentParent!);
  }),
  "setContentView(Landroid/view/View;)V": function (this: JActivity, v: JView) { return setActivityContent(this, v, null); },
  "setContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": function (this: JActivity, v: JView, lp: JLayoutParams) {
    return setActivityContent(this, v, lp);
  },
  "addContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": driven(function* (this: JActivity, v: JView, lp: JLayoutParams): Gen {
    yield ensureDecor(this);
    yield vcall(this.window.contentParent!, "addView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V", v, lp);
  }),
  "findViewById(I)Landroid/view/View;": function (this: JActivity, id: number) {
    return vcall(this.window, "findViewById", "(I)Landroid/view/View;", id);
  },
  "setShowWhenLocked(Z)V": function (this: JActivity, show: number) { return vcall(this.window, "setFlags", "(II)V", show ? 0x80000 : 0, 0x80000); },
  "requireViewById(I)Landroid/view/View;": requireViewById,
  "onStart()V": function (this: JActivity) { this.started = true; return dispatchFragLifecycle(this, "onStart"); },
  "onResume()V": function (this: JActivity) { this.resumed = true; return dispatchFragLifecycle(this, "onResume"); },
  "onPause()V": function (this: JActivity) { this.resumed = false; return dispatchFragLifecycle(this, "onPause"); },
  "onStop()V": function (this: JActivity) { this.started = false; return dispatchFragLifecycle(this, "onStop"); },
  "onDestroy()V": driven(function* (this: JActivity): Gen {
    if (this.actionMode) yield vcall(this.actionMode, "finish", "()V");
    yield dispatchFragLifecycle(this, "onDestroy");
  }),
  /**
   * AOSP Activity.onBackPressed: collapse an expanded action view, then pop the fragment
   * back stack, and only if neither consumed the press, finish. androidx apps land here as
   * the OnBackPressedDispatcher's fallback, after their own callbacks declined it.
   */
  "onBackPressed()V": driven(function* (this: JActivity): Gen {
    const bar = this.actionBarObj;
    if (bar && (yield vcall(bar, "collapseActionView", "()Z"))) return;
    const fm = yield vcall(this, "getFragmentManager", "()Landroid/app/FragmentManager;");
    if (fm && !(yield vcall(fm, "isStateSaved", "()Z")) && (yield vcall(fm, "popBackStackImmediate", "()Z"))) return;
    yield vcall(this, "finish", "()V");
  }),
  // Android routes the options panel through onCreatePanelMenu/onPreparePanel/onMenuItemSelected;
  // apps (and androidx) override those, so the panel entry points must exist and delegate.
  "onCreatePanelMenu(ILandroid/view/Menu;)Z": function (this: JActivity, f: number, menu: JMenu) {
    return f === 0 ? vcall(this, "onCreateOptionsMenu", "(Landroid/view/Menu;)Z", menu) : 1;
  },
  "onPreparePanel(ILandroid/view/View;Landroid/view/Menu;)Z": function (this: JActivity, f: number, _v: unknown, menu: JMenu) {
    return f === 0 ? vcall(this, "onPrepareOptionsMenu", "(Landroid/view/Menu;)Z", menu) : 1;
  },
  "onMenuItemSelected(ILandroid/view/MenuItem;)Z": driven(function* (this: JActivity, f: number, item: JMenuItem): Gen {
    if (f === 6) return (yield vcall(this, "onContextItemSelected", "(Landroid/view/MenuItem;)Z", item)) ? 1 : 0;
    if (f !== 0) return 0;
    if (yield vcall(this, "onOptionsItemSelected", "(Landroid/view/MenuItem;)Z", item)) return 1;
    // AOSP: an android.R.id.home nobody claimed, with DISPLAY_HOME_AS_UP set, becomes Up
    // navigation. Apps that handle Up themselves (popping a fragment, collapsing a search)
    // never get here because their onOptionsItemSelected already returned true.
    const id: number = yield vcall(item, "getItemId", "()I");
    if (id === ID_HOME && this.window.actionBarView?.showUp) {
      return (yield vcall(this, "onNavigateUp", "()Z")) ? 1 : 0;
    }
    return 0;
  }),
  /**
   * AOSP walks getParentActivityIntent() and either recreates the task or navigateUpTo()s.
   * We have one task and no affinities, so the parent is simply whatever sits below us on
   * the stack: Up on it is Back. Routed through finish() so an app override still runs.
   */
  "onNavigateUp()Z": driven(function* (this: JActivity): Gen {
    yield vcall(this, "finish", "()V");
    return 1;
  }),
  "onNavigateUpFromChild(Landroid/app/Activity;)Z": function (this: JActivity) {
    return vcall(this, "onNavigateUp", "()Z");
  },
  // AOSP: the manifest's parentActivityName, as a main-activity intent when that parent has no parent of its own
  "getParentActivityIntent()Landroid/content/Intent;": driven(function* (this: JActivity): Gen {
    const pm = getPM(), info = "(Landroid/content/ComponentName;I)Landroid/content/pm/ActivityInfo;";
    const parent: string | null = (yield vcall(pm, "getActivityInfo", info, mkComponentName(this.$host.pkg, jclsNameOf(this)), 0)).parentActivityName;
    if (!parent) return null;
    const target = mkComponentName(this.$host.pkg, parent);
    let grandparent: string | null;
    try { grandparent = (yield vcall(pm, "getActivityInfo", info, target, 0)).parentActivityName; }
    catch (error) { if (rt.iof(error, "android/content/pm/PackageManager$NameNotFoundException")) return null; throw error; }
    if (!grandparent) return vcall(rt.link("android/content/Intent").ctor, "makeMainActivity", "(Landroid/content/ComponentName;)Landroid/content/Intent;", target);
    const intent: JIntent = rt.make("android/content/Intent");
    intent.component = target.cls; intent.componentPkg = target.pkg;
    return intent;
  }),
  /** AOSP forwards the new Configuration into the window's view hierarchy. */
  "onConfigurationChanged(Landroid/content/res/Configuration;)V": function (this: JActivity, cfg: unknown) {
    return this.window.decor ? dispatchConfigurationChanged(this.window.decor, cfg) : undefined;
  },
  // the rest of Window.Callback, as Activity's no-op defaults
  "onContentChanged()V": function () {},
  "invalidateOptionsMenu()V": invalidateOptionsMenu,
  "openOptionsMenu()V": function (this: JActivity) {
    const bar = this.window.actionBarView;
    if (!bar) return;
    const { overflow } = bar.layoutMenu();
    void showMenuPopup(barAnchor(bar), overflow.length ? overflow : bar.menuItems);
  },
  "setTitle(Ljava/lang/CharSequence;)V": function (this: JActivity, t: unknown) {
    this.titleStr = spannedString(t);
    return vcall(this, "onTitleChanged", "(Ljava/lang/CharSequence;I)V", t, 0);
  },
  // AppCompatActivity overrides this to title its toolbar
  "onTitleChanged(Ljava/lang/CharSequence;I)V": function (this: JActivity, t: unknown) {
    if (this.window.actionBarView) { this.window.actionBarView.titleStr = spannedString(t); invalidate(); }
  },
  "setTitle(I)V": function (this: JActivity, id: number) {
    return vcall(this, "setTitle", "(Ljava/lang/CharSequence;)V", resString(this.$host.res, id));
  },
  "getActionBar()Landroid/app/ActionBar;": driven(function* (this: JActivity): Gen {
    yield ensureDecor(this);
    if (!this.actionBarObj) {
      const info = rt.link("webdroid/ActionBar");
      this.actionBarObj = new info.ctor();
      this.actionBarObj.act = this;
    }
    return this.actionBarObj;
  }),
  "runOnUiThread(Ljava/lang/Runnable;)V": function (this: JActivity, r: unknown) {
    if (curThread === mainThread && inMainJob()) return vcall(r, "run", "()V");
    void onMain(() => vcall(r, "run", "()V")).catch(reportUncaught);
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
    else finishActivity.call(this);
  },
  // Activity.finishAffinity (no embedded activities exist here to refuse)
  "finishAffinity()V": function (this: JActivity) {
    if (this.resultCode !== 0 || this.resultData !== null) throw rt.mkThrowable("java/lang/IllegalStateException", "Can not be called to deliver a result");
    if (this.finished) return;
    this.finished = true;
    appHost?.finishAffinity(this);
  },
  "finishAfterTransition()V": finishActivity,
  "isTaskRoot()Z": function (this: JActivity) { return +(activityTransport.isTaskRoot?.(this) ?? false); },
  // only the task's root may move it unless nonRoot says any activity may
  "moveTaskToBack(Z)Z": function (this: JActivity, nonRoot: number) {
    if (!nonRoot && !(activityTransport.isTaskRoot?.(this) ?? this.$host.activities()[0] === this)) return 0;
    this.$host.moveTaskToBack();
    return 1;
  },
  // AOSP's startActivityForResult only *starts* something; the result arrives later through
  // onActivityResult, which launchIntent arranges without waiting on a system activity's UI.
  // A negative request code asks for no result.
  "startActivityForResult(Landroid/content/Intent;ILandroid/os/Bundle;)V": function (this: JActivity, intent: JIntent, code: number) {
    return launchIntent(this.$host, intent, code >= 0 ? { act: this, code } : undefined);
  },
  "startActivityForResult(Landroid/content/Intent;I)V": function (this: JActivity, intent: JIntent, code: number) {
    return vcall(this, "startActivityForResult", "(Landroid/content/Intent;ILandroid/os/Bundle;)V", intent, code, null);
  },
  "startActivity(Landroid/content/Intent;)V": function (this: JActivity, intent: JIntent) {
    return vcall(this, "startActivity", "(Landroid/content/Intent;Landroid/os/Bundle;)V", intent, null);
  },
  "startActivity(Landroid/content/Intent;Landroid/os/Bundle;)V": function (this: JActivity, intent: JIntent, options: unknown) {
    return options ? vcall(this, "startActivityForResult", "(Landroid/content/Intent;ILandroid/os/Bundle;)V", intent, -1, options)
      : vcall(this, "startActivityForResult", "(Landroid/content/Intent;I)V", intent, -1);
  },
  "startIntentSenderForResult(Landroid/content/IntentSender;ILandroid/content/Intent;III)V": senderForResult,
  "startIntentSenderForResult(Landroid/content/IntentSender;ILandroid/content/Intent;IIILandroid/os/Bundle;)V": senderForResult,
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
  "dispatchTouchEvent(Landroid/view/MotionEvent;)Z": driven(function* (this: JActivity, event: JMotionEvent): Gen {
    const thread = curThread;
    if (event.action === 0) yield vcallOn(thread, this, "onUserInteraction", "()V");
    if (yield vcallOn(thread, this.window, "superDispatchTouchEvent", "(Landroid/view/MotionEvent;)Z", event)) return 1;
    return vcallOn(thread, this, "onTouchEvent", "(Landroid/view/MotionEvent;)Z", event);
  }),
  ...noops("registerScreenCaptureCallback(Ljava/util/concurrent/Executor;Landroid/app/Activity$ScreenCaptureCallback;)V",
    "unregisterScreenCaptureCallback(Landroid/app/Activity$ScreenCaptureCallback;)V"),
  ...noops("onCreate(Landroid/os/Bundle;)V", "onPostCreate(Landroid/os/Bundle;)V", "onRestart()V", "onPostResume()V",
    "onSaveInstanceState(Landroid/os/Bundle;)V",
    "onRestoreInstanceState(Landroid/os/Bundle;)V", "onWindowAttributesChanged(Landroid/view/WindowManager$LayoutParams;)V",
    "onPanelClosed(ILandroid/view/Menu;)V", "onPointerCaptureChanged(Z)V",
    "onProvideKeyboardShortcuts(Ljava/util/List;Landroid/view/Menu;I)V", "onLowMemory()V", "onTrimMemory(I)V",
    "closeOptionsMenu()V",
    "overridePendingTransition(II)V", "overrideActivityTransition(III)V", "overrideActivityTransition(IIII)V",
    "clearOverrideActivityTransition(I)V", "startPostponedEnterTransition()V", "reportFullyDrawn()V",
    "setVolumeControlStream(I)V", "setDefaultKeyMode(I)V", "showDialog(I)V", "dismissDialog(I)V",
    "setFinishOnTouchOutside(Z)V"),
  ...stubs(1, "onCreateOptionsMenu(Landroid/view/Menu;)Z", "onPrepareOptionsMenu(Landroid/view/Menu;)Z",
    "onMenuOpened(ILandroid/view/Menu;)Z"),
  ...backKeyMethods,
  // Activity.dispatchKeyEvent: the window's view tree first, then KeyEvent.dispatch to the activity
  "dispatchKeyEvent(Landroid/view/KeyEvent;)Z": driven(function* (this: JActivity, ev: JKeyEvent): Gen {
    yield vcall(this, "onUserInteraction", "()V");
    return dispatchWindowKey(this, this.window.decor, ev);
  }),
  "onSearchRequested(Landroid/view/SearchEvent;)Z": function (this: JActivity) { return vcall(this, "onSearchRequested", "()Z"); },
  ...stubs(0, "onOptionsItemSelected(Landroid/view/MenuItem;)Z", "onContextItemSelected(Landroid/view/MenuItem;)Z", "onSearchRequested()Z",
    "onTouchEvent(Landroid/view/MotionEvent;)Z", "getChangingConfigurations()I",
    "shouldShowRequestPermissionRationale(Ljava/lang/String;)Z",
    "isInMultiWindowMode()Z", "isInPictureInPictureMode()Z", "isLaunchedFromBubble()Z"),
  // Activity checks deviceSupportsPictureInPictureMode() first; this device lacks the feature
  ...noops("setPictureInPictureParams(Landroid/app/PictureInPictureParams;)V", "enterPictureInPictureMode()V"),
  "enterPictureInPictureMode(Landroid/app/PictureInPictureParams;)Z": () => 0,
  // a <fragment> tag goes to the FragmentController, which has nothing to inflate here
  "onCreateView(Landroid/view/View;Ljava/lang/String;Landroid/content/Context;Landroid/util/AttributeSet;)Landroid/view/View;":
    function (this: JActivity, _parent: unknown, name: string, c: unknown, attrs: unknown) {
      return name === "fragment" ? null : vcall(this, "onCreateView", "(Ljava/lang/String;Landroid/content/Context;Landroid/util/AttributeSet;)Landroid/view/View;", name, c, attrs);
    },
  ...stubs(null, "onWindowStartingActionMode(Landroid/view/ActionMode$Callback;)Landroid/view/ActionMode;",
    "onWindowStartingActionMode(Landroid/view/ActionMode$Callback;I)Landroid/view/ActionMode;",
    "getCurrentFocus()Landroid/view/View;", "getReferrer()Landroid/net/Uri;"),
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
// Picture-in-picture parameters: data only, since this device has no FEATURE_PICTURE_IN_PICTURE
const PIP_FIELDS = { AspectRatio: "Landroid/util/Rational;", ExpandedAspectRatio: "Landroid/util/Rational;", Actions: "Ljava/util/List;",
  CloseAction: "Landroid/app/RemoteAction;", SourceRectHint: "Landroid/graphics/Rect;", Title: "Ljava/lang/CharSequence;",
  Subtitle: "Ljava/lang/CharSequence;", AutoEnterEnabled: "Z", SeamlessResizeEnabled: "Z" };
class JPipParams extends JObj { values = new Map<string, unknown>(); }
const RATIONAL = "Landroid/util/Rational;";
// each field as a presence flag and its value, as PictureInPictureParams.writeToParcel writes them
const readPipParams = driven(function* (p: JParcel): Gen<JPipParams> {
  const params: JPipParams = rt.make("android/app/PictureInPictureParams");
  for (const [name, type] of Object.entries(PIP_FIELDS)) if (readInt(p)) params.values.set(name, type === "Z" ? readInt(p)
    : type === RATIONAL ? yield newObj("android/util/Rational", "(II)V", readInt(p), readInt(p))
    : yield vcall(p, "readValue", "(Ljava/lang/ClassLoader;)Ljava/lang/Object;", null));
  return params;
});
rt.register({
  name: "android/app/PictureInPictureParams", ctor: JPipParams, ifaces: ["android/os/Parcelable"],
  statics: { get CREATOR() { return parcelCreator("android/app/PictureInPictureParams", readPipParams); } },
  methods: {
    ...Object.fromEntries(Object.entries(PIP_FIELDS).map(([name, type]) => [
      `${type === "Z" ? "is" : "get"}${name}()${type}`, function (this: JPipParams) { return this.values.get(name) ?? (type === "Z" ? 0 : null); }])),
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JPipParams, p: JParcel): Gen {
      for (const [name, type] of Object.entries(PIP_FIELDS)) {
        const v = this.values.get(name) ?? null;
        writeInt(p, +(v !== null));
        if (v === null) continue;
        if (type === "Z") writeInt(p, v as number);
        else if (type === RATIONAL) { writeInt(p, yield vcall(v, "getNumerator", "()I")); writeInt(p, yield vcall(v, "getDenominator", "()I")); }
        else yield vcall(p, "writeValue", "(Ljava/lang/Object;)V", v);
      }
    }),
  },
});
rt.register({
  name: "android/app/PictureInPictureParams$Builder", ctor: class extends JPipParams {},
  methods: {
    ...noops("<init>()V"),
    "<init>(Landroid/app/PictureInPictureParams;)V": function (this: JPipParams, from: JPipParams) { this.values = new Map(from.values); },
    ...Object.fromEntries(Object.entries(PIP_FIELDS).map(([name, type]) => [`set${name}(${type})Landroid/app/PictureInPictureParams$Builder;`,
      function (this: JPipParams, v: unknown) { this.values.set(name, v); return this; }])),
    "build()Landroid/app/PictureInPictureParams;": function (this: JPipParams) { return Object.assign(rt.make("android/app/PictureInPictureParams"), { values: new Map(this.values) }); },
  },
});
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
    ...noops("<init>()V", "onCreate()V", "onLowMemory()V", "onTrimMemory(I)V",
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
    "getIntCoreSetting(Ljava/lang/String;I)I": intCoreSetting,
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

let audioCapturePolicy = 1;
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
    // the snapshot holds no keys, so every keyed read is out of range
    ...Object.fromEntries(["getTimer(I)Landroid/os/health/TimerStat;", "getMeasurement(I)J", "getStats(I)Ljava/util/Map;",
      "getTimers(I)Ljava/util/Map;", "getMeasurements(I)Ljava/util/Map;"].map((sig) => [sig, () => { throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null); }])),
  },
});
for (const [name, methods, statics] of [
  // No Bluetooth or NFC radio: the managers exist, as AOSP always registers them, and report no
  // adapter, which is what a device without the feature answers.
  ["android/bluetooth/BluetoothAdapter", {
    "static getDefaultAdapter()Landroid/bluetooth/BluetoothAdapter;": () => null,
    "isEnabled()Z": () => 0,
  }],
  ["android/bluetooth/BluetoothManager", {
    "getAdapter()Landroid/bluetooth/BluetoothAdapter;": () => null,
    "getConnectedDevices(I)Ljava/util/List;": () => newArrayList(),
    "getDevicesMatchingConnectionStates(I[I)Ljava/util/List;": () => newArrayList(),
    "getConnectionState(Landroid/bluetooth/BluetoothDevice;I)I": () => 0, // STATE_DISCONNECTED
  }],
  ["android/nfc/NfcManager", { "getDefaultAdapter()Landroid/nfc/NfcAdapter;": () => null }],
  ["android/nfc/NfcAdapter", { "static getDefaultAdapter(Landroid/content/Context;)Landroid/nfc/NfcAdapter;": () => null }],
  // a single-user device with no managed profile: nothing to reach across
  ["android/content/pm/CrossProfileApps", {
    "getTargetUserProfiles()Ljava/util/List;": () => newArrayList(),
    ...stubs(0, "canInteractAcrossProfiles()Z", "canRequestInteractAcrossProfiles()Z"),
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
    // every stream reports a non-zero volume, so none is muted
    ...stubs(0, "isStreamMute(I)Z", "getMode()I", "isSpeakerphoneOn()Z", "isBluetoothA2dpOn()Z", "isWiredHeadsetOn()Z",
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
    // AOSP's getService() caches the audio service binder here, which servicemanager answers for
    sService: null,
  }],
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
  // A Wi-Fi-only device with no SIM: no operator, no radio, and the identifiers API 29+
  // withholds from ordinary apps are null.
  ["android/telephony/TelephonyManager", {
    ...stubs("", "getNetworkOperator()Ljava/lang/String;", "getNetworkOperatorName()Ljava/lang/String;",
      "getSimOperator()Ljava/lang/String;", "getSimOperatorName()Ljava/lang/String;",
      "getSimCountryIso()Ljava/lang/String;", "getNetworkCountryIso()Ljava/lang/String;"),
    ...stubs(0, "getPhoneType()I", "getNetworkType()I", "getDataNetworkType()I", "getCallState()I", "getDataState()I",
      "isNetworkRoaming()Z", "hasIccCard()Z"),
    ...stubs(1, "getSimState()I"),
    ...stubs(null, "getDeviceId()Ljava/lang/String;", "getLine1Number()Ljava/lang/String;",
      "getSubscriberId()Ljava/lang/String;", "getSimSerialNumber()Ljava/lang/String;",
      "getSimCarrierIdName()Ljava/lang/CharSequence;", "getSimSpecificCarrierIdName()Ljava/lang/CharSequence;"),
    ...stubs(-1, "getSimCarrierId()I", "getSimSpecificCarrierId()I"),   // UNKNOWN_CARRIER_ID
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
        void vcallUncaught(executor, "execute", "(Ljava/lang/Runnable;)V", task);
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
    ...stubs(-1, "static getDefaultSubscriptionId()I", "static getDefaultDataSubscriptionId()I",
      "static getDefaultVoiceSubscriptionId()I", "static getDefaultSmsSubscriptionId()I"),
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
    "setApplicationNightMode(I)V": (mode: number) => {
      if (mode < 0 || mode > 3) throw rt.mkThrowable("java/lang/IllegalArgumentException", `Unknown mode: ${mode}`);
      appHost?.setApplicationNightMode(mode);
    },
    "getCurrentModeType()I": () => 1,
    // API 34: the device's contrast setting is standard, and it does not change underneath an app
    "getContrast()F": () => 0,
    "addContrastChangeListener(Ljava/util/concurrent/Executor;Landroid/app/UiModeManager$ContrastChangeListener;)V": () => {},
    "removeContrastChangeListener(Landroid/app/UiModeManager$ContrastChangeListener;)V": () => {},
  }],
  ["android/app/KeyguardManager", { "isKeyguardLocked()Z": () => 0, "inKeyguardRestrictedInputMode()Z": () => 0, "isDeviceSecure()Z": () => 0 }],
  ["android/hardware/SensorManager", { "getDefaultSensor(I)Landroid/hardware/Sensor;": () => null, "getSensorList(I)Ljava/util/List;": () => newArrayList(),
    ...stubs(0, "registerListener(Landroid/hardware/SensorEventListener;Landroid/hardware/Sensor;I)Z",
      "registerListener(Landroid/hardware/SensorEventListener;Landroid/hardware/Sensor;II)Z",
      "registerListener(Landroid/hardware/SensorEventListener;Landroid/hardware/Sensor;ILandroid/os/Handler;)Z"),
    ...noops("unregisterListener(Landroid/hardware/SensorEventListener;)V",
      "unregisterListener(Landroid/hardware/SensorEventListener;Landroid/hardware/Sensor;)V"),
    "static getAltitude(FF)F": (p0: number, p: number) => Math.fround(44330 * Math.fround(1 - Math.fround(Math.pow(Math.fround(p / p0), Math.fround(1 / Math.fround(5.255)))))),
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
    } }],
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
    "getDisplays()[Landroid/view/Display;": driven(function* (): Gen { return jarray([yield display()], "Landroid/view/Display;"); }),
    "getDisplays(Ljava/lang/String;)[Landroid/view/Display;": driven(function* (cat: string | null): Gen { return jarray(cat === null ? [yield display()] : [], "Landroid/view/Display;"); }),
    "registerDisplayListener(Landroid/hardware/display/DisplayManager$DisplayListener;Landroid/os/Handler;)V": (l: unknown) => {
      if (l === null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "listener must not be null");
      displayListeners.add(l);
    },
    "unregisterDisplayListener(Landroid/hardware/display/DisplayManager$DisplayListener;)V": (l: unknown) => { displayListeners.delete(l); },
  }, { DISPLAY_CATEGORY_PRESENTATION: "android.hardware.display.category.PRESENTATION" }],
] as [string, NativeSpec["methods"], NativeSpec["statics"]?][]) {
  rt.register({ name, ctor: class extends JObj {}, methods, statics });
}
// the app in front is in the ACTIVE standby bucket and never inactive
rt.register({ name: "android/app/usage/UsageStatsManager", ctor: class extends JObj {}, methods: {
  "getAppStandbyBucket()I": () => 10,
  "isAppInactive(Ljava/lang/String;)Z": () => 0,
} });
// callback bases apps extend; without a radio nothing ever invokes them
for (const name of ["android/bluetooth/le/ScanCallback", "android/bluetooth/BluetoothGattCallback"]) {
  rt.register({ name, ctor: class extends JObj {}, methods: { "<init>()V": function () {} } });
}
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
  ctor: class extends JObj { totalMem = 0n; availMem = 0n; lowMemory = 0; threshold = 0n; },
  fields: ["totalMem", "availMem", "lowMemory", "threshold"],
  methods: { "<init>()V": function () {} },
});
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
let pipeId = 0;
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
    "attachInfo(Landroid/content/Context;Landroid/content/pm/ProviderInfo;)V": driven(function* (this: { $ctx: unknown }, c: unknown): Gen {
      if (this.$ctx) return;
      this.$ctx = c;
      yield vcall(this, "onCreate", "()Z");
    }),
    "bulkInsert(Landroid/net/Uri;[Landroid/content/ContentValues;)I": driven(function* (this: JObj, uri: unknown, values: unknown[]): Gen {
      if (!uri || !values) rt.npe();
      for (const value of values) yield vcall(this, "insert", "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;", uri, value);
      return values.length;
    }),
    "openPipeHelper(Landroid/net/Uri;Ljava/lang/String;Landroid/os/Bundle;Ljava/lang/Object;Landroid/content/ContentProvider$PipeDataWriter;)Landroid/os/ParcelFileDescriptor;":
      driven(function* (uri: unknown, mime: string, opts: unknown, args: unknown, writer: unknown): Gen {
        let bytes = new Uint8Array(0);
        const output = mkPfd(bytes, (value) => { bytes = value.slice(); }, `pipe:${++pipeId}`);
        try { yield vcall(writer, "writeDataToPipe", "(Landroid/os/ParcelFileDescriptor;Landroid/net/Uri;Ljava/lang/String;Landroid/os/Bundle;Ljava/lang/Object;)V", output, uri, mime, opts, args); }
        finally { yield vcall(output, "close", "()V"); }
        return mkPfd(bytes, null);
      }),
  },
});
rt.markers("android/content/ContentProvider$PipeDataWriter");

export class JService extends JContextWrapper {}
rt.register({ name: "android/app/Service", ctor: JService, sup: "android/content/ContextWrapper",
  ifaces: ["android/content/ComponentCallbacks2", "android/content/ComponentCallbacks"],
  methods: {
    ...wrapperMethods,
    "getApplication()Landroid/app/Application;": function (this: JService) { return this.$host.application; },
    ...noops("<init>()V", "onCreate()V", "onDestroy()V"),
    "onStartCommand(Landroid/content/Intent;II)I": driven(function* (this: JObj, intent: JIntent, _flags: number, startId: number): Gen {
      yield vcall(this, "onStart", "(Landroid/content/Intent;I)V", intent, startId); return 1;
    }),
    "stopSelf()V": function (this: JObj) { svcStop(jclsNameOf(this)); },
    "stopSelf(I)V": function (this: JObj, startId: number) { svcStop(jclsNameOf(this), startId); },
    "stopSelfResult(I)Z": function (this: JObj, startId: number) { return svcStop(jclsNameOf(this), startId); },
    "startForeground(ILandroid/app/Notification;)V": function (this: JObj) { svcFg(this, true); },
    "startForeground(ILandroid/app/Notification;I)V": function (this: JObj) { svcFg(this, true); }, // the type is advisory
    "stopForeground(Z)V": function (this: JObj) { svcFg(this, false); },
    "stopForeground(I)V": function (this: JObj) { svcFg(this, false); },
  } });
rt.register({
  name: "android/media/MediaRoute2ProviderService", ctor: class extends JService {}, sup: "android/app/Service",
  methods: { ...wrapperMethods, "<init>()V": function () {} },
});

rt.register({
  name: "android/service/quicksettings/TileService", ctor: class extends JService {}, sup: "android/app/Service",
  methods: {
    ...noops("<init>()V"),
    "static requestListeningState(Landroid/content/Context;Landroid/content/ComponentName;)V": (context: unknown, component: unknown) => {
      if (context == null || component == null) rt.npe();
      rt.noteMissing("systemService statusbar");
    },
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
    "onReceive(Landroid/content/Context;Landroid/content/Intent;)V": driven(function* (this: JObj, context: JContext, intent: JIntent): Gen {
      const action = intent.action;
      if (!action?.startsWith("android.appwidget.action.APPWIDGET_")) return;
      const suffix = action.slice("android.appwidget.action.APPWIDGET_".length);
      const ids = intent.extras.map.get("appWidgetIds") as Int32Array | null ?? null;
      const manager = systemService(context, "appwidget");
      if (suffix === "UPDATE" && ids?.length) yield vcall(this, "onUpdate", "(Landroid/content/Context;Landroid/appwidget/AppWidgetManager;[I)V", context, manager, ids);
      else if (suffix === "DELETED" && ids?.length) yield vcall(this, "onDeleted", "(Landroid/content/Context;[I)V", context, ids);
      else if (suffix === "ENABLED") yield vcall(this, "onEnabled", "(Landroid/content/Context;)V", context);
      else if (suffix === "DISABLED") yield vcall(this, "onDisabled", "(Landroid/content/Context;)V", context);
      else if (suffix === "OPTIONS_CHANGED") {
        const id = Number(intent.extras.map.get("appWidgetId") ?? -1);
        if (id !== -1) yield vcall(this, "onAppWidgetOptionsChanged", "(Landroid/content/Context;Landroid/appwidget/AppWidgetManager;ILandroid/os/Bundle;)V", context, manager, id, intent.extras.map.get("appWidgetOptions") ?? null);
      } else if (suffix === "RESTORED") {
        const oldIds = intent.extras.map.get("appWidgetOldIds") as Int32Array | null ?? null;
        if (oldIds && ids) yield vcall(this, "onRestored", "(Landroid/content/Context;[I[I)V", context, oldIds, ids);
      }
    }),
    ...noops("<init>()V"),
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
    "static forText(Ljava/lang/CharSequence;)Landroid/view/autofill/AutofillValue;": (t: unknown) => {
      if (t == null) return null;
      const a = new JAutofillValue(); a.v = t; return a;
    },
    "isText()Z": function (this: JAutofillValue) { return typeof this.v !== "number" ? 1 : 0; },
    "isToggle()Z": function (this: JAutofillValue) { return typeof this.v === "number" ? 1 : 0; },
    "getTextValue()Ljava/lang/CharSequence;": function (this: JAutofillValue) {
      if (typeof this.v === "number") throw rt.mkThrowable("java/lang/IllegalStateException", "value must be a text value, not type=2");
      return this.v;
    },
    "getToggleValue()Z": function (this: JAutofillValue) { return this.v ? 1 : 0; },
  },
});
