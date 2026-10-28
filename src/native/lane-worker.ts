// A lane (lanes.ts): the process's core instantiated again over its memory, which runs the slices the
// process Worker hands it and links the JIT's batches into a table of its own. Every exit goes back
// to the process Worker, which handles it as it handles its own slices'.

import { JIT_SLOTS, REGION_INTERPRET } from "./core-abi.gen.ts";
import { coreEnv, jitEnv } from "./core-env.ts";
import type { LaneInit, LaneMessage, LaneReply } from "./lanes.ts";
import type { JitBatch } from "./core.ts";

/** what a slot holds until this lane links its batch: the interpreter runs from the Cpu.pc a chain or call stored */
const stub = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
  1, 9, 1, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 3, 2, 1, 0, 7, 8, 1, 4, 0x73, 0x74, 0x75, 0x62, 0, 0, 10, 6, 1, 4, 0, 0x41, REGION_INTERPRET, 0x0b]))).exports.stub;
const table = new WebAssembly.Table({ initial: JIT_SLOTS, element: "anyfunc" }, stub);

type Core = Record<string, (...args: number[]) => number> & { __stack_pointer: WebAssembly.Global };
let core: Core;
let env: ReturnType<typeof jitEnv>;
let posted: Int32Array;

function init(d: LaneInit): void {
  const { clock } = d, now = () => performance.timeOrigin - d.origin + performance.now();
  const imports: Record<string, WebAssembly.ImportValue> = coreEnv(d.memory, table, clock
    ? { now, uptime: () => clock[0], wall: () => clock[1] }
    : { now, uptime: () => performance.timeOrigin - d.bootTime + performance.now(), wall: () => Date.now() }, () => {});
  // the window's accesses are ARM32's, which no lane runs
  for (const { name, kind } of WebAssembly.Module.imports(d.core)) if (kind === "function" && !(name in imports)) imports[name] = () => { throw new Error(`[lane] ${name}`); };
  core = new WebAssembly.Instance(d.core, { env: imports }).exports as unknown as Core;
  core.__stack_pointer.value = d.stack;
  core.__wasm_init_tls(d.tls);
  core.lane_init(d.id);
  posted = d.posted;
  env = jitEnv(core, d.memory, table, () => { throw new Error("[lane] the window is ARM32's"); });
  for (const b of d.batches) link(b);
}
function link({ module, regions, slots }: JitBatch): void {
  const { exports } = new WebAssembly.Instance(module, env);
  regions.forEach((r, i) => table.set(slots[i], exports["r" + r]));
}

onmessage = ({ data: m }: MessageEvent<LaneMessage>) => {
  switch (m.t) {
    case "init": return init(m);
    case "link": return link(m);
    case "unlink":
      for (const s of m.slots) table.set(s, stub);
      return postMessage({ t: "unlinked" });
    case "run": {
      let reply: LaneReply;
      try { reply = { t: "exit", ex: core.run_slice(m.cpu, m.budget) }; }
      catch (e) {
        // what the trapped slice held, which lane 0 may be waiting on (lane.zig's quiesce)
        core.slice_abort();
        reply = { t: "trap", message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined };
      }
      Atomics.add(posted, 0, 1);
      return postMessage(reply);
    }
  }
};
