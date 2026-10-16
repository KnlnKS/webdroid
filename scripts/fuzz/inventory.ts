import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openApk, openDexes, dexesOf } from "../lib.ts";
import { addReachedMembers, buildCatalog, sdkApiXml, type ReachedSurface } from "./catalog.ts";
import { rt } from "../../src/jvm/runtime.ts";
import { Program, reach } from "../../src/jvm/reach.ts";
import { reflectiveRoots, rootsOf } from "../../src/jvm/roots.ts";
import "../../src/natives.ts";

function option(args: string[], name: string, fallback?: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}

export async function inventory(args: string[]): Promise<void> {
  const sdk = Number(option(args, "--sdk", "35"));
  if (!Number.isInteger(sdk) || sdk < 1) throw new Error("--sdk must be a positive integer");
  const cached = `fuzz-cache/android-${sdk}/framework.jar`;
  const frameworkPath = option(args, "--framework", existsSync(cached) ? cached : "vendor/aosp/framework.jar")!;
  const xml = sdkApiXml(sdk), frameworkDexes = await openDexes(frameworkPath);
  let catalog = buildCatalog({ sdk, xml, runtime: rt, frameworkDexes });
  if (!args.includes("--no-reached")) {
    const reached: ReachedSurface = { classes: new Map(), methods: new Map(), fields: new Map() };
    const bump = (target: Map<string, number>, source: Iterable<readonly [string, number]>) => {
      for (const [key, count] of source) target.set(key, (target.get(key) ?? 0) + count);
    };
    const apks = readdirSync("apks").filter((file) => /\.x?apk$/i.test(file)).sort();
    for (const file of apks) {
      const zip = await openApk(`apks/${file}`), dexes = dexesOf(zip), program = new Program();
      for (const dex of dexes) program.add(dex);
      for (const dex of frameworkDexes) program.add(dex);
      const services: Record<string, string> = {};
      for (const name of Object.keys(zip)) if (name.startsWith("META-INF/services/")) services[name] = new TextDecoder().decode(zip[name]);
      const roots = rootsOf(zip["AndroidManifest.xml"], program, services);
      const result = reach(program, roots.methods, [...roots.classes, ...reflectiveRoots(program, dexes)]);
      for (const cls of result.classes) reached.classes.set(cls, (reached.classes.get(cls) ?? 0) + 1);
      bump(reached.classes, result.absentClasses);
      bump(reached.methods, result.methodCalls);
      bump(reached.fields, result.fieldAccesses);
    }
    catalog = addReachedMembers(catalog, reached, rt, frameworkDexes);
  }
  console.log(`Android API ${sdk}: ${catalog.members.length} declared members`);
  for (const [support, count] of Object.entries(catalog.totals)) console.log(`  ${String(count).padStart(6)}  ${support}`);
  const json = option(args, "--json");
  if (json) {
    mkdirSync(dirname(json), { recursive: true });
    writeFileSync(json, JSON.stringify(catalog, null, 1));
    console.log(`wrote ${json}`);
  }
}
