// What `uiautomator dump` sees, for windows AOSP's ViewRootImpl manages: each window's views as
// AccessibilityNodeInfos, a virtual hierarchy (Compose) through its view's AccessibilityNodeProvider,
// in screen pixels. The e2e harness diffs this against the device's dump.
import { rt, declaredField, type JObj } from "../jvm/runtime";
import { windowZOf } from "../android/server/wm";
import { vcall, scall, newObj } from "../jvm/natives/jlang";

export interface UiNode {
  text: string; desc: string; cls: string; resId: string; bounds: [number, number, number, number];
  clickable: boolean; enabled: boolean; editable: boolean; scrollable: boolean;
}
const HOST_VIEW_ID = -1;
const str = async (cs: unknown): Promise<string> => cs == null ? "" : String(typeof cs === "string" ? cs : await vcall(cs, "toString", "()Ljava/lang/String;"));

async function describe(node: JObj, rect: Record<string, number>): Promise<UiNode | null> {
  if (!await vcall(node, "isVisibleToUser", "()Z")) return null;
  await vcall(node, "getBoundsInScreen", "(Landroid/graphics/Rect;)V", rect);
  const flag = (name: string): Promise<boolean> => Promise.resolve(vcall(node, name, "()Z")).then(Boolean);
  return {
    text: await str(await vcall(node, "getText", "()Ljava/lang/CharSequence;")),
    desc: await str(await vcall(node, "getContentDescription", "()Ljava/lang/CharSequence;")),
    cls: await str(await vcall(node, "getClassName", "()Ljava/lang/CharSequence;")),
    resId: (await vcall(node, "getViewIdResourceName", "()Ljava/lang/String;")) ?? "",
    bounds: [rect.left, rect.top, rect.right, rect.bottom],
    clickable: await flag("isClickable"), enabled: await flag("isEnabled"), editable: await flag("isEditable"),
    scrollable: await flag("isScrollable"),
  };
}

/** a provider's virtual node and its descendants */
async function walkVirtual(provider: JObj, id: number, rect: Record<string, number>, out: UiNode[]): Promise<void> {
  const node = await vcall(provider, "createAccessibilityNodeInfo", "(I)Landroid/view/accessibility/AccessibilityNodeInfo;", id);
  if (!node) return;
  const ui = await describe(node, rect);
  if (!ui) return;
  out.push(ui);
  const count: number = await vcall(node, "getChildCount", "()I");
  for (let i = 0; i < count; i++) {
    const child: bigint = await vcall(node, "getChildId", "(I)J", i);
    await walkVirtual(provider, await scall("android/view/accessibility/AccessibilityNodeInfo", "getVirtualDescendantId", "(J)I", child), rect, out);
  }
}

async function walkView(view: JObj, rect: Record<string, number>, out: UiNode[]): Promise<void> {
  if (!await vcall(view, "isShown", "()Z")) return;
  const provider: JObj | null = await vcall(view, "getAccessibilityNodeProvider", "()Landroid/view/accessibility/AccessibilityNodeProvider;");
  if (provider) { await walkVirtual(provider, HOST_VIEW_ID, rect, out); return; }
  const node = await vcall(view, "createAccessibilityNodeInfo", "()Landroid/view/accessibility/AccessibilityNodeInfo;");
  const ui = node && await describe(node, rect);
  if (ui) out.push(ui);
  if (!rt.iof(view, "android/view/ViewGroup")) return;
  const count: number = await vcall(view, "getChildCount", "()I");
  for (let i = 0; i < count; i++) await walkView(await vcall(view, "getChildAt", "(I)Landroid/view/View;", i), rect, out);
}

/** every window's nodes, bottom window first */
export async function dumpWindows(): Promise<UiNode[]> {
  const global = await scall("android/view/WindowManagerGlobal", "getInstance", "()Landroid/view/WindowManagerGlobal;");
  const views = await vcall(global, "getWindowViews", "()Ljava/util/ArrayList;");
  const count: number = await vcall(views, "size", "()I"), roots: { view: JObj; z: number }[] = [];
  for (let i = 0; i < count; i++) {
    const view: JObj = await vcall(views, "get", "(I)Ljava/lang/Object;", i);
    const root = await vcall(view, "getViewRootImpl", "()Landroid/view/ViewRootImpl;") as Record<string, JObj> | null;
    roots.push({ view, z: root ? windowZOf(root[declaredField("android/view/ViewRootImpl", "mWindow")]) : -Infinity });
  }
  const rect = await newObj("android/graphics/Rect", "()V"), out: UiNode[] = [];
  for (const { view } of roots.sort((a, b) => a.z - b.z)) await walkView(view, rect, out);
  return out;
}
