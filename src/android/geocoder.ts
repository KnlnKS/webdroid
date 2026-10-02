// Geocoding as the platform does it: Geocoder asks the installed GeocodeProvider service
// (com.android.location.service.GeocodeProvider; microG's here), bound by the platform itself,
// and Address results cross back over binder.

import { rt, JObj, driven, type Gen } from "../jvm/runtime";
import { newObj, vcall, vcallUncaught, after } from "../jvm/natives/jlang";
import { newArrayList, toJsArray } from "../jvm/natives/jcoll";
import { type JLocale, defaultLocale } from "../jvm/natives/jvalues";
import { JBinder, INTERFACE_TRANSACTION } from "./binder";
import { JParcel, readDouble, readInt, readString, writeDouble, writeInt, writeString } from "./parcel";
import { parcelCreator } from "./parcelable";
import { type JBundle, PROCESS_PID, PROCESS_UID } from "./os";
import { resolveService } from "./pm";
import { appHost } from "./apphost";
import { bindAsSystem } from "./server/activeservices";
import type { JIntent, JComponentName } from "./intent";

const FIELDS = ["FeatureName", "AdminArea", "SubAdminArea", "Locality", "SubLocality", "Thoroughfare", "SubThoroughfare",
  "Premises", "PostalCode", "CountryCode", "CountryName"] as const;
class JAddress extends JObj {
  locale: JLocale | null = null;
  lines = new Map<number, string>();
  text: Record<string, string | null> = {};
  lat: number | null = null; lon: number | null = null;
  phone: string | null = null; url: string | null = null; extras: JBundle | null = null;
}
/** a Locale as Address and GeocoderParams parcel it: its language, then its country */
function readLocale(p: JParcel): Promise<JLocale> {
  const language = readString(p) ?? "", country = readString(p) ?? "";
  return newObj("java/util/Locale", "(Ljava/lang/String;Ljava/lang/String;)V", language, country);
}
const writeLocale = driven(function* writeLocale(p: JParcel, locale: JLocale | null): Gen {
  writeString(p, locale && (yield vcall(locale, "getLanguage", "()Ljava/lang/String;")));
  writeString(p, locale && (yield vcall(locale, "getCountry", "()Ljava/lang/String;")));
});
const coordinateOf = (v: number | null, name: string) => {
  if (v === null) throw rt.mkThrowable("java/lang/IllegalStateException", name + " not set");
  return v;
};
const addressMethods: Record<string, (...a: never[]) => unknown> = {
  "<init>(Ljava/util/Locale;)V": function (this: JAddress, l: JLocale) { this.locale = l; },
  "getLocale()Ljava/util/Locale;": function (this: JAddress) { return this.locale; },
  "getMaxAddressLineIndex()I": function (this: JAddress) { return this.lines.size ? Math.max(...this.lines.keys()) : -1; },
  "getAddressLine(I)Ljava/lang/String;": function (this: JAddress, i: number) {
    if (i < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "index = " + i + " < 0");
    return this.lines.get(i) ?? null;
  },
  "setAddressLine(ILjava/lang/String;)V": function (this: JAddress, i: number, line: string | null) {
    if (i < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "index = " + i + " < 0");
    if (line === null) this.lines.delete(i); else this.lines.set(i, line);
  },
  "hasLatitude()Z": function (this: JAddress) { return +(this.lat !== null); },
  "getLatitude()D": function (this: JAddress) { return coordinateOf(this.lat, "Latitude"); },
  "setLatitude(D)V": function (this: JAddress, v: number) { this.lat = v; },
  "clearLatitude()V": function (this: JAddress) { this.lat = null; },
  "hasLongitude()Z": function (this: JAddress) { return +(this.lon !== null); },
  "getLongitude()D": function (this: JAddress) { return coordinateOf(this.lon, "Longitude"); },
  "setLongitude(D)V": function (this: JAddress, v: number) { this.lon = v; },
  "clearLongitude()V": function (this: JAddress) { this.lon = null; },
  "getPhone()Ljava/lang/String;": function (this: JAddress) { return this.phone; },
  "setPhone(Ljava/lang/String;)V": function (this: JAddress, v: string | null) { this.phone = v; },
  "getUrl()Ljava/lang/String;": function (this: JAddress) { return this.url; },
  "setUrl(Ljava/lang/String;)V": function (this: JAddress, v: string | null) { this.url = v; },
  "getExtras()Landroid/os/Bundle;": function (this: JAddress) { return this.extras; },
  "setExtras(Landroid/os/Bundle;)V": driven(function* (this: JAddress, v: JBundle | null): Gen {
    this.extras = v ? yield newObj("android/os/Bundle", "(Landroid/os/Bundle;)V", v) : null;
  }),
  "describeContents()I": function (this: JAddress) { return this.extras ? 1 : 0; },
  "toString()Ljava/lang/String;": function (this: JAddress) {
    const lines = [...this.lines].sort(([a], [b]) => a - b).map(([i, l]) => `${i}:"${l}"`).join(",");
    return `Address[addressLines=[${lines}],` + FIELDS.map((f) => `${f[0].toLowerCase() + f.slice(1)}=${this.text[f] ?? null}`).join(",") +
      `,hasLatitude=${this.lat !== null},latitude=${this.lat ?? 0},hasLongitude=${this.lon !== null},longitude=${this.lon ?? 0},phone=${this.phone},url=${this.url},extras=${this.extras}]`;
  },
  // Address.writeToParcel's layout
  "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JAddress, p: JParcel): Gen {
    yield writeLocale(p, this.locale);
    writeInt(p, this.lines.size);
    for (const [i, line] of this.lines) { writeInt(p, i); writeString(p, line); }
    for (const f of FIELDS) writeString(p, this.text[f] ?? null);
    for (const v of [this.lat, this.lon]) { writeInt(p, +(v !== null)); if (v !== null) writeDouble(p, v); }
    writeString(p, this.phone); writeString(p, this.url);
    return vcall(p, "writeBundle", "(Landroid/os/Bundle;)V", this.extras);
  }),
};
for (const f of FIELDS) {
  addressMethods[`get${f}()Ljava/lang/String;`] = function (this: JAddress) { return this.text[f] ?? null; };
  addressMethods[`set${f}(Ljava/lang/String;)V`] = function (this: JAddress, v: string | null) { this.text[f] = v; };
}
const readAddress = driven(function* readAddress(p: JParcel): Gen<JAddress> {
  const a: JAddress = rt.make("android/location/Address");
  a.locale = yield readLocale(p);
  for (let n = readInt(p); n > 0; n--) a.lines.set(readInt(p), readString(p) ?? "");
  for (const f of FIELDS) a.text[f] = readString(p);
  if (readInt(p)) a.lat = readDouble(p);
  if (readInt(p)) a.lon = readDouble(p);
  a.phone = readString(p); a.url = readString(p);
  a.extras = yield vcall(p, "readBundle", "()Landroid/os/Bundle;");
  return a;
});
rt.register({
  name: "android/location/Address", ctor: JAddress, ifaces: ["android/os/Parcelable"], methods: addressMethods,
  statics: { get CREATOR() { return parcelCreator("android/location/Address", readAddress); } },
});

class JGeocoderParams extends JObj { locale: JLocale | null = null; pkg: string | null = null; uid = PROCESS_UID; }
function initParams(this: JGeocoderParams, context: JObj | null, l: JLocale | null) {
  if (!context || !l) return rt.npe();
  this.locale = l; this.pkg = appHost?.pkg ?? null;
}
const readParams = driven(function* readParams(p: JParcel): Gen<JGeocoderParams> {
  const params: JGeocoderParams = rt.make("android/location/GeocoderParams"), locale = readLocale(p);
  params.pkg = readString(p); params.uid = readInt(p);
  params.locale = yield locale;
  return params;
});
rt.register({
  name: "android/location/GeocoderParams", ctor: JGeocoderParams, ifaces: ["android/os/Parcelable"],
  methods: {
    "<init>(Landroid/content/Context;Ljava/util/Locale;)V": initParams,
    "getLocale()Ljava/util/Locale;": function (this: JGeocoderParams) { return this.locale; },
    "getClientPackage()Ljava/lang/String;": function (this: JGeocoderParams) { return this.pkg; },
    "getClientUid()I": function (this: JGeocoderParams) { return this.uid; },
    "getClientAttributionTag()Ljava/lang/String;": () => null,
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JGeocoderParams, p: JParcel): Gen {
      yield writeLocale(p, this.locale); writeString(p, this.pkg); writeInt(p, this.uid);
    }),
  },
  statics: { get CREATOR() { return parcelCreator("android/location/GeocoderParams", readParams); } },
});

// ── the provider side: com.android.location.provider.GeocodeProvider, the platform library a
// geocode service extends; its binder calls the subclass's onGetFromLocation[Name]
const DESCRIPTOR = "android.location.IGeocodeProvider", BY_LOCATION = 1, BY_NAME = 2;
class JGeocodeBinder extends JBinder { provider: unknown = null; }
rt.register({
  name: "webdroid/GeocodeProviderBinder", ctor: JGeocodeBinder, sup: "android/os/Binder",
  methods: {
    "onTransact(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z": driven(function* (this: JGeocodeBinder, code: number, data: JParcel, reply: JParcel | null): Gen {
      if (code === INTERFACE_TRANSACTION && reply) { writeString(reply, DESCRIPTOR); return 1; }
      if (code !== BY_LOCATION && code !== BY_NAME || !reply) return 0;
      yield vcall(data, "enforceInterface", "(Ljava/lang/String;)V", DESCRIPTOR);
      const name = code === BY_NAME ? readString(data) : null;
      const coords: number[] = [];
      for (let i = code === BY_NAME ? 4 : 2; i > 0; i--) coords.push(readDouble(data));
      const max = readInt(data);
      const params = readParams(data);
      const results = newArrayList();
      const error: string | null = code === BY_NAME
        ? yield vcall(this.provider, "onGetFromLocationName", "(Ljava/lang/String;DDDDILandroid/location/GeocoderParams;Ljava/util/List;)Ljava/lang/String;", name, ...coords, max, params, results)
        : yield vcall(this.provider, "onGetFromLocation", "(DDILandroid/location/GeocoderParams;Ljava/util/List;)Ljava/lang/String;", ...coords, max, params, results);
      writeString(reply, error);
      const addresses = (yield toJsArray(results)) as JAddress[];
      writeInt(reply, addresses.length);
      for (const a of addresses) yield vcall(a, "writeToParcel", "(Landroid/os/Parcel;I)V", reply, 0);
      return 1;
    }),
  },
});
class JGeocodeProvider extends JObj { binder: JGeocodeBinder | null = null; }
rt.register({
  name: "com/android/location/provider/GeocodeProvider", ctor: JGeocodeProvider,
  methods: {
    "<init>()V": function (this: JGeocodeProvider) {
      const binder: JGeocodeBinder = this.binder = rt.make("webdroid/GeocodeProviderBinder");
      binder.provider = this; binder.descriptor = DESCRIPTOR;
    },
    "getBinder()Landroid/os/IBinder;": function (this: JGeocodeProvider) { return this.binder; },
  },
});

// ── the client side
const PROVIDER_ACTION = "com.android.location.service.GeocodeProvider";
let providerBinder: Promise<JObj> | null = null;
function* providerComponent(): Gen<JComponentName | null> {
  const intent: JIntent = yield newObj("android/content/Intent", "(Ljava/lang/String;)V", PROVIDER_ACTION);
  const first = yield resolveService(intent);
  return first ? yield newObj("android/content/ComponentName", "(Ljava/lang/String;Ljava/lang/String;)V", first.owner.pkg, first.name) : null;
}
/** the provider's binder, bound once for the process as the platform keeps it bound */
function provider(): Promise<JObj> {
  return providerBinder ??= Promise.resolve(rt.drive(function* (): Gen<JObj> {
    const component = yield* providerComponent();
    if (!component) throw rt.mkThrowable("java/io/IOException", "Service not Available");
    return (yield bindAsSystem(component, "geocoder:" + PROCESS_PID)).binder;
  }())).catch((e) => { providerBinder = null; throw e; });
}
class JGeocoder extends JObj { params: JGeocoderParams | null = null; }
const geocode = driven(function* (g: JGeocoder, name: string | null, coords: number[], code: number, max: number): Gen<unknown> {
  if (max < 1) throw rt.mkThrowable("java/lang/IllegalArgumentException", "maxResults must be positive: " + max);
  rt.link("android/os/Parcel");
  const data = new JParcel(), reply = new JParcel();
  writeString(data, DESCRIPTOR);
  if (code === BY_NAME) writeString(data, name);
  for (const v of coords) writeDouble(data, v);
  writeInt(data, max);
  yield vcall(g.params, "writeToParcel", "(Landroid/os/Parcel;I)V", data, 0);
  yield vcall(yield provider(), "transact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z", code, data, reply, 0);
  const error = readString(reply);
  if (error !== null) throw rt.mkThrowable("java/io/IOException", error);
  const results: JAddress[] = [];
  for (let n = readInt(reply); n > 0; n--) results.push(yield readAddress(reply));
  return newArrayList(results.slice(0, max));
});
const coordinate = (value: number, limit: number) => {
  if (!Number.isFinite(value) || Math.abs(value) > limit) throw rt.mkThrowable("java/lang/IllegalArgumentException", `invalid coordinate: ${value}`);
};
const byLocation = (g: JGeocoder, lat: number, lon: number, max: number) => {
  coordinate(lat, 90); coordinate(lon, 180);
  return geocode(g, null, [lat, lon], BY_LOCATION, max);
};
const byName = (g: JGeocoder, name: string | null, max: number, bounds = [0, 0, 0, 0]) => {
  if (name === null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "locationName == null");
  for (let i = 0; i < 4; i++) coordinate(bounds[i], i % 2 ? 180 : 90);
  return geocode(g, name, bounds, BY_NAME, max);
};
/** the listener forms: results, or onError with the failure's message */
function deliver(listener: unknown, lookup: unknown): void {
  if (listener === null) rt.npe();
  Promise.resolve(lookup).then((list) => vcallUncaught(listener, "onGeocode", "(Ljava/util/List;)V", list),
    (e) => vcallUncaught(listener, "onError", "(Ljava/lang/String;)V", (e as { msg?: string }).msg ?? null));
}
function initGeocoder(this: JGeocoder, context: JObj | null, l: JLocale | null) {
  initParams.call(this.params = rt.make("android/location/GeocoderParams"), context, l);
}
// onError is a default method that ignores the failure
rt.register({ name: "android/location/Geocoder$GeocodeListener", ctor: class extends JObj {}, methods: { "onError(Ljava/lang/String;)V": () => {} } });
rt.register({
  name: "android/location/Geocoder", ctor: JGeocoder,
  methods: {
    "<init>(Landroid/content/Context;)V": function (this: JGeocoder, context: JObj | null) {
      return after(defaultLocale(), (locale) => initGeocoder.call(this, context, locale));
    },
    "<init>(Landroid/content/Context;Ljava/util/Locale;)V": initGeocoder,
    "static isPresent()Z": driven(function* () { return +!!(yield* providerComponent()); }),
    "getFromLocation(DDI)Ljava/util/List;": function (this: JGeocoder, lat: number, lon: number, max: number) { return byLocation(this, lat, lon, max); },
    "getFromLocation(DDILandroid/location/Geocoder$GeocodeListener;)V": function (this: JGeocoder, lat: number, lon: number, max: number, listener: unknown) {
      deliver(listener, byLocation(this, lat, lon, max));
    },
    "getFromLocationName(Ljava/lang/String;I)Ljava/util/List;": function (this: JGeocoder, name: string | null, max: number) { return byName(this, name, max); },
    "getFromLocationName(Ljava/lang/String;IDDDD)Ljava/util/List;": function (this: JGeocoder, name: string | null, max: number, ...bounds: number[]) {
      return byName(this, name, max, bounds);
    },
    "getFromLocationName(Ljava/lang/String;ILandroid/location/Geocoder$GeocodeListener;)V": function (this: JGeocoder, name: string | null, max: number, listener: unknown) {
      deliver(listener, byName(this, name, max));
    },
    "getFromLocationName(Ljava/lang/String;IDDDDLandroid/location/Geocoder$GeocodeListener;)V": function (this: JGeocoder, name: string | null, max: number, a: number, b: number, c: number, d: number, listener: unknown) {
      deliver(listener, byName(this, name, max, [a, b, c, d]));
    },
  },
});
