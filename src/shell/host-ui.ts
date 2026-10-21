// The browser UI a system activity shows over its caller: DocumentsUI's pickers, the share sheet and
// chooser, a browser tab and the print dialog. It needs the page's document and
// the user's gesture there, so a process Worker reaches it through the broker.

import { methodsOf } from "./rpc.ts";

// lib.dom types the handles but not the pickers
declare global {
  interface Window {
    showDirectoryPicker?(o?: { mode?: string; id?: string }): Promise<FileSystemDirectoryHandle>;
    showOpenFilePicker?(o?: { multiple?: boolean; types?: unknown[] }): Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?(o?: { suggestedName?: string }): Promise<FileSystemFileHandle>;
  }
}

export type FilePick = { multiple?: boolean; save?: string; mime?: string | null };
/** a picker resolves null when the user backs out, undefined when the browser has none */
export type HostUi = {
  pickDirectory(): Promise<FileSystemDirectoryHandle | null | undefined>;
  pickFiles(pick: FilePick): Promise<FileSystemFileHandle[] | null | undefined>;
  /** whether the user shared, downloaded or copied it */
  shareSheet(title: string | null, text: string, files: File[]): Promise<boolean>;
  openTab(url: string): Promise<void>;
  /** the index picked, or null when dismissed */
  chooseOne(heading: string, labels: string[]): Promise<number | null>;
  printPdf(pdf: Uint8Array): Promise<void>;
};
export const hostUiMethods = methodsOf<HostUi>()(["pickDirectory", "pickFiles", "shareSheet", "openTab", "chooseOne", "printPdf"]);

/** Chrome only opens a picker, or re-grants a permission, while a user gesture is still warm.
 *  A request that arrives too late is parked and replayed on the next press rather than lost. */
let pending: (() => void)[] = [];
export function onNextGesture(fn: () => void): void {
  pending.push(fn);
  if (pending.length > 1) return;
  addEventListener("pointerdown", () => {
    const q = pending;
    pending = [];
    for (const f of q) f();
  }, { capture: true, once: true });
}
async function withGesture<T>(open: () => Promise<T>): Promise<T | null> {
  try { return await open(); }
  catch (error) {
    if ((error as { name?: string })?.name !== "SecurityError") return null;
    return new Promise<T>((resolve, reject) => onNextGesture(() => open().then(resolve, reject))).catch(() => null);
  }
}

function download(files: File[]): void {
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

/** A modal sheet with one button per choice and Cancel. Resolves with the chosen choice's
 *  result, or null when dismissed; a choice the browser aborted counts as dismissed. */
function choose<T>(title: string, choices: { label: string; run: () => T | Promise<T> }[]): Promise<T | null> {
  const dialog = document.createElement("dialog");
  dialog.dataset.webdroidShare = "";
  dialog.style.cssText = "border:0;border-radius:12px;padding:20px;min-width:260px;max-width:90vw;color:#222;background:#fff;box-shadow:0 12px 40px #0005;font:16px sans-serif";
  const heading = document.createElement("div");
  heading.textContent = title;
  heading.style.cssText = "font-weight:600;margin-bottom:16px;white-space:pre-line";
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

let shown: { frame: HTMLIFrameElement; url: string } | null = null;
const pageUi: HostUi = {
  async pickDirectory() {
    const show = window.showDirectoryPicker;
    return show && withGesture(() => show.call(window, { mode: "readwrite", id: "webdroid" }));
  },
  async pickFiles({ multiple, save, mime }) {
    if (save) {
      const show = window.showSaveFilePicker;
      return show && withGesture(() => show.call(window, { suggestedName: save }).then((h) => [h]));
    }
    const show = window.showOpenFilePicker;
    return show && withGesture(() => show.call(window, { multiple: !!multiple, ...(mime ? { types: [{ accept: { [mime]: [] } }] } : {}) }));
  },
  async shareSheet(title, text, files) {
    const data: ShareData = { ...(text ? { text } : {}), ...(files.length ? { files } : {}), ...(title == null ? {} : { title }) };
    // the user's choice runs in their click, for the gesture the browser asks of it
    const shared = (run: () => unknown) => async () => { await run(); return true; };
    return !!await choose(title ?? "Share", [
      ...typeof navigator.share === "function" && (!files.length || !navigator.canShare || navigator.canShare(data))
        ? [{ label: "Share…", run: shared(() => navigator.share(data)) }] : [],
      ...files.length ? [{ label: files.length === 1 ? "Download file" : "Download files", run: shared(() => download(files)) }] : [],
      ...text ? [{ label: "Copy text", run: shared(() => navigator.clipboard.writeText(text)) }] : [],
    ]);
  },
  // a new tab, or when the page may not open one outside a user gesture, a sheet whose button is that gesture
  async openTab(url) {
    const open = () => { const tab = window.open(url, "_blank"); if (tab) tab.opener = null; return tab; };
    if (!open()) await choose(new URL(url).host, [{ label: "Open in new tab", run: open }]);
  },
  chooseOne: (heading, labels) => choose(heading, labels.map((label, i) => ({ label, run: () => i }))),
  // Chrome's viewer prints a PDF from a frame of its own, kept until the next job so the dialog outlives the call
  printPdf(pdf) {
    if (shown) { shown.frame.remove(); URL.revokeObjectURL(shown.url); }
    const frame = document.createElement("iframe"), url = URL.createObjectURL(new Blob([pdf as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
    frame.style.cssText = "position:fixed;left:-10000px;width:1px;height:1px;border:0";
    shown = { frame, url };
    return new Promise((resolve) => {
      frame.onload = () => { try { frame.contentWindow?.print(); } finally { resolve(); } };
      frame.src = url;
      document.body.append(frame);
    });
  },
};
let ui = (): HostUi => pageUi;
export const hostUi = (): HostUi => ui();
export const useHostUi = (remote: () => HostUi): void => { ui = remote; };
