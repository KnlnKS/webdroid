# Android API and graphics fuzzing operator guide

Differential API, graphics and UI fuzzing against an Android API 35 oracle (`vendor/aosp/build.txt`,
the SDK webdroid advertises), plus an API inventory.

## Rules

- Run the same `WebdroidFuzzProbe.apk` unchanged on both platforms; no platform-specific intents,
  test-only branches or expected values.
- Android API 35 is the reference; classify a case unstable if Android varies across identical
  replays, before changing webdroid.
- Inventory is not behavioral coverage; only recipe-owned members are exercised.
- Copy minimized bundles somewhere durable before editing, cleaning or handing off: `fuzz-cache/`
  and `fuzz-results/` are Git-ignored and die with the worktree. Never edit bundles or bypass
  validators to make them pass.
- Per AGENTS.md: missing APIs, natives, timeouts and absent diagnostics are evidence, never
  success; fix owning general rules, never per app, package, seed, case or corpus; keep goldens;
  full matrix only on frozen code.

## Commands

```bash
pnpm fuzz inventory [--sdk 35] [--no-reached] [--framework <jar>] [--json <path>]
pnpm fuzz api|graphics [--seed <n>] [--cases 1000] --oracle <serial> [--out <dir>]
pnpm fuzz ui <apk...> [--seed <n>] [--steps 100] [--oracle <serial>] [--out <dir>]
pnpm fuzz replay <failure.json> [--oracle <serial>]
pnpm fuzz smoke
```

Seeds default to random, printed and stored; `--out` to `fuzz-results/<kind>-<seed>`.
Numbers are non-negative safe integers; `--cases`/`--steps` (new actions per APK) at least 1.
`inventory` reads `fuzz-cache/android-<sdk>/framework.jar`, else `vendor/aosp/framework.jar`;
JSON only with `--json`. `api`/`graphics` and replay of their real bundles need `--oracle`.
`smoke` uses seed `0x5eed1234`. Cases, results and bundles (with UI actions) are
`schemaVersion: 1`, validated on the host and in the probe.

Code: `scripts/fuzz.ts`,
`scripts/fuzz/{model,catalog,generate,campaign,probe-runner,compare,minimize,ui-model,ui-targets,ui-explorer,ui}.ts`,
probe `tests/fuzz-probe/src/org/webdroid/fuzz/ProbeActivity.java`, diagnostics
`tests/e2e/lib/processes.ts`.

## Setup

Needs Node 24, pnpm, Java 21 (probe uses `--release 17`), `python3`, `avdmanager` and `adb` on `PATH` (or
`cmdline-tools/<v>/bin`), and the SDK at `ANDROID_SDK_ROOT`, else `ANDROID_HOME`, else
`~/Library/Android/sdk`, whose newest `build-tools/` holds `aapt2`, `d8`, `apksigner`. Keep
machine paths out of scripts.

```bash
sdkmanager 'platform-tools' 'emulator' 'platforms;android-35' \
  'system-images;android-35;google_apis;arm64-v8a'
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}"
export PATH="$JAVA_HOME/bin:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$PATH"
pnpm install
export ANDROID_SERIAL=emulator-5554   # with several devices
bash scripts/fuzz/setup-oracle.sh
adb devices
adb -s emulator-5554 shell getprop ro.build.version.sdk   # 35
adb -s emulator-5554 shell getprop ro.build.fingerprint
adb -s emulator-5554 emu avd name                         # webdroid_api35_ref
bash scripts/fuzz/build-probe.sh
pnpm smoke fuzz-cache/WebdroidFuzzProbe.apk
```

`setup-oracle.sh` (idempotent) creates/updates AVD `webdroid_api35_ref`, boots it unless an
attached device is that AVD (log `/tmp/webdroid-emulator.log`), requires SDK 35, applies
`wm size`/density from `device` in `src/shell/config.ts` (`WEBDROID_SCREEN=WxH@dpi` overrides),
and caches `framework.jar`, `framework-res.apk`, `fingerprint.txt`, `api-versions.xml` in
`fuzz-cache/android-35/`; never copy that over `vendor/aosp` (owned by `pnpm gen-framework`).
API/graphics runs reject another API or geometry; UI checks the API only.

`build-probe.sh` signs `fuzz-cache/WebdroidFuzzProbe.apk` with `ANDROID_DEBUG_KEYSTORE` (default
`~/.android/debug.keystore`); `smoke` checks its DEX compiles. Rebuild after probe, manifest,
graphics-op, normalization or protocol changes. The probe always calls `http://127.0.0.1:4876`,
forwarded by `adb reverse` on Android and the server's rewrite (`WEBDROID_FUZZ_ORIGIN`) on
webdroid. Cases and UI actions have 5 s deadlines.

Each webdroid run starts its own dev server and headless Chromium, boots the APK as the e2e launch
step does and waits for the app's process Worker to draw; screenshots composite the Workers' mirrored
frames. The server needs a platform build matching the sources (`pnpm aot`).

## Smoke

```bash
pnpm fuzz smoke
pnpm fuzz replay fuzz-results/smoke/graphics.failure.json
```

No emulator: checks deterministic generation and writes injected bundles
`fuzz-results/smoke/{api,graphics,ui}.failure.json` testing detection, minimization, serialization
and two-replay retention, not compatibility. Fix a failing smoke first.

## Inventory

```bash
pnpm fuzz inventory --sdk 35 --json fuzz-results/api-35-inventory.json
pnpm fuzz inventory --sdk 35 --no-reached --json fuzz-results/api-35-public.json
pnpm fuzz inventory --sdk 35 --framework fuzz-cache/android-35/framework.jar \
  --json fuzz-results/api-35-inventory.json   # provenance check
```

Reads declarations and since/removed from the SDK's `platforms/android-<sdk>/data/api-versions.xml`,
checks registrations and framework DEX, and unless `--no-reached` follows each
`.apk`/`.xapk` in `apks/` through framework bytecode, adding reached internals as `reached-hidden`.
Members: `kind`, `owner` (slash JVM name), `signature` (name plus descriptor, field or class),
`source`, `since`, `removed`, `support`, `exercised` (recipe-owned), `sites` (reached references).

`support`: `delegate` (registered, correctness unproven), `placeholder`
(`stubs()`/`noops()`, not compatible), `bytecode-candidate` (in paired framework bytecode, natives
unproven), `missing` (none of these, app reach unproven), `platform-absent` (removed by SDK 35,
not to restore).

```bash
F=fuzz-results/api-35-inventory.json
jq '.totals' $F
jq '[.members[] | select(.source == "public" and .support == "missing")] | length' $F
jq '.members[] | select(.sites > 0 and (.support == "missing" or .support == "placeholder"))' $F
jq '.members[] | select(.exercised)' $F
jq '.members[] | select(.owner == "android/graphics/Matrix")' $F
```

Rank reached gaps by `sites`, confirming runtime reachability first.

## API and graphics

```bash
pnpm fuzz api --seed 1592594996 --cases 1000 --oracle emulator-5554 \
  --out fuzz-results/api-1592594996
pnpm fuzz graphics --seed 1592594996 --cases 1000 --oracle emulator-5554 \
  --out fuzz-results/graphics-1592594996
```

`API_RECIPES` (`scripts/fuzz/generate.ts`) covers `Color`, `Rect`, `Uri`, `TextUtils`, `Matrix`
and stateful `Bundle`/`Intent` sequences. The reflection protocol passes null, primitive, string,
enum and int/float/string-array arguments to public or static members by descriptor and can chain
receivers; it invents no `Context`, service, callback, `Looper`, lifecycle or binder state.
Results normalize primitives, chars, enums, arrays, `Rect`, `RectF`, `Point`, `Matrix`, bitmap
metadata, `Parcelable` bytes and `CharSequence` (else class name) to key-sorted JSON; equal
exception classes pass.

Graphics cases are bounded 128x128 `GraphicsCommand` streams (`scripts/fuzz/model.ts`) over
canvas, paint, path, matrix, drawable, `RenderNode`, text and blend state. Order: outcome;
exception class; state (path bounds, RenderNode by float32; Canvas matrix within relative `2e-6`);
image, passing if `contentDiffPct <= 1` and `tolerantPct <= 0.1`. `matchKey` decides
minimization; `fingerprint` adds operation shape. At most 20 bundles are kept; the printed count
is differing cases. Campaign `precisionDeltas` lists tolerated float32 differences (case,
field, max delta).

## UI campaigns

```bash
pnpm fuzz ui apks/FitNotes.apk apks/calculatorm.apk --seed 1592594996 --steps 100 \
  --oracle emulator-5554 --out fuzz-results/ui-1592594996
pnpm fuzz ui FitNotes.apk --seed 1592594996 --steps 100 \
  --out fuzz-results/ui-webdroid-1592594996   # webdroid alone: novelty only
```

- APKs are paths or `apks/` names with a launchable activity in the merged manifest, each
  explored alone. An oracle derives actions from Android's hierarchy, takes plain APKs only (explore
  splits without it), reinstalls per episode, starts portrait and restores rotation.
- The same `--out` resumes `<package>-<sha256:12>-v2.exploration.json`; a new one starts fresh.
  Journals bound states, paths and scrolls (four per scroll family and control).
- `--steps` bounds new actions; replays cost extra, capped at 3x `--steps` and 64 episodes.
- Episodes take an untried action, else replay to the nearest saved frontier; a mismatched replay
  is `replayDivergence`, not failure.
- Actions: tap/type/swipe on enabled semantic nodes, back, enter, background/resume,
  portrait/landscape; 3x3 fallback taps only without semantic actions.
- Identity: resource ID, else text, description, class plus ordinal (coordinates kept). A target
  absent on webdroid or under 50% semantic overlap stops the run.
- The first divergence, timeout, wedge, layout/draw/GL, process or page error stops the run and is
  minimized; missing-API and native signals only mark novelty.
- Steps record tree/frame hashes, pixel scores, novelty images, errors, liveness and diagnostics
  of the page and every Worker (`ok`/`exited`/`unavailable`/`failure`); a missing one, or one
  neither `ok` nor an expected exit (`exited`), aborts.
- `visualCandidates` ranks the ten largest visual differences for review.

## Artifacts and replay

| In `--out` | Contents |
| --- | --- |
| `<kind>-<seed>.campaign.json` | `seed`, `cases`, paired results, diagnostics, `failures`, `precisionDeltas`, `retained` |
| `<kind>-<seed>-<n>.failure.json` | API/graphics bundle |
| `ui-<seed>.campaign.json` | `summaries`, `visualCandidates`, `runs` |
| `<apk>-{episode,minimized}-<e>-<step>-{webdroid,android,diff}.png` | UI novelty |
| `<package>-<sha256:12>-<hash>.failure.json` | UI bundle, never overwritten |

Bundles hold `schemaVersion`, `kind`, `seed`, `original`, `minimized` and two `reproductions`,
each owning its exact input (`input`/`actions`), `failure` and outputs (`oracle`/`webdroid` or a UI
`run`); never mix them. API/graphics bundles add `environment.oracle`/`.webdroid`, UI ones `app`.

```bash
G=fuzz-results/graphics-1592594996 B=$G/graphics-1592594996-0.failure.json
jq '{kind,seed,cases,failures,retained}' $G/graphics-1592594996.campaign.json
jq '{failure:.minimized.failure,input:.minimized.input,oracle:.minimized.oracle,webdroid:.minimized.webdroid}' $B
jq '[.minimized.failure.fingerprint,.reproductions[].failure.fingerprint]' $B   # must agree
U=fuzz-results/ui-1592594996/<bundle>.failure.json
jq '{actions:.minimized.actions,steps:[.minimized.run.steps[] | {index,structuralDivergence,signals,
  processes:[.diagnostics.processes[]? | {url,status:.diagnostics.status}]}]}' $U
pnpm fuzz replay $B --oracle emulator-5554
pnpm fuzz replay $U --oracle emulator-5554   # UI: oracle optional
```

Replay succeeds only on two fresh reproductions. UI replay uses the stored APK path; if it moved,
restore the same bytes or record the provenance change.

## Fixing

1. Record seed, APK/probe hashes, Android fingerprint, webdroid revision, non-`ok` diagnostics.
2. Replay; if it no longer reproduces, check geometry, build, dialogs, timeouts and load.
3. Locate the first divergence: protocol (harness), varying Android (oracle), API values (owner),
   state, pixels with equal state (rasterization), missing UI target (earlier layout, lifecycle).
   Tools: `inventory`, `audit`, `fwscan`, `fwtest`, `inspect`, `dis`, `wasm watdump`; for
   graphics, minimized commands, state key, PNG diff.
4. Fix the owning rule; keep narrow findings as bundles. Confirm the bundle stops reproducing for
   the intended reason, rerun its seed, then run AGENTS.md checks.

## Extending

- API recipe: one `API_RECIPES` entry, its `members` listing every exercised class/method
  (`API_RECIPE_MEMBER_IDS` derives from it), yielding an `ApiCase` with exact descriptors, typed
  `ProbeArgument`s and bounded `Random` values. Context, callbacks, loopers or shared parcels need
  an explicit contract in the union and probe, never fake nulls. Bump `schemaVersion` for
  incompatible wire changes.
- Graphics op, in lockstep: `GraphicsCommand`, `GRAPHICS_OPERATIONS`, `validateGraphicsCommand`
  (arity, types, enums), bounded generation, the `ProbeActivity.java` switch, normalized state.
- UI action: `UiAction`, `validateUiAction`, generation only when the hierarchy supports it,
  `AndroidUiTarget.act` and `WebdroidUiTarget.act`/`webAction` (never the orchestrator), optional
  `shrinkAction`, selection test.
- Then `pnpm test tests/fuzz.test.ts` (also matches ops to the Java switch), rebuild the probe,
  run a small fixed seed on both platforms.

## Troubleshooting

| Symptom | Remedy |
| --- | --- |
| `oracle <serial> is API <n>, expected API 35`, `oracle <serial> screen is ...` | Boot `webdroid_api35_ref` via setup; pass its `adb devices` serial; keep the check |
| `attached emulator is <name>, expected webdroid_api35_ref` | Set `ANDROID_SERIAL` to it |
| `missing fuzz-cache/WebdroidFuzzProbe.apk` | Run `build-probe.sh`; build-tools need `aapt2`, `d8`, `apksigner` |
| `avdmanager not on PATH`, missing system image | Fix `PATH`, install the image, rerun setup |
| `case <id> timed out after 5000ms` | Check probe UI text, logcat, `adb reverse --list`, load, liveness; keep the deadline until the cause is known |
| `no app drew within 60000ms`, `<pkg> exited before drawing` | Run `pnpm aot` if the page logged a 404 for `/aot/current.json`; else read the app's exit |
| `missing process diagnostics`/`telemetry` | Check each snapshot's URL and status; never substitute an empty array |
| Differences, no bundle | Minimization or two-replay failed, duplicate fingerprint, or 20-cap; rerun a smaller seed; no claim without two reproductions |
| UI stops with `target absent` | Intended; compare initial trees and screenshots |
| Many pixel differences | Group by fingerprint; separate edge noise from moved or missing content; never tune to a seed |
| Replay stops after a fix | Expected; confirm the seed no longer emits it; keep the bundle outside ignored storage |

The [implementation history](../../docs/implementation-history.md) records measured compatibility
limits and ownership decisions.
