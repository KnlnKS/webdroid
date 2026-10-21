// Every page indexes the whole boot class path behind the app, so a spec method AOSP implements
// falls through to its platform body, and mounts the /apex data System.<clinit> reads; tests do too.
import "../scripts/node-env.ts";
import { hasPlatformJars } from "../scripts/aosp.ts";
import { bootTier } from "../scripts/tier.ts";
import { loadTier } from "../src/jvm/tier.ts";

// a checkout without the reference build runs the tests that need none; the others skip
await (hasPlatformJars() ? bootTier() : loadTier());
