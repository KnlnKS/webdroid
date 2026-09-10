import { JObj, rt, type NativeSpec, maySuspend } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { findById, type JViewGroup, type JView, attachView, detachView, requestLayout, removeFrom } from "./view";
import { getInflater } from "./inflate";
import type { JActivity } from "./app";
import { reportUncaught } from "./os";

// ── legacy android.app.FragmentManager/FragmentTransaction: actually attaches/detaches the
// fragment's view (unlike androidx's fragment library, which ships as bytecode inside the APK
// and needs no native support, `android.app.Fragment` is a platform class apps never bundle,
// so replace()/add()/commit() have to really run the lifecycle + view attach ourselves). ──
export class JFragmentManager extends JObj {
  act: JActivity | null = null;
  active: JFragment[] = [];
}
interface FragOp { kind: "add" | "replace" | "remove"; containerId: number; frag: JFragment | null; tag?: string | null; }
class JFragmentTransaction extends JObj {
  fm: JFragmentManager | null = null;
  ops: FragOp[] = [];
}
async function runFragmentAdd(fm: JFragmentManager, frag: JFragment, containerId: number) {
  const act = fm.act;
  frag.containerId = containerId;
  fm.active.push(frag);
  await vcall(frag, "onAttach", "(Landroid/app/Activity;)V", act);
  await vcall(frag, "onCreate", "(Landroid/os/Bundle;)V", null);
  const container = containerId && act?.window?.decor ? findById(act.window.decor, containerId) as JViewGroup | null : null;
  const view = await vcall(frag, "onCreateView", "(Landroid/view/LayoutInflater;Landroid/view/ViewGroup;Landroid/os/Bundle;)Landroid/view/View;",
    getInflater(act), container, null) as JView | null;
  frag.attachedView = view;
  if (view && container) {
    if (!view.lp) {
      const lp = new (rt.link("android/widget/FrameLayout$LayoutParams").ctor)();
      lp.width = -1; lp.height = -1;
      view.lp = lp;
    }
    attachView(container, view);
  }
  await vcall(frag, "onViewCreated", "(Landroid/view/View;Landroid/os/Bundle;)V", view, null);
  await vcall(frag, "onActivityCreated", "(Landroid/os/Bundle;)V", null);
  if (act?.started) await vcall(frag, "onStart", "()V");
  if (act?.resumed) await vcall(frag, "onResume", "()V");
}
async function runFragmentRemove(fm: JFragmentManager, frag: JFragment) {
  removeFrom(fm.active, frag);
  await vcall(frag, "onPause", "()V");
  await vcall(frag, "onStop", "()V");
  await vcall(frag, "onDestroyView", "()V");
  if (frag.attachedView?.parent) detachView(frag.attachedView.parent as JViewGroup, frag.attachedView);
  frag.attachedView = null;
  await vcall(frag, "onDestroy", "()V");
  await vcall(frag, "onDetach", "()V");
}
async function runFragmentTransaction(tx: JFragmentTransaction): Promise<number> {
  const fm = tx.fm;
  if (!fm) return 0;
  for (const op of tx.ops) {
    if (!op.frag) continue;
    if (op.tag !== undefined) op.frag.tag = op.tag;
    if (op.kind === "replace") {
      const container = op.containerId && fm.act?.window?.decor ? findById(fm.act.window.decor, op.containerId) as JViewGroup | null : null;
      for (const old of [...fm.active]) if (old.containerId === op.containerId) await runFragmentRemove(fm, old);
      if (container) for (const v of [...container.children]) detachView(container, v);
      await runFragmentAdd(fm, op.frag, op.containerId);
    } else if (op.kind === "add") {
      await runFragmentAdd(fm, op.frag, op.containerId);
    } else {
      await runFragmentRemove(fm, op.frag);
    }
  }
  tx.ops.length = 0;
  requestLayout();
  return 0;
}
rt.register({
  name: "android/app/FragmentTransaction", ctor: JFragmentTransaction,
  methods: {
    "add(Landroid/app/Fragment;Ljava/lang/String;)Landroid/app/FragmentTransaction;":
      function (this: JFragmentTransaction, f: JFragment, tag: string | null) { this.ops.push({ kind: "add", containerId: 0, frag: f, tag }); return this; },
    "add(ILandroid/app/Fragment;)Landroid/app/FragmentTransaction;":
      function (this: JFragmentTransaction, id: number, f: JFragment) { this.ops.push({ kind: "add", containerId: id, frag: f }); return this; },
    "remove(Landroid/app/Fragment;)Landroid/app/FragmentTransaction;":
      function (this: JFragmentTransaction, f: JFragment) { this.ops.push({ kind: "remove", containerId: 0, frag: f }); return this; },
    "replace(ILandroid/app/Fragment;)Landroid/app/FragmentTransaction;":
      function (this: JFragmentTransaction, id: number, f: JFragment) { this.ops.push({ kind: "replace", containerId: id, frag: f }); return this; },
    "addToBackStack(Ljava/lang/String;)Landroid/app/FragmentTransaction;": function (this: JFragmentTransaction) { return this; },
    "commit()I": async function (this: JFragmentTransaction) { return runFragmentTransaction(this); },
    "commitAllowingStateLoss()I": maySuspend(function (this: JFragmentTransaction) { return runFragmentTransaction(this); }),
  },
});
rt.register({
  name: "android/app/FragmentManager", ctor: JFragmentManager,
  methods: {
    "beginTransaction()Landroid/app/FragmentTransaction;": function (this: JFragmentManager) {
      const tx = new (rt.link("android/app/FragmentTransaction").ctor)() as JFragmentTransaction;
      tx.fm = this;
      return tx;
    },
    "findFragmentByTag(Ljava/lang/String;)Landroid/app/Fragment;": function (this: JFragmentManager, tag: string | null) {
      return (tag !== null && this.active.find((f) => f.tag === tag)) || null;
    },
    "findFragmentById(I)Landroid/app/Fragment;": function (this: JFragmentManager, id: number) {
      return (id && this.active.find((f) => f.containerId === id)) || null;
    },
    "executePendingTransactions()Z": () => 0, // commit() ran the transaction inline: nothing is pending
    // Nothing pushes to the back stack yet (androidx apps keep their own separate one), but
    // Activity.onBackPressed consults it.
    "isStateSaved()Z": () => 0,
    "popBackStackImmediate()Z": () => 0,
  },
});
export async function dispatchFragLifecycle(act: JActivity, method: string): Promise<void> {
  const active = act.fragMgr?.active;
  if (!active?.length) return;
  for (const f of [...active]) {
    try { await vcall(f, method, "()V"); } catch (e) { reportUncaught(e); }
  }
}

// ── framework (non-androidx) Fragment: real lifecycle surface, AOSP no-op bodies.
export class JFragment extends JObj {
  act: unknown = null;
  args: unknown = null;
  attachedView: JView | null = null;
  containerId = 0;
  tag: string | null = null;
}
export const fragMethods: NonNullable<NativeSpec["methods"]> = {
  "<init>()V": function () {},
  "onAttach(Landroid/app/Activity;)V": function (this: JFragment, a: unknown) { this.act = a; },
  "onAttach(Landroid/content/Context;)V": function (this: JFragment, a: unknown) { this.act = a; },
  "getActivity()Landroid/app/Activity;": function (this: JFragment) { return this.act; },
  "getContext()Landroid/content/Context;": function (this: JFragment) { return this.act; },
  "getResources()Landroid/content/res/Resources;": maySuspend(function (this: JFragment) {
    return this.act ? vcall(this.act, "getResources", "()Landroid/content/res/Resources;") : null;
  }),
  "getString(I)Ljava/lang/String;": maySuspend(function (this: JFragment, id: number) {
    return this.act ? vcall(this.act, "getString", "(I)Ljava/lang/String;", id) : null;
  }),
  "startActivity(Landroid/content/Intent;)V": maySuspend(function (this: JFragment, i: unknown) {
    return this.act ? vcall(this.act, "startActivity", "(Landroid/content/Intent;)V", i) : undefined;
  }),
  "getFragmentManager()Landroid/app/FragmentManager;": maySuspend(function (this: JFragment) {
    return this.act ? vcall(this.act, "getFragmentManager", "()Landroid/app/FragmentManager;") : null;
  }),
  "getArguments()Landroid/os/Bundle;": function (this: JFragment) { return this.args; },
  "setArguments(Landroid/os/Bundle;)V": function (this: JFragment, b: unknown) { this.args = b; },
  "onCreateView(Landroid/view/LayoutInflater;Landroid/view/ViewGroup;Landroid/os/Bundle;)Landroid/view/View;": () => null,
  "getView()Landroid/view/View;": function (this: JFragment) { return this.attachedView; },
  "getTag()Ljava/lang/String;": function (this: JFragment) { return this.tag; },
  "getId()I": function (this: JFragment) { return this.containerId; },
  "onActivityResult(IILandroid/content/Intent;)V": () => {},
  "dump(Ljava/lang/String;Ljava/io/FileDescriptor;Ljava/io/PrintWriter;[Ljava/lang/String;)V": () => {},
  "setHasOptionsMenu(Z)V": () => {}, "setRetainInstance(Z)V": () => {},
};
for (const k of ["isAdded()Z", "isRemoving()Z", "isDetached()Z", "isHidden()Z", "isVisible()Z", "isResumed()Z"]) {
  fragMethods[k] = () => 0;
}
for (const k of ["onCreate(Landroid/os/Bundle;)V", "onActivityCreated(Landroid/os/Bundle;)V",
  "onSaveInstanceState(Landroid/os/Bundle;)V", "onViewStateRestored(Landroid/os/Bundle;)V",
  "onViewCreated(Landroid/view/View;Landroid/os/Bundle;)V", "onStart()V", "onResume()V", "onPause()V",
  "onStop()V", "onDestroy()V", "onDestroyView()V", "onDetach()V", "onLowMemory()V"]) {
  fragMethods[k] = () => {};
}
rt.register({ name: "android/app/Fragment", ctor: JFragment, methods: fragMethods });
