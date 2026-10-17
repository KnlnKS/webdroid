// An Intent crossing processes travels as AOSP's own parcel of it (Intent.writeToParcel, read back
// through its CREATOR), the bytes the broker already carries for binder transactions. Its
// extras stay parcelled until the receiving side reads them, so a process routing an intent
// needs none of the classes they name.
import { vcall } from "../jvm/natives/jentry.ts";
import { awaited, rt, type Gen } from "../jvm/runtime.ts";
import { asSystem, parcelled, unparcelled, type ParcelData } from "./binder.ts";
import type { IntentCodec } from "../shell/pendingintents.ts";

export const encodeIntent = parcelled;
export const decodeIntent = (data: ParcelData) => unparcelled("android/content/Intent", data);
/** the broker's own work on intents, as system_server does it */
export const intentCodec: IntentCodec = {
  filterEquals: (a, b) => asSystem(() => rt.drive(function* (): Gen<boolean> {
    return !!(yield vcall(yield* awaited(decodeIntent(a)), "filterEquals", "(Landroid/content/Intent;)Z", yield* awaited(decodeIntent(b))));
  }())),
  replaceExtras: (target, source) => asSystem(() => rt.drive(function* (): Gen<ParcelData> {
    const intent = yield* awaited(decodeIntent(target));
    yield vcall(intent, "replaceExtras", "(Landroid/content/Intent;)Landroid/content/Intent;", yield* awaited(decodeIntent(source)));
    return yield* awaited(encodeIntent(intent));
  }())),
};
