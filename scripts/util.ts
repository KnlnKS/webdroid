// Node-side helpers the tools share.
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeWhole } from "./generated.ts";

/** `work`, or a rejection with `reason` (an Error, or one made of the text) once `ms` pass first */
export function deadline<T>(work: Promise<T>, ms: number, reason: string | Error = `timed out after ${ms} ms`): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(typeof reason === "string" ? new Error(reason) : reason), ms);
  })]).finally(() => clearTimeout(timer));
}

/** `run` over items, `jobs` at a time and heaviest first; results keep the items' order. */
export async function runQueue<T, R>(items: T[], jobs: number, weight: (item: T) => number, run: (item: T) => Promise<R>): Promise<R[]> {
  if (!(jobs >= 1)) throw new RangeError(`no jobs to run ${items.length} items with`);
  const queue = items.map((item, index) => ({ item, index })).sort((a, b) => weight(b.item) - weight(a.item));
  const results: R[] = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) results[next.index] = await run(next.item);
  }));
  return results;
}

/** seconds a job took when it last ran, kept in ~/.cache/webdroid/<name>.json, so a queue can start the longest first (unknown ones before all). The file
 *  is only a hint: one that does not parse is no history, and a save merges this run's times into what concurrent runs saved. */
export function timings(name: string) {
  const path = join(homedir(), ".cache/webdroid", name + ".json");
  const read = (): Record<string, number> => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; } };
  const times = read(), ran: Record<string, number> = {};
  return {
    weight: (key: string) => times[key] ?? Infinity,
    record: (key: string, seconds: number) => { ran[key] = seconds; },
    save: () => { mkdirSync(dirname(path), { recursive: true }); writeWhole(path, JSON.stringify({ ...read(), ...ran })); },
  };
}
