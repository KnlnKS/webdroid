// Does webdroid's StaticLayout break lines where the reference device's does? AOSP's own
// StaticLayout runs over our minikin natives in a page (text measurement needs Canvas2D) and lays
// out the paragraphs below under every break strategy, without and with letter spacing; the
// device's layouts of the same paragraphs are tests/fixtures/textlayout-device.txt, which
// `bun run textcmp --record` rewrites with the reference AVD booted. Line ends must match; widths
// differ by the fonts (the device's Roboto is variable, the page's static) and are reported.
import { BASE_URL } from "../tests/e2e/lib/util";
import { launchBrowser, CONTEXT_OPTS } from "../tests/e2e/drivers/webdroid";
import { androidPlatform, androidTool } from "./android-sdk";

const FIXTURE = "tests/fixtures/textlayout-device.txt";
const PARAGRAPHS: [string, number, number][] = [        // text, width px, text size px
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
];

if (process.argv.includes("--record")) {
  const adb = (...args: string[]) => {
    const r = Bun.spawnSync([androidTool("adb"), ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode) throw new Error(`adb ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.toString();
  };
  const dir = (await Bun.$`mktemp -d`.text()).trim(), javac = process.env.JAVA_HOME ? `${process.env.JAVA_HOME}/bin/javac` : "javac";
  const jar = `${androidPlatform(35)}/android.jar`;
  await Bun.$`${javac} --release 17 -cp ${jar} -d ${dir} scripts/TextLayoutProbe.java`.quiet();
  await Bun.$`${androidTool("d8")} --min-api 34 --lib ${jar} --output ${dir} ${dir}/TextLayoutProbe.class`.quiet();
  const cases = PARAGRAPHS.map(([t, w, s]) => `${t.replace(/\n/g, "\\n").replace(/\t/g, "\\t")}\t${w}\t${s}`).join("\n") + "\n";
  await Bun.write(`${dir}/cases.txt`, cases);
  adb("push", `${dir}/classes.dex`, "/data/local/tmp/webdroid-textlayout.dex");
  adb("push", `${dir}/cases.txt`, "/data/local/tmp/webdroid-textlayout.txt");
  const out = adb("shell", "CLASSPATH=/data/local/tmp/webdroid-textlayout.dex app_process / TextLayoutProbe /data/local/tmp/webdroid-textlayout.txt");
  await Bun.write(FIXTURE, `${cases.trimEnd().split("\n").map((c, i) => `case ${i}\t${c}`).join("\n")}\n${out.trim()}\n`);
  console.log(`${FIXTURE}: ${out.trim().split("\n").length} rows`);
  process.exit(0);
}

const apk = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "FitNotes.apk";
const browser = await launchBrowser();
const page = await browser.newPage(CONTEXT_OPTS);
const resp = await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
if (!resp?.ok()) throw new Error(`dev server not reachable at ${BASE_URL}`);
await page.waitForFunction(() => !!globalThis.wd, null, { timeout: 60_000 });
await page.evaluate(() => document.fonts.ready);
await page.evaluate((a) => void globalThis.wd.boot(a), apk);
await page.waitForFunction(() => globalThis.wd.perf.bootMs > 0, null, { timeout: 120_000 });
// LineBreakConfig reads the application's target SDK: wait for bindApplication, which follows boot
while (!await page.evaluate(async () => await globalThis.wd.scall("android/app/ActivityThread", "currentApplication", "()Landroid/app/Application;") !== null))
  await Bun.sleep(250);
const ours: string[] = await page.evaluate(async (paras) => {
  const wd = globalThis.wd, out: string[] = [];
  const config = await wd.vcall(await wd.vcall(await wd.vcall(await wd.newObj("android/graphics/text/LineBreakConfig$Builder", "()V"),
    "setLineBreakStyle", "(I)Landroid/graphics/text/LineBreakConfig$Builder;", 0),
    "setLineBreakWordStyle", "(I)Landroid/graphics/text/LineBreakConfig$Builder;", 0), "build", "()Landroid/graphics/text/LineBreakConfig;");
  for (const [i, [text, width, size]] of paras.entries()) {
    const paint = await wd.newObj("android/text/TextPaint", "(I)V", 1);
    await wd.vcall(paint, "setTextSize", "(F)V", size);
    for (let strategy = 0; strategy <= 2; strategy++) for (let spacing = 0; spacing <= 1; spacing++) {
      let row = `${i} ${strategy} ${spacing}`;
      try {
        await wd.vcall(paint, "setLetterSpacing", "(F)V", Math.fround(spacing * 0.05));
        let b = await wd.scall("android/text/StaticLayout$Builder", "obtain",
          "(Ljava/lang/CharSequence;IILandroid/text/TextPaint;I)Landroid/text/StaticLayout$Builder;", text, 0, text.length, paint, width);
        b = await wd.vcall(b, "setBreakStrategy", "(I)Landroid/text/StaticLayout$Builder;", strategy);
        b = await wd.vcall(b, "setLineBreakConfig", "(Landroid/graphics/text/LineBreakConfig;)Landroid/text/StaticLayout$Builder;", config);
        const l = await wd.vcall(b, "build", "()Landroid/text/StaticLayout;");
        for (let k = 0, n = await wd.vcall(l, "getLineCount", "()I"); k < n; k++)
          row += ` ${await wd.vcall(l, "getLineEnd", "(I)I", k)}:${await wd.vcall(l, "getLineWidth", "(I)F", k)}:${await wd.vcall(l, "getLineAscent", "(I)I", k)}:${await wd.vcall(l, "getLineDescent", "(I)I", k)}`;
      } catch (e: any) {
        row += " ERROR " + String(e?.msg ?? e).split("\n")[0].slice(0, 160);
      }
      out.push(row);
    }
  }
  return out;
}, PARAGRAPHS);
const missing: string[] = await page.evaluate(() => [...globalThis.wd.rt.missing]);
await browser.close();

const device = (await Bun.file(FIXTURE).text()).trim().split("\n").filter((l) => /^\d/.test(l));
const lines = (row: string) => row.split(" ").slice(3).map((l) => l.split(":").map(Number));
let same = 0, worstWidth = 0, metrics = 0;
for (const [k, row] of ours.entries()) {
  const want = lines(device[k]), got = lines(row), label = `${row.split(" ", 3).join(" ")} ${JSON.stringify(PARAGRAPHS[+row.split(" ")[0]][0].slice(0, 30))}`;
  const agree = !row.includes("ERROR") && got.length === want.length && got.every((l, j) => l[0] === want[j][0]);
  if (agree) {
    same++;
    for (const [j, l] of got.entries()) {
      if (process.env.TEXTCMP_WIDTHS && Math.abs(l[1] - want[j][1]) > 1) console.log(`width ${label} line ${j}: ${l[1]} device ${want[j][1]}`);
      worstWidth = Math.max(worstWidth, Math.abs(l[1] - want[j][1]));
      if (l[2] !== want[j][2] || l[3] !== want[j][3]) metrics++;
    }
  } else {
    console.log(`DIFF ${label}`);
    console.log(`       ours   ${got.map((l) => l[0]).join(",")}${row.includes("ERROR") ? row.slice(row.indexOf(" ERROR")) : ""}`);
    console.log(`       device ${want.map((l) => l[0]).join(",")}`);
    if (process.env.TEXTCMP_WIDTHS) console.log(`       widths ${got.map((l) => l[1]).join(",")} device ${want.map((l) => l[1]).join(",")}`);
  }
}
console.log(`\n${same}/${ours.length} layouts break as the device's; widths within ${worstWidth.toFixed(2)} px; ${metrics} line(s) with other ascent/descent`);
const cut = missing.filter((m) => /android\/(text|graphics)\//.test(m));
if (cut.length) console.log(`\nwhat the layouts reached and could not find:\n  ${cut.join("\n  ")}`);
