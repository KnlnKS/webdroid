// The node every script runs on, as package.json starts it: JSPI for the Wasm tier, gc for heap limits judged on live data, and the preload
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const NODE_ARGS = ["--experimental-wasm-jspi", "--expose-gc", "--import", fileURLToPath(new URL("./preload.ts", import.meta.url))];
/** the command that runs `script` with `args` on that node */
export const nodeCommand = (script: string, ...args: string[]): [string, string[]] => [process.execPath, [...NODE_ARGS, script, ...args]];

/** the output of `script` run on that node without its caller's NODE_ENV: a Vite build's "production" would have the runtime
 *  fetch its core as a page does */
export async function runNode(script: string, ...args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)(...nodeCommand(script, ...args), { maxBuffer: 1 << 28, env: { ...process.env, NODE_ENV: undefined } });
  return stdout;
}
