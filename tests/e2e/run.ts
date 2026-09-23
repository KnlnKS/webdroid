const modes = ["--full", "--record", "--diff", "--coverage"] as const;
const args = process.argv.slice(2);
const selected = modes.filter((mode) => args.includes(mode));
if (selected.length > 1) throw new Error(`choose one E2E mode: ${modes.join(", ")}`);

const mode = selected[0];
const script = mode === "--full" ? "run-full.ts"
  : mode === "--record" ? "capture-emulator.ts"
  : mode === "--diff" ? "score.ts"
  : "run-fast.ts";
const forwarded = args.filter((arg) => arg !== "--full" && arg !== "--record" && arg !== "--diff");
const child = Bun.spawn(["bun", new URL(script, import.meta.url).pathname, ...forwarded], {
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exit(await child.exited);
