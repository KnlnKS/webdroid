// Node-side helpers the tools share.

/** `work`, or a rejection with `reason` (an Error, or one made of the text) once `ms` pass first */
export function deadline<T>(work: Promise<T>, ms: number, reason: string | Error = `timed out after ${ms} ms`): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(typeof reason === "string" ? new Error(reason) : reason), ms);
  })]).finally(() => clearTimeout(timer));
}

/** `run` over items, `jobs` at a time and heaviest first; results keep the items' order. */
export async function runQueue<T, R>(items: T[], jobs: number, weight: (item: T) => number, run: (item: T) => Promise<R>): Promise<R[]> {
  const queue = items.map((item, index) => ({ item, index })).sort((a, b) => weight(b.item) - weight(a.item));
  const results: R[] = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) results[next.index] = await run(next.item);
  }));
  return results;
}
