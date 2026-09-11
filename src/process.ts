import "./natives";
import { processBroker, connectProcess, processPresentation } from "./shell/processes";
import { bootApk, setScreenCanvas, tick, SCREEN_W, SCREEN_H } from "./shell/device";
import { setProcessIdentity, recordVsync } from "./android/os";
import { attachIme, drainInput } from "./shell/input";
import { setWebLayer } from "./android/webkit";
import { parsePackageArchive, packageArchive } from "./android/packagearchive";
import { PackedArchive, packedArchives } from "./shell/packedarchive";
import { rt } from "./jvm/runtime";
import { jitStats } from "./native/core";
import type { Install } from "./shell/install";
import { installedPath, registerPackage } from "./android/pm";
import { vfs } from "./jvm/natives/jio";
import { mountSystemCertificates } from "./shell/cacerts";
import { hexBytes, u8 } from "./jvm/abi";

const params = new URLSearchParams(location.search), pid = Number(params.get("pid")), broker = processBroker();
rt.auditNatives = params.get("natcheck") === "1";
jitStats.on = params.get("jit") !== "0";
const canvas = document.getElementById("screen") as HTMLCanvasElement;
canvas.width = SCREEN_W; canvas.height = SCREEN_H;
setScreenCanvas(canvas);
setWebLayer(document.getElementById("weblayer")!);
attachIme(canvas, document.getElementById("kbd") as HTMLTextAreaElement);
processPresentation.visible = false;
let frameId = 0, ticking = false;
function frame(time: number): void {
  frameId = 0;
  if (!processPresentation.visible) return;
  recordVsync(time); drainInput();
  if (!ticking) {
    ticking = true;
    void tick().finally(() => { ticking = false; });
  }
  frameId = requestAnimationFrame(frame);
}
processPresentation.changed = (visible) => {
  if (visible && !frameId) frameId = requestAnimationFrame(frame);
  else if (!visible && frameId) { cancelAnimationFrame(frameId); frameId = 0; }
};
window.addEventListener("pagehide", () => broker.fail(pid, "Process frame unloaded"), { once: true });
try {
  const data = await broker.bootstrap(pid);
  setProcessIdentity(pid, data.uid);
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
  await bootApk(boot, () => {}, "", data.process);
  broker.ready(pid, endpoint);
} catch (error) {
  console.error("[process]", pid, error);
  broker.fail(pid, error instanceof Error ? error.message : String(error));
}
