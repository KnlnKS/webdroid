// Every page indexes the whole boot class path behind the app, so a spec method AOSP implements
// falls through to its platform body, and mounts the /apex data System.<clinit> reads; tests do too.
import "../scripts/node-env.ts";
import { loadPlatformJar } from "../src/android/framework.ts";
import { platformJarBytes } from "../scripts/aosp.ts";
import { mountApexData } from "./java.ts";
import { loadTier } from "../src/jvm/tier.ts";

await loadTier();
const jars = platformJarBytes();
if (jars.every(Boolean)) jars.forEach((bytes, i) => loadPlatformJar(bytes!, i));
await mountApexData();
