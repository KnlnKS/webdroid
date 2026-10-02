// ILocationManager, under AOSP's LocationManager: Location, LocationRequest, Criteria and the
// listener transports run from bytecode. The page's geolocation is the source of the reference
// AVD's four providers, with its provider properties; gps and high-accuracy requests ask the
// browser for high accuracy, and passive requests only hear fixes others asked for. As in
// LocationManagerService, locations need ACCESS_COARSE_LOCATION or ACCESS_FINE_LOCATION (a coarse
// grant is not fudged here) and a caller without either sees no providers.
import { JObj, noops, rt, stubs, driven, type Gen } from "../jvm/runtime";
import { newArrayList } from "../jvm/natives/jcoll";
import { after, newObj, scall, vcall } from "../jvm/natives/jlang";
import { reportUncaught } from "./os";
import { bootTime, uptimeMillis } from "../guest-clock";
import { onMain } from "./mainloop";
import { hostStub } from "./binder";
import { geocodeMethods } from "./geocoder";
import { permissionGranted } from "./permissions";
import { packages } from "./packages";
import { appHost } from "./apphost";
import type { LocationEvent, LocationFix } from "../shell/geolocation";

export const locationTransport = {
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
const providers = () => locationTransport.available() ? Object.keys(PROPERTIES) : [];
const exists = (provider: string | null) => provider !== null && providers().includes(provider);
const properties = new Map<string, Promise<JObj>>();
function providerProperties(provider: string): Promise<JObj> {
  let made = properties.get(provider);
  if (!made) properties.set(provider, made = Promise.resolve(rt.drive(function* (): Gen<JObj> {
    const [network, satellite, altitude, speed, bearing, power, accuracy] = PROPERTIES[provider];
    const B = "Landroid/location/provider/ProviderProperties$Builder;", builder = yield newObj("android/location/provider/ProviderProperties$Builder");
    for (const [setter, value] of [["setHasNetworkRequirement", network], ["setHasSatelliteRequirement", satellite],
      ["setHasAltitudeSupport", altitude], ["setHasSpeedSupport", speed], ["setHasBearingSupport", bearing]] as const) {
      yield vcall(builder, setter, `(Z)${B}`, value);
    }
    yield vcall(builder, "setPowerUsage", `(I)${B}`, power);
    yield vcall(builder, "setAccuracy", `(I)${B}`, accuracy);
    return yield vcall(builder, "build", "()Landroid/location/provider/ProviderProperties;");
  }())));
  return made;
}
const permitted = (pkg: string | null) => pkg !== null
  && (permissionGranted(pkg, "android.permission.ACCESS_FINE_LOCATION") || permissionGranted(pkg, "android.permission.ACCESS_COARSE_LOCATION"));
function enforce(pkg: string | null): void {
  if (permitted(pkg)) return;
  const uid = pkg === null ? -1 : packages.get(pkg)?.uid ?? -1;
  throw rt.mkThrowable("java/lang/SecurityException",
    `uid ${uid} does not have android.permission.ACCESS_COARSE_LOCATION or android.permission.ACCESS_FINE_LOCATION.`);
}
function requireProvider(provider: string | null): string {
  if (!exists(provider)) throw rt.mkThrowable("java/lang/IllegalArgumentException", `provider "${provider}" does not exist`);
  return provider!;
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
const lastFix = (provider: string) => {
  const fix = locationTransport.last();
  return fix && locationTransport.enabled() && (provider !== "gps" || fix.highAccuracy) ? fix : null;
};

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
function unsubscribe(key: unknown): void {
  const subscription = subscriptions.get(key);
  if (!subscription) return;
  subscriptions.delete(key);
  subscription.active = false;
  if (subscription.timer !== null) clearTimeout(subscription.timer);
  locationTransport.remove(subscription.id);
}
/** fixes for one registration, throttled by its request as LocationProviderManager throttles them */
function subscribe(key: unknown, provider: string, request: Request, on: {
  location: (fix: LocationFix) => unknown; enabled?: (enabled: boolean) => unknown; expired?: () => unknown;
}): void {
  unsubscribe(key);
  const subscription: Subscription = { id: nextId++, active: true, timer: null };
  subscriptions.set(key, subscription);
  const deliver = (job: () => unknown) => { void onMain(job).catch(reportUncaught); };
  const end = () => { if (subscription.active) { unsubscribe(key); if (on.expired) deliver(on.expired); } };
  if (request.duration < 0x7fffffffn) subscription.timer = setTimeout(end, Number(request.duration));
  const start = uptimeMillis();
  let previous: LocationFix | null = null, remaining = request.maxUpdates, events = Promise.resolve();
  const receive = async (event: LocationEvent) => {
    if (!subscription.active) return;
    if (event.kind !== "fix") {
      if (on.enabled && (event.kind === "enabled" || event.code === 1)) deliver(() => on.enabled!(event.kind === "enabled"));
      return;
    }
    const fix = event.fix;
    if (uptimeMillis() - start >= Number(request.duration)) { end(); return; }
    if (previous && (fix.monotonic - previous.monotonic < Number(request.minInterval) || await distanceM(previous, fix) < request.distance)) return;
    previous = fix;
    if (--remaining === 0) unsubscribe(key);
    deliver(() => on.location(fix));
  };
  locationTransport.subscribe(subscription.id, request.high, provider !== "passive" && request.interval !== PASSIVE_INTERVAL,
    (event) => { events = events.then(() => receive(event)).catch(reportUncaught); });
}
async function distanceM(a: LocationFix, b: LocationFix): Promise<number> {
  const results = new Float32Array(1);
  await scall("android/location/Location", "distanceBetween", "(DDDD[F)V", a.latitude, a.longitude, b.latitude, b.longitude, results);
  return results[0];
}
/** LocationManagerService.getProviders: none for a caller without location permission */
function* providerList(criteria: JObj | null, enabledOnly: number): Gen<string[]> {
  if (!permitted(appHost?.pkg ?? null)) return [];
  const out: string[] = [];
  for (const name of providers()) {
    if (enabledOnly && !locationTransport.enabled()) continue;
    if (criteria && !(yield scall("android/location/LocationProvider", "propertiesMeetCriteria",
      "(Ljava/lang/String;Landroid/location/provider/ProviderProperties;Landroid/location/Criteria;)Z", name, yield providerProperties(name), criteria))) continue;
    out.push(name);
  }
  return out;
}

const LISTENER = "Landroid/location/ILocationListener;";
rt.register({ name: "webdroid/LocationManagerService", ctor: class extends JObj {}, sup: "android/location/ILocationManager$Stub", methods: {
  // the browser's geolocation takes no provider commands (aiding data, time injection)
  "sendExtraCommand(Ljava/lang/String;Ljava/lang/String;Landroid/os/Bundle;)V": () => {},
  "getAllProviders()Ljava/util/List;": () => newArrayList(providers()),
  "getProviders(Landroid/location/Criteria;Z)Ljava/util/List;": driven(function* (criteria: JObj | null, enabledOnly: number) {
    return newArrayList(yield* providerList(criteria, enabledOnly));
  }),
  // the best of the providers meeting the criteria, or of all of them when none does
  "getBestProvider(Landroid/location/Criteria;Z)Ljava/lang/String;": driven(function* (criteria: JObj | null, enabledOnly: number) {
    let names = yield* providerList(criteria, enabledOnly);
    if (!names.length) names = yield* providerList(null, enabledOnly);
    return ["fused", "gps", "network"].find((name) => names.includes(name)) ?? names[0] ?? null;
  }),
  "hasProvider(Ljava/lang/String;)Z": (provider: string | null) => +exists(provider),
  "isLocationEnabledForUser(I)Z": () => +locationTransport.enabled(),
  "isProviderEnabledForUser(Ljava/lang/String;I)Z": (provider: string | null) => +(exists(provider) && locationTransport.enabled()),
  "getProviderProperties(Ljava/lang/String;)Landroid/location/provider/ProviderProperties;": (provider: string | null) =>
    providerProperties(requireProvider(provider)),
  "getLastLocation(Ljava/lang/String;Landroid/location/LastLocationRequest;Ljava/lang/String;Ljava/lang/String;)Landroid/location/Location;":
    (provider: string | null, _request: JObj, pkg: string | null) => {
      enforce(pkg);
      const fix = exists(provider) ? lastFix(provider!) : null;
      return fix && location(fix, provider!);
    },
  [`registerLocationListener(Ljava/lang/String;Landroid/location/LocationRequest;${LISTENER}Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V`]:
    driven(function* (provider: string | null, request: JObj, listener: JObj, pkg: string | null) {
      enforce(pkg);
      const name = requireProvider(provider);
      subscribe(listener, name, yield* readRequest(name, request), {
        location: (fix) => after(location(fix, name), (l: JObj) => vcall(listener, "onLocationChanged", "(Ljava/util/List;Landroid/os/IRemoteCallback;)V", newArrayList([l]), null)),
        enabled: (enabled) => vcall(listener, "onProviderEnabledChanged", "(Ljava/lang/String;Z)V", name, +enabled),
      });
    }),
  [`unregisterLocationListener(${LISTENER})V`]: unsubscribe,
  [`requestListenerFlush(Ljava/lang/String;${LISTENER}I)V`]: (_provider: string, listener: JObj, code: number) =>
    void onMain(() => vcall(listener, "onFlushComplete", "(I)V", code)).catch(reportUncaught),
  // one location within the request's duration, or null once it passes
  "getCurrentLocation(Ljava/lang/String;Landroid/location/LocationRequest;Landroid/location/ILocationCallback;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Landroid/os/ICancellationSignal;":
    driven(function* (provider: string | null, request: JObj, callback: JObj, pkg: string | null) {
      enforce(pkg);
      const name = requireProvider(provider), deliver = (value: JObj | null) => vcall(callback, "onLocation", "(Landroid/location/Location;)V", value);
      subscribe(callback, name, { ...yield* readRequest(name, request), maxUpdates: 1 }, {
        location: (fix) => after(location(fix, name), deliver), expired: () => deliver(null),
      });
      return null;
    }),
  // no GNSS hardware reports satellites, measurements or NMEA, so registrations never hear anything
  ...noops("registerGnssStatusCallback(Landroid/location/IGnssStatusListener;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
    "unregisterGnssStatusCallback(Landroid/location/IGnssStatusListener;)V",
    "registerGnssNmeaCallback(Landroid/location/IGnssNmeaListener;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
    "unregisterGnssNmeaCallback(Landroid/location/IGnssNmeaListener;)V"),
  "getGnssCapabilities()Landroid/location/GnssCapabilities;": driven(function* () {
    return yield vcall(yield newObj("android/location/GnssCapabilities$Builder"), "build", "()Landroid/location/GnssCapabilities;");
  }),
  "getGnssYearOfHardware()I": () => 0,
  // no GNSS time either: SystemClock.currentGnssTimeClock reports it unavailable
  ...stubs(null, "getGnssHardwareModelName()Ljava/lang/String;", "getGnssTimeMillis()Landroid/location/LocationTime;"),
  ...geocodeMethods,
} });
hostStub("location", "webdroid/LocationManagerService");
