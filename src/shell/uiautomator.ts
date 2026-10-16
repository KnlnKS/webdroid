// What `uiautomator dump` sees, for windows AOSP's ViewRootImpl manages: each window's views as
// AccessibilityNodeInfos, a virtual hierarchy (Compose) through its view's AccessibilityNodeProvider,
// in screen pixels. The e2e harness diffs this against the device's dump.
import { awaited, declaredField, driven, type Gen, type JObj } from "../jvm/runtime";
import { windowZOf } from "../android/server/wm";
import { vcall, scall, newObj, iof } from "../jvm/natives/jentry";
import { csText } from "../jvm/natives/jchars";
import { edges } from "../android/graphics";

interface UiNode {
  text: string; desc: string; cls: string; resId: string; bounds: [number, number, number, number];
  clickable: boolean; enabled: boolean; editable: boolean; scrollable: boolean;
}
const HOST_VIEW_ID = -1, FLAG_SERVICE_REQUESTS_REPORT_VIEW_IDS = 0x100;

function* describe(node: JObj, rect: JObj): Gen<UiNode | null> {
  if (!(yield vcall(node, "isVisibleToUser", "()Z"))) return null;
  yield vcall(node, "getBoundsInScreen", "(Landroid/graphics/Rect;)V", rect);
  const b = edges(rect);
  const text = function* (name: string, desc: string): Gen<string> { return yield* awaited(csText(yield vcall(node, name, desc))); };
  const flag = function* (name: string): Gen<boolean> { return !!(yield vcall(node, name, "()Z")); };
  return {
    text: yield* text("getText", "()Ljava/lang/CharSequence;"),
    desc: yield* text("getContentDescription", "()Ljava/lang/CharSequence;"),
    cls: yield* text("getClassName", "()Ljava/lang/CharSequence;"),
    resId: (yield vcall(node, "getViewIdResourceName", "()Ljava/lang/String;")) ?? "",
    bounds: [b.left, b.top, b.right, b.bottom],
    clickable: yield* flag("isClickable"), enabled: yield* flag("isEnabled"), editable: yield* flag("isEditable"),
    scrollable: yield* flag("isScrollable"),
  };
}

const A11Y_NODE = "android/view/accessibility/AccessibilityNodeInfo";

/** a provider's virtual node and its descendants. A child id naming another view (addChild(View)
 *  stores HOST_VIEW_ID as its virtual part) is that view's own tree, found as
 *  AccessibilityInteractionController finds it. */
function* walkVirtual(hostId: number, provider: JObj, id: number, rect: JObj, out: UiNode[]): Gen<void> {
  const node = yield vcall(provider, "createAccessibilityNodeInfo", "(I)Landroid/view/accessibility/AccessibilityNodeInfo;", id);
  if (!node) return;
  const ui = yield* describe(node, rect);
  if (!ui) return;
  out.push(ui);
  const count: number = yield vcall(node, "getChildCount", "()I");
  for (let i = 0; i < count; i++) {
    const child: bigint = yield vcall(node, "getChildId", "(I)J", i);
    const viewId: number = yield scall(A11Y_NODE, "getAccessibilityViewId", "(J)I", child);
    if (viewId === hostId) {
      yield* walkVirtual(hostId, provider, yield scall(A11Y_NODE, "getVirtualDescendantId", "(J)I", child), rect, out);
      continue;
    }
    const ids = yield scall("android/view/accessibility/AccessibilityNodeIdManager", "getInstance", "()Landroid/view/accessibility/AccessibilityNodeIdManager;");
    const view = yield vcall(ids, "findView", "(I)Landroid/view/View;", viewId);
    if (view) yield* walkView(view, rect, out);
  }
}

function* walkView(view: JObj, rect: JObj, out: UiNode[]): Gen<void> {
  if (!(yield vcall(view, "isShown", "()Z"))) return;
  const provider: JObj | null = yield vcall(view, "getAccessibilityNodeProvider", "()Landroid/view/accessibility/AccessibilityNodeProvider;");
  if (provider) { yield* walkVirtual(yield vcall(view, "getAccessibilityViewId", "()I"), provider, HOST_VIEW_ID, rect, out); return; }
  const node = yield vcall(view, "createAccessibilityNodeInfo", "()Landroid/view/accessibility/AccessibilityNodeInfo;");
  const ui = node && (yield* describe(node, rect));
  if (ui) out.push(ui);
  if (!iof(view, "android/view/ViewGroup")) return;
  const count: number = yield vcall(view, "getChildCount", "()I");
  for (let i = 0; i < count; i++) yield* walkView(yield vcall(view, "getChildAt", "(I)Landroid/view/View;", i), rect, out);
}

/** every window's nodes, bottom window first */
export const dumpWindows = driven(function* (): Gen<UiNode[]> {
  const global = yield scall("android/view/WindowManagerGlobal", "getInstance", "()Landroid/view/WindowManagerGlobal;");
  const views = yield vcall(global, "getWindowViews", "()Ljava/util/ArrayList;");
  const count: number = yield vcall(views, "size", "()I"), roots: { view: JObj; z: number; attach: Record<string, number> }[] = [];
  for (let i = 0; i < count; i++) {
    const view: JObj = yield vcall(views, "get", "(I)Ljava/lang/Object;", i);
    const root = (yield vcall(view, "getViewRootImpl", "()Landroid/view/ViewRootImpl;")) as Record<string, JObj> | null;
    const z = root ? windowZOf(root[declaredField("android/view/ViewRootImpl", "mWindow")]) : -Infinity;
    // only windows the window manager shows are on screen
    if (z > -Infinity) roots.push({ view, z, attach: root![declaredField("android/view/ViewRootImpl", "mAttachInfo")] as Record<string, number> });
  }
  const rect = yield newObj("android/graphics/Rect"), out: UiNode[] = [];
  // UiAutomation's service reports view ids: AccessibilityInteractionController holds its fetch
  // flags on the window's AttachInfo while it builds the nodes
  const flags = declaredField("android/view/View$AttachInfo", "mAccessibilityFetchFlags");
  for (const { view, attach } of roots.sort((a, b) => a.z - b.z)) {
    attach[flags] = FLAG_SERVICE_REQUESTS_REPORT_VIEW_IDS;
    try { yield* walkView(view, rect, out); } finally { attach[flags] = 0; }
  }
  return out;
});
