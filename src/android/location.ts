import { rt, JObj, type NativeSpec, maySuspend, fieldGetters, fieldSetters, flagSetters } from "../jvm/runtime";
import { JBundle, uptimeMillis } from "./os";
import { parcelCreator, type JParcel } from "./parcel";
import { newObj, vcall } from "../jvm/natives/jlang";

rt.markers("android/location/LocationListener");

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
const geodesicCache = { lat1: NaN, lon1: NaN, lat2: NaN, lon2: NaN, distance: 0, initial: 0, final: 0 };
function geodesic(lat1: number, lon1: number, lat2: number, lon2: number) {
  const out = geodesicCache;
  if (lat1 === out.lat1 && lon1 === out.lon1 && lat2 === out.lat2 && lon2 === out.lon2) return out;
  const radians = Math.PI / 180, major = 6378137, minor = 6356752.3142, flattening = (major - minor) / major;
  const reduced1 = Math.atan((1 - flattening) * Math.tan(lat1 * radians)), reduced2 = Math.atan((1 - flattening) * Math.tan(lat2 * radians));
  const c1 = Math.cos(reduced1), c2 = Math.cos(reduced2), s1 = Math.sin(reduced1), s2 = Math.sin(reduced2);
  const longitude = lon2 * radians - lon1 * radians;
  let lambda = longitude, sinLambda = 0, cosLambda = 0, sigma = 0, correction = 0, scale = 0;
  for (let iteration = 0; iteration < 20; iteration++) {
    const previous = lambda;
    sinLambda = Math.sin(lambda); cosLambda = Math.cos(lambda);
    const x = c2 * sinLambda, y = c1 * s2 - s1 * c2 * cosLambda;
    const sinSigma = Math.sqrt(x * x + y * y), cosSigma = s1 * s2 + c1 * c2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = sinSigma === 0 ? 0 : c1 * c2 * sinLambda / sinSigma, cosAlpha2 = 1 - sinAlpha * sinAlpha;
    const midpoint = cosAlpha2 === 0 ? 0 : cosSigma - 2 * s1 * s2 / cosAlpha2, midpoint2 = midpoint * midpoint;
    const u = cosAlpha2 * ((major * major - minor * minor) / (minor * minor));
    scale = 1 + u / 16384 * (4096 + u * (-768 + u * (320 - 175 * u)));
    const b = u / 1024 * (256 + u * (-128 + u * (74 - 47 * u)));
    const c = flattening / 16 * cosAlpha2 * (4 + flattening * (4 - 3 * cosAlpha2));
    correction = b * sinSigma * (midpoint + b / 4 * (cosSigma * (-1 + 2 * midpoint2) - b / 6 * midpoint * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * midpoint2)));
    lambda = longitude + (1 - c) * flattening * sinAlpha * (sigma + c * sinSigma * (midpoint + c * cosSigma * (-1 + 2 * midpoint2)));
    if (Math.abs((lambda - previous) / lambda) < 1e-12) break;
  }
  out.lat1 = lat1; out.lon1 = lon1; out.lat2 = lat2; out.lon2 = lon2;
  out.distance = Math.fround(minor * scale * (sigma - correction));
  out.initial = Math.fround(Math.fround(Math.atan2(c2 * sinLambda, c1 * s2 - s1 * c2 * cosLambda)) * (180 / Math.PI));
  out.final = Math.fround(Math.fround(Math.atan2(c1 * sinLambda, -s1 * c2 + c1 * s2 * cosLambda)) * (180 / Math.PI));
  return out;
}
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number { return geodesic(lat1, lon1, lat2, lon2).distance; }
const optional = [
  ["ElapsedRealtimeUncertaintyNanos", "", "D", 256], ["Altitude", "", "D", 1],
  ["Speed", "", "F", 2], ["Bearing", "", "F", 4], ["Accuracy", "", "F", 8],
  ["VerticalAccuracy", "Meters", "F", 32], ["SpeedAccuracy", "MetersPerSecond", "F", 64],
  ["BearingAccuracy", "Degrees", "F", 128],
] as const;
const locMethods: NonNullable<NativeSpec["methods"]> = {
  "<init>(Landroid/location/Location;)V": maySuspend(function (this: JLocation, source: JLocation) { return this.set(source); }),
  "set(Landroid/location/Location;)V": maySuspend(function (this: JLocation, source: JLocation) { return this.set(source); }),
  "reset()V": function (this: JLocation) {
    this.provider = null; this.lat = this.lon = 0; this.time = this.elapsed = 0n;
    this.mock = false; this.opt = {}; this.extras = null;
  },
  "getElapsedRealtimeMillis()J": function (this: JLocation) { return this.elapsed / 1000000n; },
  "getElapsedRealtimeAgeMillis()J": function (this: JLocation) { return BigInt(Math.floor(uptimeMillis())) - this.elapsed / 1000000n; },
  "getElapsedRealtimeAgeMillis(J)J": function (this: JLocation, now: bigint) { return now - this.elapsed / 1000000n; },
  "isMock()Z": function (this: JLocation) { return +this.mock; },
  "isFromMockProvider()Z": function (this: JLocation) { return +this.mock; },
  "setExtras(Landroid/os/Bundle;)V": async function (this: JLocation, value: JBundle | null) {
    this.extras = value ? await newObj("android/os/Bundle", "(Landroid/os/Bundle;)V", value) as JBundle : null;
  },
  "isComplete()Z": function (this: JLocation) { return +(this.provider !== null && "Accuracy" in this.opt && this.time !== 0n && this.elapsed !== 0n); },
  ...fieldSetters({ "<init>(Ljava/lang/String;)V": "provider", "setElapsedRealtimeNanos(J)V": "elapsed",
    "setProvider(Ljava/lang/String;)V": "provider", "setLatitude(D)V": "lat", "setLongitude(D)V": "lon",
    "setTime(J)V": "time" }),
  ...fieldGetters({ "getElapsedRealtimeNanos()J": "elapsed", "getExtras()Landroid/os/Bundle;": "extras",
    "getProvider()Ljava/lang/String;": "provider", "getLatitude()D": "lat", "getLongitude()D": "lon",
    "getTime()J": "time" }),
  ...flagSetters({ "setMock(Z)V": "mock", "setIsFromMockProvider(Z)V": "mock" }),
  "distanceTo(Landroid/location/Location;)F": function (this: JLocation, o: JLocation) { return distanceM(this.lat, this.lon, o.lat, o.lon); },
  "bearingTo(Landroid/location/Location;)F": function (this: JLocation, o: JLocation) { return geodesic(this.lat, this.lon, o.lat, o.lon).initial; },
  "static distanceBetween(DDDD[F)V": (lat1: number, lon1: number, lat2: number, lon2: number, results: Float32Array | null) => {
    if (!results?.length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "results must have length >= 1");
    const value = geodesic(lat1, lon1, lat2, lon2); results[0] = value.distance;
    if (results.length > 1) results[1] = value.initial; if (results.length > 2) results[2] = value.final;
  },
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
