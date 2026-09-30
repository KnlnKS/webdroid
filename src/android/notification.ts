// android.app.Notification and everything that feeds it. There is no notification shade
// here, so nothing is posted and nothing is drawn. The contract these classes have to keep
// is narrower and entirely mechanical: they must LINK, every fluent setter must hand back
// the right receiver, and build() must yield a Notification whose PUBLIC FIELDS read back
// what was set — androidx's NotificationCompat writes and re-reads `n.flags`, `n.when`,
// `n.extras` and friends directly rather than through getters.

import { newArrayList, toJsArray } from "../jvm/natives/jcoll";
import { rt, JObj, stubs, noops, fieldGetters, fieldSetters, driven, type Gen } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { mkUri } from "./net";
import { PARCELABLE, type JBundle } from "./os";
import { type JParcel, parcelCreator, readInt, readString, writeInt, writeString } from "./parcel";
import type { JBitmap } from "./graphics";
import { JBitmapDrawable } from "./drawable";
import { preferenceStore } from "./sharedprefs";
import { appHost } from "./apphost";
import { csText } from "../jvm/natives/jchars";

type Impl = (...a: never[]) => unknown;
const mkBundle = () => new (rt.link("android/os/Bundle").ctor as new () => JBundle)();
/** `desc` here is "name(args)" — the return descriptor is appended by the caller. */
const self = (ms: Record<string, Impl>, sigs: string[], ret: string) => {
  for (const s of sigs) ms[s + ret] = function (this: object) { return this; };
};

// ── android.graphics.drawable.Icon: a lazy reference to an image, not an image.
class JIcon extends JObj {
  type = 0; resPkg: string | null = null; resId = 0;
  bmp: JBitmap | null = null; uri: unknown = null; data: Int8Array | null = null;
}
const TYPE_BITMAP = 1, TYPE_RESOURCE = 2, TYPE_DATA = 3, TYPE_URI = 4, TYPE_ADAPTIVE = 5, TYPE_URI_ADAPTIVE = 6;
const mkIcon = (type: number, init: (i: JIcon) => void) => { const i = new JIcon(); i.type = type; init(i); return i; };
const iconMethods: Record<string, Impl> = {
  "static createWithResource(Ljava/lang/String;I)Landroid/graphics/drawable/Icon;":
    (pkg: string, id: number) => mkIcon(TYPE_RESOURCE, (i) => { i.resPkg = pkg; i.resId = id; }),
  "static createWithResource(Landroid/content/Context;I)Landroid/graphics/drawable/Icon;":
    (_c: unknown, id: number) => mkIcon(TYPE_RESOURCE, (i) => { i.resId = id; }),
  "static createWithBitmap(Landroid/graphics/Bitmap;)Landroid/graphics/drawable/Icon;":
    (b: JBitmap) => mkIcon(TYPE_BITMAP, (i) => { i.bmp = b; }),
  "static createWithAdaptiveBitmap(Landroid/graphics/Bitmap;)Landroid/graphics/drawable/Icon;":
    (b: JBitmap) => mkIcon(TYPE_ADAPTIVE, (i) => { i.bmp = b; }),
  "static createWithContentUri(Ljava/lang/String;)Landroid/graphics/drawable/Icon;":
    (u: string) => mkIcon(TYPE_URI, (i) => { i.uri = mkUri(u); }),
  "static createWithContentUri(Landroid/net/Uri;)Landroid/graphics/drawable/Icon;":
    (u: unknown) => mkIcon(TYPE_URI, (i) => { i.uri = u; }),
  "static createWithAdaptiveBitmapContentUri(Landroid/net/Uri;)Landroid/graphics/drawable/Icon;":
    (u: unknown) => mkIcon(TYPE_URI_ADAPTIVE, (i) => { i.uri = u; }),
  "static createWithAdaptiveBitmapContentUri(Ljava/lang/String;)Landroid/graphics/drawable/Icon;":
    (u: string) => mkIcon(TYPE_URI_ADAPTIVE, (i) => { i.uri = mkUri(u); }),
  "static createWithData([BII)Landroid/graphics/drawable/Icon;":
    (b: Int8Array, off: number, len: number) => mkIcon(TYPE_DATA, (i) => { i.data = b?.slice(off, off + len) ?? null; }),
  "getUri()Landroid/net/Uri;": function (this: JIcon) { return this.uri ?? null; },
  ...fieldGetters({ "getType()I": "type", "getResId()I": "resId", "getResPackage()Ljava/lang/String;": "resPkg",
    "getBitmap()Landroid/graphics/Bitmap;": "bmp" }),
  ...PARCELABLE,
  "loadDrawable(Landroid/content/Context;)Landroid/graphics/drawable/Drawable;":
    driven(function* (this: JIcon, ctx: unknown): Gen {
      if (this.type === TYPE_RESOURCE && ctx) {
        return yield vcall(ctx, "getDrawable", "(I)Landroid/graphics/drawable/Drawable;", this.resId);
      }
      if (!this.bmp) return null;
      const d = new JBitmapDrawable();
      d.bmp = this.bmp;
      return d;
    }),
};
self(iconMethods, ["setTint(I)", "setTintList(Landroid/content/res/ColorStateList;)",
  "setTintBlendMode(Landroid/graphics/BlendMode;)", "setTintMode(Landroid/graphics/PorterDuff$Mode;)"],
  "Landroid/graphics/drawable/Icon;");
rt.register({
  name: "android/graphics/drawable/Icon", ctor: JIcon, ifaces: ["android/os/Parcelable"],
  statics: { TYPE_BITMAP, TYPE_RESOURCE, TYPE_DATA, TYPE_URI, TYPE_ADAPTIVE_BITMAP: TYPE_ADAPTIVE, TYPE_URI_ADAPTIVE_BITMAP: TYPE_URI_ADAPTIVE },
  methods: iconMethods,
});

// ── android.widget.RemoteViews: describes a view hierarchy for a process we don't have.
// Recording the calls is the whole implementation; nothing ever inflates them.
class JRemoteViews extends JObj {
  pkg: string | null = null; layoutId = 0;
  ops: unknown[][] = [];
}
const initRemoteViews = function (this: JRemoteViews, p: string, l: number) { this.pkg = p; this.layoutId = l; };
const rvMethods: Record<string, Impl> = {
  "<init>()V": function () {},
  "<init>(Ljava/lang/String;I)V": initRemoteViews,
  "<init>(Ljava/lang/String;II)V": initRemoteViews,
  "<init>(Landroid/widget/RemoteViews;Landroid/widget/RemoteViews;)V": function (this: JRemoteViews, a: JRemoteViews) { this.pkg = a?.pkg ?? null; this.layoutId = a?.layoutId ?? 0; },
  "<init>(Ljava/util/Map;)V": function () {},
  "<init>(Landroid/widget/RemoteViews;)V": function (this: JRemoteViews, a: JRemoteViews) { copyRemoteViews(this, a); },
  "getLayoutId()I": function (this: JRemoteViews) { return this.layoutId; },
  "getPackage()Ljava/lang/String;": function (this: JRemoteViews) { return this.pkg; },
  "clone()Landroid/widget/RemoteViews;": function (this: JRemoteViews) { return copyRemoteViews(new JRemoteViews(), this); },
  "describeContents()I": () => 0,
  // the recorded actions travel as values; nothing here inflates them yet
  "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JRemoteViews, parcel: JParcel): Gen {
    writeString(parcel, this.pkg); writeInt(parcel, this.layoutId); writeInt(parcel, this.ops.length);
    for (const [name, ...args] of this.ops) {
      writeString(parcel, name as string); writeInt(parcel, args.length);
      for (const arg of args) yield vcall(parcel, "writeValue", "(Ljava/lang/Object;)V", arg);
    }
  }),
};
function copyRemoteViews(to: JRemoteViews, from: JRemoteViews | null): JRemoteViews {
  to.pkg = from?.pkg ?? null; to.layoutId = from?.layoutId ?? 0; to.ops = from?.ops.map((op) => [...op]) ?? [];
  return to;
}
const readRemoteViews = async (parcel: JParcel): Promise<JRemoteViews> => {
  rt.link("android/widget/RemoteViews");
  const views = new JRemoteViews();
  views.pkg = readString(parcel); views.layoutId = readInt(parcel);
  for (let n = readInt(parcel); n > 0; n--) {
    const op: unknown[] = [readString(parcel)];
    for (let argc = readInt(parcel); argc > 0; argc--) op.push(await vcall(parcel, "readValue", "(Ljava/lang/ClassLoader;)Ljava/lang/Object;", null));
    views.ops.push(op);
  }
  return views;
};
for (const sig of [
  "addStableView(ILandroid/widget/RemoteViews;I)", "addView(ILandroid/widget/RemoteViews;)", "removeAllViews(I)",
  "setBitmap(ILjava/lang/String;Landroid/graphics/Bitmap;)", "setBlendMode(ILjava/lang/String;Landroid/graphics/BlendMode;)",
  "setBoolean(ILjava/lang/String;Z)", "setBundle(ILjava/lang/String;Landroid/os/Bundle;)",
  "setByte(ILjava/lang/String;B)", "setChar(ILjava/lang/String;C)",
  "setCharSequence(ILjava/lang/String;I)", "setCharSequence(ILjava/lang/String;Ljava/lang/CharSequence;)",
  "setCharSequenceAttr(ILjava/lang/String;I)", "setChronometer(IJLjava/lang/String;Z)",
  "setChronometerCountDown(IZ)", "setColor(ILjava/lang/String;I)", "setColorAttr(ILjava/lang/String;I)",
  "setColorInt(ILjava/lang/String;II)", "setColorStateList(ILjava/lang/String;I)",
  "setColorStateList(ILjava/lang/String;Landroid/content/res/ColorStateList;)",
  "setColorStateList(ILjava/lang/String;Landroid/content/res/ColorStateList;Landroid/content/res/ColorStateList;)",
  "setColorStateListAttr(ILjava/lang/String;I)", "setContentDescription(ILjava/lang/CharSequence;)",
  "setDouble(ILjava/lang/String;D)", "setFloat(ILjava/lang/String;F)",
  "setFloatDimen(ILjava/lang/String;FI)", "setFloatDimen(ILjava/lang/String;I)", "setFloatDimenAttr(ILjava/lang/String;I)",
  "setIcon(ILjava/lang/String;Landroid/graphics/drawable/Icon;)",
  "setIcon(ILjava/lang/String;Landroid/graphics/drawable/Icon;Landroid/graphics/drawable/Icon;)",
  "setImageViewBitmap(ILandroid/graphics/Bitmap;)", "setImageViewIcon(ILandroid/graphics/drawable/Icon;)",
  "setImageViewResource(II)", "setImageViewUri(ILandroid/net/Uri;)",
  "setInt(ILjava/lang/String;I)", "setIntDimen(ILjava/lang/String;FI)", "setIntDimen(ILjava/lang/String;I)",
  "setIntDimenAttr(ILjava/lang/String;I)", "setLong(ILjava/lang/String;J)",
  "setOnClickFillInIntent(ILandroid/content/Intent;)", "setOnClickPendingIntent(ILandroid/app/PendingIntent;)",
  "setPendingIntentTemplate(ILandroid/app/PendingIntent;)", "setProgressBar(IIIZ)",
  "setRemoteAdapter(ILandroid/content/Intent;)", "setShort(ILjava/lang/String;S)",
  "setString(ILjava/lang/String;Ljava/lang/String;)", "setTextColor(II)",
  "setTextColor(ILandroid/content/res/ColorStateList;)", "setTextViewCompoundDrawables(IIIII)",
  "setTextViewText(ILjava/lang/CharSequence;)", "setTextViewTextSize(IIF)",
  "setViewLayoutHeight(IFI)", "setViewLayoutHeightDimen(II)", "setViewLayoutMargin(IIFI)",
  "setViewLayoutWidth(IFI)", "setViewLayoutWidthDimen(II)",
  "setViewOutlinePreferredRadius(IFI)", "setViewOutlinePreferredRadiusDimen(II)",
  "setViewPadding(IIIII)", "setViewVisibility(II)",
]) {
  const name = sig.slice(0, sig.indexOf("("));
  rvMethods[sig + "V"] = function (this: JRemoteViews, ...a: unknown[]) { this.ops.push([name, ...a]); };
}
rt.register({ name: "android/widget/RemoteViews", ctor: JRemoteViews, ifaces: ["android/os/Parcelable"], methods: rvMethods,
  statics: { get CREATOR() { return parcelCreator("android/widget/RemoteViews", readRemoteViews); } } });
// Apps subclass RemoteViewsService, so its JS ctor has to really extend Service's — a
// plain JObj shell would drop every inherited Service method off the prototype chain.
rt.register({
  name: "android/widget/RemoteViewsService", sup: "android/app/Service",
  ctor: class extends (rt.link("android/app/Service").ctor as new () => JObj) {},
  methods: { "<init>()V": function () {} },
});
rt.markers("android/widget/RemoteViewsService$RemoteViewsFactory");

// ── android.app.Notification. Every one of these is a PUBLIC field in AOSP.
const NFIELDS: Record<string, unknown> = {
  when: 0n, icon: 0, iconLevel: 0, number: 0, flags: 0, defaults: 0,
  ledARGB: 0, ledOnMS: 0, ledOffMS: 0, audioStreamType: -1, priority: 0, visibility: 0, color: 0,
  contentIntent: null, deleteIntent: null, fullScreenIntent: null,
  tickerText: null, tickerView: null, contentView: null, bigContentView: null, headsUpContentView: null,
  largeIcon: null, sound: null, audioAttributes: null, vibrate: null,
  actions: null, category: null, publicVersion: null,
};
class JNotification extends JObj {
  [k: string]: unknown;
  extras = mkBundle();
  channelId: string | null = null;
  group: string | null = null;
  sortKey: string | null = null;
  groupAlertBehavior = 0; badgeIcon = 0; shortcutId: string | null = null; locusId: unknown = null;
  timeoutAfter = 0n; allowSystemActions = 1; bubbleMetadata: unknown = null;
  constructor() { super(); Object.assign(this, NFIELDS); }
}
const FLAG_ONGOING_EVENT = 2, FLAG_AUTO_CANCEL = 16, FLAG_ONLY_ALERT_ONCE = 8;
const FLAG_LOCAL_ONLY = 256, FLAG_GROUP_SUMMARY = 512, FLAG_HIGH_PRIORITY = 128;
// JNI looks up these public fields even when Java bytecode inlines their values.
const NOTIFICATION_EXTRAS = {
  EXTRA_ANSWER_COLOR: "android.answerColor", EXTRA_ANSWER_INTENT: "android.answerIntent",
  EXTRA_AUDIO_CONTENTS_URI: "android.audioContents", EXTRA_BACKGROUND_IMAGE_URI: "android.backgroundImageUri",
  EXTRA_BIG_TEXT: "android.bigText", EXTRA_CALL_IS_VIDEO: "android.callIsVideo",
  EXTRA_CALL_PERSON: "android.callPerson", EXTRA_CHANNEL_GROUP_ID: "android.intent.extra.CHANNEL_GROUP_ID",
  EXTRA_CHANNEL_ID: "android.intent.extra.CHANNEL_ID", EXTRA_CHRONOMETER_COUNT_DOWN: "android.chronometerCountDown",
  EXTRA_COLORIZED: "android.colorized", EXTRA_COMPACT_ACTIONS: "android.compactActions",
  EXTRA_CONVERSATION_TITLE: "android.conversationTitle", EXTRA_DECLINE_COLOR: "android.declineColor",
  EXTRA_DECLINE_INTENT: "android.declineIntent", EXTRA_HANG_UP_INTENT: "android.hangUpIntent",
  EXTRA_HISTORIC_MESSAGES: "android.messages.historic", EXTRA_INFO_TEXT: "android.infoText",
  EXTRA_IS_GROUP_CONVERSATION: "android.isGroupConversation", EXTRA_LARGE_ICON: "android.largeIcon",
  EXTRA_LARGE_ICON_BIG: "android.largeIcon.big", EXTRA_MEDIA_SESSION: "android.mediaSession",
  EXTRA_MESSAGES: "android.messages", EXTRA_MESSAGING_PERSON: "android.messagingUser",
  EXTRA_NOTIFICATION_ID: "android.intent.extra.NOTIFICATION_ID", EXTRA_NOTIFICATION_TAG: "android.intent.extra.NOTIFICATION_TAG",
  EXTRA_PEOPLE: "android.people", EXTRA_PEOPLE_LIST: "android.people.list",
  EXTRA_PICTURE: "android.picture", EXTRA_PICTURE_CONTENT_DESCRIPTION: "android.pictureContentDescription",
  EXTRA_PICTURE_ICON: "android.pictureIcon", EXTRA_PROGRESS: "android.progress",
  EXTRA_PROGRESS_INDETERMINATE: "android.progressIndeterminate", EXTRA_PROGRESS_MAX: "android.progressMax",
  EXTRA_REMOTE_INPUT_DRAFT: "android.remoteInputDraft", EXTRA_REMOTE_INPUT_HISTORY: "android.remoteInputHistory",
  EXTRA_SELF_DISPLAY_NAME: "android.selfDisplayName", EXTRA_SHOW_BIG_PICTURE_WHEN_COLLAPSED: "android.showBigPictureWhenCollapsed",
  EXTRA_SHOW_CHRONOMETER: "android.showChronometer", EXTRA_SHOW_WHEN: "android.showWhen",
  EXTRA_SMALL_ICON: "android.icon", EXTRA_SUB_TEXT: "android.subText", EXTRA_SUMMARY_TEXT: "android.summaryText",
  EXTRA_TEMPLATE: "android.template", EXTRA_TEXT: "android.text", EXTRA_TEXT_LINES: "android.textLines",
  EXTRA_TITLE: "android.title", EXTRA_TITLE_BIG: "android.title.big",
  EXTRA_VERIFICATION_ICON: "android.verificationIcon", EXTRA_VERIFICATION_TEXT: "android.verificationText",
};
rt.register({
  name: "android/app/Notification", ctor: JNotification, ifaces: ["android/os/Parcelable"],
  fields: Object.fromEntries([...Object.keys(NFIELDS), "extras"].map((k) => [k, k])),
  statics: {
    FLAG_SHOW_LIGHTS: 1, FLAG_ONGOING_EVENT, FLAG_INSISTENT: 4, FLAG_ONLY_ALERT_ONCE,
    FLAG_AUTO_CANCEL, FLAG_NO_CLEAR: 32, FLAG_FOREGROUND_SERVICE: 64, FLAG_HIGH_PRIORITY,
    FLAG_LOCAL_ONLY, FLAG_GROUP_SUMMARY, FLAG_BUBBLE: 4096,
    DEFAULT_ALL: -1, DEFAULT_SOUND: 1, DEFAULT_VIBRATE: 2, DEFAULT_LIGHTS: 4,
    PRIORITY_DEFAULT: 0, PRIORITY_LOW: -1, PRIORITY_MIN: -2, PRIORITY_HIGH: 1, PRIORITY_MAX: 2,
    VISIBILITY_PUBLIC: 1, VISIBILITY_PRIVATE: 0, VISIBILITY_SECRET: -1,
    GROUP_ALERT_ALL: 0, GROUP_ALERT_SUMMARY: 1, GROUP_ALERT_CHILDREN: 2, BADGE_ICON_NONE: 0, BADGE_ICON_SMALL: 1, BADGE_ICON_LARGE: 2,
    ...NOTIFICATION_EXTRAS,
    // object-typed, so unlike the int constants it survives as a real field ref
    AUDIO_ATTRIBUTES_DEFAULT: null,
  },
  methods: {
    "<init>()V": function () {},
    "<init>(ILjava/lang/CharSequence;J)V": function (this: JNotification, i: number, t: unknown, w: bigint) {
      this.icon = i; this.tickerText = t; this.when = w;
    },
    "clone()Landroid/app/Notification;": function (this: JNotification) { return Object.assign(new JNotification(), this); },
    ...fieldGetters({ "getChannelId()Ljava/lang/String;": "channelId", "getChannel()Ljava/lang/String;": "channelId",
      "getGroup()Ljava/lang/String;": "group", "getSortKey()Ljava/lang/String;": "sortKey",
      "getGroupAlertBehavior()I": "groupAlertBehavior", "getBadgeIconType()I": "badgeIcon",
      "getShortcutId()Ljava/lang/String;": "shortcutId", "getLocusId()Landroid/content/LocusId;": "locusId",
      "getTimeoutAfter()J": "timeoutAfter", "getAllowSystemGeneratedContextualActions()Z": "allowSystemActions",
      "getBubbleMetadata()Landroid/app/Notification$BubbleMetadata;": "bubbleMetadata" }),
    "getSettingsText()Ljava/lang/CharSequence;": function (this: JNotification) { return this.extras.map.get("android.settingsText") ?? null; },
    ...PARCELABLE,
  },
});

// ── Notification.Builder. One table per kind of setter; the fluent chain matters, the
// values only have to survive to build().
class JNBuilder extends JObj {
  n = new JNotification();
  extras = mkBundle();
  style: JNStyle | null = null;
}
const B = "Landroid/app/Notification$Builder;";
const setFlag = (n: JNotification, bit: number, on: unknown) => { n.flags = on ? (n.flags as number) | bit : (n.flags as number) & ~bit; };
function buildNotification(this: JNBuilder) {
  rt.link("android/app/Notification");
  for (const [k, v] of this.extras.map) this.n.extras.map.set(k, v);
  if (this.style instanceof JNMediaStyle) {
    if (this.style.token) this.n.extras.map.set("android.mediaSession", this.style.token);
    if (this.style.compactActions) this.n.extras.map.set("android.compactActions", this.style.compactActions);
    this.n.category ??= "transport";
  }
  return this.n;
}
const bMethods: Record<string, Impl> = {
  "<init>(Landroid/content/Context;)V": function () {},
  "<init>(Landroid/content/Context;Ljava/lang/String;)V": function (this: JNBuilder, _c: unknown, ch: string) { this.n.channelId = ch; },
  "build()Landroid/app/Notification;": buildNotification,
  "getNotification()Landroid/app/Notification;": buildNotification,
  "getExtras()Landroid/os/Bundle;": function (this: JNBuilder) { return this.extras; },
  ["setExtras(Landroid/os/Bundle;)" + B]: function (this: JNBuilder, b: JBundle | null) {
    if (b) this.extras = b;
    return this;
  },
  ["addExtras(Landroid/os/Bundle;)" + B]: function (this: JNBuilder, b: JBundle | null) {
    if (b) for (const [key, value] of b.map) this.extras.map.set(key, value);
    return this;
  },
  "getStyle()Landroid/app/Notification$Style;": function (this: JNBuilder) { return this.style; },
  ["setStyle(Landroid/app/Notification$Style;)" + B]: function (this: JNBuilder, s: JNStyle) {
    this.style = s; if (s) s.builder = this; return this;
  },
  ["setFlag(IZ)" + B]: function (this: JNBuilder, bit: number, on: number) { setFlag(this.n, bit, on); return this; },
  ["setSmallIcon(II)" + B]: function (this: JNBuilder, i: number, lvl: number) { this.n.iconLevel = lvl; return vcall(this, "setSmallIcon", "(I)" + B, i); },
  ["setLights(III)" + B]: function (this: JNBuilder, argb: number, on: number, off: number) {
    this.n.ledARGB = argb; this.n.ledOnMS = on; this.n.ledOffMS = off; return this;
  },
  ["setSound(Landroid/net/Uri;Landroid/media/AudioAttributes;)" + B]: function (this: JNBuilder, u: unknown, aa: unknown) {
    this.n.sound = u; this.n.audioAttributes = aa; return this;
  },
  ["setSound(Landroid/net/Uri;I)" + B]: function (this: JNBuilder, u: unknown, st: number) {
    this.n.sound = u; this.n.audioStreamType = st; return this;
  },
  ["setTicker(Ljava/lang/CharSequence;Landroid/widget/RemoteViews;)" + B]: function (this: JNBuilder, t: unknown, v: unknown) {
    this.n.tickerView = v; return vcall(this, "setTicker", "(Ljava/lang/CharSequence;)" + B, t);
  },
  ["setFullScreenIntent(Landroid/app/PendingIntent;Z)" + B]: function (this: JNBuilder, pi: unknown, hi: number) {
    this.n.fullScreenIntent = pi;
    setFlag(this.n, FLAG_HIGH_PRIORITY, hi);
    return this;
  },
  ["setProgress(IIZ)" + B]: function (this: JNBuilder, max: number, cur: number, ind: number) {
    const e = (this.n.extras as JBundle).map;
    e.set("android.progressMax", max); e.set("android.progress", cur); e.set("android.progressIndeterminate", ind);
    return this;
  },
  ["addAction(Landroid/app/Notification$Action;)" + B]: function (this: JNBuilder, a: unknown) {
    ((this.n.actions ??= mkActionArray()) as unknown[]).push(a); return this;
  },
  ["addAction(ILjava/lang/CharSequence;Landroid/app/PendingIntent;)" + B]: function (this: JNBuilder, i: number, t: unknown, pi: unknown) {
    const a = new JNAction(); a.icon = i; a.title = t; a.actionIntent = pi;
    ((this.n.actions ??= mkActionArray()) as unknown[]).push(a); return this;
  },
};
// setter → the public Notification field it lands in
for (const [sig, f] of Object.entries({
  "setWhen(J)": "when",
  "setSmallIcon(I)": "icon",
  "setNumber(I)": "number",
  "setDefaults(I)": "defaults",
  "setPriority(I)": "priority",
  "setVisibility(I)": "visibility",
  "setColor(I)": "color",
  "setCategory(Ljava/lang/String;)": "category",
  "setVibrate([J)": "vibrate",
  "setSound(Landroid/net/Uri;)": "sound",
  "setTicker(Ljava/lang/CharSequence;)": "tickerText",
  "setContentIntent(Landroid/app/PendingIntent;)": "contentIntent",
  "setDeleteIntent(Landroid/app/PendingIntent;)": "deleteIntent",
  "setContent(Landroid/widget/RemoteViews;)": "contentView",
  "setCustomContentView(Landroid/widget/RemoteViews;)": "contentView",
  "setCustomBigContentView(Landroid/widget/RemoteViews;)": "bigContentView",
  "setCustomHeadsUpContentView(Landroid/widget/RemoteViews;)": "headsUpContentView",
  "setLargeIcon(Landroid/graphics/Bitmap;)": "largeIcon",
  "setLargeIcon(Landroid/graphics/drawable/Icon;)": "largeIcon",
  "setSmallIcon(Landroid/graphics/drawable/Icon;)": "smallIcon",
  "setPublicVersion(Landroid/app/Notification;)": "publicVersion",
  "setGroup(Ljava/lang/String;)": "group",
  "setSortKey(Ljava/lang/String;)": "sortKey",
  "setChannelId(Ljava/lang/String;)": "channelId",
  "setGroupAlertBehavior(I)": "groupAlertBehavior",
  "setBadgeIconType(I)": "badgeIcon",
  "setShortcutId(Ljava/lang/String;)": "shortcutId",
  "setLocusId(Landroid/content/LocusId;)": "locusId",
  "setTimeoutAfter(J)": "timeoutAfter",
  "setAllowSystemGeneratedContextualActions(Z)": "allowSystemActions",
  "setBubbleMetadata(Landroid/app/Notification$BubbleMetadata;)": "bubbleMetadata",
})) bMethods[sig + B] = function (this: JNBuilder, v: unknown) { this.n[f] = v; return this; };
// AOSP: a silent notification alerts through its group summary (children, for a summary),
// drops sound and vibration, and joins the "silent" group when it has none
bMethods["setSilent(Z)" + B] = driven(function* (this: JNBuilder, silent: number): Gen {
  if (!silent) return this;
  const n = this.n;
  yield vcall(this, "setGroupAlertBehavior", "(I)" + B, (n.flags as number) & FLAG_GROUP_SUMMARY ? 2 : 1);
  yield vcall(this, "setVibrate", "([J)" + B, null);
  yield vcall(this, "setSound", "(Landroid/net/Uri;)" + B, null);
  yield vcall(this, "setDefaults", "(I)" + B, (n.defaults as number) & ~3);
  if (!n.group) yield vcall(this, "setGroup", "(Ljava/lang/String;)" + B, "silent");
  return this;
});
// the older overloads forward to their replacements, as AOSP's do
bMethods["setContent(Landroid/widget/RemoteViews;)" + B] = function (this: JNBuilder, v: unknown) {
  return vcall(this, "setCustomContentView", "(Landroid/widget/RemoteViews;)" + B, v);
};
// setter → the flags bit it toggles
for (const [sig, bit] of Object.entries({
  "setOngoing(Z)": FLAG_ONGOING_EVENT, "setAutoCancel(Z)": FLAG_AUTO_CANCEL,
  "setOnlyAlertOnce(Z)": FLAG_ONLY_ALERT_ONCE, "setLocalOnly(Z)": FLAG_LOCAL_ONLY,
  "setGroupSummary(Z)": FLAG_GROUP_SUMMARY,
})) bMethods[sig + B] = function (this: JNBuilder, on: number) { setFlag(this.n, bit, on); return this; };
// setter → the extras key AOSP records it under, which is where androidx reads it back
for (const [sig, key] of Object.entries({
  "setContentTitle(Ljava/lang/CharSequence;)": "android.title",
  "setContentText(Ljava/lang/CharSequence;)": "android.text",
  "setSubText(Ljava/lang/CharSequence;)": "android.subText",
  "setContentInfo(Ljava/lang/CharSequence;)": "android.infoText",
  "setSettingsText(Ljava/lang/CharSequence;)": "android.settingsText",
  "setRemoteInputHistory([Ljava/lang/CharSequence;)": "android.remoteInputHistory",
  "setShowWhen(Z)": "android.showWhen",
  "setUsesChronometer(Z)": "android.showChronometer",
  "setChronometerCountDown(Z)": "android.chronometerCountDown",
  "setColorized(Z)": "android.colorized",
})) bMethods[sig + B] = function (this: JNBuilder, v: unknown) { (this.n.extras as JBundle).map.set(key, v); return this; };
// accepted and dropped: no shade reads these, but the chain must not break
self(bMethods, [
  "addPerson(Ljava/lang/String;)", "addPerson(Landroid/app/Person;)", "setForegroundServiceBehavior(I)",
], B);
bMethods["setActions([Landroid/app/Notification$Action;)" + B] = function (this: JNBuilder, actions: unknown[]) {
  this.n.actions = Object.assign(mkActionArray(), [...actions]); return this;
};
bMethods["extend(Landroid/app/Notification$Extender;)" + B] = driven(function* (this: JNBuilder, extender: unknown): Gen {
  yield vcall(extender, "extend", "(" + B + ")" + B, this); return this;
});
rt.register({ name: "android/app/Notification$Builder", ctor: JNBuilder, methods: bMethods });

// ── Notification.Style: BigTextStyle et al. exist to be handed to Builder.setStyle, and
// their setters return the SUBCLASS, so each subclass needs its own descriptors.
class JNStyle extends JObj { builder: JNBuilder | null = null; }
/** AOSP's Style.setBuilder, which its Style(Builder) ctor also calls: the style is live on the
 *  builder before any of the fluent setters run */
const attachStyle = function (this: JNStyle, b: JNBuilder) { this.builder = b; if (b) b.style = this; };
rt.register({
  name: "android/app/Notification$Style", ctor: JNStyle,
  methods: {
    "<init>()V": function () {},
    "setBuilder(Landroid/app/Notification$Builder;)V": attachStyle,
    "build()Landroid/app/Notification;": function (this: JNStyle) { return this.builder?.n ?? null; },
  },
});
class JNMediaStyle extends JNStyle {
  token: unknown = null;
  compactActions: Int32Array | null = null;
}
const MEDIA_STYLE = "Landroid/app/Notification$MediaStyle;";
rt.register({ name: "android/app/Notification$MediaStyle", ctor: JNMediaStyle, sup: "android/app/Notification$Style", methods: {
  "<init>()V": function () {},
  "<init>(Landroid/app/Notification$Builder;)V": attachStyle,
  ["setMediaSession(Landroid/media/session/MediaSession$Token;)" + MEDIA_STYLE]: function (this: JNMediaStyle, token: unknown) {
    this.token = token; return this;
  },
  ["setShowActionsInCompactView([I)" + MEDIA_STYLE]: function (this: JNMediaStyle, actions: Int32Array | null) {
    this.compactActions = actions; return this;
  },
} });
for (const [name, extra] of Object.entries({
  BigTextStyle: ["bigText(Ljava/lang/CharSequence;)"],
  BigPictureStyle: ["bigPicture(Landroid/graphics/Bitmap;)", "bigPicture(Landroid/graphics/drawable/Icon;)",
    "bigLargeIcon(Landroid/graphics/Bitmap;)", "bigLargeIcon(Landroid/graphics/drawable/Icon;)",
    "setContentDescription(Ljava/lang/CharSequence;)", "showBigPictureWhenCollapsed(Z)"],
  InboxStyle: ["addLine(Ljava/lang/CharSequence;)"],
})) {
  const cls = "android/app/Notification$" + name;
  const ms: Record<string, Impl> = {
    "<init>()V": function () {},
    "<init>(Landroid/app/Notification$Builder;)V": attachStyle,
  };
  self(ms, ["setBigContentTitle(Ljava/lang/CharSequence;)", "setSummaryText(Ljava/lang/CharSequence;)", ...extra], "L" + cls + ";");
  rt.register({ name: cls, ctor: class extends JNStyle {}, sup: "android/app/Notification$Style", methods: ms });
}
rt.register({ name: "android/app/Notification$DecoratedCustomViewStyle", ctor: class extends JNStyle {}, sup: "android/app/Notification$Style",
  methods: { "<init>()V": function () {} } });

// ── Notification.Action (+ its Builder)
class JNAction extends JObj {
  icon = 0; title: unknown = null; actionIntent: unknown = null;
  ico: JIcon | null = null; extras = mkBundle(); semantic = 0; contextual = 0;
}
const mkActionArray = () => Object.assign([] as unknown[], { $t: "Landroid/app/Notification$Action;" });
rt.register({
  name: "android/app/Notification$Action", ctor: JNAction, ifaces: ["android/os/Parcelable"],
  fields: ["icon", "title", "actionIntent"],
  methods: {
    "<init>(ILjava/lang/CharSequence;Landroid/app/PendingIntent;)V": function (this: JNAction, i: number, t: unknown, pi: unknown) {
      this.icon = i; this.title = t; this.actionIntent = pi;
    },
    "getIcon()Landroid/graphics/drawable/Icon;": function (this: JNAction) {
      return this.ico ??= this.icon ? mkIcon(TYPE_RESOURCE, (x) => { x.resId = this.icon; }) : null;
    },
    "getRemoteInputs()[Landroid/app/RemoteInput;": () => null,
    "getDataOnlyRemoteInputs()[Landroid/app/RemoteInput;": () => null,
    "getAllowGeneratedReplies()Z": () => 1,
    ...fieldGetters({ "getExtras()Landroid/os/Bundle;": "extras", "getSemanticAction()I": "semantic", "isContextual()Z": "contextual" }),
    "isAuthenticationRequired()Z": () => 0,
    "clone()Landroid/app/Notification$Action;": function (this: JNAction) { return Object.assign(new JNAction(), this); },
    ...PARCELABLE,
  },
});
class JNActionBuilder extends JObj { a = new JNAction(); }
const AB = "Landroid/app/Notification$Action$Builder;";
const abMethods: Record<string, Impl> = {
  "<init>(ILjava/lang/CharSequence;Landroid/app/PendingIntent;)V": function (this: JNActionBuilder, i: number, t: unknown, pi: unknown) {
    this.a.icon = i; this.a.title = t; this.a.actionIntent = pi;
  },
  "<init>(Landroid/graphics/drawable/Icon;Ljava/lang/CharSequence;Landroid/app/PendingIntent;)V":
    function (this: JNActionBuilder, ic: JIcon, t: unknown, pi: unknown) {
      this.a.ico = ic; this.a.icon = ic?.resId ?? 0; this.a.title = t; this.a.actionIntent = pi;
    },
  "<init>(Landroid/app/Notification$Action;)V": function (this: JNActionBuilder, a: JNAction) { if (a) this.a = Object.assign(new JNAction(), a); },
  "build()Landroid/app/Notification$Action;": function (this: JNActionBuilder) { return this.a; },
  ["addExtras(Landroid/os/Bundle;)" + AB]: function (this: JNActionBuilder, b: JBundle) {
    if (b) for (const [k, v] of b.map) this.a.extras.map.set(k, v);
    return this;
  },
  ["setSemanticAction(I)" + AB]: function (this: JNActionBuilder, v: number) { this.a.semantic = v; return this; },
  ["setContextual(Z)" + AB]: function (this: JNActionBuilder, v: number) { this.a.contextual = v; return this; },
};
self(abMethods, ["addRemoteInput(Landroid/app/RemoteInput;)", "setAllowGeneratedReplies(Z)",
  "setAuthenticationRequired(Z)",
  "extend(Landroid/app/Notification$Action$Extender;)"], AB);
rt.register({ name: "android/app/Notification$Action$Builder", ctor: JNActionBuilder, methods: abMethods });

// ── android.app.Person: only ever handed straight back to Notification.Builder.
class JPerson extends JObj {
  [k: string]: unknown;
  name: unknown = null; key: string | null = null; uri: string | null = null; ico: JIcon | null = null;
}
rt.register({
  name: "android/app/Person", ctor: JPerson, ifaces: ["android/os/Parcelable"],
  methods: {
    ...fieldGetters({ "getName()Ljava/lang/CharSequence;": "name", "getKey()Ljava/lang/String;": "key",
      "getUri()Ljava/lang/String;": "uri", "getIcon()Landroid/graphics/drawable/Icon;": "ico" }),
    "isBot()Z": () => 0, "isImportant()Z": () => 0,
    ...PARCELABLE,
  },
});
class JPersonBuilder extends JObj { p = new JPerson(); }
{
  const PB = "Landroid/app/Person$Builder;";
  const pbMethods: Record<string, Impl> = {
    "<init>()V": function () {},
    "build()Landroid/app/Person;": function (this: JPersonBuilder) { return this.p; },
  };
  for (const [sig, f] of Object.entries({
    "setName(Ljava/lang/CharSequence;)": "name", "setKey(Ljava/lang/String;)": "key",
    "setUri(Ljava/lang/String;)": "uri", "setIcon(Landroid/graphics/drawable/Icon;)": "ico",
  })) pbMethods[sig + PB] = function (this: JPersonBuilder, v: unknown) { this.p[f] = v; return this; };
  self(pbMethods, ["setBot(Z)", "setImportant(Z)"], PB);
  rt.register({ name: "android/app/Person$Builder", ctor: JPersonBuilder, methods: pbMethods });
}

// ── NotificationChannel / NotificationChannelGroup / NotificationManager. Nothing is ever
// shown; a channel keeps what apps read back out of it.
class JNotificationChannel extends JObj { id = ""; nm: unknown = null; imp = 3; bypassDnd = 0; bubbles = 0; }
rt.register({
  name: "android/app/NotificationChannel", ctor: JNotificationChannel,
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/CharSequence;I)V": function (this: JNotificationChannel, id: string, nm: unknown, imp: number) {
      this.id = id; this.nm = nm; this.imp = imp;
    },
    ...fieldGetters({ "getId()Ljava/lang/String;": "id", "getName()Ljava/lang/CharSequence;": "nm",
      "getImportance()I": "imp", "canBypassDnd()Z": "bypassDnd", "canBubble()Z": "bubbles" }),
    ...fieldSetters({ "setName(Ljava/lang/CharSequence;)V": "nm", "setBypassDnd(Z)V": "bypassDnd",
      "setAllowBubbles(Z)V": "bubbles" }),
    ...stubs(null, "getGroup()Ljava/lang/String;", "getSound()Landroid/net/Uri;"),
    ...stubs(0, "shouldVibrate()Z"),
    ...stubs(1, "canShowBadge()Z"),
    ...noops("setDescription(Ljava/lang/String;)V", "setGroup(Ljava/lang/String;)V", "setShowBadge(Z)V",
      "setSound(Landroid/net/Uri;Landroid/media/AudioAttributes;)V", "enableLights(Z)V", "enableVibration(Z)V",
      "setLockscreenVisibility(I)V", "setLightColor(I)V", "setVibrationPattern([J)V"),
  },
});
class JNotificationGroup extends JObj { id = ""; name: unknown = null; description: string | null = null; }
const groupStoreName = () => "android:notification-groups:" + (appHost?.pkg ?? "");
function notificationGroups(): JNotificationGroup[] {
  rt.link("android/app/NotificationChannelGroup");
  const groups: JNotificationGroup[] = [];
  for (const [id, fields] of preferenceStore.open(groupStoreName())) if (Array.isArray(fields)) {
    const group = new JNotificationGroup(); group.id = id; group.name = fields[0]; group.description = fields[1] ?? null;
    groups.push(group);
  }
  return groups;
}
async function createGroup(group: JNotificationGroup): Promise<void> {
  if (!group) throw rt.mkThrowable("java/lang/NullPointerException", "group");
  const name = await csText(group.name);
  if (!group.id || !name) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Group id and name must not be empty");
  const key = groupStoreName(), groups = preferenceStore.open(key);
  groups.set(group.id, group.description === null ? [name] : [name, group.description]); preferenceStore.persist(key, groups);
}
rt.register({
  name: "android/app/NotificationChannelGroup", ctor: JNotificationGroup,
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/CharSequence;)V": function (this: JNotificationGroup, id: string, name: unknown) { this.id = id; this.name = name; },
    "setDescription(Ljava/lang/String;)V": function (this: JNotificationGroup, description: string | null) { this.description = description; },
    ...fieldGetters({ "getId()Ljava/lang/String;": "id", "getName()Ljava/lang/CharSequence;": "name", "getDescription()Ljava/lang/String;": "description" }),
    "isBlocked()Z": () => 0,
  },
});
rt.register({
  name: "android/app/NotificationManager", ctor: class extends JObj {},
  methods: {
    "getNotificationChannels()Ljava/util/List;": () => newArrayList(),
    "getNotificationChannelGroups()Ljava/util/List;": () => newArrayList(notificationGroups()),
    "getNotificationChannelGroup(Ljava/lang/String;)Landroid/app/NotificationChannelGroup;": (id: string) => notificationGroups().find(group => group.id === id) ?? null,
    "createNotificationChannelGroup(Landroid/app/NotificationChannelGroup;)V": createGroup,
    "createNotificationChannelGroups(Ljava/util/List;)V": driven(function* (groups: unknown): Gen {
      for (const group of yield toJsArray(groups)) {
        if (!(group instanceof JNotificationGroup)) throw rt.mkThrowable("java/lang/ClassCastException", "Expected NotificationChannelGroup");
        yield createGroup(group);
      }
    }),
    "deleteNotificationChannelGroup(Ljava/lang/String;)V": (id: string) => {
      const key = groupStoreName(), groups = preferenceStore.open(key); groups.delete(id); preferenceStore.persist(key, groups);
    },
    "getActiveNotifications()[Landroid/service/notification/StatusBarNotification;":
      () => Object.assign([] as unknown[], { $t: "Landroid/service/notification/StatusBarNotification;" }),
    ...noops("notify(ILandroid/app/Notification;)V", "notify(Ljava/lang/String;ILandroid/app/Notification;)V",
      "cancel(I)V", "cancel(Ljava/lang/String;I)V", "cancelAll()V", "setNotificationDelegate(Ljava/lang/String;)V",
      "createNotificationChannel(Landroid/app/NotificationChannel;)V", "createNotificationChannels(Ljava/util/List;)V",
      "deleteNotificationChannel(Ljava/lang/String;)V"),
    ...stubs(null, "getNotificationDelegate()Ljava/lang/String;",
      "getNotificationChannel(Ljava/lang/String;)Landroid/app/NotificationChannel;"),
    ...stubs(1, "areNotificationsEnabled()Z"),
  },
});
