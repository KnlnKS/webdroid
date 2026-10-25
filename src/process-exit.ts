// The end of this realm's process. The kernel's do_group_exit takes every thread at once; here a
// dead realm runs nothing further: native run loops park at their next turn, suspended Java frames
// never resume, and yields, guest timers and entries from host code never return.

/** how the process ended, as wait(2) tells it: an exit status, or the signal that killed it (with
 *  debuggerd's tombstone when it crashed) */
export type ExitStatus = { code: number; signal?: undefined } | { signal: number; code?: undefined; tombstone?: Uint8Array };
let status: ExitStatus | null = null;
const listeners: ((status: ExitStatus) => void)[] = [];
export const processExited = (): boolean => status !== null;
/** what anything that would run on in a dead process waits for */
export const never = (): Promise<never> => new Promise<never>(() => {});
/** run `f` once when the process ends (the broker's death notice, the shell's display) */
export function onProcessExit(f: (status: ExitStatus) => void): void { listeners.push(f); }
/** abort(3) where no guest thread takes the SIGABRT: logged as debuggerd heads its report, and the process dies of it */
export function abortProcess(pid: number, message: string): void {
  if (status) return;
  console.error(`Fatal signal 6 (SIGABRT), pid ${pid}\nAbort message: '${message}'`);
  exitProcess({ signal: 6 });
}
export function exitProcess(how: ExitStatus): void {
  if (status) return;
  status = how;
  for (const f of listeners) {
    try { f(how); } catch (error) { console.error("[process exit]", error); }
  }
}
