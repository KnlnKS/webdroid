import { readFileSync } from "node:fs";
import { inventory } from "./fuzz/inventory.ts";
import { replayBundle, runCampaign } from "./fuzz/campaign.ts";
import { generateApiCases, generateGraphicsCases } from "./fuzz/generate.ts";
import { validateProbeCase } from "./fuzz/model.ts";
import { Random, randomSeed } from "./fuzz/random.ts";
import { replayUiBundle, runUi } from "./fuzz/ui.ts";
import { generateUiAction } from "./fuzz/ui-model.ts";
import { runInjectedSmoke } from "./fuzz/self-test.ts";

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

function positional(): string[] {
  const optionsWithValues = new Set(["--sdk", "--json", "--seed", "--cases", "--steps", "--oracle", "--out"]);
  const output: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (optionsWithValues.has(arg)) { index++; continue; }
    if (!arg.startsWith("-")) output.push(arg);
  }
  return output;
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
  if (result.precisionDeltas) console.log(`${result.precisionDeltas} tolerated float32 state differences recorded in campaign.json`);
}

async function smoke(): Promise<void> {
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
  const bundles = await runInjectedSmoke();
  console.log(`injected mismatches minimized and replayed: ${bundles.join(", ")}`);
}

switch (command) {
  case "inventory":
    await inventory(args);
    break;
  case "api":
  case "graphics":
    await campaign(command);
    break;
  case "ui": {
    const seed = integer("--seed", randomSeed()), steps = integer("--steps", 100);
    const out = value("--out") ?? `fuzz-results/ui-${seed}`;
    console.log(`seed ${seed}`);
    console.log(`steps ${steps}`);
    await runUi({ apks: positional(), seed, steps, oracle: value("--oracle"), out });
    break;
  }
  case "replay": {
    const path = args.find((arg) => !arg.startsWith("-"));
    const oracle = value("--oracle");
    if (!path) throw new Error("usage: pnpm fuzz replay <failure.json> [--oracle <adb-serial>]");
    const header = JSON.parse(readFileSync(path, "utf8")) as { kind?: unknown; injected?: unknown };
    const kind = header.kind;
    if (kind !== "ui" && header.injected !== true && !oracle) throw new Error("API and graphics replay require --oracle <adb-serial>");
    const reproduced = kind === "ui" ? await replayUiBundle(path, oracle) : await replayBundle(path, oracle!);
    if (!reproduced) throw new Error("minimized failure did not reproduce twice");
    console.log(`reproduced twice: ${path}`);
    break;
  }
  case "smoke":
    await smoke();
    {
      const nodes = [{ text: "Save", desc: "", cls: "android.widget.Button", resId: "app:id/save",
        bounds: [0, 0, 100, 100] as [number, number, number, number], clickable: true, enabled: true,
        editable: false, scrollable: false }];
      const left = generateUiAction(new Random(0x5eed1234), nodes, 100, 100);
      const right = generateUiAction(new Random(0x5eed1234), nodes, 100, 100);
      if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error("UI generation is not deterministic");
      console.log("UI semantic generation deterministic");
    }
    break;
  default:
    throw new Error("usage: pnpm fuzz <inventory|api|graphics|ui|replay|smoke> [options]");
}
