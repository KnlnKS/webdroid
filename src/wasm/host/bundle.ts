import { decodeJson, fetchBytes } from "./aotstore.ts";

let catalog: { base: string; keys: Promise<string[]> } | undefined;
const json = async <T>(url: string): Promise<T> => decodeJson<T>(await fetchBytes(url));

/** the files of the app build `key` that the platform build at `base` ships, if it ships one */
export async function fetchBundle(base: string, key: string): Promise<Map<string, Uint8Array> | undefined> {
  try {
    if (catalog?.base !== base) catalog = { base, keys: json<string[]>(`${base}apps.json`) };
    if (!(await catalog.keys).includes(key)) return undefined;
    const names = await json<string[]>(`${base}app.${key}.json`);
    return new Map(await Promise.all(names.map(async (name) => [name, await fetchBytes(`${base}app.${key}.${name}`)] as const)));
  } catch { return undefined; }
}
