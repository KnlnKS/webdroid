import { rt, JObj, type NativeSpec, maySuspend } from "../jvm/runtime";
import { JBundle, uptimeMillis } from "./os";
import { parcelCreator, type JParcel } from "./parcel";
import { newObj, vcall } from "../jvm/natives/jlang";

rt.register({ name: "android/location/LocationListener", ctor: class extends JObj {} });

export class JLocation extends JObj {
  provider: string | null = null;
  lat = 0; lon = 0; time = 0n; elapsed = 0n; mock = false;
  extras: JBundle | null = null;
  opt: Record<string, number> = {};
  async set(source: JLocation) {
    this.provider = source.provider; this.lat = source.lat; this.lon = source.lon;
    this.time = source.time; this.elapsed = source.elapsed; this.mock = source.mock;
    this.opt = { ...source.opt };
    this.extras = source.extras ? await newObj("android/os/Bundle", "(Landroid/os/Bundle;)V", source.extras) as JBundle : null;
  }
}
// AOSP iterates Vincenty on WGS84; haversine is within 0.5% and enough for an app's proximity checks.
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, h)));
}
const optional = [
  ["ElapsedRealtimeUncertaintyNanos", "", "D", 256], ["Altitude", "", "D", 1],
  ["Speed", "", "F", 2], ["Bearing", "", "F", 4], ["Accuracy", "", "F", 8],
  ["VerticalAccuracy", "Meters", "F", 32], ["SpeedAccuracy", "MetersPerSecond", "F", 64],
  ["BearingAccuracy", "Degrees", "F", 128],
] as const;
const locMethods: NonNullable<NativeSpec["methods"]> = {
  "<init>(Ljava/lang/String;)V": function (this: JLocation, p: string) { this.provider = p; },
  "<init>(Landroid/location/Location;)V": maySuspend(function (this: JLocation, source: JLocation) { return this.set(source); }),
  "set(Landroid/location/Location;)V": maySuspend(function (this: JLocation, source: JLocation) { return this.set(source); }),
  "reset()V": function (this: JLocation) {
    this.provider = null; this.lat = this.lon = 0; this.time = this.elapsed = 0n;
    this.mock = false; this.opt = {}; this.extras = null;
  },
  "getElapsedRealtimeNanos()J": function (this: JLocation) { return this.elapsed; },
  "getElapsedRealtimeMillis()J": function (this: JLocation) { return this.elapsed / 1000000n; },
  "getElapsedRealtimeAgeMillis()J": function (this: JLocation) { return BigInt(Math.floor(uptimeMillis())) - this.elapsed / 1000000n; },
  "getElapsedRealtimeAgeMillis(J)J": function (this: JLocation, now: bigint) { return now - this.elapsed / 1000000n; },
  "setElapsedRealtimeNanos(J)V": function (this: JLocation, value: bigint) { this.elapsed = value; },
  "isMock()Z": function (this: JLocation) { return +this.mock; },
  "isFromMockProvider()Z": function (this: JLocation) { return +this.mock; },
  "setMock(Z)V": function (this: JLocation, value: number) { this.mock = !!value; },
  "setIsFromMockProvider(Z)V": function (this: JLocation, value: number) { this.mock = !!value; },
  "getExtras()Landroid/os/Bundle;": function (this: JLocation) { return this.extras; },
  "setExtras(Landroid/os/Bundle;)V": async function (this: JLocation, value: JBundle | null) {
    this.extras = value ? await newObj("android/os/Bundle", "(Landroid/os/Bundle;)V", value) as JBundle : null;
  },
  "isComplete()Z": function (this: JLocation) { return +(this.provider !== null && "Accuracy" in this.opt && this.time !== 0n && this.elapsed !== 0n); },
  "getProvider()Ljava/lang/String;": function (this: JLocation) { return this.provider; },
  "setProvider(Ljava/lang/String;)V": function (this: JLocation, p: string) { this.provider = p; },
  "getLatitude()D": function (this: JLocation) { return this.lat; },
  "setLatitude(D)V": function (this: JLocation, v: number) { this.lat = v; },
  "getLongitude()D": function (this: JLocation) { return this.lon; },
  "setLongitude(D)V": function (this: JLocation, v: number) { this.lon = v; },
  "getTime()J": function (this: JLocation) { return this.time; },
  "setTime(J)V": function (this: JLocation, t: bigint) { this.time = t; },
  "distanceTo(Landroid/location/Location;)F": function (this: JLocation, o: JLocation) { return Math.fround(distanceM(this.lat, this.lon, o.lat, o.lon)); },
  "describeContents()I": () => 0,
  "writeToParcel(Landroid/os/Parcel;I)V": async function (this: JLocation, p: JParcel) {
    await vcall(p, "writeString8", "(Ljava/lang/String;)V", this.provider);
    let mask = this.mock ? 16 : 0;
    for (const [name, , , bit] of optional) if (name in this.opt) mask |= bit;
    await vcall(p, "writeInt", "(I)V", mask);
    await vcall(p, "writeLong", "(J)V", this.time);
    await vcall(p, "writeLong", "(J)V", this.elapsed);
    if (mask & 256) await vcall(p, "writeDouble", "(D)V", this.opt.ElapsedRealtimeUncertaintyNanos);
    await vcall(p, "writeDouble", "(D)V", this.lat);
    await vcall(p, "writeDouble", "(D)V", this.lon);
    for (const [name, , d, bit] of optional) if (bit !== 256 && mask & bit)
      await vcall(p, d === "D" ? "writeDouble" : "writeFloat", `(${d})V`, this.opt[name]);
    await vcall(p, "writeBundle", "(Landroid/os/Bundle;)V", this.extras);
  },
};
for (const [name, suffix, d] of optional) {
  locMethods[`get${name}${suffix}()${d}`] = function (this: JLocation) { return this.opt[name] ?? 0; };
  locMethods[`set${name}${suffix}(${d})V`] = function (this: JLocation, v: number) {
    if (name === "Bearing") {
      if (!Number.isFinite(v)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "bearing must be finite");
      v = Math.fround(v % 360) + 0; if (v < 0) v = Math.fround(v + 360);
    }
    this.opt[name] = d === "F" ? Math.fround(v) : v;
  };
  locMethods[`has${name}()Z`] = function (this: JLocation) { return +(name in this.opt); };
  locMethods[`remove${name}()V`] = function (this: JLocation) { delete this.opt[name]; };
}
rt.register({ name: "android/location/Location", ctor: JLocation, ifaces: ["android/os/Parcelable"], methods: locMethods,
  statics: { get CREATOR() { return parcelCreator("android/location/Location", async (p) => {
    const location = new JLocation();
    location.provider = await vcall(p, "readString8", "()Ljava/lang/String;");
    const mask: number = await vcall(p, "readInt", "()I"); location.mock = !!(mask & 16);
    location.time = await vcall(p, "readLong", "()J");
    location.elapsed = await vcall(p, "readLong", "()J");
    if (mask & 256) location.opt.ElapsedRealtimeUncertaintyNanos = await vcall(p, "readDouble", "()D");
    location.lat = await vcall(p, "readDouble", "()D");
    location.lon = await vcall(p, "readDouble", "()D");
    for (const [name, , d, bit] of optional) if (bit !== 256 && mask & bit)
      location.opt[name] = await vcall(p, d === "D" ? "readDouble" : "readFloat", `()${d}`);
    location.extras = await vcall(p, "readBundle", "()Landroid/os/Bundle;");
    return location;
  }); } },
});

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
