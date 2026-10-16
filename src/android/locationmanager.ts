// ILocationManager, under AOSP's LocationManager: Location, LocationRequest, Criteria and the
// listener transports run from bytecode. The page's geolocation is the source of the reference
// AVD's four providers, with its provider properties; gps and high-accuracy requests ask the
// browser for high accuracy, and passive requests only hear fixes others asked for. As in
// LocationManagerService, locations need ACCESS_COARSE_LOCATION or ACCESS_FINE_LOCATION (a coarse
// grant is not fudged here) and a caller without either sees no providers.
import { awaited, JObj, noops, rt, stubs, driven, type Gen } from "../jvm/runtime";
import { newArrayList } from "../jvm/natives/jcoll";
import { after, newObj, scall, vcall } from "../jvm/natives/jentry";
import { logUncaught } from "../jvm/natives/jthrowable";
import { once } from "../jvm/suspend";
import { bootTime, uptimeMillis } from "../guest-clock";
import { onMain, postMain } from "./mainloop";
import { hostStub } from "./binder";
import { geocodeMethods } from "./geocoder";
import { permissionsGranted } from "./permissions";
import { packages } from "./packages";
import { appHost } from "./apphost";
import type { LocationEvent, LocationFix } from "../shell/geolocation";

export type LocationAccess = {
  available(): boolean | Promise<boolean>;
  enabled(): boolean | Promise<boolean>;
  last(): LocationFix | null | Promise<LocationFix | null>;
  subscribe(id: number, high: boolean, active: boolean, receive: (event: LocationEvent) => void): void | Promise<void>;
  remove(id: number): void | Promise<void>;
};
export const locationTransport: LocationAccess = {
  available: () => false, enabled: () => false, last: (): LocationFix | null => null,
  subscribe: (_id: number, _high: boolean, _active: boolean, _receive: (event: LocationEvent) => void) => {},
  remove: (_id: number) => {},
};
const PASSIVE_INTERVAL = 0x7fffffffffffffffn;
// ProviderProperties as the reference AVD reports them: [network, satellite, altitude, speed,
// bearing, power usage (1 low, 2 medium, 3 high), accuracy (1 fine)]
const PROPERTIES: Record<string, [number, number, number, number, number, number, number]> = {
  passive: [0, 0, 0, 0, 0, 1, 1], network: [1, 0, 1, 0, 0, 2, 1], fused: [0, 0, 1, 1, 1, 1, 1], gps: [0, 1, 1, 1, 1, 3, 1],
};
const providers = () => after(locationTransport.available(), available => available ? Object.keys(PROPERTIES) : []);
const exists = (provider: string | null) => provider !== null && after(providers(), names => names.includes(provider));
const properties = Object.fromEntries(Object.entries(PROPERTIES).map(([provider, [network, satellite, altitude, speed, bearing, power, accuracy]]) =>
  [provider, once(driven(function* (): Gen<JObj> {
    const B = "Landroid/location/provider/ProviderProperties$Builder;", builder = yield newObj("android/location/provider/ProviderProperties$Builder");
    for (const [setter, value] of [["setHasNetworkRequirement", network], ["setHasSatelliteRequirement", satellite],
      ["setHasAltitudeSupport", altitude], ["setHasSpeedSupport", speed], ["setHasBearingSupport", bearing]] as const) {
      yield vcall(builder, setter, `(Z)${B}`, value);
    }
    yield vcall(builder, "setPowerUsage", `(I)${B}`, power);
    yield vcall(builder, "setAccuracy", `(I)${B}`, accuracy);
    return yield vcall(builder, "build", "()Landroid/location/provider/ProviderProperties;");
  }))]));
const providerProperties = (provider: string) => properties[provider]();
const permitted = (pkg: string | null) => pkg !== null
  && after(permissionsGranted(pkg, ["android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"]), values => values.some(Boolean));
function enforce(pkg: string | null): void | Promise<void> {
  return after(permitted(pkg), allowed => {
    if (allowed) return;
    const uid = pkg === null ? -1 : packages.get(pkg)?.uid ?? -1;
    throw rt.mkThrowable("java/lang/SecurityException",
      `uid ${uid} does not have android.permission.ACCESS_COARSE_LOCATION or android.permission.ACCESS_FINE_LOCATION.`);
  });
}
function requireProvider(provider: string | null): string | Promise<string> {
  return after(exists(provider), found => {
    if (!found) throw rt.mkThrowable("java/lang/IllegalArgumentException", `provider "${provider}" does not exist`);
    return provider!;
  });
}
const location = driven(function* (fix: LocationFix, provider: string): Gen<JObj> {
  const value = yield newObj("android/location/Location", "(Ljava/lang/String;)V", provider === "passive" ? fix.highAccuracy ? "gps" : "network" : provider);
  yield vcall(value, "setLatitude", "(D)V", fix.latitude);
  yield vcall(value, "setLongitude", "(D)V", fix.longitude);
  yield vcall(value, "setTime", "(J)V", BigInt(Math.floor(fix.timestamp)));
  yield vcall(value, "setElapsedRealtimeNanos", "(J)V", BigInt(Math.max(0, Math.floor((fix.monotonic - bootTime) * 1e6))));
  yield vcall(value, "setAccuracy", "(F)V", fix.accuracy);
  if (fix.altitude !== null) yield vcall(value, "setAltitude", "(D)V", fix.altitude);
  if (fix.altitudeAccuracy !== null) yield vcall(value, "setVerticalAccuracyMeters", "(F)V", fix.altitudeAccuracy);
  if (fix.speed !== null) yield vcall(value, "setSpeed", "(F)V", fix.speed);
  if (fix.heading !== null && Number.isFinite(fix.heading)) yield vcall(value, "setBearing", "(F)V", fix.heading);
  return value;
});
const lastFix = (provider: string) => after(locationTransport.last(), fix =>
  fix && (provider !== "gps" || fix.highAccuracy) ? after(locationTransport.enabled(), enabled => enabled ? fix : null) : null);

type Request = { interval: bigint; minInterval: bigint; distance: number; maxUpdates: number; duration: bigint; high: boolean };
function* readRequest(provider: string, request: JObj): Gen<Request> {
  const interval: bigint = yield vcall(request, "getIntervalMillis", "()J");
  return {
    interval, minInterval: yield vcall(request, "getMinUpdateIntervalMillis", "()J"),
    distance: yield vcall(request, "getMinUpdateDistanceMeters", "()F"), maxUpdates: yield vcall(request, "getMaxUpdates", "()I"),
    duration: yield vcall(request, "getDurationMillis", "()J"),
    high: provider === "gps" || (yield vcall(request, "getQuality", "()I")) === 100,
  };
}
type Subscription = { id: number; active: boolean; timer: ReturnType<typeof setTimeout> | null };
const subscriptions = new Map<unknown, Subscription>();
let nextId = 1;
function unsubscribe(key: unknown): void | Promise<void> {
  const subscription = subscriptions.get(key);
  if (!subscription) return;
  subscriptions.delete(key);
  subscription.active = false;
  if (subscription.timer !== null) clearTimeout(subscription.timer);
  return locationTransport.remove(subscription.id);
}
/** fixes for one registration, throttled by its request as LocationProviderManager throttles them */
async function subscribe(key: unknown, provider: string, request: Request, on: {
  location: (fix: LocationFix) => unknown; enabled?: (enabled: boolean) => unknown; expired?: () => unknown;
}): Promise<void> {
  const retired = unsubscribe(key);
  const subscription: Subscription = { id: nextId++, active: true, timer: null };
  subscriptions.set(key, subscription);
  const end = () => { if (subscription.active) { void Promise.resolve(unsubscribe(key)).catch(logUncaught); if (on.expired) postMain(on.expired); } };
  if (request.duration < 0x7fffffffn) subscription.timer = setTimeout(end, Number(request.duration));
  const start = uptimeMillis();
  let previous: LocationFix | null = null, remaining = request.maxUpdates, events = Promise.resolve();
  const receive = async (event: LocationEvent) => {
    if (!subscription.active) return;
    if (event.kind !== "fix") {
      if (on.enabled && (event.kind === "enabled" || event.code === 1)) postMain(() => on.enabled!(event.kind === "enabled"));
      return;
    }
    const fix = event.fix;
    if (uptimeMillis() - start >= Number(request.duration)) { end(); return; }
    if (previous && (fix.monotonic - previous.monotonic < Number(request.minInterval) || await distanceM(previous, fix) < request.distance)) return;
    previous = fix;
    if (--remaining === 0) void Promise.resolve(unsubscribe(key)).catch(logUncaught);
    postMain(() => on.location(fix));
  };
  try {
    await retired;
    if (!subscription.active) return;
    await locationTransport.subscribe(subscription.id, request.high, provider !== "passive" && request.interval !== PASSIVE_INTERVAL,
      (event) => { events = events.then(() => receive(event)).catch(logUncaught); });
    if (!subscription.active) await locationTransport.remove(subscription.id);
  } catch (error) {
    if (subscriptions.get(key) === subscription) await Promise.resolve(unsubscribe(key)).catch(logUncaught);
    throw error;
  }
}
function distanceM(a: LocationFix, b: LocationFix): Promise<number> {
  const results = new Float32Array(1);
  return onMain(() => after(scall("android/location/Location", "distanceBetween", "(DDDD[F)V", a.latitude, a.longitude, b.latitude, b.longitude, results), () => results[0]));
}
/** LocationManagerService.getProviders: none for a caller without location permission */
function* providerList(criteria: JObj | null, enabledOnly: number): Gen<string[]> {
  if (!(yield* awaited(permitted(appHost?.pkg ?? null)))) return [];
  const out: string[] = [];
  if (enabledOnly && !(yield* awaited(locationTransport.enabled()))) return out;
  for (const name of yield* awaited(providers())) {
    if (criteria && !(yield scall("android/location/LocationProvider", "propertiesMeetCriteria",
      "(Ljava/lang/String;Landroid/location/provider/ProviderProperties;Landroid/location/Criteria;)Z", name, yield* awaited(providerProperties(name)), criteria))) continue;
    out.push(name);
  }
  return out;
}

const LISTENER = "Landroid/location/ILocationListener;";
rt.register({ name: "webdroid/LocationManagerService", ctor: class extends JObj {}, sup: "android/location/ILocationManager$Stub", methods: {
  // the browser's geolocation takes no provider commands (aiding data, time injection)
  "sendExtraCommand(Ljava/lang/String;Ljava/lang/String;Landroid/os/Bundle;)V": () => {},
  "getAllProviders()Ljava/util/List;": () => after(providers(), newArrayList),
  "getProviders(Landroid/location/Criteria;Z)Ljava/util/List;": driven(function* (criteria: JObj | null, enabledOnly: number) {
    return newArrayList(yield* providerList(criteria, enabledOnly));
  }),
  // the best of the providers meeting the criteria, or of all of them when none does
  "getBestProvider(Landroid/location/Criteria;Z)Ljava/lang/String;": driven(function* (criteria: JObj | null, enabledOnly: number) {
    let names = yield* providerList(criteria, enabledOnly);
    if (!names.length) names = yield* providerList(null, enabledOnly);
    return ["fused", "gps", "network"].find((name) => names.includes(name)) ?? names[0] ?? null;
  }),
  "hasProvider(Ljava/lang/String;)Z": (provider: string | null) => after(exists(provider), found => +found),
  "isLocationEnabledForUser(I)Z": () => after(locationTransport.enabled(), enabled => +enabled),
  "isProviderEnabledForUser(Ljava/lang/String;I)Z": (provider: string | null) => after(exists(provider), found => found ? after(locationTransport.enabled(), enabled => +enabled) : 0),
  "getProviderProperties(Ljava/lang/String;)Landroid/location/provider/ProviderProperties;": (provider: string | null) =>
    after(requireProvider(provider), providerProperties),
  "getLastLocation(Ljava/lang/String;Landroid/location/LastLocationRequest;Ljava/lang/String;Ljava/lang/String;)Landroid/location/Location;":
    (provider: string | null, _request: JObj, pkg: string | null) => after(enforce(pkg), () =>
      after(exists(provider), found => found ? after(lastFix(provider!), fix => fix && location(fix, provider!)) : null)),
  [`registerLocationListener(Ljava/lang/String;Landroid/location/LocationRequest;${LISTENER}Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V`]:
    driven(function* (provider: string | null, request: JObj, listener: JObj, pkg: string | null) {
      yield* awaited(enforce(pkg));
      const name = yield* awaited(requireProvider(provider));
      yield* awaited(subscribe(listener, name, yield* readRequest(name, request), {
        location: (fix) => after(location(fix, name), (l: JObj) => after(newArrayList([l]), list => vcall(listener, "onLocationChanged", "(Ljava/util/List;Landroid/os/IRemoteCallback;)V", list, null))),
        enabled: (enabled) => vcall(listener, "onProviderEnabledChanged", "(Ljava/lang/String;Z)V", name, +enabled),
      }));
    }),
  [`unregisterLocationListener(${LISTENER})V`]: unsubscribe,
  [`requestListenerFlush(Ljava/lang/String;${LISTENER}I)V`]: (_provider: string, listener: JObj, code: number) =>
    postMain(() => vcall(listener, "onFlushComplete", "(I)V", code)),
  // one location within the request's duration, or null once it passes
  "getCurrentLocation(Ljava/lang/String;Landroid/location/LocationRequest;Landroid/location/ILocationCallback;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Landroid/os/ICancellationSignal;":
    driven(function* (provider: string | null, request: JObj, callback: JObj, pkg: string | null) {
      yield* awaited(enforce(pkg));
      const name = yield* awaited(requireProvider(provider)), deliver = (value: JObj | null) => vcall(callback, "onLocation", "(Landroid/location/Location;)V", value);
      yield* awaited(subscribe(callback, name, { ...yield* readRequest(name, request), maxUpdates: 1 }, {
        location: (fix) => after(location(fix, name), deliver), expired: () => deliver(null),
      }));
      return null;
    }),
  // no GNSS hardware reports satellites, measurements, navigation messages, antenna info or NMEA, so
  // registrations never hear anything
  ...noops("registerGnssStatusCallback(Landroid/location/IGnssStatusListener;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
    "unregisterGnssStatusCallback(Landroid/location/IGnssStatusListener;)V",
    "registerGnssNmeaCallback(Landroid/location/IGnssNmeaListener;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
    "unregisterGnssNmeaCallback(Landroid/location/IGnssNmeaListener;)V",
    "addGnssMeasurementsListener(Landroid/location/GnssMeasurementRequest;Landroid/location/IGnssMeasurementsListener;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
    "removeGnssMeasurementsListener(Landroid/location/IGnssMeasurementsListener;)V",
    "addGnssNavigationMessageListener(Landroid/location/IGnssNavigationMessageListener;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
    "removeGnssNavigationMessageListener(Landroid/location/IGnssNavigationMessageListener;)V",
    "addGnssAntennaInfoListener(Landroid/location/IGnssAntennaInfoListener;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
    "removeGnssAntennaInfoListener(Landroid/location/IGnssAntennaInfoListener;)V"),
  "getGnssCapabilities()Landroid/location/GnssCapabilities;": driven(function* () {
    return yield vcall(yield newObj("android/location/GnssCapabilities$Builder"), "build", "()Landroid/location/GnssCapabilities;");
  }),
  "getGnssYearOfHardware()I": () => 0,
  // no GNSS time either: SystemClock.currentGnssTimeClock reports it unavailable
  ...stubs(null, "getGnssHardwareModelName()Ljava/lang/String;", "getGnssTimeMillis()Landroid/location/LocationTime;"),
  ...geocodeMethods,
} });
hostStub("location", "webdroid/LocationManagerService");
