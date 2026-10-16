import type { LocationAccess } from "../android/locationmanager.ts";
import type { LocationEvent, LocationFix } from "./geolocation.ts";

export type LocationCalls = {
  locationAvailable(): Promise<boolean>;
  locationEnabled(): Promise<boolean>;
  locationLast(): Promise<LocationFix | null>;
  locationSubscribe(id: number, token: number, high: boolean, active: boolean): Promise<void>;
  locationRemove(id: number, token: number): Promise<void>;
};

/** Listener closures stay in their VM; generation tokens reject callbacks from replaced owners. */
export function remoteLocation(calls: () => LocationCalls) {
  const listeners = new Map<number, {token: number; receive: (event: LocationEvent) => void}>();
  let nextToken = 1;
  const access: LocationAccess = {
    available: () => calls().locationAvailable(),
    enabled: () => calls().locationEnabled(),
    last: () => calls().locationLast(),
    subscribe: async (id, high, active, receive) => {
      const listener = {token:nextToken++,receive};
      listeners.set(id, listener);
      try { await calls().locationSubscribe(id, listener.token, high, active); }
      catch (error) { if (listeners.get(id) === listener) listeners.delete(id); throw error; }
      if (listeners.get(id) !== listener) await calls().locationRemove(id, listener.token);
    },
    remove: async id => {
      const listener = listeners.get(id); listeners.delete(id);
      if (listener) await calls().locationRemove(id, listener.token);
    },
  };
  return {access,
    changed(id: number, token: number, event: LocationEvent) {
      const listener = listeners.get(id);
      if (listener?.token === token) listener.receive(event);
    },
    close() { listeners.clear(); },
  };
}
