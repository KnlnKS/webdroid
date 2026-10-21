import { within } from "./rpc.ts";

export interface AotProfile {
  key: string;
  wanted: string[];
  worlds: {linked:string[];called:string[]}[];
}
type FetchStore = {key:string;wanted:Iterable<string>;worlds:Iterable<() => {linked:string[];called:string[]}>};

/** Explicit diagnostic read: never opens AOT, prefetches modules or waits for startup prefetch. */
export async function existingAotProfile(): Promise<AotProfile | null> {
  const opened: Promise<FetchStore | undefined> | undefined = globalThis.__wdAot;
  if (!opened) return null;
  const store = await within(opened, 4000, () => { throw new Error("AOT profile owner timeout"); });
  return store ? {key:store.key,wanted:[...store.wanted],worlds:[...store.worlds].map(read => {
    const usage = read();return {linked:usage.linked.slice(),called:usage.called.slice()};
  })} : null;
}
