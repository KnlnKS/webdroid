import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { apkRoots, openApk } from "../lib.ts";
import { corpusApks } from "../apk-corpus.ts";
import { loadDexes } from "../dexes.ts";
import { AOSP } from "../aosp.ts";
import { dexesOfZip } from "../../src/jvm/dex.ts";
import { addReachedMembers, buildCatalog, sdkApiXml, type ReachedSurface } from "./catalog.ts";
import { rt } from "../../src/jvm/runtime.ts";
import { Program, reach } from "../../src/jvm/reach.ts";
import "../../src/natives.ts";

/** `pnpm fuzz inventory`: the API level's declared members by support, and with `reached` the members the corpus apps reach */
export async function inventory(options: { sdk: string; framework?: string; json?: string; reached: boolean }): Promise<void> {
  const sdk = Number(options.sdk);
  if (!Number.isInteger(sdk) || sdk < 1) throw new Error("--sdk must be a positive integer");
  const cached = `fuzz-cache/android-${sdk}/framework.jar`;
  const frameworkPath = options.framework ?? (existsSync(cached) ? cached : `${AOSP}/framework.jar`);
  const xml = sdkApiXml(sdk), frameworkDexes = loadDexes(frameworkPath);
  let catalog = buildCatalog({ sdk, xml, runtime: rt, frameworkDexes });
  if (options.reached) {
    const reached: ReachedSurface = { classes: new Map(), methods: new Map(), fields: new Map() };
    const bump = (target: Map<string, number>, source: Iterable<readonly [string, number]>) => {
      for (const [key, count] of source) target.set(key, (target.get(key) ?? 0) + count);
    };
    for (const file of corpusApks()) {
      const zip = openApk(`apks/${file}`), dexes = dexesOfZip(zip), program = new Program();
      for (const dex of dexes) program.add(dex);
      for (const dex of frameworkDexes) program.add(dex);
      const roots = apkRoots(zip, program, dexes);
      const result = reach(program, roots.methods, [...roots.classes, ...roots.named]);
      for (const cls of result.classes) reached.classes.set(cls, (reached.classes.get(cls) ?? 0) + 1);
      bump(reached.classes, result.absentClasses);
      bump(reached.methods, result.methodCalls);
      bump(reached.fields, result.fieldAccesses);
    }
    catalog = addReachedMembers(catalog, reached, rt, frameworkDexes);
  }
  console.log(`Android API ${sdk}: ${catalog.members.length} declared members`);
  for (const [support, count] of Object.entries(catalog.totals)) console.log(`  ${String(count).padStart(6)}  ${support}`);
  const { json } = options;
  if (json) {
    mkdirSync(dirname(json), { recursive: true });
    writeFileSync(json, JSON.stringify(catalog, null, 1));
    console.log(`wrote ${json}`);
  }
}
