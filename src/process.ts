import "./natives";
import { processBroker, connectProcess, processPresentation } from "./shell/processes";
import { bootApk, startZygote, setScreenCanvas, testFrame, SCREEN_W, SCREEN_H, pressBack, dispatchPointer } from "./shell/device";
import { loadSkia } from "./android/skia";
import { setProcessIdentity } from "./android/os";
import { recordVsync } from "./android/vsync";
import { attachIme, drainInput } from "./shell/input";
import { setWebLayer } from "./android/webkit";
import { apkCertificates, packageArchive } from "./android/packagearchive";
import { zipTree } from "./jvm/natives/jzip";
import { PackedArchive, packedArchives } from "./shell/packedarchive";
import { rt } from "./jvm/runtime";
import { strictThreadOwnership } from "./jvm/natives/jlang";
import { setBackgroundRealm } from "./jvm/yield";
import { jitStats } from "./native/core";
import { openInstallApks, type Install } from "./shell/install";
import type { FileSource } from "./shell/lazyfile";
import { installedPath, registerPackage } from "./android/pm";
import { vfs } from "./shell/vfs";
import { mountSystemCertificates } from "./shell/cacerts";
import { dumpWindows } from "./shell/uiautomator";
import { mountPlatformData } from "./shell/apex";
import { hexBytes, u8 } from "./jvm/abi";
import { configureJvmCoverage, jvmCoverage } from "./jvm/coverage";
import { perf } from "./perf";
import { mainDbg, onMain } from "./android/mainloop";
import { guestClockControl } from "./guest-clock";
import { nativeRequirements } from "./shell/diagnostics";
import { native } from "./native/debug";
import { appHost } from "./android/apphost";

strictThreadOwnership();
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
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason as { message?: string; msg?: string; stack?: string } | null;
  logs.push(`unhandledrejection: ${reason?.message ?? reason?.msg ?? String(reason)}\n${(reason?.stack ?? "").slice(0, 600)}`);
});
const canvas = document.getElementById("screen") as HTMLCanvasElement;
canvas.width = SCREEN_W; canvas.height = SCREEN_H;
setScreenCanvas(canvas);
setWebLayer(document.getElementById("weblayer")!);
attachIme(canvas, document.getElementById("kbd") as HTMLTextAreaElement);
processPresentation.visible = false;
setBackgroundRealm(() => !processPresentation.visible && !broker.servesForeground(pid));
let frameId = 0, ticks = 0;
function frame(time: number): void {
  frameId = 0;
  if (!processPresentation.visible) return;
  drainInput();
  if (recordVsync(time)) ticks++;
  frameId = requestAnimationFrame(frame);
}
processPresentation.changed = (visible) => {
  if (visible && !frameId) frameId = requestAnimationFrame(frame);
  else if (!visible && frameId) { cancelAnimationFrame(frameId); frameId = 0; }
};
// the realm's share of the main page's `wd`: enough to see its app and drive it from a probe
(globalThis as { wd?: unknown }).wd = { rt, app: () => appHost, jvmCoverage, perf, mainDbg, logs, guestClock: guestClockControl, nativeRequirements, native,
  get ticks() { return ticks; }, back: pressBack, uiTree: () => onMain(dumpWindows), testFrame: () => processPresentation.visible ? testFrame() : Promise.resolve(),
  tap: async (x: number, y: number) => { await dispatchPointer(0, x, y); await dispatchPointer(1, x, y); } };
window.addEventListener("pagehide", () => {
  guestClockControl.dispose();
  broker.fail(pid, "Process frame unloaded");
}, { once: true });
try {
  mountPlatformData();
  void startZygote();
  const data = await broker.bootstrap(pid);
  setProcessIdentity(pid, data.uid);
  mountSystemCertificates();
  let boot: Install | null = null;
  for (const snapshot of data.registry) {
    const path = installedPath(snapshot.pkg), source = snapshot.source, own = snapshot.pkg === data.pkg;
    let archive, base: Pick<Install, "zip" | "base">;
    if ("index" in source) {
      const packed = new PackedArchive(source.index, source.base, source);
      await packed.prepare(own);
      archive = packageArchive(packed.zip, source.index.certificates.map(hexBytes));
      packedArchives.set(path, packed); vfs.mount(path, packed);
      if (own) rt.classpathSource = packed;
      base = { zip: packed.zip, base: packed };
    } else {
      const bytes = u8(source), zip = zipTree(bytes);
      archive = packageArchive(zip, await apkCertificates(bytes, zip)); vfs.write(path, bytes);
      base = { zip, base: bytes };
    }
    // splits carry their native libraries and config resources; their reads return the parent realm's arrays
    if (own) boot = await openInstallApks(snapshot.splits.map((split): FileSource => ({ size: split.size, read: async (offset, length) => u8(await split.read(offset, length)) })), base);
    const record = registerPackage(archive, path, snapshot.uid);
    record.system = snapshot.system;
    for (const grant of snapshot.grants) record.grants.add(grant);
    record.compatibilityCertificates = snapshot.signatures?.map((s) => u8(s)) ?? null;
  }
  const endpoint = connectProcess();
  if (!boot) throw new Error("Process package unavailable");
  await loadSkia();
  await bootApk(boot, () => {}, "", data.process);
  broker.ready(pid, endpoint);
} catch (error) {
  console.error("[process]", pid, error);
  broker.fail(pid, error instanceof Error ? error.message : String(error));
}
