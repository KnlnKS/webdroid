// android.preference.* — the legacy Preference framework: a res/xml preference resource, parsed
// through the existing AXML/ARSC machinery (same tag→class resolution idiom as inflate.ts's
// createViewByName), rendered generically as a ListView (listview.ts), and persisted through the
// existing SharedPreferences/PreferenceManager plumbing in app.ts. No per-app special-casing:
// any app's res/xml/*.xml preference screen renders through this same path.

import { rt, JObj, type NativeSpec, stubs, noops, fieldGetters, flagGetters, fieldSetters } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { vcall, newObj } from "../jvm/natives/jlang";
import { attr, TV, parseAXML, type XmlNode } from "./axml";
import { JAttrSet, normRV, resString, rvString, type Resources, type RV, JTheme, bagStrings } from "./res";
import { JView, JLinearLP, addUnattachedView } from "./view";
import { tfMedium } from "./graphics";
import { JLinearLayout } from "./layouts";
import { JTextView } from "./textview";
import { themeAccent } from "./widget";
import { G } from "./gravity";
import { JBaseAdapter, JListView, baseAdapterMethods } from "./listview";
import { reportUncaught } from "./os";
import { getPrefs } from "./sharedprefs";
import { JFragment, fragMethods } from "./fragment";
import { type JContext } from "./context";
import { device } from "../shell/config";
import { spannedString } from "./text";

// ── attribute resolution: mirrors res.ts's own value-resolution helpers (obtainStyled etc.),
// just driven off a raw AXML attribute instead of a styleable index. ──
function attrRV(node: XmlNode, name: string): RV | null {
  const a = attr(node, name);
  if (!a) return null;
  return a.type === TV.STRING ? { t: TV.STRING, d: 0, s: a.str ?? "" } : normRV({ t: a.type, d: a.data });
}
function attrText(res: Resources, node: XmlNode, name: string): string | null {
  const v = attrRV(node, name);
  return v ? rvString(res, res.resolveRefs(v)) : null;
}
function attrBool(res: Resources, node: XmlNode, name: string, dflt: boolean): boolean {
  const v = attrRV(node, name);
  if (!v) return dflt;
  if (v.t === TV.BOOLEAN) return !!v.d;
  const s = rvString(res, res.resolveRefs(v));
  return s ? s === "true" : dflt;
}
function attrStringArray(res: Resources, node: XmlNode, name: string): string[] {
  const a = attr(node, name);
  return a && a.type === TV.REFERENCE ? bagStrings(res, a.data) : [];
}
function ctxString(jctx: any, id: number): string {
  const res: Resources | null = jctx?.$host?.res ?? null;
  return res ? resString(res, id) : "";
}
function ctxStringArray(jctx: any, id: number): string[] {
  const res: Resources | null = jctx?.$host?.res ?? null;
  return res ? bagStrings(res, id) : [];
}

// ── persistence: the same default SharedPreferences file getDefaultSharedPreferences() uses. ──
function prefsOf(jctx: any) {
  const host = jctx?.$host;
  return getPrefs(host.pkg, host.pkg + "_preferences");
}
async function putBoolean(jctx: any, key: string, val: boolean) {
  const sp = prefsOf(jctx);
  const editor = await vcall(sp, "edit", "()Landroid/content/SharedPreferences$Editor;");
  await vcall(editor, "putBoolean", "(Ljava/lang/String;Z)Landroid/content/SharedPreferences$Editor;", key, val ? 1 : 0);
  await vcall(editor, "apply", "()V");
}
async function putString(jctx: any, key: string, val: string) {
  const sp = prefsOf(jctx);
  const editor = await vcall(sp, "edit", "()Landroid/content/SharedPreferences$Editor;");
  await vcall(editor, "putString", "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/SharedPreferences$Editor;", key, val);
  await vcall(editor, "apply", "()V");
}

// ── PreferenceManager: one per fragment; the instance methods just delegate to the same default
// SharedPreferences file the static getDefaultSharedPreferences() already used. ──
class JPreferenceManager extends JObj {
  jctx: any = null;
}
rt.register({
  name: "android/preference/PreferenceManager", ctor: JPreferenceManager,
  methods: {
    "static getDefaultSharedPreferences(Landroid/content/Context;)Landroid/content/SharedPreferences;": (c: any) => prefsOf(c),
    "static getDefaultSharedPreferencesName(Landroid/content/Context;)Ljava/lang/String;": (c: any) => c.$host.pkg + "_preferences",
    "static setDefaultValues(Landroid/content/Context;IZ)V": () => {},
    "getSharedPreferences()Landroid/content/SharedPreferences;": function (this: JPreferenceManager) { return prefsOf(this.jctx); },
    "getContext()Landroid/content/Context;": function (this: JPreferenceManager) { return this.jctx; },
  },
});

// ── Preference (base) ──
class JPreference extends JObj {
  jctx: any = null;
  owner: JPreferenceFragment | null = null;
  keyStr: string | null = null;
  titleStr = "";
  summaryStr = "";
  enabled = true;
  clickL: unknown = null;
  changeL: unknown = null;
}
function notifyChanged(pref: JPreference) {
  const adapter = pref.owner?.adapter;
  if (adapter) void vcall(adapter, "notifyDataSetChanged", "()V").catch(reportUncaught);
}
function ensurePM(frag: JPreferenceFragment): JPreferenceManager {
  if (!frag.pm) {
    const pm = rt.make("android/preference/PreferenceManager") as JPreferenceManager;
    pm.jctx = frag.act;
    frag.pm = pm;
  }
  return frag.pm;
}
function initPrefCommon(pref: JPreference, jctx: any, set: JAttrSet | null) {
  pref.jctx = jctx;
  const res: Resources | null = jctx?.$host?.res ?? null;
  const node = set?.node ?? null;
  if (res && node) {
    pref.keyStr = attrText(res, node, "key");
    pref.titleStr = attrText(res, node, "title") ?? "";
    pref.summaryStr = attrText(res, node, "summary") ?? "";
    pref.enabled = attrBool(res, node, "enabled", true);
  }
}
const preferenceMethods: NonNullable<NativeSpec["methods"]> = {
  "<init>(Landroid/content/Context;)V": function (this: JPreference, c: unknown) { initPrefCommon(this, c, null); },
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function (this: JPreference, c: unknown, set: JAttrSet | null) {
    initPrefCommon(this, c, set);
  },
  "setTitle(Ljava/lang/CharSequence;)V": function (this: JPreference, t: unknown) { this.titleStr = spannedString(t); notifyChanged(this); },
  "setTitle(I)V": function (this: JPreference, id: number) { this.titleStr = ctxString(this.jctx, id); notifyChanged(this); },
  "setSummary(Ljava/lang/CharSequence;)V": function (this: JPreference, t: unknown) { this.summaryStr = spannedString(t); notifyChanged(this); },
  "setSummary(I)V": function (this: JPreference, id: number) { this.summaryStr = ctxString(this.jctx, id); notifyChanged(this); },
  "setEnabled(Z)V": function (this: JPreference, e: number) { this.enabled = !!e; notifyChanged(this); },
  "getPreferenceManager()Landroid/preference/PreferenceManager;": function (this: JPreference) {
    return this.owner ? ensurePM(this.owner) : null;
  },
  "getSharedPreferences()Landroid/content/SharedPreferences;": function (this: JPreference) { return prefsOf(this.jctx); },
  ...fieldGetters({ "getKey()Ljava/lang/String;": "keyStr", "getTitle()Ljava/lang/CharSequence;": "titleStr",
    "getSummary()Ljava/lang/CharSequence;": "summaryStr", "getContext()Landroid/content/Context;": "jctx",
    "getOnPreferenceClickListener()Landroid/preference/Preference$OnPreferenceClickListener;": "clickL",
    "getOnPreferenceChangeListener()Landroid/preference/Preference$OnPreferenceChangeListener;": "changeL",
    "toString()Ljava/lang/String;": "titleStr" }),
  ...fieldSetters({ "setKey(Ljava/lang/String;)V": "keyStr",
    "setOnPreferenceClickListener(Landroid/preference/Preference$OnPreferenceClickListener;)V": "clickL",
    "setOnPreferenceChangeListener(Landroid/preference/Preference$OnPreferenceChangeListener;)V": "changeL" }),
  ...flagGetters({ "isEnabled()Z": "enabled" }),
  ...stubs(1, "isSelectable()Z", "isPersistent()Z"),
  ...noops("setSelectable(Z)V", "setPersistent(Z)V", "setOrder(I)V", "onClick()V"),
  ...stubs(0, "getOrder()I"),
  "callChangeListener(Ljava/lang/Object;)Z": async function (this: JPreference, v: unknown) {
    if (!this.changeL) return 1;
    return (await vcall(this.changeL, "onPreferenceChange", "(Landroid/preference/Preference;Ljava/lang/Object;)Z", this, v)) ? 1 : 0;
  },
};
/** Preference.performClick(): the subclass's own onClick() first (CheckBoxPreference toggles,
 *  ListPreference opens its dialog), then the app's OnPreferenceClickListener if it set one. */
async function preferenceRowClick(pref: JPreference) {
  if (!pref.enabled) return;
  await vcall(pref, "onClick", "()V");
  if (pref.clickL) await vcall(pref.clickL, "onPreferenceClick", "(Landroid/preference/Preference;)Z", pref);
}

// ── PreferenceGroup / PreferenceCategory / PreferenceScreen ──
class JPreferenceGroup extends JPreference {
  children: JPreference[] = [];
}
function bindTree(pref: JPreference, frag: JPreferenceFragment) {
  pref.owner = frag;
  if (pref instanceof JPreferenceGroup) for (const c of pref.children) bindTree(c, frag);
}
function findPrefByKey(group: JPreferenceGroup, key: string): JPreference | null {
  for (const c of group.children) {
    if (c.keyStr === key) return c;
    if (c instanceof JPreferenceGroup) { const f = findPrefByKey(c, key); if (f) return f; }
  }
  return null;
}
const preferenceGroupMethods: NonNullable<NativeSpec["methods"]> = {
  ...preferenceMethods,
  "getPreferenceCount()I": function (this: JPreferenceGroup) { return this.children.length; },
  "getPreference(I)Landroid/preference/Preference;": function (this: JPreferenceGroup, i: number) { return this.children[i] ?? null; },
  "addPreference(Landroid/preference/Preference;)Z": function (this: JPreferenceGroup, p: JPreference) {
    this.children.push(p);
    if (this.owner) bindTree(p, this.owner);
    notifyChanged(this);
    return 1;
  },
  "removePreference(Landroid/preference/Preference;)Z": function (this: JPreferenceGroup, p: JPreference) {
    const i = this.children.indexOf(p);
    if (i < 0) return 0;
    this.children.splice(i, 1);
    notifyChanged(this);
    return 1;
  },
  "removeAll()V": function (this: JPreferenceGroup) { this.children.length = 0; notifyChanged(this); },
  "findPreference(Ljava/lang/CharSequence;)Landroid/preference/Preference;":
    function (this: JPreferenceGroup, key: unknown) { return findPrefByKey(this, String(key)); },
};
class JPreferenceCategory extends JPreferenceGroup {}
class JPreferenceScreen extends JPreferenceGroup {}

class JCheckBoxPreference extends JPreference {
  checked = false;
}
async function setCheckBoxValue(pref: JCheckBoxPreference, val: boolean, userInitiated: boolean) {
  if (userInitiated && !(await vcall(pref, "callChangeListener", "(Ljava/lang/Object;)Z", val))) return;
  pref.checked = val;
  if (pref.keyStr) await putBoolean(pref.jctx, pref.keyStr, val);
  notifyChanged(pref);
}
const checkBoxMethods: NonNullable<NativeSpec["methods"]> = {
  ...preferenceMethods,
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function (this: JCheckBoxPreference, c: unknown, set: JAttrSet | null) {
    initPrefCommon(this, c, set);
    const res: Resources | null = (c as JContext | null)?.$host?.res ?? null;
    const node = set?.node ?? null;
    let dflt = false;
    if (res && node) {
      const v = attrRV(node, "defaultValue");
      if (v) dflt = v.t === TV.BOOLEAN ? !!v.d : rvString(res, res.resolveRefs(v)) === "true";
    }
    const sp = prefsOf(c);
    this.checked = this.keyStr && sp.map.has(this.keyStr) ? !!sp.map.get(this.keyStr) : dflt;
  },
  "isChecked()Z": function (this: JCheckBoxPreference) { return this.checked ? 1 : 0; },
  "setChecked(Z)V": function (this: JCheckBoxPreference, v: number) { return setCheckBoxValue(this, !!v, false); },
  "onClick()V": function (this: JCheckBoxPreference) { return setCheckBoxValue(this, !this.checked, true); },
};

class JListPreference extends JPreference {
  entries: string[] = [];
  entryValues: string[] = [];
  value: string | null = null;
  dialogTitleStr = "";
}
async function setListValue(pref: JListPreference, val: string, userInitiated: boolean) {
  if (userInitiated && !(await vcall(pref, "callChangeListener", "(Ljava/lang/Object;)Z", val))) return;
  pref.value = val;
  if (pref.keyStr) await putString(pref.jctx, pref.keyStr, val);
  notifyChanged(pref);
}
async function showListPreferenceDialog(pref: JListPreference) {
  // reuse the existing AlertDialog/Builder machinery (dialog.ts) rather than a second popup path
  const info = rt.link("android/app/AlertDialog$Builder");
  const b: any = new info.ctor();
  await vcall(b, "<init>", "(Landroid/content/Context;)V", pref.jctx);
  await vcall(b, "setTitle", "(Ljava/lang/CharSequence;)Landroid/app/AlertDialog$Builder;", pref.dialogTitleStr || pref.titleStr);
  await vcall(b, "setItems", "([Ljava/lang/CharSequence;Landroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;",
    pref.entries, {
      [mangleMethod("onClick", "(Landroid/content/DialogInterface;I)V")]: async (_d: unknown, idx: number) => {
        await setListValue(pref, pref.entryValues[idx] ?? String(idx), true);
      },
    });
  await vcall(b, "show", "()Landroid/app/AlertDialog;");
}
const listPrefMethods: NonNullable<NativeSpec["methods"]> = {
  ...preferenceMethods,
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function (this: JListPreference, c: unknown, set: JAttrSet | null) {
    initPrefCommon(this, c, set);
    const res: Resources | null = (c as JContext | null)?.$host?.res ?? null;
    const node = set?.node ?? null;
    let dflt: string | null = null;
    if (res && node) {
      this.entries = attrStringArray(res, node, "entries");
      this.entryValues = attrStringArray(res, node, "entryValues");
      this.dialogTitleStr = attrText(res, node, "dialogTitle") ?? this.titleStr;
      const v = attrRV(node, "defaultValue");
      dflt = v ? rvString(res, res.resolveRefs(v)) : null;
    }
    const sp = prefsOf(c);
    this.value = this.keyStr && sp.map.has(this.keyStr) ? String(sp.map.get(this.keyStr)) : dflt;
  },
  "setEntries([Ljava/lang/CharSequence;)V": function (this: JListPreference, arr: unknown[]) { this.entries = (arr ?? []).map(String); },
  "setEntries(I)V": function (this: JListPreference, id: number) { this.entries = ctxStringArray(this.jctx, id); },
  "getEntries()[Ljava/lang/CharSequence;": function (this: JListPreference) {
    const a: any = [...this.entries]; a.$t = "Ljava/lang/CharSequence;"; return a;
  },
  "setEntryValues([Ljava/lang/CharSequence;)V": function (this: JListPreference, arr: unknown[]) { this.entryValues = (arr ?? []).map(String); },
  "setEntryValues(I)V": function (this: JListPreference, id: number) { this.entryValues = ctxStringArray(this.jctx, id); },
  "getEntryValues()[Ljava/lang/CharSequence;": function (this: JListPreference) {
    const a: any = [...this.entryValues]; a.$t = "Ljava/lang/CharSequence;"; return a;
  },
  "getValue()Ljava/lang/String;": function (this: JListPreference) { return this.value; },
  "setValue(Ljava/lang/String;)V": function (this: JListPreference, v: string) { return setListValue(this, v, false); },
  "getEntry()Ljava/lang/CharSequence;": function (this: JListPreference) {
    const i = this.entryValues.indexOf(this.value ?? "");
    return i >= 0 ? this.entries[i] ?? null : null;
  },
  "findIndexOfValue(Ljava/lang/String;)I": function (this: JListPreference, v: string) { return this.entryValues.indexOf(v); },
  "setValueIndex(I)V": function (this: JListPreference, i: number) { return setListValue(this, this.entryValues[i] ?? "", false); },
  "getDialogTitle()Ljava/lang/CharSequence;": function (this: JListPreference) { return this.dialogTitleStr; },
  "setDialogTitle(Ljava/lang/CharSequence;)V": function (this: JListPreference, t: unknown) { this.dialogTitleStr = t == null ? "" : String(t); },
  "setDialogTitle(I)V": function (this: JListPreference, id: number) { this.dialogTitleStr = ctxString(this.jctx, id); },
  "onClick()V": function (this: JListPreference) { return showListPreferenceDialog(this); },
};

rt.register({ name: "android/preference/Preference", ctor: JPreference, methods: preferenceMethods });
rt.register({ name: "android/preference/PreferenceGroup", ctor: JPreferenceGroup, sup: "android/preference/Preference", methods: preferenceGroupMethods });
rt.register({ name: "android/preference/PreferenceCategory", ctor: JPreferenceCategory, sup: "android/preference/PreferenceGroup", methods: preferenceGroupMethods });
rt.register({ name: "android/preference/PreferenceScreen", ctor: JPreferenceScreen, sup: "android/preference/PreferenceGroup", methods: preferenceGroupMethods });
rt.register({ name: "android/preference/CheckBoxPreference", ctor: JCheckBoxPreference, sup: "android/preference/Preference", methods: checkBoxMethods });
rt.register({ name: "android/preference/ListPreference", ctor: JListPreference, sup: "android/preference/Preference", methods: listPrefMethods });
// pure callback interfaces — apps implement these; left unregistered they'd auto-stub in
// Runtime.link and poison downstream linking (see "VM and framework lessons" in the implementation history),
// same fix as dialog.ts:256.
for (const n of ["OnPreferenceClickListener", "OnPreferenceChangeListener"]) {
  rt.register({ name: "android/preference/Preference$" + n, ctor: class extends JObj {} });
}

// ── row rendering: flatten the tree into (category header | preference) rows, then hand them to
// a plain ListView + BaseAdapter — reuses listview.ts's scroll/click/recycle machinery rather
// than reimplementing list rendering. ──
interface Row { header: boolean; pref: JPreference; }
function flattenPrefs(group: JPreferenceGroup): Row[] {
  const rows: Row[] = [];
  const walk = (g: JPreferenceGroup) => {
    for (const c of g.children) {
      if (c instanceof JPreferenceCategory) { rows.push({ header: true, pref: c }); walk(c); }
      else if (c instanceof JPreferenceGroup) walk(c); // nested PreferenceScreen: flatten, no header
      else rows.push({ header: false, pref: c });
    }
  };
  walk(group);
  return rows;
}
function lpFill(): JLinearLP { const lp = new JLinearLP(); lp.width = -1; lp.height = -2; return lp; }
function lpWeight1(): JLinearLP { const lp = new JLinearLP(); lp.width = 0; lp.height = -2; lp.weight = 1; return lp; }
function mkText(jctx: any, theme: JTheme | null, jres: Resources | null): JTextView {
  const t = new JTextView();
  t.ctx = jctx; t.jres = jres; t.theme = theme;
  return t;
}
async function buildRowView(row: Row, jctx: any): Promise<JView> {
  const jres: Resources | null = jctx?.$host?.res ?? null;
  const theme: JTheme | null = jctx?.$host?.theme ?? null;
  if (row.header) {
    const t = mkText(jctx, theme, jres);
    t.text = row.pref.titleStr;
    t.paintT.textSize = device.dp(13);
    t.paintT.tf = tfMedium;
    t.colors.defColor = themeAccent(t);
    t.padL = t.padR = t.padT = device.dp(16); t.padB = device.dp(6);
    t.lp = lpFill();
    return t;
  }
  const pref = row.pref;
  const rowL = new JLinearLayout();
  rowL.orientation = 0;
  rowL.gravity = 16 | G.START;
  rowL.ctx = jctx; rowL.jres = jres; rowL.theme = theme;
  rowL.padL = rowL.padR = device.dp(16); rowL.padT = rowL.padB = device.dp(14);
  rowL.lp = lpFill();
  rowL.clickable = pref.enabled;
  if (pref.enabled) {
    rowL.clickL = { [mangleMethod("onClick", "(Landroid/view/View;)V")]: () => preferenceRowClick(pref) };
  }

  const col = new JLinearLayout();
  col.orientation = 1;
  col.ctx = jctx; col.jres = jres; col.theme = theme;
  col.lp = lpWeight1();

  const title = mkText(jctx, theme, jres);
  title.text = pref.titleStr;
  title.paintT.textSize = device.dp(16);
  title.colors.defColor = pref.enabled ? -13421773 : -6710887;
  title.lp = lpFill();
  addUnattachedView(col, title);

  if (pref.summaryStr) {
    const sum = mkText(jctx, theme, jres);
    sum.text = pref.summaryStr;
    sum.paintT.textSize = device.dp(13);
    sum.colors.defColor = pref.enabled ? -8355712 : -6710887;
    sum.padT = device.dp(2);
    sum.lp = lpFill();
    addUnattachedView(col, sum);
  }
  addUnattachedView(rowL, col);

  if (pref instanceof JCheckBoxPreference) {
    const cb: any = rt.make("android/widget/CheckBox");
    cb.ctx = jctx; cb.jres = jres; cb.theme = theme;
    cb.checked = pref.checked;
    cb.enabled = pref.enabled;
    cb.clickable = false; // the whole row toggles it; the widget itself is just an indicator
    const lp = new JLinearLP(); lp.width = -2; lp.height = -2;
    cb.lp = lp;
    addUnattachedView(rowL, cb);
  }
  return rowL;
}

// ── the fragment's adapter: re-flattens frag.root on every notify. Settings screens are small
// and JListView already materializes every row non-recycling, so this matches that style. ──
class JPreferenceAdapter extends JBaseAdapter {
  frag: JPreferenceFragment | null = null;
  rows(): Row[] { return this.frag?.root ? flattenPrefs(this.frag.root) : []; }
}
rt.register({
  name: "webdroid/PreferenceAdapter", ctor: JPreferenceAdapter, sup: "android/widget/BaseAdapter",
  methods: {
    ...baseAdapterMethods,
    "getCount()I": function (this: JPreferenceAdapter) { return this.rows().length; },
    "getItem(I)Ljava/lang/Object;": function (this: JPreferenceAdapter, i: number) { return this.rows()[i]?.pref ?? null; },
    "getItemId(I)J": (i: number) => BigInt(i),
    "isEnabled(I)Z": function (this: JPreferenceAdapter, i: number) {
      const r = this.rows()[i];
      return r && !r.header && r.pref.enabled ? 1 : 0;
    },
    "getView(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;": function (this: JPreferenceAdapter, i: number) {
      const r = this.rows()[i];
      return r ? buildRowView(r, this.frag!.act) : null;
    },
  },
});

// ── PreferenceFragment: an android/app/Fragment (see app.ts's fragMethods/JFragment — the same
// lifecycle wiring every other framework Fragment uses; FragmentTransaction really attaches its
// onCreateView() result now, see app.ts's runFragmentAdd). ──
class JPreferenceFragment extends JFragment {
  root: JPreferenceScreen | null = null;
  pm: JPreferenceManager | null = null;
  adapter: JPreferenceAdapter | null = null;
}
async function createPreferenceByTag(name: string, jctx: any, set: JAttrSet): Promise<JPreference> {
  // AOSP resolves an undotted preference tag against android.preference.*, same idiom as
  // inflate.ts's createViewByName resolving undotted view tags against android.widget.* etc.
  const clsName = name.includes(".") ? name.replace(/\./g, "/") : "android/preference/" + name;
  return newObj(clsName, "(Landroid/content/Context;Landroid/util/AttributeSet;)V", jctx, set);
}
async function buildPreferenceNode(node: XmlNode, jctx: any, frag: JPreferenceFragment): Promise<JPreference> {
  const set = new JAttrSet();
  set.node = node;
  set.res = jctx.$host.res;
  set.theme = jctx.$host.theme;
  const pref = await createPreferenceByTag(node.name, jctx, set);
  pref.owner = frag;
  if (pref instanceof JPreferenceGroup) {
    for (const child of node.children) pref.children.push(await buildPreferenceNode(child, jctx, frag));
  }
  return pref;
}
const preferenceFragmentMethods: NonNullable<NativeSpec["methods"]> = {
  ...fragMethods,
  "getPreferenceManager()Landroid/preference/PreferenceManager;": function (this: JPreferenceFragment) { return ensurePM(this); },
  "getPreferenceScreen()Landroid/preference/PreferenceScreen;": function (this: JPreferenceFragment) { return this.root; },
  "setPreferenceScreen(Landroid/preference/PreferenceScreen;)V": function (this: JPreferenceFragment, s: JPreferenceScreen | null) {
    this.root = s;
    if (s) bindTree(s, this);
    if (this.adapter) void vcall(this.adapter, "notifyDataSetChanged", "()V").catch(reportUncaught);
  },
  "addPreferencesFromResource(I)V": async function (this: JPreferenceFragment, resId: number) {
    const jctx: any = this.act;
    const host = jctx?.$host;
    if (!host) { rt.noteMissing("preference xml (no activity)"); return; }
    const f = host.res.fileOf(resId);
    if (!f) { rt.noteMissing("preference xml 0x" + resId.toString(16)); return; }
    const screen = await buildPreferenceNode(parseAXML(f.bytes), jctx, this) as JPreferenceScreen;
    if (this.root) { for (const c of screen.children) { this.root.children.push(c); bindTree(c, this); } }
    else this.root = screen;
  },
  "findPreference(Ljava/lang/CharSequence;)Landroid/preference/Preference;": function (this: JPreferenceFragment, key: unknown) {
    return this.root ? findPrefByKey(this.root, String(key)) : null;
  },
  "onCreateView(Landroid/view/LayoutInflater;Landroid/view/ViewGroup;Landroid/os/Bundle;)Landroid/view/View;":
    async function (this: JPreferenceFragment) {
      const jctx: any = this.act;
      const list = new JListView();
      list.ctx = jctx; list.jres = jctx?.$host?.res ?? null; list.theme = jctx?.$host?.theme ?? null;
      const adapter = new JPreferenceAdapter();
      adapter.frag = this;
      this.adapter = adapter;
      await vcall(list, "setAdapter", "(Landroid/widget/ListAdapter;)V", adapter);
      return list;
    },
};
rt.register({
  name: "android/preference/PreferenceFragment", ctor: JPreferenceFragment, sup: "android/app/Fragment",
  methods: preferenceFragmentMethods,
});
