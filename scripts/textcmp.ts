// Does AOSP's own StaticLayout break lines where ours does?
//
//   bun scripts/textcmp.ts            # needs `bun run dev` (WEBDROID_URL picks the server)
//
// Two loads of the SAME bundle, one with android/text/{Layout,StaticLayout} and
// android/graphics/text/ served by vendor/aosp/framework.jar and one without, over the same
// paragraphs through the same StaticLayout.Builder call. They should agree on the greedy
// strategy, because both break through text.ts's greedyBreaks — AOSP's Layout and StaticLayout
// declare zero natives, so what the cut swaps is thousands of lines of real line-breaking Java
// sitting on the MeasuredText/LineBreaker delegates.
//
// Text measurement needs a Canvas2D context, so this cannot be `bun run fwtest`: it has to be
// a page. The page must be a REAL one — the MCP browser is throttled (see AGENTS.md).
import { BASE_URL } from "../tests/e2e/lib/util";
import { launchBrowser, CONTEXT_OPTS } from "../tests/e2e/drivers/webdroid";


const CUT = "android/text/Layout,android/text/StaticLayout,android/graphics/text/";

const PARAGRAPHS: [string, number, number][] = [        // text, width px, text size px
  ["The quick brown fox jumps over the lazy dog", 200, 24],
  ["The quick brown fox jumps over the lazy dog", 720, 24],
  ["Supercalifragilisticexpialidocious antidisestablishmentarianism", 180, 24],
  ["https://example.com/a/very/long/path/that/cannot/be/broken/on/a/space", 200, 24],
  ["one\ntwo three four five six seven eight nine ten\n\neleven", 160, 28],
  ["a b c d e f g h i j k l m n o p q r s t u v w x y z", 100, 20],
];

async function layouts(cut: boolean) {
  const browser = await launchBrowser();
  const page = await browser.newPage(CONTEXT_OPTS);
  const resp = await page.goto(cut ? `${BASE_URL}/?bytecode=${encodeURIComponent(CUT)}` : BASE_URL, { waitUntil: "domcontentloaded" });
  if (!resp?.ok()) throw new Error(`dev server not reachable at ${BASE_URL} — run \`bun run dev\``);
  await page.waitForFunction(() => !!(globalThis as any).wd, null, { timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  // BOTH sides boot. Native specs get their mangled methods at rt.link, which boot is what
  // runs (see "Native classes need rt.link() before direct TS instantiation" in AGENTS.md), and
  // the framework dex a cut resolves against is fetched by the same boot.
  await page.evaluate(() => void (globalThis as any).wd.boot("FitNotes.apk"));
  await page.waitForFunction(() => (globalThis as any).wd.perf.bootMs > 0, null, { timeout: 120_000 });
  const out = await page.evaluate(async (paras) => {
    const wd = (globalThis as any).wd;
    const res: { lines: number; breaks: number[]; widths: number[]; err?: string }[] = [];
    for (const [text, width, size] of paras as [string, number, number][]) {
      try {
        const paint = await wd.newObj("android/text/TextPaint", "()V");
        await wd.vcall(paint, "setTextSize", "(F)V", size);
        const b = await wd.scall("android/text/StaticLayout$Builder", "obtain",
          "(Ljava/lang/CharSequence;IILandroid/text/TextPaint;I)Landroid/text/StaticLayout$Builder;",
          text, 0, text.length, paint, width);
        const l = await wd.vcall(b, "build", "()Landroid/text/StaticLayout;");
        const n = await wd.vcall(l, "getLineCount", "()I");
        const breaks: number[] = [], widths: number[] = [];
        for (let i = 0; i < n; i++) {
          breaks.push(await wd.vcall(l, "getLineEnd", "(I)I", i));
          widths.push(Math.round(await wd.vcall(l, "getLineWidth", "(I)F", i)));
        }
        res.push({ lines: n, breaks, widths });
      } catch (e: any) {
        res.push({ lines: -1, breaks: [], widths: [], err: String(e?.msg ?? e).split("\n")[0].slice(0, 160) });
      }
    }
    return res;
  }, PARAGRAPHS as unknown as never);
  const missing = await page.evaluate(() => [...(globalThis as any).wd.rt.missing]);
  await browser.close();
  return { out, missing };
}

const ours = await layouts(false);
const aosp = await layouts(true);

let same = 0;
for (let i = 0; i < PARAGRAPHS.length; i++) {
  const a = ours.out[i], b = aosp.out[i];
  // two failures are not an agreement
  const agree = a.lines > 0 && a.lines === b.lines && a.breaks.join(",") === b.breaks.join(",");
  if (agree) same++;
  const label = JSON.stringify(PARAGRAPHS[i][0].slice(0, 38)) + ` w=${PARAGRAPHS[i][1]}`;
  console.log(`${agree ? "ok  " : "DIFF"} ${label}`);
  if (!agree || b.err) {
    console.log(`       ours ${a.lines} lines ${JSON.stringify(a.breaks)}${a.err ? "  " + a.err : ""}`);
    console.log(`       aosp ${b.lines} lines ${JSON.stringify(b.breaks)}${b.err ? "  " + b.err : ""}`);
  }
}
console.log(`\n${same}/${PARAGRAPHS.length} paragraphs break identically`);
const news = aosp.missing.filter((m: string) => !ours.missing.includes(m));
if (news.length) console.log(`\nwhat the cut reached and could not find:\n  ${news.join("\n  ")}`);
