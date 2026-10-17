import { type JIntent, newIntent } from "../android/intent.ts";
import { serviceContext } from "../android/binder.ts";
import { pfdContents } from "../android/os.ts";
import { uriText } from "../android/net.ts";
import { awaited, driven, type Gen, type JObj } from "../jvm/runtime.ts";
import { vcall } from "../jvm/natives/jentry.ts";
import { toJsArray } from "../jvm/natives/jcoll.ts";
import { csText } from "../jvm/natives/jchars.ts";
import { hostUi } from "./host-ui.ts";

const S = "Ljava/lang/String;";
function* extraText(intent: JIntent, key: string): Gen<string | null> {
  const text = yield vcall(intent, "getCharSequenceExtra", `(${S})Ljava/lang/CharSequence;`, key);
  return text == null ? null : yield* awaited(csText(text));
}
function* sharedFiles(intent: JIntent): Gen<File[]> {
  const multiple = (yield vcall(intent, "getAction", `()${S}`)) === "android.intent.action.SEND_MULTIPLE";
  const stream = multiple ? yield vcall(intent, "getParcelableArrayListExtra", `(${S})Ljava/util/ArrayList;`, "android.intent.extra.STREAM")
    : yield vcall(intent, "getParcelableExtra", `(${S})Landroid/os/Parcelable;`, "android.intent.extra.STREAM");
  const entries: unknown[] = stream == null ? [] : multiple ? yield* awaited(toJsArray(stream)) : [stream];
  const type: string | null = yield vcall(intent, "getType", `()${S}`);
  const resolver = entries.length ? yield vcall(yield* awaited(serviceContext()), "getContentResolver", "()Landroid/content/ContentResolver;") : null;
  const files: File[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    const parsed = entry as JObj, uri = yield* awaited(uriText(parsed));
    const mime: string | null = yield vcall(resolver, "getType", "(Landroid/net/Uri;)Ljava/lang/String;", parsed);
    const descriptor = yield vcall(resolver, "openFileDescriptor", "(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;", parsed, "r");
    try {
      const name = decodeURIComponent(uri.split(/[?#]/, 1)[0].split("/").pop() || "shared-file");
      files.push(new File([((yield* awaited(pfdContents(descriptor))) ?? new Uint8Array(0)) as BlobPart], name, { type: mime || type || "application/octet-stream" }));
    } finally { yield vcall(descriptor, "close", "()V"); }
  }
  return files;
}

export const shareIntent = driven(function* (intent: JIntent): Gen<JIntent | null> {
  const target: JIntent | null = (yield vcall(intent, "getAction", `()${S}`)) === "android.intent.action.CHOOSER"
    ? yield vcall(intent, "getParcelableExtra", `(${S})Landroid/os/Parcelable;`, "android.intent.extra.INTENT") : intent;
  if (!target) throw new Error("Chooser has no target intent");
  const message = (yield* extraText(target, "android.intent.extra.TEXT")) ?? "";
  const files = yield* sharedFiles(target);
  const title = yield* extraText(target, "android.intent.extra.SUBJECT");
  if (!message && !files.length) throw new Error("Share intent has no content");
  return (yield* awaited(hostUi().shareSheet(title, message, files))) ? yield* awaited(newIntent()) : null;
});

/** The browser as the device's default web handler. A store link goes to the web store. */
export async function openInBrowser(uri: string): Promise<null> {
  const url = uri.replace(/^market:\/\/details/i, "https://play.google.com/store/apps/details").replace(/^market:\/\//i, "https://play.google.com/store/");
  if (!/^https?:/i.test(url)) throw new Error("No browser for " + uri);
  await hostUi().openTab(url);
  return null;
}

/** The chooser's list of activities for an intent: the index picked, or null when dismissed. */
export const chooseActivity = (heading: string, labels: string[]): Promise<number | null> => hostUi().chooseOne(heading, labels);
