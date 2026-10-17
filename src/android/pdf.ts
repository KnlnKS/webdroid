// PDF output: android.graphics.pdf.PdfDocument (android_graphics_pdf_PdfDocument.cpp) and the file
// the print dialog prints. A page's canvas records as an SkPicture does, and writeTo draws each page
// into the document. AOSP draws through SkPDF, which CanvasKit does not ship, and a display list
// holds browser objects no PDF operator can read back (Path2D, gradients, deferred replays), so a
// page is rasterised at print resolution and stored losslessly.
import { rt, driven, awaited, type Gen } from "../jvm/runtime.ts";
import { handle, deref, release } from "./handles.ts";
import { NativeCanvas } from "./canvas.ts";
import { Recorder, replay, replayFor, type DisplayList } from "./recording.ts";
import { writeThrough } from "../jvm/natives/jio.ts";

/** a page of w×h points filled by one image */
export type PdfPage = { w: number; h: number; width: number; height: number; filter: "DCTDecode" | "FlateDecode"; data: Uint8Array };

const num = (v: number) => String(Math.round(v * 1000) / 1000);
export async function pdfFile(pages: PdfPage[]): Promise<Uint8Array> {
  const enc = new TextEncoder(), parts: Uint8Array[] = [], offsets: number[] = [];
  let size = 0;
  const put = (part: string | Uint8Array) => { const bytes = typeof part === "string" ? enc.encode(part) : part; parts.push(bytes); size += bytes.length; };
  const obj = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = size;
    put(`${n} 0 obj\n${body}`);
    if (stream) { put(`stream\n`); put(stream); put(`\nendstream`); }
    put(`\nendobj\n`);
  };
  put("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  pages.forEach((page, i) => {
    const n = 3 + i * 3, w = num(page.w), h = num(page.h), draw = enc.encode(`q ${w} 0 0 ${h} 0 0 cm /Im Do Q`);
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    obj(n + 1, `<< /Length ${draw.length} >>\n`, draw);
    obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${page.filter} /Length ${page.data.length} >>\n`, page.data);
  });
  const xref = size, count = 3 + pages.length * 3;
  put(`xref\n0 ${count}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`);
  put(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Uint8Array(await new Blob(parts as Uint8Array<ArrayBuffer>[]).arrayBuffer());
}

/** the print dialog's default resolution; a page past MAX_PIXELS rasterises coarser */
const DPI = 300, MAX_PIXELS = 1 << 25;
class Page {
  readonly w: number; readonly h: number; readonly content: [number, number, number, number];
  readonly recorder = new Recorder();
  ops: DisplayList = [];
  constructor(w: number, h: number, content: [number, number, number, number]) { this.w = w; this.h = h; this.content = content; }
}
/** SkDocument::beginPage: the picture drawn translated to the content rect and clipped to it */
async function rasterPage(page: Page): Promise<PdfPage> {
  const scale = Math.min(DPI / 72, Math.sqrt(MAX_PIXELS / Math.max(1, page.w * page.h)));
  const width = Math.max(1, Math.ceil(page.w * scale)), height = Math.max(1, Math.ceil(page.h * scale));
  // a CPU raster: reading back a GPU one cost 360 ms of the first page's 430
  const ctx = new OffscreenCanvas(width, height).getContext("2d", { alpha: false, willReadFrequently: true })!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height);
  ctx.scale(scale, scale);
  const [l, t, r, b] = page.content;
  ctx.beginPath(); ctx.rect(l, t, r - l, b - t); ctx.clip();
  ctx.translate(l, t);
  replayFor(NativeCanvas.over(ctx, r - l, b - t), () => replay(ctx, page.ops));
  const px = ctx.getImageData(0, 0, width, height).data, rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { rgb[j] = px[i]; rgb[j + 1] = px[i + 1]; rgb[j + 2] = px[i + 2]; }
  const data = new Uint8Array(await new Response(new Blob([rgb]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  return { w: page.w, h: page.h, width, height, filter: "FlateDecode", data };
}

class NativePdfDocument { pages: Page[] = []; current: Page | null = null; }
const documentAt = (h: bigint) => deref<NativePdfDocument>(h);
rt.registerJnis("android/graphics/pdf/PdfDocument", {
  "nativeCreateDocument()J": () => handle(new NativePdfDocument()),
  // the PdfCanvas records the content rect's size, as SkPictureRecorder::beginRecording does
  "nativeStartPage(JIIIIII)J": (h: bigint, w: number, ht: number, l: number, t: number, r: number, b: number) => {
    const doc = documentAt(h), page = new Page(w, ht, [Math.max(0, l), Math.max(0, t), Math.min(w, r), Math.min(ht, b)]);
    doc.pages.push(page); doc.current = page;
    return handle(NativeCanvas.over(page.recorder.ctx, r - l, b - t));
  },
  "nativeFinishPage(J)V": (h: bigint) => {
    const doc = documentAt(h);
    if (doc.current) { doc.current.ops = doc.current.recorder.take(); doc.current = null; }
  },
  "nativeWriteTo(JLjava/io/OutputStream;[B)V": driven(function* (h: bigint, out: unknown, storage: Int8Array): Gen {
    const pages: PdfPage[] = [];
    for (const page of documentAt(h).pages) pages.push(yield* awaited(rasterPage(page)));
    yield* writeThrough(out, storage, yield* awaited(pdfFile(pages)));
  }),
  "nativeClose(J)V": (h: bigint) => { release(h); },
});
