// The page's Worker that has the engine compile build code before processes call it (link/warmshim.ts). The page names the platform build, whose
// methods launches ran (warm.json) it warms while nothing else is asked; each process has a port to ask for the modules and slots its app's launches
// ran, which go first. App slots are the app's own, so each asker has its own.
import { compileBytes } from "../link/module.ts";
import { WarmWorld, type WarmCall } from "../link/warmshim.ts";

/** what a process asks for: the platform build's files to fetch, the app build's modules (with their bytes), and the slots to warm in them; `all` warms
 *  every method of the modules, for a build no launch has run yet. With `answer` they are warmed apart from the process's other requests and answered there. */
export type WarmRequest = { files?: string[]; modules?: [module: WebAssembly.Module, bytes: Uint8Array][]; slots?: Int32Array; all?: boolean; answer?: MessagePort };
/** how many methods were warmed and modules skipped since the last answer */
export type WarmAnswer = { warmed: number; skipped: number };

/** a slice of calls before messages are looked at again */
const SLICE_MS = 10;
type Asker = { to: MessagePort | typeof globalThis; wanted: Set<number>; done: Set<number>; count: WarmAnswer };
/** a module to warm: a platform file by name, or an app module, which is dropped once warmed */
type Job = { key: string | WebAssembly.Module; open(): Promise<[WebAssembly.Module, Uint8Array]>; asker: Asker; all?: boolean };

Error.stackTraceLimit = 0;
const world = new WarmWorld(), loaded = new Map<Job["key"], WarmCall[]>(), queue: Job[] = [];
let base = "", running = false;

const turn = (() => { const ch = new MessageChannel(); let wake = () => {}; ch.port1.onmessage = () => wake(); return () => new Promise<void>((r) => { wake = r; ch.port2.postMessage(0); }); })();
const fetched = (file: string) => async (): Promise<[WebAssembly.Module, Uint8Array]> => {
  const res = await fetch(base + file);
  if (!res.ok) throw new Error(`${file}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return [await compileBytes(bytes), bytes];
};

async function run(): Promise<void> {
  if (running) return;
  running = true;
  for (let job; (job = queue.shift());) {
    const { asker, key } = job, { wanted, done, count } = asker;
    let calls = loaded.get(key);
    if (!calls) {
      const got = await job.open().then((m) => world.load(...m)).catch(() => "unloadable");
      if (typeof got === "string") count.skipped++;
      calls = typeof got === "string" ? [] : got;
      if (typeof key === "string") loaded.set(key, calls);
    }
    let until = performance.now() + SLICE_MS;
    for (const [slot, f, args] of calls) {
      if (done.has(slot) || !job.all && !wanted.has(slot)) continue;
      done.add(slot); count.warmed++;
      // the warm trap, or a call the defaults made fail
      try { f(...args); } catch { /* compiled either way */ }
      if (performance.now() > until) { await turn(); until = performance.now() + SLICE_MS; }
    }
    if (!queue.some((j) => j.asker === asker)) { asker.to.postMessage(count); asker.count = { warmed: 0, skipped: 0 }; }
  }
  running = false;
}

function ask(asker: Asker, { files = [], modules = [], slots = new Int32Array(), all }: WarmRequest, first: boolean): void {
  for (const slot of slots) asker.wanted.add(slot);
  const jobs = [...modules.map(([module, bytes]): Job => ({ key: module, open: async () => [module, bytes], asker, all })),
    ...files.filter((file) => /^c\d+\.wasm$/.test(file)).map((file): Job => ({ key: file, open: fetched(file), asker }))];
  if (first) queue.unshift(...jobs); else queue.push(...jobs);
  void run();
}
const asker = (to: Asker["to"]): Asker => ({ to, wanted: new Set(), done: new Set(), count: { warmed: 0, skipped: 0 } });

globalThis.onmessage = async ({ data }: MessageEvent<{ base: string } | { port: MessagePort }>) => {
  if ("port" in data) {
    const process = asker(data.port);
    data.port.onmessage = ({ data: request }: MessageEvent<WarmRequest>) => ask(request.answer ? asker(request.answer) : process, request, true);
    return;
  }
  base = data.base;
  const json = async (file: string) => (await fetch(base + file)).json();
  const [files, slots] = await Promise.all([json("startup.json"), json("warm.json")]).catch(() => [[], []]) as [string[], number[]];
  ask(asker(globalThis), { files, slots: Int32Array.from(slots) }, false);
};
