// A realm's connection to the broker: the calls of its command port, connected once as it starts. A
// process Worker reaches system_server's services, providers and stores through them too; the page,
// which is system_server, and a realm that never connects (a tool or test running Java alone) hold
// those itself.
import { detached, logUncaught, unconnected } from "../jvm/natives/jthrowable.ts";
import type { BrokerCalls } from "./broker-contract.ts";
import { remoteProcessLife } from "./process-life.ts";

let calls: BrokerCalls | undefined, worker = false;
/** the broker's calls: a RemoteException before this realm connects and once its port closed */
export const broker = (): BrokerCalls => calls ?? unconnected();
/** whether system_server's state is another realm's, reached through broker(): in a process Worker */
export const remoteSystem = (): boolean => worker;
/** `calls`, or none once the port closed; a Worker's realm stays one, so its stores never answer locally */
export function connectBroker(next: BrokerCalls | undefined, inWorker: boolean): void { calls = next; worker = inWorker; }
/** `send` to the broker, which a realm without one has nobody to tell */
export function tellBroker(send: (calls: BrokerCalls) => unknown): void {
  const connected = calls;
  if (connected) detached(() => send(connected), logUncaught);
}
/** other processes' lives, which the broker tells this realm of */
export const processLife = remoteProcessLife(() => broker().process, logUncaught);
