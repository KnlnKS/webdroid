// The Wasm tier's entry (src/jvm/tier.ts loads it under ?tier=wasm). Bytecode cannot run here yet: the framework's blocking natives need S3.
import { pageShared } from "../../shell/pageshared";
import { FetchStore } from "../link/aotstore";

declare global { interface Window { __wdAot?: Promise<FetchStore | undefined> } }

export function bootWasmTier(): never {
  throw new Error("?tier=wasm: the Wasm tier cannot run the framework yet");
}

/** The platform build (scripts/wasm/aot-build.ts) the server holds for these sources, with the modules a start of the process loads compiled: fetched once by the tab,
 *  and the compiled modules are shared by the process frames, which are same-origin. Undefined when the server has no build for the sources, which leaves all code to
 *  the on-demand compiler. */
export function openAot(): Promise<FetchStore | undefined> {
  return pageShared("__wdAot", async () => {
    const current = await fetch("/aot/current.json");
    if (!current.ok) return undefined;
    const store = new FetchStore(`/aot/${(await current.json() as { key: string }).key}/`);
    const [, startup] = await Promise.all([store.fetchBytes("index.json"), store.fetchBytes("startup.json")]);
    await store.prefetch(JSON.parse(new TextDecoder().decode(startup)) as string[]);
    return store;
  });
}
