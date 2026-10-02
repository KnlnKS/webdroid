// An Intent crossing processes travels as AOSP's own parcel of it (Intent.writeToParcel, read back
// through its CREATOR), the bytes the broker already carries for binder transactions. Its
// extras stay parcelled until the receiving side reads them, so a process routing an intent
// needs none of the classes they name.
import { vcall } from "../jvm/natives/jlang";
import { parcelled, unparcelled, type ParcelData } from "./binder";
import type { IntentCodec } from "../shell/pendingintents";

export const encodeIntent = parcelled;
export const decodeIntent = (data: ParcelData) => unparcelled("android/content/Intent", data);
export const intentCodec: IntentCodec = {
  filterEquals: async (a, b) => !!await vcall(await decodeIntent(a), "filterEquals", "(Landroid/content/Intent;)Z", await decodeIntent(b)),
  replaceExtras: async (target, source) => {
    const intent = await decodeIntent(target);
    await vcall(intent, "replaceExtras", "(Landroid/content/Intent;)Landroid/content/Intent;", await decodeIntent(source));
    return encodeIntent(intent);
  },
};
