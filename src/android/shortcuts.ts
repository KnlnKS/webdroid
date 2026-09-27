// android.content.pm.ShortcutInfo and ShortcutManager: an app's dynamic launcher shortcuts.

import { rt, JObj, stubs, fieldGetters, flagGetters, driven, type Gen } from "../jvm/runtime";
import { jarray } from "../jvm/abi";
import { newObj, vcall } from "../jvm/natives/jlang";
import { newArrayList, toJsArray } from "../jvm/natives/jutil";
import { device } from "../shell/config";
import { appHost } from "./apphost";
import { csText } from "./text";
import type { JIntent } from "./intent";
import type { JBundle } from "./os";

class JShortcutInfo extends JObj {
  id = ""; pkg = ""; shortLabel = ""; longLabel: string | null = null; disabledMessage: string | null = null;
  intents: JIntent[] = []; icon: unknown = null; extras: JBundle | null = null;
  rank = 0; excluded = 0; longLived = false; dynamic = false;
}
async function copyShortcut(info: JShortcutInfo): Promise<JShortcutInfo> {
  const copy = Object.assign(rt.make("android/content/pm/ShortcutInfo"), info);
  copy.intents = await Promise.all(info.intents.map((intent) => newObj("android/content/Intent", "(Landroid/content/Intent;)V", intent)));
  if (info.extras) {
    copy.extras = Object.assign(rt.make("android/os/PersistableBundle"), info.extras);
    copy.extras.map = new Map(info.extras.map);
  }
  return copy;
}
rt.register({
  name: "android/content/pm/ShortcutInfo", ctor: JShortcutInfo, ifaces: ["android/os/Parcelable"],
  statics: { SURFACE_LAUNCHER: 1 },
  methods: {
    "getExtras()Landroid/os/PersistableBundle;": driven(function* (this: JShortcutInfo): Gen { return (yield copyShortcut(this)).extras; }),
    "getIntent()Landroid/content/Intent;": driven(function* (this: JShortcutInfo): Gen { return (yield copyShortcut(this)).intents.at(-1) ?? null; }),
    "getIntents()[Landroid/content/Intent;": driven(function* (this: JShortcutInfo): Gen { return jarray((yield copyShortcut(this)).intents, "Landroid/content/Intent;"); }),
    ...fieldGetters({ "getId()Ljava/lang/String;": "id", "getPackage()Ljava/lang/String;": "pkg",
      "getShortLabel()Ljava/lang/CharSequence;": "shortLabel", "getLongLabel()Ljava/lang/CharSequence;": "longLabel",
      "getDisabledMessage()Ljava/lang/CharSequence;": "disabledMessage", "getRank()I": "rank" }),
    ...flagGetters({ "isDynamic()Z": "dynamic", "isLongLived()Z": "longLived" }),
    "isExcludedFromSurfaces(I)Z": function (this: JShortcutInfo, surfaces: number) { return this.excluded & surfaces ? 1 : 0; },
    ...stubs(0, "isPinned()Z", "isDeclaredInManifest()Z"),
    ...stubs(1, "isEnabled()Z"),
  },
});
class JShortcutBuilder extends JObj { info = new JShortcutInfo(); }
const shortcutBuilder = "Landroid/content/pm/ShortcutInfo$Builder;";
rt.register({
  name: "android/content/pm/ShortcutInfo$Builder", ctor: JShortcutBuilder,
  methods: {
    "<init>(Landroid/content/Context;Ljava/lang/String;)V": driven(function* (this: JShortcutBuilder, context: unknown, id: string): Gen {
      if (context == null || id == null) throw rt.mkThrowable("java/lang/NullPointerException", "Shortcut context and id required");
      if (!id) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Shortcut id must not be empty");
      this.info.id = id; this.info.pkg = yield vcall(context, "getPackageName", "()Ljava/lang/String;");
    }),
    [`setShortLabel(Ljava/lang/CharSequence;)${shortcutBuilder}`]: driven(function* (this: JShortcutBuilder, label: unknown): Gen {
      const text = yield csText(label);
      if (!text) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Shortcut label must not be empty");
      this.info.shortLabel = text; return this;
    }),
    [`setLongLabel(Ljava/lang/CharSequence;)${shortcutBuilder}`]: driven(function* (this: JShortcutBuilder, label: unknown): Gen { this.info.longLabel = yield csText(label); return this; }),
    [`setDisabledMessage(Ljava/lang/CharSequence;)${shortcutBuilder}`]: driven(function* (this: JShortcutBuilder, label: unknown): Gen { this.info.disabledMessage = yield csText(label); return this; }),
    [`setIntent(Landroid/content/Intent;)${shortcutBuilder}`]: function (this: JShortcutBuilder, intent: JIntent) { this.info.intents = [intent]; return this; },
    [`setIntents([Landroid/content/Intent;)${shortcutBuilder}`]: function (this: JShortcutBuilder, intents: JIntent[]) { this.info.intents = intents.slice(); return this; },
    [`setIcon(Landroid/graphics/drawable/Icon;)${shortcutBuilder}`]: function (this: JShortcutBuilder, icon: unknown) { this.info.icon = icon; return this; },
    [`setExtras(Landroid/os/PersistableBundle;)${shortcutBuilder}`]: function (this: JShortcutBuilder, extras: JBundle) { this.info.extras = extras; return this; },
    [`setRank(I)${shortcutBuilder}`]: function (this: JShortcutBuilder, rank: number) {
      if (rank < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Rank must not be negative");
      this.info.rank = rank; return this;
    },
    [`setLongLived(Z)${shortcutBuilder}`]: function (this: JShortcutBuilder, value: number) { this.info.longLived = !!value; return this; },
    [`setExcludedFromSurfaces(I)${shortcutBuilder}`]: function (this: JShortcutBuilder, value: number) { this.info.excluded = value; return this; },
    "build()Landroid/content/pm/ShortcutInfo;": function (this: JShortcutBuilder) {
      if (!this.info.shortLabel || !this.info.intents.length || this.info.intents.some((intent) => !intent?.action)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Shortcut label and intents with actions are required");
      return copyShortcut(this.info);
    },
  },
});
// There is no launcher here to pin a shortcut, so the pinned set is always empty.
class JShortcutManager extends JObj { packages = new Map<string, Map<string, JShortcutInfo>>(); }
const MAX_SHORTCUTS = 15;
function ownShortcuts(manager: JShortcutManager): Map<string, JShortcutInfo> {
  const pkg = appHost?.pkg ?? "";
  let shortcuts = manager.packages.get(pkg);
  if (!shortcuts) manager.packages.set(pkg, shortcuts = new Map());
  return shortcuts;
}
function commitShortcuts(manager: JShortcutManager, shortcuts: Iterable<JShortcutInfo>): number {
  const next = new Map([...shortcuts].map((info) => [info.id, info]));
  if (next.size > MAX_SHORTCUTS) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Max number of dynamic shortcuts exceeded");
  manager.packages.set(appHost?.pkg ?? "", next);
  return 1;
}
async function dynamicCopies(list: unknown): Promise<JShortcutInfo[]> {
  const pkg = appHost?.pkg ?? "";
  return Promise.all((await toJsArray(list)).map(async (info) => {
    if (!(info instanceof JShortcutInfo) || info.pkg !== pkg) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Shortcut belongs to another package");
    const copy = await copyShortcut(info); copy.dynamic = true; return copy;
  }));
}
const removeShortcuts = driven(function* (this: JShortcutManager, ids: unknown): Gen {
  const shortcuts = ownShortcuts(this);
  for (const id of (yield toJsArray(ids)) as string[]) shortcuts.delete(id);
});
const shortcutList = driven(function* (manager: JShortcutManager): Gen {
  const list = newArrayList(); list.a = yield Promise.all([...ownShortcuts(manager).values()].map(copyShortcut)); return list;
});
rt.register({
  name: "android/content/pm/ShortcutManager", ctor: JShortcutManager,
  statics: { FLAG_MATCH_MANIFEST: 1, FLAG_MATCH_DYNAMIC: 2, FLAG_MATCH_PINNED: 4, FLAG_MATCH_CACHED: 8 },
  methods: {
    "setDynamicShortcuts(Ljava/util/List;)Z": driven(function* (this: JShortcutManager, list: unknown): Gen {
      return commitShortcuts(this, yield dynamicCopies(list));
    }),
    "addDynamicShortcuts(Ljava/util/List;)Z": driven(function* (this: JShortcutManager, list: unknown): Gen {
      return commitShortcuts(this, [...ownShortcuts(this).values(), ...(yield dynamicCopies(list)) as JShortcutInfo[]]);
    }),
    // API 30: a full set drops its lowest-ranked shortcut to make room
    "pushDynamicShortcut(Landroid/content/pm/ShortcutInfo;)V": driven(function* (this: JShortcutManager, info: unknown): Gen {
      const shortcuts = ownShortcuts(this), [copy] = (yield dynamicCopies(newArrayList([info]))) as JShortcutInfo[];
      if (!shortcuts.has(copy.id) && shortcuts.size >= MAX_SHORTCUTS) {
        const last = [...shortcuts.values()].reduce((a, b) => b.rank >= a.rank ? b : a);
        shortcuts.delete(last.id);
      }
      shortcuts.set(copy.id, copy);
    }),
    // updates only shortcuts that exist, leaving the rest of each one as it was
    "updateShortcuts(Ljava/util/List;)Z": driven(function* (this: JShortcutManager, list: unknown): Gen {
      const shortcuts = ownShortcuts(this);
      for (const copy of (yield dynamicCopies(list)) as JShortcutInfo[]) if (shortcuts.has(copy.id)) shortcuts.set(copy.id, copy);
      return 1;
    }),
    "removeDynamicShortcuts(Ljava/util/List;)V": removeShortcuts,
    "removeLongLivedShortcuts(Ljava/util/List;)V": removeShortcuts,
    // disabling a shortcut removes its dynamic entry; only pinned ones would stay, disabled
    "disableShortcuts(Ljava/util/List;)V": removeShortcuts,
    "disableShortcuts(Ljava/util/List;Ljava/lang/CharSequence;)V": removeShortcuts,
    "enableShortcuts(Ljava/util/List;)V": () => {},
    "getDynamicShortcuts()Ljava/util/List;": function (this: JShortcutManager) { return shortcutList(this); },
    "getShortcuts(I)Ljava/util/List;": function (this: JShortcutManager, flags: number) { return flags & 2 ? shortcutList(this) : newArrayList(); },
    "getPinnedShortcuts()Ljava/util/List;": () => newArrayList(),
    "removeAllDynamicShortcuts()V": function (this: JShortcutManager) { ownShortcuts(this).clear(); },
    "requestPinShortcut(Landroid/content/pm/ShortcutInfo;Landroid/content/IntentSender;)Z": () => 0,
    "createShortcutResultIntent(Landroid/content/pm/ShortcutInfo;)Landroid/content/Intent;": () => null,
    "getMaxShortcutCountPerActivity()I": () => MAX_SHORTCUTS,
    "getIconMaxHeight()I": () => Math.round(device.dp(96)),
    "getIconMaxWidth()I": () => Math.round(device.dp(96)),
    "isRateLimitingActive()Z": () => 0,
    "reportShortcutUsed(Ljava/lang/String;)V": (id: string) => { if (id == null) throw rt.mkThrowable("java/lang/NullPointerException", "shortcutId"); },
    "isRequestPinShortcutSupported()Z": () => 0,
  },
});
