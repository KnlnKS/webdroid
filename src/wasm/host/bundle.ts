// The app builds a platform build ships (scripts/wasm/aot-profile.ts makes them beside its modules, as a cloud profile and its compiled code are shipped for an Android app): a first launch
// of an app a profile run has seen finds its compiled code as a later launch would. A bundle is the files persist.ts keeps for the app, as app.<key>.<file> with the list in app.<key>.json.

/** the files of the app build `key` that the platform build at `base` ships, if it ships one */
export async function fetchBundle(base: string, key: string): Promise<Map<string, Uint8Array> | undefined> {
  try {
    const list = await fetch(`${base}app.${key}.json`);
    if (!list.ok) return undefined;
    const names = await list.json() as string[];
    const files = await Promise.all(names.map(async (name) => {
      const res = await fetch(`${base}app.${key}.${name}`);
      if (!res.ok) throw new Error(`${name}: ${res.status}`);
      return [name, new Uint8Array(await res.arrayBuffer())] as const;
    }));
    return new Map(files);
  } catch { return undefined; }
}
