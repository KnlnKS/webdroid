// android.widget.TabHost / TabWidget / TabHost.TabSpec, as AOSP defines them: a FrameLayout whose
// setup() finds the TabWidget (android.R.id.tabs) and the content FrameLayout
// (android.R.id.tabcontent) among its descendants, tabs that pair an indicator view with a content
// strategy, and setCurrentTab hiding the previous content view, showing the next and telling the
// OnTabChangeListener. Fragment-backed hosts (androidx / an app's FragmentTabHost) subclass this
// and drive fragments from that listener.
import { rt, JObj, noops } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { type JView, type JViewGroup, initViewFromCtx, findById, invalidate } from "./view";
import { JFrameLayout, JLinearLayout, linearMethods } from "./layouts";
import type { JAttrSet } from "./res";
import { callSelf } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";

const ID_TABS = 0x01020013, ID_TABCONTENT = 0x01020011, GONE = 8, VISIBLE = 0, MATCH_PARENT = -1;
const M_ADD_VIEW = mangleMethod("addView", "(Landroid/view/View;)V");

class JTabSpec extends JObj {
  tag = "";
  host: JTabHost | null = null;
  indicator: (() => Promise<JView>) | null = null;
  content: { get: () => Promise<JView>; closed: () => Promise<void> } | null = null;
}
export class JTabHost extends JFrameLayout {
  specs: JTabSpec[] = [];
  tabWidget: JTabWidget | null = null;
  tabContent: JViewGroup | null = null;
  current = -1;
  currentView: JView | null = null;
  listener: unknown = null;
}
export class JTabWidget extends JLinearLayout {
  host: JTabHost | null = null;
  selectedTab = -1;
  stripEnabled = true;
  async setCurrent(i: number): Promise<void> {
    if (i < 0 || i >= this.children.length || i === this.selectedTab) return;
    if (this.selectedTab !== -1 && this.children[this.selectedTab]) await vcall(this.children[this.selectedTab], "setSelected", "(Z)V", 0);
    this.selectedTab = i;
    await vcall(this.children[i], "setSelected", "(Z)V", 1);
  }
}
const setVisibility = (v: JView, vis: number) => vcall(v, "setVisibility", "(I)V", vis);

async function setCurrentTab(host: JTabHost, index: number): Promise<void> {
  if (index < 0 || index >= host.specs.length || index === host.current) return;
  if (host.current !== -1) await host.specs[host.current].content!.closed();
  host.current = index;
  const spec = host.specs[index];
  host.tabWidget!.setCurrent(index);
  host.currentView = await spec.content!.get();
  if (!host.currentView.parent) {
    const lp = await newObj("android/widget/FrameLayout$LayoutParams", "(II)V", MATCH_PARENT, MATCH_PARENT);
    await vcall(host.tabContent, "addView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V", host.currentView, lp);
  }
  if (host.listener) await vcall(host.listener, "onTabChanged", "(Ljava/lang/String;)V", spec.tag);
}

/** a label indicator: what the framework's tab_indicator layout shows, built directly */
async function labelIndicator(host: JTabHost, label: unknown, icon: unknown): Promise<JView> {
  const view = await newObj("android/widget/TextView", "(Landroid/content/Context;)V", host.ctx);
  await vcall(view, "setText", "(Ljava/lang/CharSequence;)V", label);
  await vcall(view, "setGravity", "(I)V", 17);
  if (icon) await vcall(view, "setCompoundDrawablesWithIntrinsicBounds", "(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V", null, icon, null, null);
  return view;
}

rt.markers("android/widget/TabHost$OnTabChangeListener", "android/widget/TabHost$TabContentFactory");
rt.register({
  name: "android/widget/TabHost$TabSpec", ctor: JTabSpec,
  methods: {
    "getTag()Ljava/lang/String;": function (this: JTabSpec) { return this.tag; },
    "setIndicator(Ljava/lang/CharSequence;)Landroid/widget/TabHost$TabSpec;": function (this: JTabSpec, label: unknown) {
      this.indicator = () => labelIndicator(this.host!, label, null); return this;
    },
    "setIndicator(Ljava/lang/CharSequence;Landroid/graphics/drawable/Drawable;)Landroid/widget/TabHost$TabSpec;": function (this: JTabSpec, label: unknown, icon: unknown) {
      this.indicator = () => labelIndicator(this.host!, label, icon); return this;
    },
    "setIndicator(Landroid/view/View;)Landroid/widget/TabHost$TabSpec;": function (this: JTabSpec, view: JView) {
      this.indicator = async () => view; return this;
    },
    "setContent(I)Landroid/widget/TabHost$TabSpec;": function (this: JTabSpec, viewId: number) {
      let view: JView | null = null;
      const find = () => {
        if (view) return view;
        view = findById(this.host!.tabContent!, viewId);
        if (!view) throw rt.mkThrowable("java/lang/RuntimeException", "Could not create tab content because could not find view with id " + viewId);
        return view;
      };
      this.content = { get: async () => { const v = find(); await setVisibility(v, VISIBLE); return v; }, closed: async () => { await setVisibility(find(), GONE); } };
      return this;
    },
    "setContent(Landroid/widget/TabHost$TabContentFactory;)Landroid/widget/TabHost$TabSpec;": function (this: JTabSpec, factory: unknown) {
      let view: JView | null = null;
      this.content = {
        get: async () => {
          view ??= await vcall(factory, "createTabContent", "(Ljava/lang/String;)Landroid/view/View;", this.tag);
          await setVisibility(view!, VISIBLE);
          return view!;
        },
        closed: async () => { if (view) await setVisibility(view, GONE); },
      };
      return this;
    },
    // activity-backed tabs need the LocalActivityManager handed to setup(LocalActivityManager), which AOSP retired
    "setContent(Landroid/content/Intent;)Landroid/widget/TabHost$TabSpec;": function () {
      throw rt.mkThrowable("java/lang/IllegalStateException", "Did you forget to call 'public void setup(LocalActivityManager activityGroup)'?");
    },
  },
});

rt.register({
  name: "android/widget/TabHost", ctor: JTabHost, sup: "android/widget/FrameLayout",
  methods: {
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: JTabHost, c: unknown, set: JAttrSet | null) {
      await initViewFromCtx(this, c, set);
    },
    "newTabSpec(Ljava/lang/String;)Landroid/widget/TabHost$TabSpec;": function (this: JTabHost, tag: string | null) {
      if (tag === null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "tag must be non-null");
      const spec = new JTabSpec(); spec.tag = tag; spec.host = this;
      return spec;
    },
    "setup()V": function (this: JTabHost) {
      const tabs = findById(this, ID_TABS);
      if (!(tabs instanceof JTabWidget)) throw rt.mkThrowable("java/lang/RuntimeException", "Your TabHost must have a TabWidget whose id attribute is 'android.R.id.tabs'");
      const content = findById(this, ID_TABCONTENT);
      if (!content) throw rt.mkThrowable("java/lang/RuntimeException", "Your TabHost must have a FrameLayout whose id attribute is 'android.R.id.tabcontent'");
      this.tabWidget = tabs; this.tabWidget.host = this;
      this.tabContent = content as JViewGroup;
    },
    "setup(Landroid/app/LocalActivityManager;)V": function (this: JTabHost) { return vcall(this, "setup", "()V"); },
    "addTab(Landroid/widget/TabHost$TabSpec;)V": async function (this: JTabHost, spec: JTabSpec) {
      if (!spec.indicator) throw rt.mkThrowable("java/lang/IllegalArgumentException", "you must specify a way to create the tab indicator.");
      if (!spec.content) throw rt.mkThrowable("java/lang/IllegalArgumentException", "you must specify a way to create the tab content");
      if (!this.tabWidget) throw rt.mkThrowable("java/lang/NullPointerException", "TabHost.setup() was not called");
      const indicator = await spec.indicator();
      await vcall(this.tabWidget, "addView", "(Landroid/view/View;)V", indicator);
      this.specs.push(spec);
      if (this.current === -1) await vcall(this, "setCurrentTab", "(I)V", 0);
    },
    "clearAllTabs()V": async function (this: JTabHost) {
      if (this.tabWidget) await vcall(this.tabWidget, "removeAllViews", "()V");
      if (this.tabContent) await vcall(this.tabContent, "removeAllViews", "()V");
      this.specs.length = 0; this.current = -1; this.currentView = null;
      if (this.tabWidget) this.tabWidget.selectedTab = -1;
      invalidate(this);
    },
    "getTabWidget()Landroid/widget/TabWidget;": function (this: JTabHost) { return this.tabWidget; },
    "getTabContentView()Landroid/widget/FrameLayout;": function (this: JTabHost) { return this.tabContent; },
    "getCurrentTab()I": function (this: JTabHost) { return this.current; },
    "getCurrentTabTag()Ljava/lang/String;": function (this: JTabHost) { return this.specs[this.current]?.tag ?? null; },
    "getCurrentTabView()Landroid/view/View;": function (this: JTabHost) { return this.tabWidget?.children[this.current] ?? null; },
    "getCurrentView()Landroid/view/View;": function (this: JTabHost) { return this.currentView; },
    "setCurrentTab(I)V": function (this: JTabHost, index: number) { return setCurrentTab(this, index); },
    "setCurrentTabByTag(Ljava/lang/String;)V": function (this: JTabHost, tag: string) {
      const i = this.specs.findIndex((s) => s.tag === tag);
      if (i >= 0) return vcall(this, "setCurrentTab", "(I)V", i);
    },
    "setOnTabChangedListener(Landroid/widget/TabHost$OnTabChangeListener;)V": function (this: JTabHost, l: unknown) { this.listener = l; },
    ...noops("onTouchModeChanged(Z)V"),
  },
});

/** the indicator tap: TabHost.setCurrentTab through the overridable Java entry */
class JTabClick extends JObj { host: JTabHost | null = null; index = 0; }
rt.register({
  name: "webdroid/TabClick", ctor: JTabClick, ifaces: ["android/view/View$OnClickListener"],
  methods: {
    "onClick(Landroid/view/View;)V": async function (this: JTabClick) {
      if (!this.host) return;
      await vcall(this.host, "setCurrentTab", "(I)V", this.index);
      if (this.host.tabContent) await vcall(this.host.tabContent, "requestFocus", "()Z");
    },
  },
});

rt.register({
  name: "android/widget/TabWidget", ctor: JTabWidget, sup: "android/widget/LinearLayout",
  methods: {
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: JTabWidget, c: unknown, set: JAttrSet | null) {
      await callSelf(linearMethods, "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V", this, c, set);
      this.orientation = 0;
    },
    // every tab indicator shares the row equally, and taps select its tab
    "addView(Landroid/view/View;)V": async function (this: JTabWidget, child: JView) {
      if (!child.lp) {
        const lp = await newObj("android/widget/LinearLayout$LayoutParams", "(IIF)V", 0, MATCH_PARENT, 1);
        await vcall(child, "setLayoutParams", "(Landroid/view/ViewGroup$LayoutParams;)V", lp);
      }
      await vcall(child, "setFocusable", "(Z)V", 1);
      await vcall(child, "setClickable", "(Z)V", 1);
      await (JLinearLayout.prototype as unknown as Record<string, (c: JView) => Promise<void>>)[M_ADD_VIEW].call(this, child);
      const click = new JTabClick(); click.host = this.host; click.index = this.children.length - 1;
      await vcall(child, "setOnClickListener", "(Landroid/view/View$OnClickListener;)V", click);
    },
    "getTabCount()I": function (this: JTabWidget) { return this.children.length; },
    "getChildTabViewAt(I)Landroid/view/View;": function (this: JTabWidget, i: number) { return this.children[i] ?? null; },
    "setCurrentTab(I)V": function (this: JTabWidget, i: number) { return this.setCurrent(i); },
    "focusCurrentTab(I)V": async function (this: JTabWidget, i: number) {
      await this.setCurrent(i);
      const v = this.children[i];
      if (v) await vcall(v, "requestFocus", "()Z");
    },
    "setStripEnabled(Z)V": function (this: JTabWidget, on: number) { this.stripEnabled = !!on; },
    "isStripEnabled()Z": function (this: JTabWidget) { return this.stripEnabled ? 1 : 0; },
    ...noops("setLeftStripDrawable(Landroid/graphics/drawable/Drawable;)V", "setLeftStripDrawable(I)V",
      "setRightStripDrawable(Landroid/graphics/drawable/Drawable;)V", "setRightStripDrawable(I)V", "setDividerDrawable(I)V"),
    "setEnabled(Z)V": async function (this: JTabWidget, on: number) {
      this.enabled = !!on;
      for (const c of this.children) await vcall(c, "setEnabled", "(Z)V", on);
    },
  },
});
