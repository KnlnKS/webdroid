import { JViewGroup, specSize, JView, invalidate, requestLayout } from "./view";
import { type JDrawable, loadDrawable, loadDrawableRV, drawChild } from "./drawable";
import { type JCanvas, tfMedium } from "./graphics";
import { rt, JObj, type NativeSpec, stubs, noops, fieldGetters, flagGetters, driven, type Gen } from "../jvm/runtime";
import { vcall, curThread, after } from "../jvm/natives/jlang";
import { showPopupMenu } from "./popup";
import { appHost, type AppHost } from "./apphost";
import { reportUncaught } from "./os";
import { appString } from "./context";
import { parseAXML, TV } from "./axml";
import { AID, rvString } from "./res";
import type { JActivity } from "./app";
import type { JActionMode } from "./actionmode";
import { csText, spannedString } from "./text";

function firstText(v: JView | null): string | null {
  if (!v) return null;
  if ("text" in v && v.text) return String(v.text);
  for (const c of v instanceof JViewGroup ? v.children : []) { const t = firstText(c); if (t) return t; }
  return null;
}
export class JActionBarView extends JViewGroup {
  mode: JActionMode | null = null;
  titleStr = "";
  subtitleStr: string | null = null;
  barH = 112;
  icon: JDrawable | null = null;
  /** The options menu, in menu order. The bar/overflow split is derived, never stored. */
  menuItems: JMenuItem[] = [];
  upDrawable: JDrawable | null = null;
  showUp = false;
  navMode = 0;
  navAdapter: unknown = null;
  navLabel = "";
  /** Holo action bar: 24dp icon at 13.5dp, title at 49.5dp, action slots 56dp apart. */
  slotX(i: number, n: number): number { return this.width() - 56 - (n - 1 - i) * 112; }
  /**
   * Which items get a bar slot and which fall to the overflow. SHOW_AS_ACTION_ALWAYS(2) always
   * gets one; IF_ROOM(1) gets whatever slots are left; NEVER(0) and the leftovers overflow.
   * Draw and hit-test both read this, so the affordance you see is the one you can tap.
   */
  layoutMenu(): { action: JMenuItem[]; overflow: JMenuItem[]; slots: number } {
    const vis = this.menuItems.filter((m) => m.visible);
    const max = Math.max(1, Math.floor(this.width() / 2 / 112));
    const chosen = new Set(vis.filter((m) => m.showAsAction & 2));
    for (const m of vis) if ((m.showAsAction & 3) === 1 && chosen.size < max) chosen.add(m);
    const action = vis.filter((m) => chosen.has(m));
    const overflow = vis.filter((m) => !chosen.has(m));
    return { action, overflow, slots: action.length + (overflow.length ? 1 : 0) };
  }
  *onDrawSelf$(cv: JCanvas): Gen {
    const thread = curThread;
    const ctx = cv.ctx;
    const h = this.height();
    if (this.mode) { ctx.fillStyle = "#303030"; ctx.fillRect(0, 0, this.width(), h); }
    let x = 27;
    if (this.mode) {
      ctx.fillStyle = "#fff";
      ctx.font = "40px Roboto";
      ctx.textBaseline = "middle";
      ctx.fillText("×", x, h / 2);
      x += 72;
    } else if (this.showUp && this.upDrawable) {
      const d = this.upDrawable;
      d.bounds.left = 2; d.bounds.top = h / 2 - 24;
      d.bounds.right = 50; d.bounds.bottom = h / 2 + 24;
      const pending = drawChild(d, cv, thread); if (pending instanceof Promise) yield pending;
    }
    if (this.icon) {
      this.icon.bounds.left = x; this.icon.bounds.top = h / 2 - 30;
      this.icon.bounds.right = x + 60; this.icon.bounds.bottom = h / 2 + 30;
      const pending = drawChild(this.icon, cv, thread); if (pending instanceof Promise) yield pending;
      x += 72;
    }
    const { action: shown, overflow, slots } = this.layoutMenu();
    // The title must stop before the first action slot; Android ellipsizes, it does not overlap.
    const titleMax = (slots ? this.slotX(0, slots) - 56 : this.width() - 24) - x - 16;
    ctx.fillStyle = "#ffffff";
    ctx.font = `500 36px ${tfMedium.family}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const ell = (s: string, max: number) => {
      if (max <= 0 || ctx.measureText(s).width <= max) return s;
      let lo = 0, hi = s.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ctx.measureText(s.slice(0, mid) + "\u2026").width <= max) lo = mid; else hi = mid - 1;
      }
      return s.slice(0, lo) + "\u2026";
    };
    const mainLabel = this.mode ? firstText(this.mode.customView) ?? this.mode.title : this.navMode === 1 && this.navLabel ? this.navLabel : this.titleStr;
    const subtitle = this.mode?.subtitle || this.subtitleStr;
    const two = !!subtitle;
    ctx.fillText(ell(mainLabel, this.navMode === 1 ? titleMax - 72 : titleMax), x, h / 2 + (two ? -14 : 1));
    if (this.navMode === 1) {
      // list-navigation spinner caret, right of the label
      const lw = ctx.measureText(mainLabel).width;
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.beginPath();
      ctx.moveTo(x + lw + 40, h / 2 + 24);
      ctx.lineTo(x + lw + 64, h / 2 + 24);
      ctx.lineTo(x + lw + 64, h / 2);
      ctx.closePath();
      ctx.fill();
    } else if (two) {
      ctx.font = "26px Roboto, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.fillText(subtitle!, x, h / 2 + 20);
    }
    for (let i = 0; i < shown.length; i++) {
      const item = shown[i];
      const cx = this.slotX(i, slots);
      if (item.icon) {
        item.icon.tint = -1;
        item.icon.bounds.left = cx - 24; item.icon.bounds.top = h / 2 - 24;
        item.icon.bounds.right = cx + 24; item.icon.bounds.bottom = h / 2 + 24;
        const pending = drawChild(item.icon, cv, thread); if (pending instanceof Promise) yield pending;
      } else {
        ctx.font = "26px Roboto";
        ctx.textAlign = "center";
        ctx.fillStyle = "#fff";
        ctx.fillText(item.title.slice(0, 6), cx, h / 2 + 2);
        ctx.textAlign = "left";
      }
    }
    if (overflow.length) {
      const cx = this.slotX(shown.length, slots);
      ctx.fillStyle = "#fff";
      for (const dy of [-14, 0, 14]) {
        ctx.beginPath();
        ctx.arc(cx, h / 2 + dy, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
rt.register({
  name: "webdroid/ActionBarView", ctor: JActionBarView, sup: "android/view/ViewGroup",
  methods: {
    "onMeasure(II)V": function (this: JActionBarView, wSpec: number, hSpec: number) {
      this.measuredW = specSize(wSpec);
      this.measuredH = this.barH;
    },
    "onDraw(Landroid/graphics/Canvas;)V": function (this: JActionBarView, cv: JCanvas) { return rt.drive(this.onDrawSelf$(cv)); },
    "onTouchEvent(Landroid/view/MotionEvent;)Z": driven(function* (this: JActionBarView, ev: any): Gen {
      if ((ev.action & 0xff) === 1) {
        if (this.showUp && ev.x < 80) {
          if (this.mode) { yield vcall(this.mode, "finish", "()V"); return 1; }
          // AOSP's ActionBarView reports the Up affordance as the options item
          // android.R.id.home, so it reaches the activity's onOptionsItemSelected like any
          // other item. Finishing here directly would rob every app of that override.
          yield performMenuItem(barAnchor(this), mkMenuItem(ID_HOME, ""));
          return 1;
        }
        // Action slots and the overflow affordance own the right end of the bar; they are
        // tested before the list-nav title area, whose hit box otherwise reaches under them.
        const { action, overflow, slots } = this.layoutMenu();
        for (let i = 0; i < action.length; i++) {
          const cx = this.slotX(i, slots);
          if (ev.x >= cx - 56 && ev.x <= cx + 56) { yield performMenuItem(barAnchor(this), action[i]); return 1; }
        }
        if (overflow.length) {
          const cx = this.slotX(action.length, slots);
          if (ev.x >= cx - 56 && ev.x <= cx + 56) { yield showMenuPopup(barAnchor(this), overflow); return 1; }
        }
        // list-nav spinner tap (title area)
        if (this.navMode === 1 && this.navAdapter && ev.x < this.width() - 200 && ev.x > (this.showUp ? 76 : 24)) {
          const n: number = yield vcall(this.navAdapter, "getCount", "()I");
          const items: { id: number; title: string }[] = [];
          for (let i = 0; i < n; i++) {
            const view = yield vcall(this.navAdapter, "getView", "(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;", i, null, this);
            items.push({ id: i, title: firstText(view) ?? "" });
          }
          showPopupMenu(this, items, (idx) => {
            const ab = appHost?.currentActivity()?.actionBarObj;
            if (ab) void ab.fireNav(idx);
          });
          return 1;
        }
      }
      return 1;
    }),
  },
});
/**
 * AOSP MenuBuilder.performItemAction: the item's own click listener first, then the Activity
 * callback (onMenuItemSelected → onOptionsItemSelected), honouring the boolean; an item that
 * carries a sub-menu then opens it. Every menu affordance — action slot, overflow, sub-menu
 * pick, openOptionsMenu — funnels through here, so there is one dispatch path, not four.
 */
async function performMenuItem(anchor: JView, item: JMenuItem): Promise<boolean> {
  if (!item.enabled) return false;
  let invoked = false;
  try {
    if (item.clickL) {
      invoked = !!(await vcall(item.clickL, "onMenuItemClick", "(Landroid/view/MenuItem;)Z", item));
    }
    const mode = anchor.parent instanceof JActionBarView ? anchor.parent.mode : null;
    if (!invoked && mode?.cb) {
      invoked = !!(await vcall(mode.cb, "onActionItemClicked", "(Landroid/view/ActionMode;Landroid/view/MenuItem;)Z", mode, item));
    }
    const act = appHost?.currentActivity();
    if (!invoked && !mode && act) {
      invoked = !!(await vcall(act, "onMenuItemSelected", "(ILandroid/view/MenuItem;)Z", 0, item));
    }
    if (item.sub) await showMenuPopup(anchor, item.sub.items);
  } catch (e) { reportUncaught(e); }
  invalidate();
  return invoked;
}
/**
 * showPopupMenu drops its list 20px below the anchor's TOP edge; an action-bar menu drops from
 * the bar's BOTTOM edge, so anchor it to a zero-size point at the bar's bottom-right corner.
 */
export function barAnchor(bar: JActionBarView): JView {
  const a = new JView();
  a.parent = bar;
  a.left = a.right = bar.width() - 8;
  a.top = a.bottom = bar.height() - 20;
  a.jres = bar.jres;
  a.theme = bar.theme;
  return a;
}
/**
 * Menu item ids are not unique (a sub-menu anchor usually carries none), so the popup is keyed
 * by position and the pick is mapped back to the item here.
 */
export async function showMenuPopup(anchor: JView, items: JMenuItem[]) {
  const vis = items.filter((i) => i.visible);
  if (!vis.length) return;
  showPopupMenu(anchor, vis.map((it, i) => ({ id: i, title: it.title })),
    (i) => { void performMenuItem(anchor, vis[i]); });
}

export class JMenu extends JObj {
  bar: JActionBarView | null = null;
  items: JMenuItem[] = [];
}
export class JMenuItem extends JObj {
  id = 0;
  title = "";
  icon: JDrawable | null = null;
  showAsAction = 0;
  visible = true;
  enabled = true;
  checked = false;
  checkable = false;
  clickL: unknown = null;
  sub: JMenu | null = null;
}
/** android.R.id.home — the id AOSP gives the action bar's Up/home affordance. */
export const ID_HOME = 0x0102002c;
function mkMenuItem(id: number, title: string): JMenuItem {
  const m = new JMenuItem();
  m.id = id; m.title = title;
  return m;
}
const menuItemMethods: NativeSpec["methods"] = {
  "setTitle(Ljava/lang/CharSequence;)Landroid/view/MenuItem;": function (this: JMenuItem, t: unknown) {
    this.title = spannedString(t);
    return this;
  },
  "setTitle(I)Landroid/view/MenuItem;": function (this: JMenuItem, id: number) {
    this.title = appString(id);
    return this;
  },
  "setIcon(I)Landroid/view/MenuItem;": driven(function* (this: JMenuItem, id: number): Gen {
    if (appHost && id) this.icon = yield loadDrawable(appHost.res, id, appHost.theme);
    return this;
  }),
  "setIcon(Landroid/graphics/drawable/Drawable;)Landroid/view/MenuItem;": function (this: JMenuItem, d: JDrawable | null) {
    this.icon = d;
    return this;
  },
  "setVisible(Z)Landroid/view/MenuItem;": function (this: JMenuItem, v: number) { this.visible = !!v; invalidate(); return this; },
  "setEnabled(Z)Landroid/view/MenuItem;": function (this: JMenuItem, v: number) { this.enabled = !!v; return this; },
  "setChecked(Z)Landroid/view/MenuItem;": function (this: JMenuItem, v: number) { this.checked = !!v; return this; },
  "setCheckable(Z)Landroid/view/MenuItem;": function (this: JMenuItem, v: number) { this.checkable = !!v; return this; },
  "setShowAsAction(I)V": function (this: JMenuItem, v: number) { this.showAsAction = v; invalidate(); },
  "setOnActionExpandListener(Landroid/view/MenuItem$OnActionExpandListener;)Landroid/view/MenuItem;":
    function (this: JMenuItem) { return this; },
  "setOnMenuItemClickListener(Landroid/view/MenuItem$OnMenuItemClickListener;)Landroid/view/MenuItem;":
    function (this: JMenuItem, l: unknown) { this.clickL = l; return this; },
  ...fieldGetters({ "getItemId()I": "id", "getTitle()Ljava/lang/CharSequence;": "title",
    "getIcon()Landroid/graphics/drawable/Drawable;": "icon", "getSubMenu()Landroid/view/SubMenu;": "sub" }),
  ...flagGetters({ "isVisible()Z": "visible", "isEnabled()Z": "enabled", "isChecked()Z": "checked",
    "hasSubMenu()Z": "sub" }),
  "setTitleCondensed(Ljava/lang/CharSequence;)Landroid/view/MenuItem;": function (this: JMenuItem) { return this; },
  "setAlphabeticShortcut(C)Landroid/view/MenuItem;": function (this: JMenuItem) { return this; },
  "setActionView(Landroid/view/View;)Landroid/view/MenuItem;": function (this: JMenuItem) { return this; },
  ...stubs(0, "getOrder()I", "getGroupId()I", "expandActionView()Z", "collapseActionView()Z"),
  ...stubs(null, "getActionView()Landroid/view/View;"),
};
rt.register({ name: "webdroid/MenuItem", ctor: JMenuItem, ifaces: ["android/view/MenuItem"], methods: menuItemMethods });
rt.markers("android/view/MenuItem", "android/view/SubMenu");
// Callback interfaces a menu's owner implements. An unregistered one auto-stubs and poisons
// the app class declaring it, which takes the whole menu down with it.
rt.markers("android/view/MenuItem$OnMenuItemClickListener", "android/view/MenuItem$OnActionExpandListener",
  "android/view/CollapsibleActionView", "android/view/ActionProvider$VisibilityListener");
// ActionProvider is an abstract class an app subclasses; the base keeps the visibility
// listener and answers the queries AOSP's default implementation does.
class JActionProvider extends JObj { visL: unknown = null; }
rt.register({
  name: "android/view/ActionProvider", ctor: JActionProvider,
  methods: {
    "onCreateActionView(Landroid/view/MenuItem;)Landroid/view/View;": function (this: JActionProvider) {
      return vcall(this, "onCreateActionView", "()Landroid/view/View;");
    },
    ...noops("<init>(Landroid/content/Context;)V", "onPrepareSubMenu(Landroid/view/SubMenu;)V"),
    ...stubs(null, "onCreateActionView()Landroid/view/View;"),
    ...stubs(0, "onPerformDefaultAction()Z", "hasSubMenu()Z", "overridesItemVisibility()Z"),
    ...stubs(1, "isVisible()Z"),
    "refreshVisibility()V": async function (this: JActionProvider) {
      if (this.visL && await vcall(this, "overridesItemVisibility", "()Z")) {
        await vcall(this.visL, "onActionProviderVisibilityChanged", "(Z)V", await vcall(this, "isVisible", "()Z"));
      }
    },
    "setVisibilityListener(Landroid/view/ActionProvider$VisibilityListener;)V": function (this: JActionProvider, l: unknown) { this.visL = l; },
  },
});
const menuMethods: NativeSpec["methods"] = {
  "add(Ljava/lang/CharSequence;)Landroid/view/MenuItem;": function (this: JMenu, t: unknown) {
    return after(csText(t), (title) => {
      const m = mkMenuItem(0, title);
      this.items.push(m);
      pushMenuToBar(this);
      return m;
    });
  },
  "add(IIILjava/lang/CharSequence;)Landroid/view/MenuItem;": function (this: JMenu, g: number, id: number, o: number, t: unknown) {
    return after(csText(t), (title) => {
      const m = mkMenuItem(id, title);
      this.items.push(m);
      pushMenuToBar(this);
      return m;
    });
  },
  "add(IIII)Landroid/view/MenuItem;": function (this: JMenu, g: number, id: number, o: number, tid: number) {
    const m = mkMenuItem(id, appString(tid));
    this.items.push(m);
    pushMenuToBar(this);
    return m;
  },
  "findItem(I)Landroid/view/MenuItem;": function (this: JMenu, id: number) {
    return this.items.find((i) => i.id === id) ?? null;
  },
  "removeItem(I)V": function (this: JMenu, id: number) {
    this.items = this.items.filter((i) => i.id !== id);
    pushMenuToBar(this);
  },
  "clear()V": function (this: JMenu) { this.items = []; pushMenuToBar(this); },
  "size()I": function (this: JMenu) { return this.items.length; },
  "getItem(I)Landroid/view/MenuItem;": function (this: JMenu, i: number) { return this.items[i] ?? null; },
  "addSubMenu(Ljava/lang/CharSequence;)Landroid/view/SubMenu;": function (this: JMenu, t: unknown) {
    return after(csText(t), (title) => {
      const item = mkMenuItem(0, title);
      item.sub = new JMenu();
      this.items.push(item);
      return item.sub;
    });
  },
  "setGroupVisible(IZ)V": () => {},
  "hasVisibleItems()Z": function (this: JMenu) { return this.items.some((i) => i.visible) ? 1 : 0; },
};
export function pushMenuToBar(menu: JMenu) {
  if (!menu.bar) return;
  // The items themselves, not a snapshot: setVisible/setTitle/setShowAsAction after inflation
  // must reach the bar, and a pick has to be able to find the item's sub-menu and listener.
  menu.bar.menuItems = menu.items;
  invalidate();
}
rt.register({ name: "webdroid/Menu", ctor: JMenu, ifaces: ["android/view/Menu"], methods: menuMethods });
rt.register({ name: "android/view/Menu", ctor: class extends JObj {}, statics: { NONE: 0, FIRST: 1 } });

export class JMenuInflater extends JObj { jctx: any = null; }
rt.register({
  name: "android/view/MenuInflater", ctor: JMenuInflater,
  methods: {
    "<init>(Landroid/content/Context;)V": function (this: JMenuInflater, c: unknown) { this.jctx = c; },
    "inflate(ILandroid/view/Menu;)V": driven(function* (this: JMenuInflater, id: number, menu: JMenu): Gen {
      const host: AppHost = this.jctx.$host;
      const f = host.res.fileOf(id);
      if (!f) { rt.noteMissing("menu 0x" + id.toString(16)); return; }
      const root = parseAXML(f.bytes);
      const A_id = 0x010100d0, A_title = AID("title"), A_icon = AID("icon"), A_showAsAction = AID("showAsAction");
      const walk = async (node: typeof root, target: JMenu) => {
        for (const c of node.children) {
          if (c.name !== "item") { if (c.name === "group") await walk(c, target); continue; }
          const item = mkMenuItem(0, "");
          for (const a of c.attrs) {
            if (a.resId === A_id) item.id = a.data;
            else if (a.resId === A_title) {
              item.title = a.type === TV.STRING ? a.str ?? "" : rvString(host.res, host.res.resolveRefs({ t: a.type, d: a.data })) ?? "";
            } else if (a.resId === A_icon && a.data) {
              item.icon = await loadDrawableRV(host.res, { t: a.type, d: a.data }, host.theme);
            } else if (a.resId === A_showAsAction) item.showAsAction = a.data;
          }
          if (c.children.length && c.children[0]?.name === "menu") {
            item.sub = new JMenu();
            await walk(c.children[0], item.sub);
          }
          target.items.push(item);
        }
      };
      yield walk(root, menu);
      pushMenuToBar(menu);
    }),
  },
});

class JActionBar extends JObj {
  act: JActivity | null = null;
  /** apply `f` to the activity's bar view, if it has one, then repaint (or relayout) */
  bar(f: (b: JActionBarView) => void, then: (b: JActionBarView) => void = invalidate) {
    const b = this.act?.window.actionBarView;
    if (b) { f(b); then(b); }
  }
  navMode = 0; // 0 standard, 1 list, 2 tabs
  navAdapter: unknown = null;
  navListener: unknown = null;
  navSelected = 0;
  navFired = false;
  fireNav(i: number): unknown { return rt.drive(this.fireNav$(i)); }
  *fireNav$(i: number): Gen {
    if (!this.navListener) return;
    let id = 0n;
    if (this.navAdapter) {
      try { id = yield vcall(this.navAdapter, "getItemId", "(I)J", i); } catch { /* */ }
      yield this.updateNavLabel(i);
    }
    try {
      yield vcall(this.navListener, "onNavigationItemSelected", "(IJ)Z", i, id);
    } catch (e) { reportUncaught(e); }
    invalidate();
  }
  updateNavLabel(i: number): unknown { return rt.drive(this.updateNavLabel$(i)); }
  *updateNavLabel$(i: number): Gen {
    const bar = this.act?.window.actionBarView;
    if (!bar || !this.navAdapter) return;
    try {
      const view = yield vcall(this.navAdapter, "getView", "(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;", i, null, bar);
      bar.navLabel = firstText(view) ?? "";
    } catch (e) { bar.navLabel = ""; }
  }
}
rt.register({
  name: "webdroid/ActionBar", ctor: JActionBar, sup: "android/app/ActionBar",
  methods: {
    "setTitle(Ljava/lang/CharSequence;)V": function (this: JActionBar, t: unknown) { this.bar((b) => { b.titleStr = spannedString(t); }); },
    "setTitle(I)V": function (this: JActionBar, id: number) { this.bar((b) => { b.titleStr = appString(id); }); },
    "setSubtitle(Ljava/lang/CharSequence;)V": function (this: JActionBar, t: unknown) { this.bar((b) => { b.subtitleStr = t ? spannedString(t) : null; }); },
    "getTitle()Ljava/lang/CharSequence;": function (this: JActionBar) { return this.act?.window.actionBarView?.titleStr ?? ""; },
    "setDisplayHomeAsUpEnabled(Z)V": function (this: JActionBar, v: number) { this.bar((b) => { b.showUp = !!v; }); },
    "setBackgroundDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JActionBar, d: JDrawable | null) {
      this.bar((b) => { b.background = d; });
    },
    "hide()V": function (this: JActionBar) { this.bar((b) => { b.visibility = 8; }, requestLayout); },
    "show()V": function (this: JActionBar) { this.bar((b) => { b.visibility = 0; }, requestLayout); },
    "isShowing()Z": function (this: JActionBar) { return this.act?.window.actionBarView?.visibility === 0 ? 1 : 0; },
    "setNavigationMode(I)V": function (this: JActionBar, m: number) {
      this.navMode = m;
      this.bar((b) => { b.navMode = m; });
    },
    "setListNavigationCallbacks(Landroid/widget/SpinnerAdapter;Landroid/app/ActionBar$OnNavigationListener;)V":
      driven(function* (this: JActionBar, adapter: unknown, listener: unknown): Gen {
        this.navAdapter = adapter;
        this.navListener = listener;
        if (this.act?.window.actionBarView) {
          this.act.window.actionBarView.navAdapter = adapter;
        }
        // fire initial selection (real ActionBar does this once callbacks are set)
        if (listener && !this.navFired) {
          this.navFired = true;
          yield this.fireNav(this.navSelected);
        }
      }),
    "setSelectedNavigationItem(I)V": function (this: JActionBar, i: number) {
      this.navSelected = i;
      return this.fireNav(i);
    },
    "getNavigationItemCount()I": driven(function* (this: JActionBar): Gen {
      return this.navAdapter ? yield vcall(this.navAdapter, "getCount", "()I") : 0;
    }),
    "getHeight()I": () => 112,
    ...fieldGetters({ "getNavigationMode()I": "navMode", "getSelectedNavigationIndex()I": "navSelected",
      "getThemedContext()Landroid/content/Context;": "act" }),
    // No action view expands on our bar yet; onBackPressed asks first, as AOSP does.
    "collapseActionView()Z": () => 0,
    "getDisplayOptions()I": function (this: JActionBar) { return this.act?.window.actionBarView?.showUp ? 4 : 0; },
    ...noops("setHomeAsUpIndicator(Landroid/graphics/drawable/Drawable;)V", "setHomeAsUpIndicator(I)V",
      "setHomeActionContentDescription(I)V", "setHomeActionContentDescription(Ljava/lang/CharSequence;)V",
      "setHomeButtonEnabled(Z)V", "setDisplayShowHomeEnabled(Z)V", "setDisplayShowTitleEnabled(Z)V",
      "setDisplayShowCustomEnabled(Z)V", "setDisplayUseLogoEnabled(Z)V", "setElevation(F)V",
      "setCustomView(Landroid/view/View;)V", "setIcon(I)V", "setLogo(I)V", "addTab(Landroid/app/ActionBar$Tab;)V"),
    ...stubs(null, "getCustomView()Landroid/view/View;", "newTab()Landroid/app/ActionBar$Tab;"),
  },
});
rt.markers("android/app/ActionBar", "android/app/ActionBar$OnNavigationListener");

rt.markers("android/view/ContextMenu", "android/view/ContextMenu$ContextMenuInfo");
