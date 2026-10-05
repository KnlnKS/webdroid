// CPU sampling attribution, not wall-clock latency or an idle-host acceptance.
// bun scripts/wasm/cold-profile.ts <probe.cpuprofile>
export {};
const path = process.argv[2];
if (!path) throw new Error("Required: a Chrome .cpuprofile path");
type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; positionTicks?: { line: number; ticks: number }[] };
const profile = await Bun.file(path).json() as { nodes: Node[]; samples: number[]; timeDeltas: number[] };
const nodes = new Map(profile.nodes.map(n => [n.id, n]));
const rows = new Map<string, { function: string; source: string; selfUs: number; samples: number; positions: Map<number, number> }>();
for (const node of profile.nodes) {
  const f = node.callFrame, key = JSON.stringify(f);
  let row = rows.get(key);
  if (!row) rows.set(key, row = { function: f.functionName, source: `${f.url}:${f.lineNumber + 1}`, selfUs: 0, samples: 0, positions: new Map() });
  for (const pos of node.positionTicks ?? []) row.positions.set(pos.line, (row.positions.get(pos.line) ?? 0) + pos.ticks);
}
for (const [i, id] of profile.samples.entries()) {
  const node = nodes.get(id);
  if (!node) throw new Error(`Unknown sampled node ${id}`);
  const row = rows.get(JSON.stringify(node.callFrame))!;
  row.selfUs += profile.timeDeltas[i]; row.samples++;
}
console.log(JSON.stringify([...rows.values()].sort((a, b) => b.selfUs - a.selfUs).slice(0, 25).map(row => ({
  function: row.function, source: row.source, selfSampleMs: row.selfUs / 1000, samples: row.samples,
  positions: [...row.positions].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([line, ticks]) => ({ line, ticks })),
})), null, 2));
