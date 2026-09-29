// LayoutInflater: binary layout XML → View tree, with Factory2 support (fragments/appcompat).

import { rt, JObj, driven, type Gen } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { vcall, newObj } from "../jvm/natives/jlang";
import { parseAXML, TV, type XmlNode } from "./axml";
import { JAttrSet, JXmlParser, askTheme, themeOf, noteAttrsRead, noteUnreadAttrs, obtainStyled, rvInt, attrSet } from "./res";
import { aospResources } from "./resources";
import { parserRoot } from "./assetmanager";
import { JView, JViewGroup, type JLayoutParams, guardCall, guardMaybe, resolveLp } from "./view";
import type { JContext } from "./context";

class JLayoutInflater extends JObj {
  jctx: JContext | null = null;
  /** AOSP's mFactory and mFactory2 as the FactoryMerger chains they are, newest first: a
   *  cloned inflater that a fragment manager adds its factory to still reaches appcompat's,
   *  which is what turns <ImageView> into AppCompatImageView. `factory` is asked as Factory;
   *  `factory2` asks each entry as whichever it was merged as, and a Factory set after a
   *  Factory2 joins only `factory`, which inflation then no longer consults. */
  factory: unknown[] = [];
  factory2: { f: unknown; two: boolean }[] = [];
  privateFactory: unknown = null;
  factorySet = false;
}

// AOSP resolves an undotted tag against these package prefixes, in this order
// (PhoneLayoutInflater's list, then LayoutInflater.onCreateView's "android.view.").
const TAG_PREFIXES = ["android/widget/", "android/webkit/", "android/app/", "android/view/"];

async function createViewByName(name: string, jctx: unknown, set: JAttrSet): Promise<JView> {
  let clsName: string;
  // <view class="a.b.C"/> is how AOSP writes a tag whose class name is not a legal element
  // name -- an inner class, above all. The framework's own layouts use it.
  const asClass = name === "view" ? attrSet(set)?.node?.attrs.find((a) => a.name === "class" && !a.ns)?.str : null;
  if (asClass) clsName = asClass.replaceAll(".", "/");
  else if (name === "view" || name === "View") clsName = "android/view/View";
  else if (name.includes(".")) clsName = name.replaceAll(".", "/");
  else {
    // Probe the registry rather than link()ing each candidate: linking a name we do
    // not implement auto-stubs it and reports a miss that was never real.
    clsName = "android/widget/" + name;
    for (const p of TAG_PREFIXES) if (rt.natives.has(p + name)) { clsName = p + name; break; }
  }
  return newObj(clsName, "(Landroid/content/Context;Landroid/util/AttributeSet;)V", jctx, set);
}

function setFactory(inflater: JLayoutInflater, f: unknown, two: boolean): void {
  if (inflater.factorySet) throw rt.mkThrowable("java/lang/IllegalStateException", "A factory has already been set on this LayoutInflater");
  if (f === null) throw rt.mkThrowable("java/lang/NullPointerException", "Given factory can not be null");
  inflater.factorySet = true;
  if (two) {
    const rest = inflater.factory2.length ? inflater.factory2 : inflater.factory.map((old) => ({ f: old, two: false }));
    inflater.factory2 = [{ f, two }, ...rest];
  }
  inflater.factory = [f, ...inflater.factory];
}

const F2 = "(Landroid/view/View;Ljava/lang/String;Landroid/content/Context;Landroid/util/AttributeSet;)Landroid/view/View;";
const F1 = "(Ljava/lang/String;Landroid/content/Context;Landroid/util/AttributeSet;)Landroid/view/View;";
async function createViewFromTag(
  inflater: JLayoutInflater, parent: JView | null, name: string, jctx: JContext, set: JAttrSet,
): Promise<JView> {
  // AOSP tryCreateView: the app's factories, then the activity's private one. A view they
  // return is used as is; one that already has a parent fails in addView as it does there.
  if (inflater.factory2.length) {
    for (const { f, two } of inflater.factory2) {
      const v = await (two ? vcall(f, "onCreateView", F2, parent ?? null, name, jctx, set) : vcall(f, "onCreateView", F1, name, jctx, set));
      if (v) return v as JView;
    }
  } else for (const f of inflater.factory) {
    const v = await vcall(f, "onCreateView", F1, name, jctx, set);
    if (v) return v as JView;
  }
  if (inflater.privateFactory) {
    const v = await vcall(inflater.privateFactory, "onCreateView", F2, parent ?? null, name, jctx, set);
    if (v) return v as JView;
  }
  return createViewByName(name, jctx, set);
}

const A_theme = 0x01010000, A_id = 0x010100d0, A_layout = 0x010100f2, A_layoutWidth = 0x010100f4, A_visibility = 0x010100dc;
noteAttrsRead(A_theme, A_id, A_layout, A_layoutWidth, A_visibility);
/** AOSP wraps a tag carrying android:theme -- and its whole subtree -- in a ContextThemeWrapper,
 *  which is how a per-widget ThemeOverlay reaches everything the tag contains. */
async function themedCtx(jctx: JContext, node: XmlNode): Promise<JContext> {
  const a = node.attrs.find((x) => x.resId === A_theme);
  if (!a) return jctx;
  const id = a.type === TV.ATTRIBUTE ? (await askTheme(jctx))?.lookup(a.data)?.d ?? 0 : a.data;
  return id ? newObj("android/view/ContextThemeWrapper", "(Landroid/content/Context;I)V", jctx, id) : jctx;
}

const M_generateLP = mangleMethod("generateLayoutParams", "(Landroid/util/AttributeSet;)Landroid/view/ViewGroup$LayoutParams;");
const M_addView = mangleMethod("addView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V");
const M_onFinishInflate = mangleMethod("onFinishInflate", "()V");

/** The AttributeSet of a layout tag, resolving against `ctx`'s theme. With AOSP's resources it
 *  is the layout's parser itself, advanced to the tag as LayoutInflater's rInflate advances it:
 *  their Theme.obtainStyledAttributes takes nothing else. */
async function attrSetFor(node: XmlNode, ctx: JContext, parser: unknown): Promise<JAttrSet> {
  const set = parser ? attrSet(parser)! : new JAttrSet();
  if (parser) while (set.node !== node) if (await vcall(parser, "next", "()I") === 1) throw rt.mkThrowable("android/view/InflateException", "tag " + node.name + " not in its layout");
  set.node = node;
  set.res = ctx.$host.res;
  set.theme = themeOf(ctx) ?? ctx.$host.theme;
  return (parser ?? set) as JAttrSet;
}

const A_value = 0x01010024;
/** AOSP parseViewTag: a <tag> child keys its android:value on the enclosing view under android:id */
async function applyViewTag(view: JView, node: XmlNode, jctx: JContext, parser: unknown) {
  const set = attrSet(await attrSetFor(node, jctx, parser))!;
  const ta = obtainStyled(set.res, set.theme, set, [A_id, A_value], 0, 0);
  const key = await vcall(ta, "getResourceId", "(II)I", 0, 0);
  await vcall(view, "setTag", "(ILjava/lang/Object;)V", key, await vcall(ta, "getText", "(I)Ljava/lang/CharSequence;", 1));
}

async function inflateChildren(inflater: JLayoutInflater, node: XmlNode, parentView: JView, jctx: JContext, parser: unknown) {
  const host = jctx.$host;
  for (const child of node.children) {
    if (child.name === "tag") { await applyViewTag(parentView, child, jctx, parser); continue; }
    if (child.name === "requestFocus") continue;
    if (child.name === "include") {
      if (!(parentView instanceof JViewGroup)) throw rt.mkThrowable("android/view/InflateException", "<include /> can only be used inside of a ViewGroup");
      const layoutAttr = child.attrs.find((a) => a.name === "layout" || a.resId === A_layout);
      const layoutId = layoutAttr?.data ?? 0;
      if (layoutId) {
        const included = await includedLayout(jctx, layoutId);
        let incView: JView | null;
        try { incView = await inflateNode(jctx, included.root, parentView, false, inflater, included.parser); }
        finally { if (included.parser) await vcall(included.parser, "close", "()V"); }
        // a <merge> include inflates straight into parentView and returns it
        if (incView === parentView) continue;
        if (incView) {
          const set = await attrSetFor(child, jctx, parser);
          const idAttr = child.attrs.find((a) => a.resId === A_id);
          if (idAttr) (incView as JView).idNum = idAttr.data;
          const visibility = rvInt(host.res, obtainStyled(host.res, attrSet(set)!.theme, set, [A_visibility], 0, 0).vals[0], -1);
          if (visibility >= 0 && visibility <= 2) await vcall(incView, "setVisibility", "(I)V", visibility * 4);
          // AOSP: the <include> tag's layout params win only when it declares them; otherwise
          // the included root keeps its own (inflateNode already put them on incView.lp).
          const lp = child.attrs.some((a) => a.resId === A_layoutWidth)
            ? await guardCall(parentView, M_generateLP, set)
            : (incView as JView).lp ?? await guardCall(parentView, M_generateLP, set);
          await guardCall(parentView, M_addView, incView, lp);
        }
      }
      continue;
    }
    const cctx = await themedCtx(jctx, child);
    const set = await attrSetFor(child, cctx, parser);
    const v = await createViewFromTag(inflater, parentView, child.name, cctx, set);
    noteUnreadAttrs(child, child.name);
    let lp = v.lp;
    if (!lp) lp = await guardCall(parentView, M_generateLP, set) as JLayoutParams;
    await guardCall(parentView, M_addView, v, lp);
    if (child.children.length) await inflateChildren(inflater, child, v, cctx, parser);
    await guardMaybe(v, M_onFinishInflate);
  }
}

let inflateDepth = 0;
/** an <include>d layout: AOSP's resources open it as a parser of its own */
async function includedLayout(jctx: JContext, id: number): Promise<{ root: XmlNode; parser: unknown }> {
  if (aospResources()) {
    const parser = await vcall(await vcall(jctx, "getResources", "()Landroid/content/res/Resources;"), "getLayout", "(I)Landroid/content/res/XmlResourceParser;", id);
    return { root: parserRoot(parser)!, parser };
  }
  const file = jctx.$host.res.fileOf(id);
  if (!file) throw rt.mkThrowable("android/content/res/Resources$NotFoundException", "layout 0x" + id.toString(16));
  return { root: parseAXML(file.bytes), parser: null };
}
async function inflateNode(jctx: unknown, root: XmlNode, parent: JViewGroup | null, attach: boolean, inflater: JLayoutInflater, parser: unknown): Promise<JView | null> {
  if (++inflateDepth > 60) { inflateDepth--; throw rt.mkThrowable("java/lang/StackOverflowError", "inflate recursion at " + root.name); }
  try { return await inflateNodeInner(jctx, root, parent, attach, inflater, parser); }
  finally { inflateDepth--; }
}
async function inflateNodeInner(jctx: unknown, root: XmlNode, parent: JViewGroup | null, attach: boolean, inf: JLayoutInflater, parser: unknown): Promise<JView | null> {
  const ctx = jctx as JContext;
  if (root.name === "merge") {
    if (!parent) throw rt.mkThrowable("java/lang/IllegalStateException", "<merge> needs a parent");
    await inflateChildren(inf, root, parent, ctx, parser);
    return parent;
  }
  const rctx = await themedCtx(ctx, root);
  const set = await attrSetFor(root, rctx, parser);
  const v = await createViewFromTag(inf, parent, root.name, rctx, set);
  noteUnreadAttrs(root, root.name);
  if (parent) {
    const lp = await guardCall(parent, M_generateLP, set) as JLayoutParams;
    if (attach) await guardCall(parent, M_addView, v, lp);
    else { v.lp = lp; await resolveLp(lp); }
  }
  if (root.children.length) await inflateChildren(inf, root, v, rctx, parser);
  await guardMaybe(v, M_onFinishInflate);
  return attach && parent ? parent : v;
}

export function inflateLayout(jctx: unknown, layoutId: number, parent: unknown, attach: boolean): Promise<JView | null> {
  return vcall(getInflater(jctx), "inflate", "(ILandroid/view/ViewGroup;Z)Landroid/view/View;", layoutId, parent, +attach);
}
async function inflateParser(this: JLayoutInflater, parser: JXmlParser, root: JViewGroup | null, attach: number) {
  if (!(parser instanceof JXmlParser)) {
    const node = parserRoot(parser);
    return node ? inflateNode(this.jctx, node, root, !!attach, this, parser) : null;
  }
  const node = parser.events.find((event) => event.type === 2)?.node;
  return node ? inflateNode(this.jctx, node, root, !!attach, this, null) : null;
}

const inflaterCache = new WeakMap<object, JLayoutInflater>();
/** LayoutInflater(LayoutInflater, Context): a clone carries the factories but not the "already
 *  set" flag, so the next setFactory merges rather than throwing — every fragment's path */
function copyInflater(inf: JLayoutInflater, from: JLayoutInflater | null, jctx: JContext): JLayoutInflater {
  inf.jctx = jctx;
  if (from) { inf.factory2 = [...from.factory2]; inf.factory = [...from.factory]; inf.privateFactory = from.privateFactory; }
  return inf;
}
const newInflater = (from: JLayoutInflater | null, jctx: JContext) => { rt.link("android/view/LayoutInflater"); return copyInflater(new JLayoutInflater(), from, jctx); };
/**
 * Context.getSystemService(LAYOUT_INFLATER_SERVICE): a plain ContextWrapper answers with its
 * base's inflater, a ContextThemeWrapper clones its base's once, so a dialog's themed context
 * keeps the factory appcompat installed on its activity's.
 */
export function getInflater(jctx: unknown): JLayoutInflater {
  const ctx = jctx as JContext;
  let inf = inflaterCache.get(ctx);
  if (inf) return inf;
  const base = (ctx as { base?: JContext | null }).base;
  if (base && !rt.iof(ctx, "android/view/ContextThemeWrapper")) return getInflater(base);
  inf = newInflater(base ? getInflater(base) : null, ctx);
  inflaterCache.set(ctx, inf);
  return inf;
}

rt.register({
  name: "android/view/LayoutInflater", ctor: JLayoutInflater,
  methods: {
    "static from(Landroid/content/Context;)Landroid/view/LayoutInflater;": (jctx: unknown) => getInflater(jctx),
    "<init>(Landroid/content/Context;)V": function (this: JLayoutInflater, jctx: JContext) { this.jctx = jctx; },
    "<init>(Landroid/view/LayoutInflater;Landroid/content/Context;)V": function (this: JLayoutInflater, original: JLayoutInflater, jctx: JContext) {
      copyInflater(this, original, jctx);
    },
    "inflate(ILandroid/view/ViewGroup;)Landroid/view/View;": function (this: JLayoutInflater, id: number, root: unknown) {
      return vcall(this, "inflate", "(ILandroid/view/ViewGroup;Z)Landroid/view/View;", id, root, +!!root);
    },
    "inflate(ILandroid/view/ViewGroup;Z)Landroid/view/View;": driven(function* (this: JLayoutInflater, id: number, root: unknown, attach: number): Gen {
      const context = yield vcall(this, "getContext", "()Landroid/content/Context;");
      const resources = yield vcall(context, "getResources", "()Landroid/content/res/Resources;");
      const parser = yield vcall(resources, "getLayout", "(I)Landroid/content/res/XmlResourceParser;", id);
      try { return yield vcall(this, "inflate", "(Lorg/xmlpull/v1/XmlPullParser;Landroid/view/ViewGroup;Z)Landroid/view/View;", parser, root, attach); }
      finally { yield vcall(parser, "close", "()V"); }
    }),
    "inflate(Lorg/xmlpull/v1/XmlPullParser;Landroid/view/ViewGroup;)Landroid/view/View;": function (this: JLayoutInflater, parser: unknown, root: unknown) {
      return vcall(this, "inflate", "(Lorg/xmlpull/v1/XmlPullParser;Landroid/view/ViewGroup;Z)Landroid/view/View;", parser, root, +!!root);
    },
    "inflate(Lorg/xmlpull/v1/XmlPullParser;Landroid/view/ViewGroup;Z)Landroid/view/View;": inflateParser,
    "setFactory2(Landroid/view/LayoutInflater$Factory2;)V": function (this: JLayoutInflater, f: unknown) { setFactory(this, f, true); },
    "setFactory(Landroid/view/LayoutInflater$Factory;)V": function (this: JLayoutInflater, f: unknown) { setFactory(this, f, false); },
    "getFactory()Landroid/view/LayoutInflater$Factory;": function (this: JLayoutInflater) { return this.factory[0] ?? null; },
    "getFactory2()Landroid/view/LayoutInflater$Factory2;": function (this: JLayoutInflater) { return this.factory2[0]?.f ?? null; },
    "setPrivateFactory(Landroid/view/LayoutInflater$Factory2;)V": function (this: JLayoutInflater, f: unknown) { this.privateFactory = f; },
    "cloneInContext(Landroid/content/Context;)Landroid/view/LayoutInflater;": function (this: JLayoutInflater, jctx: JContext) { return newInflater(this, jctx); },
    "getContext()Landroid/content/Context;": function (this: JLayoutInflater) { return this.jctx; },
    "createView(Ljava/lang/String;Ljava/lang/String;Landroid/util/AttributeSet;)Landroid/view/View;":
      function (this: JLayoutInflater, name: string, prefix: string | null, set: JAttrSet) {
        return createViewByName(prefix ? prefix + name : name, this.jctx, set);
      },
    "createView(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Landroid/util/AttributeSet;)Landroid/view/View;":
      function (this: JLayoutInflater, jctx: unknown, name: string, prefix: string | null, set: JAttrSet) {
        return createViewByName(prefix ? prefix + name : name, jctx ?? this.jctx, set);
      },
    "onCreateView(Ljava/lang/String;Landroid/util/AttributeSet;)Landroid/view/View;":
      function (this: JLayoutInflater, name: string, set: JAttrSet) {
        return createViewByName(name, this.jctx, set);
      },
  },
});
rt.markers("android/view/LayoutInflater$Factory", "android/view/LayoutInflater$Factory2");
