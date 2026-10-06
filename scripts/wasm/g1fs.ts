// node:fs in a G1 page: the files g1.ts fetched before the bundle loaded
const files = (globalThis as { G1_FILES?: Record<string, Uint8Array> }).G1_FILES!;
export const readFileSync = (p: string) => files[p] ?? (() => { throw new Error(`not preloaded: ${p}`); })();
export const openSync = () => { throw new Error("no file descriptors in a page"); };
export const readSync = openSync;
export const readdirSync = openSync;
