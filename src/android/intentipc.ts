// An Intent crossing processes travels as AOSP's own parcel of it (Intent.writeToParcel, read back
// through Intent(Parcel)), the bytes the broker already carries for binder transactions. Its
// extras stay parcelled until the receiving side reads them, so a process routing an intent
// needs none of the classes they name.
import type { JIntent } from "./intent";
import { newObj, vcall } from "../jvm/natives/jlang";
import { driven, type Gen } from "../jvm/runtime";
import { newParcel } from "./parcel";
import { exportParcel, importParcel, type ParcelData } from "./binder";
import type { IntentCodec } from "../shell/pendingintents";

export type IntentData = ParcelData;

export const encodeIntent = driven(function* encodeIntent(intent: JIntent): Gen<IntentData> {
  const parcel = yield newParcel();
  yield vcall(intent, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
  return yield exportParcel(parcel);
});
export const decodeIntent = driven(function* decodeIntent(data: IntentData): Gen<JIntent> {
  return yield newObj("android/content/Intent", "(Landroid/os/Parcel;)V", yield importParcel(data));
});
export const intentCodec: IntentCodec = {
  filterEquals: async (a, b) => !!await vcall(await decodeIntent(a), "filterEquals", "(Landroid/content/Intent;)Z", await decodeIntent(b)),
  replaceExtras: async (target, source) => {
    const intent = await decodeIntent(target);
    await vcall(intent, "replaceExtras", "(Landroid/content/Intent;)Landroid/content/Intent;", await decodeIntent(source));
    return encodeIntent(intent);
  },
};
