/** MIME types by file extension; the first extension listed for a type is the one MIME_EXT names */
export const EXT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  bmp: "image/bmp", heic: "image/heic", heif: "image/heif", avif: "image/avif",
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", json: "application/json", xml: "text/xml",
  csv: "text/csv", txt: "text/plain", pdf: "application/pdf", zip: "application/zip", gz: "application/gzip",
  cbz: "application/vnd.comicbook+zip", epub: "application/epub+zip",
  mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm",
  avi: "video/x-msvideo", "3gp": "video/3gpp",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac",
  apk: "application/vnd.android.package-archive", db: "application/octet-stream", woff2: "font/woff2",
};
export const MIME_EXT: Record<string, string> = {};
for (const [e, m] of Object.entries(EXT_MIME)) MIME_EXT[m] ??= e;
/** a file name's MIME type by its extension, or null when it has none known */
export const mimeOf = (name: string): string | null => EXT_MIME[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? null;

/** the headers by which the browser inflates a microg .gz download, or null to serve the file as stored */
export function gzipHeaders(url: URL): Record<string, string> | null {
  if (!url.pathname.endsWith(".gz") || url.searchParams.has("raw")) return null;
  // A .gz download filename makes WebKit retain the compressed transport body.
  return { "content-encoding": "gzip", "content-type": "application/octet-stream", "content-disposition": "inline" };
}
