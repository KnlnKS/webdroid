import { mkdirSync } from "node:fs";
import { compareResult } from "./compare";
import { generateApiCases, generateGraphicsCases } from "./generate";
import { minimizeCaseBatched, reproducesTwice } from "./minimize";
import type { Failure, ProbeCase, ProbeResult } from "./model";
import { runAndroid, runWebdroid, type PlatformRun } from "./probe-runner";
import { injectedProbeFailure } from "./injected";

export type FailureBundle = {
  schemaVersion: 1;
  kind: "api" | "graphics";
  injected?: true;
  seed: number;
  input: ProbeCase;
  minimized: ProbeCase;
  failure: Failure;
  oracle: ProbeResult;
  webdroid: ProbeResult;
  environment: { oracle: Record<string, unknown>; webdroid: Record<string, unknown> };
};

type CampaignOptions = { kind: "api" | "graphics"; seed: number; cases: number; oracle: string; out: string };

async function pair(cases: readonly ProbeCase[], serial: string): Promise<[PlatformRun, PlatformRun]> {
  const oracle = await runAndroid(cases, serial);
  const webdroid = await runWebdroid(cases);
  return [oracle, webdroid];
}

function failureFor(input: ProbeCase, oracle: ProbeResult, webdroid: ProbeResult): Failure | null {
  return compareResult(input, oracle, webdroid);
}

async function replayFingerprint(input: ProbeCase, serial: string, fingerprint: string): Promise<boolean> {
  const [oracle, webdroid] = await pair([input], serial);
  return failureFor(input, oracle.results[0]!, webdroid.results[0]!)?.fingerprint === fingerprint;
}

export async function runCampaign(options: CampaignOptions): Promise<{ failures: number; bundles: string[] }> {
  const inputs = options.kind === "api"
    ? generateApiCases(options.seed, options.cases)
    : generateGraphicsCases(options.seed, options.cases);
  const [oracle, webdroid] = await pair(inputs, options.oracle);
  const failures = inputs.flatMap((input, index) => {
    const failure = failureFor(input, oracle.results[index]!, webdroid.results[index]!);
    return failure ? [{ input, failure, oracle: oracle.results[index]!, webdroid: webdroid.results[index]! }] : [];
  });
  mkdirSync(options.out, { recursive: true });
  const bundles: string[] = [];
  const seen = new Set<string>();
  for (const item of failures) {
    if (seen.has(item.failure.fingerprint)) continue;
    seen.add(item.failure.fingerprint);
    const reproduces = (candidate: ProbeCase) => replayFingerprint(candidate, options.oracle, item.failure.fingerprint);
    const minimized = await minimizeCaseBatched(item.input, async (candidates) => {
      const uniquelyNamed = candidates.map((candidate, index) => ({ ...candidate, id: `${candidate.id}-min-${index}` }));
      const [candidateOracle, candidateWebdroid] = await pair(uniquelyNamed, options.oracle);
      return uniquelyNamed.map((candidate, index) => failureFor(candidate, candidateOracle.results[index]!, candidateWebdroid.results[index]!)?.fingerprint === item.failure.fingerprint);
    });
    if (!(await reproducesTwice(minimized, reproduces))) continue;
    const bundle: FailureBundle = {
      schemaVersion: 1, kind: options.kind, seed: options.seed, input: item.input, minimized, failure: item.failure,
      oracle: item.oracle, webdroid: item.webdroid,
      environment: { oracle: oracle.environment, webdroid: webdroid.environment },
    };
    const path = `${options.out}/${options.kind}-${options.seed}-${bundles.length}.failure.json`;
    await Bun.write(path, JSON.stringify(bundle, null, 2) + "\n");
    bundles.push(path);
    if (bundles.length >= 20) break;
  }
  await Bun.write(`${options.out}/${options.kind}-${options.seed}.campaign.json`, JSON.stringify({
    schemaVersion: 1, kind: options.kind, seed: options.seed, cases: inputs.length,
    failures: failures.length, retained: bundles, oracle, webdroid,
  }, null, 2) + "\n");
  return { failures: failures.length, bundles };
}

export async function replayBundle(path: string, oracleSerial?: string): Promise<boolean> {
  const parsed = JSON.parse(await Bun.file(path).text()) as FailureBundle;
  if (parsed.schemaVersion !== 1 || !parsed.minimized || !parsed.failure?.fingerprint) throw new Error("invalid failure bundle");
  if (parsed.injected) return reproducesTwice(parsed.minimized, async (candidate) =>
    injectedProbeFailure(candidate).failure?.fingerprint === parsed.failure.fingerprint);
  if (!oracleSerial) throw new Error("API and graphics replay require an oracle serial");
  return reproducesTwice(parsed.minimized, (candidate) => replayFingerprint(candidate, oracleSerial, parsed.failure.fingerprint));
}
