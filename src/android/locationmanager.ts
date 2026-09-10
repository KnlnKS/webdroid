import { JObj, rt } from "../jvm/runtime";
import { newArrayList } from "../jvm/natives/jutil";
import { vcall } from "../jvm/natives/jlang";
import { JFnRunnable, mainLooper, reportUncaught, bootTime, uptimeMillis } from "./os";
import { JLocation, distanceM } from "./location";
import { JLocationRequest, LOCATION_FOREVER } from "./locationrequest";
import type { LocationEvent, LocationFix } from "../shell/geolocation";

export const locationTransport = {
  available: () => false, enabled: () => false, last: (): LocationFix | null => null,
  subscribe: (_id: number, _high: boolean, _active: boolean, _receive: (event: LocationEvent) => void) => {},
  remove: (_id: number) => {},
};
const providers = () => locationTransport.available() ? ["gps", "network", "passive"] : [];
function location(fix: LocationFix, provider: string): JLocation {
  rt.link("android/location/Location");
  const value = new JLocation(); value.provider = provider === "passive" ? fix.highAccuracy ? "gps" : "network" : provider;
  value.lat = fix.latitude; value.lon = fix.longitude; value.time = BigInt(Math.floor(fix.timestamp));
  value.elapsed = BigInt(Math.max(0, Math.floor((fix.monotonic - bootTime) * 1e6)));
  value.opt.Accuracy = Math.fround(fix.accuracy);
  if (fix.altitude !== null) value.opt.Altitude = fix.altitude;
  if (fix.altitudeAccuracy !== null) value.opt.VerticalAccuracy = Math.fround(fix.altitudeAccuracy);
  if (fix.speed !== null) value.opt.Speed = Math.fround(fix.speed);
  if (fix.heading !== null && Number.isFinite(fix.heading)) value.opt.Bearing = Math.fround(fix.heading);
  return value;
}
type Subscription = { id: number; active: boolean; timer: ReturnType<typeof setTimeout> | null };
const listeners = new Map<JObj, Map<string, Subscription>>();
let nextId = 1;
function remove(listener: JObj, provider?: string) {
  const requests = listeners.get(listener);
  if (!requests) return;
  for (const [name, request] of requests) if (!provider || provider === name) {
    request.active = false; if (request.timer !== null) clearTimeout(request.timer);
    locationTransport.remove(request.id); requests.delete(name);
  }
  if (!requests.size) listeners.delete(listener);
}
function subscribe(provider: string, request: JLocationRequest, listener: JObj, dispatch: (job: () => Promise<void>) => void) {
  if (!listener) throw rt.mkThrowable("java/lang/IllegalArgumentException", "listener must not be null");
  if (!providers().includes(provider)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "unknown location provider: " + provider);
  remove(listener, provider);
  const subscription: Subscription = { id: nextId++, active: true, timer: null };
  let requests = listeners.get(listener); if (!requests) listeners.set(listener, requests = new Map());
  requests.set(provider, subscription);
  const start = uptimeMillis(), interval = Number(request.minInterval < 0n ? request.interval / 6n : request.minInterval);
  let previous: LocationFix | null = null, remaining = request.maxUpdates;
  if (request.duration < 0x7fffffffn) subscription.timer = setTimeout(() => remove(listener, provider), Number(request.duration));
  locationTransport.subscribe(subscription.id, provider === "gps" || request.quality === 100, provider !== "passive" && request.interval !== LOCATION_FOREVER, event => {
    if (!subscription.active) return;
    if (event.kind === "error") {
      if (event.code === 1) dispatch(async () => { if (subscription.active) await vcall(listener, "onProviderDisabled", "(Ljava/lang/String;)V", provider); });
      return;
    }
    const fix = event.fix;
    if (uptimeMillis() - start >= Number(request.duration)) { remove(listener, provider); return; }
    if (previous) {
      if (fix.monotonic - previous.monotonic < interval) return;
      if (distanceM(previous.latitude, previous.longitude, fix.latitude, fix.longitude) < request.distance) return;
    }
    previous = fix;
    dispatch(async () => {
      if (!subscription.active) return;
      await vcall(listener, "onLocationChanged", "(Landroid/location/Location;)V", location(fix, provider));
      if (--remaining === 0 && subscription.active) remove(listener, provider);
    });
  });
}
function onLooper(looper: typeof mainLooper = mainLooper) {
  return (job: () => Promise<void>) => { void looper.run(job).catch(reportUncaught); };
}
function legacy(provider: string, interval: bigint, distance: number, listener: JObj, looper: typeof mainLooper = mainLooper) {
  const request = new JLocationRequest(); request.interval = interval < 0n ? 0n : interval;
  request.minInterval = request.interval; request.distance = Math.max(0, distance);
  subscribe(provider, request, listener, onLooper(looper ?? mainLooper));
}
class JLocationProvider extends JObj { name = "network"; }
rt.register({ name: "android/location/LocationProvider", ctor: JLocationProvider, methods: {
  "getName()Ljava/lang/String;": function (this: JLocationProvider) { return this.name; },
  "getAccuracy()I": function (this: JLocationProvider) { return this.name === "gps" ? 1 : 2; },
  "getPowerRequirement()I": function (this: JLocationProvider) { return this.name === "gps" ? 3 : 1; },
  "requiresNetwork()Z": () => 1, "requiresSatellite()Z": () => 0, "requiresCell()Z": () => 0,
  "hasMonetaryCost()Z": () => 0, "supportsAltitude()Z": () => 1, "supportsSpeed()Z": () => 1, "supportsBearing()Z": () => 1,
} });
rt.register({ name: "android/location/LocationManager", ctor: class extends JObj {},
  statics: { GPS_PROVIDER: "gps", NETWORK_PROVIDER: "network", PASSIVE_PROVIDER: "passive", FUSED_PROVIDER: "fused" }, methods: {
    "isLocationEnabled()Z": () => +locationTransport.enabled(),
    "hasProvider(Ljava/lang/String;)Z": (provider: string) => +providers().includes(provider),
    "isProviderEnabled(Ljava/lang/String;)Z": (provider: string) => +(providers().includes(provider) && locationTransport.enabled()),
    "getProvider(Ljava/lang/String;)Landroid/location/LocationProvider;": (name: string) => {
      if (!providers().includes(name)) return null;
      rt.link("android/location/LocationProvider"); const provider = new JLocationProvider(); provider.name = name; return provider;
    },
    "getAllProviders()Ljava/util/List;": () => newArrayList(providers()),
    "getProviders(Z)Ljava/util/List;": (enabled: number) => newArrayList(enabled && !locationTransport.enabled() ? [] : providers()),
    "getProviders(Landroid/location/Criteria;Z)Ljava/util/List;": (_criteria: unknown, enabled: number) => newArrayList(enabled && !locationTransport.enabled() ? [] : providers().filter(p => p !== "passive")),
    "getBestProvider(Landroid/location/Criteria;Z)Ljava/lang/String;": (_criteria: unknown, enabled: number) => locationTransport.available() && (!enabled || locationTransport.enabled()) ? "network" : null,
    "getLastKnownLocation(Ljava/lang/String;)Landroid/location/Location;": (provider: string) => {
      const fix = locationTransport.last(); return providers().includes(provider) && fix && (provider !== "gps" || fix.highAccuracy) && locationTransport.enabled() ? location(fix, provider) : null;
    },
    "requestLocationUpdates(Ljava/lang/String;JFLandroid/location/LocationListener;)V": legacy,
    "requestLocationUpdates(Ljava/lang/String;JFLandroid/location/LocationListener;Landroid/os/Looper;)V": legacy,
    "requestLocationUpdates(Ljava/lang/String;Landroid/location/LocationRequest;Ljava/util/concurrent/Executor;Landroid/location/LocationListener;)V":
      (provider: string, request: JLocationRequest, executor: JObj, listener: JObj) => {
        if (!executor) throw rt.mkThrowable("java/lang/NullPointerException", "executor");
        subscribe(provider, request, listener, job => {
          rt.link("webdroid/FnRunnable"); const runnable = new JFnRunnable(); runnable.fn = job;
          void vcall(executor, "execute", "(Ljava/lang/Runnable;)V", runnable).catch(reportUncaught);
        });
      },
    "requestLocationUpdates(Ljava/lang/String;Landroid/location/LocationRequest;Landroid/os/Looper;Landroid/location/LocationListener;)V":
      (provider: string, request: JLocationRequest, looper: typeof mainLooper, listener: JObj) => subscribe(provider, request, listener, onLooper(looper ?? mainLooper)),
    "removeUpdates(Landroid/location/LocationListener;)V": (listener: JObj) => remove(listener),
  },
});
