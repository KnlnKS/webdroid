// ILocationManager: LocationManagerService, hosted once in system_server (SYSTEM_SERVICES), under
// AOSP's LocationManager: Location, LocationRequest, Criteria and the listener transports run from
// bytecode. The page's geolocation is the source of the reference AVD's four providers, with its
// provider properties; gps and high-accuracy requests ask the browser for high accuracy, and passive
// requests only hear fixes others asked for. As in LocationManagerService, locations need the
// caller's uid to hold ACCESS_COARSE_LOCATION or ACCESS_FINE_LOCATION (a coarse grant is not fudged
// here), a caller without either sees no providers, and a registration whose caller loses both ends.
import { awaited, JObj, noops, rt, stubs, driven, type Gen } from "../jvm/runtime.ts";
import { newArrayList } from "../jvm/natives/jcoll.ts";
import { after, newObj, scall, vcall } from "../jvm/natives/jentry.ts";
import { logUncaught } from "../jvm/natives/jthrowable.ts";
import { once } from "../jvm/suspend.ts";
import { bootTime, clearGuestTimeout, setSystemTimeout, uptimeMillis, type GuestTimer } from "../guest-clock.ts";
import { asBinder, asSystem, callingIdentity, hostService, hostedService, onCallerDeath, oneway, type Caller } from "./binder.ts";
import { geocodeMethods } from "./geocoder.ts";
import { checkUidPermission } from "./permissions.ts";
import { ownedBy } from "./packages.ts";
import { BrowserLocation, type LocationEvent, type LocationFix } from "../shell/geolocation.ts";

/** the browser's geolocation, which system_server's realm shares with the broker */
export type Geolocation = Pick<BrowserLocation, "available" | "enabled" | "last" | "subscribe" | "remove">;
let geolocation: Geolocation = new BrowserLocation();
export function useGeolocation(source: Geolocation): void { geolocation = source; }
/** LocationManager.isLocationEnabled, as a service in any process asks system_server's */
export const locationEnabled = (): boolean | Promise<boolean> => after(hostedService("location"), binder =>
  after(scall("android/location/ILocationManager$Stub", "asInterface", "(Landroid/os/IBinder;)Landroid/location/ILocationManager;", binder),
    service => after(vcall(service, "isLocationEnabledForUser", "(I)Z", 0), (enabled: number) => enabled !== 0)));
const PASSIVE_INTERVAL = 0x7fffffffffffffffn;
// ProviderProperties as the reference AVD reports them: [network, satellite, altitude, speed,
// bearing, power usage (1 low, 2 medium, 3 high), accuracy (1 fine)]
const PROPERTIES: Record<string, [number, number, number, number, number, number, number]> = {
  passive: [0, 0, 0, 0, 0, 1, 1], network: [1, 0, 1, 0, 0, 2, 1], fused: [0, 0, 1, 1, 1, 1, 1], gps: [0, 1, 1, 1, 1, 3, 1],
};
const providers = () => geolocation.available ? Object.keys(PROPERTIES) : [];
const exists = (provider: string | null): provider is string => provider !== null && providers().includes(provider);
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
/** LocationPermissions.getPermissionLevel: whether `uid` holds coarse or fine location */
const permitted = (uid: number) => after(checkUidPermission("android.permission.ACCESS_FINE_LOCATION", uid), fine =>
  fine === 0 || after(checkUidPermission("android.permission.ACCESS_COARSE_LOCATION", uid), coarse => coarse === 0));
/** CallerIdentity.fromBinder, and the location access its call needs */
function enforce(pkg: string | null): Caller | Promise<Caller> {
  const caller = callingIdentity();
  if (!ownedBy(pkg, caller.uid)) throw rt.mkThrowable("java/lang/SecurityException", `invalid package "${pkg}" for uid ${caller.uid}`);
  return after(permitted(caller.uid), allowed => {
    if (allowed) return caller;
    throw rt.mkThrowable("java/lang/SecurityException",
      `uid ${caller.uid} does not have android.permission.ACCESS_COARSE_LOCATION or android.permission.ACCESS_FINE_LOCATION.`);
  });
}
function requireProvider(provider: string | null): string {
  if (!exists(provider)) throw rt.mkThrowable("java/lang/IllegalArgumentException", `provider "${provider}" does not exist`);
  return provider;
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
function lastFix(provider: string): LocationFix | null {
  const fix = geolocation.last;
  return fix && (provider !== "gps" || fix.highAccuracy) && geolocation.enabled ? fix : null;
}

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
type Subscription = { id: number; pid: number; active: boolean; timer: GuestTimer | null; unwatch: () => void };
/** each registration by its listener's binder */
const subscriptions = new Map<unknown, Subscription>();
let nextId = 1;
function unsubscribe(key: unknown): void {
  const subscription = subscriptions.get(key);
  if (!subscription) return;
  subscriptions.delete(key);
  subscription.active = false;
  clearGuestTimeout(subscription.timer);
  subscription.unwatch();
  geolocation.remove(subscription.pid, subscription.id);
}
type Listener = { location(fix: LocationFix): unknown; enabled?(enabled: boolean): unknown; expired?(): unknown };
/** fixes for one registration, throttled by its request as LocationProviderManager throttles them, and
 *  told to its listener in order from a binder thread of system_server's; the caller's death ends it */
function subscribe(key: unknown, { pid, uid }: Caller, provider: string, request: Request, on: Listener): void {
  unsubscribe(key);
  const subscription: Subscription = { id: nextId++, pid, active: true, timer: null, unwatch: onCallerDeath(pid, () => unsubscribe(key)) };
  subscriptions.set(key, subscription);
  let calls: Promise<unknown> = Promise.resolve(), previous: LocationFix | null = null, remaining = request.maxUpdates;
  const call = (work: () => unknown) => { calls = calls.then(() => asSystem(work)).catch(logUncaught); };
  const end = () => { if (!subscription.active) return; unsubscribe(key); if (on.expired) call(on.expired); };
  if (request.duration < 0x7fffffffn) subscription.timer = setSystemTimeout(end, Number(request.duration));
  const start = uptimeMillis();
  const receive = driven(function* (event: LocationEvent): Gen<void> {
    if (!subscription.active) return;
    if (event.kind !== "fix") {
      if (on.enabled && (event.kind === "enabled" || event.code === 1)) yield on.enabled(event.kind === "enabled");
      return;
    }
    const fix = event.fix;
    if (uptimeMillis() - start >= Number(request.duration)) { end(); return; }
    if (!(yield* awaited(permitted(uid)))) { unsubscribe(key); return; }
    if (previous && (fix.monotonic - previous.monotonic < Number(request.minInterval) || (yield* distanceM(previous, fix)) < request.distance)) return;
    previous = fix;
    if (--remaining === 0) unsubscribe(key);
    yield on.location(fix);
  });
  geolocation.subscribe(pid, subscription.id, request.high, provider !== "passive" && request.interval !== PASSIVE_INTERVAL, event => call(() => receive(event)));
}
function* distanceM(a: LocationFix, b: LocationFix): Gen<number> {
  const results = new Float32Array(1);
  yield scall("android/location/Location", "distanceBetween", "(DDDD[F)V", a.latitude, a.longitude, b.latitude, b.longitude, results);
  return results[0];
}
/** LocationManagerService.getProviders: none for a caller without location permission */
function* providerList(criteria: JObj | null, enabledOnly: number): Gen<string[]> {
  if (!(yield* awaited(permitted(callingIdentity().uid)))) return [];
  const out: string[] = [];
  if (enabledOnly && !geolocation.enabled) return out;
  for (const name of providers()) {
    if (criteria && !(yield scall("android/location/LocationProvider", "propertiesMeetCriteria",
      "(Ljava/lang/String;Landroid/location/provider/ProviderProperties;Landroid/location/Criteria;)Z", name, yield* awaited(providerProperties(name)), criteria))) continue;
    out.push(name);
  }
  return out;
}

const LISTENER = "Landroid/location/ILocationListener;";
hostService("location", "webdroid/LocationManagerService", "android/location/ILocationManager$Stub", {
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
  "isLocationEnabledForUser(I)Z": () => +geolocation.enabled,
  "isProviderEnabledForUser(Ljava/lang/String;I)Z": (provider: string | null) => +(exists(provider) && geolocation.enabled),
  "getProviderProperties(Ljava/lang/String;)Landroid/location/provider/ProviderProperties;": (provider: string | null) =>
    providerProperties(requireProvider(provider)),
  "getLastLocation(Ljava/lang/String;Landroid/location/LastLocationRequest;Ljava/lang/String;Ljava/lang/String;)Landroid/location/Location;":
    (provider: string | null, _request: JObj, pkg: string | null) => after(enforce(pkg), () => {
      const fix = exists(provider) ? lastFix(provider) : null;
      return fix && location(fix, provider!);
    }),
  [`registerLocationListener(Ljava/lang/String;Landroid/location/LocationRequest;${LISTENER}Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V`]:
    driven(function* (provider: string | null, request: JObj, listener: JObj, pkg: string | null) {
      const caller = yield* awaited(enforce(pkg)), name = requireProvider(provider);
      subscribe(yield asBinder(listener), caller, name, yield* readRequest(name, request), {
        location: (fix) => after(location(fix, name), (l: JObj) => after(newArrayList([l]), list => vcall(listener, "onLocationChanged", "(Ljava/util/List;Landroid/os/IRemoteCallback;)V", list, null))),
        enabled: (enabled) => vcall(listener, "onProviderEnabledChanged", "(Ljava/lang/String;Z)V", name, +enabled),
      });
    }),
  [`unregisterLocationListener(${LISTENER})V`]: driven(function* (listener: JObj) { unsubscribe(yield asBinder(listener)); }),
  [`requestListenerFlush(Ljava/lang/String;${LISTENER}I)V`]: (_provider: string, listener: JObj, code: number) =>
    oneway(listener, "onFlushComplete", "(I)V", code),
  // one location within the request's duration, or null once it passes
  "getCurrentLocation(Ljava/lang/String;Landroid/location/LocationRequest;Landroid/location/ILocationCallback;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Landroid/os/ICancellationSignal;":
    driven(function* (provider: string | null, request: JObj, callback: JObj, pkg: string | null) {
      const caller = yield* awaited(enforce(pkg)), name = requireProvider(provider);
      const deliver = (value: JObj | null) => vcall(callback, "onLocation", "(Landroid/location/Location;)V", value);
      subscribe(yield asBinder(callback), caller, name, { ...yield* readRequest(name, request), maxUpdates: 1 }, {
        location: (fix) => after(location(fix, name), deliver), expired: () => deliver(null),
      });
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
}, { system: true });
