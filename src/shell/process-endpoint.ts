// A process realm's side of the broker: its command port, which broker-access.ts hands this realm's
// services, and the endpoint the broker's requests to it land on.
import { descriptorTransport } from "../native/process-fd.ts";
import { useAlarmIntents } from "../android/alarm.ts";
import { decodeIntent } from "../android/intentipc.ts";
import { receiveTransaction, exportBinder, importBinder, type BinderHandle } from "../android/binder.ts";
import { exitProcess, onProcessExit } from "../process-exit.ts";
import { deathOf, lastExit, noteAppKill } from "../android/server/appexitinfo.ts";
import { hostedServices, remoteServiceConnected } from "../android/server/activeservices.ts";
import { vfs } from "./vfs.ts";
import { broadcastResult, deliverBroadcast as deliverQueued, resultData } from "../android/server/broadcastqueue.ts";
import { deliverRemoteResult, setVisible, startActivityInProcess, taskVisibility } from "../android/server/atm.ts";
import { executePendingIntent, publishedProvider } from "../android/server/am.ts";
import { stopSettingsUpdates } from "../android/settings.ts";
import { stopAccountUpdates } from "../android/accounts.ts";
import { awaited, type Gen } from "../jvm/runtime.ts";
import { cookiesChanged } from "../android/cookies.ts";
import { useFocusedUid } from "../android/clipboard.ts";
import { storageChanged } from "./device-storage.ts";
import { unregisterPackage } from "../android/installpackage.ts";
import { asBroker, brokerMethods, javaFailure, type BroadcastData, type BrokerCalls, type ProcessEndpoint } from "./broker-contract.ts";
import { connectBroker, processLife } from "./broker-access.ts";
import type { ProcessBroker } from "./processes.ts";
import { callProxy, closePort } from "./rpc.ts";
import { procIdentity } from "./procfs.ts";

export { processPresentation } from "../android/server/atm.ts";

let calls: ReturnType<typeof callProxy<BrokerCalls>> | undefined, releaseFiles = () => {};
function attach(port: MessagePort, worker: boolean): BrokerCalls {
  if (calls) { closePort(port); throw new Error("Process command port already attached"); }
  calls = callProxy<BrokerCalls>(port, brokerMethods, { notifications: ["processExited", "storageWrite"], makeError: javaFailure });
  connectBroker(calls.endpoint, worker);
  return calls.endpoint;
}
/** a Worker's command port, behind which system_server's realm holds the stores */
export function attachProcessBrokerPort(port: MessagePort): BrokerCalls {
  const broker = attach(port, true);
  releaseFiles = vfs.useOwner({ prepare: broker.files.filePrepare });
  return broker;
}
export function closeProcessBrokerPort(): void {
  calls?.close();
  connectBroker(undefined, true);
  processLife.close();
  releaseFiles();
}
/** system_server's realm: it asks the broker over its own command port as a Worker does, but holds
 *  the stores and its descriptors itself */
export function connectProcess(broker: ProcessBroker): ProcessEndpoint {
  onProcessExit((status) => broker.fail(procIdentity.pid, `Process has died: ${status.signal !== undefined ? "signal " + status.signal : "exit " + status.code}`, deathOf(lastExit)));
  attach(broker.brokerPort(procIdentity.pid), false);
  broker.files.attach(procIdentity.pid, vfs);
  descriptorTransport.local = broker.descriptorRights(procIdentity.pid);
  useFocusedUid(() => broker.foregroundUid());
  useAlarmIntents(broker.intents);
  // system_server announces the stores' changes, and its watches of them end with it
  if (broker.alive(procIdentity.pid)) for (const stop of [stopAccountUpdates, stopSettingsUpdates]) broker.watch(procIdentity.pid, stop);
  return createProcessEndpoint();
}

/** JVM callbacks are local to this realm; constructing the endpoint needs no live broker. */
export function createProcessEndpoint(): ProcessEndpoint {
  return {
    processDied: async token => processLife.died(token),
    cookiesChanged: async () => cookiesChanged(),
    storageChanged: async (key, value) => storageChanged(key, value),
    packageRemoved: async pkg => unregisterPackage(pkg),
    kill: (signal, note) => { if (note) noteAppKill(note); exitProcess({ signal }); },
    activity: async (request) => {
      if (request.kind === "back") return (await import("./device.ts")).pressBack();
      if (request.kind === "rotate") return (await import("./device.ts")).rotateDevice(request.landscape);
      return asBroker(function* (): Gen<void> {
        if (request.kind === "visibility") {
          yield taskVisibility(request.phase);
          if (request.phase !== "pause") setVisible(request.phase !== "stop");
        } else if (request.kind === "launch") {
          yield startActivityInProcess(request.component, yield* awaited(decodeIntent(request.intent)), request.id, request.caller);
          setVisible(true);
        } else deliverRemoteResult(request.request, request.code, request.data ? yield* awaited(decodeIntent(request.data)) : null);
      }());
    },
    transact: receiveTransaction,
    contentProvider: (authority) => asBroker(function* (): Gen<BinderHandle | null> { return exportBinder(yield* awaited(publishedProvider(authority))); }()),
    broadcast: (intent, component, ordered, data, sender) => asBroker(function* (): Gen<BroadcastData> {
      return yield* awaited(resultData(yield* awaited(deliverQueued(yield* awaited(decodeIntent(intent)), component, ordered, yield* awaited(broadcastResult(data)), sender))));
    }()),
    service: (request) => asBroker(function* (): Gen<BinderHandle | null> {
      if (request.kind === "pending") { yield executePendingIntent(request.operation, request.fill, request.alarmCount); return null; }
      if (request.kind === "unbind") { yield hostedServices.unbind(request.key); return null; }
      if (request.kind === "restart") { yield hostedServices.restart(request.intent, request.binds); return null; }
      const intent = yield* awaited(decodeIntent(request.intent));
      if (request.kind === "bind") { yield hostedServices.bind(intent, request.key, request.flags); return null; }
      if (request.kind === "peek") return exportBinder(yield* awaited(hostedServices.peek(intent)));
      yield hostedServices[request.kind](intent);
      return null;
    }()),
    serviceConnected: (key, binder, dead) => asBroker(function* (): Gen<void> { remoteServiceConnected(key, yield* awaited(importBinder(binder)), dead); }()),
  };
}
