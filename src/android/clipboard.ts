import { rt, driven, type Gen } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { exportParcel, importParcel, type ParcelData } from "./binder";
import { JParcel } from "./parcel";
import { JClipData, plainTextClip, readClipData } from "./clipdata";
import { onMain } from "./mainloop";
import { reportUncaught } from "./os";

export const clipboardTransport: {
  set: (data: ParcelData | null) => void;
  get: () => ParcelData | null;
  listen: (active: boolean) => void;
} = {
  set: () => { throw new Error("Clipboard service unavailable"); },
  get: () => { throw new Error("Clipboard service unavailable"); },
  listen: () => { throw new Error("Clipboard service unavailable"); },
};

const listeners = new Set<unknown>();
export function clipboardChanged(): void {
  for (const listener of listeners) void onMain(() => vcall(listener, "onPrimaryClipChanged", "()V")).catch(reportUncaught);
}

async function encode(clip: JClipData): Promise<ParcelData> {
  const parcel = new JParcel();
  await vcall(clip, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
  return exportParcel(parcel);
}
async function current(): Promise<JClipData | null> {
  const data = clipboardTransport.get();
  return data ? readClipData(importParcel(data)) : null;
}

export const clipboardMethods = {
  "setPrimaryClip(Landroid/content/ClipData;)V": driven(function* (clip: JClipData | null): Gen {
    if (!clip) throw rt.mkThrowable("java/lang/NullPointerException", "clip");
    clip.description.time = BigInt(Date.now());
    clipboardTransport.set(yield encode(clip));
  }),
  "getPrimaryClip()Landroid/content/ClipData;": current,
  "hasPrimaryClip()Z": () => +(clipboardTransport.get() !== null),
  "getPrimaryClipDescription()Landroid/content/ClipDescription;": driven(function* (): Gen { return (yield current())?.description ?? null; }),
  "clearPrimaryClip()V": () => clipboardTransport.set(null),
  "addPrimaryClipChangedListener(Landroid/content/ClipboardManager$OnPrimaryClipChangedListener;)V": (listener: unknown) => {
    if (!listener) throw rt.mkThrowable("java/lang/NullPointerException", "listener");
    listeners.add(listener); clipboardTransport.listen(true);
  },
  "removePrimaryClipChangedListener(Landroid/content/ClipboardManager$OnPrimaryClipChangedListener;)V": (listener: unknown) => {
    listeners.delete(listener); if (!listeners.size) clipboardTransport.listen(false);
  },
  "setText(Ljava/lang/CharSequence;)V": driven(function* (text: unknown): Gen {
    const clip = plainTextClip(null, text); clip.description.time = BigInt(Date.now());
    clipboardTransport.set(yield encode(clip));
  }),
  "getText()Ljava/lang/CharSequence;": driven(function* (): Gen { return (yield current())?.items[0]?.text ?? null; }),
  "hasText()Z": driven(function* (): Gen { return +!!((yield current())?.items[0]?.text); }),
};
