import { resolve } from "node:path";
import { deviceScreen, screenParam, type Flow, type Screen } from "./types";

export type CoverageIndex = {
  generatedAt: string;
  complete: boolean;
  sourceRevision: string;
  schemaHash: string;
  browser: string;
  mode: "v8-precise-sourcemap";
  apkHashes: Record<string, string>;
  screens: Record<string, string>;
  unsupportedFlows: string[];
  flows: Record<string, string[]>;
  files: Record<string, string[]>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringArray = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
const stringRecord = (value: unknown): Record<string, string> | null => {
  if (!isRecord(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return null;
    result[key] = item;
  }
  return result;
};
const stringArrayRecord = (value: unknown): Record<string, string[]> | null => {
  if (!isRecord(value)) return null;
  const result: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    const parsed = stringArray(item);
    if (!parsed) return null;
    result[key] = parsed;
  }
  return result;
};

export function parseCoverageIndex(value: unknown): CoverageIndex {
  if (!isRecord(value)) throw new Error("coverage index must be an object");
  const apkHashes = stringRecord(value.apkHashes);
  const screens = stringRecord(value.screens);
  const unsupportedFlows = stringArray(value.unsupportedFlows);
  const flows = stringArrayRecord(value.flows);
  const files = stringArrayRecord(value.files);
  if (typeof value.generatedAt !== "string" || typeof value.complete !== "boolean" ||
      typeof value.sourceRevision !== "string" || typeof value.schemaHash !== "string" ||
      typeof value.browser !== "string" || value.mode !== "v8-precise-sourcemap" ||
      !apkHashes || !screens || !unsupportedFlows || !flows || !files)
    throw new Error("coverage index has an invalid or obsolete schema");
  return {
    generatedAt: value.generatedAt,
    complete: value.complete,
    sourceRevision: value.sourceRevision,
    schemaHash: value.schemaHash,
    browser: value.browser,
    mode: value.mode,
    apkHashes,
    screens,
    unsupportedFlows,
    flows,
    files,
  };
}

export async function apkHashes(flows: Flow[]): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(flows.map(async (flow) => {
    const bytes = new Uint8Array(await Bun.file(resolve(import.meta.dir, "../..", "apks", flow.apk)).arrayBuffer());
    const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    return [flow.app, hash];
  })));
}

export function gitExecutable(): string {
  return process.env.GIT || Bun.which("git") || "git";
}

export function repositoryRevision(root: string): string {
  const result = Bun.spawnSync([gitExecutable(), "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "unknown";
}

function canonical(value: unknown, reference: boolean): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, reference)).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined && (!reference || (key !== "fastWait" && key !== "fastAction"))).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key], reference)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function flowSchemaHash(flows: Flow[], mode: "all" | "reference" = "all"): string {
  return new Bun.CryptoHasher("sha256").update(new TextEncoder().encode(canonical(flows, mode === "reference"))).digest("hex");
}

function screenFromManifest(value: unknown): Screen | undefined {
  if (!isRecord(value) || !isRecord(value.device)) return;
  const { width, height, densityDpi } = value.device;
  return typeof width === "number" && typeof height === "number" && typeof densityDpi === "number"
    ? { width, height, densityDpi }
    : undefined;
}

export async function expectedScreens(flows: Flow[]): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(flows.map(async (flow) => {
    const file = Bun.file(resolve(import.meta.dir, "golden", flow.app, "manifest.json"));
    const exists = await file.exists();
    const manifestScreen = exists ? screenFromManifest(await file.json()) : undefined;
    if (exists && !manifestScreen) throw new Error(`${flow.app}: golden manifest has an invalid device screen`);
    return [flow.app, screenParam(manifestScreen ?? flow.screen ?? deviceScreen())];
  })));
}
