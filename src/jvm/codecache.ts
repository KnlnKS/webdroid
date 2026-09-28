// Compiled method bodies persisted across launches (docs/bytecode-first-plan.md §4.4). A launch
// records the source of every hot and resumable body it compiles; the next launch of the same
// package, on the same bundle, installs those bodies from scripts in Cache Storage instead of
// preparing, interpreting and compiling them again, and the service worker serving the scripts
// lets V8 reuse their code cache. A body's source depends only on its dex and this bundle, so the
// key is the dex signature and method index. Saves append a chunk of the bodies not yet written,
// so their cost follows what is new rather than what the app has accumulated.

/** installs an entry body into C/C.prototype, or returns a resumable body */
export type Factory = (C: unknown, D: unknown, R: unknown, S: unknown, P: unknown, $R?: unknown) => unknown;

const CACHE = "wd-code";
/** loads with more chunks than this rewrite them as one */
const MAX_CHUNKS = 8;
const bundle = new URL(import.meta.url).pathname.replace(/[^\w.-]+/g, "_");
let dir: string | null = null;
let loaded: Record<string, Factory> = {};
let compact = false;
/** bodies compiled in this launch and not yet written */
const pending = new Map<string, string>();
/** methods that ran without a hot body: theirs is emitted in idle time, so the next launch runs it hot */
const deferred = new Map<string, () => string>();

/** where this launch persists, what it loaded and what it has yet to write */
export const codeStats = () => ({ dir, loaded: Object.keys(loaded).length, pending: pending.size, deferred: deferred.size });

export const codeKey = (dexId: string, methodIdx: number, form: "e" | "r") => `${dexId}:${methodIdx}:${form}`;

/** the persisted body for `key`, if an earlier launch compiled one */
export function persistedBody(key: string): Factory | undefined { return loaded[key]; }

/** a body compiled in this launch: `body` is the factory's statements (an entry) or expression (resumable) */
export function recordBody(key: string, body: string, form: "e" | "r"): void {
  if (loaded[key] || pending.has(key)) return;
  pending.set(key, form === "e" ? `(C,D,R,S,P,$R)=>{${body}\n}` : `(C,D,R,S,P)=>(${body}\n)`);
  deferred.delete(key);
  idle();
}

/** a method that ran without a hot body; `make` emits one */
export function recordLater(key: string, make: () => string): void {
  if (loaded[key] || pending.has(key)) return;
  deferred.set(key, make);
  idle();
}

/** install persisted bodies: what loadCode imports from codeText's modules */
export function useCode(bodies: Record<string, Factory>): void { loaded = bodies; }

/** a module whose default export is `bodies` (the pending ones by default) */
export function codeText(bodies: Iterable<[string, string]> = pending): string {
  let text = "export default {\n";
  for (const [key, source] of bodies) text += `${JSON.stringify(key)}:${source},\n`;
  return text + "};\n";
}

/** load `app`'s persisted bodies; a launch without them records its own */
export async function loadCode(app: string): Promise<void> {
  if (typeof caches === "undefined") return;
  dir = `/wd-code/${bundle}/${encodeURIComponent(app)}/`;
  addEventListener("pagehide", () => void saveCode());
  try {
    const cache = await caches.open(CACHE), mine: string[] = [], suffix = `/${encodeURIComponent(app)}/`;
    for (const request of await cache.keys()) {
      const path = new URL(request.url).pathname;
      if (path.startsWith(dir)) mine.push(path);
      // an older bundle's chunks for this app are stale; other apps' belong to other realms
      else if (path.includes(suffix)) void cache.delete(request);
    }
    // through the service worker when it controls the page, so V8 can reuse its code cache
    const direct = !!navigator.serviceWorker?.controller;
    const modules = await Promise.all(mine.map(async (path) =>
      (await import(/* @vite-ignore */ direct ? path : URL.createObjectURL(await (await cache.match(path))!.blob()))).default));
    useCode(Object.assign({}, ...modules));
    compact = mine.length > MAX_CHUNKS;
  } catch (e) { console.warn("[webdroid] persisted code unavailable", e); }
}

let idling = false;
/** emit deferred bodies while the page is idle, then write what is pending */
function idle(): void {
  if (idling || !dir || typeof requestIdleCallback === "undefined") return;
  idling = true;
  requestIdleCallback(function work(deadline) {
    for (const [key, make] of deferred) {
      if (deadline.timeRemaining() < 1) { requestIdleCallback(work); return; }
      deferred.delete(key);
      try { recordBody(key, make(), "e"); } catch { /* it compiles on demand instead */ }
    }
    idling = false;
    if (performance.now() - lastSave > 30_000) void saveCode();
  }, { timeout: 60_000 });
}

let saving: Promise<void> = Promise.resolve(), lastSave = 0;
/** append the pending bodies as one chunk; a load that found too many chunks rewrites them all */
export function saveCode(): Promise<void> {
  return saving = saving.then(async () => {
    if (!dir || !(pending.size || compact) || typeof caches === "undefined") return;
    const bodies: [string, string][] = compact ? Object.entries(loaded).map(([k, f]) => [k, f.toString()]) : [];
    bodies.push(...pending);
    pending.clear();
    lastSave = performance.now();
    const cache = await caches.open(CACHE), old = compact ? await cache.keys() : [];
    await cache.put(`${dir}${Date.now().toString(36)}.js`, new Response(codeText(bodies), { headers: { "content-type": "text/javascript" } }));
    if (compact) for (const request of old) if (new URL(request.url).pathname.startsWith(dir)) void cache.delete(request);
    compact = false;
  }).catch((e) => console.warn("[webdroid] saving compiled code failed", e));
}
