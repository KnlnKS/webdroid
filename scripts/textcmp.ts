// Does webdroid's StaticLayout break lines where the reference device's does? AOSP's own
// StaticLayout runs over our minikin natives in a page (text measurement needs Canvas2D) and lays
// out the paragraphs below under every break strategy, without and with letter spacing; the
// device's layouts of the same paragraphs are tests/fixtures/textlayout-device.txt, which
// `pnpm textcmp --record` rewrites with the reference AVD booted (with getTextWidths across
// weights for fwtest, tests/fixtures/textwidths-device.txt). Line ends and hyphen edits must match,
// and a hyphenated line's glyphs; widths and line extents are reported.
import { readFileSync, writeFileSync } from "node:fs";
import { CONTEXT_OPTS, bootApp, launchBrowser, openWebdroid } from "./page.ts";
import { adb, runDex } from "./adb.ts";
import { tempDir } from "./java.ts";

const FIXTURE = "tests/fixtures/textlayout-device.txt", WIDTHS = "tests/fixtures/textwidths-device.txt";
/** text, width px, text size px, and for hyphenated layouts the locale and hyphenation frequency */
const PARAGRAPHS: [string, number, number, string?, number?][] = [
  ["The quick brown fox jumps over the lazy dog", 200, 24],
  ["The quick brown fox jumps over the lazy dog", 720, 24],
  ["Supercalifragilisticexpialidocious antidisestablishmentarianism", 180, 24],
  ["https://example.com/a/very/long/path/that/cannot/be/broken/on/a/space", 200, 24],
  ["one\ntwo three four five six seven eight nine ten\n\neleven", 160, 28],
  ["a b c d e f g h i j k l m n o p q r s t u v w x y z", 100, 20],
  ["A well-known state-of-the-art hyphenated compound", 150, 24],
  ["Write to someone.name@example.com for details", 180, 24],
  ["Tabs\tand\tmore\ttabs\there to see how they wrap", 200, 24],
  ["日本語のテキストを改行するテストです。", 150, 24],
  ["Emoji 👍🏽 family 👨‍👩‍👧 flags 🇨🇦🇯🇵 end", 160, 24],
  ["Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.", 300, 20],
  ...([["en-US", "Hyphenation breaks extraordinarily long words like internationalization and responsibilities"],
    ["de", "Die Donaudampfschifffahrtsgesellschaft sucht Rechtsschutzversicherungsgesellschaften"]] as const).flatMap(([locale, text]) =>
    [[text, 160, 24, locale, 1], [text, 160, 24, locale, 2], [text, 100, 20, locale, 2]] as [string, number, number, string, number][]),
];
/** weight and size of the getTextWidths cases fwtest compares (fonts.ts) */
const WIDTH_CASES = [100, 300, 400, 500, 700, 900].flatMap((w) => [10, 12, 13.5, 14, 16, 18, 20, 24, 32, 40].map((s) => `${w} ${s}`));

if (process.argv.includes("--record")) {
  const dir = tempDir(), cases = PARAGRAPHS.map(([t, ...rest]) => [t.replace(/\n/g, "\\n").replace(/\t/g, "\\t"), ...rest].join("\t")).join("\n") + "\n";
  writeFileSync(`${dir}/cases.txt`, cases);
  writeFileSync(`${dir}/widths.txt`, WIDTH_CASES.join("\n") + "\n");
  adb("push", `${dir}/cases.txt`, "/data/local/tmp/webdroid-textlayout.txt");
  adb("push", `${dir}/widths.txt`, "/data/local/tmp/webdroid-textwidths.txt");
  const out = runDex("scripts/TextLayoutProbe.java", { android: true, args: ["/data/local/tmp/webdroid-textlayout.txt", "/data/local/tmp/webdroid-textwidths.txt"] }).split("\n");
  const layouts = out.filter((l) => !l.startsWith("widths "));
  writeFileSync(FIXTURE, `${cases.trimEnd().split("\n").map((c, i) => `case ${i}\t${c}`).join("\n")}\n${layouts.join("\n")}\n`);
  writeFileSync(WIDTHS, out.filter((l) => l.startsWith("widths ")).join("\n") + "\n");
  console.log(`${FIXTURE}: ${layouts.length} rows; ${WIDTHS}`);
  process.exit(0);
}

const apk = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "FitNotes.apk";
const browser = await launchBrowser();
const page = await browser.newPage(CONTEXT_OPTS);
await openWebdroid(page);
// the layouts run in the page's realm, system_server's, whose Application ActivityThread.systemMain made before the app's process started
await bootApp(page, apk, { ms: 120_000 });
const ours: string[] = await page.evaluate(async (paras) => {
  const wd = globalThis.wd, out: string[] = [], P = "Landroid/graphics/Paint;", B = "Landroid/text/StaticLayout$Builder;";
  const config = await wd.vcall(await wd.vcall(await wd.vcall(await wd.newObj("android/graphics/text/LineBreakConfig$Builder", "()V"),
    "setLineBreakStyle", "(I)Landroid/graphics/text/LineBreakConfig$Builder;", 0),
    "setLineBreakWordStyle", "(I)Landroid/graphics/text/LineBreakConfig$Builder;", 0), "build", "()Landroid/graphics/text/LineBreakConfig;");
  for (const [i, [text, width, size, locale = "en-US", frequency = 0]] of paras.entries()) {
    const paint = await wd.newObj("android/text/TextPaint", "(I)V", 1);
    await wd.vcall(paint, "setTextSize", "(F)V", size);
    await wd.vcall(paint, "setTextLocale", "(Ljava/util/Locale;)V", await wd.scall("java/util/Locale", "forLanguageTag", "(Ljava/lang/String;)Ljava/util/Locale;", locale));
    for (let strategy = 0; strategy <= 2; strategy++) for (let spacing = 0; spacing <= 1; spacing++) {
      let row = `${i} ${strategy} ${spacing}`;
      const hyphens: string[] = [];
      try {
        await wd.vcall(paint, "setLetterSpacing", "(F)V", Math.fround(spacing * 0.05));
        let b = await wd.scall("android/text/StaticLayout$Builder", "obtain", `(Ljava/lang/CharSequence;IILandroid/text/TextPaint;I)${B}`, text, 0, text.length, paint, width);
        b = await wd.vcall(b, "setBreakStrategy", `(I)${B}`, strategy);
        b = await wd.vcall(b, "setHyphenationFrequency", `(I)${B}`, frequency);
        b = await wd.vcall(b, "setLineBreakConfig", `(Landroid/graphics/text/LineBreakConfig;)${B}`, config);
        const l = await wd.vcall(b, "build", "()Landroid/text/StaticLayout;");
        for (let k = 0, n = await wd.vcall(l, "getLineCount", "()I"); k < n; k++) {
          const start = await wd.vcall(l, "getStartHyphenEdit", "(I)I", k), end = await wd.vcall(l, "getEndHyphenEdit", "(I)I", k);
          row += ` ${await wd.vcall(l, "getLineEnd", "(I)I", k)}:${await wd.vcall(l, "getLineWidth", "(I)F", k)}:${await wd.vcall(l, "getLineAscent", "(I)I", k)}:${await wd.vcall(l, "getLineDescent", "(I)I", k)}:${start}:${end}`;
          if (!end) continue;
          const q = await wd.newObj("android/text/TextPaint", `(${P})V`, paint);
          await wd.vcall(q, "setStartHyphenEdit", "(I)V", start);
          await wd.vcall(q, "setEndHyphenEdit", "(I)V", end);
          const s = await wd.vcall(l, "getLineStart", "(I)I", k), e = await wd.vcall(l, "getLineEnd", "(I)I", k);
          const g = await wd.scall("android/graphics/text/TextRunShaper", "shapeTextRun", `(Ljava/lang/CharSequence;IIIIFFZ${P})Landroid/graphics/text/PositionedGlyphs;`, text, s, e - s, s, e - s, 0, 0, 0, q);
          let h = `hyphen ${i} ${strategy} ${spacing} ${k}`;
          for (let j = 0, n = await wd.vcall(g, "glyphCount", "()I"); j < n; j++) h += ` ${await wd.vcall(g, "getGlyphId", "(I)I", j)}@${await wd.vcall(g, "getGlyphX", "(I)F", j)}`;
          hyphens.push(h);
        }
      } catch (e: any) {
        row += " ERROR " + String(e?.msg ?? e).split("\n")[0].slice(0, 160);
      }
      out.push(row, ...hyphens);
    }
  }
  return out;
}, PARAGRAPHS);
const missing: string[] = await page.evaluate(() => [...globalThis.wd.rt.missing]);
await browser.close();

const recorded = readFileSync(FIXTURE, "utf8").trim().split("\n");
const device = recorded.filter((l) => /^\d/.test(l)), layouts = ours.filter((l) => /^\d/.test(l));
const lines = (row: string) => row.split(" ").slice(3).map((l) => l.split(":").map(Number));
let same = 0, worstWidth = 0, metrics = 0;
for (const [k, row] of layouts.entries()) {
  const want = lines(device[k]), got = lines(row), label = `${row.split(" ", 3).join(" ")} ${JSON.stringify(PARAGRAPHS[+row.split(" ")[0]][0].slice(0, 30))}`;
  // a line ends where the device's does, with the same hyphen edits
  const agree = !row.includes("ERROR") && got.length === want.length && got.every((l, j) => l[0] === want[j][0] && l[4] === want[j][4] && l[5] === want[j][5]);
  if (agree) {
    same++;
    for (const [j, l] of got.entries()) {
      if (process.env.TEXTCMP_WIDTHS && Math.abs(l[1] - want[j][1]) > 1) console.log(`width ${label} line ${j}: ${l[1]} device ${want[j][1]}`);
      worstWidth = Math.max(worstWidth, Math.abs(l[1] - want[j][1]));
      if (l[2] !== want[j][2] || l[3] !== want[j][3]) metrics++;
    }
  } else {
    console.log(`DIFF ${label}`);
    console.log(`       ours   ${got.map((l) => l.slice(0, 1).concat(l[5] ? [l[5]] : []).join("-")).join(",")}${row.includes("ERROR") ? row.slice(row.indexOf(" ERROR")) : ""}`);
    console.log(`       device ${want.map((l) => l.slice(0, 1).concat(l[5] ? [l[5]] : []).join("-")).join(",")}`);
    if (process.env.TEXTCMP_WIDTHS) console.log(`       widths ${got.map((l) => l[1]).join(",")} device ${want.map((l) => l[1]).join(",")}`);
  }
}
// the glyphs of each line a hyphen ends, drawn with its edits: ids, and positions to a float ulp
const glyphRows = (rows: string[]) => new Map(rows.filter((l) => l.startsWith("hyphen ")).map((l) => [l.split(" ", 5).join(" "), l.split(" ").slice(5)]));
const ourGlyphs = glyphRows(ours), deviceGlyphs = glyphRows(recorded);
let glyphsSame = 0;
for (const [key, want] of deviceGlyphs) {
  const got = ourGlyphs.get(key), at = (g: string) => g.split("@").map(Number);
  if (got && got.length === want.length && got.every((g, j) => at(g)[0] === at(want[j])[0] && Math.abs(at(g)[1] - at(want[j])[1]) <= Math.abs(at(want[j])[1]) * 2 ** -22)) glyphsSame++;
  else console.log(`DIFF ${key} glyphs\n       ours   ${got?.join(" ")}\n       device ${want.join(" ")}`);
}
console.log(`\n${same}/${layouts.length} layouts break as the device's; widths within ${worstWidth.toFixed(2)} px; ${metrics} line(s) with other ascent/descent`);
console.log(`${glyphsSame}/${deviceGlyphs.size} hyphenated lines shape to the device's glyphs${ourGlyphs.size > deviceGlyphs.size ? `; ${ourGlyphs.size - deviceGlyphs.size} more here` : ""}`);
const cut = missing.filter((m) => /android\/(text|graphics)\//.test(m));
if (cut.length) console.log(`\nwhat the layouts reached and could not find:\n  ${cut.join("\n  ")}`);
