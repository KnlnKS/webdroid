// Does a two-finger trackpad swipe land where a mouse drag lands? `bun run e2e` never fires a
// real browser event — its driver goes through page.evaluate into wd.* — so this is the only
// thing that exercises the wheel listener at all.
//   bun scripts/wheel.ts [flow] [stopAtStep] [px] [x|y]   frames land in webdroid-shots/wheel
import { mkdir } from "node:fs/promises";
import { PNG } from "pngjs";
import { WebdroidDriver } from "../tests/e2e/drivers/webdroid";
import { applyStep, loadManifest, settleStep } from "../tests/e2e/capture-webdroid";
import { FLOWS } from "../tests/e2e/flows";
import { PINNED_CLOCK_MS, SCREEN_W, SCREEN_H } from "../tests/e2e/types";
import { sleep } from "../tests/e2e/lib/util";

const app = process.argv[2] ?? "harmonic";
const stopAt = Number(process.argv[3] ?? 99);
const dist = Number(process.argv[4] ?? 400);
const horiz = process.argv[5] === "x";
const outDir = "webdroid-shots/wheel";

const flow = FLOWS.find((f) => f.app === app);
if (!flow) { console.error(`unknown flow "${app}" — known: ${FLOWS.map((f) => f.app).join(", ")}`); process.exit(2); }

type Node = { cls: string; text: string; desc: string; bounds: number[] };

/** percent of pixels that differ at all — "did anything move", not a score */
function delta(a: Buffer, b: Buffer): number {
  const x = PNG.sync.read(a).data, y = PNG.sync.read(b).data;
  let n = 0;
  for (let i = 0; i < x.length; i += 4) if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2]) n++;
  return n / (x.length / 4) * 100;
}

/**
 * How far the content actually travelled: the median rise of every node the two hierarchies
 * both name unambiguously. Pixels cannot answer this — a list that scrolled by 400 and one that
 * scrolled by 480 differ in the same "some of the screen changed" way.
 */
function travel(before: Node[], after: Node[]): number {
  const index = (ns: Node[]) => {
    const m = new Map<string, Node | null>();
    for (const n of ns) {
      const k = `${n.cls}|${n.text}|${n.desc}`;
      m.set(k, m.has(k) ? null : n);
    }
    return m;
  };
  const a = index(before), b = index(after);
  const d: number[] = [];
  for (const [k, n] of a) { const o = n && b.get(k); if (n && o) d.push(n.bounds[1] - o.bounds[1]); }
  // Compose draws its own content, so its hierarchy is one node that never moves: there the
  // pixel percentages are the only signal, which is why both are printed.
  if (!d.length) return NaN;
  d.sort((p, q) => p - q);
  return d[d.length >> 1];
}
const tree = (drv: WebdroidDriver) => drv.page.evaluate(() => (globalThis as any).wd.uiTree() as Node[]);

/**
 * A trackpad burst: one small wheel event per frame, then the decaying tail macOS keeps sending
 * after the fingers lift. Playwright emits neither the rate nor the momentum, so both are
 * synthesised here — the tail is the half of the gesture the framework must not fling twice.
 * The weights are normalised, so the finger travels exactly `dx,dy` however long the tail is.
 */
async function trackpad(drv: WebdroidDriver, nx: number, ny: number, dx: number, dy: number, steps = 20) {
  const r = await drv.page.evaluate(() => {
    const b = document.getElementById("screen")!.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  await drv.page.mouse.move(r.x + r.w * nx, r.y + r.h * ny);
  const w: number[] = [];
  for (let i = 0; i < steps; i++) w.push(1);
  for (let v = 1; v > 0.05; v *= 0.85) w.push(v);
  const sum = w.reduce((a, b) => a + b, 0);
  // the listener maps CSS px back to framebuffer px, so the burst is expressed the way a
  // trackpad expresses it and the scaling is exercised rather than bypassed
  for (const k of w) {
    await drv.page.mouse.wheel(dx * k / sum * r.w / SCREEN_W, dy * k / sum * r.h / SCREEN_H);
    await sleep(16);
  }
  await sleep(300); // the burst has to go quiet before the gesture lifts
}

await mkdir(outDir, { recursive: true });
const manifest = await loadManifest(app);
const byId = new Map((manifest?.steps ?? []).map((s) => [s.id, s]));
const drv = await WebdroidDriver.launch();
await drv.setClock(flow.liveClock ? Date.now() : PINNED_CLOCK_MS);
await drv.reset();
for (const [i, step] of flow.steps.entries()) {
  if (i > stopAt) break;
  await applyStep(drv, flow, step, byId.get(step.id));
  await settleStep(drv, step);
  console.log(`${String(i).padStart(2, "0")} ${step.label}`);
}

const from: [number, number] = horiz ? [0.75, 0.5] : [0.5, 0.75];
const to: [number, number] = horiz ? [0.75 - dist / SCREEN_W, 0.5] : [0.5, 0.75 - dist / SCREEN_H];
const base = (await drv.settle()).png, t0 = await tree(drv);
await drv.swipe(from, to);
const drag = (await drv.settle()).png, t1 = await tree(drv);
await drv.swipe(to, from);
const back = (await drv.settle()).png;
const t2 = await tree(drv);
await trackpad(drv, from[0], from[1], horiz ? dist : 0, horiz ? 0 : dist);
const wheel = (await drv.settle()).png, t3 = await tree(drv);

for (const [name, png] of [["0-base", base], ["1-drag", drag], ["2-back", back], ["3-wheel", wheel]] as const) {
  await Bun.write(`${outDir}/${name}.png`, png);
}
console.log(`\n${app} step ${Math.min(stopAt, flow.steps.length - 1)}, ${dist}px of ${horiz ? "horizontal" : "vertical"} finger travel`);
console.log(`  drag      moved ${travel(t0, t1).toFixed(0)}px, ${delta(base, drag).toFixed(1)}% of pixels — plus whatever it flung`);
console.log(`  and back  left ${delta(base, back).toFixed(2)}% of pixels differing`);
console.log(`  trackpad  moved ${travel(t2, t3).toFixed(0)}px, ${delta(back, wheel).toFixed(1)}% of pixels`);
console.log(`  the two land ${delta(drag, wheel).toFixed(1)}% apart — the drag's fling is the difference`);
console.log(`  alive     ${await drv.alive(3000)}`);
await drv.close();
