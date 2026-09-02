# Visual E2E harness — webdroid vs. a real Android emulator

Walks the same scripted flow through **a real Android emulator** and through **webdroid**,
then reports how far apart the two look, step by step. The output is a target: the numbers
should go down as webdroid improves.

## The two commands

```bash
bun run dev      # webdroid dev server on :4080 — required by `e2e`
bun run e2e      # capture webdroid, diff against the committed goldens, write the report
```

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

Both images are the raw 720×1280 framebuffer — no rescaling ever enters the comparison. The
`webdroid_ref` AVD is configured to 720×1280 @ 320dpi precisely so this holds. Each frame is
cropped to `y ∈ [48, 1232)`, dropping the status bar (48px, `device.statusBar` in
`src/shell/config.ts`) and the gesture bar.

* **content** — the target metric. Tolerant mismatch measured over the union of the two
  images' non-background pixels. Whole-frame percentages flatter a renderer that draws
  nothing: a blank canvas scores **2.7%** against Mihon's mostly-white Library, and **97.9%**
  here. If the two backgrounds disagree outright, the whole frame counts as content — painting
  white where the real screen is blue is not a near-miss.
* **strict** — fraction of compared pixels where any RGB channel differs at all.
* **tolerant** — `pixelmatch` (threshold 0.1) over the whole cropped frame. Diagnostic only.

Also reported per flow: **rendered N/total** and **WEDGED at step N** (see below).

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
bun run e2e:setup    # create/configure the webdroid_ref AVD (720x1280 @ 320dpi)
bun run e2e:boot     # boot it and apply the determinism settings
bun run e2e:record   # walk every flow, write golden/ + manifest.json
```

Then eyeball the goldens and commit `tests/e2e/golden/`. `actual/` and `report/` are ignored.

Determinism the recorder depends on (all applied by `boot-emulator.sh`): animations off,
SystemUI demo mode (fixed 12:00 clock, full battery, no notification icons), `adb root` +
a clock pinned to `PINNED_CLOCK_MS` (2026-01-02T12:00:00Z — FitNotes renders the current date,
and webdroid pins the same instant via `page.clock.setFixedTime`), fixed locale and font scale,
light theme, and `pm clear` before each flow. Recording twice produces byte-identical PNGs.

The soft keyboard is closed before every capture — webdroid has no IME, and a keyboard in a
golden would floor that step near 50%. It is closed **only when actually shown**, because the
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

The other five have no goldens and run in smoke mode — every step must render, and the run
reports fps and the per-step missing-API list rather than a diff percentage:

* **flappybird** (7 steps) — splash → title → PLAY → taps flap past pipes → Game Over panel.
* **harmonic** (8 steps) — the welcome dialog, then the front page and a story.
* **calculatorm** (8 steps) — keys from the rendered keypad.
* **lichess** (3 steps) — boots as far as its arm64-only libflutter.so allows.
* **doodlejump** (6 steps) — title → play → Back, on the ARM32 native tier.

Flows are aspirational on purpose. Steps webdroid cannot reach score near 100% and *are* the
target; they are not trimmed to match what works today.

Mihon steps stay on offline-reachable screens. Sockets are real (relayed through the dev
server's `/tcp` route), but Browse/Extensions depend on live upstream content that changes
under the goldens, so they would be an unstable target rather than a fair one.
