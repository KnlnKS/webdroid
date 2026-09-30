import { JIntent } from "../android/intent";
import { contentResolver, openPfd } from "../android/contentresolver";
import { mkUri } from "../android/net";
import { vcall } from "../jvm/natives/jlang";
import { toJsArray } from "../jvm/natives/jcoll";
import { csText } from "../jvm/natives/jchars";

async function sharedFiles(intent: JIntent): Promise<File[]> {
  const stream = intent.extras.map.get("android.intent.extra.STREAM");
  const entries = stream == null ? [] : intent.action === "android.intent.action.SEND_MULTIPLE" ? await toJsArray(stream) : [stream];
  const files: File[] = [];
  for (const entry of entries) {
    const uri = (entry as { uri?: string })?.uri;
    if (!uri) continue;
    const parsed = mkUri(uri);
    const mime = await vcall(contentResolver(), "getType", "(Landroid/net/Uri;)Ljava/lang/String;", parsed) as string | null;
    const descriptor = await openPfd(parsed, "r");
    try {
      const name = decodeURIComponent(uri.split(/[?#]/, 1)[0].split("/").pop() || "shared-file");
      files.push(new File([descriptor.bytes as BlobPart], name, { type: mime || intent.typeStr || "application/octet-stream" }));
    } finally { await vcall(descriptor, "close", "()V"); }
  }
  return files;
}

function download(files: File[]) {
  for (const file of files) {
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export async function shareIntent(intent: JIntent): Promise<JIntent | null> {
  const target = intent.action === "android.intent.action.CHOOSER"
    ? intent.extras.map.get("android.intent.extra.INTENT") as JIntent | undefined : intent;
  if (!target) throw new Error("Chooser has no target intent");
  const text = target.extras.map.get("android.intent.extra.TEXT");
  const message = text == null ? "" : await csText(text);
  const files = await sharedFiles(target);
  const title = target.extras.map.get("android.intent.extra.SUBJECT");
  const shareData: ShareData = { ...(message ? { text: message } : {}), ...(files.length ? { files } : {}),
    ...(title == null ? {} : { title: await csText(title) }) };
  if (!message && !files.length) throw new Error("Share intent has no content");
  const shared = (run: () => unknown) => async () => { await run(); return new JIntent(); };
  return choose(title == null ? "Share" : await csText(title), [
    ...typeof navigator.share === "function" && (!files.length || !navigator.canShare || navigator.canShare(shareData))
      ? [{ label: "Share…", run: shared(() => navigator.share(shareData)) }] : [],
    ...files.length ? [{ label: files.length === 1 ? "Download file" : "Download files", run: shared(() => download(files)) }] : [],
    ...message ? [{ label: "Copy text", run: shared(() => navigator.clipboard.writeText(message)) }] : [],
  ]);
}

/** The browser as the device's default web handler: a new tab, or when the page may not open one
 *  outside a user gesture, a sheet whose button is that gesture. A store link goes to the web store. */
export async function openInBrowser(uri: string): Promise<null> {
  const url = uri.replace(/^market:\/\/details/i, "https://play.google.com/store/apps/details").replace(/^market:\/\//i, "https://play.google.com/store/");
  if (!/^https?:/i.test(url)) throw new Error("No browser for " + uri);
  const open = () => { const tab = window.open(url, "_blank"); if (tab) tab.opener = null; return tab; };
  if (!open()) await choose(new URL(url).host, [{ label: "Open in new tab", run: open }]);
  return null;
}

/** The chooser's list of activities for an intent: the index picked, or null when dismissed. */
export const chooseActivity = (heading: string, labels: string[]): Promise<number | null> =>
  choose(heading, labels.map((label, i) => ({ label, run: () => i })));

/** A modal sheet with one button per choice and Cancel. Resolves with the chosen choice's
 *  result, or null when dismissed; a choice the browser aborted counts as dismissed. */
function choose<T>(title: string, choices: { label: string; run: () => T | Promise<T> }[]): Promise<T | null> {
  const dialog = document.createElement("dialog");
  dialog.dataset.webdroidShare = "";
  dialog.style.cssText = "border:0;border-radius:12px;padding:20px;min-width:260px;max-width:90vw;color:#222;background:#fff;box-shadow:0 12px 40px #0005;font:16px sans-serif";
  const heading = document.createElement("div");
  heading.textContent = title;
  heading.style.cssText = "font-weight:600;margin-bottom:16px";
  dialog.append(heading);
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:12px;flex-wrap:wrap";
  return new Promise<T | null>((resolve, reject) => {
    for (const { label, run } of [...choices, { label: "Cancel", run: () => null }]) {
      const element = document.createElement("button");
      element.type = "button"; element.textContent = label;
      element.style.cssText = "padding:8px 14px;border:1px solid #ccc;border-radius:8px;background:#f7f7f7;cursor:pointer";
      element.onclick = () => { void (async () => {
        try { const value = await run(); dialog.close(); resolve(value); }
        catch (error) {
          dialog.close();
          if ((error as { name?: string }).name === "AbortError") resolve(null);
          else reject(error);
        }
      })(); };
      actions.append(element);
    }
    dialog.append(actions);
    document.body.append(dialog);
    dialog.addEventListener("close", () => { dialog.remove(); resolve(null); }, { once: true });
    dialog.showModal();
  });
}
