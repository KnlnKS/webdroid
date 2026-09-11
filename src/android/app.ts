import { JContextWrapper, contextMethods, systemService, wrapperMethods, display, displayListeners, grantPermissions } from "./context";
import { JWindow } from "./window";
import {
  JIntent, activityTransport, systemActivities, deliverActivityResult, RESULT_OK, RESULT_CANCELED, launchIntent, mkComponentName,
  type JComponentName
} from "./intent";
import { type JMenu, JMenuInflater, type JMenuItem, ID_HOME, showMenuPopup, barAnchor } from "./menu";
import { mangleMethod, jarray } from "../jvm/abi";
import { reportUncaught, JBundle, PARCELABLE, PROCESS_PID, PROCESS_UID, PROCESS_NAME } from "./os";
import { type NativeSpec, rt, callSelf, JObj, maySuspend, stubs, noops } from "../jvm/runtime";
import { getInflater, inflateLayout } from "./inflate";
import { ensureDecor } from "./decor";
import { requestLayout, type JView, attachView, findById, dispatchConfigurationChanged, invalidate } from "./view";
import { dispatchFragLifecycle, type JFragmentManager } from "./fragment";
import { vcall } from "../jvm/natives/jlang";
import { appHost, jclsNameOf } from "./apphost";
import { resString } from "./res";
import { onMain } from "./mainloop";
import { getPrefs } from "./sharedprefs";
import { csText, spannedString } from "./text";
import { showToast } from "./popup";
import { newArrayList, mkIter, toJsArray } from "../jvm/natives/jutil";
import type { JUri } from "./net";
import { JService, runningServices, svcStop, svcFg } from "./runningservices";
import { isMusicActive, outputSampleRate, JSpatializer } from "./media";
import { device } from "../shell/config";
import type { JBitmap } from "./graphics";
import { JConfigurationInfo } from "./pm";
import { deviceConfiguration } from "./resnative";
import { transactionCaller } from "./binder";
import { packages } from "./packages";

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
    "getLabel()Ljava/lang/String;": function (this: JTaskDescription) { return this.label; },
    "getIcon()Landroid/graphics/Bitmap;": function (this: JTaskDescription) { return this.icon; },
    "getIconResource()I": function (this: JTaskDescription) { return this.iconResource; },
    "getPrimaryColor()I": function (this: JTaskDescription) { return this.primaryColor; },
  },
});
class JActivityOptions extends JObj { animationType = -1; }
rt.register({
  name: "android/app/ActivityOptions", ctor: JActivityOptions,
  methods: {
    "static makeBasic()Landroid/app/ActivityOptions;": () => new JActivityOptions(),
    "static makeSceneTransitionAnimation(Landroid/app/Activity;[Landroid/util/Pair;)Landroid/app/ActivityOptions;": (activity: JActivity) => {
      if (!activity) return rt.npe();
      if (activity.window.features.has(13)) throw rt.unimplemented("ActivityOptions shared element transitions");
      const options = new JActivityOptions(); options.animationType = 6; return options;
    },
    "toBundle()Landroid/os/Bundle;": function (this: JActivityOptions) {
      const bundle = new JBundle();
      if (this.animationType !== -1) bundle.map.set("android:activity.animType", this.animationType);
      return bundle;
    },
  },
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
  lifecycleCbs: unknown[] | null = null;
  fragMgr: JFragmentManager | null = null;
  // set while a configuration-change relaunch is tearing this instance down, so androidx keeps
  // the ViewModelStore alive; the retained object is handed to the replacement instance.
  changingConfigurations = false;
  lastNonConfig: unknown = null;
  requestedOrientation = -1;
}
/** Fire an ActivityLifecycleCallbacks event (both Pre/Post + the plain variant, API 29+ shapes).
 *  androidx ReportFragment.LifecycleCallbacks uses the Post* variants to advance the activity Lifecycle. */
export async function fireActivityLifecycle(act: JActivity, phase: "Created" | "Started" | "Resumed" | "Paused" | "Stopped" | "Destroyed", bundle: unknown = null) {
  // process-wide callbacks (Application.registerActivityLifecycleCallbacks) then this
  // activity's own (API 29 Activity.registerActivityLifecycleCallbacks) — one dispatch point.
  const app = act.$host?.application as JApplication | null | undefined;
  const cbs = [...(app?.lifecycleCbs ?? []), ...(act.lifecycleCbs ?? [])];
  if (!cbs.length) return;
  const withBundle = phase === "Created";
  const sig = withBundle ? "(Landroid/app/Activity;Landroid/os/Bundle;)V" : "(Landroid/app/Activity;)V";
  const args = withBundle ? [act, bundle] : [act];
  for (const cb of cbs) {
    for (const variant of [`onActivityPre${phase}`, `onActivity${phase}`, `onActivityPost${phase}`]) {
      // only call variants the callback actually implements (androidx impls vary by API level)
      const key = mangleMethod(variant, sig);
      const fn = (cb as Record<string, unknown>)[key];
      if (typeof fn !== "function") continue;
      try { const r = (fn as (...a: unknown[]) => unknown).apply(cb, args); if (r instanceof Promise) await r; }
      catch (e) { reportUncaught(e); }
    }
  }
}
// the API 29 Pre/Post hooks are interface defaults: an implementer's super call must find them
rt.register({
  name: "android/app/Application$ActivityLifecycleCallbacks", ctor: class extends JObj {},
  methods: Object.fromEntries(["Created", "Started", "Resumed", "Paused", "Stopped", "SaveInstanceState", "Destroyed"].flatMap((phase) => ["Pre", "Post"].map((when) =>
    [`onActivity${when}${phase}(Landroid/app/Activity;${phase === "Created" || phase === "SaveInstanceState" ? "Landroid/os/Bundle;" : ""})V`, () => {}]))),
});
/** Activity (API 29+) and Application both keep their own ActivityLifecycleCallbacks list */
const lifecycleCbMethods: NativeSpec["methods"] = {
  "registerActivityLifecycleCallbacks(Landroid/app/Application$ActivityLifecycleCallbacks;)V": function (this: { lifecycleCbs: unknown[] | null }, cb: unknown) {
    (this.lifecycleCbs ??= []).push(cb);
  },
  "unregisterActivityLifecycleCallbacks(Landroid/app/Application$ActivityLifecycleCallbacks;)V": function (this: { lifecycleCbs: unknown[] | null }, cb: unknown) {
    if (this.lifecycleCbs) this.lifecycleCbs = this.lifecycleCbs.filter((c) => c !== cb);
  },
};
export const activityMethods: NonNullable<NativeSpec["methods"]> = {
  ...contextMethods,
  "<init>()V": maySuspend(function (this: JActivity) { this.window.activity = this; }),
  "getWindow()Landroid/view/Window;": function (this: JActivity) { return this.window; },
  "getOnBackInvokedDispatcher()Landroid/window/OnBackInvokedDispatcher;": function (this: JActivity) { return this.window.backDispatcher(); },
  "getApplication()Landroid/app/Application;": function (this: JActivity) { return this.$host.application; },
  "setTaskDescription(Landroid/app/ActivityManager$TaskDescription;)V": function (this: JActivity, d: JTaskDescription | null) { this.taskDescription = d; },
  ...lifecycleCbMethods,
  "getWindowManager()Landroid/view/WindowManager;": function (this: JActivity) { return systemService(this, "window"); },
  "getIntent()Landroid/content/Intent;": function (this: JActivity) { return this.intent ?? (this.intent = new JIntent()); },
  "setIntent(Landroid/content/Intent;)V": function (this: JActivity, i: JIntent) { this.intent = i; },
  "getLayoutInflater()Landroid/view/LayoutInflater;": function (this: JActivity) { return getInflater(this); },
  "getMenuInflater()Landroid/view/MenuInflater;": function (this: JActivity) {
    const m = new JMenuInflater();
    m.jctx = this;
    return m;
  },
  "setContentView(I)V": async function (this: JActivity, layoutId: number) {
    await ensureDecor(this);
    this.window.contentParent!.children.length = 0;
    await inflateLayout(this, layoutId, this.window.contentParent, true);
    requestLayout();
  },
  "setContentView(Landroid/view/View;)V": async function (this: JActivity, v: JView) {
    await ensureDecor(this);
    this.window.contentParent!.children.length = 0;
    if (!v.lp) {
      const lp = rt.make("android/widget/FrameLayout$LayoutParams");
      lp.width = -1; lp.height = -1;
      v.lp = lp;
    }
    attachView(this.window.contentParent!, v);
    requestLayout();
  },
  "setContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": async function (this: JActivity, v: JView, lp: any) {
    v.lp = lp;
    await callSelf(activityMethods, "setContentView(Landroid/view/View;)V", this, v);
  },
  "addContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": async function (this: JActivity, v: JView, lp: any) {
    await ensureDecor(this);
    v.lp = lp;
    attachView(this.window.contentParent!, v);
  },
  "findViewById(I)Landroid/view/View;": function (this: JActivity, id: number) {
    return this.window.decor ? findById(this.window.decor, id) : null;
  },
  "onStart()V": async function (this: JActivity) { this.started = true; return dispatchFragLifecycle(this, "onStart"); },
  "onResume()V": async function (this: JActivity) { this.resumed = true; return dispatchFragLifecycle(this, "onResume"); },
  "onPause()V": maySuspend(function (this: JActivity) { this.resumed = false; return dispatchFragLifecycle(this, "onPause"); }),
  "onStop()V": maySuspend(function (this: JActivity) { this.started = false; return dispatchFragLifecycle(this, "onStop"); }),
  "onDestroy()V": maySuspend(function (this: JActivity) { return dispatchFragLifecycle(this, "onDestroy"); }),
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
  "onCreatePanelMenu(ILandroid/view/Menu;)Z": maySuspend(function (this: JActivity, f: number, menu: JMenu) {
    return f === 0 ? vcall(this, "onCreateOptionsMenu", "(Landroid/view/Menu;)Z", menu) : 1;
  }),
  "onPreparePanel(ILandroid/view/View;Landroid/view/Menu;)Z": maySuspend(function (this: JActivity, f: number, _v: unknown, menu: JMenu) {
    return f === 0 ? vcall(this, "onPrepareOptionsMenu", "(Landroid/view/Menu;)Z", menu) : 1;
  }),
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
  "onNavigateUpFromChild(Landroid/app/Activity;)Z": maySuspend(function (this: JActivity) {
    return vcall(this, "onNavigateUp", "()Z");
  }),
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
  "setTitle(I)V": maySuspend(function (this: JActivity, id: number) {
    callSelf(activityMethods, "setTitle(Ljava/lang/CharSequence;)V", this, resString(this.$host.res, id));
  }),
  "getTitle()Ljava/lang/CharSequence;": function (this: JActivity) { return this.titleStr; },
  "getActionBar()Landroid/app/ActionBar;": async function (this: JActivity) {
    await ensureDecor(this);
    if (!this.actionBarObj) {
      const info = rt.link("webdroid/ActionBar");
      this.actionBarObj = new info.ctor();
      this.actionBarObj.act = this;
    }
    return this.actionBarObj;
  },
  "runOnUiThread(Ljava/lang/Runnable;)V": maySuspend(function (this: JActivity, r: unknown) {
    void onMain(() => vcall(r, "run", "()V").catch(reportUncaught));
  }),
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
  "finishAffinity()V": maySuspend(function (this: JActivity) { callSelf(activityMethods, "finish()V", this); }),
  "finishAfterTransition()V": maySuspend(function (this: JActivity) { callSelf(activityMethods, "finish()V", this); }),
  "isFinishing()Z": function (this: JActivity) { return this.finished ? 1 : 0; },
  "isDestroyed()Z": function (this: JActivity) { return this.finished ? 1 : 0; },
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
  "startActivityForResult(Landroid/content/Intent;ILandroid/os/Bundle;)V": maySuspend(function (this: JActivity, intent: JIntent, code: number) {
    return callSelf(activityMethods, "startActivityForResult(Landroid/content/Intent;I)V", this, intent, code);
  }),
  "setResult(I)V": function (this: JActivity, c: number) { this.resultCode = c; },
  "setResult(ILandroid/content/Intent;)V": function (this: JActivity, c: number, d: JIntent) {
    this.resultCode = c;
    this.resultData = d;
  },
  "requestWindowFeature(I)Z": function (this: JActivity, f: number) { this.window.features.add(f); return 1; },
  "setRequestedOrientation(I)V": function (this: JActivity, orientation: number) {
    this.requestedOrientation = orientation;
    this.$host.setRequestedOrientation(this, orientation);
  },
  "getRequestedOrientation()I": function (this: JActivity) { return this.requestedOrientation; },
  "getComponentName()Landroid/content/ComponentName;": function (this: JActivity) {
    return mkComponentName(this.$host.pkg, jclsNameOf(this));
  },
  "getLocalClassName()Ljava/lang/String;": function (this: JActivity) { return jclsNameOf(this); },
  "getCallingActivity()Landroid/content/ComponentName;": function (this: JActivity) { return this.callingActivity; },
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
  "hasWindowFocus()Z": function (this: JActivity) { return this.hasWindowFocus ? 1 : 0; },
  "isChangingConfigurations()Z": function (this: JActivity) { return this.changingConfigurations ? 1 : 0; },
  // Activity.isChild is only true for the long-dead ActivityGroup embedding; AppCompat asks it
  // before relaunching for a night-mode change.
  "isChild()Z": () => 0,
  "recreate()V": function (this: JActivity) { appHost?.recreateActivity(this); },
  "getLastNonConfigurationInstance()Ljava/lang/Object;": function (this: JActivity) { return this.lastNonConfig; },
  "getTaskId()I": function (this: JActivity) { return this.taskId || -1; },
  // The system's dialog goes in front of the activity: it pauses, the answer is recorded, and
  // it resumes before the result is delivered. Nobody is here to tap, so asking is what grants
  // — but an app that re-reads the permission in onResume must see the grant by then.
  "requestPermissions([Ljava/lang/String;I)V": maySuspend(function (this: JActivity, perms: string[], code: number) {
    setTimeout(() => {
      void onMain(async () => {
        const granted = grantPermissions(perms);
        await this.$host.roundTrip(this);
        await vcall(this, "onRequestPermissionsResult", "(I[Ljava/lang/String;[I)V", code, perms, granted);
      }).catch(reportUncaught);
    }, 0);
  }),
  "getVolumeControlStream()I": () => 3,
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
    "shouldShowRequestPermissionRationale(Ljava/lang/String;)Z", "dispatchTouchEvent(Landroid/view/MotionEvent;)Z",
    "isInMultiWindowMode()Z"),
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
  lifecycleCbs: unknown[] | null = null;
}
rt.register({
  name: "android/app/Application", ctor: JApplication, sup: "android/content/ContextWrapper",
  ifaces: ["android/content/ComponentCallbacks2", "android/content/ComponentCallbacks"],
  methods: {
    ...wrapperMethods,
    "static getProcessName()Ljava/lang/String;": () => PROCESS_NAME || appHost?.pkg || "app",
    ...noops("<init>()V", "onCreate()V", "onTerminate()V", "onLowMemory()V", "onTrimMemory(I)V",
      "onConfigurationChanged(Landroid/content/res/Configuration;)V"),
    ...lifecycleCbMethods,
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

rt.markers("android/content/ComponentCallbacks", "android/content/ComponentCallbacks2");

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

let audioSession = 0;
for (const [name, methods, statics] of [
  ["android/app/ActivityManager", {
    "getMemoryClass()I": () => 256,
    "getLargeMemoryClass()I": () => 512,
    "isLowRamDevice()Z": () => 0,
    "getRunningAppProcesses()Ljava/util/List;": () => newArrayList([myProcess()]),
    "getProcessMemoryInfo([I)[Landroid/os/Debug$MemoryInfo;": (pids: Int32Array) => jarray(Array.from(pids, () => rt.make("android/os/Debug$MemoryInfo")), "Landroid/os/Debug$MemoryInfo;"),
    "getHistoricalProcessExitReasons(Ljava/lang/String;II)Ljava/util/List;": () => newArrayList(),
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
    "newWakeLock(ILjava/lang/String;)Landroid/os/PowerManager$WakeLock;": () => {
      const info = rt.link("android/os/PowerManager$WakeLock");
      return new info.ctor();
    },
    // the screen is on and this app was never exempted from doze, which is the state an app
    // offering a "disable battery optimisation" prompt is asking about
    "isDeviceIdleMode()Z": () => 0,
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
  ["android/os/Vibrator", {
    "vibrate(J)V": (ms: bigint) => globalThis.navigator?.vibrate?.(Number(ms)),
    "vibrate(Landroid/os/VibrationEffect;)V": () => globalThis.navigator?.vibrate?.(30),
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
    "getSpatializer()Landroid/media/Spatializer;": () => { rt.link("android/media/Spatializer"); return new JSpatializer(); },
    "getStreamVolume(I)I": () => 5,
    "getStreamMaxVolume(I)I": () => 10,
    "generateAudioSessionId()I": () => ++audioSession,
    "getRingerMode()I": () => 2,
    "isMusicActive()Z": isMusicActive,
    // the output path is the Web Audio context: its rate is real, its buffer size is not a fixed number of frames
    "getProperty(Ljava/lang/String;)Ljava/lang/String;": (k: string) => (k === "android.media.property.OUTPUT_SAMPLE_RATE" ? String(outputSampleRate()) : null),
    "getDevices(I)[Landroid/media/AudioDeviceInfo;": () => jarray([], "Landroid/media/AudioDeviceInfo;"),
    "getAudioDevicesForAttributes(Landroid/media/AudioAttributes;)Ljava/util/List;": () => newArrayList(),
    "getDirectProfilesForAttributes(Landroid/media/AudioAttributes;)Ljava/util/List;": () => newArrayList(),
    ...noops("setStreamVolume(III)V",
      "registerAudioDeviceCallback(Landroid/media/AudioDeviceCallback;Landroid/os/Handler;)V",
      "unregisterAudioDeviceCallback(Landroid/media/AudioDeviceCallback;)V"),
    ...stubs(1, "requestAudioFocus(Landroid/media/AudioManager$OnAudioFocusChangeListener;II)I",
      "abandonAudioFocus(Landroid/media/AudioManager$OnAudioFocusChangeListener;)I"),
    ...stubs(0, "getMode()I", "isSpeakerphoneOn()Z", "isBluetoothA2dpOn()Z", "isWiredHeadsetOn()Z",
      "static getPlaybackOffloadSupport(Landroid/media/AudioFormat;Landroid/media/AudioAttributes;)I",
      "static isOffloadedPlaybackSupported(Landroid/media/AudioFormat;Landroid/media/AudioAttributes;)Z"),
    ...stubs("", "getParameters(Ljava/lang/String;)Ljava/lang/String;"),
  }, {
    MODE_NORMAL: 0, MODE_RINGTONE: 1, MODE_IN_CALL: 2, MODE_IN_COMMUNICATION: 3,
    RINGER_MODE_SILENT: 0, RINGER_MODE_VIBRATE: 1, RINGER_MODE_NORMAL: 2,
    GET_DEVICES_INPUTS: 1, GET_DEVICES_OUTPUTS: 2, GET_DEVICES_ALL: 3,
    PROPERTY_OUTPUT_SAMPLE_RATE: "android.media.property.OUTPUT_SAMPLE_RATE", PROPERTY_OUTPUT_FRAMES_PER_BUFFER: "android.media.property.OUTPUT_FRAMES_PER_BUFFER",
    STREAM_VOICE_CALL: 0, STREAM_SYSTEM: 1, STREAM_RING: 2, STREAM_MUSIC: 3, STREAM_ALARM: 4, STREAM_NOTIFICATION: 5,
    AUDIOFOCUS_GAIN: 1, AUDIOFOCUS_LOSS: -1, AUDIOFOCUS_REQUEST_GRANTED: 1, AUDIOFOCUS_REQUEST_FAILED: 0,
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
      "getSubscriberId()Ljava/lang/String;", "getSimSerialNumber()Ljava/lang/String;"),
    ...noops("listen(Landroid/telephony/PhoneStateListener;I)V"),
  }, {
    PHONE_TYPE_NONE: 0, PHONE_TYPE_GSM: 1, PHONE_TYPE_CDMA: 2, PHONE_TYPE_SIP: 3,
    NETWORK_TYPE_UNKNOWN: 0,
    SIM_STATE_UNKNOWN: 0, SIM_STATE_ABSENT: 1, SIM_STATE_READY: 5,
    CALL_STATE_IDLE: 0, CALL_STATE_RINGING: 1, CALL_STATE_OFFHOOK: 2,
    DATA_DISCONNECTED: 0,
  }],
  ["android/os/ext/SdkExtensions", {
    "static getExtensionVersion(I)I": () => 0,
  }],
  ["android/app/AppOpsManager", {
    "noteOpNoThrow(Ljava/lang/String;ILjava/lang/String;)I": maySuspend(function (this: JObj, op: string, uid: number, pkg: string) {
      return vcall(this, "checkOpNoThrow", "(Ljava/lang/String;ILjava/lang/String;)I", op, uid, pkg);
    }),
    "noteOpNoThrow(Ljava/lang/String;ILjava/lang/String;Ljava/lang/String;Ljava/lang/String;)I": maySuspend(function (this: JObj, op: string, uid: number, pkg: string) {
      return vcall(this, "noteOpNoThrow", "(Ljava/lang/String;ILjava/lang/String;)I", op, uid, pkg);
    }),
    "checkOpNoThrow(Ljava/lang/String;ILjava/lang/String;)I": (_op: string, uid: number, pkg: string) => packages.get(pkg)?.uid === uid ? 0 : 2,
    "startOpNoThrow(Ljava/lang/String;ILjava/lang/String;)I": maySuspend(function (this: JObj, op: string, uid: number, pkg: string) {
      return vcall(this, "checkOpNoThrow", "(Ljava/lang/String;ILjava/lang/String;)I", op, uid, pkg);
    }),
    ...stubs(null, "static permissionToOp(Ljava/lang/String;)Ljava/lang/String;"),
    ...stubs(0, "noteOp(Ljava/lang/String;ILjava/lang/String;)I", "noteProxyOp(Ljava/lang/String;Ljava/lang/String;)I",
      "noteProxyOpNoThrow(Ljava/lang/String;Ljava/lang/String;)I", "checkOp(Ljava/lang/String;ILjava/lang/String;)I",
      "unsafeCheckOpNoThrow(Ljava/lang/String;ILjava/lang/String;)I"),
    ...noops("finishOp(Ljava/lang/String;ILjava/lang/String;)V", "checkPackage(ILjava/lang/String;)V",
      "startWatchingMode(Ljava/lang/String;Ljava/lang/String;Landroid/app/AppOpsManager$OnOpChangedListener;)V",
      "stopWatchingMode(Landroid/app/AppOpsManager$OnOpChangedListener;)V"),
  }, { MODE_ALLOWED: 0, MODE_IGNORED: 1, MODE_ERRORED: 2, MODE_DEFAULT: 3 }],
  ["android/view/accessibility/AccessibilityManager", {
    // No real accessibility service runs here — a device with accessibility off reports
    // both flags false. Listeners register (so `implements` links) but never fire, which
    // IS the correct behavior for this state, not a stub shortcut.
    "isEnabled()Z": () => 0,
    "isTouchExplorationEnabled()Z": () => 0,
    "getRecommendedTimeoutMillis(II)I": (orig: number) => orig,
    "addAccessibilityStateChangeListener(Landroid/view/accessibility/AccessibilityManager$AccessibilityStateChangeListener;)Z": () => 1,
    "removeAccessibilityStateChangeListener(Landroid/view/accessibility/AccessibilityManager$AccessibilityStateChangeListener;)Z": () => 1,
    "addTouchExplorationStateChangeListener(Landroid/view/accessibility/AccessibilityManager$TouchExplorationStateChangeListener;)Z": () => 1,
    "removeTouchExplorationStateChangeListener(Landroid/view/accessibility/AccessibilityManager$TouchExplorationStateChangeListener;)Z": () => 1,
    "getEnabledAccessibilityServiceList(I)Ljava/util/List;": () => newArrayList(),
  }],
  ["android/content/ClipboardManager", {
    "setPrimaryClip(Landroid/content/ClipData;)V": () => {},
    "getPrimaryClip()Landroid/content/ClipData;": () => null,
    "hasPrimaryClip()Z": () => 0,
    "getPrimaryClipDescription()Landroid/content/ClipDescription;": () => null,
    "addPrimaryClipChangedListener(Landroid/content/ClipboardManager$OnPrimaryClipChangedListener;)V": () => {},
    "removePrimaryClipChangedListener(Landroid/content/ClipboardManager$OnPrimaryClipChangedListener;)V": () => {},
  }],
  // UI_MODE_TYPE_NORMAL: a handset, not a car/desk/TV dock (Configuration.uiMode agrees).
  // getNightMode reports the device's own setting, which is not this app's to change.
  ["android/app/UiModeManager", {
    "getNightMode()I": () => device.night ? 2 : 1,
    "setNightMode(I)V": () => {},
    "getCurrentModeType()I": () => 1,
  }],
  ["android/app/KeyguardManager", { "isKeyguardLocked()Z": () => 0, "inKeyguardRestrictedInputMode()Z": () => 0, "isDeviceSecure()Z": () => 0 }],
  ["android/hardware/SensorManager", { "getDefaultSensor(I)Landroid/hardware/Sensor;": () => null, "getSensorList(I)Ljava/util/List;": () => newArrayList(), "registerListener(Landroid/hardware/SensorEventListener;Landroid/hardware/Sensor;I)Z": () => 0, "unregisterListener(Landroid/hardware/SensorEventListener;)V": () => {} }],
  ["android/os/BatteryManager", { "getIntProperty(I)I": () => 80, "isCharging()Z": () => 1 }],
  ["android/hardware/display/DisplayManager", {
    // one fixed built-in display: unknown ids are null as in AOSP, and registered listeners
    // never fire because no display is ever added, removed or reconfigured here
    "getDisplay(I)Landroid/view/Display;": maySuspend((id: number) => (id === 0 ? display() : null)),
    "getDisplays()[Landroid/view/Display;": () => jarray([display()], "Landroid/view/Display;"),
    "getDisplays(Ljava/lang/String;)[Landroid/view/Display;": (cat: string | null) => jarray(cat === null ? [display()] : [], "Landroid/view/Display;"),
    "registerDisplayListener(Landroid/hardware/display/DisplayManager$DisplayListener;Landroid/os/Handler;)V": (l: unknown) => {
      if (l === null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "listener must not be null");
      displayListeners.add(l);
    },
    "unregisterDisplayListener(Landroid/hardware/display/DisplayManager$DisplayListener;)V": (l: unknown) => { displayListeners.delete(l); },
  }, { DISPLAY_CATEGORY_PRESENTATION: "android.hardware.display.category.PRESENTATION" }],
] as [string, NativeSpec["methods"], NativeSpec["statics"]?][]) {
  rt.register({ name, ctor: class extends JObj {}, methods, statics });
}
rt.register({ name: "android/telephony/PhoneStateListener", ctor: class extends JObj {}, methods: { "<init>()V": function () {} } });
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
rt.markers("android/hardware/display/DisplayManager$DisplayListener", "android/app/AppOpsManager$OnOpChangedListener");
// AccessibilityManager callback interfaces — apps `implements` these to watch for a
// screen reader turning on; must link even though it never fires here (see above).
for (const n of ["AccessibilityStateChangeListener", "TouchExplorationStateChangeListener"]) {
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
rt.register({
  name: "android/content/ContentProvider", ctor: class extends JObj { $ctx: unknown = null; },
  methods: {
    "getCallingPackage()Ljava/lang/String;": () => {
      const caller = transactionCaller();
      if (caller) for (const record of packages.values()) if (record.uid === caller.uid) return record.pkg;
      return null;
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

class JIntentFilter extends JObj {
  actions: string[] = []; schemes: string[] = []; types: string[] = []; categories: string[] = [];
  /** AOSP's matchData, without authorities and paths: a type matches its own wildcard forms */
  matchData(type: string | null, scheme: string | null, data: JUri | null): number {
    if (!this.types.length && !this.schemes.length) return type === null && data === null ? 0x100000 + 0x8000 : -2;
    let match = 0x100000;
    if (this.schemes.length) {
      if (scheme === null || !this.schemes.includes(scheme)) return -2;
      match = 0x200000;
    } else if (scheme !== null && scheme !== "" && scheme !== "content" && scheme !== "file") return -2;
    if (this.types.length) {
      if (type === null) return -1;
      const slash = type.indexOf("/"), base = slash < 0 ? type : type.slice(0, slash);
      if (!this.types.some((t) => t === type || t === "*/*" || t === base + "/*" || t === base)) return -1;
      return 0x600000 + 0x8000;
    }
    return type !== null ? -1 : match + 0x8000;
  }
}
rt.register({
  name: "android/content/IntentFilter", ctor: JIntentFilter,
  statics: { MATCH_CATEGORY_MASK: 0xfff0000, MATCH_ADJUSTMENT_MASK: 0xffff, MATCH_ADJUSTMENT_NORMAL: 0x8000, MATCH_CATEGORY_EMPTY: 0x100000, MATCH_CATEGORY_SCHEME: 0x200000,
    MATCH_CATEGORY_TYPE: 0x600000, NO_MATCH_TYPE: -1, NO_MATCH_DATA: -2, NO_MATCH_ACTION: -3, NO_MATCH_CATEGORY: -4 },
  methods: {
    "<init>()V": function () {},
    "<init>(Ljava/lang/String;)V": function (this: any, a: string) { this.actions.push(a); },
    "addAction(Ljava/lang/String;)V": function (this: any, a: string) { this.actions.push(a); },
    "countActions()I": function (this: any) { return this.actions.length; },
    "getAction(I)Ljava/lang/String;": function (this: any, i: number) { return this.actions[i] ?? null; },
    "hasAction(Ljava/lang/String;)Z": function (this: any, a: string) { return this.actions.includes(a) ? 1 : 0; },
    "actionsIterator()Ljava/util/Iterator;": function (this: any) { return mkIter(this.actions.slice()); },
    "addCategory(Ljava/lang/String;)V": function (this: JIntentFilter, c: string) { this.categories.push(c); },
    "hasCategory(Ljava/lang/String;)Z": function (this: JIntentFilter, c: string) { return this.categories.includes(c) ? 1 : 0; },
    "countCategories()I": function (this: JIntentFilter) { return this.categories.length; },
    "countDataSchemes()I": function (this: JIntentFilter) { return this.schemes.length; },
    "countDataTypes()I": function (this: JIntentFilter) { return this.types.length; },
    "matchAction(Ljava/lang/String;)Z": function (this: JIntentFilter, a: string | null) { return a !== null && this.actions.includes(a) ? 1 : 0; },
    "matchCategories(Ljava/util/Set;)Ljava/lang/String;": async function (this: JIntentFilter, cats: unknown) {
      for (const c of cats ? await toJsArray(cats) as string[] : []) if (!this.categories.includes(c)) return c;
      return null;
    },
    "matchData(Ljava/lang/String;Ljava/lang/String;Landroid/net/Uri;)I": function (this: JIntentFilter, type: string | null, scheme: string | null, data: JUri | null) {
      return this.matchData(type, scheme, data);
    },
    "match(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Landroid/net/Uri;Ljava/util/Set;Ljava/lang/String;)I":
    async function (this: JIntentFilter, action: string | null, type: string | null, scheme: string | null, data: JUri | null, cats: unknown) {
      if (action !== null && !this.actions.includes(action)) return -3;
      const r = this.matchData(type, scheme, data);
      if (r < 0) return r;
      for (const c of cats ? await toJsArray(cats) as string[] : []) if (!this.categories.includes(c)) return -4;
      return r;
    },
    "addDataScheme(Ljava/lang/String;)V": function (this: { schemes: string[] }, scheme: string) { this.schemes.push(scheme); },
    "addDataType(Ljava/lang/String;)V": function (this: { types: string[] }, type: string) { this.types.push(type); },
    "hasDataType(Ljava/lang/String;)Z": function (this: { types: string[] }, type: string) { return this.types.includes(type) ? 1 : 0; },
  },
});
rt.register({ name: "android/app/Service", ctor: JService, sup: "android/content/ContextWrapper",
  ifaces: ["android/content/ComponentCallbacks2", "android/content/ComponentCallbacks"],
  methods: {
    ...contextMethods,
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

// API-30 WindowInsetsAnimation: the APK ships desugar stubs whose <clinit> throws
// NoClassDefFoundError; real framework classes shadow them on-device, so must ours.
rt.markers("android/view/WindowInsetsAnimation");
rt.register({
  name: "android/view/WindowInsetsAnimation$Callback", ctor: class extends JObj {},
  methods: { "<init>(I)V": () => {} },
});

class JAppWidgetManager extends JObj {}
const theAppWidgetManager = new JAppWidgetManager();
rt.register({
  name: "android/appwidget/AppWidgetManager", ctor: JAppWidgetManager,
  methods: {
    "static getInstance(Landroid/content/Context;)Landroid/appwidget/AppWidgetManager;": () => theAppWidgetManager,
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
