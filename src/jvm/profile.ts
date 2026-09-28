import { perf } from "../perf";

type JvmTier = "auto" | "cold" | "js";
type JvmProfilePhase =
  "decode" | "cfg" | "type" | "coldBuild" | "hotEmit" | "jsCompile" | "classLink" |
  "coldRun" | "hotRun";
type JvmMethodProfilePhase = Exclude<JvmProfilePhase, "classLink">;

interface JvmMethodProfile {
  name: string;
  entries: number;
  backedges: number;
  instructions: number;
  suspensions: number;
  coldToHot: number;
  generatedBytes: number;
  decodeMs: number;
  cfgMs: number;
  typeMs: number;
  coldBuildMs: number;
  hotEmitMs: number;
  jsCompileMs: number;
  coldRunMs: number;
  hotRunMs: number;
}

const MAX_METHODS = 8192;
const records = new Map<string, JvmMethodProfile>();
const dropped = new Set<string>();

const phaseCounter = {
  decode: "jvmDecodeMs",
  cfg: "jvmCfgMs",
  type: "jvmTypeMs",
  coldBuild: "jvmColdBuildMs",
  hotEmit: "jvmHotEmitMs",
  jsCompile: "jvmJsCompileMs",
  classLink: "jvmClassLinkMs",
  coldRun: "jvmColdRunMs",
  hotRun: "jvmHotRunMs",
} as const satisfies Record<JvmProfilePhase, keyof typeof perf>;
const phaseField = {
  decode: "decodeMs",
  cfg: "cfgMs",
  type: "typeMs",
  coldBuild: "coldBuildMs",
  hotEmit: "hotEmitMs",
  jsCompile: "jsCompileMs",
  coldRun: "coldRunMs",
  hotRun: "hotRunMs",
} as const satisfies Record<JvmMethodProfilePhase, keyof JvmMethodProfile>;

function makeRecord(name: string): JvmMethodProfile {
  return {
    name, entries: 0, backedges: 0, instructions: 0, suspensions: 0,
    coldToHot: 0, generatedBytes: 0,
    decodeMs: 0, cfgMs: 0, typeMs: 0, coldBuildMs: 0, hotEmitMs: 0,
    jsCompileMs: 0, coldRunMs: 0, hotRunMs: 0,
  };
}

function record(name: string): JvmMethodProfile | undefined {
  if (!jvmProfiler.enabled) return undefined;
  const existing = records.get(name);
  if (existing) return existing;
  if (records.size < MAX_METHODS) {
    const value = makeRecord(name);
    records.set(name, value);
    return value;
  }
  if (dropped.size < MAX_METHODS && !dropped.has(name)) {
    dropped.add(name);
    perf.jvmProfileDroppedMethods++;
  }
  return undefined;
}

export const JVM_HOT_THRESHOLDS: readonly number[] = [1024, 4096, 16384];
export const DEFAULT_HOT_THRESHOLD = 4096;

export function configureJvm(options: { profile: boolean; tier: JvmTier; hotThreshold?: number }): void {
  jvmProfiler.enabled = options.profile;
  jvmProfiler.tier = options.tier;
  jvmProfiler.hotThreshold = options.hotThreshold ?? DEFAULT_HOT_THRESHOLD;
}

export function parseJvmTier(value: string | null): JvmTier {
  switch (value) {
    case null: case "auto": return "auto";
    case "cold": case "js": return value;
    default: throw new Error(`invalid jvmTier ${value}`);
  }
}

export const jvmProfiler = {
  // plain properties: compiled code and the cold tier read them on every call
  enabled: false,
  tier: "auto" as JvmTier,
  hotThreshold: DEFAULT_HOT_THRESHOLD,
  entry(name: string): void { const r = record(name); if (r) r.entries++; },
  backedge(name: string, instructions: number): void {
    const r = record(name);
    if (r) { r.backedges++; r.instructions += instructions; }
  },
  suspension(name: string): void { const r = record(name); if (r) r.suspensions++; },
  promoted(name: string): void { const r = record(name); if (r) r.coldToHot++; },
  bytes(name: string, value: number): void { const r = record(name); if (r) r.generatedBytes += value; },
  add(name: string, phase: JvmMethodProfilePhase, ms: number): void {
    if (!jvmProfiler.enabled) return;
    perf[phaseCounter[phase]] += ms;
    const r = record(name);
    if (r) r[phaseField[phase]] += ms;
  },
  addAggregate(phase: JvmProfilePhase, ms: number): void {
    if (jvmProfiler.enabled) perf[phaseCounter[phase]] += ms;
  },
  snapshot() {
    const methods = [...records.values()].sort((a, b) =>
      (b.coldRunMs + b.hotRunMs + b.decodeMs + b.cfgMs + b.typeMs + b.coldBuildMs + b.hotEmitMs + b.jsCompileMs) -
      (a.coldRunMs + a.hotRunMs + a.decodeMs + a.cfgMs + a.typeMs + a.coldBuildMs + a.hotEmitMs + a.jsCompileMs));
    return { enabled: jvmProfiler.enabled, tier: jvmProfiler.tier, droppedMethods: perf.jvmProfileDroppedMethods, methods };
  },
  reset(): void { records.clear(); dropped.clear(); perf.jvmProfileDroppedMethods = 0; },
};
