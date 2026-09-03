// LayoutInflater: binary layout XML → View tree, with Factory2 support (fragments/appcompat).

import { rt, JObj } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { vcall, newObj } from "../jvm/natives/jlang";
import { parseAXML, TV, type XmlNode } from "./axml";
import { JAttrSet, askTheme, themeOf, noteAttrsRead, noteUnreadAttrs } from "./res";
import { JView, JViewGroup, guardCall } from "./view";
import type { AppHost } from "./app";

class JLayoutInflater extends JObj {
  jctx: any = null;
  factory2: unknown = null;
  factory: unknown = null;
  privateFactory: unknown = null;
}

function hostOf(jctx: any): AppHost { return jctx.$host; }

// AOSP resolves an undotted tag against these package prefixes, in this order
// (PhoneLayoutInflater's list, then LayoutInflater.onCreateView's "android.view.").
const TAG_PREFIXES = ["android/widget/", "android/webkit/", "android/app/", "android/view/"];

async function createViewByName(name: string, jctx: any, set: JAttrSet): Promise<JView> {
  let clsName: string;
  // <view class="a.b.C"/> is how AOSP writes a tag whose class name is not a legal element
  // name -- an inner class, above all. The framework's own layouts use it.
  const asClass = name === "view" ? set.node?.attrs.find((a) => a.name === "class" && !a.ns)?.str : null;
  if (asClass) clsName = asClass.replace(/\./g, "/");
  else if (name === "view" || name === "View") clsName = "android/view/View";
  else if (name.includes(".")) clsName = name.replace(/\./g, "/");
  // Probe the registry rather than link()ing each candidate: linking a name we do
  // not implement auto-stubs it and reports a miss that was never real.
  else clsName = TAG_PREFIXES.map((p) => p + name).find((n) => rt.natives.has(n)) ?? "android/widget/" + name;
  return newObj(clsName, "(Landroid/content/Context;Landroid/util/AttributeSet;)V", jctx, set);
}

async function createViewFromTag(
  inflater: JLayoutInflater, parent: JView | null, name: string, jctx: any, set: JAttrSet,
): Promise<JView> {
  for (const factory of [inflater.factory2, inflater.privateFactory]) {
    if (!factory) continue;
    const v = await vcall(factory, "onCreateView",
      "(Landroid/view/View;Ljava/lang/String;Landroid/content/Context;Landroid/util/AttributeSet;)Landroid/view/View;",
      parent, name, jctx, set);
    if (v === parent || (v as JView)?.parent) { console.warn("[inflate] factory returned parent/attached view for", name, "— ignoring"); continue; }
    if (v) return v as JView;
  }
  if (inflater.factory) {
    const v = await vcall(inflater.factory, "onCreateView",
      "(Ljava/lang/String;Landroid/content/Context;Landroid/util/AttributeSet;)Landroid/view/View;", name, jctx, set);
    if (v) return v as JView;
  }
  return createViewByName(name, jctx, set);
}

const A_theme = 0x01010000, A_id = 0x010100d0, A_layout = 0x010100f2, A_layoutWidth = 0x010100f4;
noteAttrsRead(A_theme, A_id, A_layout, A_layoutWidth);
/** AOSP wraps a tag carrying android:theme -- and its whole subtree -- in a ContextThemeWrapper,
 *  which is how a per-widget ThemeOverlay reaches everything the tag contains. */
async function themedCtx(jctx: any, node: XmlNode): Promise<any> {
  const a = node.attrs.find((x) => x.resId === A_theme);
  if (!a) return jctx;
  const id = a.type === TV.ATTRIBUTE ? (await askTheme(jctx))?.lookup(a.data)?.d ?? 0 : a.data;
  return id ? newObj("android/view/ContextThemeWrapper", "(Landroid/content/Context;I)V", jctx, id) : jctx;
}

const M_generateLP = mangleMethod("generateLayoutParams", "(Landroid/util/AttributeSet;)Landroid/view/ViewGroup$LayoutParams;");
const M_addView = mangleMethod("addView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V");
const M_onFinishInflate = mangleMethod("onFinishInflate", "()V");

async function inflateChildren(inflater: JLayoutInflater, node: XmlNode, parentView: JViewGroup, jctx: any) {
  const host = hostOf(jctx);
  for (const child of node.children) {
    if (child.name === "requestFocus" || child.name === "tag") continue;
    if (child.name === "include") {
      const layoutAttr = child.attrs.find((a) => a.name === "layout" || a.resId === A_layout);
      const layoutId = layoutAttr?.data ?? 0;
      if (layoutId) {
        const incView = await inflateLayout(jctx, layoutId, parentView, false);
        // a <merge> include inflates straight into parentView and returns it
        if (incView === parentView) continue;
        if (incView) {
          const set = new JAttrSet();
          set.node = child;
          set.res = host.res;
          set.theme = host.theme;
          const idAttr = child.attrs.find((a) => a.resId === A_id);
          if (idAttr) (incView as JView).idNum = idAttr.data;
          // AOSP: the <include> tag's layout params win only when it declares them; otherwise
          // the included root keeps its own (inflateNode already put them on incView.lp).
          const lp = child.attrs.some((a) => a.resId === A_layoutWidth)
            ? await guardCall((parentView as any)[M_generateLP], parentView, set)
            : (incView as JView).lp ?? await guardCall((parentView as any)[M_generateLP], parentView, set);
          await guardCall((parentView as any)[M_addView], parentView, incView, lp);
        }
      }
      continue;
    }
    const cctx = await themedCtx(jctx, child);
    const set = new JAttrSet();
    set.node = child;
    set.res = host.res;
    set.theme = themeOf(cctx) ?? host.theme;
    const v = await createViewFromTag(inflater, parentView, child.name, cctx, set);
    noteUnreadAttrs(child, child.name);
    let lp = v.lp;
    if (!lp) lp = await guardCall((parentView as any)[M_generateLP], parentView, set);
    await guardCall((parentView as any)[M_addView], parentView, v, lp);
    if (v instanceof JViewGroup && child.children.length) {
      await inflateChildren(inflater, child, v, cctx);
    }
    const fin = (v as any)[M_onFinishInflate];
    if (fin) await guardCall(fin, v);
  }
}

async function inflateNode(jctx: any, root: XmlNode, parent: JViewGroup | null, attach: boolean, inflater?: JLayoutInflater): Promise<JView | null> {
  const host = hostOf(jctx);
  const inf = inflater ?? getInflater(jctx);
  if (root.name === "merge") {
    if (!parent) throw rt.mkThrowable("java/lang/IllegalStateException", "<merge> needs a parent");
    await inflateChildren(inf, root, parent, jctx);
    return parent;
  }
  const rctx = await themedCtx(jctx, root);
  const set = new JAttrSet();
  set.node = root;
  set.res = host.res;
  set.theme = themeOf(rctx) ?? host.theme;
  const v = await createViewFromTag(inf, parent, root.name, rctx, set);
  noteUnreadAttrs(root, root.name);
  if (parent) {
    const lp = await guardCall((parent as any)[M_generateLP], parent, set);
    if (attach) await guardCall((parent as any)[M_addView], parent, v, lp);
    else v.lp = lp;
  }
  if (v instanceof JViewGroup && root.children.length) {
    await inflateChildren(inf, root, v, rctx);
  }
  const fin = (v as any)[M_onFinishInflate];
  if (fin) await guardCall(fin, v);
  return attach && parent ? parent : v;
}

let inflateDepth = 0;
export async function inflateLayout(jctx: any, layoutId: number, parent: unknown, attach: boolean): Promise<JView | null> {
  if (++inflateDepth > 60) { inflateDepth--; throw rt.mkThrowable("java/lang/StackOverflowError", "inflate recursion 0x" + (layoutId>>>0).toString(16)); }
  try { return await inflateLayoutInner(jctx, layoutId, parent, attach); }
  finally { inflateDepth--; }
}
async function inflateLayoutInner(jctx: any, layoutId: number, parent: unknown, attach: boolean): Promise<JView | null> {
  const host = hostOf(jctx);
  const f = host.res.fileOf(layoutId);
  if (!f) {
    rt.noteMissing("layout 0x" + layoutId.toString(16));
    return null;
  }
  const root = parseAXML(f.bytes);
  return inflateNode(jctx, root, (parent as JViewGroup) ?? null, attach && !!parent);
}

const inflaterCache = new WeakMap<object, JLayoutInflater>();
export function getInflater(jctx: any): JLayoutInflater {
  let inf = inflaterCache.get(jctx);
  if (!inf) {
    inf = new JLayoutInflater();
    inf.jctx = jctx;
    inflaterCache.set(jctx, inf);
  }
  return inf;
}

rt.register({
  name: "android/view/LayoutInflater", ctor: JLayoutInflater,
  methods: {
    "static from(Landroid/content/Context;)Landroid/view/LayoutInflater;": (jctx: any) => getInflater(jctx),
    "inflate(ILandroid/view/ViewGroup;)Landroid/view/View;": function (this: JLayoutInflater, id: number, root: unknown) {
      return inflateLayout(this.jctx, id, root, !!root);
    },
    "inflate(ILandroid/view/ViewGroup;Z)Landroid/view/View;": function (this: JLayoutInflater, id: number, root: unknown, attach: number) {
      return inflateLayout(this.jctx, id, root, !!attach);
    },
    "inflate(Landroid/content/res/XmlResourceParser;Landroid/view/ViewGroup;Z)Landroid/view/View;":
      async function (this: JLayoutInflater, parser: any, root: unknown, attach: number) {
        // parser events built from XmlNode; find its root node
        const rootNode: XmlNode | null = parser?.events?.find((e: any) => e.type === 2)?.node ?? null;
        if (!rootNode) return null;
        return inflateNode(this.jctx, rootNode, (root as JViewGroup) ?? null, !!attach, this);
      },
    "setFactory2(Landroid/view/LayoutInflater$Factory2;)V": function (this: JLayoutInflater, f: unknown) { this.factory2 = f; },
    "setFactory(Landroid/view/LayoutInflater$Factory;)V": function (this: JLayoutInflater, f: unknown) { this.factory = f; },
    "getFactory()Landroid/view/LayoutInflater$Factory;": function (this: JLayoutInflater) { return this.factory ?? this.factory2; },
    "getFactory2()Landroid/view/LayoutInflater$Factory2;": function (this: JLayoutInflater) { return this.factory2; },
    "setPrivateFactory(Landroid/view/LayoutInflater$Factory2;)V": function (this: JLayoutInflater, f: unknown) { this.privateFactory = f; },
    "cloneInContext(Landroid/content/Context;)Landroid/view/LayoutInflater;": function (this: JLayoutInflater, jctx: any) {
      const inf = getInflater(jctx);
      inf.factory2 = this.factory2;
      inf.factory = this.factory;
      return inf;
    },
    "getContext()Landroid/content/Context;": function (this: JLayoutInflater) { return this.jctx; },
    "createView(Ljava/lang/String;Ljava/lang/String;Landroid/util/AttributeSet;)Landroid/view/View;":
      async function (this: JLayoutInflater, name: string, prefix: string | null, set: JAttrSet) {
        return createViewByName(prefix ? prefix + name : name, this.jctx, set);
      },
    "onCreateView(Ljava/lang/String;Landroid/util/AttributeSet;)Landroid/view/View;":
      async function (this: JLayoutInflater, name: string, set: JAttrSet) {
        return createViewByName(name, this.jctx, set);
      },
  },
});
rt.register({ name: "android/view/LayoutInflater$Factory", ctor: class extends JObj {} });
rt.register({ name: "android/view/LayoutInflater$Factory2", ctor: class extends JObj {} });

