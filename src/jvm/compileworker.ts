// A first launch's compile worker (docs/bytecode-first-plan.md §4.4). It holds its own runtime over
// the app's dex and the platform jars and emits the hot entries of the app's methods as chunks the
// page imports: the APK's baseline profile first, then the launch components' methods, then what
// those call (reach.ts callClosure). Emitted source depends only on the dex and the bundle, so it
// matches what the page would emit; V8 compiles each chunk off the page's main thread, and a method
// reaching its body runs hot from its first call.
import { rt } from "./runtime";
import "../natives";
import { dexesIn, type DexFile } from "./dex";
import { descToName } from "./abi";
import { entryBody } from "./compiler";
import { factorySource } from "./codecache";
import { parseBaselineProfile } from "./baselineprof";
import { Program, callClosure, type MethodRoot } from "./reach";
import { rootsOf } from "./roots";
import { fetchPlatformJars, loadPlatformJar } from "../android/framework";

/** `launch`: the classes a launch instantiates first (the Application, the launcher Activity) */
export type CompileRequest = { dexes: [name: string, bytes: Uint8Array][]; profile?: Uint8Array; manifest: Uint8Array; launch: string[] };

/** a chunk goes to the page after this much emission, bounding the page's finalization task */
const CHUNK_MS = 15;
/** Bodies past the profile that no method claims stay compiled in the page for the launch: about
 *  one in six is called (Mihon, TikTok), so the closure stops here. */
const CLOSURE_LIMIT = 20_000;

onmessage = async ({ data }: MessageEvent<CompileRequest>) => {
  // the page's precedence: the boot class path ahead of the app
  (await fetchPlatformJars()).forEach(loadPlatformJar);
  const program = new Program(), appDexes: DexFile[] = [];
  for (const [name, bytes] of data.dexes) for (const d of dexesIn(bytes, name)) { rt.loadDex(d); program.add(d); appDexes.push(d); }
  rt.linkNatives();
  console.warn = () => {};
  let chunk: [string, string][] = [], since = performance.now();
  const post = () => { postMessage(chunk); chunk = []; since = performance.now(); };
  const done = new Set<string>();
  const emit = (cls: string, dex: DexFile, methodIdx: number) => {
    if (rt.classDefOf(cls)?.dex !== dex) return;
    try {
      const info = rt.link(cls);
      rt.ensureCompiled(info);
      const body = entryBody(rt, info, methodIdx);
      if (body && !done.has(body[0])) { done.add(body[0]); chunk.push([body[0], factorySource(body[1], "e")]); }
    } catch { /* the page compiles it on demand instead */ }
    if (performance.now() - since > CHUNK_MS) post();
  };
  const nameOf = (dex: DexFile, methodIdx: number) => descToName(dex.type(dex.method(methodIdx).cls));
  const rootOf = (dex: DexFile, methodIdx: number): MethodRoot => ({ cls: nameOf(dex, methodIdx), sig: dex.method(methodIdx).name + dex.methodDesc(methodIdx) });
  let roots: MethodRoot[] = [];
  for (const [name, methods] of (data.profile && parseBaselineProfile(data.profile)) || []) {
    const dex = appDexes.find((d) => d.name === name);
    if (dex) for (const m of methods) if (m < dex.methodCount) { emit(nameOf(dex, m), dex, m); roots.push(rootOf(dex, m)); }
  }
  // the launch's components, then the manifest's others, each followed by what it calls
  const others = rootsOf(data.manifest, program).classes.filter((c) => !data.launch.includes(c));
  let budget = CLOSURE_LIMIT;
  for (const classes of [data.launch, others]) {
    for (const cls of classes) {
      const def = program.def(cls), dex = program.dexOf(cls);
      if (def && dex) for (const m of [...def.directMethods, ...def.virtualMethods]) {
        if (m.codeOff) emit(cls, dex, m.methodIdx);
        roots.push(rootOf(dex, m.methodIdx));
      }
    }
    const called = callClosure(program, roots, budget);
    budget -= called.length;
    roots = [];
    for (const { cls, dex, methodIdx } of called) emit(cls, dex, methodIdx);
  }
  post();
  close();
};
