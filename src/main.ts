// webdroid shell: phone chrome, launcher, boot + input wiring.
import "./natives.ts";
import { installHarness } from "./shell/harness.ts";
import { mountSystemCertificates } from "./shell/cacerts.ts";
import { mountPlatformData } from "./shell/apex.ts";

import { platformJarBlobs, loadFramework } from "./android/framework.ts";
import { loadSkia } from "./android/skia.ts";
import { startZygote, pressBack, setDisplayChangeHandler, setScreenCanvas } from "./shell/device.ts";
import { attachIme } from "./shell/input.ts";
import { attachKeyboard } from "./shell/keyboard-input.ts";
import { drainPointers } from "./shell/pointer-input.ts";
import { mark, perf } from "./perf.ts";
import { loadTier } from "./jvm/tier.ts";
import { jitStats } from "./native/core.ts";
import { mountDiagnostics } from "./shell/diagnostics.ts";
import { countVsyncs } from "./shell/worker-control.ts";
import { createShell } from "./shell/ui.ts";
import { openInstallLocal, openInstallRemote } from "./shell/install.ts";
import { activateLocalAssets, localAsset } from "./shell/localassets.ts";
import { provisionPackages, provisionServices } from "./shell/provision.ts";
import { processBroker } from "./shell/processes.ts";
import { displayRate } from "./shell/display-rate.ts";
import { device } from "./shell/config.ts";
import { bootSystemOwner, prepareWorkerInstall } from "./shell/system-boot.ts";
import { hasFocusedWindow } from "./android/server/wm.ts";
import { systemInputLayer } from "./shell/system-input.ts";
import { procIdentity } from "./shell/procfs.ts";
import { switchOn, switchValue } from "./switches.ts";

const back = async () => {
  if (hasFocusedWindow()) { await pressBack(); return; }
  const routed = processBroker().activities.back(procIdentity.pid);
  if (routed) await routed; else await pressBack();
};
const shell = createShell({ launch: (file, local) => { void boot(file, local); }, back: () => { void back(); } });
const { canvas, kbd } = shell;
setScreenCanvas(canvas);
const systemInput = systemInputLayer(canvas, () => device);
setDisplayChangeHandler(shell.resizeDisplay);

void loadFramework();
void platformJarBlobs();
void loadTier().then(() => mark("tierLoaded"), () => {});
// the next app's process loads its runtime while the page waits for a package to open, as a device's zygote waits forked
processBroker().hosts.prestart();

if (process.env.NODE_ENV !== "production") {
  mountDiagnostics(document.querySelector<HTMLElement>("#side")!);
  void fetch("/apks").then((r) => r.json() as Promise<string[]>).catch(() => [] as string[]).then((files) => {
    for (const file of files) shell.addPackage(file);
    const auto = switchValue("apk");
    if (auto && files.includes(auto)) void boot(auto);
  });
}

navigator.serviceWorker?.addEventListener("message", (event: MessageEvent) => {
  if (event.data?.kind !== "webasset" || !event.ports[0]) return;
  const port = event.ports[0], path = event.data.path;
  void localAsset(path).then((reply) => { port.postMessage(reply); port.close(); }, () => { port.postMessage({ status: 500 }); port.close(); });
});

let booting = false;
// the page opens one app; reopening it starts a new process
let runtimeStarted = false;
async function boot(file: string, local?: File) {
  if (booting || runtimeStarted) return;
  booting = true;
  shell.setState({ kind: "loading", file, stage: local ? "Opening package…" : "Downloading package…" });
  let rollbackAssets: (() => void) | undefined;
  try {
    mark("boot");
    void startZygote(displayRate());
    // the app's process needs only the package: the system realm waits for the page's tier itself
    const [install] = await Promise.all([local ? openInstallLocal(local) : openInstallRemote("/apks/" + encodeURIComponent(file)), provisionPackages(), loadSkia()]);
    const assets = local ? { key: crypto.randomUUID(), install } : null;
    if (local) {
      shell.setState({ kind: "loading", file, stage: "Preparing local app assets…" });
      await navigator.serviceWorker.register("/webview-worker.js");
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    }
    mark("installOpened");
    rollbackAssets = activateLocalAssets(assets);
    const t0 = performance.now();
    shell.setState({ kind: "loading", file, stage: "Starting system services…" });
    canvas.style.position = "relative";
    canvas.style.zIndex = "2147483647";
    canvas.style.background = "transparent";
    canvas.style.pointerEvents = "none";
    await displayRate();
    runtimeStarted = true;
    const { pkg, label } = await prepareWorkerInstall(install);
    const broker = processBroker();
    let started!: ReturnType<typeof broker.launch>;
    // the task goes with its process (ActivityRecord.handleAppDied removes an activity with no saved
    // state) and the launcher returns, under AppErrors' crash dialog when it showed one; opening the
    // app again starts a new process for it while the other processes and the broker live on
    const launch = () => {
      shell.setState({ kind: "loading", file, stage: "Starting app…" });
      started = broker.launch(pkg, assets?.key ?? file);
      broker.watch(started.pid, death => shell.setState({ kind: "exited", file, label, crashed: death.crashed,
        crashDialog: death.crashed && death.repeated, retry: launch }));
      return started.shown.then(() => { shell.setState({ kind: "running", file, label }); },
        error => { shell.setState({ kind: "failed", file, error, retry: launch }); });
    };
    // the app's process is sent its package before the system realm's Java takes the page
    await Promise.all([launch(), bootSystemOwner()]);
    perf.bootMs = performance.now() - t0;
    // other packages' processes start once the app has shown its first frame
    void broker.presented(started.pid).then(() => provisionServices({ attestationEnabled: switchOn("attestation", false) }))
      .then(() => broker.boot()).catch(error => console.error("[provision]", error));
  } catch (e) {
    rollbackAssets?.();
    console.error(e);
    shell.setState({ kind: "failed", file, error: e, retry: runtimeStarted ? null : () => { void boot(file, local); } });
  } finally {
    booting = false;
  }
}

// `?jit=0` runs the interpreter alone, to tell the tiers apart
jitStats.on = switchOn("jit", true);

// several fingers' moves and a wheel's synthetic drag drain once per display frame
installHarness(canvas, countVsyncs(drainPointers), { boot, back });

attachIme(canvas, kbd, systemInput.element);
attachKeyboard(kbd);

mountSystemCertificates();
mountPlatformData();

// system_server boots while the page waits for a package to open, as a device's does before any app launches. A page opened for
// an app boots it once the app's process has its package: the page serves that process's code meanwhile.
if (switchValue("apk") === undefined) {
  void startZygote(displayRate());
  void provisionPackages().then(bootSystemOwner).catch(() => {});
}
