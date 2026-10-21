// The guest CPU's host half: one Cpu per guest thread, its state a struct in the core's memory
// (cpu.zig), and the async call driver that runs slices, suspends on host promises, delivers
// signals and yields between slices. The core executes; this decides what happens at its exits.

import type { JniClass } from "./jnivm.ts";
import { type JThread, mainThread, releaseThread, resumeAs, threadContended } from "../jvm/natives/jentry.ts";
import { rt } from "../jvm/runtime.ts";
import type { Strand } from "../jvm/suspend.ts";
import { mem } from "./mem.ts";
import { NativeFault, BadAddress } from "./core.ts";
import { core, jitDrain, TLS_KEYS } from "./core.ts";
import { Args, Args64, type ArgReader, onBadAddress, kernelEntry, hostDispatch, hostReturn, setPtrWidth, type HostRet, fbits, dbits, bitsf, wordsd, slowMs, NORET, hostTrace } from "./host.ts";
import { E, RET_SENTINEL, TRAMP_BASE, TRAMP_END, STACK_SIZE, MAIN_STACK_SIZE, MEM_SIZE, MEM_SIZE_A32, MEM_SIZE_A64 } from "./abi.ts";
import { perf } from "../perf.ts";
import { answeringFor, yieldToLoop } from "../jvm/yield.ts";
import { procIdentity, processTid } from "../shell/procfs.ts";
import { never, processExited } from "../process-exit.ts";
import { SIGILL, SIGTRAP, SIGBUS, SIGSEGV, SA_SIGINFO, SA_ONSTACK, SA_RESETHAND, SA_NODEFER, SS_DISABLE, SS_AUTODISARM, BLOCKABLE, action, blocked, dispositions, sigbit, type Handler } from "./signals.ts";
import { frameSize, writeFrame, loadContext, type SigInfo } from "./sigframe.ts";
import { dieOfSignal } from "./crash.ts";
import { setKernelLayout } from "./kernel.ts";
import { backtrace } from "./dl.ts";

const SliceExit = { Budget: 0, Suspend: 1, Exit: 2, Signal: 3 } as const;
type SliceExit = (typeof SliceExit)[keyof typeof SliceExit];
const CoreExit = { Budget: 0, Host: 1, Ret: 2, Fault: 3, Syscall: 4 } as const;
const ILL_ILLOPC = 1, TRAP_BRKPT = 1, BUS_ADRALN = 1, SEGV_MAPERR = 1, SEGV_ACCERR = 2;
/** a nested call() on this register file: what it is for (wd.native.regs) and, for a signal handler,
 *  the stack range it runs on, the state a siglongjmp out of it leaves for the interrupted code, and
 *  what its return restores */
interface Frame { label: string; handler?: HandlerFrame }
interface HandlerFrame { lo: bigint; hi: bigint; exit: (() => void) | null; resume: (returned: boolean) => void }
// ~5 ms of guest time per slice: coarse enough that the macrotask hop per slice is noise, fine
// enough that a 60 Hz frame loop on the JS thread keeps its cadence
const SLICE_INSTR = 3_000_000;
const RESPONSIVE_SLICE_INSTR = 300_000;
/** the run loop's instruction budget per slice; lowering it makes `profile` sample finely (debug) */
export const slice = { instr: SLICE_INSTR };
let lastPresentAt = -Infinity;
const FRAME_ACTIVE_MS = 500;

/** a frame reached the screen, whoever drew it */
export function notePresent(): void { lastPresentAt = performance.now(); }
/** a native thread swapped a frame, which reaches the screen through the next present() */
export function noteNativeFrame(cpu: Cpu): void {
  const now = performance.now();
  for (let c: Cpu | null = cpu; c; c = c.parent) c.lastFrameAt = now;
}

function sliceBudget(): number {
  return answeringFor() ? Math.min(slice.instr, RESPONSIVE_SLICE_INSTR) : slice.instr;
}

/** an argument to a guest function: a float or double travels in a V register on AAPCS64 and as
 *  its bit pattern in core registers on the softfp ABI, and only Cpu.call knows which */
export type CallArg = number | bigint | { f: number } | { d: number };

// the struct layout, from the core rather than spelled twice
const L = (i: number) => core.layout(i);
const SIZE = L(0), OFF_X = L(1), OFF_PC = L(2), OFF_V = L(3), OFF_CPSR = L(4), OFF_FPCR = L(5), OFF_FPSR = L(6), OFF_EXCL = L(7), OFF_TLS = L(8), OFF_IC = L(9), OFF_BPC = L(10), OFF_A64 = L(12), OFF_EXIT = L(13), OFF_WORD = L(14), OFF_ADDR = L(15), OFF_ERRNO = L(17), OFF_TLSTAB = L(18);
/** the architectural state a nested call saves and restores: registers, pc, V file, flags, monitor */
const ARCH_SIZE = L(16);
const Fault = { Undefined: 1, BadAddress: 2, MisalignedPc: 3, Brk: 5, UnsupportedSyscall: 6, NullPage: 8, Extension: 9 } as const;
const FAULTS = ["unimplemented", "undefined", "bad address", "misaligned pc", "dc zva", "brk", "svc: unsupported syscall", "system register", "null page", "optional extension"];

export const codeStats = { get pages(): number { return core.cpu_stat(0); }, get invalidated(): number { return core.cpu_stat(1); } };
/** single-step register trace: every instruction logs pc + the registers it changed (slow; debugging only) */
export const stepMode = { on: false, ring: [] as string[], max: 40000 };
export function setStepMode(on: boolean): void {
  stepMode.on = on;
  core.set_max_block(on ? 1 : 256);
  stepMode.ring.length = 0;
}
const stepPrev = new Int32Array(64);
const RN = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11", "ip", "sp", "lr", "pc"];
const XN = [...Array(31)].map((_, i) => `x${i}`).concat(["sp"]);
/** slice-boundary pc samples (one per budget exit; `slice.instr` sets how fine): a free statistical profile */
export const profile = { on: true, samples: new Map<number, number>() };
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
  const size = on ? MEM_SIZE_A64 : MEM_SIZE_A32;
  if (A64 === on && MEM_SIZE === size) return;
  A64 = on;
  mem.init(size);
  // the pointer width is a property of the process, not of a thread: set it here, because the
  // JNI tables are laid out before the first Cpu exists
  setPtrWidth(on ? 8 : 4);
  setKernelLayout(on);
  for (const c of cpus) c.setAbi(on);
  core.invalidate_all();
}
export function isA64(): boolean { return A64; }

/** the register file at the first native fault, as the faulting block found it (debug) */
export const lastFault: { regs: { cpu: string; r: number[]; h: number[]; bt: string[]; frames: string[] } | null; msg: string } = { regs: null, msg: "" };
export const watchPcs = new Set<number>(((globalThis as { __wdWatch?: number[] }).__wdWatch ?? []).map((p) => p >>> 0));
/** a run loop taking its thread for a turn it resumes in, and handing it back where it parks */
interface LoopTurn { own(): void; release(): void }

export class Cpu {
  /** the class declaring the native method this thread is running, whose loader FindClass resolves in */
  nativeClass: JniClass | null = null;
  parent: Cpu | null = null;
  /** when this thread last produced a frame; Infinity for a thread that always feeds a device */
  lastFrameAt = -Infinity;
  /** the state struct's address in guest memory */
  readonly base: number;
  /** the registers as int32 halves: w[2i] is the low half of x[i] (r[i] on ARM32), w[2i+1] the high; x31 is sp */
  w!: Int32Array;
  // The SIMD&FP register file V0..V31 (Vn.S[i] = s[4n+i], Vn.D[i] = d[2n+i], bytes at vb[16n+i]).
  // ARM32's VFP keeps its own map over the same bytes (Sn = s[n], Dn = d[n]); a process is one
  // ABI, so the two never meet. Moves go through the integer views so NaN payloads survive.
  s!: Float32Array; d!: Float64Array; si!: Int32Array; vu!: Uint32Array; vw!: Uint16Array; vsw!: Int16Array; vb!: Uint8Array;
  private u32!: Uint32Array;
  private bytes!: Uint8Array;
  a64 = false;
  pcx = 15; lrx = 14; spx = 13;
  private threadData = 0;
  private staticTlsBlocks = new Map<object, number>();
  /** the pthread_internal_t this thread is known by: pthread_self(), the handle pthread_create hands out */
  pthreadSelf = 0;
  jthread: JThread;
  tid: number;
  readonly pid: number;
  readonly osTid: number;
  stackBase = 0; stackTop = 0;
  env = 0;
  /** the pthread key table: TLS_KEYS guest pointers, read and written by the core */
  tlsTab = 0;
  pending: Promise<unknown> | null = null;
  private budgetWake: (() => void) | null = null;
  /** signals pending for this thread, delivered at its next slice boundary, each with the siginfo its
   *  sender described (a POSIX timer's; null is tgkill's). A pending signal does not queue again. */
  signals = new Map<number, SigInfo | null>();
  /** takes the first pending signal `pick` accepts, with its siginfo */
  takePending(pick: (sig: number) => boolean): { sig: number; info: SigInfo | null } | null {
    for (const [sig, info] of this.signals) if (pick(sig)) { this.signals.delete(sig); return { sig, info }; }
    return null;
  }
  signalInterrupt: (() => void) | null = null;
  private deferredSignalDepths = new Set<number>();
  deferSignalsUntilResume(): void { if (this.depth) this.deferredSignalDepths.add(this.depth); }
  /** an app thread's mask on the reference device (/proc/<pid>/task/<tid>/status SigBlk 0x80001204):
   *  ART's Runtime::BlockSignals (SIGQUIT, SIGUSR1, SIGPIPE) and bionic's reserved signal 32 */
  signalMask = 0x80001204n;
  alternateStack: { sp: bigint; size: bigint; flags: number } | null = null;
  alternateActive = false;

  constructor(jthread: JThread, name: string) {
    this.jthread = jthread;
    this.name = name;
    this.tid = ++tidSeq;
    this.pid = procIdentity.pid;
    this.osTid = processTid(jthread, jthread === mainThread);
    this.base = core.cpu_alloc(this.tid, this.osTid, this.pid, A64 ? 1 : 0) >>> 0;
    if (!this.base) throw new NativeFault("[native] out of memory for thread state");
    this.views();
    this.setAbi(A64);
    // the TLS block, errno, the pthread key table the core serves lookups from, then the
    // pthread_internal_t pthread_self() names (bionic's layout: tid at +0x10, the stack in
    // attr at +0x20/+0x28), which TLS slot 1 points at as on a device
    this.threadData = mem.calloc(1, 264 + 8 * TLS_KEYS + PTHREAD_SIZE);
    if (!this.threadData) throw new NativeFault("[native] out of memory for thread data");
    this.tlsBase = this.threadData;
    this.errnoAddr = this.threadData + 256;
    this.tlsTab = this.threadData + 264;
    this.u32[OFF_TLSTAB >> 2] = this.tlsTab;
    this.pthreadSelf = this.tlsTab + 8 * TLS_KEYS;
    mem.st32(this.pthreadSelf + 0x10, this.osTid);
    mem.st32(this.tlsBase + (A64 ? 8 : 4), this.pthreadSelf);
    cpus.add(this);
  }
  // a memory committed whole detached every live thread's views
  static { mem.initHooks.push(() => { for (const c of cpus) c.views(); }); }
  private views(): void {
    const b = mem.buf, base = this.base;
    this.w = new Int32Array(b, base + OFF_X, 64);
    this.s = new Float32Array(b, base + OFF_V, 128); this.d = new Float64Array(b, base + OFF_V, 64);
    this.si = new Int32Array(b, base + OFF_V, 128); this.vu = new Uint32Array(b, base + OFF_V, 128);
    this.vw = new Uint16Array(b, base + OFF_V, 256); this.vsw = new Int16Array(b, base + OFF_V, 256);
    this.vb = new Uint8Array(b, base + OFF_V, 512);
    this.u32 = new Uint32Array(b, base, SIZE >> 2);
    this.bytes = new Uint8Array(b, base, ARCH_SIZE);
  }
  // ── the struct's scalar fields
  get pc(): number { return this.u32[OFF_PC >> 2]; }
  setPc(addr: number): void { this.u32[OFF_PC >> 2] = addr & (this.a64 ? -1 : ~1); this.u32[(OFF_PC >> 2) + 1] = 0; if (!this.a64) this.t = addr & 1; }
  get lr(): number { return this.w[2 * this.lrx]; }
  get sp(): number { return this.w[2 * this.spx]; }
  get spVa(): bigint { return (this.a64 ? BigInt(this.w[2 * this.spx + 1] >>> 0) << 32n : 0n) | BigInt(this.w[2 * this.spx] >>> 0); }
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
  /** where the guest libc keeps this thread's errno, which the host's and the core's failures set */
  get errnoAddr(): number { return this.u32[OFF_ERRNO >> 2]; }
  set errnoAddr(v: number) { this.u32[OFF_ERRNO >> 2] = v; }
  get tlsBase(): number { return this.u32[OFF_TLS >> 2]; }
  set tlsBase(v: number) { this.u32[OFF_TLS >> 2] = v; this.u32[(OFF_TLS >> 2) + 1] = 0; }
  /** the thread pointer as the guest holds it: a guest libc's TLS block may lie in a plane */
  get tlsVa(): bigint { return BigInt(this.u32[(OFF_TLS >> 2) + 1]) << 32n | BigInt(this.u32[OFF_TLS >> 2]); }
  set tlsVa(v: bigint) { this.u32[OFF_TLS >> 2] = Number(v & 0xffffffffn); this.u32[(OFF_TLS >> 2) + 1] = Number(v >> 32n); }
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
      this.signalMask = (how === 0 ? this.signalMask | mask : how === 1 ? this.signalMask & ~mask : mask) & BLOCKABLE;
      this.pump();
    }
    return 0;
  }
  /** a pending signal the mask lets through: a call that raised or unblocked one returns to it, as
   *  the kernel delivers on the way back to user space */
  private deliverable(): boolean {
    for (const sig of this.signals.keys()) if (!blocked(this.signalMask, sig)) return true;
    return false;
  }
  private takeSignal() { return this.takePending((sig) => !blocked(this.signalMask, sig)); }
  /** the depth of the run loop awaiting a host call's promise, -1 for none: the Cpu is parked only when that
   *  loop is the innermost one — a nested frame in its teardown, or a handler above, owns the register file */
  parkedAt = -1;
  get parked(): boolean { return this.parkedAt === this.depth; }
  private get baseAvailable(): boolean { return this.loops === 0 && this.depth === 0; }
  loops = 0;                                        // run loops alive on this Cpu (0: a Java thread between native calls)
  state = "";                                       // which await the run loop is in (wd.native.regs)
  idle: (() => void)[] = [];                        // a run loop waiting for a handler stacked above it to finish
  sigWait: (() => void) | null = null;              // sigsuspend: released when a handler has run
  sigQueued: (() => void) | null = null;            // sigtimedwait: told of each signal queued
  handling = new Set<number>();                     // signals whose handler is running
  /** a signal for this thread: a parked thread runs the handler now, on top of its host call,
   *  as a kernel interrupts a syscall; a running one at its next slice boundary */
  kill(sig: number, info: SigInfo | null = null): void {
    // an ignored signal is discarded unless blocked: a handler may be installed before it is unblocked
    if (this.finished || !blocked(this.signalMask, sig) && action(sig, this.signalMask, false) === "ignore") return;
    if (!this.signals.has(sig)) this.signals.set(sig, info);
    this.sigQueued?.();
    if (this.signalInterrupt && !blocked(this.signalMask, sig)) {
      this.deferSignalsUntilResume();
      this.signalInterrupt();
      return;
    }
    this.pump();
  }
  /** a queued signal reaches a parked or idle Cpu on a clean stack, except an interrupted futex
   *  returns to the guest first. A running loop takes its queue at its next slice boundary. A handler parked in its own host call
   *  (sigsuspend) is a parked frame like any other: the next signal runs on top of it. */
  pump(): void {
    if (this.budgetWake && this.deliverable()) this.budgetWake();
    queueMicrotask(() => {
      if (this.finished || this.deferredSignalDepths.size || (!this.parked && !this.baseAvailable)) return;
      const taken = this.takeSignal();
      if (taken) void this.deliver(taken.sig, taken.info);
    });
  }
  sigLog: string[] = [];                           // wd.native.regs: what each thread was signalled and when it ran, the latest 40
  private logSignal(entry: string): void { if (this.sigLog.push(entry) > 40) this.sigLog.shift(); }
  /** a handler running on an otherwise idle Cpu (a Java thread between native calls): the next
   *  entry from Java waits for it, since two unrelated call() frames cannot share one register file */
  baseBusy: Promise<void> | null = null;
  /** awaitIdleBase when there is anything to wait for or deliver: a Java→native call that finds
   *  the base free keeps its Java caller's frames rather than suspending them */
  idleBase(): Promise<void> | undefined {
    if (this.baseBusy || this.loops > 0 && this.frames[0]?.handler) return this.awaitIdleBase();
    if (this.baseAvailable && this.deliverable()) return this.awaitIdleBase();
  }
  /** an entry from Java must not stack on a handler that owns the register file from the bottom */
  async awaitIdleBase(): Promise<void> {
    for (;;) {
      if (this.baseBusy) { await this.baseBusy; continue; }
      if (this.loops > 0 && this.frames[0]?.handler) {
        await new Promise<void>((r) => this.idle.push(r));
        continue;
      }
      if (!this.baseAvailable) return;
      const taken = this.takeSignal();
      if (!taken) return;
      await this.deliver(taken.sig, taken.info);
    }
  }
  /** `fault`: this thread's own instruction raised it. As the kernel's force_sig_fault, such a signal
   *  blocked or ignored takes its default action. */
  async deliver(sig: number, info: SigInfo | null = null, fault = false): Promise<void> {
    const act = action(sig, this.signalMask, fault);
    if (act !== "handler") { if (act !== "ignore") void dieOfSignal(this, sig, info); return; }
    const h = dispositions.get(sig) as Handler;
    if (h.flags & SA_RESETHAND) dispositions.delete(sig);
    this.logSignal(`${sig}@${this.ic}${this.parked ? "p" : ""}/${this.loops}`);
    const mask = this.signalMask, handling = this.handling.has(sig);
    this.signalMask = (mask | h.mask | (h.flags & SA_NODEFER ? 0n : sigbit(sig))) & BLOCKABLE;
    this.handling.add(sig);
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      this.signalMask = mask;
      if (!handling) this.handling.delete(sig);
    };
    const base = this.baseAvailable;
    const alt = (h.flags & SA_ONSTACK) && this.alternateStack && !(this.alternateStack.flags & SS_DISABLE) && !this.alternateActive
      ? this.alternateStack.sp + this.alternateStack.size : undefined;
    const p = (async () => {
      const frame = h.flags & SA_SIGINFO ? mem.malloc(frameSize(this)) : 0;
      if (h.flags & SA_SIGINFO && !frame) throw new NativeFault("[native] out of memory for signal frame");
      const context = frame ? writeFrame(this, frame, sig, info, mask) : 0;
      const previousAlt = this.alternateStack, previousActive = this.alternateActive;
      if (alt !== undefined) {
        const autodisarm = !!(previousAlt && previousAlt.flags & SS_AUTODISARM);
        this.alternateActive = !autodisarm;
        if (autodisarm) this.alternateStack = { sp: 0n, size: 0n, flags: SS_DISABLE };
      }
      // a handler runs below the interrupted sp, or on the alternate stack. sigreturn: the handler
      // may have rewritten the context, which is loaded before the interrupted frame or another
      // signal can run on this register file.
      const handler: HandlerFrame = {
        lo: alt !== undefined ? this.alternateStack!.sp : 0n, hi: alt ?? this.spVa, exit: null,
        resume: (returned) => {
          restore();
          if (handler.exit) handler.exit();
          else if (returned && context) loadContext(this, context);
        },
      };
      try {
        await this.enter(h.fn, [sig, frame, context], { label: "signal " + sig, handler }, alt);
      } finally {
        if (alt !== undefined) { this.alternateStack = previousAlt; this.alternateActive = previousActive; }
        if (frame) mem.free(frame);
      }
    })();
    if (base) this.baseBusy = p.catch(() => {}).finally(() => { this.baseBusy = null; });
    try { await p; }
    catch (e) { console.error(`[native] signal ${sig} handler on ${this.name}:`, e); throw e; }
    finally {
      this.logSignal(`~${sig}`);
      restore();
      this.pump();
    }
    const w = this.sigWait;
    if (w) { this.sigWait = null; w(); }
  }
  exc: unknown = null;
  ret1 = 0;           // r1 (ARM32) or the high half of x0 at the return of the last call() (64-bit results)
  private retFp0 = 0; private retFp1 = 0;
  args!: ArgReader & { reset(cpu: Cpu): void };
  /** a system call's arguments, in registers alone */
  private svcArgs!: ArgReader & { reset(cpu: Cpu): void };
  name: string;
  depth = 0;
  /** guest-visible thread exit (pthread_exit / thread function returned) */
  finished = false;

  dispose(retainThreadData = false): number {
    if (this.loops) throw new Error("[native] cannot dispose a running thread");
    if (!cpus.has(this)) return 0;
    this.finished = true;
    if (this.stackBase) mem.freeStack(this.stackBase, this.stackTop);
    for (const p of this.staticTlsBlocks.values()) mem.free(p);
    this.staticTlsBlocks.clear();
    const threadData = retainThreadData ? this.threadData : 0;
    if (!retainThreadData) mem.free(this.threadData);
    mem.free(this.env);
    this.threadData = this.errnoAddr = this.env = this.stackBase = this.stackTop = 0;
    this.signals.clear();
    cpus.delete(this);
    if (byThread.get(this.jthread) === this) byThread.delete(this.jthread);
    core.cpu_free(this.base);
    return threadData;
  }
  /** an unloaded image's TLS block */
  releaseTls(key: object): void {
    const p = this.staticTlsBlocks.get(key);
    if (p === undefined) return;
    mem.free(p);
    this.staticTlsBlocks.delete(key);
  }
  staticTls(key: object, image: Uint8Array, size: number, align: number): number {
    const existing = this.staticTlsBlocks.get(key);
    if (existing !== undefined) return existing;
    const p = mem.memalign(Math.max(8, align), size);
    if (!p) throw new NativeFault("[native] out of memory for static TLS");
    mem.memset(p, 0, size);
    mem.u8.set(image, p);
    this.staticTlsBlocks.set(key, p);
    return p;
  }

  /** clone(2)'s child: the caller's architectural state, returning 0 from the svc on `stack` */
  forkFrom(parent: Cpu, stack: bigint): void {
    this.bytes.set(parent.bytes);
    this.w[0] = 0; this.w[1] = 0;
    this.w[2 * this.spx] = Number(stack & 0xffffffffn); this.w[2 * this.spx + 1] = Number(stack >> 32n);
    this.stackTop = Number(stack & 0xffffffffn);                         // the guest's: stackBase stays 0, never freed here
  }
  /** CLONE_CHILD_CLEARTID's word, cleared and woken when the thread exits */
  clearChildTid = 0n;
  /** who made this thread known to a guest libc (bionic): no one yet, the host (threadHooks, for
   *  a Java thread entering native code) or the guest itself (clone) */
  libc: "none" | "host" | "guest" = "none";
  /** the host's binding of this thread to the guest libc: TPIDR, pthread_self() and errno's address */
  bindThread(tp: number, self: number, errno: number): void {
    this.tlsBase = tp; this.pthreadSelf = self;
    this.errnoAddr = errno;
    this.libc = "host";
  }
  /** clone(CLONE_SETTLS): the guest libc made this thread, with `tls` its thread pointer */
  cloned(tls: bigint): void { this.tlsVa = tls; this.libc = "guest"; threadHooks?.cloned(this); }

  ensureStack(size = this.jthread === mainThread ? MAIN_STACK_SIZE : STACK_SIZE): void {
    if (!this.stackTop) {
      const s = mem.allocStack(size);
      this.stackBase = s.base; this.stackTop = s.top;
      this.w[2 * this.spx] = s.top; this.w[2 * this.spx + 1] = 0;
      if (this.a64) { mem.st64(this.pthreadSelf + 0x20, BigInt(s.base)); mem.st64(this.pthreadSelf + 0x28, BigInt(s.top - s.base)); }
    }
  }

  /** the nested calls running on this register file, innermost last */
  frames: Frame[] = [];
  private savePool: Uint8Array[] = [];
  /** run guest function `fn` to completion on this Cpu (reentrant: saves and restores the register file) */
  call(fn: number, args: CallArg[] = [], label = "call"): Promise<number> { return Promise.resolve(this.enter(fn, args, { label })); }
  /** call(), but a number when the guest returns within its first slice without parking: a Java
   *  caller then keeps its frames instead of suspending every one of them */
  callSync(fn: number, args: CallArg[] = [], label = "call"): number | Promise<number> { return this.enter(fn, args, { label }); }
  /** `fn` as `frame`: a signal handler's on `stackTop` (its alternate stack) when given */
  private enter(fn: number, args: CallArg[], frame: Frame, stackTop?: bigint, strand = rt.cur): number | Promise<number> {
    // host code calling back into the guest (a comparator, a JNI entry) while a signal handler owns the
    // register file above the frame it belongs to waits for that handler, as the kernel would hold the
    // thread; a handler's own delivery never waits
    if (!frame.handler && this.frames.at(-1)?.handler)
      return new Promise<void>((r) => this.idle.push(r)).then(() => this.enter(fn, args, frame, stackTop, strand));
    this.frames.push(frame);
    this.ensureStack();
    const w = this.w;
    const saved = this.savePool.pop() ?? new Uint8Array(ARCH_SIZE);
    saved.set(this.bytes);
    const spending = this.pending, sstate = this.state;   // the frame below is parked in its host call until we return
    this.excl = 0;
    if (!this.a64) this.cpsr &= ~0x0600fc00;
    let n = 0, nv = 0;
    let stack: (number | bigint)[] | undefined;
    const nregs = this.a64 ? 8 : 4;
    for (const a0 of args) {
      let a = a0;
      if (typeof a === "object") {
        // AAPCS64 hard float: v0-v7, then 8-byte stack slots. softfp: the bits, as an integer
        if (this.a64) {
          if (nv < 8) { if ("f" in a) this.s[nv * 4] = a.f; else this.d[nv * 2] = a.d; nv++; continue; }
          (stack ??= []).push("f" in a ? fbits(a.f) : dbits(a.d));
          continue;
        } else a = "f" in a ? fbits(a.f) : dbits(a.d);
      }
      if (typeof a === "bigint") {
        // AAPCS64 puts a 64-bit value in one register; AAPCS32 wants an even pair
        if (!this.a64 && (n & 1)) n++;
        if (n < nregs) {
          w[2 * n] = Number(a & 0xffffffffn) | 0;
          if (this.a64) { w[2 * n + 1] = Number((a >> 32n) & 0xffffffffn) | 0; n++; }
          else { w[2 * n + 2] = Number((a >> 32n) & 0xffffffffn) | 0; n += 2; }
        } else { n = nregs; (stack ??= []).push(a); }
      } else if (n < nregs) { w[2 * n] = a | 0; w[2 * n + 1] = 0; n++; }
      else (stack ??= []).push(a | 0);
    }
    // a nested call (Java → native while this Cpu is parked in a host call) builds its frame below the guest's sp
    const slotSz = this.a64 ? 8 : 4, align = this.a64 ? ~15 : ~7;
    const nested = this.depth > 0 || stackTop !== undefined;
    const currentSp = this.depth && stackTop === undefined ? this.spVa : 0n;
    const top = stackTop ?? (this.depth ? currentSp - 64n : BigInt(this.stackTop));
    const baseSp = nested ? mem.txVa(top - 16n) + 16 : this.stackTop;
    let sp = (baseSp & align) >>> 0;
    if (stack?.length) {
      sp = ((sp - stack.length * slotSz) & align) >>> 0;
      let p = sp;
      for (const a of stack) {
        if (typeof a === "bigint") { if (!this.a64) p = ((p + 7) & ~7) >>> 0; mem.st64(p, a); p += 8; }
        else { mem.st32(p, a); if (this.a64) mem.st32(p + 4, 0); p += slotSz; }
      }
    }
    const stackVa = nested ? top - BigInt(baseSp - sp) : BigInt(sp);
    w[2 * this.spx] = Number(stackVa & 0xffffffffn); w[2 * this.spx + 1] = Number(stackVa >> 32n);
    w[2 * this.lrx] = RET_SENTINEL; w[2 * this.lrx + 1] = 0;
    this.setPc(fn);
    this.pending = null;
    this.depth++;
    let returned = false;
    const finish = (): number => {
      returned = true;
      if (frame.handler && this.spVa !== stackVa) this.escapeHandler(frame.handler);
      this.ret1 = this.a64 ? w[1] : w[2];
      this.retFp0 = this.a64 ? this.si[0] : w[0];
      this.retFp1 = this.a64 ? this.si[1] : w[2];
      return w[0];
    };
    const leave = () => {
      this.depth--;
      this.frames.pop();
      this.bytes.set(saved);
      this.savePool.push(saved);
      this.pending = spending; this.state = sstate;
      // A signal frame's state belongs to it until the interrupted frame can resume.
      frame.handler?.resume(returned);
      if (this.idle.length) for (const w2 of this.idle.splice(0)) w2();
      this.pump();                                                          // a signal that arrived while this frame owned the register file reaches the frame below now
    };
    let ran: void | Promise<void>;
    try { ran = this.run(strand); } catch (e) { leave(); throw e; }
    if (!ran) { try { return finish(); } finally { leave(); } }
    return ran.then(finish).finally(leave);
  }

  /** the float/double a call() just returned, wherever the ABI put it */
  retF(): number { return bitsf(this.retFp0); }
  retD(): number { return wordsd(this.retFp0, this.retFp1); }

  /** the guest libc's teardown of this thread, once its Java thread has ended */
  endThread(): Promise<void> { return this.libc === "host" && threadHooks ? threadHooks.end(this) : Promise.resolve(); }

  /** the slice driver: run until the frame returns (pc = RET_SENTINEL) or the thread finishes;
   *  synchronous when it returns within its first slice */
  run(strand = rt.cur): void | Promise<void> {
    if (this.libc === "none" && threadHooks) return threadHooks.start(this).then(() => this.runLoop(strand));
    return this.runLoop(strand);
  }
  private runLoop(strand: Strand): void | Promise<void> {
    this.loops++;
    // the caller's strand when it is this thread's (a JNI call), else the thread as no chain (its own start)
    const sync = { on: true };
    let loop: void | Promise<void>;
    try { loop = this.loop(sync, strand.thread === this.jthread ? strand : this.jthread.root); }
    catch (e) { this.loops--; throw e; }
    sync.on = false;
    if (!loop) { this.loops--; return; }
    return loop.finally(() => { this.loops--; });
  }
  /** The first slice runs before any await, so a guest function that returns within it (most JNI
   *  natives) completes on the caller's stack. `sync.on` while the caller is still on the stack: a
   *  frame that never parked leaves it its thread. */
  private loop(sync: { on: boolean }, strand: Strand): void | Promise<void> {
    const caller = rt.cur;
    // each turn the loop resumes in runs as the strand that entered it
    const turn: LoopTurn = { own: () => resumeAs(strand), release: releaseThread };
    turn.own();
    if (processExited() || this.deliverable()) return this.drive(sync, caller, turn);
    let ex: SliceExit;
    try { ex = this.timedSlice(); } catch (e) { if (sync.on) resumeAs(caller); else turn.release(); throw e; }
    if (ex !== SliceExit.Exit) return this.drive(sync, caller, turn, ex);
    if (sync.on) resumeAs(caller); else turn.release();
  }
  /** one budgeted slice, accounted */
  private timedSlice(): SliceExit {
    const t0 = performance.now(), ic0 = this.ic;
    this.state = "slice";
    try { return this.runSlice(sliceBudget()); }
    finally {
      const dt = performance.now() - t0;
      this.lastSliceMs = dt;
      perf.nativeMs += dt; perf.nativeSlices++; perf.nativeInstr += this.ic - ic0;
      if (slowMs && dt > slowMs) console.warn(`[slow-native] ${this.name} slice ${dt.toFixed(0)}ms ${this.ic - ic0} instr from ${symbolizeHook(this.bpc)}`);
    }
  }
  private lastSliceMs = 0;
  /** the run loop past its first slice (`first`, already run when given) */
  private async drive(sync: { on: boolean }, caller: Strand, turn: LoopTurn, first?: SliceExit): Promise<void> {
    const myDepth = this.depth;
    let budgetStreak = 0;
    try {
      for (;;) {
        let ex: SliceExit;
        if (first !== undefined) { ex = first; first = undefined; }
        else {
          turn.own();
          if (processExited()) { turn.release(); await never(); }
          for (let taken; (taken = this.takeSignal());) await this.deliverFromLoop(turn, taken.sig, taken.info);
          ex = this.timedSlice();
        }
        const sliceMs = this.lastSliceMs;
        if (ex === SliceExit.Exit) return;
        if (ex === SliceExit.Suspend) {
          budgetStreak = 0;
          const p = this.pending!, slot = this.exit;
          this.pending = null;
          const outerParked = this.parkedAt;                                        // a frame below may be parked in its own host call
          this.parkedAt = myDepth;
          this.pump();
          this.state = "park";
          turn.release();
          let v: unknown;
          try { v = await p; } catch (e) {
            if (!(e instanceof BadAddress)) throw e;
            v = onBadAddress(this, e, kernelEntry(slot));
          }
          // a handler delivered while we were parked may still be running on top of this frame,
          // parked in its own host call (sigsuspend): the flag is its until it finishes
          this.state = "idle";
          while (this.depth > myDepth) {
            turn.release();
            await new Promise<void>((r) => this.idle.push(r));
          }
          this.parkedAt = outerParked;
          turn.own();
          if (this.finished) return;
          this.deferredSignalDepths.delete(myDepth);
          if (!this.raised) { hostReturn(this, v as HostRet); continue; }
          ex = SliceExit.Signal;
        }
        if (ex === SliceExit.Signal) {
          // the handler runs with the state the faulting instruction (or host body) left, pc at it
          const { sig, info } = this.raised!;
          this.raised = null;
          await this.deliverFromLoop(turn, sig, info, true);
          // a handler that returns to an instruction that faults again spins as on a device, but
          // as a slice: other threads and the page run between its turns
          turn.release();
          await yieldToLoop();
          continue;
        }
        this.state = "yield";
        turn.release();
        budgetStreak++;
        // All guest pthreads share one JS thread, where a device would run them on other cores:
        // while input is being handled or frames are being presented, sustained background work
        // (not the UI thread, not a frame producer) gets about a quarter of it. Back-to-back slices
        // would otherwise hold off rendering until Chrome's 100 ms starvation limit.
        const now = performance.now();
        if ((answeringFor(now) > 0 || budgetStreak >= 3 && now - lastPresentAt < FRAME_ACTIVE_MS) && !this.foreground(now))
          await new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setTimeout>;
            const resume = () => { clearTimeout(timer); if (this.budgetWake === resume) this.budgetWake = null; resolve(); };
            this.budgetWake = resume;
            timer = setTimeout(resume, Math.min(250, sliceMs * 3));
          });
        else await yieldToLoop();
      }
    } finally { if (sync.on) resumeAs(caller); else turn.release(); }
  }

  /** exempt from the background share: the UI thread, a running signal handler, a frame producer,
   *  and a thread another is blocked on, which would otherwise wait at the background's pace */
  private foreground(now: number): boolean {
    return this.jthread === mainThread || this.handling.size > 0 || now - this.lastFrameAt < FRAME_ACTIVE_MS || !!threadContended.hook?.(this.jthread);
  }
  /** run the core until the frame returns, a host call parks the thread, or the budget is spent */
  runSlice(budget: number): SliceExit {
    const limit = this.ic + budget;
    for (;;) {
      if (stepMode.on) { stepPrev.set(this.w); if (watchPcs.has(this.pc)) this.watchHit(); }
      let ex: number;
      try { ex = core.run_slice(this.base, stepMode.on ? 1 : Math.max(0, limit - this.ic)); }
      catch (e) { throw this.trap(e); }
      if (stepMode.on) this.step();
      switch (ex) {
        case CoreExit.Budget:
          jitDrain();
          if (profile.on) profile.samples.set(this.pc, (profile.samples.get(this.pc) ?? 0) + 1);
          if (this.ic >= limit) return SliceExit.Budget;
          continue;
        case CoreExit.Host:
          hostDispatch(this, this.exit);
          if (this.pending || this.finished || this.raised) { jitDrain(); return this.pending ? SliceExit.Suspend : this.raised ? SliceExit.Signal : SliceExit.Exit; }
          if (this.signals.size && this.deliverable()) { jitDrain(); return SliceExit.Budget; }
          continue;
        case CoreExit.Ret: jitDrain(); return SliceExit.Exit;
        case CoreExit.Syscall:
          this.syscall(this.exit);
          if (this.pending) { jitDrain(); return SliceExit.Suspend; }
          if (this.signals.size && this.deliverable()) { jitDrain(); return SliceExit.Budget; }
          continue;
        default: {
          const code = this.exit, word = this.u32[OFF_WORD >> 2] >>> 0;
          if ((this.raised = this.faultSignal(code))) { jitDrain(); return SliceExit.Signal; }
          const what = code === Fault.BadAddress ? `bad address 0x${(this.u32[OFF_ADDR >> 2] >>> 0).toString(16)}` : code === Fault.UnsupportedSyscall ? `${FAULTS[code]} ${word}` : `${FAULTS[code] ?? "fault " + code} 0x${word.toString(16).padStart(8, "0")}`;
          this.fault(what);
        }
      }
    }
  }
  /** the syscalls the host owns, left by the core with their number, through the kernel's table
   *  (syscall.ts), which libc's syscall(2) reaches too */
  private syscall(nr: number): void {
    const w = this.w;
    if (hostTrace.on) hostTrace.ring.push(`${this.name}:svc ${nr}(${[0, 1, 2, 3, 4, 5].map((i) => (BigInt(w[2 * i + 1] >>> 0) << 32n | BigInt(w[2 * i] >>> 0)).toString(16)).join(",")}) lr=${symbolizeHook(this.lr >>> 0)}`);
    if (!rawSyscall) this.fault(`syscall ${nr}`);
    const a = this.svcArgs;
    a.reset(this);
    let ret: HostRet | Promise<HostRet>;
    try { ret = rawSyscall(this, nr, a); } catch (e) { ret = this.copyFault(e); }
    // the core has already stepped past the svc: a parked syscall resumes by writing x0 alone
    if (ret instanceof Promise) {
      this.pending = ret.then((r) => { this.syscallReturn(r); return NORET; }, (e) => { this.syscallReturn(this.copyFault(e)); return NORET; });
      return;
    }
    this.syscallReturn(ret);
  }
  /** a system call's access through a bad user pointer fails as copy_from_user does */
  private copyFault(e: unknown): HostRet {
    if (!(e instanceof BadAddress)) throw e;
    return -E.FAULT;
  }
  /** the kernel's convention: the result in x0/r0, a failure as -errno */
  private syscallReturn(ret: HostRet): void {
    const w = this.w;
    if (typeof ret === "number") { w[0] = ret; w[1] = ret < 0 ? -1 : 0; }
    else if (typeof ret === "bigint") { w[0] = Number(ret & 0xffffffffn); w[1] = Number((ret >> 32n) & 0xffffffffn); }
    else w[0] = w[1] = 0;
  }
  private trap(e: unknown): NativeFault {
    if (e instanceof NativeFault) {
      // a fault a host function raised (mem.tx on a bad pointer argument) names no guest site: add the block it was called from
      if (!e.pc) { e.message += ` @ ${symbolizeHook(this.bpc)} (block 0x${this.bpc.toString(16)}, ${this.name})`; e.pc = this.bpc; }
      return e;
    }
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
      if (w[2 * i] !== stepPrev[2 * i] || (a64 && w[2 * i + 1] !== stepPrev[2 * i + 1])) d += ` ${names[i]}=${this.regHex(i)}`;
    }
    stepMode.ring.push(`${this.name} ${symbolizeHook(at)}${d} [${this.n}${this.z}${this.c}${this.v}]`);
    if (stepMode.ring.length > stepMode.max) stepMode.ring.splice(0, 5000);
  }

  setAbi(on: boolean): void {
    this.a64 = on;
    this.u32[OFF_A64 >> 2] = on ? 1 : 0;
    this.pcx = on ? 32 : 15; this.lrx = on ? 30 : 14; this.spx = on ? 31 : 13;
    if (this.args && on === this.args instanceof Args64) return;
    this.args = on ? new Args64(this) : new Args(this);
    this.svcArgs = on ? this.args : new Args(this, 7);
  }
  /** register `i` in hex, a 64-bit one with a set high half as hi_lo */
  regHex(i: number): string {
    const lo = (this.w[2 * i] >>> 0).toString(16), hi = this.a64 ? this.w[2 * i + 1] >>> 0 : 0;
    return hi ? hi.toString(16) + "_" + lo.padStart(8, "0") : lo;
  }
  watchHit(): void {
    console.log(`[watch-native] ${this.name} ${symbolizeHook(this.pc)} x0..x7=${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => this.regHex(i)).join(" ")} lr=${symbolizeHook(this.lr >>> 0)}`);
  }
  /** the register file at the first fault, for wd.native.lastFault */
  private snapshot(): void {
    if (!lastFault.regs) lastFault.regs = { cpu: this.name, r: [...Array(32)].map((_, i) => this.w[2 * i]), h: [...Array(32)].map((_, i) => this.w[2 * i + 1]), bt: backtrace(this), frames: this.frames.map((f) => f.label) };
  }
  /** the signal a guest instruction's fault raises, as the kernel's abort handlers choose it; null
   *  for an emulator gap (an unimplemented encoding, an unsupported syscall), which stays a host fault */
  private faultSignal(code: number): { sig: number; info: SigInfo } | null {
    const pc = BigInt(this.pc);
    switch (code) {
      case Fault.Undefined: case Fault.Extension: return { sig: SIGILL, info: { code: ILL_ILLOPC, addr: pc } };
      case Fault.Brk: return { sig: SIGTRAP, info: { code: TRAP_BRKPT, addr: pc } };
      case Fault.MisalignedPc: return { sig: SIGBUS, info: { code: BUS_ADRALN, addr: pc } };
      case Fault.NullPage: return { sig: SIGSEGV, info: { code: SEGV_MAPERR, addr: this.faultAddress } };
      case Fault.BadAddress: return memoryFault(this.faultAddress);
    }
    return null;
  }
  /** a host function's access through a bad pointer, as the libc code it stands for would make
   *  it: the signal is raised at its entry, which a handler that returns runs again */
  raiseBadAddress(e: BadAddress): void { this.raised = memoryFault(e.addr); }
  private get faultAddress(): bigint { return BigInt(this.u32[(OFF_ADDR >> 2) + 1]) << 32n | BigInt(this.u32[OFF_ADDR >> 2]); }
  /** the synchronous signal a slice ended on, for the run loop to deliver */
  raised: { sig: number; info: SigInfo } | null = null;
  private async deliverFromLoop(turn: LoopTurn, sig: number, info: SigInfo | null, fault = false): Promise<void> {
    this.state = "deliver";
    const delivery = this.deliver(sig, info, fault);
    turn.release();
    await delivery;
    turn.own();
  }
  /** siglongjmp from a signal handler to a jmp_buf whose sp lies outside the handler's stack:
   *  the handler's frame is abandoned, as the kernel's would be, and the code it interrupted
   *  resumes in the state `apply` sets */
  leaveHandler(sp: bigint, apply: () => void): boolean {
    const h = this.frames.at(-1)?.handler;
    if (!h || (sp >= h.lo && sp < h.hi)) return false;
    h.exit = apply;
    this.setPc(RET_SENTINEL);
    return true;
  }
  /** A handler frame that reaches its return with another sp was left without sigreturn (its
   *  registers restored by hand, as a guest's own longjmp does): what returned is the code it
   *  jumped to, so the interrupted frame returns too, in this state and signal mask. */
  private escapeHandler(h: HandlerFrame): void {
    if (h.exit) return;
    const state = this.bytes.slice(), mask = this.signalMask;
    h.exit = () => { this.bytes.set(state); this.signalMask = mask; };
  }
  fault(msg: string): never {
    const first = !lastFault.regs;
    this.snapshot();
    const e = new NativeFault(`[native] ${msg} @ ${symbolizeHook(this.pc)} (block 0x${this.bpc.toString(16)}, ${this.name}, lr=${symbolizeHook(this.lr >>> 0)})`);
    // the first fault is the one worth knowing about even when Java catches it: keep its text
    if (first) { lastFault.msg = e.message; console.warn("[native fault]", e.message); }
    e.pc = this.pc;
    throw e;
  }
}

/** the kernel's syscall dispatcher, installed by kernelInit: raw svc/swi numbers the core leaves to the host */
let rawSyscall: ((cpu: Cpu, nr: number, a: ArgReader) => HostRet | Promise<HostRet>) | null = null;
/** a data access fault at `addr`: no mapping, or one without the access; a plane-0 address
 *  past both is a misaligned access */
function memoryFault(addr: bigint): { sig: number; info: SigInfo } {
  const h = Number(addr >> 32n), lo = Number(addr & 0xffffffffn);
  if (h) return { sig: SIGSEGV, info: { code: core.plane_reserved(h) ? SEGV_ACCERR : SEGV_MAPERR, addr } };
  if (!mem.backed(lo)) return { sig: SIGSEGV, info: { code: SEGV_MAPERR, addr } };
  if (mem.writeProtected(lo)) return { sig: SIGSEGV, info: { code: SEGV_ACCERR, addr } };
  return { sig: SIGBUS, info: { code: BUS_ADRALN, addr } };
}
export function setRawSyscall(fn: (cpu: Cpu, nr: number, a: ArgReader) => HostRet | Promise<HostRet>): void { rawSyscall = fn; }
/** bionic's pthread_internal_t is under 0x200 bytes; a crash reporter scans it up to a page */
const PTHREAD_SIZE = 0x200;
let tidSeq = 0;
/** the guest libc's state for a thread the host created: `start` binds it (bindThread) before its
 *  first instruction, `end` tears it down when its Java thread ends; `cloned` finds a thread's the
 *  guest libc created */
let threadHooks: { start: (cpu: Cpu) => Promise<void>; end: (cpu: Cpu) => Promise<void>; cloned: (cpu: Cpu) => void } | null = null;
export function setThreadHooks(hooks: NonNullable<typeof threadHooks>): void { threadHooks = hooks; }
export const cpus = new Set<Cpu>();
const byThread = new WeakMap<JThread, Cpu>();

export function cpuFor(t: JThread): Cpu {
  let c = byThread.get(t);
  if (!c) { c = new Cpu(t, t.jname); byThread.set(t, c); }
  return c;
}
export const cpuOf = (t: JThread): Cpu | undefined => byThread.get(t);
/** sets a thread's native name: what prctl(PR_SET_NAME), pthread_setname_np and a /proc comm write set, and what pthread_getname_np and comm read */
export function nameThread(t: JThread, name: string): void { t.jname = name; const c = byThread.get(t); if (c) c.name = name; }
export function bindCpu(t: JThread, c: Cpu): void { byThread.set(t, c); }
export function cpuByTid(tid: number): Cpu | undefined { for (const c of cpus) if (c.tid === tid) return c; return undefined; }
export function cpuByOsTid(tid: number): Cpu | undefined { for (const c of cpus) if (c.osTid === tid) return c; return undefined; }
let symbolizeHook: (pc: number) => string = (pc) => "0x" + pc.toString(16);
export function setSymbolizeHook(f: (pc: number) => string): void { symbolizeHook = f; }
