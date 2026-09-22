// android.provider's document/media surface — and the PackageManager half it rests on.
// DocumentsContract.isDocumentUri() is not a URI-shape test alone: it is defined as "does a
// DocumentsProvider own this authority", which apps (UniFile, DocumentFile) answer by
// querying the package manager themselves. The manifest walk (providerNodes, matchesAction,
// authoritiesOf) lives with PackageManager in app.ts; DocumentsContract reads it from there.

import { rt, JObj } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { isDocumentsProvider } from "./pm";
import { registerSystemActivity, mkResultIntent } from "./intent";
import { mkUri } from "./net";
import { docCreate, docDelete, docRename, pickTree, pickDocument, isDocsUri, isContentUri, uriParts, treeDocumentId, documentId, docUriLike, type JUriLike } from "./documents";


const PROVIDER_INTERFACE = "android.content.action.DOCUMENTS_PROVIDER";

// The activities DocumentsUI provides on a device, over the browser's own pickers.
registerSystemActivity("android.intent.action.OPEN_DOCUMENT_TREE",
  async () => { const uri = await pickTree(); return uri ? mkResultIntent(uri) : null; });
for (const action of ["android.intent.action.OPEN_DOCUMENT", "android.intent.action.GET_CONTENT",
  "android.intent.action.CREATE_DOCUMENT"] as const) {
  registerSystemActivity(action, async (intent) => {
    const uri = await pickDocument({
      save: action.endsWith("CREATE_DOCUMENT") ? String(intent.extras.map.get("android.intent.extra.TITLE") ?? "file") : undefined,
      mime: intent.typeStr && intent.typeStr !== "*/*" ? intent.typeStr : null,
    });
    return uri ? mkResultIntent(uri) : null;
  });
}


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
    "saveRecentQuery(Ljava/lang/String;Ljava/lang/String;)V": async function (this: JSearchRecentSuggestions, query: string | null, line2: string | null) {
      if (!query?.length) return;
      if (line2 != null && !this.twoLine) throw rt.mkThrowable("java/lang/IllegalArgumentException", "twoLineDisplay must be enabled");
      const values = await newObj("android/content/ContentValues");
      await vcall(values, "put", "(Ljava/lang/String;Ljava/lang/String;)V", "display1", query);
      await vcall(values, "put", "(Ljava/lang/String;Ljava/lang/String;)V", "query", query);
      await vcall(values, "put", "(Ljava/lang/String;Ljava/lang/Long;)V", "date", BigInt(Date.now()));
      if (this.twoLine) await vcall(values, "put", "(Ljava/lang/String;Ljava/lang/String;)V", "display2", line2);
      const resolver = await vcall(this.ctx, "getContentResolver", "()Landroid/content/ContentResolver;");
      await vcall(resolver, "insert", "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;", mkUri(`content://${this.authority}/suggestions`), values);
    },
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
      async (_r: unknown, u: JUriLike, mime: string, name: string) => {
        const id = isDocsUri(u) ? await docCreate(documentId(u, true), mime, name) : null;
        return id ? mkUri(docUriLike(u, id)) : null;
      },
    "static renameDocument(Landroid/content/ContentResolver;Landroid/net/Uri;Ljava/lang/String;)Landroid/net/Uri;":
      async (_r: unknown, u: JUriLike, name: string) => {
        const id = isDocsUri(u) ? await docRename(documentId(u, true), name) : null;
        return id ? mkUri(docUriLike(u, id)) : null;
      },
    "static deleteDocument(Landroid/content/ContentResolver;Landroid/net/Uri;)Z":
      async (_r: unknown, u: JUriLike) => isDocsUri(u) && await docDelete(documentId(u, true)) ? 1 : 0,
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
rt.register({
  name: "android/provider/MediaStore", ctor: class extends JObj {},
  statics: {
    VOLUME_INTERNAL: "internal", VOLUME_EXTERNAL: "external", VOLUME_EXTERNAL_PRIMARY: "external_primary",
    MEDIA_SCANNER_VOLUME: "volume", AUTHORITY: "media",
  },
  methods: { "static getPickImagesMaxLimit()I": () => 150 },
});
