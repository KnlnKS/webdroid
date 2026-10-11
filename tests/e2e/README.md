# Visual E2E harness — webdroid vs. a real Android emulator

Walks the same scripted flow through **a real Android emulator** and through **webdroid**,
then reports how far apart the two look, step by step. The output is a target: the numbers
should go down as webdroid improves.

## One command, two capture depths

```bash
PORT=4090 bun run server.ts
WEBDROID_URL=http://localhost:4090 bun run e2e
WEBDROID_URL=http://localhost:4090 bun run e2e --full --jobs 1
```

Use a private port and set `WEBDROID_URL` for every capture command. Another checkout may
already be serving the default port. Run captures sequentially: they share output directories.

`bun run e2e --full` **never touches an emulator** and does not need the Android SDK installed —
`adb` may be absent from `PATH` entirely. It reads `golden/`, drives webdroid over Playwright,
and writes `actual/` + `report/index.html`. Every flow runs in its own headless browser and
`--jobs N` (default: at most four for the full lane) bounds how many run at once; each flow is scored in a
subprocess as soon as it has captured. The serialized full matrix has taken 13–16 minutes;
live network and video flows dominate that cost.

Recording new goldens is a separate, manual step (below).

`bun run e2e` is the quick gate. By default it runs the flows reproducible from the repository
and local APKs alone (`clock: "controlled"` or `"pinned"`); `--live`, or naming a flow, adds the
flows that depend on live network content. Controlled flows advance Android time logically and
the harness pins `Date` and seeds `Math.random`, so their UI trees and checkpoint images repeat
run to run; native GL games stay on real monotonic time. Live flows use per-step readiness
checks and short observation samples instead of the full recorder's long dwell windows.

The quick pass keeps process diagnostics and a UI hierarchy at every step, and a frame hash
instead of PNG readback except at named Android visual checkpoints. Missing required text
targets, unreached states, wedged main loops, missing process diagnostics, timeouts, motion
checkpoints that presented no frames and aborted flows fail it; an exception in one flow is
recorded as that flow's failure and never discards the others. For live flows, missing APIs,
native requirements, runtime errors and browser errors are reported as observed gaps. Inspect
`actual-fast/<flow>/run.json` and each step's `.ui.json` after a failure (a wedged step's `hang`
holds its threads, what each parked one waits for, and `stalledMs` until the loop answered); the quick pass does
not rerun a failed flow. It defaults to at most five jobs and starts longer flows first using
prior run durations when available. `actual-fast/summary.json` distinguishes `compared`,
`smoke`, `observed`, `failed` and `not-selected`.

Frame rates are recorded (`fps`, `glFps`, `presentFps`) and flagged `SLOW` below a flow's
`minFps` under `--jobs 1`, but never fail the quick gate: a rate measured beside other browsers
or background load measures the host. Use `bun run lat` (below) for performance.
Flappy Bird and Doodle Jump remain smoke-only because the ARM64 reference emulator
cannot install their ARM32 native libraries. Visual checkpoints compare the launch or core
result where references exist; later live steps are semantic checks and do not claim Android
visual parity. Resy's Android launch reference includes an optional upstream alert, so its
quick flow uses semantic onboarding, search and venue checks.

### Running one flow

```bash
bun run e2e --test fitnotes           # just that flow
bun run e2e --test mihon              # prefix match: both mihon flows
bun run e2e --test fitnotes,mihon-app # comma-separated
bun run e2e fitnotes                  # bare name works too
bun run e2e --live                    # also the live-network flows
bun run e2e --jobs 1                  # one browser at a time
bun run e2e --list                    # what flows exist
bun run e2e --full --shots            # also save every distinct frame per step
```

`--full` walks every configured flow. `--record` captures Android references and `--diff`
rescores an existing full capture without launching a browser. `--test` selects a flow in
each mode.

The verification matrix excludes Genshin Impact, Clash of Clans and Clash Royale. The default
APK corpus uses the same exclusions; retained historical captures are not current targets.

`WEBDROID_CPU_THROTTLE=2` slows the page's CPU by that factor (CDP), to reproduce races that host
load exposes. `WEBDROID_SITE_ISOLATION=0` drops `--site-per-process`, so a WebView page shares the
app's renderer thread, as in Safari and Chrome on Android.

`WEBDROID_JS_FLAGS='--no-sparkplug --no-maglev'` opts either webdroid driver into a controlled
V8-tier experiment. Leave it unset when measuring stock-browser behavior.

A flow with no `golden/<flow>/manifest.json` runs in **smoke mode**: every step still executes,
`actual/<flow>/run.json` records rendered/wedged/`newMissing`/`newErrors`/perf/fps per step,
the console prints a smoke summary, and nothing is scored or written to the report. A step
with a `sample` or sampled `live` wait (a game loop never settles) is captured at its declared
logical or real instant; `tapAt` takes `repeat`/`everyMs` for a burst of taps as one step, and
`Flow.minFps` flags a motion sample as `SLOW` under `--jobs 1` (informational).
`run.json` records the `jobs` a run used. A partial run replaces `report/index.html` with only
the flows it ran, and says so.

`fps` retains its historical meaning of shell ticks per second. `glFps` counts completed
GL callbacks/swaps, and `presentFps` counts completed framebuffer transfers when the served
revision exposes that counter. Counters and elapsed time are sampled together before PNG
encoding. These capture windows still include settling and its pixel readbacks.

For isolated performance comparisons, use `bun run lat` (`scripts/lat/run.ts`): its `fps` step scrolls for a
fixed window and reports presentation intervals and page long tasks, and `--gpu` measures with Metal instead of
SwiftShader. Alternate revisions, serialize runs, and keep their code stable.

E2E steps and corpus rows also retain snapshots from the page's and every process Worker's
emulator runtime. Unavailable log, performance and queue snapshots are null; failed inspection is
explicit. Neither means an empty error list. Browser exceptions and console errors are
retained separately from runtime logs, including caught failures in child processes.

`--shots [dir]` records every distinct frame webdroid *presented* during each step, not just
the settled one that gets diffed — what you need when a step goes wrong (what was drawn on
the way, and whether anything was drawn at all). The directory is wiped per run and gitignored.
Only `e2e --full` honours it; the emulator recorder and offline scorer have no frames to record.

## How a step works

A step is declared once, semantically, in `flows/`. Two drivers interpret it:

| | emulator (`drivers/emulator.ts`) | webdroid (`drivers/webdroid.ts` + `lib/probe.ts`) |
|---|---|---|
| `tapText` | `uiautomator dump` → find node → `input tap` | `wd.locateText` → `wd.tap`; falls back to the recorded coordinate |
| `background` | HOME, then relaunch the task | pause/stop, then resume the foreground task |
| `tapAt` | `input tap` at normalized coords | `wd.tap` |
| `typeInto` | tap, `input text`, close the IME | `wd.tap` then `wd.type` |
| `swipe` / `back` | `input swipe` / `keyevent 4` | `wd.swipe` / `wd.back` |
| completion | honor the declared wait, then capture until 4 frames agree | state, quiescence, logical sample, or live wait |

The webdroid side of a step is one `page.evaluate`: the probe `lib/probe.ts` installs into the
page performs the action, waits for the app to settle, checks the main looper is alive, and
returns the step's telemetry and optional frame. Nothing polls the page from outside.
The full pass and Android recorder use each step's `wait`. Live steps can declare `fastWait`
for an observable quick-pass completion condition; otherwise the quick pass samples after
500 ms. `webdroidAction` uses an equivalent input in both browser capture modes when its
geometry differs from Android; recording still uses `action`. `fastAction` takes precedence
for an equivalent quick input when platform UI or a live text anchor differs from the reference.
Browser runners resolve these overrides once. Execution, diagnostics and `run.json` use that
resolved plan; offline scoring rejects captures whose browser actions have since changed.
Android reference fingerprints remain independent of browser overrides.

### How webdroid completes a step

The probe wraps `setTimeout`, `fetch`, `createImageBitmap`, `ImageDecoder` and `WebSocket` and observes
every presented frame (`__wdPresented`) before the page boots, and pins `Date` to the flow's clock
(Playwright's own clock shim cannot be wrapped). With that and what `wd` exposes it knows when
the app is idle. Each step declares one completion policy:

* **state** — wait for an activity, semantic text/presence change, or a named performance counter,
  then cross a main-queue sentinel and observe a resulting presentation.
* **quiescent** — wait for the conservative idle or stable-pixel rules below. Fast semantic steps
  do not retain old visual dwell horizons; full capture and checkpoint steps do.
* **sample** — advance Android-owned time to a logical instant and request the corresponding frame.
  Browser/network/media time is never advanced.
* **live** — preserve real-time waiting for external content and performance evidence.

Quiescence ends on the first of:

* **idle** — no main-looper job running or queued, no frame callbacks or pending transitions,
  no parked yields, nothing in flight over fetch/decode/the relay, no
  timer due before the policy horizon plus the stability window (timed parks are waits, not work,
  and do not count), and nothing presented in the last 150 ms. This may end a step long before
  its horizon: nothing is scheduled that could change the screen.
* **pixels** — the recorder's own rule, on frames sampled every 250 ms *past* the horizon: four
  consecutive identical samples, or a steady two-frame oscillation (a blinking caret) with the
  more frequent frame chosen. `lib/settle.ts` is the one copy of that rule.
* **timeout** — the policy's real timeout.

The policy horizon bounds relevant future work; it is not a mandatory sleep. The emulator recorder
still honors the equivalent real dwell before defining a golden. `run.json` records per
step which tier ended it (`settled`), how long it took (`settleMs`), and what kept the fast
path waiting (`busy`, poll counts per reason) — the first thing to read when a step is slow.

The captured frame is the one the pixel rule judged stable when that tier decided, and a fresh
readback of the screen when the app was idle: reading the screen while SwiftShader is busy
drawing costs seconds, and an idle compositor answers in milliseconds.

The emulator pass also **records** the coordinate each `tapText` resolved to, into
`golden/<flow>/manifest.json`. webdroid replays those coordinates whenever it cannot find the
target in its own view tree — which is always for Mihon, since Compose draws through canvas
ops and exposes no `View.text` to match on. A step that needed the fallback is flagged
`coord-fallback` in the report; that flag is itself a finding.

## Metrics and failures

Raw framebuffers are compared only at each golden's recorded geometry;
`manifest.json` names the screen, density and crop. An override such as
`WEBDROID_SCREEN=1080x2424@480` runs smoke without scoring against
mismatched pixels. Older FitNotes, Mihon and Harmonic references use
720×1280 at 320 dpi; CalculatorM uses 1080×2424 at 480 dpi.

Reference capture profiles also retain the Android status-bar inset. Older manifests use
24dp; new recordings measure `device.statusBarDp` from Android's default-display inset source.
After a size or density change, the recorder waits for SystemUI to settle before measuring it.
An explicit flow inset is checked against the device; resizing only changes dimensions and density.
The browser driver passes that profile
through `?statusBarDp=`, including child processes, and records it in `run.json`. Scoring
rejects mismatched insets rather than shifting, stretching or masking the app image. Normal
browser sessions still default to zero status-bar height. Both visual thresholds and goldens
remain independent of this capture profile.

- **content** is the target metric: tolerant mismatch over the union of
  non-background pixels. A blank rendering cannot earn a low score by
  matching a mostly white background.
- **strict** counts any RGB difference; **tolerant** uses `pixelmatch`
  threshold 0.1 over the crop. Both are diagnostics.
- **structure** compares named hierarchy nodes by resource ID, text or
  content description and counts bounds differing by more than 2 px or
  missing nodes. Anonymous containers are excluded. Old goldens without
  hierarchy files fall back to recorded tap anchors; a flow with no
  comparable nodes says so.

A step that never rendered because its main queue wedged receives a 100%
content score. `rawContentDiffPct` retains the measured pixels; strict
and tolerant scores remain raw. `wd.alive()` queues a sentinel behind
pending main work, so a frozen screen cannot masquerade as settled.
`actual/<flow>/run.json` stores the wedge flag, per-step time,
`wd.perf`, missing APIs and process diagnostics; `--diff` uses the
same record rather than inferring health from PNGs.

## Re-recording the goldens (needs an emulator)

```bash
bun run e2e:setup    # create/configure an API 35 AVD (geometry from the device profile)
bun run e2e:boot     # boot it and apply the determinism settings
bun run e2e --record # walk every flow, write golden/ + manifest.json
bun run e2e --record --startup --test resy # record only a live flow's launch reference
```

Install the APKs on the emulator first. The recorder adjusts size and density for each flow,
then verifies both geometry and SDK level before capture. Review the images and commit
`tests/e2e/golden/`; `actual/` and `report/` are ignored. Older FitNotes, Mihon, and Harmonic
references were recorded on API 35 and remain labeled as such in the report. CalculatorM was
recorded on API 33 at its declared 1080×2424 geometry. A `depth: "startup"` manifest records
only one live launch screen. The quick lane can compare it; the full lane still runs every step
but treats the flow as smoke, without claiming Android references for the remaining steps.
`--startup` requires one selected live flow and refuses to overwrite a full reference.

Determinism the recorder depends on (all applied by `boot-emulator.sh`): animations off,
SystemUI demo mode (fixed 12:00 clock, full battery, no notification icons), `adb root` +
a clock pinned to `PINNED_CLOCK_MS` (2026-01-02T12:00:00Z — FitNotes renders the current date,
and webdroid pins the same instant in its test environment), fixed locale and font scale,
light theme, and `pm clear` before each flow. Live content can still change between recordings.

The soft keyboard is closed before every capture — webdroid does not render Android's keyboard,
and a keyboard in a golden would floor that step near 50%. It is closed **only when actually shown**, because the
dismiss key also closes dialogs.

## Flows

* **fitnotes** (39 steps) — welcome dialogs → log two sets against Barbell Curl → HISTORY and
  GRAPH → create the custom exercise "Webdroid Press" (name, category, save) → find it by
  scrolling the Chest list → log two more sets → its two-point graph → back to the workout log.
* **mihon-onboarding** (5 steps) — the Compose onboarding screens, on a fresh install.
* **mihon-app** (17 steps) — Library → More → Settings → Reader (scroll, dialog) → Appearance
  (Dark/Light toggle, scroll). The recorder seeds Mihon's four onboarding preferences with
  root so the emulator starts at the Library: onboarding hard-gates on the system file picker,
  which is DocumentsUI, not Mihon, and capturing it would diff webdroid against a different app.
* **harmonic** (14 steps) — the welcome dialog and its presets, the front page, settings, a
  story and its comments. It renders live Hacker News, so it spreads ~6 points run to run;
  A/B it against the parent commit rather than reading one number.
* **calculatorm** (8 steps) — calculate 7 + 7 and compare the API 33 result screen.

The flows without full goldens run in smoke mode — every step must render, and the run
reports fps and the per-step missing-API list rather than a diff percentage:

* **flappybird** (7 steps) — splash → title → PLAY → taps flap past pipes → Game Over panel.
* **lichess** (15 steps) — Flutter home → Board editor → drag e2 to e4 → level-1 computer
  game as White → e4, Nf3, and Ne5 with native Stockfish replies. Its API 33 launch-only
  reference includes a notification permission sheet absent in webdroid, so the quick
  comparison reports a large measured difference rather than visual parity.
* **doodlejump** (6 steps) — title → play → Back, on the ARM32 native tier.
* **resy**, **reddit**, **tiktok**, **youtube**, and **chatgpt** exercise live first-run and
  content paths. Their run files expose diagnostics. Resy, Reddit, and YouTube have API 33
  launch-only Android references. TikTok and ChatGPT have no stable visual reference.

Flows are aspirational on purpose. Steps webdroid cannot reach score near 100% and *are* the
target; they are not trimmed to match what works today.

Mihon steps stay on offline-reachable screens. Sockets are real (relayed through the dev
server's `/tcp` route), but Browse/Extensions depend on live upstream content that changes
under the goldens, so they would be an unstable target rather than a fair one.
