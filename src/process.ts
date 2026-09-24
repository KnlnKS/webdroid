import "./natives";
import { processBroker, connectProcess, processPresentation } from "./shell/processes";
import { bootApk, setScreenCanvas, tick, SCREEN_W, SCREEN_H, currentApp, pressBack, dispatchPointer } from "./shell/device";
import { loadSkiaText } from "./android/skia-text";
import { setProcessIdentity, recordVsync } from "./android/os";
import { attachIme, drainInput } from "./shell/input";
import { setWebLayer } from "./android/webkit";
import { parsePackageArchive, packageArchive } from "./android/packagearchive";
import { PackedArchive, packedArchives } from "./shell/packedarchive";
import { rt } from "./jvm/runtime";
import { overlays } from "./android/popup";
import { jitStats } from "./native/core";
import type { Install } from "./shell/install";
import { installedPath, registerPackage } from "./android/pm";
import { vfs } from "./jvm/natives/jio";
import { mountSystemCertificates } from "./shell/cacerts";
import { hexBytes, u8 } from "./jvm/abi";
import { configureJvmCoverage, jvmCoverage } from "./jvm/coverage";
import { perf } from "./perf";
import { mainDbg } from "./android/mainloop";
import { guestClockControl } from "./guest-clock";
import { nativeRequirements } from "./shell/diagnostics";
import { SYSTEM_FONTS, SYSTEM_EMOJI_FONTS } from "./android/graphics";

const params = new URLSearchParams(location.search), pid = Number(params.get("pid")), broker = processBroker();
jitStats.on = params.get("jit") !== "0";
configureJvmCoverage(params.get("fuzzCoverage") === "1");
const logs: string[] = [];
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  consoleError(...args);
  logs.push(`error: ${args.map(String).join(" ")}`);
};
window.addEventListener("error", (event) => logs.push(`window.error: ${event.message}`));
window.addEventListener("unhandledrejection", (event) => logs.push(`unhandledrejection: ${String(event.reason)}`));
const canvas = document.getElementById("screen") as HTMLCanvasElement;
canvas.width = SCREEN_W; canvas.height = SCREEN_H;
setScreenCanvas(canvas);
setWebLayer(document.getElementById("weblayer")!);
attachIme(canvas, document.getElementById("kbd") as HTMLTextAreaElement);
processPresentation.visible = false;
let frameId = 0, ticking = false, ticks = 0;
function frame(time: number): void {
  frameId = 0;
  if (!processPresentation.visible) return;
  drainInput();
  if (recordVsync(time) && !ticking) {
    ticks++;
    ticking = true;
    void tick().finally(() => { ticking = false; });
  }
  frameId = requestAnimationFrame(frame);
}
processPresentation.changed = (visible) => {
  if (visible && !frameId) frameId = requestAnimationFrame(frame);
  else if (!visible && frameId) { cancelAnimationFrame(frameId); frameId = 0; }
};
// the realm's share of the main page's `wd`: enough to see its stack and drive it from a probe
(globalThis as { wd?: unknown }).wd = { rt, app: () => currentApp(), jvmCoverage, overlays, perf, mainDbg, logs, guestClock: guestClockControl, nativeRequirements,
  get ticks() { return ticks; }, back: pressBack, testFrame: () => processPresentation.visible ? tick() : Promise.resolve(),
  tap: async (x: number, y: number) => { await dispatchPointer(0, x, y); await dispatchPointer(1, x, y); } };
window.addEventListener("pagehide", () => {
  guestClockControl.dispose();
  broker.fail(pid, "Process frame unloaded");
}, { once: true });
try {
  const data = await broker.bootstrap(pid);
  setProcessIdentity(pid, data.uid);
  const systemFonts = new Set<string>([...SYSTEM_FONTS, ...SYSTEM_EMOJI_FONTS].map(([family]) => family));
  for (const font of parent.document.fonts) {
    if (systemFonts.has(font.family.replace(/^"(.*)"$/, "$1"))) document.fonts.add(font);
  }
  mountSystemCertificates();
  let boot: Uint8Array | Install | null = null;
  for (const snapshot of data.registry) {
    const path = installedPath(snapshot.pkg), source = snapshot.source;
    let archive;
    if ("index" in source) {
      const packed = new PackedArchive(source.index, source.base, source);
      await packed.prepare(snapshot.pkg === data.pkg);
      archive = packageArchive(packed.zip, source.index.certificates.map(hexBytes));
      packedArchives.set(path, packed); vfs.mount(path, packed);
      if (snapshot.pkg === data.pkg) {
        boot = { zip: packed.zip, base: packed, lazyEntries: new Map(), splits: [] };
        rt.classpathSource = packed;
      }
    } else {
      const bytes = u8(source);
      archive = await parsePackageArchive(bytes); vfs.write(path, bytes);
      if (snapshot.pkg === data.pkg) boot = bytes;
    }
    const record = registerPackage(archive, path, snapshot.uid);
    record.system = snapshot.system;
    for (const grant of snapshot.grants) record.grants.add(grant);
    record.compatibilityCertificates = snapshot.signatures?.map((s) => u8(s)) ?? null;
  }
  const endpoint = connectProcess();
  if (!boot) throw new Error("Process package unavailable");
  await loadSkiaText();
  await bootApk(boot, () => {}, "", data.process);
  broker.ready(pid, endpoint);
} catch (error) {
  console.error("[process]", pid, error);
  broker.fail(pid, error instanceof Error ? error.message : String(error));
}
