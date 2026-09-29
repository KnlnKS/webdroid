// A launch's compile worker (docs/bytecode-first-plan.md §4.4). It holds its own runtime over the
// app's dex and the platform jars and emits the hot entries of the APK's profiled methods, in
// profile order, as chunks the page imports. Emitted source depends only on the dex
// and the bundle, so it matches what the page would emit; V8 compiles each chunk off the page's
// main thread, and a method reaching its body runs hot from its first call.
import { rt } from "./runtime";
import "../natives";
import { dexesIn } from "./dex";
import { descToName } from "./abi";
import { entryBody } from "./compiler";
import { factorySource } from "./codecache";
import { fetchPlatformJars, loadPlatformJar } from "../android/framework";

export type CompileRequest = { dexes: [name: string, bytes: Uint8Array][]; work: [dexName: string, methodIdx: number][] };

/** a chunk goes to the page after this much emission, bounding the page's finalization task */
const CHUNK_MS = 15;

onmessage = async ({ data }: MessageEvent<CompileRequest>) => {
  // the page's precedence: the boot class path ahead of the app
  (await fetchPlatformJars()).forEach(loadPlatformJar);
  for (const [name, bytes] of data.dexes) for (const d of dexesIn(bytes, name)) rt.loadDex(d);
  rt.linkNatives();
  console.warn = () => {};
  let chunk: [string, string][] = [], since = performance.now();
  for (const [dexName, methodIdx] of data.work) {
    const dex = rt.dexes.find((d) => d.name === dexName);
    if (!dex || methodIdx >= dex.methodCount) continue;
    const cls = descToName(dex.type(dex.method(methodIdx).cls));
    if (rt.classDefOf(cls)?.dex !== dex) continue;
    try {
      const info = rt.link(cls);
      rt.ensureCompiled(info);
      const body = entryBody(rt, info, methodIdx);
      if (body) chunk.push([body[0], factorySource(body[1], "e")]);
    } catch { /* the page compiles it on demand instead */ }
    if (performance.now() - since > CHUNK_MS) { postMessage(chunk); chunk = []; since = performance.now(); }
  }
  postMessage(chunk);
  close();
};
