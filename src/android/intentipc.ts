import { JIntent } from "./intent";
import { JBundle } from "./os";
import { rt } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { JParcel } from "./parcel";
import { exportParcel, importParcel, type ParcelData } from "./binder";
import { JRect } from "./graphics";

export type IntentData = { action: string | null; component: string | null; componentPkg: string | null; dataUri: string | null;
  typeStr: string | null; pkg: string | null; flags: number; categories: string[]; extras: ParcelData;
  identifier: string | null; sourceBounds: Pick<JRect, "left" | "top" | "right" | "bottom"> | null;
  selector: IntentData | null; clipData: ParcelData | null; contentUserHint: number; originalIntent: IntentData | null };

export async function encodeIntent(intent: JIntent): Promise<IntentData> {
  rt.link("android/os/Parcel");
  const parcel = new JParcel();
  await vcall(parcel, "writeBundle", "(Landroid/os/Bundle;)V", intent.extras);
  let clipData: ParcelData | null = null;
  if (intent.clipData) {
    const clip = new JParcel(); await vcall(clip, "writeParcelable", "(Landroid/os/Parcelable;I)V", intent.clipData, 0); clipData = exportParcel(clip);
  }
  const bounds = intent.sourceBounds;
  return { action: intent.action, component: intent.component, componentPkg: intent.componentPkg, dataUri: intent.dataUri,
    typeStr: intent.typeStr, pkg: intent.pkg, flags: intent.flags, categories: [...intent.categories], extras: exportParcel(parcel),
    identifier: intent.identifier, sourceBounds: bounds ? { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom } : null,
    selector: intent.selector ? await encodeIntent(intent.selector) : null, clipData, contentUserHint: intent.contentUserHint,
    originalIntent: intent.originalIntent ? await encodeIntent(intent.originalIntent) : null };
}
export async function decodeIntent(data: IntentData, extras = true): Promise<JIntent> {
  rt.link("android/content/Intent");
  const intent = new JIntent();
  Object.assign(intent, data, { categories: new Set(data.categories), extras: new JBundle(), sourceBounds: null, selector: null, clipData: null, originalIntent: null });
  if (data.sourceBounds) { rt.link("android/graphics/Rect"); intent.sourceBounds = Object.assign(new JRect(), data.sourceBounds); }
  if (data.selector) intent.selector = await decodeIntent(data.selector, extras);
  if (data.originalIntent) intent.originalIntent = await decodeIntent(data.originalIntent, extras);
  if (extras && data.clipData) intent.clipData = await vcall(importParcel(data.clipData), "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
  if (extras) intent.extras = await vcall(importParcel(data.extras), "readBundle", "()Landroid/os/Bundle;");
  return intent;
}
