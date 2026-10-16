// The node every script runs on, as package.json starts it: JSPI for the Wasm tier, gc for heap limits judged on live data, and the preload
import { fileURLToPath } from "node:url";

export const NODE_ARGS = ["--experimental-wasm-jspi", "--expose-gc", "--import", fileURLToPath(new URL("./preload.ts", import.meta.url))];
/** the command that runs `script` with `args` on that node */
export const nodeCommand = (script: string, ...args: string[]): [string, string[]] => [process.execPath, [...NODE_ARGS, script, ...args]];
