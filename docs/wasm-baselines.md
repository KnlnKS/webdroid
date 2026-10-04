# Wasm backend: JS-tier baselines (plan stage S0, baseline half)

Recorded 2026-10-04 on an Apple M4 Pro (14 cores, 24 GB), macOS (Darwin 27), Bun + Node (V8) as in the repo scripts.
`src/` is unmodified: it is identical to 28d8da41 (the worktree HEAD later moved to e376c927 only through `research/wasm/j2w`
commits by another agent). Host load average was 2-5 during runs (another agent ran light probes), so figures carry that noise; every
timing below is a median of 3 (lat) or 5 (jbench) runs with the min-max range in parentheses.
Server for lat: `PORT=4097 bun run server.ts`, `WEBDROID_URL=http://localhost:4097`. Headless Chrome via the repo's `lat` (single job).

## Verification

| Command | Result |
|---|---|
| `bun run typecheck` | pass (exit 0) |
| `bun run test` | 1142 pass, 0 fail, 57 files, 6.7 s |
| `bun run smoke apks/FitNotes.apk` | 4213 classes, 1075 ms (pure compile 1033 ms), **0 method failures**; 199 missing symbols listed (class-level, pre-existing audit output) |
| `bun run fwtest` | exit 0, 31 `ok` lines, 0 failures; native coverage 646/791 (82%), 23 prefixes withheld, 54727 framework classes |

No pre-existing failures were found. Not run (not requested for S0): `e2e`, `corpus`, `textcmp`.

## jbench (JS tier, V8/node, `bun run jbench`, default `--reps 100`, 5 full passes)

`firstMs` is the first call (includes lazy class link/compile); `medianMs` is the steady-state median per rep. Ranges are min-max over 5 passes.
Spread is typically 2-8% steady state, 5-15% first call; `fbLoop` had one outlier (max 0.754 vs median 0.306 ms).

| Workload | first ms | steady ms |
|---|---|---|
| listAddGet | 56.2 (54.1-57.3) | 0.0986 (0.0965-0.107) |
| listIter | 55.1 (50.6-55.7) | 0.1134 (0.106-0.124) |
| mapInt | 47.7 (42.7-48.8) | 0.1612 (0.157-0.193) |
| deque | 49.5 (47.6-57.4) | 0.1311 (0.126-0.140) |
| sort | 54.5 (53.7-58.3) | 0.3410 (0.319-0.407) |
| linkedList | 26.3 (25.1-27.4) | 0.2908 (0.288-0.298) |
| treeMap | 48.4 (45.1-52.0) | 0.4004 (0.395-0.417) |
| random | 52.7 (50.2-53.4) | 0.6900 (0.614-0.693) |
| casts | 63.3 (61.5-65.3) | 2.701 (2.63-2.80) |
| jsonParse | 73.9 (70.9-78.5) | 3.445 (3.24-3.61) |

Other workloads (same runs), first / steady ms: sha256 94.2/0.453, ecdsaVerify 87.6/0.377, certParse 185/0.164, listRemove 30.0/1.945,
mapStr 49.0/0.232, mapWalk 53.2/0.312, linkedMap 48.2/0.237, hashSet 47.2/0.325, smallAlloc 23.2/0.184, mix 87.0/1.339,
b64java 99.6/0.956, b64android 89.6/0.935, jsonWrite 77.1/7.60, scanTokens 285/9.57, scanLines 255/4.00, format 76.0/2.46,
dtoa 30.9/1.34, parseFail 42.5/1.45, parseFailMixed 58.7/2.77, fbLoop 55.0/0.306, fbBulk 10.2/0.042, bbInts 61.6/0.256,
dbInts 60.4/0.340, monitors 54.6/0.383, strConcat 20.8/0.166, zipOpen 180/0.635, inetCached 51.1/23.7, ssbAppend 26.5/0.373,
ssbEdit 24.9/0.382, ssbGetSpans 57.4/0.962, spannedCopy 28.0/0.294, linkify 28.3/0.049.
Checksums (`result`) are recorded by `bun run jbench` output and were identical across the 5 passes for the table workloads.

Reproduce: `for i in 1 2 3 4 5; do bun run jbench; done`. Note the steady-state medians are sub-millisecond for the collection
workloads, so timer granularity contributes to their relative spread.

## lat (tap latency, `bun run lat <scenario> [--warm]`, 3 runs each)

Scenarios present in `scripts/lat/scenarios`: fitnotes, mihon, calculatorm. Komikku has an APK in `apks/` but no lat scenario, so it was
not measured. "Launch" is navigation to the first presented frame; "idle" is navigation to idle (both ungated). Counters are `wd.perf`
at the first frame. Cold = fresh profile (no persisted compiled code); warm = the second launch in one profile (fresh app data, persisted code).

| App | Tier | Launch ms | Idle ms | compileMs | clinitMs | classesCompiled | methodsCold | coldCalls | Max gated tap ms (limit 150) |
|---|---|---|---|---|---|---|---|---|---|
| FitNotes | cold | 1755 (1694-1793) | 4033 (3991-4067) | 476 (463-478) | 250 | 3305 | 10296 | 131316 (131066-170568) | 21 |
| FitNotes | warm | 1236 (1215-1251) | 3556 (3552-3574) | 179 (174-181) | 155 | 3306 | 308 | 828 | 19 |
| Mihon | cold | 7394 (7382-7468) | 8001 (7990-8076) | 903 (884-944) | 397 | 9344 | 15716 | 173012 (171902-183050) | 98 |
| Mihon | warm | 6712 (6701-6777) | 7386 (7323-7512) | 364 (361-383) | 286 | 9344 | 1508 | 12263 (9472-12317) | 85 |
| Calculator M | cold | 1693 (1672-1698) | 2377 (2356-2383) | 467 (459-475) | 261 | 4166 | 11004 | 153002 (149176-185912) | 78 |
| Calculator M | warm | 1220 (1216-1233) | 1999 (1929-2001) | 200 (198-206) | 179 | 4241 | 1031 | 7958 (7882-8026) | 57 |

The latency gate passed in all 18 runs. G3 target to beat: cold-call compile time (cold `compileMs` above, plus per-tap `compileMs`);
no gated tap above 150 ms (Mihon cold dark/dark-warm/light-warm taps run 49-91 ms, the closest to the limit).

Per-tap cold compile cost (sum over the scenario's taps, per run): FitNotes 1.7 ms compile / 192 cold calls; Mihon 25.4 ms / 7287;
Calculator M 9.0 ms / 3413. Warm: 0.6 / 0; 9.0 / 0; 2.2 / 0.

Reproduce: `WEBDROID_URL=http://localhost:4097 bun run lat <fitnotes|mihon|calculatorm>` and again with `--warm`.
Heap size per app was not recorded (see proposals).

## Observations

- Warm persistence removes about 60% of launch `compileMs` for FitNotes/Mihon and cuts `methodsCold` by 85-97%, but launch-to-first-draw falls only 8-30%, so
  the floor is elsewhere (clinit, resources, interpretation of cold-tier code, Mihon's 6.7 s warm launch).
- Mihon launch (6.7-7.4 s) dominates; G3's cold-start goal should be judged on Mihon first.

## Proposed harness changes for S0 (not implemented)

1. Expose host crossings per tap and wasm-vs-js time as `wd.perf` counters, and add them to `COUNTERS` in `scripts/lat/run.ts` so they appear in the tap breakdown.
2. Add module count and baseline-compiled function count to `wd.perf` (`classesCompiled`/`methodsCold` are the JS-tier analogues).
3. Report `performance.memory.usedJSHeapSize` (and Wasm memory pages) at launch idle in `lat` for the per-app heap baseline the plan asks for.
4. Add a Komikku `lat` scenario (an APK exists in `apks/`) if it is to be a gated app.
5. `lat --json` already writes machine-readable results; use it for the Wasm A/B instead of text parsing.
