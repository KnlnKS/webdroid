import { runUnderNode } from "./wasm/undernode";
process.exit(await runUnderNode(new URL("../tests/caller-frames.ts", import.meta.url).pathname, []));
