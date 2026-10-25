import { guestClockControl } from "../guest-clock.ts";
import { closeProcessBootstrap, type ProcessBootstrap } from "./process-bootstrap-data.ts";
import type { BrokerCalls } from "./broker-contract.ts";

/** The Worker attached its clock and loaded natives before this bootstrap arrived. */
export async function attachWorkerBootstrap(data: ProcessBootstrap): Promise<BrokerCalls> {
  let closeDisplay = () => {}, closeInput = () => {}, closeWeb = () => {};
  const release = () => { closeWeb(); closeInput(); closeDisplay(); guestClockControl.dispose(); };
  try {
    const { setProcessIdentity, setProcessName } = await import("../android/os.ts");
    setProcessIdentity(data.pid, data.uid);
    setProcessName(data.process);
    const { attachProcessBrokerPort, closeProcessBrokerPort } = await import("./process-endpoint.ts");
    const broker = attachProcessBrokerPort(data.broker);
    (await import("./device-storage.ts")).useStorageReplica(data.storage, broker.storageWrite);
    const {sendFrames} = await import("./frame-port.ts");
    const [{ setScreenSink, setDisplayChangeHandler, setRotation }, { device }] = await Promise.all([import("./device.ts"), import("./config.ts")]);
    setRotation(data.rotation);
    const display = sendFrames(data.display, data.screen);closeDisplay = display.close;
    setScreenSink(display.present);
    setDisplayChangeHandler(() => void broker.displayOrientation(device.width > device.height));
    const [{ sendMedia }, { useAudioOut }, { useMediaElements }] = await Promise.all([import("./media-port.ts"), import("../android/audio-output.ts"), import("../android/mediaplayer.ts")]);
    const media = sendMedia(data.media);
    useAudioOut(media.audio); useMediaElements(media.createElement);
    closeInput = await (await import("./input-port.ts")).serveInput(data.input);
    const surfaces = (await import("./web-surface-port.ts")).sendWebSurfaces(data.web);
    const {useWebSurfaces} = await import("../android/webframes.ts");
    useWebSurfaces(surfaces.create);
    closeWeb = () => { useWebSurfaces(null); surfaces.close(); };
    const { onProcessExit } = await import("../process-exit.ts");
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
  const { closePort, serveCalls } = await import("./rpc.ts");
  try { return serveCalls(port, (await import("./process-endpoint.ts")).createProcessEndpoint()); }
  catch (error) { closePort(port); throw error; }
}
