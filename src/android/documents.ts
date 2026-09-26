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

import { rt, driven, type Gen } from "../jvm/runtime";
import { JOutputStream, streamOf, type JInputStream } from "../jvm/natives/jio";
import { pickDirectory, pickFiles, rootHandles } from "../shell/hostfs";
import { openDb, txDone } from "../shell/idb";

export const DOCS_AUTHORITY = "com.android.externalstorage.documents";

// ── content://<authority>/tree/<treeId>/document/<docId>[/children], and the ids inside it
export type JUriLike = { uri?: string } | null;
const enc = encodeURIComponent;
export const isContentUri = (u: JUriLike) => (u?.uri ?? "").startsWith("content://");
const badUri = (u: JUriLike) => rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid URI: " + (u?.uri ?? "null"));

/** (authority, decoded path segments) — Uri.getPathSegments decodes, and document ids carry ':'. */
export function uriParts(u: JUriLike): [string, string[]] {
  const s = u?.uri ?? "";
  const i = s.indexOf("://");
  if (i < 0) return ["", []];
  const rest = s.slice(i + 3).split(/[?#]/)[0]!;
  const j = rest.indexOf("/");
  if (j < 0) return [rest, []];
  return [rest.slice(0, j), rest.slice(j + 1).split("/").filter(Boolean).map(decodeURIComponent)];
}
/** is this one of ours, i.e. does the built-in storage provider own the authority */
export const isDocsUri = (u: JUriLike) => isContentUri(u) && uriParts(u)[0] === DOCS_AUTHORITY;

export function treeDocumentId(u: JUriLike): string {
  const p = uriParts(u)[1];
  if (p.length >= 2 && p[0] === "tree") return p[1]!;
  throw badUri(u);
}
/** The document a URI points at: the child under a tree, or a bare document. `treeRootOk` also
 *  accepts a plain tree URI and answers with its root, which getDocumentId itself rejects. */
export function documentId(u: JUriLike, treeRootOk = false): string {
  const p = uriParts(u)[1];
  if (p.length >= 4 && p[0] === "tree" && p[2] === "document") return p[3]!;
  if (p.length >= 2 && p[0] === "document") return p[1]!;
  if (treeRootOk && p.length >= 2 && p[0] === "tree") return p[1]!;
  throw badUri(u);
}
/** a URI for `id` in the same shape the one it came from has — tree-scoped, or bare */
export function docUriLike(u: JUriLike, id: string): string {
  const [auth, p] = uriParts(u);
  return p[0] === "tree"
    ? `content://${auth}/tree/${enc(p[1]!)}/document/${enc(id)}`
    : `content://${auth}/document/${enc(id)}`;
}
/** a `.../children` URI asks for a directory listing rather than the document itself */
export const isChildrenUri = (u: JUriLike) => uriParts(u)[1].at(-1) === "children";

const DIR_MIME = "vnd.android.document/directory";
// Document flags: SUPPORTS_WRITE | SUPPORTS_DELETE | SUPPORTS_RENAME (+ DIR_SUPPORTS_CREATE)
const FILE_FLAGS = 2 | 4 | 64, DIR_FLAGS = FILE_FLAGS | 8;

const MIMES: Record<string, string> = {
  txt: "text/plain", json: "application/json", xml: "text/xml", html: "text/html", csv: "text/csv",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  pdf: "application/pdf", zip: "application/zip", cbz: "application/vnd.comicbook+zip", epub: "application/epub+zip",
  gz: "application/gzip", tachibk: "application/octet-stream", mp3: "audio/mpeg", mp4: "video/mp4",
};
function mimeOf(name: string): string {
  return MIMES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
}

interface DocRow { id: string; name: string; mime: string; size: number; modified: number; flags: number }
export const DOC_COLUMNS = ["document_id", "_display_name", "mime_type", "_size", "last_modified", "flags"];
export const docCells = (r: DocRow) => [r.id, r.name, r.mime, r.size, r.modified, r.flags];

/** Loose files (an OPEN_DOCUMENT / CREATE_DOCUMENT result) have no tree above them, so they get
 *  a volume of their own rather than a path. */
const loose = new Map<string, FileSystemFileHandle>();

async function savedFile(vol: string): Promise<FileSystemFileHandle | undefined> {
  const db = await openDb("webdroid-documents", "files");
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("files", "readonly").objectStore("files").get(vol);
      request.onsuccess = () => resolve(request.result as FileSystemFileHandle | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

async function saveFile(vol: string, h: FileSystemFileHandle): Promise<void> {
  const db = await openDb("webdroid-documents", "files");
  try {
    const transaction = db.transaction("files", "readwrite");
    transaction.objectStore("files").put(h, vol);
    await txDone(transaction);
  } finally { db.close(); }
}

export async function clearPickedDocuments(): Promise<void> {
  loose.clear();
  cache.clear();
  const db = await openDb("webdroid-documents", "files");
  try {
    const transaction = db.transaction("files", "readwrite");
    transaction.objectStore("files").clear();
    await txDone(transaction);
  } finally { db.close(); }
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

async function rowOf(id: string, h: FileSystemHandle): Promise<DocRow> {
  if (h.kind === "directory") return { id, name: h.name, mime: DIR_MIME, size: 0, modified: 0, flags: DIR_FLAGS };
  const f = await (h as FileSystemFileHandle).getFile();
  return { id, name: h.name, mime: f.type || mimeOf(h.name), size: f.size, modified: f.lastModified, flags: FILE_FLAGS };
}

export async function docRow(docId: string): Promise<DocRow | null> {
  const h = await resolveDoc(docId);
  return h ? rowOf(docId, h) : null;
}

export async function docChildren(docId: string): Promise<DocRow[]> {
  const h = await resolveDoc(docId);
  if (h?.kind !== "directory") return [];
  const [vol, segs] = split(docId);
  const out: DocRow[] = [];
  for await (const [name, child] of (h as FileSystemDirectoryHandle).entries()) {
    const id = join(vol, [...segs, name]);
    cache.set(id, child);
    out.push(await rowOf(id, child));
  }
  return out;
}

export async function docRead(docId: string): Promise<Uint8Array> {
  const h = await resolveDoc(docId);
  if (h?.kind !== "file") throw rt.mkThrowable("java/io/FileNotFoundException", docId);
  return new Uint8Array(await (await (h as FileSystemFileHandle).getFile()).arrayBuffer());
}

export async function docWrite(docId: string, bytes: Uint8Array): Promise<void> {
  const h = await resolveDoc(docId);
  if (h?.kind !== "file") throw rt.mkThrowable("java/io/FileNotFoundException", docId);
  const w = await (h as FileSystemFileHandle).createWritable();
  await w.write(bytes as BufferSource);
  await w.close();
}

/** DocumentsContract.createDocument: a directory when the mime says so, an empty file otherwise. */
export async function docCreate(parentId: string, mime: string, name: string): Promise<string | null> {
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

export async function docDelete(docId: string): Promise<boolean> {
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
export async function docRename(docId: string, name: string): Promise<string | null> {
  const [vol, segs] = split(docId);
  const parent = join(vol, segs.slice(0, -1));
  if (!segs.length || !await copyDoc(docId, parent, name)) return null;
  await docDelete(docId);
  return join(vol, [...segs.slice(0, -1), name]);
}
async function copyDoc(srcId: string, parentId: string, name: string): Promise<string | null> {
  const src = await resolveDoc(srcId);
  if (!src) return null;
  const dst = await docCreate(parentId, src.kind === "directory" ? DIR_MIME : mimeOf(name), name);
  if (!dst) return null;
  if (src.kind === "file") await docWrite(dst, await docRead(srcId));
  else for (const child of await docChildren(srcId)) await copyDoc(child.id, dst, child.name);
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
  const picked = await pickFiles(opts);
  return picked?.length ? await looseDocUri(picked[0]!) : null;
}

// ── the streams ContentResolver hands out for a document
export function docInputStream(docId: string): Promise<JInputStream> {
  return docRead(docId).then(streamOf);
}
class JDocOutputStream extends JOutputStream { docId = ""; }
rt.register({
  name: "webdroid/DocOutputStream", ctor: JDocOutputStream, sup: "java/io/OutputStream",
  methods: {
    // A handle's writable truncates on open, so the bytes are buffered here and committed once,
    // on close. flush() cannot be that commit: a BufferedOutputStream wrapper flushes per block,
    // which would rewrite the whole file for every buffer's worth of a backup.
    "flush()V": () => {},
    "close()V": driven(function* (this: JDocOutputStream): Gen { yield docWrite(this.docId, Uint8Array.from(this.chunks)); }),
  },
});
export function docOutputStream(docId: string, append: boolean): Promise<JDocOutputStream> {
  const s = new (rt.link("webdroid/DocOutputStream").ctor as typeof JDocOutputStream)();
  s.docId = docId;
  return append ? docRead(docId).then((b) => { s.chunks = [...b]; return s; }, () => s) : Promise.resolve(s);
}
