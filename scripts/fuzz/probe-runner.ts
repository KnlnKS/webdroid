import { copyFileSync, existsSync } from "node:fs";
import { chromium } from "playwright";
import { androidTool } from "../android-sdk";
import { readProcesses } from "../../tests/e2e/lib/processes";
import { serveCases } from "./case-server";
import type { ProbeCase, ProbeResult } from "./model";

const PROBE_APK = "fuzz-cache/WebdroidFuzzProbe.apk";
const PROBE_PACKAGE = "org.webdroid.fuzz";
const PROBE_ACTIVITY = `${PROBE_PACKAGE}/.ProbeActivity`;

export type PlatformRun = {
  platform: "android" | "webdroid";
  results: ProbeResult[];
  environment: Record<string, unknown>;
  diagnostics: unknown;
};

async function command(argv: string[], quiet = false): Promise<string> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0 && !quiet) throw new Error(`${argv.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
  return stdout.trim();
}

function requireProbe(): void {
  if (!existsSync(PROBE_APK)) throw new Error(`missing ${PROBE_APK}; run bash scripts/fuzz/build-probe.sh`);
}

export async function runAndroid(cases: readonly ProbeCase[], serial: string): Promise<PlatformRun> {
  requireProbe();
  const adb = androidTool("adb");
  const at = (...args: string[]) => command([adb, "-s", serial, ...args]);
  const [sdk, fingerprint] = await Promise.all([
    at("shell", "getprop", "ro.build.version.sdk"), at("shell", "getprop", "ro.build.fingerprint"),
  ]);
  if (sdk !== "33") throw new Error(`oracle ${serial} is API ${sdk}, expected API 33`);
  const server = serveCases(cases);
  try {
    await at("reverse", "tcp:4876", "tcp:4876");
    await at("install", "-r", "-t", PROBE_APK);
    await at("shell", "am", "force-stop", PROBE_PACKAGE);
    await at("shell", "am", "start", "-W", "-n", PROBE_ACTIVITY);
    const results = await server.results;
    const logcat = await at("logcat", "-d", "-t", "300", "WebdroidFuzz:D", "AndroidRuntime:E", "*:S");
    return { platform: "android", results, environment: { serial, sdk, fingerprint }, diagnostics: { logcat } };
  } finally {
    server.stop();
  }
}

async function waitForServer(url: string, child: ReturnType<typeof Bun.spawn>): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`webdroid server exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await Bun.sleep(250);
  }
  throw new Error(`webdroid server did not start at ${url}`);
}

export async function runWebdroid(cases: readonly ProbeCase[], port = 4097): Promise<PlatformRun> {
  requireProbe();
  if (!existsSync("apks")) throw new Error("missing apks directory");
  copyFileSync(PROBE_APK, "apks/WebdroidFuzzProbe.apk");
  const caseServer = serveCases(cases);
  const output: string[] = [];
  const devServer = Bun.spawn(["bun", "run", "server.ts"], {
    env: { ...process.env, PORT: String(port) }, stdout: "pipe", stderr: "pipe",
  });
  void new Response(devServer.stdout).text().then((value) => output.push(value));
  void new Response(devServer.stderr).text().then((value) => output.push(value));
  const origin = `http://127.0.0.1:${port}`;
  const pageUrl = `${origin}/?apk=WebdroidFuzzProbe.apk&screen=1080x2160@480&fuzzCoverage=1`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await waitForServer(origin, devServer);
    browser = await chromium.launch({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader"] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1500 }, locale: "en-US", timezoneId: "UTC" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => Boolean(globalThis.wd?.app()), null, { timeout: 60_000 });
    const results = await caseServer.results;
    let processes = await readProcesses(page);
    let processFrames = processes.filter((process) => process.url === pageUrl || process.url.startsWith(`${origin}/process`));
    let missingDiagnostics = processFrames.filter((process) => process.diagnostics === null ||
      (typeof process.diagnostics === "object" && process.diagnostics !== null && "failure" in process.diagnostics));
    for (let attempt = 0; missingDiagnostics.length && attempt < 10; attempt++) {
      await Bun.sleep(250);
      processes = await readProcesses(page);
      processFrames = processes.filter((process) => process.url === pageUrl || process.url.startsWith(`${origin}/process`));
      missingDiagnostics = processFrames.filter((process) => process.diagnostics === null ||
        (typeof process.diagnostics === "object" && process.diagnostics !== null && "failure" in process.diagnostics));
    }
    if (!processFrames.length || missingDiagnostics.length)
      throw new Error(`missing process diagnostics: ${JSON.stringify(missingDiagnostics.length ? missingDiagnostics : processes)}`);
    const alive = await page.evaluate(() => globalThis.wd!.alive(2_000));
    return {
      platform: "webdroid", results,
      environment: { origin, userAgent: await page.evaluate(() => navigator.userAgent) },
      diagnostics: { alive, errors, processes: processFrames },
    };
  } finally {
    caseServer.stop();
    await browser?.close();
    devServer.kill();
    await devServer.exited;
  }
}
