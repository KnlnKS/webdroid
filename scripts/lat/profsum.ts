// Self and inclusive time per function in a V8 CPU profile, optionally for one tap:
//   bun scripts/lat/profsum.ts <file.cpuprofile> [top=40] [tap=<n> window=<ms> | until=<ms>]
// A tap window starts at the n-th __wdMarkUp sample (bun run lat --cpuprofile) and lasts `window` ms;
// `until` keeps the profile's first ms, such as a launch up to its first frame.
export {};
const [file, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.map((a) => a.split("=")));
const prof = JSON.parse(await Bun.file(file).text());
const nodes = new Map<number, any>(prof.nodes.map((n: any) => [n.id, n]));
const parent = new Map<number, number>();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const key = (n: any) => `${n.callFrame.functionName || "<anon>"} ${(n.callFrame.url || "").split("/").pop()}:${n.callFrame.lineNumber + 1}`;
const times: number[] = [];
for (let i = 0, t = prof.startTime; i < prof.samples.length; i++) times.push(t += prof.timeDeltas[i]);
let from = -Infinity, to = opt.until === undefined ? Infinity : prof.startTime + +opt.until * 1000;
if (opt.tap !== undefined) {
  const marks = times.filter((_, i) => nodes.get(prof.samples[i]).callFrame.functionName === "__wdMarkUp");
  const starts = marks.filter((t, i) => i === 0 || t - marks[i - 1] > 5000);
  from = starts[+opt.tap];
  if (from === undefined) throw new Error(`only ${starts.length} marked taps`);
  to = from + +(opt.window ?? 300) * 1000;
}
const self = new Map<string, number>(), incl = new Map<string, number>();
let total = 0;
for (let i = 1; i < prof.samples.length; i++) {
  if (times[i] < from || times[i] > to) continue;
  const dt = prof.timeDeltas[i], id = prof.samples[i], k = key(nodes.get(id));
  self.set(k, (self.get(k) ?? 0) + dt);
  total += dt;
  const seen = new Set<string>();
  for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
    const kk = key(nodes.get(cur));
    if (!seen.has(kk)) { seen.add(kk); incl.set(kk, (incl.get(kk) ?? 0) + dt); }
  }
}
const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, +(opt.top ?? 40))
  .map(([k, v]) => `${(v / 1000).toFixed(1).padStart(8)} ms  ${k}`).join("\n");
console.log(`total ${(total / 1000).toFixed(1)} ms\n== self ==\n${top(self)}\n== inclusive ==\n${top(incl)}`);
