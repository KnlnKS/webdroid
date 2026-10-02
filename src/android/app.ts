// The TS Activity, Application and Service objects, which only the TS view layer and activity stack
// (shell/activities.ts) still reach: AOSP's bytecode runs android/app.
import { JContextWrapper, JContextThemeWrapper } from "./context";
import { JWindow } from "./window";
import type { JIntent, JComponentName } from "./intent";
import type { JMenu } from "./menu";
import { type NativeSpec, rt, JObj, driven, type Gen } from "../jvm/runtime";
import { inflateLayout } from "./inflate";
import { ensureDecor } from "./decor";
import { requestLayout, type JView, type JLayoutParams, setWindowContent } from "./view";
import type { JFragment, JFragmentManager } from "./fragment";
import { vcall, after } from "../jvm/natives/jlang";
import { csText } from "../jvm/natives/jchars";
import type { JActionMode } from "./actionmode";

class JSplashScreenView extends JObj {}
class JSplashScreen extends JObj { listener: unknown = null; exitSent = false; }
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
  lifecycleCbs: object[] | null = null;
  fragMgr: JFragmentManager | null = null;
  fragmentResults = new Map<number, { fragment: JFragment; requestCode: number }>();
  nextFragmentRequestCode = 1;
  // set while a configuration-change relaunch is tearing this instance down, so androidx keeps
  // the ViewModelStore alive; the retained object is handed to the replacement instance.
  changingConfigurations = false;
  lastNonConfig: unknown = null;
  requestedOrientation = -1;
  splashScreen: JSplashScreen | null = null;
}
const setActivityContent = driven(function* setActivityContent(act: JActivity, v: JView, lp: JLayoutParams | null): Gen {
  yield ensureDecor(act);
  yield setWindowContent(act.window.contentParent!, v, lp);
});
/** the Activity entries the TS PhoneWindow forwards to */
export const activityMethods: NonNullable<NativeSpec["methods"]> = {
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
  "setTitle(Ljava/lang/CharSequence;)V": function (this: JActivity, t: unknown) {
    return after(csText(t), (s) => { this.titleStr = s; return vcall(this, "onTitleChanged", "(Ljava/lang/CharSequence;I)V", t, 0); });
  },
};

export class JApplication extends JContextWrapper {
  lifecycleCbs: object[] | null = null;
}
export class JService extends JContextWrapper {}
