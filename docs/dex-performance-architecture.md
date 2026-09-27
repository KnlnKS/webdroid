# DEX-to-JavaScript performance architecture

Java runs synchronously. A compiled call returns its value, or a Promise only
when something below it actually waits (a park, a contended monitor, an
asynchronous class initialization or browser I/O). Frames pay for asynchrony
only on that path, and a woken stack resumes in one pass. Framework natives
follow the same rule.

## Execution model

```text
DEX -> decode/CFG -> PreparedMethod -> pooled cold handlers (first 31 calls)
                                    -> fast hot body (installed; V8 inlines it)
                                    -> resumable hot body (built on first suspension or OSR)
```

`src/jvm/prepared.ts` owns decoding, CFG leaders and constant typing. The
emitter's opcode switch in `src/jvm/compiler.ts` remains the semantic source of
truth for both tiers. Longs are BigInts, strings are JS strings, primitive
arrays are typed arrays and object arrays carry `$t`.

- **Fast body.** A plain function over a `for(;;) switch(pc)` of basic blocks.
  After each call it tests `$t instanceof Promise`; if so it breaks to a single
  save point that captures its registers and calls `R.dfr` with the resumable
  body. It has no resume prologue or resume cases, which keeps it small enough
  for V8 to inline through deep Kotlin/Compose call chains. Leaf methods (no
  calls, statics or allocation) compile to one sync form.
- **Resumable body.** `function($F)`: the same blocks plus a prologue that
  restores the saved frame and a `case -K` resume point after each call. It
  is only ever a continuation, never an entry, and is compiled on the
  method's first suspension (or for on-stack replacement), not at promotion.
- **Cold tier.** Pooled handlers keyed by their emitted body run the first 31
  calls. A method's first call prepares it once, but keeps only the
  instructions constant typing annotated (`coldInstructions`); every other
  instruction is decoded again and its handler built when it first runs.
  Reaching-definition typing runs only when a float read can see a constant. A handler returns the
  Promise it waits on: a call result is delivered
  past the handler (`F.$w = 1`), while class-initialization and resolution
  waits rerun the handler once their caches are filled. Cold frames transfer to
  the resumable body at any backedge past the hotness threshold. Generated
  bodies and handlers are parenthesized so V8 compiles them eagerly: each runs
  as soon as it is created.
- **Continuations.** `src/jvm/suspend.ts`: every frame waiting on the same
  pending operation (hot, cold or generator native) joins one continuation
  list; when it settles the list resumes innermost to outermost in a single
  microtask. A frame that suspends again hands the rest of the list to its new
  suspension. A resumed frame re-pins its Java thread and releases it to the
  main thread when it finishes.
- **Natives.** A native that calls back into Java is a generator wrapped in
  `driven()`: each `yield` takes a Java result, value or Promise, and
  `Runtime.drive` stays synchronous until one is a Promise. `vcall` is
  sync-first; `vcallAsync` is for the few callers that chain on completion.
  An `async` native would make every Java caller suspend on every call.
- **Dispatch.** Direct-call caches follow lazy stubs to their current body.
  `instance-of`/`check-cast` in hot code compare the receiver's constructor
  with a per-site cache before the full check.
- **Constants.** Reaching-definition typing of numeric constants runs only
  for methods with a float or double reader; the rest mark constant-null
  receivers with a flow-insensitive pass.

## Diagnostics

`?jvmProfile=1` counts entries, suspensions and run time in both hot forms;
it retains at most 8,192 records. `wd.perf` exposes aggregate
phases and counters (`mainJobs`, `hotMethods`, `osrMethods`, `rnReplay`...).
`?jvmTier=auto|cold|js` and `?jvmHotness=1024|4096|16384` support diagnosis;
`jvmTier=js` compiles every executed method to the fast form at once.

`scripts/perf-browser.ts` measures a flow state with optional CPU throttling,
ad-hoc swipes, CPU profiles and renderer trace totals; it forces its GC before
warmup because a forced GC deoptimizes code that embeds weak objects.
`scripts/launch-profile.ts` times navigation to first draw, and with
`--launches N` repeated launches in one browser profile. In V8 CPU profiles
the first sample carries the gap since `Profiler.start` as `(program)`;
excluding it, microtask machinery also appears as `(program)`.

## Rejected or deferred

- A Java Wasm backend: application time is object, Compose and collection
  code with no eligible numeric bottleneck.
- Moving process realms off the main thread: child realms reach the broker,
  fonts and file sources directly, and they are idle in steady-state
  interaction; launch is where they compete.
- Replacing BigInt longs: Compose's packed Offset/Constraints and
  ScatterMap metadata cost about 40–65 ns per pack or probe, roughly 5–8% of
  Mihon scrolling. Wrapping every result in `BigInt.asIntN(64, …)` gained
  only 16% on that kernel; a two-int32 representation would touch every
  native.
- A synchronous drain loop for the main queue: Mihon runs about 180 main
  jobs per second, so its Promise overhead is negligible.
- Persisting promoted methods per package so a relaunch compiles them hot on
  first call (a baseline profile): relaunch first draw was flat for Mihon
  and FitNotes and about 3% faster for YouTube, not worth the stored state.
- A promotion threshold other than 32 calls: 8 and 128 both left Mihon's
  launch flat or slower after the cold tier became lazy.
- Earlier rejections still hold: fused cold blocks and a sparse cold-op array
  saved little under auto tiering, and retaining every cold preparation cost
  about 5.5% of Mihon heap.
