// Compile-ahead on a launch without persisted code (docs/bytecode-first-plan.md §4.4): a compile
// worker (compileworker.ts) emits the methods the app is likely to run, and the page offers each
// chunk of bodies to the methods that reach them. A body persists only once a method uses it.
import { adoptBody, codeStats, codeText, hasBody, noteChunk, type Factory } from "./codecache";
import type { CompileRequest } from "./compileworker";
import { jvmCoverage } from "./coverage";
import { jvmProfiler } from "./profile";
import { inputSettled } from "./yield";

/** Start the worker unless the launch has persisted code: once a launch has persisted what it ran,
 *  that is the app's own profile. */
export function compileAhead(request: CompileRequest): void {
  if (typeof Worker === "undefined" || typeof document === "undefined" || jvmProfiler.enabled || jvmCoverage.enabled ||
    jvmProfiler.tier === "cold" || codeStats().loaded) return;
  const worker = new Worker(`/compile-worker.js${location.search}`, { type: "module" });
  worker.onmessage = ({ data }: MessageEvent<[string, string][]>) => offerCode(data);
  // copies, transferred: an entry of a stored archive is a view of the whole archive's buffer
  const dexes = request.dexes.map(([name, bytes]) => [name, bytes.slice()] as [string, Uint8Array]);
  const profile = request.profile?.slice(), manifest = request.manifest.slice();
  worker.postMessage({ dexes, profile, manifest, launch: request.launch } satisfies CompileRequest,
    [...dexes.map(([, bytes]) => bytes.buffer), manifest.buffer, ...profile ? [profile.buffer] : []]);
}

/** bodies the worker emitted this launch and no method has used yet, with the chunk holding each */
const offered = new Map<string, Record<string, Factory>>();
export const offeredCount = (): number => offered.size;
/** the offered body for `key`, which persists now that a method has reached it */
export function claimOffered(key: string): Factory | undefined {
  const chunk = offered.get(key);
  if (!chunk) return undefined;
  offered.delete(key);
  lastClaim = performance.now();
  adoptBody(key, chunk[key]);
  return chunk[key];
}

/** Offered bodies cost the page about 4 KB each until they are dropped (Mihon offers 27k). Once
 *  no method has claimed one for this long, launch and its first interactions are over and the
 *  rest are dropped; a later first call compiles its own. */
const UNCLAIMED_MS = 30_000;
let lastClaim = 0, sweeping = false;
function sweepOffered(): void {
  if (sweeping) return;
  sweeping = true;
  const check = () => {
    if (performance.now() - lastClaim < UNCLAIMED_MS) { setTimeout(check, UNCLAIMED_MS); return; }
    // the chunks keep their line maps for stacks through the bodies still in them
    for (const [key, bodies] of offered) delete bodies[key];
    offered.clear();
    sweeping = false;
  };
  setTimeout(check, UNCLAIMED_MS);
}

/** A worker's bodies (factory sources). Those the page has not compiled meanwhile load as a classic
 *  script, which V8 compiles off the main thread and finalizes there. Idle time would be too late:
 *  a launching page is not idle until after its first taps. Not a module: a module's record keeps
 *  every function it compiled for the realm's life, so unclaimed bodies could not be dropped. */
function offerCode(bodies: [key: string, source: string][]): void {
  offers.push(bodies);
  if (importing < MAX_IMPORTS) void importOffers();
}
/** Finalizing a chunk takes the main thread, so imports wait while input is being answered, and a
 *  few at a time keep the worker's pace without finalizing a burst at once. */
const MAX_IMPORTS = 3, offers: [key: string, source: string][][] = [];
let importing = 0, scripts = 0;
const fresh = (key: string) => !hasBody(key) && !offered.has(key);
/** the global an offered chunk's script hands its bodies to, by chunk */
const OFFER = "__wdOffer", ran = new Map<number, Record<string, Factory>>();
if (typeof document !== "undefined") Object.defineProperty(globalThis, OFFER, { value: (id: number, bodies: Record<string, Factory>) => ran.set(id, bodies) });
function runScript(url: string, id: number): Promise<Record<string, Factory>> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.onload = () => { script.remove(); const bodies = ran.get(id); ran.delete(id); if (bodies) resolve(bodies); else reject(new Error("chunk ran no bodies")); };
    script.onerror = () => { script.remove(); reject(new Error("chunk failed to load")); };
    document.head.append(script);
  });
}
async function importOffers(): Promise<void> {
  importing++;
  for (let bodies; (bodies = offers.shift());) {
    await inputSettled();
    const needed = bodies.filter(([key]) => fresh(key));
    if (!needed.length) continue;
    const id = ++scripts;
    const { text, starts } = codeText(needed);
    const url = URL.createObjectURL(new Blob([`${OFFER}(${id},${text});\n`], { type: "text/javascript" }));
    try {
      const factories = noteChunk(url, await runScript(url, id), starts);
      for (const key in factories) if (fresh(key)) offered.set(key, factories);
      lastClaim = performance.now();
      sweepOffered();
    } catch (e) { console.warn("[webdroid] compiled code unavailable", e); }
    finally { URL.revokeObjectURL(url); }
  }
  importing--;
}
