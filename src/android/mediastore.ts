import type { Database } from "sql.js";
import { vfs } from "../jvm/natives/jio";
import { sqliteStore, mkCursor } from "./sqlite";
import { type JUri, mkUri } from "./net";

const extensions: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", heic: "image/heic", heif: "image/heif", avif: "image/avif", svg: "image/svg+xml",
  mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", mkv: "video/x-matroska",
  webm: "video/webm", avi: "video/x-msvideo", "3gp": "video/3gpp",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac",
};
const columns = ["_id", "_data", "_display_name", "title", "mime_type", "media_type", "_size",
  "date_added", "date_modified", "datetaken", "relative_path", "bucket_id", "bucket_display_name",
  "width", "height", "duration", "orientation", "is_pending", "is_trashed"];
const schema = `CREATE TABLE media (${columns.map((c) => `"${c}" ${c === "_data" || c === "_display_name" || c === "title" || c === "mime_type" || c === "relative_path" || c === "bucket_display_name" ? "TEXT" : "INTEGER"}`).join(", ")})`;
type Entry = { source: object; size: number; id: number };
const indexed = new Map<string, Entry>();
let dbReady: Promise<Database> | null = null;

function hash(path: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193);
  return (h >>> 1) || 1;
}
function mimeOf(path: string): string | null {
  return extensions[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? null;
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
  const stmt = db.prepare(`INSERT INTO media (${columns.map((c) => `"${c}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
  try {
    for (const path of removed) { drop.run([path]); indexed.delete(path); }
    for (const [path, file] of added) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      const parent = path.slice(0, path.lastIndexOf("/"));
      const mime = mimeOf(path);
      const id = hash(path);
      const now = Math.floor(Date.now() / 1000);
      stmt.run([id, path, name, name.slice(0, name.lastIndexOf(".") < 0 ? name.length : name.lastIndexOf(".")), mime,
        mediaType(mime), file.size, now, now, now * 1000, parent.slice("/sdcard/".length) + "/",
        hash(parent.toLowerCase()), parent.slice(parent.lastIndexOf("/") + 1), null, null, null, 0, 0, 0]);
      indexed.set(path, { ...file, id });
    }
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  } finally { drop.free(); stmt.free(); }
  return db;
}

function tableOf(uri: JUri): { volume: string; kind: string; id: number | null } | null {
  const match = /^content:\/\/media\/(external|external_primary|internal)\/(file|images\/media|video\/media|audio\/media|downloads)(?:\/(\d+))?(?:\?.*)?$/.exec(uri.uri);
  return match ? { volume: match[1], kind: match[2], id: match[3] ? Number(match[3]) : null } : null;
}
export function isMediaUri(uri: JUri): boolean { return tableOf(uri) !== null; }
export async function mediaPath(uri: JUri): Promise<string | null> {
  const table = tableOf(uri);
  if (!table?.id || table.volume === "internal") return null;
  await index();
  return [...indexed].find(([, e]) => e.id === table.id)?.[0] ?? null;
}
export async function mediaMime(uri: JUri): Promise<string | null> {
  const path = await mediaPath(uri);
  return path ? mimeOf(path) : null;
}
export async function scannedMediaUri(path: string): Promise<JUri | null> {
  if (!path.startsWith("/sdcard/") || !vfs.stat(path)) return null;
  await index();
  const entry = indexed.get(path);
  return entry ? mkUri(`content://media/external/file/${entry.id}`) : null;
}
export async function mediaQuery(uri: JUri, projection: string[] | null, selection: string | null,
  args: string[] | null, sort: string | null) {
  const table = tableOf(uri);
  if (!table) return null;
  const database = await index();
  const requested = projection?.length ? projection : columns;
  const predicates: string[] = [];
  if (table.volume === "internal") predicates.push("0");
  if (table.id) predicates.push(`_id = ${table.id}`);
  const type = table.kind === "images/media" ? 1 : table.kind === "audio/media" ? 2 : table.kind === "video/media" ? 3 : 0;
  if (type) predicates.push(`media_type = ${type}`);
  if (selection?.trim()) predicates.push(`(${selection})`);
  const query = `SELECT ${requested.map((c) => `"${c.replaceAll('"', '""')}"`).join(", ")} FROM media`
    + (predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "") + (sort ? ` ORDER BY ${sort}` : "");
  const rows: unknown[][] = [];
  const stmt = database.prepare(query);
  try {
    if (args?.length) stmt.bind(args);
    while (stmt.step()) rows.push(stmt.get());
  } finally { stmt.free(); }
  return mkCursor(requested, rows);
}
