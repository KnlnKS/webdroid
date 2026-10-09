# Plan: compile DEX to WebAssembly

Branch `knlnks/bytecode-wasm` (worktree `../webdroid-wasm`), from `knlnks/bytecode` at `5ad1d22a`.
Research only when written: no production code changed. The prototype has since moved (work package P0): it was `research/wasm/j2w/`, it is now `src/wasm/{compiler,link,host}`
with its suites in `scripts/wasm/` (`bun run wasm <suite>`) and its Java fixtures in `tests/fixtures/wasm/java/`. Sections below keep the file names of their time; the map is in
[wasm-s2-breakdown.md](wasm-s2-breakdown.md) section 1.1 and `lazy.ts` is `link/world.ts`, `threads.ts` `link/sched.ts`, `handles.ts` `link/mhandles.ts`, `oracle.ts` split into
`host/nativesource.ts` and `scripts/wasm/oracle.ts`, `build.ts` `scripts/wasm/lib.ts`, `aotbuild.ts`/`aotstartup.ts` `scripts/wasm/aot-build.ts`/`aot-startup.ts`, `reach.ts` `scripts/wasm/reach.ts`
(its `mid` is `compiler/ids.ts`). `floatbench.ts`, `lazybench.ts` and the j2w `dis.ts` were deleted.
This is a report plus a staged plan for a different coding agent to execute.

## Recovery status (2026-10-08)

The user excludes Genshin Impact, Clash of Clans and Clash Royale from verification. The full
E2E matrix contains 14 configured flows; excluded APKs are not acceptance blockers.

### Queried hierarchy index checkpoint (2026-10-08)

Signature queries now use a lazy cache and compact numeric DEX name chains instead of switching to a whole-program declaration map. Fixed-work probes preserve declaration results and reduce retained data by about 46 MB; this is not app-wide heap evidence. Typecheck, all 19 Wasm sections, 1,212 unit tests, framework/ordinary OSR/smoke and four/eight-jar AOT/persistence pass. All 4,324 rebuilt files remain identical; source `cb91b836fe7f…` serves ordinary `1b5670f294906181`/guarded `7f960edaa709944b`. Full FitNotes passes 39 checkpoints. The initial quick gate passes 5/7, retaining Doodle's monitor cycle and an unexplained Komikku launch throwable; canonical and diagnostic Komikku repeats pass. Matched warm controls bring the first previous-day response below 150 ms (175–178→121–123 ms), while exercise-list responses remain 206–222 ms. FPS and broader acceptance remain open. The history records exact evidence and limits; guarded-AOT handoff coverage is next.

### Platform code over live globals checkpoint (2026-10-08)

Platform code now binds published fallback class globals through the existing class-import binder, preserving data ownership and invalidation. Typecheck, all 19 Wasm sections, 1,212 unit tests on repeat, four/eight-jar AOT (111 each), persistence, framework/smoke and ordinary OSR pass; all 4,324 rebuilt assets remain byte-identical. Source `43ebf3ac2a027…` serves ordinary `b4794b1e007545f6`/guarded `1382db50e4e9f421`. Full FitNotes passes 39 checkpoints; the quick gate passes 6/7 flows, with Doodle's mutual wait reproduced under both loaders. Matched warm controls reduce launch-checkpoint method compilations about 95%, rendered-home time 35% and exercise-list latency 21%, but the first previous-day tap regresses from about 100 to 179 ms as whole-program hierarchy indexing moves into interaction. The 150 ms gate remains failed. Shipping `cold-osr --aot` also reproduces a starting-source assertion failure: its root has no speculative assumptions to invalidate. The history records exact evidence, initial browser transport failures and limits. Removing the indexing cliff and restoring guarded-AOT handoff coverage are next; broader acceptance remains open.

### Rejected-platform patch reuse checkpoint (2026-10-08)

The linker now loads valid app patches after permanent platform code rejection and preserves their lazy slot invalidation ownership. A fallback-global/subclass regression fails on the starting code and passes with the change. Four/eight-jar AOT (107 checks each), eight-jar persistence, loaders, 41 OSR checks, typecheck, FitNotes smoke and all 39 full FitNotes checkpoints pass. All 4,324 platform files remain unchanged under source `a9e02fa27e89…`, ordinary `0f60422daaae0d6d`/guarded `2f9e6fcdd4866f71`. Alternating warm controls reduce launch-checkpoint method compilations from 8,161/8,142 to 5,974/5,998. Exercise-list responses remain variable: before 346.6/297.1 ms, after 263.9/352.1 ms, all above 150 ms. This is cache-reuse progress, not latency/FPS acceptance. The history records controls and remaining class-data fallback work; broader gates remain open.

### App data ownership checkpoint (2026-10-08)

App builds exclude all class data owned by the platform, including reserved classes whose methods are compiled later. This prevents a cached data module from replacing live methods with stubs; app cache version 12 rejects older layouts. A core ownership regression, four/eight-jar persistence, 101 AOT checks, typecheck, FitNotes smoke and all 39 full FitNotes checkpoints pass. Platform assets remain byte-identical under source `7ece376decb25…`, ordinary `003c57ed11e5184b`/guarded `7473ecaf75e27010`. Two fresh canonical warm replays complete without the reproduced startup overflow, but exercise-list latency still fails at 450.2/288.5 ms with varying compilation work. Observer prototypes remain private, and broader latency/FPS/application gates remain open. Details and evidence limits are in the implementation history.

### Host-call preparation checkpoint (2026-10-08)

Bridge caches method caller preparation behind qualified-identity checks and preserves the World's invalidatable wrappers. Eight paired small-call controls reduce Chrome call time by 12–40%; they do not establish application latency or FPS. Typecheck, all 19 Wasm sections, 1,212 unit tests, cold/OSR/framework/smoke checks and all 39 full FitNotes checkpoints pass, with all 4,324 rebuilt AOT files unchanged. Source `6c3b162e0adc…` serves ordinary `ba16499ff1f57098`/guarded `265a2e9cbc65050e`. A fresh unprofiled warm pair still fails the exercise-list response gate at 317.1/314.7 ms with unequal compilation work. The history records measurements, setup failures and limits; broader gates remain open.

### Indexed virtual-slot construction checkpoint (2026-10-08)

Signature-indexed candidate selection preserves package-private declarations, access checks and dispatch-slot order. A fixed-work comparison preserves all 1,516,790 slot entries and reduces construction time 51%; it does not establish an allocation, latency or FPS gain. Typecheck, all 19 Wasm suites, 1,212 unit tests, framework/smoke checks and all 39 full FitNotes checkpoints pass. Source `54af9a587a5b9c25…` serves ordinary `3cb221716a2f01fd`/guarded `0340214ae84f9344`; all 4,324 build files remain byte-identical. Warm exercise-list response still fails at 314 ms (starting-source profile 312 ms), with differing compilation work and substantial observer cost. History records exact evidence and limits; the broader gates remain open.

### Binary emission allocation checkpoint (2026-10-08)

ASCII names avoid temporary UTF-8 buffers, and metadata encodes into section-level arrays. A fixed-work comparison of 737 captured modules preserves all bytes and offsets and reduces emission time by 46% in Node and 69% in Chrome; this is not app latency or FPS acceptance. Typecheck, all 19 Wasm sections, the 1,212-test unit repeat, cold/OSR/framework checks and FitNotes smoke pass. Fresh source `3a53e47b973bd396…` serves ordinary `541489dd5a52ef90`/guarded `d65378005f63f872`, with all 4,324 AOT files unchanged. Full FitNotes passes all 39 checkpoints with 117 responding process diagnostics and identical UI trees. Warm latency still fails: Calculator M's rendered-state timeout reproduces on the starting source; a separate FitNotes candidate repeat takes 300 ms to open the exercise list versus 309 ms on the baseline. An earlier candidate startup StackOverflowError remains unexplained. History records controls, initial failures and limits; the full performance/application gates remain open.

### Shared callee-planning checkpoint (2026-10-08)

Direct and guarded callee planning share one traversal while preserving group/guard order and readiness semantics. Private exact comparisons reduce loader lookups and CHA queries without changing 184 plans; this is work-count evidence, not a timing claim. Typecheck, all 19 Wasm sections, 1,212 unit tests, cold/OSR/framework checks and APK smoke pass. Fresh source `07fc417ecaa1…` serves ordinary `04bf9aec9e749c91`/guarded `0d4efaaa09b9655f`, with all 4,324 AOT files unchanged. The frozen full FitNotes flow passes 39 actions with 117 responding process diagnostics, identical UI trees and only three text-caret PNG differences. Exact evidence and limits are in the history. Other application failures, Worker and performance gates remain open; JavaScript stays default.

### Shared lazy-link admission checkpoint (2026-10-08)

Lazy stubs share one per-World Wasm admission helper while preserving their Java signatures, suspension/exception restoration and table dispatch. Fixed-work FitNotes class construction emits 43% fewer bytes with unchanged metadata; fresh platform class modules shrink about 46%, while all code modules and indexes stay byte-identical. Typecheck, all 19 Wasm sections, the 1,212-test candidate repeat, cold/OSR/framework checks and APK smoke pass. An initial browser fixture parse failure remains unexplained after matching passing baseline/candidate repeats. Source `b215919a74b0…` serves ordinary `a8808f2e56edaa6c`/guarded `d59212cdb4215b87`. The frozen full FitNotes flow passes all 39 actions with 117 responding process diagnostics and unchanged UI trees; goldens remain unchanged. The history retains measurements and evidence limits. This is not complete application or performance acceptance; JavaScript stays default.

The subsequent frozen `13b1c47f` full Doodle/TikTok run captures all 19 checkpoints with 85 responding process diagnostics but fails both flows. Doodle retains its opposing monitor owners; TikTok OOMs after the second swipe, and its video screenshots still show signup/loading UI. Smaller class modules do not establish app recovery. A private invocation-triggered promotion policy also fails its focused steady-state control and is not integrated. Exact scope and artifacts remain in the history.

### Stable symbolic-helper names checkpoint (2026-10-08)

Resolved helpers retain their instructions, bindings and caller Java frame metadata while using one stable non-Java debug name. Fixed-work controls demonstrate lower engine code cost without adding a runtime cache; a private FitNotes comparison preserves all 39 screenshots and UI trees. Integrated typecheck, all 19 Wasm sections, the final 1,212-test unit repeat, framework/cold/OSR checks and FitNotes smoke pass. Two initial browser JAR-loading failures remain unexplained; their candidate and baseline fixture bundles are byte-identical and focused/full repeats pass. Source `251b90c37d16…` serves ordinary `f1aa39b747ea4e7b`/guarded `128b051fde702f7a`, with all 4,324 platform files unchanged. Current-source canonical application follow-through and the final gates remain open; JavaScript stays default.

The subsequent frozen `ade8929d` selected full run captures all 58 FitNotes/Doodle/TikTok checkpoints with 203 responding process diagnostics. FitNotes passes its action checks (7.43% content difference); Doodle retains opposing monitor owners and TikTok still records an OOM without verified playback. Inputs remain stable. This is selected application follow-through, not a full-matrix or performance gate; the history retains exact scope and artifacts.

### Current full application checkpoint (2026-10-08, production `1763b497`)

Selective metadata/header refresh preserves loader semantics in matched controls and passes the integrated compiler/unit/framework/cold/OSR checks with byte-identical fresh AOT. The frozen `582ca82d` full matrix captures all 208 screenshots in 14 flows, but fails Doodle, Resy, Reddit, TikTok, YouTube and ChatGPT. All 709 observed process diagnostics respond; Doodle still has opposing thread waits, TikTok records an OOM, and rendered Resy/YouTube/ChatGPT screens do not establish the requested venue/playback/response. Five scored flows average 18.70% content difference. Source `67a3c407835365…` and ordinary `d4e184dbdd4fef0e`/guarded `0a4fa6880383d20c` assets remain frozen throughout. The history records per-flow evidence and limitations. Final application/conformance/Worker/corpus and performance acceptance remain open; JavaScript stays default.

### Full corrected G1 checkpoint (2026-10-08)

The frozen `354c6903` ordinary run uses production bootstrap/application ownership and validates all 149,480 calls across 74 workloads in Node and Chrome. Source, fixtures, harness and matching assets remain stable. G1 fails: primary-ten steady means are 0.793× Node and 1.048× Chrome; six Node and three Chrome workloads exceed the 10% slowdown limit, and every Chrome first call regresses (mean 0.230×). Background Spotlight activity is observed despite no competing owned benchmark, so idle-host acceptance remains unproved. The history records exact results and scope. This measurement does not attribute the losses to GC or justify a default switch.

### G1 bootstrap ownership checkpoint (2026-10-08)

Ordinary G1 incorrectly flattened platform and app DEX into the application loader; production and the installed scenario use a bootstrap platform beneath the app. Both scenarios now share that construction, and reports identify the layout. An actual World audit finds all 54,727 platform definitions bootstrap-owned and the workload app-owned. Typecheck and the full short 74-workload Node/Chrome comparison pass (592 calls). Private matched controls change timings in both directions, including worse linkedList execution. Earlier flattened G1 runs remain evidence of that harness, not production-layout acceptance. The runtime/AOT source is unchanged; full corrected performance gates remain open.

### Bounded polymorphic guards checkpoint (2026-10-08)

The hot planner now retains its highest-ranked two eligible implementations when more qualify, preserving virtual dispatch for all others. Five-run Node and Chrome controls improve steady HashMap timing with matching answers. The full frozen G1 run validates all 149,480 calls but fails: primary-ten steady means reach 1.557× Node and 1.353× Chrome, while ArrayList loses in both engines, Node sort and Chrome linkedList exceed the 10% regression limit, and all ten Chrome first calls regress. CPU sampling retains 14 negative-delta errors and desktop activity, so idle-host acceptance is also unproved. All 19 Wasm sections, 1,212 unit cases, typecheck, OSR/cold/framework checks and default eight-jar AOT pass. Source `8296c7ccc8bd…` identifies ordinary `0b51dc814a97fd73` and guarded `b0e4ab64daa0b929`; platform module files remain byte-identical to b4d0. The previous diagnostic cut now observes Doodle's mutual thread wait directly, but still fails the gameplay flow. History contains exact measurements and source guards.

### Linker retention and full conformance checkpoint (2026-10-08)

The frozen `b4d0be2d` cut completes all nine conformance suites with zero regressions/unexplained differences and validates 6,227,619 method bodies across all 33 top-level APK/XAPK files with zero failures. Existing divergence pins and 134 baseline tests absent from both tiers remain explicit coverage limits. Matched Doodle still wedges after Play on Wasm while JavaScript reaches gameplay. Full YouTube still wedges; its differing live JS control cannot establish matched playback. These are correctness runs under concurrent load, not idle performance acceptance.

The linker now releases replaced symbolic resolver functions and consumed AOT headers. Matched collection probes establish both retention fixes; existing loaders and AOT checks pass. A private browser prefix retains the intended home card but still wedges at launch. The rejected batching experiment is not integrated. Fresh source-matched assets and application follow-through remain required; the history records exact receipts and limits.

### Eligible-guard checkpoint (2026-10-08)

The hot-call planner now applies its existing minimum execution count and inlinability check before counting candidates against the two-guard limit. Low-traffic startup iterators no longer suppress the workload's eligible iterator. Focused five-run Node/Chrome comparisons improve steady iteration timing with matching answers; first-call regressions and the full primary-ten gate remain open. Typecheck, 1,212 unit tests, all 19 broad Wasm suites, cold/OSR/framework checks and matching eight-jar AOT pass. Current source `489037c219da…` identifies ordinary `e5fd4a029d6a191e` and guarded `54db3ad38b83a3a5`. The history records measurements and limits; final application, conformance, Worker and idle timing remain required.

### Synchronous allocation checkpoint (2026-10-08)

Heap-pressure handling now checks whether its caller can suspend before yielding for finalizers. A host byte-array conversion previously raised an engine `SuspendError`; it now raises Java's actual `OutOfMemoryError`. The previous compiler reproduces the focused failure; typecheck, 134 threading checks, lazy allocation/exception checks and 241 cold-operation checks pass. Matching AOT passed; application verification remains required. The post-import-compaction YouTube capture shows lower instantiation-attributed heap samples and the intended video, but still ends with memory exhaustion; differing live paths prevent an APK-wide causal percentage. The history records raw receipts and limits.

### Import compaction checkpoint (2026-10-08)

Generated modules now omit unused function imports while preserving function references and stack-trace offsets. All 291,144 default-sweep bodies validate; that isolated-method workload emits 28.15% fewer bytes and 92.94% fewer function imports. A production-Compiler helper probe saves about 4,400 live heap bytes per instance; batched platform AOT shrinks only about 0.2%. These are scoped structural/heap results, not an APK-wide or latency win.

Source `a49b6aa2f7cf…` serves ordinary `7d15d79983d11fc4` and guarded `5d552cdb5f4e9dac`. Typecheck, 19 Wasm suites, cold/OSR/framework checks and two 1,212-test unit repeats pass. An initial browser ZIP-loading failure remains unexplained after a passing prepared starting-commit control. Actual ordinary Chromium/WebKit and guarded Chromium FitNotes startup renders and advances ticks with matching guards. The preceding YouTube heap diagnostic attributes about 800 MB of a 2.14 GB sample to instantiation frames, but does not isolate unused imports or reproduce its earlier explicit OOM. The history records controls and limits. Application, conformance, Worker and performance gates below remain open; guarded WebKit remains unsupported.

### Compiler cleanup checkpoint (2026-10-08)

Canonical descriptor parsing, void-result handling, opcode predicates and float-local emission lose redundant work without changing generated code. The default 291,144-body sweep is byte-identical; all 4,324 files inside fresh ordinary/guarded production builds also match the preceding build. Source `549677716dc4…` now identifies ordinary `b05d9363f111d0bd` and guarded `d98efc6ee340c4f1`. Typecheck, all 19 Wasm sections, 241 cold-operation checks, 41 OSR checks, 31 framework exercises and the standard 1,211-test unit run pass. No tests or dependencies are added. Measured work reductions and exact receipts are in the history; the application and performance gates below remain open.

### Current application checkpoint (2026-10-08, production `b020e09f`)

The source-stable ordinary-Wasm full matrix completes all 208 steps across 14 flows and exits 1 for Doodle, Resy, Reddit, TikTok, YouTube and ChatGPT. All 722 observed process snapshots answer diagnostics, including 77 unbooted realms; reachable diagnostics do not prove app liveness. Lichess additionally fails visual review: all 15 screenshots are black despite its non-wedged smoke result, with a Flutter preferences-channel startup error. The five scored flows average 18.79% content difference; no visual-parity or idle-performance acceptance follows. Goldens and production/AOT/APK/native inputs remain unchanged throughout the capture.

YouTube's OOM occurs after substantial compilation; its reported 8 MiB is a periodic allocation-check window, not an identified allocation size. Resy's missing touch-mode delegate is a later error than its initial stall. These need causal profiles and matching controls. The complete receipt is `/tmp/webdroid-b020-full/`; the implementation history records the per-flow evidence and limits. G2/S4/S5/S6 and the previously failing performance/Worker gates remain open. JavaScript remains default.

### Core verification checkpoint (2026-10-07, production `269719d3`)

Custom range invocations no longer establish a false non-null argument fact. Unit format 11 carries compiler-owned class-import metadata, removing WebKit's failing GC import reflection and consolidating platform header construction. Fresh matching ordinary `beac2b720f1b8642` and guarded `07bd5183b198b168` assets compile all 290,828 methods per policy with five existing binding gaps. Typecheck, all 19 broad Wasm sections and the unchanged full 1,211-test/79,749-assertion unit repeat pass. Nine initial browser parser failures remain unexplained. Actual ordinary-Wasm FitNotes startup/render/liveness passes in WebKit and Chromium with complete observed-realm diagnostics; guarded Chromium passes, while guarded WebKit fails with a JSPI RestoreFrameMode stack-scan error before app initialization.

The completed source-stable `5f45a4ea` primary G1 repeat validates 149,480 calls across all 74 workloads in both engines. It still fails: primary-ten steady means are 1.319x Node and 1.299x Chrome, individual losses exceed 10%, and all ten Chrome first calls regress (mean 0.231x). G4 default numerical rows pass; guarded irreducible execution still misses the 100 ms threshold, and engine-tier correlation remains incomplete. The CPU sampler records ten negative-delta errors and competing desktop load, so these are not accepted idle-host results. Doodle gameplay, native Worker shared mappings, complete compiler accounting and final conformance/application/performance gates remain open. The compile-Worker readiness handshake and checked guest-copy invalidation are integrated. JavaScript remains default and goldens are unchanged.

### Preceding recovery checkpoint (2026-10-07, production `e3b51392`)

Host-only Wasm entries skip unnecessary Error allocation while preserving explicit cold/synchronous callers and logical ancestry. Canonical descriptor-owned shared pages retain independent leases and refresh persistence snapshots after direct page mutation; raw native shared mappings remain unsupported until checked core access, atomic publication/reservations and futex ownership are coherent. Failed A64 exclusive stores preserve memory when no reservation exists, and checked JS JNI writes invalidate executed code. One-shot app builders skip unused refinement setup. Optional bounded compiler spans and Worker journals now retain disjoint elapsed work and ownership, but total compilation accounting remains incomplete.

The combined parent passes typecheck, all 1,211 unit tests/79,749 assertions, 47 owning native/layer checks and persistence. Parent Chrome/WebKit caller controls pass after the host-entry change; actual explicit-JS WebKit FitNotes startup renders its intended welcome UI with advancing ticks and no observed process errors. The earlier unexplained browser SyntaxError remains recorded alongside passing unchanged and starting-commit controls. Four of nine conformance suites pass on the frozen preceding 7eb source with no regressions or unexplained differences. Fresh matching AOT, the remaining conformance/application/Worker matrix and idle G1/G3/G4/G5 acceptance remain required. The JS compile worker's initial-request readiness race is under repair. JavaScript remains default and visual goldens are unchanged.

### Preceding recovery checkpoint (2026-10-07, production `7ebf4b7e`)

JavaScript and Wasm caller recovery now recognize actual WebKit frames while preserving defining-loader identity and truthful unknown positions. The engine-only probe has a neutral shared owner. Optional early/terminal compiler counters use a common root clock; disabled telemetry avoids browser-only access in Node. Current typecheck, all 1,211 unit tests/79,635 assertions, 23 cold-initialization controls and parent Chrome 153/WebKit 26.5 caller/recursive/suspended controls pass. The preceding full unit invocation retains three explained integration failures: the frame-owner import crossed the linker boundary, and disabled telemetry evaluated location in two Node tests. Fresh production AOT and application startup repeats remain required; served assets still belong to d239.

Complete uninstrumented six-input Doodle controls on d239 and the authentic starting c6 source reproduce healthy JavaScript and wedged Wasm gameplay at both commits. Their different Play images do not establish an identical internal cause; G2 remains open. Worker native MAP_SHARED/atomics/futex ownership and complete compiler-worker accounting are being implemented. The remaining conformance/application/Worker matrix and idle G1/G3/G4/G5 acceptance remain required. JavaScript remains default and visual goldens are unchanged.

### Preceding recovery checkpoint (2026-10-07, production `9e208dd2`)

Ordered defining-loader lookup, explicit bootstrap ownership and ART-shaped in-memory DEX cookies are integrated. Host I/O, font, codec, bitmap, cipher and GL buffer operations use canonical owner transfers; GL retains context, output bounds and error state across waits. Fresh eight-jar ordinary `374364963ebf1fba` and guarded `1b5a32493017dd51` assets match source `d2399bc5…`. Typecheck, all 19 broad Wasm sections, 31 framework exercises, 241 cold-slow, 41 OSR and 23 initialization checks pass with stable source. The first unit invocation retains one browser ZIP startup failure; an unchanged focused check and full 1,211-test/79,633-assertion repeat pass. A matching starting-commit unit control passes; the transient failure's cause remains unproved.

The serial quick gate captures all 105 checkpoints and passes six of seven flows. Doodle's same-source JavaScript control completes all six translated inputs; Wasm enters the tutorial then freezes on Play, with four later wedged checkpoints. All relevant process diagnostics reach the runtimes. This is an unresolved G2 failure, not a buffer-repair success. Stable interim NIO and NIO-file comparisons have zero regressions or unexplained differences; NIO-file retains nine documented pins. The remaining seven conformance suites await the next freeze.

Chrome 153 and WebKit 26.5 execute the required Wasm probes. The narrow packed-asset header repair removes WebKit's gzip digest mismatch, but actual JavaScript app startup still fails at caller-sensitive class initialization because the stack parser does not recognize WebKit frames. The private repair remains under investigation. The stable full 33-APK binary-validation sweep validates all 6,227,619 method bodies with zero failures (375,055 additional bodyless declarations). Full application/Worker and idle G1/G3/G4/G5 acceptance remain open. JavaScript remains default and goldens are unchanged. Detailed controls and limitations are in the implementation history under “Owned GL transfers and the frozen d239 verification cut.”

### Preceding recovery checkpoint (2026-10-07, production `c6d40dff`)

Hot refresh and resumed-loop counting are integrated. Matching eight-jar ordinary/guarded assets have source `47503d22…`, keys `ff5a163d6a8d9040`/`27da2fed4780a8b4`. Full typecheck, all 19 broad Wasm sections, 31 framework exercises and zero-failure FitNotes smoke compilation pass. An unchanged full unit repeat passes 1,208 tests/79,596 assertions after two unexplained browser SyntaxErrors in the first full invocation; diagnostic passing repeats do not establish a repair. Current Chrome/WebKit probes execute required GC/EH/tail-call/string/JSPI features, while both reject JS frames across a suspending import. The default six-jar/FitNotes sweep validates 291,144 bodies with zero failures. These runs overlap independent correctness work and supply no idle performance acceptance. Complete application/conformance repeats remain required. The private Doodle diagnostic used untranslated actions and establishes passive rendering/callback observations only, not a full gameplay control. Commands and evidence limits are in the implementation history under “Integrated hot-refresh baseline and browser support repeat.” G1/G3/G4/G5 and S6 remain open; JavaScript remains default.

### Preceding recovery checkpoint (2026-10-07, production `2f92c766`, capture/accounting/sweep harness through `983cb83d`)

Concrete default conflicts now remain explicit through virtual/interface, host and JNI invocation, including serialized replay and CHA invalidation. Format10/APP_VERSION10 rejects earlier concrete-target semantics. Fixed VarHandle access modes use validated canonical boot enum fields; inherited public reflection preserves defining Runtime; wide CHA can stop at a matching class body. Core private controls and all 54,871 flat/shared layout vectors pass. The integrated first full unit run has eight failures; the reproduced MethodHandle lookup regression is repaired and the full repeat passes 1,207 tests/79,592 assertions, while seven initial browser JThrowable failures remain unexplained. Matching format10 eight-jar production AOT and the 19-section broad core run now pass, with cold-slow/OSR and all 31 Wasm framework exercises. All 33 APK sweeps complete; TikTok fails on Bun executable-memory exhaustion. The full nine-suite run finishes seven successful suites and two failed exits: Guava Maps times out, and IO rejects a stale divergence count. The IO correction retains exact private-suite coverage accounting and all 124 absent baseline names; targeted combined checks pass. The exact TikTok Node constructor control also exhausts Wasm code space. Reusing the existing compileOnly World mode and canonical binary validation checks all 1,855,399 TikTok bodies successfully in V8; the integrated all-33 V8 repeat passes all 6,227,619 method bodies with zero failures and stable input/source guards. An exclusive full Guava repeat reproduces the Maps timeout with all four classes retained. A separate diagnostic starts its first test after 445 seconds and records at least 237,568 completions before timeout; The null-reference VarHandle repair preserves live handle/type/coordinate guards and canonical fallback, with 46 supported JDK/compiled/cold controls matching. Its uninstrumented four-class Guava repeat completes Maps in 293.4 seconds: 368,772 passes, 22 expected failure records, zero regressions and zero skips. The original exit 1 identifies a resolved replaceAll divergence pin; removing only that pin gives a successful cached comparator replay, while injected failures and missing cases still fail. Underspecified VarHandle calls now retain canonical WrongMethodTypeException behavior in 12 actual JDK/DEX controls. The integrated parent passes all 58 controls and full typecheck; fresh eight-jar ordinary/guarded AOT matches source `acd45dbf…`. Final-source broader repeats remain pending. The overlapping full browser attempt is retained as incomplete; a bounded owned-browser harness passes the eight-step Calculator control. Complete exclusive application and performance repeats remain required.

The validated Doodle capture identifies both actual lock objects and Java frames: main holds serviceLock while entering billingLock; a distinct JNI Java Thread holds billingLock while entering serviceLock. Same-source JS gameplay passes and its billing callback keeps the native CPU's actual Thread. The cold-aware JS observer now identifies the actual main Thread in the service callback and a distinct billing Thread. The trigger for the Wasm-only inversion remains under investigation; the complete exclusive ordinary/guarded six-step comparison now fails both policies. Ordinary passes launch/title only; guarded also passes initial play, then taps/playing/Back fail. Source/assets are stable and both owned browsers close. No app lock rewriting or forced callback ownership is introduced.

The private hot-refresh candidate completes all 74 G1 workloads with 149,480 correct calls and stable source/assets, but fails the primary-ten gate: steady means are 1.214x Node and 1.185x Chrome, and all ten Chrome first calls are worse. Continuous CPU-owner provenance is retained; no matched integrated-baseline repeat or causal speedup is claimed. The candidate remains private. The current G4 repeat returns correct results for all six rows but leaves default irreducible reference stability, cold irreducible first-activation speed and correlated engine-tier identity open. The VarHandle change reduces emitted lookup work but has no accepted latency result. Default JS remains unchanged. Evidence and limits are recorded in the implementation history.

### Preceding recovery checkpoint (2026-10-07, production `87facb0e`)

JNI virtual/nonvirtual calls now preserve valid abstract declarations and raise AbstractMethodError at invocation; 24 real JDK/guest JNI compiled/cold comparisons pass. Full typecheck passes. The unchanged unit repeat passes 1,207 tests/79,592 assertions; two browser syntax failures in the initial full invocation remain unexplained and retained. Fresh ordinary `1445f5d2a547c5df` and guarded `33af20a7d731b8d5` assets match source `3d597a9a95aa930a82d9ecc90f27410c268230d240bc872dd5ae93641d442859`. The all-19 broad run, cold-slow, OSR and both framework exercises pass on preceding source `aa2f7267a896`; current-source broad/application/conformance coverage remains required.

All 74 G1 workloads complete on both engines with 149,480 validated calls and zero errors/omissions. Primary-ten JS/Wasm means are Node first 1.849/steady 0.633 and Chrome first 0.281/steady 0.571: G1 fails. The exclusive diagnostic window has no competing agent CPU, but continuous CPU-owner utilization was not recorded; load provenance remains provisional. Default G4 shapes reach their measured references within 100 ms; cold irreducible's reference is unstable and correlated engine-tier traces are absent. G4 remains open. Commands/hashes/raw measurements: `/tmp/webdroid-final-gates-87fac/handoff.json`.

Same-source JavaScript Doodle passes all six checkpoints. Bounded Wasm captures prove a two-monitor wait cycle between main and a distinct JNI Java Thread after a working title. The pending callback and unchanged bytecode supply an opposite-lock-order candidate; direct field equality, main inner call and actual JS Thread comparison remain required. A separate unchanged-DEX control confirms that conflicting concrete defaults incorrectly execute an ancestor body in Wasm. Its JDK virtual/interface errors differ, so Android call-site error selection remains under investigation. No gate or default-tier switch follows.

### Preceding recovery checkpoint (2026-10-07, production `a83afdb5`)

Format 9 retains matching flat/shared platform layouts. Ordinary defaults now use canonical maximal declarations on both tiers; an abstract redeclaration suppresses inherited defaults and fails at the call site. The unchanged binary-evolution control passes 22 compiled/cold/root/separate-loader cases. Host-entry continuations retain the allocating caller's Thread and same-thread native ancestry across waits, while explicit thread switches retain independent monitor ownership. Full typecheck, 1,207 unit tests/79,592 assertions and 48 Wasm/40 JS positive default controls pass. These focused checks do not replace the complete integrated execution matrix.

Fresh dual-policy eight-jar assets compile 290,828 methods per policy with five existing binding gaps: source `aa2f7267a896aafca4c4bae0a7e77e6cf43d05b98aba3c120749351879287805`, ordinary `6e6df0fd2823f4cd`, guarded `8d506c874b9d310c`. The explicit-Wasm serial quick gate retains all 105 checkpoints across seven flows. Six flows pass, including Komikku's 23 checkpoints; Doodle Jump fails gameplay liveness and motion. Every booted process has copied nonzero Wasm counters; one unbooted onboarding process is reported separately. Evidence is `tests/e2e/actual/parent-recovery-a83afdb5/quick/`. Doodle's matching prior-source control also wedges after its working title screen; the blocked main job remains unexplained and is not waived.

The previous `3537fde8` Resy prefix retains all three requested steps but still times out during close. Komikku completes 23 checkpoints on that cut with a Handler/Looper error at the reader step. The later unmodified quick capture has no such error; that observation does not establish the constructor ownership repair as its cause. Earlier wrong-tier prefixes remain JavaScript controls. Current captures explicitly select `?tier=wasm` and retain per-process diagnostics.

Regular-file notification rights and exceptional scheduler continuation ownership repairs are integrated. Shared ashmem coherence, full current-source conformance, full application/Worker coverage and idle G1/G3/G4/G5 measurements remain required. G1 rejects incomplete or drifting samples and never aggregates a narrowed successful subset. Promotion-copy removal reduces controlled work counts without establishing latency. The sweep now allows only reported missing-native capability gaps; obsolete string-constructor and lambda-bootstrap blanket allowances are removed. No default-tier switch or gate closure follows.


The recovered compiler, launch/cache and correctness packages are merged through `c0bbbd81`. Full typecheck and the 1,200-case unit suite pass on the combined source. The broad Wasm run passes every suite except its initial loader fixture, which failed on a missing shared-library control declaration. That declaration is restored, and the corrected loader suite passes in a focused repeat; the original run retains its failed exit status. Earlier frozen `7d5f8ae2` passed all suites and 31 framework exercises, but those results do not substitute for combined-source verification. The generic generated-proxy defining-loader repair is integrated at `a4eaa981`; clean-tree loader, class differential, thread, host-class, AOT/persistence and typecheck checks pass. Fresh dual-policy eight-jar AOT compiles 290,828 methods per policy with five existing binding gaps. The default iframe quick gate passes 7/7 flows and 105 checkpoints. All nine frozen-source conformance suites pass with zero regressions and zero unexplained differences (410,872 raw passes, 597 failure records, zero skips). The full browser matrix finishes with five failing flows and a Resy field-resolution difference, so final acceptance remains open. Full conformance and browser coverage remain required for final G2 acceptance; the implementation history records the commands and evidence limits.

The later recovery cut integrates MethodHandle/MethodType constants, all nine DEX handle kinds, libcore transformer execution through EmulatedStackFrame, canonical initiated-class lookup, suspending Java-loader resolution and JNI FindClass. Platform DEX ownership differs from the application root, and package access includes defining-loader identity. Class.forName now invokes Java loader overrides and separates lookup failure wrapping from initialization. Generic invoke-custom executes the actual Java bootstrap and current CallSite target; combined checks pass 604 reference cases, 229 cold cases, 12 suspended cases, eight ART-derived collector/retry/race cases and two synchronous callback cases. Compiled symbolic sites and some polymorphic handle modes remain open. The broad combined run exposed fixture classpath, suspension and boot-order assumptions; the corrected repeat at `1b679ac7` passes all 19 sections, including all 42 workloads and 99 thread checks. The original broad invocation retains its failed exit status. Separate cold-slow verification exposed an admission-resume ownership race; `5ad21add` restores ownership inside the resumed Wasm stub and passes 241 cold checks and 55 selected thread checks. Lazy-link turn admission remains provisional: a private source-matched TikTok candidate now draws and starts three processes but still fails its later liveness check. Fresh AOT, the final application/conformance matrix and performance gates remain required.

The combined `bc4117a0` cut adds execution-time symbolic loader resolution, hierarchy preparation before layout, bounded batching of already resolved cold operations, atomic field accessor installation and canonical direct VarHandle adaptation/views. TypeScript, loaders, 241 cold checks and 694 custom-reference comparisons pass. Its separate OSR check fails the live interface-slot invalidation assertion; guarded continuation transfer must remain exercised before acceptance. AOT metadata is now version 4, so fresh assets and browser verification are required. Remaining handle/bootstrap symbolic references, signature constraints, helper compile accounting and retained ordinary-method analysis also require review. No new performance or application acceptance is claimed.

The subsequent combined cut restores guarded operations for prepared initiating identities, passes 153 shipping OSR checks, 100 full thread checks, 694 custom comparisons and 59 AOT checks. Format-5 symbolic metadata avoids retaining full ordinary analyses; bounded reuse and remaining symbolic handle/bootstrap references still require review. An on-demand Resy diagnostic draws onboarding but fails on GMS process death: JavaClass.new passes an admitted allocation Promise into Bridge.toHost. Its canonical synchronous allocation repair passes matching before/after core checks; the application repeat remains required. These results do not establish browser or performance acceptance.

The `83acf79d` cut bounds recent symbolic analyses to four methods/65,536 cost cells and passes the eviction/lifetime probe, 700 custom comparisons, helper invalidation recovery, TypeScript and 41 OSR checks. Complete helper cost accounting and executed signature/bootstrap Java-loader wiring remain open. Resy's repeat no longer records the GMS allocation death, but still wedges in a JNI callback waiting to reenter Mapbox LibraryLoader's monitor. A matched core check identifies host-strand loss when a fast nested callback returns through idle Wasm globals; the entry boundary now restores its exact caller. ChatGPT's welcome-only interrupted capture remains a failure. Fresh production AOT, application repeats and the final correctness/performance matrix are still required; the implementation history retains the failed runs and controls.

At `4ed03c89`, executed handle/type/bootstrap signature loading, optional combined-image app ownership and prepublication AOT dependency retries are integrated. Full typecheck, 1,200 unit cases, focused custom/loader checks, fresh four-jar AOT, persistence and 241 cold-slow checks pass. The actual `c64ca4eb` Resy retry reaches four GL frames but still fails liveness; the original JNI monitor cycle is absent in its final root trace. Current eight-jar delivery and application acceptance remain required. The broad combined run finishes with 18/19 sections passing; its standalone cold-suite loader-state regression is repaired in a focused 1,290-case repeat. The original broad run remains failed. Helper accounting and initiated-owner polymorphic prototype resolution are subsequently integrated; bounded asynchronous AOT readiness remains open.

The shared-host G1/G4 measurements recorded in the implementation history are provisional: G1 steady-state geometric mean is about 2x with the weakest measured installed-app workload at 0.91x, while Chrome first-call geometric mean remains 0.93x installed and 0.31x on demand. The three G4 loop shapes reached their measured optimized reference in 22–23 ms. Final acceptance still requires matching idle-host measurements after correctness and source integration stabilize. S6 retains the JavaScript oracle for one release after the default switch, as specified below.

Recovered from `1d7fdeea` after the session crash. The gate definitions in section 6 remain the acceptance criteria; historical measurements and a successful compile sweep do not establish full runtime parity.

| Gate | Recovered evidence and work still required |
|---|---|
| G1 | Open; current primary protocol fails. All 74 workloads complete correctly; primary-ten steady means are Node 0.633x/Chrome 0.571x, with Chrome first 0.281x. Attribute warm crossings and compile/tier-up costs before a corrected idle repeat. |
| G2 | Open for final acceptance. Differential suites and `fwtest` (31/31) pass. The TestNG runner now recovers 6,123 previously skipped executions; the affected classes pass 8,065 cases without skips. The nine-suite serial recovery cut now reports 410,872 raw passes, 597 failure records and zero skips, with zero unexplained differences; the final integrated source/browser gate remains open (section 6). A compile sweep checks translation, not execution of every method. |
| G3 | Open. The stated bar is 30% less cold-call compile time and every gated tap at most 150 ms. Record matching cold/warm compile counters for every named app; launch parity is also required by S4/S6. X1's launch timings alone do not settle the compile-time criterion. |
| G4 | Open. Current default shapes reach the measured reference in 21–47 ms and two cold shapes in 20–26 ms. Cold irreducible has an unstable reference/no established speed window; correlated engine-tier proof remains required. |
| G5 | Open. The string representation comparison is measured; the required boundary share below 5% of a heavy tap has not been demonstrated. |
| G6 | Not implemented. X1 records a measured decision to pursue module-loading reductions instead of a heap image; this is a design decision, not a successful image-loader measurement. |
| G7 | Measured for Chrome and the WebKit build. Firefox is excluded by the user's instruction. |
| G8 | Provisional decision recorded in [0004-wasm-heap.md](decisions/0004-wasm-heap.md): continue Wasm GC, keep G1 open, and reconsider a heap replacement only with measured attribution. |

S0–S3 have substantial implementations and harness coverage. S4 has AOT delivery, worker compilation and an opt-in shared Wasm interpreter with canonical slow opcodes, Java exception dispatch, monitor ownership and suspended-native continuations. Precise-PC compiled resume entries pass 872 checks, including actual cold execution followed by a Wasm tail transfer; production promotion and deoptimization pass 153 shipping AOT checks, including ordinary Worker-compiled roots, guarded invalidation and capture ABI rejection. Matching instrumentation/cache policy and promising startup recording are integrated. Standard eight-jar delivery validates 290,828 methods with five existing gaps and records 153 startup files. Cold caller/annotation initialization passes 23 fresh-World checks; real suspending weak-reference vsync initialization passes 12. Full cold application startup and performance remain open. The integrated closure-lifetime repair reduces retained callFn Compiler objects from 1,000 to zero while executable helpers remain live; 31 host-class checks, 153 shipping OSR checks and typecheck pass. This isolated GC proof does not establish complete cold application parity. S5 now boots the real Android system owner before the first foreground application Worker, selected by `?processMode=worker`; page-owned IME commands and canonical terminal-exit diagnostics are integrated. WebView, FD/ashmem and complete application verification remain unfinished. S6's default switch/removal is unfinished. Optional and open-ended work follows completion of the main stages and gates.

The `49b506b0` integration adds PID-bound canonical pending-intent/alarm/location commands and acknowledged service-start state, with 61 core cases/1,057 assertions, the real Worker endpoint case/nine assertions and typecheck passing. The actual Wasm Worker selector delivers an unchanged FitNotes welcome frame and complete copied diagnostics, but first-foreground/system-owner bootstrap, FD/ashmem, IME/WebView and expected-exit classification remain open. A real-clock full FitNotes capture at `46ece0e7` renders 39/39 steps, all intended sets and the custom exercise, with no fallbacks/errors/timeouts and 7.43% mean content difference. Accelerated readiness repair `3a14a23e` retains controlled virtual gesture horizons and waits for requested text/editable targets: standalone FitNotes also completes 39/39 with correct data and no fallbacks; the frozen-source seven-flow repeat passes 7/7 and 105 checkpoints with empty errors/gaps, including the same correct FitNotes data. No idle timing or whole-matrix acceptance is implied. Goldens are unchanged.

The later frozen `1ac5d96e` runtime/AOT `8eae625bb8b70e77` with harness `a437162c` repeats the seven-flow quick gate: 7/7 and 105 checkpoints, empty errors/gaps, unchanged goldens. Shipping OSR now passes 153 checks. Worker Calculator renders all eight steps with 1.17% result difference but fails initial service diagnostics and Back acknowledgment; S5 is not accepted. Matched cold-on probes still fail app liveness/UI delivery, and a real-clock cold-off FitNotes diagnostic reproduces an absent native RenderNode during accessibility traversal. The cold monitor-order failure is classified against both source epochs and controlled JDK schedules; its strengthened existing fixture passes 171 checks without weakening the strict admission assertions. Final cold startup, intermittent native-handle cause, full/browser/conformance and idle performance acceptance remain open.

At runtime `46d9cf5f`, fresh standard AOT `b8607f64217e9050` records 153 startup files; typecheck, 175 cold-slow and 153 shipping OSR checks pass. The actual Worker Calculator flow now passes all eight checkpoints with clean copied root/Worker diagnostics. Worker FitNotes renders all 39 checkpoints and the intended data, but new-save fails in the system process with a missing window Binder service and ToastPresenter inflation error. IME and Back fixes are exercised; this root failure keeps the Worker gate open. Goldens remain unchanged and shared-load timings are not acceptance evidence.

Y1 stabilization, Y2 host-class/JNI dispatch and synthetic input timing, the TestNG runner/shared cache recovery, typed loop re-entry, full-width executable metadata and deferred thread context-loader initialization are merged. Sections 4.19–4.21 record Y2 verification, navigation and archive transport. Historical full attempt `d3847282` crashed in TikTok with native V8 out-of-memory; its repeated black YouTube captures and interrupted run are not acceptance passes. The Mihon outlined-frame regression is fixed by charging only active frames, with matching outlined/unoutlined controls completing five captures. Later lazy member metadata avoids retained unrelated members in an isolated heap probe; it does not establish whole-app OOM closure.

The `2ace54d6` compiler cut uses eight-jar platform AOT `689ade30b26fa0dc` (290,828 methods, five existing gaps). Compact native chunk locals remove unused root-method padding from outlined functions; state indices and the stack quota stay unchanged. Komikku completes all 23 steps in an unmodified standalone capture and in the seven-flow quick run. The quick gate passes six of seven flows: FitNotes throws `Proxy(JThrowable)` after partial captures through History. The summary's zero returned FitNotes steps reflects the discarded partial result, not a startup failure. Separate routed diagnostics reproduce invalid native handles in Paint drawing and input delivery, with guest process death; three timing-changing traced runs complete 39 steps. These observations do not establish a cause or waive the official failure. Evidence is retained under `tests/e2e/actual/parent-recovery-2ace54d6`; the earlier matched outlining controls remain under `parent-recovery-6faa0c2b`.

The later `4845c6c8` cut captures all 105 quick-flow steps with six of seven flows passing. FitNotes completes 39 steps, and Komikku completes 23; this does not establish a cause for the earlier intermittent native-handle failures. Doodle Jump fails on an HTTP 502 from the Google check-in proxy. All 300 process snapshots are healthy, with no new missing APIs, native requirements, wedges or draw errors. Evidence is retained under `tests/e2e/actual/parent-recovery-4845c6c8/quick`. This cut predates the clock, SQLite, cookie and compiled-resume integration and is not final acceptance.

Process endpoints now use owned MessagePorts with reentrant request dispatch, serialized Java exceptions and pending-call rejection on death. SQLite connections/statements and CookieManager commands have canonical broker ownership; controlled clock ports preserve shared ordering and cancel process timers on death. Their Worker bootstrap integration now attaches clock, identity and reverse commands before JVM loading; incoming endpoints use local JVM handlers. Clipboard, settings and accounts also use canonical commands. Worker frame transport bounds retained bitmaps and acknowledges page consumption; actual Worker application entry remains unfinished. File descriptors still lack complete shared backing/offset semantics. Other mutable stores, presentation and actual process Workers remain unfinished. At `ff3a90f0`, integrated typecheck and the 1,105-case differential suite plus two wide reflection cases pass. Final integrated conformance, browser acceptance, idle performance and shipped-AOT deoptimization remain active.

The `5a92ffed` production cut uses matching AOT `6c266304fccf3b71`. Its seven-flow quick run passes six; FitNotes aborts after partial captures through category creation. An unmodified standalone FitNotes capture subsequently completes all 39 steps, without closing the intermittent failure. The harness now retains completed-step diagnostics and an explicit abort record instead of reporting zero steps. Cold slow adapters avoid whole-caller native declaration rescans (5,439 to 17 words on unchanged fixture); the expanded constructor fixture passes 166 comparisons after correcting its throwable binding to match production. These correctness and work-count checks do not establish G3 latency acceptance. Actual application Workers and the remaining S5 boundaries are still required.

The later `1c71bf8f` production cut builds eight-jar AOT `0ca3f714445d8b1e` (290,828 methods, five existing gaps); typecheck and 40 cold OSR checks pass. The latest unmodified quick capture at `d9087293` passes six of seven flows. FitNotes fails at step 22 in RenderNode.nHasIdentityMatrix with an absent native object, freezes ticks and wedges its main queue. The browser was explicitly terminated after retaining failed-step diagnostics; its target-closed abort is the intervention, not the initiating failure. Several timing-changing handle diagnostics complete all 39 steps without capturing a missing handle and do not close the failure. Aborted quick summaries now retain the earlier guest errors. Display and account command integration follows this production cut; fresh application acceptance remains required.

Canonical account command/bootstrap wiring and bounded Worker frame transport are integrated. Parent permission and preference contracts now await owner replies in their Java callers; preference mutations no longer expose or write back whole mutable maps. Their combined data/device/notification checks pass 39 cases/208 assertions, including real preference ports, and typecheck passes. Permission/preference PID binding and Worker bootstrap wiring remain assigned to Y2. Application Worker entry, canonical notification/service/VFS state and FD/ashmem coherence remain required. The latest cold-on pair stalls in attachApplication without presentation; 15 cold caller/initialization checks and 40 integrated OSR checks pass, but this does not close application startup.

At `db099c8d`, the official ordinary Worker full run reproduces FitNotes's missing RenderNode in Editor.PositionListener during the third set save; the independent RefBase fixture does not close this recurring failure. Calculator completes eight checkpoints without runtime errors but differs by 13.41% against the full visual reference. The matching cold=1 Worker full run fails the unchanged boot/action/liveness budgets. Both failed captures are preserved under `tests/e2e/actual/parent-recovery-db099c8d`; neither is idle performance evidence. Distinct Wasm cold execution and compiler-phase counters now reach copied process telemetry.

At `975ef87e`, typed local reuse resolves the matched ChatGPT iframe logical stack overflow without increasing quota. Binder regular-FD transfer and copied terminal crash reports are integrated;59 selected Java/native/Worker cases399assertions, full typecheck,241 cold-slow and153 shipping resume checks pass. Fresh standard AOT `cecb95557b2ccf13` uses source040662401a20304d9a54a4bfa38a571852e8114d60ab4429f4dd00452541d176 and153 process-bootstrap startup files. Private cold register buffers and indexed slow-op instructions reduce a focused snapshot microprobe's median29%; actual forced-cold Worker Calculator still does not draw within the60-second diagnostic, with root185 and app269 AOT misses. This is neither the official launch gate nor idle performance acceptance. Actual font/ICU module preload coverage remains under investigation. RenderNode has a captured generic-finalizer release while its Java owner is alive; the offending registry owner remains unidentified. Actual Worker ChatGPT memory tracing attributes substantial concurrent heap to three compiler Workers; renderer OOM remains unresolved. Full/live/corpus and final idle G1/G3/G4/G5 gates remain open.


Regular-file canonical ownership is wired through Java and ARM I/O at `c9c280dd`; merged core checks and the actual Worker endpoint fixture pass. The matched JS Worker ChatGPT startup no longer fails on the split directory/open owner. Actual Wasm Worker startup still fails: after the shared-library graph integration (`80edae9e`, AOT `61104d66d0f187ef`), an unmodified diagnostic replay records V8 javascript OOM (Scavenger: semi-space copy) before a first frame. The earlier renderer Target-crashed result remains separately preserved. Shared-library metadata, defining-loader identity and dependent-cache rebinding are integrated; loaders, threads and 153 shipping OSR checks pass on the stated cuts. Compose's observed overflow is the compiler's logical stack guard. Binder FD grants, cross-Worker shared mappings, application correctness and all open performance gates remain required.


At `efad9424`, the actual InputChannel cleaner/reused-RenderNode cause is repaired without the independent Vector change. Ordinary and forced-cold ownership fixtures and typecheck pass; source-matched eight-jar AOT `612bdb445ed935c7` retains153startupfiles. Official Worker cold=0 FitNotes passes39/39, content8.51%, with healthy process diagnostics at every checkpoint. Calculator passes8/8 with no observed runtime gaps/errors; its13.41%mean visual difference also occurs on the matched JavaScript control, concentrated in the post-Back launcher reference. The actual result and post-Back PNGs match across tiers; this is compiler parity on those paths, not Android launcher support. The temporary422-module cold Calculator control on `9ceed5f1` also draws with all observed processes healthy after canonical public-field and list callbacks preserve suspension. Shipping startup coverage still needs the worker-aware profile, not this response override.

At `5f4d4225`, explicit copied Worker AOT profiling and bounded/lazy compiler-worker lifetimes are integrated. The actual Worker profile fixture passes1/11; persistence adoption, refinement and stale-unit checks pass. The memory agent's matching unchanged ChatGPT control observes at most two compiler targets and no renderer crash, but exits on a Cronet constructor NPE before UI. No complete OOM, ChatGPT, full cold application or idle timing acceptance is claimed. Final integrated conformance/full/live/corpus, canonical stored descriptor/shared mappings, G1/G3/G4/G5 and S6 remain open.

The `71326ca9` integration adds selective packed-archive DEX loading, bounded compiler-typing reuse, active-range Java-loader catch resolution, prepared Worker hierarchy certificates, binary-descriptor member lookup and bounded demanded AOT readiness. Module format 6 rejects the previous lazy-link ABI. The preceding fresh-AOT Resy and ChatGPT diagnostics still fail; Resy's root trace identifies a background whole-archive DEX wait, and the selective loader repair passes its matching core control. Cross-loader initialization constraints, compiled boot catch semantics, fresh integrated application/conformance verification and idle performance remain open. Detailed commands and evidence limits are in the implementation history.

## 0. How to read this

- **Measured** = I ran it (Chrome 153 on an M4 Pro, headless, single runs, other agents idle or lightly
  loaded; treat as indicative, rerun under the AGENTS.md measurement rules before relying on any number).
- **Reported** = a sub-agent counted or read it; scripts are in `research/wasm/`.
- **Inferred** = reasoning, not tested. Every inferred claim that a stage depends on has a gate in section 6.
- The earlier analysis (docs/decisions/0003, docs/dex-performance-architecture.md "Rejected") said a Java Wasm
  backend has "no eligible numeric bottleneck" and that Wasm would "add host crossings". Both assume Java
  objects stay JS objects and natives stay JS. Neither was measured. This plan does not inherit them.

Research artifacts:

| Path | Content |
|---|---|
| `research/wasm/micro/*.mjs` | microbenchmarks (alloc/GC, i64, dispatch, JSPI, compile, EH, interop, modules, tier-up) |
| `research/wasm/gc/` | Zig mark-sweep collector for a linear-memory heap, benchmark driver |
| `research/wasm/dexstats/REPORT.md` | opcode, type-inference, method-size, CFG, CHA statistics over 704k methods |
| `research/wasm/native-survey.md` | how the ~75k lines of TS touch Java values (counts per category and per file) |
| `research/wasm/runtime-inventory.md` | ~40 runtime facilities: JS mechanism, Wasm need, essential vs artefact |
| `research/wasm/platform-status.md` | Wasm feature status by browser (partly unverified, see section 5) |
| `src/wasm/`, `scripts/wasm/` | DEX to Wasm-GC prototype compiler (incomplete, see section 4.4); was `research/wasm/j2w/` |

## 1. Findings that drive the design

### 1.1 Execution speed (measured)

| Kernel | JS (current idioms) | Wasm GC | Linear memory |
|---|---|---|---|
| Binary tree build + walk, depth 18 x 20, engine GC | 73 ms | 33 ms | 27 ms (bump, **no GC**) |
| Same, with a 32 MB live tree kept | 73 ms | 33 ms | 97 ms (my naive mark-sweep, 7.5 ms per GC) |
| 64-bit xorshift | ~147 ms (BigInt, scaled from 1/10 run) | 41 ms | n/a |
| Virtual call, 2 receiver classes | 33 ms | 24 ms (`call_ref`) | not run |
| Pointer chase over a 1000-node list | 124 ms | 123 ms, with or without `ref.cast` per access | not run |
| Allocation churn, no live heap | 67 to 209 ms | 52 to 173 ms | not run |

- Wasm GC is 2.2x faster than JS on allocation-heavy graph code and 3.6x on `long` math. It is **not** faster on
  pointer chasing; a gain claim for Compose-like code is unproven until section 6 gate G1.
- `ref.cast` on every field access is invisible in the pointer-chase kernel.
- A simple non-generational mark-sweep in linear memory is about as fast as JS and 2 to 3x slower than V8's
  generational GC. Matching V8 needs a generational collector with write barriers. That is real engineering, not
  a given.
- Object size: 24 B (Wasm GC struct, 4 fields) vs 28 B (JS object).

### 1.2 Startup and tiering (measured)

- V8 compiles Wasm lazily. A 6.9 MB module with 20,000 functions: `new WebAssembly.Module` 3.7 ms,
  instantiate 0.4 ms, first execution of all 20,000 functions 79 ms (about 4 us per ~350 B function, Liftoff).
  Current launches spend 0.4 to 0.9 s compiling JS and run 120k to 215k cold calls, so Wasm's baseline compile is a
  plausible order-of-magnitude improvement on cold code **if** the platform and app code arrives as ready-made
  binaries (inferred; gate G3).
- Liftoff code ran 2.4x slower than TurboFan (509 ms vs 209 ms for the same loop, first vs second call).
  **There is no OSR**: a long-running loop inside one call stays in baseline code until the function is called
  again. My attempt to force optimized tier-up with a `compilationHints` custom section had no effect in Chrome 153
  (the same bytes work as specified on Node 24 with the flag, so shipping Chrome ignores them; see "G4 hint result").
- 1,000 tiny modules (each a struct subtype + one function written into a shared imported table): compile +
  instantiate 21 ms total. Calls across modules through the shared table work (13 ns including a JS to Wasm entry).
- Structurally identical struct types **canonicalize to one type across modules**. Two Java classes with the same
  layout and supertype are the same Wasm type, so class identity must live in the object header, not in the Wasm type.
  Subtype casts across modules work.

### 1.3 Suspension (measured)

- JSPI: one `WebAssembly.Suspending` call that actually suspends and resumes costs 40 to 55 ns (a JS `await` is 62 ns).
  Suspension cost does not depend on stack depth. 2,000 concurrently suspended stacks of depth 200 all resumed in 3.3 ms.
- The current design saves 1,000 to 1,300 frames per Mihon tap and has resumable-body compilation; with JSPI all of that
  (SUSPENDED throw, `dfr`, resumable twin, continuation lists) disappears.
- Constraint confirmed: a JS frame between the `promising` entry and the `Suspending` call throws
  `SuspendError: trying to suspend JS frames`. Any native that can call back into Java and that Java can block under
  must itself be Wasm, or be an async function wrapped in `Suspending` (it then runs on the JS side of the boundary,
  which is the existing "driven generator" shape but without per-Java-frame cost).
- Recursion depth with trivial frames: 10,000 fine, 50,000 overflows, same on the main stack. JSPI does not make
  deep Java stacks worse than the current JS runtime; `StackOverflowError` must be synthesized from `RangeError`.
- Stack traces: `new Error().stack` costs 3 to 10 us at depth 5 to 150 for wasm frames (similar to today). Wasm
  throw/catch costs about the same as JS (154 ns vs 221 ns, depth 5).

### 1.4 Interop (measured)

- `WeakRef`, `WeakMap`, `FinalizationRegistry` work with Wasm GC struct references and finalizers fire. GC objects are
  opaque to JS (frozen, null prototype, no expandos). So `===`, Map keys and handle tables keep working; field access
  from TS needs generated accessors.
- `wasm:js-string` builtins work (`length`, `charCodeAt`, `equals`, `fromCharCodeArray`, `intoCharCodeArray`).
  A 54-char hash loop through the builtins is 95 ns vs 44 ns in JS, so keep String.hashCode cached or intrinsified.
- GC byte arrays copy to and from linear memory at about 0.27 ns/byte (4 GB/s) with a 1 to 2 ns call crossing.
  JS cannot view a GC array as a typed array. 190 natives take primitive arrays (reported).

### 1.5 Corpus facts (reported, `dexstats/REPORT.md`)

- Register typing is solved: 704,430 / 704,430 methods infer with no merge conflict; 99.5 to 99.9% are fully
  determined; the rest are `const` feeding a 32-bit `aget`/`aput` (resolved by array element type). 14.8 to 29.8% of
  vregs hold two kinds at different points, so the typing must be per live range, not per vreg. Splitting locals by
  kind costs +4% to +29% locals (mean 3.9 to 6.0 per method, p99 18 to 41, max 420).
- Methods are tiny: median 18 to 36 bytes, 29 to 48% have at most 4 instructions, p99 0.4 to 1.1 KiB, none over 64 KiB.
- 0 to 0.5% of methods fall back to the dispatch loop in the existing `Flow` structurer (Kotlin `invokeSuspend`,
  AIDL `onTransact`). Try ranges are flat (no nesting). 4 to 13.5% of methods have a try.
- Invoke mix: virtual 42 to 58%, interface 6 to 12%, static 16 to 27%, direct 15 to 26%. Class-hierarchy analysis
  finds one target for 82 to 90% of virtual sites (closed world assumption). 47 to 85% of interface sites have three
  or more implementations.
- Only 0.6 to 2.1% of code bytes are numeric-only leaf code. The numeric-kernel argument against Wasm was correct
  as far as it went; the case for Wasm here rests on object layout, `long`, startup, suspension and threading, not on kernels.

### 1.6 Host surface (reported, `native-survey.md`)

- 2,682 registered native entries (floor). 41% take only primitives, longs or handles and touch no object; 29% touch
  fields, call Java, retain objects or rely on identity.
- TS-declared field sites: 1,018 on 79 TS classes, 858 of them in 10 files. Bytecode-class field access through
  `getDeclared`/`setDeclared`/`declaredField`/`fieldOf`: 276 sites; untyped property access about 233; string-keyed
  element access up to 717 (upper bound).
- Java-call helpers: 1,301 sites (`vcall` 812, `newObj` 303, `scall` 138) funnelling through about 8 functions in
  `jentry.ts`; 18 hosted-service files hold 678 of them.
- 403 `driven(` generator natives, 854 `yield*`. This is the largest constraint (suspension), larger than layout.
- 128 files (17.9k lines) have zero coupling to Java object layout (HarfBuzz/sfnt/Skia glue, ciphers, DER, fs, zlib,
  sqlite, the ARM/A64 host layer).

### 1.7 Runtime inventory (reported, `runtime-inventory.md`)

Most JS dependence is an artefact of the design, not a requirement. Genuine new work for a Wasm VM: full register
typing (solved above), explicit null/bounds/zero checks (Wasm traps are not catchable by Wasm EH), class descriptors
and dispatch tables, a class-init protocol, JNI/reflection through descriptors, stack-trace symbolization, module
granularity for lazy linking. Things the JS runtime does wrongly today and a rewrite need not copy: no
`ArrayStoreException`, finalizers never run, `SoftReference` is strong, only one `invoke-custom` bootstrap, strings
compare by value.

## 2. Blockers examined: artefact of today's design, or genuine?

| Claimed blocker | Verdict | Why |
|---|---|---|
| "No suspension in Wasm" | **Artefact.** JSPI is available in Chrome (137+) and measured at ~50 ns per switch. | Needs the JS-frame rule above. Firefox/Safari status is reported but unverified. A CPS/unwind mode transcribed from today's design is the fallback. |
| "Java objects are JS objects, natives read fields directly" | **Artefact.** 41% of natives need no change; field access concentrates in 79 classes and 10 files; the rest funnels through ~8 helpers. | Needs a generated accessor layer and a lint. |
| "Dynamic class loading" | **Artefact.** | Module per class group, shared funcref table, cross-module struct subtyping works (measured). Shape-only Wasm types plus header identity. |
| "Crossings would dominate" | **Artefact.** | The crossing is 1 to 2 ns for scalars. The cost is JS-resident natives that pass strings and arrays; those move to builtins/copies or into Wasm. Gate G5. |
| "Needs a GC of our own" | **Choice.** | Wasm GC removes it. A linear-memory heap is the alternative and costs a GC (section 3). |
| "No OSR in Wasm" | **Genuine, mitigable.** | Back-edge counters already exist for preemption; use them as a voluntary re-entry into the tiered-up function (state transfer through the same frame record JSPI does not need, so this needs its own small mechanism) or outline hot loops. Gate G4. |
| "Wasm traps are uncatchable (NPE, AIOOBE, div)" | **Genuine, cheap.** | Emit explicit checks; V8 removes dominated duplicates (to verify in G1). |
| "Boot image impossible with Wasm GC" | **Partly genuine.** | No engine heap snapshot. A data-driven loader over a build-time image works (inferred). Linear memory would make it a memcpy. Gate G6. |
| "No shared-memory threads with Wasm GC" | **Genuine for Wasm GC** (shared-everything threads are Phase 1). | The project does not need it for Java: processes are already separate realms and Binder carries Parcels. Process-per-Worker (performance-plan item 1.2) is independent of this choice. Linear memory is the only route to threads within one process. |
| "JS strings vs Java strings" | **Design choice with a measured trade-off.** | See 3.4. |
| Safari/Firefox support | **Unverified.** | Platform agent could not confirm; see section 5 and gate G7. |

## 3. Target architecture (recommendation)

Decision: **Wasm GC for the Java heap, JSPI for blocking, ahead-of-time Wasm modules for platform code, a Wasm
interpreter as the cold tier and the deopt target.** Keep the linear-memory VM (section 3.7) as a documented
alternative with explicit triggers for switching.

### 3.1 Object model

- Header: `vt: (ref $VT)` (immutable), `hash: i32` (identity hash, lazily assigned; monitor word added when needed).
  `$VT` is an `i32` array holding class id, depth, a fixed display of ancestor ids, interface-method-table
  (selector, function index) pairs, a slow-path region, an implemented-interface list, and the virtual slots, all as
  function-table indices. This is what `src/wasm/compiler` implements.
- One Wasm struct type per distinct field layout, declared as a subtype of its superclass layout; classes with equal
  layouts share the type. Reference fields are typed `(ref null $Obj)`. Primitive kinds: `i32` (int, short, byte,
  char, boolean, float bits), `i64` (long, double bits).
- Arrays: wrapper struct (header + immutable data array) per element storage kind, so array classes, covariance
  checks, identity hash and `synchronized` work. Evaluate bare arrays for primitives in G5 if the extra load shows.
- Dispatch: CHA devirtualization to direct calls (82 to 90% of virtual sites per the corpus, closed world), vtable
  `call_indirect` otherwise, IMT-style hashing for interface calls. Open-world loading needs a guard or a
  re-link (see 3.3).
- Class identity and subtype tests use the header display, not Wasm `ref.test`. Revisit when custom descriptors
  ship (origin trial in Chrome 149 per the platform report, unverified).

### 3.2 Compiler

- Reuse the existing front end: `prepared.ts` decode and CFG, and `structure.ts` (`Flow`: dominators, loops,
  regions, labelled scopes). Its output maps one-to-one onto Wasm `block`/`loop`/`br`; handlers are separate regions
  entered through a `br_table` dispatcher. The prototype already does this.
- Replace constant typing with a live-range ("web") type inference (kinds I, F, R, J, D), as in
  `dexstats/infer.ts`. Allocate Wasm locals per (vreg, kind) or per web. Decide float handling in G1: floats as
  `f32`/`f64` locals (best code) vs bits in `i32`/`i64` (what the prototype does, simplest, costs reinterprets).
- Exceptions: one Java-throwable tag, `try_table` with a pc-range catch dispatcher for methods with tries, explicit
  null/bounds/divide/cast checks, `trunc_sat` for float to int, guard for `INT_MIN / -1`.
- Fuel/preemption check on back edges (suspend via a `Suspending` import when budget runs out). Reuse it as the
  tier-up trigger (G4).
- Emit binary directly with a small encoder (`src/wasm/compiler/wasmbin.ts`, `code.ts`); no binaryen at runtime.

### 3.3 Linking, tiering and code delivery

- Granularity: module per class group (or per jar chunk for the platform). Instances share one imported funcref table
  and imported globals. Vtables are data (`array.new_data` from a passive segment) holding table indices; slots start
  at per-signature lazy-link stubs.
- Platform code (all boot jars + `framework.jar`): compiled at build time to static `.wasm` assets split by package
  and served with long-lived caching so V8's streaming compile and code cache apply. Hot-method priority hints go in
  if G3 shows they work.
- App code: compiled at install time in workers (the `compileworker.ts` shape), cached in OPFS/Cache Storage.
  Dynamically loaded dex compiles into extra modules.
- Cold tier: a Wasm DEX interpreter (one module, precompiled, shared by all processes). It is also the deopt target
  for any frame that needs to be rebuilt (class redefinition, failed devirtualization guard, GC unwinding if the
  linear-memory design is ever chosen). With JSPI no frame saving is needed for suspension itself.
- Open-world soundness for devirtualization: record the CHA assumptions per module; loading a class that breaks one
  invalidates the module's affected functions (re-link to vtable stubs) before the class becomes visible.

### 3.4 Strings

`java.lang.String` is a struct over an `i16` array (G5, decided in 4.10): the Object header, the chars, the cached hash code and, once a
native has asked for it, the JS string. A String is then an Object like any other (a virtual call needs no test for it, `hashCode` is a
field), and character access is an array access instead of a call of a `wasm:js-string` builtin, which Chrome does not inline. A native sees
the JS string (made and cached on first use); a JS string a native answers is copied into an array once. Constants are Strings put in the
shared table by the host and interned with `String.intern`; identity is Java's (ART interns member names, which `Method.equals` compares by
identity, so the host makes those through `intern`). The JS-string representation measured worse on every string workload and was removed.

### 3.5 Natives and host boundary

- Define the boundary once as a typed ABI, generated from descriptors: scalars and handles pass as `i32`/`f64`/
  `i64`-as-pair or `f64` handle; strings as externref; byte arrays as (copy in, copy out) or as linear-memory
  regions owned by the native; object references as opaque externref. No host function sees a Java field.
- Field access from TS goes through generated accessors (exports per class and field), reached only through the
  existing `getDeclared`-style helpers, plus a lint that forbids property access on Java objects.
- Natives that call back into Java: either Wasm, or `async` TS wrapped in `Suspending`. Replace the 403 `driven`
  generators accordingly.
- Natives that mostly move bytes (bitmap conversion, parcel, zlib, regex, crypto, fs) are rewritten against copy-in
  and copy-out or move into Wasm (Zig) where the data already lives in linear memory.
- JNI: ARM/A64 core stays a separate instance on shared linear memory, JNI refs become handles into a table; the
  Java side exposes handle-in/handle-out entry points. Unifying VM and core in one instance via multi-memory is a
  later option, not a requirement.

### 3.6 Other parts to re-architect with this

1. **Process-per-Worker** (independent of the Wasm choice, enabled by Parcel-serialized Binder): moves non-presented
   process realms off the page thread. Needs enumerating the direct broker/font/file/guest-clock calls (history
   ~3275) and giving each a message or `SharedArrayBuffer` form. SAB needs cross-origin isolation, which the project
   does not use today; the cross-site WebView renderer on Pages would need CORP/COEP headers.
2. **Boot image** (section 6, G6): build-time run of framework initialization, serialized heap image + data-driven
   loader.
3. **Differential testing as the main correctness tool**: the JS tier stays as an oracle during migration; compare
   per-method results and per-step `run.json`.
4. **Tools**: `dis`, `jsrc`, `dbg`, `trace`, `stacklines.ts` need Wasm equivalents (name section, DEX pc side table).
5. **Optional later**: display-list command buffer in shared memory for an OffscreenCanvas render worker.

### 3.7 Alternative: linear-memory VM with its own GC

Pros: threads inside one process (SAB + Atomics, a real answer to "background threads share the page's one
thread"), heap snapshot as a memcpy, zero-copy arrays shared with natives and the ARM core, deterministic memory.
Cons measured or reported: no engine GC so we write one (the naive version is 2 to 3x slower than V8's, see 1.1);
roots need a shadow stack or an "unwind to safepoint" protocol; 4 GB cap on desktop and well under 1 GB on mobile;
cross-origin isolation required for threads; strings must be copied at every host boundary.
**Switch to it only if** G1 shows Wasm GC allocation/GC behaves worse than JS on the app workloads, **or** profiling
(plan step S1) shows background-thread contention is still the dominant hitch source after process-per-Worker.

## 4. Current state of the prototype

### 4.1 What exists (`src/wasm/`, then `research/wasm/j2w/`)

`wasmbin.ts` (binary module builder with GC rec/sub types, imports, tags, tables, passive data), `code.ts`
(instruction emitter), `program.ts` (class model, open-world `add`), `cha.ts` (class-hierarchy analysis over all loaded classes),
`reach.ts` (RTA reachability, now only a measuring tool), `consts.ts`, `lazy.ts` (the linker: class modules, lazy-link stubs, slots,
CHA invalidation, entry points), `j2w.ts` (per-module compile context: types, imports, local helpers, allocation), `method.ts`
(per-method compile using `Flow`, all opcode families except strings/MethodHandles/monitors), `infer.ts` (live-range web typing),
`exc.ts` (implicit exceptions, stack frames, heap limit), `cfg.ts`, `opinfo.ts`, `intrinsics.ts`, `build.ts`, `dis.ts`,
`java/W.java`, and the harnesses `oracle.ts` (the production JS tier as oracle), `cases.ts`, `diff.ts`, `libdiff.ts`, `jbench.ts`,
`lazytest.ts` + `trace.ts` (linker, exceptions, V8-only checks), `lazybench.ts` and `floatbench.ts` (measurements).

### 4.2 What it showed

On `W.java` compiled with javac + d8, the generated module for `fib`, `sieve`, `xorshift`, `swsum` and `floats`
produced the same results as the JDK. Module size 2.9 KB, compile 7.6 ms in Bun.

### 4.3 What is wrong or untested

Status after the S0 differential work (the suites run as `bun run wasm <suite>`; the first two need javac, d8 and java on PATH):

| Harness | Subject | Oracles | Result |
|---|---|---|---|
| `diff.ts` | 30 static methods of `W.java`, 775 cases | JDK and the production JS tier | 775/775 agree. The earlier `mandel`/`collatz` mismatches are gone. 2 JS-tier results are explained: Bun's JSC words a negative typed-array length differently from V8, so `rt` maps `new int[-1]` to `InternalError` instead of `NegativeArraySizeException` (production runs V8; `runtime.ts` matches only V8's wording) |
| `libdiff.ts` | primitive-only statics of `java.lang.{Integer,Long,Short,Byte,Character,Boolean,Float,Double,Math,StrictMath}`, `Objects`, `Arrays`, FP16, compiled from the unchanged core-oj/core-libart dex | JS tier running the same bytecode | 322 candidates, 87 compile without a gap in their closure; 3,480 cases, 0 diffs. The rest are blocked by const-string (139), natives (74) or a closure over 1,000 methods (22) |
| `jbench.ts` | the 42 `scripts/jbench/Bench.java` workloads, each cut out as `static int w_<name>()` (generated, not copied) over all boot jars | JS tier | before lazy linking: one valid 6.9 MB module of 17,859 methods built in 23 s, every unsupported construct recorded as a gap. Now each workload runs on a fresh lazy `World` (cold): none runs to a result, every one stops at its first gap, after 22 to 50 methods compiled; 1,397 methods and 0.5 s over all 42 (`--survey` compiles the whole reach: 15,170 methods in 1.6 s) |

Bugs found and fixed by this work: ART's `java.lang.Object` declares `shadow$_klass_`/`shadow$_monitor_` fields, which
broke struct layout and invalidated every module built with real core-oj (they are now the object header);
`wasmbin` overflowed the stack on large modules; and unsupported constructs compiled to a silent trap
(`const-string`, `const-class`, `invoke-polymorphic`, array methods, calls with no instantiated implementor, natives).
Each now goes through `Compiler.gap`, which records it and calls `host.gap(id)`, so the harness reports the first gap
a run hits. Nothing is faked: a gap throws `UnsatisfiedLinkError`.

**S1 work list, from the 17,859 methods the jbench workloads reach** (counts are blocked methods; a method can appear
under several rows; `bun jbench.ts -v` lists them all):

| Missing feature | Blocked methods | First gap of | Needed for |
|---|---|---|---|
| Strings: `const-string` and string static initial values | 2,811 (+12 jumbo) | `Integer.<clinit>` (`Class.getPrimitiveClass("int")`) hits `listAddGet`, `listIter`, `listRemove`, `mapInt`, `deque`, `sort`, `linkedList`, `scanTokens`, `format`, `casts`, `ssb*`; `Bench.<clinit>` (KEYS) hits `mapStr`, `mapWalk`, `linkedMap`, `hashSet`, `treeMap`, `mix`, `parseFail*`, `zipOpen`, `spannedCopy`; `Float`/`Double.<clinit>` hit `b64java`, `jsonParse`, `jsonWrite`, `dtoa`; the workload body itself for `sha256`, `ecdsaVerify`, `certParse`, `smallAlloc`, `scanLines`, `strConcat`, `inetCached`, `linkify`; `StringBuffer.<clinit>` for `monitors` | every workload |
| Class objects: `const-class`, `Object.getClass` (reads the removed `shadow$_klass_`), `Class` methods | 340 const-class; 789 calls with no instantiated implementor, of which 374 on `Class` (`getName` 100, `getComponentType`, `getClassLoader`, `isAssignableFrom`, `newInstance`), then `reflect.Field/Constructor/Method` | `Unsafe.<clinit>` for `fbLoop`, `fbBulk`, `bbInts`, `dbInts`; `Base64$Encoder.<clinit>` for `b64android` | NIO buffers, `Arrays.copyOf(.., Class)`, `Enum.values()` via clone |
| Array methods: `clone()` (101 sites: enum `values()`, `ArrayList`, ICU) | 101 | | `listAddGet` family (`Arrays.copyOf`), enums |
| Natives with no intrinsic | 263: `libcore.io.Linux` 46, `jdk.internal.misc.Unsafe` 23 (+ `sun.misc.Unsafe` 11), `libcore.io.Memory` 14, `VMRuntime` 12, `Character` 12, ICU `MatcherNative` 11, `String` 11, `Math` 10, `Thread` 8, `FileDispatcherImpl` 8 | `AtomicLong.VMSupportsCS8()` for `random` | `random`, NIO, zip, files, crypto |
| `invoke-polymorphic` (VarHandle/MethodHandle) | 51 (+3 range): `ForkJoinPool` and `WorkQueue`, `AtomicInteger`, `AtomicLong`, `CountedCompleter` | | `AtomicInteger`/`AtomicLong` (`random`, `ConcurrentHashMap` users), executors |
| `invoke-super` to interface default methods (`unresolved direct`) | 31, all `java.time.chrono`/`temporal` | | `java.time` (format, zip entries) |
| Monitors | not a gap: `monitor-enter/exit` are null checks, valid only while a process has one Java thread | | `monitors`; revisit with S1 threads |
| Whole-program reach | a size problem, solved by lazy linking (4.5): `Locale.getDefault()`, `Object.toString()` or `Objects.checkIndex` alone reach 7,854 methods and 716 classes from core-oj+core-libart | | |

`casts` is the smallest case: 26 methods, blocked only by `Integer.<clinit>` (string plus the `getPrimitiveClass`
native and `const-class`), so it is the first jbench workload to turn green once strings and class objects exist.
Still untested: `framework.jar` and app code through `diff`, `fwtest` and the conformance suites (`invoke-custom` and control flow no javac emits are covered in 4.8). There is no speed comparison against the JS tier on
real DEX (cold-start numbers can now be taken, see 4.5, but every jbench workload still stops at its first string or class-object gap).

### 4.4b Differential coverage (S1-E, 2026-10-04, `knlnks/wasm-e`)

All three run from the repository root and re-execute themselves bundled under node (`undernode.ts`; V8 frames are needed for caller-sensitive natives):

- `bun run wasm jbench`: one fresh `World` per workload, table of Wasm result, JS-tier result and MATCH/DIFF/BLOCKED(first gap). On the merged tree: 41 MATCH, 0 DIFF, 1 BLOCKED (`inetCached`, `Linux.android_getaddrinfo` answers a Promise). The earlier "hang" of 11 workloads was the harness: the JS tier's yield port is unref'd, so node exited with the workload suspended.
- `bun run wasm fuzz [--seed N --methods N --depth N --debug --file F.java]`: random Java (int/long/float/double/narrow casts, arrays, 2-D arrays, fields, virtual/interface calls, instanceof/casts, labelled loops, switches, try/catch/finally, custom exceptions, synchronized, calls) compiled with javac and d8, run on Wasm, the JS tier and the JDK. 70 seeds x 3,600 cases: Wasm and the JDK never differ. It found two bugs, below.
- `bun run wasm sweep [jar|apk ...]`: compiles every method alone and groups failures by cause. framework.jar: 219,874 methods, 18 fail (15 `invoke-custom`, 3 `MethodHandle.invoke`). FitNotes 7 (calls into optional or newer platform APIs). Mihon 190 (171 irreducible flow, Kotlin coroutine state machines; 19 absent platform APIs). Zero unexplained.

Bugs found: (1) the class module exported static fields by name only, so a dex that declares one name with two types (R8 output) produced a duplicate export or an ill-typed global; they are now keyed by name and type. (2) Production JS tier, `src/jvm/prepared.ts`: a handler's reaching definitions came from the state at the end of every block in the try range, so an int constant assigned after the last throwing instruction (d8 shares the register with a float the handler reads) was typed float (`const 32` became 4.5e-44). Handler edges now carry the state before each instruction that can throw (`tests/float-handler.test.ts`; 20 of the fuzzer's failing methods, one cause). Also: `Flow` limits scope nesting to 256 for the JS parser; Wasm bodies are no longer limited (8 AIDL `onTransact`/`getDefaultTransactionName` methods compile). Both open items (irreducible flow, unresolved references) are closed in 4.8.

### 4.5 S1 compiler architecture (2026-10-04, `knlnks/wasm-c`)

Measured in Bun (JavaScriptCore) and Node 24 (V8 13.6), M4 Pro, single runs, other agents running: indicative.

**Lazy linking** (`lazy.ts`). A `World` holds one funcref table. A class module is built the first time any code names the class: it defines
the vtable, init flag and static fields as exported globals and one lazy-link stub per method in a contiguous block of table slots.
A stub calls `host.link(slot)`, which compiles that method plus the small methods it calls (up to 8, 100 code units each: V8 inlines inside a
module, not through the table) into a unit module, instantiates it against the class modules it names, and replaces the slot. Every call across
modules is `call_indirect slot`; vtables and IMTs hold slots; unseen interface selectors are learned through `host.imtMiss`. Stubs are per
method (a per-signature stub cannot know which method it stands for without a store before every call). Each module is `Compiler.buildUnit(group)`
bytes; `World.classModule` returns the class module bytes, so a build-time mode can store both instead of instantiating on demand.

| Cold start, same entries | Closed-world build (before) | Lazy (after) |
|---|---|---|
| 322 primitive statics of the number classes, `lazybench.ts` | 8,127 methods, 2.8 MB, 4,139 ms | 494 methods (6.1%) in 357 modules plus 125 class modules, 0.5 MB, 61 ms compiler + 19 ms Module/Instance + 30 ms class links (V8) |
| jbench closed-world compile | 17,859 methods, 23-25 s | 15,170 methods, 1.6 s (`--survey`) |

The compiler itself is about 13x faster per method (0.5 to 1.4 ms to 0.07 to 0.12 ms) because the read-set fixpoint (two passes) is gone and the
analysis is one pass. `new WebAssembly.Module` + `Instance` of a unit cost about 35 us each in V8 (80 us in JavaScriptCore). Compiling every
method of core-oj + core-libart (37,340) takes 2.5 s, the 219,874 of framework.jar 15 s, with no inference failure; the only compile failures are
the 8 (framework) to 196 (Komikku) irreducible-CFG methods `Flow` already rejected.

**CHA under open-world loading.** `Cha` considers every concrete subtype the Program knows (not only instantiated ones, which is unsound once
classes load later). A virtual call with one target becomes `call_indirect` of that target's slot, and the unit records the decision per slot.
`World.addDexes` re-checks the recorded decisions against the new classes, puts the lazy-link stubs back for every method that relied on a
falsified one (and its compile group), and the next call recompiles against the new hierarchy (`lazytest.ts`: a subclass in a second dex flips
`Lz.call` from 11 to 12). Frames already executing keep their old code: closing that window needs the deopt target of S4.

**Exceptions** (`exc.ts`). The implicit exceptions are throwers in reserved table slots, compiled on first use: they allocate the ART class,
run its constructor and throw the one tag. Messages follow the JS tier and ART (`divide by zero`, `length=4; index=7`, `Ex$P cannot be cast to
Ex$Q`, `-5`, `Failed to allocate a N byte allocation with 536870912 free bytes`); the host computes them (`World.lastMessage`) but they are not
yet stored in `Throwable.detailMessage`: that needs the String representation. Stack traces: `Throwable.nativeFillInStackTrace` returns an
Object that keys a captured V8 `Error`; `World.stackTrace` maps each wasm frame back to a Java method by the name section and to a DEX pc by a
per-function table of call offsets (`Code.marks`, `Module.bodyOffsets`), then to a line by `DexFile.lineAt`. V8 reports the offset of the call
instruction, so the greatest mark at or before it is the frame's pc (verified under node: `Ex.c`, `Ex.b`, `Ex.a` at the pcs of their calls with
the source lines of the three methods). `nativeGetStackTrace` (building `StackTraceElement[]`) waits for strings. Allocation counts against an 8 MB window
(`rt.alloc` counts up to zero); the end of a window asks the host whether the real heap passed the 512 MB limit, and an array over the limit is an
OutOfMemoryError before it is allocated. **V8 does not let Wasm catch its stack-overflow RangeError** (`catch_all` catches a host-thrown
TypeError but not the overflow, Node 24): a Java handler for StackOverflowError cannot see it, so it becomes a `StackOverflowError` at the
edge of the Java world (`World.entry`). The JS tier converts at every catch site; closing this needs an explicit depth counter or another engine
mechanism, and apps that catch SOE mid-stack are rare.

**Typing and floats** (`infer.ts`). The kind analysis of `method.ts` is replaced by the web analysis of `dexstats/infer.ts`, now shared: every
used web gets its own local of its kind, a dead definition drops its value, an unreachable instruction compiles to `unreachable`. Results on
verified bytecode: 0 conflicts in 500,000+ methods compiled; `dexstats` output is unchanged apart from timings. **G1 sub-question, floats:**
f32/f64 locals are 30% faster than i32/i64 bits with a reinterpret around every operation under TurboFan (41 vs 58 ms for 30 M iterations of
a multiply-add chain) and equal under Liftoff (`floatbench.ts`); Wasm of mandel is 17% faster end to end. Decision: floats live in float
locals (`FLOAT_LOCALS` in `method.ts`, one flag), fields, arrays, parameters and results keep the bits ABI.

**V8 findings.** (1) A module without a start function gets a quarter of the inlining budget (`--trace-wasm-inlining`: `budget=min(128,700)`
against `min(320,7000)`), which halves `fib(32)` (9.7 vs 5.4 ms); unit modules carry an empty start function. (2) Cross-module calls cannot
inline, so small callees are grouped (without grouping `swsum` is 3x slower than the closed-world build; with it equal at 0.07 ms).

### 4.6 Natives and the host boundary (2026-10-04, `knlnks/wasm-d`)

**ABI.** A native keeps the production value model: Strings as JS strings, primitive arrays as typed arrays over scratch memory, long as bigint.
Every other reference (receiver, object, object array, a result that is an object) crosses as an opaque `externref` and meets the production
function through `bridge.ts`. The bridge never reads a Java object itself: array length and elements, and one getter and setter per field, are
generated Wasm (`World.hostFn`), and a field-reading `Proxy` per object lets a production native such as `Linux.close(fd)` run unchanged. A
Java method a native calls on an object (`vcall`) resolves to the implementation the object's class has and runs as Wasm. For the length of
the call an `Object` that is a primitive array is a copy that is written back; a host array becomes a Java array; an object the production
runtime made (`StructStat`, a `FileDescriptor`) is copied field by field; a throwable a native raises keeps its subclass fields (`ErrnoException`).
A `static ()V` native that fills in statics (`OsConstants.initConstants`) has them stored into the Wasm class. A native that answers a Promise is
a recorded gap, as is anything JavaScriptCore's stack cannot answer (the caller class: Bun runs `W` only, `libdiff` blocks and counts the rest).

**Natives landed** (Wasm unless noted): `Thread.currentThread` over a real main `Thread` (made as ART's `CreatePeer` does, `rt.thr` is the one
global a scheduler changes), `nativeGetStatus`, interrupt flag; `Reference` and `FinalizerReference` natives (a referent is held until cleared);
`Class.forName`, `getDeclaredClasses`, `VMClassLoader.findLoadedClass` and the boot class path entries; `Field.get/set*` with widening,
receiver, access (the caller from the V8 frame) and final checks; `libcore.io.Memory` peek/poke over the `byte[]` a direct buffer lives in
(`VMRuntime.addressOf` pins it, 50th bit of the address); every `Character` native (ASCII inline, the rest through ICU4J's `UCharacter` running as
Wasm over the ICU data the production natives map); `String.<init>(int,int,char[])`; production natives now reachable with object receivers
(`Linux`, `VMRuntime`, `Unix` file system, `FileChannelImpl`, zip, conscrypt). A mapped file's pages and the 64 KB digest path are asynchronous in
production; the harness makes the ICU data resident first and runs the digest's JS form.

**Results.** `diff.ts` 861/861 under node (the new `N.java` covers fields, `Class.forName`, direct buffers, the main thread, Unicode properties
and references against the JDK and the JS tier); `libdiff.ts` 409 methods, 16,360 cases, 0 diffs under node; `classdiff.ts` and `lazytest.ts`
pass under both. Under Bun `diff.ts` runs the 741 cases of `W`, `libdiff.ts` blocks 1,970 whose `System.<clinit>` needs the caller class.
`jbench.ts` under node: **40 of 42 workloads match the JS tier**; `inetCached` stops at `android_getaddrinfo` (the production native builds
`InetAddress` objects asynchronously). Fixed on the way: `findMethod` branched out of its own loop on the first parameter mismatch (an infinite
loop for a class with two constructors), and `node` exited while an unref'd yield port held a pending await (`nodeshim.mjs` is now the entry:
`node nodeshim.mjs bundle.mjs`).

**Production findings.** The JS tier's `Field` lacks the receiver, type and final checks (`getBoolean` of an int field answers a number) and
does not convert on widening reads and writes (`getLong` of an int field answers a number, `setByte` on a long field stores a number): `diff.ts`
compares those cases with the JDK alone. Natives that need a lock-step thread (`wait`, `sleep`, `park`, `holdsLock`, `nativeCreate`) stay gaps
for the scheduler; `Class.getSimpleNameNative`, the annotation natives, `getDeclaredConstructorsInternal` and `android_getaddrinfo` are done in 4.8.

### 4.7 S1-F: generated-code performance and the G1 timing (2026-10-04, `knlnks/wasm-f`)

**Harness.** `bun run wasm g1 [workload ...] [--runs 5] [--reps 100] [--engines node,chrome] [--json out.json] [--ref earlier.json] [--v8-flags "..."]`
(`g1run.ts`, `g1platform.ts`, `g1fs.ts`). A workload is a `case` line of `scripts/jbench/Bench.java` or `tests/fixtures/wasm/java/G1.java`
(strings, arithmetic loops, field/array/virtual/interface/switch kernels, the G4 loop pair, same format); it joins the table as soon as its
Wasm result equals the JS tier's, so unblocking a workload is a change to the compiler or natives and nothing here. Every measurement is a fresh
engine: a node process or a new headless Chrome context (cross-origin isolated, so `performance.now()` has 5 us resolution instead of 100 us);
runs interleave JS and Wasm; `first` is the first call (linking, compiling, class initialisation; the JS tier's first call has no compile step of
its own), `steady` the median of the last half of 100 calls, `warm` calls 2 to 11. `--ref` takes the JS numbers from an earlier `--json` so a
compiler A/B measures Wasm only. `watdump.ts <workload> <method>` prints generated code. **The host was shared (load average 4 to 8 on 14
cores) for everything below; every table says so, spreads are 2 to 10%, and the authoritative run must be redone on an idle machine.**

**G1 tables** (merged with `knlnks/bytecode-wasm` at `4d783acc`; every workload whose Wasm result equals the JS tier's; two workloads stop early on a pre-existing OutOfMemoryError after about 14 calls: `scanTokens`, `scanLines`, their numbers are over the calls that completed; `inetCached` is still blocked by an Unsafe accessor). Wasm more than 10% slower in steady state (js/wasm), node: zipOpen 0.01, sha256 0.10, fbBulk 0.17, parseInts 0.18, strConcat 0.19, strBuild 0.29, strIndex 0.76, b64android 0.78, strSubstr 0.78, bbInts 0.79, switchSparse 0.85, strCompare 0.87, scanTokens 0.88, strChars 0.89, scanLines 0.89; Chrome adds jsonWrite 0.45, format 0.77, fbLoop 0.87 and has strIndex 0.25, strSubstr 0.44, strChars 0.56, strCompare 0.63 (builtins, see V8 findings). The first four and `fbBulk` are dominated by the natives bridge: `$copy:i8` copies the whole array element by element on every native call (66% of `zipOpen`, whose `initCEN` takes 49 ms over a 1000-entry directory where the JS tier uses a native ZipFile) and by the host String factories (`decodeString`); that is a change to the bridge (range copies), not to generated code. first-call times are not comparable with the JS tier's (it has no compile step, and node's JS tier caches).

**node v24.19.0 (V8 13.6.233.17-node.51)**, 3 runs x 100 reps, medians (min-max) in ms, load average 1.3-2.5 on 14 cores. Wasm warm = calls 2 to 11.

| workload | JS first | Wasm first | JS steady | Wasm steady | steady js/wasm | Wasm warm |
|---|---|---|---|---|---|---|
| sha256 | 70.6 | 563 | 0.411 | 3.9 (3.9-3.9) | 0.10x | 4.0 |
| ecdsaVerify | 68.2 | 580 | 0.344 | 0.332 (0.331-0.334) | 1.04x | 0.432 |
| certParse | 133 | 969 | 0.141 | 0.135 (0.134-0.139) | 1.04x | 0.235 |
| listAddGet | 21.7 | 13.4 | 0.081 | 0.037 (0.035-0.040) | 2.17x | 0.262 |
| listIter | 21.4 | 13.2 | 0.115 | 0.066 (0.066-0.066) | 1.74x | 0.220 |
| listRemove | 24.3 | 14.2 | 1.9 | 0.665 (0.665-0.668) | 2.86x | 0.751 |
| mapStr | 21.8 | 10.8 | 0.214 | 0.141 (0.140-0.142) | 1.52x | 0.329 |
| mapInt | 21.5 | 11.1 | 0.150 | 0.089 (0.088-0.089) | 1.69x | 0.312 |
| mapWalk | 23.5 | 13.8 | 0.295 | 0.136 (0.134-0.139) | 2.17x | 0.300 |
| linkedMap | 23.2 | 11.8 | 0.211 | 0.127 (0.125-0.127) | 1.67x | 0.361 |
| hashSet | 21.8 | 10.5 | 0.200 | 0.125 (0.122-0.125) | 1.60x | 0.249 |
| smallAlloc | 3.0 | 7.5 | 0.105 | 0.032 (0.031-0.033) | 3.32x | 0.251 |
| deque | 22.0 | 15.2 | 0.127 | 0.049 (0.046-0.049) | 2.60x | 0.179 |
| treeMap | 25.6 | 19.3 | 0.399 | 0.314 (0.314-0.314) | 1.27x | 0.545 |
| sort | 31.2 | 36.0 | 0.291 | 0.284 (0.284-0.295) | 1.03x | 0.926 |
| mix | 27.7 | 20.1 | 1.3 | 0.806 (0.787-0.810) | 1.58x | 1.0 |
| linkedList | 22.1 | 12.3 | 0.087 | 0.032 (0.032-0.032) | 2.67x | 0.175 |
| b64java | 29.4 | 27.8 | 0.832 | 0.831 (0.829-0.853) | 1.00x | 0.861 |
| b64android | 24.4 | 18.2 | 0.616 | 0.793 (0.769-0.815) | 0.78x | 0.729 |
| jsonParse | 50.0 | 134 | 3.3 | 2.4 (2.3-2.4) | 1.39x | 3.3 |
| jsonWrite | 62.7 | 173 | 7.5 | 7.6 (7.5-7.6) | 0.99x | 9.8 |
| scanTokens | 199 | 1122 | 9.3 | 10.6 (10.3-10.9) | 0.88x | 11.2 |
| scanLines | 183 | 1102 | 3.7 | 4.2 (4.2-4.5) | 0.89x | 6.9 |
| format | 49.7 | 135 | 2.3 | 1.6 (1.6-1.6) | 1.44x | 5.3 |
| dtoa | 26.8 | 31.9 | 1.3 | 0.403 (0.402-0.405) | 3.16x | 0.974 |
| parseFail | 12.1 | 18.3 | 7.4 | 2.8 (2.8-2.9) | 2.60x | 3.1 |
| parseFailMixed | 21.6 | 24.5 | 6.8 | 2.7 (2.7-2.7) | 2.52x | 3.6 |
| fbLoop | 22.2 | 24.0 | 0.132 | 0.138 (0.137-0.138) | 0.96x | 0.299 |
| fbBulk | 2.6 | 17.5 | 0.037 | 0.220 (0.219-0.220) | 0.17x | 0.224 |
| bbInts | 21.8 | 20.2 | 0.187 | 0.237 (0.234-0.237) | 0.79x | 0.272 |
| dbInts | 22.2 | 19.3 | 0.355 | 0.129 (0.129-0.130) | 2.75x | 0.254 |
| casts | 30.7 | 12.2 | 2.5 | 0.385 (0.381-0.398) | 6.49x | 0.420 |
| monitors | 20.6 | 11.0 | 0.244 | 0.093 (0.093-0.093) | 2.63x | 0.154 |
| random | 22.4 | 12.4 | 0.612 | 0.067 (0.067-0.084) | 9.11x | 0.114 |
| strConcat | 19.6 | 8.6 | 0.027 | 0.142 (0.141-0.144) | 0.19x | 0.436 |
| zipOpen | 147 | 492 | 0.466 | 60.3 (60.3-60.5) | 0.01x | 61.3 |
| ssbAppend | 33.4 | 37.0 | 0.332 | 0.179 (0.177-0.183) | 1.86x | 0.850 |
| ssbEdit | 32.0 | 35.1 | 0.333 | 0.104 (0.102-0.106) | 3.19x | 1.6 |
| ssbGetSpans | 33.3 | 38.4 | 0.871 | 0.638 (0.635-0.646) | 1.36x | 1.2 |
| spannedCopy | 9.0 | 19.0 | 0.242 | 0.168 (0.166-0.170) | 1.44x | 1.1 |
| linkify | 16.4 | 49.6 | 0.031 | 0.023 (0.022-0.023) | 1.36x | 0.033 |
| loopOnce | 39.3 | 23.5 | 38.2 | 7.1 (7.1-7.1) | 5.36x | 7.2 |
| loopChunk | 39.3 | 12.9 | 7.1 | 7.1 (7.1-7.1) | 1.00x | 7.2 |
| divLoop | 5.1 | 5.5 | 4.2 | 0.371 (0.371-0.371) | 11.24x | 0.390 |
| longDiv | 1.8 | 5.8 | 0.339 | 0.188 (0.188-0.188) | 1.80x | 0.199 |
| switchDense | 1.2 | 5.5 | 0.068 | 0.073 (0.070-0.073) | 0.93x | 0.069 |
| switchSparse | 1.3 | 5.4 | 0.068 | 0.081 (0.080-0.081) | 0.85x | 0.073 |
| refArray | 19.9 | 6.0 | 0.191 | 0.205 (0.204-0.208) | 0.93x | 0.206 |
| matrix | 22.4 | 7.8 | 0.198 | 0.066 (0.066-0.066) | 3.01x | 0.086 |
| sieve | 2.2 | 6.0 | 0.229 | 0.206 (0.196-0.214) | 1.12x | 0.218 |
| intLoop | 1.9 | 5.8 | 0.957 | 0.187 (0.187-0.189) | 5.13x | 0.194 |
| longLoop | 1.9 | 5.2 | 0.424 | 0.133 (0.133-0.133) | 3.18x | 0.136 |
| doubleLoop | 20.6 | 5.6 | 0.692 | 0.071 (0.071-0.071) | 9.80x | 0.072 |
| arraySum | 1.4 | 5.4 | 0.118 | 0.062 (0.059-0.064) | 1.91x | 0.063 |
| fieldLoop | 19.9 | 5.6 | 0.104 | 0.067 (0.065-0.069) | 1.55x | 0.070 |
| allocLoop | 20.3 | 6.2 | 0.160 | 0.012 (0.012-0.012) | 13.41x | 0.144 |
| virtualMono | 19.8 | 6.3 | 0.083 | 0.033 (0.033-0.033) | 2.54x | 0.033 |
| virtualBi | 20.5 | 8.3 | 0.544 | 0.124 (0.124-0.138) | 4.39x | 0.128 |
| interfaceBi | 20.3 | 8.1 | 0.552 | 0.235 (0.235-0.246) | 2.35x | 0.237 |
| linkedNodes | 20.5 | 6.9 | 0.255 | 0.046 (0.046-0.046) | 5.56x | 0.165 |
| strChars | 21.2 | 8.1 | 0.252 | 0.283 (0.281-0.285) | 0.89x | 0.285 |
| strEquals | 20.0 | 6.4 | 0.106 | 0.106 (0.103-0.107) | 0.99x | 0.357 |
| strIndex | 20.3 | 8.6 | 0.272 | 0.358 (0.349-0.359) | 0.76x | 0.498 |
| strBuild | 19.6 | 14.7 | 0.119 | 0.415 (0.411-0.417) | 0.29x | 0.615 |
| strSubstr | 21.9 | 8.2 | 0.300 | 0.384 (0.382-0.397) | 0.78x | 0.400 |
| strCompare | 19.9 | 5.6 | 0.034 | 0.039 (0.035-0.040) | 0.87x | 0.270 |
| parseInts | 19.8 | 12.0 | 0.067 | 0.382 (0.378-0.388) | 0.18x | 0.412 |
| exceptions | 23.5 | 7.3 | 3.1 | 1.4 (1.4-1.4) | 2.20x | 1.2 |

jbench: 41 workloads, geometric mean js/wasm: steady 1.28x, first call 0.78x

G1 extras: 27 workloads, geometric mean js/wasm: steady 1.83x, first call 1.46x


**Chrome 153.0.8010.53**, 3 runs x 100 reps, medians (min-max) in ms, load average 1.2-3.0 on 14 cores. Wasm warm = calls 2 to 11.

| workload | JS first | Wasm first | JS steady | Wasm steady | steady js/wasm | Wasm warm |
|---|---|---|---|---|---|---|
| sha256 | 40.1 | 505 | 0.465 | 4.1 (4.1-4.1) | 0.11x | 4.2 |
| ecdsaVerify | 40.6 | 525 | 0.290 | 0.285 (0.280-0.295) | 1.02x | 0.365 |
| certParse | 142 | 885 | 0.205 | 0.130 (0.125-0.130) | 1.58x | 0.240 |
| listAddGet | 3.1 | 16.6 | 0.080 | 0.035 (0.035-0.035) | 2.29x | 0.285 |
| listIter | 3.0 | 16.6 | 0.100 | 0.055 (0.055-0.055) | 1.82x | 0.240 |
| listRemove | 5.9 | 16.8 | 1.5 | 0.630 (0.630-0.630) | 2.40x | 0.710 |
| mapStr | 3.1 | 13.3 | 0.505 | 0.145 (0.140-0.145) | 3.48x | 0.345 |
| mapInt | 2.7 | 14.2 | 0.170 | 0.090 (0.090-0.090) | 1.89x | 0.335 |
| mapWalk | 4.1 | 16.6 | 0.365 | 0.135 (0.135-0.140) | 2.70x | 0.540 |
| linkedMap | 4.1 | 14.9 | 0.420 | 0.130 (0.130-0.130) | 3.23x | 0.375 |
| hashSet | 3.2 | 13.4 | 0.525 | 0.135 (0.130-0.135) | 3.89x | 0.280 |
| smallAlloc | 1.8 | 10.4 | 0.100 | 0.030 (0.030-0.030) | 3.33x | 0.305 |
| deque | 3.6 | 18.2 | 0.115 | 0.045 (0.045-0.070) | 2.56x | 0.215 |
| treeMap | 6.7 | 21.5 | 0.370 | 0.330 (0.330-0.330) | 1.12x | 0.590 |
| sort | 12.0 | 37.6 | 0.285 | 0.280 (0.280-0.285) | 1.02x | 1.0 |
| mix | 8.2 | 22.8 | 2.2 | 0.970 (0.895-0.975) | 2.22x | 1.2 |
| linkedList | 3.4 | 15.6 | 0.070 | 0.030 (0.030-0.030) | 2.33x | 0.195 |
| b64java | 12.7 | 31.7 | 0.950 | 0.850 (0.820-0.870) | 1.12x | 0.880 |
| b64android | 5.6 | 20.7 | 1.1 | 0.870 (0.840-0.880) | 1.24x | 0.865 |
| jsonParse | 34.2 | 102 | 3.1 | 2.9 (2.9-2.9) | 1.07x | 3.8 |
| jsonWrite | 44.5 | 141 | 7.3 | 16.0 (15.7-16.1) | 0.45x | 16.0 |
| scanTokens | 195 | 1049 | 13.9 | 12.6 (12.4-12.7) | 1.10x | 14.9 |
| scanLines | 154 | 1021 | 5.1 | 4.1 (3.8-4.2) | 1.25x | 5.2 |
| format | 38.8 | 103 | 2.5 | 3.2 (3.0-3.4) | 0.77x | 5.0 |
| dtoa | 10.4 | 34.2 | 3.2 | 0.445 (0.440-0.445) | 7.10x | 1.1 |
| parseFail | 16.6 | 20.8 | 11.8 | 3.0 (3.0-3.0) | 3.92x | 3.5 |
| parseFailMixed | 23.8 | 27.6 | 10.0 | 3.0 (2.9-3.0) | 3.38x | 4.1 |
| fbLoop | 3.9 | 25.7 | 0.130 | 0.150 (0.150-0.150) | 0.87x | 0.290 |
| fbBulk | 2.1 | 21.2 | 0.040 | 0.225 (0.225-0.230) | 0.18x | 0.230 |
| bbInts | 3.4 | 24.4 | 0.215 | 0.225 (0.220-0.230) | 0.96x | 0.360 |
| dbInts | 3.8 | 22.5 | 0.330 | 0.135 (0.135-0.135) | 2.44x | 0.250 |
| casts | 12.1 | 15.6 | 2.0 | 0.430 (0.420-0.435) | 4.66x | 0.455 |
| monitors | 2.4 | 13.9 | 0.215 | 0.100 (0.100-0.100) | 2.15x | 0.140 |
| random | 4.3 | 14.9 | 0.590 | 0.070 (0.070-0.070) | 8.43x | 0.205 |
| strConcat | 1.5 | 11.7 | 0.030 | 0.165 (0.165-0.170) | 0.18x | 0.420 |
| zipOpen | 122 | 457 | 0.625 | 60.0 (59.8-60.1) | 0.01x | 61.3 |
| ssbAppend | 15.3 | 42.8 | 0.285 | 0.155 (0.155-0.165) | 1.84x | 1.0 |
| ssbEdit | 14.7 | 39.8 | 0.250 | 0.100 (0.095-0.100) | 2.50x | 1.7 |
| ssbGetSpans | 13.5 | 43.1 | 0.800 | 0.615 (0.610-0.615) | 1.30x | 1.1 |
| spannedCopy | 7.7 | 22.6 | 0.190 | 0.150 (0.150-0.155) | 1.27x | 1.0 |
| linkify | 11.1 | 53.1 | 0.035 | 0.025 (0.025-0.025) | 1.40x | 0.035 |
| loopOnce | 40.1 | 27.6 | 38.3 | 7.4 (7.2-7.4) | 5.21x | 7.5 |
| loopChunk | 40.5 | 15.6 | 38.3 | 7.3 (7.1-7.4) | 5.24x | 7.5 |
| divLoop | 2.3 | 8.2 | 1.0 | 0.390 (0.370-0.395) | 2.64x | 0.390 |
| longDiv | 2.0 | 8.3 | 0.270 | 0.190 (0.190-0.190) | 1.42x | 0.210 |
| switchDense | 0.920 | 8.0 | 0.075 | 0.070 (0.070-0.075) | 1.07x | 0.075 |
| switchSparse | 0.880 | 8.2 | 0.070 | 0.080 (0.070-0.080) | 0.87x | 0.085 |
| refArray | 3.0 | 8.8 | 0.195 | 0.190 (0.190-0.190) | 1.03x | 0.200 |
| matrix | 4.0 | 10.5 | 0.250 | 0.070 (0.070-0.070) | 3.57x | 0.090 |
| sieve | 2.2 | 8.6 | 0.235 | 0.125 (0.120-0.145) | 1.88x | 0.140 |
| intLoop | 1.8 | 8.2 | 0.960 | 0.200 (0.190-0.205) | 4.80x | 0.215 |
| longLoop | 2.1 | 7.7 | 0.455 | 0.135 (0.135-0.135) | 3.37x | 0.155 |
| doubleLoop | 2.4 | 8.4 | 0.605 | 0.075 (0.075-0.080) | 8.07x | 0.080 |
| arraySum | 1.1 | 8.6 | 0.075 | 0.060 (0.060-0.060) | 1.25x | 0.065 |
| fieldLoop | 2.8 | 8.5 | 0.780 | 0.070 (0.070-0.070) | 11.14x | 0.070 |
| allocLoop | 2.2 | 8.8 | 0.150 | 0.035 (0.035-0.035) | 4.29x | 0.135 |
| virtualMono | 1.4 | 8.8 | 0.080 | 0.075 (0.075-0.075) | 1.07x | 0.075 |
| virtualBi | 2.1 | 10.8 | 0.485 | 0.125 (0.125-0.145) | 3.88x | 0.135 |
| interfaceBi | 2.3 | 10.7 | 0.480 | 0.250 (0.245-0.250) | 1.92x | 0.250 |
| linkedNodes | 2.2 | 9.9 | 0.230 | 0.065 (0.065-0.065) | 3.54x | 0.070 |
| strChars | 1.9 | 10.5 | 0.240 | 0.430 (0.405-0.430) | 0.56x | 0.445 |
| strEquals | 2.0 | 9.2 | 0.295 | 0.130 (0.125-0.140) | 2.27x | 0.365 |
| strIndex | 2.1 | 11.6 | 0.175 | 0.710 (0.705-0.715) | 0.25x | 0.815 |
| strBuild | 1.6 | 17.9 | 0.125 | 0.435 (0.430-0.435) | 0.29x | 0.660 |
| strSubstr | 3.5 | 10.8 | 0.250 | 0.570 (0.555-0.570) | 0.44x | 0.685 |
| strCompare | 1.5 | 8.1 | 0.025 | 0.040 (0.040-0.040) | 0.63x | 0.160 |
| parseInts | 1.5 | 14.8 | 0.065 | 0.335 (0.330-0.335) | 0.19x | 0.410 |
| exceptions | 4.7 | 9.9 | 2.4 | 1.6 (1.6-1.6) | 1.48x | 1.6 |

jbench: 41 workloads, geometric mean js/wasm: steady 1.39x, first call 0.24x

G1 extras: 27 workloads, geometric mean js/wasm: steady 1.67x, first call 0.25x



**What changed, in the order of measured effect** (steady geometric mean js/wasm over the 11 jbench workloads that match, V8 13.6, 3 to 5 runs
each, so +-5%; the starting point is `3702b732` plus the harness):

| Step | js/wasm |
|---|---|
| start | 0.84x |
| array stores check the element class in Wasm (`astore` asked the host, `host.info`, a Map lookup by class name, on every store into a typed array: 28% of `mapInt`); the element class and test kind sit in the array vtable (`ELEM`, `ELEM_KIND`) | 1.15x |
| constructors join their caller's unit (they were never grouped), 16 members | 1.28x |
| a thrower call is followed by `unreachable`, so V8 narrows the reference after `if (x == null) throw` (`mapWalk` 0.28 to 0.22 ms, `bbInts` 1.09 to 0.94, `random` 0.21 to 0.18) | 1.38x |
| class-initialisation guards skipped for classes already initialised when the unit is compiled and for the compiled method's own class chain (`World.entry` now initialises a static entry's class itself) | 1.44x |
| already-compiled small callees are copied into the caller's unit (unexported copy, `buildUnit(methods, copies)`), so a call is direct and inlinable wherever it is | 1.56x |
| null checks and guards dominated by an earlier one on every path are dropped (`facts.ts`, forward must-analysis, edges of `if-eqz`/`if-nez` refine it); field accesses that share a cast keep it in a local | 1.57x (TurboFan already narrowed; Liftoff-only `treeMap` -10%, `fieldLoop` -32%) |
| a virtual call tests the vtable slot against the one or two small implementations among the classes some compiled code allocates and calls them directly (`bbInts` 0.65 to 0.31 ms, `random` 0.17 to 0.11) | 1.83x |
| the Wasm-written intrinsics (String methods, `Math`) are copied in like other small callees; the classes a unit allocates count before its calls are planned (`virtualMono` 0.18 to 0.03 ms, `strChars` 0.53 to 0.29) | 1.90x |
| dense `switch` is a `br_table` (`switchDense` 0.136 to 0.075 ms); groups up to 24 | 2.0x |
| two tiers: a method is first compiled alone and counts calls and loop iterations (budget 5000); a hot one is recompiled with the callees that ran copied in, busiest first. Steady state is unchanged, first call 17% faster overall and 2x on the collection workloads (cold code no longer compiles its callees) | 2.0 to 2.1x |
| throwers, allocations, casts and instance tests are calls to small functions of the module: V8's inlining budget is a multiple of the root function's size and the callee limit is 500 bytes, so shorter sequences mean more inlining (`bbInts` 0.32 to 0.24, `mapStr`/`hashSet`/`mapWalk` -12%) | 2.1 to 2.2x |
| `astore` fast path in the caller for a value of exactly the component class (`refArray` 0.29 to 0.21 ms, parity with the JS tier) | |

**V8 findings.** (1) After `if (is_null x) { call thrower }` V8 does not narrow `x`; with `unreachable` after the call it does. (2) Inlining is the
whole game: `--no-wasm-inlining` is 3.6x slower on `bbInts` and 2x on `mapInt`; the default budget (`min(5 x root size, 7000)` nodes, callees up to 500
wire bytes, counts from Liftoff) is what limits `bbInts`: with `--wasm-inlining-budget=50000 --wasm-inlining-factor=10 --wasm-inlining-max-size=3000` it
runs in 0.16 ms (0.19 for the JS tier) against 0.24, which Chrome does not let us set. (3) `--wasm-inlining-call-indirect` changes nothing in
Chrome 153 on five workloads. (4) Repeated `ref.cast` of one value is free under TurboFan (46 vs 47 ms for 30 M iterations of six field reads) and 2x slower
per access in Liftoff, hence the shadow locals. (5) Default tiering beats `--no-liftoff` (`bbInts` 0.65 vs 0.75 ms): optimized code uses the call counts
collected in Liftoff. (6) **Chrome 153 and Chromium 151 do not inline the `wasm:js-string` builtins** (node's V8 13.6 does): a `charCodeAt` loop over a
58-character string costs 2.1 ms in Chrome from Wasm against 0.56 ms in node and 0.70 ms for the same loop in Chrome's JS; the same loop over an `i16`
array copied once with `intoCharCodeArray` costs 0.39 ms in both. In Chrome `charAt` (a `length` and a `charCodeAt` call) is the slow part of every string
workload there (`strChars` 0.45 vs 0.24 ms, `strIndex` 0.77 vs 0.19). Gate G5 (strings as structs over `i16` arrays) should weigh this.

**Rejected or neutral** (each measured, reverted unless noted). Larger groups (32 members, callees up to 200 code units): within 5% on steady
state, first call +10%. Dropping the allocation accounting (`alloc` word per allocation): 2% (noise). A fast path in `acmp` (reference compare): 1%.
Static types of reference webs (`types.ts`: one cast for `array-length` instead of testing five kinds, casts to a supertype dropped): `mapWalk` +9%
slower, the rest unchanged; the shorter code gave V8 a smaller inlining budget. An out-of-line `ensure` call in the class-init guard: nothing, `bbInts`
worse. Budget of 20, 200 or 1000 calls for the second tier: same steady state, first call 2x worse (the first call of a jbench workload already runs
thousands of iterations); 5000 and 20000 are equal, 5000 kept. Compile hints: ignored by Chrome (G4 hint result). Kept although neutral under TurboFan: the
dominated-check facts and the shadow cast locals (Liftoff gains above).

**G4 (tier-up without OSR).** A loop kernel in one long call stays in Liftoff for the whole activation. `loopOnce` (8 M iterations of an int mix, one call):
first call 47.7 ms node / 42.4 ms Chrome including about 25 ms of compile, against 8.2 ms for the same call once tiered up, i.e. about 3x per iteration in
baseline code; the JS tier needs 45 ms for it, so even baseline Wasm is faster than the JS tier's optimized code here. Re-entering the loop in chunks of
16384 iterations (`loopChunk`, the same work as outlined body calls) reaches optimized speed after about 12 ms: first call 38.2 ms node / 34.2 ms Chrome.
Ten times the work (`loopOnceBig`, 80 M): 214 ms in one activation (the next call 188 ms, still baseline in the new function), 112 ms chunked (83 ms
optimized), 441 ms in the JS tier. So the gate (optimized speed within 100 ms) holds for any loop that is re-entered (called from a loop or recursion), fails
only for one activation longer than about 100 ms, and there Wasm baseline is still about 2x ahead of the JS tier. The call counter that drives the second tier also
counts loop iterations, so the method is recompiled for its next call. Not built, since the gain is bounded to about 2x on a rare shape: an automatic
outlining of loops that run long in tier 1 (live-in/live-out webs through multi-value results plus an exit code for the loop's branch targets and handlers), or a
back-edge exit to a driver that re-enters the loop in the optimized function.

**For the owners of the natives and strings.** `Integer.toString`/`parseInt` (`parseInts`) go through the host `String.<init>([B)` factory (`decodeString`, a
linear-memory copy per call): 0.36 ms against 0.12 for the JS tier. `String.indexOf` loops over `charCodeAt`; the JS tier calls `String.prototype.indexOf` beyond 32 characters
(`strIndex` 0.36 vs 0.25 ms in node). `String.hashCode` is recomputed on every call (HashMap, 17% of `hashSet`).

### 4.8 S1-I: the remaining correctness gaps (2026-10-04, `knlnks/wasm-i`)

Every method of framework.jar (219,874), FitNotes (22,259), Mihon (95,799), Komikku (131,785) and NewPipe (61,589) now compiles and validates: `sweep.ts` reports no failure of any
kind. A gap is a recorded unsupported capability, so what the sweep and the harnesses below count as gaps is the whole list of what Wasm cannot do yet: natives with no host
binding, String constructors `strings.ts` lacks, a lambda call site (below), a transformer method handle, a relay lookup. The harnesses run the same Java on Wasm, the production
JS tier and the JDK; a case the JS tier cannot answer (its method handle and VarHandle model is its own) is decided by the JDK alone.

**Irreducible flow.** `Flow` threw on a retreating edge whose target does not dominate its source (171 methods of Mihon, 8 of framework.jar: Kotlin `invokeSuspend` state
machines, d8 tail-merged invokes). It now reports the heads of such edges (`Irreducible`), and `structureAny` (`src/jvm/structure.ts`) retries with each head as an extra region
entry: every edge into a head is a dispatch of the existing `$disp` loop and `br_table`, so only the edges that close the cycle pay for it and the rest of the method keeps its
structured loops and blocks. The production JS tier keeps its own fallback. `fuzz.ts --irreducible` (`irfuzz.ts`) writes methods as random block graphs (conditional branches, `tableswitch`, handler
blocks over runs of the layout, a fuel local to end every cycle) in a version 50 class file, which d8 converts: about 30% of the generated methods are irreducible after d8
(91 of 328 for seed 1), 6 seeds x 3,600 cases against the JS tier and the JDK show no difference.

**Unresolved references.** `linkage.ts` resolves a use site as ClassLinker does and fails it the way ART does, when the site runs and with the prefix of the method still executed:
`NoClassDefFoundError: Failed resolution of: LFoo;` for `const-class`, `new-instance`, `check-cast`, `instance-of`, `new-array`, `filled-new-array`, a field or an invoke of an absent
class; `NoSuchMethodError: No virtual method gv()V in class LLkP; or its super classes (declaration of 'LkP' appears in <dex>)` and the static, direct, super and interface forms;
`NoSuchFieldError: No static field gsf of type I in class LLkP; or its superclasses (...)`; `IncompatibleClassChangeError` for a static call of an instance method and the reverse
("The method 'void LkP.sm2()' was expected to be of type static but instead was found to be of type virtual"), an invoke-interface of a class and an invoke-virtual of an
interface ("Found class LkI, but interface was expected"), and a field of the wrong staticness. The message formats are those of `class_linker.cc` and `common_throws.cc` as I know them; they are
not checked against a device, and the `NoClassDefFoundError` has no `ClassNotFoundException` cause. A site that failed because a class is absent is undone when a dex that defines the class is added
(`World.absent`, like the CHA assumptions); a missing member stays missing because a class's supertypes cannot change. A handler whose exception class is absent is skipped, as ART does. `linkdiff.ts`
checks 19 cases (error class against the JDK, message against ART's wording, the code before the site, the dex loaded later). In the sweeps, 3 methods of framework.jar, 19 of FitNotes (the
removed `org.apache.http`), 89 of Mihon, 94 of Komikku and 94 of NewPipe contain such a site: all name a newer platform API or a library the boot jars lack. Also: a call through an
interface no loaded class implements was compiled to `AbstractMethodError`; it is now a dispatch like any other, since a class made later (a proxy) may implement it, even in a frame that is already running. A CHA
decision that one class implements a method still binds the frames already running.

**invoke-custom and method handles.** d8 desugars lambdas, string concatenation and records unless run with `--no-desugaring`, and libcore cannot link what it leaves: `LambdaMetafactory.metafactory` is
`return null`, and `StringConcatFactory` and `SwitchBootstraps` are not in the boot jars. The framework's 15 invoke-custom sites are all `ObjectMethods.bootstrap` (records). `custom.ts` links
those at compile time from the call site item: the record class, the component names and the getter handles (field gets, and virtual, direct and interface getters, the virtual ones
through the reflection thunk so an override is called) become `toString` (a `StringBuilder`), `equals` and `hashCode` (31 * hash + hash, `Float.compare` for floats, `Objects.equals`).
AOSP's own `ObjectMethods` is a chain of combinators that needs transformers. A bootstrap class or method libcore lacks is the `NoClassDefFoundError` at the site (checked: string
concatenation); `LambdaMetafactory` is a recorded gap. `handles.ts` implements `MethodHandle.invoke` and `invokeExact` (framework: `RemoteViews`): the site boxes its arguments, the host checks the site's
type against the handle's (`invokeExact`: equal, else `WrongMethodTypeException`; `invoke`: asType's boxing, unboxing, widening and casts) and calls the method (static, virtual, direct,
super, interface) or field (get/set, instance/static) the handle names through the reflection thunks, without wrapping what it throws. A handle that is a transformer (`bindTo`,
`asType` of another shape, every combinator) runs Java over `EmulatedStackFrame`, which is not modelled: a recorded gap (`customdiff.ts` checks it). `customdiff.ts`: 375 cases, JDK-checked
(records of every component type, about two dozen handle shapes including errors, the hand-written class file whose getters are virtual and interface methods checked against the semantics of ObjectMethods). The JS tier
agrees on records and differs on handles (its model throws on field handles).

**Natives.** `Class.getSimpleNameNative`, `isRecord0`, `getDeclaringClass`, `getEnclosingClass`, `getEnclosingMethodNative`/`getEnclosingConstructorNative`, `isAnonymousClass`, `getDeclaredMethodsUnchecked`,
`getDeclaredConstructorsInternal`, `Method/Constructor.getExceptionTypes`, `compareMethodParametersInternal` and the annotation presence natives (`isDeclaredAnnotationPresent`,
`isAnnotationPresentNative`) come from the dex (`members.ts`); `getDeclaredAnnotation(s)`, `getAnnotationNative`, `getParameterAnnotationsNative`, `Method.getDefaultValue` and the `Signature` annotation
(generic types) build the annotation objects as ART does, through libcore's `AnnotationFactory` with members typed by the annotation method's return type (`annotations.ts`), which needs
`Proxy.generateProxy` (`proxy.ts`): a class made at run time (`World.addClass`) extending Proxy whose methods box their arguments into `Proxy.invoke(proxy, method, args)`, unbox as ART does and wrap
undeclared checked exceptions in `UndeclaredThrowableException`. `Linux.android_getaddrinfo` runs the production resolution (hosts file, numeric forms) and builds the `InetAddress[]` in Wasm with
`InetAddress.getByAddress`; a name the relay must look up is a recorded gap (it answers a Promise), and the error path throws `GaiException` (`UnknownHostException` on top). `Unsafe` get/put of any width on
any array are composed from the elements' bytes (`ArraysSupport.vectorizedMismatch` over `int[]` reads longs). VarHandles: static-field handles, receivers whose static type has no candidate
field (any class, `Object`), `getAndAdd` on byte, short and char variables narrows, byte/short/char/boolean element handles, and an array of another class than the handle's is a `ClassCastException`
(`Vh.java`: 323 cases against the JDK; `classdiff.ts` now builds its handles with `Lookup.findVarHandle` and `arrayElementVarHandle` instead of intrinsics). Two older bugs surfaced and are fixed: `reflect.ts` and
`classes.ts` compared annotation types as descriptors (`getDeclaredClasses` was always empty, `getModifiers` of a member class ignored `InnerClass`). `jbench.ts`: 42 of 42 MATCH (`inetCached` was the blocked one).

**Limits.** A transformer handle, a lambda call site, a name resolved by the relay and a native that needs a scheduler stay gaps. The CHA window for running frames (above) remains.
`invoke` and `invokeExact` box every argument and result. The ART message formats are unverified against a device.

### 4.10 S1-G: the host boundary, strings and the G1 steady state (2026-10-04, `knlnks/wasm-g`)

**G1 steady state, js/wasm geometric mean** (3 runs x 100 reps, load average 1.5 to 5 on 14 cores, so +-10% per workload; same harness, base `b77c6e02`
against this branch): jbench 42 workloads node 1.28x -> 1.76x, Chrome 1.38x -> 1.97x; G1 extras node 1.82x -> 2.38x, Chrome 1.66x -> 2.24x. The
geometric-mean half of the gate holds. The half "no workload more than 10% slower" does not: node `sha256` 0.11x, `fbBulk` 0.16x, `strConcat` 0.47x,
`strSubstr` 0.47x, `bbInts` 0.77x, `switchSparse` 0.83x, `fbLoop` 0.93x; Chrome `sha256` 0.12x, `fbBulk` 0.16x, `strConcat` 0.64x, `strSubstr` 0.46x,
`strBuild` 0.88x. Before (node/Chrome): `zipOpen` 0.01x/0.01x -> 1.21x/1.76x, `parseInts` 0.16x/0.18x -> 1.31x/1.20x, `strIndex` 0.63x/0.24x -> 2.09x/1.10x,
`strChars` 0.90x/0.53x -> 1.92x/1.61x, `jsonWrite` 0.95x/0.47x -> 1.90x/1.81x, `format` 1.43x/0.71x -> 2.03x/2.17x, `hashSet` 1.62x/4.12x -> 3.07x/8.0x.

**Why the rest fails.** `sha256`: the harness's digest of a 1 MB array is the JS form (3.4 ms of the 3.7), because a native cannot await `crypto.subtle`
(the JS tier does, 0.4 ms); it needs the suspension of S3, not a faster bridge. `fbBulk`: a `FloatBuffer.put` into a direct buffer is 16 K `array.set` into
a GC `byte[]`; there is no bulk operation between a GC array and anything else (`array.copy` is array to array, `array.init_data` reads a passive
segment), so about 0.25 ns per byte is the floor. `strSubstr` and `strConcat` allocate a struct and an array per String (a JS rope or slice is one
object): 7.5 ns per `substring`; the micro-measurement of the same two allocations is 2.2 ns, and removing the allocation accounting, an inlined
`sub` and a loop in place of `array.copy` each changed nothing, so the rest is the engine's inlining of the callers. `bbInts`, `switchSparse`, `fbLoop` are
code generation (4.7).

**Natives boundary** (`natives.ts`, `bridge.ts`). `$copy` copied a whole array element by element for each call (`zipOpen`: `initCEN` decodes each of 1000
entry names out of a 60 KB array, 66%, 60 ms). Natives whose contract is (array, offset, length) now copy that range (`RANGES`, 40 entries by class, name
and descriptor; text and pixel natives read a context around their range, so a descriptor-shape rule was wrong: `newStringFromUtf16Bytes` counts chars,
`CursorWindow.nativePutBlob` takes a row and a column), an `Object` argument reaches the native as just the range at offset 0 (`Bridge.offsetIn`), the loops
move two 32-bit words per iteration, and a call that reaches no array no longer reads the scratch top (`WebAssembly.Global.value` was 5% of `zipOpen`).
`zipOpen` 60.3 -> 0.65 ms. The Bridge also copied a primitive array three times; it now allocates the host array for the range only.

**OutOfMemoryError in `scanTokens`/`scanLines`.** Every `java.util.regex.Matcher` opens a native matcher through `NativeAllocationRegistry`, whose `sun.misc.Cleaner` never
ran: the `PhantomReference` held its referent strongly and the Cleaner list held the Cleaner, so 2,022 handles and 7 MB of matcher state stayed per call (heap 468 -> 525 MB
over 8 calls, measured with a handle count and a sampling heap profile that named `hitEndImpl`). `Cleaner.create` is now an intrinsic that makes the Cleaner without
its referent and registers the referent with a host `FinalizationRegistry` that runs `Cleaner.clean`; the harness yields to the event loop every 8 calls so
finalizers run. The limit also compared the whole JS heap (420 MB of it the engine's own program model) with ART's 512 MB; the World now takes the heap at construction as its
base. Either alone is not enough (the leak alone stops at 14 calls, the base alone at 100). `VMRuntime.addressOf` still pins every array it is asked about in
`pinned` and the `nm` table forever; direct buffers that are created and dropped leak through it, which no workload here shows.

**G5: strings as structs, adopted.** `StringRepr` has one implementation, `strings.ts`: `struct { vt, hash, chars: i16[], javaHash, jsString }`. Measured with the
same byte decoders (`strfactory.ts`) in both representations, 3 runs, steady js/wasm geometric mean over all 69 workloads: node JS-string 1.67x, struct 1.93x;
Chrome 1.74x, 2.06x. Per workload (node/Chrome, JS-string -> struct): `strIndex` 0.64/0.25 -> 1.98/1.06, `strChars` 0.92/0.57 -> 1.84/1.62, `strCompare` 0.85/0.75 -> 1.68/1.5,
`strEquals` 0.92/2.77 -> 1.92/6.1, `jsonWrite` 1.04/1.05 -> 1.86/1.85, `format` 1.60/1.83 -> 1.93/2.19, `jsonParse` 1.47/1.31 -> 2.29/1.88, `hashSet` 1.55/4.31 -> 2.71/8.0;
`strSubstr` 0.65/0.43 -> 0.52/0.44 and `scanLines`/`scanTokens` 1.12/1.08 -> 0.99/0.99 (node) are the losses. The micro-costs (`micro/strings.mjs`, ns, 60-char String,
node/Chrome): charAt 1.25/1.75 against 0.35/0.33 over an array, hash 0.74/1.5 against 0.57/0.58, 4-char substring 4.3/8.1 against 2.3/2.2, concat 9/5 against 19/20, equals of equal
Strings 4.3/5 against 31/35, and 25 ns to cross to the host and back. Hash codes are cached in the String, `String.intern` is a host table that also holds the constants,
ART's interned member names come from `intern` (`Method.equals` compares them by identity), and the String is a JS string only for natives
(`toHost` makes it once). `Integer.toString`/`Long.toString` write the chars directly and `parseInt(String)`/`parseLong(String)` take the plain decimal case and leave
the rest (radix, sign, overflow, exceptions) to the library method (`parseInts` 0.16x -> 1.31x node); `AbstractStringBuilder.putStringAt` is one pass instead of `coder()` and `getBytes`.
`String.indexOf` has no bulk operation to call over an array and loops over `array.get`.

**Rejected or neutral** (each measured, reverted). Allocation accounting dropped from `newCharsKnown`, `substring` written as one inlined function, and a char loop below 16
chars in place of `array.copy`: `strSubstr` 0.51 -> 0.50 to 0.52 each. The JS-string representation with its own Wasm byte decoders: lost to the struct everywhere (above).
Not built: a snapshot-and-compare copy-back to skip writing unchanged elements of a large array (`memory.copy` makes the snapshot cheap; useful for a native that only reads a large array, of which
`sha256` is the only measured case, and that one is bounded by the digest).
### 4.9 S4: ahead-of-time platform code and the cold profile (2026-10-04, `knlnks/wasm-h`)

**Where cold time went** (`g1.ts --phases`, node 24 and Chrome 153, shared host). A workload compiles 40 to 3,000 methods; per method the compiler spent 0.07 ms warm and 0.2 to 0.4 ms cold: emit 55%, infer 20%, encode 12%, flow and facts 10%; V8 `Module` + `Instance` of each unit 55 us; a class module (build + link) 0.2 ms. `sha256` (1,413 methods, 330 class modules): compile 275 ms, Module/Instance 72 ms, class modules 62 ms of a 565 ms first call (the rest is the natives bridge, `$copy:i8`). Process start (`processState`) compiles 411 methods and links 178 classes: about 330 ms. The jbench run compiled 35,992 methods in 7.2 s.

**Design** (`aot.ts`, `aotbuild.ts`, `aotstore.ts`, `aotstartup.ts`; `WEBDROID_AOT=<dir>` runs every harness over a build). `bun run aot --only <jars> [--d|--c class|outer|pkg|pkgN|all]` compiles the platform jars at build time through the same `Compiler.buildUnit` / `World.classModule`. Nothing in the generated code depends on what ran first: `World.seedPlatform` numbers the classes of the chosen dexes (ids, one block of table slots per class, `MethodInfo.index` is the offset in it) in definition order, and the index carries the rest (array and other extra ids, the slots reserved after them, selectors, gaps, link messages). The Program must start with the same dexes (a signature check; otherwise the build is not attached and everything compiles on demand). Class (D) modules hold the vtable, init word, statics, lazy-link stubs and `ensure` of a group of classes and import nothing from other modules; code (C) modules hold the methods of a group, install them in the table when instantiated, and import the D globals they name. Loading a C module first loads the D modules of the classes it touches (and their superclass closure), so a table slot it can call is never empty. String constants are imported (`importedStringConstants`), which removes the shared string table; first-tier counters are words of the scratch memory (no imported global per method); module headers and stack-trace maps are custom sections (`aot`, `aottrace`), so a `WebAssembly.Module` compiled ahead carries everything. Methods of a precompiled module call each other through the table, like on-demand units, so the second tier (still dynamic: `World.upgrade`) replaces them one at a time.

**Soundness.** A C module records its class-hierarchy decisions per method; at load, those about a class that gained concrete subtypes since the build (`World.late`) are checked and the methods that fail are put back to lazy-link stubs; later `addDexes`/`addClass` undo them through the ordinary assumption table. `World.holds` now asks only whether an added subtype has a different implementation. Sites that failed on a class missing at the build are undone the same way. A module whose natives are not bound in the World (other `Natives`) is not used; a method this World replaces by an intrinsic the build did not have (or the reverse) is put back too. `aottest.ts` checks both orders with `ArrayList.contains`/`indexOf`. Invalid code the compiler emits for a method (one found: `FinalizerReference.makeCircularListIfUnenqueued`, "expected 0 elements on the stack") is found by validating every module at build and leaves that method to the on-demand compiler.

**Numbers** (node 24.19 / Chrome 153.0, load average 2 to 7 on 14 cores, 3 runs x 30 reps, medians; geometric mean js/wasm over the 42 jbench workloads, first call: base 0.72 node / 0.25 Chrome, with AOT 0.84 / 0.32; steady state unchanged, 1.48 to 1.36 node and 1.51 to 1.44 Chrome within spread). Large first calls improve most (node ms, base to AOT): sha256 575 to 323, certParse 999 to 476, scanTokens 1165 to 531, jsonWrite 181 to 85, jsonParse 140 to 66, sort 37 to 18; small ones are at or below the JS tier in node (listAddGet 14 vs 21.5, deque, treeMap, casts, monitors), but below it only where the JS first call is 20 ms or more. In Chrome the JS tier's first call is 2 to 5 ms for most workloads against 6 to 13 ms for Wasm: the floor is instantiating the app unit, the first hot-loop upgrade (compiler cold, 3 to 4 ms) and V8's lazy compile of the functions that run; G1's "first call not worse" is not met there and is not met in node for the 20 workloads whose JS first call is under 10 ms. jbench compiles 4,368 methods instead of 35,992 (0.7 s instead of 7.2 s of compiler). Boot (`processState`) in node 198 ms (92 D, 20 C modules loaded, 11 MB) against about 330 ms; with the modules compiled ahead by `fetch` + `WebAssembly.compile` (`FetchStore`, `startup.json`) Chrome boot is 113 ms against 142 ms (29 ms of compiling off the main thread). `WebAssembly.compileStreaming` of the same bytes gave modules that fail (a NullPointerException in the platform's start): not understood, `FetchStore` compiles the fetched bytes.

**Asset sizes** (uncompressed, gzip -6 of the directory in brackets): core-oj, core-libart, okhttp, bouncycastle, apache-xml, conscrypt, core-icu4j: 8,534 classes, 66,101 methods, 279 + 279 modules, C 36.7 MB, D 7.2 MB, index 128 KB, build 4 s. The same plus framework.jar: 41,247 classes, 287,763 methods, 1,078 + 1,078 modules, 198 MB (44 MB gzip), index 935 KB, 31 s and 3.5 GB of memory to build; it attaches and passes jbench and aottest, process start 321 ms instead of 198. The largest module is 7.1 MB; Chrome refuses a synchronous compile above 8 MB on the main thread (a worker has no limit).

**Granularity** (node, 10 workloads, 3 runs; first-call geometric mean js/wasm and process start): D = C = package 1.08 (182 ms), package depth 3 1.06 (182 ms), outer class 0.99 (112 ms), one module for everything 0.99 (295 ms, and above Chrome's limit), class 0.55 (115 ms). Fewer larger modules win the first call (module count costs more than bytes: about 55 us per module against 3 ms per MB of validation), per class wins process start; package is the default.

**Cheap compiler wins.** LEB128 without BigInt, no `JSON.stringify` per local or function type, section assembly without per-byte pushes, `Cha.targets` answered from the implementations when a hierarchy is wide (it was 30 of the 36 ms of the first hot upgrade once the boot no longer warmed it; identical to the walk on 48,000 queries); jbench compile 7.2 to 5.2 s. Second-tier compiling is limited to 10 ms plus 30% of the time since the first request (a cold compiler made the first upgrades cost 3 to 4 ms each).

**Left.** The first-call floor in Chrome (tier-up while the compiler is cold; a worker for second-tier compiles); a profile-driven boot group (all classes the start touches in one D and one C module) instead of the package grouping; the ARM-side check of Chrome's `compileStreaming` failure; framework.jar chunking under the 8 MB main-thread limit by size instead of package; production persistence of the index and modules per build hash; G3 as defined (launch to first draw) needs the app-level harness.

**With the AOT platform code (4.9) merged** (`80b8f12f`..). H's modules import String constants as `externref` globals (`importedStringConstants`); with struct Strings a constant is
made on first use: a module-local function `$lit` takes the imported JS string, makes the String (`fromJs`), interns it through the host table (`String.intern` and the constants share it,
so interned-name identity holds across modules) and keeps it in a table of the module (a table, because an added global would shift the indices of the imports declared after it); the class
modules call the runtime function `strLit` for the static String values. The hash is a field of the String, so it is cached in AOT code as well. The `js-string` builtins stay: `fromCharCodeArray` and
`intoCharCodeArray` are the conversion to and from the JS string a native takes. `aot.ts` VERSION is 2. Build `aotbuild.ts` (4 jars, 218 + 218 modules, C 23.8 MB, D 4.6 MB) and the set (diff,
libdiff, classdiff, customdiff, linkdiff, lazytest, fuzz seeds, jbench, `aottest`) pass plain and over the build. Combined G1 (AOT build and `G1_PREFETCH=1`, 3 runs, load 2 to 6): jbench steady
node 1.25x -> 1.66x, Chrome 1.34x -> 1.90x; first call node 0.80x -> 0.95x, Chrome 0.33x -> 0.37x (all 69 workloads: first 0.92x -> 1.09x node, 0.34x -> 0.37x Chrome; steady 1.44x -> 1.90x, 1.51x -> 2.04x).
Still under 0.9 with AOT, node: `sha256`, `fbBulk`, `bbInts`, `strConcat` 0.46, `switchSparse`, `strBuild` 0.86, `strSubstr`; Chrome: `sha256`, `fbBulk`, `fbLoop`, `strConcat` 0.64, `strBuild` 0.88, `strSubstr`,
and `ecdsaVerify` 0.63 (0.28 ms JS tier, 0.46 ms Wasm; 1.00 in Chrome without the AOT build, in node with it, and with the AOT build before the struct String). Not the Cleaner, the ranges or the
harness's gc (each switched off alone); the JS profile of the two modes is the same BigInt code, the Wasm run has 100 ms more garbage collection in 1,500 calls. Unresolved.

**Two bugs found on the way.** `FinalizerReference.makeCircularListIfUnenqueued` (`refs.ts`) compiled to invalid Wasm because its `if` produced a value and was written without a block type; the Wasm validator rejects the
module, and `aotbuild.ts` leaves a method it cannot compile to the on-demand compiler, which then fails the same way at run time. The sweep now covers the jars the build compiles (the first six boot jars, 281,000
methods, no invalid module) with the options the engine uses (`COMPILE_OPTIONS`). `WebAssembly.compileStreaming` of the AOT modules made `Reflection.getCallerClass` answer the wrong class: a module compiled from a
streamed response names its frames by the response's URL (`at f (http://host/m?p=...:wasm-function[3]:0x176)`), not `wasm://wasm/<hash>`, and `javaFrames` only read the second form, so every frame of a streamed
module was skipped (node's `compileStreaming` and tiny modules in Chrome look identical, hence "works with fetch + compile"). Options and import object were identical (`micro/streaming.mjs`: the builtins and the imported
constants work through `compileStreaming` in Chrome 153). `FRAME` now accepts both and `aotstore.ts` streams again.

### 4.11 S1-J: the G1 first call and the residual steady losers (2026-10-04, `knlnks/wasm-j`)

**Where the first call went.** With the AOT platform (4.9) the first call of a small workload was still 6 to 13 ms in Chrome, and `--phases` showed why: 3 to 10 ms of it was the *second tier*. A loop that spends its budget (5,000) asks `World.upgrade`, which compiled the method and its small callees at once, with a cold compiler (about 0.5 ms per method; `UPGRADE_FREE_MS` allowed the first 10 ms for free). With upgrades switched off, `listAddGet` node first call went 14.7 -> 3.5 ms. The upgrade now waits until the program has been hot long enough to pay for it: a request is refused (and renewed after another budget) while `upgradeMs + expected cost > 0.3 x (time since the first request)`; the expected cost is 1 ms until a compile has been measured, then the mean. A loop that stays hot for about 3 ms upgrades as before; a first call that is short never pays. `lazytest` and `trace` ran their hot loop for 40,000 iterations and asserted an upgrade; they now call until one has happened.

**App compiled at build time.** `bun run aot --app <dex>` numbers and compiles an app dex after the platform's, as an install would (`AotRuntime.attach` already accepts a Program of the platform dexes plus more; the build records the app's dex signature, so a different app does not attach). In the harness, `bun aotbuild.ts --app $TMPDIR/g1/classes.dex` (the dex `g1.ts` builds; copy `startup.json` from a build without it, the boot does not touch the app). The first call of `intLoop` in Chrome 4.7 -> 2.4 ms (it compiled its method and a second unit on demand, 3 ms), `listAddGet` 6.1 -> 3.4, `hashSet` 4.9 -> 2.7. Every workload of the harness is in that one dex, so its C module is the size of a package of a real app.

**Sparse `switch` and the array peek/poke natives.** Keys that are not dense enough for `br_table` are searched in halves down to runs of three compares (`switchSparse` node 0.98 -> 1.09, Chrome 1.00 -> 1.21; `W.sparse9` joins `diff`). `Memory.peek/poke<Kind>Array` test the byte order once (two loops instead of an xor per byte), step a position instead of recomputing `i * w`, and byte kinds are one `array.copy`: `fbLoop` Chrome 0.84 -> 0.94..1.10, `fbBulk` unchanged.

**G1, js/wasm geometric mean** (3 runs x 100 reps, node 24.19 / Chrome 153.0, load average 2 to 4 on 14 cores: +-10% per workload, flagged noisy; the same harness at `9bc05263` in a second worktree is the base). jbench's 42 workloads (the gate), first call / steady:

| build | node first | node steady | Chrome first | Chrome steady |
|---|---|---|---|---|
| base: 4 jars (4.9 combined) | 1.01 | 1.67 | 0.38 | 1.88 |
| + deferred second tier, switch, memory | 1.35 | 1.64 | 0.52 | 1.76 |
| + app compiled at build time | 1.97 | 1.54 | 0.73 | 1.76 |
| 7 jars (core-oj, core-libart, okhttp, bouncycastle, apache-xml, conscrypt, core-icu4j) + app | 2.42 | 1.55 | 0.76 | 1.74 |

All 69 workloads, last three rows against base: node first 1.20 -> 1.45 -> 2.49 -> 3.03, steady 1.88 -> 1.89 -> 1.81 -> 1.80; Chrome first 0.38 -> 0.49 -> 0.77 -> 0.80, steady 2.03 -> 1.94 -> 1.96 -> 1.95. The steady geometric mean loses 5 to 8% because a workload that is 5 ms long in total (a hundred calls of 0.05 ms) now upgrades after about 60 of them, and Wasm's own tier-up (Liftoff to TurboFan) then starts later (`listAddGet` 0.03 -> 0.059 in one run, 0.030 in the next: the policy is time-based, so it moves with host load); it is within the gate's 1.3x. **First call passes in node and not in Chrome**: Chrome's JS tier takes 1 to 5 ms for the small workloads and Wasm 2 to 4 now (`hashSet` 2.7 against 3.0, `listAddGet` 3.4 against 3.2, `intLoop` 2.4 against 1.8), and the geometric mean is dragged below 1 by the 12 workloads that run platform code which the build does not hold or that V8 must compile (`sha256`, `ecdsaVerify`, `certParse`, `scanTokens`, `scanLines`, `zipOpen`: 0.25 to 0.64; `ssb*`, `spannedCopy`, `linkify`, `b64android`, `dtoa`, `dbInts`: 0.3 to 0.5, all `framework.jar` code). Building `framework.jar` too (204 MB, 1,079 modules) gave `ssbAppend` 39 -> 33 ms, `linkify` 42 -> 42, `b64android` 21 -> 25: the remaining cost there is V8 compiling and validating the multi-MB package modules (about 3 ms per MB), not our compiler; the page cannot hold that build (fetching 204 MB per context failed in Chrome).

**Still failing the steady half** ("no workload more than 10% slower", js/wasm, node/Chrome): `sha256` 0.11/0.12 (the harness's digest is the JS form; it needs S3's suspension), `fbBulk` 0.17/0.17, `strConcat` 0.48/0.4, `strSubstr` 0.47/0.6, `strBuild` 0.88/0.76, `bbInts` 0.66 to 0.77/0.5 to 0.95, `ecdsaVerify` Chrome 0.62, `fbLoop` Chrome 0.84 to 0.94.

**Rejected or not built** (each measured unless it says so).
- `fbBulk`: there is no bulk operation between linear memory and a GC array (`array.new_data`/`array.init_data` read passive data segments, `array.copy` is array to array), so a staging area in linear memory cannot beat the per-element `array.set`. With one byte-order test and a stepped position the 4,096-float `put` is still 0.2 ms, 1 ns per float, 0.25 ns per byte. The remaining route is a direct buffer in linear memory (a native allocator with the lifetime of the `NativeAllocationRegistry`), which also gives the natives views without a copy; not built.
- `strSubstr`/`strConcat`: sharing the parent's chars with offset and length fields would save the array allocation, but 4.10 measured the two allocations at 2.2 ns of the 7.5 ns and removing the accounting or the loop changed nothing; the best case is then about 0.8x, still under the gate, and it adds an offset to `charAt`, `equals`, `hash` and every native string conversion. A rope node flattened on first `charAt` is the same size of change for `strConcat`, whose cost is the byte-array `StringBuilder` of libcore (`putStringAt`, `getBytes`, the decoder in `toString`) against the JS tier's native builder. Not built.
- Upgrade cost estimated per method (0.4 or 0.2 ms times the group size) instead of 1 ms: `listAddGet` first call 3.6 -> 8.1 ms, nothing gained elsewhere. Thresholds of 0.5 ms or a share of 0.5 or 1: first call 3.5 -> 11 ms (the first compile of a group costs about 7 ms with a cold compiler).
- Compiling second-tier groups in a worker or at idle: not built. The group needs the World's class hierarchy and program model (hundreds of MB), and its install is synchronous; a copy in the worker would double the model. Deferring until the code has been hot recovers most of the first-call time without it.
- A profile-driven boot group (one D and one C module for what the start touches), engine warming and avoiding the re-instantiation of the app unit: not built; with the second tier deferred and the app in the build, the first call of the small workloads has no compile left (`call` phase: 0 methods, 0 ms), so there is nothing for them to remove, and boot (`processState`, 92 D and 20 C modules, 110 to 130 ms) is outside G1's first call.
- Chrome flags: none can be set from a page.

**Harness.** The page script of `g1.ts` had an extra brace since the streaming switch (4.9): every Chrome run timed out waiting for the page; fixed. Tests (`diff`, `libdiff`, `classdiff`, `customdiff`, `linkdiff`, `lazytest`, `aottest`, `fuzz` seeds 1 to 6, `jbench` 42 MATCH) pass plain and over a 4-jar build.

### 4.12 Track A: delivery of the platform build and the Program model (2026-10-04, `knlnks/wasm-ta`)

**A1, build and delivery.** `bun run aot` builds the libcore jars and `framework.jar` (41,247 classes, 287,769 methods, 1,085 C and 1,078 D modules, 204 MB, 55 s and no memory trouble under node) into `vendor/wasm-aot/<key>`,
where the key is a digest of the platform jars, `src/wasm/{compiler,link}`, the shared front end (`dex prepared structure opcodes abi`), the registered native keys, the build format and the options; the same key
names the build when it is made again (skipped). A group of classes (a package) is split into modules of an estimated 3 MiB (`--max-module`; the estimate is 14 bytes per dex code unit and 150 per method for code
modules, 52 per method for data modules, measured over the 7-jar build as within 0.5x to 1.5x), the largest module of the framework build is 3.4 MB, and a module over 7 MiB fails the build. `startup.json` lists the 188 files (28 MB) a
start of the process loads; `current.json` names the build and carries the digest of the sources it was made from, which the dev server compares with the sources now (a stale build is not offered) and `build-prod` refuses.
Cloudflare (docs read 2026-10-04: static assets 25 MiB per file, 20,000 files per version on the free plan, 100,000 paid; Workers Builds 8 GB of memory, 20 minutes) takes this build as it is: 2,163 files, `_headers` makes
`/aot/<key>/*` immutable and `current.json` revalidates; `bun run worker:check` reads 6,001 files. The build is made where `vendor/aosp` is, not by `build-prod`, and shipped when present.
**D1, the miss policy.** A page never fetches synchronously. `FetchStore` compiles the start's modules with `compileStreaming` (the fetch of the whole build failed in a page; 28 MB does not), and a module the store lacks is a
miss: the code is compiled on demand against the build's numbering (a seeded class that misses its D module is compiled with its reserved slots; a C module is used only with the D modules it was built against), and the
answer is kept, so a module that arrives later cannot define a class twice. `aottest` runs stores that lack every other module, every module, and modules that arrive late. A module compiled by the tab is a
`WebAssembly.Module` of the tab's realm, so `instanceof WebAssembly.Module` is false in a process frame (it failed in the probe), and `ArrayBuffer.isView` tells bytes from a module.
`bun run wasm boot-probe` (headless Chrome, `?tier=wasm`): the tab opens the build, starts the process (`processState`: 188 modules loaded, 0 missed, 0 synchronous requests, 200 ms to fetch and compile them off the main thread,
boot 250 to 330 ms of which our compiler 4 ms for 16 methods) and an iframe does it again with no request, a shared platform Program and its modules.
**A2, the Program.** `Program` keeps a `DexClass` per class that reads its header when asked and builds `FieldInfo`/`MethodInfo`/`byKey` when the first of them is used; the class-hierarchy index (`cha.ts`) works from headers and
method declarations (`DexFile.classHeader`, `declaredMethodCount`, `methodKey`), with the "classes that declare a concrete method of this key" index built on the first wide-hierarchy query. `new Program(dexes, base)` extends an
immutable base Program (the platform's), whose memos and class-hierarchy index are kept in the base (`Program.shared`) and so exist once per tab (`host/boot.ts` `platformProgram`). Node 24, `--expose-gc`, all 40 boot jars
(54,727 classes) and Mihon (21,905 classes): `new Program` 330 MB and 425 MB before; platform Program and index 24 MB (once per tab), the index of declared method keys 63 MB more on first use (once per tab), Mihon over it 12 MB per
process; touching five classes (2,222 methods) 1 MB.
Loaders: a loader is a namespace (`Loader`: parent, `defined`, its Java object); the default one holds the platform and the app (first definition wins, as before) and any other holds what its dex files define that its parent
does not (parent first, as BaseDexClassLoader), keyed `name@id`. A class has one key whatever loader defines it, so ids, class modules, statics and vtables are per defining loader without any other change, and the
platform keeps its build numbering. The dex files of a loader see the classes through it: `DexFile.resolveType` maps each descriptor it reads to the key its loader resolves, so the compiler, the linker and reflection read keys
from the dex and nothing else changes; `javaName` strips the suffix wherever Java sees a name (`Class.getName`, messages, stack traces). The DexFile natives of libcore's `BaseDexClassLoader` (`openDexFileNative`,
`defineClassNative`, `closeDexFile`, `isBackedByOatFile`, `verifyInBackgroundNative`) are Wasm over `World.opts.dexes(path)`; `Class.forName(name, init, loader)` and `VMClassLoader.findLoadedClass` resolve in the loader's scope,
`Class.classLoader` is the loader's object, and a loader that opens dex files the Program already holds stays in that namespace. Not done: `getClassNameList` (a gap), `DexFile.loadClass` defining in the cookie's loader instead of the
given one, the app's own PathClassLoader object as the default namespace's `getClassLoader` (classes of the default namespace still answer the boot loader), custom `ClassLoader` subclasses that define classes themselves.
`bun run wasm loaders`: two DexClassLoaders over dex files defining `Shared` (and `Boom`): distinct Class objects, statics, instances, array classes, signatures naming the loader's own class, exceptions thrown and caught inside
a loader and seen from outside, `Class.forName`, `loadClass`, `getClassLoader`, `instanceof`/casts across loaders and through the app's `Tag`.

### 4.14 B2: classes the host implements (2026-10-04, `knlnks/wasm-tb2`)

The registered specs (`rt.register`) outside the VM's own classes (`TS_SPECS` "vm:", and the "intrinsic:" ones, which stand in for bytecode for speed) are the **host classes**: 147 of the 194 specs, `webdroid/*` services and helpers, the WebView
provider, the TLS and HTTP boundary (`java/net/HttpURLConnection`, `javax/net/ssl/*`, `com/android/okhttp/Http{,s}Handler`) and the GL/EGL implementations; over the 40 boot jars all 147 are defined (124 classes of natives, 23 over dex classes). `World.addHostClass(spec)` (`link/hostclass.ts`; `nativeSource.hostSpecs()` lists them) makes each a Java class
once its superclass and interfaces exist (a spec waiting for one is retried as dexes arrive):
 - A spec whose class no dex defines becomes a class of natives (`World.addClass`): every method key a native with the spec's function behind its host import, the spec's `ifaces`, and the constructor Java finds when the spec declares none (`<init>()V` calling the superclass's), so `newObj`, a bytecode subclass's
   `super()` and `Class.newInstance` work on it.
 - A spec whose class a dex defines (the boundary) takes over the methods that class declares, in a class of the World's own Program layer that stands for it (methods copied at the same positions; their bodies are dropped, an abstract one becomes concrete, the AOT build's code for them is not used: `AotRuntime.override`); the platform's classes, which the Worlds of a tab share, are never changed (`Program.shadowing` makes the layer answer for implementations). A method the spec implements that a superclass declares (`connect()` of URLConnection,
   implemented for HttpURLConnection) cannot be added to the class without changing the numbering of its slots, so it is a native of a class of its own (`name$$host`) that the class's `byKey` resolves it in; `implFor`, `resolve`, `invoke-super` and the vtable find it there, reflection does not list it.

**Identity.** A Java object whose class chain reaches a host class has a host object (an instance of the spec's TS class) beside it; the natives of the spec take it as `this`, and every other place a native or a host call sees that Java object (arguments, results, fields, arrays, `vcall`
receivers, `classNameOf`) sees the same host object, never a facade. A host object that crosses to Java is the Java object it was made with, allocated when it first crosses (`Bridge.shellOf`). `self() === receiver` holds both ways, `equals`/`hashCode`/`HashSet`/`indexOf` in Java agree with `===` in TS (`hostclass`).
A Java object Java allocated (a bytecode subclass of a host class, `HttpURLConnectionImpl`) gets its host object at its first host call, which is its constructor.
**Lifetime.** The two are linked by two `WeakMap`s (Java object to host object, host object to Java object) and nothing else: each keeps the other alive exactly as long as it lives itself, an ephemeron cycle the collector frees when neither is reachable from elsewhere, and there is no table to leak from or to
clean (`hostclass` collects both ways under `--expose-gc`, and checks that a Java object that Java holds keeps its host object).
**Fields.** The host object reaches the fields of its Java object as properties: every instance field of the class's layout under its mangled name (so `declaredField`, `getDeclared`, and a spec such as HttpURLConnection reading `URLConnection.connected` by name work on a host object), and the fields `fields:` names under their
host property (HttpURLConnection's `method`, `responseCode`, ...). What the host object holds in such a property when it is made is stored into the field (a field Java wrote first keeps its value). A property of a class that has no Java field of that name stays an ordinary property. **Hooks.** `claimOnStore` is a store hook: a store into a long
field of a class with a `finalize()` calls `host.claim(owner, handle)` (`rt.claimHandle`), whose `FinalizationRegistry` frees the handle with the owner.
**Deviation from the breakdown (2.3):** no `$host` field. A field added to a platform class changes the struct type of its subclasses and so the layout the AOT build was compiled against, and a class made at run time needs the same table for the classes of the boundary, so one pair of weak tables serves both; the cost is a `WeakMap` get where `this` is bound.
**Not done:** `statics:`, `clinit` and `platformClinit` of a spec (no host class uses them: the boundary's constants come from the dex), `callerSensitive`, JS-prototype checks inside a spec (HttpURLConnection's `getResponseCode` asks whether `getInputStream` is overridden by comparing prototype properties, which a host object has none of),
methods of a spec that no supertype declares (Java cannot call them), and the CHA of a wide hierarchy for the methods in `name$$host` (the walk of a small one finds them).
`bun run wasm hostclass`: 26 cases on the JS tier and on a World (a `Counter` spec with interfaces, an alias, `self()`, a host-made object passed to Java and kept there, a Java-made subclass whose `twice()` virtual call from the host reaches the override, an `AbstractList` spec with a bytecode subclass calling `super.get`, an HttpURLConnection subclass whose Java and host sides read and write
each other's fields, and the exceptions each way), a host method that waits called from a bytecode subclass, and one that enters Java that blocks on a monitor (both Suspending natives: the host object is `this` through the wait), the lifetime checks and the handle claims. `aottest` checks that a host class's method replaces the build's code.
### 4.12 S3: strands, monitors and the waits (C1 and C2, 2026-10-04, `knlnks/wasm-tc`)

**Substrate** (`link/sched.ts`, `link/monitor.ts`, `host/suspend.ts`). A Java thread is a strand, a JSPI stack: `Strand.call(f)` runs a table function through `WebAssembly.promising`, `World.entryAsync` is the entry
that may block (a new strand of the main thread). Compiled code reaches the scheduler through two imports: `host.sync(op, obj, a)` answers at once, `host.block(op, obj, a, b)` is Suspending and answers a status the Wasm
side turns into the exception (`blockStatus`: InterruptedException, IllegalMonitorStateException, IllegalArgumentException for a timeout, and an IllegalStateException when the stack cannot suspend). There is no
scheduler loop: the strand that resumes is the one whose promise a waker resolved. `sid` (strand id), `thr` (the Thread) and `depth` are globals the running strand owns; a blocking call keeps them in locals and sets them
again after it (`emitSave`), and every Suspending wrapper puts them back to the host's top level when its function returns, so host code at the top level always sees strand 1 (the root, which cannot suspend).
Measured (platform-status.md): a Suspending import answering a plain value still suspends and costs 52 ns against 4 for a plain import, so only natives that can wait get one; `entryAsync` costs 1.4 us against 0.9 for `entry`.
Natives: async functions are Suspending only; generator natives (`$g`) and `MAY_SUSPEND` ones (conscrypt's `EVP_DigestFinal_ex`, which answers a Promise only for a message of 64 KB or more) have a plain import and a
Suspending one (`id#s`), and the stub calls the Suspending one on a strand's stack and the plain one at the top level. A plain import that answers a Promise is reported (`wasmNativeSuspended`, `suspendedNatives`),
a call the engine refuses to suspend (a JS frame between the strand's entry and the import) is counted (`wasmSuspendErrors`). The Bridge scope of a Suspending native is set aside while it waits (`hold`), and its arrays are
private copies written to the scratch region on resume (H2). The harness workaround for the digest is gone: `sha256` steady 3.8 ms -> 0.9 ms (JS tier 0.44), through `entryAsync`.
**Monitors.** The header word of every object is an i64: identity hash in the low half, the lock in the high half (0 free; strand id << 8 | count for a thin lock, count up to 255; INFLATED | index for a host
monitor). `monitor-enter/exit` are the module-local helpers `menter`/`mexit` (thin fast path), `menterSlow`/`mexitSlow` otherwise. Inflation happens on contention, a count past 255 and the first `wait`; an idle
monitor deflates. Ownership is by strand, a thread's root strand shares with its other strands (as the JS tier's `owns`), a lock whose owner strand has ended is free. `wait/notify/notifyAll`, `Thread.sleep(lock, ms, ns)`
(a timed wait on `Thread.lock`), `Thread.nativeCreate` (the body is a strand: `run`, `dispatchUncaughtException`, `exit`, peer cleared, joiners notified), `interrupt0`/`interrupted`, `holdsLock`, `Unsafe.park/unpark`
(both Unsafe classes), `Thread.getState` are intrinsics over those imports; the real libcore `Thread`, `LockSupport` and `java.util.concurrent` run unchanged.
**Class initialization.** The init word holds `strand << 2 | 1`; the same strand proceeds, another waits in `initWait` (Suspending; woken by `initWake` when the initializer finishes or fails), a request the initializer
waits on through classes or locks (`waitsOn`) proceeds with the statics as they are, as clinit.ts does.
**Fuel and depth.** A loop whose body calls, locks or reads a field counts its iterations in a local of its activation and every 4,096 yields (`yieldNow`: a macrotask once the turn has held the thread 8 ms, else a
microtask hop, so strands whose promises resolved run); the check is skipped for loops of arithmetic and array elements, where it cost 40 to 150% (the `call` in the loop is the cost, not the counter). Methods that
call something count their frame weight (4 + Wasm locals) in `depth` against `MAX_DEPTH` 56,000 (about half what node's stack holds: 8,700 frames of weight 11 or 2,030 of weight 53) and throw StackOverflowError themselves,
so a Java `catch (StackOverflowError)` works mid-stack on the host's stack and on strands'; an overflow that still reaches the engine is converted at the boundary as before. The depth is restored on return and at handlers.
**Results.** `bun run wasm threads`: 38 Java cases (monitors, wait/notify ping-pong, contention, sleep order, interrupts, join, uncaught handlers, thread states, park/unpark, ExecutorService, ConcurrentHashMap under
contention, CountDownLatch, ReentrantLock/Condition, BlockingQueue, Semaphore, FutureTask, ScheduledExecutor, CompletableFuture, 100 threads, class-init race, cycle, failure, a deadlock the JVM has) agree with the JDK;
the JS tier differs on the two stack-overflow cases (its handler throws an InternalError). Direct checks: async, generator and nested promising natives, 1,000 stacks suspended in a native (5 ms), a plain native answering
a Promise, a native waiting under a JS frame (SuspendError, counted), overflow on both kinds of stack. G1 node, steady ms base -> branch (JS tier): monitors 0.096 -> 0.162 (0.24), sha256 3.8 -> 0.9 (0.44), kernels
(intLoop, longLoop, doubleLoop, sieve, matrix, arraySum, fieldLoop) unchanged within noise, virtualMono 0.033 -> 0.074, allocLoop 0.012 -> 0.026, mapInt 0.087 -> 0.11, listAddGet 0.032 -> 0.045, random 0.069 -> 0.09
(loops with a call pay the fuel check; the i64 header costs allocation-heavy rows part of it). Load average 4 to 5, so +-10%.
**Open.** A native that calls Java through a plain call and expects it to block gets SuspendError (entry.ts must call through strands); the depth limit is conservative and Chrome's JSPI stack size is unmeasured;
`Thread.getState` of a thread blocked in `initWait`/`monitor enter` reports BLOCKED, `synchronized` on a `Class` or String works but `Thread.holdsLock(null)` is not checked; `Thread.priority`, `stop` and daemon exit
are not modelled; the AOT build key changes (header layout, imports).
### 4.13 Track A3: app compile off the main thread, and persisted app code (2026-10-04, `knlnks/wasm-ta3`)

**What the worker can and cannot share.** Compiled code names classes, selectors, table slots, gaps and link messages by number, and the numbers are whatever the World handed out in the order the program asked, so a unit
made by another World is the page's only if that World numbered the same things in the same order. Two mechanisms, one idea (`World.numbering/since/adopt/rollback`, `aot.ts` `Marks`/`Numbering`; the platform build's `tail`
log is now kept by every World):
- *Second-tier units.* The worker holds a compile-only World (`WorldOptions.compileOnly`: classes are numbered and linked by name, nothing is instantiated) over a copy of the app's dex files and the platform's, attached to the
  same platform index. The page sends the numbering it has done since the worker last heard (`sync`) with each job (`World.upgradeJob`: the group `group()` chose, the guarded-call plan, the classes initialized since); the
  worker numbers whatever its unit needs beyond that and returns it with the unit (`link/unit.ts`). `World.adoptUnit` takes the unit if no dex file was added since the job (`epoch`), its natives are bound and the page has
  numbered nothing since it sent the job (a unit that needed no new number is taken whatever the page did meanwhile); the numbering is then replayed in the page and the worker keeps its own, else the worker rolls its
  numbering back to the page's before the next job. A hot method keeps running its first-tier code until the unit arrives and does not ask again meanwhile (`pending`); a refused unit lets it ask again after another budget. The
  unit's `WebAssembly.Module` is compiled and validated in the worker and posted whole. A loader of its own, `addClass`, or repeated worker failures retire the worker and the page compiles inline as before.
- *App builds.* `link/apps.ts` compiles the methods an app is likely to run (the baseline profile's, the launch classes', the manifest's components', then `callClosure`, the selection `compileworker.ts` uses) into code modules
  `a<k>.wasm` of at most about 1 MiB (estimated) and records the numbering they rely on as an `AppIndex`. It continues the numbering of the World right after the platform build is attached, so it is used only by a World
  that numbered nothing since (`AotRuntime.extend`, called from the World's constructor with `WorldOptions.app`) and whose Program starts with the same dex files (a signature check; later dex files are allowed). Its modules load
  the way the platform's code modules do (`loadC`, one module on the first call of one of its methods), import the class globals they use by class id from whatever module the page made for the class
  (`World.classImports`), and record their class-hierarchy decisions in the same header; a decision about a class added after the build is checked at load against `World.late` without the app's own classes and the method
  is put back to a lazy-link stub if it fails, and later `addDexes` undo them through the ordinary assumption table.

**Persistence** (`host/persist.ts`, `host/appcode.ts`). The files of a build are kept in OPFS (Cache Storage where OPFS is unavailable) under a key of the app's dex files (`DexFile.id`), the platform build key and the build
format; an entry is listed once all its files are written, checked for size on load (a damaged one is removed), limited to 64 MiB, and the least recently used entries go when the total passes 256 MiB. `prepareApp` loads the
saved build and compiles its modules (asynchronously, before the World exists); without one, a worker of its own builds it while the launch goes on and the page keeps it for the next launch (nothing is attached
mid-launch: the numbering would no longer match). `bootWasmTier` is not wired to it: the tier's boot still makes the World from the first dex it is given, and where the app's dex files and the platform Program arrive is Track C3's.

**Tests.** `bun run wasm persist` (node, the protocol over a `MessageChannel`): the numbering handshake (a unit that numbered something is not taken after the page did, the worker follows the page after a refusal, a stale epoch is
refused), second-tier units adopted from the worker with the answers unchanged, the worker retired by a loader of its own, the app build attached with its answers equal, fewer methods compiled on demand, a CHA decision of the
build undone by a dex added later and by a dex present from the start behind the app's, builds that do not match (other dex files, base, format) not used, a missing module compiled on demand, and the store's limits,
eviction, damage and replacement. `aottest` is unchanged. `bun run wasm boot-probe` now also runs the Pst fixture in Chrome with a real Worker and OPFS: the first load has no saved build, a Worker builds and the page
keeps it, a hot loop's second tier comes from the Worker; the iframe, a second load of the same dex, finds the build (13 ms to read and compile it), attaches it, loads its module and compiles 22 methods on demand instead of 35. The probe
no longer runs under `?tier=wasm`: the merge of Tracks A and B left it failing there (the oracle's natives link JS-runtime classes, which the tier refuses) and the page runs the Wasm host libraries directly.

**Numbers** (node 24.19 on an idle M-series laptop; FitNotes, the Application, launcher and manifest components with the call closure, no baseline profile). Building the app: 3,492 methods in 2 modules, 0.68 s in the
worker (0.20 ms per method as one module per group) against 1.18 s for the main thread to compile the same methods as first calls do (0.34 ms per method: compiler 0.88 s, Module 0.17 s, Instance 0.10 s). Loading the saved build:
2 ms to read and compile its modules, 0.36 to 0.40 s from the first call to all of its 3,492 methods installed (60 ms of it Instance; the rest links the classes they use, which the on-demand path pays too and is in its 1.18 s). The main thread
no longer pays the compile on a launch with a saved build (about 3x less), nor on the first launch once the worker finishes. Second tier: the main thread's compile time for the hot methods of four jbench workloads, one call
at a time with the event loop turning in between, was 114 ms (sha256), 44 (jsonParse), 138 (scanTokens), 28 (mapStr) inline and 1, 3, 5, 1 ms adopting the worker's units (110 to 141 ms of worker time, no unit
refused); run times after the first call are the same within spread. A single long synchronous call gets nothing from the worker (its units arrive after the call; the inline path replaces the table entry for the next call
as well, not for the running frames).

**Not done / open.** The `lat` gate (FitNotes, Calculator M, Mihon cold and warm, no gated tap above 150 ms) needs the framework to boot under `?tier=wasm` (Track C3); nothing here is measured at a tap. Class modules (D) of the
app's classes are not persisted: the page makes them on first use (0.2 ms each), as for any class the platform build lacks. The build covers the launch's likely methods only; later runs do not add to it (the JS tier's code cache
does). A build is not attached to a World that has already numbered something, nor to loaders other than the default namespace; a DexClassLoader's dex files and a plugin's code compile on demand. The worker keeps a
second copy of the app's dex bytes and its own platform Program (about 24 MB plus the parse of the dex files it touches). The numbering handshake refuses a unit when the page numbered meanwhile; no unit was refused in the
runs above, but an app that links classes continuously while it is hot would see more refusals (they cost the worker's time only).

### 4.15 B3: JNI, arrays and buffers (2026-10-04, `knlnks/wasm-tb3`)

**Direct buffers in the core's memory.** A Wasm GC array cannot be seen from linear memory, so a `DirectByteBuffer` no longer owns a `byte[]`: `MemoryRef.<init>(int)` is an intrinsic (`link/memory.ts`) that takes a zeroed block of the native core's allocator (`host/guest.ts`, `GuestMemory`) at the address the guest knows, with `buffer == null`, freed by a `FinalizationRegistry` when the MemoryRef is collected. Java code, production natives (`bufferBytes`) and native code (`GetDirectBufferAddress`) read the same bytes with no copy. `libcore.io.Memory` reaches an address of the first 4 GiB (above the core's reserved low pages) through runtime functions over the core's memory (`link/guest.ts`: `gld8..64`, `gst8..64`, `gget_/gput_<i8|i16|i32|i64>` copying an array range to or from it in one loop, byte order applied on the way); other addresses (external mappings, higher planes) stay with the production natives. They are runtime functions (a table slot, 1.5 ns a call, measured) and not inline loads because the memory's type (shared or not) is then declared by a module made at run time, never by precompiled code, and multi-memory is not on the default path (G7). Deviation from ART: `hasArray()`/`array()` of a direct buffer answer false/throw (ART's has the non-movable array).
**The pin leak.** `VMRuntime.addressOf` pinned every byte[] in the `nm` table and a map, for good. Nothing pins any more (`nm` holds only the Method objects of proxy classes). `addressOf` of an array that is not a MemoryRef's is still the production handle, which for a Wasm array is a handle of the scoped copy (see Open). H2 enumeration: `mem.isGuest` is read by `VMRuntime.addressOf` and `gles3-pixels`; `nonMovableBytes` (guest-backed `Int8Array`) only by `newNonMovableArray(byte)`; `addressOf` is called by `MemoryRef` (replaced), `TypedArray.resize` (an int[]) and `PathIterator` (non-guest arrays: handles).
**JNI.** `native/jni.ts` keeps the tables and the marshalling and asks everything about classes, objects, fields, methods and arrays of `JniVm` (`native/jnivm.ts`): `jnijs.ts` is the JS tier's (moved, behaviour unchanged), `host/jni.ts` the Wasm tier's. A reference in a table is the tier's own: on the Wasm tier the Wasm reference. Fields and calls go through `Bridge.call/read/write` (generated Wasm, no facade), array regions through `gget_/gput_` straight to guest memory, so an array native code holds is the array Java mutates (`arrays are the Java arrays` in `jni.test.ts`). A native with guest code is a `javaValues` HostFn: the Wasm import passes every reference opaque (no String conversion, no array copy, no Bridge scope). A native with no implementation when its class is compiled (a JNI library registers its natives when loaded, after the class was compiled) is bound to a stand-in that finds `rt.jniFn` when called (`NativeSource.late`), so `RegisterNatives` after the class ran works. References: locals per Cpu in frames (freed with the native's frame, `DeleteLocalRef`, `PopLocalFrame`), globals in a free-listed table, weak globals as `WeakRef`s (a collected one is null; before they were strong globals), `GetObjectRefType` tells the three. Pinned `Get<Prim>ArrayElements` copies leave the table on Release (mode 0 and `JNI_ABORT`; `JNI_COMMIT` keeps it).
**Evidence.** `bun test src/native/jni.test.ts`: 24 pass on the JS tier; `WEBDROID_TIER=wasm`: 20 pass, 4 skipped (the JS tier's parked-Promise callbacks and a native that makes JNI calls of its own, which waits and so needs a strand to enter from: Track C3). The suite is on both ABIs: call families (virtual, nonvirtual, static, A/V forms), reflection round trip, fields of every type, strings, arrays, exceptions, references including weak collection, monitors, direct buffers, critical/fast ABI, natives taking and answering references, RegisterNatives after the class ran. `bun run wasm diff` gains `directBulk` (both byte orders, views, slices, direct to direct, heap to direct). Typecheck, `bun run test` (1167), `wasm all`, `smoke FitNotes` (0 failures), `fwtest` (identical to the base); `wasm sweep` of Cut the Rope's dex: 430,976 methods, 0 failures (JS tier `smoke` of the XAPK: 64,465 classes, 0 method failures); the `doodlejump` e2e flow (ARM32 JNI) reaches its checkpoints on the JS tier after the refactor.
**G1 (node 24 / Chrome 153, 5 runs x 100 reps, load average 11 to 20: indicative), js/wasm steady** `fbBulk` 0.19 / 0.17 -> 0.44 / 0.53 (0.225 -> 0.095 ms in node, 0.230 -> 0.075 in Chrome; a loop of array loads and 32-bit stores per float is the floor, there is no GC-array to memory bulk op), `fbLoop` 0.66 / 0.69 -> 0.63 / 0.52 (Chrome 0.240 -> 0.280 ms: each element is a 1.5 ns call where the pinned array was inline loads), `dbInts` 2.12 / 1.92 -> 2.13 / 1.75, `bbInts` (a heap buffer, unaffected) 0.59 / 0.58 -> 0.58 / 0.59.
**Handles of Java arrays.** `VMRuntime.addressOf` of an array that is not a direct buffer's (`TypedArray.mData`, `PathIterator`) is a `javaValues` host native answering `handle(array)` of the Java array itself; `deref` (android/handles.ts) gives a native the host form of such a handle (`handleViews`, a copy in a Bridge scope) and every non-raw native with a `long` parameter runs in a scope that stores the copy back on return (`jni.test.ts`, last test). A copy already made by an enclosing call that was passed the same array is the one `deref` returns.
**Open.** (1) A JNI native that waits (a callback that blocks, a nested JNI call that returns a Promise) is reported by the plain import and re-imported as Suspending (`wasmNativeSuspended`); entering it needs strands in `entry.ts` (C3). (3) `cpuFor(curThread)` is the JS tier's thread: a Wasm strand has no Cpu of its own yet. (4) `FindClass` ignores the calling library's loader (one namespace). (5) JNI `MonitorEnter` of a contended lock cannot wait.

### 4.15 C3: the framework on the Wasm tier (2026-10-04, `knlnks/wasm-tc3`)

**Entry.** Host code that enters Java (`vcall`, `scall`, `newObj`, `linkInit`, `callOn`, `after`) runs on a new strand of the thread that owns the turn (`callOn`'s thread, else the thread of the strand whose native is running, else main), with the
strand it entered from as `parent` (`monitor.ts owns`: same thread, so locks held are shared). The module of the call (`World.callFn`) records how it ended in globals and takes a token, so a call that never waited answers its value at once and a
call that did answers a Promise: the JS tier's contract, which the 759 `vcall` sites rely on. `sched.onThread` keeps `curThread` the JThread of the running strand (a resumed strand says so with `Sync.Resume`). `Looper.loop` is the main strand suspended in
`nativePollOnce` (a Suspending host native); `mainDbg.depth` is unchanged.
**Natives that answer a Promise.** Every native without arrays is a plain import; if it answers a Promise, its wrapper hands the Promise to `sched.pending`, sets the `rt.wait` global, and the call site (`Natives.call`) then calls a
Suspending `settle:*` import and takes the settled value in its place. This replaced classifying natives (the survey cannot tell `return transact(...)`): only natives with arrays still need to be known (`MAY_SUSPEND`, `webdroid/` services, the build's
`waiting.json`), because their views are scratch memory; a parked scope keeps its scratch (the call site and `Bridge.end` lower the top only if nothing is above it).
**Boot.** `bootWasmTier` opens the tab's build and platform Program (`openAot`, `platformProgram`) and makes a World over `new Program([], platform)`; the app's dexes join as they arrive and `opts.dexes` serves class loaders. Outside a page (the harnesses)
it keeps the old path.
**Results.** `WEBDROID_TIER=wasm`: Calculator M and FitNotes reach `Activity.onCreate`, `onStart`, `onResume` in a process frame and draw (the EventLog order matches the JS tier); the microG processes start. `lat` FitNotes: gate passes
(max tap 47 ms cold, 42 ms warm), launch to first frame 7.9 s against 1.8 s on the JS tier (G3 fails on launch time; warm is not faster because bootWasmTier is not yet wired to `prepareApp`). Mihon: scenario times out. Calculator M: the gated taps need `uiTree`,
which fails (below). The JS tier's quick gate is 7/7; Wasm: `fitnotes` ran its 39 steps with 11 failures, `doodlejump` wedged in `Application.onCreate`.
**First failing mechanisms (open).** (1) Compose's `uiTree` (Calculator M): a `ViewGroup` made with no attributes reads a layoutAnimation resource id from its TypedArray (`AssetManager.nativeApplyStyle` fills `mData` through `deref` of an `addressOf` handle; a stale or
shifted result). (2) `RuntimeError: illegal cast` in `Double.doubleValue` under an `$invoke` stub (reflection/MethodHandle boxing; FitNotes tab-graph). (3) `Runtime.link` guards left in JS-tier-only code: `rt.classFor` for `Notification$CallStyle`
(`fixNotification`), the toast layout `transient_notification` ("Error inflating class <unknown>"). (4) `RamLogger.Append`: "move-result without invoke at 58" (a compiler gap on app code, Doodle Jump). (5) `AttributionSource should be unparceled during a binder transaction`
for a receiver of a microG process (binder calling identity from a strand). (6) JNI natives that wait (4 `jni.test.ts` tests skip), a Cpu per strand, contended MonitorEnter from JNI, FindClass by the calling loader (B3's list) are not done. (7) The page's
`heapUsed` is tab-wide, so `heapLimit` is 2 GiB there. Mihon's timeout is not diagnosed.
**Fixed on the way** (all generic): suspending natives lost their array results when they completed without waiting (`give` ran only after a wait); `Bridge.invoke` scopes outliving the natives they reached handed a native the copy of an array an earlier one reached;
`put` wrote array results at an unaligned scratch address; a process frame read a page file whose lazy source answers the page realm's Promise (`instanceof Promise` in `fdReadAt`); `Rect` edge names were cached by `constructor`, which every facade shares;
`handles.ts` could not key a Wasm array; `pm.ts` cloned an ApplicationInfo as a JS object; `jcoll.ts` built ArrayLists as JS objects; the JS compile worker ran under `tier=wasm`; `VMRuntime.addressOf` took its receiver as the array.

### 4.15 V1: the conformance suites, fwtest and the descriptor check on the Wasm tier (2026-10-04, `knlnks/wasm-v1`)

**Commands.** `bun run wasm conform <suite|quick> [class-substring] [--test name] [--no-js] [--jobs n]`, `bun run wasm fwtest`, `bun run wasm desccheck`; `all` has `conform-quick` (one class of each of guava, ojluni-time,
luni-util, jsr166 and luni-io, 15 s) and `desccheck`; the full suites and `fwtest` are not in it (the suites take 25 minutes together).
**How.** `scripts/wasm/conform.ts` runs each class of a suite (the lists and the dex of `scripts/conform/prepare.ts`, which `run.ts` shares) in a process of its own on each tier: the Wasm one is `conformone.ts` under
node (a World over the suite's dex and the boot jars, `ConformRunner` entered with `entryAsync`, so JUnit and its threads run on strands), the JS one is `scripts/conform/run.ts --one`. Per suite it reports the
Wasm pass count beside the JS tier's and the baseline's, a **regression** (a baseline pass that does not pass on the Wasm tier and is not failing on the JS tier too), and a **divergence** (a test the two tiers answer
differently). A divergence is *pinned* in `tests/conformance/wasm-pins.json` (class regex, test regex, an optional regex on the reason the Wasm tier did not pass it, and the mechanism) or the run fails it as
*unexplained*; a pin that matches nothing is stale and fails too (flaky ones excepted). Classes get 600 s, then are killed. `fwtest` runs the exercises of `scripts/fwtest/*` (the same files as the JS tier's `bun run fwtest`, made
tier-neutral where they touched the JS object model) over a World with the same cuts; `tests/conformance/wasm-fwtest.json` pins the exercises that fail and why. `desccheck` holds the registered descriptors to the
checked-in baseline and every intrinsic's key (class, name, descriptor) to a method the platform class declares (it found seven `sun.misc.Unsafe` aliases that matched nothing).
**Fixes** (each found as the first failing mechanism of a suite, generic, no suite-specific code):
- `Thread.getContextClassLoader` was null on the main thread (testng's `Logger`, every `getResourceAsStream` through it): ART gives the main thread the system class loader (`sched.ts` `curThread`).
- `Method.invoke` unboxed arguments with the parameter's own wrapper (an `Integer` for a `long` parameter was an illegal cast), checked neither the argument count, the receiver nor a reference argument's type: `argp` widens as the
  language does, and the checks throw ART's `IllegalArgumentException`s (`iarg`, `iarity`, `recv`; `reflect.ts`, `exc.ts`).
- `Constructor.newInstanceFromSerialization` was a gap, so nothing deserialized through `ObjectInputStream`: allocate without a constructor, run the first non-serializable superclass's (`reflect.ts`).
- `sun.misc.Unsafe`'s accessors reached the production spec with a Wasm object (a `TypeError`): the intrinsics of `jdk.internal.misc.Unsafe` now also name `sun/misc/Unsafe`'s `Object` and `compareAndSwap` forms (`unsafe.ts`).
- A Suspending native that answered a value (not a Promise) never wrote its array arguments back: `MessageDigest` answered zeros, so every default `serialVersionUID` was 0 (`natives.ts`).
- An array passed to a native twice (`Matrix.mapPoints(src, dst)` with one array) was copied twice and the stale copy written back last: the second parameter shares the first's region (`natives.ts`).
- A throw out of a Suspending native left the strand's globals as the strand that ran meanwhile set them (`sid` the host's), so the next natives took the plain path and failed with "native suspended" and
  "blocking operation on a stack that cannot suspend": the call restores them in a `try_table` handler (`natives.ts`, `code.ts`).
- A Promise a plain import abandoned could reject later and end the process: it is caught (`natives.ts`). A JS error escaping a native is the throwable the JS tier makes of it (`rt.jx`: NullPointerException for a `TypeError`
  on null, OutOfMemoryError for a typed array too long), not a crash of the strand (`nativesource.ts`).
- `new String(StringBuffer)` and `(StringBuilder)` went to the JS tier's string builder (`.s` of a Wasm object); they call the final classes' `toString` (`strings.ts`). `System.setIn/setOut/setErr` stored into the JS tier's statics
  (`intrinsics.ts`). `ObjectStreamClass.hasStaticInitializer` asked the JS class model (`classes.ts`). `Unsafe.allocateInstance(String.class)` built a struct with four of the five fields (`j2w.ts`).
- The heap limit: `heapUsed` counts garbage the engine has not swept and handles only a finalizer frees, so a test that allocates a lot hit the 512 MB limit while its live data was small. A full heap now collects (where the host can: `collect`,
  node's `--expose-gc`), then gives the event loop two turns of the *timer* queue (a message-channel turn runs the engine's finalizers after the strand resumes, not before) before it is an `OutOfMemoryError` (`j2w.ts` `allocSlow`, `sched.ts`
  `Block.Yield` with a timer). The conformance children raise the limit to 3 GB: the runner's own 60 MB output is 120 MB of `char[]` here (Latin-1 on ART).
- `Thread.getState` of a thread that `join` had just woken answered RUNNABLE: the `alive` flag was cleared one microtask after the peer (`sched.ts`; JSR-166's `PhaserTest` and `RecursiveActionTest`).
- `android_getaddrinfo` of a name the relay must look up was a gap: the strand waits for the answer (`Block.Net`, `host/inet.ts` `wait`) and asks again (`link/inet.ts`).
- `jnet.ts` `headerMap` made its `HashMap` with `rt.make`, an object of the JS tier: it asks the entry (`newObj`), as for the JS tier it only skipped a constructor (cookies: 14 tests on both tiers).
- `graphics.ts` cached a Rect's field names by `r.constructor`, which every facade shares (`Object`): by class name.
- The list of natives that answer a Promise for some arguments (`suspend.ts` `MAY_SUSPEND`, the survey's flag C) grew by the 19 the suites reached (Linux `readBytes`, `preadBytes`, `poll`, `connect`, `recvfromBytes`, `getpwuid`, `FileDescriptor.sync`,
  `FileChannelImpl.map0`, `Memory.peekIntNative`, `AndroidCharacter.*`, `BitmapFactory.nativeDecodeByteArray`, ...): a plain import that answers a Promise on a strand still fails that call once and is Suspending in modules built
  after, so the list is what makes the first call work. The suites print the natives found (`CONFORM_DEBUG=1`).
- Harness: node's `process.exit` after a `stdout.write` cut a class's output at the pipe's 512 KiB (the first Wasm counts of the big classes were short by that), `nodeshim.mjs` gives `fetch` of `file:` URLs and `Bun.file().text/bytes`.
**Results** (`bun run wasm conform <suite>`, node 24, tests that ran on the Wasm tier; the JS tier's pass count is its run today, the baseline is `tests/conformance/<suite>.json`; a pinned divergence is a test the tiers answer
differently with its mechanism recorded; 0 regressions and 0 unexplained in every suite; the full set takes about 25 minutes with four classes at a time on each tier):

| suite | tests | Wasm pass | JS pass | baseline | pinned divergences |
|---|---|---|---|---|---|
| `guava` | 368,794 | 368,772 | 366,001 | 365,994 | 2,771 |
| `ojluni-time` | 24,479 | 24,473 | 30,598 | 30,603 | 6,125 |
| `jsr166` | 3,211 | 3,209 | 3,136 | 3,135 | 73 |
| `luni-util` | 2,586 | 2,347 | 2,325 | 2,320 | 22 |
| `luni-io` | 1,373 | 1,247 | 1,418 | 1,417 | 185 |
| `luni-nio` | 2,747 | 2,650 | 2,712 | 2,712 | 62 |
| `luni-nio-file` | 195 | 182 | 173 | 173 | 9 |
| `luni-net` | 892 | 813 | 812 | 798 | 1 |
| `luni-security` | 721 | 715 | 715 | 715 | 0 |
| total | 404,792 | 404,403 | 407,891 | 407,867 | 9,248 |

JSR-166 runs on strands (C1 and C2) and passes 3,209 of 3,211 (the two it fails fail on the JS tier too), 73 more than the JS tier's cooperative threads. The ojluni-time pass count is lower than the JS tier's for the two reasons below
(about 6,100 data-provider rows skipped, about 950 behind the nested-entry limit); the other suites' counts agree to within the pinned tests.
**Pinned divergences by mechanism** (the pin file has the details and the evidence of each):
- *The JS tier is wrong, the Wasm tier answers as AOSP's bytecode does* (about 3,000 tests): `toArray(T[])` without `ArrayStoreException` (ArrayDeque, LinkedList, the queues, the guava collections: 2,753 in guava alone); `replaceAll` on a
  `ConcurrentSkipListMap` submap (400); `CompletableFuture`'s asynchronous stages (`NoSuchMethodError` for `Thread.nextThreadNum`, 39); a Throwable's message or cause lost across serialization, and its golden stream (`nio.file` exceptions, `IOError`, `ZipError`,
  `InputMismatchException`, ...); a `String` made with `new String(s)` that is `s` (IdentityHashMap, TreeMap, `writeUnshared`) and `Integer` against `String` without `ClassCastException`; `Class.getMethod` finding a private `suite()`
  (124 tests of `OutputStreamTesterTest` and `WriterTesterTest` that JUnit does not run on AOSP); `values()` of an enum, a null thread name, a deserialized interface proxy, one NullPointerException of the JS tier's compiled code.
- *The Wasm tier runs AOSP's bytecode and the test cannot*: TestNG reads a data provider's `Iterator<Object[]>` type argument, which libcore leaves a `GenericArrayTypeImpl` (as on a device), so 6,100 rows of `TCKLocalTime`,
  `TCKLocalDateTime` and `TCKDateTimeFormatters` are skipped.
- *Owned by another package*: a TS native calls Java through a plain entry and the Java waits (ICU: `CaseMapperNative`, `String.toLowerCase`'s locale, `HttpURLConnection`; `SuspendError`, about 1,000 tests of `ojluni-time`, `CalendarTest`,
  `CurrencyTest`, `LocaleTest`, `StreamTokenizerTest`, `CertificateFactory3Test`): entries on strands, C3. Natives that read a direct buffer through the pinned array's address (`unmapped address 0x4000...`, 60 tests of `luni-nio`, `luni-nio-file`,
  CRC32 and Adler32): B3. A flaky pair (`TestClock_System`) fails on either tier in some runs.
When C3 or B3 lands these pins go stale and the run says so; delete them then.
**fwtest.** All 31 exercises pass over a World after merging B2, B3 and C3 (the pins for pinned-array addresses, host classes and nested entries were deleted); `tests/conformance/wasm-fwtest.json` is empty. Remaining pins in `wasm-pins.json`: the JS tier's own faults, TestNG data providers (libcore's `GenericArrayTypeImpl` is never resolved to a Class, which ART's bytecode does too, so about 6,100 rows are skipped on the Wasm tier), the flaky `TestClock_System`, and `FileTest`/`CharsetTest`, where repeated entries accumulate JSPI stacks until a `StackOverflowError` (upstream repro: `File.list()` about 1,000 times inside one entry, also on eeb222b3).
main looper running (C3), and four implement a Java interface with a host object or construct a host class with an argument (`ImageDecoder`, `SpannableStringBuilder`, `InputProbe`, the `DexFile` spec: B2). Declared natives with a host binding: 646 of 791, the
JS tier's own count. The exercises need host code that waits (a font file, a decode), so the harness enters Java on strands (`scripts/wasm/strandentry.ts`, outside natives only; Track C3's entry replaces it).
**Open.** The pinned divergences above; `desccheck` and `conform-quick` are in `all`, the full suites (25 minutes) and `fwtest` are not.

### 4.16 W3: generated-code speed after the locks, fuel and depth of C (2026-10-04, `knlnks/wasm-w3`)

Load average was 4 to 20 on 14 cores while this was measured (other agents), so single rows move by 5 to 15% between runs; every A/B below alternated the two builds
(`/tmp`-side scripts over two worktrees) and took medians of 3 to 5. Node 24.19 and Chrome 153.

**Where the C regressions came from** (node steady ms, `NOFUEL`/`NODEPTH` switches in the emitter): `virtualMono` 0.078 with both checks, 0.035 without fuel, 0.075 without depth; `allocLoop` 0.029 / 0.020 / 0.019, both off 0.013 (pre-C 0.012);
`listAddGet` 0.047 / 0.044 / 0.038, both off 0.033; `mapInt` 0.116 / 0.111 / 0.094, both off 0.088; `random` 0.095 / 0.090 / 0.077, both off 0.067. So fuel and depth are all of the
tight-loop loss; **the i64 header is not**: with fuel and depth off, `allocLoop` is within 0.001 ms of pre-C, so allocation does not pay for the 64-bit word (the two layouts, `[vt, i64]` and `[vt, i32, i32]`, are the same 8 bytes) and the layout was left alone.
Only `monitors` has a real cost left (0.096 -> 0.135 with both off), the lock itself.

**What changed**
- *Fuel only where a loop can wait* (`compiler/loops.ts`). A loop whose exit test compares an int that every iteration steps by a constant toward the bound, tested in the head's block (or by the only back edge), ends by itself in at most 2^32 iterations and gets no check;
  a counter that moves only when something else decides (`while (i < 3) { if (flag) i++; }`) or a test reached only then (`Th.spinStep`, `Th.spinTest`) keeps it, and both hang without it. `virtualMono` 0.078 -> 0.036 (node), `allocLoop` 0.029 -> 0.019, `linkedNodes` 0.130 -> 0.068, `fieldLoop` 0.093 -> 0.076.
  Chrome 153 is the other way for the smallest kernels: `virtualMono` 0.085 -> 0.120..0.135, `fieldLoop` 0.060 -> 0.075, `syncBlock` 0.125 -> 0.230 are faster *with* the check in the loop (the same loop with the check kept gives the old numbers), and `--no-wasm-loop-unrolling` takes `fieldLoop` to 0.050; no flag moves `virtualMono`. The loops that gained in Chrome:
  `linkedNodes` 0.145 -> 0.075, `hashSet` 0.130 -> 0.095, `listAddGet` 0.045 -> 0.035, `virtualBi` 0.170 -> 0.135. Kept: net positive in both engines.
- *The dispatch loop of methods with handlers* falls into region 0 and tests the region only on a re-dispatch, where the fuel check now is (it ran on every call before). Neutral on time, smaller code.
- *Depth by weight, not by default* (`method.ts planDepth`). A method that calls only methods of its unit that count nothing, and weighs at most `MAX_UNCOUNTED` (512) with them, counts nothing; one with one or two other calls counts around those calls, not in a prologue; the dispatch behind a guarded virtual call and the constructor of an exception thrown right after are cold and counted around themselves
  without making the caller count; a call in a loop, a method with handlers and more than two such calls keep the prologue. A leaf is a function that runs no Java (`Compiler.runsJava`: no table call, no import that can enter Java, no method of the unit; `rt()` functions marked `pure`, the `libcore.io.Memory` natives). The soundness argument: the engine's stack holds the limit twice over, and the uncounted frames
  on top of counted ones weigh at most 512; a recursion cannot pass only through uncounted frames except by throwing, so **the throwers now add 512 to the depth** (an exception whose construction throws would otherwise recurse without a counted frame: the first version of this overflowed the engine at boot through a missing native, which is how it was found).
  Steady ms (node, before -> after): `mapInt` 0.113 -> 0.099, `listAddGet` 0.045 -> 0.039, `random` 0.092 -> 0.085, `allocLoop` 0.028 -> 0.020, `dbInts` 0.167 -> 0.115, `bbInts` 0.325 -> 0.229 in the good mode (below), `strBuild` 0.150 -> 0.137.
- *Thin locks* are 4 bytes of identity hash in the high half and the lock in the low half of the header word (`lock ^ id << 8` is the count when the strand holds it: one unsigned compare), and `monitor-enter`/`-exit` do the free-object lock and the release of a lock held once inline, calling `menter`/`mexit` for the rest. `syncCall` 0.394 -> 0.246 against the first version of the depth work; `monitors` 0.163 -> 0.151.
- *Harness*: `/tmp/g1` is per checkout now (`G1_DIR`), `watdump` runs under node on a booted process, new workloads `syncCall`, `syncBlock`, `plainCall`, `tryCall`, `idHash`.

**The tables** (all 74 workloads that match; the geometric means are over everything):

**node v24.19.0 (V8 13.6), no platform build (compiled on demand)**, 3 runs x 100 reps, medians in ms; before = `eeb222b3`, after = this branch (before the loop-site fix of the last commit: `sort`, `bbInts`, `dbInts` in Chrome moved by it, see the text). First call: Wasm first call, before / after.

| workload | JS steady | before | after | js/wasm before | js/wasm after | first before | first after |
|---|---|---|---|---|---|---|---|
| sha256 | 0.447 | 0.908 | 0.899 | 0.49x | 0.50x | 445.8 | 456.4 |
| ecdsaVerify | 0.351 | 0.350 | 0.350 | 1.00x | 1.00x | 468.5 | 479.1 |
| certParse | 0.154 | 0.131 | 0.129 | 1.18x | 1.19x | 838.6 | 897.0 |
| listAddGet | 0.079 | 0.045 | 0.039 | 1.74x | 2.04x | 39.2 | 35.2 |
| listIter | 0.110 | 0.082 | 0.079 | 1.34x | 1.40x | 47.7 | 41.5 |
| listRemove | 1.927 | 0.667 | 0.655 | 2.89x | 2.94x | 34.6 | 20.9 |
| mapStr | 0.223 | 0.106 | 0.107 | 2.10x | 2.09x | 30.6 | 7.2 |
| mapInt | 0.163 | 0.113 | 0.099 | 1.45x | 1.64x | 34.0 | 7.4 |
| mapWalk | 0.298 | 0.154 | 0.163 | 1.94x | 1.83x | 36.3 | 40.3 |
| linkedMap | 0.218 | 0.108 | 0.102 | 2.01x | 2.13x | 45.3 | 17.1 |
| hashSet | 0.205 | 0.093 | 0.095 | 2.20x | 2.15x | 37.6 | 10.7 |
| smallAlloc | 0.109 | 0.041 | 0.043 | 2.65x | 2.55x | 7.2 | 7.5 |
| deque | 0.116 | 0.061 | 0.049 | 1.89x | 2.36x | 46.4 | 43.1 |
| treeMap | 0.404 | 0.216 | 0.207 | 1.87x | 1.96x | 37.5 | 39.1 |
| sort | 0.299 | 0.244 | 0.278 | 1.22x | 1.08x | 44.0 | 59.3 |
| mix | 1.315 | 0.679 | 0.621 | 1.94x | 2.12x | 64.0 | 42.1 |
| linkedList | 0.081 | 0.045 | 0.037 | 1.78x | 2.22x | 33.5 | 18.4 |
| b64java | 0.861 | 0.696 | 0.684 | 1.24x | 1.26x | 49.5 | 33.6 |
| b64android | 0.649 | 0.571 | 0.568 | 1.14x | 1.14x | 37.5 | 59.0 |
| jsonParse | 3.425 | 2.185 | 2.097 | 1.57x | 1.63x | 107.5 | 136.9 |
| jsonWrite | 7.762 | 5.030 | 4.906 | 1.54x | 1.58x | 144.7 | 185.2 |
| scanTokens | 9.487 | 15.215 | 14.814 | 0.62x | 0.64x | 1003.7 | 1067.9 |
| scanLines | 3.855 | 6.019 | 6.036 | 0.64x | 0.64x | 996.2 | 1042.3 |
| format | 2.319 | 1.373 | 1.342 | 1.69x | 1.73x | 94.8 | 140.0 |
| dtoa | 1.296 | 0.449 | 0.445 | 2.89x | 2.91x | 49.7 | 88.6 |
| parseFail | 8.125 | 2.409 | 2.433 | 3.37x | 3.34x | 15.7 | 20.6 |
| parseFailMixed | 6.977 | 2.296 | 2.230 | 3.04x | 3.13x | 42.4 | 22.4 |
| fbLoop | 0.133 | 0.218 | 0.202 | 0.61x | 0.66x | 66.2 | 27.5 |
| fbBulk | 0.040 | 0.074 | 0.070 | 0.54x | 0.57x | 38.5 | 18.6 |
| bbInts | 0.187 | 0.321 | 0.376 | 0.58x | 0.50x | 65.2 | 62.2 |
| dbInts | 0.357 | 0.167 | 0.115 | 2.13x | 3.11x | 63.0 | 40.3 |
| casts | 2.370 | 0.336 | 0.325 | 7.05x | 7.30x | 50.8 | 19.8 |
| monitors | 0.220 | 0.163 | 0.151 | 1.35x | 1.46x | 39.4 | 29.6 |
| random | 0.594 | 0.092 | 0.085 | 6.45x | 6.98x | 55.0 | 19.0 |
| strConcat | 0.027 | 0.067 | 0.064 | 0.40x | 0.42x | 21.3 | 15.3 |
| zipOpen | 0.489 | 0.448 | 0.584 | 1.09x | 0.84x | 504.3 | 490.9 |
| inetCached | 12.252 | 2.749 | 2.912 | 4.46x | 4.21x | 32.1 | 79.5 |
| ssbAppend | 0.333 | 0.190 | 0.188 | 1.75x | 1.77x | 40.6 | 59.9 |
| ssbEdit | 0.333 | 0.110 | 0.108 | 3.04x | 3.07x | 60.0 | 58.1 |
| ssbGetSpans | 0.904 | 0.709 | 0.702 | 1.28x | 1.29x | 53.7 | 41.6 |
| spannedCopy | 0.250 | 0.139 | 0.140 | 1.79x | 1.79x | 19.4 | 26.5 |
| linkify | 0.033 | 0.025 | 0.024 | 1.31x | 1.38x | 78.1 | 76.8 |
| loopOnce | 43.959 | 8.224 | 7.798 | 5.35x | 5.64x | 42.3 | 40.5 |
| loopChunk | 8.237 | 8.247 | 7.787 | 1.00x | 1.06x | 14.8 | 34.9 |
| divLoop | 4.680 | 0.428 | 0.413 | 10.93x | 11.34x | 16.0 | 11.5 |
| longDiv | 0.362 | 0.217 | 0.213 | 1.67x | 1.70x | 15.7 | 14.7 |
| switchDense | 0.071 | 0.076 | 0.076 | 0.93x | 0.93x | 17.8 | 7.8 |
| switchSparse | 0.071 | 0.075 | 0.072 | 0.94x | 0.98x | 17.1 | 19.7 |
| refArray | 0.198 | 0.177 | 0.165 | 1.12x | 1.20x | 50.2 | 14.6 |
| matrix | 0.204 | 0.070 | 0.070 | 2.94x | 2.92x | 18.4 | 28.3 |
| sieve | 0.268 | 0.207 | 0.205 | 1.30x | 1.31x | 5.9 | 11.4 |
| intLoop | 1.102 | 0.218 | 0.216 | 5.06x | 5.10x | 14.3 | 25.3 |
| longLoop | 0.442 | 0.153 | 0.155 | 2.89x | 2.86x | 17.6 | 5.4 |
| doubleLoop | 0.723 | 0.088 | 0.083 | 8.25x | 8.75x | 48.8 | 7.0 |
| arraySum | 0.123 | 0.063 | 0.063 | 1.94x | 1.96x | 4.8 | 5.4 |
| fieldLoop | 0.141 | 0.093 | 0.076 | 1.51x | 1.86x | 31.3 | 6.9 |
| allocLoop | 0.171 | 0.028 | 0.020 | 6.16x | 8.73x | 40.6 | 36.2 |
| syncCall | 0.230 | 0.110 | 0.241 | 2.08x | 0.95x | 26.5 | 9.7 |
| plainCall | 0.081 | 0.054 | 0.050 | 1.50x | 1.61x | 49.0 | 13.4 |
| tryCall | 0.129 | 0.089 | 0.094 | 1.45x | 1.38x | 25.2 | 26.0 |
| syncBlock | 0.250 | 0.115 | 0.179 | 2.18x | 1.40x | 45.2 | 14.5 |
| idHash | 0.721 | 0.540 | 0.547 | 1.33x | 1.32x | 43.2 | 27.3 |
| virtualMono | 0.144 | 0.075 | 0.038 | 1.92x | 3.83x | 49.1 | 24.2 |
| virtualBi | 0.559 | 0.157 | 0.129 | 3.56x | 4.32x | 33.0 | 14.9 |
| interfaceBi | 0.560 | 0.259 | 0.244 | 2.16x | 2.29x | 33.0 | 12.9 |
| linkedNodes | 0.282 | 0.130 | 0.068 | 2.17x | 4.17x | 26.0 | 37.3 |
| strChars | 0.256 | 0.248 | 0.263 | 1.03x | 0.97x | 25.7 | 19.7 |
| strEquals | 0.099 | 0.061 | 0.067 | 1.62x | 1.47x | 11.5 | 19.1 |
| strIndex | 0.243 | 0.231 | 0.236 | 1.05x | 1.03x | 35.7 | 28.2 |
| strBuild | 0.103 | 0.143 | 0.135 | 0.72x | 0.76x | 32.7 | 7.5 |
| strSubstr | 0.256 | 0.526 | 0.560 | 0.49x | 0.46x | 33.9 | 34.5 |
| strCompare | 0.034 | 0.023 | 0.022 | 1.44x | 1.52x | 11.2 | 5.2 |
| parseInts | 0.059 | 0.053 | 0.054 | 1.10x | 1.10x | 43.2 | 20.4 |
| exceptions | 3.421 | 1.147 | 1.224 | 2.98x | 2.80x | 42.6 | 29.4 |

Geometric mean js/wasm over 74 workloads: steady 1.71x -> 1.77x, first call 0.48x -> 0.65x.

**Chrome 153.0.8010.53, over a platform build of the 7 libcore jars (`aot-build --only`)**, 3 runs x 100 reps, medians in ms; before = `eeb222b3`, after = this branch (before the loop-site fix of the last commit: `sort`, `bbInts`, `dbInts` in Chrome moved by it, see the text). First call: Wasm first call, before / after.

| workload | JS steady | before | after | js/wasm before | js/wasm after | first before | first after |
|---|---|---|---|---|---|---|---|
| sha256 | 0.495 | 0.905 | 0.900 | 0.55x | 0.55x | 298.3 | 308.9 |
| ecdsaVerify | 0.295 | 0.295 | 0.295 | 1.00x | 1.00x | 306.0 | 320.1 |
| certParse | 0.140 | 0.120 | 0.120 | 1.17x | 1.17x | 461.1 | 489.2 |
| listAddGet | 0.085 | 0.045 | 0.035 | 1.89x | 2.43x | 15.5 | 11.7 |
| listIter | 0.105 | 0.105 | 0.090 | 1.00x | 1.17x | 16.7 | 16.9 |
| listRemove | 1.550 | 0.650 | 0.630 | 2.38x | 2.46x | 16.1 | 13.0 |
| mapStr | 0.535 | 0.115 | 0.105 | 4.65x | 5.10x | 13.4 | 7.8 |
| mapInt | 0.145 | 0.115 | 0.105 | 1.26x | 1.38x | 14.6 | 11.0 |
| mapWalk | 0.375 | 0.195 | 0.185 | 1.92x | 2.03x | 16.9 | 15.3 |
| linkedMap | 0.435 | 0.145 | 0.110 | 3.00x | 3.95x | 17.5 | 8.6 |
| hashSet | 0.535 | 0.130 | 0.095 | 4.12x | 5.63x | 11.2 | 6.8 |
| smallAlloc | 0.100 | 0.060 | 0.070 | 1.67x | 1.43x | 9.8 | 7.0 |
| deque | 0.115 | 0.055 | 0.065 | 2.09x | 1.77x | 14.7 | 14.8 |
| treeMap | 0.370 | 0.200 | 0.215 | 1.85x | 1.72x | 14.0 | 13.4 |
| sort | 0.360 | 0.275 | 0.310 | 1.31x | 1.16x | 17.1 | 16.7 |
| mix | 2.225 | 0.650 | 0.610 | 3.42x | 3.65x | 20.0 | 19.7 |
| linkedList | 0.085 | 0.050 | 0.050 | 1.70x | 1.70x | 15.0 | 7.7 |
| b64java | 0.935 | 0.555 | 0.545 | 1.68x | 1.72x | 13.6 | 17.0 |
| b64android | 0.765 | 0.520 | 0.520 | 1.47x | 1.47x | 23.3 | 20.6 |
| jsonParse | 3.470 | 2.205 | 2.070 | 1.57x | 1.68x | 78.1 | 92.2 |
| jsonWrite | 7.775 | 5.860 | 5.635 | 1.33x | 1.38x | 100.9 | 125.0 |
| scanTokens | 14.325 | 13.500 | 12.675 | 1.06x | 1.13x | 541.4 | 513.9 |
| scanLines | 5.325 | 6.390 | 6.030 | 0.83x | 0.88x | 489.1 | 496.9 |
| format | 2.630 | 1.515 | 1.445 | 1.74x | 1.82x | 76.0 | 99.6 |
| dtoa | 3.300 | 0.485 | 0.460 | 6.80x | 7.17x | 35.1 | 52.0 |
| parseFail | 12.445 | 2.570 | 2.605 | 4.84x | 4.78x | 18.6 | 19.2 |
| parseFailMixed | 10.510 | 2.420 | 2.410 | 4.34x | 4.36x | 22.0 | 22.2 |
| fbLoop | 0.155 | 0.270 | 0.245 | 0.57x | 0.63x | 20.3 | 21.6 |
| fbBulk | 0.040 | 0.070 | 0.070 | 0.57x | 0.57x | 15.5 | 15.9 |
| bbInts | 0.220 | 0.380 | 0.225 | 0.58x | 0.98x | 22.1 | 19.9 |
| dbInts | 0.360 | 0.200 | 0.120 | 1.80x | 3.00x | 20.9 | 21.0 |
| casts | 2.035 | 0.430 | 0.420 | 4.73x | 4.85x | 16.9 | 15.2 |
| monitors | 0.200 | 0.170 | 0.170 | 1.18x | 1.18x | 15.0 | 14.4 |
| random | 0.590 | 0.155 | 0.170 | 3.81x | 3.47x | 9.8 | 10.6 |
| strConcat | 0.035 | 0.070 | 0.065 | 0.50x | 0.54x | 7.4 | 11.6 |
| zipOpen | 0.655 | 0.405 | 0.410 | 1.62x | 1.60x | 393.2 | 401.3 |
| inetCached | 10.345 | 3.185 | 3.305 | 3.25x | 3.13x | 39.7 | 56.4 |
| ssbAppend | 0.290 | 0.200 | 0.195 | 1.45x | 1.49x | 45.8 | 46.6 |
| ssbEdit | 0.265 | 0.130 | 0.115 | 2.04x | 2.30x | 43.1 | 41.3 |
| ssbGetSpans | 0.830 | 0.710 | 0.720 | 1.17x | 1.15x | 45.7 | 45.5 |
| spannedCopy | 0.205 | 0.120 | 0.135 | 1.71x | 1.52x | 24.6 | 23.6 |
| linkify | 0.035 | 0.025 | 0.025 | 1.40x | 1.40x | 43.1 | 40.2 |
| loopOnce | 42.810 | 8.325 | 8.070 | 5.14x | 5.30x | 26.2 | 27.1 |
| loopChunk | 42.725 | 8.055 | 7.995 | 5.30x | 5.34x | 14.1 | 14.3 |
| divLoop | 1.190 | 0.425 | 0.430 | 2.80x | 2.77x | 5.6 | 8.0 |
| longDiv | 0.290 | 0.215 | 0.215 | 1.35x | 1.35x | 6.5 | 5.8 |
| switchDense | 0.080 | 0.075 | 0.080 | 1.07x | 1.00x | 9.3 | 9.1 |
| switchSparse | 0.075 | 0.070 | 0.070 | 1.07x | 1.07x | 5.2 | 10.1 |
| refArray | 0.205 | 0.175 | 0.165 | 1.17x | 1.24x | 8.5 | 6.5 |
| matrix | 0.220 | 0.075 | 0.075 | 2.93x | 2.93x | 6.8 | 6.8 |
| sieve | 0.230 | 0.145 | 0.145 | 1.59x | 1.59x | 6.7 | 6.8 |
| intLoop | 1.115 | 0.215 | 0.215 | 5.19x | 5.19x | 5.2 | 5.5 |
| longLoop | 0.500 | 0.155 | 0.155 | 3.23x | 3.23x | 5.3 | 5.6 |
| doubleLoop | 0.615 | 0.095 | 0.080 | 6.47x | 7.69x | 10.0 | 10.3 |
| arraySum | 0.075 | 0.065 | 0.060 | 1.15x | 1.25x | 5.6 | 5.5 |
| fieldLoop | 0.795 | 0.060 | 0.075 | 13.25x | 10.60x | 6.8 | 10.1 |
| allocLoop | 0.135 | 0.040 | 0.040 | 3.37x | 3.38x | 7.0 | 7.0 |
| syncCall | 0.450 | 0.165 | 0.280 | 2.73x | 1.61x | 9.3 | 9.9 |
| plainCall | 0.085 | 0.060 | 0.050 | 1.42x | 1.70x | 10.8 | 6.9 |
| tryCall | 0.180 | 0.085 | 0.145 | 2.12x | 1.24x | 10.8 | 9.9 |
| syncBlock | 0.245 | 0.125 | 0.230 | 1.96x | 1.07x | 7.1 | 6.4 |
| idHash | 0.765 | 0.625 | 0.565 | 1.22x | 1.35x | 11.4 | 11.4 |
| virtualMono | 0.155 | 0.085 | 0.120 | 1.82x | 1.29x | 7.6 | 10.2 |
| virtualBi | 0.510 | 0.170 | 0.130 | 3.00x | 3.92x | 13.1 | 8.1 |
| interfaceBi | 0.510 | 0.260 | 0.270 | 1.96x | 1.89x | 9.5 | 7.7 |
| linkedNodes | 0.240 | 0.145 | 0.075 | 1.66x | 3.20x | 9.3 | 12.0 |
| strChars | 0.475 | 0.245 | 0.285 | 1.94x | 1.67x | 7.9 | 6.9 |
| strEquals | 0.300 | 0.060 | 0.065 | 5.00x | 4.62x | 6.0 | 6.3 |
| strIndex | 0.170 | 0.230 | 0.210 | 0.74x | 0.81x | 8.3 | 12.0 |
| strBuild | 0.110 | 0.160 | 0.150 | 0.69x | 0.73x | 8.5 | 11.5 |
| strSubstr | 0.310 | 0.540 | 0.565 | 0.57x | 0.55x | 12.2 | 13.5 |
| strCompare | 0.030 | 0.025 | 0.020 | 1.20x | 1.50x | 5.5 | 9.0 |
| parseInts | 0.055 | 0.055 | 0.055 | 1.00x | 1.00x | 6.6 | 9.7 |
| exceptions | 2.740 | 1.275 | 1.275 | 2.15x | 2.15x | 12.1 | 12.6 |

Geometric mean js/wasm over 74 workloads: steady 1.83x -> 1.87x, first call 0.31x -> 0.31x.

**Open and rejected**
- **V8's inlining budget is five times the root function's size, so a smaller root inlines less.** `syncCall` (a loop calling a synchronized method) was 0.110 in the base and is 0.241 here in the table, although the code is smaller: the base root carried a depth prologue and a fuel check and so could afford to inline `menter`, `mexit` and the callee; the loop of `w_syncCall` now is 63 nodes, a budget of 315, and the callee (196) leaves nothing for the helpers (`--trace-wasm-inlining`: "not enough inlining budget"). Making the lock inline moved it from 0.394 to 0.246; the rest needs a smaller body for methods with handlers (their pc stores and region dispatch are most of the 196). `syncBlock` 0.115 -> 0.179, `tryCall` and, in Chrome, `virtualMono` are the same effect or its cousin; `sort` 0.244 -> 0.278 (node) and 0.275 -> 0.305 (Chrome) moved with the depth change and without a cause found.
- `bbInts` is bimodal in node (0.23 or 0.40 ms from run to run, the same build): the budget is spent on four copies of `_put` and the shape V8 settles on depends on the call counts at the moment it tiers up. Chrome measured 0.225 in the table. The code that does the work is the 348-byte `Bits.putIntB`; only shorter bodies help.
- The fuel check outlined (`loop F { block S { loop L { br_if S } } yield; br F }`, no call in the loop): `virtualMono` 0.078 -> 0.049 but `allocLoop` 0.029 -> 0.052, `random` +22%; rejected. A global counter instead of the local: measured in C (2x on tight loops).
- A `[vt, hash, lock]` header (three fields, 60 sites index the data array at 2): not built, see above; the lock in the low half cost nothing at the places that read the hash.
- Skipping the depth of every call that precedes a throw outright (no wrap): overflows the engine at boot (above). Treating `Iterator.hasNext` loops as counted: not built, the compiler does not know library names.
- `fbLoop` in Chrome (0.63x): a cross-instance call costs 1.5 ns (`call_indirect` into another module's function 1.7, a direct imported call 1.45, an inline store 0.2; micro-benchmark in the Chrome of this table), so the per-element `gst32` call is not the cost; 12 ns per `put` is the Java layers (`put`, `nextPutIndex`, `put(int,float)`, `checkIndex`, `putFloatUnchecked`, `putFloat`, `Memory.pokeInt`), each of which now inlines where V8's budget allows. Putting the guest memory in every module is multi-memory (Chrome only) or moving the counters and the scratch region into the core's memory; not built. `fbBulk` is 0.57x in both (the copy itself, 0.075 ms for 16 KB).
- `strConcat`, `strSubstr`, `strBuild`, `strIndex`: unchanged (0.42x, 0.46x, 0.76x, 1.03x); the two allocations per String and the byte-array builder of libcore remain; sharing the parent's chars was costed in 4.10 and not built again. `ecdsaVerify` is 1.00x in node and Chrome (BigInteger, nothing missing in a profile: the time is in unnamed optimized code).
- First call: not moved (0.48x -> 0.65x in node, 0.31x -> 0.31x in Chrome over a build of the 7 libcore jars; node's rows are on-demand compiles whose noise is +-15 ms). The compile phases are unchanged (the sweep of bouncycastle takes 4 s in both), the per-module cost of the larger import list is not visible next to V8's compile of the multi-MB package modules (4.11).

### 4.16 W2: launch time (G3), Mihon's launch and JNI on strands (2026-10-04, `knlnks/wasm-w2`)

**Instrumentation.** `wd.perf` has the World's work (`wasmMethods wasmCompileMs wasmModules wasmModuleMs wasmBytes wasmAotLoaded wasmAotMissed wasmAotMs wasmClasses wasmSuspensions wasmCrossings`, bound to `World.stats` by `host/stats.ts`, reset by `perfReset`),
`src/perf.ts mark()` writes launch milestones (`boot tierLoaded installOpened bootApk dexLoaded appCodeSaved|appCode worldMade startZygote dataReady resourcesReady firstPresented`, and the build's `aotIndex aotOpened platformReady`) as
performance marks of the realm that makes them, and `bun run lat <scenario> --timeline` prints them for the page and its process frames (`--query tier=wasm`; `scripts/lat/profsum.ts from= until=` windows a `--cpuprofile`).
**Where a 7.9 s FitNotes launch went** (cold, Chrome, load average 14; the app runs in the page, the framework's processes in frames): 3.4 s of the 5.5 s from `startActivityThread` to the first frame was on-demand compile
(14,449 methods, 18,695 modules instantiated: 2.5 s compiler, 0.9 s Module/Instance) because (1) the startup list (`startup.json`, from a probe of one process, 188 files) missed 293 modules the framework's start wants, and a missed module is compiled on demand
for good, (2) a precompiled code module imports Suspending natives as `id#s`, which `World.nativeBound` did not know, so 25 modules were dead and compiled on demand, (3) no saved app build was attached (`bootWasmTier` made the World before the app's dex files
existed, and the zygote's Java ran before them), (4) 62 more modules died because a class module they import was a miss.
**Changes.** `bun run wasm aot-profile [apk ...]` launches the apps in headless Chrome twice (no saved build, then with one), takes every file `FetchStore.wanted` saw (all realms of the tab) and writes the build's `startup.json`
(about 530 modules, 120 MB of the 215 MB build, plus every class module: 39 MB; run it after `bun run aot`, which still writes the one-process probe). The tab's build opens while the package downloads. `bootApk` loads the app's dex files and
calls `loadAppCode` (tier.ts, `host/boot.ts appCode`, `host/appcode.ts prepareApp`) before any other Java; the World is made lazily at the first Java the realm runs over `new Program(appDexes, platform)`, so a build a previous launch saved (OPFS directory
`wd-wasm-apps`, kept by `wd.reset`) attaches (`appCodeSaved`), a launch without one has a worker build it for the next, and the second-tier compile worker is the one `prepareApp` made. The zygote waits for the app's code (`appCodeReady`).
`nativeBound` strips `#s`; a precompiled module's class-hierarchy decision is checked against the app's classes once (`Assumption.stands`), not once per module (298 ms of `Program.implFor` building the members of 4,000 app classes);
`newlyInitialized` scans the classes whose initialization was not reported, not all of them (it ran for every worker job: 120 ms).
**Result** (`lat fitnotes`, the same machine busy with other agents: load average 14; ranges of 3 runs; the JS tier's baselines from docs/wasm-baselines.md):

| App | Launch to first frame, cold | warm | JS tier cold / warm | on-demand methods (cold / warm) | gated taps |
|---|---|---|---|---|---|
| FitNotes | 7.9 s -> 4.2 to 5.6 s | 7.7 s -> 3.8 to 4.0 s | 1.76 / 1.24 s | 14,449 -> 2,900 / 2,200 | 8 to 24 ms but the first tap 84 to 178 ms (24 methods, 85 ms of CHA `reaches`/`isSubclass`; limit 150) |
| Calculator M | not measured by lat (uiTree, W1) | | 1.69 / 1.22 s | 5.6 s cold, 4.1 s warm by `wd.perf.presentations` | |
| Mihon | never presented (below) | | 7.39 / 6.71 s | | |

G3's warm target (at most the JS tier's) is not met: the floor is the framework's own start run as Wasm (the zygote's Java 1.3 s, `startActivityThread` to the first frame 2.0 s) with what is still compiled or linked on demand: 2,200 methods
(0.5 s compile, 0.5 s Module/Instance), 1,365 class modules of the app's classes built on demand (0.3 s: the app build does not persist class modules), 300 precompiled methods undone by the app's classes (CHA) and recompiled, 700 platform class
modules instantiated (0.3 s), and the build's 620 ms open (a tier open is on the critical path beside the package download). Next: persist the methods a launch compiled on demand and the app's class modules in the app build, and cache the compiled
modules (IndexedDB takes a `WebAssembly.Module`).
**Mihon** never presented because its process died: (1) `Thread.getStackTrace` is `VMStack.getThreadStackTrace`, a JS-tier native that links `StackTraceElement` through the runtime (`App.getPackageName` calls it) -> an intrinsic over the frames the host records;
(2) `ActivityManager.getMemoryInfo` wrote `totalMem` by its Java name -> `setDeclared`; (3) the app's classes answered the boot loader for `getClassLoader` (the open item of A3), so kotlinx.coroutines found no Main dispatcher -> the loader that opened the app's dex
files is the default namespace's loader for the classes the app defines; (4) the host implements `javax.microedition.khronos` whole, but the Wasm tier ran the dex `EGLContext.<clinit>` (EGLImpl natives) -> `hostWhole` classes drop their initializers.
Next failure: a host spec over a dex *interface* (`EGL10`/`EGL11`, `GL10`) has no class an instance can be made of (`Bridge.shellOf` allocates the interface); the same classes need a concrete class of natives (hostclass.ts, B2). Also seen: an `Unsafe` accessor gap, `AttributionSource should be unparceled` (microG process).
**Strands.** The engine frees the JSPI stacks of calls made on a stack of its own only when that stack waits and refuses a new one past about 1,400 (reproduced with 30 lines of Wasm: 1,485 nested `promising` calls in one outer stack; none from the top level, and a Suspending import in the loop frees them).
A native that enters Java (File.list0 asks the File for its path) 1,000 times in one entry therefore ended in StackOverflowError. A strand that made 200 nested entries returns its next plain native through the settle import (`Sched.owes`), which waits once. `bun run wasm nested`; the FileTest and CharsetTest pins are gone.
**JNI.** A JNI call into Java (`vm.invoke/construct/init/monitor`) runs on a strand of the calling thread (`host/entry.ts onNestedStrand`, `Bridge.callOn`) and answers a Promise when it waited. A JThread the host made (binder, native, test) is a Java thread of its own (`recOf`, `Sched.hostThread`; its
Thread object is named `Thread-host` and bound to its record by `Sync.Bind`) and has its own Cpu; the host's current thread is what it was before it entered Java (`hostCurrent`). JNI monitors belong to the thread's root strand (`Sched.nativeMonitor`), so they outlive the call that took them and a contended
MonitorEnter waits (a Promise, no stack). FindClass resolves in the loader of the class declaring the running native method (`Cpu.nativeClass`; `JniVm.find(name, owner, from)`; checked by reading, not by a test: `jni.test.ts` has one loader). `WEBDROID_TIER=wasm bun test src/native/jni.test.ts` runs all 26 (the 4 skipped
ones now use Java fixtures: `JniSlowInit`, `JniCallback`). Open: the doodlejump flow's JNI part cannot be reached on the Wasm tier until `RamLogger.Append` compiles (move-result gap, W1).

### 4.17 X2: the full platform build in a page (2026-10-04, `knlnks/wasm-x2`)

**Why the build "could not be fetched".** Chrome fails a request with `net::ERR_INSUFFICIENT_RESOURCES` once about 1,600 are pending at once: 2,143 concurrent `fetch`es of the build's files gave 1,616 answers and 527 failures
(`TypeError: Failed to fetch`), with or without keeping the bytes, with `compile` or `compileStreaming`. With 6 to 16 in flight the same 222 MB (largest module 3.9 MB, no sync XHR) is fetched in 0.46 s from localhost,
compiled in 0.58 s (`compile`) or 1.0 s (`compileStreaming`) and held in memory without trouble, so size, memory and ordering are not the limit; the count in flight is. G1's page preloaded every file with one `Promise.all`
(the page never became ready), and `FetchStore.prefetch` of W2's 1,280-file profile list was within a few hundred requests of the same limit.

**Loading.** `FetchStore` keeps 16 requests in flight (`WIDTH`) over a queue, in the order of `startup.json`; the page still waits for that list before the World runs. A module the code wants that nobody asked for yet is a miss for
that realm (its code compiles on demand, as before, and `AotRuntime.missed` keeps the answer, so a module that arrives later is never mixed with code compiled without it) and goes to the *front* of the queue, so the realms that
ask later (the framework's processes are frames of the tab, sharing the store) find it. A synchronous or `Suspending` wait for the module was not built: a miss costs the 0.2 ms per method the compiler needs, 289 misses of the
old startup list were 3.0 s of compiling, while waiting for the same files one by one costs a round trip each (289 x 30 ms = 8.7 s on a 30 ms link) on a strand that also holds the main queue; the stub that asks is a plain
table entry and cannot suspend without making every lazy-link stub a `Suspending` import. Modules are compiled with `compileStreaming` (the frame-naming issue of 4.9 is solved) in the tab's realm and used by the frames directly
(same origin, same thread): `boot-probe` shows the frame fetching and compiling nothing.

**Grouping by use.** `aot-profile --classes` launches FitNotes and Calculator M with the code modules withheld (every method that runs is compiled on demand) and writes `vendor/wasm-aot/hot.json`: the classes with a method called
(5,209 of 41,247), most shared first. `bun run aot` puts them into code modules of their own (`--max-hot`, 1 MiB estimated), in that order, and puts the classes whose class modules a launch loads (`linked`, recorded by
`aot-profile` on a build where the code modules are there: 43,000, because compiled code links every class it names, so a launch loads nearly every D module, 29 MB) into class modules of their own; the rest are grouped by package as
before. Numbering is by definition order and does not depend on the grouping. `aot-profile` then writes `startup.json` from `FetchStore.wanted` of a launch with every module available (a launch with misses wants different modules,
and a module whose class module missed is dead for good), instead of W2's list, which also added all class modules. Order: `aot-profile --classes`, `bun run aot`, `aot-profile` (twice for `linked` to settle).
A launch of FitNotes wants 41 to 58 files, 63 MB raw (34 MB code, 29 MB class modules), against 1,280 files and 133 MB.

**FitNotes launch** (`?tier=wasm`, Chrome 153 headless, navigation to the first presented frame, 2 runs, load average 9 to 15 so +-1 s; transfer is brotli q5 from the dev server, which now compresses `/aot/` as the edge does;
warm = second launch in the profile, HTTP cache and saved app build):

| layout / startup list | cold | warm | methods compiled on demand (cold / warm) | requests, MB transferred cold |
|---|---|---|---|---|
| package, probe list (188 files, before) | 7.1 to 8.4 s | 6.3 to 6.9 s | 15,200 / 14,200 | 514 (misses fetched behind), 22.8 |
| package, profile list (1,280 files, W2) | 4.8 to 6.2 s | 4.1 to 4.5 s | 3,400 / 2,600 | 1,284, 25.9 |
| hot 1 MiB, profile list (58 files) | 4.5 to 4.9 s | 3.3 to 3.6 s | 3,400 / 2,600 | 65, 12.7 |
| hot 3 MiB (21 files) / 512 KiB (114 files) | 5.0 to 5.3 / 4.2 to 4.4 s | 3.7 to 4.4 / 3.5 to 3.7 s | same | 32 / 122, 12.9 / 13.0 |

Warm transfers 0 bytes (the files come from the HTTP cache, still one cache read and one compile each). `aotOpened` (startup list fetched and compiled, on the critical path beside the package download) 0.6 to 1.3 s for 63 MB raw.
Brotli q5 is 0.18 of the raw size, gzip -6 0.22 (sample of 108 modules): a launch is about 12 MB, the whole build about 40 MB. The edge compresses `application/wasm` (Cloudflare docs, read 2026-10-04; the algorithm
depends on the plan; not checked against a deployment); the largest file is 3.9 MB against 25 MiB and the build has 2,163 files against 20,000.

**G1 first call, geometric mean js/wasm over the 14 rows that run framework or non-7-jar code** (ssbAppend ssbEdit ssbGetSpans spannedCopy linkify b64android dtoa dbInts sha256 ecdsaVerify certParse scanTokens scanLines zipOpen;
3 runs x 30 reps, load average 9 to 15, indicative; the harness now opens the build as the app does, so these are not comparable with the earlier tables):

| build | Chrome | node |
|---|---|---|
| 7 jars (before) | 0.13 | 0.34 |
| full, package, probe list | 0.15 | 0.36 to 0.40 |
| full, package, profile list (133 MB, `ahead` 650 ms) | 0.23 | not applicable |
| full, hot 1 MiB, profile list (63 MB, `ahead` 270 ms) | 0.21 | 0.23 to 0.31 |
| full, hot, every module fetched before the call | 0.20 (3 MiB: 0.19) | |

What helps the first call is having the module before the call (sha256 429 -> 217 ms, certParse 739 -> 362, scanTokens 923 -> 429 in Chrome), not the build's size or the layout; fetching all 2,143 modules first adds nothing more.
The ssb\*, spannedCopy and linkify rows stay at 100 to 160 ms in Chrome with every module present: their first call is 19 methods compiled on demand in 100 ms of which the phases are 14 (the Program's class model and
class-hierarchy index are built for the harness's Program on the first query; in a tab they are shared, A2), not modules. In node the hot layout is 10 to 40% slower than package modules on single-feature rows (its modules are
larger and a call pulls the whole one); the page does not pay for that, since modules are compiled off the main thread.

**Left.** Compiled code links every class it names, so a launch loads 29 MB of class modules for 5,000 classes that run: stubs created on the first use of a slot would cut the largest remaining cost. Warm launches still read and
compile 58 files; V8's cache of `compileStreaming` results (Chrome's code cache for HTTP-cached responses) was not measured. The first-call floor of the framework rows is the Program/CHA cost above (X1's area). Profiles use FitNotes and
Calculator M (Mihon does not present on this tier); classes only another app runs are misses and compile on demand.

### 4.18 X1: launch time, the app build and the boot image (G3, G6; 2026-10-05, `knlnks/wasm-x1`)

**Where a warm FitNotes launch went** (3.5 s from navigation to the first frame at `d0c9a31b`; Chrome 153 headless, load average 4 to 6; a V8 profile of the page plus a `v8.wasm` trace of the tab).
The page's main thread was busy the whole way, and the Java itself was a small part of it: wasm self time is 165 ms of the 1.8 s that remain once the build is held, 12 ms of the 453 ms of the zygote's Java.
- *Engine*: 42,131 functions compiled lazily (Liftoff, on first call) cost 800 ms, 11 of them (static initializers with long array literals: ICU's `LocaleIDs.<clinit>` alone 140 ms, a 1.5 MB text function) 293 ms; 5,965
  runtime-built modules were compiled (209 ms) and 6,683 instantiated (192 ms); the streaming compile of the 130 MB startup list held the main thread (95% in native code from 300 to 800 ms: `OnBytesReceived` 310 ms,
  `FinishStreaming` 119 ms) while nothing else ran.
- *What the launch built because no saved code had it* (the saved app build covered the likely methods only): 829 app methods (463 ms), 733 synthetic functions (`uf:` field accessors of Unsafe, allocators, runtime functions: 2,000 modules
  with their stubs), 1,365 class modules of the app's classes (every code module links all the classes it names), 27 platform methods undone by the app's classes and compiled again (installProvider alone 98 ms, most of it the one-time
  class-hierarchy index of every platform method key), 1,151 identical `fieldReader` modules (one per host object, an uncached call), 549 modules to set `OsConstants`' constants one by one, inline second-tier compiles 190 ms.
- *Loading platform modules*: each C/D module made a record for every class it names (37,000 `ClassRt`s, each building the class's member list), built the members of every class to mark its slots, resolved every class-hierarchy
  decision to a method, and looped over all overridden slots; `stackClass` formatted 128 frames of `Error.stack` per call (104 ms).

**What changed.** An app build now holds everything a launch built on demand (appcode.ts `refine`, apps.ts): the launch records its demand (`World.demand`: the methods compiled at first call, the class modules made, the host questions that
made synthetic functions, by name), and once the launch has gone quiet (two looks, 2 s apart, after the first frame; at most 3 builds) the worker makes the build again with it (the build worker is kept for that; one that began without the
host's classes is replaced). The build has *data modules* `e<k>.wasm` for the app's classes and for every class its code modules name (about 128 KB each, a module loads whole), *synthetic modules* `s<k>.wasm` (64 functions each;
`hostInfo` questions are replayed in the worker by class name, since ids differ; a function whose code relies on a class-hierarchy decision is left out) and *patches*: code for platform methods that the app's classes undo or the
platform build lacks, in modules loaded right after the platform module they patch, so that they replace its entries. The methods of classes the platform build does not number (the 32 jars outside its set, the host's classes) are
compiled into the build like the app's. A platform build ships the builds its profile run made (`aot-profile` writes `app.<key>.<file>` beside the modules, 4 to 5 MB for FitNotes; host/bundle.ts), so a first launch of a known app
finds its code: on a device without one the launch makes it, as before. `APP_VERSION` 2, `VERSION` 3 (traces are read per function).

Cheaper launch work: a platform module loads the module of each class it names but makes a record only for a class something asks for; marks its slots from the block sizes; compares class-hierarchy decisions by names and resolves a target
only when a class has been added; finds the overridden slots of its own module; `fieldReader` and `OsConstants` as above; `isSubclass` reads one Set of ancestors per class (`Program.ancestors`) and `reaches` stops at a class that
implements the method itself; a static initializer's `aput` is a call of a helper (`aput:<kind>`: the function is 4 times smaller; `LocaleIDs.<clinit>` 140 ms -> 15 ms); the caller class is looked for in 16 frames first (104 -> 15 ms); the
inline second tier (`World.holdUpgrades`) waits for the first frame (190 ms: what runs hot while a process starts is run-once code; the worker still takes the jobs); the tier is loaded as the page starts, its World is made
while the build's modules arrive, and workers fetch and compile them (host/aotload.ts, 4 workers, 8 requests each, the modules cross as they are): the main thread no longer feeds 66 MB to the engine.

**Result** (FitNotes, `lat fitnotes --query tier=wasm [--warm]`, navigation to the first presented frame; 3 to 4 runs each, run alternately against X2's tip `05991197` served on a second port, load average 4 to 9; the JS tier measured
in the same hour: 1.25 to 1.28 s warm, 1.68 to 1.78 s cold):

| | X2 tip | this branch, no shipped build | this branch, build shipped |
|---|---|---|---|
| cold | 3.6 to 4.2 s | 2.9 to 3.0 s | 2.15 to 2.55 s |
| warm | 2.98 to 3.33 s | 1.74 to 1.87 s | the same (it has its own build) |
| Calculator M cold / warm (`wd.perf.presentations`, 3 runs) | 5.7 to 5.95 / 4.04 to 4.09 s | | 2.76 to 2.97 / 1.81 to 1.89 s |
| max gated tap, cold / warm | 27 to 31 / 83 to 99 ms | | 24 to 33 / 19 to 22 ms |

At the start of this work (`d0c9a31b`, load 4 to 6): cold 4.06 s, warm 3.53 s. On-demand work at the first frame, warm: 2,264 methods compiled (519 ms) -> 23 (6 ms); class modules built 1,365 -> 66; modules instantiated 7,746 -> 1,845;
`wasmAotMs` (platform module loading) 270 -> 70 ms. Cold, no shipped build: 2,222 methods (505 ms) and 512 class modules, as the first launch of an app on a device. Mihon still does not present: it reaches `resourcesReady` at 2.1 s (2.5 s at
X2's tip), then its process dies (`Unsafe: no accessor for this offset`, then `Bridge.shellOf` allocating the dex interface `EGL10`, as W2 recorded); its builds were not shipped.

**G3** (launch on the Wasm tier at most the JS tier's, cold and warm): *not met*. Warm 1.74 to 1.87 s against 1.25 to 1.28 s, cold 2.15 to 2.55 s (build shipped) or 2.9 to 3.0 s against 1.68 to 1.78 s: the gap is 0.5 s warm and 0.4 to 1.2 s
cold, from 4.06 s and 3.53 s when the work began. No gated tap is above 150 ms (max 33 ms). What is left of a warm launch is the main thread running the framework as Wasm: 0.45 s from navigation to the World, the zygote 0.45 s (172 ms of it
loading modules), `startActivityThread` to the first frame 0.85 s (141 ms of it Java).

**G6, the boot image: decided not to build.** Measured first: the Java heap of the page's World at the first frame is 140,139 wasm GC objects in 490 struct and array types, 20.7 MB (a heap snapshot of the tab is 845 MB, 8.2 M nodes, 3.1 M of them
plain JS objects of the program models and 2 M strings); the zygote's initialization (`System.<clinit>`, `commonInit`, JCA warm-up, fonts, text resources, paint) runs for 450 to 550 ms from the World to `startZygote`, and of those 12 ms are
wasm execution: 172 ms are loading modules (`linkSlot`: C and D instantiation, their `touch`), the rest the host's natives and JS. A loader that made the 140,000 objects from a data section would take about 10 to 20 ms, but it would not
make the zygote cheaper: the statics of the classes it restores live in the globals of their D modules, so the loader instantiates the D module of every class in the image (about 500, the 70 ms of `Instance` and the `touch` cascade that
the launch pays now), and the Java that runs once is 12 ms of the zygote and 141 ms of the 845 ms after it, so a free image saves at most 150 ms of 1.8 s (8%). What it would also have to re-establish is host state that is not in the
heap: the classes' init words and the thread that initializes, identity hashes and monitors (`Sched`), the interned strings, `hostFns`/`callFns`/`fieldReaders` closures and the table entries of every installed function (instances
cannot be serialized), `ctab` (Class objects by id), the host classes' shells (`hosts` WeakMaps), the proxies' Method table (`nm`), `pinned`, the natives' own JS-side state (properties, locale, charsets, JNI handles), the native heap (`guest`
memory and its `FinalizationRegistry`), the file system. Gate G6 asks for a loader under 50 ms and `clinit` time that drops: the loader would pass, `clinit` time is 12 ms, and the cost that dominates is the module loading it cannot remove. The
cheaper alternative the measurement supports is the one above: do less per module (no record per class a module names, no members built to mark slots), have the module and its code ready before the launch (the app build holds
classes, synthetic functions and patches; a platform build ships them), and keep the zygote's host work (natives, resources) for X-track profiles.

**Left.** (1) Method-level hot modules: of the 156,011 methods in the 196 platform code modules a FitNotes launch loads, 13,084 (8.4%) run before the first frame (counters of the first tier), and X2's class-level split leaves 37 MB of code to
fetch and 33 code modules to instantiate for them; a split by method (a patch-like module per platform module) would cut the bytes to a tenth. (2) 21 synthetic functions and 2 methods still compile in a warm launch (runtime functions
nothing in the build names). (3) The class-hierarchy index of platform method keys (100 ms, built the first time a query outgrows the walk's budget) is avoided by patches but is still built by anything that compiles a method with a
large hierarchy. (4) Lazy compile of big functions: V8's Liftoff time follows function size (the 11 functions over 2 ms are 293 ms), and compilation hints are not shipping (4.9). (5) Mihon's failure (Bridge.shellOf over an interface) is W1's.
Evidence limits: headless Chrome with swiftshader on a loaded shared host (load 4 to 9; runs alternated between two builds, spreads +-0.2 s), a profile run of FitNotes and Calculator M (classes only another app runs are misses),
shipped builds exist for the apps and the framework's processes that the profile run launched.

### 4.19 Y2: recovered app parity slice (2026-10-05, `knlnks/wasm-y2`)

Starting HEAD `47059fe3`, original base `1d7fdeea`. The four existing commits were inspected with their saved captures before edits. Main merges are `e10dae6d`, `0cd312b3`, `3ee7c299`, and `b38825f5` (through `809ce40d`, including Y1, parent's isolated CHA fix and the expanded all-production-source AOT key). The branch remains unmerged to main. Retained fixes are generic platform/JNI behavior; APKs, app bytecode, flow definitions, thresholds and goldens are unchanged.

**Additional fix:** `02e82805` registers an interface host spec's concrete implementation before any caller is compiled. Previously the first native result made that implementation too late: CHA had selected the sole bytecode implementor. `Hc.faces` reproduces 303 against the JS tier's 307; after the fix both return 307. It changes `src/wasm/link/hostclass.ts`, `scripts/wasm/hostcases.ts`, `tests/fixtures/wasm/java/hc/Hc.java`, and `tests/fixtures/wasm/java/hc/stubs/wdtest/Maker.java`. Existing AOT vtable/initializer and same-thread nested JNI changes in `47059fe3` were retained after validation; recovery made no edits to Y1's `host/natives.ts`, `compiler/method.ts` or `link/sched.ts`.

**Delivery reconciliation:** `f07dbca4` temporarily represented an absent optional app bundle as 204, eliminating browser 404 errors on otherwise completed flows. Main's `d36eb94a` instead publishes an always-present `apps.json` catalog and fetches only listed bundles. `469070a4` removes the temporary protocol; `src/wasm/host/bundle.ts` and `scripts/wasm/aot-serve.ts` now match main exactly. A fresh strict eight-jar AOT build validates all 290,828 methods. Generated assets remain ignored. The server was restarted after merging; `/aot/current.json` returns HTTP 200 and all five final flows load AOT modules (observed per-process maxima 260–276). Final build key `1fabf74bff3914b6` (source `72806f2054e1e9a9ba91b38f2deba88ca93872b6987bb666a3f45f66b7ada9f2`).

| Flow | Final standalone at `b38825f5` | Final sequence at `b38825f5` | Reference coverage |
|---|---|---|---|
| Doodle Jump | Pass, 6 steps | Pass, 6 steps | Smoke; no golden manifest |
| Flappy Bird | Pass, 7 steps | Pass, 7 steps | Smoke; no golden manifest |
| Komikku | Pass, 23 steps, backup file retained | Pass, 23 steps, backup file retained | Smoke; no golden manifest |
| Mihon onboarding | Pass, 5 steps; storage 15.36% | Pass, 5 steps; storage 15.36% | Existing storage-step visual limit 29% |
| Mihon app | 17 steps; Appearance fails 74.77% vs 14% | Pass, 17 steps; Appearance 2.58% | Existing Appearance visual limit 14% |

The final merged sequence and the pre-catalog strict sequence (`--jobs 1`) both pass 5/5: Mihon storage-step 15.36%, Appearance 2.58%. The failing standalone Appearance image shows Download queue, with Appearance/Dark/Light text targets returning false. A fresh build of starting `47059fe3` under matching inputs reproduces Download queue and a 74.60% difference; recovery did not introduce this failure. At this milestone the intermittent navigation cause was unresolved; section 4.20 records the subsequent input-timing diagnosis and fix. No old EGL10 shell or Unsafe accessor error appears in either final Mihon observed path; no speculative Unsafe offset handling was added.

Core checks are limited to the changed behavior: hostclass 31/31 against JS in lazy and four-jar AOT modes; JDK/JS/Wasm initialization race, cycle and failure 3/3; typecheck; all four affected APK smoke compiles with zero method failures. Every final standalone and sequence step has reachable process diagnostics with status ok, no unexpected missing/native/runtime/browser diagnostics, no wedged loop or completion timeout, and no error counters. Komikku retains its declared SQLite log messages: the eight unique code 28/284 messages and their `E/SQLiteLog` labels match the fresh starting `47059fe3` jobs-1 sequence, with the same geometry and flow hash. The callback ownership and severity distinction are resolved in section 4.20. Game motion checkpoints present advancing frames. No full-suite or idle-host performance claim is made.

CHA coordination: the retained `a5749f0e` patch replaces exactly two `stack.push(...this.subsOf(n))` calls with loops. Direct Object-subtype counts are 42,726 / 42,624 / 58,501 / 55,636 for Doodle Jump / Flappy Bird / Komikku / Mihon. Archived original-base diagnostics record a Maximum call stack size exceeded error under HashMap.putVal, but a shallow Chromium worker spread accepts those counts. The specific pre-crash compiler-stack argument-limit mechanism is not isolated here; the overlap is resolved using parent's `ab42ca02` file exactly; there is no remaining CHA diff from main.

The surviving Y2 source/fixture file set is `src/android/glsurface.ts`, `src/wasm/link/{hostclass,world,sched}.ts`, `scripts/wasm/{hostcases,run}.ts`, `tests/fixtures/wasm/java/hc/Hc.java`, and its `stubs/wdtest/{Maker,Counter}.java`; CHA and optional-bundle delivery match main. The two changed documentation files are this plan and the implementation history.

Evidence and exact retained-commit mechanisms are in `docs/implementation-history.md`. Captures and logs are isolated under `webdroid-shots/y2-recovery/` (`standalone/`, `strict-before-catalog/`, archived `base/` and `start/`, core/build logs, `final-standalone/`, `final-sequence/`, their telemetry summaries, `final-manifest.json`, and `sqlite-baseline-comparison.json`). Original-base full flow work was stopped when startup could not progress; the later 45-second launch snapshots are bounded diagnostics, not completed baseline flows.

### 4.20 Y2: synthetic input timing and SQLite callback ownership (2026-10-05)

Main's reviewed host/JNI milestone and canonical numeric DEX ordering (`1c2e8f0d`, `3c6da02a`) are merged into this checkout at `08d3ae69`. Production commit `daf308dd` changes only `src/main.ts` and `src/shell/device.ts`: synthetic swipe positions keep their requested sample times in the shared uptime time base. Ordinary pointer callers still timestamp events when dispatched. Flows, recorded actions, app bytecode, preferences and goldens are unchanged.

**Navigation mechanism:** `wd.swipe` scheduled positions along a 400 ms trajectory but timestamped each MOVE when its timer finally ran. Browser work delayed samples; catch-up timers then compressed their spacing, so Compose's unchanged velocity tracker inferred a faster fling. In the failing capture Default rotation's remaining text bounds were y=0–19; its attempted tap opened no dialog. The following Back actions therefore popped Reader and Settings, and the Appearance coordinate fallback hit Download queue on More. Back dispatch and the app's navigation stack were behaving as authored.

A fresh merged baseline on the same port, APK, pinned clock, preferences, geometry and jobs-1 flow passed once on JS and once on Wasm (both Appearance 2.58% against 14%). That does not waive the intermittent failure. A controlled 100 ms event-delivery stall near the end of the unchanged Reader swipe reproduces the missing rotation target before the fix: final MOVE intervals are 5–7 ms and the gesture's event time grows to 509 ms. With the same stall after the fix, intervals retain their requested 8–9 ms spacing, the gesture is exactly 400 ms, Default rotation remains at y=226–282 and its dialog opens. The Android recorded target is y=240–296. The [MotionEvent contract](https://developer.android.com/reference/android/view/MotionEvent) uses the time the event was generated, in the uptime time base, rather than late delivery time.

Two untouched standalone runs after the fix pass Appearance at 2.58%; the final one uses build `425007f7b3dd30ae` (source `16897f31112dd67b1dc981445fead7c26bb7a3b410123c2bca76f62e916c3ee7`). The restarted server returns HTTP 200 for the manifest and generated assets load. Typecheck passes; a fresh strict eight-jar build validates 290,828 methods. No unrelated core suite or performance measurement was run. Final Wasm jobs-1 sequence passes 5/5 flows and all 58 steps: Doodle Jump 6, Flappy Bird 7, Komikku 23, Mihon app 17 and onboarding 5. Appearance is 2.58% against 14%; onboarding storage is 15.36% against 29%. Every final standalone/sequence step has healthy observed process diagnostics, no missing/native requirements, unexpected errors, error counters, timeouts, wedging or semantic tap misses; per-process AOT maxima are 260–276. Komikku retains the declared guest SQLite messages. The games and Komikku are smoke flows without golden manifests. Parent owns the broader matrix.

**SQLite severity:** [Android 15's native callback](https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/android-15.0.0_r1/core/jni/android_database_SQLiteGlobal.cpp) masks to the primary code: code 28 is WARN, code 284 (AUTOINDEX) and primary NOTICE/CONSTRAINT/SCHEMA are verbose-only, and other errors remain ERROR. Komikku executes its bundled requery callback instead. [Requery's source](https://raw.githubusercontent.com/requery/sqlite-android/0bbaa7a8b4c485c0d4b385425113fe33ead6c3c0/sqlite-android/src/main/jni/sqlite/android_database_SQLiteGlobal.cpp) suppresses only exact 0/17/19 when verbosity is disabled and emits other codes at ERROR. The APK's actual ARM64 library confirms that mechanism: registration loads callback 0x4a3f0 at 0x4a3b0; the callback sets w0=6 at 0x4a3fc and codes 28/284 branch directly to `__android_log_print`. `src/native/libc.ts` faithfully preserves that priority. Neither an AOSP callback replacement nor a liblog tag/message filter is warranted for this unchanged guest library; real error severity remains intact. The existing expected log messages remain in the flow.

Evidence is local to `webdroid-shots/y2-navigation/`: baseline JS/Wasm captures, controlled before/after pointer traces and UI, standalone captures, strict build/typecheck logs, final manifest, native callback disassembly and primary source snapshots. Komikku APK SHA256 `5dec6178557c89944bf2ef0b5059a5c36a5ab8ebf74dab92fa9281997879d2e2`; extracted `libsqlite3x.so` SHA256 `5ebf59bb86273e4757a01de5eb1ea31283ea54fa66e8562b1b0146d2f6fe77f8`. Earlier baseline attempts restored only manifest metadata after the build command had removed its module directory; they were interrupted during startup and are excluded. The completed baseline was rebuilt and checked with both manifest and index HTTP 200.

### 4.21 Y2: S5 migration boundaries (2026-10-05)

S5 starts from main `64622fec`, including the compile-only vtable guard and full-width executable metadata fix. No process Worker is enabled by the first archive transport milestone. `world.ts` remains parent's scope. Firefox is not an acceptance requirement for this task.

The minimal migration order is:

1. **Bootstrap and endpoint messages.** Bootstrap contains bytes or packed archive index/base descriptors, not archive instances or read functions. Lazy split reads use read-only MessagePorts; responses own their buffers, failures preserve their messages, and process death rejects outstanding reads. Binder already carries serialized Parcel bytes and handles. Endpoint calls need a typed request/reply contract and explicit death rejection, including reentrant service callbacks; do not expose arbitrary broker methods.
2. **Canonical stores.** `process-endpoint.ts` currently installs live broker stores and callbacks. Keep SQLite's sql.js module and connection/statement tables with their owning service and cross the boundary with commands and copied results. Preserve transaction ordering, TEMP schemas and PRAGMAs; whole-file snapshot replication does not replace that contract. Private-file writes need ordered acknowledgments and read coherency; preferences/settings/accounts/permissions/notifications, cookies, alarms and pending-intent codecs need explicit requests or updates rather than shared mutable Maps or functions.
3. **Immutable resources and time.** Font/platform/HarfBuzz/Skia/AOT caches reached through `pageShared` must become caches owned by each Worker. Browser caching can reuse bytes; live parser/Skia objects cannot cross the port. Give real clocks the page's boot origin and controlled clocks broker-ordered deadlines and completion acknowledgments. The current shared clock heap stores callable functions, so a Worker-local clock alone would change controlled flow ordering.
4. **Process and presentation.** Instantiate a process Worker after those contracts pass. Keep page-owned IME, clipboard/geolocation permission prompts, WebView frames and presentation behind explicit adapters. A process first started for a service can later launch a window; manifest activity absence does not justify discarding that capability. Keep process diagnostics available through the broker. Do not enable Workers with a fake DOM, independent persistent stores or a process restart used as heap migration.

The first focused change replaces bootstrap's live packed archives with descriptors and unpacked/split FileSources with transferable read ports. No raw APK buffer is copied into the bootstrap message. Packed archives remain lazy, digest-checked and bounded by their existing per-realm cache. The current iframe loader still materializes unpacked registry APKs for parsing; transfer alone does not eliminate that cost, and foreign-package metadata loading must be narrowed or measured before Worker enablement. A Chromium Worker test exercises the initial structured clone followed by a second port transfer into the Worker, out-of-order reads, independent returned buffers, source exceptions and pending/future rejection on teardown without cross-origin isolation. The real broker test verifies zero eager archive reads, replacement ownership, cleanup of every unpublished port after a failed handoff, retention of the prior published set on that failure, and independent process teardown. A future Worker endpoint must explicitly transfer the ports again; no production Worker endpoint is claimed by this milestone. Broader S5 gates remain open: real process Workers, canonical stores, controlled scheduling, presentation/WebView adapters, full jobs-1 e2e, corpus, cross-site WebView checks and the 4x-throttle presentation comparison. No performance claim follows from this transport test.

Milestone `4f090a6f` changes only `src/process.ts`, `src/shell/processes.ts`, `src/shell/remote-file.ts` and the two focused browser test files. Typecheck and the Chromium transport/ownership test pass. A fresh strict eight-jar AOT build validates 290,828 methods, key `39e336d95afee941`, source `48d397a87ec6114e328ae82a5791fd0f25a3151f0f416db3e99806f583771ad3`. The restarted isolated server on port 4123 returns manifest/index 200. The final unchanged Wasm jobs-1 quick sequence passes 7/7, 105 steps (four Android-compared and three smoke), with zero reported gaps, unexpected errors, missing/native requirements, error counters, timeouts, wedges or semantic misses in final telemetry. Every observed process has healthy diagnostics; per-flow observed AOT maxima are 244–277. Appearance is 2.58% against 14%, FitNotes home 13.93% against 22%, onboarding storage 15.36% against 29%, Calculator result 1.17% against 10%. Komikku's declared guest SQLite messages remain. Evidence is isolated under `webdroid-shots/y2-s5/` (`quick/summary.json`, per-flow runs, `telemetry.json`, test/typecheck/build logs and `manifest.json`). An earlier seven-flow draft capture preceded the ownership/raw-source revision and is not the final-source gate. Only the final capture is retained in `quick/`. The owned server is stopped; main is not merged or changed.

### 4.22 Y2: S5 endpoint and foreign resource contracts (2026-10-05)

The endpoint milestone on integrated parent `8fcfadef` (Y2 merge `487204af`, including compiler-owner teardown `79589919`) uses typed MessagePort calls in both directions. Binder, service, provider and broadcast calls bind their caller PID to the reverse port. Requests dispatch independently so a suspended Binder call can receive a reentrant callback. Exceptions cross as class/name/message data and are reconstructed by the receiving VM. Endpoint death rejects pending and future calls; repeated readiness retains the first endpoint and closes an unpublished replacement. Package removal awaits its acknowledgment, and force-stop waits for actual process death rather than the queued kill notification. Parcel FD exports copy guest-backed bytes before the transfer boundary; this proves wire-buffer ownership only, not Android descriptor-sharing semantics. `pageShared` retains one value per key in each Worker realm.

Foreign raw APK bootstrap reads the ZIP directory, manifest and resource table through the canonical FileSource/ZIP helpers. Files named by the table's string pool are resident before publication, preserving synchronous `Resources.fileOf` (including account-authenticator XML); other entries keep lazy sources. Certificates come from the authoritative installed record. This does not read foreign DEX/native payloads eagerly. The existing packagearchive core check compares the unchanged FitNotes manifest, certificates, table and every referenced file against whole-APK parsing, then reads the lazy DEX and compares its bytes.

Bounded read/residency measurements using BlobFile (not startup timing), bytes:

| APK | Archive | Read at metadata load | Resident resource bytes |
| --- | ---: | ---: | ---: |
| FitNotes | 4,338,070 | 1,361,568 | 1,639,560 |
| Mihon | 66,875,196 | 5,660,837 | 6,367,147 |
| Komikku | 40,915,941 | 9,045,478 | 10,417,621 |
| TikTok | 461,589,329 | 42,528,979 | 61,199,520 |
| Google Maps | 303,173,591 | 60,272,208 | 67,573,066 |

The cost is bounded by the resource files, but remains material for large installed registries and repeats in each process realm. No Worker JVM is enabled. Canonical mutable stores, controlled clock ordering, presentation/WebView adapters and the remaining S5 gates are still required. Chromium endpoint/archive checks (2), compiler-owner teardown checks (2), selected FD checks (5), packagearchive check (1) and full typecheck pass.

Fresh strict eight-jar AOT validates 290,828 methods, key `2e6f95da6b05c96f`, source `f631f5d1734a85a75781ace1e4ae1edb1834502421d47968162ef48bad16956d`. The restarted isolated server on port 4123 serves manifest HTTP 200; every flow observes nonzero AOT loading. The unchanged Wasm jobs-1 six-flow sequence completes 92 captures: Doodle Jump 6, FitNotes 39, Flappy Bird 7, Mihon onboarding 5 and Calculator M 8 pass. Mihon app completes 17 captures but its last two Back steps each wedge and time out. All inspected runs have empty browser errors and new missing/error/native requirements, zero observed draw/layout/Wasm suspension error counters, and healthy process diagnostics. Completed rendering is observed in every flow. These observations do not establish unvisited-path coverage or timing acceptance.

For the ambiguous Mihon failure, the endpoint draft was stashed and the clean integrated starting source rebuilt under matching port, flow, Wasm tier, preference/clock inputs and jobs-1 conditions. Baseline AOT key `00878c03d7402684`, source `cdba9bf7be42573c17ffc1ccdcaef6f5a27380368d80e982ed5890d18aa0e8bd`, also validates 290,828 methods. It reproduces exactly the final two Back wedges/timeouts, with no reported Java/browser error. This comparison does not explain or waive the failure. Earlier Komikku captures stalled; parent's later unchanged-source outlined/no-outline control attributes that crash to app compiler outlining, owned by G4. No process-kill suppression is introduced. There is no accepted all-seven gate or S5 completion claim.

Evidence: `webdroid-shots/y2-s5-endpoint/8fc-six-flows/`, `8fc-baseline-mihon/`, `8fc-telemetry.json`, both manifest/build logs, endpoint/core/typecheck logs and foreign-resource measurements. The initial capture missing the Wasm selector was stopped and excluded. All owned captures and the port 4123 server are stopped. Parent diagnostic load prevents performance conclusions.

**FD contract still open.** AOSP `ParcelFileDescriptor.dup` uses `F_DUPFD`/`F_DUPFD_CLOEXEC` and shares the open-file description, including position ([primary source](https://android.googlesource.com/platform/frameworks/base/+/HEAD/core/java/android/os/ParcelFileDescriptor.java), observed blob `60eeb2b8b0d5787cd397bd4162e3da70488ddd5b`). The local native descriptor table reuses the same open-file object for dup. The existing cross-process `FileHandle` instead creates another byte-backed file on import; writable imports retain a `FileWriter` Binder targeting a duplicate of the exporting FD and write back their final contents on last close. That can preserve an eventual write after the source descriptor closes, but provides neither live read coherence nor a shared offset across imports. Read-only imports have no owner handle, and ashmem imports create separate regions. The corrected fixture tests independent wire buffers and cloneability only; it does not assert that guest reads should remain stale.

Before Worker enablement, move exported descriptor references to a broker-owned open-file description with an opaque capability and per-process reference ownership. Reuse canonical native/VFS operations for read/pread, write/pwrite, truncate, seek, flags and stat; serialize changes to one open-file description, preserve offsets for dup and independently opened positions, and release references on close/death without revoking surviving owners. Every import, including read-only, must retain access to the canonical owner. Copied response buffers are transport values, never authoritative replicas. MAP_SHARED/ashmem require canonical region identity and protection narrowing plus visible updates across existing mappings: command-based final flush alone cannot implement arbitrary concurrent loads/stores. Audit the native mapping owner and select a real shared-memory or ordered coherence mechanism before claiming that contract. Required core verification covers source-to-import and import-to-other-owner visibility before close, shared positions, surviving duplicates after writer/process death, last-reference cleanup and ashmem mapping updates. Existing writeback and local dup checks cover only their narrower operations. A bounded diagnostic (`webdroid-shots/y2-s5-endpoint/fd-owner-diagnostic.test.ts`, result `fd-owner-diagnostic.json`) confirms the limitation: a source write of 7 leaves imported bytes at 1, source/import offsets are 2/0, and an imported write of 9 is invisible at the source before close. Closing source then importer writes back `[1,9,3]`, overwriting the source's earlier 7. This is failure evidence, not an accepted stale-read fixture. The four selected wire/local-dup/writeback core checks pass (12 assertions).


### 4.23 Y2: canonical SQLite commands (2026-10-05)

Starting from Y2 merge `ccfc0636` of parent `2ace54d6`, process SQLite calls now cross the reverse broker port instead of installing another realm's live SQLiteStore. The existing SQLite native tables remain the canonical implementations for AOSP SQLiteConnection and all three bundled-driver families. Their registered client entries suspend through `driven` and send only declared descriptor arguments. No Java object, raw SQLite pointer or another realm's JNI handle crosses the boundary.

Each PID owns one session of monotonic opaque connection/statement tokens. Statements are checked against their owning connection. Requests serialize within the session; other sessions remain independent and share the existing canonical sql.js file. TEMP schemas, PRAGMAs and transaction state remain on their live connections. CursorWindow requests carry geometry/protection; replies carry copied typed cells and accounting. Errors retain Java class/message. Oversized-row errors also return the mutated window state; read-only rejection preserves the client's existing cells. No database snapshot replica is introduced.

Process death rejects active, queued and future requests immediately, drops queued payload references, finalizes owned statements before closing connections, and closes a handle returned by an in-flight asynchronous open. The in-flight read can finish; its request remains retained until it settles. Existing debounce/checkpoint persistence retains its owner and can finish an already-started flush. This changes resource ownership, not the guest's process-kill decision.

Core checks exercise the real AOSP database/session/pool over MessagePorts, shared committed writes and rollback isolation, independent TEMP schemas, 64-bit/blob cursor values, reconstructed errors, foreign-token rejection, bundled-driver calls, failed-window mutation, read-only preservation and late-open/death cleanup. Four selected SQLite checks pass (36 assertions), including the existing live-TEMP/large-snapshot checks; endpoint/archive/compiler-owner checks remain green and typecheck passes. A bounded live owner probe confirms FitNotes PID 1000 owns the broker SQLite session, with two WorkManager connections and one app-database connection. Fresh strict eight-jar AOT validates 290,828 methods, with five existing builder gaps, key `0acdffb7058254ea`, source `7c4ba012d1e90ca09abf5ca7c2ac3aa3a291c51b1f3792f7010691b0c14bd197`. The restarted port 4123 server serves manifest/index HTTP 200. The unchanged Wasm jobs-1 sequence passes FitNotes 39, Mihon app 17 and Komikku 23 steps: 3/3 flows, 79 steps, two Android-compared and one smoke, no reported gaps. Final telemetry has 221 healthy process snapshots, advancing completed rendering, observed AOT maxima 264/265/337, no new missing/native requirements, timeout, wedge or unexpected runtime/browser errors. Komikku's declared guest SQLite 28/284 logs remain and are preserved in raw runs. An earlier three-flow pass predates the read-only-window guard and is not the final-source gate. The bounded owner probe covers startup, not a standalone full flow. No timing comparison follows from shared-host captures. Evidence: `webdroid-shots/y2-s5-endpoint/sqlite-final-browser/`, `sqlite-final-telemetry.json`, `sqlite-final-manifest.json`, `sqlite-final-aot-build.log`, core/typecheck logs and `sqlite-owner-probe.{ts,json,log}`. Owned drivers and server are stopped.

Finalize/close review correction: session statement tokens are retired at validated finalize dispatch, including bundled `nativeClose`, even if a post-destruction error is thrown. Canonical statement ownership is removed in `finally`; a close_v2 zombie retains file ownership until its last statement is finalized. No snapshot query reaches an unusable zombie database pointer. Requests on its closed connection or statements are rejected before execution, while remaining finalizers are allowed. The JNI finalizers still ignore SQLite's previous-evaluation return code, matching the existing AOSP behavior; no new JNI exception is introduced for that result. SQLite documents destruction even on error ([finalize](https://www.sqlite.org/c3ref/finalize.html)) and the unusable zombie lifetime ([close](https://www.sqlite.org/c3ref/close.html)). Five selected core checks pass (56 assertions) and full typecheck passes. The added existing-fixture case exercises both driver families: a real constraint failure produces finalize code 19, a diagnostic injected after actual destruction throws, its error survives, reuse is rejected and death does not finalize that pointer twice. It also checks release-only behavior and file ownership across zombie close. Evidence: `webdroid-shots/y2-s5-endpoint/sqlite-finalize-test.log` and `sqlite-finalize-typecheck.log`. The 3/3 browser sequence above predates this correction; AOT must be rebuilt after integration, and no post-correction browser gate is claimed.

This is one canonical mutable-store contract. VFS/FD coherence (including the documented cross-process stale read/writeback risk), preferences, settings, accounts, permissions, notifications, cookies, alarms/pending intents, controlled clocks and presentation/WebView still need their Worker contracts. The sql.js owner runs on the page and synchronous C operations still occupy that realm. No process JVM Worker is enabled and no S5/full-matrix or idle performance acceptance is claimed.


### 4.4 Do not trust

Any speed claim for the prototype except those in 4.7, which are measured on a loaded host and carry their spreads. The remaining timing evidence is the microbenchmark table in 1.1 to 1.4.


### 4.24 Y2: canonical CookieManager commands (2026-10-05)

CookieManager uses six typed, acknowledged commands on the existing reverse process port. The broker resolves the package from its bound PID; no package selector or jar object travels with the request. The page's existing WebCookies remains the sole owner, so CookieManager writes, WebView network/document reads and same-package processes observe the same jar. Get, set, acceptance, existence, removal and persistence all use that owner. The JVM waits for a write's result before posting its ValueCallback on the main looper. Local fallback uses the same operations and keeps tough-cookie loading lazy. A process death check runs after asynchronous jar loading and immediately before any operation; a dead caller cannot perform a late mutation, while surviving callers retain their jar.

The existing Chromium process-port fixture now sends these commands from a real Worker and checks shared reads, package isolation, HttpOnly document filtering, shared acceptance policy, session-only removal, persistence, watcher notifications, pending/future rejection on death and surviving-owner visibility. The existing data fixture checks actual CookieManager JVM suspension and main-looper callback delivery after a delayed owner acknowledgment, then getters, denied writes and removal. Both selected core checks pass (12 assertions); full typecheck and diff check pass. Evidence: `webdroid-shots/y2-s5-endpoint/cookie-{port-test,manager-test,typecheck}.log`.

This converts CookieManager's store access, not WebView presentation. WebView still receives the live jar and watcher functions in its iframe realm; its page-owned renderer, cookie notifications and network/document adapters need explicit Worker contracts. Other stores and FD/mapping coherence remain open. Parent owns `guest-clock.ts` and `shell/clock-port.ts`; Y2 will wire its provided API into process bootstrap. No JVM Worker is enabled, no new app/AOT acceptance is claimed, and integration requires a fresh AOT build before browser verification. No owned browser/server driver is running.


### 4.25 Y2: owned clock/bootstrap handoff (2026-10-05)

Parent clock API `88dc1058` is integrated in Y2 as `8a8046c9`. `ProcessBroker.bootstrap(pid, true)` now includes its ClockBootstrap and retains that clock's close callback with the archive owners. `bootstrapTransfers` lists archive, split and optional clock ports at both the initial structured clone and the Worker hop. Replacement closes the previous owner set; failed initial handoff closes only the unpublished set; process death closes all retained ports explicitly. Terminating a Worker alone cannot substitute for that broker cleanup. Default iframe bootstrap requests no clock port and keeps its existing direct clock bindings. Broker service/alarm timer ownership is unchanged.

The registry/APK loader is extracted from the iframe entry into `shell/process-bootstrap.ts`, preserving the existing packed/raw own-package, lazy foreign-package and split-loading branches. The iframe now calls that shared implementation. Clock descriptors and their transfer list live in a small module with type-only archive dependencies, so a Worker startup can receive its clock before loading the JVM package loader.

The existing Chromium archive fixture exercises the actual broker clone followed by a Worker postMessage using the same transfer list. Its Worker attaches the clock before archive loading and startup timers. Uptime, wall time and page origin agree; a microtask schedules a nested same-time timer before acknowledgment. Explicit broker death after Worker termination cancels the remaining process callback and preserves a scheduled system timer. Replacement/failure/death close four clock owners with zero remaining callbacks. The existing endpoint/cookie fixture also passes. Two selected browser core tests pass (nine assertions); full typecheck and diff check pass. Evidence: `webdroid-shots/y2-s5-endpoint/bootstrap-{clock-test,endpoint-test,clock-typecheck}.log`.

These are bootstrap contracts, not a booted application JVM Worker. The production entry still uses an iframe; a real Worker entry must attach the clock before Java/time/timer initialization, transfer the reverse/endpoint ports, register diagnostics and close its broker owners on death or failed publication. Canonical FD/mapping coherence, remaining mutable stores and presentation/WebView adapters remain prerequisites. Parent may own a disjoint settings contract; Y2 retains process/bootstrap wiring and leaves clock files unchanged. No new AOT/app gate or performance result is claimed; rebuild AOT after source integration before browser verification.


### 4.26 Y2: canonical Clipboard commands and registration ordering (2026-10-05)

ClipboardService now gets, sets and registers listeners through three acknowledged reverse-port commands. The broker binds the caller PID; its existing foreground-UID access policy and canonical Parcel owner remain authoritative. Reads await a nullable result instead of treating a pending Promise as a present clip. Writes and listener registration complete after the broker acknowledgment; listener callbacks still enter the receiving process's main looper. Local synchronous transports retain their immediate path. Process transport setup stores lazy operation closures, so it does not acquire a reverse port before foreground registration.

Parent CookieManager ordering fix `e38f3b10` is integrated as `fcced894` before this verification. A regression in the existing browser endpoint fixture calls connectProcess before PID 1000 exists, then registers it and successfully uses both cookie and clipboard commands. The real Worker clipboard contract checks canonical reads, independent wire/read buffers, foreground-UID denial and access after changing foreground, listener registration/removal, clear notifications and surviving access after the writing Worker dies. The existing data fixture exercises actual ClipboardService Java calls over MessageChannel, including a delayed write acknowledgment, absent asynchronous reads, text/Parcel round trip and clear. The CookieManager acknowledgment check remains green. Three selected core tests pass (22 assertions), full typecheck and diff check pass. Evidence: `webdroid-shots/y2-s5-endpoint/clipboard-{port-test,cookie-jvm-test,typecheck}.log`.

This converts another direct broker/store coupling; it does not enable an application JVM Worker. Parent owns canonical settings and its broker registration; Y2 retains bootstrap/Worker wiring and the other remaining stores/presentation contracts. FD/ashmem backing and mapping coherence remain open (4.22). No new app capture, source-matched browser gate or performance result is claimed. Rebuild AOT after integration before app verification; no owned browser/server capture driver is active.

## 5. Unverified facts the executor must check first

Resolved on 2026-10-04 with `research/wasm/probe.mjs` and `probe-tiering.mjs` (matrix and versions in
`research/wasm/platform-status.md`). Still open after that pass:

- Firefox is out of scope (decision 2026-10-04); no non-JSPI mode is built.
- Mobile memory64 caps, `call_indirect` vs `call_ref` cost at scale, TeaVM/J2CL/Hoot lessons (not probed).
- Code caching in headed Chrome (headless showed none, below).

Resolved: the V8 max function body is about 7.65 MB (not 128 KB) and 50,000 locals; the main-thread sync-compile limit
is 8 MiB in Chrome (none in the WebKit build); custom descriptors are flag-only in Chrome 153; JSPI, GC, exnref EH,
tail calls and `wasm:js-string` are present in Chrome 151/153 and the WebKit build; the WebKit build lacks memory64,
multi-memory and relaxed SIMD; runtime-built modules were not code-cached in headless Chrome.

## 6. Gates (run before the stage that depends on them)

| Gate | Question | Method | Pass condition |
|---|---|---|---|
| G1 | Is Wasm GC faster on real Java code than the JS tier? | Finish the prototype; run jbench workloads (listAddGet, listIter, mapInt, deque, sort, linkedList, treeMap, random, casts, jsonParse) on identical DEX in both tiers, `--jobs 1`, idle host, steady state and first call. Also test floats as bits vs `f32`/`f64`, explicit checks vs none. | Steady state at least 1.3x faster geometric mean and no workload more than 10% slower; first-call time not worse |
| G2 | Does correctness hold? | Per-method differential execution against the JS tier on framework.jar and Mihon/FitNotes, `fwtest`, conformance suites | zero unexplained diffs |
| G3 | Is cold start better? | Build platform modules ahead of time; time launch to first draw on FitNotes/Mihon/Calculator with `lat` cold and warm | at least 30% lower cold-call compile time; no gated tap above 150 ms |
| G4 | Does tier-up behave without OSR? | Loop kernels called once; measure baseline vs optimized; try back-edge re-entry and compilation hints | hot-loop methods reach optimized speed within 100 ms |
| G5 | Is the host boundary cheap enough? | Count crossings per tap from a profile; microbench strings (JS vs struct), byte arrays, accessors | crossings under 5% of a heavy tap |
| G6 | Boot image | Serialize the post-init framework heap; time the loader | loader under 50 ms for the boot heap (hypothesis), `clinit` time drops |
| G7 | Browser matrix | Run JSPI, GC, EH, tail calls, builtins probes in Firefox and WebKit builds in `~/Library/Caches/ms-playwright` | a documented support matrix; decide whether a non-JSPI mode is required |
| G8 | Linear-memory trigger | Only if G1 fails or S1 attributes hitches to same-process threads | decision recorded in docs/decisions/ |

### G7 result (2026-10-04, Chrome 153, Chromium 151, WebKit 2359; Firefox not measurable)

Supported on both measured engines: Wasm GC, exnref and legacy EH, tail calls, `wasm:js-string` builtins, JSPI
(including the rule that suspending through a JS frame throws). Chrome-only of the features probed: memory64,
multi-memory, relaxed SIMD. Do not use those on the default path. Custom descriptors are not shipped (flag-only).
**A non-JSPI mode is not required for Chrome or the WebKit build.** Firefox is out of scope, so no fallback is built. Details in `platform-status.md`.

### G2 result for `fwtest` and the conformance suites (V1, 2026-10-04)

Nine conformance suites (404,112 tests on the Wasm tier) against their baselines and the JS tier: 0 regressions, 0 unexplained differences, 9,248 differences pinned with their mechanisms (about 3,000 where the JS tier is wrong, 6,100
where TestNG's data providers meet libcore's `GenericArrayTypeImpl`, about 1,000 behind C3's entries on strands, 60 behind B3's pinned-array addresses). `fwtest`: all 31 exercises pass, none pinned (B3, B2, C3), native coverage 646 of 791 as on the JS tier.
Details and the fixes it took: 4.15. The per-method differentials on framework.jar and the apps are 4.4b's (`sweep`, `libdiff`).

### G2 serial coverage recovery (2026-10-05)

The recovery run executes all nine required conformance suites serially with `--jobs 1`, retaining both tiers' raw output. Its aggregate and source epochs are in `conform-cache/g2-full-loader-fix/final-results.json` and `conform-cache/g2-full-c664d867-local/source-epochs.json`; each suite has a `.log`, `.json` audit and per-class `.wasm.txt`/`.js.txt` files. The successful full time rerun is under `g2-full-loader-fix`; the other eight suites are under `g2-full-c664d867-local`. The initial failed time capture and incomplete source-boundary capture are retained separately and excluded from the final aggregate.

| Suite | Raw pass | Raw fail | Skipped | Pinned divergences | Wasm baseline names absent | Runtime source |
|---|---:|---:|---:|---:|---:|---|
| guava | 368,772 | 22 | 0 | 2,771 | 0 | `c664d867` |
| jsr166 | 3,209 | 2 | 0 | 73 | 0 | `c664d867` |
| ojluni-time | 30,819 | 6 | 0 | 2 | 10 | `4a040a08` |
| luni-util | 2,347 | 239 | 0 | 22 | 0 | `3c6da02a` |
| luni-io | 1,301 | 129 | 0 | 131 | 124 | `3c6da02a` |
| luni-nio | 2,712 | 103 | 0 | 0 | 0 | `4a040a08` |
| luni-nio-file | 182 | 13 | 0 | 9 | 0 | `4a040a08` |
| luni-net | 813 | 79 | 0 | 1 | 0 | `4a040a08` |
| luni-security | 715 | 6 | 0 | 0 | 0 | `4a040a08` |

All nine suites exit 0: **410,870 raw pass records, 599 raw failure records, zero skips**, over 976 classes; **zero regressions, zero unexplained differences, 3,009 pinned divergences**. Every class emits a result marker on both tiers. Separating eight class setup/synthetic validation records leaves **411,461 ordinary case outcome records: 410,870 pass and 591 fail**. The eight records are two JSR166 synthetic warnings, the two IO private-suite validations, one GB charset encoder class-initialization failure, two security initialization null failures and one security constructor warning; only IO has passing baseline names among these classes. They remain explicitly reported, not successful test bodies. Their audit is `conform-cache/g2-full-loader-fix/non-case-failure-records.json`. Existing failures include missing test resources, unsupported charsets, absent `sun.nio.ch.Net.pollinValue`, filesystem watch/security limits and multicast environment requirements; these successful suite exits do not claim those operations pass. Six security failures are shared by both tiers. The tightened comparator replay over all nine saved captures also exits 0 with unchanged pin counts.

Coverage accounting is independent of unique test-name comparison: repeated provider names contribute separate raw executions. The TestNG adapter recovers 6,123 executions without changing generic reflection types. A subsequent canonical loader-startup repair recovers all 1,537 raw cases from the four classes previously losing 1,536 baseline names. Full time now reports 30,819 pass, six fail and zero skipped, with zero unexplained differences. Three existing Coptic service-loader/serialization failures occur on both tiers; the other three failures are clock timing checks, with the existing timing pins retained.

The remaining missing baseline names are explicit limits:

- **IO: 124 Wasm-only names**, 59 in `OutputStreamTesterTest` and 65 in `WriterTesterTest`. Both classes declare private `suite()` methods. Real JDK `getMethod("suite")` rejects them and JUnit emits the same solitary “No runnable methods” validation result as Wasm; current JS improperly exposes their private suites. The existing pin covers this exact mechanism. This remains absent baseline execution, not 124 passing cases. Evidence: `conform-cache/g2-io-private-suite-jdk.txt`.
- **Time: 10 names absent on both tiers.** All eight date-dependent hashes were reconstructed from four chronology rows evaluated on two earlier dates; the four rows execute with today's date. Two other hashes differ only in the printed iteration order of preferred-zone sets, whose cases execute and pass. Evidence: `conform-cache/g2-missing-name-audit.json`. No baseline waiver or edit was made.

The comparator now rejects class setup coverage loss independently of both-tier agreement. A class-wide pin reason must come from an explicit class result or a solitary JUnit validation result; an arbitrary collection of failing tests cannot lend its first reason to all missing names. Only the exact single pinned private-suite validation is exempted. Negative checks include a mixed failure and an additional validation cause; injecting a new setup failure into both tiers of the saved IO output exits 1 with one regression for 65 lost baseline rows. The final saved-output replay uses this tightened comparator rather than claiming a new VM run.

The captured runtime source epochs are `c664d867` for Guava/JSR166, `3c6da02a` for util/IO, and `4a040a08` for the successful time rerun and nio/nio-file/net/security. The numeric DEX-ordering merge occurs before the latter suites; the startup repair occurs after util/IO. No later parent main, G4 continuation, final S4/S5, or the parent's `64622fec` reflection-cookie fix is included in this cut. No broad repeat is claimed against that later source.

Startup evidence at `4a040a08`: the real JDK/cold-Wasm fixture passes 16 checks, the four affected time classes pass 1,537/1,537, classdiff passes 33/33, customdiff passes 375/375, loader checks and three initialization race/cycle/failure checks pass, and typecheck passes. A bounded fresh-World diagnostic uses the real app AOT emitter and loader, includes and installs `threadLoaderReady` from `s0.wasm`, and passes the four loader checks. Its source and output are `conform-cache/g2-loader-aot-probe.ts` and `.log`. It does not reproduce the parent’s reported Mihon overflow or establish full integrated browser correctness. Shared-host suite wall times are execution evidence, not idle-host performance measurements. G2 remains open for final integrated browser and source-cut acceptance.

### G4 hint result

Compilation hints do not work in shipping Chrome. The `compilationHints` section (and
`metadata.code.compilation_priority`) is ignored by Chrome 153 and Chromium 151, with and without
`--js-flags=--experimental-wasm-compilation-hints`: tiering is identical for every hint value and a section with the wrong
count is accepted. The encoding itself is right: Node 24 (V8 13.6) with the flag honours it (`0x2a` compiles the function
with TurboFan at module compile, before the first call; a wrong count is a CompileError). The G4 mechanisms to use in Chrome are
therefore back-edge re-entry (outlined loop bodies called repeatedly) or ahead-of-time choice of which functions get
eager optimization by other means; hints are not an option until V8 ships them. Gate G4 itself (kernels reaching optimized
speed within 100 ms) remains to be run with the S1 compiler.

### G3 and G6 result (X1, 2026-10-05; section 4.18)

G3 is not met: FitNotes on the Wasm tier launches in 1.74 to 1.87 s warm and 2.15 to 2.55 s cold (2.9 to 3.0 s when the app's build has to be made on the device) against 1.25 to 1.28 s and 1.68 to 1.78 s on the JS tier, from 3.53 s and 4.06 s;
Calculator M 1.81 to 1.89 s warm, 2.76 to 2.97 s cold (from 4.1 and 5.6 to 5.95 s); no gated tap above 150 ms (max 33). G6 is not pursued: Java execution is 12 ms of the zygote's 453 ms and 141 ms of the 845 ms after it, a free image saves 8% at
most and would still instantiate the class module of every class it restores; the cost is module loading, which the image cannot remove.

## 7. Staged plan

Each stage lists deliverables and acceptance. A stage does not start until its gates pass. Keep the JS tier working
on every commit; the Wasm tier is selected per process with a flag (`?tier=wasm`) until the last stage.
Follow AGENTS.md verification at each stage (`typecheck`, `test`, `smoke` with zero method failures, `fwtest`,
`e2e`, `lat`).

### S0. Baseline and instrumentation
- Move the prototype's shared pieces into a real module location behind a flag (done in P0: `src/wasm`, `?tier=wasm`); keep `research/wasm/` as history.
- Add counters to `lat`/`run.json`: host crossings per tap, wasm vs js time, module count, baseline-compiled functions.
- Record JS-tier baselines for jbench, `lat` (cold/warm), launch profiles and heap size per app.
- Fix the `mandel`/`collatz` mismatches and add a differential test harness (JS tier vs Wasm tier per method,
  random inputs, plus DEX-level fuzz on instruction sequences). *Done except DEX-level fuzz: see 4.3.*
- **Accept:** G2 harness runs on `W.java` and the jbench classes with zero diffs. *Status: zero diffs on `W.java`
  (against the JDK and the JS tier) and on 87 compiled AOSP library statics; the 42 jbench workloads compile but every
  one stops at its first gap (strings, then class objects, per the 4.3 table), so they have no result to diff yet.
  The acceptance closes when the S1 string and class-object work lets `bun jbench.ts` report MATCH.*

### S1. Core compiler to a closed set
- Finish opcodes: strings (const-string, String ops via the chosen representation), class objects, monitors,
  `invoke-polymorphic`/`invoke-custom`, `filled-new-array`, `fill-array-data`, interface default methods, all array
  types and `ArrayStoreException`.
- Class init protocol with concurrent-init and cycle rules; `<clinit>` guards on static access and `new`.
- Exceptions: stack trace capture via the name section plus a code-offset to DEX-pc table; `StackOverflowError`
  from `RangeError`; OOM via a byte budget counter.
- Type inference from `dexstats/infer.ts` productized, with per-web locals. *Done (4.5).*
- Run G1 (the float sub-question is answered in 4.5; the Wasm GC speed gate needs the string and class-object work first).
- **Accept:** jbench workloads on AOSP library bytecode run in Wasm with the same results as the JS tier; `smoke` on
  FitNotes reports zero method failures in Wasm mode.

### S2. Runtime on Wasm (single process, no suspension yet)
- Object/class model from 3.1 as the VM's own representation: loader, linker, vtable/IMT builders, reflection
  descriptors, `Class` objects, Unsafe/VarHandle as field-id based operations, Proxy through descriptor trampolines,
  identity hash and monitors in the header, weak/soft/phantom references through `WeakRef`/`FinalizationRegistry`.
- Generated accessor layer and ABI for natives (3.5); replace `getDeclared`-style helpers and `vcall` internals;
  add the lint against direct property access on Java objects.
- Convert natives in the order: primitive-only (1,014), reference-through (759), then the field-touching 711, starting
  with the ten files that hold 858 of the field sites.
- **Accept:** `fwtest`, `desccheck`, and the conformance suites (`guava`, `jsr166`, `ojluni-time`, harmony suites)
  match their baselines in Wasm mode. *Status (V1, 4.15): the nine suites run on the Wasm tier with 0 regressions against their baselines and 0 unexplained differences from the JS tier (9,248 pinned, each with its mechanism);
  `desccheck` is clean; `fwtest` passes all 31 exercises; the pins attributed to B2, B3 and C3 were deleted after the merge.*

### S3. Suspension and threads
- One `promising` stack per Java thread; blocking operations (monitor contention, `wait`, `park`, class-init waits,
  binder transactions, sleep, I/O) are `Suspending` imports; scheduler picks which thread resumes.
- Back-edge fuel checks and the "yield to the browser" rule from `yield.ts`; main-thread queue ownership and
  `onMain` rules preserved.
- Replace the 403 `driven` natives: Wasm, or async TS under `Suspending`.
- If G7 requires a no-JSPI mode, implement the unwind/resume transcription for that browser only.
- **Accept:** lifecycle order matches the reference AVD EventLog on gated flows; `lat` passes cold and warm;
  suspension counters per tap go to zero frame saves.

### S4. Tiers, linking and delivery
- Wasm DEX interpreter as the cold tier and deopt target; promotion by call count/back-edge count; module-per-class-group
  linker with shared table and lazy-link stubs; CHA guards and invalidation.
- Build-time AOT of boot jars and `framework.jar` into static assets with caching; install-time compile of app code in
  workers; persistence of the compiled form per APK hash.
- Back-edge re-entry for hot loops (G4).
- Boot image (G6) if the gate passes.
- **Accept:** G3 passes; launch-to-first-draw and cold-call counts improve against the S0 baseline on FitNotes, Mihon,
  Calculator M, Komikku; `e2e` quick gate green.

### S5. Process model and boundary clean-up
- Process-per-Worker with serialized Parcels; enumerate and convert the direct broker/font/file/clock accesses.
- Move byte-moving natives to copy-in/copy-out or into Wasm.
- JNI handle tables against the new object model; ARM/A64 core entry points through handles.
- **Accept:** `e2e --full --jobs 1`, `corpus`, and the cross-site WebView checks pass; p99 present interval at 4x
  throttle improves or holds.

### S6. Make Wasm the default, remove the JS tier
- Run the full matrix (`e2e --full`, `--live`, corpus, `lat --warm`, `conform` suites, fuzz differentials) with the
  Wasm tier as default; keep the JS tier one release as an oracle behind a flag, then delete it with
  `compiler.ts` emission, `tiering.ts`, `suspend.ts`, `cold.ts`, `codecache.ts` JS persistence.
- Update docs: AGENTS.md architecture section, PLAN.md, bytecode-first-plan.md, decisions record.
- **Accept:** no regression versus the S0 baselines on any gated metric; goldens unchanged.

### Conditional stage L: linear-memory VM
Only if G8 triggers. Reuse S1 (front end), S3 scheduling shape, S4 delivery; replace S2's object model with a
linear heap, add a generational collector with a write barrier and a safepoint protocol, and add worker threads.

## 8. Instructions to the executing agent

- Do not restate difficulty or duration; each stage is accepted by its gate, nothing else.
- Re-measure before trusting any number in section 1; those were single runs.
- Keep every Wasm-specific decision (floats as bits or typed, string representation, field-accessor ABI, hint
  encoding) behind a small interface so a gate result can flip it without a rewrite.
- When a gate fails, write the measurement and the mechanism in `docs/implementation-history.md` and either change
  the design in this file or take the alternative in 3.7; do not weaken the gate.
- Respect AGENTS.md: no app-specific substitutes, no fabricated success, unchanged bytecode, goldens unchanged,
  serialized timing runs.


### 4.27 Y2: Worker command attachment before JVM initialization (2026-10-05)

Worker bootstrap now transfers a PID-bound reverse command port together with archive and clock capabilities through both hops. The broker retains its exact close callback; replacement, failed initial clone and process death retire command owners through the existing caller-port registry. Iframe bootstrap leaves its lazy reverse-port path unchanged.

`attachWorkerBootstrap` attaches time before dynamically loading natives/JVM modules, sets the actual process PID, UID and name, and installs SQL, cookie and clipboard bindings from the received command proxy without consulting a parent window. Failed attachment closes only the received bootstrap capabilities; duplicate clock attachment does not dispose the previously attached clock. This entry is an attachment contract, not application boot or a Worker enablement switch.

Two selected existing Chromium core fixtures pass (11 assertions), and full typecheck and diff check pass. The bootstrap fixture invokes the production attachment function in a real Worker, observes JVM identity and canonical cookie/clipboard commands, and retains origin, nested controlled-timer acknowledgment, system-timer survival and owner teardown coverage. The endpoint fixture remains green. Shared build chunks preserve one guest-clock module identity across fixture entry points. Evidence: `webdroid-shots/y2-s5-endpoint/worker-commands-{core,typecheck}.log`.

Application entry still uses an iframe. Incoming JVM endpoint publication, remaining canonical stores, FD/ashmem coherence and presentation adapters remain required. Parent owns settings/device and the settings callback registration; Y2 will preserve that binding when integrating the parent API. No AOT/app gate or performance result is claimed. No owned browser/server capture driver is active.


### 4.28 Y2: Incoming Worker JVM endpoint (2026-10-05)

Parent settings owner `7302c49c`, bootstrap `264d307c`, selector `29f9c2b6` and Clipboard `3e997b5d` are integrated by Y2 merge `bc5827ce`. Settings remote binding is installed by the common command-transport helper, so a Worker attaches it through its received reverse port. Parent's root direct store, bootstrap-time subscription, four allowed commands, notification callback and PID death cleanup are preserved. An initial merge fixture omission lost its settings-notification variables; restoring those parent fixture variables resolves both the browser ReferenceError and TypeScript errors. No production settings behavior was changed to resolve that test failure.

The JVM endpoint handlers are extracted into `createProcessEndpoint`, independent of the live broker/store setup in `connectProcess`. The iframe uses this same factory with its existing activity-result map. `serveWorkerEndpoint` loads the factory in the attached Worker and serves its received local port; the peer is transferred to the page's existing `readyPort` owner after initialization. Startup failure closes an unpublished serving port and preserves the original error.

Two existing Chromium core fixtures pass (11 assertions); TypeScript, full typecheck and diff check pass. The archive/bootstrap Worker uses the production time/identity/command attachment and now the real JVM endpoint factory. The page publishes its transferred endpoint, awaits settings-change and package-removal handlers, then verifies ordered timers and explicit broker death cleanup as before. The existing endpoint/clipboard/settings fixture also passes. Evidence: `webdroid-shots/y2-s5-endpoint/worker-incoming-{core,tsc,typecheck}.log`; integrated settings checks: `worker-settings-{core,tsc}.log`.

No application Worker is enabled: the production entry remains an iframe. A Worker activity transport must share its result-delivery map with the endpoint; Java exit must report its real death record and close owners, and remaining stores, FD/ashmem coherence, diagnostics, input/presentation and WebView adapters are still required. The clock and settings owner files remain parent-owned. No app/AOT acceptance or performance claim; no owned browser/server capture driver is active.


### 4.29 Y2: Worker activity commands and local result ownership (2026-10-05)

Attached Workers now bind activity launch, finish and presentation to three PID-bound broker commands. Intent values use AOSP Parcel encoding; callbacks and request IDs stay in the requesting VM, shared with its incoming endpoint. Results retire their callback before decoding/delivery, duplicate replies are ignored, and a failed launch acknowledgment retires the unpublished callback. Closing the reverse port clears outstanding result callbacks. The iframe retains its existing direct ActivityStack binding.

Launch/finish commands acknowledge queueing in the canonical ActivityStack, not completion of its lifecycle work. Waiting for completion would keep the caller's launching main job pending while the same process must answer pause. The broker checks the bound caller before queueing and retains the existing serialized stack and error handling.

One existing Java data fixture passes seven assertions with real AOSP Intent encoding/decoding: independent parcel identity/action, delayed acknowledgment, a reentrant result before acknowledgment, duplicate suppression, and callback retirement on denial. An initial Bun rejects.toThrow matcher hung; explicitly catching and checking the same transported error passes. Two existing Chromium endpoint/bootstrap fixtures pass 11 assertions; full typecheck and diff check pass. Evidence: `webdroid-shots/y2-s5-endpoint/worker-activity-{java,core,typecheck}.log`.

No application Worker is enabled yet. Canonical exit records and teardown, remaining stores, FD/ashmem coherence, diagnostics and input/presentation/WebView remain open. No fresh AOT/app gate or performance claim.


### 4.30 Y2: Canonical Worker exit history and teardown (2026-10-05)

Activity command milestone `09fa6277` is merged with parent source through `d9087293` by `63283310` (including parent-integrated Worker bootstrap/endpoints and settings). Workers now publish their actual AppExitInfoTracker record through a PID-bound reverse notification. The page overwrites identity from the registered entry, computes repeat-crash policy against current canonical history, persists using the existing 16-record owner, then invokes canonical broker death cleanup with the resulting crash/repeat flags. Worker record creation remains synchronous during exit; no Worker localStorage history is authoritative. The page's existing direct recording path remains unchanged.

Historical process-exit queries use an optional async owner transport and the real Java ActivityManagerService awaits it before constructing ApplicationExitInfo. The broker additionally enforces same UID or canonical DUMP permission. The default page path still reads synchronously. Worker-local crash notes can carry a provisional dialog value; the canonical stored/death value is computed by the owner, so future serialized diagnostics must use that owner result.

Bootstrap registers exit cleanup after the existing AppExitInfoTracker listener: the record notification is posted first, followed by closing received clock/archive/command capabilities and clearing local activity-result callbacks. Reverse-port close retains the closed proxy so post-death host calls reject rather than trying to reacquire a parent-window broker. Endpoint lifetime is closed by canonical broker death after persistence, avoiding a competing endpoint-close notification that could otherwise mark the process non-crashed first. Forced host Worker termination still requires explicit broker failure; MessagePort peer termination is not a death detector.

Five selected existing core checks pass (37 assertions), full typecheck and diff check pass. The real Chromium Worker receives a crash kill note through its JVM endpoint, exits through process-exit, and its canonical record has the registered PID/UID/package/process, crash status and repeated-crash flag. A surviving owner reads copied history; wire mutation does not change the stored description. Process timer ownership closes while a root system timer survives. Existing clipboard/settings/endpoint checks remain green. The Java activity fixture also delays canonical history reads and checks a real ApplicationExitInfo PID/reason after acknowledgment; clipboard/cookie Java checks pass after restoring all fixture-global transports. Evidence: `webdroid-shots/y2-s5-endpoint/worker-exit-{core,java,tsc,typecheck}.log`.

The application entry remains an iframe. Remaining prerequisites include canonical accounts/preferences/permissions/notifications/VFS and pending-intent/service state, FD/ashmem mapping coherence, serialized diagnostics and Worker presentation/input/WebView. Accounts is a proposed disjoint parent slice: shell/accounts.ts and android/accounts.ts plus a focused fixture; export typed owner commands/async access and a local accountsChanged notification, retaining credential and authenticator ownership and avoiding whole-table snapshot writeback. Y2 retains process/broker wiring, Worker boot, activity/exit and presentation; parent keeps existing settings/clock owners. No fresh AOT/app/performance gate is claimed.


### 4.31 Y2: Bounded Worker frame ownership and page presentation (2026-10-05)

Device presentation now accepts a complete-frame sink; the default HTML canvas remains synchronous. An attached Worker can supply a frame port instead. The sender retains at most one transferred request and one newest pending bitmap; replacement closes the superseded pending bitmap and resolves its presentation false. An acknowledgment follows actual page sink consumption; only successfully consumed frames increment presentation/first-frame state. Sink errors are returned to the producer and logged by the device path; closed process/display owners reject pending and future submissions and close retained bitmaps. No partially drawn canvas crosses the boundary.

Bootstrap optionally publishes a display port for an entry with a page canvas, includes it in both transfer hops and retains its exact receiving close callback with archive/clock/command owners. Failed construction creates the sink before allocating a channel. Worker attachment selects the asynchronous sink after attaching time/identity; failed startup and process exit explicitly close the sender before its raw received capabilities. Broker death removes and releases the page canvas. Creating actual Worker entries and their input/IME/visibility/diagnostic adapters is still required; this does not change the iframe entry selector.

Two existing Chromium core fixtures pass (12 assertions), full typecheck and diff check pass. A real Worker transfers red/blue snapshots while a middle frame is replaced, then changes the source canvas to yellow; received pixels remain red/blue. Bitmap detachment/release, changed dimensions, sink-error propagation, pending/future close rejection are checked. Actual broker replacement, failed initial handoff and independent death close four display owners with future rejection, alongside the existing archive/clock/command checks. The production Worker attachment receives its optional display port and exits with canonical cleanup. Initial fixture-only failures were a split-build dynamic import path and transferToImageBitmap before creating a context; both were corrected without changing the transport mechanism. Evidence: `webdroid-shots/y2-s5-endpoint/worker-frame-{core,tsc,typecheck}.log`.

No application JVM Worker is enabled and no app/AOT or performance acceptance is claimed. Input, IME, WebView, diagnostics, remaining canonical stores and FD/ashmem coherence remain open. Parent owns accounts owner files; Y2 will integrate its committed AccountCalls into process wiring.
