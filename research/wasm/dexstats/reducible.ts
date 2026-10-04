/** Reducible iff every retreating edge of a depth-first search runs to a dominator (Hecht-Ullman),
 *  from a synthetic root over `roots`. */
export function isReducible(n: number, succs: (b: number) => readonly number[], roots: readonly number[]): boolean {
  const root = n, order: number[] = [], seen = new Uint8Array(n + 1);
  const sx = (b: number) => (b === root ? roots : succs(b));
  const stack: [number, number][] = [[root, 0]];
  seen[root] = 1;
  while (stack.length) {
    const top = stack[stack.length - 1], s = sx(top[0])[top[1]++];
    if (s === undefined) { order.push(top[0]); stack.pop(); } else if (!seen[s]) { seen[s] = 1; stack.push([s, 0]); }
  }
  order.reverse();
  const rpo = new Int32Array(n + 1).fill(-1);
  order.forEach((b, i) => { rpo[b] = i; });
  const preds: number[][] = Array.from({ length: n + 1 }, () => []);
  for (const u of order) for (const v of sx(u)) preds[v].push(u);
  const idom = new Int32Array(n + 1).fill(-1);
  idom[root] = root;
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 1; i < order.length; i++) {
      const b = order[i];
      let d = -1;
      for (const p of preds[b]) {
        if (idom[p] < 0) continue;
        if (d < 0) { d = p; continue; }
        let x = p;
        while (x !== d) { while (rpo[x] > rpo[d]) x = idom[x]; while (rpo[d] > rpo[x]) d = idom[d]; }
      }
      if (idom[b] !== d) { idom[b] = d; changed = true; }
    }
  }
  for (const u of order) for (const v of sx(u)) {
    if (rpo[v] > rpo[u]) continue;           // forward edge
    let x = u; while (x !== root && x !== v) x = idom[x];
    if (x !== v) return false;               // retreating edge whose head does not dominate its tail
  }
  return true;
}
