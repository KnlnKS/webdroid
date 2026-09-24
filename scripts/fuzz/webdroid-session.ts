import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { device } from "../../src/shell/config";
import { isWebdroidProcessFrame } from "../../tests/e2e/lib/processes";

export type WebdroidSession = {
  origin: string;
  page: Page;
  errors: string[];
  close(): Promise<void>;
};

export type WebdroidOptions = { port?: number; coverage?: boolean; proxyProbeTo?: string; attestationEnabled?: boolean };

export { isWebdroidProcessFrame };

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

export async function startWebdroid(apkPath: string, options: WebdroidOptions = {}): Promise<WebdroidSession> {
  if (!existsSync(apkPath)) throw new Error(`missing ${apkPath}`);
  const apk = basename(apkPath);
  const stage = mkdtempSync(join(tmpdir(), "webdroid-fuzz-"));
  const servedPath = join(stage, apk);
  copyFileSync(apkPath, servedPath);
  const port = options.port ?? freePort();
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
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    const query = new URLSearchParams({ apk, screen: `${device.width}x${device.height}@${device.densityDpi}` });
    if (options.coverage !== false) query.set("fuzzCoverage", "1");
    if (options.attestationEnabled) query.set("attestation", "1");
    await page.goto(`${origin}/?${query}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => Boolean(globalThis.wd?.app()), null, { timeout: 60_000 });
    return {
      origin, page, errors,
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
