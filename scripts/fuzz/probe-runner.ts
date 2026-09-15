import { existsSync } from "node:fs";
import { androidTool } from "../android-sdk";
import { readProcesses } from "../../tests/e2e/lib/processes";
import { serveCases } from "./case-server";
import type { ProbeCase, ProbeResult } from "./model";
import { isWebdroidProcessFrame, startWebdroid } from "./webdroid-session";

const PROBE_APK = "fuzz-cache/WebdroidFuzzProbe.apk";
const PROBE_PACKAGE = "org.webdroid.fuzz";
const PROBE_ACTIVITY = `${PROBE_PACKAGE}/.ProbeActivity`;
const preparedOracles = new Map<string, { sdk: string; fingerprint: string }>();

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
    const [sdk, fingerprint] = await Promise.all([
      at("shell", "getprop", "ro.build.version.sdk"), at("shell", "getprop", "ro.build.fingerprint"),
    ]);
    if (sdk !== "33") throw new Error(`oracle ${serial} is API ${sdk}, expected API 33`);
    await at("install", "-r", "-t", PROBE_APK);
    environment = { sdk, fingerprint };
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

export async function runWebdroid(cases: readonly ProbeCase[]): Promise<PlatformRun> {
  requireProbe();
  const caseServer = serveCases(cases);
  let session: Awaited<ReturnType<typeof startWebdroid>> | undefined;
  try {
    session = await startWebdroid(PROBE_APK, { proxyProbeTo: caseServer.url });
    const { origin, page, errors } = session;
    const results = await caseServer.results;
    let processes = await readProcesses(page);
    let processFrames = processes.filter((process) => isWebdroidProcessFrame(process.url, origin));
    let missingDiagnostics = processFrames.filter((process) => process.diagnostics.status !== "ok");
    for (let attempt = 0; missingDiagnostics.length && attempt < 10; attempt++) {
      await Bun.sleep(250);
      processes = await readProcesses(page);
      processFrames = processes.filter((process) => isWebdroidProcessFrame(process.url, origin));
      missingDiagnostics = processFrames.filter((process) => process.diagnostics.status !== "ok");
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
    await session?.close();
  }
}
