# Webdroid status — 2026-10-16

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
  With second-tier units adopted again (`8392a936`), Komikku's cold `settings` and `appearance` taps ran 30–40 ms
  slower than without them on a loaded host (history, "Restored units cost Komikku's taps"); unresolved.
  Komikku's warm taps (32–89 ms) are first-tier Java composing the new screen in one `doFrame` (38–61 ms) plus GC
  bursts of up to 30 ms. Heavy apps are reports (`"gate": false`). Scroll p95 is 17.3–17.8 ms with no missed vsyncs.
  Every re-architecture plan item is done, rejected, or measured with nothing to recover
  ([status](docs/perf-handoff.md#plan-status-2026-10-14)). What remains of a tap is the app's own Java, which runs 3.2×
  slower than on ART in Kotlin-shaped workloads; skipping every Wasm cast left warm taps unchanged. See [performance.md](docs/performance.md).
- **Compatibility:** the original 20-APK scope and the 15-app open-source corpus all draw an initial frame; neither
  is established as fully usable. Feature paths were exercised for each corpus app except Thunderbird's account
  setup. Outside the corpus, NewPipe was exercised end to end on 2026-10-15, and Google Maps (2026-10-15) draws its
  vector map and layers, searches, and shows places, driving routes, active navigation, Street View and Immersive
  View. The `apks/new` XAPKs run on the Wasm tier (2026-10-16): Snapseed edits and exports, Yelp's onboarding, home,
  search, map and business page work, Walmart's flows and cart work, McDonald's reaches home, menu and the store
  locator, and Tubi plays non-DRM titles.
- **Deployment:** Cloudflare Workers Builds deploys the main app and Pages the isolated WebView renderer from
  `main`; this branch is not deployed. See [deployment.md](docs/deployment.md).

## Gate state

At the merge of `knlnks/node-migration` (2026-10-16), at a load of about 3: typecheck passes; 1,158 unit tests pass under
Vitest; all 16 `wasm all` suites and 31 of 31 `fwtest` exercises pass; after `aot`, the `--jobs 1` quick e2e gate reaches
7 of 7 flows in 161 s with no missing APIs, errors, required natives, draw errors, settle timeouts or wedges.

On Node, pnpm and Vite+ (`knlnks/node-migration`, 2026-10-16), with other checkouts' browsers holding the host at a load
of 12-32: typecheck passes; 1,158 unit tests pass under Vitest; 31 of 31 `fwtest` exercises and all 16 `wasm all`
suites pass; `build:prod` and `worker:check` pass; `textcmp FitNotes.apk` matches 108 of 108 layouts and 184 of 184
hyphenated lines. The quick e2e gate reaches 6 of 7 flows, Doodle Jump failing as below; interleaved with `2f48474e` on
Bun, both stacks drew its title loop at the same cost (history, "Doodle Jump under load"). `conform` guava
(368,772/368,794), jsr166 (3,209/3,211) and ojluni-time (30,596/30,602) have no regressions, once ojluni-time's
clock-derived non-ISO dates in test names hash stably. `lat` fails on both stacks alike: Mihon's launch is unavailable (once, at a load of 32, its process died of a
`NullPointerException` instead; four reruns did not repeat it), and Komikku's `start`, `more` and
`appearance` taps reach 166-436 ms; CalculatorM's taps passed 3 of 3 interleaved runs on each. After the review cleanup,
at a load of 4-12, the same checks pass and the `--jobs 1` quick gate reaches 6 of 7 flows: Doodle Jump passes, and Mihon
onboarding's process dies at launch of the ICU `NullPointerException` that concurrent launches reproduce at the cleanup's
start too. A generator native that dropped its strand after a wait entered Java as the main thread (history, "Mihon's ICU
initialization under concurrent launches"); with it kept, unit tests, `wasm all` and `fwtest` pass and the `--jobs 1` gate
reaches 7 of 7 flows with no missing APIs, errors, required natives or draw errors. The 5-job gate at a load of about 20
fails other flows on starvation with and without the change alike.

At the merge of `knlnks/maps-wasm` (2026-10-16): typecheck passes; 1,158 unit tests pass (the "End Of Central
Directory" flake failed four browser tests once, and they pass on a rerun); all 16 `wasm all` suites pass. The `--jobs 1`
quick e2e gate reaches 6 of 7 flows with no missing APIs, errors, required natives, draw errors, settle timeouts or
wedges. Doodle Jump's idle Play services Worker (pid 1003) missed the 5 s diagnostic read in one step, and again on a
rerun; `6fb77b0a`, the tip before the merge, fails the same way twice, with other checkouts' browsers holding the host at
a load of 9-14.

Before the merge, each side's quick gate passed 7 of 7 flows. At `knlnks/maps-wasm` (2026-10-15) every flow upgraded
methods to the second tier (35-485 per flow); 31 of 31 `fwtest` exercises and the Google Maps sweep (351,903 methods)
passed. `lat` fails on a loaded host: Mihon's launch is unavailable, as at `cae91309`, and Komikku's cold taps reach
155-177 ms (see Latency). At `01e96bf7`, with 24 busy loops beside the gate (load about 45), FitNotes failed 11 steps, and
14 at `89868cac`, all completion timeouts: its off-screen spinners keep vsync requested, as on the reference AVD, and the
pixel rule's readbacks stretch past the bound (history, "FitNotes under host load"). At `4de1c0a9`, FitNotes `smoke` was
clean and 31 of 31 `fwtest` exercises passed; the default five-at-a-time run missed four flows on worker-diagnostic and
completion timeouts while another checkout's sweep held the host at a load of about 14.

Not run since the JS tier was deleted: `e2e --live`, `e2e --full --jobs 1` and `corpus`. Before that,
the serial `--live` matrix reached 13 of 14 flows (TikTok missed its launch budget).

## Open work, in priority order

1. **Cold taps: fewer, cheaper modules.** A tap without a saved build compiles the methods it first calls, one
   module per method; compiling ahead covers 16–45% of those links. The compiler takes 52% of `linkSlot`. A
   Chrome Worker charges about 18.5 µs per module against Node's 4.2 µs, and no V8 flag changes that, so fold
   `linkEnsure` (603 modules) into fewer modules. A callee prediction must hit more than
   about 70% to pay inside a tap (single-target callees hit 64%).
2. **The full matrix after the JS tier's removal.** Run `--live`, then `--full --jobs 1`, `corpus` and `textcmp`,
   serially, with a platform build that matches the sources. Compare any failure with `33373567` (the last commit
   before the removal) under the same settings: check it out in its own worktree with its own `vendor/wasm-aot`
   (not the symlink), cherry-pick `06f9ceb4` (which keys the platform build correctly), and run `pnpm aot`
   there. Lichess's launch differs from its reference on both tiers (a notification-permission request and live
   content); do not raise the limit.
3. **TikTok's launch** (12.3 s cold, 8.2 s warm in `lat` since its saved build attaches; its `--live` e2e
   launch budget is not rechecked). With compile workers in their own renderer its app cage peaks at 2.5–2.6 GB;
   native code takes 27.6 s and on-demand compiling 26 s of the main process's busy time. At its feed the main
   process holds ~1.16 GB after a full collection, against 1.35 GB before one lazy-link stub per signature and the
   slimmer Program/dex metadata (2026-10-16). Its e2e flow now picks an adult birthdate on the guest birthdate screen.
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
   - *YouTube:* search, thumbnails, playback, fullscreen and Shorts work; the fullscreen crash (about 1 in 9
     walks) was a stale handle long naming a reused slot (history, YouTube). The full lane's video-open tap is a
     coordinate that can land on a live Short.
   - *NewPipe:* feeds, search, playback (fullscreen, background and popup players), live streams, channels,
     subscriptions, downloads, history and settings work. Live streams intermittently get HTTP 403 from YouTube,
     as they do on the reference AVD. It has no e2e flow.
   - *Cut the Rope:* the intro plays and level one completes from a swipe; frame rate beyond the level-one sample
     (36 frames/s at 1080×2160) is unmeasured on an idle host. Player ID/backend paths are unvalidated; it has no
     full-matrix flow.
   - *Graphics parity:* minimize the 132 differences of the two larger API-33 graphics fuzz campaigns (58 and 74
     of 1,000 cases) before changing common renderer behavior; the small retained seeds report 0 of 100.
   - *Explorer and Integrity:* run the saved-state UI explorer over a small, diverse corpus with matched Android
     oracles and cluster repeatable failure signatures. SPIC's Play Integrity request reaches Google with
     `?attestation=1` but gets HTTP 500 (`DF-DFERH-01`): DroidGuard supplied zero bytes and microG had no auth token.
     A licensed Play Store oracle is needed before attributing that to webdroid.
   - *Unvalidated paths:* ChatGPT authenticated upload and voice; TikTok sign-in and publishing; general multi-window
     bar arbitration; Google Maps sign-in and backup transport. A native fault converted into a Java exception can
     still leave native locks held.
   - *Games:* Among Us completes a live online match through the dev server's relay at its own 30/s target; a cold Skeld
     start once exceeded the host's client-load wait, so map-load time (about 6.4 s cold) is the reliability margin,
     and the deployed Worker has no UDP endpoint. FMOD stream decoding needs a device comparison with audio.
     Subway Surfers reaches an active run; its background Firebase initialization still throws. Genshin Impact
     (outside the matrix) reaches the Geetest captcha, which needs the account owner; its data exceeds the app pane's
     4.7 GB quota.
   - *`apks/new`:* McDonald's Order tab overlaps because the XAPK ships only the mdpi split. Walmart's Sparky needs
     an on-demand feature split that is not in the XAPK, and microG's SplitInstallService is disabled. Tubi's Widevine
     titles show a DRM error and Snapseed's "Looks" needs GLES 3.1 compute; both need a decision from the user.
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
  Google Maps' two `getError`s per frame come through the untracked Java bindings (history, EGL/GLES).
- **ARM JIT:** ARM32 regions still end at 4 KiB pages, so a call or return to another page spills and reloads (A64
  regions span pages and ARM32 ones spill only the registers they name since 2026-10-16); CPU-bound games are unmeasured.
- **Native:** `AndroidBitmap_lockPixels` copies and converts the whole bitmap per lock; a file read compares a
  writable `MAP_SHARED` mapping whole; `fork`, `vfork` and non-thread `clone` return EAGAIN (exec ENOSYS), so `popen`,
  `system`, `Runtime.exec` and shelling out to `getprop` fail.
- **Hidden API:** no hidden-API policy is enforced, so reflection reaches `@hide` members that ART denies apps, and an
  app that relies on the denial takes another path (Compose's `findViewByAccessibilityIdTraversal` override recurses).
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
