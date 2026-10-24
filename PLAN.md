# Webdroid status — 2026-10-22

This file tracks where the work stands and what is open. [AGENTS.md](AGENTS.md) defines the working and
verification rules, [docs/architecture.md](docs/architecture.md) the design, [docs/performance.md](docs/performance.md)
how to measure and where the time goes, and the [implementation history](docs/implementation-history.md) the
failure mechanisms, measurements and rejected experiments. Superseded plans and handoffs are in Git history.

## Where things stand

- **Java runs only on the Wasm tier.** The DEX-to-JavaScript tier and the cold interpreter were deleted on
  2026-10-13; there is no other tier to compare against or fall back to. `knlnks/bytecode-wasm` carries the whole
  backend and is about 2,990 commits ahead of `main`.
- **The platform runs from AOSP bytecode** of one API-35 reference build (bytecode-first stages A–F complete):
  libcore, resources, graphics, text, the view stack, windows, `android.content` and ActivityThread, over TS
  system services and natives. 64-bit processes run the reference build's bionic; text measures on HarfBuzz
  (`textcmp` 72/72); Path ops run on Skia.
- **Every app process runs in its own Worker**; the page realm is `system_server`.
- **Code delivery:** the platform is compiled at build time. A shown first launch without a saved or bundled build
  waits for a build of the whole app, made in parallel shards in the compile host's process, as an install compiles an
  app ahead; an app above 250k method references (TikTok) launches without one, compiling likely callees in idle time,
  and is built after its launch. Builds after launches refine the app's build and are persisted; bundled builds cover
  the gate apps; a page Worker warms the engine's code for what launches ran (Chrome).
- **Latency:** `lat` gates on the first response frame. Every Calculator M, FitNotes and Komikku tap passes the
  150 ms gate cold and warm by median of three runs (2026-10-17). With the install-time build a first launch's taps
  match warm ones (Calculator M `7` 16 ms against 55 on demand; Komikku's cold medians 16–101 ms against 49–118). The
  80 ms target holds for every gated tap but Komikku's cold `appearance` (medians 82–91); its `start` met it once large
  fallback fonts were read ahead while idle (median 66 ms cold, 64 warm, against 87 and 90). First launches take
  longer (Calculator M 2.36 s, FitNotes 1.99 s, Komikku 6.69 s, against 2.27, 1.58 and 5.97 s); warm launches are
  unchanged. Compile Worker answers wait out the input window. `lat --ecores` measures an about 6× slower device.
  The 80–170 ms stalls that failed earlier runs were the engine freeing merged-away units in one pause, now released
  in batches (`World.retire`).
  With second-tier units adopted again (`8392a936`), Komikku's cold `settings` and `appearance` taps ran 30–40 ms
  slower than without them on a loaded host (history, "Restored units cost Komikku's taps"); unresolved.
  Komikku's warm taps (32–89 ms) are first-tier Java composing the new screen in one `doFrame` (38–61 ms) plus GC
  bursts of up to 30 ms. Heavy apps are reports (`"gate": false`). Scroll p95 is 17.3–17.8 ms with no missed vsyncs.
  What remains of a tap is the app's own Java, which runs 3.2× slower than on ART in Kotlin-shaped workloads
  (2026-10-14). V8 inlines only calls within a module, and Liftoff none. Build code therefore calls a module's
  statically bound methods directly, binds calls of final classes and methods, and runs empty, accessor, check and
  straight-line bodies in place. Komikku's repeat Appearance `doFrame` fell from about 37 to 32–34 ms (history,
  "Final binding and trivial inlining", "Straight-line bodies in place"). In idle time from 250 ms after an
  input the burner has the engine optimize first-tier code that ran 64 calls, which the engine's own budget would leave
  baseline code (Komikku's repeat Appearance 60–69 → 47–50 ms), the platform code modules earlier launches loaded are
  linked ahead of their first call (FitNotes' first `start` 48–57 → 39 ms), and the frame that answers an input
  begins as soon as no frame is open rather than at the next refresh (sums of per-tap medians −10 to −28%, Calculator
  M a further −36%; history, "Burning first-tier code in idle time", "Linking ahead what earlier launches loaded",
  "Early frames for input"). Against the starting commit, first launches' sums of per-tap medians fell 21%
  (Komikku), 40% (Calculator M) and 15% (FitNotes) with first frames unchanged ([performance.md](docs/performance.md),
  2026-10-22). Measured and not levers: the engine code
  cache, GC (2–4% of heavy frames), nested inlining and guarded inlining of a virtual call's one loaded
  implementation. See [performance.md](docs/performance.md).
- **Compatibility:** the original 20-APK scope and the 15-app open-source corpus all draw an initial frame; neither
  is established as fully usable. Feature paths were exercised for each corpus app except Thunderbird's account
  setup. Outside the corpus, NewPipe was exercised end to end on 2026-10-15, and Google Maps (2026-10-15) draws its
  vector map and layers, searches, and shows places, driving routes, active navigation, Street View and Immersive
  View. The `apks/new` XAPKs run on the Wasm tier (2026-10-16): Snapseed edits and exports, Yelp's onboarding, home,
  search, map and business page work, Walmart's flows and cart work, McDonald's reaches home, menu and the store
  locator, and Tubi plays non-DRM titles.
- **Deployment:** one Workers Builds build deploys the page to Pages and the backend, which is also the isolated
  WebView renderer's origin, to a Worker from `main`, and paired previews from other branches. Not yet deployed
  from this layout. See [deployment.md](docs/deployment.md).

## Gate state

The 2026-10-21 native-region and call-site experiments pass the gates listed in their
[verification report](docs/performance-design.md#verification), which also records a cold FitNotes page crash and
an intermittent Chrome startup SIGILL. Negligible overhead across all apps remains open.

After the second code-quality pass (2026-10-20; history, "Second code-quality pass (2026-10-20)"): typecheck passes,
along with 1,187 unit tests, all `wasm all` suites, `fwtest` (31 of 31), desccheck (no mismatches), `build:prod` and the
Worker dry run. After `pnpm aot` the `--jobs 1` quick gate reaches 7 of 7 flows in 165 s. `lat` puts every FitNotes
and Komikku tap within 150 ms; Mihon's launch is unavailable because its live update check shows "New version
available!" over the onboarding screen the scenario expects.

`pnpm check` (2026-10-22) runs typecheck, the unit tests, `wasm all` and the quick e2e gate in 90 s on an M4 Pro
with the five flows whose APKs this checkout has. The Mihon flows now open `apks/mihon.apk` (0.21.2), whose screens
stay within the 0.20.4 goldens' thresholds; with them all seven pass in 115 s (2026-10-23). The quick gate runs
two flows at once on the host GPU (45 s); five at once fails on the starting commit too.

Not run since the JS tier was deleted: `e2e --live`, `e2e --full --jobs 1` and `corpus`. Before that,
the serial `--live` matrix reached 13 of 14 flows (TikTok missed its launch budget).

## Open work, in priority order

1. **On demand: fewer, cheaper modules.** Background processes, code outside a build (platform jars outside the
   platform build, code an app loads itself) and apps above the whole-app limit compile the methods they first call,
   one module per method; compiling ahead covers 16–45% of those links. The compiler takes 52% of `linkSlot`. A
   Chrome Worker charges about 18.5 µs per module against Node's 4.2 µs, and no V8 flag changes that, so fold
   `linkEnsure` (603 modules) into fewer modules. A callee prediction must hit more than
   about 70% to pay inside a tap (single-target callees hit 64%).
2. **The full matrix after the JS tier's removal.** Run `--live`, then `--full --jobs 1`, `corpus` and `textcmp`,
   serially, with a platform build that matches the sources. Compare any failure with `33373567` (the last commit
   before the removal) under the same settings: check it out in its own worktree with its own `vendor/wasm-aot`
   (not the symlink), cherry-pick `06f9ceb4` (which keys the platform build correctly), copy the main checkout's
   `vendor/wasm-aot/hot.json` into it, and run `pnpm aot` there. Lichess's launch differs from its reference on
   both tiers (a notification-permission request and live content); do not raise the limit.
3. **TikTok's launch** (11.5 s cold in `lat` on this branch and its base, 2026-10-16; 8.2 s warm since its saved
   build attaches). A cold launch needs about 48 s to its first gate, so the quick lane's 20 s launch wait fails on
   this branch and its base alike; under `--full` the flow reaches the feed and plays through both swipes
   (2026-10-16), though liveness probes can stall past 3 s while the interests and first swipe steps compile cold
   code. With compile workers in their own renderer its app cage peaks at 2.5–2.6 GB; native code takes 27.6 s and
   on-demand compiling 26 s of the main process's busy time. Its e2e flow now picks an adult birthdate on the guest
   birthdate screen. In matched cold first visits against its base (new browser contexts, 2026-10-16), signup comes
   at 37.6 s, as on the base. The feed comes at 66.9 s against 95.1 s, and 60 s later the main Worker holds 1.13 GB
   after a full collection against 1.36 GB. On the base, merged-away units drained 32 per collection force full
   collections for external memory. Two of 14 of the branch's cold launches stalled idle on a black window before
   any gate, and none of the base's 12; the cause is open (history, "The branch against its base").
4. **First-launch build cost** (Komikku 3.0 s, FitNotes 0.5 s, TikTok). A first launch waits for its app's build,
   so the compiler is now on its path: front-end allocation (about 200 MB/s, `Flow` construction 12%), a shard's fixed
   cost (its script and jars, about 290 ms) and instantiation (code modules import about 172 globals each;
   cross-module class access could use id-indexed arrays). Measure each on Komikku's first launch, three matched runs
   or more. Without a platform build FitNotes' quick flow takes 144 s against 46 s, so the on-demand
   path itself is worth profiling. Building an app's static roots before its first launch and a Zig compiler were
   measured and rejected: the build costs more than the 6–9 s it saves TikTok's signup, and the compiler's profile
   has no phase to move (history, 2026-10-16).
5. **Launch reliability and status.** First launches no longer hang on the compile worker script, whose body
   Chrome stopped delivering in about 1 of 80 (history, "Compile workers that end or never load"). Still open: one
   first launch that did not wait for a build hung and one launch-only FitNotes run crashed its renderer, neither
   reproduced; the page shows "Starting app…" through the whole launch, the build's wait included.
6. **Application compatibility.**
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
   - *Play Integrity:* SPIC's Play Integrity request reaches Google with
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
7. **Lower value; only with a new measurement that justifies it.**
   - `system_server` and the broker stores in a system Worker: the broker answers app IPC on the page thread, so
     slow page work starves app queries. Measure page-thread time during app IPC first.
   - Pre-linked images with relocations: direct calls measured neutral, and FitNotes' warm launch would save an
     estimated 100–200 ms; relocation matters mainly as the enabler of ahead-of-time compiles (item 4).
   - Per-signature trampolines in place of the per-name `callFn` and `hostFn` modules (15–30 ms of a launch).
8. **Cleanup candidates** (confirm with a reference search before deleting): `src/jvm/runtime.ts` is still shaped
   around the JS tier in places (`rt.make` gives a carrier of fields that cannot take a virtual call); browser tests
   intermittently fail with "End Of Central Directory signature not found" while reading a jar, still unexplained.

## Known limits and candidates

Unranked; each needs a measurement or a check against the current code before work starts.

- **Rendering:** color-matrix and MODULATE layer filters, mask filters and RenderEffects read pixels back with
  `getImageData`/`putImageData` every frame; WebGL2 shader passes would remove the readback. Every frame replays the
  whole root display list (no damage tracking); measure raster time on a hardware GPU first.
- **GLES:** `keepsClean` validation excludes draws, uniforms and state setters, so `gl.getError` follows them;
  Google Maps' two `getError`s per frame come through the untracked Java bindings (history, EGL/GLES).
- **ARM JIT:** ARM32 regions now cross pages at observed entries, avoiding transfers on direct branches;
  calls and returns still spill and reload. Cross-page loop gains are large, Doodle Jump's frame rate unchanged
  ([measurements and further designs](docs/performance-design.md)); broader CPU-bound games remain unmeasured.
- **Native:** `AndroidBitmap_lockPixels` copies and converts the whole bitmap per lock; a file read compares a
  writable `MAP_SHARED` mapping whole; `fork`, `vfork` and non-thread `clone` return EAGAIN (exec ENOSYS), so `popen`,
  `system`, `Runtime.exec` and shelling out to `getprop` fail.
- **Hidden API:** no hidden-API policy is enforced, so reflection reaches `@hide` members that ART denies apps, and an
  app that relies on the denial takes another path (Compose's `findViewByAccessibilityIdTraversal` override recurses).
- **Transport:** the relay terminates TLS with a leaf from its own CA, so certificate pinning cannot pass.
- **Delivery:** the platform build omits the APEX/module jars, so every realm compiles them on demand. In Chrome a
  page Worker has the engine compile the build code launches ran before a process calls it; processes still compile
  per-module helpers (`$new:`, `$dispatch:`) and on-demand units on first call, and other engines all of it.
- **Platform gaps recorded before the Wasm tier:** WebView has no Safe Browsing or saveState, and cross-origin
  WindowProxy navigations hit `frame-src`; IME insets have zero height (the browser keyboard sits outside the
  canvas) and hardware keys beyond Enter are missing; one task per process, no recents, no ANR detection;
  `PdfRenderer` and the DownloadManager provider are missing; java.nio.file lacks links, permission bits and
  WatchService; the regex natives (`jregex.ts`) translate to JS RegExp, so possessive quantifiers run greedy; only 9 of 226 charsets are
  served; A64 exclusive-monitor semantics are unverified.
- **Harness:** the emulator recorder runs online, so re-recording Mihon's references would capture its update
  dialog.
- **Tap candidates** (2026-10-22, from profiles; unmeasured as changes): YouTube's first RuntimeShader creates a
  WebGL context in its tap (~9 ms), which could be made while idle; a caught exception captures its Java stack
  eagerly whenever bridged callers exist (~1.5 ms a Komikku tap); a LaunchRecord's ran slots are keyed by the build
  id, so after a rebuild they are not used.
- **Maintainability:** shaping is cached for measurement but not for layout; two deflate libraries (fflate and pako).

## Verification for changed behavior

Run the owning unit, framework and `wasm` suites and smoke-compile affected APKs while developing. Freeze code before
the serialized full matrix and inspect every relevant process's `run.json`. Use matched inputs and settings for
performance ([performance.md](docs/performance.md)); keep goldens unchanged unless reference updates are explicitly
requested. The [E2E guide](tests/e2e/README.md) gives commands and artifact locations.
