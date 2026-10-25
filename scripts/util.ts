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

/** a job of `pool`: the cores and gigabytes of memory it holds while it runs, the seconds it takes, and the job of the same pool it waits for */
export type PoolJob<R> = { cores: number; gb: number; secs: number; after?: PoolJob<unknown>; run(): Promise<R> };

/** runs `jobs`, each once the one it waits for has finished and the `cores` and `gb` it holds are free (or nothing else runs), those that hold the
 *  most memory first and the longest of them first; results keep the jobs' order, and the first failure rejects */
export function pool<R>(jobs: PoolJob<R>[], cores: number, gb = Infinity): Promise<R[]> {
  if (!(cores >= 1)) throw new RangeError(`no cores to run ${jobs.length} jobs on`);
  const queue = jobs.map((job, index) => ({ job, index })).sort((a, b) => b.job.gb - a.job.gb || b.job.secs - a.job.secs);
  const results: R[] = new Array(jobs.length), finished = new Set<PoolJob<unknown>>();
  let usedCores = 0, usedGb = 0, running = 0;
  return new Promise((resolve, reject) => {
    const fill = () => {
      if (!queue.length && !running) return resolve(results);
      for (let i = 0; i < queue.length; i++) {
        const { job, index } = queue[i];
        if (job.after && !finished.has(job.after) || running && (usedCores + job.cores > cores || usedGb + job.gb > gb)) continue;
        queue.splice(i--, 1);
        usedCores += job.cores; usedGb += job.gb; running++;
        job.run().then((result) => {
          results[index] = result; finished.add(job);
          usedCores -= job.cores; usedGb -= job.gb; running--;
          fill();
        }, reject);
      }
    };
    fill();
  });
}

/** `run` over items, `jobs` at a time and heaviest first; results keep the items' order. */
export const runQueue = <T, R>(items: T[], jobs: number, weight: (item: T) => number, run: (item: T) => Promise<R>): Promise<R[]> =>
  pool(items.map((item) => ({ cores: 1, gb: 0, secs: weight(item), run: () => run(item) })), jobs);

/** seconds a job took when it last ran, kept in ~/.cache/webdroid/<name>.json, so a queue can start the longest first (an unknown one at its fallback, else before all). The file
 *  is only a hint: one that does not parse is no history, and a save merges this run's times into what concurrent runs saved. */
export function timings(name: string) {
  const path = join(homedir(), ".cache/webdroid", name + ".json");
  const read = (): Record<string, number> => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; } };
  const times = read(), ran: Record<string, number> = {};
  return {
    weight: (key: string, fallback = Infinity) => times[key] ?? fallback,
    record: (key: string, seconds: number) => { ran[key] = seconds; },
    save: () => { mkdirSync(dirname(path), { recursive: true }); writeWhole(path, JSON.stringify({ ...read(), ...ran })); },
  };
}
