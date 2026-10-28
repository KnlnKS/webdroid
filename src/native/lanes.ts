// Lanes: Workers that run a process's compute-bound native threads on cores of their own (lane-worker.ts,
// lane.zig). A lane runs a thread's slice only up to its next exit, which comes back to the process
// Worker to be handled as its own slices' exits are (cpu.ts): the host stays single-threaded, and only
// guest code runs in parallel. Every JIT batch the process links is linked into each lane's table too.

import { WORKER_SCRIPTS } from "../worker-scripts.ts";
import { core, coreModule, memory, shared, jitTables, jitJoin, type JitBatch, type JitTable } from "./core.ts";
import { bootTime, guestClockControl, uptimeMillis, wallMillis } from "../guest-clock.ts";
import { switchOn } from "../switches.ts";

export type LaneInit = {
  t: "init"; id: number; core: WebAssembly.Module; memory: WebAssembly.Memory; stack: number; tls: number;
  /** the process Worker's time origin, which the guest's counter (CNTVCT) counts from */
  origin: number; bootTime: number; clock?: Float64Array; batches: readonly JitBatch[]; posted: Int32Array;
};
export type LaneMessage = LaneInit | ({ t: "link" } & JitBatch) | { t: "unlink"; slots: number[] } | { t: "run"; cpu: number; budget: number };
export type LaneReply = { t: "exit"; ex: number } | { t: "trap"; message: string; stack?: string } | { t: "unlinked" };

/** a core instance's own stack: generated.ts's --stack */
const CORE_STACK = 256 << 10;
/** lane.zig's MAX, the process Worker's own lane among them */
const MAX_LANES = 16;
/** a core for each lane, leaving one to the page and one to the process Worker; a shared memory reaches
 *  another Worker only under cross-origin isolation, though Chrome makes one without it (core.ts) */
const limit = typeof Worker === "undefined" || !shared || !globalThis.crossOriginIsolated || !switchOn("lanes", true) ? 0
  : Math.min(MAX_LANES - 1, Math.max(0, navigator.hardwareConcurrency - 2));
/** guest time under a controlled clock, which moves only as the process Worker sees it: stamped at each slice */
const clock = guestClockControl.controlled && limit ? new Float64Array(new SharedArrayBuffer(16)) : undefined;
/** exits lanes have posted that the process Worker has yet to take, which its own slices end early for (cpu.ts) */
const posted = new Int32Array(limit ? new SharedArrayBuffer(4) : new ArrayBuffer(4));

export class Lane implements JitTable {
  private readonly worker = new Worker(WORKER_SCRIPTS.lane.url, { type: "module" });
  private reply: { resolve: (ex: number) => void; reject: (e: Error) => void } | null = null;
  /** unlinks this lane has yet to acknowledge, oldest first */
  private readonly unlinks: (() => void)[] = [];
  constructor(id: number) {
    this.worker.onmessage = ({ data: r }: MessageEvent<LaneReply>) => {
      if (r.t === "unlinked") return this.unlinks.shift()!();
      const reply = this.reply!;
      this.reply = null;
      Atomics.sub(posted, 0, 1);
      if (r.t === "exit") return reply.resolve(r.ex);
      const e = new Error(r.message);
      e.stack = r.stack;
      reply.reject(e);
    };
    const tls = core.memalign(Math.max(16, core.__tls_align.value), core.__tls_size.value), stack = core.memalign(16, CORE_STACK);
    this.post({ t: "init", id, core: coreModule, memory, stack: stack + CORE_STACK, tls, origin: performance.timeOrigin, bootTime, clock, batches: jitJoin(this), posted });
  }
  private post(m: LaneMessage): void { this.worker.postMessage(m); }
  link(batch: JitBatch): void { this.post({ t: "link", ...batch }); }
  /** once this lane's table no longer holds `slots` */
  unlink(slots: number[]): Promise<void> {
    return new Promise((resolve) => { this.unlinks.push(resolve); this.post({ t: "unlink", slots }); });
  }
  /** one run of the core on this lane: its exit, as core.run_slice returns it */
  run(cpu: number, budget: number): Promise<number> {
    if (clock) { clock[0] = uptimeMillis(); clock[1] = wallMillis(); }
    return new Promise((resolve, reject) => { this.reply = { resolve, reject }; this.post({ t: "run", cpu, budget }); });
  }
}

const idle: Lane[] = [];
/** A thread's slices run on a lane while it runs at least this many instructions per exit from the
 *  core: each exit costs a round trip between Workers (~70 µs), against ~0.25 ms for that compute. */
const INSTR_PER_EXIT = 200_000;
/** whether a slice of `instr` instructions over `exits` exits from the core sends the thread's next slice to a lane */
export const laneBound = (instr: number, exits: number): boolean => limit > 0 && instr >= INSTR_PER_EXIT * (exits + 1);
/** While lanes run, a slice on the process Worker runs in pieces of this many instructions, after any of
 *  which it ends for a lane's waiting exit (laneExitWaiting): the lane idles until the Worker takes it. */
const SERVICE_INSTR = 100_000;
export const lanePiece = (): number => idle.length < jitTables.length ? SERVICE_INSTR : Infinity;
export const laneExitWaiting = (): boolean => Atomics.load(posted, 0) > 0;

/** a lane free to run a slice, started if none is and another core is left; null to run it here */
export function takeLane(): Lane | null {
  const free = idle.pop();
  if (free || jitTables.length >= limit) return free ?? null;
  return new Lane(jitTables.length + 1);
}
export function giveLane(lane: Lane): void { idle.push(lane); }
