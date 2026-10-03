// AppExitInfoTracker: why each process of a package ended, as getHistoricalProcessExitReasons
// answers it, kept per package across reloads (the tracker persists its records too). AppErrors'
// part of a crash is here as well: the crash is logged and notes the reason the process's death
// will carry, and a crash within MIN_CRASH_INTERVAL of the process's last one repeats, which shows
// the crash dialog (a first crash shows none).
import { onProcessExit, type ExitStatus } from "../../process-exit";
import { PROCESS_NAME, PROCESS_PID, PROCESS_UID } from "../os";
import { appHost } from "../apphost";
import { wallMillis } from "../../guest-clock";
import { foreground } from "./atm";
import { logLine } from "../../native/libc";
import { storedPackages } from "../packages";
import type { PackageState } from "../../shell/packagedata";

export const REASON_EXIT_SELF = 1, REASON_SIGNALED = 2, REASON_CRASH = 4, REASON_CRASH_NATIVE = 5, REASON_USER_REQUESTED = 10;
export type ExitRecord = {
  pid: number; uid: number; process: string; pkg: string; reason: number; status: number; importance: number; timestamp: number;
  description: string | null; state: string | null; tombstone: string | null;
  /** AppErrors showed the crash dialog: the process had crashed within MIN_CRASH_INTERVAL */
  dialog: boolean;
};
/** how a process ended, as the broker and the shell tell it: whether it crashed, and whether
 *  AppErrors found it crashed within MIN_CRASH_INTERVAL of its last crash */
export type Death = { crashed: boolean; repeated: boolean };
export const deathOf = (record: ExitRecord | null): Death =>
  ({ crashed: record?.reason === REASON_CRASH || record?.reason === REASON_CRASH_NATIVE, repeated: !!record?.dialog });
export const NOT_CRASHED = deathOf(null);
/** AppExitInfoTracker's history per package */
const HISTORY = 16;
/** ActivityManagerConstants.MIN_CRASH_INTERVAL */
const MIN_CRASH_INTERVAL_MS = 2 * 60_000;
const IMPORTANCE_FOREGROUND = 100, IMPORTANCE_CACHED = 400;
const PREFIX = "wd:exit-info:", storageKey = (pkg: string) => PREFIX + pkg;
const base64 = (bytes: Uint8Array): string => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
export const unbase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** the packages with records, which AppExitInfoTracker.onPackageRemoved drops */
export const exitRecordData: PackageState = {
  remove(pkg) { try { globalThis.localStorage?.removeItem(storageKey(pkg)); } catch { /* storage can be unavailable */ } },
  packages: () => storedPackages(PREFIX),
};
/** a package's records, newest first */
export function exitRecords(pkg: string): ExitRecord[] {
  try {
    const saved: unknown = JSON.parse(globalThis.localStorage?.getItem(storageKey(pkg)) ?? "[]");
    return Array.isArray(saved) ? saved as ExitRecord[] : [];
  } catch { return []; }
}
function save(record: ExitRecord): void {
  try { globalThis.localStorage?.setItem(storageKey(record.pkg), JSON.stringify([record, ...exitRecords(record.pkg)].slice(0, HISTORY))); }
  catch (error) { console.warn("[AppExitInfoTracker] not persisted", error); }
}

const processName = () => PROCESS_NAME || appHost?.pkg || "";
/** the reason a kill noted, which the process's death then carries (ProcessList.noteAppKill) */
let noted: { reason: number; description: string; dialog: boolean } | null = null;
/** IActivityManager.setProcessStateSummary's bytes, recorded with the exit */
let stateSummary: Uint8Array | null = null;
/** the reason the system killed this process with (ProcessList.noteAppKill) */
export type KillNote = { reason: number; description: string };
export function noteAppKill(note: KillNote): void { noted ??= { ...note, dialog: false }; }
export function setProcessStateSummary(state: Uint8Array | null): void { stateSummary = state && state.slice(); }

/** the bound application's ApplicationInfo.flags, which am_crash records (-1 with none bound) */
let appFlags = -1;
export function noteApplicationFlags(flags: number): void { appFlags = flags; }
export type CrashInfo = { exceptionClassName: string | null; exceptionMessage: string | null; throwFileName: string | null; throwLineNumber: number };
/** AppErrors.crashApplicationInner for this process: logged as am_crash, its death noted as a crash,
 *  and the dialog policy run (AppErrors.handleAppCrashLocked and handleShowAppErrorUi) */
export function appCrashed(info: CrashInfo, native: boolean): void {
  if (noted) return;
  const process = processName(), now = wallMillis();
  logLine(4, "am_crash", `[${PROCESS_PID},0,${process},${appFlags},${info.exceptionClassName ?? ""},${info.exceptionMessage ?? ""},${info.throwFileName ?? ""},${info.throwLineNumber},0]`);
  const last = exitRecords(appHost?.pkg ?? process).find((r) => r.process === process && (r.reason === REASON_CRASH || r.reason === REASON_CRASH_NATIVE));
  // Settings' show_first_crash_dialog (and its developer option) would show one for a first crash
  // too; only the shell or adb could set them
  const dialog = !!last && now - last.timestamp < MIN_CRASH_INTERVAL_MS;
  noted = { reason: native ? REASON_CRASH_NATIVE : REASON_CRASH, description: "crash", dialog };
}
/** strsignal(3), which NativeCrashListener reports as the exception message */
const SIGNAL_TEXT: Record<number, string> = { 3: "Quit", 4: "Illegal instruction", 5: "Trace/breakpoint trap", 6: "Aborted", 7: "Bus error",
  8: "Floating point exception", 11: "Segmentation fault", 24: "CPU time limit exceeded", 25: "File size limit exceeded", 31: "Bad system call" };

/** this process's record, once it has ended */
export let lastExit: ExitRecord | null = null;
function recordExit(status: ExitStatus): void {
  // debuggerd reports a crash dump to the activity manager (NativeCrashListener) as a native crash
  if (status.signal !== undefined && status.tombstone) appCrashed({ exceptionClassName: "Native crash", exceptionMessage: SIGNAL_TEXT[status.signal] ?? `Signal ${status.signal}`, throwFileName: "unknown", throwLineNumber: 0 }, true);
  const reason = noted?.reason ?? (status.code !== undefined ? REASON_EXIT_SELF : REASON_SIGNALED);
  save(lastExit = {
    pid: PROCESS_PID, uid: PROCESS_UID, process: processName(), pkg: appHost?.pkg ?? processName(), reason,
    // a Java crash keeps no status; the others carry the exit code or the signal
    status: reason === REASON_CRASH ? 0 : status.code ?? status.signal,
    importance: foreground() ? IMPORTANCE_FOREGROUND : IMPORTANCE_CACHED, timestamp: wallMillis(),
    description: noted?.description ?? null, state: stateSummary && base64(stateSummary),
    tombstone: status.signal !== undefined && status.tombstone ? base64(status.tombstone) : null, dialog: noted?.dialog ?? false,
  });
}
onProcessExit(recordExit);
