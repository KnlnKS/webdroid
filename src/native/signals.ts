// Signals: their numbers and names, sigset bits, the process's dispositions (sigaction's one
// table) and the rule kill(2) and delivery both follow to decide what a signal does, with the
// calls that send, mask, wait for and dispose of them. A thread's queue, mask and alternate
// stack are its Cpu's; the frame a handler runs on is sigframe.ts's; what a fatal signal leaves
// behind is crash.ts's.

import { mem, anchor } from "./mem.ts";
import { stp, ldp, ldWord, stWord, PTR, type HostFn, type ArgReader } from "./host.ts";
import { E } from "./abi.ts";
import { readTimeout } from "./kernel.ts";
import { type Cpu, cpuByOsTid } from "./cpu.ts";
import { dieOfSignal } from "./crash.ts";
import { writeSiginfo } from "./sigframe.ts";
import { waitUntil } from "./poll.ts";

export const SIGQUIT = 3, SIGILL = 4, SIGTRAP = 5, SIGABRT = 6, SIGBUS = 7, SIGFPE = 8, SIGKILL = 9, SIGSEGV = 11, SIGPIPE = 13;
export const SIGSTKFLT = 16, SIGCHLD = 17, SIGCONT = 18, SIGSTOP = 19, SIGTSTP = 20, SIGTTIN = 21, SIGTTOU = 22, SIGURG = 23;
export const SIGXCPU = 24, SIGXFSZ = 25, SIGWINCH = 28, SIGSYS = 31;
export const SIGNAL_NAMES = ["", "SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGBUS", "SIGFPE", "SIGKILL", "SIGUSR1", "SIGSEGV",
  "SIGUSR2", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGSTKFLT", "SIGCHLD", "SIGCONT", "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG",
  "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGPWR", "SIGSYS"];
export const SA_SIGINFO = 4, SA_ONSTACK = 0x08000000, SA_RESTART = 0x10000000, SA_NODEFER = 0x40000000, SA_RESETHAND = 0x80000000;
export const SS_ONSTACK = 1, SS_DISABLE = 2, SS_AUTODISARM = 0x80000000;
const SIG_IGN = 1;

/** `sig`'s bit in a sigset_t */
export const sigbit = (sig: number): bigint => 1n << BigInt(sig - 1);
export const sigset = (...sigs: number[]): bigint => sigs.reduce((m, sig) => m | sigbit(sig), 0n);
export const blocked = (mask: bigint, sig: number): boolean => (mask & sigbit(sig)) !== 0n;
/** the signals a mask can hold: SIGKILL and SIGSTOP are never blocked */
export const BLOCKABLE = ~sigset(SIGKILL, SIGSTOP) & 0xffff_ffff_ffff_ffffn;
// signal(7)'s default actions. Stop signals are ignored: nothing here could continue the process.
const DEFAULT_IGNORED = sigset(SIGCHLD, SIGCONT, SIGSTOP, SIGTSTP, SIGTTIN, SIGTTOU, SIGURG, SIGWINCH);
const DUMPS_CORE = sigset(SIGQUIT, SIGILL, SIGTRAP, SIGABRT, SIGBUS, SIGFPE, SIGSEGV, SIGXCPU, SIGXFSZ, SIGSYS);
export const dumpsCore = (sig: number): boolean => blocked(DUMPS_CORE, sig);

/** a disposition other than the default: SIG_IGN, or a handler (sa_handler or sa_sigaction) */
export type Disposition = { kind: "ignore" } | Handler;
export type Handler = { kind: "handler"; fn: number; flags: number; mask: bigint };
/** sigaction's table, by signal; a signal it lacks takes its default action */
export const dispositions = new Map<number, Disposition>();
export const sigHandler = (fn: number, flags: number, mask: bigint): Handler => ({ kind: "handler", fn, flags, mask });

/** What delivering `sig` under `mask` does. `forced` is force_sig_fault's: a signal the thread's own
 *  instruction raised, which blocked or ignored takes its default action. */
export function action(sig: number, mask: bigint, forced: boolean): "handler" | "ignore" | "terminate" | "core" {
  const d = dispositions.get(sig);
  if (d?.kind === "handler" && !(forced && blocked(mask, sig))) return "handler";
  if (!forced && (d?.kind === "ignore" || !d && blocked(DEFAULT_IGNORED, sig))) return "ignore";
  return dumpsCore(sig) ? "core" : "terminate";
}

/** sigaction's disposition change: SIGKILL and SIGSTOP keep their default */
export function setDisposition(sig: number, fn: number, flags: number, mask: bigint): void {
  if (fn > SIG_IGN) dispositions.set(sig, sigHandler(fn, flags, mask));
  else if (fn === SIG_IGN) dispositions.set(sig, { kind: "ignore" });
  else dispositions.delete(sig);
}
export const handlerAddress = (sig: number): number => { const d = dispositions.get(sig); return d?.kind === "handler" ? d.fn : d ? SIG_IGN : 0; };
export interface SigactionLayout { size: number; handler: number; mask: number; flags: number; wideMask: boolean }
/** one signal's handler exchanged through a struct sigaction laid out as given */
export function exchangeAction(a: ArgReader, { size, handler: handlerAt, flags: flagsAt, mask: maskAt, wideMask }: SigactionLayout): number {
  const sig = a.i(), act = a.p(), old = a.p(), prev = dispositions.get(sig);
  if (sig < 1 || sig > 64 || act && (sig === SIGKILL || sig === SIGSTOP)) return -E.INVAL;
  if (old) {
    mem.memset(old, 0, size);
    stp(old + handlerAt, handlerAddress(sig));
    if (prev?.kind === "handler") {
      mem.st32(old + flagsAt, prev.flags);
      if (wideMask) mem.st64(old + maskAt, prev.mask); else mem.st32(old + maskAt, Number(prev.mask & 0xffffffffn));
    }
  }
  if (act) setDisposition(sig, ldp(act + handlerAt), mem.ld32(act + flagsAt), wideMask ? mem.ld64(act + maskAt) : BigInt(mem.ld32(act + maskAt) >>> 0));
  return 0;
}

/** kill/tgkill/raise: signal 0 only probes the target */
export function signalThread(target: Cpu, sig: number): number {
  if (sig < 0 || sig > 64) return -E.INVAL;
  if (sig) target.kill(sig);
  return 0;
}
/** bionic's abort: SIGABRT unblocked and raised; a handler that returns is followed by the default action */
export function abortThread(cpu: Cpu): Promise<never> {
  cpu.signalMask &= ~sigbit(SIGABRT);
  // a microtask on: the call has parked, so a handler runs on top of it
  return Promise.resolve().then(() => cpu.deliver(SIGABRT)).then(() => dieOfSignal(cpu, SIGABRT));
}
function sigaltstack(cpu: Cpu, a: ArgReader): number {
  const next = a.p(), old = a.p();
  const previous = cpu.alternateStack ?? { sp: 0n, size: 0n, flags: SS_DISABLE };
  const sizeAt = PTR === 8 ? 16 : 8;
  if (old) {
    stWord(old, previous.sp);
    mem.st32(old + PTR, previous.flags | (cpu.alternateActive ? SS_ONSTACK : 0));
    stWord(old + sizeAt, previous.size);
  }
  if (!next) return 0;
  if (cpu.alternateActive) return -E.PERM;
  const flags = mem.ld32(next + PTR) >>> 0;
  if (flags !== 0 && flags !== SS_DISABLE && flags !== SS_AUTODISARM) return -E.INVAL;
  if (flags === SS_DISABLE) { cpu.alternateStack = { sp: 0n, size: 0n, flags }; return 0; }
  const size = ldWord(next + sizeAt);
  if (size < 2048n) return -E.NOMEM;
  const sp = ldWord(next);
  cpu.alternateStack = { sp, size, flags };
  return 0;
}

/** sigtimedwait: the first signal of `set` pending or queued within `ms` (-1: forever), its siginfo
 *  written to `info`; -EAGAIN when none comes */
export function sigtimedwait(cpu: Cpu, set: bigint, info: () => number, ms: number): number | Promise<number> {
  const take = (): number => {
    const taken = cpu.takePending((sig) => blocked(set, sig));
    if (!taken) return 0;
    const at = info();
    if (at) writeSiginfo(at, taken.sig, taken.info);
    return taken.sig;
  };
  let sig = take();
  if (sig || ms === 0) return sig || -E.AGAIN;
  // taken as it is queued, before the Cpu could deliver it to a handler
  const subscribe = (wake: () => void) => { cpu.sigQueued = () => { if ((sig = take())) wake(); }; return () => { cpu.sigQueued = null; }; };
  return waitUntil(subscribe, ms, undefined, true).then(() => sig || -E.AGAIN);
}
/** tgkill: a thread of this process by its kernel tid, ESRCH once it has run to its end */
function signalTid(cpu: Cpu, pid: number, tid: number, sig: number): number {
  const t = cpuByOsTid(tid);
  return pid !== cpu.pid || !t || t.pid !== pid || t.finished ? -E.SRCH : signalThread(t, sig);
}

/** the signal calls the kernel and libc's wrappers share: a handler runs on the target thread, at
 *  once when it is parked in a host call (as a kernel interrupts a syscall) and at its next slice
 *  boundary when it is running */
export const SIGNAL_SYSCALLS: Record<string, HostFn> = {
  // the raw syscall's struct sigaction is the kernel's (handler, flags, restorer, mask), not bionic's
  rt_sigaction: (_c, a) => exchangeAction(a, { size: 3 * PTR + 8, handler: 0, flags: PTR, mask: 3 * PTR, wideMask: true }),
  tgkill: (cpu, a) => signalTid(cpu, a.i(), a.i(), a.i()),
  tkill: (cpu, a) => signalTid(cpu, cpu.pid, a.i(), a.i()),
  // the info is not carried
  rt_tgsigqueueinfo: (cpu, a) => signalTid(cpu, a.i(), a.i(), a.i()),
  kill: (cpu, a) => { a.i(); return signalThread(cpu, a.i()); },
  // the kernel's sigset_t is 8 bytes on both ABIs
  rt_sigprocmask: (cpu, a) => { const how = a.i(), set = a.p(), old = a.p(), e = a.u() === 8 ? cpu.sigmask(how, set, old, 8) : E.INVAL; return e ? -e : 0; },
  rt_sigtimedwait: (cpu, a) => { const set = mem.ld64(a.p()), info = anchor(a.p()); return sigtimedwait(cpu, set, info, readTimeout(a.p())); },
  sigsuspend: (cpu, a) => { const mask = cpu.signalMask; cpu.sigmask(2, a.p(), 0, PTR); return new Promise<number>((r) => { cpu.sigWait = () => { cpu.signalMask = mask; cpu.pump(); r(-E.INTR); }; }); },
  sigaltstack,
};
