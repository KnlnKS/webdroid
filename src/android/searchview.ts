import { JLinearLayout, linearMethods } from "./layouts";
import { JEditText, textViewMethods, textViewCtors } from "./textview";
import { type JView, findById, initViewFromCtx, requestLayout, setViewBackground } from "./view";
import { AID, type JAttrSet, obtainStyled, rvInt, rvString } from "./res";
import { inflateLayout } from "./inflate";
import { JImageView } from "./imageview";
import { loadDrawableRV } from "./drawable";
import { rt, JObj, noops, driven, type Gen } from "../jvm/runtime";
import { vcall, after, curThread, callOn } from "../jvm/natives/jlang";
import { csText } from "../jvm/natives/jchars";

// ── SearchView. AOSP inflates layout/search_view.xml and toggles the parts of it that a
// collapsed or expanded search shows, so this does too rather than describing the row again.
class JSearchView extends JLinearLayout {
  queryText = "";
  queryL: unknown = null;
  hintStr = "";
  iconified = true;
  edit: JEditText | null = null;
  closeBtn: JView | null = null;
}
// AOSP reads all of this out of ?attr/searchViewStyle -- the layout to inflate and every icon
// and background in it -- so none of it is described here. Which parts of that layout a
// collapsed or an expanded search shows is the only decision left.
const SEARCH_ICONS: [string, string][] = [
  ["search_button", "searchIcon"], ["search_mag_icon", "searchIcon"],
  ["search_close_btn", "closeIcon"], ["search_go_btn", "goIcon"], ["search_voice_btn", "voiceIcon"],
];
const SEARCH_BACKGROUNDS: [string, string][] = [
  ["search_plate", "queryBackground"], ["submit_area", "submitBackground"],
];
/** shown when expanded; the submit half of the row waits for a query, as it does on a device */
const SEARCH_EXPANDED = ["search_edit_frame", "search_plate", "search_mag_icon", "search_src_text"];
const SEARCH_ON_QUERY = ["search_badge", "search_close_btn", "submit_area", "search_go_btn", "search_voice_btn"];

async function buildSearchView(sv: JSearchView, set: JAttrSet | null) {
  // the drawables load on the building thread, whichever thread the awaits resume on
  const thread = curThread;
  const res = sv.jres;
  if (!res) return;
  const names = ["layout", "iconifiedByDefault", "queryHint", "searchIcon", "closeIcon", "goIcon",
    "voiceIcon", "queryBackground", "submitBackground"];
  const ta = obtainStyled(res, sv.theme, set, names.map(AID), AID("searchViewStyle"), 0);
  const val = (n: string) => ta.vals[names.indexOf(n)];
  if (val("iconifiedByDefault")) sv.iconified = !!rvInt(res, val("iconifiedByDefault"), 1);
  if (val("queryHint")) sv.hintStr = rvString(res, val("queryHint")) || sv.hintStr;

  const layout = val("layout");
  if (!layout?.d) return;
  await inflateLayout(sv.ctx, layout.d, sv, true);
  const byName = (n: string) => { const id = res.idFor("id", n, "android"); return id ? findById(sv, id) : null; };

  for (const [part, attr] of SEARCH_ICONS) {
    const v = byName(part), d = val(attr);
    if (v instanceof JImageView && d) await callOn(thread, () => after(loadDrawableRV(res, d, sv.theme), (dr) => v.setDrawable(dr)));
  }
  for (const [part, attr] of SEARCH_BACKGROUNDS) {
    const v = byName(part), d = val(attr);
    if (v && d) await callOn(thread, () => after(loadDrawableRV(res, d, sv.theme), (dr) => setViewBackground(v, dr)));
  }
  for (const part of [...SEARCH_EXPANDED, "search_button"]) {
    const v = byName(part);
    if (v) v.visibility = (part === "search_button") === sv.iconified ? 0 : 8;
  }
  for (const part of SEARCH_ON_QUERY) { const v = byName(part); if (v) v.visibility = 8; }
  sv.closeBtn = byName("search_close_btn");
  const src = byName("search_src_text");
  if (src instanceof JEditText) { sv.edit = src; if (sv.hintStr) src.hint = sv.hintStr; }
}
const setIconified = function (this: JSearchView, v: number) { this.iconified = !!v; };
rt.register({
  name: "android/widget/SearchView", ctor: JSearchView, sup: "android/widget/LinearLayout",
  ifaces: ["android/widget/FilterQueryProvider"],
  methods: {
    ...linearMethods,
    "<init>(Landroid/content/Context;)V": driven(function* (this: JSearchView, c: unknown): Gen {
      yield initViewFromCtx(this, c, null);
      this.orientation = 0;
      yield buildSearchView(this, null);
    }),
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": driven(function* (this: JSearchView, c: unknown, set: JAttrSet | null): Gen {
      yield initViewFromCtx(this, c, set);
      this.orientation = 0;
      yield buildSearchView(this, set);
    }),
    "setOnQueryTextListener(Landroid/widget/SearchView$OnQueryTextListener;)V": function (this: JSearchView, l: unknown) { this.queryL = l; },
    "setQueryHint(Ljava/lang/CharSequence;)V": function (this: JSearchView, h: unknown) {
      return after(csText(h), (hint) => {
        this.hintStr = hint;
        if (this.edit) this.edit.hint = hint;
      });
    },
    "setIconifiedByDefault(Z)V": setIconified,
    "setIconified(Z)V": setIconified,
    "isIconified()Z": function (this: JSearchView) { return this.iconified ? 1 : 0; },
    "setQuery(Ljava/lang/CharSequence;Z)V": driven(function* (this: JSearchView, q: unknown, submit: number): Gen {
      this.queryText = yield csText(q);
      if (this.edit) this.edit.text = this.queryText;
      if (this.closeBtn) { this.closeBtn.visibility = this.queryText ? 0 : 8; requestLayout(this.closeBtn); }
      if (this.queryL) {
        yield vcall(this.queryL, "onQueryTextChange", "(Ljava/lang/String;)Z", this.queryText);
        if (submit) yield vcall(this.queryL, "onQueryTextSubmit", "(Ljava/lang/String;)Z", this.queryText);
      }
    }),
    "getQuery()Ljava/lang/CharSequence;": function (this: JSearchView) { return this.queryText; },
    ...noops("setMaxWidth(I)V", "setSubmitButtonEnabled(Z)V", "clearFocus()V", "onActionViewExpanded()V",
      "onActionViewCollapsed()V", "setOnCloseListener(Landroid/widget/SearchView$OnCloseListener;)V",
      "setSearchableInfo(Landroid/app/SearchableInfo;)V"),
  },
});
for (const name of ["android/widget/MultiAutoCompleteTextView",
  "android/widget/SearchView$SearchAutoComplete"]) {
  rt.register({
    name, ctor: class extends JEditText {}, sup: "android/widget/EditText",
    methods: {
      ...textViewMethods,
      ...textViewCtors<JEditText>("autoCompleteTextViewStyle"),
      ...noops("setThreshold(I)V", "setAdapter(Landroid/widget/ListAdapter;)V", "dismissDropDown()V",
        "setDropDownAnchor(I)V"),
      ...(name === "android/widget/SearchView$SearchAutoComplete" ? noops("setImeVisibility(Z)V") : {}),
    },
  });
}
rt.markers("android/widget/SearchView$OnQueryTextListener", "android/widget/FilterQueryProvider",
  "android/widget/Filterable");
rt.register({ name: "android/widget/Filter", ctor: class extends JObj {},
  methods: { "<init>()V": function () {}, "filter(Ljava/lang/CharSequence;)V": () => {},
    "filter(Ljava/lang/CharSequence;Landroid/widget/Filter$FilterListener;)V": () => {} } });
