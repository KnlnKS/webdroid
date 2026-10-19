// The page's compile host. Chrome runs the realms of a page, its Workers included, in one renderer whose V8 heaps share one 4 GB pointer cage, and a large
// app's compile workers (the app build's World over all its dexes, the second tier's) took a third of it. A sandboxed frame gets a process of its own, with a
// cage of its own, so the compile workers of every process Worker run there; a browser that keeps such a frame in the page's process runs them as before.
// Each worker the host starts reads the platform's jars from the page's Blobs while its script loads, rather than taking them from the realm that asked for it (43 MB
// copied on that realm's thread for each worker).
import { startCompileWorker, type CompileWorkerRequest } from "./compiler.ts";
import { WORKER_SCRIPTS } from "../../worker-scripts.ts";
import { platformJarBlobs } from "../../android/framework.ts";

const STALL_MS = 5000;
/** The compile workers' script. Chrome sometimes stopped delivering this 8 MB body partway (in about 1 of 80 first launches text() never settled, and the build
 *  waited for good), while a fetch of it after the stall completed at once, so a body that stops arriving for STALL_MS is fetched again. */
async function workerScript(): Promise<Blob> {
  for (let attempt = 1; ; attempt++) {
    const abort = new AbortController(), parts: Uint8Array<ArrayBuffer>[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reader = (await fetch(WORKER_SCRIPTS.compile.url, { signal: abort.signal })).body!.getReader();
      const read = () => { clearTimeout(timer); timer = setTimeout(() => abort.abort(), STALL_MS); return reader.read(); };
      for (let chunk; !(chunk = await read()).done;) parts.push(chunk.value);
      return new Blob(parts);
    } catch (error) {
      if (!abort.signal.aborted || attempt === 3) throw error;
      console.warn(`[compile host] the compile worker script stopped arriving after ${parts.reduce((n, p) => n + p.length, 0)} bytes; fetching it again`);
    } finally { clearTimeout(timer); }
  }
}

let host: Promise<(req: CompileWorkerRequest) => void> | undefined;
function compileHost(): Promise<(req: CompileWorkerRequest) => void> {
  return host ??= (async () => {
    const [source, jars] = await Promise.all([workerScript(), platformJarBlobs().catch(() => undefined)]);
    const frame = document.createElement("iframe");
    frame.sandbox.add("allow-scripts");
    frame.hidden = true;
    // An opaque origin starts a worker only from a blob of its own, and a module worker not even from that, but a classic one imports a module blob: it keeps
    // the messages that arrive meanwhile, reading the jars a message brings, for the module's handler, and reports a module that fails to load as the worker's error.
    // The first message is the script and the jars, the others are its workers' requests.
    const shim = (module: string) => `const early=[],bytes=(d)=>d.jars?Promise.all(d.jars.map(async(b)=>new Uint8Array(await b.arrayBuffer()))).then((jars)=>({...d,jars}),()=>({...d,jars:undefined})):d;
onmessage=(e)=>early.push(bytes(e.data));import(${JSON.stringify(module)}).then(async()=>{for(const d of early)dispatchEvent(new MessageEvent("message",{data:await d}))},reportError)`;
    frame.srcdoc = `<script>let url,jars;const blob=(part)=>URL.createObjectURL(new Blob([part],{type:"text/javascript"}));
onmessage=({data})=>{if(data.source){url=blob((${shim})(blob(data.source)));jars=data.jars}else(${startCompileWorker})(url,data,"classic",jars)}</script>`;
    await new Promise((resolve) => { frame.onload = resolve; document.body.append(frame); });
    const window = frame.contentWindow!;
    window.postMessage({ source, jars }, "*");
    return (req) => window.postMessage(req, "*", [req.port, req.fetcher, req.ctl]);
  })();
}

/** starts the compile workers a process Worker asks for through `port`. The host's process starts with the first process Worker, ahead of the first build. */
export function serveCompileWorkers(port: MessagePort): void {
  compileHost().catch(() => {});
  port.onmessage = ({ data }: MessageEvent<CompileWorkerRequest>) => {
    void compileHost().then((start) => start(data), () => startCompileWorker(WORKER_SCRIPTS.compile.url, data));
  };
}
