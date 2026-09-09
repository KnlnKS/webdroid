# Visual E2E harness — webdroid vs. a real Android emulator

Walks the same scripted flow through **a real Android emulator** and through **webdroid**,
then reports how far apart the two look, step by step. The output is a target: the numbers
should go down as webdroid improves.

## The two commands

```bash
PORT=4090 bun run server.ts
WEBDROID_URL=http://localhost:4090 bun run e2e
```

Use a private port and set `WEBDROID_URL` for every capture command. Another checkout may
already be serving the default port. Run captures sequentially: they share output directories.

`bun run e2e` **never touches an emulator** and does not need the Android SDK installed —
`adb` may be absent from `PATH` entirely. It reads `golden/`, drives webdroid over Playwright,
and writes `actual/` + `report/index.html`.

Recording new goldens is a separate, manual step (below).

### Running one flow

```bash
bun run e2e --test fitnotes           # just that flow
bun run e2e --test mihon              # prefix match: both mihon flows
bun run e2e --test fitnotes,mihon-app # comma-separated
bun run e2e fitnotes                  # bare name works too
bun run e2e --list                    # what flows exist
bun run e2e --shots                   # also save every distinct frame per step to webdroid-shots/
```

`--test` works the same way on `e2e:record` and `e2e:diff`.

### Authenticated Reddit diagnostic

With `REDDIT_USERNAME` and `REDDIT_PASSWORD` supplied in the environment, run:

```bash
WEBDROID_URL=http://localhost:4090 bun tests/e2e/reddit.ts
```

This separate, opt-in smoke run signs in and exercises the feed, navigation drawer, Back,
and a post with comments and an empty composer at 1080×2424 @480dpi. It saves only post-login screenshots and
redacted text/telemetry to `actual/reddit/`; it never records credential screens. Run it
sequentially with the main suite. Live feed content can move the post target or select an
image lightbox, so a timeout is a diagnostic failure to inspect, not proof of an emulator bug.

Completion requires newly presented canvas text: post detail must draw "Join the
conversation", scrolling must reach "Reply", and Back must remove the detail marker. A stable white pixel or
an attached container cannot pass. The diagnostic hook observes synchronous canvas calls,
including Compose replay; clipping and occlusion still require screenshot inspection.
It neither votes nor submits comments.

`WEBDROID_JS_FLAGS='--no-sparkplug --no-maglev'` opts either webdroid driver into a controlled
V8-tier experiment. The Reddit run records the supplied flags. Leave it unset when measuring
stock-browser behavior.

A flow with no `golden/<flow>/manifest.json` runs in **smoke mode**: every step still executes,
`actual/<flow>/run.json` records rendered/wedged/`newMissing`/`newErrors`/perf/fps per step,
the console prints a smoke summary, and nothing is scored or written to the report. A step
declared `animated: true` (a game loop never settles) is captured once after its
`settleDelayMs` instead of waiting for stable frames; `tapAt` takes `repeat`/`everyMs` for a
burst of taps as one step, and `Flow.minFps` flags an animated step as `SLOW`. A partial run replaces
`report/index.html` with only the flows it ran, and says so.

`--shots [dir]` records every distinct webdroid frame *during* each step, not just the settled
one that gets diffed — what you need when a step goes wrong (what was drawn on the way, and
whether anything was drawn at all). The directory is wiped per run and gitignored. Only `e2e`
honours it; the emulator recorder and `e2e:diff` have no frames to record.

## How a step works

A step is declared once, semantically, in `flows/`. Two drivers interpret it:

| | emulator (`drivers/emulator.ts`) | webdroid (`drivers/webdroid.ts`) |
|---|---|---|
| `tapText` | `uiautomator dump` → find node → `input tap` | `wd.locateText` → `wd.tap`; falls back to the recorded coordinate |
| `tapAt` | `input tap` at normalized coords | `wd.tap` |
| `typeInto` | tap, `input text`, close the IME | `wd.tap` then `wd.type` |
| `swipe` / `back` | `input swipe` / `keyevent 4` | `wd.swipe` / `wd.back` |

The emulator pass also **records** the coordinate each `tapText` resolved to, into
`golden/<flow>/manifest.json`. webdroid replays those coordinates whenever it cannot find the
target in its own view tree — which is always for Mihon, since Compose draws through canvas
ops and exposes no `View.text` to match on. A step that needed the fallback is flagged
`coord-fallback` in the report; that flag is itself a finding.

## Metrics

Both images are the raw framebuffer at the geometry the goldens were recorded at — no rescaling
ever enters the comparison. Each golden set carries that geometry in its `manifest.json`
`device` block, and the run navigates the page to it (`?screen=WxH@dpi`), so the shell's own
default can move without invalidating a golden. `bun run e2e:setup` reads the same geometry out
of the device profile, so the `webdroid_ref` AVD cannot drift from it. Today every set is
720×1280 @ 320dpi, cropped to `y ∈ [48, 1232)` — dropping the status bar (`device.statusBar`)
and the gesture bar.

`WEBDROID_SCREEN=1080x2424@480 bun run e2e` runs every flow at that size instead. Such a run is
reported as **smoke, never scored**: the goldens are pixels at one size, so a run at any other
size measures cost, not fidelity.

* **content** — the target metric. Tolerant mismatch measured over the union of the two
  images' non-background pixels. Whole-frame percentages flatter a renderer that draws
  nothing: a blank canvas scores **2.7%** against Mihon's mostly-white Library, and **97.9%**
  here. If the two backgrounds disagree outright, the whole frame counts as content — painting
  white where the real screen is blue is not a near-miss.
* **strict** — fraction of compared pixels where any RGB channel differs at all.
* **tolerant** — `pixelmatch` (threshold 0.1) over the whole cropped frame. Diagnostic only.

Also reported per flow: **rendered N/total** and **WEDGED at step N** (see below).

### structure — which view is wrong, not how much

Beside the pixel numbers, each step compares the two **view hierarchies**: what
`uiautomator dump` reported on the device against what `wd.uiTree()` reports here, both in
absolute device px with the status bar included.

Views are paired by what both sides can name the same way — resource id first, then text, then
content-description, which is what the tap resolver already matches on. Anonymous containers
are not comparable; system chrome is not the app's hierarchy. **STRUCTURE** is the share of
nameable device views that webdroid puts somewhere else (>2px on any edge) or does not have at
all, so it falls as things improve like everything else here. The worst offenders print with
both sets of bounds:

```
  STRUCTURE  83.33% of nameable device views misplaced, over 18 steps
    02 t:OK off by 494px  device [50,1082,670,1178] here [544,1084,648,1172]
```

That line says the dialog's OK button is within 2px vertically and 104px wide where the device
makes it 620 — the button bar is not stretching. A content percentage cannot say that.

The device half comes from `NN-id.ui.json` beside each golden png, written by `e2e:record`.
Goldens recorded before that existed have no hierarchy files, and the metric falls back to the
one node the manifest already carries for every `tapText` step: the bounds the device resolved
that anchor to. Those are read **a step behind** — a tap resolves against the screen already on
display, so the bounds recorded for step N+1 describe the frame captured at step N. Re-record to
compare whole hierarchies instead of one node per step.

A flow that pairs nothing says so rather than reporting 100%: Compose draws through canvas ops
and exposes no `View.text` for either side to name, which is why those flows also fall back to
recorded coordinates for their taps.

### Non-renders score 100%

A step webdroid never rendered — because its main-looper queue was wedged — is scored a flat
**100%** content diff, not the measured pixel difference. A frozen frame is one the app drew
several steps ago, so measuring it hands out partial credit for background pixels that happen
to have survived: a frozen FitNotes home screen measures only ~66% against the golden's graph
screen. That is not a rendering near-miss; the app was not executing.

Nothing is hidden by this. The measurement is kept as `rawContentDiffPct` per step and
`meanRawContentDiffPct` per flow, both shown in the report and in the console summary
(`34 never rendered, scored 100%; raw mean 81.00%`). Only **content** is scored this way —
`strict` and `tolerant` stay pure measurements, since they are diagnostics.

Note the distinction: *wedged* means the app stopped executing. An app that is alive but draws
the wrong thing (webdroid on Mihon renders a blank canvas) is **not** wedged and is scored on
its measured pixels — it rendered, it just rendered wrongly.

## Wedge detection

webdroid runs every input, layout pass and frame through one serialized main-looper queue
(`src/android/mainloop.ts`). If a job in that queue never settles, the app stops responding
*and* stops repainting — which from the outside is indistinguishable from "the screen
settled". `wd.alive()` enqueues a no-op behind whatever is in the queue and races it against a
timeout, so a hung app is reported as hung instead of quietly scoring as stable.

The capture pass writes these flags to `actual/<flow>/run.json`, so a standalone
`bun run e2e:diff` scores identically to a full `bun run e2e` instead of silently reporting a
better number for the same pixels. `run.json` is also the perf artifact: per step it keeps the
wall-clock `ms`, the `wd.perf` counters burned, and `newMissing` (the APIs the step was the
first to ask for and not find). None of that is in the HTML report; read the file.

## Re-recording the goldens (needs an emulator)

```bash
bun run e2e:setup    # create/configure the webdroid_ref AVD (geometry from the device profile)
bun run e2e:boot     # boot it and apply the determinism settings
bun run e2e:record   # walk every flow, write golden/ + manifest.json
```

Then eyeball the goldens and commit `tests/e2e/golden/`. `actual/` and `report/` are ignored.

Determinism the recorder depends on (all applied by `boot-emulator.sh`): animations off,
SystemUI demo mode (fixed 12:00 clock, full battery, no notification icons), `adb root` +
a clock pinned to `PINNED_CLOCK_MS` (2026-01-02T12:00:00Z — FitNotes renders the current date,
and webdroid pins the same instant via `page.clock.setFixedTime`), fixed locale and font scale,
light theme, and `pm clear` before each flow. Recording twice produces byte-identical PNGs.

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

The other four have no goldens and run in smoke mode — every step must render, and the run
reports fps and the per-step missing-API list rather than a diff percentage:

* **flappybird** (7 steps) — splash → title → PLAY → taps flap past pipes → Game Over panel.
* **calculatorm** (8 steps) — keys from the rendered keypad.
* **lichess** (15 steps) — Flutter home → Board editor → drag e2 to e4 → level-1 computer
  game as White → e4, Nf3, and Ne5 with native Stockfish replies.
* **doodlejump** (6 steps) — title → play → Back, on the ARM32 native tier.

Flows are aspirational on purpose. Steps webdroid cannot reach score near 100% and *are* the
target; they are not trimmed to match what works today.

Mihon steps stay on offline-reachable screens. Sockets are real (relayed through the dev
server's `/tcp` route), but Browse/Extensions depend on live upstream content that changes
under the goldens, so they would be an unstable target rather than a fair one.
