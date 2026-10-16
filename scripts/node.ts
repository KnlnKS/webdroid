// The node every script runs on, as package.json starts it
import { spawn } from "node:child_process";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

/** JSPI for the Wasm tier, and gc for heap limits judged on live data */
export const NODE_FLAGS = ["--experimental-wasm-jspi", "--expose-gc"];
/** the flags and the preload a script's node starts with */
export const NODE_ARGS = [...NODE_FLAGS, "--import", fileURLToPath(new URL("./preload.ts", import.meta.url))];
/** the command that runs `script` with `args` on that node */
export const nodeCommand = (script: string, ...args: string[]): [string, string[]] => [process.execPath, [...NODE_ARGS, script, ...args]];

/** the output of `script` run on that node without its caller's NODE_ENV, whose log goes on to the caller's: a Vite build's
 *  "production" would have the runtime fetch its core as a page does */
export function runNode(script: string, ...args: string[]): Promise<string> {
  const child = spawn(...nodeCommand(script, ...args), { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, NODE_ENV: undefined } });
  const output = text(child.stdout);
  return new Promise((resolve, reject) => child.once("error", reject)
    .once("close", (code) => code === 0 ? resolve(output) : reject(new Error(`${script} exited with ${code}`))));
}
