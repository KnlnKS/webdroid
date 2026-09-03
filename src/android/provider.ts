// android.provider's document/media surface — and the PackageManager half it rests on.
// DocumentsContract.isDocumentUri() is not a URI-shape test alone: it is defined as "does a
// DocumentsProvider own this authority", which apps (UniFile, DocumentFile) answer by
// querying the package manager themselves. The manifest walk (providerNodes, matchesAction,
// authoritiesOf) lives with PackageManager in app.ts; DocumentsContract reads it from there.

import { rt, JObj } from "../jvm/runtime";
import { providerNodes, matchesAction, authoritiesOf, registerSystemActivity, mkResultIntent } from "./app";
import { mkUri } from "./net";
import { DOCS_AUTHORITY, docCreate, docDelete, docRename, pickTree, isDocsUri, isContentUri, uriParts, treeDocumentId, documentId, docUriLike, type JUriLike } from "./documents";


const PROVIDER_INTERFACE = "android.content.action.DOCUMENTS_PROVIDER";
/** The manifest walk only sees the app's own providers; the storage one is a system package. */
const isDocumentsProvider = (auth: string) => auth === DOCS_AUTHORITY ||
  providerNodes().some(([, n]) => matchesAction(n, PROVIDER_INTERFACE) && authoritiesOf(n).includes(auth));

registerSystemActivity("android.intent.action.OPEN_DOCUMENT_TREE",
  async () => { const uri = await pickTree(); return uri ? mkResultIntent(uri) : null; });


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

// ── MediaStore: the volume-scoped content URIs. content://media/<volume>/<table>
const mediaUri = (vol: string, table: string) => mkUri(`content://media/${vol}/${table}`);
for (const [cls, table] of [["Images$Media", "images/media"], ["Video$Media", "video/media"],
  ["Audio$Media", "audio/media"], ["Files", "file"]] as const) {
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
});
