// ExpandableListView over ListView's rows. As in AOSP, an ExpandableListConnector flattens the
// groups and the children of expanded groups into the positions the list lays out.

import { rt, JObj, type NativeSpec, fieldSetters, callSelf, stubs, noops, driven, type Gen } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { vcall, vcallOn, curThread } from "../jvm/natives/jlang";
import { type JView, vgMethods } from "./view";
import { AID, type JAttrSet, obtainStyled, rvDimen } from "./res";
import { type JDrawable, ST, loadDrawableRV, drawableSize, drawAt } from "./drawable";
import { type JavaCanvas } from "./canvas";
import { JListView, JBaseAdapter, baseAdapterMethods, listViewMethods } from "./listview";
import { inflateLayout } from "./inflate";

const L = "Landroid/widget/ExpandableListView;";
const PACKED_NULL = 0xffffffffn;
const packGroup = (g: number) => BigInt(g & 0x7fffffff) << 32n;
const packChild = (g: number, c: number) => BigInt.asIntN(64, (1n << 63n) | packGroup(g) | BigInt(c >>> 0));
const packed = (g: number, c: number) => c < 0 ? packGroup(g) : packChild(g, c);

/** a flattened row: a group (child -1) or a child of an expanded group */
type Row = { g: number; c: number; last: boolean };

class JExpandableListConnector extends JBaseAdapter {
  adapter: unknown = null;
  expanded = new Set<number>();
  rows: Row[] = [];
  /** the DataSetObserver it registers on its ExpandableListAdapter */
  readonly observer = Object.assign(new JObj(), {
    [mangleMethod("onChanged", "()V")]: () => this.refresh(),
    [mangleMethod("onInvalidated", "()V")]: () => this.refresh(),
  });
  /** the rows the adapter's groups and the expanded set make, then the list's own rebuild */
  refresh(): unknown { return rt.drive(this.refresh$()); }
  *refresh$(): Gen {
    const a = this.adapter, thread = curThread, rows: Row[] = [];
    const n = Number(yield vcallOn(thread, a, "getGroupCount", "()I"));
    for (const g of this.expanded) if (g >= n) this.expanded.delete(g);
    for (let g = 0; g < n; g++) {
      rows.push({ g, c: -1, last: false });
      if (!this.expanded.has(g)) continue;
      const k = Number(yield vcallOn(thread, a, "getChildrenCount", "(I)I", g));
      for (let c = 0; c < k; c++) rows.push({ g, c, last: c === k - 1 });
    }
    this.rows = rows;
    yield vcallOn(thread, this, "notifyDataSetChanged", "()V");
  }
  /** ExpandableListConnector.expandGroup/collapseGroup: false when nothing changed */
  toggle(g: number, open: boolean): unknown { return rt.drive(this.toggle$(g, open)); }
  *toggle$(g: number, open: boolean): Gen<number> {
    if (g < 0 || this.expanded.has(g) === open) return 0;
    if (open) this.expanded.add(g); else this.expanded.delete(g);
    yield vcall(this.adapter, open ? "onGroupExpanded" : "onGroupCollapsed", "(I)V", g);
    yield this.refresh();
    return 1;
  }
}
const rowOf = (c: JExpandableListConnector, i: number) => c.rows[i] ?? null;
rt.register({
  name: "android/widget/ExpandableListConnector", ctor: JExpandableListConnector, sup: "android/widget/BaseAdapter",
  methods: {
    "getCount()I": function (this: JExpandableListConnector) { return this.rows.length; },
    "getItem(I)Ljava/lang/Object;": function (this: JExpandableListConnector, i: number) {
      const r = rowOf(this, i);
      return !r ? null : r.c < 0 ? vcall(this.adapter, "getGroup", "(I)Ljava/lang/Object;", r.g) : vcall(this.adapter, "getChild", "(II)Ljava/lang/Object;", r.g, r.c);
    },
    "getItemId(I)J": driven(function* (this: JExpandableListConnector, i: number): Gen {
      const r = rowOf(this, i), a = this.adapter;
      if (!r) return -1n;
      const gid = yield vcall(a, "getGroupId", "(I)J", r.g);
      return r.c < 0 ? vcall(a, "getCombinedGroupId", "(J)J", gid)
        : vcall(a, "getCombinedChildId", "(JJ)J", gid, yield vcall(a, "getChildId", "(II)J", r.g, r.c));
    }),
    "getView(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;": function (this: JExpandableListConnector, i: number, convert: unknown, parent: unknown) {
      const r = rowOf(this, i);
      if (!r) return null;
      return r.c < 0
        ? vcall(this.adapter, "getGroupView", "(IZLandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;", r.g, +this.expanded.has(r.g), convert, parent)
        : vcall(this.adapter, "getChildView", "(IIZLandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;", r.g, r.c, +r.last, convert, parent);
    },
    "isEnabled(I)Z": function (this: JExpandableListConnector, i: number) {
      const r = rowOf(this, i);
      return !r || r.c < 0 ? 1 : vcall(this.adapter, "isChildSelectable", "(II)Z", r.g, r.c);
    },
    "areAllItemsEnabled()Z": function (this: JExpandableListConnector) { return vcall(this.adapter, "areAllItemsEnabled", "()Z"); },
    "hasStableIds()Z": function (this: JExpandableListConnector) { return vcall(this.adapter, "hasStableIds", "()Z"); },
  },
});

class JExpandableListView extends JListView {
  connector: JExpandableListConnector | null = null;
  groupIndicator: JDrawable | null = null; childIndicator: JDrawable | null = null;
  childDivider: JDrawable | null = null;
  indicatorLeft = 0; indicatorRight = 0;
  /** CHILD_INDICATOR_INHERIT: children use the group bounds */
  childIndicatorLeft = -1; childIndicatorRight = -1;
  groupClickL: unknown = null; childClickL: unknown = null; groupExpandL: unknown = null; groupCollapseL: unknown = null;
  /** the adapter row a list position names, or null for a header or footer */
  rowAt(position: number): Row | null {
    return this.connector ? rowOf(this.connector, position - this.headers.length) : null;
  }
  /** AOSP resolveIndicatorPositions: a right edge left at 0 is the indicator's own width */
  *setGroupIndicator$(d: JDrawable | null): Gen {
    this.groupIndicator = d;
    if (d && this.indicatorRight === 0) this.indicatorRight = this.indicatorLeft + Math.max(0, yield drawableSize(d, false));
  }
  expand(g: number, open: boolean): unknown { return rt.drive(this.expand$(g, open)); }
  *expand$(g: number, open: boolean): Gen<number> {
    const changed = this.connector ? yield this.connector.toggle(g, open) : 0;
    const l = open ? this.groupExpandL : this.groupCollapseL;
    if (l) yield vcall(l, open ? "onGroupExpand" : "onGroupCollapse", "(I)V", g);
    return changed;
  }
}
const GROUP_STATES = [[], [ST.expanded], [ST.empty], [ST.expanded, ST.empty]].map((s) => Int32Array.from(s));
const CHILD_LAST = Int32Array.of(ST.last), NO_STATE = new Int32Array(0);

const initExpandable = driven(function* initExpandable(this: JExpandableListView, c: unknown, set: JAttrSet | null = null, dsa: number = AID("expandableListViewStyle")): Gen {
  yield callSelf(listViewMethods, "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V", this, c, set);
  const res = this.jres;
  if (!res) return;
  const a = obtainStyled(res, this.theme, set, ["groupIndicator", "childIndicator", "indicatorLeft", "indicatorRight",
    "childIndicatorLeft", "childIndicatorRight", "childDivider"].map(AID), dsa, 0);
  const dimen = (i: number, dflt: number) => a.vals[i] ? Math.trunc(rvDimen(res, a.vals[i], dflt)) : dflt;
  this.indicatorLeft = dimen(2, 0); this.indicatorRight = dimen(3, 0);
  this.childIndicatorLeft = dimen(4, -1); this.childIndicatorRight = dimen(5, -1);
  if (a.vals[1]) this.childIndicator = yield loadDrawableRV(res, a.vals[1], this.theme);
  if (a.vals[6]) this.childDivider = yield loadDrawableRV(res, a.vals[6], this.theme);
  if (a.vals[0]) yield* this.setGroupIndicator$(yield loadDrawableRV(res, a.vals[0], this.theme));
});
function expandGroup(this: JExpandableListView, g: number) { return this.expand(g, true); }
function setIndicatorBounds(this: JExpandableListView, l: number, r: number) { this.indicatorLeft = l; this.indicatorRight = r; }
function setChildIndicatorBounds(this: JExpandableListView, l: number, r: number) { this.childIndicatorLeft = l; this.childIndicatorRight = r; }
/** AOSP handleItemClick: a group's click expands or collapses it unless its listener consumed it;
 *  a child's goes to OnChildClickListener; neither reaches OnItemClickListener */
const performItemClick = driven(function* (this: JExpandableListView, v: JView, position: number, id: bigint): Gen {
  const r = this.rowAt(position);
  if (!r) return callSelf(listViewMethods, "performItemClick(Landroid/view/View;IJ)Z", this, v, position, id);
  if (r.c >= 0) return this.childClickL ? vcall(this.childClickL, "onChildClick", `(${L}Landroid/view/View;IIJ)Z`, this, v, r.g, r.c, id) : 0;
  if (this.groupClickL && (yield vcall(this.groupClickL, "onGroupClick", `(${L}Landroid/view/View;IJ)Z`, this, v, r.g, id))) return 1;
  yield this.expand(r.g, !this.connector!.expanded.has(r.g));
  return 1;
});
rt.register({
  name: "android/widget/ExpandableListView", ctor: JExpandableListView, sup: "android/widget/ListView",
  statics: { PACKED_POSITION_TYPE_GROUP: 0, PACKED_POSITION_TYPE_CHILD: 1, PACKED_POSITION_TYPE_NULL: 2, PACKED_POSITION_VALUE_NULL: PACKED_NULL, CHILD_INDICATOR_INHERIT: -1 },
  methods: {
    ...listViewMethods,
    "<init>(Landroid/content/Context;)V": initExpandable,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": initExpandable,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": initExpandable,
    "setAdapter(Landroid/widget/ListAdapter;)V": () => {
      throw rt.mkThrowable("java/lang/RuntimeException", "For ExpandableListView, use setAdapter(ExpandableListAdapter) instead of setAdapter(ListAdapter)");
    },
    "setAdapter(Landroid/widget/ExpandableListAdapter;)V": driven(function* (this: JExpandableListView, a: unknown): Gen {
      const old = this.connector;
      if (old?.adapter) yield vcall(old.adapter, "unregisterDataSetObserver", "(Landroid/database/DataSetObserver;)V", old.observer);
      let connector: JExpandableListConnector | null = null;
      if (a) {
        connector = rt.make("android/widget/ExpandableListConnector") as JExpandableListConnector;
        connector.adapter = a;
        yield vcall(a, "registerDataSetObserver", "(Landroid/database/DataSetObserver;)V", connector.observer);
        yield connector.refresh();
      }
      this.connector = connector;
      yield callSelf(listViewMethods, "setAdapter(Landroid/widget/ListAdapter;)V", this, connector);
    }),
    "getExpandableListAdapter()Landroid/widget/ExpandableListAdapter;": function (this: JExpandableListView) { return this.connector?.adapter ?? null; },
    "expandGroup(I)Z": expandGroup,
    "expandGroup(IZ)Z": expandGroup,
    "collapseGroup(I)Z": function (this: JExpandableListView, g: number) { return this.expand(g, false); },
    "isGroupExpanded(I)Z": function (this: JExpandableListView, g: number) { return +!!this.connector?.expanded.has(g); },
    "performItemClick(Landroid/view/View;IJ)Z": performItemClick,
    "setGroupIndicator(Landroid/graphics/drawable/Drawable;)V": function (this: JExpandableListView, d: JDrawable | null) { return rt.drive(this.setGroupIndicator$(d)); },
    "setIndicatorBounds(II)V": setIndicatorBounds,
    "setIndicatorBoundsRelative(II)V": setIndicatorBounds,
    "setChildIndicatorBounds(II)V": setChildIndicatorBounds,
    "setChildIndicatorBoundsRelative(II)V": setChildIndicatorBounds,
    ...fieldSetters({ "setChildIndicator(Landroid/graphics/drawable/Drawable;)V": "childIndicator", "setChildDivider(Landroid/graphics/drawable/Drawable;)V": "childDivider",
      [`setOnGroupClickListener(Landroid/widget/ExpandableListView$OnGroupClickListener;)V`]: "groupClickL",
      [`setOnChildClickListener(Landroid/widget/ExpandableListView$OnChildClickListener;)V`]: "childClickL",
      [`setOnGroupExpandListener(Landroid/widget/ExpandableListView$OnGroupExpandListener;)V`]: "groupExpandL",
      [`setOnGroupCollapseListener(Landroid/widget/ExpandableListView$OnGroupCollapseListener;)V`]: "groupCollapseL" }),
    "getExpandableListPosition(I)J": function (this: JExpandableListView, position: number) {
      const r = this.rowAt(position);
      return r ? packed(r.g, r.c) : PACKED_NULL;
    },
    "getFlatListPosition(J)I": function (this: JExpandableListView, p: bigint) {
      const g = packedGroup(p), c = packedChild(p), rows = this.connector?.rows ?? [];
      const i = rows.findIndex((r) => r.g === g && r.c === c);
      return i < 0 ? -1 : i + this.headers.length;
    },
    "static getPackedPositionForChild(II)J": packChild,
    "static getPackedPositionForGroup(I)J": packGroup,
    "static getPackedPositionType(J)I": (p: bigint) => p === PACKED_NULL ? 2 : p < 0n ? 1 : 0,
    "static getPackedPositionGroup(J)I": packedGroup,
    "static getPackedPositionChild(J)I": packedChild,
    "dispatchDraw(Landroid/graphics/Canvas;)V": driven(function* (this: JExpandableListView, cv: JavaCanvas): Gen {
      yield callSelf(vgMethods, "dispatchDraw(Landroid/graphics/Canvas;)V", this, cv);
      if (!this.connector || (!this.groupIndicator && !this.childIndicator)) return;
      const thread = curThread, { rows, expanded } = this.connector, vs = this.allViews(), top = this.scrollY, bottom = top + this.height();
      for (let i = this.headers.length; i < vs.length - this.footers.length; i++) {
        const v = vs[i], r = this.rowAt(i);
        if (!r || v.bottom < top || v.top > bottom) continue;
        const child = r.c >= 0, d = child ? this.childIndicator : this.groupIndicator;
        const left = child && this.childIndicatorLeft !== -1 ? this.childIndicatorLeft : this.indicatorLeft;
        const right = child && this.childIndicatorRight !== -1 ? this.childIndicatorRight : this.indicatorRight;
        if (!d || left === right) continue;
        if (yield vcallOn(thread, d, "isStateful", "()Z")) {
          // AOSP counts a collapsed group as empty: only an expanded one has children to ask about
          const open = expanded.has(r.g), next = rows[i - this.headers.length + 1];
          const empty = !open || !next || next.c < 0;
          yield vcallOn(thread, d, "setState", "([I)Z", child ? (r.last ? CHILD_LAST : NO_STATE) : GROUP_STATES[(open ? 1 : 0) | (empty ? 2 : 0)]);
        }
        yield drawAt(d, cv, left + this.padL, v.top, right + this.padL, v.bottom, thread);
      }
    }),
  },
});
function packedGroup(p: bigint): number { return p === PACKED_NULL ? -1 : Number((p >> 32n) & 0x7fffffffn); }
function packedChild(p: bigint): number { return p === PACKED_NULL || p >= 0n ? -1 : Number(BigInt.asIntN(32, p)); }
rt.markers(...["OnGroupClickListener", "OnChildClickListener", "OnGroupExpandListener", "OnGroupCollapseListener"].map((n) => "android/widget/ExpandableListView$" + n));
rt.register({ name: "android/widget/ExpandableListAdapter", ctor: class extends JObj {} });
rt.register({ name: "android/widget/HeterogeneousExpandableList", ctor: class extends JObj {} });

// ── BaseExpandableListAdapter: the observable half every app adapter inherits
const combinedGroupId = (id: bigint) => (BigInt.asUintN(64, id) & 0x7fffffffn) << 32n;
const baseExpandableMethods: NativeSpec["methods"] = {
  ...Object.fromEntries(["registerDataSetObserver(Landroid/database/DataSetObserver;)V", "unregisterDataSetObserver(Landroid/database/DataSetObserver;)V",
    "notifyDataSetChanged()V", "notifyDataSetInvalidated()V"].map((s) => [s, baseAdapterMethods[s]])),
  ...stubs(1, "areAllItemsEnabled()Z"),
  ...noops("onGroupExpanded(I)V", "onGroupCollapsed(I)V"),
  "getCombinedGroupId(J)J": combinedGroupId,
  "getCombinedChildId(JJ)J": (g: bigint, c: bigint) => BigInt.asIntN(64, (1n << 63n) | combinedGroupId(g) | (BigInt.asUintN(64, c) & 0xffffffffn)),
  "isEmpty()Z": driven(function* (this: JBaseAdapter): Gen { return +((yield vcall(this, "getGroupCount", "()I")) === 0); }),
  "getChildType(II)I": () => 0, "getChildTypeCount()I": () => 1, "getGroupType(I)I": () => 0, "getGroupTypeCount()I": () => 1,
};
rt.register({ name: "android/widget/BaseExpandableListAdapter", ctor: class extends JBaseAdapter {},
  ifaces: ["android/widget/ExpandableListAdapter", "android/widget/HeterogeneousExpandableList"], methods: { ...baseExpandableMethods, ...noops("<init>()V") } });

// ── SimpleExpandableListAdapter: Maps bound into inflated rows by view id
class JSimpleExpandableListAdapter extends JBaseAdapter {
  jctx: unknown = null;
  groups: unknown = null; children: unknown = null;
  expandedLayout = 0; collapsedLayout = 0; childLayout = 0; lastChildLayout = 0;
  groupFrom: string[] = []; groupTo: Int32Array = new Int32Array(0);
  childFrom: string[] = []; childTo: Int32Array = new Int32Array(0);
}
type SE = JSimpleExpandableListAdapter;
const listGet = (list: unknown, i: number) => vcall(list, "get", "(I)Ljava/lang/Object;", i);
/** SimpleExpandableListAdapter.bindView: each `from` key's value into the TextView with that `to` id */
const bindRow = driven(function* bindRow(v: JView, data: unknown, from: string[], to: Int32Array): Gen {
  for (let i = 0; i < to.length; i++) {
    const tv = yield vcall(v, "findViewById", "(I)Landroid/view/View;", to[i]);
    if (tv) yield vcall(tv, "setText", "(Ljava/lang/CharSequence;)V", yield vcall(data, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", from[i]));
  }
});
/** the full constructor, which AOSP's shorter ones call with a layout repeated */
function simpleInit(this: SE, ctx: unknown, groups: unknown, expanded: number, collapsed: number, groupFrom: string[], groupTo: Int32Array,
  children: unknown, child: number, lastChild: number, childFrom: string[], childTo: Int32Array) {
  Object.assign(this, { jctx: ctx, groups, children, expandedLayout: expanded, collapsedLayout: collapsed, childLayout: child, lastChildLayout: lastChild,
    groupFrom: [...groupFrom], groupTo, childFrom: [...childFrom], childTo });
}
const G_ = "Landroid/content/Context;Ljava/util/List;", F_ = "[Ljava/lang/String;[ILjava/util/List;", C_ = "[Ljava/lang/String;[I)V";
rt.register({ name: "android/widget/SimpleExpandableListAdapter", ctor: JSimpleExpandableListAdapter, sup: "android/widget/BaseExpandableListAdapter", methods: {
  ...baseExpandableMethods,
  [`<init>(${G_}I${F_}I${C_}`]: function (this: SE, ctx: unknown, groups: unknown, g: number, gFrom: string[], gTo: Int32Array, children: unknown, c: number, cFrom: string[], cTo: Int32Array) {
    simpleInit.call(this, ctx, groups, g, g, gFrom, gTo, children, c, c, cFrom, cTo);
  },
  [`<init>(${G_}II${F_}I${C_}`]: function (this: SE, ctx: unknown, groups: unknown, e: number, g: number, gFrom: string[], gTo: Int32Array, children: unknown, c: number, cFrom: string[], cTo: Int32Array) {
    simpleInit.call(this, ctx, groups, e, g, gFrom, gTo, children, c, c, cFrom, cTo);
  },
  [`<init>(${G_}II${F_}II${C_}`]: simpleInit,
  "getGroupCount()I": function (this: SE) { return vcall(this.groups, "size", "()I"); },
  "getGroup(I)Ljava/lang/Object;": function (this: SE, g: number) { return listGet(this.groups, g); },
  "getGroupId(I)J": (g: number) => BigInt(g),
  "getChildrenCount(I)I": driven(function* (this: SE, g: number): Gen { return vcall(yield listGet(this.children, g), "size", "()I"); }),
  "getChild(II)Ljava/lang/Object;": driven(function* (this: SE, g: number, c: number): Gen { return listGet(yield listGet(this.children, g), c); }),
  "getChildId(II)J": (_g: number, c: number) => BigInt(c),
  "hasStableIds()Z": () => 1,
  "isChildSelectable(II)Z": () => 1,
  "getGroupView(IZLandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;": driven(function* (this: SE, g: number, open: number, convert: JView | null, parent: unknown): Gen {
    const v = convert ?? (yield inflateLayout(this.jctx, open ? this.expandedLayout : this.collapsedLayout, parent, false));
    yield bindRow(v, yield listGet(this.groups, g), this.groupFrom, this.groupTo);
    return v;
  }),
  "getChildView(IIZLandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;": driven(function* (this: SE, g: number, c: number, last: number, convert: JView | null, parent: unknown): Gen {
    const v = convert ?? (yield inflateLayout(this.jctx, last ? this.lastChildLayout : this.childLayout, parent, false));
    yield bindRow(v, yield listGet(yield listGet(this.children, g), c), this.childFrom, this.childTo);
    return v;
  }),
  "newGroupView(ZLandroid/view/ViewGroup;)Landroid/view/View;": function (this: SE, open: number, parent: unknown) { return inflateLayout(this.jctx, open ? this.expandedLayout : this.collapsedLayout, parent, false); },
  "newChildView(ZLandroid/view/ViewGroup;)Landroid/view/View;": function (this: SE, last: number, parent: unknown) { return inflateLayout(this.jctx, last ? this.lastChildLayout : this.childLayout, parent, false); },
} });
