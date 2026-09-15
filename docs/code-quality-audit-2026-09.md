# Code-quality audit: Android compatibility fuzzing

This audit covers all 99,514 lines of TypeScript and Zig under `src`, `scripts`, and `tests` at
the end of the fuzzing implementation. It combines full-file size and boundary scans with the
strict TypeScript build (`noUnusedLocals`), targeted ownership tracing, and review of every
production file changed by the work. Size is evidence for inspection, not a reason to move code.

## Implemented findings

1. **Registration support had multiple definitions.** Audit and framework tools independently
   inferred whether a class, method, or field was registered, and none could distinguish a
   placeholder. `scripts/native-surface.ts` is now the single resolver. The inventory, audit,
   corpus ranking, framework scan, and framework test use this catalog layer. Placeholder tagging
   is a `WeakSet`; it adds no branch to normal invocation.
2. **Android tool discovery was brittle.** A Bun glob form silently returned no build-tool
   versions on this host. `scripts/android-sdk.ts` now owns platform/tool discovery and reads the
   build-tools directory directly. Probe building, inventory, and UI fuzzing share it.
3. **Browser/server lifecycle was duplicated.** Probe and UI campaigns now share one webdroid
   session owner. Cleanup remains exception-safe, and callers own only their protocol.
4. **Failure minimization serialized avoidable platform boots.** Candidate deletions and argument
   shrinks are evaluated in batches for API and graphics campaigns, while retaining bounded rounds
   and two final reproductions. UI minimization resets both platforms for each stateful replay.
5. **Coverage risked contaminating production paths.** Coverage mode is selected before methods
   are generated. Disabled cold and hot methods contain no probe and no per-call coverage branch;
   enabled methods use one set insertion. The option propagates to child realms and diagnostics.
6. **Two broad graphics contracts were wrong.** Paint cap/join state did not round-trip, and
   inverted Canvas bounds drew or clipped rather than following Android empty-bound semantics.
   The differential probe supplied the Android evidence for the retained fixes.

These changes establish ownership or remove duplicated work. No source file was split simply to
reduce its line count, and no test was deleted: the scan found no test whose behavior, regression
mechanism, and coverage were all duplicated.

## Ranked remaining findings

| Rank | Area | Evidence and decision |
| --- | --- | --- |
| P1 | `src/jvm/natives/jutil.ts` (2,747 lines) | Collections, maps, streams, regex-adjacent utilities, and generated registrations share one native surface. There are repeated iterator/view patterns, but moving them without live-view and suspension proofs risks semantic drift. Extract by proven ownership in a dedicated task, not by size. |
| P1 | `src/android/view.ts` (2,470 lines) | Measurement, layout, invalidation, accessibility state, and RenderNode ownership meet here. The condition density is real, but those state machines are coupled. Instrument transition frequency and extract only a complete state owner. |
| P1 | `src/android/graphics.ts` (2,416 lines) and `drawable.ts` (1,803) | Canvas state, text metrics, bitmap operations, and Drawable behavior have overlapping geometry helpers. Differential graphics cases should first identify equivalent contracts; premature consolidation could merge intentionally different Android rounding rules. |
| P2 | Typed JVM boundaries | The tree contains 408 `any` annotations/assertions, concentrated at generated-Java object and browser diagnostic boundaries. Replace them when a stable discriminated wire type exists. Broad cast removal would add wrappers without increasing safety. |
| P2 | Harness command/deadline helpers | Probe, UI, and E2E drivers have similar subprocess and deadline helpers, but return types and timeout semantics differ. Consolidate only if another harness needs the same contract; the current shared browser session captured the proven duplication. |
| P2 | Native core modules | `arm.zig` (1,398), `simd.zig` (1,279), `jit.zig` (1,265), and `jit32.zig` (913) are large but instruction-family ownership is cohesive. A split would increase cross-file dispatch without evidence of reduced defects or compile cost. |
| P3 | Two TODO/FIXME markers | Both are localized compatibility notes rather than abandoned paths. They remain discoverable and do not justify speculative implementation. |

## Rejected changes

- Thin façade modules around the large Android/JVM files: more names and imports with no clearer
  state owner.
- Generic invocation of every API member: contexts, loopers, callbacks, permissions, services,
  and related objects need explicit recipes. Fabricated receivers would measure the harness.
- Per-call coverage guards in production-generated methods: rejected in favor of generation-time
  selection.
- Broad test pruning: no deletion met the requirement that it remove no unique behavior or
  regression evidence.
- A shared catch-all subprocess helper: Android binary output, probe text output, and E2E process
  control have materially different failure and lifetime semantics.

The next cleanup should be driven by a minimized compatibility defect or a measured hot path. The
ranked files are review queues, not blanket refactoring authorization.
