// Geocoding as the platform does it: AOSP's Geocoder asks LocationManagerService, whose GeocoderProxy
// calls the installed GeocodeProvider service (com.android.location.service.GeocodeProvider; microG's
// here), bound by the platform itself.

import { awaited, rt, JObj, driven, type Gen } from "../jvm/runtime.ts";
import { scall, vcall } from "../jvm/natives/jentry.ts";
import { once } from "../jvm/suspend.ts";
import { newArrayList } from "../jvm/natives/jcoll.ts";
import type { JLocale } from "../jvm/natives/jvalues.ts";
import { newStub } from "./binder.ts";
import { resolveService } from "./pm.ts";
import { bindAsSystem } from "./server/activeservices.ts";
import { newIntent, mkComponentName, type JIntent, type JComponentName } from "./intent.ts";
import { procIdentity } from "../shell/procfs.ts";

// the provider library's GeocoderParams: the request's locale and caller
class JGeocoderParams extends JObj { locale: JLocale | null = null; pkg: string | null = null; uid = procIdentity.uid; }
rt.register({
  name: "android/location/GeocoderParams", ctor: JGeocoderParams,
  methods: {
    "getLocale()Ljava/util/Locale;": function (this: JGeocoderParams) { return this.locale; },
    "getClientPackage()Ljava/lang/String;": function (this: JGeocoderParams) { return this.pkg; },
    "getClientUid()I": function (this: JGeocoderParams) { return this.uid; },
    "getClientAttributionTag()Ljava/lang/String;": () => null,
  },
});

// ── the provider side: com.android.location.provider.GeocodeProvider, the platform library a
// geocode service extends; its IGeocodeProvider calls the subclass's onGetFromLocation[Name]
class JGeocodeBinder extends JObj { provider: unknown = null; }
const R = "android/location/provider/ReverseGeocodeRequest", F = "android/location/provider/ForwardGeocodeRequest";
/** a request's GeocoderParams, its results list, and the callback told of either */
function* answer$(request: JObj, callback: JObj, lookup: (params: JGeocoderParams, results: JObj) => unknown): Gen {
  const params: JGeocoderParams = rt.make("android/location/GeocoderParams");
  params.locale = yield vcall(request, "getLocale", "()Ljava/util/Locale;");
  params.pkg = yield vcall(request, "getCallingPackage", "()Ljava/lang/String;");
  params.uid = yield vcall(request, "getCallingUid", "()I");
  const results = yield* awaited(newArrayList()), error: string | null = yield lookup(params, results);
  return error === null ? vcall(callback, "onResults", "(Ljava/util/List;)V", results) : vcall(callback, "onError", "(Ljava/lang/String;)V", error);
}
const num = (request: JObj, getter: string) => vcall(request, getter, "()D") as Promise<number>;
rt.register({
  name: "webdroid/GeocodeProviderBinder", ctor: JGeocodeBinder, sup: "android/location/provider/IGeocodeProvider$Stub",
  methods: {
    [`reverseGeocode(L${R};Landroid/location/provider/IGeocodeCallback;)V`]: driven(function* (this: JGeocodeBinder, request: JObj, callback: JObj): Gen {
      const [lat, lon, max]: number[] = [yield* awaited(num(request, "getLatitude")), yield* awaited(num(request, "getLongitude")), yield vcall(request, "getMaxResults", "()I")];
      return yield* answer$(request, callback, (params, results) => vcall(this.provider, "onGetFromLocation",
        "(DDILandroid/location/GeocoderParams;Ljava/util/List;)Ljava/lang/String;", lat, lon, max, params, results));
    }),
    [`forwardGeocode(L${F};Landroid/location/provider/IGeocodeCallback;)V`]: driven(function* (this: JGeocodeBinder, request: JObj, callback: JObj): Gen {
      const name: string = yield vcall(request, "getLocationName", "()Ljava/lang/String;"), bounds: number[] = [];
      for (const g of ["getLowerLeftLatitude", "getLowerLeftLongitude", "getUpperRightLatitude", "getUpperRightLongitude"]) bounds.push(yield* awaited(num(request, g)));
      const max: number = yield vcall(request, "getMaxResults", "()I");
      return yield* answer$(request, callback, (params, results) => vcall(this.provider, "onGetFromLocationName",
        "(Ljava/lang/String;DDDDILandroid/location/GeocoderParams;Ljava/util/List;)Ljava/lang/String;", name, ...bounds, max, params, results));
    }),
  },
});
class JGeocodeProvider extends JObj { binder: JObj | null = null; }
rt.register({
  name: "com/android/location/provider/GeocodeProvider", ctor: JGeocodeProvider,
  methods: {
    "<init>()V": driven(function* (this: JGeocodeProvider): Gen {
      const binder = this.binder = (yield* awaited(newStub("webdroid/GeocodeProviderBinder"))) as JGeocodeBinder;
      binder.provider = this;
    }),
    "getBinder()Landroid/os/IBinder;": function (this: JGeocodeProvider) { return this.binder; },
  },
});

// ── LocationManagerService's geocoding: GeocoderProxy over the bound provider service, which with
// no provider answers onError(null)
const PROVIDER_ACTION = "com.android.location.service.GeocodeProvider";
function* providerComponent(): Gen<JComponentName | null> {
  const intent: JIntent = yield newIntent(PROVIDER_ACTION);
  const first = yield* awaited(resolveService(intent));
  return first ? yield mkComponentName(first.owner.pkg, first.name) : null;
}
/** the provider's IGeocodeProvider, bound as the platform keeps it bound; a failed call drops the binding (its process may have died), as ServiceWatcher rebinds */
const bindProvider = () => once(driven(function* (): Gen<{ geocoder: JObj; unbind: () => unknown }> {
  const component = yield* providerComponent();
  if (!component) throw rt.mkThrowable("java/io/IOException", "Service not Available");
  const { binder, unbind } = yield* awaited(bindAsSystem(component, "geocoder:" + procIdentity.pid));
  return { geocoder: yield scall("android/location/provider/IGeocodeProvider$Stub", "asInterface", "(Landroid/os/IBinder;)Landroid/location/provider/IGeocodeProvider;", binder), unbind };
}));
let provider = bindProvider();
const geocode = (method: string, request: string) => driven(function* (req: JObj, callback: JObj): Gen {
  let bound: { geocoder: JObj; unbind: () => unknown };
  try { bound = yield* awaited(provider()); } catch { return yield vcall(callback, "onError", "(Ljava/lang/String;)V", null); }
  try { yield vcall(bound.geocoder, method, `(L${request};Landroid/location/provider/IGeocodeCallback;)V`, req, callback); }
  catch (e) {
    provider = bindProvider();
    bound.unbind();
    yield vcall(callback, "onError", "(Ljava/lang/String;)V", String((e as { msg?: string }).msg ?? e));
  }
});
export const geocodeMethods = {
  "isGeocodeAvailable()Z": driven(function* (): Gen { return +!!(yield* providerComponent()); }),
  [`reverseGeocode(L${R};Landroid/location/provider/IGeocodeCallback;)V`]: geocode("reverseGeocode", R),
  [`forwardGeocode(L${F};Landroid/location/provider/IGeocodeCallback;)V`]: geocode("forwardGeocode", F),
};
