// The system activities behind android.provider's and android.content's intents (DocumentsUI's
// pickers, the photo picker, the chooser, sharing and viewing), over the browser's own.

import { awaited, rt, type JObj, getDeclared, driven, type Gen } from "../jvm/runtime.ts";
import { newObj, vcall, scall } from "../jvm/natives/jentry.ts";
import { serviceContext } from "./binder.ts";
import { startActivityFor } from "./server/atm.ts";
import { thisApp } from "./server/am.ts";
import { registerSystemActivity, systemActivity, mkResultIntent, newIntent, intentQuery$, mkComponentName, type JIntent } from "./intent.ts";
import { csText } from "../jvm/natives/jchars.ts";
import { systemResource } from "./configuration.ts";
import { mkUri } from "./net.ts";
import { toJsArray } from "../jvm/natives/jcoll.ts";
import { pickTree, pickDocument, pickDocuments } from "./documents.ts";

const S = "Ljava/lang/String;";
const typeOf = (intent: JIntent): string | null | Promise<string | null> => vcall(intent, "getType", `()${S}`);

// The activities DocumentsUI provides on a device, over the browser's own pickers.
registerSystemActivity("android.intent.action.OPEN_DOCUMENT_TREE", driven(function* (): Gen<JIntent | null> {
  const uri = yield* awaited(pickTree());
  return uri ? yield* awaited(mkResultIntent(uri, 3 | 0x40 | 0x80)) : null;
}));
registerSystemActivity("android.intent.action.PICK", driven(function* (intent: JIntent): Gen<JIntent | null> {
  const mime = yield* awaited(typeOf(intent));
  if (!mime || !/^(image|video|audio)\//.test(mime)) throw rt.unimplemented("PICK for " + (mime ?? (yield vcall(intent, "getDataString", `()${S}`))));
  const uri = yield* awaited(pickDocument({ mime }));
  return uri ? yield* awaited(mkResultIntent(uri, 1)) : null;
}));
// MediaStore.ACTION_PICK_IMAGES, the photo picker: one item as the data, or up to
// EXTRA_PICK_IMAGES_MAX as ClipData, readable and persistable
registerSystemActivity("android.provider.action.PICK_IMAGES", driven(function* (intent: JIntent): Gen<JIntent | null> {
  const mime = yield* awaited(typeOf(intent)), multiple = (yield vcall(intent, "getIntExtra", `(${S}I)I`, "android.provider.extra.PICK_IMAGES_MAX", 1)) > 1;
  if (mime && !/^(image|video)\//.test(mime)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid picker MIME type " + mime);
  const uris = yield* awaited(pickDocuments({ mime, multiple }));
  if (!uris.length) return null;
  const result = yield* awaited(mkResultIntent(multiple ? null : uris[0], 1 | 0x40));
  if (multiple) {
    const parsed: JObj[] = [];
    for (const uri of uris) parsed.push(yield* awaited(mkUri(uri)));
    const clip = yield scall("android/content/ClipData", "newRawUri", "(Ljava/lang/CharSequence;Landroid/net/Uri;)Landroid/content/ClipData;", null, parsed[0]);
    for (const uri of parsed.slice(1)) yield vcall(clip, "addItem", "(Landroid/content/ClipData$Item;)V", yield newObj("android/content/ClipData$Item", "(Landroid/net/Uri;)V", uri));
    yield vcall(result, "setClipData", "(Landroid/content/ClipData;)V", clip);
  }
  return result;
}));
for (const action of ["android.intent.action.OPEN_DOCUMENT", "android.intent.action.GET_CONTENT",
  "android.intent.action.CREATE_DOCUMENT"] as const) {
  registerSystemActivity(action, driven(function* (intent: JIntent): Gen<JIntent | null> {
    const title: string | null = yield vcall(intent, "getStringExtra", `(${S})${S}`, "android.intent.extra.TITLE"), mime = yield* awaited(typeOf(intent));
    const uri = yield* awaited(pickDocument({
      save: action.endsWith("CREATE_DOCUMENT") ? title ?? "file" : undefined,
      mime: mime && mime !== "*/*" ? mime : null,
    }));
    return uri ? yield* awaited(mkResultIntent(uri, action === "android.intent.action.GET_CONTENT" ? 1 : 3 | 0x40)) : null;
  }));
}
registerSystemActivity("android.intent.action.VIEW", driven(function* (intent: JIntent): Gen<null> {
  const url: string = yield vcall(intent, "getDataString", `()${S}`);
  return yield* awaited((yield* awaited(import("../shell/share.ts"))).openInBrowser(url));
}), ["http", "https", "market"]);
for (const action of ["android.intent.action.SEND", "android.intent.action.SEND_MULTIPLE"])
  registerSystemActivity(action, driven(function* (intent: JIntent): Gen<JIntent | null> { return yield* awaited((yield* awaited(import("../shell/share.ts"))).shareIntent(intent)); }));
registerSystemActivity("android.intent.action.CHOOSER", driven(function* (intent: JIntent): Gen<JIntent | null> {
  const target: JIntent | null = yield vcall(intent, "getParcelableExtra", `(${S})Landroid/os/Parcelable;`, "android.intent.extra.INTENT");
  if (!target) throw rt.mkThrowable("java/lang/NullPointerException", "Chooser target");
  const q = yield* intentQuery$(target);
  const share = () => import("../shell/share.ts");
  if (q.action === "android.intent.action.SEND" || q.action === "android.intent.action.SEND_MULTIPLE")
    return yield* awaited((yield* awaited(share())).shareIntent(intent));
  const handler = systemActivity(q);
  if (handler) return yield* awaited(handler(target));
  // AOSP's chooser lists the activities that handle the target; with none it only says so, and
  // the user dismissing it is RESULT_CANCELED
  const pm = yield vcall(yield* awaited(serviceContext()), "getPackageManager", "()Landroid/content/pm/PackageManager;");
  const matches = (yield* awaited(toJsArray(yield vcall(pm, "queryIntentActivities", "(Landroid/content/Intent;I)Ljava/util/List;", target, 0x10000)))) as JObj[];
  if (!matches.length) return null;
  const labels: string[] = [];
  for (const m of matches) labels.push(yield* awaited(csText(yield vcall(m, "loadLabel", "(Landroid/content/pm/PackageManager;)Ljava/lang/CharSequence;", pm))));
  const title = yield vcall(intent, "getCharSequenceExtra", `(${S})Ljava/lang/CharSequence;`, "android.intent.extra.TITLE");
  const choice = yield* awaited((yield* awaited(share())).chooseActivity(title == null ? yield systemResource("string", "chooseActivity", "getString", `(I)${S}`) : yield* awaited(csText(title)), labels));
  if (choice === null) return null;
  const chosen: JIntent = yield newObj("android/content/Intent", "(Landroid/content/Intent;)V", target);
  const activity = getDeclared<JObj>(matches[choice], "android/content/pm/ResolveInfo", "activityInfo");
  yield vcall(chosen, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", yield* awaited(mkComponentName(
    getDeclared<string>(activity, "android/content/pm/PackageItemInfo", "packageName"), getDeclared<string>(activity, "android/content/pm/PackageItemInfo", "name"))));
  yield startActivityFor(thisApp(), chosen);
  return yield* awaited(newIntent());
}));
