import { guestClockControl } from "../guest-clock.ts";
import { closeProcessBootstrap, type ProcessBootstrap, type SurfaceName } from "./process-bootstrap-data.ts";
import type { BrokerCalls } from "./broker-contract.ts";

/** each surface's Worker end: what the realm draws, hears and plays through, closed by what it answers */
const surfaces: Record<SurfaceName, (port: MessagePort, data: ProcessBootstrap) => Promise<() => void>> = {
  async display(port, data) {
    const [{ sendFrames }, { setScreenSink }] = await Promise.all([import("./frame-port.ts"), import("./device.ts")]);
    const display = sendFrames(port, data.screen);
    setScreenSink(display.present);
    return display.close;
  },
  async media(port) {
    const [{ sendMedia }, { useAudioOut }, { useMediaElements }] = await Promise.all([import("./media-port.ts"), import("../android/audio-output.ts"), import("../android/mediaplayer.ts")]);
    const media = sendMedia(port);
    useAudioOut(media.audio); useMediaElements(media.createElement);
    return media.close;
  },
  input: async port => (await import("./input-port.ts")).serveInput(port),
  async web(port) {
    const [{ sendWebSurfaces }, { useWebSurfaces }] = await Promise.all([import("./web-surface-port.ts"), import("../android/webframes.ts")]);
    const web = sendWebSurfaces(port);
    useWebSurfaces(web.create);
    return () => { useWebSurfaces(null); web.close(); };
  },
};

/** The Worker attached its clock and loaded natives before this bootstrap arrived. */
export async function attachWorkerBootstrap(data: ProcessBootstrap): Promise<BrokerCalls> {
  const ends: (() => void)[] = [];
  const release = () => { for (const end of ends.splice(0).reverse()) end(); guestClockControl.dispose(); };
  try {
    const { setProcessIdentity, setProcessName } = await import("../android/os.ts");
    setProcessIdentity(data.pid, data.uid);
    setProcessName(data.process);
    const { attachProcessBrokerPort, closeProcessBrokerPort } = await import("./process-endpoint.ts");
    const broker = attachProcessBrokerPort(data.broker);
    (await import("./device-storage.ts")).useStorageReplica(data.storage, broker.storageWrite);
    const [{ setDisplayChangeHandler, setRotation }, { device }] = await Promise.all([import("./device.ts"), import("./config.ts")]);
    setRotation(data.rotation);
    setDisplayChangeHandler(() => void broker.displayOrientation(device.width > device.height));
    for (const name of Object.keys(surfaces) as SurfaceName[]) ends.push(await surfaces[name](data.surfaces[name], data));
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
