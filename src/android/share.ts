import { JIntent, registerSystemActivity } from "./intent";
import { contentResolver } from "./contentresolver";
import type { JUri } from "./net";
import { JParcelFileDescriptor } from "./os";
import { toJsArray } from "../jvm/natives/jutil";
import { vcall } from "../jvm/natives/jlang";
import { rt } from "../jvm/runtime";
import { zipSync } from "fflate";

const EXTRA_INTENT = "android.intent.extra.INTENT";
const EXTRA_STREAM = "android.intent.extra.STREAM";
const EXTRA_TEXT = "android.intent.extra.TEXT";
const EXTRA_SUBJECT = "android.intent.extra.SUBJECT";

async function shareFile(uri: JUri, mime: string): Promise<File> {
  const descriptor = await vcall(contentResolver(), "openFileDescriptor", "(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;", uri, "r");
  if (!(descriptor instanceof JParcelFileDescriptor)) throw rt.mkThrowable("java/io/FileNotFoundException", uri.uri);
  const name = decodeURIComponent(uri.uri.split(/[?#]/, 1)[0]!.split("/").pop() || "shared-file");
  const file = new File([descriptor.bytes.slice()], name, { type: mime });
  await vcall(descriptor, "close", "()V");
  return file;
}

function hostAction(browser: Window, headingText: string, buttonText: string, run: () => Promise<unknown> | unknown): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const doc = browser.document;
    const panel = doc.createElement("div");
    panel.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:#0008";
    const card = doc.createElement("div");
    card.style.cssText = "background:#fff;color:#222;border-radius:16px;padding:24px;font:16px system-ui;box-shadow:0 12px 40px #0005;max-width:340px";
    const heading = doc.createElement("div");
    heading.textContent = headingText;
    heading.style.cssText = "font-weight:600;margin-bottom:16px";
    const button = doc.createElement("button");
    button.textContent = buttonText;
    button.style.cssText = "padding:8px 18px;margin-right:12px";
    const cancel = doc.createElement("button");
    cancel.textContent = "Cancel";
    cancel.style.cssText = "padding:8px 18px";
    card.append(heading, button, cancel);
    panel.append(card);
    doc.body.append(panel);
    button.addEventListener("click", () => {
      button.disabled = true;
      cancel.disabled = true;
      let pending: Promise<unknown> | unknown;
      try { pending = run(); }
      catch (error) { panel.remove(); reject(error); return; }
      Promise.resolve(pending).then(() => { panel.remove(); resolve(true); }, (error: unknown) => {
        panel.remove();
        if ((error as { name?: string })?.name === "AbortError") resolve(false);
        else reject(error);
      });
    }, { once: true });
    cancel.addEventListener("click", () => { panel.remove(); resolve(false); }, { once: true });
  });
}

async function saveFiles(browser: Window, files: File[]): Promise<boolean> {
  let file = files[0];
  if (files.length > 1) {
    const entries: Record<string, Uint8Array> = {};
    for (const item of files) {
      let name = item.name, suffix = 2;
      while (Object.hasOwn(entries, name)) {
        const dot = item.name.lastIndexOf(".");
        name = dot > 0 ? `${item.name.slice(0, dot)} (${suffix++})${item.name.slice(dot)}` : `${item.name} (${suffix++})`;
      }
      entries[name] = new Uint8Array(await item.arrayBuffer());
    }
    file = new File([zipSync(entries)], "shared-files.zip", { type: "application/zip" });
  }
  return hostAction(browser, `Save ${files.length} file${files.length === 1 ? "" : "s"}`, "Save file", () => {
    const href = URL.createObjectURL(file);
    const link = browser.document.createElement("a");
    link.href = href; link.download = file.name;
    browser.document.body.append(link);
    link.click(); link.remove();
    browser.setTimeout(() => URL.revokeObjectURL(href), 60_000);
  });
}

async function share(intent: JIntent): Promise<JIntent | null> {
  const target = intent.extras.map.get(EXTRA_INTENT);
  if (!(target instanceof JIntent)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Chooser requires an Intent");
  if (target.action !== "android.intent.action.SEND" && target.action !== "android.intent.action.SEND_MULTIPLE")
    throw rt.unimplemented("Chooser for " + target.action);

  const raw = target.extras.map.get(EXTRA_STREAM);
  const uris = raw == null ? [] : target.action === "android.intent.action.SEND_MULTIPLE" ? await toJsArray(raw) : [raw];
  const files = await Promise.all(uris.map((uri) => shareFile(uri as JUri, target.typeStr || "application/octet-stream")));
  const data: ShareData = {
    text: String(target.extras.map.get(EXTRA_TEXT) ?? ""),
    title: String(target.extras.map.get(EXTRA_SUBJECT) ?? ""),
    ...(files.length ? { files } : {}),
  };
  const browser = window.parent;
  if (!browser.navigator.share || files.length && !browser.navigator.canShare?.({ files })) {
    if (!files.length) throw rt.unimplemented("Browser text sharing");
    return await saveFiles(browser, files) ? new JIntent() : null;
  }
  try {
    if (browser.navigator.userActivation?.isActive) await browser.navigator.share(data);
    else if (!(await hostAction(browser, files.length ? `Share ${files.length} file${files.length === 1 ? "" : "s"}` : "Share",
      "Share", () => browser.navigator.share(data)))) return null;
    return new JIntent();
  }
  catch (error) {
    if ((error as { name?: string })?.name === "AbortError") return null;
    if ((error as { name?: string })?.name === "NotAllowedError" && files.length)
      return await saveFiles(browser, files) ? new JIntent() : null;
    throw error;
  }
}

registerSystemActivity("android.intent.action.CHOOSER", share);
