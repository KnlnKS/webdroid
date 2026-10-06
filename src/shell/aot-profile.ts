import { peekPageShared } from "./pageshared";

export interface AotProfile {
  key: string;
  wanted: string[];
  worlds: {linked:string[];called:string[]}[];
}
type FetchStore = {key:string;wanted:Iterable<string>;worlds:Iterable<() => {linked:string[];called:string[]}>};

/** Explicit diagnostic read: never opens AOT, prefetches modules or waits for startup prefetch. */
export async function existingAotProfile(): Promise<AotProfile | null> {
  const opened = peekPageShared("__wdAot") as Promise<FetchStore | undefined> | undefined;
  if (!opened) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const store = await Promise.race([opened,new Promise<never>((_,reject) => {
      timer = setTimeout(() => reject(new Error("AOT profile owner timeout")),4000);
    })]);
    return store ? {key:store.key,wanted:[...store.wanted],worlds:[...store.worlds].map(read => {
      const usage = read();return {linked:usage.linked.slice(),called:usage.called.slice()};
    })} : null;
  } finally {clearTimeout(timer);}
}
