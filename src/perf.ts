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
  // wall time inside input dispatch, and lazy class compilation — both land ON the tap.
  inputMs: 0, compileMs: 0, classesCompiled: 0,
  // outermost static initializers' synchronous work, and resource tables and XML parsed
  clinitMs: 0, resParseMs: 0,
  // main-looper jobs run (Handler messages, frames, input, lifecycle)
  mainJobs: 0,
  // leaf method bodies that cannot suspend (no call, static access, monitor or allocation)
  // against those that can, which carry a save point and a lazily built resumable body.
  syncMethods: 0, asyncMethods: 0,
  // methods first called, and those that began cold (no persisted or offered body)
  methodsReached: 0, methodsCold: 0,
  coldCalls: 0, coldHandlers: 0, hotMethods: 0, osrMethods: 0,
  // Detailed JVM attribution is populated only under ?jvmProfile=1.
  jvmDecodeMs: 0, jvmCfgMs: 0, jvmTypeMs: 0, jvmColdBuildMs: 0, jvmHotEmitMs: 0,
  jvmJsCompileMs: 0, jvmClassLinkMs: 0, jvmColdRunMs: 0, jvmHotRunMs: 0,
  jvmProfileDroppedMethods: 0,
  // Surface frames (GL, native windows and decoded video)
  glFrames: 0,
  // the native tier: guest instructions, wall time in the core, slices, host calls, GLES draws,
  // and errors from native GL (counted under __wdGlProbe).
  nativeInstr: 0, nativeMs: 0, nativeSlices: 0, nativeHostCalls: 0, glDraws: 0, glErrors: 0,
  // the JIT: regions linked into the core, and the wall time spent emitting, compiling and linking them
  jitRegions: 0, jitMs: 0,
  // the Wasm tier: Java calls made from the host, host reads of a Java object's property no field backs (each also a missing entry), and
  // constructs the compiler has no translation for, which compiled code reached
  wasmEntries: 0, wasmFacadeMisses: 0, wasmGaps: 0,
  bootMs: 0,
};
export function perfReset() {
  for (const k of Object.keys(perf) as (keyof typeof perf)[]) if (k !== "bootMs") perf[k] = 0;
}
