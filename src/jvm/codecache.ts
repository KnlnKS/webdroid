// Compiled method bodies persisted across launches (docs/bytecode-first-plan.md §4.4). A launch
// records the source of every hot and resumable body it compiles; the next launch of the same
// package, on the same build, installs those bodies from scripts in Cache Storage instead of
// preparing, interpreting and compiling them again, and the service worker serving the scripts
// lets V8 reuse their code cache. A body's source depends only on its dex and the build, so the
// key is the dex signature and method index. Saves append a chunk of the bodies not yet written,
// so their cost follows what is new rather than what the app has accumulated. Bodies a launch
// first needed before its first frame go to startup chunks, which the next launch awaits; the
// rest load after that launch's first frame, so they do not delay it. Bodies of the platform's
// dex are the same for every app, so they persist in one store all packages share: an app's first
// launch runs the framework code earlier launches of other apps compiled.

import { inputSettled } from "./yield";
import { BYTECODE } from "./provenance";
import { once } from "./suspend";

/** installs an entry body into C/C.prototype, or returns a resumable body */
export type Factory = (C: unknown, D: unknown, R: unknown, S: unknown, P: unknown, $R?: unknown) => unknown;

const CACHE = "wd-code";
/** loads with more chunks than this rewrite them as one */
const MAX_CHUNKS = 8;
/** "s" until the realm's first frame, then "l": which chunks a body recorded now belongs to */
type Phase = "s" | "l";
let phase: Phase = "s";
let dir: string | null = null, platformDir: string | null = null;
const platformDexes = new Set<string>();
/** a boot class path dex: its bodies go to the shared store */
export function markPlatformDex(id: string): void { platformDexes.add(id); }
const isPlatformKey = (key: string) => platformDexes.has(key.slice(0, key.indexOf(":")));
let loaded: Record<string, Factory> = {};
/** keys the startup chunks hold, which a compacting rewrite keeps there */
let startupKeys = new Set<string>();
/** later chunks not yet imported: a compacting rewrite waits for them */
let later: string[] | null = null;
let compact = false;
/** bodies compiled in this launch and not yet written */
const pending = new Map<string, { source: string; phase: Phase }>();
/** the phase of each method's first call, by entry key: a startup method promoted later is still startup */
const firstUse = new Map<string, Phase>();
const entryOf = (key: string) => key.slice(0, -1) + "e";

/** where this launch persists, what it loaded and what it has yet to write */
export const codeStats = () => ({ dir, loaded: Object.keys(loaded).filter((key) => !isPlatformKey(key)).length, pending: pending.size, later: later?.length ?? 0 });

export const codeKey = (dexId: string, methodIdx: number, form: "e" | "r") => `${dexId}:${methodIdx}:${form}`;

/** bodies a compile worker emitted this launch and no method has used yet */
const offered = new Set<string>();

/** the persisted body for `key`, if an earlier launch or this launch's compile worker made one */
export function persistedBody(key: string): Factory | undefined {
  claim(key);
  return loaded[key];
}

/** an offered body a method has reached persists, whether it installs it or compiles its own */
function claim(key: string): boolean {
  if (!offered.delete(key)) return false;
  record(key, loaded[key].toString(), "e");
  return true;
}

/** the factory source of a body: `body` is its statements (an entry) or expression (resumable) */
export function factorySource(body: string, form: "e" | "r"): string {
  // a chunk holds many bodies, and its last sourceURL would name them all; their function names
  // name each one instead
  body = body.replace(/\n\/\/# sourceURL=\S*\s*$/, "");
  return form === "e" ? `(C,D,R,S,P,$R)=>{${body}\n}` : `(C,D,R,S,P)=>(${body}\n)`;
}

/** a body compiled in this launch */
export function recordBody(key: string, body: string, form: "e" | "r"): void {
  if (claim(key) || loaded[key] || pending.has(key)) return;
  record(key, factorySource(body, form), form);
}

function record(key: string, source: string, form: "e" | "r"): void {
  const at = firstUse.get(entryOf(key)) ?? phase;
  if (form === "e") firstUse.set(key, at);
  pending.set(key, { source, phase: at });
  idle();
}

/** The first call determines the persisted phase, even if compilation happens after startup. */
export function recordUse(key: string): void { if (!firstUse.has(key)) firstUse.set(key, phase); }

/** A compile worker's bodies (factory sources). Those the page has not compiled meanwhile import
 *  as a module, which V8 compiles off the main thread and finalizes there, and install like
 *  persisted bodies; one persists once a method uses it. Idle time would be too late: a launching
 *  page is not idle until after its first taps. */
export function offerCode(bodies: [key: string, source: string][]): void {
  offers.push(bodies);
  if (importing < MAX_IMPORTS) void importOffers();
}
/** Finalizing a chunk takes the main thread, so imports wait while input is being answered, and a
 *  few at a time keep the worker's pace without finalizing a burst at once. */
const MAX_IMPORTS = 3, offers: [key: string, source: string][][] = [];
let importing = 0;
async function importOffers(): Promise<void> {
  importing++;
  for (let bodies; (bodies = offers.shift());) {
    await inputSettled();
    const needed = bodies.filter(([key]) => !loaded[key] && !pending.has(key));
    if (!needed.length) continue;
    const url = URL.createObjectURL(new Blob([codeText(needed)], { type: "text/javascript" }));
    try {
      const factories: Record<string, Factory> = (await import(/* @vite-ignore */ url)).default;
      for (const key in factories) if (!loaded[key] && !pending.has(key)) { loaded[key] = factories[key]; offered.add(key); }
    } catch (e) { console.warn("[webdroid] compiled code unavailable", e); }
    finally { URL.revokeObjectURL(url); }
  }
  importing--;
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

/** the source the page was built from, which decides every emitted body (scripts/build-id.ts) */
async function fetchBuildId(): Promise<string | null> {
  try {
    const res = await fetch("/build-id");
    return res.ok ? await res.text() : null;
  } catch (e) { console.warn("[webdroid] build id unavailable", e); return null; }
}
/** the build's store root, once the platform's persisted bodies are loaded; null when the page
 *  cannot persist or has no link table naming its build */
const storeRoot = once(async (): Promise<string | null> => {
  const build = typeof caches === "undefined" ? null : await fetchBuildId();
  if (!build) return null;
  const cache = await caches.open(CACHE);
  // through the service worker when it controls the page, so V8 can reuse its code cache
  const direct = !!navigator.serviceWorker?.controller;
  importChunk = async (path) =>
    (await import(/* @vite-ignore */ direct ? path : URL.createObjectURL(await (await cache.match(path))!.blob()))).default;
  // the bodies depend on which platform classes run from bytecode, so a cut has a store of its own
  const platform = `@platform${BYTECODE.length ? "-" + [...BYTECODE.join(",")].reduce((h, c) => Math.imul(h, 31) + c.charCodeAt(0) | 0, 0).toString(36) : ""}`;
  const root = `/wd-code/${build}/`;
  await loadStore(cache, platformDir = `${root}${platform}/`, `/${platform}/`);
  return root;
});
/** load the platform's persisted bodies: a zygote awaits them before it runs platform code */
export const loadPlatformCode = async (): Promise<void> => { await storeRoot(); };

/** load `app`'s persisted bodies; a launch without them records its own */
export async function loadCode(app: string): Promise<void> {
  const root = await storeRoot();
  if (!root) return;
  addEventListener("pagehide", () => void saveCode());
  await loadStore(await caches.open(CACHE), dir = `${root}${encodeURIComponent(app)}/`, `/${encodeURIComponent(app)}/`);
}

/** import a store's startup chunks and note its later ones; another build's chunks of it are stale */
async function loadStore(cache: Cache, store: string, suffix: string): Promise<void> {
  try {
    const paths: string[] = [];
    for (const request of await cache.keys()) {
      const path = new URL(request.url).pathname;
      if (path.startsWith(store)) paths.push(path);
      else if (path.includes(suffix)) void cache.delete(request);
    }
    const laterPaths = paths.filter((path) => path.startsWith(`${store}l-`));
    if (laterPaths.length) (later ??= []).push(...laterPaths);
    for (const bodies of await Promise.all(paths.filter((path) => !laterPaths.includes(path)).map(importChunk)))
      for (const key in bodies) { loaded[key] = bodies[key]; startupKeys.add(key); }
    compact ||= paths.length > MAX_CHUNKS;
  } catch (e) { console.warn("[webdroid] persisted code unavailable", e); }
}
let importChunk: (path: string) => Promise<Record<string, Factory>> = async () => ({});

/** the realm presented its first frame: bodies from now on are later ones, and the later chunks load */
export function startupDone(): void {
  if (phase === "l") return;
  phase = "l";
  idle();
  const paths = later ?? [];
  void Promise.all(paths.map(importChunk)).then((modules) => {
    for (const bodies of modules) for (const key in bodies) loaded[key] ??= bodies[key];
    later = null;
    if (compact) idle();
  }).catch((e) => console.warn("[webdroid] persisted code unavailable", e));
}

let idling = false;
/** write new bodies outside the current Java call */
function idle(): void {
  if (idling || !dir || typeof requestIdleCallback === "undefined") return;
  idling = true;
  requestIdleCallback(function work() {
    if (!(pending.size || compact && !later)) { idling = false; return; }
    const delay = phase === "l" && !lastSave ? 0 : 30_000 - (performance.now() - lastSave);
    if (delay > 0) {
      if (phase === "l") setTimeout(() => requestIdleCallback(work, { timeout: 60_000 }), delay);
      else idling = false;
      return;
    }
    idling = false;
    void saveCode();
  }, { timeout: 60_000 });
}

let saving: Promise<void> = Promise.resolve(), lastSave = 0;
/** append the pending bodies as a startup and a later chunk; a load that found too many chunks
 *  rewrites them all, once the later ones have loaded */
function saveCode(): Promise<void> {
  return saving = saving.then(async () => {
    const rewrite = compact && !later;
    if (!dir || !(pending.size || rewrite) || typeof caches === "undefined") return;
    // by store (the app's, the platform's) and phase
    const chunks = new Map<string, [string, string][]>();
    const add = (key: string, at: Phase, source: string) => {
      const name = `${isPlatformKey(key) ? platformDir : dir}${at}`;
      let chunk = chunks.get(name);
      if (!chunk) chunks.set(name, chunk = []);
      chunk.push([key, source]);
    };
    if (rewrite) for (const [key, factory] of Object.entries(loaded)) if (!offered.has(key) && !pending.has(key)) add(key, startupKeys.has(key) ? "s" : "l", factory.toString());
    for (const [key, { source, phase }] of pending) add(key, phase, source);
    pending.clear();
    lastSave = performance.now();
    const cache = await caches.open(CACHE), old = rewrite ? await cache.keys() : [], stamp = Date.now().toString(36);
    // all at once: a pagehide save gets no time for a second write after the first
    await Promise.all([...chunks].map(([name, bodies]) =>
      cache.put(`${name}-${stamp}.js`, new Response(codeText(bodies), { headers: { "content-type": "text/javascript" } }))));
    if (rewrite) for (const request of old) {
      const path = new URL(request.url).pathname;
      if (path.startsWith(dir) || path.startsWith(platformDir!)) void cache.delete(request);
    }
    if (rewrite) compact = false;
  }).catch((e) => console.warn("[webdroid] saving compiled code failed", e));
}

// Link metadata (§4.1): per native class, the platform methods its spec leaves out, which
// Runtime.fallThrough stubs at every boot of every realm. Finding them decodes and mangles every
// method of each class a spec covers; the gaps depend only on the specs and the platform dex, so
// the server computes them once (scripts/link-table.ts) and a boot replays the table.
/** a gap: its method list (0 direct, 1 virtual), index there, mangled name and how it is filled
 *  (0 the platform body, 1 its JNI binding, 2 the superclass's implementation) */
export type Gap = [list: number, index: number, mangled: string, kind: number];
type LinkTable = { fingerprint: string; gaps: Record<string, Gap[]> };
let gaps: Record<string, Gap[]> | null = null, foundGaps: Record<string, Gap[]> | null = null;
/** the served table for this bytecode switch, if the page has one to ask */
export async function fetchLinkTable(): Promise<LinkTable | null> {
  if (typeof location === "undefined") return null;
  try {
    const res = await fetch(`/link-table.json${BYTECODE.length ? "?bytecode=" + encodeURIComponent(BYTECODE.join(",")) : ""}`);
    return res.ok ? await res.json() : null;
  } catch (e) { console.warn("[webdroid] link table unavailable", e); return null; }
}
/** replay `table` if it was made for these specs and this platform; otherwise each boot finds its own */
export function useLinkTable(table: LinkTable | null, fingerprint: string): void {
  gaps = table?.fingerprint === fingerprint ? table.gaps : null;
  if (table && !gaps) console.warn("[webdroid] link table is stale; finding gaps");
}
export const gapsOf = (cls: string): Gap[] | undefined => gaps?.[cls];
export function recordGaps(cls: string, found: Gap[]): void { if (!gaps) (foundGaps ??= {})[cls] = found; }
/** what a boot without a table found: the table the server serves */
export const foundLinkTable = (): Record<string, Gap[]> | null => foundGaps;
