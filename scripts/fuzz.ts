import { inventory } from "./fuzz/inventory";
import { replayBundle, runCampaign } from "./fuzz/campaign";
import { generateApiCases, generateGraphicsCases } from "./fuzz/generate";
import { validateProbeCase } from "./fuzz/model";
import { randomSeed } from "./fuzz/random";

const [command, ...args] = process.argv.slice(2);

function value(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

function integer(name: string, fallback: number): number {
  const raw = value(name);
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

async function campaign(kind: "api" | "graphics"): Promise<void> {
  const seed = integer("--seed", randomSeed());
  const cases = integer("--cases", 1_000);
  const oracle = value("--oracle");
  const out = value("--out") ?? `fuzz-results/${kind}-${seed}`;
  if (!oracle) throw new Error(`${kind} requires --oracle <adb-serial>`);
  if (!cases) throw new Error("--cases must be at least 1");
  console.log(`seed ${seed}`);
  console.log(`cases ${cases}`);
  const result = await runCampaign({ kind, seed, cases, oracle, out });
  console.log(`${result.failures} differences; ${result.bundles.length} minimized and retained in ${out}`);
}

function smoke(): void {
  const seed = 0x5eed1234;
  const api = generateApiCases(seed, 32).map(validateProbeCase);
  const graphics = generateGraphicsCases(seed, 32).map(validateProbeCase);
  const canonical = (value: unknown): string => JSON.stringify(value, (_, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
      : item);
  if (canonical(api) !== canonical(generateApiCases(seed, 32))) throw new Error("API generation is not deterministic");
  if (canonical(graphics) !== canonical(generateGraphicsCases(seed, 32))) throw new Error("graphics generation is not deterministic");
  console.log(`fuzz smoke passed: ${api.length} API and ${graphics.length} graphics cases (seed ${seed})`);
}

switch (command) {
  case "inventory":
    await inventory(args);
    break;
  case "api":
  case "graphics":
    await campaign(command);
    break;
  case "replay": {
    const path = args.find((arg) => !arg.startsWith("-"));
    const oracle = value("--oracle");
    if (!path || !oracle) throw new Error("usage: bun run fuzz replay <failure.json> --oracle <adb-serial>");
    if (!(await replayBundle(path, oracle))) throw new Error("minimized failure did not reproduce twice");
    console.log(`reproduced twice: ${path}`);
    break;
  }
  case "smoke":
    smoke();
    break;
  default:
    throw new Error("usage: bun run fuzz <inventory|api|graphics|ui|replay|smoke> [options]");
}
