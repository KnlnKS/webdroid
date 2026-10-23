import { availableParallelism } from "node:os";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

/** half the host's cores: how many jobs that each keep a core busy run at once unless --jobs says otherwise */
export const HALF_CORES = Math.max(1, availableParallelism() >> 1);
/** the --jobs value `cli` read, else WEBDROID_JOBS (the share of its own jobs a runner gives each runner it starts), else `fallback`: anything but a
 *  positive whole number exits with status 2, as a gate that ran nothing must not pass */
export function jobsOf(value: string | undefined, fallback: number): number {
  value ??= process.env.WEBDROID_JOBS;
  const jobs = value === undefined ? fallback : Number(value);
  if (Number.isInteger(jobs) && jobs > 0) return jobs;
  console.error(`--jobs or WEBDROID_JOBS needs a positive whole number, not ${value}`);
  process.exit(2);
}

/** the command line as node:util's parseArgs reads it with `options`, positional arguments allowed. An option `options` does not declare,
 *  a missing value or fewer than `min` positional arguments print `usage` and exit with status 2. */
export function cli<const O extends ParseArgsOptionsConfig>(usage: string, options: O, { min = 0, args = process.argv.slice(2) } = {}) {
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true });
    if (parsed.positionals.length >= min) return parsed;
  } catch (e) { console.error((e as Error).message); }
  console.error(`usage: ${usage}`);
  process.exit(2);
}
