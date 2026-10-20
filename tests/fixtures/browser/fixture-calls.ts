// What the browser fixtures' page side (process-bootstrap.ts) and their Workers (process-worker-fixture.ts) share.
import type { BrokerCalls, ProcessEndpoint } from "../../../src/shell/processes.ts";

/** a process endpoint that answers as an idle process does, but for `overrides` */
export const stubEndpoint = (overrides: Partial<ProcessEndpoint> = {}): ProcessEndpoint => ({
  processDied: async () => {}, activity: async () => {}, transact: async request => ({ handled: 0, data: request.data }),
  service: async () => null, serviceConnected: async () => {}, contentProvider: async () => null,
  broadcast: async (_intent, _component, _ordered, result) => result, cookiesChanged: async () => {},
  accountsChanged: async () => {}, settingsChanged: async () => {},
  storageChanged: async () => {}, packageRemoved: async () => {}, kill: () => {}, ...overrides,
});

/** the script of a fixture Worker playing `role` */
export const fixtureUrl = (role: string): string => `${location.origin}/process-worker-fixture.js?role=${role}`;
export const fixtureWorker = (role: string): Worker => new Worker(fixtureUrl(role), { type: "module" });

/** how a fixture Worker reaches the broker: its port and the methods the Worker's proxy names */
export type BrokerInit = { broker: MessagePort; methods: readonly (keyof BrokerCalls)[] };
export type PointerCalls = { pointer(owner: number, action: number, x: number, y: number): Promise<void>; release(): Promise<void>; samples(): Promise<number[][]> };
