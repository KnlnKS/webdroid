// The Wasm tier's compile worker (compile-serve.ts) in a page, bundled by the server and by scripts/build-prod.ts as /wasm-compile-worker.js and started by
// spawnCompileWorker (compiler.ts). Its first message brings the port it serves and the one it fetches through: it may run in another origin's process.
import "../../natives";
import { jarDexes, platformJarUrl } from "../../android/framework";
import { PLATFORM_JARS, hostWhole } from "../../jvm/provenance";
import { externs, intrinsics } from "../link/intrinsics";
import { serveCompile } from "./compile-serve";
import { natives } from "./nativesource";
import { heapUsed } from "./stats";

onmessage = ({ data: { port, fetcher } }: MessageEvent<{ port: MessagePort; fetcher: MessagePort }>) => {
  onmessage = null;
  let next = 0;
  const waiting = new Map<number, [(bytes: Uint8Array) => void, (error: Error) => void]>();
  fetcher.onmessage = ({ data: [id, bytes, error] }: MessageEvent<[number, Uint8Array | null, string?]>) => {
    const [resolve, reject] = waiting.get(id)!;
    waiting.delete(id);
    if (bytes) resolve(bytes); else reject(new Error(error));
  };
  const fetchBytes = (url: string) => new Promise<Uint8Array>((resolve, reject) => { waiting.set(next, [resolve, reject]); fetcher.postMessage([next++, url]); });
  serveCompile(port, {
    platform: async () => (await Promise.all(PLATFORM_JARS.map((jar) => fetchBytes(platformJarUrl(jar))))).flatMap((jar, i) => jarDexes(jar, PLATFORM_JARS[i])),
    natives, intrinsics, externs, heapUsed, hostWhole, fetchBytes,
  });
};
