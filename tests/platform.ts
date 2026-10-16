// Every page indexes the whole boot class path behind the app, so a spec method AOSP implements
// falls through to its platform body, and mounts the /apex data System.<clinit> reads; tests do too.
import "../scripts/node-env.ts";
import { existsSync, readFileSync } from "node:fs";
import { loadPlatformJar } from "../src/android/framework.ts";
import { PLATFORM_JARS } from "../src/jvm/provenance.ts";
import { mountApexData } from "./java.ts";
import { loadTier } from "../src/jvm/tier.ts";

await loadTier();
const jar = (name: string) => new URL(`../vendor/aosp/${name}`, import.meta.url).pathname;
if (PLATFORM_JARS.every((name) => existsSync(jar(name))))
  PLATFORM_JARS.forEach((name, i) => loadPlatformJar(new Uint8Array(readFileSync(jar(name))), i));
await mountApexData();
