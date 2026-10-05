// Fetches and compiles the modules of the platform build a start of the process wants in workers of their own. The engine takes a streamed module's bytes on the thread that
// fetched them, which for 130 MB of modules keeps the page's main thread from anything else for hundreds of milliseconds; a compiled module crosses to the page as it is. Several
// workers share the files, as the machine has threads for them.
import { COMPILE_OPTIONS } from "../link/module";
import type { FetchStore } from "../link/aotstore";

// each worker keeps a few requests in flight (link/aotstore.ts WIDTH: Chrome fails requests once about 1,600 are pending)
const SOURCE = `onmessage = async ({ data: { base, files, options, width } }) => {
  const queue = [...files];
  await Promise.all(Array.from({ length: width }, async () => {
    for (let file; (file = queue.shift()) !== undefined;) {
      try { postMessage({ file, module: await WebAssembly.compileStreaming(fetch(base + file), options) }); } catch { postMessage({ file }); }
    }
  }));
  postMessage({ done: true });
};`;
const MAX_WORKERS = 4, WIDTH = 8;

/** `files` of `store`'s build compiled by workers, which the store holds when this resolves; a file that could not be fetched or compiled is left out, as in `FetchStore.prefetch`, which does it all on the page when there is no worker */
export function prefetchInWorker(store: FetchStore, files: string[]): Promise<void> {
  const todo = files.filter((f) => !store.has(f)), n = Math.max(1, Math.min(MAX_WORKERS, (navigator.hardwareConcurrency || 4) >> 1));
  const url = URL.createObjectURL(new Blob([SOURCE], { type: "text/javascript" })), base = new URL(store.base, location.href).href;
  return Promise.all(Array.from({ length: n }, (_, k) => new Promise<void>((resolve) => {
    // the list is in the order the start wants the files, so each worker takes every n-th
    const share = todo.filter((_, i) => i % n === k);
    let worker: Worker;
    try { worker = new Worker(url); } catch { void store.prefetch(share).then(resolve); return; }
    worker.onmessage = ({ data }: MessageEvent<{ file?: string; module?: WebAssembly.Module; done?: boolean }>) => {
      if (data.done) { worker.terminate(); resolve(); } else if (data.module) store.put(data.file!, data.module); else store.failed.push(data.file!);
    };
    worker.onerror = () => { worker.terminate(); void store.prefetch(share).then(resolve); };
    worker.postMessage({ base, files: share, options: COMPILE_OPTIONS, width: WIDTH });
  }))).then(() => URL.revokeObjectURL(url));
}
