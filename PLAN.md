# Staged performance replacements — completed

Starting revision: `b16d705`. Integration branch: `codex/perf-integration`.
Final production: `ca2effd`; measurement harness: `dc5d401`.
All planned replacement levels were implemented and measured, then retained or
rejected. Conditional indexed eviction remains deferred because its profiling gate
was not met. The universal 1.5x / 55–60 completed-frame target was **not achieved**.

The retained selection makes Doodle's completed-title startup **22.57% faster
(about 1.29x)**. Sustained score-advancing Doodle gameplay and a valid fixed
15-second Flappy gameplay comparison remain unverified. Guest bytecode, timer
rates, process isolation and visual goldens are unchanged.

## Decisions

| Workstream | Retained | Rejected or deferred |
| --- | --- | --- |
| Native execution | Executed-byte-range invalidation across scalar, floating, bulk, host and GPU writes; allocation/mapping lifetime invalidation; ARM dispatch/flags corrections; standalone/far Thumb calls; ISB redispatch | Precise ARM32 register effects produced only 6–9% incremental app benefit, below 15%. Indexed eviction lacked the required profile evidence. |
| JVM | Signed-zero literal correctness; compact real-DEX tier/re-entry fixture | Explicit operands/reused preparation, dense fused blocks and synchronous-until-suspension execution. Component gains did not establish qualifying app gains; latency-sensitive combined results prompted complete operand rollback. |
| Rendering | Detached renderer-hook cleanup, completed Window PixelCopy source, unreachable duplicate branch removal | Completed snapshots, CPU-backed Canvas2D, combined snapshots/backing, separate compositor and narrower UI plane. Neutral hardware results or software pacing/CPU regressions failed retention. |
| Measurement | Synchronized time/counter windows, completed-frame/presentation distinctions, fixed input/state controls, backend verification, uncapped browser errors and exposed process diagnostics | No production timer/scheduling shortcuts or temporary experiment switches remain. |

The original cold executor is byte-identical to baseline. Its compiler differs only
by signed-zero literal preservation; promotion at entry 32 and the 32 MiB hot-source
limit remain unchanged. Rejected implementations survive only in isolated experiment
branches/worktrees and evidence. The pre-existing GLSurfaceView resize-across-await
generation race remains; the rejected snapshot prototype's protection was not retained.

## Measured selection

Measurements used serial browsers, fixed geometry/inputs, 15-second windows after
warmup, no competing diagnostics, and three alternating pairs extended to seven for
near-threshold or inconsistent results. SwiftShader and verified Metal were separate.
Screenshots, tracing and heap collection were outside the in-page timing windows.

| Workload | Final result versus pristine | Scope |
| --- | --- | --- |
| Doodle, seven final native rotations | Title 12.9813 → 10.0514 s; CPU -5.96%; presentation p95 9.2 → 9.1 ms | Completed title and score-zero tutorial; about 120 completed GL/presentation calls per second, not verified tilt gameplay |
| Lichess, three final native rotations | CPU +1.39%; proxy median +1.94%, lower empirical p95 +1.20%; heap -0.044% | Editor/Back responsiveness; variable engine work prevents throughput claims |
| FitNotes, seven pairs | CPU +3.99%; proxy median -4.51%, p95 +2.40%; heap unchanged | Empty Graph/history navigation; CPU worse in six pairs is a retained near-threshold cost |
| Mihon, seven pairs | CPU -0.58%; proxy median -0.21%, p95 -1.22%; heap unchanged | Reader-settings scrolling, not comic decoding |
| Resy, seven aligned pairs | CPU +1.40%; proxy median -5.67%, p95 -6.62%; heap unchanged | Search/Back; matched live content changes across the series remain documented |
| Flappy, three pairs per backend | Metal approximately 60 presentations/s; SwiftShader approximately 29/s, both neutral | Title guard; frozen gameplay replay failed proof and is not a performance result |

The non-native foreground guards describe production `6cbce0b`; the final ISB delta
was independently guarded against that selection and pristine. Those FitNotes/Mihon/
Resy windows execute no foreground native instructions, without proving zero child work.
Input-to-next-presentation is an opportunity proxy, not causal pixel latency/INP.
Presentation counts are atomic bitmap transfers, not physical display refreshes.
Memory measurements cover retained JS heap/backing evidence, not all OS/GPU/child memory.
Native reports use lower empirical p95; other reports label their interpolation method.
The detected percentile-summary mistake, unfavorable pairs and rejected experiments remain
in the [implementation history](docs/implementation-history.md).

## Verification and remaining limits

- Final typecheck and **1211 tests / 26480 assertions** pass. Eight executed framework
  exercises pass; Paint.measureText is skipped without DOM. Declared native coverage is
  295/363 with 68 gaps. Twelve eager/cold smoke compilations across all six target APKs
  have zero method failures; the later native-only delta is covered by final checks.
- Pristine and final full E2E each capture **12 flows / 159 steps / four scored reports**.
  Corpus records **17/17 first draws per revision**. All 318 original PNGs pass geometry,
  chunk-integrity and matching JSON-tree checks. Per-step and process diagnostics were
  reviewed; exit zero, non-wedged counters and early shell draws are not full app success.
- FitNotes' 39 and onboarding's five screenshots are byte-identical. FitNotes still misses
  reps input and produces zero-rep sets; Mihon dark rendering, Reddit signup/login flow,
  YouTube playback and TikTok video/layout failures remain baseline limitations.
- Lichess renders real engine replies on both revisions; the pristine ponder-extraction
  null fault is not claimed fixed because the engine games differ. Doodle lacks usable
  accelerometer input. The short Flappy flow does not prove a successful restart.
- Matched Resy venue/scroll follow-ups reproduce the larger offscreen map position on
  pristine and converge after scrolling. Its original duplicate SVG node did not recur;
  the cause remains unresolved without a visible effect. Calculator differences are only
  1–4 result-glyph edge pixels across the original and repeated pairs.
- Twitch's additional permission error occurs naturally on pristine in the follow-up.
  Maps reaches completed GL on both builds at the later snapshot. Amazon's original frame
  exists on both builds, but wrapper/resolved-document parity remains unverified: neither
  fresh follow-up reaches a WebView in the bounded window. Child logs/performance/queue
  remain unavailable where null; exposed missing/native channels were inspected.

The [final matrix report](webdroid-shots/final-matrix/REPORT.md) links raw captures,
paired reviews, reproduction commands and coverage limits. Served main/process assets
are hash-identical before and after the final captures. All experiment worktrees and the
existing baseline worktree are preserved; goldens were not changed.
