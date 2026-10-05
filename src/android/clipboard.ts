// IClipboard, the TS half of AOSP's ClipboardManager. The clip itself is the broker's, shared by
// every process (processes.ts): a clip crosses as its parcel, as it does to ClipboardService.
import { awaited, JObj, rt, driven, type Gen } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jentry";
import { parcelled, unparcelled, type ParcelData } from "./binder";
import { postMain } from "./mainloop";

export const clipboardTransport: {
  set: (data: ParcelData | null) => void | Promise<void>;
  get: () => ParcelData | null | Promise<ParcelData | null>;
  listen: (active: boolean) => void | Promise<void>;
} = {
  set: () => { throw new Error("Clipboard service unavailable"); },
  get: () => { throw new Error("Clipboard service unavailable"); },
  listen: () => { throw new Error("Clipboard service unavailable"); },
};

const listeners = new Set<unknown>();
export function clipboardChanged(): void {
  for (const listener of listeners) postMain(() => vcall(listener, "dispatchPrimaryClipChanged", "()V"));
}
/** the clip, read back from its parcel */
function* current(): Gen<JObj | null> {
  const data = yield* awaited(clipboardTransport.get());
  return data && (yield* awaited(unparcelled("android/content/ClipData", data)));
}
const P = "Ljava/lang/String;Ljava/lang/String;II";
rt.register({ name: "webdroid/ClipboardService", ctor: class extends JObj {}, sup: "android/content/IClipboard$Stub", methods: {
  // ClipboardService stamps the clip as copied now
  [`setPrimaryClip(Landroid/content/ClipData;${P})V`]: driven(function* (clip: JObj) {
    yield vcall(yield vcall(clip, "getDescription", "()Landroid/content/ClipDescription;"), "setTimestamp", "(J)V", BigInt(Date.now()));
    yield* awaited(clipboardTransport.set(yield* awaited(parcelled(clip))));
  }),
  [`getPrimaryClip(${P})Landroid/content/ClipData;`]: driven(current),
  [`getPrimaryClipDescription(${P})Landroid/content/ClipDescription;`]: driven(function* () {
    const clip = yield* current();
    return clip && (yield vcall(clip, "getDescription", "()Landroid/content/ClipDescription;"));
  }),
  [`hasPrimaryClip(${P})Z`]: driven(function* () { return +((yield* awaited(clipboardTransport.get())) !== null); }),
  [`hasClipboardText(${P})Z`]: driven(function* () {
    const clip = yield* current();
    if (!clip || !(yield vcall(clip, "getItemCount", "()I"))) return 0;
    const text = yield vcall(yield vcall(clip, "getItemAt", "(I)Landroid/content/ClipData$Item;", 0), "getText", "()Ljava/lang/CharSequence;");
    return +(text != null && (yield vcall(text, "length", "()I")) > 0);
  }),
  [`clearPrimaryClip(${P})V`]: () => clipboardTransport.set(null),
  [`addPrimaryClipChangedListener(Landroid/content/IOnPrimaryClipChangedListener;${P})V`]: driven(function* (listener: unknown) {
    const present = listeners.has(listener);
    listeners.add(listener);
    try { yield* awaited(clipboardTransport.listen(true)); }
    catch (error) { if (!present) listeners.delete(listener); throw error; }
  }),
  [`removePrimaryClipChangedListener(Landroid/content/IOnPrimaryClipChangedListener;${P})V`]: driven(function* (listener: unknown) {
    listeners.delete(listener); if (!listeners.size) yield* awaited(clipboardTransport.listen(false));
  }),
  // a clip's source app is not disclosed to other apps
  [`getPrimaryClipSource(${P})Ljava/lang/String;`]: () => null,
  // the platform default: an app reading the clipboard is announced
  "areClipboardAccessNotificationsEnabledForUser(I)Z": () => 1,
} });
