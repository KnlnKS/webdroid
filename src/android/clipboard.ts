// IClipboard: ClipboardService, hosted once in system_server (SYSTEM_SERVICES) for every process's
// ClipboardManager. It keeps the primary clip as the ClipData the caller's parcel made, which only the
// focused app's uid reads, and tells the listeners whose uid has focus of each change.
import { JObj, driven } from "../jvm/runtime.ts";
import { vcall } from "../jvm/natives/jentry.ts";
import { asBinder, callingIdentity, hostService, onCallerDeath, oneway } from "./binder.ts";
import { foreground } from "./server/atm.ts";
import { PROCESS_UID } from "./os.ts";
import { wallMillis } from "../guest-clock.ts";

/** the uid whose app has input focus (WindowManagerService.isUidFocused): system_server's realm asks
 *  the broker; a realm of its own has its app while one of its activities is resumed */
let focusedUid = (): number | undefined => foreground() ? PROCESS_UID : undefined;
/** the uid whose window has focus, `focused`'s answer from now on; the previous source is returned */
export function useFocusedUid(focused: () => number | undefined): () => number | undefined { const was = focusedUid; focusedUid = focused; return was; }

let primary: JObj | null = null;
/** each listener by its binder, with the uid that registered it, as a RemoteCallbackList keeps them */
const listeners = new Map<unknown, { listener: JObj; uid: number; unwatch: () => void }>();
/** clipboardAccessAllowed for a read: the app must have focus */
const readable = (uid = callingIdentity().uid) => uid === focusedUid();
function setPrimary(clip: JObj | null): void {
  primary = clip;
  for (const { listener, uid } of listeners.values()) if (readable(uid)) oneway(listener, "dispatchPrimaryClipChanged", "()V");
}
const description = (clip: JObj) => vcall(clip, "getDescription", "()Landroid/content/ClipDescription;");
const P = "Ljava/lang/String;Ljava/lang/String;II", L = "Landroid/content/IOnPrimaryClipChangedListener;";
hostService("clipboard", "webdroid/ClipboardService", "android/content/IClipboard$Stub", {
  // stamped as copied now, as setPrimaryClipInternalLocked does
  [`setPrimaryClip(Landroid/content/ClipData;${P})V`]: driven(function* (clip: JObj) {
    yield vcall(yield description(clip), "setTimestamp", "(J)V", BigInt(Math.floor(wallMillis())));
    setPrimary(clip);
  }),
  [`getPrimaryClip(${P})Landroid/content/ClipData;`]: () => readable() ? primary : null,
  [`getPrimaryClipDescription(${P})Landroid/content/ClipDescription;`]: () => readable() && primary ? description(primary) : null,
  [`hasPrimaryClip(${P})Z`]: () => +(readable() && primary !== null),
  [`hasClipboardText(${P})Z`]: driven(function* () {
    const clip = readable() ? primary : null;
    if (!clip || !(yield vcall(clip, "getItemCount", "()I"))) return 0;
    const text = yield vcall(yield vcall(clip, "getItemAt", "(I)Landroid/content/ClipData$Item;", 0), "getText", "()Ljava/lang/CharSequence;");
    return +(text != null && (yield vcall(text, "length", "()I")) > 0);
  }),
  [`clearPrimaryClip(${P})V`]: () => setPrimary(null),
  [`addPrimaryClipChangedListener(${L}${P})V`]: driven(function* (listener: JObj) {
    const { pid, uid } = callingIdentity(), binder = yield asBinder(listener);
    if (!listeners.has(binder)) listeners.set(binder, { listener, uid, unwatch: onCallerDeath(pid, () => listeners.delete(binder)) });
  }),
  [`removePrimaryClipChangedListener(${L}${P})V`]: driven(function* (listener: JObj) {
    const binder = yield asBinder(listener);
    listeners.get(binder)?.unwatch();
    listeners.delete(binder);
  }),
  // a clip's source app is not disclosed to other apps
  [`getPrimaryClipSource(${P})Ljava/lang/String;`]: () => null,
  // the platform default: an app reading the clipboard is announced
  "areClipboardAccessNotificationsEnabledForUser(I)Z": () => 1,
});
