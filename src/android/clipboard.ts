// IClipboard, the TS half of AOSP's ClipboardManager. The clip itself is the broker's, shared by
// every process (processes.ts): a clip crosses as its parcel, as it does to ClipboardService.
import { JObj, rt, driven, type Gen } from "../jvm/runtime";
import { vcall, linkInit } from "../jvm/natives/jlang";
import { mangleStaticField } from "../jvm/abi";
import { exportParcel, importParcel, type ParcelData } from "./binder";
import { JParcel } from "./parcel";
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
  for (const listener of listeners) void onMain(() => vcall(listener, "dispatchPrimaryClipChanged", "()V")).catch(reportUncaught);
}
/** the clip, read back from its parcel */
function* current(): Gen<JObj | null> {
  const data = clipboardTransport.get();
  if (!data) return null;
  const creator = (yield linkInit("android/content/ClipData")).ctor[mangleStaticField("CREATOR")];
  return yield vcall(creator, "createFromParcel", "(Landroid/os/Parcel;)Ljava/lang/Object;", importParcel(data));
}
const P = "Ljava/lang/String;Ljava/lang/String;II";
rt.register({ name: "webdroid/ClipboardService", ctor: class extends JObj {}, sup: "android/content/IClipboard$Stub", methods: {
  // ClipboardService stamps the clip as copied now
  [`setPrimaryClip(Landroid/content/ClipData;${P})V`]: driven(function* (clip: JObj) {
    yield vcall(yield vcall(clip, "getDescription", "()Landroid/content/ClipDescription;"), "setTimestamp", "(J)V", BigInt(Date.now()));
    const parcel = new JParcel();
    yield vcall(clip, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
    clipboardTransport.set(exportParcel(parcel));
  }),
  [`getPrimaryClip(${P})Landroid/content/ClipData;`]: driven(current),
  [`getPrimaryClipDescription(${P})Landroid/content/ClipDescription;`]: driven(function* () {
    const clip = yield* current();
    return clip && (yield vcall(clip, "getDescription", "()Landroid/content/ClipDescription;"));
  }),
  [`hasPrimaryClip(${P})Z`]: () => +(clipboardTransport.get() !== null),
  [`hasClipboardText(${P})Z`]: driven(function* () {
    const clip = yield* current();
    if (!clip || !(yield vcall(clip, "getItemCount", "()I"))) return 0;
    const text = yield vcall(yield vcall(clip, "getItemAt", "(I)Landroid/content/ClipData$Item;", 0), "getText", "()Ljava/lang/CharSequence;");
    return +(text != null && (yield vcall(text, "length", "()I")) > 0);
  }),
  [`clearPrimaryClip(${P})V`]: () => clipboardTransport.set(null),
  [`addPrimaryClipChangedListener(Landroid/content/IOnPrimaryClipChangedListener;${P})V`]: (listener: unknown) => {
    listeners.add(listener); clipboardTransport.listen(true);
  },
  [`removePrimaryClipChangedListener(Landroid/content/IOnPrimaryClipChangedListener;${P})V`]: (listener: unknown) => {
    listeners.delete(listener); if (!listeners.size) clipboardTransport.listen(false);
  },
  // a clip's source app is not disclosed to other apps
  [`getPrimaryClipSource(${P})Ljava/lang/String;`]: () => null,
  // the platform default: an app reading the clipboard is announced
  "areClipboardAccessNotificationsEnabledForUser(I)Z": () => 1,
} });
