import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
Uint8Array.fromBase64 ??= (s) => new Uint8Array(Buffer.from(s, "base64"));
Uint8Array.prototype.toHex ??= function () { return Buffer.from(this).toString("hex"); };
globalThis.Bun ??= {
  spawnSync(cmd, o = {}) { const r = spawnSync(cmd[0], cmd.slice(1), { cwd: o.cwd, input: o.stdin && o.stdin !== "ignore" ? o.stdin : undefined, maxBuffer: 1 << 28 }); return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr }; },
  which: () => null,
  file(u) { const buf = () => { const b = readFileSync(u); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); }; return { arrayBuffer: async () => buf(), slice: (a, b) => ({ arrayBuffer: async () => buf().slice(a, b) }) }; },
  Glob: class { constructor(p) { this.re = new RegExp("^" + p.replace(/\*/g, ".*") + "$"); } scanSync(d) { return { toArray: () => readdirSync(d).filter((f) => this.re.test(f)) }; } },
};
