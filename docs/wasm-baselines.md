# Wasm-tier latency baseline

Recorded 2026-10-10 on an Apple M4 Pro, from `knlnks/bytecode-wasm` at `d315ed55` with the harness of `1edc0c98`
(state probed once per app frame, receipts only while listening, scroll FPS step). Headless Chrome, SwiftShader,
iframe process mode, `perfProbe=1`, one job at a time against `PORT=4190 bun run server.ts`.
Cold is a fresh profile; warm launches twice in one profile and gates the second.

`bun run lat <scenario> [--warm] [--query tier=js]`

## Launch to first app frame (ms)

| Scenario | Wasm cold | Wasm warm | JS warm |
|---|---|---|---|
| fitnotes | 3366 | 2427 | 1561 |
| calculatorm | 4763 | 2521 | 1616 |
| mihon | 11547 | 8297 | 7219 |

## Gated taps (ms, 150 ms gate)

| Tap | Wasm cold | Wasm warm | JS warm |
|---|---|---|---|
| fitnotes next/prev (6 taps) | 23–38 | 23–34 | 18–48 |
| fitnotes start | 111 | 91 | 103 |
| calculatorm 7 | **390** | 60 | **193** |
| calculatorm plus | **189** | **175** | 112 |
| calculatorm 7-warm | 50 | 89 | 39 |
| calculatorm equals | **161** | **170** | 114 |
| calculatorm clear | 71 | 77 | 66 |
| calculatorm 8 | 69 | 73 | 68 |
| mihon dark | never | never | never |
| mihon light | **319** | **248** | **167** |
| mihon dark-warm | 93 | 72 | 116 |
| mihon light-warm | 76 | 70 | 78 |
| mihon next | **287** | **265** | **197** |

## Scroll (fitnotes `scroll-chest`, 8 s of alternating swipes)

| | fps | p50 | p95 | p99 | intervals > 25 ms |
|---|---|---|---|---|---|
| Wasm cold | 30.6 | 22.5 | 29.5 | 297.3 | 21 |
| Wasm warm | 31.0 | 23.0 | 45.9 | 308.5 | 30 |
| JS warm | 31.5 | 22.0 | 41.2 | 311.2 | 22 |

Under SwiftShader these numbers measure the GPU process rather than webdroid: in a trace of the scroll the GPU
process's compositor spends 5.5 of 9 s in `SwapBuffers`, and the app Worker is busy 0.4 s. With `--gpu`, warm Wasm
at `f18fc7dc` presents at the display's rate: p50 16.6, p95 18.2, p99 29.3 ms, with 2 intervals over 25 ms. Compare
scroll with `--gpu`.

## Counters of note (Wasm warm launch)

| | modules instantiated | AOT modules loaded | methods compiled | compile ms | module ms | Suspending import calls |
|---|---|---|---|---|---|---|
| fitnotes | 3172 | 630 | 498 | 147 | 182 | 93k (cold) |
| calculatorm | 3376 | 640 | 505 | 172 | 200 | 50k |
| mihon | 4744 | — | 1457 | 632 | — | — |

Calculator's `clear` tap makes 12,831 Suspending import calls (fuel yields) for 80 ms of work.
