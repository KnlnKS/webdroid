// Compiled method bodies persisted across launches (docs/bytecode-first-plan.md §4.4). A launch
// records the source of every hot and resumable body it compiles; the next launch of the same
// package, on the same bundle, installs those bodies from a script in Cache Storage instead of
// preparing, interpreting and compiling them again, and the service worker serving that script
// lets V8 reuse its code cache. A body's source depends only on its dex and this bundle, so the
// key is the dex signature and method index, and the bundle names the file.

/** installs an entry body into C/C.prototype, or returns a resumable body */
export type Factory = (C: unknown, D: unknown, R: unknown, S: unknown, P: unknown, $R?: unknown) => unknown;

const CACHE = "wd-code";
const bundle = new URL(import.meta.url).pathname.replace(/[^\w.-]+/g, "_");
let url: string | null = null;
let loaded: Record<string, Factory> = {};
const used = new Map<string, string>();
let unsaved = 0;

/** what this launch loaded, reused and has yet to save */
export const codeStats = () => ({ url, loaded: Object.keys(loaded).length, used: used.size, unsaved });

export const codeKey = (dexId: string, methodIdx: number, form: "e" | "r") => `${dexId}:${methodIdx}:${form}`;

/** the persisted body for `key`, if the last launch compiled one */
export function persistedBody(key: string): Factory | undefined {
  const factory = loaded[key];
  if (factory && !used.has(key)) used.set(key, factory.toString());
  return factory;
}

/** a body compiled in this launch: `body` is the factory's statements (an entry) or expression (resumable) */
export function recordBody(key: string, body: string, form: "e" | "r"): void {
  if (used.has(key)) return;
  used.set(key, form === "e" ? `(C,D,R,S,P,$R)=>{${body}\n}` : `(C,D,R,S,P)=>(${body}\n)`);
  unsaved++;
}

/** install persisted bodies: what loadCode imports from codeText's module */
export function useCode(bodies: Record<string, Factory>): void { loaded = bodies; }

/** a module whose default export is every body this launch used or compiled */
export function codeText(): string {
  let text = "export default {\n";
  for (const [key, source] of used) text += `${JSON.stringify(key)}:${source},\n`;
  return text + "};\n";
}

/** load `app`'s persisted bodies; a launch without them records its own */
export async function loadCode(app: string): Promise<void> {
  if (typeof caches === "undefined") return;
  url = `/wd-code/${bundle}/${encodeURIComponent(app)}.js`;
  try {
    if (!await (await caches.open(CACHE)).match(url)) return;
    // through the service worker when it controls the page, so V8 can reuse its code cache
    const source = navigator.serviceWorker?.controller ? url : URL.createObjectURL(await (await (await caches.open(CACHE)).match(url))!.blob());
    useCode((await import(/* @vite-ignore */ source)).default);
  } catch (e) { console.warn("[webdroid] persisted code unavailable", e); }
  finally {
    setInterval(() => void saveCode(), 15_000);
    addEventListener("pagehide", () => void saveCode());
  }
}

/** write every body this launch used or compiled, when there is anything new */
export async function saveCode(): Promise<void> {
  if (!url || !unsaved || typeof caches === "undefined") return;
  unsaved = 0;
  const cache = await caches.open(CACHE);
  await cache.put(url, new Response(codeText(), { headers: { "content-type": "text/javascript" } }));
  // an older bundle's file for this app is stale; other apps' files belong to other realms
  const name = url.slice(url.lastIndexOf("/"));
  for (const request of await cache.keys()) if (request.url.endsWith(name) && !request.url.endsWith(url)) void cache.delete(request);
}
