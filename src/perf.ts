// Cheap always-on counters. Increments only — no strings, no timers in the hot path
// beyond the three performance.now() pairs the frame loop already needs.
export const perf = {
  frames: 0, completedFrames: 0, presentations: 0, frameMs: 0,
  layoutPasses: 0, layoutMs: 0,
  draws: 0, drawMs: 0,
  measureText: 0, measureTextMiss: 0,
  rnRecord: 0, rnReplay: 0,
  // how many repaints were asked for vs how many frames actually drew: tells "slow frame"
  // apart from "we are drawing frames nobody asked for".
  invalidates: 0,
  // layout work: requests that name a view against those that re-measure the whole tree,
  // onMeasure bodies that actually ran, views laid out at a size other than their measurement,
  // and window-inset dispatches (each one forces a layout pass).
  layoutRequests: 0, layoutRequestsAll: 0, onMeasures: 0, layoutMismatch: 0, insetsPasses: 0,
  // TextView line breaking computed against served from a memo, measures a cache answered, and
  // measures skipped because an EXACTLY spec matched the size the view already had
  wraps: 0, wrapHits: 0, measureCacheHits: 0, exactSkips: 0,
  // draw work: views painted against views their parent's clip rejected
  viewsDrawn: 0, viewsRejected: 0,
  // a frame phase that threw. Must stay 0 on a healthy app; non-zero names a real gap.
  layoutErrors: 0, drawErrors: 0,
  // wall time inside input dispatch, and lazy class compilation — both land ON the tap.
  inputMs: 0, compileMs: 0, classesCompiled: 0,
  // method bodies emitted without `async` (no call, static access, monitor or allocation)
  // against those that can suspend. A sync call is ~24x cheaper in the shape we emit.
  syncMethods: 0, asyncMethods: 0,
  coldCalls: 0, coldHandlers: 0, hotMethods: 0, osrMethods: 0,
  // Detailed JVM attribution is populated only under ?jvmProfile=1.
  jvmDecodeMs: 0, jvmCfgMs: 0, jvmTypeMs: 0, jvmColdBuildMs: 0, jvmHotEmitMs: 0,
  jvmJsCompileMs: 0, jvmClassLinkMs: 0, jvmColdRunMs: 0, jvmHotRunMs: 0, jvmSuspendMs: 0,
  jvmProfileDroppedMethods: 0,
  // Surface frames (GL, native windows and decoded video), Renderer wall time, and ticks where
  // the previous Renderer frame was still in flight.
  glFrames: 0, glFrameMs: 0, glSkipped: 0,
  // the native tier: guest instructions, wall time in the core, slices, host calls, time spent
  // in host bodies, GLES draws and errors from native GL.
  nativeInstr: 0, nativeMs: 0, nativeSlices: 0, nativeHostCalls: 0, nativeHostMs: 0, glDraws: 0, glErrors: 0,
  // the JIT: regions linked into the core, and the wall time spent emitting, compiling and linking them
  jitRegions: 0, jitMs: 0,
  bootMs: 0,
};
export function perfReset() {
  for (const k of Object.keys(perf) as (keyof typeof perf)[]) if (k !== "bootMs") perf[k] = 0;
}
