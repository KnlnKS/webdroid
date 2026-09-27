import { JObj, rt, type NativeSpec, stubs, noops, fieldGetters, fieldSetters, driven, type Gen } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { findById, type JViewGroup, type JView, attachView, detachView, removeFrom } from "./view";
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
/** the view in the activity's window a transaction's container id names */
const containerOf = (fm: JFragmentManager, id: number) =>
  id && fm.act?.window?.decor ? findById(fm.act.window.decor, id) as JViewGroup | null : null;
const runFragmentAdd = driven(function* runFragmentAdd(fm: JFragmentManager, frag: JFragment, containerId: number): Gen {
  const act = fm.act;
  frag.containerId = containerId;
  fm.active.push(frag);
  yield vcall(frag, "onAttach", "(Landroid/app/Activity;)V", act);
  yield vcall(frag, "onCreate", "(Landroid/os/Bundle;)V", null);
  const container = containerOf(fm, containerId);
  const view = (yield vcall(frag, "onCreateView", "(Landroid/view/LayoutInflater;Landroid/view/ViewGroup;Landroid/os/Bundle;)Landroid/view/View;",
    getInflater(act), container, null)) as JView | null;
  frag.attachedView = view;
  if (view && container) {
    if (!view.lp) {
      const lp = rt.make("android/widget/FrameLayout$LayoutParams");
      lp.width = -1; lp.height = -1;
      view.lp = lp;
    }
    yield attachView(container, view);
  }
  yield vcall(frag, "onViewCreated", "(Landroid/view/View;Landroid/os/Bundle;)V", view, null);
  yield vcall(frag, "onActivityCreated", "(Landroid/os/Bundle;)V", null);
  if (act?.started) yield vcall(frag, "onStart", "()V");
  if (act?.resumed) yield vcall(frag, "onResume", "()V");
});
const runFragmentRemove = driven(function* runFragmentRemove(fm: JFragmentManager, frag: JFragment): Gen {
  removeFrom(fm.active, frag);
  yield vcall(frag, "onPause", "()V");
  yield vcall(frag, "onStop", "()V");
  yield vcall(frag, "onDestroyView", "()V");
  if (frag.attachedView?.parent) yield detachView(frag.attachedView.parent as JViewGroup, frag.attachedView);
  frag.attachedView = null;
  yield vcall(frag, "onDestroy", "()V");
  yield vcall(frag, "onDetach", "()V");
});
const runFragmentTransaction = driven(function* runFragmentTransaction(tx: JFragmentTransaction): Gen<number> {
  const fm = tx.fm;
  if (!fm) return 0;
  for (const op of tx.ops) {
    if (!op.frag) continue;
    if (op.tag !== undefined) op.frag.tag = op.tag;
    if (op.kind === "replace") {
      const container = containerOf(fm, op.containerId);
      for (const old of [...fm.active]) if (old.containerId === op.containerId) yield runFragmentRemove(fm, old);
      if (container) for (const v of [...container.children]) yield detachView(container, v);
      yield runFragmentAdd(fm, op.frag, op.containerId);
    } else if (op.kind === "add") {
      yield runFragmentAdd(fm, op.frag, op.containerId);
    } else {
      yield runFragmentRemove(fm, op.frag);
    }
  }
  // the views added and removed above asked for layout themselves, as AOSP's do
  tx.ops.length = 0;
  return 0;
});
const commitTransaction = function (this: JFragmentTransaction) { return runFragmentTransaction(this); };
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
    "commit()I": commitTransaction,
    "commitAllowingStateLoss()I": commitTransaction,
  },
});
rt.register({
  name: "android/app/FragmentManager", ctor: JFragmentManager,
  methods: {
    "beginTransaction()Landroid/app/FragmentTransaction;": function (this: JFragmentManager) {
      const tx = rt.make("android/app/FragmentTransaction") as JFragmentTransaction;
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
export const dispatchFragLifecycle = driven(function* dispatchFragLifecycle(act: JActivity, method: string): Gen<void> {
  const active = act.fragMgr?.active;
  if (!active?.length) return;
  for (const f of [...active]) {
    try { yield vcall(f, method, "()V"); } catch (e) { reportUncaught(e); }
  }
});

// ── framework (non-androidx) Fragment: real lifecycle surface, AOSP no-op bodies.
export class JFragment extends JObj {
  act: unknown = null;
  args: unknown = null;
  attachedView: JView | null = null;
  containerId = 0;
  tag: string | null = null;
}
export const fragMethods: NonNullable<NativeSpec["methods"]> = {
  ...fieldSetters({ "onAttach(Landroid/app/Activity;)V": "act", "onAttach(Landroid/content/Context;)V": "act" }),
  ...fieldGetters({ "getActivity()Landroid/app/Activity;": "act", "getContext()Landroid/content/Context;": "act" }),
  "getResources()Landroid/content/res/Resources;": function (this: JFragment) {
    return this.act ? vcall(this.act, "getResources", "()Landroid/content/res/Resources;") : null;
  },
  "getString(I)Ljava/lang/String;": function (this: JFragment, id: number) {
    return this.act ? vcall(this.act, "getString", "(I)Ljava/lang/String;", id) : null;
  },
  "startActivity(Landroid/content/Intent;)V": function (this: JFragment, i: unknown) {
    return this.act ? vcall(this.act, "startActivity", "(Landroid/content/Intent;)V", i) : undefined;
  },
  "startActivityForResult(Landroid/content/Intent;I)V": function (this: JFragment, intent: unknown, requestCode: number) {
    const act = this.act as JActivity | null;
    if (!act) throw rt.mkThrowable("java/lang/IllegalStateException", "Fragment not attached to Activity");
    if (requestCode < -1 || requestCode > 0xffff) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Request code must fit in 16 bits");
    let code = requestCode;
    if (code >= 0) {
      const index = act.nextFragmentRequestCode++ & 0x7fff;
      code = (index << 16) | requestCode;
      act.fragmentResults.set(code, { fragment: this, requestCode });
    }
    return vcall(act, "startActivityForResult", "(Landroid/content/Intent;I)V", intent, code);
  },
  "getFragmentManager()Landroid/app/FragmentManager;": function (this: JFragment) {
    return this.act ? vcall(this.act, "getFragmentManager", "()Landroid/app/FragmentManager;") : null;
  },
  ...fieldGetters({ "getArguments()Landroid/os/Bundle;": "args", "getView()Landroid/view/View;": "attachedView",
    "getTag()Ljava/lang/String;": "tag", "getId()I": "containerId" }),
  ...fieldSetters({ "setArguments(Landroid/os/Bundle;)V": "args" }),
  ...noops("<init>()V", "onActivityResult(IILandroid/content/Intent;)V",
    "dump(Ljava/lang/String;Ljava/io/FileDescriptor;Ljava/io/PrintWriter;[Ljava/lang/String;)V",
    "setHasOptionsMenu(Z)V", "setRetainInstance(Z)V"),
  // the base class's lifecycle callbacks: empty by design, not missing
  ...Object.fromEntries(["onCreate(Landroid/os/Bundle;)V", "onActivityCreated(Landroid/os/Bundle;)V",
    "onSaveInstanceState(Landroid/os/Bundle;)V", "onViewStateRestored(Landroid/os/Bundle;)V",
    "onViewCreated(Landroid/view/View;Landroid/os/Bundle;)V", "onStart()V", "onResume()V", "onPause()V",
    "onStop()V", "onDestroy()V", "onDestroyView()V", "onDetach()V", "onLowMemory()V"].map((s) => [s, () => {}])),
  ...stubs(null, "onCreateView(Landroid/view/LayoutInflater;Landroid/view/ViewGroup;Landroid/os/Bundle;)Landroid/view/View;"),
  ...stubs(0, "isAdded()Z", "isRemoving()Z", "isDetached()Z", "isHidden()Z", "isVisible()Z", "isResumed()Z"),
};
rt.register({ name: "android/app/Fragment", ctor: JFragment, methods: fragMethods });
