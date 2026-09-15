import { copyFileSync, existsSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

export type WebdroidSession = {
  origin: string;
  page: Page;
  errors: string[];
  close(): Promise<void>;
};

export const isWebdroidProcessFrame = (url: string, origin: string): boolean =>
  url.startsWith(`${origin}/?`) || url.startsWith(`${origin}/process`);

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

export async function startWebdroid(apkPath: string, port: number, coverage = true): Promise<WebdroidSession> {
  if (!existsSync(apkPath)) throw new Error(`missing ${apkPath}`);
  const apk = basename(apkPath);
  const servedPath = `apks/${apk}`;
  if (!existsSync(servedPath) || realpathSync(apkPath) !== realpathSync(servedPath)) copyFileSync(apkPath, servedPath);
  const devServer = Bun.spawn(["bun", "run", "server.ts"], {
    env: { ...process.env, PORT: String(port) }, stdout: "ignore", stderr: "ignore",
  });
  const origin = `http://127.0.0.1:${port}`;
  let browser: Browser | undefined;
  try {
    await waitForServer(origin, devServer);
    browser = await chromium.launch({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader"] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1500 }, locale: "en-US", timezoneId: "UTC" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    const query = new URLSearchParams({ apk, screen: "1080x2160@480" });
    if (coverage) query.set("fuzzCoverage", "1");
    await page.goto(`${origin}/?${query}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => Boolean(globalThis.wd?.app()), null, { timeout: 60_000 });
    return {
      origin, page, errors,
      close: async () => {
        await browser?.close();
        devServer.kill();
        await devServer.exited;
      },
    };
  } catch (error) {
    await browser?.close();
    devServer.kill();
    await devServer.exited;
    throw error;
  }
}
