# Handoff: the `apks/new` corpus (updated 2026-09-27, second session)

Goal (from the user): make every app in `apks/new` usable (Snapseed, Walmart, Yelp,
McDonald's and Tubi XAPKs). Core flows must fully work, and input latency must stay under
150 ms, not counting network. Fixes must be generic, not app-specific. Keep code DRY and
lean, write few tests, add comments only where needed, and commit in focused commits.
Parallelize with one subagent per unfinished app. Follow `AGENTS.md`.

Durable findings from both sessions are in `docs/implementation-history.md` (search for
the app names, `LruCache`, `F_DUPFD`, `saveLayer`, "Harness cost"). This file is the
working status.

## Where the work is

- Everything is squash-merged into `main` (commit "new-apks: …"); the `new-apks` branch and its
  worktrees are deleted. Gate at merge: `bun run typecheck` clean, `bun run test` 1408/1408,
  `bun run smoke` 0 method failures on FitNotes and all five XAPKs, `bun run e2e` 7/7 (Komikku's
  SQLite autoindex/double-quote warnings reproduce identically on the pre-merge `main`).
- `PLAN.md` is not updated for this work.

## Code-quality review round (after the app work)

A strict structural review of the branch found duplicated concepts and drift bugs;
seven fixers resolved all findings (squashed into the same `main` commit). Behaviour changes worth watching in e2e and app runs:
- Every HttpURLConnection request uses the proxy's `manual=1` mode and follows
  redirects in JS.
- POSIX timers/timerfds run on the guest clock (virtual under `testClock=controlled`).
- GLSurfaceView renders at display rate with backpressure; it stops while its page
  isn't presenting. Renderer exceptions end the loop until the next wake.
- BACK to a Dialog goes through its window callback (appcompat's wrapper).
- MessageFormat builds subformats at `applyPattern` (bad patterns throw there);
  plain NumberFormat instances report the locale's currency.
- Left for later: `setCanvasBitmap` doesn't reset the save stack; `isBoring`
  metrics ignore style runs; `baselineShift` isn't applied to measured runs;
  the MAP_SHARED dirty-page optimisation was not measured.

## How to drive the apps

```bash
bun run typecheck   # builds the Wasm core
PORT=4470 WEBDROID_APK_DIR=/Users/kunalan/Projects/webdroid/apks/new bun run server.ts
DRIVE_PORT=4471 WEBDROID_URL=http://localhost:4470 webdroid-shots/new/restart-driver.sh
```

- Everything under `webdroid-shots/` is gitignored and local to the main checkout.
- **Parallel agents:** `webdroid-shots/new/new-worktree.sh <name> [base]` creates
  `.claude/worktrees/<name>` on branch `<name>` off `base` (default `main`) with apks, vendor
  assets, node_modules and the shots dir linked. Give each agent its own server/driver
  ports; all tools (`wd`, `wdjs`, `profdiff`, flow scripts, `restart-driver.sh`) read
  `DRIVE_PORT`. The brief used for this session's agents is
  `webdroid-shots/new/tools/scratch/common.md`. The host has 24 GB/14 cores; five
  agents at once pushed load to 30–58, which made every latency number noisy.
- **Driver** (`webdroid-shots/new/drive.ts`, replaced this session by the latency
  agent's version):
  - Frame capture no longer reads pixels back synchronously (that alone added
    100–300 ms per frame on SwiftShader).
  - `plat` measures real pointer taps from the actual up; `latency`'s `up` still
    includes `wd.tap`'s fixed 60 ms hold.
  - `open` accepts `"gpu":"hardware"` (use it for GL apps; SwiftShader is the default)
    and `"init"` (an init script). Also `ptap`, `pswipe`, `profstart`/`profstop`, `cdp`.
  - Earlier commands still apply: `open`, `state`, `ui`, `tree`, `tap`, `tapText`,
    `type`, `enter`, `back`, `swipe`, `wait`, `shot`, `diag`, `logs`, `eval` (with
    `"frame":"pid=…"`), `pick`, `debug`/`stack`/`peval`, `close`.
- **Measurement:** `webdroid-shots/new/lat/raw.ts` is a Playwright-free harness over
  raw CDP (Playwright's `Runtime.enable` makes every Java exception ~5x dearer).
  `lat/*.json` are scenarios (FitNotes, Snapseed, Tubi); `lat/ab.sh` runs A/B
  comparisons; `cats.ts`, `win.ts`, `callers.ts` summarize CPU profiles.
- **Other tools** in `webdroid-shots/new/tools` (see the previous handoff's list, all
  still valid): `throws-hook.js`/`throws-read.js`, `trace-methods.js`, `stack-at.js`,
  `profdiff`, dex helpers (`classes.ts`, `findmethod.ts`, `findref.ts`,
  `findstrref.ts`, `findconst.ts`).
- **Agent scratch scripts** are kept in `webdroid-shots/new/tools/scratch/`:
  - `heapsamp.ts` (allocation sampling by call site; found the executor leak),
    `heap.ts`, `prof.ts`, `tapprof.ts`, `wvgc.ts` (WebView leak check with forced GC).
  - `tubi/`: CPU profile per tap, `netlog.js`, `wsmon.js`.
  - `yelp/`: relay WebSocket logger with an h2 decoder (`netlog.js`), Rx chain walker
    (`cache.js`), blocked-thread lister (`blocked.js`), a driver copy with a `geo`
    command that re-sets a fresh fix.
  - `walmart/`: `flow.sh`, `search.sh`, and `seed.js` — a **harness-only** rewrite of
    the location response to a US store, for exercising flows past the geo block. Never
    commit anything like it.
- `jvmProfile` caps at 8192 methods; in big apps late-running methods are silently
  dropped and `profdiff` shows almost nothing.

## Per-app status

### Snapseed: core flows work; Looks blocked
- Verified (hardware GPU): welcome → GET STARTED → pick → editor; Tune Image (tutorial,
  apply); Crop (rotate, square, angle, apply); Details; Healing; Brush; undo/redo;
  "Save as a Look?" dismiss; two exports (the second JPEG shows all edits).
- **Looks aborts the process:** MediaPipe/LiteRT's ML Drift OpenGL delegate needs GLES
  3.1 compute (see history). A real ES 3.0 device fails the same way. Supporting it
  means compute shaders (e.g. over WebGPU) — **a user decision**. Portrait, Head Pose
  and Expand may hit the same path (untested). Looks' "Current" thumbnail renders black.
- Latency (up → first change, raw CDP, hardware GPU, loaded host): GET STARTED 21–35,
  Add Photo 14–28, undo/redo 13–35, warm Tune open 84–125, warm Crop 96–202, first Tune
  198–342, first apply 57–405 ms. Slider drag keeps up with input.

### Tubi: browse and clear-stream playback work; DRM titles blocked
- Verified: onboarding (carousel now visible) → Skip → Home, details, Explore search,
  Live TV, and VOD playback of clear streams (24 fps, audio, pause/resume, ±10 s seek,
  back to details).
- **Widevine:** many films and every detail-page inline preview are only
  `hlsv6_widevine_psshv0` (license at `license.adrise.tv`, software L1 token). Needs
  MediaDrm/MediaCrypto over EME with MSE playback drawn to the Surface; not testable in
  headless Chromium (needs branded Chrome). **A user decision** — not yet asked.
- Latency is the weakest area: Explore 150–650, My Stuff 98–321, Home 212–474, Skip
  440–700 ms after the up; first feedback 2–35 ms. The time is cold interpretation and
  compile. Lead: hot-promotion threshold 16 vs 32 (knob: `globalThis.__wdCalls` in
  `compiler.ts` `invoke`, experiment reverted) — re-run `lat/ab.sh` on a quiet host.
- `PulseView` on My Stuff invalidates every frame by design (~1.4 ms/frame).
- `RenderNode.setPosition` discards the display list on resize; AOSP keeps it.

### Yelp: search works; business page unverified
- Verified: onboarding → OK → Continue → dismiss the Google sheet in the `pid=1004`
  frame → Skip → home; suggestions; category search with map, pins, list and results.
- Next: retest the business page (the three missing APIs it hit are now committed),
  back, bottom tabs.
- The first Skip after dismissing the Google sheet is often ignored (not investigated).
- The home "Target crashed" did not reproduce (RSS flat over ~26 scrolls). The LruCache
  sizing fix is a plausible cause; confirm with a long scroll session.
- Bunsen event publication returns 400 (not 403 this time); experiment allocation is
  fine. DataDome is present. Log relay traffic before guessing.
- Location freshness: Yelp rejects fixes older than 15 minutes. For the harness, re-set
  geolocation before searching. Platform gap: a stationary browser's `watchPosition`
  never re-reports, so the fix ages out on real users too — consider re-reporting while
  a subscription is active.
- Adjust `nSign`'s second call spins >70 G instructions (see history); the throttle
  limits the damage but it still takes ~34% of the thread. Root cause unknown.
- Emoji render as "�" in the home "Unlock your top 10 list" header.
- Latency (driver, loaded host): search bar up 69–130, category 166, Skip 446 ms.

### Walmart: blocked by server-side geo on this host
- The location GraphQL uses the egress IP (Rogers, Ontario) and ignores the device's US
  coordinates/ZIP; curl gets the same answer. Onboarding then shows "unable to identify
  your location" and search returns 0 items. **Needs a US egress** to finish product
  page, add to cart, cart and tabs.
- With the harness seed: home feed (categories, carousels with prices, video, cart
  summary, tabs) and type-ahead search work.
- Fixed: Lottie black circle (`saveLayer`), `sqlite3_close` BUSY (LruCache
  `entryRemoved`), Tink/EncryptedSharedPreferences (ByteBuffer equality), prices
  clipped (span-aware StaticLayout metrics), `android.icu.number`.
- Open: home sub-nav chips run together with no spacing; missing
  `StorageManager.allocateBytes(UUID,J)`; `android.icu.number` non-currency units throw
  UnsupportedOperationException.
- Rendering on animated screens is GPU-bound under SwiftShader (`CrGpuMain` ~95%);
  re-measure with `"gpu":"hardware"`. microG's FIDO sheet appears on launch and needs a
  Back.

### McDonald's: waiting for microG 0.3.17
- **The user decided to wait for the official microG 0.3.17 release** (due 2026-09-28)
  rather than build from master. Do not bypass the gate (e.g. via the exported
  `DeepLinkRouter`). Check https://github.com/microg/GmsCore/releases; when 0.3.17 is
  out, update the pins in `src/shell/system-packages.ts`, `vendor/microg-README.md` and
  provenance, regenerate `vendor/microg` (it is a shared symlink to the main checkout —
  use a local copy and a separate `WEBDROID_PACKAGE_CACHE` while testing), then verify
  the gate passes and recheck Yelp's Google sheet and Walmart's location/Geocoder.
- After the gate: home, menu, item detail, deals, store locator, bag, tabs (sign-in
  and ordering are out of scope).
- Works now: the gate, its Terms/Privacy WebViews, "Close the app", splash video.
- Latency on the gate: warm link open 113–204 first change; first open 241–510 ms
  (cold compile).

## Cross-app priorities for the next agent

1. McDonald's once microG 0.3.17 ships.
2. Latency: cold first opens (Tubi most of all) are 200–700 ms. Measure on a quiet host
   with `lat/raw.ts` or `plat`, hardware GPU, one browser. Then attack cold
   interpretation/compile (threshold A/B, cheaper first-call path).
3. Yelp business page and tabs; Walmart flows if a US egress becomes available.
4. Ask the user about Widevine (Tubi) and GLES 3.1 compute (Snapseed Looks).
5. Run `bun run e2e` and fix regressions before merging to `main`; update `PLAN.md`.

## Known gaps noticed but not fixed

- `Runtime.exec` has no `Process`, so every command fails with ENOENT (Braze calls
  `getprop`).
- Synchronous compiled methods have no back-edge fuel; microtask-only loops starve the
  event loop.
- The relay terminates TLS and gives apps a peer certificate without a public key, so
  certificate pinning would fail.
- Every `read(2)` of a file with a writable shared mapping compares the whole mapping.
- Blob creation for tiny PNG decodes can stall for milliseconds under host load;
  `ImageDecoder` would avoid the IPC.
- Walmart's `saveLayer` and Tubi's RenderNode compositing layers were written
  independently in the same session; check them for shared code.
