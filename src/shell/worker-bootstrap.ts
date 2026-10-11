import { guestClockControl } from "../guest-clock";
import { closeProcessBootstrap, type ProcessBootstrap } from "./process-bootstrap-data";
import type { BrokerCalls } from "./processes";

/** The Worker attached its clock and loaded natives before this bootstrap arrived. */
export async function attachWorkerBootstrap(data: ProcessBootstrap): Promise<BrokerCalls> {
  let closeDisplay = () => {}, closeIme = () => {}, closeWeb = () => {};
  try {
    if (!data.broker) throw new Error("Worker bootstrap is missing command capabilities");
    const { setProcessIdentity, setProcessName } = await import("../android/os");
    setProcessIdentity(data.pid, data.uid);
    setProcessName(data.process);
    const { attachProcessBrokerPort, closeProcessBrokerPort } = await import("./process-endpoint");
    const broker = attachProcessBrokerPort(data.broker);
    if (data.display) {
      const {sendFrames} = await import("./frame-port");
      const {setScreenSink} = await import("./device");
      const display = sendFrames(data.display);closeDisplay = display.close;
      setScreenSink(bitmap => display.present(bitmap));
    }
    if (data.ime) closeIme = await (await import("./ime-port")).serveIme(data.ime);
    if (data.web) {
      const surfaces = (await import("./web-surface-port")).sendWebSurfaces(data.web);
      const {useWebSurfaces} = await import("../android/webframes");
      useWebSurfaces(surfaces.create);
      closeWeb = () => { useWebSurfaces(null); surfaces.close(); };
    }
    const { onProcessExit } = await import("../process-exit");
    // AppExitInfoTracker publishes the real record first, then these received owners close.
    onProcessExit(() => { closeWeb(); closeIme(); closeDisplay(); guestClockControl.dispose(); closeProcessBrokerPort(); closeProcessBootstrap(data); });
    return broker;
  } catch (error) {
    closeWeb(); closeIme(); closeDisplay();
    guestClockControl.dispose();
    closeProcessBootstrap(data);
    throw error;
  }
}


/** Publish only after package/JVM boot; transfer the peer port to the page's readyPort owner. */
export async function serveWorkerEndpoint(port: MessagePort): Promise<() => void> {
  try {
    const { createProcessEndpoint } = await import("./process-endpoint");
    const { serveProcess } = await import("./process-port");
    return serveProcess(port, createProcessEndpoint());
  } catch (error) {
    try { port.postMessage({kind:"close"}); } catch { /* startup may have detached the unpublished port */ }
    port.close();
    throw error;
  }
}
