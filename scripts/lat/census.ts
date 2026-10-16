// The IPC census of `lat --timeline --json` runs: in each gated tap and fps window, the app Worker's calls to the broker by method (how many, their
// round trips), and how long the page took to start serving each (the Worker's Call to the page's next unmatched Serve, which includes the message
// hop). Calls the main thread made are split out, since only those hold up a frame. It sizes batching SQLite, caching Settings and moving
// system_server off the page.
//   bun scripts/lat/census.ts <run.json> ... [--windows]
import { brokerMethods } from "../../src/shell/processes.ts";

const THREAD = 17, CALL = 20, ANSWER = 21, SERVE = 25, MAIN = 1;
type Mark = [number, number, number];
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const byMethod = new Map<string, { calls: number; windows: Set<string>; trips: number[]; main: number }>(), perWindow: number[] = [], mainPerWindow: number[] = [], waits: number[] = [];
let windows = 0;
for (const file of process.argv.slice(2).filter((a) => !a.startsWith("--"))) for (const run of JSON.parse(await Bun.file(file).text())) {
  const steps = [...run.taps.map((t: any) => ({ name: t.m, worker: t.timeline?.raw, page: t.page?.raw })),
    ...(run.fps ?? []).map((f: any) => ({ name: f.m, worker: f.frames?.raw, page: undefined }))];
  for (const step of steps) {
    const worker: Mark[] = step.worker ?? [];
    if (!worker.length) continue;
    windows++;
    const open = new Map<number, [number, boolean][]>(), window = `${file}:${run.scenario}:${step.name}:${windows}`;
    let spent = 0, mainSpent = 0, thread = 0;
    for (const [ms, ev, arg] of worker) {
      if (ev === THREAD) thread = arg;
      if (ev === CALL) (open.get(arg) ?? open.set(arg, []).get(arg)!).push([ms, thread === MAIN]);
      if (ev !== ANSWER) continue;
      const call = open.get(arg)?.shift();
      if (!call) continue;
      const [at, main] = call, name = brokerMethods[arg] ?? `#${arg}`, row = byMethod.get(name) ?? byMethod.set(name, { calls: 0, windows: new Set(), trips: [], main: 0 }).get(name)!;
      row.calls++; row.windows.add(window); row.trips.push(ms - at); spent += ms - at;
      if (main) { row.main += ms - at; mainSpent += ms - at; }
    }
    perWindow.push(spent); mainPerWindow.push(mainSpent);
    if (process.argv.includes("--windows") && spent) console.log(`  ${run.scenario} ${step.name}: ${spent.toFixed(1)} ms waiting on broker calls, ${mainSpent.toFixed(1)} on the main thread`);
    const serves = (step.page as Mark[] | undefined ?? []).filter(([, ev]) => ev === SERVE).map(([ms]) => ms);
    let next = 0;
    for (const [ms, ev] of worker) {
      if (ev !== CALL) continue;
      while (next < serves.length && serves[next] < ms) next++;
      if (next < serves.length) waits.push(serves[next++] - ms);
    }
  }
}
console.log(`${windows} windows; Worker time waiting on broker calls per window p50 ${q(perWindow, 0.5).toFixed(1)} p95 ${q(perWindow, 0.95).toFixed(1)} max ${q(perWindow, 1).toFixed(1)} ms ` +
  `(main thread p95 ${q(mainPerWindow, 0.95).toFixed(1)} max ${q(mainPerWindow, 1).toFixed(1)}); ` +
  `page start of service p50 ${q(waits, 0.5).toFixed(2)} p95 ${q(waits, 0.95).toFixed(2)} max ${q(waits, 1).toFixed(2)} ms over ${waits.length} calls`);
console.log("method".padEnd(22), "calls".padStart(6), "windows".padStart(8), "trip p50".padStart(9), "p95".padStart(7), "max".padStart(7), "total ms".padStart(9), "main ms".padStart(8));
for (const [name, r] of [...byMethod].sort((a, b) => b[1].trips.reduce((s, x) => s + x, 0) - a[1].trips.reduce((s, x) => s + x, 0)))
  console.log(name.padEnd(22), String(r.calls).padStart(6), String(r.windows.size).padStart(8), q(r.trips, 0.5).toFixed(2).padStart(9), q(r.trips, 0.95).toFixed(2).padStart(7), q(r.trips, 1).toFixed(2).padStart(7), r.trips.reduce((s, x) => s + x, 0).toFixed(1).padStart(9), r.main.toFixed(1).padStart(8));
