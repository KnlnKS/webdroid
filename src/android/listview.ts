import { AID, bagStrings } from "./res";
// AdapterView/ListView/GridView + framework adapters (BaseAdapter/ArrayAdapter).
// Non-recycling: materializes all item views (fine at app scale), scrolls internally.

import { rt, JObj, type NativeSpec, stubs, noops, fieldGetters, fieldSetters, driven, type Gen } from "../jvm/runtime";
import { mangleMethod, jmethod } from "../jvm/abi";
import { newObj, vcall, curThread, after, vcallUncaught } from "../jvm/natives/jlang";
import { JView, JViewGroup, JLayoutParams, attachView, detachView, measureView, layoutView, makeSpec, MS_EXACTLY, MS_AT_MOST, MS_UNSPEC, specMode, specSize, MATCH_PARENT, WRAP_CONTENT, childMeasureSpec, defaultSize, resolveSize, invalidate, requestLayout, initViewFromCtx, inheritContext, uiState, guardCall, findById, removeFrom } from "./view";
import { JMotionEvent, restVelocity, trackVelocity, SCROLL_WEIGHT, FLING } from "./motionevent";
import { JAttrSet, obtainStyled, rvDimen, rvInt, type Resources } from "./res";
import { attr } from "./axml";
import { JCanvas } from "./graphics";
import { JDrawable, loadDrawableRV, drawableSize, drawChild } from "./drawable";
import { reportUncaught } from "./os";
import { onMain } from "./mainloop";
import { JList, jeq, toJsArray } from "../jvm/natives/jutil";
import { JTextView } from "./textview";
import { inflateLayout } from "./inflate";
import { addOverlay, removeOverlay } from "./popup";
import { device } from "../shell/config";
import { JActionMode } from "./actionmode";

for (const i of ["android/widget/Adapter", "android/widget/ListAdapter", "android/widget/WrapperListAdapter", "android/widget/SpinnerAdapter",
  "android/widget/AdapterView$OnItemClickListener", "android/widget/AdapterView$OnItemLongClickListener",
  "android/widget/AdapterView$OnItemSelectedListener", "android/widget/AbsListView$SelectionBoundsAdjuster",
  "android/widget/AbsListView$RecyclerListener", "android/widget/SectionIndexer"]) {
  rt.register({ name: i, ctor: class extends JObj {} });
}

// ── BaseAdapter (framework): DataSetObservable plumbing
export class JBaseAdapter extends JObj {
  observers: unknown[] = [];
}
export const baseAdapterMethods: NonNullable<NativeSpec["methods"]> = {
  "registerDataSetObserver(Landroid/database/DataSetObserver;)V": function (this: JBaseAdapter, o: unknown) {
    this.observers.push(o);
  },
  "unregisterDataSetObserver(Landroid/database/DataSetObserver;)V": function (this: JBaseAdapter, o: unknown) {
    removeFrom(this.observers, o);
  },
  "notifyDataSetChanged()V": driven(function* (this: JBaseAdapter): Gen {
    for (const o of [...this.observers]) {
      try { yield vcall(o, "onChanged", "()V"); } catch (e) { reportUncaught(e); }
    }
    invalidate();
  }),
  "notifyDataSetInvalidated()V": driven(function* (this: JBaseAdapter): Gen {
    for (const o of [...this.observers]) {
      try { yield vcall(o, "onInvalidated", "()V"); } catch (e) { reportUncaught(e); }
    }
  }),
  ...noops("<init>()V"),
  ...stubs(0, "hasStableIds()Z", "getItemViewType(I)I"),
  ...stubs(1, "areAllItemsEnabled()Z", "isEnabled(I)Z", "getViewTypeCount()I"),
  "isEmpty()Z": driven(function* (this: JBaseAdapter): Gen {
    return (yield vcall(this, "getCount", "()I")) === 0 ? 1 : 0;
  }),
  "getDropDownView(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;":
    function (this: JBaseAdapter, pos: number, cv: unknown, parent: unknown) {
      return vcall(this, "getView", "(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;", pos, cv, parent);
    },
};
rt.register({
  name: "android/widget/BaseAdapter", ctor: JBaseAdapter,
  ifaces: ["android/widget/ListAdapter", "android/widget/SpinnerAdapter", "android/widget/Adapter"],
  methods: baseAdapterMethods,
});

class JArrayAdapter extends JBaseAdapter {
  jctx: any = null;
  layoutRes = 0;
  textViewId = 0;
  items: unknown[] = [];
  source: unknown = null;
}
function adapterList(adapter: JArrayAdapter, list: unknown) {
  adapter.source = list;
  adapter.items = list instanceof JList ? list.a : [];
}
const appendAdapterItems = driven(function* appendAdapterItems(adapter: JArrayAdapter, values: unknown[]): Gen {
  if (adapter.source) {
    for (const value of values) yield vcall(adapter.source, "add", "(Ljava/lang/Object;)Z", value);
  } else adapter.items.push(...values);
  yield vcall(adapter, "notifyDataSetChanged", "()V");
});
rt.register({
  name: "android/widget/ArrayAdapter", ctor: JArrayAdapter, sup: "android/widget/BaseAdapter",
  methods: {
    ...baseAdapterMethods,
    "<init>(Landroid/content/Context;I)V": function (this: JArrayAdapter, c: unknown, res: number) {
      this.jctx = c; this.layoutRes = res;
    },
    "<init>(Landroid/content/Context;II)V": function (this: JArrayAdapter, c: unknown, res: number, tvId: number) {
      this.jctx = c; this.layoutRes = res; this.textViewId = tvId;
    },
    "<init>(Landroid/content/Context;ILjava/util/List;)V": function (this: JArrayAdapter, c: unknown, res: number, list: unknown) {
      this.jctx = c; this.layoutRes = res;
      adapterList(this, list);
    },
    "<init>(Landroid/content/Context;I[Ljava/lang/Object;)V": function (this: JArrayAdapter, c: unknown, res: number, arr: unknown[]) {
      this.jctx = c; this.layoutRes = res; this.items = [...(arr ?? [])];
    },
    "<init>(Landroid/content/Context;II[Ljava/lang/Object;)V": function (this: JArrayAdapter, c: unknown, res: number, tvId: number, arr: unknown[]) {
      this.jctx = c; this.layoutRes = res; this.textViewId = tvId; this.items = [...(arr ?? [])];
    },
    "<init>(Landroid/content/Context;IILjava/util/List;)V": function (this: JArrayAdapter, c: unknown, res: number, tvId: number, list: unknown) {
      this.jctx = c; this.layoutRes = res; this.textViewId = tvId;
      adapterList(this, list);
    },
    "getCount()I": function (this: JArrayAdapter) {
      return this.source && !(this.source instanceof JList) ? vcall(this.source, "size", "()I") : this.items.length;
    },
    "getItem(I)Ljava/lang/Object;": function (this: JArrayAdapter, i: number) {
      return this.source && !(this.source instanceof JList) ? vcall(this.source, "get", "(I)Ljava/lang/Object;", i) : this.items[i] ?? null;
    },
    "getPosition(Ljava/lang/Object;)I": driven(function* (this: JArrayAdapter, item: unknown): Gen {
      if (this.source && !(this.source instanceof JList)) return vcall(this.source, "indexOf", "(Ljava/lang/Object;)I", item);
      for (let i = 0; i < this.items.length; i++) if (yield jeq(item, this.items[i])) return i;
      return -1;
    }),
    "getItemId(I)J": (i: number) => BigInt(i),
    "add(Ljava/lang/Object;)V": function (this: JArrayAdapter, o: unknown) {
      return appendAdapterItems(this, [o]);
    },
    "addAll(Ljava/util/Collection;)V": driven(function* (this: JArrayAdapter, collection: unknown): Gen {
      yield appendAdapterItems(this, yield toJsArray(collection));
    }),
    "addAll([Ljava/lang/Object;)V": function (this: JArrayAdapter, values: unknown[]) {
      return appendAdapterItems(this, values);
    },
    "clear()V": driven(function* (this: JArrayAdapter): Gen {
      if (this.source) yield vcall(this.source, "clear", "()V");
      else this.items.length = 0;
      yield vcall(this, "notifyDataSetChanged", "()V");
    }),
    "getView(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;":
      driven(function* (this: JArrayAdapter, pos: number, convert: unknown, parent: unknown): Gen {
        const item = yield vcall(this, "getItem", "(I)Ljava/lang/Object;", pos);
        const text = item === null || item === undefined ? "" :
          typeof item === "string" ? item : String(yield vcall(item, "toString", "()Ljava/lang/String;"));
        let v: any = null;
        if (this.layoutRes) {
          v = yield inflateLayout(this.jctx, this.layoutRes, parent, false);
        }
        if (!v) {
          v = new JTextView();
          v.ctx = this.jctx;
          v.jres = this.jctx?.$host?.res ?? null;
          v.theme = this.jctx?.$host?.theme ?? null;
          v.paintT.textSize = device.dp(16);
          v.padL = v.padR = device.dp(16); v.padT = v.padB = device.dp(14);
        }
        let target = v;
        if (this.textViewId) {
          target = findById(v, this.textViewId) ?? v;
        }
        if (target instanceof JTextView) {
          target.text = text;
          target.rawText = text;
          target.layoutWidthFor = -1;
        }
        return v;
      }),
    "setDropDownViewResource(I)V": () => {},
    "static createFromResource(Landroid/content/Context;II)Landroid/widget/ArrayAdapter;":
      function (c: any, arrRes: number, layout: number) {
        const a = new JArrayAdapter();
        a.jctx = c;
        a.layoutRes = layout;
        const res: Resources = c.$host.res;
        a.items = bagStrings(res, arrRes);
        return a;
      },
  },
});

// AbsListView.MultiChoiceModeListener extends ActionMode.Callback.
rt.register({
  name: "android/widget/AbsListView$MultiChoiceModeListener", ctor: class extends JObj {},
  ifaces: ["android/view/ActionMode$Callback"],
});
rt.register({
  name: "android/widget/AbsListView$OnScrollListener", ctor: class extends JObj {},
  statics: { SCROLL_STATE_IDLE: 0, SCROLL_STATE_TOUCH_SCROLL: 1, SCROLL_STATE_FLING: 2 },
});
const CHOICE_MODE_MULTIPLE_MODAL = 3;
export class JListView extends JViewGroup {
  adapter: unknown = null;
  observer: unknown = null;
  itemClickL: unknown = null;
  itemLongClickL: unknown = null;
  itemSelectedL: unknown = null;
  divH = 2;
  divDraw: JDrawable | null = null;
  headers: JView[] = [];
  footers: JView[] = [];
  headerAdapter: JHeaderViewListAdapter | null = null;
  itemViews: JView[] = [];
  building = false;
  rebuildPending = false;
  rebuildPromise: Promise<void> | null = null;
  dragging = false;
  downY = 0; lastY = 0; velo = 0; lastMoveT = 0;
  flingAnim: (() => boolean) | null = null;
  pressTarget = -1;
  longFired = false;
  choiceMode = 0;
  checked = new Set<number>();
  multiChoiceL: unknown = null;
  actionMode: JActionMode | null = null;
  scrollL: unknown = null;
  scrollState = 0;
  scrollPosted = false;
  /** AOSP mNextSelectedPosition/mSpecificTop under LAYOUT_SPECIFIC: apps call setSelection
   *  straight after setAdapter/notifyDataSetChanged, before any row has a height */
  pendingSel: { pos: number; off: number } | null = null;
  emptyView: JView | null = null;
  itemIndexAt(y: number): number {
    const vs = this.allViews();
    for (let i = 0; i < vs.length; i++) {
      if (y >= vs[i].top && y < vs[i].bottom + this.divH) return i;
    }
    return -1;
  }
  totalCount(): number { return this.headers.length + this.itemViews.length + this.footers.length; }
  /** headers + items + footers, read several times per frame; rebuilt only when one of them changes */
  viewsCache: JView[] | null = null;
  allViews(): JView[] { return this.viewsCache ??= [...this.headers, ...this.itemViews, ...this.footers]; }
  maxScroll(): number {
    let h = 0;
    for (const v of this.allViews()) h += v.measuredH + this.divH;
    return Math.max(0, h - this.divH + this.padT + this.padB - this.height());
  }
  /** AOSP mFirstPosition .. mFirstPosition+childCount-1: rows meeting the viewport; [0,-1] when empty */
  visibleRange(): [number, number] {
    const vs = this.allViews(), hi = this.scrollY + this.height();
    if (!vs.length) return [0, -1];
    let first = 0, last: number;
    while (first < vs.length - 1 && vs[first].bottom + this.divH <= this.scrollY) first++;
    for (last = first; last + 1 < vs.length && vs[last + 1].top < hi; last++);
    return [first, last];
  }
  /** every scroll delta: clamp, redraw, notify (AOSP trackMotionScroll) */
  scrollRows(dy: number) {
    const y = Math.max(0, Math.min(this.maxScroll(), this.scrollY + dy));
    if (y === this.scrollY) return;
    this.scrollY = y; invalidate(); this.notifyScroll();
  }
  /** invokeOnItemScrollListener, coalesced and posted: the listener's reply for an "infinite"
   *  list is notifyDataSetChanged + setSelectionFromTop, which must not rebuild the rows inside
   *  the layout pass or fling tick that is still walking them */
  notifyScroll() {
    if (!this.scrollL || this.scrollPosted) return;
    this.scrollPosted = true;
    void onMain(async () => {
      this.scrollPosted = false;
      const [first, last] = this.visibleRange();
      if (!this.scrollL) return;
      try { await vcall(this.scrollL, "onScroll", "(Landroid/widget/AbsListView;III)V", this, first, last - first + 1, this.totalCount()); }
      catch (e) { reportUncaught(e); }
    });
  }
  /** reportScrollStateChange: transitions only */
  setScrollState(s: number) {
    if (s === this.scrollState) return;
    this.scrollState = s;
    if (this.scrollL) void onMain(() => vcallUncaught(this.scrollL, "onScrollStateChanged", "(Landroid/widget/AbsListView;I)V", this, s));
  }
  /** AdapterView.updateEmptyStatus: an empty adapter shows the empty view in the list's place */
  updateEmptyStatus() {
    if (!this.emptyView) return;
    const empty = !this.adapter || !this.itemViews.length;
    // AOSP flips both through setVisibility, which asks for layout only on a change
    const ev = empty ? 0 : 8, lv = empty ? 8 : 0;
    if (this.emptyView.visibility !== ev) { this.emptyView.visibility = ev; requestLayout(this.emptyView); }
    if (this.visibility !== lv) { this.visibility = lv; requestLayout(this); }
  }
  /** the tail AOSP layoutChildren shares with GridView: land the deferred selection, clamp, report */
  finishLayout() {
    const sel = this.pendingSel, vs = this.allViews();
    if (sel && !this.building) {
      this.pendingSel = null;
      this.scrollY = (vs[Math.min(sel.pos, vs.length - 1)]?.top ?? this.padT) - this.padT - sel.off;
    }
    this.scrollY = Math.max(0, Math.min(this.maxScroll(), this.scrollY));
    this.notifyScroll();
  }
  /** A rebuild requested while one is suspended reruns it once it finishes. */
  rebuild(): void | Promise<void> {
    if (this.rebuildPromise) {
      this.rebuildPending = true;
      return this.rebuildPromise;
    }
    const pending = this.rebuildRows();
    if (!(pending instanceof Promise)) return;
    this.rebuildPromise = pending.finally(() => { this.rebuildPromise = null; });
    return this.rebuildPromise;
  }
  private rebuildRows(): void | Promise<void> { return rt.drive(this.rebuildRows$()); }
  private *rebuildRows$(): Gen<void> {
    this.building = true;
    try {
      do {
        this.rebuildPending = false;
        for (const v of [...this.children]) yield detachView(this, v);
        this.itemViews = []; this.viewsCache = null;
        if (this.adapter) {
          const n: number = yield vcall(this.adapter, "getCount", "()I");
          for (let i = 0; i < n; i++) {
            const v = (yield vcall(this.adapter, "getView", "(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;", i, null, this)) as JView | null;
            if (!v) continue;
            this.itemViews.push(v); this.viewsCache = null;
          }
        }
        for (const v of this.allViews()) yield attachView(this, v);
        if (this.choiceMode) yield showCheckStates(this);
        this.updateEmptyStatus();
        requestLayout(this);
      } while (this.rebuildPending);
    } catch (e) {
      reportUncaught(e);
    } finally {
      this.building = false;
    }
  }
}
class JHeaderViewListAdapter extends JObj {
  constructor(readonly list: JListView) { super(); }
}
const headerAdapterMethods: NonNullable<NativeSpec["methods"]> = {
  "getWrappedAdapter()Landroid/widget/ListAdapter;": function (this: JHeaderViewListAdapter) { return this.list.adapter; },
  "getCount()I": driven(function* (this: JHeaderViewListAdapter): Gen {
    return this.list.headers.length + (this.list.adapter ? (yield vcall(this.list.adapter, "getCount", "()I")) as number : 0) + this.list.footers.length;
  }),
  "getItem(I)Ljava/lang/Object;": function (this: JHeaderViewListAdapter, pos: number) {
    const row = pos - this.list.headers.length;
    return row >= 0 && row < this.list.itemViews.length && this.list.adapter
      ? vcall(this.list.adapter, "getItem", "(I)Ljava/lang/Object;", row) : null;
  },
  "getItemId(I)J": function (this: JHeaderViewListAdapter, pos: number) {
    const row = pos - this.list.headers.length;
    return row >= 0 && row < this.list.itemViews.length && this.list.adapter
      ? vcall(this.list.adapter, "getItemId", "(I)J", row) : -1n;
  },
  "getView(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;": function (this: JHeaderViewListAdapter, pos: number, convert: unknown, parent: unknown) {
    if (pos < this.list.headers.length) return this.list.headers[pos];
    const row = pos - this.list.headers.length;
    if (row < this.list.itemViews.length && this.list.adapter)
      return vcall(this.list.adapter, "getView", "(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;", row, convert, parent);
    return this.list.footers[row - this.list.itemViews.length] ?? null;
  },
  "isEnabled(I)Z": function (this: JHeaderViewListAdapter, pos: number) {
    const row = pos - this.list.headers.length;
    return row >= 0 && row < this.list.itemViews.length && this.list.adapter
      ? vcall(this.list.adapter, "isEnabled", "(I)Z", row) : 1;
  },
  "areAllItemsEnabled()Z": function (this: JHeaderViewListAdapter) {
    return this.list.adapter ? vcall(this.list.adapter, "areAllItemsEnabled", "()Z") : 1;
  },
  "getItemViewType(I)I": function (this: JHeaderViewListAdapter, pos: number) {
    const row = pos - this.list.headers.length;
    return row >= 0 && row < this.list.itemViews.length && this.list.adapter
      ? vcall(this.list.adapter, "getItemViewType", "(I)I", row) : -2;
  },
  "getViewTypeCount()I": function (this: JHeaderViewListAdapter) {
    return this.list.adapter ? vcall(this.list.adapter, "getViewTypeCount", "()I") : 1;
  },
  "hasStableIds()Z": function (this: JHeaderViewListAdapter) {
    return this.list.adapter ? vcall(this.list.adapter, "hasStableIds", "()Z") : 0;
  },
  "isEmpty()Z": function (this: JHeaderViewListAdapter) { return this.list.totalCount() ? 0 : 1; },
  "registerDataSetObserver(Landroid/database/DataSetObserver;)V": function (this: JHeaderViewListAdapter, observer: unknown) {
    return this.list.adapter ? vcall(this.list.adapter, "registerDataSetObserver", "(Landroid/database/DataSetObserver;)V", observer) : undefined;
  },
  "unregisterDataSetObserver(Landroid/database/DataSetObserver;)V": function (this: JHeaderViewListAdapter, observer: unknown) {
    return this.list.adapter ? vcall(this.list.adapter, "unregisterDataSetObserver", "(Landroid/database/DataSetObserver;)V", observer) : undefined;
  },
};
rt.register({ name: "android/widget/HeaderViewListAdapter", ctor: JHeaderViewListAdapter,
  ifaces: ["android/widget/ListAdapter", "android/widget/WrapperListAdapter"], methods: headerAdapterMethods });
const M_perfItemClick = mangleMethod("performItemClick", "(Landroid/view/View;IJ)Z");
const M_perfLongPress = mangleMethod("performLongPress", "(Landroid/view/View;IJ)Z");
const M_setItemChecked = mangleMethod("setItemChecked", "(IZ)V");
const M_setSelFromTop = mangleMethod("setSelectionFromTop", "(II)V");

const INVALID_POSITION = -1;
const INVALID_ROW_ID = -9223372036854775808n; // AdapterView.INVALID_ROW_ID = Long.MIN_VALUE
/** AdapterView.getItemAtPosition/getItemIdAtPosition: asks the virtual getAdapter(), whose
 *  header wrapper maps positions, whether or not the row has a view */
const adapterAt = (list: JListView, pos: number, name: string, desc: string, none: unknown) =>
  after(vcall(list, "getAdapter", "()Landroid/widget/Adapter;"), (a) => a && pos >= 0 ? vcall(a, name, desc, pos) : none);
const rowId = (list: JListView, pos: number) => adapterAt(list, pos, "getItemId", "(I)J", INVALID_ROW_ID);

/** The only place a modal-choice list talks to its MultiChoiceModeListener. Called from
 *  setItemChecked, so every route that changes checked state (click, long press, app call)
 *  reaches the callback. Starts the ActionMode on the first check, ends it on the last uncheck. */
const notifyChoiceMode = driven(function* notifyChoiceMode(list: JListView, pos: number, checked: boolean): Gen {
  const cb = list.multiChoiceL;
  if (list.choiceMode !== CHOICE_MODE_MULTIPLE_MODAL || !cb) return;
  if (!list.actionMode) {
    if (!checked) return;
    const mode = new JActionMode();
    mode.jctx = list.ctx;
    mode.cb = cb;
    mode.menu = rt.make("webdroid/Menu");
    mode.onFinish = async () => {
      list.actionMode = null;
      for (const p of [...list.checked]) await guardCall(list, M_setItemChecked, p, 0);
    };
    list.actionMode = mode;
    if (!(yield vcall(cb, "onCreateActionMode", "(Landroid/view/ActionMode;Landroid/view/Menu;)Z", mode, mode.menu))) {
      list.actionMode = null;
      return;
    }
    yield vcall(cb, "onPrepareActionMode", "(Landroid/view/ActionMode;Landroid/view/Menu;)Z", mode, mode.menu);
  }
  const mode = list.actionMode;
  if (!mode) return;
  yield vcall(cb, "onItemCheckedStateChanged", "(Landroid/view/ActionMode;IJZ)V",
    mode, pos, yield rowId(list, pos), checked ? 1 : 0);
  if (!list.checked.size) yield vcall(mode, "finish", "()V");
});

/** AbsListView.setupChild: every row shows the list's check state, through Checkable when the
 *  row is one and as the activated state otherwise */
const showCheckStates = driven(function* showCheckStates(list: JListView): Gen {
  const vs = list.allViews();
  for (let i = 0; i < vs.length; i++) {
    const v = vs[i], on = list.checked.has(i);
    if (rt.iof(v, "android/widget/Checkable")) yield vcall(v, "setChecked", "(Z)V", +on);
    else if (v.activated !== on) { v.activated = on; yield v.refreshDrawableState(); }
  }
});

function cancelItemLongPress(list: JListView) {
  if (list.longPressTimer) { clearTimeout(list.longPressTimer); list.longPressTimer = null; }
}

/** long-press dispatch: resolve the row id, then go through performLongPress (the funnel) */
const dispatchLongPress = driven(function* dispatchLongPress(list: JListView, pos: number): Gen {
  const v = list.allViews()[pos];
  if (!v) return;
  const id = yield rowId(list, pos);
  list.longFired = !!(yield guardCall(list, M_perfLongPress, v, pos, id));
});

/** ListView's default divider is the theme's listDivider (ListView style: divider="?attr/listDivider") */
const themeDivider = driven(function* themeDivider(list: JListView): Gen {
  const rv = list.theme?.lookup(AID("listDivider"));
  if (rv && list.jres) list.divDraw = yield loadDrawableRV(list.jres, rv, list.theme);
});
function addHeader(this: JListView, v: JView) { this.headers.push(v); this.viewsCache = null; void this.rebuild(); }
function addFooter(this: JListView, v: JView) { this.footers.push(v); this.viewsCache = null; void this.rebuild(); }
const measureListView = driven(function* measureListView(this: JListView, wSpec: number, hSpec: number): Gen {
    const w = defaultSize(specSize(wSpec), wSpec);
    const availW = Math.max(0, w - this.padL - this.padR);
    let totalH = this.padT + this.padB;
    for (const v of this.allViews()) {
      const lp = v.lp;
      yield measureView(v,
        childMeasureSpec(makeSpec(availW, MS_EXACTLY), 0, lp?.width ?? MATCH_PARENT),
        childMeasureSpec(makeSpec(Math.max(0, specSize(hSpec)), MS_UNSPEC), 0, lp?.height ?? WRAP_CONTENT));
      totalH += v.measuredH + this.divH;
    }
    this.measuredW = w;
    this.measuredH = specMode(hSpec) === MS_EXACTLY ? specSize(hSpec) : resolveSize(totalH, hSpec);
});
const listViewMethods: NonNullable<NativeSpec["methods"]> = {
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": driven(function* (this: JListView, c: unknown, set: JAttrSet | null): Gen {
    yield initViewFromCtx(this, c, set);
    if (set && this.jres) {
      const ta = obtainStyled(this.jres, this.theme, set, [AID("divider"), AID("dividerHeight"), AID("choiceMode")], 0, 0);
      if (ta.vals[0]) this.divDraw = yield loadDrawableRV(this.jres, ta.vals[0], this.theme);
      // an explicit @null reads like an absent attribute; only the latter takes the theme's listDivider
      else if (!(set.node && attr(set.node, "divider"))) yield themeDivider(this);
      if (ta.vals[1]) this.divH = Math.round(rvDimen(this.jres, ta.vals[1], this.divH));
      else if (this.divDraw) { const h = yield drawableSize(this.divDraw, true); if (h > 0) this.divH = h; }
      if (ta.vals[2]) this.choiceMode = rvInt(this.jres, ta.vals[2], 0);
    }
  }),
  "setAdapter(Landroid/widget/ListAdapter;)V": driven(function* (this: JListView, a: unknown): Gen {
    if (this.adapter && this.observer) {
      try { yield vcall(this.adapter, "unregisterDataSetObserver", "(Landroid/database/DataSetObserver;)V", this.observer); } catch { /* */ }
    }
    this.adapter = a;
    if (a) {
      const self = this;
      this.observer = {
        [mangleMethod("onChanged", "()V")]: () => self.rebuild(),
        [mangleMethod("onInvalidated", "()V")]: () => { invalidate(); },
      };
      try { yield vcall(a, "registerDataSetObserver", "(Landroid/database/DataSetObserver;)V", this.observer); } catch { /* */ }
    }
    yield this.rebuild();
  }),
  // appcompat's dropdown list reads both back: without them a Spinner popup dies on open, and
  // picking a row throws instead of selecting it
  "getOnItemClickListener()Landroid/widget/AdapterView$OnItemClickListener;": function (this: JListView) { return this.itemClickL; },
  "getOnItemSelectedListener()Landroid/widget/AdapterView$OnItemSelectedListener;": function (this: JListView) { return this.itemSelectedL; },
  "addHeaderView(Landroid/view/View;)V": addHeader,
  "addHeaderView(Landroid/view/View;Ljava/lang/Object;Z)V": addHeader,
  "addFooterView(Landroid/view/View;)V": addFooter,
  "addFooterView(Landroid/view/View;Ljava/lang/Object;Z)V": addFooter,
  "removeHeaderView(Landroid/view/View;)Z": function (this: JListView, v: JView) {
    const i = this.headers.indexOf(v);
    if (i >= 0) { this.headers.splice(i, 1); this.viewsCache = null; void this.rebuild(); return 1; }
    return 0;
  },
  "removeFooterView(Landroid/view/View;)Z": function (this: JListView, v: JView) {
    const i = this.footers.indexOf(v);
    if (i >= 0) { this.footers.splice(i, 1); this.viewsCache = null; void this.rebuild(); return 1; }
    return 0;
  },
  "getHeaderViewsCount()I": function (this: JListView) { return this.headers.length; },
  "getFooterViewsCount()I": function (this: JListView) { return this.footers.length; },
  "setDivider(Landroid/graphics/drawable/Drawable;)V": function (this: JListView, d: JDrawable | null) {
    this.divDraw = d;
    return after(d ? drawableSize(d, true) : 0, h => { this.divH = Math.max(0, h); requestLayout(this); });
  },
  "setDividerHeight(I)V": function (this: JListView, h: number) { this.divH = h; requestLayout(this); },
  "setChoiceMode(I)V": driven(function* (this: JListView, m: number): Gen {
    this.choiceMode = m;
    if (m !== CHOICE_MODE_MULTIPLE_MODAL && this.actionMode) yield vcall(this.actionMode, "finish", "()V");
  }),
  "setItemChecked(IZ)V": driven(function* (this: JListView, pos: number, val: number): Gen {
    if (!this.choiceMode) return;
    if (val) {
      if (this.choiceMode === 1) this.checked.clear();
      this.checked.add(pos);
    } else this.checked.delete(pos);
    yield showCheckStates(this);
    yield notifyChoiceMode(this, pos, !!val);
  }),
  "isItemChecked(I)Z": function (this: JListView, pos: number) { return this.checked.has(pos) ? 1 : 0; },
  "getCheckedItemPosition()I": function (this: JListView) {
    return this.choiceMode === 1 && this.checked.size ? [...this.checked][0] : -1;
  },
  "getCount()I": function (this: JListView) { return this.totalCount(); },
  "getItemAtPosition(I)Ljava/lang/Object;": function (this: JListView, pos: number) { return adapterAt(this, pos, "getItem", "(I)Ljava/lang/Object;", null); },
  "getItemIdAtPosition(I)J": function (this: JListView, pos: number) { return rowId(this, pos); },
  "getFirstVisiblePosition()I": function (this: JListView) { return this.visibleRange()[0]; },
  "getLastVisiblePosition()I": function (this: JListView) { return this.visibleRange()[1]; },
  "setSelectionFromTop(II)V": function (this: JListView, pos: number, off: number) {
    this.pendingSel = { pos, off };
    requestLayout(this);
  },
  "setSelection(I)V": function (this: JListView, pos: number) { jmethod(this, M_setSelFromTop)!.call(this, pos, 0); },
  "smoothScrollToPosition(I)V": function (this: JListView, pos: number) { jmethod(this, M_setSelFromTop)!.call(this, pos, 0); },
  "getPositionForView(Landroid/view/View;)I": function (this: JListView, v: JView) {
    let cur: JView | null = v;
    while (cur && cur.parent !== this) cur = cur.parent;
    return cur ? this.allViews().indexOf(cur) : -1;
  },
  "performItemClick(Landroid/view/View;IJ)Z": driven(function* (this: JListView, v: JView, pos: number, id: bigint): Gen {
    // modal choice mode only consumes clicks while its ActionMode is up; before that a tap is a plain click
    const modalActive = this.choiceMode === CHOICE_MODE_MULTIPLE_MODAL && this.actionMode !== null;
    if (this.choiceMode && (this.choiceMode !== CHOICE_MODE_MULTIPLE_MODAL || modalActive)) {
      yield guardCall(this, M_setItemChecked, pos, this.checked.has(pos) ? 0 : 1);
      if (modalActive) return 1;
    }
    if (this.itemClickL) {
      yield vcall(this.itemClickL, "onItemClick", "(Landroid/widget/AdapterView;Landroid/view/View;IJ)V", this, v, pos, id);
      return 1;
    }
    return 0;
  }),
  // AbsListView's long-press funnel: modal choice mode checks the row, everything else
  // goes to the OnItemLongClickListener.
  "performLongPress(Landroid/view/View;IJ)Z": driven(function* (this: JListView, v: JView, pos: number, id: bigint): Gen {
    if (this.choiceMode === CHOICE_MODE_MULTIPLE_MODAL && this.multiChoiceL) {
      yield guardCall(this, M_setItemChecked, pos, 1);
      return this.actionMode ? 1 : 0;
    }
    if (this.itemLongClickL) {
      return (yield vcall(this.itemLongClickL, "onItemLongClick",
        "(Landroid/widget/AdapterView;Landroid/view/View;IJ)Z", this, v, pos, id)) ? 1 : 0;
    }
    return 0;
  }),
  "setEmptyView(Landroid/view/View;)V": function (this: JListView, v: JView) { this.emptyView = v; this.updateEmptyStatus(); },
  "smoothScrollBy(II)V": function (this: JListView, dy: number) { this.scrollRows(dy); },
  "setOnScrollListener(Landroid/widget/AbsListView$OnScrollListener;)V": function (this: JListView, l: unknown) {
    this.scrollL = l;
    this.notifyScroll();
  },
  "clearChoices()V": function (this: JListView) { this.checked.clear(); return showCheckStates(this); },
  "getCheckedItemCount()I": function (this: JListView) { return this.checked.size; },
  "getCheckedItemIds()[J": function (this: JListView) { return BigInt64Array.from([...this.checked].map((c) => BigInt(c))); },
  "getCheckedItemPositions()Landroid/util/SparseBooleanArray;": function (this: JListView) {
    const info = rt.link("android/util/SparseBooleanArray");
    const sa = new info.ctor();
    for (const c of this.checked) sa.m.set(c, 1);
    return sa;
  },
  "pointToPosition(II)I": function (this: JListView, x: number, y: number) { return this.itemIndexAt(y + this.scrollY); },
  "getAdapter()Landroid/widget/ListAdapter;": function (this: JListView) {
    return this.headers.length || this.footers.length ? this.headerAdapter ??= new JHeaderViewListAdapter(this) : this.adapter;
  },
  "getAdapter()Landroid/widget/Adapter;": function (this: JListView) {
    return this.headers.length || this.footers.length ? this.headerAdapter ??= new JHeaderViewListAdapter(this) : this.adapter;
  },
  ...fieldGetters({ "getDividerHeight()I": "divH", "getChoiceMode()I": "choiceMode",
    "getEmptyView()Landroid/view/View;": "emptyView", "getListPaddingLeft()I": "padL",
    "getListPaddingRight()I": "padR", "getListPaddingTop()I": "padT", "getListPaddingBottom()I": "padB",
    "getDivider()Landroid/graphics/drawable/Drawable;": "divDraw" }),
  ...fieldSetters({ "setOnItemClickListener(Landroid/widget/AdapterView$OnItemClickListener;)V": "itemClickL",
    "setOnItemLongClickListener(Landroid/widget/AdapterView$OnItemLongClickListener;)V": "itemLongClickL",
    "setOnItemSelectedListener(Landroid/widget/AdapterView$OnItemSelectedListener;)V": "itemSelectedL",
    "setMultiChoiceModeListener(Landroid/widget/AbsListView$MultiChoiceModeListener;)V": "multiChoiceL" }),
  "layoutChildren()V": function (this: JListView) { requestLayout(this); },
  ...noops("setSelector(Landroid/graphics/drawable/Drawable;)V", "setSelector(I)V", "setDrawSelectorOnTop(Z)V",
    "setFastScrollEnabled(Z)V", "setHeaderDividersEnabled(Z)V", "setFooterDividersEnabled(Z)V",
    "setOverscrollHeader(Landroid/graphics/drawable/Drawable;)V",
    "setOverscrollFooter(Landroid/graphics/drawable/Drawable;)V", "setVerticalFadingEdgeEnabled(Z)V",
    "setFadingEdgeLength(I)V", "setRecyclerListener(Landroid/widget/AbsListView$RecyclerListener;)V",
    "setTextFilterEnabled(Z)V", "setSmoothScrollbarEnabled(Z)V", "setItemsCanFocus(Z)V",
    "setScrollingCacheEnabled(Z)V", "setCacheColorHint(I)V", "setTranscriptMode(I)V", "setStackFromBottom(Z)V"),
  ...stubs(null, "getSelectedItem()Ljava/lang/Object;"),
  ...stubs(-1, "getSelectedItemPosition()I"),
  "invalidateViews()V": function (this: JListView) { void this.rebuild(); },
  "onMeasure(II)V": measureListView,
  "onLayout(ZIIII)V": driven(function* (this: JListView): Gen {
    let y = this.padT;
    for (const v of this.allViews()) {
      yield layoutView(v, this.padL, y, this.padL + v.measuredW, y + v.measuredH);
      y += v.measuredH + this.divH;
    }
    this.finishLayout();
  }),
  "onDraw(Landroid/graphics/Canvas;)V": driven(function* (this: JListView, cv: JCanvas): Gen {
    const d = this.divDraw, thread = curThread;
    if (!d || this.divH <= 0) return;
    const vs = this.allViews();
    for (let i = 0; i < vs.length - 1; i++) {
      d.bounds.left = this.padL;
      d.bounds.top = vs[i].bottom;
      d.bounds.right = this.width() - this.padR;
      d.bounds.bottom = vs[i].bottom + this.divH;
      const pending = drawChild(d, cv, thread);
      if (pending instanceof Promise) yield pending;
    }
  }),
  "onInterceptTouchEvent(Landroid/view/MotionEvent;)Z": function (this: JListView, ev: JMotionEvent) {
    const a = ev.action & 0xff;
    if (a === 0) {
      this.downY = this.lastY = ev.y;
      this.dragging = false;
      this.flingAnim = null;
      this.setScrollState(0);
      this.velo = 0;
    } else if (a === 2 && Math.abs(ev.y - this.downY) > device.touchSlop) {
      this.dragging = true;
      return 1;
    }
    return 0;
  },
  "onTouchEvent(Landroid/view/MotionEvent;)Z": driven(function* (this: JListView, ev: JMotionEvent): Gen {
    const a = ev.action & 0xff;
    if (a === 0) {
      this.lastY = ev.y;
      this.lastMoveT = ev.eventTime;
      this.flingAnim = null;
      // press feedback on the item under finger
      const idx = this.itemIndexAt(ev.y + this.scrollY);
      this.pressTarget = idx;
      this.longFired = false;
      cancelItemLongPress(this);
      if (idx >= 0) {
        this.longPressTimer = setTimeout(() => {
          this.longPressTimer = null;
          void (async () => dispatchLongPress(this, idx))().catch(reportUncaught);
        }, 450);
      }
      return 1;
    }
    if (a === 2) {
      const d = this.lastY - ev.y;
      const dt = Math.max(1, ev.eventTime - this.lastMoveT);
      this.velo = trackVelocity(this.velo, d, dt);
      this.lastMoveT = ev.eventTime;
      if (!this.dragging && Math.abs(ev.y - this.downY) > device.touchSlop) this.dragging = true;
      if (this.dragging) {
        cancelItemLongPress(this);
        this.setScrollState(1);
        this.scrollRows(d);
      }
      this.lastY = ev.y;
      return 1;
    }
    if (a === 1) {
      cancelItemLongPress(this);
      if (!this.dragging && !this.longFired && this.pressTarget >= 0) {
        const v = this.allViews()[this.pressTarget];
        if (v) {
          yield guardCall(this, M_perfItemClick, v, this.pressTarget, yield rowId(this, this.pressTarget));
        }
      }
      let vv = restVelocity(this.velo, SCROLL_WEIGHT, ev.eventTime - this.lastMoveT);
      if (this.dragging && Math.abs(vv) > FLING.arm) {
        const anim = () => {
          if (this.flingAnim !== anim) return false;
          this.scrollRows(vv);
          vv *= FLING.decay;
          if (Math.abs(vv) > FLING.stop) return true;
          this.setScrollState(0);
          return false;
        };
        this.flingAnim = anim;
        uiState.animHooks.add(anim);
        this.setScrollState(2);
      } else this.setScrollState(0);
      this.dragging = false;
      this.pressTarget = -1;
      return 1;
    }
    if (a === 3) { cancelItemLongPress(this); this.pressTarget = -1; this.setScrollState(0); }
    return 1;
  }),
  "canScrollVertically(I)Z": function (this: JListView, dir: number) {
    return dir > 0 ? (this.scrollY < this.maxScroll() ? 1 : 0) : (this.scrollY > 0 ? 1 : 0);
  },
};

rt.register({
  name: "android/widget/AdapterView", ctor: class extends JListView {}, sup: "android/view/ViewGroup",
  statics: { INVALID_POSITION: -1, ITEM_VIEW_TYPE_IGNORE: -1 },
  methods: listViewMethods,
});
rt.register({ name: "android/widget/AbsListView", ctor: class extends JListView {}, sup: "android/widget/AdapterView",
  statics: { CHOICE_MODE_NONE: 0, CHOICE_MODE_SINGLE: 1, CHOICE_MODE_MULTIPLE: 2, CHOICE_MODE_MULTIPLE_MODAL: CHOICE_MODE_MULTIPLE_MODAL },
  methods: listViewMethods });
rt.register({ name: "android/widget/ListView", ctor: JListView, sup: "android/widget/AbsListView", methods: listViewMethods });

class JListPopupWindow extends JObj {
  ctx: unknown = null;
  anchor: JView | null = null;
  adapter: unknown = null;
  itemClick: unknown = null;
  popup: unknown = null;
  list: JListView | null = null;
  width = WRAP_CONTENT;
  height = WRAP_CONTENT;
  xoff = 0;
  yoff = 0;
  modal = true;
}
rt.register({ name: "android/widget/ListPopupWindow", ctor: JListPopupWindow, methods: {
  "<init>(Landroid/content/Context;)V": function (this: JListPopupWindow, ctx: unknown) { this.ctx = ctx; },
  "setAdapter(Landroid/widget/ListAdapter;)V": driven(function* (this: JListPopupWindow, adapter: unknown): Gen {
    this.adapter = adapter;
    if (this.list) yield vcall(this.list, "setAdapter", "(Landroid/widget/ListAdapter;)V", adapter);
  }),
  "setAnchorView(Landroid/view/View;)V": function (this: JListPopupWindow, anchor: JView) { this.anchor = anchor; },
  "setOnItemClickListener(Landroid/widget/AdapterView$OnItemClickListener;)V": driven(function* (this: JListPopupWindow, listener: unknown): Gen {
    this.itemClick = listener;
    if (this.list) yield vcall(this.list, "setOnItemClickListener", "(Landroid/widget/AdapterView$OnItemClickListener;)V", listener);
  }),
  "setModal(Z)V": function (this: JListPopupWindow, value: number) { this.modal = !!value; },
  "setWidth(I)V": function (this: JListPopupWindow, value: number) { this.width = value; },
  "setHeight(I)V": function (this: JListPopupWindow, value: number) { this.height = value; },
  "setHorizontalOffset(I)V": function (this: JListPopupWindow, value: number) { this.xoff = value; },
  "setVerticalOffset(I)V": function (this: JListPopupWindow, value: number) { this.yoff = value; },
  "getListView()Landroid/widget/ListView;": function (this: JListPopupWindow) { return this.list; },
  "isShowing()Z": function (this: JListPopupWindow) { return this.popup ? vcall(this.popup, "isShowing", "()Z") : 0; },
  "dismiss()V": function (this: JListPopupWindow) { if (this.popup) return vcall(this.popup, "dismiss", "()V"); },
  "show()V": driven(function* (this: JListPopupWindow): Gen {
    if (!this.anchor) return;
    if (!this.popup) {
      this.list = yield newObj("android/widget/ListView", "(Landroid/content/Context;Landroid/util/AttributeSet;)V", this.ctx, null);
      yield vcall(this.list, "setAdapter", "(Landroid/widget/ListAdapter;)V", this.adapter);
      yield vcall(this.list, "setOnItemClickListener", "(Landroid/widget/AdapterView$OnItemClickListener;)V", this.itemClick);
      this.popup = yield newObj("android/widget/PopupWindow", "(Landroid/content/Context;)V", this.ctx);
      yield vcall(this.popup, "setContentView", "(Landroid/view/View;)V", this.list);
      yield vcall(this.popup, "setFocusable", "(Z)V", +this.modal);
      yield vcall(this.popup, "setOutsideTouchable", "(Z)V", 1);
    }
    yield vcall(this.popup, "setWidth", "(I)V", this.width === WRAP_CONTENT ? this.anchor.width() : this.width);
    yield vcall(this.popup, "setHeight", "(I)V", this.height);
    yield vcall(this.popup, "showAsDropDown", "(Landroid/view/View;II)V", this.anchor, this.xoff, this.yoff);
  }),
} });
rt.register({
  name: "android/widget/ExpandableListView", ctor: class extends JListView {}, sup: "android/widget/ListView",
  methods: {
    "static getPackedPositionForChild(II)J": (group: number, child: number) => (1n << 63n) | (BigInt(group >>> 0) << 32n) | BigInt(child >>> 0),
    "static getPackedPositionForGroup(I)J": (group: number) => BigInt(group >>> 0) << 32n,
    "static getPackedPositionType(J)I": (p: bigint) => p === -1n ? 2 : p < 0n ? 1 : 0,
    "static getPackedPositionGroup(J)I": (p: bigint) => p === -1n ? -1 : Number((p >> 32n) & 0x7fffffffn),
    "static getPackedPositionChild(J)I": (p: bigint) => p < 0n && p !== -1n ? Number(p & 0xffffffffn) : -1,
  },
});
rt.register({
  name: "android/widget/AbsListView$LayoutParams", ctor: class extends JLayoutParams {}, sup: "android/view/ViewGroup$LayoutParams",
  methods: {
    "<init>(II)V": function (this: JLayoutParams, w: number, h: number) { this.width = w; this.height = h; },
    "<init>(III)V": function (this: JLayoutParams, w: number, h: number) { this.width = w; this.height = h; },
  },
});
rt.register({
  name: "android/widget/GridView", ctor: class extends JListView { cols = 2; }, sup: "android/widget/AbsListView",
  methods: {
    ...listViewMethods,
    "setNumColumns(I)V": function (this: any, n: number) { this.cols = Math.max(1, n); requestLayout(this); },
    ...noops("setColumnWidth(I)V", "setStretchMode(I)V", "setHorizontalSpacing(I)V", "setVerticalSpacing(I)V"),
    "onMeasure(II)V": driven(function* (this: any, wSpec: number, hSpec: number): Gen {
      const w = defaultSize(specSize(wSpec), wSpec);
      const availW = Math.max(0, w - this.padL - this.padR);
      const colW = Math.floor(availW / this.cols);
      let rowH = 0, totalH = this.padT + this.padB;
      const vs = this.allViews();
      for (let i = 0; i < vs.length; i++) {
        yield measureView(vs[i], makeSpec(colW, MS_EXACTLY), makeSpec(0, MS_UNSPEC));
        rowH = Math.max(rowH, vs[i].measuredH);
        if (i % this.cols === this.cols - 1 || i === vs.length - 1) {
          totalH += rowH;
          rowH = 0;
        }
      }
      this.measuredW = w;
      this.measuredH = specMode(hSpec) === MS_EXACTLY ? specSize(hSpec) : resolveSize(totalH, hSpec);
    }),
    "onLayout(ZIIII)V": driven(function* (this: any): Gen {
      const availW = Math.max(0, this.width() - this.padL - this.padR);
      const colW = Math.floor(availW / this.cols);
      const vs = this.allViews();
      let y = this.padT, rowH = 0;
      for (let i = 0; i < vs.length; i++) {
        const col = i % this.cols;
        if (col === 0 && i > 0) { y += rowH; rowH = 0; }
        const x = this.padL + col * colW;
        yield layoutView(vs[i], x, y, x + vs[i].measuredW, y + vs[i].measuredH);
        rowH = Math.max(rowH, vs[i].measuredH);
      }
      this.finishLayout();
    }),
  },
});

// Spinner: one selected item view (getView) + a dropdown of getDropDownViews on click
class JSpinner extends JListView {
  selection = 0;
  selView: JView | null = null;
  popupBg: JDrawable | null = null;
  /** the AdapterView rebuild: a Spinner materializes only the selected item */
  rebuild(): void | Promise<void> { return rt.drive(this.rebuild$()); }
  *rebuild$(): Gen<void> {
    for (const v of [...this.children]) yield detachView(this, v);
    this.selView = null;
    const n: number = this.adapter ? yield vcall(this.adapter, "getCount", "()I") : 0;
    if (this.selection >= 0 && this.selection < n) {
      this.selView = (yield vcall(this.adapter, "getView", "(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;",
        this.selection, null, this)) as JView | null;
      if (this.selView) yield attachView(this, this.selView);
    }
    requestLayout(this);
  }
}
/** the dropdown list: as wide as its anchor, as tall as the free space beside it */
class JSpinnerPopup extends JListView { popW = 0; popH = 0; }
rt.register({
  name: "webdroid/SpinnerPopup", ctor: JSpinnerPopup, sup: "android/widget/ListView",
  methods: {
    ...listViewMethods,
    "generateLayoutParams(Landroid/util/AttributeSet;)Landroid/view/ViewGroup$LayoutParams;": function () {
      const lp = new JLayoutParams();
      lp.width = MATCH_PARENT; lp.height = WRAP_CONTENT;
      return lp;
    },
    "onMeasure(II)V": function (this: JSpinnerPopup) {
      return measureListView.call(this, makeSpec(this.popW, MS_EXACTLY), makeSpec(this.popH, MS_AT_MOST));
    },
  },
});
const showSpinnerPopup = driven(function* showSpinnerPopup(sp: JSpinner): Gen {
  const a = sp.adapter;
  if (!a || !(yield vcall(a, "getCount", "()I"))) return;
  const list = new JSpinnerPopup();
  inheritContext(list, sp);
  yield themeDivider(list);
  list.background = sp.popupBg;
  const fwd = (n: string, d: string) => (...args: unknown[]) => vcall(a, n, d, ...args);
  yield vcall(list, "setAdapter", "(Landroid/widget/ListAdapter;)V", {
    [mangleMethod("getCount", "()I")]: fwd("getCount", "()I"),
    [mangleMethod("getItem", "(I)Ljava/lang/Object;")]: fwd("getItem", "(I)Ljava/lang/Object;"),
    [mangleMethod("getItemId", "(I)J")]: fwd("getItemId", "(I)J"),
    [mangleMethod("getView", "(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;")]:
      fwd("getDropDownView", "(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;"),
    [mangleMethod("registerDataSetObserver", "(Landroid/database/DataSetObserver;)V")]: () => {},
    [mangleMethod("unregisterDataSetObserver", "(Landroid/database/DataSetObserver;)V")]: () => {},
  });
  list.itemClickL = {
    [mangleMethod("onItemClick", "(Landroid/widget/AdapterView;Landroid/view/View;IJ)V")]:
      async (_p: unknown, _v: unknown, pos: number) => {
        removeOverlay(list);
        await vcall(sp, "setSelection", "(I)V", pos);
      },
  };
  let root: JView = sp, x = 0, y = 0;
  for (let v: JView | null = sp; v; v = v.parent) {
    x += v.left - (v.parent?.scrollX ?? 0);
    y += v.top - (v.parent?.scrollY ?? 0);
    root = v;
  }
  const below = root.height() - y - sp.height();
  list.popW = sp.width();
  list.popH = Math.max(y, below);
  yield measureView(list, makeSpec(root.width(), MS_AT_MOST), makeSpec(root.height(), MS_AT_MOST));
  yield vcall(list, "setSelection", "(I)V", sp.selection);
  addOverlay(list, x, list.measuredH <= below ? y + sp.height() : Math.max(0, y - list.measuredH), true);
});
// ── AbsSpinner: AdapterView's selection contract
//
// AOSP is Spinner extends AbsSpinner extends AdapterView, and the two superclasses own the
// half of a spinner that has nothing to do with drawing a row:
//   * AbsSpinner.setAdapter makes position 0 the selection the moment a non-empty adapter
//     lands (INVALID_POSITION when it is empty), so getSelectedItem/getSelectedItemPosition/
//     getSelectedItemId answer with the default row before the user has touched anything.
//   * AdapterView reports a selection that MOVED — including that initial move off
//     INVALID_POSITION — to the OnItemSelectedListener, and reports it from a posted
//     Runnable (SelectionNotifier) rather than inline, so the callback still arrives when the
//     listener is registered after the adapter. Nothing selected means onNothingSelected.
// A spinner left sitting on its default row must therefore still tell its listener it is on
// that row. Without that, an app which mirrors the spinner into its own state believes the
// user chose nothing and its own validation rejects the form.
//
// Our Spinner is registered below over the ListView row plumbing (it descends from AbsListView
// rather than from AbsSpinner), so this layer is spread into that spec rather than inherited.
/** `selNotified` is AdapterView's mOldSelectedPosition: the position the listener last heard. */
type JSelSpinner = JSpinner & { selNotified?: number; selNotifyPosted?: boolean };

const selectedRowId = driven(function* selectedRowId(sp: JSelSpinner): Gen<bigint> {
  if (!sp.adapter || sp.selection < 0) return INVALID_ROW_ID;
  return (yield vcall(sp.adapter, "getItemId", "(I)J", sp.selection)) as bigint;
});

/** AdapterView.SelectionNotifier: the deferred half of selectionChanged(). */
const fireItemSelected = driven(function* fireItemSelected(sp: JSelSpinner): Gen {
  const l = sp.itemSelectedL;
  if (!l) return;
  if (sp.adapter && sp.selection >= 0) {
    yield vcall(l, "onItemSelected", "(Landroid/widget/AdapterView;Landroid/view/View;IJ)V",
      sp, sp.selView, sp.selection, yield selectedRowId(sp));
  } else {
    yield vcall(l, "onNothingSelected", "(Landroid/widget/AdapterView;)V", sp);
  }
});

/** AdapterView.checkSelectionChanged(): notify only when the selected row actually moved. */
function checkSelectionChanged(sp: JSelSpinner) {
  if ((sp.selNotified ?? INVALID_POSITION) === sp.selection) return;
  sp.selNotified = sp.selection;
  if (sp.selNotifyPosted) return; // one notifier in flight; it reads the selection when it runs
  sp.selNotifyPosted = true;
  setTimeout(() => void onMain(async () => {
    sp.selNotifyPosted = false;
    try { await fireItemSelected(sp); } catch (e) { reportUncaught(e); }
  }), 0);
}

/** The one place the selection moves: AdapterView.setSelectedPositionInt + the layout that
 *  materializes the new selected view + the change check that reports it. */
const selectPosition = driven(function* selectPosition(sp: JSelSpinner, pos: number): Gen {
  if (sp.selection !== pos) {
    sp.selection = pos;
    yield sp.rebuild();
  }
  checkSelectionChanged(sp);
});

const absSpinnerMethods: NativeSpec["methods"] = {
  "setAdapter(Landroid/widget/SpinnerAdapter;)V": driven(function* (this: JSelSpinner, a: unknown): Gen {
    yield vcall(this, "setAdapter", "(Landroid/widget/ListAdapter;)V", a);
    const n = a ? (yield vcall(this, "getCount", "()I")) as number : 0;
    yield selectPosition(this, n > 0 ? 0 : INVALID_POSITION);
  }),
  "setSelection(I)V": driven(function* (this: JSelSpinner, pos: number): Gen { yield selectPosition(this, pos); }),
  "getSelectedItemPosition()I": function (this: JSelSpinner) { return this.selection; },
  "getSelectedView()Landroid/view/View;": function (this: JSelSpinner) { return this.selView; },
  "getSelectedItem()Ljava/lang/Object;": function(this: JSelSpinner) {
    if (!this.adapter || this.selection < 0) return null;
    return vcall(this.adapter, "getItem", "(I)Ljava/lang/Object;", this.selection);
  },
  "getSelectedItemId()J": function (this: JSelSpinner) { return selectedRowId(this); },
};
rt.register({
  name: "android/widget/AbsSpinner", ctor: class extends JSpinner {},
  sup: "android/widget/AdapterView", methods: absSpinnerMethods,
});

rt.register({
  name: "android/widget/Spinner", ctor: JSpinner, sup: "android/widget/AbsListView",
  methods: {
    ...listViewMethods,
    "<init>(Landroid/content/Context;)V": function (this: JSpinner, c: unknown) {
      return (this as any)[mangleMethod("<init>", "(Landroid/content/Context;Landroid/util/AttributeSet;)V")](c, null);
    },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": driven(function* (this: JSpinner, c: unknown, set: JAttrSet | null, dsa?: number): Gen {
      yield initViewFromCtx(this, c, set);
      if (!this.jres) return;
      // appcompat's Spinner passes its OWN spinnerStyle: resolving the framework one instead
      // gives a widget the app never styled (a Holo underline under a Material app's title)
      const ta = obtainStyled(this.jres, this.theme, set, [AID("background"), AID("popupBackground")], dsa || AID("spinnerStyle"), 0);
      if (ta.vals[0]) this.background = yield loadDrawableRV(this.jres, ta.vals[0], this.theme);
      if (ta.vals[1]) this.popupBg = yield loadDrawableRV(this.jres, ta.vals[1], this.theme);
    }),
    "getAdapter()Landroid/widget/SpinnerAdapter;": function (this: JSpinner) { return this.adapter; },
    "getCount()I": driven(function* (this: JSpinner): Gen {
      return this.adapter ? yield vcall(this.adapter, "getCount", "()I") : 0;
    }),
    "setSelection(IZ)V": function (this: JSpinner, pos: number) {
      return (this as any)[mangleMethod("setSelection", "(I)V")](pos);
    },
    "onMeasure(II)V": driven(function* (this: JSpinner, wSpec: number, hSpec: number): Gen {
      if (this.selView) {
        yield measureView(this.selView, childMeasureSpec(wSpec, device.dp(20), this.selView.lp?.width ?? WRAP_CONTENT), makeSpec(0, MS_UNSPEC));
      }
      const w = specMode(wSpec) === MS_EXACTLY ? specSize(wSpec) : Math.max(this.minW, (this.selView?.measuredW ?? device.dp(50)) + device.dp(28));
      const h = specMode(hSpec) === MS_EXACTLY ? specSize(hSpec) : Math.max(this.minH, (this.selView?.measuredH ?? device.dp(30)), device.dp(42));
      this.measuredW = w;
      this.measuredH = h;
    }),
    "onLayout(ZIIII)V": driven(function* (this: JSpinner): Gen {
      if (this.selView) {
        yield layoutView(this.selView, this.padL, (this.height() - this.selView.measuredH) >> 1,
          this.padL + this.selView.measuredW, (this.height() + this.selView.measuredH) >> 1);
      }
    }),
    "performClick()Z": driven(function* (this: JSpinner): Gen {
      yield showSpinnerPopup(this);
      return 1;
    }),
    "onTouchEvent(Landroid/view/MotionEvent;)Z": driven(function* (this: JSpinner, ev: JMotionEvent): Gen {
      if ((ev.action & 0xff) === 1) yield vcall(this, "performClick", "()Z");
      return 1;
    }),
    ...absSpinnerMethods,
  },
});
