import { mkdirSync } from "node:fs";
import { compareResult } from "./compare";
import { generateApiCases, generateGraphicsCases } from "./generate";
import { minimizeCaseBatched, reproducesTwice } from "./minimize";
import { sameFailure, validateFailure, validateProbeCase, validateProbeResult, type Failure, type ProbeCase, type ProbeResult } from "./model";
import { runAndroid, runWebdroid, type PlatformRun } from "./probe-runner";
import { injectedProbeFailure } from "./injected";

export type ProbeObservation = {
  input: ProbeCase;
  failure: Failure;
  oracle: ProbeResult;
  webdroid: ProbeResult;
};

export type FailureBundle = {
  schemaVersion: 1;
  kind: "api" | "graphics";
  injected?: true;
  seed: number;
  original: ProbeObservation;
  minimized: ProbeObservation;
  reproductions: [ProbeObservation, ProbeObservation];
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

async function replayFailure(input: ProbeCase, serial: string, expected: Failure): Promise<ProbeObservation | null> {
  const [oracle, webdroid] = await pair([input], serial);
  const failure = failureFor(input, oracle.results[0]!, webdroid.results[0]!);
  return sameFailure(expected, failure) ? { input, failure: failure!, oracle: oracle.results[0]!, webdroid: webdroid.results[0]! } : null;
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
  const attempted = new Set<string>();
  for (const item of failures) {
    if (attempted.has(item.failure.fingerprint)) continue;
    attempted.add(item.failure.fingerprint);
    const minimized = await minimizeCaseBatched(item.input, async (candidates) => {
      const uniquelyNamed = candidates.map((candidate, index) => ({ ...candidate, id: `${candidate.id}-min-${index}` }));
      const [candidateOracle, candidateWebdroid] = await pair(uniquelyNamed, options.oracle);
      return uniquelyNamed.map((candidate, index) => sameFailure(item.failure,
        failureFor(candidate, candidateOracle.results[index]!, candidateWebdroid.results[index]!)));
    });
    const first = await replayFailure(minimized, options.oracle, item.failure);
    const second = await replayFailure(minimized, options.oracle, item.failure);
    if (!first || !second || first.failure.fingerprint !== second.failure.fingerprint) continue;
    if (seen.has(first.failure.fingerprint)) continue;
    seen.add(first.failure.fingerprint);
    const bundle: FailureBundle = {
      schemaVersion: 1, kind: options.kind, seed: options.seed,
      original: item, minimized: first, reproductions: [first, second],
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
  const parsed = validateFailureBundle(JSON.parse(await Bun.file(path).text()));
  if (parsed.injected) return reproducesTwice(parsed.minimized.input, async (candidate) =>
    sameFailure(parsed.minimized.failure, injectedProbeFailure(candidate).failure));
  if (!oracleSerial) throw new Error("API and graphics replay require an oracle serial");
  return reproducesTwice(parsed.minimized.input, async (candidate) =>
    (await replayFailure(candidate, oracleSerial, parsed.minimized.failure)) !== null);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function observation(value: unknown, label: string): ProbeObservation {
  const input = object(value, label);
  const probe = validateProbeCase(input.input);
  const oracle = validateProbeResult(input.oracle), webdroid = validateProbeResult(input.webdroid);
  if (oracle.id !== probe.id || webdroid.id !== probe.id || oracle.kind !== probe.kind || webdroid.kind !== probe.kind)
    throw new Error(`${label} mixes results from different cases`);
  return { input: probe, failure: validateFailure(input.failure, `${label}.failure`), oracle, webdroid };
}

export function validateFailureBundle(value: unknown): FailureBundle {
  const input = object(value, "failure bundle");
  if (input.schemaVersion !== 1 || (input.kind !== "api" && input.kind !== "graphics") || typeof input.seed !== "number")
    throw new Error("invalid failure bundle");
  if (!Array.isArray(input.reproductions) || input.reproductions.length !== 2) throw new Error("failure bundle requires two reproductions");
  const original = observation(input.original, "failure bundle.original");
  const minimized = observation(input.minimized, "failure bundle.minimized");
  const reproductions: [ProbeObservation, ProbeObservation] = [
    observation(input.reproductions[0], "failure bundle.reproductions[0]"),
    observation(input.reproductions[1], "failure bundle.reproductions[1]"),
  ];
  if (original.input.kind !== input.kind || minimized.input.kind !== input.kind ||
      reproductions.some((item) => item.input.kind !== input.kind || item.failure.fingerprint !== minimized.failure.fingerprint))
    throw new Error("failure bundle observations disagree");
  const environment = object(input.environment, "failure bundle.environment");
  const output: FailureBundle = {
    schemaVersion: 1, kind: input.kind, seed: input.seed, original, minimized, reproductions,
    environment: { oracle: object(environment.oracle, "failure bundle.environment.oracle"), webdroid: object(environment.webdroid, "failure bundle.environment.webdroid") },
  };
  if (input.injected === true) output.injected = true;
  return output;
}
