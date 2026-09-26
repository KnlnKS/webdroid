import { JObj, rt, type NativeSpec, driven, type Gen } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { mangleStaticField } from "../jvm/abi";
import { parcelCreator, type JParcel } from "./parcel";

export const LOCATION_FOREVER = 0x7fffffffffffffffn;
export class JLocationRequest extends JObj {
  provider: string | null = null;
  interval = 0n; quality = 102; expires = LOCATION_FOREVER; duration = LOCATION_FOREVER;
  maxUpdates = 0x7fffffff; minInterval = -1n; distance = 0; maxDelay = 0n;
  hidden = 0; adas = 0; ignored = 0; lowPower = 0; workSource: JObj | null = null;
}
class JLocationRequestBuilder extends JObj { request = new JLocationRequest(); }
const parameters = [
  ["IntervalMillis", "interval", "J", 0], ["Quality", "quality", "I", 0],
  ["DurationMillis", "duration", "J", 1], ["MaxUpdates", "maxUpdates", "I", 1],
  ["MinUpdateIntervalMillis", "minInterval", "J", 0], ["MinUpdateDistanceMeters", "distance", "F", 0],
  ["MaxUpdateDelayMillis", "maxDelay", "J", 0],
] as const;
const requestMethods: NonNullable<NativeSpec["methods"]> = {
  "describeContents()I": () => 0,
  "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JLocationRequest, p: JParcel): Gen {
    yield vcall(p, "writeString", "(Ljava/lang/String;)V", this.provider);
    for (const [field, d, type] of wire) yield vcall(p, "write" + type, `(${d})V`, this[field]);
    yield vcall(p, "writeTypedObject", "(Landroid/os/Parcelable;I)V", this.workSource ?? (yield newObj("android/os/WorkSource")), 0);
  }),
};
const builderMethods: NonNullable<NativeSpec["methods"]> = {
  "<init>(J)V": function (this: JLocationRequestBuilder, interval: bigint) {
    if (interval < 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "negative interval"); this.request.interval = interval;
  },
  "<init>(Landroid/location/LocationRequest;)V": function (this: JLocationRequestBuilder, request: JLocationRequest) { Object.assign(this.request, request); },
  "clearMinUpdateIntervalMillis()Landroid/location/LocationRequest$Builder;": function (this: JLocationRequestBuilder) { this.request.minInterval = -1n; return this; },
  "build()Landroid/location/LocationRequest;": driven(function* (this: JLocationRequestBuilder): Gen {
    if (this.request.interval === LOCATION_FOREVER && this.request.minInterval < 0n)
      throw rt.mkThrowable("java/lang/IllegalStateException", "passive request requires a minimum interval");
    rt.link("android/location/LocationRequest");
    const request = Object.assign(new JLocationRequest(), this.request);
    if (request.minInterval > request.interval) request.minInterval = request.interval;
    request.workSource = yield newObj("android/os/WorkSource", "(Landroid/os/WorkSource;)V", request.workSource);
    return request;
  }),
};
for (const [name, field, d, min] of parameters) {
  requestMethods[`get${name}()${d}`] = function (this: JLocationRequest) {
    return field === "minInterval" ? (this.minInterval < 0n ? this.interval / 6n : this.minInterval < this.interval ? this.minInterval : this.interval) : this[field];
  };
  builderMethods[`set${name}(${d})Landroid/location/LocationRequest$Builder;`] = function (this: JLocationRequestBuilder, value: number | bigint) {
    if (value < min || typeof value === "number" && !Number.isFinite(value) || field === "quality" && value !== 100 && value !== 102 && value !== 104)
      throw rt.mkThrowable("java/lang/IllegalArgumentException", name);
    Object.assign(this.request, { [field]: value }); return this;
  };
}
const wire = [
  ["interval", "J", "Long"], ["quality", "I", "Int"], ["expires", "J", "Long"], ["duration", "J", "Long"],
  ["maxUpdates", "I", "Int"], ["minInterval", "J", "Long"], ["distance", "F", "Float"], ["maxDelay", "J", "Long"],
  ["hidden", "Z", "Boolean"], ["adas", "Z", "Boolean"], ["ignored", "Z", "Boolean"], ["lowPower", "Z", "Boolean"],
] as const;
rt.register({ name: "android/location/LocationRequest", ctor: JLocationRequest, ifaces: ["android/os/Parcelable"], methods: requestMethods,
  statics: { PASSIVE_INTERVAL: LOCATION_FOREVER, QUALITY_HIGH_ACCURACY: 100, QUALITY_BALANCED_POWER_ACCURACY: 102, QUALITY_LOW_POWER: 104,
    get CREATOR() { return parcelCreator("android/location/LocationRequest", async p => {
      const request = new JLocationRequest(); request.provider = await vcall(p, "readString", "()Ljava/lang/String;");
      for (const [field, d, type] of wire) Object.assign(request, { [field]: await vcall(p, "read" + type, `()${d}`) });
      request.workSource = await vcall(p, "readTypedObject", "(Landroid/os/Parcelable$Creator;)Ljava/lang/Object;", rt.link("android/os/WorkSource").ctor[mangleStaticField("CREATOR")]);
      return request;
    }); },
  },
});
rt.register({ name: "android/location/LocationRequest$Builder", ctor: JLocationRequestBuilder, methods: builderMethods });
