// system_server's ShortcutService, under AOSP's ShortcutManager: ShortcutInfo and its Builder run
// from bytecode. A package's dynamic shortcuts, validated, ranked and capped per activity as
// ShortcutService does, outlive its processes. There is no launcher here: nothing can be pinned,
// and none is persisted past a reload.
import { awaited, rt, JObj, noops, driven, type Gen } from "../jvm/runtime.ts";
import { after, vcall } from "../jvm/natives/jentry.ts";
import { toJsArray } from "../jvm/natives/jcoll.ts";
import { device } from "../shell/config.ts";
import { wallMillis } from "../guest-clock.ts";
import { checkCallingPackage, hostService, parceledList } from "./binder.ts";
import { mkComponentName } from "./intent.ts";
import { launcherActivity } from "./pm.ts";
import type { PackageState } from "../shell/packagedata.ts";

const MAX_PER_ACTIVITY = 15, MAX_UPDATES_PER_INTERVAL = 10;
const FLAG_DYNAMIC = 1, MATCH_DYNAMIC = 2, CLONE_REMOVE_FOR_CREATOR = 9;
const SI = "Landroid/content/pm/ShortcutInfo;", CN = "Landroid/content/ComponentName;";
/** each package's dynamic shortcuts by id, in publishing order */
const packages = new Map<string, Map<string, JObj>>();
/** a data clear's cleanUpPackageLocked */
export const shortcutData: PackageState = { clear(pkg) { packages.delete(pkg); } };
/** ShortcutService.verifyCaller, as each call starts */
const verifyCaller = (pkg: string): void => checkCallingPackage(pkg, "Calling package name mismatch");
const dynamicOf = (pkg: string) => {
  let shortcuts = packages.get(pkg);
  if (!shortcuts) packages.set(pkg, shortcuts = new Map());
  return shortcuts;
};
const idOf = (si: JObj): Promise<string> => vcall(si, "getId", "()Ljava/lang/String;");
function mainActivity(pkg: string): JObj | Promise<JObj> {
  const launcher = launcherActivity(pkg);
  if (!launcher) throw rt.mkThrowable("java/lang/IllegalStateException", "Launcher activity not found for package " + pkg);
  return mkComponentName(pkg, launcher.name);
}
/** ShortcutService.fixUpIncomingShortcutInfo: the publisher's own, complete, on an activity, as a copy it no longer holds */
function* incoming(pkg: string, si: JObj | null, forUpdate = false): Gen<JObj> {
  if (!si) throw rt.mkThrowable("java/lang/NullPointerException", "Null shortcut detected");
  if ((yield vcall(si, "getPackage", "()Ljava/lang/String;")) !== pkg) throw rt.mkThrowable("java/lang/SecurityException", "Shortcut package name mismatch");
  const copy: JObj = yield vcall(si, "clone", `(I)${SI}`, 0);
  if (!forUpdate) {
    if (!(yield vcall(copy, "getActivity", `()${CN}`))) yield vcall(copy, "setActivity", `(${CN})V`, yield* awaited(mainActivity(pkg)));
    yield vcall(copy, "enforceMandatoryFields", "(Z)V", 0);
  }
  yield vcall(copy, "setTimestamp", "(J)V", BigInt(Math.floor(wallMillis())));
  return copy;
}
function* incomingList(pkg: string, slice: JObj): Gen<JObj[]> {
  const out: JObj[] = [];
  for (const si of (yield* awaited(toJsArray(yield vcall(slice, "getList", "()Ljava/util/List;")))) as JObj[]) out.push(yield* incoming(pkg, si));
  return out;
}
/** a package's shortcuts after a change: at most MAX_PER_ACTIVITY on an activity, each dynamic,
 *  ranked 0..n-1 per activity by requested rank then publishing order */
function* commit(pkg: string, shortcuts: JObj[]): Gen<void> {
  const byActivity = new Map<string, { si: JObj; rank: number; order: number }[]>();
  for (const [order, si] of shortcuts.entries()) {
    const activity = String(yield vcall(yield vcall(si, "getActivity", `()${CN}`), "flattenToString", "()Ljava/lang/String;"));
    let group = byActivity.get(activity);
    if (!group) byActivity.set(activity, group = []);
    group.push({ si, rank: yield vcall(si, "getRank", "()I"), order });
  }
  for (const group of byActivity.values()) {
    if (group.length > MAX_PER_ACTIVITY) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Max number of dynamic shortcuts exceeded");
    group.sort((a, b) => a.rank - b.rank || a.order - b.order);
    for (const [rank, { si }] of group.entries()) {
      yield vcall(si, "setRank", "(I)V", rank);
      yield vcall(si, "addFlags", "(I)V", FLAG_DYNAMIC);
    }
  }
  const next = new Map<string, JObj>();
  for (const si of shortcuts) next.set(yield* awaited(idOf(si)), si);
  packages.set(pkg, next);
}
const remove = (pkg: string, ids: JObj | null) => {
  verifyCaller(pkg);
  return after(toJsArray(ids), (list) => { const shortcuts = dynamicOf(pkg); for (const id of list as string[]) shortcuts.delete(id); });
};
const complete = (future: JObj, value: unknown) => vcall(future, "complete", "(Ljava/lang/Object;)Z", value);

const SLICE = "Landroid/content/pm/ParceledListSlice;", LIST = "Ljava/util/List;", S = "Ljava/lang/String;", FUTURE = "Lcom/android/internal/infra/AndroidFuture;";
hostService("shortcut", "webdroid/ShortcutService", "android/content/pm/IShortcutService$Stub", {
  [`setDynamicShortcuts(${S}${SLICE}I)Z`]: driven(function* (pkg: string, slice: JObj) { verifyCaller(pkg); yield* commit(pkg, yield* incomingList(pkg, slice)); return 1; }),
  [`addDynamicShortcuts(${S}${SLICE}I)Z`]: driven(function* (pkg: string, slice: JObj) {
    verifyCaller(pkg);
    const shortcuts = new Map(dynamicOf(pkg));
    for (const si of yield* incomingList(pkg, slice)) shortcuts.set(yield* awaited(idOf(si)), si);
    yield* commit(pkg, [...shortcuts.values()]);
    return 1;
  }),
  // a full activity drops its lowest-ranked shortcut to make room
  [`pushDynamicShortcut(${S}${SI}I)V`]: driven(function* (pkg: string, si: JObj) {
    verifyCaller(pkg);
    const pushed = yield* incoming(pkg, si), id = yield* awaited(idOf(pushed)), shortcuts = new Map(dynamicOf(pkg));
    shortcuts.delete(id);
    const activity = yield vcall(pushed, "getActivity", `()${CN}`), same: JObj[] = [];
    for (const other of shortcuts.values()) if (yield vcall(activity, "equals", "(Ljava/lang/Object;)Z", yield vcall(other, "getActivity", `()${CN}`))) same.push(other);
    if (same.length >= MAX_PER_ACTIVITY) {
      let last = same[0];
      for (const other of same) if ((yield vcall(other, "getRank", "()I")) >= (yield vcall(last, "getRank", "()I"))) last = other;
      shortcuts.delete(yield* awaited(idOf(last)));
    }
    yield* commit(pkg, [pushed, ...shortcuts.values()]);
  }),
  // an update changes only shortcuts that exist, and only the fields it sets
  [`updateShortcuts(${S}${SLICE}I)Z`]: driven(function* (pkg: string, slice: JObj) {
    verifyCaller(pkg);
    const shortcuts = dynamicOf(pkg);
    for (const si of (yield* awaited(toJsArray(yield vcall(slice, "getList", `()${LIST}`)))) as JObj[]) {
      const update = yield* incoming(pkg, si, true), target = shortcuts.get(yield* awaited(idOf(update)));
      if (target) yield vcall(target, "copyNonNullFieldsFrom", `(${SI})V`, update);
    }
    yield* commit(pkg, [...shortcuts.values()]);
    return 1;
  }),
  [`removeDynamicShortcuts(${S}${LIST}I)V`]: remove,
  [`removeLongLivedShortcuts(${S}${LIST}I)V`]: remove,
  // disabling removes a dynamic shortcut; only a pinned one would stay, disabled
  [`disableShortcuts(${S}${LIST}Ljava/lang/CharSequence;II)V`]: remove,
  [`removeAllDynamicShortcuts(${S}I)V`]: (pkg: string) => { verifyCaller(pkg); dynamicOf(pkg).clear(); },
  [`getShortcuts(${S}II)${SLICE}`]: driven(function* (pkg: string, flags: number) {
    verifyCaller(pkg);
    const clones: JObj[] = [];
    if (flags & MATCH_DYNAMIC) for (const si of dynamicOf(pkg).values()) clones.push(yield vcall(si, "clone", `(I)${SI}`, CLONE_REMOVE_FOR_CREATOR));
    return yield* awaited(parceledList(clones));
  }),
  [`getShareTargets(${S}Landroid/content/IntentFilter;I)${SLICE}`]: () => parceledList(),
  [`hasShareTargets(${S}${S}I)Z`]: () => 0,
  [`getMaxShortcutCountPerActivity(${S}I)I`]: () => MAX_PER_ACTIVITY,
  [`getIconMaxDimensions(${S}I)I`]: () => Math.round(device.dp(96)),
  // the app in front is never rate limited
  [`getRemainingCallCount(${S}I)I`]: () => MAX_UPDATES_PER_INTERVAL,
  [`reportShortcutUsed(${S}${S}I)V`]: (_pkg: string, id: string | null) => { if (id == null) throw rt.mkThrowable("java/lang/NullPointerException", "shortcutId"); },
  "isRequestPinItemSupported(II)Z": () => 0,
  // ShortcutService completes the request with String.valueOf(accepted)
  [`requestPinShortcut(${S}${SI}Landroid/content/IntentSender;I${FUTURE})V`]: (_pkg: string, _si: JObj, _sender: JObj, _user: number, future: JObj) =>
    complete(future, "false"),
  [`createShortcutResultIntent(${S}${SI}I${FUTURE})V`]: (_pkg: string, _si: JObj, _user: number, future: JObj) => complete(future, null),
  ...noops(`enableShortcuts(${S}${LIST}I)V`, `onApplicationActive(${S}I)V`),
});
