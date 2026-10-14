// The Wasm tier's compile worker (compile-serve.ts) in a page: `new Worker("/wasm-compile-worker.js")`, bundled by the server and by scripts/build-prod.ts beside compile-worker.js.
import "../../natives";
import { fetchPlatformJars, jarDexes } from "../../android/framework";
import { PLATFORM_JARS, hostWhole } from "../../jvm/provenance";
import { externs, intrinsics } from "../link/intrinsics";
import { serveCompile, type Port } from "./compile-serve";
import { natives } from "./nativesource";
import { heapUsed } from "./stats";

serveCompile(self as unknown as Port, {
  platform: async () => (await fetchPlatformJars()).flatMap((jar, i) => jarDexes(jar, PLATFORM_JARS[i])),
  natives, intrinsics, externs, heapUsed, hostWhole,
  fetchBytes: async (url) => { const res = await fetch(url); if (!res.ok) throw new Error(`${url}: ${res.status}`); return new Uint8Array(await res.arrayBuffer()); },
});
