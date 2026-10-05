import { attachGuestClockPort, guestClockControl } from "../guest-clock";
import { closeProcessBootstrap, type ProcessBootstrap } from "./process-bootstrap-data";
import type { BrokerCalls } from "./processes";

/** Time is attached before loading natives, process identity or any other JVM module. */
export async function attachWorkerBootstrap(data: ProcessBootstrap): Promise<BrokerCalls> {
  let attachedClock = false;
  try {
    if (!data.clock || !data.broker) throw new Error("Worker bootstrap is missing clock or command capabilities");
    attachGuestClockPort(data.clock);
    attachedClock = true;
    await import("../natives");
    const { setProcessIdentity, setProcessName } = await import("../android/os");
    setProcessIdentity(data.pid, data.uid);
    setProcessName(data.process);
    const { attachProcessBrokerPort } = await import("./process-endpoint");
    return attachProcessBrokerPort(data.broker);
  } catch (error) {
    if (attachedClock) guestClockControl.dispose();
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
