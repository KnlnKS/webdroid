import { perf } from "../perf";

export type JvmTier = "auto" | "cold" | "js" | "wasm";
export type JvmProfilePhase =
  "decode" | "cfg" | "type" | "coldBuild" | "hotEmit" | "jsCompile" | "classLink" |
  "coldRun" | "hotRun" | "suspend";

export interface JvmMethodProfile {
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
  classLinkMs: number;
  coldRunMs: number;
  hotRunMs: number;
  suspendMs: number;
}

const MAX_METHODS = 8192;
const records = new Map<string, JvmMethodProfile>();
const dropped = new Set<string>();
let enabled = false;
let requestedTier: JvmTier = "auto";
let tier: Exclude<JvmTier, "wasm"> = "auto";
let hotThreshold = 4096;

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
  suspend: "jvmSuspendMs",
} as const satisfies Record<JvmProfilePhase, keyof typeof perf>;
const phaseField = {
  decode: "decodeMs",
  cfg: "cfgMs",
  type: "typeMs",
  coldBuild: "coldBuildMs",
  hotEmit: "hotEmitMs",
  jsCompile: "jsCompileMs",
  classLink: "classLinkMs",
  coldRun: "coldRunMs",
  hotRun: "hotRunMs",
  suspend: "suspendMs",
} as const satisfies Record<JvmProfilePhase, keyof JvmMethodProfile>;

function makeRecord(name: string): JvmMethodProfile {
  return {
    name, entries: 0, backedges: 0, instructions: 0, suspensions: 0,
    coldToHot: 0, generatedBytes: 0,
    decodeMs: 0, cfgMs: 0, typeMs: 0, coldBuildMs: 0, hotEmitMs: 0,
    jsCompileMs: 0, classLinkMs: 0, coldRunMs: 0, hotRunMs: 0, suspendMs: 0,
  };
}

function record(name: string): JvmMethodProfile | undefined {
  if (!enabled) return undefined;
  let value = records.get(name);
  if (!value && records.size < MAX_METHODS) {
    value = makeRecord(name);
    records.set(name, value);
  }
  if (!value && dropped.size < MAX_METHODS && !dropped.has(name)) {
    dropped.add(name);
    perf.jvmProfileDroppedMethods++;
  }
  return value;
}

export function configureJvm(options: { profile: boolean; tier: JvmTier; hotThreshold?: number }): void {
  enabled = options.profile;
  requestedTier = options.tier;
  tier = options.tier === "wasm" ? "auto" : options.tier;
  hotThreshold = options.hotThreshold ?? 4096;
}

export function parseJvmTier(value: string | null): JvmTier {
  switch (value) {
    case null: case "auto": return "auto";
    case "cold": case "js": case "wasm": return value;
    default: throw new Error(`invalid jvmTier ${value}`);
  }
}

export const jvmProfiler = {
  get enabled(): boolean { return enabled; },
  get tier(): Exclude<JvmTier, "wasm"> { return tier; },
  get hotThreshold(): number { return hotThreshold; },
  entry(name: string): void { const r = record(name); if (r) r.entries++; },
  backedge(name: string, instructions: number): void {
    const r = record(name);
    if (r) { r.backedges++; r.instructions += instructions; }
  },
  suspension(name: string): void { const r = record(name); if (r) r.suspensions++; },
  promoted(name: string): void { const r = record(name); if (r) r.coldToHot++; },
  bytes(name: string, value: number): void { const r = record(name); if (r) r.generatedBytes += value; },
  add(name: string, phase: JvmProfilePhase, ms: number): void {
    if (!enabled) return;
    perf[phaseCounter[phase]] += ms;
    const r = record(name);
    if (r) r[phaseField[phase]] += ms;
  },
  snapshot(): { enabled: boolean; requestedTier: JvmTier; tier: Exclude<JvmTier, "wasm">; wasmAvailable: false; droppedMethods: number; methods: JvmMethodProfile[] } {
    const methods = [...records.values()].sort((a, b) =>
      (b.coldRunMs + b.hotRunMs + b.decodeMs + b.cfgMs + b.typeMs + b.coldBuildMs + b.hotEmitMs + b.jsCompileMs + b.classLinkMs) -
      (a.coldRunMs + a.hotRunMs + a.decodeMs + a.cfgMs + a.typeMs + a.coldBuildMs + a.hotEmitMs + a.jsCompileMs + a.classLinkMs));
    return { enabled, requestedTier, tier, wasmAvailable: false, droppedMethods: perf.jvmProfileDroppedMethods, methods };
  },
  reset(): void { records.clear(); dropped.clear(); perf.jvmProfileDroppedMethods = 0; },
};
