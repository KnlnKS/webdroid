# Webdroid status — 2026-10-15

This file tracks where the work stands and what is open. [AGENTS.md](AGENTS.md) defines the working and
verification rules, [docs/architecture.md](docs/architecture.md) the design, [docs/performance.md](docs/performance.md)
how to measure and where the time goes, and the [implementation history](docs/implementation-history.md) the
failure mechanisms, measurements and rejected experiments. Superseded plans and handoffs are in Git history.

## Where things stand

- **Java runs only on the Wasm tier.** The DEX-to-JavaScript tier and the cold interpreter were deleted on
  2026-10-13; there is no other tier to compare against or fall back to. `knlnks/bytecode-wasm` carries the whole
  backend and is about 2,090 commits ahead of `main`.
- **The platform runs from AOSP bytecode** of one API-35 reference build (bytecode-first stages A–F complete):
  libcore, resources, graphics, text, the view stack, windows, `android.content` and ActivityThread, over TS
  system services and natives. 64-bit processes run the reference build's bionic; text measures on HarfBuzz
  (`textcmp` 72/72); Path ops run on Skia.
- **Every app process runs in its own Worker**; the page realm is `system_server`.
- **Code delivery:** the platform is compiled at build time; an app's build is compiled in a Worker after its
  first launch and persisted; bundled builds cover the gate apps; a launch without a saved build compiles likely
  callees in idle time.
- **Latency:** `lat` gates on the first response frame. Every Calculator M, FitNotes and Komikku tap passes the
  150 ms gate cold and warm by median of three runs (re-measured 2026-10-14). Komikku's cold taps are 36–177 ms per run
  (medians 45–128), mostly first-tier Java and on-demand compiling; single runs still exceed 150 ms by up to 27 ms. Compile
  Worker answers wait out the input window. `lat --ecores` measures an about 6× slower device. The 80–170 ms stalls that failed
  earlier runs were the engine freeing merged-away units in one pause, now released in batches (`World.retire`).
  Komikku's warm taps (32–89 ms) are first-tier Java composing the new screen in one `doFrame` (38–61 ms) plus GC
  bursts of up to 30 ms. Heavy apps are reports (`"gate": false`). Scroll p95 is 17.3–17.8 ms with no missed vsyncs.
  Every re-architecture plan item is done, rejected, or measured with nothing to recover
  ([status](docs/perf-handoff.md#plan-status-2026-10-14)). What remains of a tap is the app's own Java, which runs 3.2×
  slower than on ART in Kotlin-shaped workloads; skipping every Wasm cast left warm taps unchanged. See [performance.md](docs/performance.md).
- **Compatibility:** the original 20-APK scope and the 15-app open-source corpus all draw an initial frame; neither
  is established as fully usable. Feature paths were exercised for each corpus app except Thunderbird's account
  setup. The `apks/new` XAPKs (Snapseed, Walmart, Yelp, McDonald's, Tubi) were last worked on 2026-09-27, before
  the Wasm tier, and need re-verification. Google Maps (2026-10-15) draws its vector map, searches, and shows
  places and driving routes.
- **Deployment:** Cloudflare Workers Builds deploys the main app and Pages the isolated WebView renderer from
  `main`; this branch is not deployed. See [deployment.md](docs/deployment.md).

## Gate state

At `8392a936` (2026-10-15): the `--jobs 1` quick e2e gate passes 7 of 7 flows in 171.5 s with no new missing APIs,
errors, required natives, draw errors, settle timeouts or wedges. Every flow upgrades methods to the second tier
again. From `32867b8c` until `8392a936`, units could not reach the process Worker from the compile frame's agent
cluster, so earlier gates, `c6249776` included, presumably ran without upgrades; Google Maps measured 0. 1,148 unit tests
pass; the FitNotes and boot-jar sweep is clean; all 16 `wasm all` suites and 31 of 31 `fwtest` exercises pass. Two
gate runs at a host load of 19–30 from another checkout's e2e failed FitNotes (once also Calculator) with completion
timeouts while the app kept presenting frames. FitNotes alone then passed 3 of 3 at a load of 12–16. Those failures
were not compared with `c6249776` under the same load.

Not run since the JS tier was deleted: `e2e --live`, `e2e --full --jobs 1`, `corpus` and `textcmp`. Before that,
the serial `--live` matrix reached 13 of 14 flows (TikTok missed its launch budget).

## Open work, in priority order

1. **Cold taps: fewer, cheaper modules.** A tap without a saved build compiles the methods it first calls, one
   module per method; compiling ahead covers 16–45% of those links. The compiler takes 52% of `linkSlot`. A
   Chrome Worker charges about 18.5 µs per module against Node's 4.2 µs, and no V8 flag changes that, so fold
   `linkEnsure` (603 modules) and the stub pools (318) into fewer modules. A callee prediction must hit more than
   about 70% to pay inside a tap (single-target callees hit 64%).
2. **The full matrix after the JS tier's removal.** Run `--live`, then `--full --jobs 1`, `corpus` and `textcmp`,
   serially, with a platform build that matches the sources. Compare any failure with `33373567` (the last commit
   before the removal) under the same settings: check it out in its own worktree with its own `vendor/wasm-aot`
   (not the symlink), cherry-pick `06f9ceb4` (which keys the platform build correctly), and run `bun run aot`
   there. Lichess's launch differs from its reference on both tiers (a notification-permission request and live
   content); do not raise the limit.
3. **TikTok's launch** (12.3 s cold, 8.2 s warm in `lat` since its saved build attaches; its `--live` e2e
   launch budget is not rechecked). With compile workers in their own renderer its app cage peaks at 2.5–2.6 GB;
   native code takes 27.6 s and on-demand compiling 26 s of the main process's busy time. The main process holds
   ~1.34 GB live, ~240 MB of it Program/dex metadata and ~80 MB pool stubs (358,000, 72% for slots never looked up;
   passing the slot at the call site would let one stub per signature serve every unlinked method).
4. **First-launch compile cost** (Komikku, Feeder, TikTok). Levers: compiler front-end allocation (about 200 MB/s,
   `Flow` construction 12%); instantiation (code modules import about 172 globals each; cross-module class access
   could use id-indexed arrays); relocatable numbering (classes, slots, selectors, gaps and links are numbered by the
   page's World, which blocks any parallel or ahead-of-time compile; seeding app numbers at dex arrival
   covers 99.9% of Komikku, but attaching a first build mid-session did not pay, see the history). Measure each on Komikku's first launch, three
   matched runs or more. Without a platform build FitNotes' quick flow takes 144 s against 46 s, so the on-demand
   path itself is worth profiling.
5. **Application compatibility.**
   - *TikTok playback and input:* capture repeatable source media and separate decoded-video, EGL-swap and
     presentation counts; profile dense clips and warmed action latency. Its unchanged ByteVC decoder reached a
     near-30/s cadence on one 30-fps HEVC segment.
   - *Cut the Rope:* the intro video stalls or shows black; gameplay beyond the level-one sample (36 frames/s at
     1080×2160) is unmeasured on an idle host. Player ID/backend paths are unvalidated; it has no full-matrix flow.
   - *Graphics parity:* minimize the 132 differences of the two larger API-33 graphics fuzz campaigns (58 and 74
     of 1,000 cases) before changing common renderer behavior; the small retained seeds report 0 of 100.
   - *Explorer and Integrity:* run the saved-state UI explorer over a small, diverse corpus with matched Android
     oracles and cluster repeatable failure signatures. SPIC's Play Integrity request reaches Google with
     `?attestation=1` but gets HTTP 500 (`DF-DFERH-01`): DroidGuard supplied zero bytes and microG had no auth token.
     A licensed Play Store oracle is needed before attributing that to webdroid.
   - *Unvalidated paths:* ChatGPT authenticated upload and voice; TikTok sign-in and publishing; general multi-window
     bar arbitration; Google Maps zoom, active navigation, sign-in and backup transport. A native fault converted
     into a Java exception can still leave native locks held.
   - *Games:* Among Us completes a live online match through the Bun relay at its own 30/s target; a cold Skeld
     start once exceeded the host's client-load wait, so map-load time (about 6.4 s cold) is the reliability margin,
     and the deployed Worker has no UDP endpoint. FMOD stream decoding needs a device comparison with audio.
     Subway Surfers reaches an active run; its background Firebase initialization still throws. Genshin Impact
     (outside the matrix) reaches the Geetest captcha, which needs the account owner; its data exceeds the app pane's
     4.7 GB quota.
   - *`apks/new`:* McDonald's gate needs microG 0.3.17; microG is still pinned at v0.3.16.252432
     (`vendor/microg-README.md`, `SYSTEM_PACKAGE_RELEASE`), and the user chose to wait for the official release.
     Then recheck Yelp's Google sheet and Walmart's geocoding. Yelp's business page and tabs are unverified;
     Walmart needs a US egress (its location service follows the egress IP); Tubi's DRM (Widevine) and Snapseed's
     GLES 3.1 compute "Looks" need a decision from the user.
6. **Lower value; only with a new measurement that justifies it.**
   - `system_server` and the broker stores in a system Worker: the broker answers app IPC on the page thread, so
     slow page work starves app queries. Measure page-thread time during app IPC first.
   - Pre-linked images with relocations: direct calls measured neutral, and FitNotes' warm launch would save an
     estimated 100–200 ms; relocation matters mainly as the enabler of ahead-of-time compiles (item 4).
   - Per-signature trampolines in place of the per-name `callFn` and `hostFn` modules (15–30 ms of a launch).
7. **Cleanup candidates** (confirm with a reference search before deleting): `src/jvm/runtime.ts` is still shaped
   around the JS tier in places (`rt.make` gives a carrier of fields that cannot take a virtual call); browser tests
   intermittently fail with "End Of Central Directory signature not found" while reading a jar, still unexplained.

## Known limits and candidates

Unranked; each needs a measurement or a check against the current code before work starts.

- **Rendering:** color-matrix and MODULATE layer filters, mask filters and RenderEffects read pixels back with
  `getImageData`/`putImageData` every frame; WebGL2 shader passes would remove the readback. Every frame replays the
  whole root display list (no damage tracking); measure raster time on a hardware GPU first.
- **GLES:** `keepsClean` validation excludes draws, uniforms and state setters, so `gl.getError` follows them;
  rangeless client-array indexed draws read the element buffer back.
- **ARM JIT:** ARM32 regions load and spill all 15 GPRs, and A64 regions end at 4 KiB pages, so a call or return to
  another page spills and reloads. Precise ARM32 register sets and multi-page regions would help CPU-bound games.
- **Native:** `AndroidBitmap_lockPixels` copies and converts the whole bitmap per lock; a file read compares a
  writable `MAP_SHARED` mapping whole; `fork`, `vfork` and non-thread `clone` return EAGAIN (exec ENOSYS), so `popen`,
  `system`, `Runtime.exec` and shelling out to `getprop` fail.
- **Transport:** the relay terminates TLS with a leaf from its own CA, so certificate pinning cannot pass.
- **Delivery:** the platform build omits the APEX/module jars, so every realm compiles them on demand; app code's
  lazy Liftoff compile (about 107 ms of Calculator's launch) has no idle thread to move to.
- **Platform gaps recorded before the Wasm tier:** WebView has no Safe Browsing or saveState, and cross-origin
  WindowProxy navigations hit `frame-src`; IME insets have zero height (the browser keyboard sits outside the
  canvas) and hardware keys beyond Enter are missing; one task per process, no recents, no ANR detection;
  `PdfRenderer` and the DownloadManager provider are missing; java.nio.file lacks links, permission bits and
  WatchService; the regex natives (`jregex.ts`) translate to JS RegExp, so possessive quantifiers run greedy; only 9 of 226 charsets are
  served; A64 exclusive-monitor semantics are unverified.
- **Harness:** the emulator recorder runs online, so re-recording Mihon's references would capture its update
  dialog.
- **Maintainability:** shaping is cached for measurement but not for layout; two deflate libraries (fflate and pako).

## Verification for changed behavior

Run the owning unit, framework and `wasm` suites and smoke-compile affected APKs while developing. Freeze code before
the serialized full matrix and inspect every relevant process's `run.json`. Use matched inputs and settings for
performance ([performance.md](docs/performance.md)); keep goldens unchanged unless reference updates are explicitly
requested. The [E2E guide](tests/e2e/README.md) and [fuzz guide](scripts/fuzz/README.md) give commands and artifact
locations.
