import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
Uint8Array.fromBase64 ??= (s) => new Uint8Array(Buffer.from(s, "base64"));
Uint8Array.prototype.toHex ??= function () { return Buffer.from(this).toString("hex"); };
globalThis.Bun ??= {
  spawnSync(cmd, o = {}) { const r = spawnSync(cmd[0], cmd.slice(1), { cwd: o.cwd, input: o.stdin && o.stdin !== "ignore" ? o.stdin : undefined, maxBuffer: 1 << 28 }); return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr }; },
  which: () => null,
  file(u) { const buf = () => { const b = readFileSync(u); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); }; return { arrayBuffer: async () => buf(), slice: (a, b) => ({ arrayBuffer: async () => buf().slice(a, b) }) }; },
  Glob: class { constructor(p) { this.re = new RegExp("^" + p.replace(/\*/g, ".*") + "$"); } scanSync(d) { return { toArray: () => readdirSync(d).filter((f) => this.re.test(f)) }; } },
};
// The production yield port is unref'd, so a script awaiting a yield would let node exit with its top-level await pending. Run the
// script from here instead of with --import: `node nodeshim.mjs script.mjs args...` keeps the loop alive until the script finishes.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2]) {
  const keep = setInterval(() => {}, 1 << 30);
  process.argv.splice(1, 1);
  try { await import(pathToFileURL(resolve(process.argv[1])).href); } finally { clearInterval(keep); }
  process.exit(process.exitCode ?? 0);
}
