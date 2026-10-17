import { installCounterReceipt } from "./shell/perf-receipts.ts";
// Cheap always-on counters. Increments only — no strings, no timers in the hot path
// beyond the three performance.now() pairs the frame loop already needs.
export const perf = {
  frames: 0, completedFrames: 0, presentations: 0, frameMs: 0,
  // wall time from a buffer's queueBuffer to the composite that shows it
  presentLagMs: 0,
  draws: 0, drawMs: 0,
  measureText: 0, measureTextMiss: 0,
  rnRecord: 0, rnReplay: 0,
  // a frame phase that threw. Must stay 0 on a healthy app; non-zero names a real gap.
  drawErrors: 0,
  // wall time inside input dispatch, which lands ON the tap, and resource tables and XML parsed
  inputMs: 0, resParseMs: 0,
  // main-looper jobs run (Handler messages, frames, input, lifecycle)
  mainJobs: 0,
  // Surface frames (GL, native windows and decoded video)
  glFrames: 0,
  // the native tier: guest instructions, wall time in the core, slices, host calls, GLES draws,
  // and errors from native GL (counted under __wdGlProbe).
  nativeInstr: 0, nativeMs: 0, nativeSlices: 0, nativeHostCalls: 0, glDraws: 0, glErrors: 0,
  // the JIT: regions linked into the core, and the wall time spent emitting, compiling and linking them
  jitRegions: 0, jitMs: 0,
  // the Wasm tier: Java calls made from the host, host reads of a Java object's property no field backs (each also a missing entry), and
  // constructs the compiler has no translation for, which compiled code reached, natives that answered a Promise from a plain import (nativeSuspended: each
  // is a native to classify as suspending, suspend.ts), calls the engine refused to suspend
  wasmEntries: 0, wasmFacadeMisses: 0, wasmGaps: 0, wasmNativeSuspended: 0, wasmSuspendErrors: 0,
  // the World's work (host/stats.ts bindWorld): methods compiled (on demand, or ahead in idle time: wasmAhead) and the time that took (compiler), modules built and
  // instantiated and their time, platform and app build modules loaded and missed, classes linked, stack switches, and natives called (Java to host)
  wasmMethods: 0, wasmCompileMs: 0, wasmModules: 0, wasmModuleMs: 0, wasmBytes: 0, wasmAotLoaded: 0, wasmAotMissed: 0, wasmAotMs: 0, wasmClasses: 0, wasmSuspensions: 0, wasmCrossings: 0,
  wasmUpgrades: 0, wasmAhead: 0,
  // first-tier units merged away and dropped for collection a batch at a time (World.retire), and those the collector has freed
  wasmRetired: 0, wasmCollected: 0,
  wasmPrepareMs: 0, wasmFlowMs: 0, wasmInferMs: 0, wasmFactsMs: 0, wasmEmitMs: 0, wasmEncodeMs: 0, wasmClassBuildMs: 0,
  bootMs: 0,
};
const recordCounterReset = installCounterReceipt(perf, import.meta.url);
export function perfReset() {
  recordCounterReset?.();
  for (const k of Object.keys(perf) as (keyof typeof perf)[]) if (k !== "bootMs") perf[k] = 0;
}

/** a point on the launch timeline: a performance mark "wd:<name>" in the realm that made it (scripts/lat/run.ts collects the page's and the app Worker's) */
export const mark = (name: string): void => { performance.mark("wd:" + name); };
