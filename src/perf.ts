// Cheap always-on counters. Increments only — no strings, no timers in the hot path
// beyond the three performance.now() pairs the frame loop already needs.
export const perf = {
  frames: 0, frameMs: 0,
  layoutPasses: 0, layoutMs: 0,
  draws: 0, drawMs: 0,
  measureText: 0, measureTextMiss: 0,
  rnRecord: 0, rnReplay: 0,
  // how many repaints were asked for vs how many frames actually drew: tells "slow frame"
  // apart from "we are drawing frames nobody asked for".
  invalidates: 0,
  // a frame phase that threw. Must stay 0 on a healthy app; non-zero names a real gap.
  layoutErrors: 0, drawErrors: 0,
  // wall time inside input dispatch, and lazy class compilation — both land ON the tap.
  inputMs: 0, compileMs: 0, classesCompiled: 0,
  // method bodies emitted without `async` because the suspension analysis proved they cannot
  // suspend, against those that can. A sync call is ~24x cheaper in the shape we emit.
  syncMethods: 0, asyncMethods: 0, analyseMs: 0,
  coldCalls: 0, coldHandlers: 0, hotMethods: 0,
  // GL surfaces: Renderer frames and their wall time; glSkipped = ticks where the previous
  // GL frame was still in flight (a renderer that awaits its engine spans ticks).
  glFrames: 0, glFrameMs: 0, glSkipped: 0,
  // the native tier: guest instructions, wall time in the core, slices, host calls, time spent
  // in host bodies, GLES draws and errors from native GL.
  nativeInstr: 0, nativeMs: 0, nativeSlices: 0, nativeHostCalls: 0, nativeHostMs: 0, glDraws: 0, glErrors: 0,
  // the JIT: regions linked into the core, and the wall time spent emitting, compiling and linking them
  jitRegions: 0, jitMs: 0,
  bootMs: 0,
};
export function perfReset() {
  for (const k of Object.keys(perf) as (keyof typeof perf)[]) if (k !== "bootMs" && k !== "analyseMs") perf[k] = 0;
}
