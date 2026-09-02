// The ARM32 interpreter core: register file, per-page decode cache of op records, the synchronous
// run loop, and the async call driver that suspends on host promises and yields between slices.

import { JThread, setCurThread } from "../jvm/natives/jlang";
import { NativeFault } from "./mem";
export { NativeFault };

export const enum SliceExit { Budget = 0, Suspend = 1, Exit = 2 }
export const SLICE_INSTR = 200_000;

const vfpBuf = new ArrayBuffer(32 * 4);

export class Cpu {
  r = new Int32Array(16);
  t = 0;
  n = 0; z = 0; c = 0; v = 0; q = 0; ge = 0;
  s = new Float32Array(vfpBuf);
  d = new Float64Array(vfpBuf);
  fn = 0; fz = 0; fc = 0; fv = 0; fpscr = 0;
  jthread: JThread;
  tid: number;
  stackBase = 0; stackTop = 0;
  errnoAddr = 0;
  env = 0;
  tls = new Map<number, number>();
  pending: Promise<unknown> | null = null;
  exc: unknown = null;
  instr = 0;
  pcRing = new Int32Array(64); pcPos = 0;
  name: string;

  constructor(jthread: JThread, name: string) {
    this.jthread = jthread;
    this.name = name;
    this.tid = ++tidSeq;
    // each Cpu owns its VFP file; the class-field initialisers above share one buffer only as a type shape
    const b = new ArrayBuffer(32 * 4);
    this.s = new Float32Array(b);
    this.d = new Float64Array(b);
    cpus.add(this);
  }

  async call(_fn: number, _args: (number | bigint)[] = []): Promise<number> {
    setCurThread(this.jthread);
    throw new Error("TODO Cpu.call");
  }
  runSlice(_budget: number): SliceExit { throw new Error("TODO Cpu.runSlice"); }
  setPc(addr: number): void { this.r[15] = addr & ~1; this.t = addr & 1; }
  flush(): void { throw new Error("TODO Cpu.flush"); }
  fault(msg: string): never {
    const e = new NativeFault(`[native] ${msg} @ ${symbolizeHook(this.r[15] >>> 0)}`);
    e.pc = this.r[15] >>> 0;
    throw e;
  }
}

let tidSeq = 0;
export const cpus = new Set<Cpu>();
const byThread = new WeakMap<JThread, Cpu>();

export function cpuFor(t: JThread): Cpu {
  let c = byThread.get(t);
  if (!c) { c = new Cpu(t, t.jname); byThread.set(t, c); }
  return c;
}

export let symbolizeHook: (pc: number) => string = (pc) => "0x" + pc.toString(16);
export function setSymbolizeHook(f: (pc: number) => string): void { symbolizeHook = f; }

export function yieldToLoop(): Promise<void> { throw new Error("TODO yieldToLoop"); }
