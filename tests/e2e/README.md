# Visual E2E harness: webdroid vs. a real Android emulator

Each flow in `flows/` is recorded once on a real Android emulator (the goldens) and replayed in webdroid, which
is scored against it step by step. The scores are a target: they should fall as webdroid improves.

## Running

```bash
PORT=4090 pnpm dev
WEBDROID_URL=http://localhost:4090 pnpm e2e
WEBDROID_URL=http://localhost:4090 pnpm e2e --full --jobs 1
```

Use a private port and set `WEBDROID_URL` (default port 4080) on every capture; run captures
serially, as they share output directories.

| Mode (exclusive) | Does | Writes | Default `--jobs` |
|---|---|---|---|
| none | quick gate | `actual-fast/` | min(5, cpus/2) |
| `--full` | capture and score | `actual/`, `report/` | min(4, cpus/3) |
| `--diff` | rescore `actual/` | `report/` | min(4, cpus/3) |
| `--record` | emulator pass | `golden/` | sequential |

Only `--record` needs the SDK, `adb` or an emulator; it rejects `--jobs`. `--jobs N` (`-j`)
bounds concurrent flows (one headless Chromium each).

```bash
pnpm e2e --test fitnotes  # or -t; an exact name, else a prefix (mihon selects both Mihon flows)
pnpm e2e --test fitnotes,mihon-app  # a comma list; --test repeats
pnpm e2e --live  # the quick gate plus the live flows
pnpm e2e --list  # flow names (--help for usage)
pnpm e2e --full --shots [dir]  # --full only; default ./webdroid-shots
```

Named flows run even if live; unknown flags error. `--shots` keeps each distinct frame presented
in a step (max 240) as `<dir>/<flow>/<NN-id>/fNNN.png`; wiped per run, gitignored.

| Env | Effect |
|---|---|
| `WEBDROID_SCREEN=WxH@dpi` | geometry: `--full` runs smoke, quick visual checks fail |
| `WEBDROID_BYTECODE` | `?bytecode=` provenance cut |
| `WEBDROID_CPU_THROTTLE=N` | CDP CPU slowdown (load races) |
| `WEBDROID_SITE_ISOLATION=0` | WebView shares the app's renderer (as Safari/Android; also `lat`) |
| `WEBDROID_JS_FLAGS` | V8 flags, e.g. `'--no-sparkplug --no-maglev'` (also `lat`) |

Verification and the default corpus (`scripts/apk-corpus.ts`) exclude Genshin Impact, Clash of
Clans and Clash Royale.

## Quick gate

Runs `controlled`/`pinned` flows (`--live` adds live ones), longest first by the last
`actual-fast/summary.json`; no reruns; an exception fails only its flow. Steps keep process
diagnostics, `.ui.json` and a frame hash (PNGs only at `visual`/`motion` checks). Live steps use
`fastAction` (else `webdroidAction`, `action`) and `fastWait` (else a 500 ms live sample), and are
semantic after launch.

**Fails a flow:** missing required text, completion timeout, wedged loop, step error, abort (host
step deadline), no process diagnostics, a `motion` check under 2 presentations, a `visual` check
over its limit, missing `privateStorage.expectedFiles`; for non-live flows also `newMissing` (not
`[binder]`), `nativeRequired`, `newErrors`, process or browser errors outside `expectedErrors`
(live flows: gaps).

`actual-fast/summary.json`: per flow `status` (`compared`, `smoke`, `observed`, `failed`,
`not-selected`), `steps`, `durationMs`, `visual`, `errors`, `gaps`; on failure read
`actual-fast/<flow>/run.json` and `.ui.json`.

**Determinism:** non-live flows (both lanes) start `Date` at `PINNED_CLOCK_MS`
(2026-01-02T12:00:00Z, then advancing), seed `Math.random`, run offline (`/dns` 404, `/proxy` 502,
`/tcp`/`/udp` closed). Quick-lane `controlled` flows advance Android time logically
(`?testClock=controlled`); `pinned` flows and `--full` use real time. Live flows: wall clock,
network. Browser: SwiftShader, en-US, UTC, light, reduced motion.

## Full capture

Flows score in a subprocess once captured; quick-gate failures apply; serial runs take ~13-16
min. **Smoke** (steps run, `run.json` written, no score): no `golden/<flow>/manifest.json`, a
`depth: "startup"` manifest, or a `WEBDROID_SCREEN` unlike the golden. A subset run replaces
`report/index.html` and says so. `--diff` refuses launch-only references, aborted or non-`full`
captures, and changed `flowSchemaHash` (covers browser overrides), geometry, inset or step ids.

Motion steps (sample waits in full, `motion` evidence in quick) record `fps` (shell ticks/s),
`glFps` (GL callbacks/swaps) and `presentFps` (framebuffer transfers, if exposed), sampled with
elapsed time before PNG encoding; windows include settling. Below `Flow.minFps`, a non-launch step
is `SLOW` only under `--jobs 1`; rates never fail a run. Measure performance with `pnpm lat`
(`--gpu`: Metal), alternating revisions serially.

## Steps

| Action | Emulator (`drivers/emulator.ts`) | webdroid (`drivers/webdroid.ts`) |
|---|---|---|
| `tapText` | `uiautomator dump`, `input tap` | await `wd.locateText`, `wd.tap` |
| `tapAt` | `input tap` | `wd.tap` (`repeat`/`everyMs`, `whileText`) |
| `typeInto` | tap, `input text`, ESC | `wd.tap`, `wd.type` |
| `swipe`/`back`/`enter` | `input swipe`, key 4, key 66 | `wd.swipe` (`untilText`, `whileText`), `wd.back` (`whileText`), `wd.enter` |
| `background` | HOME, relaunch | pause/stop, resume |

A required `tapText` absent at the action timeout fails the step (recorded coordinates are no
longer replayed); optional ones are skipped and tagged `skipped`. Overrides: `webdroidAction` (browser lanes, when
geometry differs), `fastAction`/`fastWait` (above), `fastEvidence` (`visual` with
`maxContentDiffPct`, or `motion`; else semantic), `maskRects` (normalized diff exclusions).

A step is one `page.evaluate` into `lib/probe.ts` (it wraps timers, `fetch`, image decoding and
`WebSocket`, and sees `__wdPresented` frames): act, wait, liveness (a `wd.alive` sentinel behind
main work: frozen screens cannot pass as settled), telemetry.

Waits (`wait.*`; real timeouts and `state`'s virtual limit default 20 s, others 0):

- `state(cond, maxVirtualMs, maxRealMs, stableMs)`: `cond` holds `stableMs`, then a sentinel and
  a new frame. `cond`: `text`/`text-absent` (`resId`, `visible`), `resource`/`resource-absent`,
  `perf` `atLeast`, `all`/`any`
- `quiescent(maxVirtualMs, maxRealMs)`: quiescence past the horizon
- `sample(atVirtualMs, maxRealMs, minRealMs)`: that Android instant (advanced if controlled, else
  slept; browser time never advances)
- `live(horizonMs, timeoutMs)`: real-time quiescence, or its optional `condition`;
  `liveSample(atRealMs, timeoutMs)`: a real dwell

Quiescence ends on the first of:

- **idle:** page and foreground Worker lack main jobs (running/queued), frame callbacks,
  transitions, parked yields, in-flight fetch/decode/relay sockets and timers due before horizon +
  window (timed parks aside), and nothing presented for 150 ms; frame is a fresh readback.
- **pixels:** `lib/settle.ts` on 250 ms samples past the horizon: 4 identical, or a steady
  two-frame oscillation (a caret) taking the commoner frame; never during main work or transitions.
- **timeout:** the policy's real timeout.

The horizon bounds work, not a sleep. Quick-lane semantic steps on real clocks drop it
(except `launch`) and use 50 ms x 2 stability. For a slow step read `settled` (`idle`, `pixels`,
`timeout`, `state`, `snapshot`), `settleMs` and `busy` (polls per reason: `job:<phase>`, `queued`,
`vsync`, `transition`, `yields`, `inflight`, `sockets`, `timers`, `presented`).

## run.json

`actual[-fast]/<flow>/run.json` is saved after every step.

- **Run:** `mode`, `flowSchemaHash`, `jobs`, `screen`, `statusBarDp`, `browserErrors`, `hostFiles`,
  `aborted`.
- **Step:** `id`, `index`, `file`, `semanticHit`, `settled`, `settleMs`, `busy`, `settleTimedOut`,
  `mainLoopWedged`, `hang`, `frames`, `ms`, `perf`, `fps`/`glFps`/`presentFps`, `slow`,
  `newMissing`, `newPlaceholders`, `nativeRequired`, `newErrors`, `web`, `error`, `processes`,
  `frameHash`, `presentation`, `evidence`, `phases`.
- `hang`: threads and looper when a phase outran 30 s or the loop wedged; `stalledMs` until it
  answered (null: over 30 s).
- `processes`: per-Worker snapshots (corpus rows too); null log/perf/queue = unavailable,
  `failure` = failed read; neither means no errors.

## Metrics

Pixels compare only at the golden's geometry: `manifest.json` screen, density, crop and status
inset (absent: 24dp). The driver passes `?screen=`/`?statusBarDp=` (child processes
too; plain sessions: 0). Mismatched insets are rejected, not shifted, stretched or masked.

- **content** (target): tolerant mismatch over the union of non-background pixels (commonest
  colour at 4 bits/channel; differing backgrounds count the whole frame).
- **strict** (any RGB difference), **tolerant** (`pixelmatch` 0.1 over the crop): diagnostics.
- **structure:** named nodes (resource ID, text, content description; anonymous and system UI
  excluded) missing or more than 2 px off; tap anchors stand in without hierarchy files.
- A wedged step scores 100% content; `rawContentDiffPct`, strict and tolerant stay raw.

Output: `report/index.html`, `report/report.json`, `report/<flow>.json`, `report/<flow>-sxs/`
(golden, actual, diff).

## Re-recording goldens

```bash
pnpm e2e:setup  # create the API 35 AVD
pnpm e2e:boot  # boot, make deterministic
pnpm e2e --record  # all, or --test flows -> golden/<flow>/
pnpm e2e --record --startup --test resy  # launch-only, one live flow
```

`setup-avd.sh` (idempotent) creates `webdroid_api35_ref` from
`system-images;android-35;google_apis;arm64-v8a` at the profile geometry (`src/shell/config.ts`:
1080x2160@480, or `WEBDROID_SCREEN`); env `AVD_NAME`, `ANDROID_API`,
`ANDROID_SDK_ROOT`/`ANDROID_HOME`, `ANDROID_AVD_HOME`, `JAVA_HOME`. `boot-emulator.sh` reuses a
connected device or boots `AVD_NAME` (log `/tmp/webdroid-emulator.log`), then sets: animation
scales 0, font scale 1.0, auto time/zone off, light mode, no IME with the hardware keyboard;
SystemUI demo mode (12:00, full battery and signal, no notification icons); `adb root`, UTC,
clock at `PIN_UTC` (default `2026-01-02 12:00:00`, must equal `PINNED_CLOCK_MS`). It sets no
locale.

Install the APKs from `apks/` first. Per flow, the recorder applies the flow's `screen` (else the
profile's) via `wm size`/`density`, waits for SystemUI, measures `statusBarDp`, requires the SDK
to equal the profile's (35), sets the clock (pinned; now for live flows), runs `pm clear` and
writes `seedPrefs` as root. Per step: honor the horizon; close the soft keyboard (webdroid has
none) only if shown, since its key also closes dialogs; capture once 4 screenshots 350 ms apart
match (20 s: `settleTimedOut`). It writes `NN-id.png`, `NN-id.ui.json`, `manifest.json`
(`resolved` taps, `bounds`, `sdk`, fingerprint, `pinnedClockMs`). `--startup` takes one live
flow, never overwriting a full reference. Review, then commit `tests/e2e/golden/`.

## Flows

Flows are aspirational; keep unreachable steps. Quick: visual step, max content diff %.

| Flow | Steps | Clock | Reference (API) | Quick | Covers |
|---|---|---|---|---|---|
| fitnotes | 39 | controlled | 35, 720x1280@320 | `home-final` 22 | Barbell Curl sets, history, graph; new exercise |
| mihon-onboarding | 5 | pinned | 35, 720x1280@320 | `storage-step` 29 | Compose onboarding |
| mihon-app | 17 | pinned | 35, 720x1280@320 | `appearance-light` 14 | Library, More, Reader/Appearance settings |
| harmonic | 14 | live | 35, 720x1280@320 | `launch` 19 | presets, front page, settings, comments |
| calculatorm | 8 | controlled | 33, 1080x2424@480 | `result` 10 | 7 + 7 |
| flappybird | 7 | pinned | smoke, `minFps` 55 | motion | title, flaps, Game Over, restart |
| doodlejump | 6 | pinned | smoke, `minFps` 30 | motion | title, play, Back (ARM32) |
| komikku | 23 | pinned | smoke | semantic | onboarding, chapter, library, backup/restore |
| lichess | 15 | live | launch: 33, 1080x2424@480 | `launch` 76 | editor e2-e4; e4 Nf3 Ne5 vs Stockfish |
| resy | 15 | live | launch: 33, 1080x2160@480 | semantic | onboarding, search, venue |
| reddit | 6 | live | launch: 33, 1080x2160@480 | `launch` 4 | logged-out sheets |
| youtube | 16 | live | launch: 33, 1080x2160@480 | `launch` 82 | search, playback, Shorts |
| tiktok | 13 | live | none | semantic | guest gates, feed swipes |
| chatgpt | 24 | live | none | semantic | guest chat, settings, login |

- **mihon-app** seeds four onboarding prefs (the gate is DocumentsUI's picker). Mihon skips
  Browse/Extensions (live content).
- **harmonic** loads HN via `/proxy` (front page masked), drifting ~6 points; A/B against the
  parent.
- **flappybird/doodlejump:** the ARM64 reference emulator cannot install ARM32 libraries.
- **komikku**'s `privateStorage` hides directory pickers, stages `fixtures/komikku-page.png` in
  OPFS and requires a `files/*.tachibk` of 100+ bytes.
- lichess's reference has a notification sheet webdroid lacks; resy's an optional alert.

Failure mechanisms found with this harness (clock, settling, probe and capture pitfalls) are in the
[implementation history](../../docs/implementation-history.md#evidence-and-measurement).
