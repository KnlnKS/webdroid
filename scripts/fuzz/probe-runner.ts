import { existsSync } from "node:fs";
import { androidTool } from "../android-sdk.ts";
import { device, formatScreen } from "../../src/shell/config.ts";
import { diagnosed, readProcesses } from "../../tests/e2e/lib/processes.ts";
import { serveCases } from "./case-server.ts";
import type { ProbeCase, ProbeResult } from "./model.ts";
import { startWebdroid } from "./webdroid-session.ts";

const PROBE_APK = "fuzz-cache/WebdroidFuzzProbe.apk";
const PROBE_PACKAGE = "org.webdroid.fuzz";
const PROBE_ACTIVITY = `${PROBE_PACKAGE}/.ProbeActivity`;
const preparedOracles = new Map<string, { sdk: string; fingerprint: string; screen: string }>();

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
  let environment = preparedOracles.get(serial);
  if (!environment) {
    const [sdk, fingerprint, size, density] = await Promise.all([
      at("shell", "getprop", "ro.build.version.sdk"), at("shell", "getprop", "ro.build.fingerprint"),
      at("shell", "wm", "size"), at("shell", "wm", "density"),
    ]);
    if (sdk !== "35") throw new Error(`oracle ${serial} is API ${sdk}, expected API 35`);
    const screen = `${size.match(/(\d+x\d+)\s*$/)?.[1]}@${density.match(/(\d+)\s*$/)?.[1]}`;
    const expected = formatScreen(device);
    if (screen !== expected) throw new Error(`oracle ${serial} screen is ${screen}, expected ${expected}; run scripts/fuzz/setup-oracle.sh`);
    await at("install", "-r", "-t", PROBE_APK);
    environment = { sdk, fingerprint, screen };
    preparedOracles.set(serial, environment);
  }
  const server = serveCases(cases);
  try {
    await at("reverse", "tcp:4876", `tcp:${new URL(server.url).port}`);
    await at("shell", "am", "force-stop", PROBE_PACKAGE);
    await at("shell", "am", "start", "-W", "-n", PROBE_ACTIVITY);
    const results = await server.results;
    const logcat = await at("logcat", "-d", "-t", "300", "WebdroidFuzz:D", "AndroidRuntime:E", "*:S");
    return { platform: "android", results, environment: { serial, ...environment }, diagnostics: { logcat } };
  } finally {
    await at("reverse", "--remove", "tcp:4876").catch(() => undefined);
    server.stop();
  }
}

async function webdroidRun(session: Awaited<ReturnType<typeof startWebdroid>>, results: ProbeResult[]): Promise<PlatformRun> {
    const { origin, page, errors } = session;
    let processFrames = await readProcesses(page);
    let missingDiagnostics = processFrames.filter((process) => !diagnosed(process.diagnostics));
    for (let attempt = 0; missingDiagnostics.length && attempt < 10; attempt++) {
      await Bun.sleep(250);
      processFrames = await readProcesses(page);
      missingDiagnostics = processFrames.filter((process) => !diagnosed(process.diagnostics));
    }
    if (!processFrames.length || missingDiagnostics.length)
      throw new Error(`missing process diagnostics: ${JSON.stringify(missingDiagnostics)}`);
    const alive = await page.evaluate(() => globalThis.wd!.alive(2_000));
    return {
      platform: "webdroid", results,
      environment: { origin, userAgent: await page.evaluate(() => navigator.userAgent) },
      diagnostics: { alive, errors, processes: processFrames },
    };
}

export class WebdroidProbeRunner {
  private session?: Awaited<ReturnType<typeof startWebdroid>>;
  private casePort?: number;

  async run(cases: readonly ProbeCase[]): Promise<PlatformRun> {
    requireProbe();
    const caseServer = serveCases(cases, this.casePort ?? 0);
    this.casePort = Number(new URL(caseServer.url).port);
    try {
      if (!this.session) this.session = await startWebdroid(PROBE_APK, { proxyProbeTo: caseServer.url });
      else {
        this.session.errors.length = 0;
        await this.session.reopen();
      }
      return await webdroidRun(this.session, await caseServer.results);
    } finally {
      caseServer.stop();
    }
  }

  async close(): Promise<void> {
    await this.session?.close();
    this.session = undefined;
  }
}

export async function runWebdroid(cases: readonly ProbeCase[]): Promise<PlatformRun> {
  const runner = new WebdroidProbeRunner();
  try {
    return await runner.run(cases);
  } finally {
    await runner.close();
  }
}
