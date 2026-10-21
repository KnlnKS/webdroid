// How the process ends: exit_group(2), or a signal nothing handles. A signal that dumps core is
// logged as debuggerd's handler logs it (the "Fatal signal" line, the tombstone's head and
// backtrace, the abort message) and leaves debuggerd's tombstone (tombstone.ts) for the exit
// status; the handler debuggerd_init installs reaches the same report.

import { defineHost } from "./host.ts";
import type { Cpu } from "./cpu.ts";
import { backtrace, backtracePcs, tombstoneFrame } from "./dl.ts";
import { tombstoneProto, signalCodeName } from "./tombstone.ts";
import { SIGNAL_NAMES, SIGILL, SIGTRAP, SIGABRT, SIGBUS, SIGFPE, SIGSEGV, SIGSTKFLT, SIGSYS, SA_SIGINFO, SA_ONSTACK, SA_RESTART, dispositions, dumpsCore, sigHandler } from "./signals.ts";
import { loadContext, readSiginfo, type SigInfo } from "./sigframe.ts";
import { propertyValue } from "../shell/properties.ts";
import { procIdentity } from "../shell/procfs.ts";
import { wallMillis } from "../guest-clock.ts";
import { exitProcess, never, processExited } from "../process-exit.ts";

/** exit_group(2): the process ends with `code`, and the calling thread never returns */
export function exitGroup(cpu: Cpu, code: number, how: string): Promise<never> {
  console.warn(`[native] ${how}(${code}) from ${cpu.name} lr=${(cpu.lr >>> 0).toString(16)}`);
  exitProcess({ code: code & 0xff });
  cpu.finished = true;
  return never();
}

/** android_set_abort_message's text: the HLE's own, or what a guest libc keeps (bionic.ts) */
let abortMessage: string | (() => string) = "";
export function setAbortMessage(message: string | (() => string)): void { abortMessage = message; }

/** A terminating signal nothing handles: the process ends as exit_group ends it, every thread
 *  parking at its next turn. */
export function dieOfSignal(cpu: Cpu, sig: number, info: SigInfo | null = null): Promise<never> {
  if (!processExited()) {
    const name = SIGNAL_NAMES[sig] ?? "?", process = `pid ${cpu.pid} (${procIdentity.argv0})`, code = info ? `, code ${info.code}` : "";
    let report: Uint8Array | undefined;
    if (dumpsCore(sig)) {
      const abort = typeof abortMessage === "string" ? abortMessage : abortMessage();
      report = tombstone(cpu, sig, info, abort);
      console.error([`Fatal signal ${sig} (${name})${code} in tid ${cpu.osTid} (${cpu.name}), ${process}`,
        "*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***",
        `pid: ${cpu.pid}, tid: ${cpu.osTid}, name: ${cpu.name}  >>> ${procIdentity.argv0} <<<`,
        `signal ${sig} (${name})${code}, fault addr ${info ? "0x" + info.addr.toString(16) : "--------"}`,
        ...(abort ? [`Abort message: '${abort}'`] : []),
        "backtrace:", ...backtrace(cpu).map((frame, i) => `  #${String(i).padStart(2, "0")} ${frame}`)].join("\n"));
    } else console.warn(`[native] ${process} killed by signal ${sig} (${name})`);
    exitProcess({ signal: sig, tombstone: report });
  }
  return never();
}

const REGS32 = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11", "ip", "sp", "lr"];
/** debuggerd's tombstone of the crashing thread: its registers and its frame-pointer chain */
function tombstone(cpu: Cpu, sig: number, info: SigInfo | null, abort: string): Uint8Array {
  const reg = (i: number) => (cpu.a64 ? BigInt(cpu.w[2 * i + 1] >>> 0) << 32n : 0n) | BigInt(cpu.w[2 * i] >>> 0);
  const names = cpu.a64 ? [...Array(29)].map((_, i) => `x${i}`).concat(["x29", "lr", "sp"]) : REGS32;
  return tombstoneProto({
    a64: cpu.a64, fingerprint: propertyValue("ro.build.fingerprint") ?? "", timestamp: wallMillis(), pid: cpu.pid, tid: cpu.osTid,
    uid: procIdentity.uid, command: procIdentity.argv0, uptimeS: performance.now() / 1000,
    signal: sig, signalName: SIGNAL_NAMES[sig] ?? "", code: info?.code ?? 0, codeName: signalCodeName(sig, info?.code ?? 0),
    faultAddress: info?.addr ?? null, abort, threadName: cpu.name,
    registers: [...names.map((name, i): [string, bigint] => [name, reg(i)]), ["pc", BigInt(cpu.pc >>> 0)]],
    frames: backtracePcs(cpu).map(tombstoneFrame),
  });
}

/** debuggerd_init's handler, which the linker installs in every process for the signals that dump
 *  core: a runtime chaining to the handler it replaced (libunity's, sigchain's, a crash reporter's)
 *  reaches it. It logs the tombstone and the process dies of the signal, as crash_dump and the
 *  re-raise after it end it. */
let debuggerdHandler = 0;
export function installDebuggerdHandlers(): void {
  debuggerdHandler ||= defineHost("debuggerd_signal_handler", (cpu, a) => {
    const sig = a.i(), info = a.p(), context = a.p();
    // the tombstone describes the interrupted state, which this thread never returns to
    if (context) loadContext(cpu, context);
    return dieOfSignal(cpu, sig, info ? readSiginfo(info) : null);
  });
  // every signal blocked while it runs
  for (const sig of [SIGILL, SIGTRAP, SIGABRT, SIGBUS, SIGFPE, SIGSEGV, SIGSTKFLT, SIGSYS])
    if (!dispositions.has(sig)) dispositions.set(sig, sigHandler(debuggerdHandler, SA_SIGINFO | SA_ONSTACK | SA_RESTART, ~0n));
}
