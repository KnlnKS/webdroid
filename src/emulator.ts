// The emulator behind the shell (main.ts): its runtime, the system server it boots while the page waits for a package, and an app's launch.
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
import { startDisplayLoop } from "./android/vsync.ts";
import type { Shell } from "./shell/ui.ts";
import { openInstallLocal, openInstallRemote } from "./shell/install.ts";
import { activateLocalAssets, localAsset } from "./shell/localassets.ts";
import { provisionPackages, provisionServices } from "./shell/provision.ts";
import { processBroker } from "./shell/processes.ts";
import { displayRate } from "./shell/display-rate.ts";
import { bootSystemOwner, prepareWorkerInstall } from "./shell/system-boot.ts";
import { hasFocusedWindow } from "./android/server/wm.ts";
import { systemInputLayer } from "./shell/system-input.ts";
import { procIdentity } from "./shell/procfs.ts";
import { switchOn, switchValue } from "./switches.ts";
import { device } from "./shell/config.ts";

export type Emulator = ReturnType<typeof attach>;

/** starts the emulator behind `shell`'s page: what it loads ahead of a package, and how it opens one */
export function attach(shell: Shell) {
  const { canvas, kbd } = shell;
  setScreenCanvas(canvas);
  const systemInput = systemInputLayer(canvas, () => device);
  setDisplayChangeHandler(shell.resizeDisplay);

  void loadFramework();
  void platformJarBlobs();
  void loadTier().then(() => mark("tierLoaded"), () => {});
  // the next app's process loads its runtime while the page waits for a package to open, as a device's zygote waits forked
  processBroker().hosts.prestart();

  if (process.env.NODE_ENV !== "production") mountDiagnostics(document.querySelector<HTMLElement>("#side")!);

  navigator.serviceWorker?.addEventListener("message", (event: MessageEvent) => {
    if (event.data?.kind !== "webasset" || !event.ports[0]) return;
    const port = event.ports[0], path = event.data.path;
    void localAsset(path).then((reply) => { port.postMessage(reply); port.close(); }, () => { port.postMessage({ status: 500 }); port.close(); });
  });

  const back = async () => {
    if (hasFocusedWindow()) { await pressBack(); return; }
    const routed = processBroker().activities.back(procIdentity.pid);
    if (routed) await routed; else await pressBack();
  };

  let booting = false;
  // the page opens one app; reopening it starts a new process
  let runtimeStarted = false;
  async function boot(file: string, local?: File) {
    if (booting || runtimeStarted) return;
    booting = true;
    shell.setState({ kind: "loading", file, stage: local ? "open" : "download" });
    let rollbackAssets: (() => void) | undefined;
    try {
      mark("boot");
      void startZygote(displayRate());
      // the app's process needs only the package: the system realm waits for the page's tier itself
      const [install] = await Promise.all([local ? openInstallLocal(local) : openInstallRemote("/apks/" + encodeURIComponent(file)), provisionPackages(), loadSkia()]);
      const assets = local ? { key: crypto.randomUUID(), install } : null;
      if (local) {
        shell.setState({ kind: "loading", file, stage: "assets" });
        await navigator.serviceWorker.register("/webview-worker.js");
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
      }
      mark("installOpened");
      rollbackAssets = activateLocalAssets(assets);
      const t0 = performance.now();
      shell.setState({ kind: "loading", file, stage: "system" });
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
      // app again starts a new process for it while the other processes and the broker live on. The
      // task lives on in another of its processes that is on top once the activity changes the death
      // set off are done, as the one Chrome's restart starts in place of the one it killed.
      const follow = (pid: number, shown: Promise<void>): Promise<void> => {
        broker.watch(pid, death => void broker.activities.settled().then(() => {
          const top = broker.activities.foreground;
          if (broker.alive(top) && broker.entry(top).pkg === pkg) return follow(top, Promise.resolve());
          shell.setState({ kind: "exited", file, label, crashed: death.crashed, crashDialog: death.crashed && death.repeated, retry: launch });
        }));
        // it runs from its first frame, which a process that dies first settles too
        return shown.then(() => broker.presented(pid)).then(() => { if (broker.alive(pid)) shell.setState({ kind: "running", file, label }); })
          .catch(error => shell.setState({ kind: "failed", file, error, retry: launch }));
      };
      const launch = () => {
        shell.setState({ kind: "loading", file, stage: "attaching" });
        started = broker.launch(pkg, assets?.key ?? file, stage => shell.setState({ kind: "loading", file, stage }));
        return follow(started.pid, started.shown);
      };
      // the app's process is sent its package before the system realm's Java takes the page
      const firstFrame = launch();
      await Promise.all([started.shown.catch(() => {}), bootSystemOwner()]);
      perf.bootMs = performance.now() - t0;
      await firstFrame;
      // other packages' processes start once the app has shown its first frame
      void provisionServices({ attestationEnabled: switchOn("attestation", false) }).then(() => broker.boot()).catch(error => console.error("[provision]", error));
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
  installHarness(canvas, startDisplayLoop(true, drainPointers), { boot, back });

  attachIme(canvas, kbd, systemInput.element);
  attachKeyboard(kbd);

  mountSystemCertificates();
  mountPlatformData();
  // its fonts are among the platform data
  void loadSkia().catch(() => {});

  // system_server boots while the page waits for a package to open, as a device's does before any app launches. A page opened for
  // an app boots it once the app's process has its package: the page serves that process's code meanwhile.
  if (switchValue("apk") === undefined) {
    void startZygote(displayRate());
    void provisionPackages().then(bootSystemOwner).catch(() => {});
  }
  return { boot, back };
}
