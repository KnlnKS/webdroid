// An Intent crossing processes travels as AOSP's own parcel of it (Intent.writeToParcel, read back
// through Intent(Parcel)), the bytes the broker already carries for binder transactions. Its
// extras stay parcelled until the receiving side reads them, so a process routing an intent
// needs none of the classes they name.
import type { JIntent } from "./intent";
import { rt } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { JParcel } from "./parcel";
import { exportParcel, importParcel, type ParcelData } from "./binder";
import type { IntentCodec } from "../shell/pendingintents";

export type IntentData = ParcelData;

export async function encodeIntent(intent: JIntent): Promise<IntentData> {
  rt.link("android/os/Parcel");
  const parcel = new JParcel();
  await vcall(intent, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
  return exportParcel(parcel);
}
export function decodeIntent(data: IntentData): Promise<JIntent> {
  return newObj("android/content/Intent", "(Landroid/os/Parcel;)V", importParcel(data));
}
export const intentCodec: IntentCodec = {
  filterEquals: async (a, b) => !!await vcall(await decodeIntent(a), "filterEquals", "(Landroid/content/Intent;)Z", await decodeIntent(b)),
  replaceExtras: async (target, source) => {
    const intent = await decodeIntent(target);
    await vcall(intent, "replaceExtras", "(Landroid/content/Intent;)Landroid/content/Intent;", await decodeIntent(source));
    return encodeIntent(intent);
  },
};
