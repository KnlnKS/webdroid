// The page's compile host. Chrome runs the realms of a page, its Workers included, in one renderer whose V8 heaps share one 4 GB pointer cage, and a large
// app's compile workers (the app build's World over all its dexes, the second tier's) took a third of it. A sandboxed frame gets a process of its own, with a
// cage of its own, so the compile workers of every process Worker run there; a browser that keeps such a frame in the page's process runs them as before.
import { COMPILE_WORKER_URL, startCompileWorker, type CompileWorkerRequest } from "./compiler.ts";

let host: Promise<(req: CompileWorkerRequest) => void> | undefined;
function compileHost(): Promise<(req: CompileWorkerRequest) => void> {
  return host ??= (async () => {
    const source = await (await fetch(COMPILE_WORKER_URL)).text();
    const frame = document.createElement("iframe");
    frame.sandbox.add("allow-scripts");
    frame.hidden = true;
    // An opaque origin starts a worker only from a blob of its own, and a module worker not even from that, but a classic one imports a module blob: it keeps
    // the messages that arrive meanwhile for the module's handler. The first message is the script, the others are its workers' requests.
    const shim = (module: string) => `const early=[];onmessage=(e)=>early.push(e);import(${JSON.stringify(module)}).then(()=>{for(const e of early)dispatchEvent(new MessageEvent("message",{data:e.data}))})`;
    frame.srcdoc = `<script>let url;const blob=(text)=>URL.createObjectURL(new Blob([text],{type:"text/javascript"}));
onmessage=({data})=>{if(typeof data==="string")url=blob((${shim})(blob(data)));else(${startCompileWorker})(url,data,"classic")}</script>`;
    await new Promise((resolve) => { frame.onload = resolve; document.body.append(frame); });
    const window = frame.contentWindow!;
    window.postMessage(source, "*");
    return (req) => window.postMessage(req, "*", [req.port, req.fetcher, req.ctl]);
  })();
}

/** starts the compile workers a process Worker asks for through `port` */
export function serveCompileWorkers(port: MessagePort): void {
  port.onmessage = ({ data }: MessageEvent<CompileWorkerRequest>) => {
    void compileHost().then((start) => start(data), () => startCompileWorker(COMPILE_WORKER_URL, data));
  };
}
