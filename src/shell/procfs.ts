import { device } from "./config";

export const procIdentity = { pid: 1000, uid: 10001, name: "" };
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
export const SYSCONF: Record<string, [number, () => number]> = {
  _SC_CLK_TCK: [0x06, () => 100], _SC_OPEN_MAX: [0x0b, () => 32768],
  _SC_PAGESIZE: [0x27, () => 4096], _SC_PAGE_SIZE: [0x28, () => 4096],
  _SC_NPROCESSORS_CONF: [0x60, () => device.cpu.cores], _SC_NPROCESSORS_ONLN: [0x61, () => device.cpu.cores],
  _SC_PHYS_PAGES: [0x62, () => device.cpu.memKb / 4], _SC_AVPHYS_PAGES: [0x63, () => device.cpu.memKb / 8],
};
const sysconfByName = new Map(Object.values(SYSCONF));
export function sysconf(name: number): number { return sysconfByName.get(name)?.() ?? -1; }

const cpuList = () => device.cpu.cores === 1 ? "0\n" : `0-${device.cpu.cores - 1}\n`;

export function procText(path: string): string | null {
  if (!path.startsWith("/proc/") && !path.startsWith("/sys/")) return null;
  if (path === "/proc/cpuinfo") {
    let text = "";
    for (let i = 0; i < device.cpu.cores; i++) {
      text += `processor\t: ${i}\nmodel name\t: ARMv7 Processor rev 0 (v7l)\nBogoMIPS\t: 38.40\nFeatures\t: ${device.cpu.features}\nCPU implementer\t: 0x41\nCPU architecture: 7\nCPU variant\t: 0x0\nCPU part\t: 0xc07\nCPU revision\t: 0\n\n`;
    }
    return text + `Hardware\t: ${device.cpu.hardware}\nRevision\t: 0000\nSerial\t\t: 0000000000000000\n`;
  }
  if (path === "/sys/devices/system/cpu/present" || path === "/sys/devices/system/cpu/possible" || path === "/sys/devices/system/cpu/online") return cpuList();
  if (path === "/proc/meminfo") return `MemTotal:        ${device.cpu.memKb} kB\nMemFree:         ${device.cpu.memKb >> 1} kB\nBuffers:               0 kB\nCached:                0 kB\n`;
  if (path === "/proc/self/maps") return "";
  if (path === "/proc/self/cmdline" || path === `/proc/${procIdentity.pid}/cmdline`) return procIdentity.name + "\0";
  if (path === "/proc/self/status" || path === `/proc/${procIdentity.pid}/status`) {
    const { pid, uid, name } = procIdentity;
    return `Name:\t${(name || "app_process").slice(0, 15)}\nState:\tR (running)\nTgid:\t${pid}\nPid:\t${pid}\nPPid:\t1\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${uid}\t${uid}\t${uid}\t${uid}\nCpus_allowed_list:\t${cpuList().trim()}\n`;
  }
  return null;
}
