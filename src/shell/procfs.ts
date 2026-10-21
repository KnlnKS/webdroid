import { device } from "./config.ts";
import { DEVICE_PROPERTIES, UNAME } from "./device-properties.ts";

/** the process's identity: name is what the activity manager knows it by, argv0 its command line, which
 *  Process.setArgV0 changes */
export const procIdentity = { pid: 1000, uid: 10001, name: "", argv0: "" };
/** uname(2): the reference kernel's, whose machine is what an arm64 kernel reports a 64-bit or a compat task */
export const uname = (wide: boolean) => ({ ...UNAME, machine: wide ? "aarch64" : "armv8l" });
/** bionic's passwd name for a uid: u<user>_a<app> for application ids, root and system by name, else the number. */
export function appUserName(uid: number): string {
  const appId = uid % 100000;
  return appId >= 10000 && appId < 20000 ? `u${Math.floor(uid / 100000)}_a${appId - 10000}` : uid === 0 ? "root" : uid === 1000 ? "system" : String(uid);
}
const threadOffsets = new WeakMap<object, number>();
let nextThreadOffset = 0;

export function processTid(thread: object, main: boolean): number {
  if (main) return procIdentity.pid;
  let offset = threadOffsets.get(thread);
  if (offset === undefined) threadOffsets.set(thread, (offset = ++nextThreadOffset));
  return procIdentity.pid + offset;
}

/** The sysconf names this device answers, by Bionic's number (bits/sysconf.h); the rest are -1.
 *  AVPHYS_PAGES agrees with /proc/meminfo's MemFree, and CLK_TCK is the kernel's USER_HZ. */
const SYSCONF: Record<string, [number, () => number]> = {
  _SC_CLK_TCK: [0x06, () => 100], _SC_OPEN_MAX: [0x0b, () => 32768],
  _SC_PAGESIZE: [0x27, () => 4096], _SC_PAGE_SIZE: [0x28, () => 4096],
  _SC_NPROCESSORS_CONF: [0x60, () => device.cpu.cores], _SC_NPROCESSORS_ONLN: [0x61, () => device.cpu.cores],
  _SC_PHYS_PAGES: [0x62, () => device.cpu.memKb / 4], _SC_AVPHYS_PAGES: [0x63, () => device.cpu.memKb / 8],
};
const sysconfByName = new Map(Object.values(SYSCONF));
export function sysconf(name: number): number { return sysconfByName.get(name)?.() ?? -1; }

/** the guest's memory as /proc reports it, which the native tier assigns: its resident size, the
 *  maps lines of its images and thread stacks, and the main thread's initial stack pointer */
export const procMemory = { resident: (): number => 0, maps: (): string => "", startStack: (): number => 0 };
const comm = () => (procIdentity.argv0 || "app_process").slice(0, 15);
/** proc(5)'s stat line; CPU time is wall time since page load in USER_HZ (100) ticks */
function statLine(id: number): string {
  const ticks = Math.floor(performance.now() / 10), bytes = procMemory.resident();
  return `${id} (${taskComm(id)}) R 1 ${procIdentity.pid} 0 0 -1 4194560 0 0 0 0 ${ticks} 0 0 0 20 0 1 0 0 ${bytes} ${Math.ceil(bytes / 4096)} ` +
    `18446744073709551615 0 0 ${procMemory.startStack()} 0 0 0 0 4612 0 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`;
}
const cpuList = () => device.cpu.cores === 1 ? "0\n" : `0-${device.cpu.cores - 1}\n`;

/** the process's live threads by tid, what /proc/self/task lists, and their native names, which the Wasm tier's entry assigns (src/wasm/host/entry.ts) */
export const procTasks = { tids: (): number[] => [procIdentity.pid], name: (_tid: number): string | null => null, rename: (_tid: number, _name: string): boolean => false };
const TASK = /^\/proc\/(?:self|thread-self|(\d+))(?:\/task\/(\d+))?\/(\w+)$/;
/** a task's comm: the main thread's is the process's, another's its own name, as prctl(PR_SET_NAME) leaves it */
const taskComm = (id: number) => (id === procIdentity.pid ? null : procTasks.name(id))?.slice(0, 15) ?? comm();
/** the task a /proc comm path names: writing it renames the task, as pthread_setname_np does for
 *  another thread; no other /proc file is writable */
function commTask(path: string): number | null {
  const own = TASK.exec(path);
  return own && own[3] === "comm" && (!own[1] || +own[1] === procIdentity.pid) ? own[2] ? +own[2] : procIdentity.pid : null;
}
export const procWritable = (path: string): boolean => commTask(path) !== null;
export function procWrite(path: string, text: string): boolean {
  const tid = commTask(path);
  return tid !== null && procTasks.rename(tid, text.replace(/\n$/, "").slice(0, 15));
}
/** a /proc directory's entries: the process's own, its task/ and each task's; null for any other path */
export function procList(path: string): string[] | null {
  const m = /^\/proc\/(?:self|thread-self|(\d+))(\/task(?:\/(\d+))?)?$/.exec(path);
  if (!m || m[1] && +m[1] !== procIdentity.pid) return null;
  if (!m[2]) return ["task", "cmdline", "comm", "maps", "stat", "statm", "status"];
  if (m[3] === undefined) return procTasks.tids().map(String);
  return procTasks.tids().includes(+m[3]) ? ["comm", "stat", "status"] : null;
}

export function procText(path: string): string | null {
  if (!path.startsWith("/proc/") && !path.startsWith("/sys/")) return null;
  if (path === "/proc/cpuinfo") {
    let text = "";
    for (let i = 0; i < device.cpu.cores; i++) {
      text += `processor\t: ${i}\nmodel name\t: ARMv7 Processor rev 0 (v7l)\nBogoMIPS\t: 38.40\nFeatures\t: ${device.cpu.features}\nCPU implementer\t: 0x41\nCPU architecture: 7\nCPU variant\t: 0x0\nCPU part\t: 0xc07\nCPU revision\t: 0\n\n`;
    }
    return text + `Hardware\t: ${DEVICE_PROPERTIES["ro.hardware"]}\nRevision\t: 0000\nSerial\t\t: 0000000000000000\n`;
  }
  if (path === "/sys/devices/system/cpu/present" || path === "/sys/devices/system/cpu/possible" || path === "/sys/devices/system/cpu/online") return cpuList();
  if (path === "/proc/meminfo") return `MemTotal:        ${device.cpu.memKb} kB\nMemFree:         ${device.cpu.memKb >> 1} kB\nBuffers:               0 kB\nCached:                0 kB\n`;
  // /proc/self, /proc/thread-self and /proc/<own pid>, each optionally narrowed to task/<tid>
  const own = TASK.exec(path);
  if (!own || own[1] && +own[1] !== procIdentity.pid) return null;
  const id = own[2] ? +own[2] : procIdentity.pid;
  switch (own[3]) {
    case "maps": case "smaps": return procMemory.maps();
    case "cmdline": return procIdentity.argv0 + "\0";
    case "comm": return taskComm(id) + "\n";
    case "stat": return statLine(id);
    case "statm": { const pages = Math.ceil(procMemory.resident() / 4096); return `${pages} ${pages} 0 0 0 ${pages} 0\n`; }
    case "status": {
      const { pid, uid } = procIdentity, kb = procMemory.resident() >> 10;
      return `Name:\t${taskComm(id)}\nState:\tR (running)\nTgid:\t${pid}\nPid:\t${id}\nPPid:\t1\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${uid}\t${uid}\t${uid}\t${uid}\n` +
        `VmPeak:\t${kb} kB\nVmSize:\t${kb} kB\nVmHWM:\t${kb} kB\nVmRSS:\t${kb} kB\nThreads:\t1\nCpus_allowed_list:\t${cpuList().trim()}\n`;
    }
  }
  return null;
}
