// android.location: Location/Criteria value classes and the listener interface apps implement.
// LocationManager itself is a Context system service and lives with the others in app.ts.

import { rt, JObj, type NativeSpec } from "../jvm/runtime";
import { PARCELABLE } from "./os";

rt.register({ name: "android/location/LocationListener", ctor: class extends JObj {} });

class JLocation extends JObj {
  provider: string | null = null;
  lat = 0; lon = 0; time = 0n;
  opt: Record<string, number> = {}; // altitude/accuracy/speed/bearing: present only once set (has*())
}
// AOSP iterates Vincenty on WGS84; haversine is within 0.5% and enough for an app's proximity checks.
function distanceM(a: JLocation, b: JLocation) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
const locMethods: NonNullable<NativeSpec["methods"]> = {
  "<init>(Ljava/lang/String;)V": function (this: JLocation, p: string) { this.provider = p; },
  "getProvider()Ljava/lang/String;": function (this: JLocation) { return this.provider; },
  "setProvider(Ljava/lang/String;)V": function (this: JLocation, p: string) { this.provider = p; },
  "getLatitude()D": function (this: JLocation) { return this.lat; },
  "setLatitude(D)V": function (this: JLocation, v: number) { this.lat = v; },
  "getLongitude()D": function (this: JLocation) { return this.lon; },
  "setLongitude(D)V": function (this: JLocation, v: number) { this.lon = v; },
  "getTime()J": function (this: JLocation) { return this.time; },
  "setTime(J)V": function (this: JLocation, t: bigint) { this.time = t; },
  "distanceTo(Landroid/location/Location;)F": function (this: JLocation, o: JLocation) { return Math.fround(distanceM(this, o)); },
  ...PARCELABLE,
};
for (const [n, d] of [["Altitude", "D"], ["Accuracy", "F"], ["Speed", "F"], ["Bearing", "F"]] as const) {
  locMethods[`get${n}()${d}`] = function (this: JLocation) { return this.opt[n] ?? 0; };
  locMethods[`set${n}(${d})V`] = function (this: JLocation, v: number) { this.opt[n] = v; };
  locMethods[`has${n}()Z`] = function (this: JLocation) { return n in this.opt ? 1 : 0; };
}
rt.register({ name: "android/location/Location", ctor: JLocation, ifaces: ["android/os/Parcelable"], methods: locMethods });

class JCriteria extends JObj { v: Record<string, number> = {}; }
const critMethods: NonNullable<NativeSpec["methods"]> = { "<init>()V": function () {} };
for (const [n, d, get] of [["Accuracy", "I", "get"], ["PowerRequirement", "I", "get"], ["AltitudeRequired", "Z", "is"],
  ["BearingRequired", "Z", "is"], ["SpeedRequired", "Z", "is"], ["CostAllowed", "Z", "is"]] as const) {
  critMethods[`set${n}(${d})V`] = function (this: JCriteria, x: number) { this.v[n] = x; };
  critMethods[`${get}${n}()${d}`] = function (this: JCriteria) { return this.v[n] ?? 0; };
}
rt.register({
  name: "android/location/Criteria", ctor: JCriteria,
  statics: { ACCURACY_FINE: 1, ACCURACY_COARSE: 2, POWER_LOW: 1, POWER_MEDIUM: 2, POWER_HIGH: 3, NO_REQUIREMENT: 0 },
  methods: critMethods,
});
