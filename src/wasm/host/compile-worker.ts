// The Wasm tier's compile worker (compile-serve.ts) in a page, bundled by the server and by scripts/build-prod.ts as /wasm-compile-worker.js and started by
// spawnCompileWorker (compiler.ts). Its first message brings the port it serves and the one it fetches through, and the platform's jars from a compile host that holds
// them: it may run in another origin's process.
import "../../natives.ts";
import { jarDexes, platformJarUrl } from "../../android/framework.ts";
import { PLATFORM_JARS } from "../../jvm/provenance.ts";
import { externs, intrinsics } from "../link/intrinsics.ts";
import { serveCompile } from "./compile-serve.ts";
import { natives } from "./nativesource.ts";
import { heapUsed } from "./stats.ts";
import type { FetchAnswer, FetchRequest } from "./compiler.ts";

onmessage = ({ data: { port, fetcher, jars } }: MessageEvent<{ port: MessagePort; fetcher: MessagePort; jars?: Uint8Array[] }>) => {
  onmessage = null;
  let next = 0;
  const waiting = new Map<number, [(bytes: Uint8Array) => void, (error: Error) => void]>();
  fetcher.onmessage = ({ data: [id, bytes, error] }: MessageEvent<FetchAnswer>) => {
    const [resolve, reject] = waiting.get(id)!;
    waiting.delete(id);
    if (bytes) resolve(bytes); else reject(new Error(error));
  };
  const fetchBytes = (url: string) => new Promise<Uint8Array>((resolve, reject) => { waiting.set(next, [resolve, reject]); fetcher.postMessage([next++, url] satisfies FetchRequest); });
  serveCompile(port, {
    platform: async () => (jars ?? await Promise.all(PLATFORM_JARS.map((jar) => fetchBytes(platformJarUrl(jar))))).flatMap((jar, i) => jarDexes(jar, PLATFORM_JARS[i])),
    natives, intrinsics, externs, heapUsed, fetchBytes,
  });
};
