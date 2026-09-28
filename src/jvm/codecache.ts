// Compiled method bodies persisted across launches (docs/bytecode-first-plan.md §4.4). A launch
// records the source of every hot and resumable body it compiles; the next launch of the same
// package, on the same bundle, installs those bodies from scripts in Cache Storage instead of
// preparing, interpreting and compiling them again, and the service worker serving the scripts
// lets V8 reuse their code cache. A body's source depends only on its dex and this bundle, so the
// key is the dex signature and method index. Saves append a chunk of the bodies not yet written,
// so their cost follows what is new rather than what the app has accumulated. Bodies a launch
// first needed before its first frame go to startup chunks, which the next launch awaits; the
// rest load after that launch's first frame, so they do not delay it.

/** installs an entry body into C/C.prototype, or returns a resumable body */
export type Factory = (C: unknown, D: unknown, R: unknown, S: unknown, P: unknown, $R?: unknown) => unknown;

const CACHE = "wd-code";
/** loads with more chunks than this rewrite them as one */
const MAX_CHUNKS = 8;
const bundle = new URL(import.meta.url).pathname.replace(/[^\w.-]+/g, "_");
/** "s" until the realm's first frame, then "l": which chunks a body recorded now belongs to */
type Phase = "s" | "l";
let phase: Phase = "s";
let dir: string | null = null;
let loaded: Record<string, Factory> = {};
/** keys the startup chunks hold, which a compacting rewrite keeps there */
let startupKeys = new Set<string>();
/** later chunks not yet imported: a compacting rewrite waits for them */
let later: string[] | null = null;
let compact = false;
/** bodies compiled in this launch and not yet written */
const pending = new Map<string, { source: string; phase: Phase }>();
/** methods that ran without a hot body: theirs is emitted in idle time, so the next launch runs it hot */
const deferred = new Map<string, () => string>();
/** the phase of each method's first call, by entry key: a startup method promoted later is still startup */
const firstUse = new Map<string, Phase>();
const entryOf = (key: string) => key.slice(0, -1) + "e";

/** where this launch persists, what it loaded and what it has yet to write */
export const codeStats = () => ({ dir, loaded: Object.keys(loaded).length, pending: pending.size, deferred: deferred.size, later: later?.length ?? 0 });

export const codeKey = (dexId: string, methodIdx: number, form: "e" | "r") => `${dexId}:${methodIdx}:${form}`;

/** the persisted body for `key`, if an earlier launch compiled one */
export function persistedBody(key: string): Factory | undefined { return loaded[key]; }

/** a body compiled in this launch: `body` is the factory's statements (an entry) or expression (resumable) */
export function recordBody(key: string, body: string, form: "e" | "r"): void {
  if (loaded[key] || pending.has(key)) return;
  const at = firstUse.get(entryOf(key)) ?? phase;
  if (form === "e") firstUse.set(key, at);
  // a chunk holds many bodies, and its last sourceURL would name them all; their function names
  // name each one instead
  body = body.replace(/\n\/\/# sourceURL=\S*\s*$/, "");
  pending.set(key, { source: form === "e" ? `(C,D,R,S,P,$R)=>{${body}\n}` : `(C,D,R,S,P)=>(${body}\n)`, phase: at });
  deferred.delete(key);
  idle();
}

/** a body a method has not compiled yet but the next launch will want; `make` emits it */
export function recordLater(key: string, make: () => string): void {
  if (loaded[key] || pending.has(key)) return;
  deferred.set(key, make);
  if (!firstUse.has(key)) firstUse.set(key, phase);
  idle();
}

/** install persisted bodies: what loadCode imports from codeText's modules */
export function useCode(bodies: Record<string, Factory>): void { loaded = bodies; }

/** a module whose default export is `bodies` (the pending ones by default); each factory is
 *  parenthesized so V8 compiles it with the module, off the launch's critical calls, rather than
 *  preparsing it there and compiling it again when the method is first called */
export function codeText(bodies: Iterable<[string, string]> = [...pending].map(([key, { source }]) => [key, source])): string {
  let text = "export default {\n";
  for (const [key, source] of bodies) text += `${JSON.stringify(key)}:(${source}),\n`;
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
    importChunk = async (path) =>
      (await import(/* @vite-ignore */ direct ? path : URL.createObjectURL(await (await cache.match(path))!.blob()))).default;
    const laterPaths = mine.filter((path) => path.startsWith(`${dir}l-`));
    later = laterPaths.length ? laterPaths : null;
    useCode(Object.assign({}, ...await Promise.all(mine.filter((path) => !laterPaths.includes(path)).map(importChunk))));
    startupKeys = new Set(Object.keys(loaded));
    compact = mine.length > MAX_CHUNKS;
  } catch (e) { console.warn("[webdroid] persisted code unavailable", e); }
}
let importChunk: (path: string) => Promise<Record<string, Factory>> = async () => ({});

/** the realm presented its first frame: bodies from now on are later ones, and the later chunks load */
export function startupDone(): void {
  if (phase === "l") return;
  phase = "l";
  const paths = later ?? [];
  void Promise.all(paths.map(importChunk)).then((modules) => {
    for (const bodies of modules) for (const key in bodies) loaded[key] ??= bodies[key];
    later = null;
  }).catch((e) => console.warn("[webdroid] persisted code unavailable", e));
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
      try { recordBody(key, make(), key.endsWith(":r") ? "r" : "e"); } catch { /* it compiles on demand instead */ }
    }
    idling = false;
    // the first save follows startup, so a launch that ends early keeps it without a pagehide write
    if (phase === "l" && !lastSave || performance.now() - lastSave > 30_000) void saveCode();
  }, { timeout: 60_000 });
}

let saving: Promise<void> = Promise.resolve(), lastSave = 0;
/** append the pending bodies as a startup and a later chunk; a load that found too many chunks
 *  rewrites them all, once the later ones have loaded */
function saveCode(): Promise<void> {
  return saving = saving.then(async () => {
    const rewrite = compact && !later;
    if (!dir || !(pending.size || rewrite) || typeof caches === "undefined") return;
    const chunks: Record<Phase, [string, string][]> = { s: [], l: [] };
    if (rewrite) for (const [key, factory] of Object.entries(loaded)) chunks[startupKeys.has(key) ? "s" : "l"].push([key, factory.toString()]);
    for (const [key, { source, phase }] of pending) chunks[phase].push([key, source]);
    pending.clear();
    lastSave = performance.now();
    const cache = await caches.open(CACHE), old = rewrite ? await cache.keys() : [], stamp = Date.now().toString(36);
    // both at once: a pagehide save gets no time for a second write after the first
    await Promise.all((["s", "l"] as const).filter((at) => chunks[at].length).map((at) =>
      cache.put(`${dir}${at}-${stamp}.js`, new Response(codeText(chunks[at]), { headers: { "content-type": "text/javascript" } }))));
    if (rewrite) for (const request of old) if (new URL(request.url).pathname.startsWith(dir)) void cache.delete(request);
    if (rewrite) compact = false;
  }).catch((e) => console.warn("[webdroid] saving compiled code failed", e));
}
