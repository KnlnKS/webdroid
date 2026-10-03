# 0003: specialize execution boundaries before replacing the VM

Status: performance investigation, 2026-10-02. Base: `304c0529`,
`knlnks/bytecode`; implementation work: `knlnks/bytecode-codex-performance`.
This supplements the [bytecode-first plan](../bytecode-first-plan.md), preserving
its bytecode, correctness and latency requirements.

## Cost model

A visible response includes input delivery, Java execution, suspension/resumption,
layout, drawing, composition and browser presentation. Reducing allocations helps
only when allocation or collection is on that path. The number of shell ticks is
not a frame rate; an idle or wedged app can have advancing ticks without presenting.
FPS averaged across gestures includes intentional gaps between animations.

Keep these ownership boundaries:

- Java objects and virtual dispatch stay in the process's JS realm. Hot methods
  already use scalar registers and create saved frames only when they suspend.
- ARM execution, guest memory and instruction translation stay in the Zig/Wasm
  core. The host owns suspension, signals, Java callbacks and browser APIs.
- AOSP owns view/layout behavior. Native RenderNodes retain display lists and
  transforms; Canvas2D owns software drawing and the browser owns presentation.
- Compilation and code delivery happen ahead of interaction where possible.
  A cache or compiler worker must account for both entry and resumable bodies.

These are useful boundaries, not reasons to keep every implementation unchanged.

## Adopted changes

1. **Avoid suspension when there is no pending operation.** JNI calls from guest
   code into Java return directly when initialization and the Java body complete
   synchronously. Actual suspension retains thread identity, pinned arrays and
   pending-exception handling. The native-entry driver also avoids empty spill
   arrays, redundant register views and empty waiter snapshots.
2. **Retain small numeric state with clear ownership.** A RenderNode updates its
   own 2D transform and position bounds in place; 3D camera state is lazy. Short
   UTF conversion uses bounded numeric scratch arrays. This does not pool Java
   objects or retain caller references beyond their lifetime.
3. **Remove redundant native-boundary work.** Canvas recordings reuse method
   wrappers before native reflection. JIT compilation receives the emission view;
   the WebAssembly API makes the required snapshot itself.
4. **Reject invalid measurements.** Browser setup must reach its text targets.
   Reports flag incomplete inputs, hidden/nonadvancing displays, unresponsive
   loopers and interaction windows that present no frames.
5. **Use idle compilation in the current launch.** Deferred source previously
   went only to persistence, leaving this launch interpreting the same methods.
   Install that already-emitted source without repeating preparation. Prepare a
   resumable form only after observing a suspension. Limit idle installation to
   24 MiB of the existing 32 MiB source allowance, reserving 8 MiB for demand
   promotion; reaching the idle allowance must not disable future promotion.
   This counts source string length, not retained heap. No method or class initializer executes early.

The implementation history records measurements and rejected experiments. Large
isolated speedups in matrix arithmetic and fewer JNI parks do not establish a
large overall speedup: initial matched Mihon scrolling was effectively unchanged.

## Rejected shortcuts

- Cold-frame pooling reduced allocation but slowed a V8 probe by 1.6–2.0 times;
  clearing retained registers and pool bookkeeping cost more than fresh arrays.
- Replacing superclass `.call` with JS `super` did not improve a current V8
  probe. Its optimizer already inlined the monomorphic existing call shape.
- Whole-method live-register capture would remove about 8–15% of saved slots in
  the inspected DEX sets. It needs handler-aware liveness and OSR remapping;
  this static estimate does not yet justify the compiler complexity.
- Emitting both forms for every APK baseline-profile method added 44.6 MB of
  resumable source to Mihon's 32.1 MB of entries. Unused forms would stay in the
  worker-offer cache. That broad experiment was removed; preparation based on
  observed execution has a much smaller scope. Timing samples collected while
  another checkout ran browser tests cannot establish its performance effect.
- Do not bypass app/framework bytecode, alter animation time, skip required
  frames, or replace asynchronous operations with fabricated results.

## Where a larger redesign could pay

| Boundary | Next experiment | Evidence required before adoption |
|---|---|---|
| Compiler worker | Prioritize observed suspension sites | Less tap-path compilation without excessive import time, startup delay or retained code |
| Java to guest entry | Make the native driver synchronous until the first real wait | Quantify forced suspension in app profiles; preserve nested calls, signals and thread ownership |
| Display-list replay | Batch commands and arguments in reusable storage | Allocation profile and command histogram; preserve resource lifetimes and nested replay |
| Composition | Track damage and cache ordering at mutations | Profile full-surface work; verify relative-Z layers, translucent content and WebView overlays |
| JVM saved frames | Per-site live-register capture | Generated-code and inlining gains, including catches and cold-to-hot OSR |

Wasm is a strong fit for contiguous numerical kernels with substantial work per
call, as the ARM core, HarfBuzz and Skia already demonstrate. Moving Java object
dispatch or individual Canvas2D operations into Wasm would add host crossings and
duplicate ownership. A renderer rewrite should first define a batched command and
resource boundary, then compare its software path against existing visual fixtures.
There is no measured basis here for replacing the whole JVM with Zig.

## Verification contract

Compare immutable revisions with matching inputs, geometry, clock, GPU and fresh
browser state. Serialize latency/FPS runs without competing diagnostic load when possible.
This investigation shares the host with another checkout, with the user approving
continued measurements under that constraint; its timing results are qualified. Keep
CPU profiles separate from uninstrumented gates. Record setup hits, completed
inputs, visible advancing frames and every process's diagnostics. A missed target,
unavailable diagnostic or baseline failure must remain visible in the results.
Keep visual goldens unchanged and smoke-compile affected APKs with zero failures.
