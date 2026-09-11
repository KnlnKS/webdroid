// Mass-compile every class in an APK's dex files: catches codegen syntax errors broadly.
import { loadDexes } from "./lib";
import { rt } from "../src/jvm/runtime";
import { perf } from "../src/perf";
import { setLazyMethods } from "../src/jvm/compiler";
import "../src/jvm/natives/jlang";
import { descToName } from "../src/jvm/abi";
import { need } from "./args";

const [path] = need("bun run smoke <apk> [--cold]");
const cold = process.argv.includes("--cold");
setLazyMethods(cold);

await loadDexes(path);

let ok = 0, fail = 0;
const t0 = performance.now();
const failures = new Map<string, number>();
const origWarn = console.warn;
console.warn = (...a: unknown[]) => {
  if (String(a[0]).includes("compile error")) {
    const m = /compile error \S+: (.*)/.exec(String(a[0]));
    failures.set(m?.[1] ?? "?", (failures.get(m?.[1] ?? "?") ?? 0) + 1);
    fail++;
  }
};
for (const dex of rt.dexes) {
  for (let i = 0; i < dex.classDefCount; i++) {
    const name = descToName(dex.type(dex.classDef2Type(i)));
    try {
      const info = rt.link(name);
      rt.ensureCompiled(info);
      if (cold) for (let j = 0; j < (info.lazy?.length ?? 0); j++) rt.lz(info.ctor, j);
      ok++;
    } catch (e) {
      console.error("class-level failure", name, e);
      fail++;
      if (fail > 20) process.exit(1);
    }
  }
}
console.warn = origWarn;
console.log(`compiled ${ok} classes (${perf.classesCompiled} bodies-bearing) in ${(performance.now() - t0).toFixed(0)}ms (pure compile ${perf.compileMs.toFixed(0)}ms), ${fail} method failures`);
const sorted = [...failures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
for (const [msg, n] of sorted) console.log(`  ${n}× ${msg}`);
console.log(`missing (first 30 of ${rt.missing.size}):`);
console.log([...rt.missing].slice(0, 30).join("\n"));
