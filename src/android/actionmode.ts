import { rt, JObj, fieldGetters, driven, type Gen } from "../jvm/runtime";
import { mangleMethod, jmethod } from "../jvm/abi";
import { vcall } from "../jvm/natives/jlang";
import { JActionBarView, JMenu } from "./menu";
import { addOverlay, removeOverlay } from "./popup";
import { initViewFromCtx, invalidate, type JView } from "./view";
import { rvString, type Resources } from "./res";
import { spannedString } from "./text";
import { device } from "../shell/config";
import type { JActivity } from "./app";

rt.markers("android/view/ActionMode$Callback");

export class JActionMode extends JObj {
  jctx: any = null;
  cb: unknown = null;
  menu: JMenu | null = null;
  customView: JView | null = null;
  title = "";
  subtitle = "";
  finished = false;
  onFinish: (() => void | Promise<void>) | null = null;
  onFinished: (() => void | Promise<void>) | null = null;
}
const M_setTitle = mangleMethod("setTitle", "(Ljava/lang/CharSequence;)V");
const M_setSubtitle = mangleMethod("setSubtitle", "(Ljava/lang/CharSequence;)V");
function resourceString(mode: JActionMode, id: number): string {
  const res: Resources | null = mode.jctx?.$host?.res ?? null;
  return res ? rvString(res, res.resolveRefs(res.value(id))) ?? "" : "";
}
rt.register({
  name: "android/view/ActionMode", ctor: JActionMode,
  methods: {
    "getMenuInflater()Landroid/view/MenuInflater;": function (this: JActionMode) {
      const inf = rt.make("android/view/MenuInflater");
      inf.jctx = this.jctx;
      return inf;
    },
    "setTitle(Ljava/lang/CharSequence;)V": function (this: JActionMode, title: unknown) { this.title = spannedString(title); invalidate(); },
    "setTitle(I)V": function (this: JActionMode, id: number) { jmethod(this, M_setTitle)!.call(this, resourceString(this, id)); },
    "setSubtitle(Ljava/lang/CharSequence;)V": function (this: JActionMode, title: unknown) { this.subtitle = spannedString(title); invalidate(); },
    "setSubtitle(I)V": function (this: JActionMode, id: number) { jmethod(this, M_setSubtitle)!.call(this, resourceString(this, id)); },
    "setCustomView(Landroid/view/View;)V": function (this: JActionMode, view: JView | null) { this.customView = view; invalidate(); },
    ...fieldGetters({ "getMenu()Landroid/view/Menu;": "menu", "getTitle()Ljava/lang/CharSequence;": "title",
      "getSubtitle()Ljava/lang/CharSequence;": "subtitle", "getCustomView()Landroid/view/View;": "customView" }),
    "invalidate()V": driven(function* (this: JActionMode): Gen {
      if (this.cb) yield vcall(this.cb, "onPrepareActionMode", "(Landroid/view/ActionMode;Landroid/view/Menu;)Z", this, this.menu);
      invalidate();
    }),
    "finish()V": driven(function* (this: JActionMode): Gen {
      if (this.finished) return;
      this.finished = true;
      yield this.onFinish?.();
      if (this.cb) yield vcall(this.cb, "onDestroyActionMode", "(Landroid/view/ActionMode;)V", this);
      yield this.onFinished?.();
      invalidate();
    }),
  },
});

export async function startActionMode(activity: JActivity, cb: unknown): Promise<JActionMode | null> {
  const previous = activity.actionMode;
  if (previous) await vcall(previous, "finish", "()V");
  const mode = new JActionMode();
  mode.jctx = activity;
  mode.cb = cb;
  mode.menu = new JMenu();
  const bar = new JActionBarView();
  await initViewFromCtx(bar, activity, null);
  bar.barH = device.dp(56);
  bar.mode = mode;
  bar.showUp = true;
  bar.clickable = true;
  bar.menuItems = mode.menu.items;
  mode.menu.bar = bar;
  if (!await vcall(cb, "onCreateActionMode", "(Landroid/view/ActionMode;Landroid/view/Menu;)Z", mode, mode.menu)) return null;
  activity.actionMode = mode;
  mode.onFinish = async () => {
    removeOverlay(bar);
    if (activity.actionMode === mode) activity.actionMode = null;
  };
  mode.onFinished = async () => {
    await vcall(activity, "onActionModeFinished", "(Landroid/view/ActionMode;)V", mode);
  };
  addOverlay(bar, 0, 0, false, () => vcall(mode, "finish", "()V"));
  await vcall(cb, "onPrepareActionMode", "(Landroid/view/ActionMode;Landroid/view/Menu;)Z", mode, mode.menu);
  await vcall(activity, "onActionModeStarted", "(Landroid/view/ActionMode;)V", mode);
  return mode;
}
