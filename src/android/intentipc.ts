import { JIntent } from "./intent";
import { JBundle } from "./os";
import { rt } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { JParcel } from "./parcel";
import { exportParcel, importParcel, type ParcelData } from "./binder";

export type IntentData = { action: string | null; component: string | null; componentPkg: string | null; dataUri: string | null;
  typeStr: string | null; pkg: string | null; flags: number; categories: string[]; extras: ParcelData };

export async function encodeIntent(intent: JIntent): Promise<IntentData> {
  rt.link("android/os/Parcel");
  const parcel = new JParcel();
  await vcall(parcel, "writeBundle", "(Landroid/os/Bundle;)V", intent.extras);
  return { action: intent.action, component: intent.component, componentPkg: intent.componentPkg, dataUri: intent.dataUri,
    typeStr: intent.typeStr, pkg: intent.pkg, flags: intent.flags, categories: [...intent.categories], extras: exportParcel(parcel) };
}
export async function decodeIntent(data: IntentData, extras = true): Promise<JIntent> {
  rt.link("android/content/Intent");
  const intent = new JIntent();
  Object.assign(intent, data, { categories: new Set(data.categories), extras: new JBundle() });
  if (extras) intent.extras = await vcall(importParcel(data.extras), "readBundle", "()Landroid/os/Bundle;");
  return intent;
}
