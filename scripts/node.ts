// The node every script runs on: scripts/node starts package.json's scripts with these flags, and these start the scripts' children
import { spawn, type ChildProcess } from "node:child_process";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

/** JSPI for the Wasm tier, and gc for heap limits judged on live data */
export const NODE_FLAGS = ["--experimental-wasm-jspi", "--expose-gc"];
/** the flags and the preload a script's node starts with */
export const NODE_ARGS = [...NODE_FLAGS, "--import", fileURLToPath(new URL("./preload.ts", import.meta.url))];
/** the command that runs `script` with `args` on that node */
export const nodeCommand = (script: string, ...args: string[]): [string, string[]] => [process.execPath, [...NODE_ARGS, script, ...args]];

export interface Ran { status: number; stdout: string; stderr: string }
export interface RunOptions { env?: NodeJS.ProcessEnv; show?: boolean; detached?: boolean; started?: (child: ChildProcess) => void }
/** `cmd args` run to completion with no input: its exit status (1 for a signal) and its output, unless `show` passes that through. A `detached` child
 *  leads a process group of its own, which `started`, given the child, can stop. */
export function run(cmd: string, args: string[], { env = process.env, show = false, detached = false, started }: RunOptions = {}): Promise<Ran> {
  const child = spawn(cmd, args, { env, detached, stdio: show ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"] });
  started?.(child);
  const out = { stdout: "", stderr: "" };
  for (const k of ["stdout", "stderr"] as const) child[k]?.setEncoding("utf8").on("data", (d: string) => { out[k] += d; });
  return new Promise((resolve, reject) => child.once("error", reject).once("close", (code) => resolve({ status: code ?? 1, ...out })));
}
/** a run's output, stdout then stderr */
export const output = ({ stdout, stderr }: Ran): string => (stdout + stderr).trimEnd();

/** the output of `script` run on that node without its caller's NODE_ENV, whose log goes on to the caller's: a Vite build's
 *  "production" would have the runtime fetch its core as a page does */
export function runNode(script: string, ...args: string[]): Promise<string> {
  const child = spawn(...nodeCommand(script, ...args), { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, NODE_ENV: undefined } });
  const output = text(child.stdout);
  return new Promise((resolve, reject) => child.once("error", reject)
    .once("close", (code) => code === 0 ? resolve(output) : reject(new Error(`${script} exited with ${code}`))));
}
