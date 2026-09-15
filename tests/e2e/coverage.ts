import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { waitHorizonMs, type Flow } from "./types";

export type CoverageIndex = {
  generatedAt: string;
  complete: boolean;
  sourceRevision: string;
  schemaHash: string;
  browser: string;
  mode: "v8-precise-sourcemap";
  apkHashes: Record<string, string>;
  screens: Record<string, string>;
  flows: Record<string, string[]>;
  files: Record<string, string[]>;
};

export async function apkHashes(flows: Flow[]): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(flows.map(async (flow) => {
    const bytes = new Uint8Array(await Bun.file(resolve(import.meta.dir, "../..", "apks", flow.apk)).arrayBuffer());
    const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    return [flow.app, hash];
  })));
}

export function gitExecutable(): string {
  const fallback = resolve(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/git");
  return existsSync(fallback) ? fallback : Bun.which("git") ?? "git";
}

export function repositoryRevision(root: string): string {
  return Bun.spawnSync([gitExecutable(), "rev-parse", "HEAD"], { cwd: root, stdout: "pipe" }).stdout.toString().trim() || "unknown";
}

export function flowSchemaHash(flows: Flow[]): string {
  const value = flows.map((flow) => ({
    app: flow.app,
    clock: flow.clock,
    steps: flow.steps.map((step) => [step.id, step.action.type, waitHorizonMs(step.wait)]),
  }));
  return new Bun.CryptoHasher("sha256").update(new TextEncoder().encode(JSON.stringify(value))).digest("hex");
}
