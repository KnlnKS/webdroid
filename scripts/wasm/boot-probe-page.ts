// The page of boot-probe.ts, also loaded in an iframe of itself (`?frame`), the way a process realm shares the page's modules.
import { fetchPlatformJars, jarDexes } from "../../src/android/framework";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { tier } from "../../src/jvm/tier";
import { openAot, platformProgram } from "../../src/wasm/host/boot";
import { Program } from "../../src/wasm/compiler/program";
import { World } from "../../src/wasm/link/world";
import { intrinsics } from "../../src/wasm/link/intrinsics";
import { hostNet } from "../../src/wasm/host/inet";
import { guestMemory } from "../../src/wasm/host/guest";
import { heapUsed } from "../../src/wasm/host/stats";
import { jsTier, natives, processState } from "./oracle";

export interface ProbeResult {
  tier: string;
  error?: string;
  attached: boolean;
  syncRequests: number;
  /** fetching and compiling the start's modules, off the main thread */
  aheadMs: number;
  /** from the World's creation to the end of the process's start */
  bootMs: number;
  /** our compiler, V8's Module and Instance, the platform build's reading and instantiating */
  compileMs: number; moduleMs: number; instantiateMs: number; aotMs: number;
  loaded: string[]; missed: string[]; failed: string[];
  /** methods compiled on demand */
  methods: number;
  /** whether the Program under the World extends the tab's platform Program */
  sharedPlatform: boolean;
}

let syncRequests = 0;
const open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, async?: boolean, ...rest: [string?, string?]) {
  if (async === false) syncRequests++;
  return open.call(this, method, url, async ?? true, ...rest);
} as typeof open;

async function probe(): Promise<ProbeResult> {
  const t0 = performance.now(), store = await openAot(), aheadMs = performance.now() - t0;
  await jsTier([]);
  const jars = await fetchPlatformJars();
  const platform = platformProgram(() => jars.flatMap((jar, i) => jarDexes(jar, PLATFORM_JARS[i])));
  const b0 = performance.now(), w = new World(new Program([], platform), { intrinsics, natives, heapUsed, net: hostNet, guest: guestMemory, aot: store });
  processState(w);
  const bootMs = performance.now() - b0, s = w.stats;
  return { tier, attached: !!w.aot, syncRequests, aheadMs, bootMs, compileMs: s.compileMs, moduleMs: s.moduleMs, instantiateMs: s.instantiateMs, aotMs: s.aot.ms,
    loaded: w.aot?.loaded ?? [], missed: [...w.aot?.missed ?? []], failed: store?.failed ?? [], methods: s.methods, sharedPlatform: w.prog.base === (window.top ?? window).__wdPlatformProgram };
}

const result = probe().catch((e): ProbeResult => ({ tier, error: String(e?.stack ?? e), attached: false, syncRequests, aheadMs: 0, bootMs: 0, compileMs: 0, moduleMs: 0, instantiateMs: 0, aotMs: 0, loaded: [], missed: [], failed: [], methods: 0, sharedPlatform: false }));
if (new URLSearchParams(location.search).has("frame")) (window.parent as unknown as { probeFrame: Promise<ProbeResult> }).probeFrame = result;
else (window as unknown as { probe: Promise<ProbeResult> }).probe = result;
