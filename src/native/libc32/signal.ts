// The ARM32 libc's signal functions over the kernel's (signals.ts): sigaction through bionic's
// ARM32 layouts, pthread_kill by handle, and the sigset_t helpers.

import { mem, anchor } from "../mem.ts";
import { complete, type HostFn } from "../host.ts";
import { E } from "../abi.ts";
import { fail, readTimeout, wrapped } from "../kernel.ts";
import { type Cpu, cpuByTid } from "../cpu.ts";
import { SA_RESTART, SIGKILL, SIGSTOP, exchangeAction, handlerAddress, setDisposition, signalThread, sigset, sigtimedwait, type SigactionLayout } from "../signals.ts";
import { tidOf } from "./pthread.ts";

/** bionic's ARM32 struct sigaction, and sigaction64's, whose mask widens to 8 bytes and pushes sa_flags on */
const SIGACTION: SigactionLayout = { size: 16, handler: 0, mask: 4, flags: 8, wideMask: false };
const SIGACTION64: SigactionLayout = { size: 20, handler: 0, mask: 4, flags: 12, wideMask: true };
/** wd.native.killLog: the last pthread_kill calls, who signalled whom and what the target was doing */
export const killLog: string[] = [];
/** pthread_kill, answering the error itself: a thread that has run to its end is gone, ESRCH,
 *  which a stop-the-world collector discounts */
function killThread(c: Cpu, handle: number, sig: number): number {
  const tid = tidOf(handle), t = cpuByTid(tid), r = !t || t.finished ? E.SRCH : sig < 0 || sig > 64 ? E.INVAL : 0;
  killLog.push(`${c.name}->${t?.name ?? "tid" + tid}:${sig}=${r}${t ? `/${t.state},${t.loops},${t.parked ? "p" : ""}` : ""}`);
  if (killLog.length > 300) killLog.splice(0, 100);
  if (r === 0 && sig) t!.kill(sig);
  return r;
}

/** the ARM32 libc's own signal functions */
export const SIGNAL_LIBC: Record<string, HostFn> = {
  // bionic reserves the first two realtime signals for itself: SIGRTMIN is 34, SIGRTMAX 64
  __libc_current_sigrtmin: () => 34, __libc_current_sigrtmax: () => 64,
  sigaction: wrapped((_c, a) => exchangeAction(a, SIGACTION)),
  sigaction64: wrapped((_c, a) => exchangeAction(a, SIGACTION64)),
  // bionic's signal(): sigaction with SA_RESTART; SIG_ERR and EINVAL for SIGKILL, SIGSTOP or a bad number
  signal: (cpu, a) => {
    const sig = a.i(), fn = a.p(), prev = handlerAddress(sig);
    if (sig < 1 || sig > 64 || sig === SIGKILL || sig === SIGSTOP) return fail(cpu, E.INVAL);
    setDisposition(sig, fn, SA_RESTART, 0n);
    return prev;
  },
  pthread_kill: (c, a) => killThread(c, a.p(), a.i()),
  // the value is not carried
  pthread_sigqueue: (c, a) => killThread(c, a.p(), a.i()),
  raise: wrapped((cpu, a) => signalThread(cpu, a.i())),
  // the process leads its own group
  killpg: wrapped((cpu, a) => { const group = a.i(), sig = a.i(); return group < 0 ? -E.INVAL : group === 0 || group === cpu.pid ? signalThread(cpu, sig) : -E.SRCH; }),
  sigprocmask: (cpu, a) => { const e = cpu.sigmask(a.i(), a.p(), a.p(), 4); return e ? fail(cpu, e) : 0; },
  sigprocmask64: (cpu, a) => { const e = cpu.sigmask(a.i(), a.p(), a.p(), 8); return e ? fail(cpu, e) : 0; },
  sigpending: (cpu, a) => { mem.st32(a.p(), Number(sigset(...cpu.signals.keys()) & 0xffffffffn)); return 0; },
};
SIGNAL_LIBC.bsd_signal = SIGNAL_LIBC.signal;
for (const suffix of ["", "64"]) {
  // a sigset_t is a word, a sigset64_t the kernel's 8 bytes
  const setAt = (p: number): bigint => suffix ? mem.ld64(p) : BigInt(mem.ld32(p) >>> 0);
  // sigwait answers the error itself
  SIGNAL_LIBC["sigwait" + suffix] = (cpu, a) => {
    const set = setAt(a.p()), out = anchor(a.p());
    return complete(sigtimedwait(cpu, set, () => 0, -1), (sig) => { if (sig < 0) return -sig; mem.st32(out(), sig); return 0; });
  };
  SIGNAL_LIBC["sigwaitinfo" + suffix] = wrapped((cpu, a) => sigtimedwait(cpu, setAt(a.p()), anchor(a.p()), -1));
  SIGNAL_LIBC["sigtimedwait" + suffix] = wrapped((cpu, a) => { const set = setAt(a.p()), info = anchor(a.p()); return sigtimedwait(cpu, set, info, readTimeout(a.p())); });
  SIGNAL_LIBC["sigemptyset" + suffix] = (_c, a) => { mem.memset(a.p(), 0, suffix ? 8 : 4); return 0; };
  SIGNAL_LIBC["sigfillset" + suffix] = (_c, a) => { mem.memset(a.p(), 255, suffix ? 8 : 4); return 0; };
  for (const op of ["add", "del", "ismember"]) SIGNAL_LIBC[(op === "ismember" ? "sigismember" : "sig" + op + "set") + suffix] = (cpu, a) => {
    const p = a.p(), n = a.i() - 1;
    if (n < 0 || n >= (suffix ? 8 : 4) * 8) return fail(cpu, E.INVAL);
    const at = p + (n >> 3), bit = 1 << (n & 7);
    if (op === "ismember") return mem.u8[at] & bit ? 1 : 0;
    mem.st8(at, op === "add" ? mem.u8[at] | bit : mem.u8[at] & ~bit);
    return 0;
  };
}
