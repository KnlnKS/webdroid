import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

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
