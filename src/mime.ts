export const EXT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", json: "application/json", xml: "text/xml",
  csv: "text/csv", txt: "text/plain", pdf: "application/pdf", zip: "application/zip", mp4: "video/mp4", mp3: "audio/mpeg",
  apk: "application/vnd.android.package-archive", db: "application/octet-stream", woff2: "font/woff2",
};
export const MIME_EXT: Record<string, string> = {};
for (const [e, m] of Object.entries(EXT_MIME)) MIME_EXT[m] ??= e;

export function mimeFromFilename(filename: string): string | null {
  const fragment = filename.indexOf("#");
  if (fragment >= 0) filename = filename.slice(0, fragment);
  if (filename.endsWith("/")) return "text/html";
  const slash = filename.lastIndexOf("/");
  if (slash >= 0) filename = filename.slice(slash);
  let dot = -1;
  do {
    const mime = EXT_MIME[filename.slice(dot + 1).toLowerCase()];
    if (mime && (slash < 0 || dot >= 0)) return mime;
    dot = filename.indexOf(".", dot + 1);
  } while (dot >= 0);
  return null;
}
