// android.provider's document/media surface — and the PackageManager half it rests on.
// DocumentsContract.isDocumentUri() is not a URI-shape test alone: it is defined as "does a
// DocumentsProvider own this authority", which apps (UniFile, DocumentFile) answer by
// querying the package manager themselves. The manifest walk (providerNodes, matchesAction,
// authoritiesOf) lives with PackageManager in app.ts; DocumentsContract reads it from there.

import { rt, JObj, driven, type Gen } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { isDocumentsProvider, getPM, type JResolveInfo } from "./pm";
import { registerSystemActivity, systemActivity, launchIntent, mkResultIntent, type JIntent } from "./intent";
import { csText } from "../jvm/natives/jchars";
import { frameworkString } from "./res";
import { mkUri, type JUri } from "./net";
import { isMediaUri, mediaDelete } from "./mediastore";
import { newArrayList, toJsArray } from "../jvm/natives/jutil";
import { appHost } from "./apphost";
import { packages } from "./packages";
import { docCreate, docDelete, docRename, pickTree, pickDocument, isDocsUri, isContentUri, uriParts, treeDocumentId, documentId, docUriLike, type JUriLike } from "./documents";


const PROVIDER_INTERFACE = "android.content.action.DOCUMENTS_PROVIDER";

// The activities DocumentsUI provides on a device, over the browser's own pickers.
registerSystemActivity("android.intent.action.OPEN_DOCUMENT_TREE",
  async () => { const uri = await pickTree(); return uri ? mkResultIntent(uri, 3 | 0x40 | 0x80) : null; });
registerSystemActivity("android.intent.action.PICK", async (intent) => {
  const mime = intent.typeStr;
  if (!mime || !/^(image|video|audio)\//.test(mime)) throw rt.unimplemented("PICK for " + (mime ?? intent.dataUri));
  const uri = await pickDocument({ mime });
  return uri ? mkResultIntent(uri, 1) : null;
});
for (const action of ["android.intent.action.OPEN_DOCUMENT", "android.intent.action.GET_CONTENT",
  "android.intent.action.CREATE_DOCUMENT"] as const) {
  registerSystemActivity(action, async (intent) => {
    const uri = await pickDocument({
      save: action.endsWith("CREATE_DOCUMENT") ? String(intent.extras.map.get("android.intent.extra.TITLE") ?? "file") : undefined,
      mime: intent.typeStr && intent.typeStr !== "*/*" ? intent.typeStr : null,
    });
    return uri ? mkResultIntent(uri, action === "android.intent.action.GET_CONTENT" ? 1 : 3 | 0x40) : null;
  });
}
for (const action of ["android.intent.action.SEND", "android.intent.action.SEND_MULTIPLE"])
  registerSystemActivity(action, async (intent) => (await import("../shell/share")).shareIntent(intent));
registerSystemActivity("android.intent.action.CHOOSER", async (intent) => {
  const target = intent.extras.map.get("android.intent.extra.INTENT") as JIntent | null;
  if (!target) throw rt.mkThrowable("java/lang/NullPointerException", "Chooser target");
  if (target.action === "android.intent.action.SEND" || target.action === "android.intent.action.SEND_MULTIPLE")
    return (await import("../shell/share")).shareIntent(intent);
  const handler = systemActivity(target);
  if (handler) return handler(target);
  // AOSP's chooser lists the activities that handle the target; with none it only says so, and
  // the user dismissing it is RESULT_CANCELED
  const pm = getPM(), matches = await toJsArray(await vcall(pm, "queryIntentActivities", "(Landroid/content/Intent;I)Ljava/util/List;", target, 0x10000)) as JResolveInfo[];
  if (!matches.length) return null;
  const labels = await Promise.all(matches.map(async (m) => csText(await vcall(m, "loadLabel", "(Landroid/content/pm/PackageManager;)Ljava/lang/CharSequence;", pm))));
  const title = intent.extras.map.get("android.intent.extra.TITLE");
  const choice = await (await import("../shell/share")).chooseActivity(title == null ? frameworkString("chooseActivity") ?? "" : await csText(title), labels);
  if (choice === null) return null;
  const chosen: JIntent = await newObj("android/content/Intent", "(Landroid/content/Intent;)V", target);
  chosen.component = matches[choice].activityInfo!.name; chosen.componentPkg = matches[choice].activityInfo!.packageName;
  await launchIntent(appHost!, chosen);
  return rt.make("android/content/Intent");
});


const enc = encodeURIComponent;

class JSearchRecentSuggestions extends JObj {
  ctx: unknown = null;
  authority = "";
  twoLine = false;
}
rt.register({
  name: "android/provider/SearchRecentSuggestions", ctor: JSearchRecentSuggestions,
  methods: {
    "<init>(Landroid/content/Context;Ljava/lang/String;I)V": function (this: JSearchRecentSuggestions, ctx: unknown, authority: string | null, mode: number) {
      if (!authority || !(mode & 1)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown mode or empty authority");
      this.ctx = ctx;
      this.authority = authority;
      this.twoLine = !!(mode & 2);
    },
    "saveRecentQuery(Ljava/lang/String;Ljava/lang/String;)V": driven(function* (this: JSearchRecentSuggestions, query: string | null, line2: string | null): Gen {
      if (!query?.length) return;
      if (line2 != null && !this.twoLine) throw rt.mkThrowable("java/lang/IllegalArgumentException", "twoLineDisplay must be enabled");
      const values = yield newObj("android/content/ContentValues");
      yield vcall(values, "put", "(Ljava/lang/String;Ljava/lang/String;)V", "display1", query);
      yield vcall(values, "put", "(Ljava/lang/String;Ljava/lang/String;)V", "query", query);
      yield vcall(values, "put", "(Ljava/lang/String;Ljava/lang/Long;)V", "date", BigInt(Date.now()));
      if (this.twoLine) yield vcall(values, "put", "(Ljava/lang/String;Ljava/lang/String;)V", "display2", line2);
      const resolver = yield vcall(this.ctx, "getContentResolver", "()Landroid/content/ContentResolver;");
      yield vcall(resolver, "insert", "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;", mkUri(`content://${this.authority}/suggestions`), values);
    }),
  },
});

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
  if (intent.extras.map.get("op") === "delete") for (const uri of await toJsArray(intent.extras.map.get("uris"))) await mediaDelete(uri as JUri, null, null);
  return rt.make("android/content/Intent");
});
const mediaRequest = (del: boolean) => driven(function* (resolver: unknown, uris: unknown): Gen {
  if (!resolver || !uris) rt.npe();
  const items = (yield toJsArray(uris)) as JUri[];
  if (items.some((uri) => !isMediaUri(uri) || !/\/\d+$/.test(uri.uri))) throw rt.mkThrowable("java/lang/IllegalArgumentException", "All requested items must be referenced by specific ID");
  const intent: JIntent = rt.make("android/content/Intent");
  intent.action = MEDIA_REQUEST; intent.identifier = String(++mediaRequests);
  intent.extras.map.set("uris", newArrayList(items)); intent.extras.map.set("op", del ? "delete" : "write");
  return vcall(rt.link("android/app/PendingIntent").ctor, "getActivity", "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;",
    appHost?.application, 0, intent, 0x4000000); // FLAG_IMMUTABLE
});
rt.register({
  name: "android/provider/MediaStore", ctor: class extends JObj {},
  statics: {
    VOLUME_INTERNAL: "internal", VOLUME_EXTERNAL: "external", VOLUME_EXTERNAL_PRIMARY: "external_primary",
    MEDIA_SCANNER_VOLUME: "volume", AUTHORITY: "media",
  },
  methods: {
    "static getPickImagesMaxLimit()I": () => 150,
    "static createDeleteRequest(Landroid/content/ContentResolver;Ljava/util/Collection;)Landroid/app/PendingIntent;": mediaRequest(true),
    "static createWriteRequest(Landroid/content/ContentResolver;Ljava/util/Collection;)Landroid/app/PendingIntent;": mediaRequest(false),
    "static canManageMedia(Landroid/content/Context;)Z": (ctx: { $host: { pkg: string } } | null) => {
      if (!ctx) rt.npe();
      return packages.get(ctx!.$host.pkg)?.grants.has("android.permission.MANAGE_MEDIA") ? 1 : 0;
    },
  },
});
