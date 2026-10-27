/**
 * The documents provider a device has and a browser does not. AOSP's ExternalStorageProvider
 * lives in a system package, so an app can neither see it in its own manifest nor reach its
 * files through java.io.File — a content:// tree is only ever readable through ContentResolver
 * and DocumentsContract, which is exactly what this serves, over the directory handles
 * src/shell/hostfs.ts gets from the browser.
 *
 * Document ids keep AOSP's shape, `<volume>:<relative/path>`, so DocumentsContract's existing
 * URI algebra needs no special case; the volume is the picked directory's own name.
 */

import { awaited, rt, type JObj, driven, type Gen } from "../jvm/runtime.ts";
import { vcall } from "../jvm/natives/jentry.ts";
import { uriParts, uriText } from "./net.ts";
import { pickDirectory, pickFiles, rootHandles } from "../shell/hostfs.ts";
import { openDb, txDone } from "../shell/idb.ts";
import { mkPfd, pfdBackingBytes } from "./os.ts";
import { mimeOf } from "../mime.ts";
import { registerSystemProvider, matrixCursor, uriBundle, DOCUMENTS_PROVIDER } from "./systemproviders.ts";

const DOCS_AUTHORITY = "com.android.externalstorage.documents";

// ── content://<authority>/tree/<treeId>/document/<docId>[/children], and the ids inside it
const enc = encodeURIComponent;
const badUri = (u: string) => rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid URI: " + u);

/** The document a URI points at: the child under a tree, a bare document, or a tree's root. */
function documentId(u: string): string {
  const p = uriParts(u).segments;
  if (p.length >= 4 && p[0] === "tree" && p[2] === "document") return p[3]!;
  if (p.length >= 2 && (p[0] === "document" || p[0] === "tree")) return p[1]!;
  throw badUri(u);
}
/** a URI for `id` in the same shape the one it came from has — tree-scoped, or bare */
function docUriLike(u: string, id: string): string {
  const { authority: auth, segments: p } = uriParts(u);
  return p[0] === "tree"
    ? `content://${auth}/tree/${enc(p[1]!)}/document/${enc(id)}`
    : `content://${auth}/document/${enc(id)}`;
}
/** a `.../children` URI asks for a directory listing rather than the document itself */
const isChildrenUri = (u: string) => uriParts(u).segments.at(-1) === "children";

const DIR_MIME = "vnd.android.document/directory";
// Document flags: SUPPORTS_WRITE | SUPPORTS_DELETE | SUPPORTS_RENAME (+ DIR_SUPPORTS_CREATE)
const FILE_FLAGS = 2 | 4 | 64, DIR_FLAGS = FILE_FLAGS | 8;

/** a document as DocumentsContract.Document's columns hold it */
type DocRow = { document_id: string; _display_name: string; mime_type: string; _size: number; last_modified: number; flags: number };
const DOC_COLUMNS: (keyof DocRow)[] = ["document_id", "_display_name", "mime_type", "_size", "last_modified", "flags"];

/** Loose files (an OPEN_DOCUMENT / CREATE_DOCUMENT result) have no tree above them, so they get
 *  a volume of their own rather than a path. */
const loose = new Map<string, FileSystemFileHandle>();

/** the picked-file handles store, open for one operation */
async function withFiles<T>(use: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDb("webdroid-documents", "files");
  try { return await use(db); } finally { db.close(); }
}
async function writeFiles(write: (store: IDBObjectStore) => void): Promise<void> {
  await withFiles((db) => {
    const transaction = db.transaction("files", "readwrite");
    write(transaction.objectStore("files"));
    return txDone(transaction);
  });
}

function savedFile(vol: string): Promise<FileSystemFileHandle | undefined> {
  return withFiles((db) => new Promise((resolve, reject) => {
    const request = db.transaction("files", "readonly").objectStore("files").get(vol);
    request.onsuccess = () => resolve(request.result as FileSystemFileHandle | undefined);
    request.onerror = () => reject(request.error);
  }));
}

const saveFile = (vol: string, h: FileSystemFileHandle) => writeFiles((store) => store.put(h, vol));

export async function clearPickedDocuments(): Promise<void> {
  loose.clear();
  cache.clear();
  await writeFiles((store) => store.clear());
}

const cache = new Map<string, FileSystemHandle>();

const split = (docId: string): [string, string[]] => {
  const i = docId.indexOf(":");
  const path = i < 0 ? "" : docId.slice(i + 1);
  return [i < 0 ? docId : docId.slice(0, i), path ? path.split("/") : []];
};
const join = (vol: string, segs: string[]) => vol + ":" + segs.join("/");

/** The handle a document id names, or null if nothing is there. */
async function resolveDoc(docId: string): Promise<FileSystemHandle | null> {
  const hit = cache.get(docId);
  if (hit) return hit;
  const [vol, segs] = split(docId);
  let h: FileSystemHandle | undefined = loose.get(vol) ?? rootHandles().get(vol);
  if (!h && vol.startsWith("single-")) {
    h = await savedFile(vol).catch(() => undefined);
    if (h?.kind === "file") loose.set(vol, h as FileSystemFileHandle);
  }
  for (const seg of segs) {
    if (!h || h.kind !== "directory") return null;
    const dir = h as FileSystemDirectoryHandle;
    h = await dir.getDirectoryHandle(seg).catch(() => dir.getFileHandle(seg).catch(() => undefined));
  }
  if (h) cache.set(docId, h);
  return h ?? null;
}

/** a document's row; null once it is gone, as one another call removed (UniFile renames by copy and
 *  delete) while it was being listed or looked up */
async function rowOf(id: string, h: FileSystemHandle): Promise<DocRow | null> {
  if (h.kind === "directory") return { document_id: id, _display_name: h.name, mime_type: DIR_MIME, _size: 0, last_modified: 0, flags: DIR_FLAGS };
  let f: File;
  try { f = await (h as FileSystemFileHandle).getFile(); }
  catch (e) { if ((e as DOMException).name !== "NotFoundError") throw e; cache.delete(id); return null; }
  return { document_id: id, _display_name: h.name, mime_type: f.type || mimeOf(h.name) || "application/octet-stream", _size: f.size,
    last_modified: f.lastModified, flags: FILE_FLAGS };
}

async function docRow(docId: string): Promise<DocRow | null> {
  const h = await resolveDoc(docId);
  return h ? rowOf(docId, h) : null;
}

async function docChildren(docId: string): Promise<DocRow[]> {
  const h = await resolveDoc(docId);
  if (h?.kind !== "directory") return [];
  const [vol, segs] = split(docId);
  const out: DocRow[] = [];
  for await (const [name, child] of (h as FileSystemDirectoryHandle).entries()) {
    const id = join(vol, [...segs, name]), row = await rowOf(id, child);
    if (row) { cache.set(id, child); out.push(row); }
  }
  return out;
}

async function docRead(docId: string): Promise<Uint8Array> {
  const h = await resolveDoc(docId);
  if (h?.kind !== "file") throw rt.mkThrowable("java/io/FileNotFoundException", docId);
  try { return new Uint8Array(await (await (h as FileSystemFileHandle).getFile()).arrayBuffer()); }
  catch (e) { if ((e as DOMException).name !== "NotFoundError") throw e; cache.delete(docId); throw rt.mkThrowable("java/io/FileNotFoundException", docId); }
}

async function docWrite(docId: string, bytes: Uint8Array): Promise<void> {
  const h = await resolveDoc(docId);
  if (h?.kind !== "file") throw rt.mkThrowable("java/io/FileNotFoundException", docId);
  const w = await (h as FileSystemFileHandle).createWritable();
  await w.write(bytes as BufferSource);
  await w.close();
}

/** DocumentsContract.createDocument: a directory when the mime says so, an empty file otherwise. */
async function docCreate(parentId: string, mime: string, name: string): Promise<string | null> {
  const p = await resolveDoc(parentId);
  if (p?.kind !== "directory") return null;
  const dir = p as FileSystemDirectoryHandle;
  const child: FileSystemHandle = mime === DIR_MIME
    ? await dir.getDirectoryHandle(name, { create: true })
    : await dir.getFileHandle(name, { create: true });
  const [vol, segs] = split(parentId);
  const id = join(vol, [...segs, name]);
  cache.set(id, child);
  return id;
}

/** A directory takes its children with it, and every cached descendant with them. */
function forget(docId: string) {
  for (const k of cache.keys()) if (k === docId || k.startsWith(docId + "/")) cache.delete(k);
}

async function docDelete(docId: string): Promise<boolean> {
  const [vol, segs] = split(docId);
  const name = segs.pop();
  if (!name) return false;
  const p = await resolveDoc(join(vol, segs));
  if (p?.kind !== "directory") return false;
  await (p as FileSystemDirectoryHandle).removeEntry(name, { recursive: true });
  forget(docId);
  return true;
}

/** No handle renames in place, so a rename is a copy under the new name and a delete of the
 *  old — recursive, because UniFile renames directories as readily as files. */
async function docRename(docId: string, name: string): Promise<string | null> {
  const [vol, segs] = split(docId);
  const parent = join(vol, segs.slice(0, -1));
  if (!segs.length || !await copyDoc(docId, parent, name)) return null;
  await docDelete(docId);
  return join(vol, [...segs.slice(0, -1), name]);
}
async function copyDoc(srcId: string, parentId: string, name: string): Promise<string | null> {
  const src = await resolveDoc(srcId);
  if (!src) return null;
  const dst = await docCreate(parentId, src.kind === "directory" ? DIR_MIME : mimeOf(name) ?? "application/octet-stream", name);
  if (!dst) return null;
  if (src.kind === "file") await docWrite(dst, await docRead(srcId));
  else for (const child of await docChildren(srcId)) await copyDoc(child.document_id, dst, child._display_name);
  return dst;
}

/** The user picks a directory; the tree URI is what an app persists and reopens it by. */
export async function pickTree(): Promise<string | null> {
  const h = await pickDirectory();
  if (!h) return null;
  cache.clear();
  return `content://${DOCS_AUTHORITY}/tree/${enc(h.name + ":")}`;
}

async function looseDocUri(h: FileSystemFileHandle): Promise<string> {
  const vol = "single-" + crypto.randomUUID();
  loose.set(vol, h);
  cache.set(vol + ":", h);
  await saveFile(vol, h).catch(() => {});
  return `content://${DOCS_AUTHORITY}/document/${enc(vol + ":")}`;
}
/** OPEN_DOCUMENT / GET_CONTENT / CREATE_DOCUMENT: one file, named by a document URI of its own,
 *  since a file the user picked outside a tree has no tree to be relative to. */
export async function pickDocument(opts: { save?: string; mime?: string | null }): Promise<string | null> {
  return (await pickDocuments(opts))[0] ?? null;
}
export async function pickDocuments(opts: { multiple?: boolean; save?: string; mime?: string | null }): Promise<string[]> {
  return Promise.all((await pickFiles(opts) ?? []).map(looseDocUri));
}

/** a document opened in `mode`: a write commits its bytes on close, "t" truncating */
const docPfd = driven(function* (docId: string, mode: string | null): Gen<JObj> {
  const write = (mode ?? "r").includes("w");
  const bytes = (yield* awaited(pfdBackingBytes(docId))) ?? (write && (mode ?? "").includes("t") ? new Uint8Array(0) : yield* awaited(docRead(docId)));
  return yield* awaited(mkPfd(bytes, write ? (b) => docWrite(docId, b) : null, docId));
});

// ── ExternalStorageProvider, the storage authority's IContentProvider over the picked handles: a
// document, or a directory's children, as DocumentsProvider's query answers them
const docQuery = driven(function* (u: string, projection: string[] | null): Gen<JObj> {
  const id = documentId(u);
  const rows: DocRow[] = isChildrenUri(u) ? yield* awaited(docChildren(id)) : [yield* awaited(docRow(id))].filter((r) => r !== null);
  const cols = projection?.length ? projection : DOC_COLUMNS;
  return yield* awaited(matrixCursor(cols, rows));
});
const S = "Ljava/lang/String;";
/** DocumentsProvider.call's document methods, as DocumentsContract sends them: the document in
 *  EXTRA_URI, and a created or renamed one's uri back in it; failures throw as ExternalStorageProvider's do */
const docCall = driven(function* (method: string, _arg: string | null, extras: JObj | null): Gen<JObj | null> {
  const get = (key: string): PromiseOrVal<string | null> => vcall(extras, "getString", `(${S})${S}`, key);
  const uri = yield* awaited(uriText(yield vcall(extras, "getParcelable", `(${S})Landroid/os/Parcelable;`, "uri"))), id = documentId(uri);
  let result: string | null;
  if (method === "android:createDocument") {
    result = yield* awaited(docCreate(id, (yield* awaited(get("mime_type"))) ?? "", (yield* awaited(get("_display_name"))) ?? ""));
    if (!result) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Parent document isn't a directory");
  } else if (method === "android:renameDocument") {
    const name: string = (yield* awaited(get("_display_name"))) ?? "";
    if (!(result = yield* awaited(docRename(id, name)))) throw rt.mkThrowable("java/lang/IllegalStateException", "Failed to rename to " + name);
  } else if (method === "android:deleteDocument") {
    if (!(yield* awaited(docDelete(id)))) throw rt.mkThrowable("java/lang/IllegalStateException", "Failed to delete " + id);
    return null;
  } else throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Method not supported " + method);
  return yield* awaited(uriBundle("uri", docUriLike(uri, result!)));
});
registerSystemProvider(DOCS_AUTHORITY, { pkg: "com.android.externalstorage", cls: "com.android.externalstorage.ExternalStorageProvider",
  process: "com.android.externalstorage", appFlags: 1, flags: 0, initOrder: 0, grantUriPermissions: true, action: DOCUMENTS_PROVIDER }, {
  query: docQuery,
  getType: async (u) => (await docRow(documentId(u)))?.mime_type ?? null,
  openFile: (u, mode) => docPfd(documentId(u), mode),
  delete: async (u) => +await docDelete(documentId(u)),
  call: docCall,
});
