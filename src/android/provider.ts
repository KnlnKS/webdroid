// android.provider's document/media surface — and the PackageManager half it rests on.
// DocumentsContract.isDocumentUri() is not a URI-shape test alone: it is defined as "does a
// DocumentsProvider own this authority", which apps (UniFile, DocumentFile) answer by
// querying the package manager themselves. The manifest walk (providerNodes, matchesAction,
// authoritiesOf) lives with PackageManager in pm.ts; DocumentsContract reads it from there.

import { rt, JObj, driven, type Gen } from "../jvm/runtime";
import { newObj, vcall, scall } from "../jvm/natives/jlang";
import { isDocumentsProvider, field, serviceContext } from "./pm";
import { startActivityFor } from "./server/atm";
import { thisApp } from "./server/am";
import { registerSystemActivity, systemActivity, mkResultIntent, newIntent, intentQuery, putExtra, mkComponentName, type JIntent } from "./intent";

const S = "Ljava/lang/String;";
const typeOf = (intent: JIntent): Promise<string | null> => vcall(intent, "getType", `()${S}`);
import { csText } from "../jvm/natives/jchars";
import { frameworkString } from "./res";
import { mkUri, type JUri } from "./net";
import { isMediaUri, mediaDelete, mediaFlag } from "./mediastore";
import { newArrayList, toJsArray } from "../jvm/natives/jcoll";
import { packages } from "./packages";
import { docCreate, docDelete, docRename, pickTree, pickDocument, pickDocuments, isDocsUri, isContentUri, uriParts, treeDocumentId, documentId, docUriLike, type JUriLike } from "./documents";

const PROVIDER_INTERFACE = "android.content.action.DOCUMENTS_PROVIDER";

// The activities DocumentsUI provides on a device, over the browser's own pickers.
registerSystemActivity("android.intent.action.OPEN_DOCUMENT_TREE",
  async () => { const uri = await pickTree(); return uri ? mkResultIntent(uri, 3 | 0x40 | 0x80) : null; });
registerSystemActivity("android.intent.action.PICK", async (intent) => {
  const mime = await typeOf(intent);
  if (!mime || !/^(image|video|audio)\//.test(mime)) throw rt.unimplemented("PICK for " + (mime ?? await vcall(intent, "getDataString", `()${S}`)));
  const uri = await pickDocument({ mime });
  return uri ? mkResultIntent(uri, 1) : null;
});
// MediaStore.ACTION_PICK_IMAGES, the photo picker: one item as the data, or up to
// EXTRA_PICK_IMAGES_MAX as ClipData, readable and persistable
registerSystemActivity("android.provider.action.PICK_IMAGES", async (intent) => {
  const mime = await typeOf(intent), multiple = await vcall(intent, "getIntExtra", `(${S}I)I`, "android.provider.extra.PICK_IMAGES_MAX", 1) > 1;
  if (mime && !/^(image|video)\//.test(mime)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid picker MIME type " + mime);
  const uris = await pickDocuments({ mime, multiple });
  if (!uris.length) return null;
  const result = await mkResultIntent(multiple ? null : uris[0], 1 | 0x40);
  if (multiple) {
    const [first, ...rest] = uris.map(mkUri);
    const clip = await scall("android/content/ClipData", "newRawUri", "(Ljava/lang/CharSequence;Landroid/net/Uri;)Landroid/content/ClipData;", null, first);
    for (const uri of rest) await vcall(clip, "addItem", "(Landroid/content/ClipData$Item;)V", await newObj("android/content/ClipData$Item", "(Landroid/net/Uri;)V", uri));
    await vcall(result, "setClipData", "(Landroid/content/ClipData;)V", clip);
  }
  return result;
});
for (const action of ["android.intent.action.OPEN_DOCUMENT", "android.intent.action.GET_CONTENT",
  "android.intent.action.CREATE_DOCUMENT"] as const) {
  registerSystemActivity(action, async (intent) => {
    const title: string | null = await vcall(intent, "getStringExtra", `(${S})${S}`, "android.intent.extra.TITLE"), mime = await typeOf(intent);
    const uri = await pickDocument({
      save: action.endsWith("CREATE_DOCUMENT") ? title ?? "file" : undefined,
      mime: mime && mime !== "*/*" ? mime : null,
    });
    return uri ? mkResultIntent(uri, action === "android.intent.action.GET_CONTENT" ? 1 : 3 | 0x40) : null;
  });
}
registerSystemActivity("android.intent.action.VIEW", async (intent) => (await import("../shell/share")).openInBrowser((await vcall(intent, "getDataString", `()${S}`))!), ["http", "https", "market"]);
for (const action of ["android.intent.action.SEND", "android.intent.action.SEND_MULTIPLE"])
  registerSystemActivity(action, async (intent) => (await import("../shell/share")).shareIntent(intent));
registerSystemActivity("android.intent.action.CHOOSER", async (intent) => {
  const target: JIntent | null = await vcall(intent, "getParcelableExtra", `(${S})Landroid/os/Parcelable;`, "android.intent.extra.INTENT");
  if (!target) throw rt.mkThrowable("java/lang/NullPointerException", "Chooser target");
  const q = await intentQuery(target);
  if (q.action === "android.intent.action.SEND" || q.action === "android.intent.action.SEND_MULTIPLE")
    return (await import("../shell/share")).shareIntent(intent);
  const handler = systemActivity(q);
  if (handler) return handler(target);
  // AOSP's chooser lists the activities that handle the target; with none it only says so, and
  // the user dismissing it is RESULT_CANCELED
  const pm = await vcall(await serviceContext(), "getPackageManager", "()Landroid/content/pm/PackageManager;");
  const matches = await toJsArray(await vcall(pm, "queryIntentActivities", "(Landroid/content/Intent;I)Ljava/util/List;", target, 0x10000));
  if (!matches.length) return null;
  const labels = await Promise.all(matches.map(async (m) => csText(await vcall(m, "loadLabel", "(Landroid/content/pm/PackageManager;)Ljava/lang/CharSequence;", pm))));
  const title = await vcall(intent, "getCharSequenceExtra", `(${S})Ljava/lang/CharSequence;`, "android.intent.extra.TITLE");
  const choice = await (await import("../shell/share")).chooseActivity(title == null ? frameworkString("chooseActivity") ?? "" : await csText(title), labels);
  if (choice === null) return null;
  const chosen: JIntent = await newObj("android/content/Intent", "(Landroid/content/Intent;)V", target);
  const activity = field<JObj>(matches[choice], "android/content/pm/ResolveInfo", "activityInfo");
  await vcall(chosen, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", await mkComponentName(
    field<string>(activity, "android/content/pm/PackageItemInfo", "packageName"), field<string>(activity, "android/content/pm/PackageItemInfo", "name")));
  await startActivityFor(thisApp(), chosen);
  return newIntent();
});

const enc = encodeURIComponent;

rt.register({
  name: "android/provider/DocumentsContract", ctor: class extends JObj {},
  statics: { PROVIDER_INTERFACE, EXTRA_LOADING: "loading", EXTRA_ERROR: "error", EXTRA_INFO: "info" },
  methods: {
    "static isDocumentUri(Landroid/content/Context;Landroid/net/Uri;)Z": (_c: unknown, u: JUriLike) => {
      if (!isContentUri(u)) return 0;
      const [auth, p] = uriParts(u);
      if (!isDocumentsProvider(auth)) return 0;
      if (p.length === 2 && p[0] === "document") return 1;
      return p.length === 4 && p[0] === "tree" && p[2] === "document" ? 1 : 0;
    },
    "static isTreeUri(Landroid/net/Uri;)Z": (u: JUriLike) => {
      const p = uriParts(u)[1];
      return p.length >= 2 && p[0] === "tree" ? 1 : 0;
    },
    "static getDocumentId(Landroid/net/Uri;)Ljava/lang/String;": (u: JUriLike) => documentId(u),
    "static getTreeDocumentId(Landroid/net/Uri;)Ljava/lang/String;": treeDocumentId,
    "static buildDocumentUri(Ljava/lang/String;Ljava/lang/String;)Landroid/net/Uri;":
      (auth: string, id: string) => mkUri(`content://${auth}/document/${enc(id)}`),
    "static buildTreeDocumentUri(Ljava/lang/String;Ljava/lang/String;)Landroid/net/Uri;":
      (auth: string, id: string) => mkUri(`content://${auth}/tree/${enc(id)}`),
    "static buildDocumentUriUsingTree(Landroid/net/Uri;Ljava/lang/String;)Landroid/net/Uri;":
      (u: JUriLike, id: string) => mkUri(`content://${uriParts(u)[0]}/tree/${enc(treeDocumentId(u))}/document/${enc(id)}`),
    "static buildChildDocumentsUriUsingTree(Landroid/net/Uri;Ljava/lang/String;)Landroid/net/Uri;":
      (u: JUriLike, id: string) => mkUri(`content://${uriParts(u)[0]}/tree/${enc(treeDocumentId(u))}/document/${enc(id)}/children`),
    // Mutations are a ContentResolver.call into the owning DocumentsProvider; ours answers for
    // DOCS_AUTHORITY and anything else takes AOSP's own failure return rather than throwing.
    "static createDocument(Landroid/content/ContentResolver;Landroid/net/Uri;Ljava/lang/String;Ljava/lang/String;)Landroid/net/Uri;":
      driven(function* (_r: unknown, u: JUriLike, mime: string, name: string): Gen {
        const id = isDocsUri(u) ? yield docCreate(documentId(u, true), mime, name) : null;
        return id ? mkUri(docUriLike(u, id)) : null;
      }),
    "static renameDocument(Landroid/content/ContentResolver;Landroid/net/Uri;Ljava/lang/String;)Landroid/net/Uri;":
      driven(function* (_r: unknown, u: JUriLike, name: string): Gen {
        const id = isDocsUri(u) ? yield docRename(documentId(u, true), name) : null;
        return id ? mkUri(docUriLike(u, id)) : null;
      }),
    "static deleteDocument(Landroid/content/ContentResolver;Landroid/net/Uri;)Z":
      driven(function* (_r: unknown, u: JUriLike): Gen { return isDocsUri(u) && (yield docDelete(documentId(u, true))) ? 1 : 0; }),
  },
});
rt.register({
  name: "android/provider/DocumentsContract$Document", ctor: class extends JObj {},
  statics: {
    COLUMN_DOCUMENT_ID: "document_id", COLUMN_MIME_TYPE: "mime_type", COLUMN_DISPLAY_NAME: "_display_name",
    COLUMN_LAST_MODIFIED: "last_modified", COLUMN_FLAGS: "flags", COLUMN_SIZE: "_size",
    COLUMN_SUMMARY: "summary", COLUMN_ICON: "icon",
    MIME_TYPE_DIR: "vnd.android.document/directory",
    FLAG_SUPPORTS_THUMBNAIL: 1, FLAG_SUPPORTS_WRITE: 2, FLAG_SUPPORTS_DELETE: 4,
    FLAG_DIR_SUPPORTS_CREATE: 8, FLAG_DIR_PREFERS_GRID: 16, FLAG_DIR_PREFERS_LAST_MODIFIED: 32,
    FLAG_SUPPORTS_RENAME: 64, FLAG_SUPPORTS_COPY: 128, FLAG_SUPPORTS_MOVE: 256,
    FLAG_VIRTUAL_DOCUMENT: 512, FLAG_SUPPORTS_REMOVE: 1024,
  },
});
rt.register({
  name: "android/provider/DocumentsContract$Root", ctor: class extends JObj {},
  statics: {
    COLUMN_ROOT_ID: "root_id", COLUMN_FLAGS: "flags", COLUMN_ICON: "icon", COLUMN_TITLE: "title",
    COLUMN_SUMMARY: "summary", COLUMN_DOCUMENT_ID: "document_id", COLUMN_MIME_TYPES: "mime_types",
    COLUMN_AVAILABLE_BYTES: "available_bytes", COLUMN_CAPACITY_BYTES: "capacity_bytes",
    MIME_TYPE_ITEM: "vnd.android.document/root",
    FLAG_SUPPORTS_CREATE: 1, FLAG_LOCAL_ONLY: 2, FLAG_SUPPORTS_RECENTS: 4,
    FLAG_SUPPORTS_SEARCH: 8, FLAG_SUPPORTS_IS_CHILD: 16, FLAG_EMPTY: 64,
  },
});

// ── ContactsContract: the contract's URIs, which image loaders and pickers build requests from
// before ever querying (the provider itself is absent: a query answers no rows)
const contactsUri = (path: string) => mkUri(`content://com.android.contacts/${path}`);
rt.register({
  name: "android/provider/ContactsContract", ctor: class extends JObj {},
  statics: { AUTHORITY: "com.android.contacts", AUTHORITY_URI: mkUri("content://com.android.contacts") },
});
for (const [cls, path, extra] of [
  ["Contacts", "contacts", { CONTENT_LOOKUP_URI: contactsUri("contacts/lookup"), CONTENT_TYPE: "vnd.android.cursor.dir/contact", CONTENT_ITEM_TYPE: "vnd.android.cursor.item/contact" }],
  ["RawContacts", "raw_contacts", {}], ["Data", "data", {}], ["Groups", "groups", {}],
  ["CommonDataKinds$Phone", "data/phones", { CONTENT_TYPE: "vnd.android.cursor.dir/phone_v2", CONTENT_ITEM_TYPE: "vnd.android.cursor.item/phone_v2" }],
  ["CommonDataKinds$Email", "data/emails", { CONTENT_TYPE: "vnd.android.cursor.dir/email_v2", CONTENT_ITEM_TYPE: "vnd.android.cursor.item/email_v2" }],
] as const) {
  rt.register({ name: "android/provider/ContactsContract$" + cls, ctor: class extends JObj {}, statics: { CONTENT_URI: contactsUri(path), ...extra } });
}

rt.register({ name: "android/provider/BlockedNumberContract$BlockedNumbers", ctor: class extends JObj {}, statics: {
  CONTENT_URI: mkUri("content://com.android.blockednumber/blocked"),
  COLUMN_ID: "_id", COLUMN_ORIGINAL_NUMBER: "original_number", COLUMN_E164_NUMBER: "e164_number",
  CONTENT_TYPE: "vnd.android.cursor.dir/blocked_number", CONTENT_ITEM_TYPE: "vnd.android.cursor.item/blocked_number",
} });

const calendarUri = (table: string) => mkUri(`content://com.android.calendar/${table}`);
rt.register({ name: "android/provider/CalendarContract", ctor: class extends JObj {},
  statics: { AUTHORITY: "com.android.calendar" } });
for (const [name, table] of [["Calendars", "calendars"], ["Events", "events"],
  ["Attendees", "attendees"], ["Reminders", "reminders"], ["Colors", "colors"]] as const) {
  rt.register({ name: `android/provider/CalendarContract$${name}`, ctor: class extends JObj {},
    statics: { CONTENT_URI: calendarUri(table) } });
}

// ── MediaStore: the volume-scoped content URIs. content://media/<volume>/<table>
const mediaUri = (vol: string, table: string) => mkUri(`content://media/${vol}/${table}`);
for (const [cls, table] of [["Images$Media", "images/media"], ["Video$Media", "video/media"],
  ["Audio$Media", "audio/media"], ["Files", "file"], ["Downloads", "downloads"]] as const) {
  rt.register({
    name: "android/provider/MediaStore$" + cls, ctor: class extends JObj {},
    statics: {
      EXTERNAL_CONTENT_URI: mediaUri("external", table),
      INTERNAL_CONTENT_URI: mediaUri("internal", table),
    },
    methods: {
      "static getContentUri(Ljava/lang/String;)Landroid/net/Uri;": (vol: string) => mediaUri(vol, table),
    },
  });
}
// MediaProvider's consent screen for a create*Request PendingIntent. It is answered by the grant
// policy runtime permissions follow here (context.ts): the user allows, and the operation runs.
const MEDIA_REQUEST = "webdroid.provider.action.MEDIA_REQUEST";
let mediaRequests = 0;
registerSystemActivity(MEDIA_REQUEST, async (intent) => {
  const op: string | null = await vcall(intent, "getStringExtra", `(${S})${S}`, "op");
  const uris = await toJsArray(await vcall(intent, "getParcelableArrayListExtra", `(${S})Ljava/util/ArrayList;`, "uris")) as JUri[];
  if (op === "delete") for (const uri of uris) await mediaDelete(uri, null, null);
  else if (op === "trash" || op === "favorite") await mediaFlag(uris, op === "trash" ? "is_trashed" : "is_favorite", !!await vcall(intent, "getIntExtra", `(${S}I)I`, "value", 0));
  return newIntent();
});
const mediaRequest = (op: string) => driven(function* (resolver: unknown, uris: unknown, value: number = 0): Gen {
  if (!resolver || !uris) rt.npe();
  const items = (yield toJsArray(uris)) as JUri[];
  if (items.some((uri) => !isMediaUri(uri) || !/\/\d+$/.test(uri.uri))) throw rt.mkThrowable("java/lang/IllegalArgumentException", "All requested items must be referenced by specific ID");
  const intent: JIntent = yield newIntent(MEDIA_REQUEST);
  yield vcall(intent, "setIdentifier", `(${S})Landroid/content/Intent;`, String(++mediaRequests));
  yield vcall(intent, "putParcelableArrayListExtra", `(${S}Ljava/util/ArrayList;)Landroid/content/Intent;`, "uris", yield newArrayList(items));
  yield putExtra(intent, "op", op, S); yield putExtra(intent, "value", value, "I");
  return scall("android/app/PendingIntent", "getActivity", "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;",
    yield serviceContext(), 0, intent, 0x4000000); // FLAG_IMMUTABLE
});
rt.register({
  name: "android/provider/MediaStore", ctor: class extends JObj {},
  statics: {
    VOLUME_INTERNAL: "internal", VOLUME_EXTERNAL: "external", VOLUME_EXTERNAL_PRIMARY: "external_primary",
    MEDIA_SCANNER_VOLUME: "volume", AUTHORITY: "media",
  },
  methods: {
    "static getPickImagesMaxLimit()I": () => 150,
    "static createDeleteRequest(Landroid/content/ContentResolver;Ljava/util/Collection;)Landroid/app/PendingIntent;": mediaRequest("delete"),
    "static createWriteRequest(Landroid/content/ContentResolver;Ljava/util/Collection;)Landroid/app/PendingIntent;": mediaRequest("write"),
    "static createTrashRequest(Landroid/content/ContentResolver;Ljava/util/Collection;Z)Landroid/app/PendingIntent;": mediaRequest("trash"),
    "static createFavoriteRequest(Landroid/content/ContentResolver;Ljava/util/Collection;Z)Landroid/app/PendingIntent;": mediaRequest("favorite"),
    "static canManageMedia(Landroid/content/Context;)Z": async (ctx: JObj | null) => {
      if (!ctx) rt.npe();
      const pkg: string = await vcall(ctx, "getOpPackageName", "()Ljava/lang/String;");
      return packages.get(pkg)?.grants.has("android.permission.MANAGE_MEDIA") ? 1 : 0;
    },
  },
});
