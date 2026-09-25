import { rt, JObj, fieldGetters } from "../jvm/runtime";
import { mangleMethod, jmethod } from "../jvm/abi";
import { vcall } from "../jvm/natives/jlang";
import { attachView, detachView, invalidate } from "./view";
import { rvString, type Resources } from "./res";
import { spannedString } from "./text";
import type { JActionBarView, JMenu } from "./menu";
import type { JContext } from "./context";
import type { JView } from "./view";

rt.markers("android/view/ActionMode$Callback");

export class JActionMode extends JObj {
  jctx: JContext | null = null;
  cb: unknown = null;
  menu: JMenu | null = null;
  title = "";
  subtitle = "";
  customView: JView | null = null;
  bar: JActionBarView | null = null;
  finished = false;
  onFinish: (() => void | Promise<void>) | null = null;
}

const M_setTitle = mangleMethod("setTitle", "(Ljava/lang/CharSequence;)V");
const M_setSubtitle = mangleMethod("setSubtitle", "(Ljava/lang/CharSequence;)V");
function amString(m: JActionMode, id: number): string {
  const res: Resources | null = m.jctx?.$host?.res ?? null;
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
    "setTitle(Ljava/lang/CharSequence;)V": function (this: JActionMode, t: unknown) { this.title = spannedString(t); invalidate(); },
    "setTitle(I)V": function (this: JActionMode, id: number) { jmethod(this, M_setTitle)!.call(this, amString(this, id)); },
    "setSubtitle(Ljava/lang/CharSequence;)V": function (this: JActionMode, t: unknown) { this.subtitle = spannedString(t); invalidate(); },
    "setSubtitle(I)V": function (this: JActionMode, id: number) { jmethod(this, M_setSubtitle)!.call(this, amString(this, id)); },
    "setCustomView(Landroid/view/View;)V": async function (this: JActionMode, view: JView | null) {
      if (this.bar && this.customView) await detachView(this.bar, this.customView);
      this.customView = view;
      if (this.bar && view) await attachView(this.bar, view);
      invalidate();
    },
    ...fieldGetters({ "getMenu()Landroid/view/Menu;": "menu", "getTitle()Ljava/lang/CharSequence;": "title",
      "getSubtitle()Ljava/lang/CharSequence;": "subtitle", "getCustomView()Landroid/view/View;": "customView" }),
    "invalidate()V": async function (this: JActionMode) {
      if (this.cb) await vcall(this.cb, "onPrepareActionMode", "(Landroid/view/ActionMode;Landroid/view/Menu;)Z", this, this.menu);
      invalidate();
    },
    "finish()V": async function (this: JActionMode) {
      if (this.finished) return;
      this.finished = true;
      if (this.cb) await vcall(this.cb, "onDestroyActionMode", "(Landroid/view/ActionMode;)V", this);
      await this.onFinish?.();
      invalidate();
    },
  },
});
