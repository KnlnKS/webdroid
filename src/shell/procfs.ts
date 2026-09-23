import { device } from "./config";

export const procIdentity = { pid: 1000, name: "" };
const threadOffsets = new WeakMap<object, number>();
let nextThreadOffset = 0;

export function processTid(thread: object, main: boolean): number {
  if (main) return procIdentity.pid;
  let offset = threadOffsets.get(thread);
  if (offset === undefined) threadOffsets.set(thread, (offset = ++nextThreadOffset));
  return procIdentity.pid + offset;
}

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
  return null;
}
