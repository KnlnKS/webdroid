// The guest CPU's host half: one Cpu per guest thread, its state a struct in the core's memory
// (cpu.zig), and the async call driver that runs slices, suspends on host promises, delivers
// signals and yields between slices. The core executes; this decides what happens at its exits.

import { JThread, setCurThread } from "../jvm/natives/jlang";
import { NativeFault, mem } from "./mem";
import { core, jitDrain, TLS_KEYS } from "./core";
import { Args, Args64, type ArgReader, hostDispatch, hostReturn, setPtrWidth, type HostRet, fbits, dbits, bitsf, bitsd, retPair, slowMs } from "./host";
import { RET_SENTINEL, TRAMP_BASE, TRAMP_END, STACK_SIZE, MEM_SIZE_A32, MEM_SIZE_A64 } from "./abi";
import { perf } from "../perf";
export { NativeFault };

export const enum SliceExit { Budget = 0, Suspend = 1, Exit = 2 }
const enum CoreExit { Budget = 0, Host = 1, Ret = 2, Fault = 3, Syscall = 4 }
// ~5 ms of guest time per slice: coarse enough that the macrotask hop per slice is noise, fine
// enough that a 60 Hz frame loop on the JS thread keeps its cadence
const SLICE_INSTR = 3_000_000;
/** the run loop's instruction budget per slice; lowering it makes `profile` sample finely (debug) */
export const slice = { instr: SLICE_INSTR };

/** an argument to a guest function: a float or double travels in a V register on AAPCS64 and as
 *  its bit pattern in core registers on the softfp ABI, and only Cpu.call knows which */
export type CallArg = number | bigint | { f: number } | { d: number };

// the struct layout, from the core rather than spelled twice
const L = (i: number) => core.layout(i);
const SIZE = L(0), OFF_X = L(1), OFF_PC = L(2), OFF_V = L(3), OFF_CPSR = L(4), OFF_FPCR = L(5), OFF_FPSR = L(6), OFF_EXCL = L(7), OFF_TLS = L(8), OFF_IC = L(9), OFF_BPC = L(10), OFF_A64 = L(12), OFF_EXIT = L(13), OFF_WORD = L(14), OFF_ADDR = L(15), OFF_ERRNO = L(17), OFF_TLSTAB = L(18);
/** the architectural state a nested call saves and restores: registers, pc, V file, flags, monitor */
const ARCH_SIZE = L(16);
const FAULTS = ["unimplemented", "undefined", "bad address", "misaligned pc", "dc zva", "brk", "svc: unsupported syscall", "system register", "null page"];

export const codeStats = { get pages(): number { return core.cpu_stat(0); }, get invalidated(): number { return core.cpu_stat(1); }, /** instructions the interpreter ran (the rest ran in regions) */ get interp(): number { return core.interp_ic(); } };
/** single-step register trace: every instruction logs pc + the registers it changed (slow; debugging only) */
export const stepMode = { on: false, ring: [] as string[], max: 40000, watch: 0, hits: [] as string[] };
export function setStepMode(on: boolean): void {
  stepMode.on = on;
  core.set_max_block(on ? 1 : 256);
  stepMode.ring.length = 0;
}
const stepPrev = new Int32Array(64);
const RN = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11", "ip", "sp", "lr", "pc"];
const XN = [...Array(31)].map((_, i) => `x${i}`).concat(["sp"]);
let processExited = false;
/** slice-boundary pc samples (one per budget exit; `slice.instr` sets how fine): a free statistical profile */
export const profile = { on: true, samples: new Map<number, number>() };
export function markProcessExited(): void { processExited = true; }
export const hasProcessExited = (): boolean => processExited;
/** why code pages were invalidated, by cause (wd.native.invalidations) */
export const invalidations = new Map<string, number>();
export function invalidateRange(addr: number, size: number, reason = "range"): void {
  core.invalidate_range(addr >>> 0, size >>> 0);
  invalidations.set(reason, (invalidations.get(reason) ?? 0) + 1);
}

/** A process is one ABI — Android never mixes 32- and 64-bit code in one image's dependency
 *  graph — so the instruction set is a property of the process, set when its first image loads. */
let A64 = false;
export function setA64(on: boolean): void {
  if (A64 === on) return;
  A64 = on;
  mem.init(on ? MEM_SIZE_A64 : MEM_SIZE_A32);
  // the pointer width is a property of the process, not of a thread: set it here, because the
  // JNI tables are laid out before the first Cpu exists
  setPtrWidth(on ? 8 : 4);
  for (const c of cpus) c.setAbi(on);
  core.invalidate_all();
}
export function isA64(): boolean { return A64; }

/** the register file at the first native fault, as the faulting block found it (debug) */
export const lastFault: { regs: { cpu: string; r: number[]; h: number[] } | null } = { regs: null };
/** log every call() frame on the named thread (debug: set __wdCallLog to the thread name before load) */
const callLog = (globalThis as { __wdCallLog?: string }).__wdCallLog ?? "";
export const watchPcs = new Set<number>(((globalThis as { __wdWatch?: number[] }).__wdWatch ?? []).map((p) => p >>> 0));

export class Cpu {
  /** the state struct's address in guest memory */
  readonly base: number;
  /** the registers as int32 halves: w[2i] is the low half of x[i] (r[i] on ARM32), w[2i+1] the high; x31 is sp */
  w!: Int32Array;
  // The SIMD&FP register file V0..V31 (Vn.S[i] = s[4n+i], Vn.D[i] = d[2n+i], bytes at vb[16n+i]).
  // ARM32's VFP keeps its own map over the same bytes (Sn = s[n], Dn = d[n]); a process is one
  // ABI, so the two never meet. Moves go through the integer views so NaN payloads survive.
  s!: Float32Array; d!: Float64Array; si!: Int32Array; vu!: Uint32Array; vw!: Uint16Array; vsw!: Int16Array; vb!: Uint8Array; vsb!: Int8Array;
  private u32!: Uint32Array;
  private bytes!: Uint8Array;
  a64 = false;
  pcx = 15; lrx = 14; spx = 13;
  private threadData = 0;
  jthread: JThread;
  tid: number;
  stackBase = 0; stackTop = 0;
  errnoAddr = 0;
  env = 0;
  /** the pthread key table: TLS_KEYS guest pointers, read and written by the core */
  tlsTab = 0;
  pending: Promise<unknown> | null = null;
  /** signals queued for this thread, delivered at its next slice boundary */
  signals: number[] = [];
  signalMask = 0n;

  constructor(jthread: JThread, name: string) {
    this.jthread = jthread;
    this.name = name;
    this.tid = ++tidSeq;
    this.base = core.cpu_alloc(this.tid, A64 ? 1 : 0) >>> 0;
    if (!this.base) throw new NativeFault("[native] out of memory for thread state");
    this.views();
    mem.initHooks.push(() => this.views());
    this.args = A64 ? new Args64(this) : new Args(this);
    this.setAbi(A64);
    // the TLS block, errno, then the pthread key table the core serves lookups from
    this.threadData = mem.calloc(1, 264 + 8 * TLS_KEYS);
    if (!this.threadData) throw new NativeFault("[native] out of memory for thread data");
    this.tlsBase = this.threadData;
    this.errnoAddr = this.threadData + 256;
    this.u32[OFF_ERRNO >> 2] = this.errnoAddr;
    this.tlsTab = this.threadData + 264;
    this.u32[OFF_TLSTAB >> 2] = this.tlsTab;
    cpus.add(this);
  }
  private views(): void {
    const b = mem.buf, base = this.base;
    this.w = new Int32Array(b, base + OFF_X, 64);
    this.s = new Float32Array(b, base + OFF_V, 128); this.d = new Float64Array(b, base + OFF_V, 64);
    this.si = new Int32Array(b, base + OFF_V, 128); this.vu = new Uint32Array(b, base + OFF_V, 128);
    this.vw = new Uint16Array(b, base + OFF_V, 256); this.vsw = new Int16Array(b, base + OFF_V, 256);
    this.vb = new Uint8Array(b, base + OFF_V, 512); this.vsb = new Int8Array(b, base + OFF_V, 512);
    this.u32 = new Uint32Array(b, base, SIZE >> 2);
    this.bytes = new Uint8Array(b, base, SIZE);
  }
  // ── the struct's scalar fields
  get pc(): number { return this.u32[OFF_PC >> 2]; }
  setPc(addr: number): void { this.u32[OFF_PC >> 2] = addr & (this.a64 ? -1 : ~1); this.u32[(OFF_PC >> 2) + 1] = 0; if (!this.a64) this.t = addr & 1; }
  get lr(): number { return this.w[2 * this.lrx]; }
  get sp(): number { return this.w[2 * this.spx]; }
  get cpsr(): number { return this.u32[OFF_CPSR >> 2]; }
  set cpsr(v: number) { this.u32[OFF_CPSR >> 2] = v; }
  get n(): number { return this.cpsr >>> 31; }
  set n(v: number) { this.cpsr = (this.cpsr & 0x7fffffff) | (v << 31); }
  get z(): number { return (this.cpsr >>> 30) & 1; }
  set z(v: number) { this.cpsr = (this.cpsr & ~(1 << 30)) | (v << 30); }
  get c(): number { return (this.cpsr >>> 29) & 1; }
  set c(v: number) { this.cpsr = (this.cpsr & ~(1 << 29)) | (v << 29); }
  get v(): number { return (this.cpsr >>> 28) & 1; }
  set v(v: number) { this.cpsr = (this.cpsr & ~(1 << 28)) | (v << 28); }
  get q(): number { return (this.cpsr >>> 27) & 1; }
  set q(v: number) { this.cpsr = (this.cpsr & ~(1 << 27)) | (v << 27); }
  get t(): number { return (this.cpsr >>> 5) & 1; }
  set t(v: number) { this.cpsr = (this.cpsr & ~(1 << 5)) | (v << 5); }
  get fpcr(): number { return this.u32[OFF_FPCR >> 2]; }
  set fpcr(v: number) { this.u32[OFF_FPCR >> 2] = v; }
  get fpsr(): number { return this.u32[OFF_FPSR >> 2]; }
  set fpsr(v: number) { this.u32[OFF_FPSR >> 2] = v; }
  /** exclusive monitor: set by LDXR, consumed by STXR; a slice must not end between them */
  get excl(): number { return this.u32[OFF_EXCL >> 2]; }
  set excl(v: number) { this.u32[OFF_EXCL >> 2] = v; }
  get tlsBase(): number { return this.u32[OFF_TLS >> 2]; }
  set tlsBase(v: number) { this.u32[OFF_TLS >> 2] = v; this.u32[(OFF_TLS >> 2) + 1] = 0; }
  /** instructions executed */
  get ic(): number { return this.u32[(OFF_IC >> 2) + 1] * 4294967296 + this.u32[OFF_IC >> 2]; }
  /** start of the block being executed (fault attribution) */
  get bpc(): number { return this.u32[OFF_BPC >> 2]; }
  private get exit(): number { return this.u32[OFF_EXIT >> 2]; }
  /** the pointer in x[i], translated */
  xp(i: number): number { const hi = this.w[2 * i + 1]; return hi ? mem.tx(hi, this.w[2 * i]) : this.w[2 * i] >>> 0; }

  // SIGKILL and SIGSTOP cannot be masked.
  sigmask(how: number, set: number, old: number, size: number): number {
    if (size !== 4 && size !== 8 || set && (how < 0 || how > 2)) return 22;
    const mask = set ? (size === 8 ? mem.ld64(set) : BigInt(mem.ld32(set) >>> 0)) : 0n;
    if (old) { if (size === 8) mem.st64(old, this.signalMask); else mem.st32(old, Number(this.signalMask & 0xffffffffn)); }
    if (set) {
      this.signalMask = (how === 0 ? this.signalMask | mask : how === 1 ? this.signalMask & ~mask : mask) & 0xfffffffffffbfeffn;
      this.pump();
    }
    return 0;
  }
  private takeSignal(): number {
    if (!this.signals.length) return 0;
    const i = this.signals.findIndex((sig) => !(this.signalMask & 1n << BigInt(sig - 1)));
    return i < 0 ? 0 : this.signals.splice(i, 1)[0];
  }
  /** the depth of the run loop awaiting a host call's promise, -1 for none: the Cpu is parked only when that
   *  loop is the innermost one — a nested frame in its teardown, or a handler above, owns the register file */
  parkedAt = -1;
  get parked(): boolean { return this.parkedAt === this.depth; }
  loops = 0;                                        // run loops alive on this Cpu (0: a Java thread between native calls)
  state = "";                                       // which await the run loop is in (wd.native.regs)
  idle: (() => void)[] = [];                        // a run loop waiting for a handler stacked above it to finish
  sigWait: (() => void) | null = null;              // sigsuspend: released when a handler has run
  /** a signal for this thread: a parked thread runs the handler now, on top of its host call,
   *  as a kernel interrupts a syscall; a running one at its next slice boundary */
  handling = new Set<number>();                     // signals whose handler is running
  kill(sig: number): void {
    if (this.finished || !sigHandlers.has(sig)) return;
    if (!this.signals.includes(sig)) this.signals.push(sig);           // pending already: signals do not queue up
    this.pump();
  }
  /** a queued signal reaches a parked or idle Cpu on a clean stack, never inside the sender's own host call;
   *  a running loop takes its queue at its next slice boundary. A handler parked in its own host call
   *  (sigsuspend) is a parked frame like any other: the next signal runs on top of it. */
  pump(): void {
    queueMicrotask(() => { if (!this.finished && (this.parked || this.loops === 0)) { const sig = this.takeSignal(); if (sig) void this.deliver(sig); } });
  }
  sigLog: string[] = [];                           // wd.native.regs: what each thread was signalled and when it ran
  /** a handler running on an otherwise idle Cpu (a Java thread between native calls): the next
   *  entry from Java waits for it, since two unrelated call() frames cannot share one register file */
  baseBusy: Promise<void> | null = null;
  /** an entry from Java must not stack on a handler that owns the register file from the bottom */
  async awaitIdleBase(): Promise<void> {
    while (this.baseBusy || (this.loops > 0 && this.frames[0]?.startsWith("signal "))) {
      if (this.baseBusy) await this.baseBusy;
      else await new Promise<void>((r) => this.idle.push(r));
    }
  }
  async deliver(sig: number): Promise<void> {
    const h = sigHandlers.get(sig);
    if (callLog && this.name === callLog) console.log(`[call-native] ${this.name} deliver ${sig} depth=${this.depth} loops=${this.loops} parked=${this.parked} state=${this.state}`);
    this.sigLog.push(`${sig}@${this.ic}${this.parked ? "p" : ""}/${this.loops}`);
    const mask = this.signalMask, handling = this.handling.has(sig);
    this.signalMask = (mask | (h?.mask ?? 0n) | (h && h.flags & 0x40000000 ? 0n : 1n << BigInt(sig - 1))) & 0xfffffffffffbfeffn;
    this.handling.add(sig);
    const base = this.loops === 0;
    const p = (async () => { if (h) await this.call(h.fn, [sig, 0, 0], "signal " + sig); })();
    if (base) this.baseBusy = p.catch(() => {}).finally(() => { this.baseBusy = null; });
    try { await p; }
    catch (e) { console.error(`[native] signal ${sig} handler on ${this.name}:`, e); throw e; }
    finally {
      this.sigLog.push(`~${sig}`);
      this.signalMask = mask;
      if (!handling) this.handling.delete(sig);
      this.pump();
    }
    const w = this.sigWait;
    if (w) { this.sigWait = null; w(); }
  }
  exc: unknown = null;
  ret1 = 0;           // r1 (ARM32) or the high half of x0 at the return of the last call() (64-bit results)
  private retFp0 = 0; private retFp1 = 0;
  args: ArgReader & { reset(cpu: Cpu): void };
  name: string;
  depth = 0;
  /** guest-visible thread exit (pthread_exit / thread function returned) */
  finished = false;

  dispose(): void {
    if (this.loops) throw new Error("[native] cannot dispose a running thread");
    if (!cpus.has(this)) return;
    this.finished = true;
    if (this.stackTop) mem.freeStack(this.stackBase, this.stackTop);
    mem.free(this.threadData); mem.free(this.env);
    this.threadData = this.errnoAddr = this.env = this.stackBase = this.stackTop = 0;
    this.signals.length = 0;
    cpus.delete(this);
    if (byThread.get(this.jthread) === this) byThread.delete(this.jthread);
    core.cpu_free(this.base);
  }

  ensureStack(): void {
    if (!this.stackTop) {
      const s = mem.allocStack(STACK_SIZE);
      this.stackBase = s.base; this.stackTop = s.top;
      this.w[2 * this.spx] = s.top; this.w[2 * this.spx + 1] = 0;
    }
  }

  /** run guest function `fn` to completion on this Cpu (reentrant: saves and restores the register file) */
  frames: string[] = [];                            // what each nested call() is for (wd.native.regs)
  private savePool: Uint8Array[] = [];
  async call(fn: number, args: CallArg[] = [], label = "call"): Promise<number> {
    // host code calling back into the guest (a comparator, a JNI entry) while a signal handler owns the
    // register file above the frame it belongs to waits for that handler, as the kernel would hold the
    // thread; a handler's own delivery never waits
    if (!label.startsWith("signal ")) while (this.frames.length && this.frames[this.frames.length - 1].startsWith("signal ")) await new Promise<void>((r) => this.idle.push(r));
    this.frames.push(label);
    if (callLog && this.name === callLog) console.log(`[call-native] ${this.name} enter ${label} depth=${this.depth} loops=${this.loops} parked=${this.parked} pending=${!!this.pending} fn=${symbolizeHook(fn >>> 0)} lr=${symbolizeHook(this.lr >>> 0)} pc=${symbolizeHook(this.pc)}`);
    this.ensureStack();
    const w = this.w;
    const saved = this.savePool.pop() ?? new Uint8Array(ARCH_SIZE);
    saved.set(this.bytes.subarray(0, ARCH_SIZE));
    const spending = this.pending, sstate = this.state;   // the frame below is parked in its host call until we return
    this.excl = 0;
    let n = 0, nv = 0;
    const stack: (number | bigint)[] = [];
    const nregs = this.a64 ? 8 : 4;
    for (const a0 of args) {
      let a = a0;
      if (typeof a === "object") {
        // AAPCS64 hard float: v0-v7, then 8-byte stack slots. softfp: the bits, as an integer
        if (this.a64) {
          if (nv < 8) { if ("f" in a) this.s[nv * 4] = a.f; else this.d[nv * 2] = a.d; nv++; continue; }
          a = "f" in a ? fbits(a.f) : dbits(a.d);
        } else a = "f" in a ? fbits(a.f) : dbits(a.d);
      }
      if (typeof a === "bigint") {
        // AAPCS64 puts a 64-bit value in one register; AAPCS32 wants an even pair
        if (!this.a64 && (n & 1)) n++;
        if (n < nregs) {
          w[2 * n] = Number(a & 0xffffffffn) | 0;
          if (this.a64) { w[2 * n + 1] = Number((a >> 32n) & 0xffffffffn) | 0; n++; }
          else { w[2 * n + 2] = Number((a >> 32n) & 0xffffffffn) | 0; n += 2; }
        } else { n = nregs; stack.push(a); }
      } else if (n < nregs) { w[2 * n] = a | 0; w[2 * n + 1] = 0; n++; }
      else stack.push(a | 0);
    }
    // a nested call (Java → native while this Cpu is parked in a host call) builds its frame below the guest's sp
    const slotSz = this.a64 ? 8 : 4, align = this.a64 ? ~15 : ~7;
    let sp = (this.depth ? w[2 * this.spx] - 64 : this.stackTop) & align;
    if (stack.length) {
      sp = (sp - stack.length * slotSz) & align;
      let p = sp;
      for (const a of stack) {
        if (typeof a === "bigint") { if (!this.a64) p = (p + 7) & ~7; mem.st64(p, a); p += 8; }
        else { mem.st32(p, a); if (this.a64) mem.st32(p + 4, 0); p += slotSz; }
      }
    }
    w[2 * this.spx] = sp; w[2 * this.spx + 1] = 0;
    w[2 * this.lrx] = RET_SENTINEL; w[2 * this.lrx + 1] = 0;
    this.setPc(fn);
    this.pending = null;
    this.depth++;
    try {
      await this.run();
      this.ret1 = this.a64 ? w[1] : w[2];
      this.retFp0 = this.a64 ? this.si[0] : w[0];
      this.retFp1 = this.a64 ? this.si[1] : w[2];
      return w[0];
    } finally {
      if (callLog && this.name === callLog) console.log(`[call-native] ${this.name} leave ${label} depth=${this.depth} loops=${this.loops} pc=${symbolizeHook(this.pc)} r0=${(w[0] >>> 0).toString(16)}`);
      this.depth--;
      this.frames.pop();
      for (const w2 of this.idle.splice(0)) w2();
      this.bytes.set(saved);
      this.savePool.push(saved);
      this.pending = spending; this.state = sstate;
      this.pump();                                                          // a signal that arrived while this frame owned the register file reaches the frame below now
    }
  }

  /** the float/double a call() just returned, wherever the ABI put it */
  retF(): number { return bitsf(this.retFp0); }
  retD(): number { return bitsd(retPair(this.retFp0, this.retFp1)); }

  /** the slice driver: run until the frame returns (pc = RET_SENTINEL) or the thread finishes */
  async run(): Promise<void> {
    this.loops++;
    try { await this.loop(); } finally { this.loops--; }
  }
  private async loop(): Promise<void> {
    const myDepth = this.depth;
    for (;;) {
      setCurThread(this.jthread);
      if (processExited) await new Promise<never>(() => {});
      for (let sig; (sig = this.takeSignal());) { this.state = "deliver"; await this.deliver(sig); }
      const t0 = performance.now(), ic0 = this.ic;
      let ex: SliceExit;
      this.state = "slice";
      try { ex = this.runSlice(slice.instr); }
      finally {
        perf.nativeMs += performance.now() - t0; perf.nativeSlices++; perf.nativeInstr += this.ic - ic0;
        if (slowMs && performance.now() - t0 > slowMs) console.warn(`[slow-native] ${this.name} slice ${(performance.now() - t0).toFixed(0)}ms ${this.ic - ic0} instr from ${symbolizeHook(this.bpc)}`);
      }
      if (ex === SliceExit.Exit) { if (callLog && this.name === callLog) console.log(`[call-native] ${this.name} loop exit depth=${this.depth} myDepth=${myDepth} loops=${this.loops}`); return; }
      if (ex === SliceExit.Suspend) {
        const p = this.pending!;
        if (callLog && this.name === callLog) console.log(`[call-native] ${this.name} loop park depth=${this.depth} myDepth=${myDepth} at ${symbolizeHook(this.pc)}`);
        this.pending = null;
        const outerParked = this.parkedAt;                                        // a frame below may be parked in its own host call
        this.parkedAt = myDepth;
        this.pump();
        this.state = "park";
        const v = await p;
        // a handler delivered while we were parked may still be running on top of this frame,
        // parked in its own host call (sigsuspend): the flag is its until it finishes
        this.state = "idle";
        while (this.depth > myDepth) await new Promise<void>((r) => this.idle.push(r));
        if (callLog && this.name === callLog) console.log(`[call-native] ${this.name} loop resume depth=${this.depth} myDepth=${myDepth} loops=${this.loops} pc=${symbolizeHook(this.pc)} lr=${symbolizeHook(this.lr >>> 0)}`);
        this.parkedAt = outerParked;
        setCurThread(this.jthread);
        if (this.finished) return;
        hostReturn(this, v as HostRet);
        continue;
      }
      this.state = "yield";
      await yieldToLoop();
    }
  }

  /** run the core until the frame returns, a host call parks the thread, or the budget is spent */
  runSlice(budget: number): SliceExit {
    const limit = this.ic + budget;
    for (;;) {
      if (stepMode.on) { stepPrev.set(this.w); if (watchPcs.has(this.pc)) this.watchHit(); }
      let ex: number;
      try { ex = core.run_slice(this.base, Math.max(stepMode.on ? 1 : 0, limit - this.ic)); }
      catch (e) { throw this.trap(e); }
      if (stepMode.on) this.step();
      jitDrain();
      switch (ex) {
        case CoreExit.Budget:
          if (profile.on) profile.samples.set(this.pc, (profile.samples.get(this.pc) ?? 0) + 1);
          if (this.ic >= limit) return SliceExit.Budget;
          continue;
        case CoreExit.Host:
          hostDispatch(this, this.exit);
          if (this.pending) return SliceExit.Suspend;
          if (this.finished) return SliceExit.Exit;
          continue;
        case CoreExit.Ret: return SliceExit.Exit;
        case CoreExit.Syscall: this.syscall(this.exit); continue;
        default: {
          const code = this.exit, word = this.u32[OFF_WORD >> 2] >>> 0;
          const what = code === 2 ? `bad address 0x${(this.u32[OFF_ADDR >> 2] >>> 0).toString(16)}` : code === 6 ? `${FAULTS[code]} ${word}` : `${FAULTS[code] ?? "fault " + code} 0x${word.toString(16).padStart(8, "0")}`;
          this.fault(what);
        }
      }
    }
  }
  /** the syscalls the host owns, left by the core with their number */
  private syscall(nr: number): void {
    const w = this.w;
    if (nr === 135) {                                                                    // rt_sigprocmask
      const result = w[6] === 8 ? this.sigmask(w[0], this.xp(1), this.xp(2), 8) : 22;
      w[0] = -result; w[1] = result ? -1 : 0;
    } else if (nr === 175) {
      w[0] = -(w[6] === 8 ? this.sigmask(w[0], w[2] >>> 0, w[4] >>> 0, 8) : 22);
    } else this.fault(`syscall ${nr}`);
  }
  private trap(e: unknown): NativeFault {
    if (e instanceof NativeFault) return e;
    this.snapshot();
    // the wasm frame (region function and byte offset) says which emitted code trapped
    const frame = e instanceof Error ? /wasm-function\[\d+\]:0x[0-9a-f]+/.exec(e.stack ?? "") : null;
    const f = new NativeFault(`[native] ${e instanceof Error ? e.message : String(e)}${frame ? ` in ${frame[0]}` : ""} @ ${symbolizeHook(this.bpc)} (block 0x${this.bpc.toString(16)}, ${this.name})`);
    f.pc = this.bpc;
    return f;
  }
  /** the tracing variant's record: pc + the registers the last instruction changed, into stepMode.ring */
  private step(): void {
    const a64 = this.a64, names = a64 ? XN : RN, nregs = a64 ? 32 : 15, at = this.bpc, w = this.w;
    if (at >= TRAMP_BASE && at < TRAMP_END) return;
    let d = "";
    for (let i = 0; i < nregs; i++) {
      if (w[2 * i] !== stepPrev[2 * i] || (a64 && w[2 * i + 1] !== stepPrev[2 * i + 1])) d += ` ${names[i]}=${a64 && w[2 * i + 1] ? (w[2 * i + 1] >>> 0).toString(16) + (w[2 * i] >>> 0).toString(16).padStart(8, "0") : (w[2 * i] >>> 0).toString(16)}`;
    }
    stepMode.ring.push(`${this.name} ${symbolizeHook(at)}${d} [${this.n}${this.z}${this.c}${this.v}]`);
    if (stepMode.ring.length > stepMode.max) stepMode.ring.splice(0, 5000);
  }

  setAbi(on: boolean): void {
    this.a64 = on;
    this.u32[OFF_A64 >> 2] = on ? 1 : 0;
    this.pcx = on ? 32 : 15; this.lrx = on ? 30 : 14; this.spx = on ? 31 : 13;
    if (on !== (this.args instanceof Args64)) this.args = on ? new Args64(this) : new Args(this);
  }
  /** interworking branch target (BX semantics): returns the pc to continue at */
  bx(addr: number): number { this.t = addr & 1; return addr & ~1; }
  setFlags(v: number): void { this.cpsr = (this.cpsr & 0x07ffffff) | (v & 0xf8000000); }
  watchHit(): void {
    const x = (i: number) => (this.w[2 * i + 1] ? (this.w[2 * i + 1] >>> 0).toString(16) + "_" : "") + (this.w[2 * i] >>> 0).toString(16).padStart(this.w[2 * i + 1] ? 8 : 1, "0");
    console.log(`[watch-native] ${this.name} ${symbolizeHook(this.pc)} x0..x7=${[0, 1, 2, 3, 4, 5, 6, 7].map(x).join(" ")} lr=${symbolizeHook(this.lr >>> 0)}`);
  }
  /** the register file at the first fault, for wd.native.lastFault */
  private snapshot(): void {
    if (!lastFault.regs) lastFault.regs = { cpu: this.name, r: [...Array(32)].map((_, i) => this.w[2 * i]), h: [...Array(32)].map((_, i) => this.w[2 * i + 1]) };
  }
  fault(msg: string): never {
    this.snapshot();
    const e = new NativeFault(`[native] ${msg} @ ${symbolizeHook(this.pc)} (block 0x${this.bpc.toString(16)}, ${this.name}, lr=${symbolizeHook(this.lr >>> 0)})`);
    e.pc = this.pc;
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
export function bindCpu(t: JThread, c: Cpu): void { byThread.set(t, c); }
export function cpuByTid(tid: number): Cpu | undefined { for (const c of cpus) if (c.tid === tid) return c; return undefined; }
/** sigaction's table: signal → handler (sa_handler or sa_sigaction) and flags */
export const sigHandlers = new Map<number, { fn: number; flags: number; mask?: bigint }>();

let symbolizeHook: (pc: number) => string = (pc) => "0x" + pc.toString(16);
export function setSymbolizeHook(f: (pc: number) => string): void { symbolizeHook = f; }

// A macrotask boundary so the main looper, rAF and other cooperative threads get the JS thread.
// MessageChannel is not subject to the nested-setTimeout clamp.
const chan = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
const waiters: (() => void)[] = [];
if (chan) {
  chan.port1.onmessage = () => { yieldStats.fires++; const w = waiters.splice(0); for (const f of w) f(); };
  // an open port keeps a bun/node process alive after its work is done (tests, scripts)
  (chan.port1 as unknown as { unref?: () => void }).unref?.();
}
export function yieldToLoop(): Promise<void> {
  if (!chan) return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) => { yieldStats.pushes++; if (waiters.push(r) === 1) chan.port2.postMessage(0); });
}
export const yieldStats = { pushes: 0, fires: 0, pending: () => waiters.length, kick: () => { const w = waiters.splice(0); for (const f of w) f(); return w.length; } };
