let catalog: { base: string; keys: Promise<string[]> } | undefined;

/** the files of the app build `key` that the platform build at `base` ships, if it ships one */
export async function fetchBundle(base: string, key: string): Promise<Map<string, Uint8Array> | undefined> {
  try {
    if (catalog?.base !== base) catalog = { base, keys: fetch(`${base}apps.json`).then(async (res) => {
      if (!res.ok) throw new Error(`apps.json: ${res.status}`);
      return await res.json() as string[];
    }) };
    if (!(await catalog.keys).includes(key)) return undefined;
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
