// Printing: the print service (IPrintManager) and the spooler's print dialog over the browser's
// print. AOSP's PrintManager hands the service the app's document adapter and starts the dialog the
// service answers with; the dialog asks the adapter for its PDF and prints it in the browser.
import { JObj, rt, driven, awaited, type Gen } from "../jvm/runtime.ts";
import { jarray, i8 } from "../jvm/abi.ts";
import { after, newObj, vcall, scall, staticField } from "../jvm/natives/jentry.ts";
import { csText } from "../jvm/natives/jchars.ts";
import { newArrayList } from "../jvm/natives/jcoll.ts";
import { wallMillis } from "../guest-clock.ts";
import { vfs } from "../shell/vfs.ts";
import { hostUi } from "../shell/host-ui.ts";
import { hostService } from "./binder.ts";
import { newIntent, registerSystemActivity, type JIntent } from "./intent.ts";
import { mkUri } from "./net.ts";
import { pendingTransport, intentSender } from "./pendingintent.ts";
import { encodeIntent } from "./intentipc.ts";
import { pdfFile, type PdfPage } from "./pdf.ts";
import type { WebViewChromium as JWebView } from "./webkit.ts";

const S = "Ljava/lang/String;", ID = "Landroid/print/PrintJobId;", PA = "Landroid/print/PrintAttributes;";
const PRINT_DIALOG = "android.print.PRINT_DIALOG";
const STATE_CREATED = 1, STATE_STARTED = 3, STATE_COMPLETED = 5, STATE_FAILED = 6, STATE_CANCELED = 7;
type Job = { info: JObj; adapter: JObj };
const jobs = new Map<string, Job>();
const jobKey = (id: JObj): string | Promise<string> => vcall(id, "flattenToString", `()${S}`);
const setState = (job: Job, state: number) => vcall(job.info, "setState", "(I)V", state);

hostService("print", "webdroid/PrintManagerService", "android/print/IPrintManager$Stub", {
  // UserState.print: a created job, and the dialog that configures and runs it
  [`print(${S}Landroid/print/IPrintDocumentAdapter;${PA}${S}II)Landroid/os/Bundle;`]:
    driven(function* (name: string, adapter: JObj, attributes: JObj | null, pkg: string, appId: number): Gen {
      const id = yield newObj("android/print/PrintJobId"), info = yield newObj("android/print/PrintJobInfo");
      yield vcall(info, "setId", `(${ID})V`, id);
      yield vcall(info, "setLabel", `(${S})V`, name);
      yield vcall(info, "setAppId", "(I)V", appId);
      yield vcall(info, "setAttributes", `(${PA})V`, attributes);
      yield vcall(info, "setCopies", "(I)V", 1);
      yield vcall(info, "setCreationTime", "(J)V", BigInt(Math.floor(wallMillis())));
      yield vcall(info, "setState", "(I)V", STATE_CREATED);
      const key: string = yield jobKey(id);
      jobs.set(key, { info, adapter });
      const intent: JIntent = yield* awaited(newIntent(PRINT_DIALOG));
      yield vcall(intent, "setData", "(Landroid/net/Uri;)Landroid/content/Intent;", yield* awaited(mkUri(`printjob:${key}`)));
      // FLAG_ONE_SHOT | FLAG_IMMUTABLE, as the spooler makes it
      const record = yield* awaited(pendingTransport.create(pkg, "activity", 0, 0x44000000, yield* awaited(encodeIntent(intent))));
      if (record === null) return null;
      const sender = yield newObj("android/content/IntentSender", "(Landroid/content/IIntentSender;)V", yield* awaited(intentSender(record)));
      const result = yield newObj("android/os/Bundle");
      yield vcall(result, "putParcelable", `(${S}Landroid/os/Parcelable;)V`, "android.print.intent.extra.EXTRA_PRINT_JOB", info);
      yield vcall(result, "putParcelable", `(${S}Landroid/os/Parcelable;)V`, "android.print.intent.extra.EXTRA_PRINT_DIALOG_INTENT", sender);
      return result;
    }),
  [`getPrintJobInfo(${ID}II)Landroid/print/PrintJobInfo;`]: (id: JObj) => after(jobKey(id), (key) => jobs.get(key)?.info ?? null),
  "getPrintJobInfos(II)Ljava/util/List;": () => newArrayList([...jobs.values()].map((job) => job.info)),
  [`cancelPrintJob(${ID}II)V`]: (id: JObj) => after(jobKey(id), (key) => { const job = jobs.get(key); return job && setState(job, STATE_CANCELED); }),
});

/** an adapter callback's outcome: its result, null when canceled, or the failure's message. Each
 *  callback class has its own ctor, which takes on its Stub as supertype. */
const printCallback = () => class extends JObj {
  settle: (outcome: unknown) => void = () => {};
  readonly done = new Promise<unknown>((resolve) => { this.settle = resolve; });
};
type JPrintCallback = InstanceType<ReturnType<typeof printCallback>>;
class PrintFailure { readonly message: string; constructor(message: string) { this.message = message; } }
const failed = function (this: JPrintCallback, error: unknown) { return after(csText(error), (message) => this.settle(new PrintFailure(message))); };
const canceled = function (this: JPrintCallback) { this.settle(null); };
rt.register({ name: "webdroid/PrintLayoutCallback", ctor: printCallback(), sup: "android/print/ILayoutResultCallback$Stub", methods: {
  "onLayoutStarted(Landroid/os/ICancellationSignal;I)V": () => {},
  "onLayoutFinished(Landroid/print/PrintDocumentInfo;ZI)V": function (this: JPrintCallback, info: JObj) { this.settle(info); },
  "onLayoutFailed(Ljava/lang/CharSequence;I)V": failed,
  "onLayoutCanceled(I)V": canceled,
} });
rt.register({ name: "webdroid/PrintWriteCallback", ctor: printCallback(), sup: "android/print/IWriteResultCallback$Stub", methods: {
  "onWriteStarted(Landroid/os/ICancellationSignal;I)V": () => {},
  "onWriteFinished([Landroid/print/PageRange;I)V": function (this: JPrintCallback, pages: JObj[]) { this.settle(pages); },
  "onWriteFailed(Ljava/lang/CharSequence;I)V": failed,
  "onWriteCanceled(I)V": canceled,
} });

const B = "Landroid/print/PrintAttributes$Builder;";
/** the app's attributes, what it left unset taken from the spooler's defaults for this device's
 *  en-US locale: US letter at 300 dpi, in colour, with no margins */
const jobAttributes = driven(function* (given: JObj | null): Gen<JObj> {
  const get = (name: string, desc: string) => given && vcall(given, name, desc);
  const builder = yield newObj("android/print/PrintAttributes$Builder");
  yield vcall(builder, "setMediaSize", `(Landroid/print/PrintAttributes$MediaSize;)${B}`,
    (yield get("getMediaSize", "()Landroid/print/PrintAttributes$MediaSize;")) ?? (yield staticField("android/print/PrintAttributes$MediaSize", "NA_LETTER")));
  yield vcall(builder, "setResolution", `(Landroid/print/PrintAttributes$Resolution;)${B}`,
    (yield get("getResolution", "()Landroid/print/PrintAttributes$Resolution;")) ?? (yield newObj("android/print/PrintAttributes$Resolution", `(${S}${S}II)V`, "PDF resolution", "PDF resolution", 300, 300)));
  yield vcall(builder, "setColorMode", `(I)${B}`, (yield get("getColorMode", "()I")) || 2);
  yield vcall(builder, "setMinMargins", `(Landroid/print/PrintAttributes$Margins;)${B}`,
    (yield get("getMinMargins", "()Landroid/print/PrintAttributes$Margins;")) ?? (yield staticField("android/print/PrintAttributes$Margins", "NO_MARGINS")));
  return vcall(builder, "build", `()${PA}`);
});
let spooled = 0;
/** the document the adapter lays out and writes for every page, or why it has none */
function* documentOf(job: Job): Gen<Uint8Array | PrintFailure | null> {
  const adapter = job.adapter, attributes: JObj = yield* awaited(jobAttributes(yield vcall(job.info, "getAttributes", `()${PA}`)));
  yield vcall(adapter, "start", "()V");
  try {
    const layout: JPrintCallback = yield newObj("webdroid/PrintLayoutCallback");
    yield vcall(adapter, "layout", `(${PA}${PA}Landroid/print/ILayoutResultCallback;Landroid/os/Bundle;I)V`, null, attributes, layout, yield newObj("android/os/Bundle"), 0);
    const laidOut = yield* awaited(layout.done);
    if (!laidOut || laidOut instanceof PrintFailure) return laidOut as PrintFailure | null;
    const path = `/data/local/tmp/print-${++spooled}.pdf`;
    const fd = yield scall("android/os/ParcelFileDescriptor", "open", "(Ljava/io/File;I)Landroid/os/ParcelFileDescriptor;",
      yield newObj("java/io/File", `(${S})V`, path), 0x3c000000);
    try {
      const write: JPrintCallback = yield newObj("webdroid/PrintWriteCallback");
      yield vcall(adapter, "write", "([Landroid/print/PageRange;Landroid/os/ParcelFileDescriptor;Landroid/print/IWriteResultCallback;I)V",
        jarray([yield staticField("android/print/PageRange", "ALL_PAGES")], "Landroid/print/PageRange;"), fd, write, 0);
      const written = yield* awaited(write.done);
      if (!written || written instanceof PrintFailure) return written as PrintFailure | null;
      return (yield* awaited(vfs.readFile(path))) ?? new PrintFailure("the document was not written");
    } finally { yield vcall(fd, "close", "()V"); vfs.delete(path); }
  } finally { yield vcall(adapter, "finish", "()V"); }
}
// PrintActivity: the job's document, printed (or saved as a PDF) through the browser's dialog
registerSystemActivity(PRINT_DIALOG, driven(function* (intent: JIntent): Gen<null> {
  const data = yield vcall(intent, "getData", "()Landroid/net/Uri;");
  const job = data && jobs.get(yield vcall(data, "getSchemeSpecificPart", `()${S}`));
  if (!job) return null;
  yield setState(job, STATE_STARTED);
  const pdf = yield* documentOf(job);
  if (pdf instanceof Uint8Array) { yield* awaited(hostUi().printPdf(pdf)); yield setState(job, STATE_COMPLETED); }
  else {
    if (pdf) yield vcall(job.info, "setStatus", "(Ljava/lang/CharSequence;)V", pdf.message);
    yield setState(job, pdf ? STATE_FAILED : STATE_CANCELED);
  }
  return null;
}));

// WebView's adapter (AwPrintDocumentAdapter, which Chromium answers with its own PDF): one document
// of unknown length, written as the page's snapshot cut into pages of the chosen media
class JWebPrintAdapter extends JObj { view: JWebView | null = null; name = ""; media: JObj | null = null; }
const LR = "Landroid/print/PrintDocumentAdapter$LayoutResultCallback;", WR = "Landroid/print/PrintDocumentAdapter$WriteResultCallback;";
rt.register({ name: "webdroid/WebViewPrintAdapter", ctor: JWebPrintAdapter, sup: "android/print/PrintDocumentAdapter", methods: {
  [`onLayout(${PA}${PA}Landroid/os/CancellationSignal;${LR}Landroid/os/Bundle;)V`]:
    driven(function* (this: JWebPrintAdapter, _old: JObj | null, attributes: JObj, _cancel: JObj, callback: JObj): Gen {
      this.media = yield vcall(attributes, "getMediaSize", "()Landroid/print/PrintAttributes$MediaSize;");
      const builder = yield newObj("android/print/PrintDocumentInfo$Builder", `(${S})V`, this.name);
      yield vcall(builder, "setContentType", "(I)Landroid/print/PrintDocumentInfo$Builder;", 0);
      yield vcall(callback, "onLayoutFinished", "(Landroid/print/PrintDocumentInfo;Z)V", yield vcall(builder, "build", "()Landroid/print/PrintDocumentInfo;"), 1);
    }),
  [`onWrite([Landroid/print/PageRange;Landroid/os/ParcelFileDescriptor;Landroid/os/CancellationSignal;${WR})V`]:
    driven(function* (this: JWebPrintAdapter, _pages: JObj[], fd: JObj, _cancel: JObj, callback: JObj): Gen {
      const w: number = yield vcall(this.media, "getWidthMils", "()I"), h: number = yield vcall(this.media, "getHeightMils", "()I");
      let pdf: Uint8Array;
      try {
        const image = yield* awaited(this.view!.bitmapSnapshot());
        try { pdf = yield* awaited(pagedPdf(image, w * 0.072, h * 0.072)); } finally { image.close(); }
      } catch (error) {
        yield vcall(callback, "onWriteFailed", "(Ljava/lang/CharSequence;)V", (error as { msg?: string }).msg ?? String(error));
        return;
      }
      const out = yield newObj("java/io/FileOutputStream", "(Ljava/io/FileDescriptor;)V", yield vcall(fd, "getFileDescriptor", "()Ljava/io/FileDescriptor;"));
      yield vcall(out, "write", "([B)V", i8(pdf));
      yield vcall(callback, "onWriteFinished", "([Landroid/print/PageRange;)V", jarray([yield staticField("android/print/PageRange", "ALL_PAGES")], "Landroid/print/PageRange;"));
    }),
} });
export const webPrintAdapter = driven(function* (view: JWebView, name: string): Gen<JObj> {
  const adapter: JWebPrintAdapter = yield newObj("webdroid/WebViewPrintAdapter");
  adapter.view = view; adapter.name = name;
  return adapter;
});

/** a PDF of `image` cut into w×h pt pages across its width, each page a JPEG */
async function pagedPdf(image: ImageBitmap, w: number, h: number): Promise<Uint8Array> {
  const width = image.width, height = Math.round(width * h / w), canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext("2d")!;
  const pages: PdfPage[] = [];
  for (let y = 0; y < image.height; y += height) {
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, -y);
    const data = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 })).arrayBuffer());
    pages.push({ w, h, width, height, filter: "DCTDecode", data });
  }
  return pdfFile(pages);
}
