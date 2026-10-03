// The page's app ends and opens again without a tab reload: System.exit in the page's app, "Open
// again", and the app starts in a new process frame while microG's realm and the broker live on;
// then that process is killed and opened again in turn.
// bun scripts/relaunch.ts [apk]   (WEBDROID_URL names the server)
import { CONTEXT_OPTS, launchBrowser } from "../tests/e2e/drivers/webdroid";
import { BASE_URL } from "../tests/e2e/lib/util";

const apk = process.argv[2] ?? "FitNotes.apk";
type Broker = { alive(pid: number): boolean; entries: Map<number, { pid: number; pkg: string; dead: boolean; ready: Promise<{ kill(signal: number): void }> }>; mark?: number };
declare global { var __wdProcesses: Broker; var mark: number | undefined }

const browser = await launchBrowser("hardware");
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };
try {
  const page = await (await browser.newContext(CONTEXT_OPTS)).newPage();
  let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });
  await page.goto(`${BASE_URL}/?apk=${encodeURIComponent(apk)}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => globalThis.wd?.perf.draws > 0, null, { timeout: 120_000 });
  const pkg = await page.evaluate(() => globalThis.wd.app()!.pkg);
  // the processes in frames, by package
  const framed = async (want: string) => {
    for (const frame of page.frames()) {
      if (frame.isDetached() || !frame.url().includes("/process")) continue;
      if (await frame.evaluate(() => globalThis.wd?.app()?.pkg).catch(() => null) === want) return frame;
    }
    return null;
  };
  let gms = null;
  for (let i = 0; i < 480 && !(gms = await framed("com.google.android.gms")); i++) await page.waitForTimeout(250);
  if (!gms) throw new Error("microG's process never started");
  await page.evaluate(() => { globalThis.mark = 1; globalThis.__wdProcesses.mark = 1; });
  await gms.evaluate(() => { globalThis.mark = 1; });

  void page.evaluate(() => { void globalThis.wd.scall("java/lang/System", "exit", "(I)V", 0); });
  await page.waitForSelector("#root[data-state=exited]", { timeout: 30_000 });
  check(await page.isVisible("#retry"), `the exited app offers "Open again" (${await page.textContent("#status")})`);
  const opened = performance.now();
  await page.click("#retry");
  await page.waitForSelector("#root[data-state=running]", { timeout: 120_000 });
  let app = null;
  for (let i = 0; i < 600 && !(app && await app.evaluate(() => globalThis.wd.perf.draws > 0)); i++) { app = await framed(pkg); await page.waitForTimeout(50); }
  check(!!app, `${pkg} runs in a new process frame, first frame ${Math.round(performance.now() - opened)} ms after "Open again"`);
  check(navigations === 1 && await page.evaluate(() => globalThis.mark === 1), "the tab did not reload");
  check(await page.evaluate(() => globalThis.__wdProcesses.mark === 1), "the broker lived on");
  check(await gms.evaluate(() => globalThis.mark === 1).catch(() => false) && await page.evaluate(() => globalThis.__wdProcesses.alive(1001)), "microG's process lived on");
  const texts = (await page.evaluate(() => globalThis.wd.uiTree()) as { text: string }[]).map((n) => n.text).filter(Boolean);
  check(texts.length > 0, `the relaunched app's windows show (${texts.slice(0, 4).join(" | ")})`);

  const pid = Number(new URL(app!.url()).searchParams.get("pid"));
  await page.evaluate((pid) => globalThis.__wdProcesses.entries.get(pid)!.ready.then((endpoint) => endpoint.kill(9)), pid);
  await page.waitForSelector("#root[data-state=exited]", { timeout: 30_000 });
  check(app!.isDetached(), "a killed relaunched process's frame goes");
  await page.click("#retry");
  await page.waitForSelector("#root[data-state=running]", { timeout: 120_000 });
  const live = await page.evaluate((pkg) => [...globalThis.__wdProcesses.entries.values()].filter((e) => e.pkg === pkg && !e.dead).map((e) => e.pid), pkg);
  check(live.length === 1 && live[0] > pid, `it opens again in another process (pid ${live.join(",")})`);
} finally { await browser.close(); }
console.log(failures.length ? `relaunch check FAILED: ${failures.length}` : "relaunch check passed");
process.exit(failures.length ? 1 : 0);
