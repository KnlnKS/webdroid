// The android: resource package — vendor/framework-res.apk, built by `bun run gen-framework-res`.
// It is fetched once per page and read lazily: only resources.arsc is inflated up front, every
// other entry (a layout, a nine-patch, a state list) on the first read of that path.

import { Arsc } from "./arsc";
import { centralDir, entryBytes } from "../jvm/natives/jzip";
import { rt, JObj } from "../jvm/runtime";
import { mangleStaticField } from "../jvm/abi";
import { setFramework } from "./res";

let pending: Promise<Arsc> | null = null;

export function loadFramework(): Promise<Arsc> {
  return pending ??= (async () => {
    const res = await fetch("/vendor/framework-res.apk");
    if (!res.ok) throw new Error(`no framework package (${res.status}) — run: bun run gen-framework-res`);
    const apk = new Uint8Array(await res.arrayBuffer());
    const dir = centralDir(apk);
    const inflated = new Map<string, Uint8Array | null>();
    const files = (path: string): Uint8Array | null => {
      let b = inflated.get(path);
      if (b === undefined) {
        const e = dir.get(path);
        inflated.set(path, b = e ? entryBytes(apk, e) : null);
      }
      return b;
    };
    const arsc = new Arsc(files("resources.arsc")!, files);

    // android.R.<type>.<name>. R.java spells a resource name as a java identifier, so the dots in
    // a style name are underscores there. Filled on first use: an app that never names one of
    // these types never pays for its table.
    for (const type of arsc.allTypes()) {
      const ctor = class extends JObj {};
      rt.register({
        name: `android/R$${type}`, ctor,
        clinit: () => {
          for (const [name, id] of arsc.names(type)) (ctor as any)[mangleStaticField(name.replace(/\./g, "_"))] = id;
        },
      });
    }
    rt.register({ name: "android/R", ctor: class extends JObj {} });

    setFramework(arsc);
    return arsc;
  })();
}
