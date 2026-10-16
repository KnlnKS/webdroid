import { spawn } from "node:child_process";
import { nodeCommand } from "../../scripts/node.ts";

const modes = ["--full", "--record", "--diff"] as const;
const args = process.argv.slice(2);
const selected = modes.filter((mode) => args.includes(mode));
if (selected.length > 1) throw new Error(`choose one E2E mode: ${modes.join(", ")}`);

const mode = selected[0];
if (mode !== "--full" && args.some((arg) => arg === "--shots" || arg.startsWith("--shots=")))
  throw new Error("--shots requires --full");
if (mode === "--record" && args.some((arg) => arg === "--jobs" || arg === "-j" || arg.startsWith("--jobs=")))
  throw new Error("Android recording is sequential; --jobs is unavailable with --record");
const script = mode === "--full" ? "run-full.ts"
  : mode === "--record" ? "capture-emulator.ts"
  : mode === "--diff" ? "score.ts"
  : "run-fast.ts";
const forwarded = args.filter((arg) => arg !== "--full" && arg !== "--record" && arg !== "--diff");
spawn(...nodeCommand(`${import.meta.dirname}/${script}`, ...forwarded), { stdio: "inherit" })
  .on("close", (code) => process.exit(code ?? 1));
