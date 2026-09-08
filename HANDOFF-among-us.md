# Among Us on webdroid — handoff

Branch `arm64-rosetta`. Goal (agreed with the user): **local Freeplay playable** — boot to the
main menu, enter Freeplay, a map loads from the 1 GB asset pack, a crewmate moves under touch
at a usable frame rate. EOS/online is out of scope; its failures must be honest network errors.
Approved plan: `~/.claude/plans/launch-the-webview-of-reflective-sketch.md` (Phases 0–7).

Rules from the user: focused commits (`<area>: <sentence>` subjects, trailers
`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and
`Claude-Session: https://claude.ai/code/session_016vf1zmhhmf7oHdRpQrcC7Q`), minimal code, comments
only where needed, nothing hardcoded for this apk, performance first. Only run the full e2e
(`PORT=4090 bun run server.ts` + `WEBDROID_URL=http://localhost:4090 bun run e2e`) at the very end.

## Where it stands

- The A64 tier runs the whole Unity/IL2CPP/EOS/Sentry stack: 60–110 guest threads, Boehm
  stop-the-world GC cycles, EGL/GLES3 rendering over WebGL2. The **loading screen renders**
  (logo + progress bar, screenshot in the scratchpad `menu4.png`), the menu logic reaches
  `ControllerManager` menus (DisconnectPopup, PrivacyPolicy), servers/DNS fail honestly.
- Stability: after the signal/frame fixes (commit f1ff695) six of six "stall catcher" boots pass
  under both the traced and plain configurations. Before them ~1 in 3 boots died at ~20 s with
  `ClassID … conflicts` (a double engine init) or a wedged world-stop.
- **Performance is the blocker.** Peak ~8 fps right after the menu loads, then it collapses to
  ~0.5 fps. Root cause measured (see "GC storm"): too many compiled blocks → V8 code space /
  full-GC thrash. A cold-code interpreter tier is written but not finished (see "Uncommitted").
- Boot: ~30 s to the first frame, the 1.1 GB asset pack is still fetched whole into the page
  (Phase 3 not done).

## Commits landed this session (newest first)

- `f1ff695` native: a signal reaches the innermost frame on a clean stack, and host code calling back into the guest waits below a handler
- `0589e9a` native: a new thread keeps the process's compiled blocks, mprotect does not drop them, and an invalidation clears only the caches that point at its page
- `70389f0` native: a buffer's kind is decided at its first typed bind, a mapping belongs to its buffer, and negative host results sign-extend
- `daa15ad` notes: the SIMD oracle build directory is output
- `ae9b81c` native: signals reach a thread where it is, futex, key destructors, and the debug surface names what a run did
- `6e093b9` mem: address planes — a 64-bit process reserves past the buffer and commits into contiguous, relocatable runs
- `8941e9e` native: EGL, GLES 3 and the NDK as closed host libraries, one WebGL2 context per EGL context
- `12e8b1a` jvm: java.lang.reflect.Proxy over every interface method, and the Java surface Unity's player reaches for
- `29f55fe` native: three answers that were wrong — an X write aliasing its own low half, the subtracting widening multiplies, and Bionic's sysconf numbers
- earlier: `a5a07a1` (per-looper queues), `be2289d` (dlopen handles), SIMD/FP/LP64 phases.

`bun run typecheck` and `bun run test` (602 tests) pass at `f1ff695`.

## Uncommitted work in progress: the cold tier (interpreter)

Files: `src/native/interp.ts` (new), `src/native/interp.test.ts` (new), edits in
`src/native/a64.ts` (`emitA64Word`), `src/native/cpu.ts` (`coldTier`, `heat`, the `cold` stub,
`look()` promotion, `link()` skip, `runSlice` tolerating the stub, eviction params), 
`src/native/a64.testkit.ts` (`run(words, setup, tier)` sets `coldTier.heat` 0/255),
`src/native/debug.ts` (exposes `coldTier`).

Design: an A64 block entry is interpreted until it has run `coldTier.heat` (8) times, then
compiled as before. The interpreter (`coldRun`) decodes control flow and pc-relative words
natively (B/BL, B.cond, CBZ/CBNZ, TBZ/TBNZ, ADR/ADRP, LDR literal incl. SIMD, BR/BLR/RET, SVC)
and runs every other word through **one `new Function` per distinct instruction word**, built
from the emitter's own single-instruction JS (`emitA64Word`, all flags written). Measured on
the images: unique non-pc-dependent words are 2–4 % of instructions (libil2cpp 0.23 M of 11.2 M),
so the per-word cache is small; pc-dependent words are 18–29 % of instructions.

Status: typecheck passes; the 602 existing tests pass (they force the compiled tier).
`interp.test.ts` (runs four programs through both tiers and compares registers/memory) **fails**:
`[native] udf 0x0 @ 0x0 (test, lr=0x41efff8)` from `coldRun` → i.e. the interpreter read word 0.
Yet the direct script `scratchpad/colddbg.ts` (new Cpu, `look`, `coldRun` by hand) runs the
control-flow program correctly (`next fffef008 r0 10 r1 9 ic 5`). So the difference is in the
test-kit path (`run()` → `runSlice` loop, shared Cpu across tests, the compiled run preceding the
cold run in the same test). Diagnose from there before booting; do not boot with the cold tier
until `interp.test.ts` passes. Then measure (see tooling) blocks compiled, heap, GC, fps.

If the cold tier is abandoned, revert the working tree (`git checkout -- src && git clean -f src/native/interp*.ts`);
`f1ff695` is stable.

## The GC storm (why fps collapses) — measured

- CPU profile in the slow phase: 87–97 % `(garbage collector)`.
- V8 GC trace: **152 MajorGC in 15 s**, reason `allocation failure` / `background allocation
  failure`, 4 marking threads busy continuously.
- Heap snapshot at 70 s: JS heap ≈ 600 MB live: **205 MB InstructionStream (65 k machine-code
  objects, ~3 KB each), 100 MB block sources (97 k), 76 MB bytecode, 47 MB TrustedByteArray,
  52 MB arrays** (`pages` 8 KB per code page, successor caches). ArrayBuffers (4 GiB wasm guest
  memory, 1.1 GB xapk) are external and not the issue; `performance.memory` is coarse/stale —
  use CDP `Runtime.getHeapUsage` / snapshots.
- Per compiled block: ~850 chars of source, ~1.5 KB function, ~3 KB machine code once baseline
  compiled. 200–450 k blocks are compiled per boot; most run once.
- Cold-page eviction (in `cpu.ts`: `EPOCH`/`EPOCH_MS`/`HOT`, `evictCold`) shrinks the live set
  (37 k live) but with `HOT=32` caused recompile churn (450 k compiles, 57 s compileMs) and did
  not stop the storm; it is set to `HOT=4`, 60 s epochs now. The interpreter tier is the real fix
  (cold code never becomes a JS function).
- Also worth doing: shrink emitted JS (inline memory shape is ~70 chars per access), and the
  `pages` arrays (8 KB per code page → a Uint16 index table).

## Other findings fixed on the way (lore for debugging)

- Emitter: `setX` must route a high half computed from the destination's own low half through
  temporaries (ROR/EXTR were wrong); UMSUBL/SMSUBL had product−acc reversed; `sysconf` used glibc
  numbers (Bionic `_SC_PAGESIZE=0x27`) → Boehm ran with a 4-byte page size and its block grid was
  off (objects pushed 0x20/0x50 off their real starts).
- Host boundary: negative host results must sign-extend into x0's high half (a 32-bit −1 read as
  4 GiB "sent" kept `File.Copy` looping on `sendfile`); functions returning a pointer derived from
  an argument return `ptr()`/`ARG0` (plane addresses); `ldp` must treat a zero high half as plane 0.
- Memory: address planes (pointer high half = plane) with contiguous relocatable runs;
  reservations exclusive (the "reserve over RESERVED pages" fallback was corrupting);
  `madvise(DONTNEED)` zeroes (Boehm relies on it) but only inside the arena; a module
  reservation moves plane runs out of its range; `bump()` stops at the pool.
- Threads/signals: `parkedAt` depth (parked only when the innermost frame parked), microtask
  pump for delivery (never inside the sender's host call), host code that calls back into the
  guest waits below a handler frame (this was the `bsearch` comparator + SIGPWR race behind the
  double init), `pthread_once` blocks concurrent callers, key destructors run at thread exit,
  stacks recycled, looper messages held while the thread is inside a native call.
- Blocks: the Cpu constructor flushed every block per new thread (50 threads → 1 M recompiles);
  `mprotect` no longer invalidates; invalidation clears only referrers (`refs` per page).
- GL: WebGL fixes a buffer as element/vertex at first bind; Unity uploads via COPY_WRITE and
  maps two buffers at once → kind decided at first typed bind, shadow until then, mappings keyed
  by buffer (this turned the black surface into the loading screen).
- Java: `Process.killProcess`, `PixelCopy`, `System.getProperties`, per-path inodes (Mono's
  sharing-violation table), `wd.surfaces()`/`wd.probeSurface(i)`.

## Open problems, in priority order

1. **Finish the cold tier** (above), then re-measure: target ≥ 30 fps at the menu, compiled
   blocks ≤ 60 k, no MajorGC storm. If still GC-bound, batch/shrink emitted code and the
   `pages` arrays.
2. **Thread storm**: IL2CPP threadpool grows to 80–110 workers (hill-climbing because work items
   are slow under emulation). Each `pthread_create` cost 300–1400 ms before the flush fix; check
   it is cheap now (`__wdSlowMs`); consider whether `sysconf(_SC_NPROCESSORS_*)=4` vs
   `sched_getaffinity` (`Cores = 1` logged) should agree.
3. **Phase 3, lazy asset pack**: `install.ts`/`lazyfile.ts`/vfs/stdio per the plan; the 1.1 GB
   pack is fetched and held whole today (boot cost and renderer size).
4. **Menu → Freeplay**: nothing has been tapped yet. Use `wd.surfaces()`/`probeSurface`, the
   shell's input, the e2e driver's `tapAt`. Unity reads touches via `nativeInjectEvent`.
5. Remaining named gaps: `java/lang/invoke/MethodHandles$Lookup` (FindClass from il2cpp, warning
   only), `gles3:texture swizzle` (INVALID_ENUM by design), `getaddrinfo` returns EAI_AGAIN at once
   (fine), Sentry `NullReferenceException` in `ScopeCallback` (ignore), `libwebsockets` init
   failure (network, fine).
6. Phase 6/7 deliverables: `tests/e2e/flows/amongus.ts`, corpus, AGENTS.md/PLAN.md rewrite
   (the A64 tier, planes, closed host libs, signal model, cold tier), final typecheck/test/e2e.

## Tooling (scratchpad: `/private/tmp/claude-501/-Users-kunalan-Projects-webdroid/6e76624d-4056-4755-a6c6-a54280823c62/scratchpad/`)

Dev server on port 4090 must be running: `PORT=4090 bun run server.ts &`.

- `boot.ts "Among Us.xapk" <waitMs>` — headless boot; env: `OUT=file.json` (stats+logs),
  `EVAL=<js>` (evaluated at the end), `SAMPLE=1` (frames/instr/cpus every 10 s), `STALL=1`
  (stop when frames stay 0 and instr flat), `SHOT=x.png` [+`SHOTEVERY=60`], `TRACE=<regex>`
  [+`TRACEMAX`] host-call trace (entries carry `=ret`, spin loops collapsed), `LOGS=n`,
  `JX=1` (Java TypeError stacks), `JNICALLS=1` (`[jni-call]`/`[jni-ret]` per Java→native call),
  `CALLLOG=<thread>` (every `call()` frame, park/resume/deliver on that thread),
  `LOGTRAP=<regex>` (logcat line → thread/frames/backtrace), `WATCH=0x..,..` (register dump at
  block entry), `SLOWMS=300` (host calls/slices slower than that), `GLPROBE=1` (+`GLCAPTURE=n`
  per-draw capture), `FREEZE=1` (Debugger.pause + JS stack when the page stops answering),
  `HEAP=1` (accurate heap via CDP), `COUNT=1`, `BT=n`.
- `prof.ts` (`WAIT`, `DUR`): CDP CPU profile top self-time; `gctrace.ts`: V8 GC events with
  reasons; `heapsnap.ts`: heap snapshot by type/name; `liveprof.ts` / `allocprof.ts`: sampled
  live heap / allocation sites; `fnmem.ts`: per-function retained size experiment;
  `nhang.ts <apk> <lib>`: nrun with a MessageChannel watchdog; `colddbg.ts`: cold tier by hand;
  `stagehunks.py <file> <regex>`: stage only matching hunks; `srcsize.ts`: emitted source per block.
- `wd.native` additions: `regs()` (state/loops/depth/parked/frames/sigLog/signals), `killLog`,
  `futexStats()`, `backtrace(name)`, `watchPcs`, `lastFault`, `allBlocks`, `invalidatedPages`,
  `invalidations`, `glRing`, `glProbe.capture`, `gl3` (live GL context/handles), `coldTier`,
  `mem()` (planes/chunks/moves), `blocks` (compiled/invalidated/evicted/compileMs).
- Disassembly: `scratchpad/libunity.dis`, `.so` files under `scratchpad/so/lib/arm64-v8a/`;
  `llvm-objdump -d --start-address=… libil2cpp.so` (text VMA = file offset + 0x4000);
  libil2cpp loads at 0xF8520000 in the shell (from fault messages).

## Measurements to beat

| phase | now |
|---|---|
| first frame | ~30 s |
| menu fps (peak / after 60 s) | 8 / 0.5 |
| blocks compiled per 200 s boot | 250–450 k (37–100 k live) |
| MajorGC | ~10 per second in the slow phase |
| JS heap live | ~600 MB (blocks) |
