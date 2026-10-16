import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { device, formatScreen } from "../../src/shell/config.ts";
import { probeScript } from "../../tests/e2e/lib/probe.ts";

export type WebdroidSession = {
  origin: string;
  page: Page;
  errors: string[];
  /** a fresh page with the APK booted again in a new process */
  reopen(): Promise<void>;
  close(): Promise<void>;
};

type WebdroidOptions = { proxyProbeTo?: string };

function freePort(): number {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = reservation.port;
  reservation.stop(true);
  if (port === undefined) throw new Error("could not allocate a webdroid server port");
  return port;
}

async function waitForServer(url: string, child: ReturnType<typeof Bun.spawn>): Promise<void> {
  for (let attempt = 0; attempt < 1_200; attempt++) {
    if (child.exitCode !== null) throw new Error(`webdroid server exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await Bun.sleep(250);
  }
  throw new Error(`webdroid server did not start at ${url}`);
}

/** until the foreground process has drawn: the app runs in a process Worker, so the page realm's
 *  own counters (system_server's) do not show it */
async function waitForDraw(page: Page, ms = 60_000): Promise<void> {
  const end = performance.now() + ms;
  for (;;) {
    const shown = await page.evaluate(async () => {
      const row = await globalThis.wd!.foregroundWorkerSnapshot();
      return row?.snapshot ? { pkg: row.pkg, draws: row.snapshot.perf.draws ?? 0 }
        : row && { pkg: row.pkg, error: row.error ?? null, exit: row.terminal?.cause ?? null };
    });
    if (shown && "draws" in shown && shown.draws > 0) return;
    if (shown && "exit" in shown && shown.exit) throw new Error(`${shown.pkg} exited before drawing: ${shown.exit}`);
    if (performance.now() > end) throw new Error(`no app drew within ${ms}ms: ${JSON.stringify(shown)}`);
    await Bun.sleep(250);
  }
}

/** Load the page and boot the APK as the e2e launch step does, with every process's frames mirrored
 *  to the page from its start (screenshots composite them), then wait for the app to draw. */
async function openApp(page: Page, origin: string, apk: string): Promise<void> {
  await page.goto(`${origin}/?${new URLSearchParams({ screen: formatScreen(device) })}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(() => Boolean(globalThis.wd), null, { timeout: 60_000 });
  await page.evaluate(() => globalThis.wd!.mirrorFrames(true));
  await page.evaluate((file) => globalThis.wd!.boot(file), apk);
  await waitForDraw(page);
}

export async function startWebdroid(apkPath: string, options: WebdroidOptions = {}): Promise<WebdroidSession> {
  if (!existsSync(apkPath)) throw new Error(`missing ${apkPath}`);
  const apk = basename(apkPath);
  const stage = mkdtempSync(join(tmpdir(), "webdroid-fuzz-"));
  const servedPath = join(stage, apk);
  copyFileSync(apkPath, servedPath);
  const port = freePort();
  const devServer = Bun.spawn(["bun", "run", "server.ts"], {
    env: { ...process.env, PORT: String(port), WEBDROID_APK_DIR: stage,
      ...(options.proxyProbeTo ? { WEBDROID_FUZZ_ORIGIN: options.proxyProbeTo } : {}) },
    stdout: "pipe", stderr: "pipe",
  });
  const serverOutput = Promise.all([new Response(devServer.stdout).text(), new Response(devServer.stderr).text()]);
  const origin = `http://127.0.0.1:${port}`;
  let browser: Browser | undefined;
  const errors: string[] = [];
  try {
    await waitForServer(origin, devServer);
    browser = await chromium.launch({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader"] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1500 }, locale: "en-US", timezoneId: "UTC" });
    // the e2e probe's page half, on the wall clock: it keeps the mirrored frames a screenshot composites
    await context.addInitScript({ content: probeScript({ fixedMs: null, storage: [], shots: false }) });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await openApp(page, origin, apk);
    return {
      origin, page, errors,
      reopen: () => openApp(page, origin, apk),
      close: async () => {
        await browser?.close();
        devServer.kill();
        await devServer.exited;
        rmSync(stage, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await browser?.close();
    devServer.kill();
    await devServer.exited;
    const output = (await serverOutput).filter(Boolean).join("\n");
    rmSync(stage, { recursive: true, force: true });
    throw new Error(`${error instanceof Error ? error.message : String(error)}\npage errors: ${errors.join("\n")}\nserver: ${output}`);
  }
}
