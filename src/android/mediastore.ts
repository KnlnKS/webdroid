import type { Database } from "sql.js";
import { vfs } from "../shell/vfs";
import { mimeOf, MIME_EXT } from "../mime";
import { sqliteStore } from "./sqlite";
import { clipUris } from "./net";
import { awaited, rt, JObj, driven, type Gen } from "../jvm/runtime";
import { newObj, scall, vcall } from "../jvm/natives/jentry";
import { strArray } from "../jvm/abi";
import { serviceContext } from "./binder";
import { registerSystemActivity, newIntent, putExtra, type JIntent } from "./intent";
import { newFile } from "../jvm/natives/jio";
import { toJsArray } from "../jvm/natives/jcoll";
import { registerSystemProvider, matrixCursor, contentValues, uriBundle } from "./systemproviders";

const columns = ["_id", "_data", "_display_name", "title", "mime_type", "media_type", "_size",
  "date_added", "date_modified", "datetaken", "relative_path", "bucket_id", "bucket_display_name",
  "width", "height", "duration", "orientation", "is_pending", "is_trashed", "is_favorite"];
const schema = `CREATE TABLE media (${columns.map((c) => `"${c}" ${c === "_data" || c === "_display_name" || c === "title" || c === "mime_type" || c === "relative_path" || c === "bucket_display_name" ? "TEXT" : "INTEGER"}`).join(", ")})`;
type Entry = { source: object; size: number; id: number };
const indexed = new Map<string, Entry>();
let dbReady: Promise<Database> | null = null;
/** pending, trashed and favourite paths: MediaProvider's own columns, kept across reloads */
type Flag = "is_pending" | "is_trashed" | "is_favorite";
const FLAGS: Flag[] = ["is_pending", "is_trashed", "is_favorite"];
const FLAGS_KEY = "wd:media:flags";
let flags: Record<Flag, Set<string>> | null = null;
function mediaFlags(): Record<Flag, Set<string>> {
  if (flags) return flags;
  let saved: Partial<Record<Flag, string[]>> = {};
  try { saved = JSON.parse(localStorage.getItem(FLAGS_KEY) ?? "{}"); } catch { /* no storage */ }
  return flags = { is_pending: new Set(saved.is_pending), is_trashed: new Set(saved.is_trashed), is_favorite: new Set(saved.is_favorite) };
}
function saveFlags(): void {
  const all = mediaFlags();
  try { localStorage.setItem(FLAGS_KEY, JSON.stringify(Object.fromEntries(FLAGS.map((f) => [f, [...all[f]]])))); } catch { /* no storage */ }
}

function hash(path: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193);
  return (h >>> 1) || 1;
}
function mediaType(mime: string | null): number {
  return mime?.startsWith("image/") ? 1 : mime?.startsWith("audio/") ? 2 : mime?.startsWith("video/") ? 3 : 0;
}
function mediaFiles(): Map<string, { source: object; size: number }> {
  const files = new Map<string, { source: object; size: number }>();
  for (const [path, bytes] of vfs.files) if (path.startsWith("/sdcard/")) files.set(path, { source: bytes, size: bytes.length });
  for (const [path, source] of vfs.lazyFiles) if (path.startsWith("/sdcard/")) files.set(path, { source, size: source.size });
  return files;
}
const INSERT = `INSERT INTO media (${columns.map((c) => `"${c}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`;
function row(path: string, size: number, id: number): (string | number | null)[] {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const parent = path.slice(0, path.lastIndexOf("/"));
  const mime = mimeOf(path);
  const now = Math.floor(Date.now() / 1000);
  return [id, path, name, name.slice(0, name.lastIndexOf(".") < 0 ? name.length : name.lastIndexOf(".")), mime,
    mediaType(mime), size, now, now, now * 1000, parent.slice("/sdcard/".length) + "/",
    hash(parent.toLowerCase()), parent.slice(parent.lastIndexOf("/") + 1), null, null, null, 0,
    ...FLAGS.map((f) => +mediaFlags()[f].has(path))];
}
async function index(): Promise<Database> {
  const db = await (dbReady ??= sqliteStore.sql().then((sql) => {
    const database = new sql.Database();
    database.run(schema);
    database.run("CREATE INDEX media_type_idx ON media(media_type)");
    database.run("CREATE INDEX media_path_idx ON media(_data)");
    return database;
  }).catch((error) => { dbReady = null; throw error; }));
  const files = mediaFiles();
  const removed = [...indexed].filter(([path, old]) => {
    const next = files.get(path);
    return !next || next.source !== old.source || next.size !== old.size;
  }).map(([path]) => path);
  const added = [...files].filter(([path, file]) => {
    const old = indexed.get(path);
    return !old || old.source !== file.source || old.size !== file.size;
  });
  if (!removed.length && !added.length) return db;
  db.run("BEGIN");
  const drop = db.prepare("DELETE FROM media WHERE _data = ?");
  const stmt = db.prepare(INSERT);
  try {
    for (const path of removed) { drop.run([path]); indexed.delete(path); }
    for (const [path, file] of added) {
      const id = hash(path);
      stmt.run(row(path, file.size, id));
      indexed.set(path, { ...file, id });
    }
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  } finally { drop.free(); stmt.free(); }
  return db;
}

type Table = { volume: string; kind: string; id: number | null };
/** each media collection's MEDIA_TYPE */
const KIND_TYPE: Record<string, number> = { "images/media": 1, "audio/media": 2, "video/media": 3 };
function tableOf(uri: string): Table | null {
  const match = /^content:\/\/media\/(external|external_primary|internal)\/(file|images\/media|video\/media|audio\/media|downloads)(?:\/(\d+))?(?:\?.*)?$/.exec(uri);
  return match ? { volume: match[1], kind: match[2], id: match[3] ? Number(match[3]) : null } : null;
}
function isMediaUri(uri: string): boolean { return tableOf(uri) !== null; }
export async function mediaPath(uri: string): Promise<string | null> {
  const table = tableOf(uri);
  if (!table?.id || table.volume === "internal") return null;
  await index();
  return [...indexed].find(([, e]) => e.id === table.id)?.[0] ?? null;
}
async function mediaMime(uri: string): Promise<string | null> {
  const path = await mediaPath(uri);
  return path ? mimeOf(path) : null;
}
function setFlag(database: Database, path: string, column: Flag, value: boolean): void {
  const set = mediaFlags()[column];
  if (value) set.add(path); else set.delete(path);
  database.run(`UPDATE media SET ${column} = ? WHERE _data = ?`, [+value, path]);
}
/** createTrashRequest/createFavoriteRequest once granted: the column set on each item */
async function mediaFlag(uris: string[], column: Flag, value: boolean): Promise<void> {
  const database = await index();
  for (const uri of uris) {
    const path = await mediaPath(uri);
    if (path) setFlag(database, path, column, value);
  }
  saveFlags();
}
/** each collection's allowed top-level directories, the first being where an insert without RELATIVE_PATH goes */
const AUDIO_DIRS = ["Music", "Alarms", "Audiobooks", "Notifications", "Podcasts", "Recordings", "Ringtones"];
const collectionDirs: Record<string, string[]> = {
  "images/media": ["Pictures", "DCIM"], "video/media": ["Movies", "DCIM", "Pictures"], "audio/media": AUDIO_DIRS,
  downloads: ["Download"], file: ["Download", "Documents", "DCIM", "Pictures", "Movies", ...AUDIO_DIRS],
};
const illegal = (why: string) => rt.mkThrowable("java/lang/IllegalArgumentException", why);
/** where MediaProvider puts a file: under an allowed primary directory, with the MIME type's extension,
 *  and made unique as "name (1).ext" unless it is `current`'s own path */
function placement(uri: string, kind: string, relativePath: string, name: string, mime: string | null, current?: string): string {
  const allowed = collectionDirs[kind];
  const relative = relativePath.replace(/^\/+|\/+$/g, "");
  const top = relative.split("/")[0];
  if (!allowed.some((dir) => dir.toLowerCase() === top.toLowerCase()))
    throw illegal(`Primary directory ${top} not allowed for ${uri}; allowed directories are [${allowed.join(", ")}]`);
  const ext = mime && mime !== "application/octet-stream" ? MIME_EXT[mime] : undefined;
  if (ext && mimeOf(name) !== mime) name += "." + ext;
  const dot = name.lastIndexOf("."), base = dot > 0 ? name.slice(0, dot) : name, suffix = dot > 0 ? name.slice(dot) : "";
  let path = `/sdcard/${relative}/${name}`;
  for (let n = 1; path !== current && vfs.exists(path); n++) path = `/sdcard/${relative}/${base} (${n})${suffix}`;
  return path;
}
const textOf = (values: Map<string, unknown>, key: string) => { const v = values.get(key); return v === null || v === undefined ? null : String(v); };
/** MediaProvider.insert: a new, empty file placed from DISPLAY_NAME, MIME_TYPE and RELATIVE_PATH,
 *  pending while IS_PENDING is set */
export async function mediaInsert(uri: string, values: Map<string, unknown>): Promise<string | null> {
  const table = tableOf(uri);
  if (!table || table.id !== null || table.volume === "internal") return null;
  const name = textOf(values, "_display_name") ?? String(Date.now());
  const mime = textOf(values, "mime_type") ?? mimeOf(name);
  if (KIND_TYPE[table.kind] && mediaType(mime) !== KIND_TYPE[table.kind])
    throw illegal(`MIME type ${mime} cannot be inserted into ${uri}`);
  const path = placement(uri, table.kind, textOf(values, "relative_path") ?? collectionDirs[table.kind][0], name, mime);
  vfs.write(path, new Uint8Array(0));
  const database = await index();
  const pending = Number(values.get("is_pending") ?? 0) === 1;
  if (pending) { setFlag(database, path, "is_pending", true); saveFlags(); }
  return `content://media/${table.volume}/${table.kind}/${indexed.get(path)!.id}`;
}
/** MediaProvider.update over the flag columns and the file's name and place: a new DISPLAY_NAME or
 *  RELATIVE_PATH moves the file, keeping its _id. Rows count only when a column here changed them. */
export async function mediaUpdate(uri: string, values: Map<string, unknown>, selection: string | null, args: string[] | null): Promise<number> {
  const table = tableOf(uri);
  if (!table) return 0;
  const paths = await selectedPaths(table, selection, args, { pending: 1, trashed: 1 });
  const database = await index();
  const flagged = FLAGS.filter((column) => values.has(column));
  const name = textOf(values, "_display_name"), relative = textOf(values, "relative_path");
  let count = 0;
  for (let path of paths) {
    if (name !== null || relative !== null) {
      const parent = path.slice(0, path.lastIndexOf("/"));
      const to = placement(uri, table.kind, relative ?? parent.slice("/sdcard/".length), name ?? path.slice(parent.length + 1), mimeOf(path), path);
      if (to !== path) {
        const entry = indexed.get(path)!;
        vfs.rename(path, to);
        indexed.delete(path); indexed.set(to, entry);
        for (const f of FLAGS) { const set = mediaFlags()[f]; if (set.delete(path)) set.add(to); }
        database.run("DELETE FROM media WHERE _data = ?", [path]);
        database.run(INSERT, row(to, entry.size, entry.id));
        path = to;
      }
    } else if (!flagged.length) continue;
    for (const column of flagged) setFlag(database, path, column, Number(values.get(column)) === 1);
    count++;
  }
  saveFlags();
  return count;
}
/** MediaStore.QUERY_ARG_MATCH_*: MATCH_DEFAULT (0), MATCH_INCLUDE (1), MATCH_EXCLUDE (2), MATCH_ONLY (3);
 *  `limit` is the SQL LIMIT clause */
interface MediaMatch { trashed?: number; pending?: number; favorite?: number; limit?: string | null }
function matchPredicate(column: string, match: number, fallback: number): string | null {
  const m = match || fallback;
  return m === 2 ? `${column} = 0` : m === 3 ? `${column} = 1` : null;
}
/** A media row is its file: deleting the row deletes the file, and the index follows the VFS. */
async function mediaDelete(uri: string, selection: string | null, args: string[] | null): Promise<number> {
  const table = tableOf(uri);
  let count = 0;
  for (const path of table ? await selectedPaths(table, selection, args) : []) if (vfs.delete(path)) count++;
  return count;
}
async function scannedMediaUri(path: string): Promise<string | null> {
  if (!path.startsWith("/sdcard/") || !vfs.stat(path)) return null;
  await index();
  const entry = indexed.get(path);
  return entry ? `content://media/external/file/${entry.id}` : null;
}
/** the table's rows a query selects, as `requested` columns. Trashed and pending items are left out
 *  unless the query asks for them, as MediaProvider does. */
async function select(table: Table, requested: string[], selection: string | null, args: string[] | null,
  sort: string | null, match: MediaMatch = {}): Promise<unknown[][]> {
  const database = await index();
  const predicates: string[] = [];
  if (table.volume === "internal") predicates.push("0");
  if (table.id) predicates.push(`_id = ${table.id}`);
  if (KIND_TYPE[table.kind]) predicates.push(`media_type = ${KIND_TYPE[table.kind]}`);
  for (const p of [matchPredicate("is_trashed", match.trashed ?? 0, 2), matchPredicate("is_pending", match.pending ?? 0, 2),
    matchPredicate("is_favorite", match.favorite ?? 0, 1)]) if (p) predicates.push(p);
  if (selection?.trim()) predicates.push(`(${selection})`);
  const query = `SELECT ${requested.map((c) => `"${c.replaceAll('"', '""')}"`).join(", ")} FROM media`
    + (predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "") + (sort ? ` ORDER BY ${sort}` : "") + (match.limit ? ` LIMIT ${match.limit}` : "");
  const rows: unknown[][] = [];
  const stmt = database.prepare(query);
  try {
    if (args?.length) stmt.bind(args);
    while (stmt.step()) rows.push(stmt.get());
  } finally { stmt.free(); }
  return rows;
}
const selectedPaths = async (table: Table, selection: string | null, args: string[] | null, match?: MediaMatch) =>
  (await select(table, ["_data"], selection, args, null, match)).map(([path]) => path as string);

// ── MediaProvider, the media authority's IContentProvider: a query's sort and limit come in its
// Bundle (ContentResolver.QUERY_ARG_*, MediaStore.QUERY_ARG_MATCH_*), an item opens as its file
const S = "Ljava/lang/String;", PFD = "android/os/ParcelFileDescriptor";
const ARG = "android:query-arg-", GET: Record<string, string> = { Int: `(${S})I`, String: `(${S})${S}`, StringArray: `(${S})[${S}` };
const QUERY_ARGS = new Set(["sql-selection", "sql-selection-args", "sql-sort-order", "sql-limit", "sort-columns", "sort-direction",
  "limit", "offset", "match-trashed", "match-pending", "match-favorite"].map((key) => ARG + key));
const query = driven(function* query$(u: string, projection: string[] | null, selection: string | null, args: string[] | null, extras: JObj | null): Gen<JObj | null> {
  const table = tableOf(u), requested = projection?.length ? projection : columns;
  if (!table) return null;
  const keys = new Set(extras ? (yield* awaited(toJsArray(yield vcall(extras, "keySet", "()Ljava/util/Set;")))) as string[] : []);
  for (const key of keys) if (!QUERY_ARGS.has(key)) throw rt.unimplemented(`MediaProvider query argument ${key}`);
  const get = (key: string, type: string): unknown => keys.has(ARG + key) ? vcall(extras, "get" + type, GET[type], ARG + key) : undefined;
  const limit: number | undefined = yield get("limit", "Int"), offset: number | undefined = yield get("offset", "Int");
  // QUERY_SORT_DIRECTION_DESCENDING is 1
  const direction = (yield get("sort-direction", "Int")) === 1 ? " DESC" : " ASC";
  const sort = (yield get("sql-sort-order", "String")) ?? ((yield get("sort-columns", "StringArray")) as string[] | undefined)?.map((c) => c + direction).join(", ") ?? null;
  const sqlLimit = (yield get("sql-limit", "String")) ?? (limit === undefined ? null : limit + (offset ? ` OFFSET ${offset}` : ""));
  const match = { trashed: yield get("match-trashed", "Int"), pending: yield get("match-pending", "Int"), favorite: yield get("match-favorite", "Int"), limit: sqlLimit };
  return yield* awaited(matrixCursor(requested, yield* awaited(select(table, requested, selection, args, sort, match))));
});
const openFile = driven(function* openFile$(u: string, mode: string): Gen<JObj> {
  const path = yield* awaited(mediaPath(u));
  if (!path) throw rt.mkThrowable("java/io/FileNotFoundException", u);
  return yield scall(PFD, "open", `(Ljava/io/File;I)L${PFD};`, yield* awaited(newFile(path)), yield scall(PFD, "parseMode", `(${S})I`, mode));
});

// MediaProvider's consent screen for a create*Request PendingIntent. It is answered by the grant
// policy runtime permissions follow here: the user allows, and the operation runs.
const MEDIA_REQUEST = "webdroid.provider.action.MEDIA_REQUEST";
const REQUESTS: Record<string, string> = { create_delete_request: "delete", create_write_request: "write",
  create_trash_request: "trash", create_favorite_request: "favorite" };
let mediaRequests = 0;
registerSystemActivity(MEDIA_REQUEST, driven(function* (intent: JIntent): Gen<JIntent> {
  const op: string | null = yield vcall(intent, "getStringExtra", `(${S})${S}`, "op");
  const uris: string[] = [...(yield vcall(intent, "getStringArrayExtra", `(${S})[${S}`, "uris")) ?? []];
  if (op === "delete") for (const uri of uris) yield mediaDelete(uri, null, null);
  else if (op === "trash" || op === "favorite") yield mediaFlag(uris, op === "trash" ? "is_trashed" : "is_favorite", !!(yield vcall(intent, "getIntExtra", `(${S}I)I`, "value", 0)));
  return yield* awaited(newIntent());
}));
/** MediaStore.createRequest's call: the items in EXTRA_CLIP_DATA, the flag in EXTRA_CONTENT_VALUES,
 *  and the consent screen's PendingIntent back in EXTRA_RESULT */
function* mediaCall(method: string, extras: JObj | null): Gen<JObj> {
  const op = REQUESTS[method];
  if (!op || !extras) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Unsupported call: " + method);
  const uris: string[] = yield* clipUris(yield vcall(extras, "getParcelable", `(${S})Landroid/os/Parcelable;`, "clip_data"));
  if (uris.some((uri) => !isMediaUri(uri) || !/\/\d+$/.test(uri))) throw rt.mkThrowable("java/lang/IllegalArgumentException", "All requested items must be referenced by specific ID");
  const values = contentValues(yield vcall(extras, "getParcelable", `(${S})Landroid/os/Parcelable;`, "content_values"));
  const intent = yield* awaited(newIntent(MEDIA_REQUEST));
  yield vcall(intent, "setIdentifier", `(${S})Landroid/content/Intent;`, String(++mediaRequests));
  yield putExtra(intent, "uris", strArray(uris), `[${S}`); yield putExtra(intent, "op", op, S);
  yield putExtra(intent, "value", Number(values.get("is_trashed") ?? values.get("is_favorite") ?? 0), "I");
  const result: JObj = yield newObj("android/os/Bundle", "()V");
  yield vcall(result, "putParcelable", `(${S}Landroid/os/Parcelable;)V`, "result", yield scall("android/app/PendingIntent", "getActivity",
    "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;", yield* awaited(serviceContext()), 0, intent, 0x4000000)); // FLAG_IMMUTABLE
  return result;
}
// FLAG_SYSTEM | FLAG_HAS_CODE | FLAG_ALLOW_CLEAR_USER_DATA, in its own package's process
registerSystemProvider("media", { pkg: "com.google.android.providers.media.module", cls: "com.android.providers.media.MediaProvider",
  process: "com.google.android.providers.media.module", appFlags: 0x45, flags: 0, initOrder: 0, systemRealm: true }, {
  query, insert: mediaInsert, update: mediaUpdate, delete: mediaDelete, getType: mediaMime, openFile,
  // MediaStore.SCAN_FILE_CALL, which MediaScannerConnection makes, takes the file's path and
  // answers its row, indexed now; the create*Request calls answer a consent PendingIntent
  call: driven(function* (method: string, arg: string | null, extras: JObj | null): Gen<JObj> {
    if (method !== "scan_file") return yield* mediaCall(method, extras);
    return yield* awaited(uriBundle("android.intent.extra.STREAM", yield* awaited(scannedMediaUri(arg ?? ""))));
  }),
});
