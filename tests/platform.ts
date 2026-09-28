// Every page indexes the whole boot class path behind the app, so a spec method AOSP implements
// falls through to its platform body; tests index it too.
import { existsSync, readFileSync } from "node:fs";
import { loadPlatformJar } from "../src/android/framework";
import { PLATFORM_JARS } from "../src/jvm/provenance";

const jar = (name: string) => new URL(`../vendor/aosp/${name}`, import.meta.url).pathname;
if (PLATFORM_JARS.every((name) => existsSync(jar(name))))
  PLATFORM_JARS.forEach((name, i) => loadPlatformJar(new Uint8Array(readFileSync(jar(name))), i));
