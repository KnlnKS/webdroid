import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Browser, Page } from "playwright";
import { device, formatScreen } from "../../src/shell/config.ts";
import { probeScript } from "../../tests/e2e/lib/probe.ts";
import { CONTEXT_OPTS, launchBrowser } from "../browser.ts";

export type WebdroidSession = {
  origin: string;
  page: Page;
  errors: string[];
  /** a fresh page with the APK booted again in a new process */
  reopen(): Promise<void>;
  close(): Promise<void>;
};

type WebdroidOptions = { proxyProbeTo?: string };

const ROOT = join(import.meta.dirname, "../..");

async function freePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => reservation.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = reservation.address() as AddressInfo;
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 1_200; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`webdroid server exited with ${child.exitCode ?? child.signalCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await setTimeout(250);
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
    if ((shown?.draws ?? 0) > 0) return;
    if (shown && "exit" in shown && shown.exit) throw new Error(`${shown.pkg} exited before drawing: ${shown.exit}`);
    if (performance.now() > end) throw new Error(`no app drew within ${ms}ms: ${JSON.stringify(shown)}`);
    await setTimeout(250);
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
  const port = await freePort();
  // its own process group, so stopping it stops whatever it spawned too
  const devServer = spawn(join(ROOT, "node_modules/.bin/vp"), ["dev", "--configLoader", "native"], {
    cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), WEBDROID_APK_DIR: stage,
      ...(options.proxyProbeTo ? { WEBDROID_FUZZ_ORIGIN: options.proxyProbeTo } : {}) },
  });
  const serverOutput: string[] = [];
  for (const stream of [devServer.stdout, devServer.stderr]) stream.setEncoding("utf8").on("data", (chunk: string) => serverOutput.push(chunk));
  const stopServer = async () => {
    if (devServer.exitCode !== null || devServer.signalCode !== null) return;
    const exited = once(devServer, "exit");
    process.kill(-devServer.pid!, "SIGTERM");
    await exited;
  };
  const origin = `http://127.0.0.1:${port}`;
  let browser: Browser | undefined;
  const errors: string[] = [];
  try {
    await waitForServer(origin, devServer);
    browser = await launchBrowser();
    const context = await browser.newContext(CONTEXT_OPTS);
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
        await stopServer();
        rmSync(stage, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await browser?.close();
    await stopServer();
    rmSync(stage, { recursive: true, force: true });
    throw new Error(`${error instanceof Error ? error.message : String(error)}\npage errors: ${errors.join("\n")}\nserver: ${serverOutput.join("")}`);
  }
}
