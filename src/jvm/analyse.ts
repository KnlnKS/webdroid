// The one whole-program pass, run once at boot between "every dex is loaded" and "anything
// is compiled". It answers two questions off the same call graph: what the apk can reach,
// and which of those methods can suspend.
//
// It is not free — harmonic pays ~130ms of a 700ms boot — so it earns its place only if the
// sync tier it enables is worth more. That is a measurement, not an assumption: `?sync=0`
// turns it off and the e2e perf columns say which way it went.

import { rt } from "./runtime";
import { Program, reach } from "./reach";
import { rootsOf, reflectiveRoots } from "./roots";
import { analyseSuspend, subtypeIndex } from "./suspend";
import { perf } from "../perf";

interface Analysis {
  reachable: number;
  sync: number;
  ms: number;
}

/**
 * @param manifest the apk's AndroidManifest.xml, for the roots the platform enters through
 * @param services META-INF/services entries, for what ServiceLoader instantiates by name
 */
export function analyseProgram(manifest: Uint8Array, services: Record<string, string>): Analysis {
  const t0 = performance.now();
  const p = new Program();
  for (const d of rt.dexes) p.add(d);
  const roots = rootsOf(manifest, p, services);
  const r = reach(p, roots.methods, [...roots.classes, ...reflectiveRoots(p, rt.dexes)]);
  const suspends = analyseSuspend(p, r.methods, subtypeIndex(p, r.instantiated), rt.nativeOracle());
  const sync = new Set<string>();
  for (const k of r.methods) if (!suspends.has(k)) sync.add(k);
  rt.syncMethods = sync;
  const ms = performance.now() - t0;
  perf.analyseMs = ms;
  return { reachable: r.methods.size, sync: sync.size, ms };
}
