import { guestClockControl } from "../guest-clock";
import { closeProcessBootstrap, type ProcessBootstrap } from "./process-bootstrap-data";
import type { BrokerCalls } from "./processes";

/** The Worker attached its clock and loaded natives before this bootstrap arrived. */
export async function attachWorkerBootstrap(data: ProcessBootstrap): Promise<BrokerCalls> {
  let closeDisplay = () => {}, closeIme = () => {}, closeWeb = () => {};
  const release = () => { closeWeb(); closeIme(); closeDisplay(); guestClockControl.dispose(); };
  try {
    const { setProcessIdentity, setProcessName } = await import("../android/os");
    setProcessIdentity(data.pid, data.uid);
    setProcessName(data.process);
    const { attachProcessBrokerPort, closeProcessBrokerPort } = await import("./process-endpoint");
    const broker = attachProcessBrokerPort(data.broker);
    (await import("./device-storage")).useStorageReplica(data.storage, broker.storageWrite);
    const {sendFrames} = await import("./frame-port");
    const {setScreenSink} = await import("./device");
    const display = sendFrames(data.display, data.screen);closeDisplay = display.close;
    setScreenSink(display.present);
    const [{ sendMedia }, { useAudioOut }, { useMediaElements }] = await Promise.all([import("./media-port"), import("../android/audio-output"), import("../android/mediaplayer")]);
    const media = sendMedia(data.media);
    useAudioOut(media.audio); useMediaElements(media.createElement);
    closeIme = await (await import("./ime-port")).serveIme(data.ime);
    const surfaces = (await import("./web-surface-port")).sendWebSurfaces(data.web);
    const {useWebSurfaces} = await import("../android/webframes");
    useWebSurfaces(surfaces.create);
    closeWeb = () => { useWebSurfaces(null); surfaces.close(); };
    const { onProcessExit } = await import("../process-exit");
    // AppExitInfoTracker publishes the real record first, then these received owners close.
    onProcessExit(() => { release(); closeProcessBrokerPort(); closeProcessBootstrap(data); });
    return broker;
  } catch (error) {
    release(); closeProcessBootstrap(data);
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
